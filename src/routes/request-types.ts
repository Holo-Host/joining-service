import * as v from 'valibot';
import type { LinkerCapability } from '../linker-auth/types.js';

const CAPABILITIES: LinkerCapability[] = ['dht_read', 'dht_write', 'k2'];
const Capability = v.picklist(CAPABILITIES);

// ---- Admin: POST /v1/admin/linker-invites ----

export const CreateInviteBody = v.object({
  label: v.optional(v.string()),
  capabilities: v.pipe(v.array(Capability), v.minLength(1)),
  max_uses: v.optional(v.number()),
  expires_at: v.optional(v.string()),
});
export type CreateInviteBody = v.InferOutput<typeof CreateInviteBody>;

// ---- Admin: PATCH /v1/admin/linkers/:pubkey ----

export const UpdateLinkerBody = v.object({
  capabilities: v.pipe(v.array(Capability), v.minLength(1)),
});
export type UpdateLinkerBody = v.InferOutput<typeof UpdateLinkerBody>;

// ---- Linker: POST /v1/linkers/heartbeat ----

export const HeartbeatBody = v.object({
  pubkey: v.string(),
  invite_token: v.optional(v.string()),
  linker_url: v.string(),
  admin_url: v.string(),
  admin_secret: v.optional(v.string()),
  rotate_secret: v.optional(v.boolean()),
  timestamp: v.string(),
  signature: v.string(),
});
export type HeartbeatBody = v.InferOutput<typeof HeartbeatBody>;

// ---- Linker: DELETE /v1/linkers/:pubkey ----

export const DeregisterBody = v.object({
  timestamp: v.string(),
  signature: v.string(),
});
export type DeregisterBody = v.InferOutput<typeof DeregisterBody>;

// ---- Admin: POST /v1/admin/allowed-agents ----

export const RegisterAgentBody = v.object({
  agent_key: v.string(),
  label: v.optional(v.string()),
});
export type RegisterAgentBody = v.InferOutput<typeof RegisterAgentBody>;

// ---- Admin: POST /v1/admin/networks ----

const RoleConfigBody = v.object({
  dna_hash: v.optional(v.string()),
  // network_seed is typed because it's load-bearing for DNA identity
  // (a non-string seed would silently break agent connectivity); other
  // modifier keys (e.g. properties) pass through unvalidated.
  modifiers: v.optional(
    v.looseObject({
      network_seed: v.optional(v.string()),
    }),
  ),
});

const HappMetadataBody = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  icon_url: v.optional(v.string()),
  happ_bundle_url: v.optional(v.string()),
});

export const RegisterNetworkBody = v.object({
  happ_id: v.string(),
  happ: v.optional(HappMetadataBody),
  roles: v.record(v.string(), RoleConfigBody),
  allowed_agents: v.optional(v.array(v.string())),
});
export type RegisterNetworkBody = v.InferOutput<typeof RegisterNetworkBody>;
