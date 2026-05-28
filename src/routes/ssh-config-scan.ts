/**
 * SSH config scanning routes.
 *
 * Reads and parses SSH config files (e.g. ~/.ssh/config) from the local
 * filesystem or from a remote server via SSH. Presents discovered hosts
 * so users can batch-install vibecontrols-agent on them.
 */

import { homedir } from "node:os";
import { Elysia } from "elysia";
import { Client } from "ssh2";
import { expandPath } from "../utils/expand-path";
import type { HostServices, SSHConnection } from "../types.js";

// ---------------------------------------------------------------------------
// SSH config parser
// ---------------------------------------------------------------------------

export interface SSHConfigHost {
  name: string; // Host alias
  hostname: string; // HostName (actual IP/domain)
  port: number;
  user: string;
  identityFile?: string;
  proxyJump?: string;
  extra: Record<string, string>; // Other directives
}

function parseSSHConfig(content: string): SSHConfigHost[] {
  const hosts: SSHConfigHost[] = [];
  let current: Partial<SSHConfigHost> | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;

    const [, key, value] = match;
    const keyLower = key.toLowerCase();

    if (keyLower === "host") {
      // Save previous host
      if (current?.name && current.name !== "*") {
        hosts.push({
          name: current.name,
          hostname: current.hostname || current.name,
          port: current.port || 22,
          user: current.user || "root",
          identityFile: current.identityFile,
          proxyJump: current.proxyJump,
          extra: current.extra || {},
        });
      }
      current = { name: value, extra: {} };
    } else if (current) {
      switch (keyLower) {
        case "hostname":
          current.hostname = value;
          break;
        case "port":
          current.port = parseInt(value, 10);
          break;
        case "user":
          current.user = value;
          break;
        case "identityfile":
          current.identityFile = value.replace(/^~/, homedir());
          break;
        case "proxyjump":
          current.proxyJump = value;
          break;
        default:
          if (!current.extra) current.extra = {};
          current.extra[key] = value;
      }
    }
  }

  // Save last host
  if (current?.name && current.name !== "*") {
    hosts.push({
      name: current.name,
      hostname: current.hostname || current.name,
      port: current.port || 22,
      user: current.user || "root",
      identityFile: current.identityFile,
      proxyJump: current.proxyJump,
      extra: current.extra || {},
    });
  }

  return hosts;
}

// ---------------------------------------------------------------------------
// SSH helpers
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

function sshExec(
  client: Client,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      stream.on("close", (code: number) => {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createSSHConfigScanRoutes(hostServices: HostServices) {
  const { storage } = hostServices;

  return (
    new Elysia({ prefix: "/api/ssh/config-scan" })

      // -----------------------------------------------------------------------
      // POST /api/ssh/config-scan/local — scan a local SSH config file
      // -----------------------------------------------------------------------
      .post("/local", async ({ body, set }) => {
        const { configPath = "~/.ssh/config" } = body as {
          configPath?: string;
        };

        const resolved = configPath.replace(/^~/, homedir());

        try {
          const file = Bun.file(resolved);
          const exists = await file.exists();
          if (!exists) {
            set.status = 404;
            return { error: `SSH config not found at ${resolved}` };
          }

          const content = await file.text();
          const hosts = parseSSHConfig(content);

          return {
            configPath: resolved,
            hosts,
            total: hosts.length,
          };
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to read SSH config",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/config-scan/remote — scan SSH config on a remote server
      //   via an existing SSH connection
      // -----------------------------------------------------------------------
      .post("/remote", async ({ body, set }) => {
        const { connectionId, configPath = "~/.ssh/config" } = body as {
          connectionId: string;
          configPath?: string;
        };

        try {
          const connConfig = await getConnectionById(storage, connectionId);
          if (!connConfig) {
            set.status = 404;
            return { error: "SSH connection not found" };
          }

          const sshClient = new Client();
          const connectConfig = await buildConnectConfig(connConfig);

          return new Promise((resolve) => {
            sshClient.on("ready", async () => {
              try {
                const { stdout, code } = await sshExec(
                  sshClient,
                  `cat ${configPath} 2>/dev/null`,
                );

                if (code !== 0 || !stdout) {
                  sshClient.end();
                  set.status = 404;
                  return resolve({
                    error: `SSH config not found at ${configPath} on remote server`,
                  });
                }

                const hosts = parseSSHConfig(stdout);
                sshClient.end();

                resolve({
                  configPath,
                  remoteHost: connConfig.host,
                  hosts,
                  total: hosts.length,
                });
              } catch (err) {
                sshClient.end();
                set.status = 500;
                resolve({
                  error: "Failed to read remote SSH config",
                  details: err instanceof Error ? err.message : "Unknown error",
                });
              }
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
            error: "Failed to scan remote SSH config",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/config-scan/batch-create — create SSH connections from
      //   scanned hosts (bulk import from SSH config)
      // -----------------------------------------------------------------------
      .post("/batch-create", async ({ body, set }) => {
        const { hosts } = body as { hosts: SSHConfigHost[] };

        if (!hosts || !Array.isArray(hosts) || hosts.length === 0) {
          set.status = 400;
          return { error: "No hosts provided" };
        }

        try {
          const raw = await storage.get("ssh", "connections");
          const connections: SSHConnection[] = raw ? JSON.parse(raw) : [];
          const created: SSHConnection[] = [];
          const skipped: string[] = [];

          for (const host of hosts) {
            // Skip if connection with same name already exists
            if (connections.find((c) => c.serverName === host.name)) {
              skipped.push(host.name);
              continue;
            }

            const newConn: SSHConnection = {
              id: globalThis.crypto.randomUUID(),
              serverName: host.name,
              host: host.hostname,
              port: host.port,
              username: host.user,
              privateKeyPath: host.identityFile,
              createdAt: new Date().toISOString(),
            };

            connections.push(newConn);
            created.push(newConn);
          }

          await storage.set("ssh", "connections", JSON.stringify(connections));

          return {
            created: created.length,
            skipped: skipped.length,
            skippedNames: skipped,
            connections: created.map((c) => ({
              id: c.id,
              serverName: c.serverName,
              host: c.host,
              port: c.port,
              username: c.username,
            })),
          };
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to batch create connections",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })
  );
}
