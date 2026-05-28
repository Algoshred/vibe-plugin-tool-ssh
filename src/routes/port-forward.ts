/**
 * Port-forwarding routes (Elysia + KV storage).
 *
 * Namespace: "ssh"
 * Keys:
 *   "connections"   → JSON array of SSHConnection objects  (read-only here)
 *   "port-forwards" → JSON array of PortForward objects
 */

import { Elysia } from "elysia";
import { Client } from "ssh2";
import { createServer, type Server } from "node:net";
import { expandPath } from "../utils/expand-path";
import type {
  HostServices,
  SSHConnection,
  PortForward,
  CreatePortForwardBody,
} from "../types.js";

// ---------------------------------------------------------------------------
// In-memory map of currently active tunnels
// ---------------------------------------------------------------------------

const activeConnections = new Map<string, { client: Client; server: Server }>();

// ---------------------------------------------------------------------------
// KV helpers – connections (read-only from this module)
// ---------------------------------------------------------------------------

async function getConnectionById(
  storage: HostServices["storage"],
  id: string,
): Promise<SSHConnection | undefined> {
  const raw = await storage.get("ssh", "connections");
  if (!raw) return undefined;
  const all = JSON.parse(raw) as SSHConnection[];
  return all.find((c) => c.id === id);
}

async function getConnectionByName(
  storage: HostServices["storage"],
  serverName: string,
): Promise<SSHConnection | undefined> {
  const raw = await storage.get("ssh", "connections");
  if (!raw) return undefined;
  const all = JSON.parse(raw) as SSHConnection[];
  return all.find((c) => c.serverName === serverName);
}

// ---------------------------------------------------------------------------
// KV helpers – port forwards
// ---------------------------------------------------------------------------

async function getAllPortForwards(
  storage: HostServices["storage"],
): Promise<PortForward[]> {
  const raw = await storage.get("ssh", "port-forwards");
  if (!raw) return [];
  return JSON.parse(raw) as PortForward[];
}

async function getPortForwardById(
  storage: HostServices["storage"],
  id: string,
): Promise<PortForward | undefined> {
  const all = await getAllPortForwards(storage);
  return all.find((pf) => pf.id === id);
}

async function savePortForwards(
  storage: HostServices["storage"],
  forwards: PortForward[],
): Promise<void> {
  await storage.set("ssh", "port-forwards", JSON.stringify(forwards));
}

async function updatePortForward(
  storage: HostServices["storage"],
  id: string,
  patch: Partial<PortForward>,
): Promise<void> {
  const all = await getAllPortForwards(storage);
  const idx = all.findIndex((pf) => pf.id === id);
  if (idx !== -1) {
    all[idx] = { ...all[idx], ...patch };
    await savePortForwards(storage, all);
  }
}

async function deletePortForwardById(
  storage: HostServices["storage"],
  id: string,
): Promise<void> {
  const all = await getAllPortForwards(storage);
  const filtered = all.filter((pf) => pf.id !== id);
  await savePortForwards(storage, filtered);
}

// ---------------------------------------------------------------------------
// Build an ssh2 connect config from a stored connection
// ---------------------------------------------------------------------------

async function buildConnectConfig(conn: SSHConnection) {
  const cfg: {
    host: string;
    port: number;
    username: string;
    privateKey?: Buffer;
    password?: string;
  } = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
  };

  if (conn.privateKeyPath) {
    const file = Bun.file(expandPath(conn.privateKeyPath));
    cfg.privateKey = Buffer.from(await file.arrayBuffer());
  } else if (conn.password) {
    cfg.password = conn.password;
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// Cleanup helper — exported so onServerStop can call it too
// ---------------------------------------------------------------------------

export function cleanupAllTunnels(): void {
  for (const [, { client, server }] of activeConnections) {
    server.close();
    client.end();
  }
  activeConnections.clear();
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createPortForwardRoutes(hostServices: HostServices) {
  const { storage, eventBus } = hostServices;

  return (
    new Elysia({ prefix: "/api/port-forward" })

      // -----------------------------------------------------------------------
      // GET /api/port-forward — list all port forwards
      // -----------------------------------------------------------------------
      .get("/", async () => {
        const portForwards = await getAllPortForwards(storage);
        return { portForwards };
      })

      // -----------------------------------------------------------------------
      // POST /api/port-forward — create a new port forward config
      // -----------------------------------------------------------------------
      .post("/", async ({ body, set }) => {
        const { localPort, remoteHost, remotePort, connectionId } =
          body as CreatePortForwardBody;

        try {
          const existing = (await getAllPortForwards(storage)).find(
            (pf) => pf.localPort === localPort && pf.status === "active",
          );

          if (existing) {
            set.status = 409;
            return { error: "Local port is already in use" };
          }

          const connectionConfig = await getConnectionById(
            storage,
            connectionId,
          );
          if (!connectionConfig) {
            set.status = 404;
            return { error: "SSH connection not found" };
          }

          const newPf: PortForward = {
            id: globalThis.crypto.randomUUID(),
            localPort,
            remoteHost,
            remotePort,
            serverName: connectionConfig.serverName,
            connectionId,
            status: "inactive",
            createdAt: new Date().toISOString(),
          };

          const all = await getAllPortForwards(storage);
          all.push(newPf);
          await savePortForwards(storage, all);

          return { portForward: newPf };
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to create port forward",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })

      // -----------------------------------------------------------------------
      // POST /api/port-forward/:id/start — start the tunnel
      // -----------------------------------------------------------------------
      .post("/:id/start", async ({ params, set }) => {
        const { id } = params;

        try {
          const portForward = await getPortForwardById(storage, id);
          if (!portForward) {
            set.status = 404;
            return { error: "Port forward not found" };
          }

          if (portForward.status === "active") {
            set.status = 400;
            return { error: "Port forward is already active" };
          }

          // Resolve connection config (by id first, then by serverName)
          const connectionConfig = portForward.connectionId
            ? await getConnectionById(storage, portForward.connectionId)
            : await getConnectionByName(storage, portForward.serverName);

          if (!connectionConfig) {
            set.status = 404;
            return { error: "SSH connection not found" };
          }

          const sshClient = new Client();
          const connectConfig = await buildConnectConfig(connectionConfig);

          const server = createServer((localSocket) => {
            sshClient.forwardOut(
              "localhost",
              portForward.localPort,
              portForward.remoteHost,
              portForward.remotePort,
              (err, stream) => {
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
              },
            );
          });

          return new Promise((resolve) => {
            sshClient.on("ready", () => {
              server.listen(portForward.localPort, () => {
                activeConnections.set(id, { client: sshClient, server });

                // Persist status change
                void updatePortForward(storage, id, { status: "active" });

                if (eventBus) {
                  eventBus.emit("portforward:started", {
                    id,
                    localPort: portForward.localPort,
                  });
                } else {
                  console.log(
                    `[port-forward] Started tunnel ${id} on localhost:${portForward.localPort}`,
                  );
                }

                resolve({
                  success: true,
                  message: `Port forwarding started on localhost:${portForward.localPort}`,
                });
              });

              server.on("error", (err) => {
                sshClient.end();
                set.status = 500;
                resolve({
                  error: "Failed to start local server",
                  details: err.message,
                });
              });
            });

            sshClient.on("error", (err) => {
              set.status = 500;
              resolve({
                error: "SSH connection failed",
                details: err.message,
              });
            });

            sshClient.connect(connectConfig);
          });
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to start port forward",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })

      // -----------------------------------------------------------------------
      // POST /api/port-forward/:id/stop — stop an active tunnel
      // -----------------------------------------------------------------------
      .post("/:id/stop", async ({ params, set }) => {
        const { id } = params;

        try {
          const portForward = await getPortForwardById(storage, id);
          if (!portForward) {
            set.status = 404;
            return { error: "Port forward not found" };
          }

          if (portForward.status !== "active") {
            set.status = 400;
            return { error: "Port forward is not active" };
          }

          const active = activeConnections.get(id);
          if (active) {
            active.server.close();
            active.client.end();
            activeConnections.delete(id);
          }

          await updatePortForward(storage, id, { status: "inactive" });

          if (eventBus) {
            eventBus.emit("portforward:stopped", {
              id,
              localPort: portForward.localPort,
            });
          } else {
            console.log(
              `[port-forward] Stopped tunnel ${id} (localhost:${portForward.localPort})`,
            );
          }

          return { success: true };
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to stop port forward",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })

      // -----------------------------------------------------------------------
      // DELETE /api/port-forward/:id — delete a port forward (stops if active)
      // -----------------------------------------------------------------------
      .delete("/:id", async ({ params, set }) => {
        const { id } = params;

        try {
          const portForward = await getPortForwardById(storage, id);
          if (!portForward) {
            set.status = 404;
            return { error: "Port forward not found" };
          }

          // Tear down tunnel if still active
          if (portForward.status === "active") {
            const active = activeConnections.get(id);
            if (active) {
              active.server.close();
              active.client.end();
              activeConnections.delete(id);
            }
          }

          await deletePortForwardById(storage, id);

          return { success: true };
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to delete port forward",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })
  );
}
