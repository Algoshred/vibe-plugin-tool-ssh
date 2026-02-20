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
export interface VibePlugin {
    name: string;
    version: string;
    description?: string;
    onCliSetup?: (program: Command) => void | Promise<void>;
    onServerStart?: (app: FastifyInstance) => void | Promise<void>;
    onServerStop?: (app: FastifyInstance) => void | Promise<void>;
}
export declare const vibePlugin: VibePlugin;
export default vibePlugin;
//# sourceMappingURL=index.d.ts.map