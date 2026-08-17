/**
 * HTTP client for the hc-auth-server admin API.
 *
 * Mirrors the workflow demonstrated in examples/client.rs in the
 * holochain/hc-auth-server repository. When an official npm package for
 * hc-auth-server is published this module can be replaced with that dependency.
 *
 * The joining service uses this client to register and immediately authorize
 * agent keys after they pass all joining challenges. The agent then
 * authenticates directly against hc-auth-server (GET /now → sign → PUT
 * /authenticate) to obtain a token for downstream services such as
 * kitsune2-bootstrap-srv.
 *
 * Key encoding: hc-auth-server expects raw 32-byte Ed25519 public keys encoded
 * as base64url (no padding). Use agentKeyToRawEd25519Base64url() from utils.ts
 * to convert a Holochain AgentPubKey before calling these methods.
 */

export interface HcAuthConfig {
  /** Base URL of the hc-auth-server, e.g. "https://auth.holo.host" */
  url: string;
  /** Bearer token from the server's API_TOKENS config */
  api_token: string;
  /**
   * Whether a failure to register/authorize should block provisioning.
   * Default: false (non-fatal — hc-auth outage does not break joining).
   */
  required?: boolean;
  /**
   * Claim keys to forward as metadata to hc-auth (e.g. ["email", "phone"]).
   * When set, matching claims from the join session are included in the
   * metadata payload sent during registerAndAuthorize.
   * Default: undefined (no claims forwarded).
   */
  forward_claims?: string[];
}

export type AgentState = 'pending' | 'authorized' | 'blocked';

export interface HcAuthRecord {
  state: AgentState;
  pubKey: string;
  json?: unknown;
}

export class HcAuthClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(readonly config: HcAuthConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    this.authHeader = `Bearer ${config.api_token}`;
  }

  /**
   * Register a raw Ed25519 public key as a pending auth request.
   *
   * Corresponds to PUT /request-auth/{pubkey} in the client API, which
   * returns:
   *   200 OK                 registered (pending)
   *   409 CONFLICT           key already has a record -- once hc-auth-server
   *                          maps `already_exists` to a conflict status
   *   500 INTERNAL           what `already_exists` currently surfaces as,
   *                          since the server reports it as a storage failure
   *   429 TOO MANY REQUESTS  pending-request limit reached; nothing was stored
   *   401 UNAUTHORIZED       invalid pubkey
   *
   * 409 and 500 are treated as success because the caller's next step is the
   * pending -> authorized transition, which is exactly what an
   * already-registered key needs. A 500 that is a genuine storage failure
   * rather than `already_exists` is not swallowed: the transition that
   * follows has no record to act on and throws there. Accepting both lets
   * the server-side conflict mapping land without a lockstep release here.
   */
  async requestAuth(rawPubKeyB64url: string, metadata: unknown): Promise<void> {
    const resp = await fetch(
      `${this.baseUrl}/request-auth/${rawPubKeyB64url}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      },
    );

    if (resp.ok || resp.status === 409 || resp.status === 500) return;

    // 429 means the limit was hit and the key was NOT registered. Naming that
    // here matters: proceeding would fail at the transition step instead, and
    // report a missing record rather than the rate limit that caused it.
    if (resp.status === 429) {
      throw new Error(
        'hc-auth PUT /request-auth returned 429: pending-request limit reached, ' +
          `key was not registered: ${await resp.text()}`,
      );
    }

    throw new Error(
      `hc-auth PUT /request-auth returned ${resp.status}: ${await resp.text()}`,
    );
  }

  /**
   * Transition a key between states using the admin API.
   *
   * Corresponds to POST /api/transition (requires Bearer token).
   * Field names match the server's camelCase JSON schema.
   */
  async transition(
    rawPubKeyB64url: string,
    oldState: AgentState,
    newState: AgentState,
  ): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/api/transition`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
      },
      body: JSON.stringify({
        pubKey: rawPubKeyB64url,
        oldState,
        newState,
      }),
    });
    if (!resp.ok) {
      throw new Error(
        `hc-auth POST /api/transition returned ${resp.status}: ${await resp.text()}`,
      );
    }
  }

  /**
   * Fetch the current record for a key via the admin API.
   *
   * Corresponds to GET /api/get/{key} (requires Bearer token).
   * Returns null if the key is not registered.
   */
  async getRecord(rawPubKeyB64url: string): Promise<HcAuthRecord | null> {
    const resp = await fetch(`${this.baseUrl}/api/get/${rawPubKeyB64url}`, {
      headers: { Authorization: this.authHeader },
    });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(
        `hc-auth GET /api/get returned ${resp.status}: ${await resp.text()}`,
      );
    }
    return resp.json() as Promise<HcAuthRecord>;
  }

  /**
   * Register a key and immediately authorize it. Idempotent.
   *
   * State machine:
   *   not found  → requestAuth (→ pending) → transition (pending → authorized)
   *   pending    → transition (pending → authorized)
   *   authorized → no-op
   *   blocked    → transition (blocked → authorized)
   */
  async registerAndAuthorize(
    rawPubKeyB64url: string,
    metadata: unknown,
  ): Promise<void> {
    const existing = await this.getRecord(rawPubKeyB64url);

    if (existing?.state === 'authorized') {
      return;
    }

    if (existing?.state === 'blocked') {
      await this.transition(rawPubKeyB64url, 'blocked', 'authorized');
      return;
    }

    if (!existing) {
      await this.requestAuth(rawPubKeyB64url, metadata);
    }
    // existing.state === 'pending' || just registered → transition to authorized
    await this.transition(rawPubKeyB64url, 'pending', 'authorized');
  }
}
