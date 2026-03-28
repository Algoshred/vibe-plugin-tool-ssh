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
      .action(() => {
        console.log(
          "Use the agent API to list SSH connections: GET /api/ssh/connections",
        );
      });

    ssh
      .command("terminals")
      .description("List active remote terminal sessions")
      .action(() => {
        console.log(
          "Use the agent API to list terminal sessions: GET /api/ssh/terminal/sessions",
        );
      });

    ssh
      .command("install-jobs")
      .description("List remote agent installation jobs")
      .action(() => {
        console.log(
          "Use the agent API to list install jobs: GET /api/ssh/agent-install/jobs",
        );
      });
  },
};

export default vibePlugin;
