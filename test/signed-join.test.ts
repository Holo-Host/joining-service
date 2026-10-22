import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestApp, joinMessage, postJson, resumeMessage, signingAgent } from './helpers.js';
import { HcAuthClient } from '../src/hc-auth/client.js';
import type { SessionData } from '../src/session/store.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

type Agent = Awaited<ReturnType<typeof signingAgent>>;

const EMAIL_CONFIG = {
  auth_methods: ['email_code' as const],
  email: { provider: 'file' as const, output_dir: '/tmp/test-emails' },
};

describe('signed POST /v1/join', () => {
  it('accepts a join signed by the agent key, and refuses a bad signature or timestamp before it reads or changes any session', async () => {
    const { request, ctx } = await createTestApp(EMAIL_CONFIG);
    const agent = await signingAgent();
    const other = await signingAgent();
    const join = (signed: object) => postJson(request, '/v1/join', { agent_key: agent.agentKey, claims: { email: 'a@b.com' }, ...signed });
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const first = await join(await agent.sign(joinMessage('a@b.com'), at(25_000)));
    expect(first.status).toBe(201);
    const { session } = await first.json();
    const before = await ctx.sessionStore.get(session);
    const lookups = vi.spyOn(ctx.sessionStore, 'findByAgentKey');

    for (const [signed, code] of [
      [await other.sign(joinMessage('a@b.com')), 'invalid_signature'],
      [await agent.sign(), 'invalid_signature'],
      [await agent.sign(joinMessage('A@b.com')), 'invalid_signature'],
      [await agent.sign(resumeMessage), 'invalid_signature'],
      [await agent.sign(joinMessage('a@b.com'), at(-600_000)), 'timestamp_out_of_range'],
      [await agent.sign(joinMessage('a@b.com'), at(31_000)), 'timestamp_out_of_range'],
    ] as const) {
      const refused = await join(signed);
      expect(refused.status).toBe(400);
      expect((await refused.json()).error.code).toBe(code);
    }

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
  async function resume(request: Parameters<typeof postJson>[0], agent: Agent, extra: Record<string, unknown> = {}) {
    return postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign(resumeMessage)), ...extra });
  }

  it.each<[string, string, (agent: Agent, other: Agent) => Promise<string>]>([
    ['a signature by another key', 'invalid_signature', async (agent, other) => JSON.stringify({ agent_key: agent.agentKey, ...(await other.sign(resumeMessage)) })],
    ['a signature of the bare timestamp', 'invalid_signature', async (agent) => JSON.stringify({ agent_key: agent.agentKey, ...(await agent.sign()) })],
    ['no signature', 'invalid_signature', async (agent) => JSON.stringify({ agent_key: agent.agentKey })],
    ['a cut-off body', 'invalid_json', async () => '{"agent_key":'],
    ['a body that is not an object', 'invalid_json', async () => '42'],
    ['a bad agent key', 'invalid_agent_key', async (agent) => JSON.stringify({ agent_key: 'uhCAknotakey', ...(await agent.sign()) })],
    ['a malformed network', 'unknown_network', async (agent) => JSON.stringify({ agent_key: agent.agentKey, ...(await agent.sign()), network: 42 })],
  ])('refuses %s with %s before any lookup', async (_name, code, body) => {
    const { request, ctx } = await createTestApp(EMAIL_CONFIG);
    const lookups = vi.spyOn(ctx.sessionStore, 'findByAgentKey');
    const res = await request('/v1/join/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await body(await signingAgent(), await signingAgent()),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(code);
    expect(lookups).not.toHaveBeenCalled();
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
