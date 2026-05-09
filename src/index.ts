/**
 * @vibecontrols/vibe-plugin-tool-ssh
 *
 * SSH connections, remote command execution, port forwarding,
 * remote terminal sessions (ttyd on destination), and remote agent installation.
 *
 * Registers:
 *   - Elysia routes: /api/ssh/*, /api/port-forward/*
 *   - Session provider: "ssh" (for terminal proxy integration)
 *   - CLI commands: vibe ssh ...
 *
 * Migrated to consume `@vibecontrols/plugin-sdk` for the contract,
 * lifecycle, telemetry, CLI multimode, and redaction helpers.
 */

import type { Command } from "commander";

import {
  createLifecycleHooks,
  maybePrintJson,
  pickOutputMode,
  redact,
  runMultimode,
  TelemetryEmitter,
  type HostServices,
  type OutputFlags,
  type VibePlugin,
} from "@vibecontrols/plugin-sdk";

import type { AgentHostServices } from "./types.js";
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
  AgentHostServices,
  AgentStorageProvider,
  AgentEventBus,
  AgentServiceRegistry,
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

const PLUGIN_NAME = "ssh";
const PLUGIN_VERSION = "2026.508.3";

const lifecycle = createLifecycleHooks({
  name: PLUGIN_NAME,
  telemetryEventName: "tool.ready",
  onInit: (hostServices: HostServices) => {
    const telemetry = new TelemetryEmitter(
      PLUGIN_NAME,
      PLUGIN_VERSION,
      hostServices,
    );
    telemetry.emitEvent("tool.ready", { provider: "ssh" });
  },
});

export const vibePlugin: VibePlugin = {
  capabilities: {
    storage: "rw",
    subprocess: true,
    audit: true,
    telemetry: true,
  },
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description:
    "SSH connection management, remote terminals, port forwarding, and remote agent installation",
  tags: ["backend", "cli", "integration", "provider"],
  cliCommand: "ssh",
  apiPrefix: "/api/ssh",

  async onServerStart(app: unknown, hostServices: HostServices) {
    await lifecycle.onServerStart(app, hostServices);

    // SSH plugin is POSIX-only for now: it shells out to `ssh`, `scp`, `chmod`,
    // `tar`, and uses `nohup` to launch ttyd on the remote host. Windows
    // OpenSSH coverage and tar packaging differ enough that we don't claim
    // support yet — see README.
    if (process.platform === "win32") {
      process.stderr.write(
        "  Plugin 'ssh' is not supported on Windows yet — skipping route + provider registration. " +
          "See https://github.com/algoshred/vibe-plugin-tool-ssh for status.\n",
      );
      return;
    }

    // The agent passes a real Elysia instance with the richer HostServices
    // surface — narrow once at the boundary so route factories see the
    // agent shape (sync getConfig, 3-arg registerProvider).
    const elysiaApp = app as { use: (plugin: unknown) => unknown };
    const agentHost = hostServices as unknown as AgentHostServices;

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
    elysiaApp.use(createSSHRoutes(agentHost));
    elysiaApp.use(createPortForwardRoutes(agentHost));
    elysiaApp.use(createRemoteTerminalRoutes(agentHost));
    elysiaApp.use(createRemoteAgentInstallRoutes(agentHost));
    elysiaApp.use(createSSHConfigScanRoutes(agentHost));

    // Stash cleanup functions
    cleanupPortForwards = cleanupAllTunnels;
    cleanupTerminals = cleanupAllTerminals;

    // Register as a "session" provider so the agent's terminal proxy at
    // /terminal/:sessionId/ws can find our SSH-forwarded ttyd ports.
    if (agentHost.serviceRegistry) {
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

      agentHost.serviceRegistry.registerProvider(
        "session",
        sshSessionProvider,
        "ssh",
      );
    }

    process.stdout.write(
      "  Plugin 'ssh' registered routes: /api/ssh, /api/port-forward, /api/ssh/terminal, /api/ssh/agent-install, /api/ssh/config-scan\n",
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
    process.stdout.write(
      "  Plugin 'ssh' cleaned up active connections and terminals\n",
    );
  },

  onCliSetup(programArg: unknown) {
    const program = programArg as Command;
    const ssh = program
      .command("ssh")
      .description("SSH connection and remote terminal management");

    // Windows gate: every subcommand below ultimately shells out to POSIX
    // tooling that has no first-class equivalent on cmd / PowerShell yet.
    ssh.hook("preAction", () => {
      if (process.platform === "win32") {
        process.stderr.write(
          "SSH plugin is not supported on Windows yet — see issue tracker.\n",
        );
        process.exit(1);
      }
    });

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
              process.stdout.write(
                "Use the agent API to list SSH connections: GET /api/ssh/connections\n",
              );
              return;
            }
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
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
              process.stdout.write(
                "Use the agent API to list terminal sessions: GET /api/ssh/terminal/sessions\n",
              );
              return;
            }
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
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
        if (maybePrintJson(opts, { ok: true, action: "install-jobs", message }))
          return;
        process.stdout.write(`${message}\n`);
      });
  },
};

export default vibePlugin;
