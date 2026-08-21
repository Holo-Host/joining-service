import type { AgentPubKeyB64 } from '../types.js';
import type { RoleConfig } from '../config.js';

export interface NetworkRecord {
  happ_id: string;
  /** Optional hApp metadata for this network, surfaced via GET /v1/info/:happ_id. */
  happ?: {
    name?: string;
    description?: string;
    icon_url?: string;
    happ_bundle_url?: string;
  };
  /** Per-role DNA configuration for this network (same shape as config.roles). */
  roles: Record<string, RoleConfig>;
  /** Agents allowed to join this network via agent_allow_list, e.g. its progenitor. */
  allowed_agents?: AgentPubKeyB64[];
  registered_at: string;
}

export interface NetworkStore {
  put(network: NetworkRecord): Promise<void>;   // idempotent upsert by happ_id
  get(happId: string): Promise<NetworkRecord | null>;
  list(): Promise<NetworkRecord[]>;
  delete(happId: string): Promise<void>;     // no-op if absent
}
