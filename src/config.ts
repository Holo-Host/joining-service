import type { AgentPubKeyB64, AuthMethodEntry, DnaModifiers } from './types.js';
import type { HcAuthConfig } from './hc-auth/index.js';
import type { LinkerAuthConfig } from './linker-auth/index.js';
import type { DelegatedVerificationConfig } from './auth-methods/delegated-verification.js';
import { validateDelegatedVerificationConfig } from './auth-methods/delegated-verification.js';
import { decodeHashFromBase64 } from './utils.js';

/** Per-role DNA configuration, mirroring Holochain's app model. */
export interface RoleConfig {
  /**
   * Base64 DnaHash ("uhC0k..."), strictly validated when present. Required
   * when `membrane_proof.enabled` — a membrane proof is bound to a network
   * via this hash. Must be the post-modifiers DNA hash as reported by the
   * conductor that installed the DNA (see DEPLOYMENT.md).
   */
  dna_hash?: string;
  /** Per-DNA modifiers for this role. */
  modifiers?: DnaModifiers;
}

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
   * Per-role DNA configuration: role name → { dna_hash?, modifiers? }.
   * dna_hash is required only when membrane_proof.enabled is true.
   */
  roles?: Record<string, RoleConfig>;
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
  // Config is loaded from untyped JSON at runtime, so keys outside the
  // ServiceConfig type can appear on the raw object. The retired
  // dna_hashes/dna_modifiers keys are rejected with a pointer to roles
  // rather than silently ignored.
  const raw = partial as Partial<ServiceConfig> & {
    dna_hashes?: unknown;
    dna_modifiers?: unknown;
  };
  if ('dna_hashes' in raw || 'dna_modifiers' in raw) {
    throw new Error(
      'config: dna_hashes/dna_modifiers have been replaced by roles: { <role>: { dna_hash, modifiers } }',
    );
  }

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

  // An explicitly empty roles map carries no DNA information, so it is
  // treated as absent.
  const hasRoles = !!partial.roles && Object.keys(partial.roles).length > 0;
  const roles: Record<string, RoleConfig> | undefined = hasRoles ? partial.roles : undefined;
  if (roles) {
    for (const [name, rc] of Object.entries(roles)) {
      if (rc.dna_hash !== undefined && !isValidDnaHash(rc.dna_hash)) {
        throw new Error(
          `config: roles.${name}.dna_hash is not a valid DnaHash (expected base64 "uhC0k..." decoding to 39 bytes)`,
        );
      }
      if (partial.membrane_proof?.enabled && !rc.dna_hash) {
        throw new Error(
          `config: roles.${name}.dna_hash is required when membrane_proof.enabled is true`,
        );
      }
    }
  }

  return {
    ...partial,
    happ: partial.happ,
    auth_methods: partial.auth_methods,
    session: { ...DEFAULTS.session, ...partial.session },
    reconnect: { ...DEFAULTS.reconnect, ...partial.reconnect },
    port: partial.port ?? DEFAULTS.port,
    roles,
  };
}

function isValidDnaHash(hash: string): boolean {
  try {
    const bytes = decodeHashFromBase64(hash);
    // 39-byte HoloHash with DnaHash prefix 0x84 0x2d 0x24
    return (
      bytes.length === 39 && bytes[0] === 0x84 && bytes[1] === 0x2d && bytes[2] === 0x24
    );
  } catch {
    return false;
  }
}
