import { describe, it, expect, beforeEach } from 'vitest';
import * as ed from '@noble/ed25519';
import { createApp, type ServiceContext } from '../../src/app.js';
import { resolveConfig } from '../../src/config.js';
import { MemorySessionStore } from '../../src/session/memory-store.js';
import { OpenAuthMethod } from '../../src/auth-methods/open.js';
import { KvUrlProvider } from '../../src/urls/kv.js';
import { LinkerRegistrationStore } from '../../src/linker-registration/store.js';
import { canonicalJson } from '../../src/linker-registration/verify.js';
import { createMockKV } from './helpers.js';

const ADMIN_SECRET = 'integration-test-admin-secret';

describe('Dynamic linker registration integration', () => {
  let app: ReturnType<typeof createApp>;
  let regStore: LinkerRegistrationStore;

  beforeEach(() => {
    const kv = createMockKV();
    regStore = new LinkerRegistrationStore(kv);

    const config = resolveConfig({
      happ: { id: 'test-app', name: 'Test App' },
      auth_methods: ['open'],
      linker_auth: {
        capabilities: ['dht_read', 'dht_write'],
        admin_secret: ADMIN_SECRET,
        ttl_seconds: 600,
        timestamp_tolerance_seconds: 30,
      },
    });

    const ctx: ServiceContext = {
      config,
      sessionStore: new MemorySessionStore(86400),
      authPlugins: new Map([['open', new OpenAuthMethod()]]),
      urlProvider: new KvUrlProvider(kv, regStore),
      linkerRegistrationStore: regStore,
    };

    app = createApp(ctx);
  });

  it('admin routes are mounted when linker_auth.admin_secret and store are set', async () => {
    const resp = await app.request('/v1/admin/linker-invites', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ capabilities: ['dht_read'] }),
    });
    expect(resp.status).toBe(201);
    const json = await resp.json() as { invite_token: string };
    expect(json.invite_token).toMatch(/^lnk_/);
  });

  it('admin routes reject unauthenticated requests', async () => {
    const resp = await app.request('/v1/admin/linker-invites');
    expect(resp.status).toBe(401);
  });

  it('linker routes are mounted and accept heartbeats', async () => {
    // Create invite via admin API
    const inviteResp = await app.request('/v1/admin/linker-invites', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ capabilities: ['dht_read', 'dht_write'] }),
    });
    const { invite_token } = await inviteResp.json() as { invite_token: string };

    // Generate linker keypair and send heartbeat
    const privKey = ed.utils.randomPrivateKey();
    const pubKey = await ed.getPublicKeyAsync(privKey);
    const pubkeyB64 = Buffer.from(pubKey).toString('base64');

    const timestamp = new Date().toISOString();
    const admin_secret = 'linker-secret';
    const fields = {
      admin_secret,
      admin_url: 'https://linker.test',
      linker_url: 'wss://linker.test:8090',
      pubkey: pubkeyB64,
      timestamp,
    };
    const message = new TextEncoder().encode(canonicalJson(fields));
    const sig = await ed.signAsync(message, privKey);
    const signature = Buffer.from(sig).toString('base64');

    const hbResp = await app.request('/v1/linkers/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubkey: pubkeyB64,
        invite_token,
        linker_url: 'wss://linker.test:8090',
        admin_url: 'https://linker.test',
        admin_secret,
        timestamp,
        signature,
      }),
    });
    expect(hbResp.status).toBe(201);

    // Verify linker appears in admin listing
    const listResp = await app.request('/v1/admin/linkers', {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    });
    const { linkers } = await listResp.json() as { linkers: Array<{ pubkey: string }> };
    expect(linkers).toHaveLength(1);
    expect(linkers[0].pubkey).toBe(pubkeyB64);
  });

  it('routes are not mounted when linkerRegistrationStore is absent', () => {
    const config = resolveConfig({
      happ: { id: 'test-app', name: 'Test App' },
      auth_methods: ['open'],
      linker_auth: {
        capabilities: ['dht_read'],
        admin_secret: ADMIN_SECRET,
      },
    });

    const appNoStore = createApp({
      config,
      sessionStore: new MemorySessionStore(86400),
      authPlugins: new Map([['open', new OpenAuthMethod()]]),
      urlProvider: new KvUrlProvider(createMockKV()),
      // no linkerRegistrationStore
    });

    // Admin routes should 404
    return appNoStore.request('/v1/admin/linker-invites', {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    }).then((resp) => {
      expect(resp.status).toBe(404);
    });
  });
});
