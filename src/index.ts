/**
 * @burdenoff/vibe-plugin-ssh v2.0.0
 *
 * SSH connections, remote command execution, and port forwarding plugin
 * for the VibeControls Agent (Bun / Elysia / KV storage).
 *
 * Registers:
 *   - Elysia routes: /api/ssh/*, /api/port-forward/*
 *   - CLI stub:      (SSH CLI commands to be implemented later)
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
} from "./types.js";

// ---------------------------------------------------------------------------
// Module-level reference so onServerStop can clean up
// ---------------------------------------------------------------------------

let cleanupFn: (() => void) | undefined;

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const vibePlugin: VibePlugin = {
  name: "ssh",
  version: "2.0.0",
  description: "SSH connection management and port forwarding",
  tags: ["backend", "cli", "integration"],
  cliCommand: "ssh",
  apiPrefix: "/api/ssh",

  async onServerStart(app: Elysia, hostServices: HostServices) {
    // Dynamically import route modules — ssh2 native deps only load when
    // the plugin is actually activated.
    const { createSSHRoutes } = await import("./routes/ssh.js");
    const { createPortForwardRoutes, cleanupAllTunnels } =
      await import("./routes/port-forward.js");

    app.use(createSSHRoutes(hostServices));
    app.use(createPortForwardRoutes(hostServices));

    // Stash the cleanup function for onServerStop
    cleanupFn = cleanupAllTunnels;

    console.log(
      "  Plugin 'ssh' registered routes: /api/ssh, /api/port-forward",
    );
  },

  async onServerStop() {
    // Tear down every active SSH tunnel and connection
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = undefined;
    }
    console.log("  Plugin 'ssh' cleaned up active connections");
  },

  onCliSetup(_program: Command) {
    // SSH CLI commands to be implemented in a future version.
    // The plugin currently only contributes server-side routes.
  },
};

export default vibePlugin;
