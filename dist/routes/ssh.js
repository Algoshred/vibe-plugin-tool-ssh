import crypto from "node:crypto";
import { Client } from "ssh2";
import { readFileSync } from "fs";
export const sshRoutes = async (fastify) => {
    // Get all SSH connections
    fastify.get("/connections", async (_request, _reply) => {
        const connections = fastify.db.getAllSSHConnections();
        const safeConnections = connections.map((conn) => ({
            ...conn,
            password: undefined,
            privateKeyPath: conn.privateKeyPath ? "***" : undefined,
        }));
        return { connections: safeConnections };
    });
    // Create SSH connection config
    fastify.post("/connections", async (request, reply) => {
        const { serverName, host, port = 22, username, privateKeyPath, password, } = request.body;
        try {
            const connection = fastify.db.createSSHConnection({
                id: crypto.randomUUID(),
                serverName,
                host,
                port,
                username,
                privateKeyPath,
                password,
            });
            return {
                connection: {
                    ...connection,
                    password: undefined,
                    privateKeyPath: connection.privateKeyPath ? "***" : undefined,
                },
            };
        }
        catch (error) {
            return reply.code(500).send({
                error: "Failed to create SSH connection",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // Execute command on remote server
    fastify.post("/execute", async (request, reply) => {
        const { connectionId, command, workingDirectory } = request.body;
        try {
            const connectionConfig = fastify.db.getSSHConnection(connectionId);
            if (!connectionConfig) {
                return reply.code(404).send({ error: "SSH connection not found" });
            }
            const conn = new Client();
            let output = "";
            let errorOutput = "";
            return new Promise((resolve) => {
                conn.on("ready", () => {
                    const fullCommand = workingDirectory
                        ? `cd ${workingDirectory} && ${command}`
                        : command;
                    conn.exec(fullCommand, (err, stream) => {
                        if (err) {
                            conn.end();
                            return resolve(reply.code(500).send({
                                error: "Failed to execute command",
                                details: err.message,
                            }));
                        }
                        stream.on("close", (code) => {
                            conn.end();
                            resolve({
                                output,
                                errorOutput,
                                exitCode: code,
                                success: code === 0,
                            });
                        });
                        stream.on("data", (data) => {
                            output += data.toString();
                            fastify.io.emit("ssh:output", {
                                connectionId,
                                data: data.toString(),
                                type: "stdout",
                            });
                        });
                        stream.stderr.on("data", (data) => {
                            errorOutput += data.toString();
                            fastify.io.emit("ssh:output", {
                                connectionId,
                                data: data.toString(),
                                type: "stderr",
                            });
                        });
                    });
                });
                conn.on("error", (err) => {
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
                conn.connect(connectConfig);
            });
        }
        catch (error) {
            return reply.code(500).send({
                error: "Failed to execute SSH command",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // Test SSH connection
    fastify.post("/test/:connectionId", async (request, reply) => {
        const { connectionId } = request.params;
        try {
            const connectionConfig = fastify.db.getSSHConnection(connectionId);
            if (!connectionConfig) {
                return reply.code(404).send({ error: "SSH connection not found" });
            }
            const conn = new Client();
            return new Promise((resolve) => {
                conn.on("ready", () => {
                    conn.end();
                    resolve({ success: true, message: "Connection successful" });
                });
                conn.on("error", (err) => {
                    resolve(reply.code(500).send({
                        success: false,
                        error: "Connection failed",
                        details: err.message,
                    }));
                });
                const connectConfig = {
                    host: connectionConfig.host,
                    port: connectionConfig.port,
                    username: connectionConfig.username,
                    readyTimeout: 10000,
                };
                if (connectionConfig.privateKeyPath) {
                    connectConfig.privateKey = readFileSync(connectionConfig.privateKeyPath);
                }
                else if (connectionConfig.password) {
                    connectConfig.password = connectionConfig.password;
                }
                conn.connect(connectConfig);
            });
        }
        catch (error) {
            return reply.code(500).send({
                success: false,
                error: "Failed to test connection",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // Delete SSH connection
    fastify.delete("/connections/:id", async (request, reply) => {
        const { id } = request.params;
        try {
            const connection = fastify.db.getSSHConnection(id);
            if (!connection) {
                return reply.code(404).send({ error: "Connection not found" });
            }
            fastify.db.deleteSSHConnection(id);
            return { success: true };
        }
        catch (error) {
            return reply.code(500).send({
                error: "Failed to delete connection",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
};
//# sourceMappingURL=ssh.js.map