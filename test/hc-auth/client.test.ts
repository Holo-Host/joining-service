import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { HcAuthClient } from '../../src/hc-auth/client.js';

const BASE_URL = 'https://auth.example.com';
const API_TOKEN = 'test-token';

function makeClient(required = false): HcAuthClient {
  return new HcAuthClient({ url: BASE_URL, api_token: API_TOKEN, required });
}

function mockFetch(
  responses: Array<{ status: number; body?: unknown }>,
): MockInstance {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const { status, body } = responses[call++] ?? { status: 200 };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    } as Response;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('HcAuthClient.requestAuth', () => {
  it('sends PUT /request-auth/{key} with metadata', async () => {
    const spy = mockFetch([{ status: 200 }]);
    const client = makeClient();
    await client.requestAuth('abc123', { agent: 'test' });

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/request-auth/abc123`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ agent: 'test' });
  });

  it('throws on other error status', async () => {
    mockFetch([{ status: 400, body: 'bad request' }]);
    await expect(makeClient().requestAuth('abc123', {})).rejects.toThrow('400');
  });

  // hc-auth-server's PUT /request-auth returns 200 on success (not 202), 429
  // when the pending-request limit is hit and nothing was stored, 500 when the
  // key already has a record, and 401 for an invalid pubkey. See issue #15.

  it('resolves on 200 (registered)', async () => {
    mockFetch([{ status: 200 }]);
    await expect(makeClient().requestAuth('abc123', {})).resolves.toBeUndefined();
  });

  it('throws on 429, naming the pending-request limit as the cause', async () => {
    mockFetch([{ status: 429, body: 'too many requests' }]);
    await expect(makeClient().requestAuth('abc123', {})).rejects.toThrow(
      /pending-request limit/i,
    );
  });

  it('resolves on 500 (key already has a record) so the transition can proceed', async () => {
    mockFetch([{ status: 500, body: 'storage failure: already_exists' }]);
    await expect(makeClient().requestAuth('abc123', {})).resolves.toBeUndefined();
  });

  it('resolves on 409 (already registered) once hc-auth-server maps the conflict', async () => {
    mockFetch([{ status: 409, body: 'already exists' }]);
    await expect(makeClient().requestAuth('abc123', {})).resolves.toBeUndefined();
  });

  it('throws on 401 (invalid pubkey)', async () => {
    mockFetch([{ status: 401, body: 'unauthorized' }]);
    await expect(makeClient().requestAuth('abc123', {})).rejects.toThrow('401');
  });
});

describe('HcAuthClient.transition', () => {
  it('sends POST /api/transition with camelCase fields and Bearer token', async () => {
    const spy = mockFetch([{ status: 200 }]);
    await makeClient().transition('abc123', 'pending', 'authorized');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/transition`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${API_TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      pubKey: 'abc123',
      oldState: 'pending',
      newState: 'authorized',
    });
  });

  it('throws on non-ok response', async () => {
    mockFetch([{ status: 404, body: 'not found' }]);
    await expect(
      makeClient().transition('abc123', 'pending', 'authorized'),
    ).rejects.toThrow('404');
  });
});

describe('HcAuthClient.getRecord', () => {
  it('returns null on 404', async () => {
    mockFetch([{ status: 404 }]);
    const result = await makeClient().getRecord('abc123');
    expect(result).toBeNull();
  });

  it('returns parsed record on success', async () => {
    const record = { state: 'pending', pubKey: 'abc123' };
    mockFetch([{ status: 200, body: record }]);
    const result = await makeClient().getRecord('abc123');
    expect(result).toEqual(record);
  });

  it('throws on server error', async () => {
    mockFetch([{ status: 500, body: 'error' }]);
    await expect(makeClient().getRecord('abc123')).rejects.toThrow('500');
  });
});

describe('HcAuthClient.registerAndAuthorize', () => {
  it('no-ops when already authorized', async () => {
    const spy = mockFetch([{ status: 200, body: { state: 'authorized', pubKey: 'abc123' } }]);
    await makeClient().registerAndAuthorize('abc123', {});
    // Only the getRecord call; no requestAuth or transition
    expect(spy).toHaveBeenCalledOnce();
  });

  it('transitions blocked → authorized directly', async () => {
    const spy = mockFetch([
      { status: 200, body: { state: 'blocked', pubKey: 'abc123' } }, // getRecord
      { status: 200 }, // transition blocked→authorized
    ]);
    await makeClient().registerAndAuthorize('abc123', {});
    expect(spy).toHaveBeenCalledTimes(2);
    const [, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      oldState: 'blocked',
      newState: 'authorized',
    });
  });

  it('registers then authorizes when key is not found', async () => {
    const spy = mockFetch([
      { status: 404 },    // getRecord → not found
      { status: 200 },    // requestAuth
      { status: 200 },    // transition pending→authorized
    ]);
    await makeClient().registerAndAuthorize('abc123', { happ_id: 'test' });
    expect(spy).toHaveBeenCalledTimes(3);
    const [, authInit] = spy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(authInit.body as string)).toMatchObject({ happ_id: 'test' });
  });

  it('skips requestAuth and transitions when already pending', async () => {
    const spy = mockFetch([
      { status: 200, body: { state: 'pending', pubKey: 'abc123' } }, // getRecord
      { status: 200 }, // transition pending→authorized
    ]);
    await makeClient().registerAndAuthorize('abc123', {});
    expect(spy).toHaveBeenCalledTimes(2);
    const [, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      oldState: 'pending',
      newState: 'authorized',
    });
  });

  it('writes verified claims even when the key is already authorized', async () => {
    const spy = mockFetch([
      { status: 200, body: { state: 'authorized', pubKey: 'abc123' } }, // getRecord
      { status: 200 }, // setVerified
    ]);
    await makeClient().registerAndAuthorize('abc123', {}, { email: 'ada@example.com' });
    expect(spy).toHaveBeenCalledTimes(2);
    const [url, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/verified/abc123`);
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ email: 'ada@example.com' });
  });

  it('writes verified claims after registering and authorizing a new key', async () => {
    const spy = mockFetch([
      { status: 404 }, // getRecord
      { status: 202 }, // requestAuth
      { status: 200 }, // transition
      { status: 200 }, // setVerified
    ]);
    await makeClient().registerAndAuthorize('abc123', { happ_id: 't' }, { email: 'ada@example.com' });
    expect(spy).toHaveBeenCalledTimes(4);
    const [url] = spy.mock.calls[3] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/verified/abc123`);
  });

  it('writes verified claims after transitioning a blocked key', async () => {
    const spy = mockFetch([
      { status: 200, body: { state: 'blocked', pubKey: 'abc123' } },
      { status: 200 }, // transition
      { status: 200 }, // setVerified
    ]);
    await makeClient().registerAndAuthorize('abc123', {}, { email: 'ada@example.com' });
    expect(spy).toHaveBeenCalledTimes(3);
    const [url] = spy.mock.calls[2] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/verified/abc123`);
  });

  it('throws when the verified write fails, so a required hc_auth blocks the join', async () => {
    mockFetch([
      { status: 200, body: { state: 'authorized', pubKey: 'abc123' } },
      { status: 500, body: 'boom' },
    ]);
    await expect(
      makeClient().registerAndAuthorize('abc123', {}, { email: 'x' }),
    ).rejects.toThrow('/api/verified');
  });

  it('skips the verified write when there is nothing to verify', async () => {
    const spy = mockFetch([{ status: 200, body: { state: 'authorized', pubKey: 'abc123' } }]);
    await makeClient().registerAndAuthorize('abc123', {}, {});
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('HcAuthClient.setVerified', () => {
  it('sends PUT /api/verified/{key} with Bearer token and the verified object', async () => {
    const spy = mockFetch([{ status: 200 }]);
    await makeClient().setVerified('abc123', { email: 'ada@example.com' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/verified/abc123`);
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ email: 'ada@example.com' });
  });

  it('throws on 404 (no record) and other non-2xx', async () => {
    mockFetch([{ status: 404, body: '' }]);
    await expect(makeClient().setVerified('abc123', { email: 'x' })).rejects.toThrow('404');
  });
});
