/**
 * CLI commands for interacting with hc-auth-server.
 *
 * - authenticate: Agent-side flow (GET /now → sign → PUT /authenticate).
 *   Produces base64_auth_material for the conductor config.
 * - check: Read-only diagnostic — is the agent registered? What state?
 * - register: Admin-side register-and-authorize (requires API token).
 */

import { HcAuthClient, type HcAuthConfig } from '../hc-auth/client.js';
import { agentKeyToRawEd25519Base64url } from '../utils.js';
import { lairSign, extractPubKey, type LairSignerOptions } from './lair.js';

// ---- Types ----

export interface AuthenticateOptions {
  hcAuthUrl: string;
  agentKey: string;
  lair: LairSignerOptions;
}

export interface CheckOptions {
  hcAuthUrl: string;
  /** When omitted, only connectivity is checked (no agent state lookup). */
  apiToken?: string;
  agentKey: string;
}

export interface RegisterOptions {
  hcAuthUrl: string;
  apiToken: string;
  agentKey: string;
  metadata?: Record<string, unknown>;
}

// ---- authenticate ----

/**
 * Perform the agent-side hc-auth authentication flow:
 *   GET /now → sign payload with lair → PUT /authenticate
 *
 * Returns the auth material that the conductor needs in its config.
 * This is the same flow that holochain-register does in the heart repo.
 */
export async function authenticate(
  opts: AuthenticateOptions,
): Promise<{ authBody: string; authMaterialBase64: string; authToken: string }> {
  const baseUrl = opts.hcAuthUrl.replace(/\/$/, '');

  // Get the raw 32-byte ed25519 pubkey as base64url
  const pubKeyB64url = await extractPubKey(opts.agentKey, opts.lair.keyutilBin);

  // Fetch challenge payload from /now
  const nowResp = await fetch(`${baseUrl}/now`);
  if (!nowResp.ok) {
    throw new Error(`GET /now returned ${nowResp.status}: ${await nowResp.text()}`);
  }
  const payloadB64 = (await nowResp.text()).trim();

  // Sign the payload via lair
  const signature = await lairSign(opts.lair, pubKeyB64url, payloadB64);

  // Submit to /authenticate
  const authBody = JSON.stringify({
    pubKey: pubKeyB64url,
    payload: payloadB64,
    signature,
  });

  // Content-Type is intentionally application/octet-stream — the hc-auth server
  // treats the body as opaque bytes to base64-encode, not as parsed JSON.
  const authResp = await fetch(`${baseUrl}/authenticate`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: authBody,
  });

  if (!authResp.ok) {
    throw new Error(
      `PUT /authenticate returned ${authResp.status}: ${await authResp.text()}`,
    );
  }

  const authResult = await authResp.json() as { authToken?: string };
  if (!authResult.authToken) {
    throw new Error(
      'Agent not yet approved on hc-auth server (no authToken in response). ' +
      'An admin must approve the agent first.',
    );
  }

  // base64_auth_material: the conductor sends this verbatim to PUT /authenticate
  const authMaterialBase64 = Buffer.from(authBody).toString('base64');

  return {
    authBody,
    authMaterialBase64,
    authToken: authResult.authToken,
  };
}

/** Format authenticate output for the chosen format */
export function formatAuthOutput(
  result: { authBody: string; authMaterialBase64: string },
  format: 'base64' | 'json' | 'conductor-yaml-patch',
): string {
  switch (format) {
    case 'base64':
      return result.authMaterialBase64;
    case 'json':
      return result.authBody;
    case 'conductor-yaml-patch':
      return `base64_auth_material: "${result.authMaterialBase64}"`;
  }
}

// ---- check ----

/**
 * Diagnostic: check connectivity and agent state on hc-auth server.
 */
export async function check(opts: CheckOptions): Promise<string> {
  const lines: string[] = [];
  lines.push(`hc-auth server: ${opts.hcAuthUrl}`);

  if (!opts.apiToken) {
    // No token — just check basic connectivity
    try {
      const resp = await fetch(`${opts.hcAuthUrl.replace(/\/$/, '')}/now`);
      lines.push(`  connectivity: ok (HTTP ${resp.status})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`  connectivity: failed (${msg})`);
    }
    lines.push(`  agent state: skipped (no API token provided)`);
    return lines.join('\n');
  }

  const config: HcAuthConfig = {
    url: opts.hcAuthUrl,
    api_token: opts.apiToken,
  };
  const client = new HcAuthClient(config);
  const rawKey = agentKeyToRawEd25519Base64url(opts.agentKey);

  try {
    const record = await client.getRecord(rawKey);
    lines.push(`  connectivity: ok`);
    if (record) {
      lines.push(`  agent ${opts.agentKey.slice(0, 16)}...: ${record.state}`);
    } else {
      lines.push(`  agent ${opts.agentKey.slice(0, 16)}...: not registered`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`  connectivity: failed (${msg})`);
  }

  return lines.join('\n');
}

// ---- register ----

/**
 * Admin-side: register an agent and immediately authorize it.
 */
export async function register(opts: RegisterOptions): Promise<string> {
  const config: HcAuthConfig = {
    url: opts.hcAuthUrl,
    api_token: opts.apiToken,
  };
  const client = new HcAuthClient(config);
  const rawKey = agentKeyToRawEd25519Base64url(opts.agentKey);

  // Check current state first
  const before = await client.getRecord(rawKey);
  const wasBefore = before ? before.state : 'not registered';

  await client.registerAndAuthorize(rawKey, opts.metadata ?? {
    agent_key: opts.agentKey,
    timestamp: Date.now(),
  });

  return `agent ${opts.agentKey.slice(0, 16)}...: registered and authorized (was: ${wasBefore})`;
}
