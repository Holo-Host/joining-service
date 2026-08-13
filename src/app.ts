import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ServiceConfig } from './config.js';
import type { AuthMethodPlugin } from './auth-methods/plugin.js';
import type { SessionStore, ChallengeState } from './session/store.js';
import type { MembraneProofGenerator } from './membrane-proof/generator.js';
import type { UrlProvider } from './urls/provider.js';
import type { AuthMethodEntry, AuthMethodGroup, Challenge, LinkerUrl } from './types.js';
import type { LinkerRegistration } from './linker-auth/types.js';
import {
  generateSessionId,
  validateAgentKey,
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

export interface ServiceContext {
  config: ServiceConfig;
  sessionStore: SessionStore;
  authPlugins: Map<string, AuthMethodPlugin>;
  proofGenerator?: MembraneProofGenerator;
  urlProvider: UrlProvider;
  hcAuthClient?: HcAuthClient;
  linkerRegistrationStore?: LinkerRegistrationStore;
  allowedAgentStore?: AllowedAgentStore;
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
    if (ctx.config.hc_auth?.required) throw err;
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

/**
 * Shared helper: create a session in 'ready' state, notifying hc-auth and linkers.
 * Used by both the delegated verification fast path and the normal auth completion path.
 */
async function createReadySession(
  ctx: ServiceContext,
  sessionId: string,
  agentKey: string,
  claims: Record<string, string>,
  challenges: ChallengeState[],
  options?: { skipHcAuth?: boolean },
): Promise<void> {
  if (!options?.skipHcAuth) {
    await notifyHcAuth(ctx, agentKey, claims);
  }
  await notifyLinkers(ctx, agentKey);

  await ctx.sessionStore.create({
    id: sessionId,
    agent_key: agentKey,
    status: 'ready',
    challenges,
    claims,
    created_at: Date.now(),
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

import type { NetworkConfig } from './types.js';

/** Build a NetworkConfig from service config. Returns undefined if no URLs are available. */
function buildNetworkConfig(config: ServiceConfig): NetworkConfig | undefined {
  const nc: NetworkConfig = {};
  if (config.hc_auth?.url) nc.auth_server_url = config.hc_auth.url;
  if (config.network?.bootstrap_url) nc.bootstrap_url = config.network.bootstrap_url;
  if (config.network?.relay_url) nc.relay_url = config.network.relay_url;
  return Object.keys(nc).length > 0 ? nc : undefined;
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

export function createApp(ctx: ServiceContext): Hono {
  const app = new Hono();

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
    const { config } = ctx;
    const registrations = await ctx.urlProvider.getLinkerRegistrations();
    const linkerUrls = toLinkerUrls(registrations);
    const httpGateways = await ctx.urlProvider.getHttpGateways();
    return c.json({
      happ: {
        id: config.happ.id,
        name: config.happ.name,
        description: config.happ.description,
        icon_url: config.happ.icon_url,
      },
      http_gateways: httpGateways,
      auth_methods: config.auth_methods,
      linker_info: linkerUrls
        ? (config.linker_info ?? { selection_mode: 'assigned' })
        : undefined,
      happ_bundle_url: config.happ.happ_bundle_url,
      dna_modifiers: config.dna_modifiers,
      network_config: config.network?.reveal_in_info
        ? buildNetworkConfig(config)
        : undefined,
    });
  });

  // ---- POST /v1/join ----
  app.post('/v1/join', async (c) => {
    const body = await c.req.json();
    const { agent_key, claims = {} } = body;

    if (!agent_key) {
      return errorJson('invalid_agent_key', 'agent_key is required', 400);
    }

    const validation = validateAgentKey(agent_key);
    if (!validation.valid) {
      return errorJson('invalid_agent_key', validation.reason!, 400);
    }

    // Check if agent already joined
    const existing = await ctx.sessionStore.findByAgentKey(agent_key);
    if (existing?.status === 'ready') {
      return errorJson(
        'agent_already_joined',
        'This agent key has already completed joining. Use POST /v1/reconnect instead.',
        409,
      );
    }

    // Delete any stale pending session for this agent
    if (existing) {
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
      await createReadySession(ctx, sessionId, agent_key, claims, []);

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

        for (const method of entry.any_of) {
          const plugin = ctx.authPlugins.get(method);
          if (!plugin) continue;

          try {
            const challenges = await plugin.createChallenges(
              agent_key,
              claims,
              ctx.config,
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
              });
              groupHasChallenges = true;
            }
          } catch {
            // In an OR group, individual methods may fail (e.g. missing claims).
            // That's fine as long as at least one method in the group succeeds.
          }
        }

        // If no method in the OR group produced challenges, the group is unsatisfiable
        if (!groupHasChallenges) {
          return c.json(
            {
              session: sessionId,
              status: 'rejected' as const,
              reason: 'No eligible auth method in group',
            },
            201,
          );
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
          );
          if (challenges.length === 0 && entry !== 'open' && entry !== 'hc_auth_approval') {
            // Non-open/non-hc_auth_approval method produced no challenges -- agent is not eligible
            return c.json(
              {
                session: sessionId,
                status: 'rejected' as const,
                reason: 'Agent is not eligible for this auth method',
              },
              201,
            );
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
            });
          }
        } catch (e: unknown) {
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
              return c.json(
                {
                  session: sessionId,
                  status: 'rejected' as const,
                  reason: result.reason ?? 'Invalid invite code',
                },
                201,
              );
            }
            cs.completed = true;
          }
        }
      }
    }

    const finalStatus = allSatisfied(allChallenges) ? 'ready' : status;

    if (finalStatus === 'ready') {
      await createReadySession(ctx, sessionId, agent_key, claims, allChallenges, {
        skipHcAuth: usedHcAuthApproval(allChallenges),
      });
    } else {
      await ctx.sessionStore.create({
        id: sessionId,
        agent_key,
        status: finalStatus,
        challenges: allChallenges,
        claims,
        created_at: Date.now(),
      });
    }

    const response: Record<string, unknown> = {
      session: sessionId,
      status: finalStatus,
    };

    if (finalStatus === 'pending') {
      response.challenges = allChallenges
        .filter((cs) => !cs.completed)
        .map((cs) => stripInternal(cs.challenge));
      response.poll_interval_ms = 2000;
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

    const newStatus = allSatisfied(session.challenges) ? 'ready' : 'pending';

    await ctx.sessionStore.update(sessionId, {
      status: newStatus,
      challenges: session.challenges,
    });

    if (newStatus === 'ready') {
      if (!usedHcAuthApproval(session.challenges)) {
        await notifyHcAuth(ctx, session.agent_key, session.claims);
      }
      await notifyLinkers(ctx, session.agent_key);
    }

    const resp: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'pending') {
      resp.challenges_remaining = session.challenges
        .filter((cs) => !cs.completed)
        .map((cs) => stripInternal(cs.challenge));
      resp.poll_interval_ms = 2000;
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
          // hc-auth already authorized; only notify linkers
          await notifyLinkers(ctx, session.agent_key);
        }
        await ctx.sessionStore.update(sessionId, {
          status: newStatus,
          challenges: session.challenges,
        });
        session.status = newStatus;
      }
    }

    const resp: Record<string, unknown> = { status: session.status };

    if (session.status === 'pending') {
      resp.challenges = session.challenges.map((cs) => ({
        ...stripInternal(cs.challenge),
        completed: cs.completed,
      }));
      resp.poll_interval_ms = 2000;
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

    const linkerUrls = toLinkerUrls(await ctx.urlProvider.getLinkerRegistrations());

    let membraneProofs: Record<string, string> | undefined;
    const dnaHashesCfg = ctx.config.dna_hashes;
    if (ctx.proofGenerator && dnaHashesCfg) {
      // Normalise: role-keyed Record or flat array
      const isRoleKeyed = !Array.isArray(dnaHashesCfg);
      const hashList = isRoleKeyed ? Object.values(dnaHashesCfg) : dnaHashesCfg;
      if (hashList.length > 0) {
        const rawProofs = await ctx.proofGenerator.generate(
          session.agent_key,
          hashList,
        );
        membraneProofs = {};
        if (isRoleKeyed) {
          // Key proofs by role name
          for (const [role, hash] of Object.entries(dnaHashesCfg)) {
            if (rawProofs[hash]) {
              membraneProofs[role] = toBase64(rawProofs[hash]);
            }
          }
        } else {
          for (const [hash, proof] of Object.entries(rawProofs)) {
            membraneProofs[hash] = toBase64(proof);
          }
        }
      }
    }

    // Build network_config from config.network + hc_auth.url
    const networkConfig = buildNetworkConfig(ctx.config);

    return c.json({
      linker_urls: linkerUrls,
      membrane_proofs: membraneProofs,
      happ_bundle_url: ctx.config.happ.happ_bundle_url,
      dna_modifiers: ctx.config.dna_modifiers,
      network_config: networkConfig,
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

  // ---- POST /v1/reconnect ----
  app.post('/v1/reconnect', async (c) => {
    if (ctx.config.reconnect?.enabled === false) {
      return c.notFound();
    }

    const body = await c.req.json();
    const { agent_key, timestamp, signature } = body;

    if (!agent_key) {
      return errorJson('invalid_agent_key', 'agent_key is required', 400);
    }

    const validation = validateAgentKey(agent_key);
    if (!validation.valid) {
      return errorJson('invalid_agent_key', validation.reason!, 400);
    }

    if (!timestamp || !signature) {
      return errorJson(
        'invalid_signature',
        'timestamp and signature are required',
        400,
      );
    }

    // Validate timestamp is within tolerance
    const toleranceSeconds =
      ctx.config.reconnect?.timestamp_tolerance_seconds ?? 300;
    const tsDate = new Date(timestamp);
    if (isNaN(tsDate.getTime())) {
      return errorJson(
        'timestamp_out_of_range',
        'Invalid timestamp format',
        400,
      );
    }

    const drift = Math.abs(Date.now() - tsDate.getTime());
    if (drift > toleranceSeconds * 1000) {
      return errorJson(
        'timestamp_out_of_range',
        `Timestamp is ${Math.round(drift / 1000)}s from server time (max ${toleranceSeconds}s)`,
        400,
      );
    }

    // Verify agent has joined
    const session = await ctx.sessionStore.findByAgentKey(agent_key);
    if (!session || session.status !== 'ready') {
      return errorJson(
        'agent_not_joined',
        'This agent key has not completed joining',
        403,
      );
    }

    // Verify ed25519 signature of the timestamp string
    const sigBytes = fromBase64(signature);
    const msgBytes = new TextEncoder().encode(timestamp);
    // Extract the raw 32-byte ed25519 public key from the 39-byte AgentPubKey
    // (skip 3-byte HoloHash prefix, take 32 bytes, skip 4-byte DHT location)
    const agentKeyBytes = decodeHashFromBase64(agent_key);
    const publicKey = agentKeyBytes.slice(3, 35);

    let valid: boolean;
    try {
      valid = await ed.verifyAsync(sigBytes, msgBytes, publicKey);
    } catch {
      valid = false;
    }

    if (!valid) {
      return errorJson(
        'invalid_signature',
        'Signature does not verify against agent key',
        400,
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

    return c.json({
      linker_urls: linkerUrls,
      http_gateways: httpGateways,
    });
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
