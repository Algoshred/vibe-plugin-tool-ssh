/**
 * Type declarations for the vibe-plugin-ssh plugin.
 *
 * All interfaces are defined locally so the plugin does not hard-import
 * from the core agent package.  At runtime the host agent injects concrete
 * implementations via HostServices.
 */

import type { Elysia } from "elysia";
import type { Command } from "commander";

// ---------------------------------------------------------------------------
// KV Storage provider – the host agent supplies this
// ---------------------------------------------------------------------------

export interface StorageProvider {
  /** Retrieve a value by namespace + key.  Returns `null` when missing. */
  get(namespace: string, key: string): Promise<string | null>;
  /** Persist a value under namespace + key. */
  set(namespace: string, key: string, value: string): Promise<void>;
  /** Delete a single key. */
  delete(namespace: string, key: string): Promise<boolean>;
  /** List all keys in a namespace. */
  keys(namespace: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Event bus – optional, used when the host provides one
// ---------------------------------------------------------------------------

export interface EventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
}

// ---------------------------------------------------------------------------
// Service registry – exposes shared host services & provider registration
// ---------------------------------------------------------------------------

export interface ServiceRegistry {
  get<T = unknown>(name: string): T | undefined;
  registerProvider(type: string, provider: unknown, pluginName: string): void;
  listProvidersForType(
    type: string,
  ): Array<{ pluginName: string; provider: unknown }>;
}

// ---------------------------------------------------------------------------
// Broadcast function – sends events to all connected WebSocket clients
// ---------------------------------------------------------------------------

export type BroadcastFn = (type: string, payload: unknown) => void;

// ---------------------------------------------------------------------------
// HostServices – the bag of goodies the host agent hands to every plugin
// ---------------------------------------------------------------------------

export interface HostServices {
  storage: StorageProvider;
  eventBus?: EventBus;
  serviceRegistry?: ServiceRegistry;
  broadcast?: BroadcastFn;
  // Agent config and gateway access (optional for backward compat)
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

// ---------------------------------------------------------------------------
// VibePlugin contract – every plugin must satisfy this shape
// ---------------------------------------------------------------------------

export interface VibePlugin {
  name: string;
  version: string;
  description?: string;
  tags?: Array<
    "backend" | "frontend" | "cli" | "provider" | "adapter" | "integration"
  >;
  cliCommand?: string;
  apiPrefix?: string;
  onCliSetup?: (program: Command) => void | Promise<void>;
  onServerStart?: (
    app: Elysia,
    hostServices: HostServices,
  ) => void | Promise<void>;
  onServerStop?: () => void | Promise<void>;
}

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

// ---------------------------------------------------------------------------
// SSH Terminal Session – remote ttyd session forwarded back to agent
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Remote agent install job
// ---------------------------------------------------------------------------

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
