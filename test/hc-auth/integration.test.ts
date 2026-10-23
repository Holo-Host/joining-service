import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestApp, fakeAgentKey } from '../helpers.js';
import { HcAuthClient } from '../../src/hc-auth/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('hc-auth integration — open auth (immediate ready)', () => {
  it('calls registerAndAuthorize when open auth makes status ready on join', async () => {
    const client = new HcAuthClient({
      url: 'https://auth.example.com',
      api_token: 'tok',
    });
    const spy = vi.spyOn(client, 'registerAndAuthorize').mockResolvedValue();

    const { request } = await createTestApp({}, undefined, undefined, client);
    const agentKey = fakeAgentKey();

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe('ready');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toMatchObject({ happ_id: 'test-app' });
  });

  it('still returns ready when hcAuthClient fails and required=false', async () => {
    const client = new HcAuthClient({
      url: 'https://auth.example.com',
      api_token: 'tok',
      required: false,
    });
    vi.spyOn(client, 'registerAndAuthorize').mockRejectedValue(
      new Error('hc-auth down'),
    );

    const { request } = await createTestApp({}, undefined, undefined, client);

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe('ready');
  });

  // Issue #15: a downstream hc-auth failure must be distinguishable from a
  // rejection of the caller's own credentials. Previously both surfaced as a
  // bare `Internal Server Error` body with no code to key off.
  it('reports a failed hc-auth registration as 503 service_unavailable, not a bare 500', async () => {
    const client = new HcAuthClient({
      url: 'https://auth.example.com',
      api_token: 'tok',
      required: true,
    });
    vi.spyOn(client, 'registerAndAuthorize').mockRejectedValue(
      new Error('hc-auth down'),
    );

    const { request } = await createTestApp(
      { hc_auth: { url: 'https://auth.example.com', api_token: 'tok', required: true } },
      undefined,
      undefined,
      client,
    );

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('service_unavailable');
  });

  it('keeps the invite code of a join that fails at a required hc-auth step', async () => {
    const HC = { url: 'https://auth.example.com', api_token: 'tok', required: true };
    const client = new HcAuthClient(HC);
    vi.spyOn(client, 'registerAndAuthorize').mockRejectedValueOnce(new Error('hc-auth down')).mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request } = await createTestApp(
      { auth_methods: ['invite_code'], invite_codes: ['GOOD'], hc_auth: HC },
      undefined,
      undefined,
      client,
    );
    const join = () => request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(44), claims: { invite_code: 'GOOD' } }),
    });

    expect((await join()).status).toBe(503);
    expect((await join()).status).toBe(201);
  });

  it('returns a structured JSON error, not plain text, for an unexpected throw', async () => {
    const client = new HcAuthClient({
      url: 'https://auth.example.com',
      api_token: 'tok',
      required: true,
    });
    vi.spyOn(client, 'registerAndAuthorize').mockRejectedValue(
      new Error('hc-auth down'),
    );

    const { request } = await createTestApp(
      { hc_auth: { url: 'https://auth.example.com', api_token: 'tok', required: true } },
      undefined,
      undefined,
      client,
    );

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });

    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.error.code).toBeTypeOf('string');
    expect(body.error.message).toBeTypeOf('string');
  });

  it('does not call registerAndAuthorize when hcAuthClient is not configured', async () => {
    // No hcAuthClient passed — default createTestApp has none
    const { request } = await createTestApp();

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });

    expect(res.status).toBe(201);
    // No errors — nothing to assert on the client since it's not configured
  });
});

describe('hc-auth integration — email_code auth (ready on verify)', () => {
  it('calls registerAndAuthorize when final verify makes status ready', async () => {
    const client = new HcAuthClient({
      url: 'https://auth.example.com',
      api_token: 'tok',
    });
    const spy = vi.spyOn(client, 'registerAndAuthorize').mockResolvedValue();

    const { request, ctx } = await createTestApp(
      {
        auth_methods: ['email_code'],
        email: { provider: 'file', output_dir: '/tmp/test-emails' },
      },
      undefined,
      undefined,
      client,
    );

    const agentKey = fakeAgentKey(42);

    // Initiate join
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, claims: { email: 'a@b.com' } }),
    });
    expect(joinRes.status).toBe(201);
    const { session, challenges } = await joinRes.json();
    expect(spy).not.toHaveBeenCalled(); // not yet ready

    // Extract expected code from session store (server-side only)
    const sessionData = await ctx.sessionStore.get(session);
    const expectedCode = sessionData!.challenges[0].expected_response;

    // Verify the challenge
    const verifyRes = await request(`/v1/join/${session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: challenges[0].id, response: expectedCode }),
    });
    expect(verifyRes.status).toBe(200);
    expect((await verifyRes.json()).status).toBe('ready');

    expect(spy).toHaveBeenCalledOnce();
  });

  it('keeps the session pending when a required hc-auth step fails on the final verify, which the same verify or a status poll retries', async () => {
    const HC = { url: 'https://auth.example.com', api_token: 'tok', required: true };
    const client = new HcAuthClient(HC);
    const spy = vi.spyOn(client, 'registerAndAuthorize').mockRejectedValue(new Error('hc-auth down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request, ctx } = await createTestApp(
      { auth_methods: ['email_code'], email: { provider: 'file', output_dir: '/tmp/test-emails' }, hc_auth: HC },
      undefined,
      undefined,
      client,
    );
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(43), claims: { email: 'a@b.com' } }),
    });
    const { session, challenges } = await joinRes.json();
    const expectedCode = (await ctx.sessionStore.get(session))!.challenges[0].expected_response;

    const verify = () => request(`/v1/join/${session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: challenges[0].id, response: expectedCode }),
    });
    expect((await verify()).status).toBe(503);
    expect((await ctx.sessionStore.get(session))!.status).toBe('pending');
    expect((await request(`/v1/join/${session}/status`)).status).toBe(503);

    spy.mockResolvedValue();
    expect(await (await verify()).json()).toEqual({ status: 'ready' });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('passes forwarded claims as verified, not only inside metadata', async () => {
    const client = new HcAuthClient({
      url: 'https://auth.example.com',
      api_token: 'tok',
      forward_claims: ['email'],
    });
    const spy = vi.spyOn(client, 'registerAndAuthorize').mockResolvedValue();

    const { request, ctx } = await createTestApp(
      {
        auth_methods: ['email_code'],
        email: { provider: 'file', output_dir: '/tmp/test-emails' },
        hc_auth: { url: 'https://auth.example.com', api_token: 'tok', forward_claims: ['email'] },
      },
      undefined,
      undefined,
      client,
    );

    const agentKey = fakeAgentKey(43);
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, claims: { email: 'ada@example.com' } }),
    });
    expect(joinRes.status).toBe(201);
    const { session, challenges } = await joinRes.json();
    const sessionData = await ctx.sessionStore.get(session);
    const expectedCode = sessionData!.challenges[0].expected_response;

    const verifyRes = await request(`/v1/join/${session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: challenges[0].id, response: expectedCode }),
    });
    expect(verifyRes.status).toBe(200);

    expect(spy).toHaveBeenCalledOnce();
    const [, metadata, verified] = spy.mock.calls[0];
    expect(metadata).toMatchObject({ email: 'ada@example.com' });
    expect(verified).toEqual({ email: 'ada@example.com' });
  });

  it('passes an empty verified object when no forwarded claim is present', async () => {
    const client = new HcAuthClient({ url: 'https://auth.example.com', api_token: 'tok' });
    const spy = vi.spyOn(client, 'registerAndAuthorize').mockResolvedValue();
    const { request } = await createTestApp({}, undefined, undefined, client);
    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][2]).toEqual({});
  });
});

describe('hc-auth integration — hc_auth_approval still writes verified', () => {
  const HC = { url: 'https://auth.example.com', api_token: 'tok', forward_claims: ['email'] };

  it('email_code + hc_auth_approval: setVerified on ready via status poll, no registerAndAuthorize', async () => {
    const client = new HcAuthClient(HC);
    const getRecord = vi.spyOn(client, 'getRecord').mockResolvedValueOnce(null);
    vi.spyOn(client, 'requestAuth').mockResolvedValue();
    const raa = vi.spyOn(client, 'registerAndAuthorize').mockResolvedValue();
    const setVerified = vi.spyOn(client, 'setVerified').mockResolvedValue();

    const { request, ctx } = await createTestApp(
      {
        auth_methods: ['email_code', 'hc_auth_approval'],
        email: { provider: 'file', output_dir: '/tmp/test-emails' },
        hc_auth: HC,
      },
      undefined,
      undefined,
      client,
    );

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(91), claims: { email: 'ada@example.com' } }),
    });
    const joinBody = await joinRes.json();
    expect(joinBody.status).toBe('pending');

    const sessionData = await ctx.sessionStore.get(joinBody.session);
    const emailState = sessionData!.challenges.find((cs) => cs.challenge.type === 'email_code')!;
    const emailChallenge = joinBody.challenges.find((c: { type: string }) => c.type === 'email_code');
    const verifyRes = await request(`/v1/join/${joinBody.session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: emailChallenge.id, response: emailState.expected_response }),
    });
    expect((await verifyRes.json()).status).toBe('pending');
    expect(setVerified).not.toHaveBeenCalled();

    getRecord.mockResolvedValueOnce({ state: 'authorized', pubKey: 'k' });
    const statusRes = await request(`/v1/join/${joinBody.session}/status`);
    expect((await statusRes.json()).status).toBe('ready');

    expect(raa).not.toHaveBeenCalled();
    expect(setVerified).toHaveBeenCalledOnce();
    expect(setVerified.mock.calls[0][1]).toEqual({ email: 'ada@example.com' });
  });

  it('already authorized in hc-auth → immediate ready at join still writes verified', async () => {
    const client = new HcAuthClient(HC);
    vi.spyOn(client, 'getRecord').mockResolvedValue({ state: 'authorized', pubKey: 'k' });
    const raa = vi.spyOn(client, 'registerAndAuthorize').mockResolvedValue();
    const setVerified = vi.spyOn(client, 'setVerified').mockResolvedValue();

    const { request } = await createTestApp(
      { auth_methods: ['hc_auth_approval'], hc_auth: HC },
      undefined,
      undefined,
      client,
    );
    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(92), claims: { email: 'ada@example.com' } }),
    });
    expect((await res.json()).status).toBe('ready');
    // No hc_auth_approval challenge is created when the key is already
    // authorized, so this path goes through registerAndAuthorize, which
    // no-ops on state and writes verified via its third argument.
    expect(raa).toHaveBeenCalledOnce();
    expect(raa.mock.calls[0][2]).toEqual({ email: 'ada@example.com' });
    expect(setVerified).not.toHaveBeenCalled();
  });

  it('status poll: a failed verified write with required=true leaves the session pending', async () => {
    const client = new HcAuthClient({ ...HC, required: true });
    const getRecord = vi.spyOn(client, 'getRecord').mockResolvedValueOnce(null);
    vi.spyOn(client, 'requestAuth').mockResolvedValue();
    vi.spyOn(client, 'setVerified').mockRejectedValue(new Error('hc-auth PUT /api/verified returned 500'));

    const { request, ctx } = await createTestApp(
      { auth_methods: ['hc_auth_approval'], hc_auth: { ...HC, required: true } },
      undefined,
      undefined,
      client,
    );
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(93), claims: { email: 'ada@example.com' } }),
    });
    const joinBody = await joinRes.json();
    expect(joinBody.status).toBe('pending');

    getRecord.mockResolvedValueOnce({ state: 'authorized', pubKey: 'k' });
    const statusRes = await request(`/v1/join/${joinBody.session}/status`);
    expect(statusRes.status).toBe(503);
    expect((await ctx.sessionStore.get(joinBody.session))!.status).toBe('pending');
  });
});
