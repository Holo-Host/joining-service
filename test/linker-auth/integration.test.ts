import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { createTestApp, fakeAgentKey } from '../helpers.js';
import type { UrlProvider } from '../../src/urls/provider.js';
import type { LinkerRegistration } from '../../src/linker-auth/types.js';

function mockFetchOk(): MockInstance {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return {
      ok: true,
      status: 204,
      text: async () => '',
      json: async () => ({}),
    } as Response;
  });
}

function mockFetchFail(): MockInstance {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return {
      ok: false,
      status: 500,
      text: async () => 'internal error',
      json: async () => ({ error: 'internal error' }),
    } as Response;
  });
}

const TEST_REGISTRATIONS: LinkerRegistration[] = [
  {
    linker_url: { url: 'wss://l1.example.com:8090' },
    admin: { url: 'https://l1.example.com', secret: 'secret-1' },
  },
  {
    linker_url: { url: 'wss://l2.example.com:8090' },
    admin: { url: 'https://l2.example.com', secret: 'secret-2' },
  },
];

function mockUrlProvider(registrations?: LinkerRegistration[]): UrlProvider {
  return {
    async getLinkerRegistrations() {
      return registrations ?? TEST_REGISTRATIONS;
    },
    async getHttpGateways() {
      return undefined;
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('linker-auth integration — open auth (immediate ready)', () => {
  it('calls POST /admin/agents on each linker when open auth makes status ready', async () => {
    const spy = mockFetchOk();
    const { request } = await createTestApp(
      { linker_auth: { capabilities: ['dht_read', 'dht_write', 'k2'] } },
      undefined,
      mockUrlProvider(),
    );

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe('ready');
    // Called once per linker registration
    expect(spy).toHaveBeenCalledTimes(2);

    // Verify each call targets the correct admin URL
    const urls = spy.mock.calls.map((c) => (c as [string, RequestInit])[0]);
    expect(urls).toContain('https://l1.example.com/admin/agents');
    expect(urls).toContain('https://l2.example.com/admin/agents');
  });

  it('still returns ready when linker auth fails and required=false', async () => {
    mockFetchFail();
    const { request } = await createTestApp(
      { linker_auth: { capabilities: ['dht_read'], required: false } },
      undefined,
      mockUrlProvider(),
    );

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe('ready');
  });

  it('returns 503 when linker auth fails and required=true', async () => {
    mockFetchFail();
    const { request } = await createTestApp(
      { linker_auth: { capabilities: ['dht_read'], required: true } },
      undefined,
      mockUrlProvider(),
    );

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });

    expect(res.status).toBe(503);
  });

  it('does not call linker auth when linker_auth config is absent', async () => {
    const spy = mockFetchOk();
    const { request } = await createTestApp(
      {},
      undefined,
      mockUrlProvider(),
    );

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });

    expect(res.status).toBe(201);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not call linker auth when no registrations are available', async () => {
    const spy = mockFetchOk();
    const emptyProvider: UrlProvider = {
      async getLinkerRegistrations() { return undefined; },
      async getHttpGateways() { return undefined; },
    };

    const { request } = await createTestApp(
      { linker_auth: { capabilities: ['dht_read'] } },
      undefined,
      emptyProvider,
    );

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });

    expect(res.status).toBe(201);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('linker-auth integration — email_code auth (ready on verify)', () => {
  it('calls linker auth when final verify makes status ready', async () => {
    const spy = mockFetchOk();
    const { request, ctx } = await createTestApp(
      {
        auth_methods: ['email_code'],
        email: { provider: 'file', output_dir: '/tmp/test-emails' },
        linker_auth: { capabilities: ['dht_read', 'k2'] },
      },
      undefined,
      mockUrlProvider(),
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

    // Extract expected code from session store
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

    // Both linkers should have been called
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
