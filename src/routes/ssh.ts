/**
 * SSH connection management routes (Elysia + KV storage).
 *
 * Namespace: "ssh"
 * Keys:
 *   "connections" → JSON array of SSHConnection objects
 */

import { Elysia } from "elysia";
import { Client } from "ssh2";
import type {
  HostServices,
  SSHConnection,
  CreateConnectionBody,
  ExecuteCommandBody,
} from "../types.js";

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

async function getAllConnections(
  storage: HostServices["storage"],
): Promise<SSHConnection[]> {
  const raw = await storage.get("ssh", "connections");
  if (!raw) return [];
  return JSON.parse(raw) as SSHConnection[];
}

async function getConnectionById(
  storage: HostServices["storage"],
  id: string,
): Promise<SSHConnection | undefined> {
  const all = await getAllConnections(storage);
  return all.find((c) => c.id === id);
}

async function saveConnections(
  storage: HostServices["storage"],
  connections: SSHConnection[],
): Promise<void> {
  await storage.set("ssh", "connections", JSON.stringify(connections));
}

// ---------------------------------------------------------------------------
// Sanitise a connection for API responses (strip secrets)
// ---------------------------------------------------------------------------

function sanitise(conn: SSHConnection): Omit<
  SSHConnection,
  "password" | "privateKeyPath"
> & {
  privateKeyPath?: string;
} {
  const { password: _pw, privateKeyPath: _pk, ...rest } = conn;
  return {
    ...rest,
    privateKeyPath: conn.privateKeyPath ? "***" : undefined,
  };
}

// ---------------------------------------------------------------------------
// Build an ssh2 connect config from a stored connection
// ---------------------------------------------------------------------------

async function buildConnectConfig(conn: SSHConnection) {
  const cfg: {
    host: string;
    port: number;
    username: string;
    readyTimeout?: number;
    privateKey?: Buffer;
    password?: string;
  } = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
  };

  if (conn.privateKeyPath) {
    const file = Bun.file(conn.privateKeyPath);
    cfg.privateKey = Buffer.from(await file.arrayBuffer());
  } else if (conn.password) {
    cfg.password = conn.password;
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createSSHRoutes(hostServices: HostServices) {
  const { storage, eventBus } = hostServices;

  return (
    new Elysia({ prefix: "/api/ssh" })

      // -----------------------------------------------------------------------
      // GET /api/ssh/connections — list all saved SSH connections
      // -----------------------------------------------------------------------
      .get("/connections", async () => {
        const connections = await getAllConnections(storage);
        return { connections: connections.map(sanitise) };
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/connections — create a new SSH connection config
      // -----------------------------------------------------------------------
      .post("/connections", async ({ body, set }) => {
        const {
          serverName,
          host,
          port = 22,
          username,
          privateKeyPath,
          password,
        } = body as CreateConnectionBody;

        try {
          const connections = await getAllConnections(storage);

          const newConn: SSHConnection = {
            id: globalThis.crypto.randomUUID(),
            serverName,
            host,
            port,
            username,
            privateKeyPath,
            password,
            createdAt: new Date().toISOString(),
          };

          connections.push(newConn);
          await saveConnections(storage, connections);

          return { connection: sanitise(newConn) };
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to create SSH connection",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/execute — execute a command on a remote server
      // -----------------------------------------------------------------------
      .post("/execute", async ({ body, set }) => {
        const { connectionId, command, workingDirectory } =
          body as ExecuteCommandBody;

        try {
          const connectionConfig = await getConnectionById(
            storage,
            connectionId,
          );
          if (!connectionConfig) {
            set.status = 404;
            return { error: "SSH connection not found" };
          }

          const conn = new Client();
          let output = "";
          let errorOutput = "";

          const connectConfig = await buildConnectConfig(connectionConfig);

          return new Promise((resolve) => {
            conn.on("ready", () => {
              const fullCommand = workingDirectory
                ? `cd ${workingDirectory} && ${command}`
                : command;

              conn.exec(fullCommand, (err, stream) => {
                if (err) {
                  conn.end();
                  set.status = 500;
                  resolve({
                    error: "Failed to execute command",
                    details: err.message,
                  });
                  return;
                }

                stream.on("close", (code: number) => {
                  conn.end();
                  resolve({
                    output,
                    errorOutput,
                    exitCode: code,
                    success: code === 0,
                  });
                });

                stream.on("data", (data: Buffer) => {
                  output += data.toString();
                  if (eventBus) {
                    eventBus.emit("ssh:output", {
                      connectionId,
                      data: data.toString(),
                      type: "stdout",
                    });
                  } else {
                    console.log(
                      `[ssh:stdout] ${connectionId}: ${data.toString().trimEnd()}`,
                    );
                  }
                });

                stream.stderr.on("data", (data: Buffer) => {
                  errorOutput += data.toString();
                  if (eventBus) {
                    eventBus.emit("ssh:output", {
                      connectionId,
                      data: data.toString(),
                      type: "stderr",
                    });
                  } else {
                    console.error(
                      `[ssh:stderr] ${connectionId}: ${data.toString().trimEnd()}`,
                    );
                  }
                });
              });
            });

            conn.on("error", (err) => {
              set.status = 500;
              resolve({
                error: "SSH connection failed",
                details: err.message,
              });
            });

            conn.connect(connectConfig);
          });
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to execute SSH command",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/test/:connectionId — test an SSH connection
      // -----------------------------------------------------------------------
      .post("/test/:connectionId", async ({ params, set }) => {
        const { connectionId } = params;

        try {
          const connectionConfig = await getConnectionById(
            storage,
            connectionId,
          );
          if (!connectionConfig) {
            set.status = 404;
            return { error: "SSH connection not found" };
          }

          const conn = new Client();
          const testConfig = await buildConnectConfig(connectionConfig);

          return new Promise((resolve) => {
            conn.on("ready", () => {
              conn.end();
              resolve({ success: true, message: "Connection successful" });
            });

            conn.on("error", (err) => {
              set.status = 500;
              resolve({
                success: false,
                error: "Connection failed",
                details: err.message,
              });
            });

            conn.connect({
              ...testConfig,
              readyTimeout: 10_000,
            });
          });
        } catch (error) {
          set.status = 500;
          return {
            success: false,
            error: "Failed to test connection",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })

      // -----------------------------------------------------------------------
      // DELETE /api/ssh/connections/:id — remove a saved SSH connection
      // -----------------------------------------------------------------------
      .delete("/connections/:id", async ({ params, set }) => {
        const { id } = params;

        try {
          const connections = await getAllConnections(storage);
          const idx = connections.findIndex((c) => c.id === id);

          if (idx === -1) {
            set.status = 404;
            return { error: "Connection not found" };
          }

          connections.splice(idx, 1);
          await saveConnections(storage, connections);

          return { success: true };
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to delete connection",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })
  );
}
