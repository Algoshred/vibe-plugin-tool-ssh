/**
 * Remote terminal routes – start ttyd on a destination server via SSH,
 * port-forward back to a local port on the agent, and serve it through
 * the agent's existing terminal WebSocket proxy.
 *
 * Namespace: "ssh"
 * Keys:
 *   "terminal-sessions" → JSON array of SSHTerminalSession objects
 */

import { Elysia } from "elysia";
import { Client } from "ssh2";
import { createServer, type Server } from "node:net";
import type { Subprocess } from "bun";
import { expandPath } from "../utils/expand-path";
import type {
  HostServices,
  SSHConnection,
  SSHTerminalSession,
  StartTerminalBody,
  StopTerminalBody,
} from "../types.js";

// ---------------------------------------------------------------------------
// In-memory state for active SSH terminal sessions
// ---------------------------------------------------------------------------

interface ActiveTerminal {
  sshClient: Client;
  sshTunnelProc?: Subprocess;
  session: SSHTerminalSession;
}

const activeTerminals = new Map<string, ActiveTerminal>();

// ---------------------------------------------------------------------------
// KV helpers
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

async function persistSessions(
  storage: HostServices["storage"],
): Promise<void> {
  const sessions = Array.from(activeTerminals.values()).map((t) => t.session);
  await storage.set("ssh", "terminal-sessions", JSON.stringify(sessions));
}

// ---------------------------------------------------------------------------
// SSH helpers
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
// Find a free port on the remote server
// ---------------------------------------------------------------------------

async function findFreeRemotePort(
  client: Client,
  start = 7881,
  end = 8080,
): Promise<number> {
  for (let port = start; port <= end; port++) {
    const { code } = await sshExec(
      client,
      `ss -tlnp 2>/dev/null | grep -q ':${port} ' && echo taken || echo free`,
    );
    // If grep finds the port, code is 0 and output contains "taken".
    // We just check the stdout text directly.
    const { stdout } = await sshExec(
      client,
      `ss -tlnp 2>/dev/null | grep -q ':${port} ' && echo taken || echo free`,
    );
    if (stdout === "free") return port;
  }
  throw new Error(
    `No free port found on remote server in range ${start}-${end}`,
  );
}

// ---------------------------------------------------------------------------
// Find a free local port on the agent
// ---------------------------------------------------------------------------

function findFreeLocalPort(start = 7681, end = 7880): Promise<number> {
  return new Promise((resolve, reject) => {
    let current = start;

    function tryPort() {
      if (current > end) {
        return reject(
          new Error(`No free local port found in range ${start}-${end}`),
        );
      }

      // Check if any active terminal already uses this port
      for (const [, t] of activeTerminals) {
        if (t.session.localPort === current) {
          current++;
          return tryPort();
        }
      }

      const srv = createServer();
      srv.once("error", () => {
        current++;
        tryPort();
      });
      srv.once("listening", () => {
        srv.close(() => resolve(current));
      });
      srv.listen(current, "127.0.0.1");
    }

    tryPort();
  });
}

// ---------------------------------------------------------------------------
// Install ttyd on remote if missing
// ---------------------------------------------------------------------------

async function ensureTtydInstalled(client: Client): Promise<boolean> {
  const { code } = await sshExec(client, "which ttyd");
  if (code === 0) return true;

  // Detect package manager and try to install
  const { stdout: osRelease } = await sshExec(
    client,
    "cat /etc/os-release 2>/dev/null || echo unknown",
  );

  let installCmd: string;

  if (
    osRelease.includes("debian") ||
    osRelease.includes("ubuntu") ||
    osRelease.includes("ID=debian") ||
    osRelease.includes("ID=ubuntu")
  ) {
    installCmd =
      "sudo apt-get update -qq && sudo apt-get install -y -qq ttyd 2>/dev/null";
  } else if (
    osRelease.includes("centos") ||
    osRelease.includes("fedora") ||
    osRelease.includes("rhel") ||
    osRelease.includes("ID=centos") ||
    osRelease.includes("ID=fedora")
  ) {
    installCmd = "sudo yum install -y -q ttyd 2>/dev/null";
  } else if (osRelease.includes("alpine") || osRelease.includes("ID=alpine")) {
    installCmd = "sudo apk add --quiet ttyd 2>/dev/null";
  } else {
    // Fallback: try downloading binary from GitHub
    const { stdout: arch } = await sshExec(client, "uname -m");
    const archMap: Record<string, string> = {
      x86_64: "x86_64",
      aarch64: "aarch64",
      arm64: "aarch64",
    };
    const mappedArch = archMap[arch] || "x86_64";
    installCmd = `curl -fsSL "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${mappedArch}" -o /tmp/ttyd && chmod +x /tmp/ttyd && sudo mv /tmp/ttyd /usr/local/bin/ttyd`;
  }

  const result = await sshExec(client, installCmd);
  if (result.code !== 0) {
    // Try without sudo
    const { code: retryCode } = await sshExec(
      client,
      installCmd.replace(/sudo /g, ""),
    );
    return retryCode === 0;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanupAllTerminals(): void {
  for (const [id, terminal] of activeTerminals) {
    try {
      if (terminal.sshTunnelProc) terminal.sshTunnelProc.kill();
    } catch {
      /* ignore */
    }
    try {
      terminal.sshClient.end();
    } catch {
      /* ignore */
    }
    activeTerminals.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Session provider shim – exposes getTerminalInfo() so the agent's terminal
// proxy at /terminal/:sessionId/ws can find and route to our forwarded port.
// ---------------------------------------------------------------------------

export function getTerminalInfo(
  sessionId: string,
): { url: string; port: number; pid: number } | null {
  const terminal = activeTerminals.get(sessionId);
  if (!terminal || terminal.session.status !== "active") return null;
  return {
    url: `http://127.0.0.1:${terminal.session.localPort}`,
    port: terminal.session.localPort,
    pid: process.pid, // Agent's own PID – always alive while agent runs
  };
}

/** List all active terminal sessions (for the session provider shim). */
export function listTerminalSessions(): SSHTerminalSession[] {
  return Array.from(activeTerminals.values()).map((t) => t.session);
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createRemoteTerminalRoutes(hostServices: HostServices) {
  const { storage, broadcast } = hostServices;

  return (
    new Elysia({ prefix: "/api/ssh/terminal" })

      // -----------------------------------------------------------------------
      // GET /api/ssh/terminal/sessions — list active remote terminal sessions
      // -----------------------------------------------------------------------
      .get("/sessions", () => {
        return { sessions: listTerminalSessions() };
      })

      // -----------------------------------------------------------------------
      // GET /api/ssh/terminal/sessions/:id — get a specific session
      // -----------------------------------------------------------------------
      .get("/sessions/:id", ({ params, set }) => {
        const terminal = activeTerminals.get(params.id);
        if (!terminal) {
          set.status = 404;
          return { error: "Terminal session not found" };
        }
        return { session: terminal.session };
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/terminal/start — start remote ttyd + SSH port forward
      // -----------------------------------------------------------------------
      .post("/start", async ({ body, set }) => {
        const { connectionId, shell = "bash" } = body as StartTerminalBody;

        try {
          // 1. Look up connection
          const connConfig = await getConnectionById(storage, connectionId);
          if (!connConfig) {
            set.status = 404;
            return { error: "SSH connection not found" };
          }

          const sessionId = globalThis.crypto.randomUUID();
          const session: SSHTerminalSession = {
            id: sessionId,
            connectionId,
            remotePort: 0,
            localPort: 0,
            remotePid: null,
            shell,
            status: "starting",
            startedAt: new Date().toISOString(),
          };

          // 2. Establish SSH connection
          const sshClient = new Client();
          const connectConfig = await buildConnectConfig(connConfig);

          return new Promise((resolve) => {
            sshClient.on("error", (err) => {
              session.status = "error";
              session.error = err.message;
              set.status = 500;
              resolve({
                error: "SSH connection failed",
                details: err.message,
              });
            });

            sshClient.on("ready", async () => {
              try {
                // 3. Ensure ttyd is installed on remote
                const installed = await ensureTtydInstalled(sshClient);
                if (!installed) {
                  sshClient.end();
                  session.status = "error";
                  session.error = "Failed to install ttyd on remote server";
                  set.status = 500;
                  return resolve({
                    error:
                      "ttyd is not installed on the remote server and auto-install failed",
                  });
                }

                // 4. Find free remote port
                const remotePort = await findFreeRemotePort(sshClient);
                session.remotePort = remotePort;

                // 5. Start ttyd on remote
                const { stdout: pidOutput, code: startCode } = await sshExec(
                  sshClient,
                  `nohup ttyd --writable --port ${remotePort} ${shell} > /dev/null 2>&1 & echo $!`,
                );

                if (startCode !== 0 || !pidOutput) {
                  sshClient.end();
                  session.status = "error";
                  session.error = "Failed to start ttyd on remote";
                  set.status = 500;
                  return resolve({ error: "Failed to start ttyd on remote" });
                }

                const remotePid = parseInt(pidOutput, 10);
                session.remotePid = remotePid;

                // 6. Wait for ttyd to bind and verify it's listening
                await new Promise((r) => setTimeout(r, 1500));
                const { stdout: listenCheck } = await sshExec(
                  sshClient,
                  `ss -tlnp 2>/dev/null | grep ':${remotePort} ' || echo NOT_LISTENING`,
                );
                if (listenCheck.includes("NOT_LISTENING")) {
                  // ttyd may need more time
                  await new Promise((r) => setTimeout(r, 2000));
                }

                // 7. Allocate local port + create SSH port forward
                //    Uses a real `ssh -L` subprocess for the tunnel
                //    because ssh2's forwardOut + Bun has data piping
                //    issues with WebSocket-heavy protocols like ttyd.
                const localPort = await findFreeLocalPort();
                session.localPort = localPort;

                try {
                  // Build ssh command args
                  const sshArgs: string[] = [
                    "-N", // No remote command
                    "-L",
                    `${localPort}:127.0.0.1:${remotePort}`,
                    "-o",
                    "StrictHostKeyChecking=accept-new",
                    "-o",
                    "ServerAliveInterval=30",
                    "-o",
                    "ExitOnForwardFailure=yes",
                    "-p",
                    String(connConfig.port),
                  ];

                  if (connConfig.privateKeyPath) {
                    sshArgs.push("-i", expandPath(connConfig.privateKeyPath));
                  }

                  sshArgs.push(`${connConfig.username}@${connConfig.host}`);

                  const sshProc = Bun.spawn(["ssh", ...sshArgs], {
                    stdout: "ignore",
                    stderr: "pipe",
                  });

                  // Wait for the tunnel to be ready
                  await new Promise((r) => setTimeout(r, 2000));

                  // Verify the local port is listening
                  const checkSrv = createServer();
                  const portBound = await new Promise<boolean>((res) => {
                    checkSrv.once("error", () => res(true)); // Port in use = tunnel working
                    checkSrv.once("listening", () => {
                      checkSrv.close();
                      res(false); // Port free = tunnel not ready
                    });
                    checkSrv.listen(localPort, "127.0.0.1");
                  });

                  if (!portBound) {
                    // Tunnel didn't bind yet, wait more
                    await new Promise((r) => setTimeout(r, 2000));
                  }

                  session.status = "active";

                  activeTerminals.set(sessionId, {
                    sshClient,
                    sshTunnelProc: sshProc,
                    session,
                  });

                  void persistSessions(storage);

                  if (broadcast) {
                    broadcast("ssh:terminal:started", {
                      sessionId,
                      connectionId,
                      localPort,
                      remotePort,
                      host: connConfig.host,
                    });
                  }

                  resolve({
                    sessionId,
                    connectionId,
                    localPort,
                    remotePort,
                    host: connConfig.host,
                    status: "active",
                  });
                } catch (bindErr) {
                  void sshExec(sshClient, `kill ${remotePid} 2>/dev/null`);
                  sshClient.end();
                  session.status = "error";
                  session.error =
                    bindErr instanceof Error
                      ? bindErr.message
                      : "Port bind failed";
                  set.status = 500;
                  resolve({
                    error: "Failed to bind local port",
                    details: session.error,
                  });
                }
              } catch (err) {
                sshClient.end();
                session.status = "error";
                session.error =
                  err instanceof Error ? err.message : "Unknown error";
                set.status = 500;
                resolve({
                  error: "Failed to start remote terminal",
                  details: session.error,
                });
              }
            });

            sshClient.connect(connectConfig);
          });
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to start remote terminal",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/terminal/stop — stop a remote ttyd session
      // -----------------------------------------------------------------------
      .post("/stop", async ({ body, set }) => {
        const { sessionId } = body as StopTerminalBody;

        const terminal = activeTerminals.get(sessionId);
        if (!terminal) {
          set.status = 404;
          return { error: "Terminal session not found" };
        }

        try {
          terminal.session.status = "stopping";

          // Kill remote ttyd process
          if (terminal.session.remotePid) {
            await sshExec(
              terminal.sshClient,
              `kill ${terminal.session.remotePid} 2>/dev/null`,
            ).catch(() => {});
          }

          // Kill SSH tunnel subprocess
          if (terminal.sshTunnelProc) {
            terminal.sshTunnelProc.kill();
          }

          // Close SSH connection (used for exec commands)
          terminal.sshClient.end();

          terminal.session.status = "stopped";
          activeTerminals.delete(sessionId);

          void persistSessions(storage);

          if (broadcast) {
            broadcast("ssh:terminal:stopped", {
              sessionId,
              connectionId: terminal.session.connectionId,
            });
          }

          return { success: true, sessionId };
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to stop terminal session",
            details: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })
  );
}
