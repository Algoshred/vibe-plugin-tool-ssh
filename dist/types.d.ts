/**
 * Type declarations for Fastify decorations provided by the vibe-agent host.
 * These are available at runtime when the plugin is loaded by the agent.
 */
import "fastify";
import type { Server as SocketIOServer } from "socket.io";
declare module "fastify" {
    interface FastifyInstance {
        db: any;
        io: SocketIOServer;
    }
}
//# sourceMappingURL=types.d.ts.map