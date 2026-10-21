import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestApp, postJson, signingAgent } from './helpers.js';
import { HcAuthClient } from '../src/hc-auth/client.js';
import type { SessionData } from '../src/session/store.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

const EMAIL_CONFIG = {
  auth_methods: ['email_code' as const],
  email: { provider: 'file' as const, output_dir: '/tmp/test-emails' },
};

describe('signed POST /v1/join', () => {
  it('accepts a join signed by the agent key, and refuses a bad signature or a stale timestamp before it reads or changes any session', async () => {
    const { request, ctx } = await createTestApp(EMAIL_CONFIG);
    const agent = await signingAgent();
    const other = await signingAgent();
    const first = await postJson(request, '/v1/join', { agent_key: agent.agentKey, claims: { email: 'a@b.com' }, ...(await agent.sign()) });
    expect(first.status).toBe(201);
    const { session } = await first.json();
    const before = await ctx.sessionStore.get(session);
    const lookups = vi.spyOn(ctx.sessionStore, 'findByAgentKey');

    const forged = await postJson(request, '/v1/join', {
      agent_key: agent.agentKey,
      claims: { email: 'a@b.com' },
      ...(await other.sign()),
    });
    expect(forged.status).toBe(400);
    expect((await forged.json()).error.code).toBe('invalid_signature');

    const stale = await postJson(request, '/v1/join', {
      agent_key: agent.agentKey,
      claims: { email: 'a@b.com' },
      ...(await agent.sign(new Date(Date.now() - 600_000).toISOString())),
    });
    expect(stale.status).toBe(400);
    expect((await stale.json()).error.code).toBe('timestamp_out_of_range');

    const half = await postJson(request, '/v1/join', { agent_key: agent.agentKey, timestamp: new Date().toISOString() });
    expect((await half.json()).error.code).toBe('invalid_signature');

    const signedNow = await agent.sign();
    for (const pair of [
      { timestamp: signedNow.timestamp, signature: 7 },
      { timestamp: Date.now(), signature: signedNow.signature },
    ]) {
      const untyped = await postJson(request, '/v1/join', { agent_key: agent.agentKey, ...pair });
      expect(untyped.status).toBe(400);
      expect((await untyped.json()).error.code).toBe('invalid_signature');
    }

    expect(lookups).not.toHaveBeenCalled();
    expect(await ctx.sessionStore.get(session)).toEqual(before);
  });
});

describe('POST /v1/join/resume', () => {
  async function resume(request: Parameters<typeof postJson>[0], agent: Awaited<ReturnType<typeof signingAgent>>, extra: Record<string, unknown> = {}) {
    return postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign()), ...extra });
  }

  it('refuses a bad signature before any lookup', async () => {
    const { request, ctx } = await createTestApp(EMAIL_CONFIG);
    const agent = await signingAgent();
    const other = await signingAgent();
    const lookups = vi.spyOn(ctx.sessionStore, 'findByAgentKey');

    const res = await postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await other.sign()) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_signature');

    const unsigned = await postJson(request, '/v1/join/resume', { agent_key: agent.agentKey });
    expect((await unsigned.json()).error.code).toBe('invalid_signature');

    for (const body of ['{"agent_key":', '42']) {
      const malformed = await request('/v1/join/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe('invalid_json');
    }
    expect(lookups).not.toHaveBeenCalled();
  });

  it('refuses a bad agent key and a malformed network', async () => {
    const { request } = await createTestApp(EMAIL_CONFIG);
    const agent = await signingAgent();

    const badKey = await postJson(request, '/v1/join/resume', { agent_key: 'uhCAknotakey', ...(await agent.sign()) });
    expect((await badKey.json()).error.code).toBe('invalid_agent_key');

    const network = await resume(request, agent, { network: 42 });
    expect(network.status).toBe(400);
    expect((await network.json()).error.code).toBe('unknown_network');
  });

  it('answers 404 join_not_found when the agent has no session', async () => {
    const { request } = await createTestApp(EMAIL_CONFIG);
    const res = await resume(request, await signingAgent());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('join_not_found');
  });

  it('returns a pending session and its token, listed as status lists it', async () => {
    const { request } = await createTestApp(EMAIL_CONFIG);
    const agent = await signingAgent();
    const join = await postJson(request, '/v1/join', { agent_key: agent.agentKey, claims: { email: 'a@b.com' } });
    const { session } = await join.json();

    const res = await resume(request, agent, { network: 'test-app' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBe(session);
    expect(body.status).toBe('pending');
    expect(body.poll_interval_ms).toBe(2000);
    expect(body.challenges).toHaveLength(1);
    expect(body.challenges[0]).toMatchObject({ type: 'email_code', completed: false });
    expect(body.challenges[0].metadata).toBeUndefined();

    const status = await (await request(`/v1/join/${session}/status`)).json();
    expect(body.challenges).toEqual(status.challenges);
  });

  it('returns a rejected session with its reason', async () => {
    const { request, ctx } = await createTestApp(EMAIL_CONFIG);
    const agent = await signingAgent();
    await ctx.sessionStore.create(stored(agent.agentKey, { status: 'rejected', reason: 'Too late' }));

    const res = await resume(request, agent);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: 'js_stored', status: 'rejected', reason: 'Too late' });
  });

  it('answers 409 agent_already_joined for a ready session', async () => {
    const { request } = await createTestApp();
    const agent = await signingAgent();
    await postJson(request, '/v1/join', { agent_key: agent.agentKey });
    const res = await resume(request, agent);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('agent_already_joined');
  });

  it('makes ready a pending session with every requirement met, then answers 409', async () => {
    const HC = { url: 'https://auth.example.com', api_token: 'tok', required: true, forward_claims: ['email'] };
    const client = new HcAuthClient(HC);
    const register = vi.spyOn(client, 'registerAndAuthorize').mockRejectedValueOnce(new Error('hc-auth down'));
    const { request, ctx } = await createTestApp({ ...EMAIL_CONFIG, hc_auth: HC }, undefined, undefined, client);
    const agent = await signingAgent();
    await ctx.sessionStore.create(stored(agent.agentKey, { completed: true }));

    const failed = await resume(request, agent);
    expect(failed.status).toBe(503);
    expect((await ctx.sessionStore.get('js_stored'))!.status).toBe('pending');

    register.mockResolvedValue();
    const res = await resume(request, agent);
    expect(res.status).toBe(409);
    expect((await ctx.sessionStore.get('js_stored'))!.status).toBe('ready');
    expect(register).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ email: 'a@b.com' }));
  });
});

function stored(
  agentKey: string,
  opts: { status?: SessionData['status']; reason?: string; completed?: boolean } = {},
): SessionData {
  return {
    id: 'js_stored',
    agent_key: agentKey,
    status: opts.status ?? 'pending',
    reason: opts.reason,
    challenges: [
      {
        challenge: { id: 'ch_email_1', type: 'email_code', description: 'Enter the code' },
        expected_response: '123456',
        completed: opts.completed ?? false,
        attempts: 0,
        expires_at: Date.now() + 600_000,
      },
    ],
    claims: { email: 'a@b.com' },
    created_at: Date.now(),
  };
}
