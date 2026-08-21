/**
 * JoiningClient — handles the full discovery-join-verify-provision flow
 * against a Holo joining service.
 *
 * Can be used standalone or orchestrated by WebConductorAppClient.
 */

import type {
  WellKnownHoloJoining,
  JoiningServiceInfo,
  Challenge,
  JoinProvision,
  ReconnectResponse,
  JoinResponse,
  VerifyResponse,
  StatusResponse,
  ErrorResponse,
} from '../types.js';

// ---- Error class ----

export class JoiningError extends Error {
  code: string;
  httpStatus: number;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'JoiningError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

// ---- JoinSession (immutable) ----

export class JoinSession {
  readonly sessionToken: string;
  readonly status: 'ready' | 'pending' | 'rejected';
  readonly challenges?: Challenge[];
  readonly reason?: string;
  readonly pollIntervalMs?: number;

  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    sessionToken: string,
    status: 'ready' | 'pending' | 'rejected',
    challenges?: Challenge[],
    reason?: string,
    pollIntervalMs?: number,
  ) {
    this.baseUrl = baseUrl;
    this.sessionToken = sessionToken;
    this.status = status;
    this.challenges = challenges;
    this.reason = reason;
    this.pollIntervalMs = pollIntervalMs;
  }

  async verify(challengeId: string, response: string): Promise<JoinSession> {
    const res = await fetch(
      `${this.baseUrl}/join/${this.sessionToken}/verify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge_id: challengeId, response }),
      },
    );

    if (!res.ok) {
      await throwJoiningError(res);
    }

    const body = await res.json() as VerifyResponse;
    return new JoinSession(
      this.baseUrl,
      this.sessionToken,
      body.status,
      body.challenges_remaining,
      body.reason,
      body.poll_interval_ms,
    );
  }

  async pollStatus(): Promise<JoinSession> {
    const res = await fetch(
      `${this.baseUrl}/join/${this.sessionToken}/status`,
    );

    if (!res.ok) {
      await throwJoiningError(res);
    }

    const body = await res.json() as StatusResponse;
    return new JoinSession(
      this.baseUrl,
      this.sessionToken,
      body.status,
      body.challenges,
      body.reason,
      body.poll_interval_ms,
    );
  }

  async getProvision(): Promise<JoinProvision> {
    const res = await fetch(
      `${this.baseUrl}/join/${this.sessionToken}/provision`,
    );

    if (!res.ok) {
      await throwJoiningError(res);
    }

    return await res.json() as JoinProvision;
  }
}

// ---- JoiningClient ----

export class JoiningClient {
  private readonly baseUrl: string;
  private cachedInfo?: JoiningServiceInfo;
  private readonly discoveredHappId?: string;

  private constructor(baseUrl: string, discoveredHappId?: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.discoveredHappId = discoveredHappId;
  }

  /**
   * Discover a joining service from the app domain's .well-known endpoint.
   * Retains the document's `happ_id` so a later `join()` call can default to
   * it without the caller having to thread it through by hand.
   */
  static async discover(appDomain: string): Promise<JoiningClient> {
    const origin = appDomain.startsWith('http')
      ? appDomain
      : `https://${appDomain}`;
    const url = `${origin.replace(/\/+$/, '')}/.well-known/holo-joining`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new JoiningError(
        'discovery_failed',
        `Failed to discover joining service at ${url}: ${res.status}`,
        res.status,
      );
    }

    const body = await res.json() as WellKnownHoloJoining;
    return new JoiningClient(body.joining_service_url, body.happ_id);
  }

  /**
   * Create a client from an explicit joining service URL.
   */
  static fromUrl(joiningServiceUrl: string): JoiningClient {
    return new JoiningClient(joiningServiceUrl);
  }

  /**
   * Get service info (hApp metadata, auth methods, gateways).
   */
  async getInfo(): Promise<JoiningServiceInfo> {
    if (this.cachedInfo) return this.cachedInfo;

    const res = await fetch(`${this.baseUrl}/info`);
    if (!res.ok) {
      await throwJoiningError(res);
    }

    this.cachedInfo = await res.json() as JoiningServiceInfo;
    return this.cachedInfo!;
  }

  /**
   * Initiate a join session for the given agent key.
   *
   * @param agentKey - Base64-encoded 39-byte AgentPubKey
   * @param claims - Optional identity claims (email, invite_code, etc.)
   * @param network - happ_id of a registered network to join. Determines
   *   which network's `roles` (and therefore membrane proofs) the session
   *   receives at provision, instead of the service's static `roles`.
   *   Three-way: omit (`undefined`) to default to the happ_id discovered by
   *   `discover()`, if any (naming the statically configured network's own
   *   happ_id is harmless -- the server normalizes it to the same session
   *   scope as an omitted `network`); pass `null` to explicitly suppress the
   *   discovered default and send no `network` at all; pass a string to
   *   override discovery with that network.
   * @returns A JoinSession — check `.status` to determine next steps
   */
  async join(
    agentKey: string,
    claims?: Record<string, string>,
    network?: string | null,
  ): Promise<JoinSession> {
    const body: Record<string, unknown> = { agent_key: agentKey };
    if (claims && Object.keys(claims).length > 0) {
      body.claims = claims;
    }
    // undefined -> fall back to the discovered happ_id; null -> explicit
    // opt-out (send no network); a string -> use it as-is.
    const resolvedNetwork = network === undefined ? this.discoveredHappId : network;
    if (resolvedNetwork) {
      body.network = resolvedNetwork;
    }

    const res = await fetch(`${this.baseUrl}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwJoiningError(res);
    }

    const data = await res.json() as JoinResponse;
    return new JoinSession(
      this.baseUrl,
      data.session,
      data.status,
      data.challenges,
      // A join is never created in the "rejected" state — rejection surfaces as
      // a thrown JoiningError (403 join_rejected) above. Only pollStatus() can
      // observe a rejection reason, on a session rejected after creation.
      undefined,
      data.poll_interval_ms,
    );
  }

  /**
   * Reconnect an already-joined agent to get fresh linker/gateway URLs and,
   * when the agent has a ready session for the requested network, that
   * session's token -- the recovery path for an agent that completed
   * `join()` and crashed before calling `getProvision()`, since a fresh
   * `join()` after that point only gets `409 agent_already_joined`.
   *
   * @param agentKey - Base64-encoded 39-byte AgentPubKey
   * @param signTimestamp - Callback that signs an ISO 8601 timestamp string
   *   with the agent's ed25519 private key and returns the signature bytes
   * @param network - happ_id of the network whose session token to look up.
   *   Omit to target the statically configured network (naming it explicitly
   *   is equivalent). Does not affect what gets signed: the signature covers
   *   only the timestamp, so `network` is safe to add to the request body
   *   without a signer-side change -- it selects among the agent's own
   *   already-authenticated sessions rather than authorizing anything new.
   */
  async reconnect(
    agentKey: string,
    signTimestamp: (timestamp: string) => Promise<Uint8Array>,
    network?: string,
  ): Promise<ReconnectResponse> {
    const timestamp = new Date().toISOString();
    const signatureBytes = await signTimestamp(timestamp);
    const signature = uint8ArrayToBase64(signatureBytes);

    const body: Record<string, unknown> = { agent_key: agentKey, timestamp, signature };
    if (network !== undefined) {
      body.network = network;
    }

    const res = await fetch(`${this.baseUrl}/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwJoiningError(res);
    }

    return await res.json() as ReconnectResponse;
  }

  /**
   * Reconnect and, when a session token comes back, immediately fetch its
   * provision -- the one-call version of the crash-recovery path: an agent
   * that joined and crashed before provisioning calls this instead of
   * `join()` to pick up where it left off. `provision` is absent when the
   * requested network has no ready session (`reconnect.session` absent too),
   * which callers should treat as "fall through to `join()` for this
   * network".
   *
   * @param agentKey - Base64-encoded 39-byte AgentPubKey
   * @param signTimestamp - Callback that signs an ISO 8601 timestamp string
   *   with the agent's ed25519 private key and returns the signature bytes
   * @param network - happ_id of the network to recover. Omit for the
   *   statically configured network.
   */
  async reconnectAndProvision(
    agentKey: string,
    signTimestamp: (timestamp: string) => Promise<Uint8Array>,
    network?: string,
  ): Promise<{ reconnect: ReconnectResponse; provision?: JoinProvision }> {
    const reconnect = await this.reconnect(agentKey, signTimestamp, network);
    if (!reconnect.session) {
      return { reconnect };
    }

    const session = new JoinSession(this.baseUrl, reconnect.session, 'ready');
    const provision = await session.getProvision();
    return { reconnect, provision };
  }

  /** The resolved base URL of this joining service. */
  get url(): string {
    return this.baseUrl;
  }
}

// ---- Helpers ----

async function throwJoiningError(res: Response): Promise<never> {
  let code = 'unknown_error';
  let message = `HTTP ${res.status}`;
  let details: Record<string, unknown> | undefined;

  try {
    const body = await res.json() as ErrorResponse;
    if (body.error) {
      code = body.error.code;
      message = body.error.message;
      details = body.error.details;
    }
  } catch {
    // Response wasn't JSON — use status text
    message = res.statusText || message;
  }

  throw new JoiningError(code, message, res.status, details);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Works in both Node.js and browsers
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
