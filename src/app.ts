import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ServiceConfig, RoleConfig } from './config.js';
import { JoinRequestError, type AuthMethodPlugin, type JoinContext } from './auth-methods/plugin.js';
import type { SessionStore, SessionData, ChallengeState } from './session/store.js';
import { holdsLink } from './session/store.js';
import {
  DiditWithEmailAuthMethod,
  pollIntervalMs,
  takeLink,
} from './auth-methods/didit-with-email.js';
import { InviteCodeAuthMethod } from './auth-methods/invite-code.js';
import { createDiditRoutes } from './routes/didit-links.js';
import type { MembraneProofGenerator } from './membrane-proof/generator.js';
import type { UrlProvider } from './urls/provider.js';
import type { AuthMethodEntry, AuthMethodGroup, Challenge, LinkerUrl, ReconnectResponse, RoleProvision } from './types.js';
import type { LinkerRegistration } from './linker-auth/types.js';
import {
  generateSessionId,
  validateAgentKey,
  isCanonicalAgentKey,
  toBase64,
  fromBase64,
  decodeHashFromBase64,
  agentKeyToRawEd25519Base64url,
} from './utils.js';
import type { HcAuthClient } from './hc-auth/index.js';
import { LinkerAuthClient } from './linker-auth/index.js';
import {
  validateDelegatedVerification,
  validatePayloadShape,
  type DelegatedVerificationPayload,
} from './auth-methods/delegated-verification.js';
import * as ed from '@noble/ed25519';
import type { LinkerRegistrationStore } from './linker-registration/store.js';
import { createAdminLinkerRoutes } from './routes/admin-linkers.js';
import { createLinkerRoutes } from './routes/linker-heartbeat.js';
import type { AllowedAgentStore } from './agent-registration/store.js';
import { createAdminAgentRoutes } from './routes/admin-agents.js';
import type { NetworkStore, NetworkRecord } from './network-registration/store.js';
import { createAdminNetworkRoutes, HAPP_ID_RE } from './routes/admin-networks.js';

export interface ServiceContext {
  config: ServiceConfig;
  sessionStore: SessionStore;
  authPlugins: Map<string, AuthMethodPlugin>;
  proofGenerator?: MembraneProofGenerator;
  urlProvider: UrlProvider;
  hcAuthClient?: HcAuthClient;
  linkerRegistrationStore?: LinkerRegistrationStore;
  allowedAgentStore?: AllowedAgentStore;
  networkStore?: NetworkStore;
}

/**
 * A required downstream service (currently hc-auth) was unreachable or
 * errored. Mapped to 503 `service_unavailable` by the error handler, so a
 * caller can tell "we could not reach our auth service" from "your
 * credentials were rejected" -- the two need very different responses, and a
 * bare 500 conflates them.
 */
class ServiceUnavailableError extends Error {
  constructor(message: string, readonly reason?: unknown) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

async function notifyHcAuth(
  ctx: ServiceContext,
  agentKey: string,
  claims?: Record<string, string>,
): Promise<void> {
  if (!ctx.hcAuthClient) return;
  const rawKey = agentKeyToRawEd25519Base64url(agentKey);
  const metadata: Record<string, unknown> = {
    agent_key: agentKey,
    happ_id: ctx.config.happ.id,
  };

  // Forward configured claim keys (e.g. email, phone) to hc-auth metadata
  const forwardKeys = ctx.config.hc_auth?.forward_claims;
  if (forwardKeys && claims) {
    for (const key of forwardKeys) {
      if (claims[key]) {
        metadata[key] = claims[key];
      }
    }
  }

  try {
    await ctx.hcAuthClient.registerAndAuthorize(rawKey, metadata);
  } catch (err) {
    if (ctx.config.hc_auth?.required) {
      // The agent's own credentials were fine -- this is our downstream
      // registration failing after that point. Tagged so it does not surface
      // as an indistinguishable 500.
      throw new ServiceUnavailableError('Auth service registration failed', err);
    }
    console.error('[hc-auth] registerAndAuthorize failed (non-fatal):', err);
  }
}

/** Extract client-safe LinkerUrl[] from registrations (strips admin fields). */
function toLinkerUrls(
  registrations: LinkerRegistration[] | undefined,
): LinkerUrl[] | undefined {
  return registrations?.map((r) => r.linker_url);
}

async function notifyLinkers(
  ctx: ServiceContext,
  agentKey: string,
): Promise<void> {
  if (!ctx.config.linker_auth) {
    console.log('[linker-auth] skipped: linker_auth not configured');
    return;
  }

  const registrations = await ctx.urlProvider.getLinkerRegistrations();
  // Only authorize on linkers that have admin credentials (skip open linkers)
  const authable = registrations?.filter((r) => r.admin);
  if (!authable?.length) {
    console.log('[linker-auth] skipped: no linker registrations with admin credentials',
      { registrationCount: registrations?.length ?? 0 });
    return;
  }

  console.log(`[linker-auth] authorizing agent on ${authable.length} linker(s)`,
    { agentKey: agentKey.slice(0, 20) + '...', adminUrls: authable.map(r => r.admin!.url) });

  const { capabilities, required } = ctx.config.linker_auth;

  const results = await Promise.allSettled(
    authable.map((reg) => {
      const client = new LinkerAuthClient(reg.admin!);
      return client.authorizeAgent(agentKey, capabilities);
    }),
  );

  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );

  const successes = results.filter(r => r.status === 'fulfilled').length;
  if (successes > 0) {
    console.log(`[linker-auth] authorized agent on ${successes}/${authable.length} linker(s)`);
  }

  if (failures.length > 0) {
    const summary = failures
      .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
      .join('; ');

    if (required) {
      throw new Error(`linker authorization failed: ${summary}`);
    }
    console.error(
      `[linker-auth] authorization failed on ${failures.length}/${authable.length} linkers (non-fatal): ${summary}`,
    );
  }
}

function isGroup(entry: AuthMethodEntry): entry is AuthMethodGroup {
  return typeof entry === 'object' && 'any_of' in entry;
}

/** The hc-auth and linker steps of every ready path. A join that holds an hc_auth_approval challenge leaves authorizing the key to hc-auth. */
async function notifyReady(
  ctx: ServiceContext,
  agentKey: string,
  claims: Record<string, string>,
  challenges: ChallengeState[],
): Promise<void> {
  if (!usedHcAuthApproval(challenges)) {
    await notifyHcAuth(ctx, agentKey, claims);
  }
  await notifyLinkers(ctx, agentKey);
}

/** Runs the ready steps before writing, so a failed required step creates nothing. */
async function createReadySession(
  ctx: ServiceContext,
  sessionId: string,
  agentKey: string,
  claims: Record<string, string>,
  challenges: ChallengeState[],
  options?: { beforeCreate?: () => Promise<void> },
  network?: string,
): Promise<void> {
  await notifyReady(ctx, agentKey, claims, challenges);
  await options?.beforeCreate?.();

  await ctx.sessionStore.create({
    id: sessionId,
    agent_key: agentKey,
    status: 'ready',
    challenges,
    claims,
    created_at: Date.now(),
    network,
  });
}

/** OR-aware completion: ungrouped must all pass, each group needs at least one. */
function allSatisfied(challenges: ChallengeState[]): boolean {
  const groups = new Map<string, ChallengeState[]>();
  const ungrouped: ChallengeState[] = [];

  for (const cs of challenges) {
    if (cs.group) {
      const list = groups.get(cs.group) ?? [];
      list.push(cs);
      groups.set(cs.group, list);
    } else {
      ungrouped.push(cs);
    }
  }

  if (!ungrouped.every((cs) => cs.completed)) return false;

  for (const [, members] of groups) {
    if (!members.some((cs) => cs.completed)) return false;
  }

  return true;
}

/** True if any challenge in the session used hc_auth_approval. */
function usedHcAuthApproval(challenges: ChallengeState[]): boolean {
  return challenges.some((cs) => cs.challenge.type === 'hc_auth_approval');
}

function diditMethod(ctx: ServiceContext): DiditWithEmailAuthMethod | undefined {
  const plugin = ctx.authPlugins.get('didit_with_email');
  return plugin instanceof DiditWithEmailAuthMethod ? plugin : undefined;
}

async function sendLinks(
  didit: DiditWithEmailAuthMethod | undefined,
  agentKey: string,
  claims: Record<string, string>,
  challenges: ChallengeState[],
): Promise<void> {
  for (const cs of challenges.filter((c) => c.link)) {
    const others = cs.group ? challenges.filter((o) => o !== cs && o.group === cs.group) : [];
    if (!others.some((o) => o.completed)) {
      try {
        await didit!.sendFirst(agentKey, claims.email, cs);
        continue;
      } catch (e) {
        if (!(e instanceof JoinRequestError) || others.length === 0) throw e;
        console.warn(`[didit_with_email] link not sent (${e.code}), so the join goes on with the rest of its any_of group`);
      }
    }
    challenges.splice(challenges.indexOf(cs), 1);
  }
}

/** The static network's own happ id is the same session scope as an omitted `network`. */
function normalizeNetwork(config: ServiceConfig, value: string | undefined): string | undefined {
  return value === config.happ.id ? undefined : value;
}

import type { NetworkConfig } from './types.js';

/** Build a NetworkConfig from service config. Returns undefined if no URLs are available. */
function buildNetworkConfig(config: ServiceConfig): NetworkConfig | undefined {
  const nc: NetworkConfig = {};
  if (config.hc_auth?.url) nc.auth_server_url = config.hc_auth.url;
  if (config.network?.bootstrap_url) nc.bootstrap_url = config.network.bootstrap_url;
  if (config.network?.relay_url) nc.relay_url = config.network.relay_url;
  return Object.keys(nc).length > 0 ? nc : undefined;
}

/** Per-role `{ dna_modifiers }` map as returned in /v1/info responses. */
function rolesToInfo(
  roles: Record<string, RoleConfig> | undefined,
): Record<string, { dna_modifiers?: RoleConfig['modifiers'] }> | undefined {
  return roles
    ? Object.fromEntries(
        Object.entries(roles).map(([role, rc]) => [role, { dna_modifiers: rc.modifiers }]),
      )
    : undefined;
}

/**
 * Service-level /v1/info fields that are identical regardless of which
 * network (static or registered) the response describes -- only `happ`,
 * `happ_bundle_url`, and `roles` vary per network.
 */
async function buildServiceInfoFields(ctx: ServiceContext) {
  const { config } = ctx;
  const registrations = await ctx.urlProvider.getLinkerRegistrations();
  const linkerUrls = toLinkerUrls(registrations);
  const httpGateways = await ctx.urlProvider.getHttpGateways();
  return {
    http_gateways: httpGateways,
    auth_methods: config.auth_methods,
    linker_info: linkerUrls
      ? (config.linker_info ?? { selection_mode: 'assigned' })
      : undefined,
    network_config: config.network?.reveal_in_info
      ? buildNetworkConfig(config)
      : undefined,
  };
}

/**
 * The bare /v1/info response body -- also served at GET /v1/info/:happ_id
 * when the id names the service's own statically configured happ id.
 */
async function buildStaticInfo(ctx: ServiceContext) {
  const { config } = ctx;
  return {
    happ: {
      id: config.happ.id,
      name: config.happ.name,
      description: config.happ.description,
      icon_url: config.happ.icon_url,
    },
    happ_bundle_url: config.happ.happ_bundle_url,
    roles: rolesToInfo(config.roles),
    ...(await buildServiceInfoFields(ctx)),
  };
}

/**
 * Resolve what provisioning should use for a session: the named network's
 * own roles and happ_bundle_url if it joined one (no fallback to the
 * service's own happ_bundle_url -- a network's bundle is independent of the
 * service's), otherwise the service's static config. Returns
 * 'unknown_network' if the network was since deleted.
 */
async function resolveProvisionSource(
  ctx: ServiceContext,
  session: SessionData,
): Promise<
  | { roles: Record<string, RoleConfig> | undefined; happBundleUrl: string | undefined }
  | 'unknown_network'
> {
  if (!session.network) {
    return { roles: ctx.config.roles, happBundleUrl: ctx.config.happ.happ_bundle_url };
  }
  const record = await ctx.networkStore?.get(session.network);
  if (!record) return 'unknown_network';
  return { roles: record.roles, happBundleUrl: record.happ?.happ_bundle_url };
}

function errorJson(code: string, message: string, status: number) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

/** The validated `agent_key` and normalized `network`, or the 400 that refuses them. */
function requestScope(
  ctx: ServiceContext,
  body: { agent_key?: unknown; network?: unknown },
): { agentKey: string; network: string | undefined } | Response {
  const agentKey = body.agent_key;
  if (!agentKey) {
    return errorJson('invalid_agent_key', 'agent_key is required', 400);
  }

  const validation = validateAgentKey(agentKey as string);
  if (!validation.valid) {
    return errorJson('invalid_agent_key', validation.reason!, 400);
  }

  // Refused rather than falling back to the static scope, which would act on
  // the static network instead of the one asked for. The format check also
  // bounds `network` before it reaches a KV key or an error body.
  if (body.network !== undefined && typeof body.network !== 'string') {
    return errorJson('unknown_network', 'network must be a string', 400);
  }
  const network = normalizeNetwork(ctx.config, body.network as string | undefined);
  if (network !== undefined && !HAPP_ID_RE.test(network)) {
    return errorJson(
      'unknown_network',
      'network does not match the network-id format',
      400,
    );
  }
  return { agentKey: agentKey as string, network };
}

const MAX_SIGNED_AHEAD_MS = 30_000;
// Date.parse alone also reads a string such as `resume:{date}` as a date, which
// would let one route's signed message pass as reconnect's bare timestamp.
const SIGNED_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

function timestampError(ctx: ServiceContext, timestamp: string): Response | null {
  const toleranceSeconds =
    ctx.config.reconnect?.timestamp_tolerance_seconds ?? 300;
  const at = Date.parse(timestamp);
  if (!SIGNED_TIMESTAMP_RE.test(timestamp) || isNaN(at)) {
    return errorJson(
      'timestamp_out_of_range',
      'Invalid timestamp format',
      400,
    );
  }

  const drift = Math.abs(Date.now() - at);
  if (drift > toleranceSeconds * 1000) {
    return errorJson(
      'timestamp_out_of_range',
      `Timestamp is ${Math.round(drift / 1000)}s from server time (max ${toleranceSeconds}s)`,
      400,
    );
  }
  const ahead = at - Date.now();
  if (ahead > MAX_SIGNED_AHEAD_MS) {
    return errorJson(
      'timestamp_out_of_range',
      `Timestamp is ${Math.round(ahead / 1000)}s ahead of server time (max ${MAX_SIGNED_AHEAD_MS / 1000}s)`,
      400,
    );
  }
  return null;
}

async function signedByAgent(
  agentKey: string,
  message: string,
  signature: string,
): Promise<boolean> {
  if (!isCanonicalAgentKey(agentKey)) return false;
  const sigBytes = fromBase64(signature);
  const msgBytes = new TextEncoder().encode(message);
  // Extract the raw 32-byte ed25519 public key from the 39-byte AgentPubKey
  // (skip 3-byte HoloHash prefix, take 32 bytes, skip 4-byte DHT location)
  const agentKeyBytes = decodeHashFromBase64(agentKey);
  const publicKey = agentKeyBytes.slice(3, 35);

  try {
    return await ed.verifyAsync(sigBytes, msgBytes, publicKey);
  } catch {
    return false;
  }
}

async function signatureError(
  ctx: ServiceContext,
  agentKey: string,
  timestamp: unknown,
  signature: unknown,
  message: (timestamp: string) => string,
): Promise<Response | null> {
  if (typeof timestamp !== 'string' || typeof signature !== 'string') {
    return errorJson('invalid_signature', 'timestamp and signature are required', 400);
  }
  const stale = timestampError(ctx, timestamp);
  if (stale) return stale;
  if (await signedByAgent(agentKey, message(timestamp), signature)) return null;
  return errorJson(
    'invalid_signature',
    'Signature does not verify against agent key',
    400,
  );
}

function pendingView(session: SessionData) {
  return {
    challenges: session.challenges.map((cs) => ({
      ...stripInternal(cs.challenge),
      completed: cs.completed,
    })),
    poll_interval_ms: pollIntervalMs(session.challenges),
  };
}

/**
 * Makes ready a pending session whose requirements are all met, saving
 * `ready` last. A failed required step leaves the session pending for the
 * next call to retry.
 */
async function completeIfSatisfied(ctx: ServiceContext, session: SessionData): Promise<boolean> {
  if (session.status !== 'pending' || !allSatisfied(session.challenges)) return false;
  await notifyReady(ctx, session.agent_key, session.claims, session.challenges);
  await ctx.sessionStore.update(session.id, { status: 'ready', challenges: session.challenges });
  session.status = 'ready';
  return true;
}

const ALREADY_JOINED =
  'This agent key has already completed joining this network. Use POST /v1/reconnect instead.';

export function createApp(ctx: ServiceContext): Hono {
  const app = new Hono();
  const didit = diditMethod(ctx);

  // Without this, any throw escaping a handler becomes Hono's default bare
  // `Internal Server Error` text body -- no code for a client to branch on,
  // and no way to tell a rejected credential from a downstream failure that
  // happened *after* the caller was successfully verified.
  app.onError((err, c) => {
    if (err instanceof JoinRequestError) {
      const res = errorJson(err.code, err.message, err.status);
      if (err.retryAfterSeconds !== undefined) res.headers.set('Retry-After', String(err.retryAfterSeconds));
      return res;
    }
    if (err instanceof ServiceUnavailableError) {
      console.error(`[service_unavailable] ${err.message}:`, err.reason);
      return errorJson('service_unavailable', err.message, 503);
    }
    console.error('[unhandled] request failed:', err);
    return errorJson('internal_error', 'Internal server error', 500);
  });

  app.use('*', cors());

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Joining-Service-Version', '1.0');
  });

  // ---- GET /.well-known/holo-joining ----
  app.get('/.well-known/holo-joining', (c) => {
    const { config } = ctx;
    const baseUrl = config.base_url ?? c.req.url.replace(/\/.well-known\/holo-joining$/, '');
    return c.json({
      joining_service_url: `${baseUrl}/v1`,
      happ_id: config.happ.id,
      version: '1.0',
    });
  });

  // ---- GET /v1/info ----
  app.get('/v1/info', async (c) => {
    return c.json(await buildStaticInfo(ctx));
  });

  // ---- GET /v1/info/:happ_id ----
  // `/v1/info` and `/v1/info/:happ_id` are distinct path patterns that never
  // overlap, so registration order between them doesn't matter for shadowing.
  app.get('/v1/info/:happ_id', async (c) => {
    const { config } = ctx;
    const happId = c.req.param('happ_id');

    if (happId === config.happ.id) {
      return c.json(await buildStaticInfo(ctx));
    }

    // Cheap format check before the store lookup so junk ids are rejected
    // without a store round-trip (and, on KV, without risking a key-length
    // throw from garbage input).
    if (!HAPP_ID_RE.test(happId)) {
      return errorJson('unknown_network', 'network is not registered with this service', 404);
    }

    const record = ctx.networkStore ? await ctx.networkStore.get(happId) : null;
    if (!record) {
      return errorJson('unknown_network', 'network is not registered with this service', 404);
    }

    // A gated network's role modifiers (network_seed, etc.) are only for
    // agents that clear its allowed_agents gate -- exposing them at an
    // unauthenticated info endpoint would leak them to anyone who guesses
    // or is told the happ_id, defeating the gate's purpose. Joiners who pass
    // the gate still receive them normally at provision.
    const gated = (record.allowed_agents?.length ?? 0) > 0;

    return c.json({
      happ: {
        id: happId,
        name: record.happ?.name ?? happId,
        description: record.happ?.description,
        icon_url: record.happ?.icon_url,
      },
      happ_bundle_url: record.happ?.happ_bundle_url,
      roles: gated ? undefined : rolesToInfo(record.roles),
      ...(await buildServiceInfoFields(ctx)),
    });
  });

  // ---- POST /v1/join ----
  app.post('/v1/join', async (c) => {
    const body = await c.req.json();
    const { claims = {} } = body;
    const scope = requestScope(ctx, body);
    if (scope instanceof Response) return scope;
    const { agentKey: agent_key, network: requestedNetwork } = scope;

    const signed = body.timestamp !== undefined || body.signature !== undefined;
    if (signed) {
      const email = typeof claims?.email === 'string' ? claims.email : '';
      const refused = await signatureError(ctx, agent_key, body.timestamp, body.signature, (t) => `join:${t}:${email}`);
      if (refused) return refused;
    } else if (didit && claims?.email && !body.delegated_verification) {
      return errorJson(
        'signature_required',
        'A join with an email must be signed: send timestamp and signature',
        400,
      );
    }

    // Checked before the stale-session delete below, so a refused `network`
    // leaves the caller's pending session in place.
    let networkRecord: NetworkRecord | undefined;
    if (requestedNetwork !== undefined) {
      const record = ctx.networkStore ? await ctx.networkStore.get(requestedNetwork) : null;
      if (!record) {
        return errorJson(
          'unknown_network',
          'network is not registered with this service',
          400,
        );
      }
      // A network's allowed_agents restricts who may join it at all, on top
      // of whatever auth_methods the service otherwise applies -- without
      // this gate, any agent naming the network inherits its membrane
      // proofs regardless of auth_methods (e.g. progenitor registration
      // absolutely must be restricted; see issue #13).
      if (record.allowed_agents?.length && !record.allowed_agents.includes(agent_key)) {
        return errorJson(
          'join_rejected',
          'Agent is not allowed to join this network',
          403,
        );
      }
      networkRecord = record;
    }
    const joinContext: JoinContext = { network: networkRecord };

    // Check if agent already joined this network. Scoped to (agent, network)
    // so a session on another network neither blocks this join nor gets
    // deleted as a stale-pending session below.
    const existing = await ctx.sessionStore.findByAgentKey(agent_key, requestedNetwork);
    if (existing?.status === 'ready') {
      return errorJson('agent_already_joined', ALREADY_JOINED, 409);
    }

    const replacesLink = existing?.status === 'pending' && holdsLink(existing);
    if (replacesLink && !signed && !body.delegated_verification) {
      return errorJson(
        'join_in_progress',
        'Use POST /v1/join/resume, or sign the join to start again',
        409,
      );
    }
    // A replaced link session is deleted only when this join writes its own,
    // so a refused join leaves the link working.
    const dropReplacedLink = async () => {
      if (replacesLink) await ctx.sessionStore.delete(existing.id);
    };

    if (existing && !replacesLink) {
      await ctx.sessionStore.delete(existing.id);
    }

    // ---- Delegated verification fast path ----
    const rawDelegatedPayload = body.delegated_verification;
    if (rawDelegatedPayload && ctx.config.delegated_verification) {
      // Validate payload shape before casting
      const shapeError = validatePayloadShape(rawDelegatedPayload);
      if (shapeError) {
        return errorJson(shapeError.code, shapeError.message, shapeError.status);
      }

      const delegatedPayload = rawDelegatedPayload as DelegatedVerificationPayload;

      // Verify the auth method is configured
      const hasDelegated = ctx.config.auth_methods.some((entry) => {
        if (typeof entry === 'string') return entry === 'delegated_verification';
        if ('any_of' in entry) return entry.any_of.includes('delegated_verification');
        return false;
      });

      if (!hasDelegated) {
        return errorJson(
          'partner_not_authorized',
          'delegated_verification is not configured for this hApp',
          403,
        );
      }

      const apiKeyHeader = c.req.header('X-Partner-Api-Key');
      // Determine required claims: email is required by default for delegated verification
      const requiredClaims = ['email'];

      const result = validateDelegatedVerification(
        apiKeyHeader,
        delegatedPayload,
        ctx.config.delegated_verification,
        requiredClaims,
        claims,
      );

      if (!result.valid) {
        return errorJson(result.code, result.message, result.status);
      }

      // Audit log
      console.log('[delegated-verification] join accepted', {
        partner_id: result.partner.partner_id,
        partner_name: result.partner.name,
        agent_key: agent_key.slice(0, 20) + '...',
        claims_attested: Object.keys(claims),
        verified_at: delegatedPayload.verified_at,
        verification_method: delegatedPayload.verification_method,
        reference_id: delegatedPayload.reference_id,
        source_ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
        timestamp: new Date().toISOString(),
      });

      const sessionId = generateSessionId();
      await createReadySession(ctx, sessionId, agent_key, claims, [], { beforeCreate: dropReplacedLink }, requestedNetwork);

      return c.json({ session: sessionId, status: 'ready' }, 201);
    }

    // If delegated_verification payload was provided but no config exists, reject
    if (rawDelegatedPayload && !ctx.config.delegated_verification) {
      return errorJson(
        'partner_not_authorized',
        'delegated_verification is not configured for this service',
        403,
      );
    }

    const sessionId = generateSessionId();
    const allChallenges: ChallengeState[] = [];
    let groupIndex = 0;

    // Create challenges from each auth method entry
    for (const entry of ctx.config.auth_methods) {
      if (isGroup(entry)) {
        // OR group: create challenges for each method, tag with shared group id
        const groupId = `g_${groupIndex++}`;
        let groupHasChallenges = false;
        let refusal: JoinRequestError | undefined;

        for (const method of entry.any_of) {
          const plugin = ctx.authPlugins.get(method);
          if (!plugin) continue;

          try {
            const challenges = await plugin.createChallenges(
              agent_key,
              claims,
              ctx.config,
              joinContext,
            );
            for (const ch of challenges) {
              ch.group = groupId;
              allChallenges.push({
                challenge: ch,
                expected_response: (ch.metadata?.expected_code as string) ?? '',
                completed: false,
                attempts: 0,
                expires_at: ch.expires_at
                  ? new Date(ch.expires_at).getTime()
                  : Date.now() + 600_000,
                group: groupId,
                ...takeLink(ch),
              });
              groupHasChallenges = true;
            }
          } catch (e: unknown) {
            if (e instanceof JoinRequestError) refusal ??= e;
            // In an OR group, individual methods may fail (e.g. missing claims).
            // That's fine as long as at least one method in the group succeeds.
          }
        }

        // If no method in the OR group produced challenges, the group is unsatisfiable
        if (!groupHasChallenges) {
          if (refusal) throw refusal;
          return errorJson('join_rejected', 'No eligible auth method in group', 403);
        }
      } else {
        // AND: standalone method
        const plugin = ctx.authPlugins.get(entry);
        if (!plugin) continue;

        try {
          const challenges = await plugin.createChallenges(
            agent_key,
            claims,
            ctx.config,
            joinContext,
          );
          if (challenges.length === 0 && entry !== 'open' && entry !== 'hc_auth_approval') {
            // Non-open/non-hc_auth_approval method produced no challenges -- agent is not eligible
            return errorJson('join_rejected', 'Agent is not eligible for this auth method', 403);
          }
          for (const ch of challenges) {
            allChallenges.push({
              challenge: ch,
              expected_response: (ch.metadata?.expected_code as string) ?? '',
              completed: false,
              attempts: 0,
              expires_at: ch.expires_at
                ? new Date(ch.expires_at).getTime()
                : Date.now() + 600_000,
              ...takeLink(ch),
            });
          }
        } catch (e: unknown) {
          if (e instanceof JoinRequestError) throw e;
          const message = e instanceof Error ? e.message : 'Unknown error';
          return errorJson('missing_claims', message, 400);
        }
      }
    }

    const status = allChallenges.length === 0 ? 'ready' : 'pending';

    // For invite_code, auto-verify at join time
    if (status === 'pending') {
      for (const cs of allChallenges) {
        if (cs.challenge.type === 'invite_code') {
          const plugin = ctx.authPlugins.get('invite_code');
          if (plugin) {
            const result = await plugin.verifyChallengeResponse(
              cs.challenge,
              claims.invite_code ?? '',
              claims,
            );
            if (!result.passed) {
              return errorJson('join_rejected', result.reason ?? 'Invalid invite code', 403);
            }
            cs.completed = true;
          }
        }
      }
    }

    let finalStatus: typeof status;
    try {
      // After every other method and the invite check, so a refused join sends no email.
      await sendLinks(didit, agent_key, claims, allChallenges);
      finalStatus = allSatisfied(allChallenges) ? 'ready' : status;

      if (finalStatus === 'ready') {
        await createReadySession(
          ctx,
          sessionId,
          agent_key,
          claims,
          allChallenges,
          { beforeCreate: dropReplacedLink },
          requestedNetwork,
        );
      } else {
        await dropReplacedLink();
        await ctx.sessionStore.create({
          id: sessionId,
          agent_key,
          status: finalStatus,
          challenges: allChallenges,
          claims,
          created_at: Date.now(),
          network: requestedNetwork,
        });
      }
    } catch (e) {
      const invite = ctx.authPlugins.get('invite_code');
      if (invite instanceof InviteCodeAuthMethod && allChallenges.some((cs) => cs.challenge.type === 'invite_code' && cs.completed)) {
        invite.restore(claims.invite_code);
      }
      throw e;
    }

    const response: Record<string, unknown> = {
      session: sessionId,
      status: finalStatus,
    };

    if (finalStatus === 'pending') {
      response.challenges = allChallenges
        .filter((cs) => !cs.completed)
        .map((cs) => stripInternal(cs.challenge));
      response.poll_interval_ms = pollIntervalMs(allChallenges);
    }

    return c.json(response, 201);
  });

  // ---- POST /v1/join/:session/verify ----
  app.post('/v1/join/:session/verify', async (c) => {
    const sessionId = c.req.param('session');
    const session = await ctx.sessionStore.get(sessionId);

    if (!session) {
      return errorJson('invalid_session', 'Session not found or expired', 401);
    }

    if (session.status !== 'pending') {
      return errorJson(
        'invalid_session',
        `Session is ${session.status}, not pending`,
        401,
      );
    }

    const body = await c.req.json();
    const { challenge_id, response: challengeResponse } = body;

    const challengeState = session.challenges.find(
      (cs) => cs.challenge.id === challenge_id,
    );

    if (!challengeState) {
      return errorJson(
        'challenge_not_found',
        'Challenge not found for this session',
        404,
      );
    }

    if (challengeState.completed) {
      if (await completeIfSatisfied(ctx, session)) return c.json({ status: 'ready' });
      return errorJson(
        'challenge_not_found',
        'Challenge already completed',
        404,
      );
    }

    if (Date.now() > challengeState.expires_at) {
      return errorJson(
        'challenge_expired',
        'Challenge has expired; start a new join',
        410,
      );
    }

    challengeState.attempts++;
    if (challengeState.attempts > 5) {
      return errorJson(
        'rate_limited',
        'Too many verification attempts',
        429,
      );
    }

    const plugin = ctx.authPlugins.get(challengeState.challenge.type);
    if (!plugin) {
      return errorJson('invalid_response', 'Unknown auth method', 400);
    }

    const result = await plugin.verifyChallengeResponse(
      challengeState.challenge,
      challengeResponse,
      session.claims,
    );

    if (!result.passed) {
      await ctx.sessionStore.update(sessionId, {
        challenges: session.challenges,
      });
      return errorJson(
        'verification_failed',
        result.reason ?? 'Verification failed',
        422,
      );
    }

    challengeState.completed = true;
    await ctx.sessionStore.update(sessionId, { challenges: session.challenges });
    await completeIfSatisfied(ctx, session);

    const resp: Record<string, unknown> = { status: session.status };
    if (session.status === 'pending') {
      resp.challenges_remaining = session.challenges
        .filter((cs) => !cs.completed)
        .map((cs) => stripInternal(cs.challenge));
      resp.poll_interval_ms = pollIntervalMs(session.challenges);
    }

    return c.json(resp);
  });

  // ---- GET /v1/join/:session/status ----
  app.get('/v1/join/:session/status', async (c) => {
    const sessionId = c.req.param('session');
    const session = await ctx.sessionStore.get(sessionId);

    if (!session) {
      return errorJson('invalid_session', 'Session not found or expired', 401);
    }

    // Live-poll hc-auth for pending hc_auth_approval challenges
    if (session.status === 'pending' && ctx.hcAuthClient) {
      let changed = false;
      for (const cs of session.challenges) {
        if (cs.challenge.type !== 'hc_auth_approval' || cs.completed) continue;

        const rawKey = cs.challenge.metadata?.raw_key as string | undefined;
        if (!rawKey) continue;

        try {
          const record = await ctx.hcAuthClient.getRecord(rawKey);
          if (record?.state === 'authorized') {
            cs.completed = true;
            changed = true;
          } else if (record?.state === 'blocked') {
            await ctx.sessionStore.update(sessionId, {
              status: 'rejected',
              reason: 'Agent blocked by administrator',
              challenges: session.challenges,
            });
            return c.json({
              status: 'rejected',
              reason: 'Agent blocked by administrator',
            });
          }
        } catch (err) {
          console.error('[hc-auth] status poll failed:', err);
        }
      }

      if (changed) {
        const newStatus = allSatisfied(session.challenges) ? 'ready' : 'pending';
        if (newStatus === 'ready') {
          await notifyReady(ctx, session.agent_key, session.claims, session.challenges);
        }
        await ctx.sessionStore.update(sessionId, {
          status: newStatus,
          challenges: session.challenges,
        });
        session.status = newStatus;
      }
    }

    if (session.status === 'pending' && didit && holdsLink(session)) {
      await didit.refresh(session);
    }
    await completeIfSatisfied(ctx, session);

    const resp: Record<string, unknown> = { status: session.status };

    if (session.status === 'pending') {
      Object.assign(resp, pendingView(session));
    }

    if (session.status === 'rejected' && session.reason) {
      resp.reason = session.reason;
    }

    return c.json(resp);
  });

  // ---- GET /v1/join/:session/provision ----
  app.get('/v1/join/:session/provision', async (c) => {
    const sessionId = c.req.param('session');
    const session = await ctx.sessionStore.get(sessionId);

    if (!session) {
      return errorJson('invalid_session', 'Session not found or expired', 401);
    }

    if (session.status !== 'ready') {
      return errorJson(
        'not_ready',
        `Session status is "${session.status}", not "ready"`,
        403,
      );
    }

    // Revocation check: if hc_auth_approval was used, verify still authorized
    if (ctx.hcAuthClient && usedHcAuthApproval(session.challenges)) {
      const rawKey = agentKeyToRawEd25519Base64url(session.agent_key);
      try {
        const record = await ctx.hcAuthClient.getRecord(rawKey);
        if (record?.state === 'blocked') {
          await ctx.sessionStore.update(sessionId, {
            status: 'rejected',
            reason: 'Agent blocked by administrator',
          });
          return errorJson('agent_revoked', 'Agent has been blocked by administrator', 403);
        }
      } catch (err) {
        if (ctx.config.hc_auth?.required) {
          return errorJson('service_unavailable', 'Auth service check failed', 503);
        }
        console.error('[hc-auth] provision revocation check failed (non-fatal):', err);
      }
    }

    const provisionSource = await resolveProvisionSource(ctx, session);
    if (provisionSource === 'unknown_network') {
      return errorJson(
        'unknown_network',
        'network is not registered with this service',
        404,
      );
    }

    const linkerUrls = toLinkerUrls(await ctx.urlProvider.getLinkerRegistrations());

    let rolesOut: Record<string, RoleProvision> | undefined;
    const rolesCfg = provisionSource.roles;
    if (rolesCfg && Object.keys(rolesCfg).length > 0) {
      let proofsByHash: Record<string, Uint8Array> = {};
      if (ctx.proofGenerator) {
        const hashes = [
          ...new Set(
            Object.values(rolesCfg)
              .map((r) => r.dna_hash)
              .filter((hash): hash is string => hash !== undefined),
          ),
        ];
        proofsByHash = await ctx.proofGenerator.generate(session.agent_key, hashes);
      }
      rolesOut = {};
      for (const [role, rc] of Object.entries(rolesCfg)) {
        const proof = rc.dna_hash ? proofsByHash[rc.dna_hash] : undefined;
        rolesOut[role] = {
          membrane_proof: proof ? toBase64(proof) : undefined,
          dna_modifiers: rc.modifiers,
        };
      }
    }

    // Build network_config from config.network + hc_auth.url
    const networkConfig = buildNetworkConfig(ctx.config);

    return c.json({
      linker_urls: linkerUrls,
      happ_bundle_url: provisionSource.happBundleUrl,
      network_config: networkConfig,
      roles: rolesOut,
    });
  });

  // ---- Dynamic linker registration routes ----
  if (ctx.config.linker_auth?.admin_secret && ctx.linkerRegistrationStore) {
    const adminRoutes = createAdminLinkerRoutes(ctx.linkerRegistrationStore, ctx.config.linker_auth);
    const linkerRoutes = createLinkerRoutes(ctx.linkerRegistrationStore, ctx.config.linker_auth);
    app.route('', adminRoutes);
    app.route('', linkerRoutes);
  }

  // ---- Dynamic allowed-agent registration routes ----
  if (ctx.config.agent_registration?.admin_secret && ctx.allowedAgentStore) {
    app.route('', createAdminAgentRoutes(ctx.allowedAgentStore, ctx.config.agent_registration.admin_secret));
  }

  // ---- Dynamic network registration routes ----
  if (ctx.config.network_registration?.admin_secret && ctx.networkStore) {
    const staticDnaHashes = Object.values(ctx.config.roles ?? {})
      .map((rc) => rc.dna_hash)
      .filter((hash): hash is string => hash !== undefined);
    app.route(
      '',
      createAdminNetworkRoutes(ctx.networkStore, {
        adminSecret: ctx.config.network_registration.admin_secret,
        requireDnaHash: ctx.config.membrane_proof?.enabled === true,
        staticHappId: ctx.config.happ.id,
        staticDnaHashes,
      }),
    );
  }

  // ---- Emailed link pages and resend for didit_with_email ----
  if (didit) {
    app.route(
      '',
      createDiditRoutes(didit, ctx.sessionStore, {
        finishJoin: async (session) => {
          try {
            await completeIfSatisfied(ctx, session);
          } catch (err) {
            console.error('[didit_with_email] ready path failed; the next call retries:', err);
          }
        },
        pendingView,
      }),
    );
  }

  // ---- POST /v1/join/resume ----
  app.post('/v1/join/resume', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return errorJson('invalid_json', 'Request body must be a JSON object', 400);
    }
    const scope = requestScope(ctx, body);
    if (scope instanceof Response) return scope;
    const refused = await signatureError(ctx, scope.agentKey, body.timestamp, body.signature, (t) => `resume:${t}`);
    if (refused) return refused;

    const session = await ctx.sessionStore.findByAgentKey(scope.agentKey, scope.network);
    if (!session) {
      return errorJson(
        'join_not_found',
        'This agent key has no join in progress. Start one with POST /v1/join.',
        404,
      );
    }

    if (session.status === 'pending' && didit && holdsLink(session)) {
      await didit.refresh(session);
    }
    await completeIfSatisfied(ctx, session);

    if (session.status === 'ready') {
      return errorJson('agent_already_joined', ALREADY_JOINED, 409);
    }
    if (session.status === 'rejected') {
      return c.json({ session: session.id, status: 'rejected', reason: session.reason });
    }
    return c.json({ session: session.id, status: 'pending', ...pendingView(session) });
  });

  // ---- POST /v1/reconnect ----
  app.post('/v1/reconnect', async (c) => {
    if (ctx.config.reconnect?.enabled === false) {
      return c.notFound();
    }

    const body = await c.req.json();

    const scope = requestScope(ctx, body);
    if (scope instanceof Response) return scope;
    const { agentKey: agent_key, network: requestedNetwork } = scope;

    const refused = await signatureError(ctx, agent_key, body.timestamp, body.signature, (t) => t);
    if (refused) return refused;

    // Verify agent has joined -- linker/gateway URLs are service-wide, not
    // per-network, so any ready session for this agent satisfies reconnect.
    const session = await ctx.sessionStore.findAnyByAgentKey(agent_key);
    if (!session || session.status !== 'ready') {
      return errorJson(
        'agent_not_joined',
        'This agent key has not completed joining',
        403,
      );
    }

    // Revocation check: if hc-auth is configured, verify agent is not blocked
    if (ctx.hcAuthClient) {
      const rawKey = agentKeyToRawEd25519Base64url(agent_key);
      try {
        const record = await ctx.hcAuthClient.getRecord(rawKey);
        if (record?.state === 'blocked') {
          return errorJson('agent_revoked', 'Agent has been blocked by administrator', 403);
        }
      } catch (err) {
        if (ctx.config.hc_auth?.required) {
          return errorJson('service_unavailable', 'Auth service check failed', 503);
        }
        console.error('[hc-auth] reconnect revocation check failed (non-fatal):', err);
      }
    }

    // Network-scoped session-token lookup -- separate from the joined-at-all
    // gate above. That gate is intentionally network-agnostic (URLs are
    // service-wide), but the session token to hand back is per-network, so
    // which session comes back depends on which network was requested.
    const scopedSession = await ctx.sessionStore.findByAgentKey(agent_key, requestedNetwork);
    let sessionToken: string | undefined;
    if (scopedSession?.status === 'ready') {
      sessionToken = scopedSession.id;
    } else if (requestedNetwork !== undefined) {
      // A distinct (non-static) network was named and the agent has no
      // ready session there -- point the caller at /v1/join for that
      // network rather than silently returning URLs with no session to
      // provision.
      return errorJson(
        'agent_not_joined',
        `This agent key has not joined network "${requestedNetwork}"`,
        403,
      );
    }
    // requestedNetwork === undefined (network omitted, or explicitly named
    // the static network): a static-scope miss is not an error here -- omit
    // `session` and still return URLs, preserving reconnect's original
    // contract for agents whose only session names a non-static network.

    // Re-register agent with linkers (idempotent — handles linker restarts)
    try {
      await notifyLinkers(ctx, agent_key);
    } catch (err) {
      console.error('[reconnect] linker re-registration failed:', err);
      // Non-fatal: still return URLs so client can attempt WS auth
    }

    const [registrations, httpGateways] = await Promise.all([
      ctx.urlProvider.getLinkerRegistrations(),
      ctx.urlProvider.getHttpGateways(),
    ]);
    const linkerUrls = toLinkerUrls(registrations);

    const resp: ReconnectResponse = {
      linker_urls: linkerUrls,
      http_gateways: httpGateways,
    };
    if (sessionToken !== undefined) {
      resp.session = sessionToken;
    }

    return c.json(resp);
  });

  return app;
}

function stripInternal(challenge: Challenge): Challenge {
  const { metadata, ...rest } = challenge;
  // Strip server-side fields from metadata before sending to client
  if (metadata) {
    const { expected_code: _, agent_key: __, raw_key: ___, ...safeMetadata } = metadata as Record<
      string,
      unknown
    >;
    if (Object.keys(safeMetadata).length > 0) {
      return { ...rest, metadata: safeMetadata };
    }
  }
  return rest;
}
