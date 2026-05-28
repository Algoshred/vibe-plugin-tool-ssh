/**
 * Remote agent installation routes.
 *
 * Installs vibecontrols-agent on a target server via SSH. This is a
 * long-running operation — progress is reported via WebSocket events.
 *
 * Registry URL resolution (for @vibecontrols packages):
 *   1. hostServices.getPluginRegistry() — reads from agent config/env
 *   2. Fallback: https://registry.npmjs.org
 */

import { Elysia } from "elysia";
import { Client } from "ssh2";
import { homedir, tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { expandPath } from "../utils/expand-path";
import type {
  HostServices,
  SSHConnection,
  RemoteAgentInstallJob,
  RemoteAgentInstallStep,
  StartAgentInstallBody,
  BatchInstallBody,
  UninstallAgentBody,
} from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Common PATH setup prepended to all remote commands after bun is installed. */
const REMOTE_PATH =
  'export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"';

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

// ---------------------------------------------------------------------------
// In-memory job tracking
// ---------------------------------------------------------------------------

const installJobs = new Map<string, RemoteAgentInstallJob>();

// ---------------------------------------------------------------------------
// KV / SSH helpers
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
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }

      let stdout = "";
      let stderr = "";

      stream.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      stream.on("close", (code: number) => {
        clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Installation step definitions
// ---------------------------------------------------------------------------

const INSTALL_STEPS: Array<{ name: string }> = [
  { name: "connect" },
  { name: "detect_os" },
  { name: "install_bun" },
  { name: "install_agent" },
  { name: "configure" },
  { name: "start" },
  { name: "verify" },
  { name: "retrieve" },
  { name: "register" },
];

// ---------------------------------------------------------------------------
// Run the installation pipeline
// ---------------------------------------------------------------------------

async function runInstallation(
  job: RemoteAgentInstallJob,
  connConfig: SSHConnection,
  agentPort: number,
  hostServices: HostServices,
  options: { autoRegister?: boolean; agentName?: string } = {},
): Promise<void> {
  const { broadcast } = hostServices;
  const sshClient = new Client();

  // Resolve registry URL from agent config
  const registryUrl = hostServices.getPluginRegistry?.() ?? DEFAULT_REGISTRY;

  function emitProgress() {
    if (broadcast) broadcast("ssh:install:progress", { ...job });
  }

  function updateStep(
    stepIdx: number,
    status: RemoteAgentInstallStep["status"],
    message?: string,
  ) {
    job.steps[stepIdx].status = status;
    if (message) job.steps[stepIdx].message = message;
    job.currentStep = stepIdx;
    emitProgress();
  }

  function fail(stepIdx: number, error: string) {
    updateStep(stepIdx, "failed", error);
    job.status = "failed";
    job.error = error;
    job.completedAt = new Date().toISOString();
    if (broadcast) broadcast("ssh:install:failed", { ...job });
    sshClient.end();
  }

  try {
    const connectConfig = await buildConnectConfig(connConfig);

    // ── Step 0: Connect ──────────────────────────────────────────────
    updateStep(0, "running");

    await new Promise<void>((resolve, reject) => {
      sshClient.on("ready", () => resolve());
      sshClient.on("error", (err) => reject(err));
      sshClient.connect({ ...connectConfig, readyTimeout: 15_000 });
    });

    updateStep(0, "completed", "Connected successfully");

    // ── Step 1: Detect OS and architecture ───────────────────────────
    updateStep(1, "running");
    const { stdout: osInfo } = await sshExec(sshClient, "uname -s && uname -m");
    const [osName, arch] = osInfo.split("\n");
    updateStep(1, "completed", `${osName} ${arch}`);

    if (osName !== "Linux" && osName !== "Darwin") {
      return fail(1, `Unsupported OS: ${osName}. Only Linux and macOS.`);
    }

    // ── Step 2: Install Bun ──────────────────────────────────────────
    updateStep(2, "running");
    const { code: bunCheck } = await sshExec(
      sshClient,
      `${REMOTE_PATH} && which bun 2>/dev/null`,
    );
    if (bunCheck !== 0) {
      // Install prerequisites (unzip) — try without sudo first
      updateStep(2, "running", "Installing prerequisites...");
      await sshExec(
        sshClient,
        "which unzip >/dev/null 2>&1 || " +
          "(apt-get update -qq && apt-get install -y -qq unzip 2>/dev/null || " +
          "sudo apt-get update -qq && sudo apt-get install -y -qq unzip 2>/dev/null || " +
          "yum install -y -q unzip 2>/dev/null || " +
          "sudo yum install -y -q unzip 2>/dev/null || " +
          "apk add --quiet unzip 2>/dev/null || true)",
        60_000,
      );

      updateStep(2, "running", "Installing Bun...");
      const { code: bunInstall, stderr: bunErr } = await sshExec(
        sshClient,
        `curl -fsSL https://bun.sh/install | bash && ${REMOTE_PATH} && bun --version`,
        120_000,
      );
      if (bunInstall !== 0) {
        return fail(2, `Failed to install Bun: ${bunErr}`);
      }
      updateStep(2, "completed", "Bun installed");
    } else {
      updateStep(2, "skipped", "Bun already installed");
    }

    // ── Step 3: Install vibecontrols-agent ────────────────────────────
    updateStep(3, "running");
    const { code: agentCheck } = await sshExec(
      sshClient,
      `${REMOTE_PATH} && which vibe 2>/dev/null`,
    );
    if (agentCheck !== 0) {
      updateStep(
        3,
        "running",
        `Installing agent (registry: ${registryUrl})...`,
      );

      // Strategy 1: Try bun install -g from registry
      const { code: installCode } = await sshExec(
        sshClient,
        `${REMOTE_PATH} && bun install -g @vibecontrols/vibecontrols-agent --registry ${registryUrl}`,
        120_000,
      );

      if (installCode !== 0) {
        // Strategy 2: npm pack locally, SCP tarball, extract on remote
        updateStep(
          3,
          "running",
          "Registry unavailable, transferring directly...",
        );
        try {
          const agentDir =
            hostServices.getConfig?.("agent:packageDir") ||
            `${homedir()}/products/vibecontrols/vibecontrols-agent`;

          // npm pack runs locally — use the OS tmpdir for cross-platform
          // correctness even though SSH itself only targets POSIX hosts.
          const localTmpDir = tmpdir();
          const packResult = Bun.spawnSync(
            ["npm", "pack", "--pack-destination", localTmpDir],
            { cwd: agentDir, stdout: "pipe", stderr: "pipe" },
          );
          const tgzName = packResult.stdout.toString().trim().split("\n").pop();
          const tgzPath = tgzName ? joinPath(localTmpDir, tgzName) : "";

          if (!tgzPath || !(await Bun.file(tgzPath).exists())) {
            return fail(3, "Failed to pack agent for transfer");
          }

          // SCP to remote
          const scpArgs = [
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-P",
            String(connConfig.port),
          ];
          if (connConfig.privateKeyPath) {
            scpArgs.push("-i", expandPath(connConfig.privateKeyPath));
          }
          scpArgs.push(
            tgzPath,
            `${connConfig.username}@${connConfig.host}:/tmp/vibecontrols-agent.tgz`,
          );

          const scpResult = Bun.spawnSync(["scp", ...scpArgs]);
          if (scpResult.exitCode !== 0) {
            return fail(3, "Failed to transfer agent package via SCP");
          }

          // Extract and set up on remote
          const { code: setupCode2, stderr: setupErr2 } = await sshExec(
            sshClient,
            `${REMOTE_PATH} && ` +
              `mkdir -p $HOME/.vibecontrols/agent && ` +
              `cd $HOME/.vibecontrols/agent && ` +
              `tar xzf /tmp/vibecontrols-agent.tgz --strip-components=1 && ` +
              `bun install --production --ignore-scripts 2>/dev/null; ` +
              `mkdir -p $HOME/.local/bin && ` +
              `ln -sf $HOME/.vibecontrols/agent/dist/cli.js $HOME/.local/bin/vibe && ` +
              `chmod +x $HOME/.vibecontrols/agent/dist/cli.js && ` +
              `rm -f /tmp/vibecontrols-agent.tgz`,
            120_000,
          );
          if (setupCode2 !== 0) {
            return fail(
              3,
              `Failed to set up agent: ${setupErr2?.slice(0, 200)}`,
            );
          }

          // Verify vibe is available
          const { code: vibeCheck } = await sshExec(
            sshClient,
            `${REMOTE_PATH} && which vibe`,
          );
          if (vibeCheck !== 0) {
            return fail(
              3,
              "Agent installed but 'vibe' command not found in PATH",
            );
          }
        } catch (transferErr) {
          return fail(
            3,
            `Failed to install agent: ${transferErr instanceof Error ? transferErr.message : "transfer failed"}`,
          );
        }
      }
      updateStep(3, "completed", "Agent installed");
    } else {
      updateStep(3, "skipped", "Agent already installed");
    }

    // ── Step 4: Configure agent ──────────────────────────────────────
    updateStep(4, "running");

    // Check if cloudflared is available
    const { code: cfCheck } = await sshExec(
      sshClient,
      "which cloudflared 2>/dev/null",
    );
    const hasCloudflared = cfCheck === 0;

    const { code: setupCode, stderr: setupErr } = await sshExec(
      sshClient,
      `${REMOTE_PATH} && vibe setup --non-interactive --port ${agentPort}`,
      30_000,
    );
    if (setupCode !== 0) {
      updateStep(
        4,
        "completed",
        setupErr
          ? `Warning: ${setupErr.slice(0, 120)}`
          : "Configured with defaults",
      );
    } else {
      updateStep(4, "completed", "Agent configured");
    }

    // ── Step 5: Start agent daemon ───────────────────────────────────
    updateStep(5, "running");

    // Check if agent already running on this port
    const { code: portCheck } = await sshExec(
      sshClient,
      `curl -sf http://127.0.0.1:${agentPort}/health`,
      5_000,
    );
    if (portCheck === 0) {
      updateStep(5, "skipped", "Agent already running on this port");
    } else {
      const tunnelEnv = hasCloudflared ? "" : "AGENT_TUNNEL=false ";
      // Try vibe start first, fall back to direct bun run for extraction-based installs
      const { code: startCode, stderr: startErr } = await sshExec(
        sshClient,
        `${REMOTE_PATH} && ${tunnelEnv}PORT=${agentPort} nohup vibe start > /dev/null 2>&1 & sleep 3 && echo started || ` +
          `(cd $HOME/.vibecontrols/agent && ${tunnelEnv}PORT=${agentPort} nohup bun run dist/index.js > /tmp/vibe-agent.log 2>&1 & sleep 3 && echo started)`,
        30_000,
      );
      if (startCode !== 0 && !startErr.includes("already running")) {
        return fail(5, `Failed to start agent: ${startErr}`);
      }
      updateStep(5, "completed", "Agent started");
    }

    // ── Step 6: Verify health ────────────────────────────────────────
    updateStep(6, "running");

    await new Promise((r) => setTimeout(r, 3000));

    let healthy = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { code: healthCode } = await sshExec(
        sshClient,
        `curl -sf http://127.0.0.1:${agentPort}/health`,
        5_000,
      );
      if (healthCode === 0) {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!healthy) {
      return fail(6, "Agent health check failed after 8 attempts");
    }

    updateStep(6, "completed", "Agent is healthy");

    // ── Step 7: Retrieve agent details ───────────────────────────────
    updateStep(7, "running");

    let apiKey: string | undefined;
    let tunnelUrl: string | undefined;
    let hostname = connConfig.host;
    let platform = "linux";
    let architecture = "x86_64";

    // Get API key
    const { stdout: keyOut } = await sshExec(
      sshClient,
      `curl -sf http://127.0.0.1:${agentPort}/api/agent/api-key`,
      5_000,
    ).catch(() => ({ stdout: "", stderr: "", code: 1 }));
    if (keyOut) {
      try {
        apiKey = JSON.parse(keyOut).apiKey;
      } catch {
        /* ignore */
      }
    }

    // Get identity
    const { stdout: identityOut } = await sshExec(
      sshClient,
      `curl -sf http://127.0.0.1:${agentPort}/api/agent/identity`,
      5_000,
    ).catch(() => ({ stdout: "", stderr: "", code: 1 }));
    if (identityOut) {
      try {
        const id = JSON.parse(identityOut);
        hostname = id.hostname || hostname;
        platform = id.platform || platform;
        architecture = id.arch || architecture;
      } catch {
        /* ignore */
      }
    }

    // Poll for tunnel URL (if cloudflared is present)
    if (hasCloudflared) {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const { stdout: statusOut } = await sshExec(
          sshClient,
          `curl -sf http://127.0.0.1:${agentPort}/api/agent/status`,
          5_000,
        ).catch(() => ({ stdout: "", stderr: "", code: 1 }));
        if (statusOut) {
          try {
            const s = JSON.parse(statusOut);
            if (s.tunnelUrl) {
              tunnelUrl = s.tunnelUrl;
              break;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }

    updateStep(
      7,
      "completed",
      tunnelUrl ? `Tunnel: ${tunnelUrl}` : "Details retrieved (no tunnel)",
    );

    job.result = {
      agentUrl: tunnelUrl || `http://${connConfig.host}:${agentPort}`,
      agentPort,
      apiKey,
      tunnelUrl,
      hostname,
      platform,
      architecture,
    };

    // ── Step 8: Auto-register with backend ───────────────────────────
    if (
      options.autoRegister &&
      hostServices.isGatewayConfigured?.() &&
      hostServices.workspaceQuery
    ) {
      updateStep(8, "running");

      const workspaceId = hostServices.getWorkspaceId?.();
      if (!workspaceId) {
        updateStep(8, "skipped", "No workspace ID configured");
      } else {
        try {
          const agentName =
            options.agentName || hostname || connConfig.serverName;
          const mutation = `
            mutation RegisterInstalledAgent($workspaceId: ID!, $input: RegisterInstalledAgentInput!) {
              registerInstalledAgent(workspaceId: $workspaceId, input: $input) {
                id name hostname
              }
            }
          `;

          const result = await hostServices.workspaceQuery<{
            registerInstalledAgent: {
              id: string;
              name: string;
              hostname: string;
            };
          }>(mutation, {
            workspaceId,
            input: {
              name: agentName,
              hostname,
              platform,
              architecture,
              apiUrl: `http://${connConfig.host}:${agentPort}`,
              tunnelUrl: tunnelUrl || undefined,
              agentApiKey: apiKey || undefined,
            },
          });

          if (result.errors?.length) {
            updateStep(8, "failed", result.errors[0].message);
          } else {
            const agentRecord = result.data?.registerInstalledAgent;
            if (agentRecord) {
              job.result!.backendAgentId = agentRecord.id;

              // Push gateway auth to the remote agent so it can
              // authenticate with the backend independently
              if (apiKey && hostServices.getConfig) {
                const gwPayload = JSON.stringify({
                  tenantApiUrl:
                    hostServices.getConfig("gateway-auth:globalGatewayUrl") ||
                    "",
                  workspacesApiUrl:
                    hostServices.getConfig(
                      "gateway-auth:workspaceGatewayUrl",
                    ) || "",
                  appClientId:
                    hostServices.getConfig("gateway-auth:clientId") || "",
                  appClientSecret:
                    hostServices.getConfig("gateway-auth:clientSecret") || "",
                  workspaceId,
                  agentRecordId: agentRecord.id,
                });

                // Write to a temp file to avoid shell escaping issues
                await sshExec(
                  sshClient,
                  `echo '${gwPayload.replace(/'/g, "'\\''")}' > /tmp/.vc-gw-auth.json && ` +
                    `curl -sf -X POST http://127.0.0.1:${agentPort}/api/agent/gateway-auth ` +
                    `-H 'Content-Type: application/json' ` +
                    `-H 'x-agent-api-key: ${apiKey}' ` +
                    `-d @/tmp/.vc-gw-auth.json && ` +
                    `rm -f /tmp/.vc-gw-auth.json`,
                  15_000,
                ).catch(() => {
                  /* gateway push is best-effort */
                });
              }

              updateStep(
                8,
                "completed",
                `Registered as "${agentRecord.name}" (${agentRecord.id.slice(0, 8)})`,
              );
            }
          }
        } catch (regErr) {
          updateStep(
            8,
            "failed",
            regErr instanceof Error ? regErr.message : "Registration failed",
          );
        }
      }
    } else {
      updateStep(
        8,
        "skipped",
        "Auto-registration not requested or gateway not configured",
      );
    }

    // Done
    job.status = "completed";
    job.completedAt = new Date().toISOString();

    if (broadcast) broadcast("ssh:install:complete", { ...job });

    sshClient.end();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    job.status = "failed";
    job.error = errMsg;
    job.completedAt = new Date().toISOString();
    if (broadcast) broadcast("ssh:install:failed", { ...job });
    sshClient.end();
  }
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createRemoteAgentInstallRoutes(hostServices: HostServices) {
  const { storage, broadcast } = hostServices;

  return (
    new Elysia({ prefix: "/api/ssh/agent-install" })

      // -----------------------------------------------------------------------
      // GET /api/ssh/agent-install/jobs — list all install jobs
      // -----------------------------------------------------------------------
      .get("/jobs", () => {
        return { jobs: Array.from(installJobs.values()) };
      })

      // -----------------------------------------------------------------------
      // GET /api/ssh/agent-install/jobs/:id — get a specific job
      // -----------------------------------------------------------------------
      .get("/jobs/:id", ({ params, set }) => {
        const job = installJobs.get(params.id);
        if (!job) {
          set.status = 404;
          return { error: "Install job not found" };
        }
        return { job };
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/agent-install/start — begin remote agent installation
      // -----------------------------------------------------------------------
      .post("/start", async ({ body, set }) => {
        const {
          connectionId,
          agentPort = 3005,
          autoRegister = false,
          agentName,
        } = body as StartAgentInstallBody;

        const connConfig = await getConnectionById(storage, connectionId);
        if (!connConfig) {
          set.status = 404;
          return { error: "SSH connection not found" };
        }

        const jobId = globalThis.crypto.randomUUID();
        const job: RemoteAgentInstallJob = {
          id: jobId,
          connectionId,
          status: "running",
          steps: INSTALL_STEPS.map((s) => ({
            name: s.name,
            status: "pending" as const,
          })),
          currentStep: 0,
          startedAt: new Date().toISOString(),
        };

        installJobs.set(jobId, job);

        // Run installation asynchronously
        runInstallation(job, connConfig, agentPort, hostServices, {
          autoRegister,
          agentName,
        }).catch(() => {
          // Errors handled inside runInstallation
        });

        return { jobId, status: "running" };
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/agent-install/batch-start — install on multiple servers
      // -----------------------------------------------------------------------
      .post("/batch-start", async ({ body, set }) => {
        const {
          connectionIds,
          agentPort = 3005,
          autoRegister = false,
        } = body as BatchInstallBody;

        if (!connectionIds?.length) {
          set.status = 400;
          return { error: "No connection IDs provided" };
        }

        const jobs: Array<{ connectionId: string; jobId: string }> = [];

        for (const connectionId of connectionIds) {
          const connConfig = await getConnectionById(storage, connectionId);
          if (!connConfig) continue;

          const jobId = globalThis.crypto.randomUUID();
          const job: RemoteAgentInstallJob = {
            id: jobId,
            connectionId,
            status: "running",
            steps: INSTALL_STEPS.map((s) => ({
              name: s.name,
              status: "pending" as const,
            })),
            currentStep: 0,
            startedAt: new Date().toISOString(),
          };

          installJobs.set(jobId, job);
          jobs.push({ connectionId, jobId });

          // Run each installation asynchronously (in parallel)
          runInstallation(job, connConfig, agentPort, hostServices, {
            autoRegister,
          }).catch(() => {});
        }

        return { jobs, total: jobs.length };
      })

      // -----------------------------------------------------------------------
      // POST /api/ssh/agent-install/uninstall — uninstall agent from remote
      // -----------------------------------------------------------------------
      .post("/uninstall", async ({ body, set }) => {
        const { connectionId } = body as UninstallAgentBody;

        const connConfig = await getConnectionById(storage, connectionId);
        if (!connConfig) {
          set.status = 404;
          return { error: "SSH connection not found" };
        }

        const sshClient = new Client();
        const connectConfig = await buildConnectConfig(connConfig);

        await new Promise<void>((resolve, reject) => {
          sshClient.on("ready", () => resolve());
          sshClient.on("error", (err) => reject(err));
          sshClient.connect({ ...connectConfig, readyTimeout: 15_000 });
        });

        try {
          // Stop running agent processes
          await sshExec(
            sshClient,
            'pkill -f "bun.*index.ts" 2>/dev/null; pkill -f "vibe" 2>/dev/null',
            10_000,
          ).catch(() => {});

          // Remove agent files
          await sshExec(sshClient, "rm -rf $HOME/.vibecontrols/agent", 10_000);

          // Remove symlink
          await sshExec(sshClient, "rm -f $HOME/.local/bin/vibe", 10_000);

          // Remove vibecontrols state
          await sshExec(sshClient, "rm -rf $HOME/.vibecontrols", 10_000);
        } finally {
          sshClient.end();
        }

        return { success: true, message: "Agent uninstalled" };
      })
  );
}
