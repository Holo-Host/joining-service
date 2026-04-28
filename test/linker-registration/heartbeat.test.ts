import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as ed from '@noble/ed25519';
import { Hono } from 'hono';
import { LinkerRegistrationStore } from '../../src/linker-registration/store.js';
import { createLinkerRoutes } from '../../src/routes/linker-heartbeat.js';
import { canonicalJson } from '../../src/linker-registration/verify.js';
import type { LinkerAuthConfig } from '../../src/linker-auth/types.js';
import { createMockKV } from './helpers.js';

// ed25519 keypair shared across tests
let privKey: Uint8Array;
let pubKey: Uint8Array;
let pubkeyB64: string;

beforeAll(async () => {
  privKey = ed.utils.randomPrivateKey();
  pubKey = await ed.getPublicKeyAsync(privKey);
  pubkeyB64 = Buffer.from(pubKey).toString('base64');
});

/** Sign a set of fields using the test keypair. */
async function signFields(fields: Record<string, string>): Promise<string> {
  const message = new TextEncoder().encode(canonicalJson(fields));
  const sig = await ed.signAsync(message, privKey);
  return Buffer.from(sig).toString('base64');
}

/** Sign fields with an arbitrary private key. */
async function signFieldsWith(key: Uint8Array, fields: Record<string, string>): Promise<string> {
  const message = new TextEncoder().encode(canonicalJson(fields));
  const sig = await ed.signAsync(message, key);
  return Buffer.from(sig).toString('base64');
}

function makeConfig(overrides: Partial<LinkerAuthConfig> = {}): LinkerAuthConfig {
  return {
    capabilities: ['dht_read', 'dht_write'],
    admin_secret: 'admin-secret',
    ttl_seconds: 600,
    heartbeat_interval_seconds: 200,
    timestamp_tolerance_seconds: 30,
    ...overrides,
  };
}

describe('Linker Heartbeat Routes', () => {
  let app: Hono;
  let regStore: LinkerRegistrationStore;

  beforeEach(async () => {
    const kv = createMockKV();
    regStore = new LinkerRegistrationStore(kv);
    app = createLinkerRoutes(regStore, makeConfig());

    // Seed a valid invite
    await regStore.createInvite({
      token: 'lnk_valid',
      capabilities: ['dht_read', 'dht_write'],
      used_by: [],
      created_at: '2026-04-01T00:00:00.000Z',
    });
  });

  async function sendHeartbeat(overrides: Record<string, unknown> = {}) {
    const timestamp = new Date().toISOString();
    const admin_secret = overrides.admin_secret as string | undefined ?? 'linker-admin-secret';
    const linker_url = (overrides.linker_url as string) ?? 'wss://linker.example.com:8090';
    const admin_url = (overrides.admin_url as string) ?? 'https://linker.example.com';

    // Build fields for signature (must match what the handler expects)
    const fields: Record<string, string> = overrides.omit_secret
      ? { admin_url, linker_url, pubkey: pubkeyB64, timestamp }
      : { admin_secret, admin_url, linker_url, pubkey: pubkeyB64, timestamp };

    const signature = overrides.signature as string ?? await signFields(fields);

    const body: Record<string, unknown> = {
      pubkey: pubkeyB64,
      linker_url,
      admin_url,
      timestamp,
      signature,
      ...overrides,
    };
    // Include admin_secret unless explicitly omitted
    if (!overrides.omit_secret) {
      body.admin_secret = admin_secret;
    }
    delete body.omit_secret;

    return app.request('/v1/linkers/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  describe('POST /v1/linkers/heartbeat - first heartbeat', () => {
    it('registers a new linker with valid invite and signature', async () => {
      const resp = await sendHeartbeat({ invite_token: 'lnk_valid' });
      expect(resp.status).toBe(201);
      const json = await resp.json() as { registered: boolean; ttl_seconds: number };
      expect(json.registered).toBe(true);
      expect(json.ttl_seconds).toBe(600);

      // Verify linker is stored
      const linker = await regStore.getLinker(pubkeyB64);
      expect(linker).not.toBeNull();
      expect(linker!.linker_url).toBe('wss://linker.example.com:8090');
    });

    it('rejects first heartbeat without invite_token', async () => {
      const resp = await sendHeartbeat({});
      expect(resp.status).toBe(400);
      const json = await resp.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    });

    it('rejects first heartbeat without admin_secret', async () => {
      const timestamp = new Date().toISOString();
      const admin_url = 'https://linker.example.com';
      const linker_url = 'wss://linker.example.com:8090';
      const fields = { admin_url, linker_url, pubkey: pubkeyB64, timestamp };
      const signature = await signFields(fields);

      const resp = await app.request('/v1/linkers/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: pubkeyB64,
          invite_token: 'lnk_valid',
          linker_url,
          admin_url,
          timestamp,
          signature,
        }),
      });
      expect(resp.status).toBe(400);
    });

    it('rejects invalid invite token', async () => {
      const resp = await sendHeartbeat({ invite_token: 'lnk_nonexistent' });
      expect(resp.status).toBe(403);
    });

    it('rejects expired invite', async () => {
      await regStore.createInvite({
        token: 'lnk_expired',
        capabilities: ['dht_read'],
        used_by: [],
        created_at: '2025-01-01T00:00:00.000Z',
        expires_at: '2025-06-01T00:00:00.000Z',
      });
      const resp = await sendHeartbeat({ invite_token: 'lnk_expired' });
      expect(resp.status).toBe(403);
    });

    it('rejects exhausted invite (max_uses reached)', async () => {
      await regStore.createInvite({
        token: 'lnk_exhausted',
        capabilities: ['dht_read'],
        max_uses: 1,
        used_by: ['existing-pubkey'],
        created_at: '2026-04-01T00:00:00.000Z',
      });
      const resp = await sendHeartbeat({ invite_token: 'lnk_exhausted' });
      expect(resp.status).toBe(403);
    });

    it('rejects invalid JSON body', async () => {
      const resp = await app.request('/v1/linkers/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(resp.status).toBe(400);
      const json = await resp.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_json');
    });
  });

  describe('POST /v1/linkers/heartbeat - subsequent heartbeat', () => {
    beforeEach(async () => {
      // Register the linker first
      await sendHeartbeat({ invite_token: 'lnk_valid' });
    });

    it('updates URL and last_heartbeat', async () => {
      await new Promise((r) => setTimeout(r, 10));

      const resp = await sendHeartbeat({
        linker_url: 'wss://new-linker.example.com:8090',
        omit_secret: true,
      });
      expect(resp.status).toBe(200);

      const linker = await regStore.getLinker(pubkeyB64);
      expect(linker!.linker_url).toBe('wss://new-linker.example.com:8090');
    });

    it('rotates admin_secret when rotate_secret is true', async () => {
      await new Promise((r) => setTimeout(r, 10));

      const resp = await sendHeartbeat({
        admin_secret: 'new-secret',
        rotate_secret: true,
      });
      expect(resp.status).toBe(200);

      const linker = await regStore.getLinker(pubkeyB64);
      expect(linker!.admin_secret).toBe('new-secret');
    });

    it('rejects secret rotation when signature does not cover the new secret', async () => {
      await new Promise((r) => setTimeout(r, 10));

      const timestamp = new Date().toISOString();
      // Sign with the OLD secret but send a different one in the body
      const fields = {
        admin_secret: 'wrong-secret-in-sig',
        admin_url: 'https://linker.example.com',
        linker_url: 'wss://linker.example.com:8090',
        pubkey: pubkeyB64,
        timestamp,
      };
      const signature = await signFields(fields);

      const resp = await app.request('/v1/linkers/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: pubkeyB64,
          linker_url: 'wss://linker.example.com:8090',
          admin_url: 'https://linker.example.com',
          admin_secret: 'actual-new-secret',
          rotate_secret: true,
          timestamp,
          signature,
        }),
      });
      expect(resp.status).toBe(401);
    });
  });

  describe('replay protection', () => {
    it('rejects timestamp outside tolerance window', async () => {
      const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
      const fields = {
        admin_secret: 'linker-admin-secret',
        admin_url: 'https://linker.example.com',
        linker_url: 'wss://linker.example.com:8090',
        pubkey: pubkeyB64,
        timestamp: oldTimestamp,
      };
      const signature = await signFields(fields);

      const resp = await app.request('/v1/linkers/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: pubkeyB64,
          invite_token: 'lnk_valid',
          linker_url: 'wss://linker.example.com:8090',
          admin_url: 'https://linker.example.com',
          admin_secret: 'linker-admin-secret',
          timestamp: oldTimestamp,
          signature,
        }),
      });
      expect(resp.status).toBe(400);
      const json = await resp.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_timestamp');
    });

    it('rejects non-monotonic timestamp for known pubkey', async () => {
      // First heartbeat
      await sendHeartbeat({ invite_token: 'lnk_valid' });

      // Set last_heartbeat into the future to force monotonic failure
      const linker = await regStore.getLinker(pubkeyB64);
      linker!.last_heartbeat = new Date(Date.now() + 5000).toISOString();
      await regStore.putLinker(linker!, 600);

      const resp = await sendHeartbeat({ omit_secret: true });
      expect(resp.status).toBe(400);
    });
  });

  describe('signature verification', () => {
    it('rejects invalid signature', async () => {
      const resp = await sendHeartbeat({
        invite_token: 'lnk_valid',
        signature: Buffer.from('invalid-signature-bytes').toString('base64'),
      });
      expect(resp.status).toBe(401);
    });
  });

  describe('DELETE /v1/linkers/:pubkey', () => {
    beforeEach(async () => {
      await sendHeartbeat({ invite_token: 'lnk_valid' });
    });

    it('deregisters a linker with valid signature', async () => {
      // Ensure deregistration timestamp is after last_heartbeat
      await new Promise((r) => setTimeout(r, 10));

      const timestamp = new Date().toISOString();
      const fields = { pubkey: pubkeyB64, timestamp };
      const signature = await signFields(fields);

      const resp = await app.request(`/v1/linkers/${encodeURIComponent(pubkeyB64)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp, signature }),
      });
      expect(resp.status).toBe(204);

      const linker = await regStore.getLinker(pubkeyB64);
      expect(linker).toBeNull();
    });

    it('rejects invalid signature on deregistration', async () => {
      const timestamp = new Date().toISOString();

      const resp = await app.request(`/v1/linkers/${encodeURIComponent(pubkeyB64)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp,
          signature: Buffer.from('bad').toString('base64'),
        }),
      });
      expect(resp.status).toBe(401);
    });

    it('returns 404 for unknown linker', async () => {
      const otherPriv = ed.utils.randomPrivateKey();
      const otherPub = await ed.getPublicKeyAsync(otherPriv);
      const otherB64 = Buffer.from(otherPub).toString('base64');

      const timestamp = new Date().toISOString();
      const fields = { pubkey: otherB64, timestamp };
      const signature = await signFieldsWith(otherPriv, fields);

      const resp = await app.request(`/v1/linkers/${encodeURIComponent(otherB64)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp, signature }),
      });
      expect(resp.status).toBe(404);
    });

    it('rejects deregistration with non-monotonic timestamp', async () => {
      // Set last_heartbeat into the future
      const linker = await regStore.getLinker(pubkeyB64);
      linker!.last_heartbeat = new Date(Date.now() + 5000).toISOString();
      await regStore.putLinker(linker!, 600);

      const timestamp = new Date().toISOString();
      const fields = { pubkey: pubkeyB64, timestamp };
      const signature = await signFields(fields);

      const resp = await app.request(`/v1/linkers/${encodeURIComponent(pubkeyB64)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp, signature }),
      });
      expect(resp.status).toBe(400);
      const json = await resp.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_timestamp');
    });

    it('rejects invalid JSON body', async () => {
      const resp = await app.request(`/v1/linkers/${encodeURIComponent(pubkeyB64)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(resp.status).toBe(400);
      const json = await resp.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_json');
    });
  });
});
