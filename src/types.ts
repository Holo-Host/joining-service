// API types matching JOINING_SERVICE_API.md Section 9

export interface WellKnownHoloJoining {
  joining_service_url: string;
  happ_id: string;
  version: string;
}

export interface JoiningServiceInfo {
  happ: {
    id: string;
    name: string;
    description?: string;
    icon_url?: string;
  };
  http_gateways?: HttpGateway[];
  auth_methods: AuthMethodEntry[];
  /** Absent when the service does not manage linker relay URLs. */
  linker_info?: {
    selection_mode: 'assigned' | 'client_choice';
    region_hints?: string[];
  };
  happ_bundle_url?: string;
  /** Network service URLs. Only present when reveal_in_info is enabled in config. */
  network_config?: NetworkConfig;
  roles?: Record<string, { dna_modifiers?: DnaModifiers }>;
}

export interface HttpGateway {
  url: string;
  dna_hashes: string[];
  status: 'available' | 'degraded' | 'offline';
  /** When this gateway entry expires. Absent means no known expiry. */
  expires_at?: string;
}

/** A linker WebSocket URL with an optional per-URL expiration. */
export interface LinkerUrl {
  url: string;
  /** When this linker URL reservation expires. Absent means no known expiry. */
  expires_at?: string;
}

/** Base64-encoded 39-byte Holochain AgentPubKey. */
export type AgentPubKeyB64 = string;

export type AuthMethod =
  | 'open'
  | 'email_code'
  | 'sms_code'
  | 'evm_signature'
  | 'solana_signature'
  | 'invite_code'
  | 'agent_allow_list'
  | 'hc_auth_approval'
  | 'delegated_verification'
  | `x-${string}`;

export interface AuthMethodGroup {
  any_of: AuthMethod[];
}

export type AuthMethodEntry = AuthMethod | AuthMethodGroup;

export interface DnaModifiers {
  network_seed?: string;
  properties?: Record<string, unknown>;
}

/** Per-role provision data, mirroring hc roles-settings. */
export interface RoleProvision {
  /** Base64 membrane proof for this role's DNA. */
  membrane_proof?: string;
  dna_modifiers?: DnaModifiers;
}

export interface JoinRequest {
  agent_key: string;
  claims?: Record<string, string>;
  /** Named network to join. Must be registered with the service (see network_registration). */
  network?: string;
}

export interface JoinResponse {
  session: string;
  status: 'ready' | 'pending';
  challenges?: Challenge[];
  poll_interval_ms?: number;
}

export interface Challenge {
  id: string;
  type: AuthMethod;
  description: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
  completed?: boolean;
  /** Challenges sharing the same group are OR alternatives. */
  group?: string;
}

export interface VerifyRequest {
  challenge_id: string;
  response: string;
}

export interface VerifyResponse {
  status: 'ready' | 'pending' | 'rejected';
  challenges_remaining?: Challenge[];
  reason?: string;
  poll_interval_ms?: number;
}

export interface StatusResponse {
  status: 'ready' | 'pending' | 'rejected';
  challenges?: Challenge[];
  reason?: string;
  poll_interval_ms?: number;
}

export interface NetworkConfig {
  auth_server_url?: string;
  bootstrap_url?: string;
  relay_url?: string;
}

export interface JoinProvision {
  /** Absent when the service does not manage linker relay URLs. Each entry may carry its own expiry. */
  linker_urls?: LinkerUrl[];
  happ_bundle_url?: string;
  /** Network service URLs for conductor configuration. Only present when at least one URL is available. */
  network_config?: NetworkConfig;
  roles?: Record<string, RoleProvision>;
}

export interface ReconnectRequest {
  agent_key: string;
  timestamp: string;
  signature: string;
  /** Named network to reconnect to. Omitted, or equal to the static happ_id, selects the static network's session. */
  network?: string;
}

export interface ReconnectResponse {
  /** Absent when the service does not manage linker relay URLs. Each entry may carry its own expiry. */
  linker_urls?: LinkerUrl[];
  http_gateways?: HttpGateway[];
  /** Session token for the requested network's ready session. Absent when the (possibly static-defaulted) scope has no ready session. */
  session?: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
