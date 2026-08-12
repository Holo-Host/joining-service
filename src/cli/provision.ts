/**
 * CLI provision command — drives the full join flow and outputs
 * a roles-settings YAML file (or JSON) for `hc s call install-app`.
 *
 * Flow:
 *   1. Join the service (with claims: invite_code, email, etc.)
 *   2. Auto-verify agent_allow_list challenges by signing nonce via lair
 *   3. Poll until ready (for async challenges like email_code)
 *   4. Get provision (membrane proofs, linker URLs, etc.)
 *   5. Output roles-settings YAML for hc install-app
 */

import { JoiningClient, JoinSession, JoiningError } from '../client/joining.js';
import type { Challenge, JoinProvision } from '../types.js';
import { lairSign, extractPubKey, type LairSignerOptions } from './lair.js';

export interface ProvisionOptions {
  /** Joining service base URL */
  serviceUrl?: string;
  /** App domain for .well-known discovery (alternative to serviceUrl) */
  discover?: string;
  /** 39-byte AgentPubKey in HoloHash format (uhCAk...) */
  agentKey: string;
  /** Lair connection options (required for agent_allow_list signing) */
  lair?: LairSignerOptions;
  /** Claims to pass with join request */
  claims?: Record<string, string>;
  /** Output file path (default: stdout) */
  output?: string;
  /** Output format */
  format?: 'yaml' | 'json';
  /** Suppress progress messages */
  quiet?: boolean;
  /** Max seconds to poll for async challenges (default: 300) */
  pollTimeout?: number;
}

function log(opts: ProvisionOptions, msg: string): void {
  if (!opts.quiet) {
    process.stderr.write(msg + '\n');
  }
}

/**
 * Run the full provision flow and return the provision data.
 */
export async function provision(opts: ProvisionOptions): Promise<JoinProvision> {
  // Resolve client
  let client: JoiningClient;
  if (opts.serviceUrl) {
    client = JoiningClient.fromUrl(opts.serviceUrl);
  } else if (opts.discover) {
    log(opts, `Discovering joining service from ${opts.discover}...`);
    client = await JoiningClient.discover(opts.discover);
  } else {
    throw new Error('Either --service-url or --discover is required');
  }

  log(opts, `Joining with agent key ${opts.agentKey.slice(0, 16)}...`);

  // Join
  let session: JoinSession;
  try {
    session = await client.join(opts.agentKey, opts.claims);
  } catch (err) {
    if (err instanceof JoiningError && err.code === 'join_rejected') {
      throw new Error(`Join rejected: ${err.message}`);
    }
    throw err;
  }

  // Handle pending challenges
  if (session.status === 'pending' && session.challenges) {
    for (const challenge of session.challenges) {
      if (challenge.completed) continue;

      if (challenge.type === 'agent_allow_list') {
        // Auto-sign nonce via lair
        session = await handleAllowListChallenge(opts, session, challenge);
      }
      // invite_code is auto-verified at join time — nothing to do here
      // email_code would need interactive input — not supported in headless mode
    }
  }

  // Poll if still pending (e.g. waiting for external approval)
  if (session.status === 'pending') {
    const timeout = (opts.pollTimeout ?? 300) * 1000;
    const deadline = Date.now() + timeout;
    const interval = session.pollIntervalMs ?? 2000;

    log(opts, 'Waiting for approval...');
    while (session.status === 'pending' && Date.now() < deadline) {
      await sleep(interval);
      session = await session.pollStatus();
    }

    if (session.status === 'pending') {
      throw new Error(`Timed out after ${opts.pollTimeout ?? 300}s waiting for approval`);
    }
  }

  if (session.status === 'rejected') {
    throw new Error(`Join rejected: ${session.reason ?? 'no reason given'}`);
  }

  if (session.status !== 'ready') {
    throw new Error(`Unexpected session status: ${session.status}`);
  }

  log(opts, 'Session ready — fetching provision...');
  return session.getProvision();
}

/**
 * Sign an agent_allow_list nonce challenge via lair.
 */
async function handleAllowListChallenge(
  opts: ProvisionOptions,
  session: JoinSession,
  challenge: Challenge,
): Promise<JoinSession> {
  if (!opts.lair) {
    throw new Error(
      'agent_allow_list challenge requires --lair-url and --lair-passphrase-file',
    );
  }

  const nonce = challenge.metadata?.nonce as string | undefined;
  if (!nonce) {
    throw new Error('agent_allow_list challenge missing nonce in metadata');
  }

  log(opts, 'Signing allow-list nonce via lair...');

  // Get raw pubkey for lair signing
  const pubKeyB64url = await extractPubKey(opts.agentKey, opts.lair.keyutilBin);

  // The nonce comes as base64 from the server; holo-keyutil expects base64url
  const nonceB64url = base64ToBase64url(nonce);

  const signature = await lairSign(opts.lair, pubKeyB64url, nonceB64url);

  // Convert signature back to standard base64 for the verify endpoint
  const sigBase64 = base64urlToBase64(signature);

  return session.verify(challenge.id, sigBase64);
}

/**
 * Convert a JoinProvision response to roles-settings YAML format
 * for `hc s call install-app --roles-settings`.
 *
 * When membrane_proofs keys are role names (from role-keyed dna_hashes config),
 * they map directly to YAML role entries. When they are DNA hashes,
 * they are output as-is — the caller is responsible for mapping them to roles.
 */
export function provisionToRolesSettingsYaml(
  prov: JoinProvision,
): string {
  if (!prov.membrane_proofs || Object.keys(prov.membrane_proofs).length === 0) {
    return '# No membrane proofs returned by joining service\n';
  }

  const lines: string[] = [];
  for (const [key, proofBase64] of Object.entries(prov.membrane_proofs)) {
    lines.push(`"${key}":`);
    lines.push(`  type: provisioned`);
    lines.push(`  membrane_proof: "${proofBase64}"`);
    if (prov.dna_modifiers) {
      lines.push(`  modifiers:`);
      if (prov.dna_modifiers.network_seed) {
        lines.push(`    network_seed: "${prov.dna_modifiers.network_seed}"`);
      }
      if (prov.dna_modifiers.properties) {
        // Single-quoted to prevent YAML misparse of JSON metacharacters.
        // Limitation: if a property value contains a literal single quote,
        // the YAML will be malformed. Use a proper YAML library if that arises.
        lines.push(`    properties: '${JSON.stringify(prov.dna_modifiers.properties)}'`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Convert provision to JSON output.
 */
export function provisionToJson(prov: JoinProvision): string {
  return JSON.stringify(prov, null, 2) + '\n';
}

// ---- Helpers ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Raw base64 <-> base64url conversion (no HoloHash u-prefix handling).
// Distinct from the HoloHash-aware helpers in ../utils.ts.
function base64ToBase64url(s: string): string {
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBase64(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4;
  if (pad === 2) b += '==';
  else if (pad === 3) b += '=';
  return b;
}
