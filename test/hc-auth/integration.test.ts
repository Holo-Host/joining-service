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
});
