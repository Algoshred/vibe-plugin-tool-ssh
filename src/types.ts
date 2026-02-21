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
// Service registry – optional, exposes shared host services
// ---------------------------------------------------------------------------

export interface ServiceRegistry {
  get<T = unknown>(name: string): T | undefined;
}

// ---------------------------------------------------------------------------
// HostServices – the bag of goodies the host agent hands to every plugin
// ---------------------------------------------------------------------------

export interface HostServices {
  storage: StorageProvider;
  eventBus?: EventBus;
  serviceRegistry?: ServiceRegistry;
}

// ---------------------------------------------------------------------------
// VibePlugin contract – every plugin must satisfy this shape
// ---------------------------------------------------------------------------

export interface VibePlugin {
  name: string;
  version: string;
  description?: string;
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
