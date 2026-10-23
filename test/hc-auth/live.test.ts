/**
 * Live test against a running hc-auth-server (branch feat/confirm-email or
 * later, which has PUT /api/verified/{key}).
 *
 * Skipped unless both are set:
 *   HC_AUTH_LIVE_URL    e.g. http://127.0.0.1:3000
 *   HC_AUTH_LIVE_TOKEN  a token from the server's API_TOKENS
 *
 * The server needs a reachable Redis. Each run uses fresh random keys, so
 * records left behind do not affect later runs.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { HcAuthClient } from '../../src/hc-auth/client.js';

const url = process.env.HC_AUTH_LIVE_URL;
const token = process.env.HC_AUTH_LIVE_TOKEN;

function freshKey(): string {
  return randomBytes(32).toString('base64url');
}

interface LiveRecord {
  state: string;
  data?: { payload?: Record<string, unknown>; verified?: Record<string, unknown> };
}

describe.skipIf(!url || !token)('hc-auth live: PUT /api/verified via registerAndAuthorize', () => {
  // Placeholders keep collection from throwing when the suite is skipped.
  const client = new HcAuthClient({ url: url ?? 'http://unset', api_token: token ?? '' });

  async function fetchRecord(key: string): Promise<LiveRecord> {
    const resp = await fetch(`${url}/api/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);
    return (await resp.json()) as LiveRecord;
  }

  it('new key: registers, authorizes, and writes verified', async () => {
    const key = freshKey();
    await client.registerAndAuthorize(key, { happ_id: 'live' }, { email: 'ada@example.com' });
    const rec = await fetchRecord(key);
    expect(rec.state).toBe('authorized');
    expect(rec.data?.verified).toEqual({ email: 'ada@example.com' });
  });

  it('already-authorized key: verified is replaced on the next join', async () => {
    const key = freshKey();
    await client.registerAndAuthorize(key, { happ_id: 'live' }, { email: 'old@example.com' });
    await client.registerAndAuthorize(key, { happ_id: 'live' }, { email: 'new@example.com' });
    const rec = await fetchRecord(key);
    expect(rec.state).toBe('authorized');
    expect(rec.data?.verified).toEqual({ email: 'new@example.com' });
  });

  it('pre-registered key with attacker payload: verified holds the real email', async () => {
    const key = freshKey();
    // Anyone can call the public route and claim any email.
    const pre = await fetch(`${url}/request-auth/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'victim@example.com' }),
    });
    expect(pre.ok).toBe(true);

    await client.registerAndAuthorize(key, { email: 'attacker@example.com' }, { email: 'attacker@example.com' });
    const rec = await fetchRecord(key);
    expect(rec.state).toBe('authorized');
    expect(rec.data?.payload).toEqual({ email: 'victim@example.com' }); // untrusted, unchanged
    expect(rec.data?.verified).toEqual({ email: 'attacker@example.com' }); // what the joiner proved
  });

  it('empty verified: nothing is written', async () => {
    const key = freshKey();
    await client.registerAndAuthorize(key, { happ_id: 'live' }, {});
    const rec = await fetchRecord(key);
    expect(rec.state).toBe('authorized');
    expect(rec.data?.verified).toBeUndefined();
  });

  it('setVerified on an unknown key throws 404', async () => {
    await expect(client.setVerified(freshKey(), { email: 'x@example.com' })).rejects.toThrow('404');
  });

  it('setVerified with a bad key throws 400', async () => {
    await expect(client.setVerified('not-a-key', { email: 'x@example.com' })).rejects.toThrow('400');
  });
});
