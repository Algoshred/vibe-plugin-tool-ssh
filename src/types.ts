/**
 * Domain models for the vibe-plugin-tool-ssh plugin.
 *
 * Plugin contract types (VibePlugin / HostServices / PluginCapabilities /
 * StorageProvider / ServiceRegistry / EventBus) are imported from
 * `@vibecontrols/plugin-sdk` — do NOT redeclare them here.
 *
 * The agent's runtime exposes a richer HostServices surface (3-arg
 * `registerProvider`, sync `getConfig` / `getAgentRecordId` /
 * `getWorkspaceId`) than the SDK's neutral contract. Routes / install
 * helpers in this plugin reference that richer shape via
 * `AgentHostServices` below; the plugin entry-point in `src/index.ts`
 * only relies on the narrower SDK contract.
 */

export interface AgentStorageProvider {
  /** Retrieve a value by namespace + key. Returns `null` when missing. */
  get(namespace: string, key: string): Promise<string | null>;
  /** Persist a value under namespace + key. */
  set(namespace: string, key: string, value: string): Promise<void>;
  /** Delete a single key. */
  delete(namespace: string, key: string): Promise<boolean>;
  /** List all keys in a namespace. */
  keys(namespace: string): Promise<string[]>;
}

export interface AgentEventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
}

export interface AgentServiceRegistry {
  get<T = unknown>(name: string): T | undefined;
  registerProvider(type: string, provider: unknown, pluginName: string): void;
  listProvidersForType(
    type: string,
  ): Array<{ pluginName: string; provider: unknown }>;
}

export type BroadcastFn = (type: string, payload: unknown) => void;

/**
 * The runtime shape the agent injects into route factories. Storage is
 * required (every helper hits it). Other host capabilities remain
 * optional so the plugin still loads under partial / older host
 * implementations.
 */
export interface AgentHostServices {
  telemetry?: {
    emit: (name: string, payload?: Record<string, unknown>) => void;
  };
  storage: AgentStorageProvider;
  eventBus?: AgentEventBus;
  serviceRegistry?: AgentServiceRegistry;
  broadcast?: BroadcastFn;
  getConfig?(key: string): string | undefined;
  getPluginRegistry?(): string;
  getAgentBaseUrl?(): string;
  getAgentVersion?(): string;
  isGatewayConfigured?(): boolean;
  getAgentRecordId?(): string | null;
  getWorkspaceId?(): string | null;
  workspaceQuery?<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data?: T; errors?: Array<{ message: string }> }>;
}

// Back-compat aliases — every file in src/routes/ imports these names.
export type StorageProvider = AgentStorageProvider;
export type EventBus = AgentEventBus;
export type ServiceRegistry = AgentServiceRegistry;
export type HostServices = AgentHostServices;

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface SSHConnection {
  id: string;
  serverName: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  password?: string;
  createdAt?: string;
}

export interface PortForward {
  id: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  serverName: string;
  connectionId: string;
  status: "active" | "inactive";
  createdAt?: string;
}

export type SSHTerminalStatus =
  | "starting"
  | "active"
  | "stopping"
  | "stopped"
  | "error";

export interface SSHTerminalSession {
  id: string;
  connectionId: string;
  remotePort: number;
  localPort: number;
  remotePid: number | null;
  shell: string;
  status: SSHTerminalStatus;
  startedAt: string;
  error?: string;
}

export type InstallJobStatus = "pending" | "running" | "completed" | "failed";
export type InstallStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface RemoteAgentInstallStep {
  name: string;
  status: InstallStepStatus;
  message?: string;
}

export interface RemoteAgentInstallJob {
  id: string;
  connectionId: string;
  status: InstallJobStatus;
  steps: RemoteAgentInstallStep[];
  currentStep: number;
  result?: {
    agentUrl: string;
    agentPort: number;
    apiKey?: string;
    tunnelUrl?: string;
    hostname?: string;
    platform?: string;
    architecture?: string;
    backendAgentId?: string;
  };
  error?: string;
  startedAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Request body shapes
// ---------------------------------------------------------------------------

export interface CreateConnectionBody {
  serverName: string;
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  password?: string;
}

export interface UpdateConnectionBody {
  serverName?: string;
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  password?: string;
}

export interface ExecuteCommandBody {
  connectionId: string;
  command: string;
  workingDirectory?: string;
}

export interface CreatePortForwardBody {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  connectionId: string;
}

export interface StartTerminalBody {
  connectionId: string;
  shell?: string;
}

export interface StopTerminalBody {
  sessionId: string;
}

export interface StartAgentInstallBody {
  connectionId: string;
  agentName?: string;
  agentPort?: number;
  autoRegister?: boolean;
}

export interface BatchInstallBody {
  connectionIds: string[];
  agentPort?: number;
  autoRegister?: boolean;
}

export interface UninstallAgentBody {
  connectionId: string;
}
