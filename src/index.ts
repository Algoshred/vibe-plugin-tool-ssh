import type { FastifyInstance } from "fastify";
import type { Command } from "commander";

/**
 * @burdenoff/vibe-plugin-ssh
 *
 * SSH connections, remote command execution, and port forwarding plugin
 * for the VibeControls Agent. This plugin registers:
 *
 *   - Fastify routes: /api/ssh/*, /api/port-forward/*
 *   - CLI commands:   vibe ssh list|add|remove|test|exec
 *                     vibe forward list|create|start|stop|delete
 *
 * Install: vibe plugin install @burdenoff/vibe-plugin-ssh
 */

// Re-export the plugin interface type for consumers
export interface VibePlugin {
  name: string;
  version: string;
  description?: string;
  cliCommand?: string;
  apiPrefix?: string;
  onCliSetup?: (program: Command) => void | Promise<void>;
  onServerStart?: (app: FastifyInstance) => void | Promise<void>;
  onServerStop?: (app: FastifyInstance) => void | Promise<void>;
}

export const vibePlugin: VibePlugin = {
  name: "ssh",
  version: "1.0.0",
  description: "SSH connections & port forwarding for VibeControls Agent",
  cliCommand: "ssh",
  apiPrefix: "/api/ssh",

  async onServerStart(app: FastifyInstance) {
    // Dynamically import ssh2 — this is the whole point of the plugin:
    // ssh2 (with native cpu-features) is only loaded when the plugin is installed.
    const { sshRoutes } = await import("./routes/ssh.js");
    const { portForwardRoutes } = await import("./routes/port-forward.js");

    await app.register(sshRoutes, { prefix: "/api/ssh" });
    await app.register(portForwardRoutes, { prefix: "/api/port-forward" });

    console.log(
      "  🔌 Plugin 'ssh' registered routes: /api/ssh, /api/port-forward",
    );
  },

  onCliSetup(program: Command) {
    // SSH CLI commands are registered by the agent's built-in CLI for now.
    // In a future version, the CLI commands will also move into this plugin.
    // For now, the plugin only contributes server-side routes.
  },
};

export default vibePlugin;
