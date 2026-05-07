/**
 * @burdenoff/vibe-plugin-ssh v3.0.0
 *
 * SSH connections, remote command execution, port forwarding,
 * remote terminal sessions (ttyd on destination), and remote agent installation.
 *
 * Registers:
 *   - Elysia routes: /api/ssh/*, /api/port-forward/*
 *   - Session provider: "ssh" (for terminal proxy integration)
 *   - CLI commands: vibe ssh ...
 *
 * Install: vibe plugin install @burdenoff/vibe-plugin-ssh
 */

import type { Elysia } from "elysia";
import type { Command } from "commander";
import type { HostServices, VibePlugin } from "./types.js";
import {
  runMultimode,
  pickOutputMode,
  maybePrintJson,
  type OutputFlags,
} from "./utils/multimode.js";
import {
  interactiveTable,
  interactiveDetail,
  type TableRow,
} from "./utils/interactive.js";

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

const AGENT_BASE_URL = process.env.VIBE_AGENT_URL ?? "http://localhost:3005";
const API_KEY = process.env.VIBE_AGENT_API_KEY ?? "";

async function apiFetch(
  urlPath: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${AGENT_BASE_URL}${urlPath}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-agent-api-key": API_KEY,
      ...options?.headers,
    },
  });
}

const SECRET_RX = /(token|secret|password|apikey|api_key)/i;

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_RX.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

interface RecordWithId {
  id?: string;
  name?: string;
  host?: string;
  username?: string;
  status?: string;
  [k: string]: unknown;
}

// Re-export types for external consumers
export type {
  VibePlugin,
  HostServices,
  StorageProvider,
  EventBus,
  ServiceRegistry,
  SSHConnection,
  PortForward,
  SSHTerminalSession,
  RemoteAgentInstallJob,
} from "./types.js";

// ---------------------------------------------------------------------------
// Module-level references for cleanup
// ---------------------------------------------------------------------------

let cleanupPortForwards: (() => void) | undefined;
let cleanupTerminals: (() => void) | undefined;

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const vibePlugin: VibePlugin = {
  name: "ssh",
  version: "3.0.0",
  description:
    "SSH connection management, remote terminals, port forwarding, and remote agent installation",
  tags: ["backend", "cli", "integration", "provider"],
  cliCommand: "ssh",
  apiPrefix: "/api/ssh",

  async onServerStart(app: Elysia, hostServices: HostServices) {
    // Dynamically import route modules — ssh2 native deps only load when
    // the plugin is actually activated.
    const { createSSHRoutes } = await import("./routes/ssh.js");
    const { createPortForwardRoutes, cleanupAllTunnels } =
      await import("./routes/port-forward.js");
    const {
      createRemoteTerminalRoutes,
      cleanupAllTerminals,
      getTerminalInfo,
      listTerminalSessions,
    } = await import("./routes/remote-terminal.js");
    const { createRemoteAgentInstallRoutes } =
      await import("./routes/remote-agent-install.js");
    const { createSSHConfigScanRoutes } =
      await import("./routes/ssh-config-scan.js");

    // Mount all route groups
    app.use(createSSHRoutes(hostServices));
    app.use(createPortForwardRoutes(hostServices));
    app.use(createRemoteTerminalRoutes(hostServices));
    app.use(createRemoteAgentInstallRoutes(hostServices));
    app.use(createSSHConfigScanRoutes(hostServices));

    // Stash cleanup functions
    cleanupPortForwards = cleanupAllTunnels;
    cleanupTerminals = cleanupAllTerminals;

    // Register as a "session" provider so the agent's terminal proxy at
    // /terminal/:sessionId/ws can find our SSH-forwarded ttyd ports.
    // We only need to implement getTerminalInfo(); other SessionProvider
    // methods are not called by the terminal proxy.
    if (hostServices.serviceRegistry) {
      const sshSessionProvider = {
        name: "ssh",
        getTerminalInfo: (sessionId: string) => getTerminalInfo(sessionId),
        // Minimal stubs — the terminal proxy only calls getTerminalInfo
        list: async () => {
          return listTerminalSessions().map((s) => ({
            id: s.id,
            name: `ssh-terminal-${s.id.slice(0, 8)}`,
            status: s.status === "active" ? "active" : "inactive",
            provider: "ssh",
            createdAt: s.startedAt,
          }));
        },
        get: async (sessionId: string) => {
          const sessions = listTerminalSessions();
          const s = sessions.find((x) => x.id === sessionId);
          if (!s) return null;
          return {
            id: s.id,
            name: `ssh-terminal-${s.id.slice(0, 8)}`,
            status: s.status === "active" ? "active" : "inactive",
            provider: "ssh",
            createdAt: s.startedAt,
          };
        },
      };

      hostServices.serviceRegistry.registerProvider(
        "session",
        sshSessionProvider,
        "ssh",
      );
    }

    console.log(
      "  Plugin 'ssh' v3.0.0 registered routes: /api/ssh, /api/port-forward, /api/ssh/terminal, /api/ssh/agent-install, /api/ssh/config-scan",
    );
  },

  async onServerStop() {
    if (cleanupTerminals) {
      cleanupTerminals();
      cleanupTerminals = undefined;
    }
    if (cleanupPortForwards) {
      cleanupPortForwards();
      cleanupPortForwards = undefined;
    }
    console.log("  Plugin 'ssh' cleaned up active connections and terminals");
  },

  onCliSetup(program: Command) {
    const ssh = program
      .command("ssh")
      .description("SSH connection and remote terminal management");

    ssh
      .command("list")
      .description("List saved SSH connections")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(async (opts: OutputFlags) => {
        await runMultimode<RecordWithId[]>({
          mode: pickOutputMode(opts),
          fetchData: async () => {
            const res = await apiFetch("/api/ssh/connections");
            const data = (await res.json()) as
              | RecordWithId[]
              | { connections?: RecordWithId[] };
            return Array.isArray(data) ? data : (data.connections ?? []);
          },
          plain: (rows) => {
            if (!rows || rows.length === 0) {
              console.log(
                "Use the agent API to list SSH connections: GET /api/ssh/connections",
              );
              return;
            }
            console.log(JSON.stringify(rows, null, 2));
          },
          interactive: async (rows) => {
            if (!rows || rows.length === 0) {
              await interactiveDetail({
                title: "ssh — connections",
                body: "No saved SSH connections.",
              });
              return;
            }
            const tableRows: TableRow[] = rows.map((r) => ({
              id: String(r.id ?? r.name ?? ""),
              label: String(r.name ?? r.host ?? r.id ?? "(unnamed)"),
              hint: r.host ? `${r.username ?? ""}@${r.host}` : undefined,
              detail: JSON.stringify(redact(r), null, 2),
            }));
            await interactiveTable({
              title: `ssh list — ${rows.length} connection(s)`,
              rows: tableRows,
            });
          },
          json: (rows) => redact(rows),
        });
      });

    ssh
      .command("terminals")
      .description("List active remote terminal sessions")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(async (opts: OutputFlags) => {
        await runMultimode<RecordWithId[]>({
          mode: pickOutputMode(opts),
          fetchData: async () => {
            const res = await apiFetch("/api/ssh/terminal/sessions");
            const data = (await res.json()) as
              | RecordWithId[]
              | { sessions?: RecordWithId[] };
            return Array.isArray(data) ? data : (data.sessions ?? []);
          },
          plain: (rows) => {
            if (!rows || rows.length === 0) {
              console.log(
                "Use the agent API to list terminal sessions: GET /api/ssh/terminal/sessions",
              );
              return;
            }
            console.log(JSON.stringify(rows, null, 2));
          },
          interactive: async (rows) => {
            if (!rows || rows.length === 0) {
              await interactiveDetail({
                title: "ssh — terminals",
                body: "No active terminal sessions.",
              });
              return;
            }
            const tableRows: TableRow[] = rows.map((r) => ({
              id: String(r.id ?? ""),
              label: String(r.name ?? r.id ?? "(terminal)"),
              hint: r.status ? String(r.status) : undefined,
              detail: JSON.stringify(redact(r), null, 2),
            }));
            await interactiveTable({
              title: `ssh terminals — ${rows.length} session(s)`,
              rows: tableRows,
            });
          },
          json: (rows) => redact(rows),
        });
      });

    ssh
      .command("install-jobs")
      .description("List remote agent installation jobs")
      .option("--json", "Emit JSON")
      .action(async (opts: OutputFlags) => {
        const message =
          "Use the agent API to list install jobs: GET /api/ssh/agent-install/jobs";
        if (
          maybePrintJson(opts, { ok: true, action: "install-jobs", message })
        )
          return;
        console.log(message);
      });
  },
};

export default vibePlugin;
