import type { AgentPubKeyB64, AuthMethodEntry, DnaModifiers } from './types.js';
import type { HcAuthConfig } from './hc-auth/index.js';
import type { LinkerAuthConfig } from './linker-auth/index.js';
import type { DelegatedVerificationConfig } from './auth-methods/delegated-verification.js';
import { validateDelegatedVerificationConfig } from './auth-methods/delegated-verification.js';

export interface ServiceConfig {
  happ: {
    id: string;
    name: string;
    description?: string;
    icon_url?: string;
    happ_bundle_url?: string;
  };
  auth_methods: AuthMethodEntry[];
  linker_info?: {
    selection_mode: 'assigned' | 'client_choice';
    region_hints?: string[];
  };
  /**
   * DNA hashes for membrane proof generation.
   * Accepts either:
   *   - string[] — flat list of DNA hashes (proofs keyed by hash in response)
   *   - Record<string, string> — role_name → dna_hash (proofs keyed by role name)
   * The role-keyed form is required for CLI provisioning (roles-settings YAML output).
   */
  dna_hashes?: string[] | Record<string, string>;
  dna_modifiers?: DnaModifiers;
  membrane_proof?: {
    enabled: boolean;
    signing_key_path?: string;
  };
  email?: {
    provider: 'postmark' | 'sendgrid' | 'file';
    api_key?: string;
    from?: string;
    template?: string;
    output_dir?: string;
  };
  base_url?: string;
  invite_codes?: string[];
  allowed_agents?: AgentPubKeyB64[];
  session?: {
    store: 'memory' | 'sqlite' | 'cloudflare-kv';
    db_path?: string;
    /** TTL for pending (not yet approved) sessions. Default: 86400 (24 hours). */
    pending_ttl_seconds?: number;
  };
  reconnect?: {
    enabled?: boolean;
    timestamp_tolerance_seconds?: number;
  };
  port?: number;
  network?: {
    bootstrap_url?: string;
    relay_url?: string;
    /** Allow network_config (including auth_server_url) in the public /v1/info response. Default: false. */
    reveal_in_info?: boolean;
  };
  hc_auth?: HcAuthConfig;
  linker_auth?: LinkerAuthConfig;
  delegated_verification?: DelegatedVerificationConfig;
  /** Runtime registration of allowed agents (e.g. network progenitors). */
  agent_registration?: {
    /** Bearer secret for the /v1/admin/allowed-agents routes. */
    admin_secret: string;
  };
}

const DEFAULTS = {
  session: {
    store: 'memory' as const,
    pending_ttl_seconds: 86400,
  },
  reconnect: {
    enabled: true,
    timestamp_tolerance_seconds: 300,
  },
  port: 3000,
};

export function resolveConfig(partial: Partial<ServiceConfig>): ServiceConfig {
  if (!partial.happ?.id || !partial.happ?.name) {
    throw new Error('config: happ.id and happ.name are required');
  }
  if (!partial.auth_methods?.length) {
    throw new Error('config: at least one auth_method is required');
  }

  // Validate delegated_verification config if present
  if (partial.delegated_verification) {
    validateDelegatedVerificationConfig(partial.delegated_verification);
  }

  return {
    ...partial,
    happ: partial.happ,
    auth_methods: partial.auth_methods,
    session: { ...DEFAULTS.session, ...partial.session },
    reconnect: { ...DEFAULTS.reconnect, ...partial.reconnect },
    port: partial.port ?? DEFAULTS.port,
  };
}
