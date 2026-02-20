import crypto from "node:crypto";
import { Client } from "ssh2";
import { createServer } from "net";
import { readFileSync } from "fs";
// Store active connections and servers
const activeConnections = new Map();
export const portForwardRoutes = async (fastify) => {
    // Get all port forwards
    fastify.get("/", async (_request, _reply) => {
        const portForwards = fastify.db.getAllPortForwards();
        return { portForwards };
    });
    // Create new port forward
    fastify.post("/", async (request, reply) => {
        const { localPort, remoteHost, remotePort, connectionId } = request.body;
        try {
            const existing = fastify.db
                .getAllPortForwards()
                .find((pf) => pf.localPort === localPort && pf.status === "active");
            if (existing) {
                return reply.code(409).send({ error: "Local port is already in use" });
            }
            const connectionConfig = fastify.db.getSSHConnection(connectionId);
            if (!connectionConfig) {
                return reply.code(404).send({ error: "SSH connection not found" });
            }
            const portForward = fastify.db.createPortForward({
                id: crypto.randomUUID(),
                localPort,
                remoteHost,
                remotePort,
                serverName: connectionConfig.serverName,
                connectionId,
                status: "inactive",
            });
            return { portForward };
        }
        catch (error) {
            return reply.code(500).send({
                error: "Failed to create port forward",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // Start port forwarding
    fastify.post("/:id/start", async (request, reply) => {
        const { id } = request.params;
        try {
            const portForward = fastify.db.getPortForward(id);
            if (!portForward) {
                return reply.code(404).send({ error: "Port forward not found" });
            }
            if (portForward.status === "active") {
                return reply
                    .code(400)
                    .send({ error: "Port forward is already active" });
            }
            const connectionConfig = portForward.connectionId
                ? fastify.db.getSSHConnection(portForward.connectionId)
                : fastify.db.getSSHConnectionByName(portForward.serverName);
            if (!connectionConfig) {
                return reply.code(404).send({ error: "SSH connection not found" });
            }
            const sshClient = new Client();
            const server = createServer((localSocket) => {
                sshClient.forwardOut("localhost", portForward.localPort, portForward.remoteHost, portForward.remotePort, (err, stream) => {
                    if (err) {
                        localSocket.end();
                        console.error("Forward error:", err);
                        return;
                    }
                    localSocket.pipe(stream).pipe(localSocket);
                    localSocket.on("close", () => {
                        stream.end();
                    });
                    stream.on("close", () => {
                        localSocket.end();
                    });
                });
            });
            return new Promise((resolve) => {
                sshClient.on("ready", () => {
                    server.listen(portForward.localPort, () => {
                        activeConnections.set(id, { client: sshClient, server });
                        fastify.db.updatePortForward(id, {
                            status: "active",
                            connectionId: id,
                        });
                        fastify.io.emit("portforward:started", {
                            id,
                            localPort: portForward.localPort,
                        });
                        resolve({
                            success: true,
                            message: `Port forwarding started on localhost:${portForward.localPort}`,
                        });
                    });
                    server.on("error", (err) => {
                        sshClient.end();
                        resolve(reply.code(500).send({
                            error: "Failed to start local server",
                            details: err.message,
                        }));
                    });
                });
                sshClient.on("error", (err) => {
                    resolve(reply.code(500).send({
                        error: "SSH connection failed",
                        details: err.message,
                    }));
                });
                const connectConfig = {
                    host: connectionConfig.host,
                    port: connectionConfig.port,
                    username: connectionConfig.username,
                };
                if (connectionConfig.privateKeyPath) {
                    connectConfig.privateKey = readFileSync(connectionConfig.privateKeyPath);
                }
                else if (connectionConfig.password) {
                    connectConfig.password = connectionConfig.password;
                }
                sshClient.connect(connectConfig);
            });
        }
        catch (error) {
            return reply.code(500).send({
                error: "Failed to start port forward",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // Stop port forwarding
    fastify.post("/:id/stop", async (request, reply) => {
        const { id } = request.params;
        try {
            const portForward = fastify.db.getPortForward(id);
            if (!portForward) {
                return reply.code(404).send({ error: "Port forward not found" });
            }
            if (portForward.status !== "active") {
                return reply.code(400).send({ error: "Port forward is not active" });
            }
            const active = activeConnections.get(id);
            if (active) {
                active.server.close();
                active.client.end();
                activeConnections.delete(id);
            }
            fastify.db.updatePortForward(id, {
                status: "inactive",
                connectionId: undefined,
            });
            fastify.io.emit("portforward:stopped", {
                id,
                localPort: portForward.localPort,
            });
            return { success: true };
        }
        catch (error) {
            return reply.code(500).send({
                error: "Failed to stop port forward",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // Delete port forward
    fastify.delete("/:id", async (request, reply) => {
        const { id } = request.params;
        try {
            const portForward = fastify.db.getPortForward(id);
            if (!portForward) {
                return reply.code(404).send({ error: "Port forward not found" });
            }
            if (portForward.status === "active") {
                const active = activeConnections.get(id);
                if (active) {
                    active.server.close();
                    active.client.end();
                    activeConnections.delete(id);
                }
            }
            fastify.db.deletePortForward(id);
            return { success: true };
        }
        catch (error) {
            return reply.code(500).send({
                error: "Failed to delete port forward",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // Cleanup on server close
    fastify.addHook("onClose", async () => {
        for (const [, { client, server }] of activeConnections) {
            server.close();
            client.end();
        }
        activeConnections.clear();
    });
};
//# sourceMappingURL=port-forward.js.map