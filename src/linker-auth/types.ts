import type { LinkerUrl } from '../types.js';

/** Capability strings matching h2hc-linker's Capability enum (snake_case). */
export type LinkerCapability = 'dht_read' | 'dht_write' | 'k2';

/** Admin API credentials for a linker that requires authorization. */
export interface LinkerAdminInfo {
  /** The admin API base URL (e.g. "https://linker1.holo.host"). */
  url: string;
  /** The Bearer token for the linker's admin API. */
  secret: string;
}

/**
 * Registration data for a linker instance.
 *
 * Every linker has a client-facing WSS URL. Linkers that require authorization
 * also carry an `admin` block with credentials. Linkers without `admin` are
 * treated as open (no authorization call needed).
 */
export interface LinkerRegistration {
  /** The client-safe WSS URL (returned to agents in provision). */
  linker_url: LinkerUrl;
  /** Admin API credentials. Absent for open linkers. */
  admin?: LinkerAdminInfo;
}

/**
 * Config block for linker authorization.
 * Lives in ServiceConfig as `linker_auth?`.
 */
export interface LinkerAuthConfig {
  /** Capabilities to grant on each linker (e.g. ["dht_read", "dht_write", "k2"]). */
  capabilities: LinkerCapability[];
  /**
   * Whether a failure to authorize on a linker should block provisioning.
   * Default: false (non-fatal — a linker outage does not break joining).
   */
  required?: boolean;
  /** Bearer token for admin endpoints (linker invite/management). Enables dynamic registration when set. */
  admin_secret?: string;
  /** TTL for registered linker entries in seconds. Default: 600 (10 minutes). */
  ttl_seconds?: number;
  /** Heartbeat interval returned to linkers. Default: 200 (~TTL/3). */
  heartbeat_interval_seconds?: number;
  /** Max clock drift allowed for heartbeat timestamps in seconds. Default: 30. */
  timestamp_tolerance_seconds?: number;
}
