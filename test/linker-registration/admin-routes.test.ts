import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { LinkerRegistrationStore } from '../../src/linker-registration/store.js';
import { createAdminLinkerRoutes } from '../../src/routes/admin-linkers.js';
import type { LinkerAuthConfig } from '../../src/linker-auth/types.js';
import { createMockKV } from './helpers.js';

const ADMIN_SECRET = 'test-admin-secret';

function makeConfig(overrides: Partial<LinkerAuthConfig> = {}): LinkerAuthConfig {
  return {
    capabilities: ['dht_read', 'dht_write'],
    admin_secret: ADMIN_SECRET,
    ...overrides,
  };
}

function authHeader(secret = ADMIN_SECRET) {
  return { Authorization: `Bearer ${secret}` };
}

describe('Admin Linker Routes', () => {
  let app: Hono;
  let regStore: LinkerRegistrationStore;

  beforeEach(() => {
    const kv = createMockKV();
    regStore = new LinkerRegistrationStore(kv);
    app = createAdminLinkerRoutes(regStore, makeConfig());
  });

  describe('auth middleware', () => {
    it('rejects requests without Authorization header', async () => {
      const resp = await app.request('/v1/admin/linker-invites');
      expect(resp.status).toBe(401);
    });

    it('rejects requests with wrong secret', async () => {
      const resp = await app.request('/v1/admin/linker-invites', {
        headers: authHeader('wrong'),
      });
      expect(resp.status).toBe(403);
    });
  });

  describe('POST /v1/admin/linker-invites', () => {
    it('creates an invite and returns token', async () => {
      const resp = await app.request('/v1/admin/linker-invites', {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'test-linker',
          capabilities: ['dht_read', 'dht_write'],
          max_uses: 1,
        }),
      });
      expect(resp.status).toBe(201);
      const json = await resp.json() as { invite_token: string };
      expect(json.invite_token).toMatch(/^lnk_/);
    });

    it('rejects invalid capabilities', async () => {
      const resp = await app.request('/v1/admin/linker-invites', {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['invalid'] }),
      });
      expect(resp.status).toBe(400);
    });

    it('rejects empty capabilities', async () => {
      const resp = await app.request('/v1/admin/linker-invites', {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: [] }),
      });
      expect(resp.status).toBe(400);
    });

    it('rejects invalid JSON body', async () => {
      const resp = await app.request('/v1/admin/linker-invites', {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(resp.status).toBe(400);
      const json = await resp.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_json');
    });
  });

  describe('GET /v1/admin/linker-invites', () => {
    it('lists created invites', async () => {
      await app.request('/v1/admin/linker-invites', {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['dht_read'] }),
      });
      await app.request('/v1/admin/linker-invites', {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['dht_write'] }),
      });

      const resp = await app.request('/v1/admin/linker-invites', {
        headers: authHeader(),
      });
      expect(resp.status).toBe(200);
      const json = await resp.json() as { invites: unknown[] };
      expect(json.invites).toHaveLength(2);
    });
  });

  describe('DELETE /v1/admin/linker-invites/:token', () => {
    it('deletes an existing invite', async () => {
      const createResp = await app.request('/v1/admin/linker-invites', {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['dht_read'] }),
      });
      const { invite_token } = await createResp.json() as { invite_token: string };

      const deleteResp = await app.request(`/v1/admin/linker-invites/${invite_token}`, {
        method: 'DELETE',
        headers: authHeader(),
      });
      expect(deleteResp.status).toBe(204);
    });

    it('returns 404 for nonexistent invite', async () => {
      const resp = await app.request('/v1/admin/linker-invites/lnk_nonexistent', {
        method: 'DELETE',
        headers: authHeader(),
      });
      expect(resp.status).toBe(404);
    });
  });

  describe('linker management endpoints', () => {
    async function seedLinker(pubkey = 'dGVzdGtleQ==') {
      await regStore.putLinker(
        {
          pubkey,
          invite_token: 'lnk_test',
          capabilities: ['dht_read'],
          admin_secret: 'linker-secret',
          linker_url: 'wss://linker.example.com:8090',
          admin_url: 'https://linker.example.com',
          last_heartbeat: new Date().toISOString(),
        },
        600,
      );
    }

    it('GET /v1/admin/linkers lists linkers with redacted secrets', async () => {
      await seedLinker('key1');
      await seedLinker('key2');
      const resp = await app.request('/v1/admin/linkers', {
        headers: authHeader(),
      });
      expect(resp.status).toBe(200);
      const json = await resp.json() as { linkers: Array<{ admin_secret: string }> };
      expect(json.linkers).toHaveLength(2);
      expect(json.linkers[0].admin_secret).toBe('[redacted]');
    });

    it('GET /v1/admin/linkers/:pubkey returns linker detail', async () => {
      await seedLinker('mykey');
      const resp = await app.request('/v1/admin/linkers/mykey', {
        headers: authHeader(),
      });
      expect(resp.status).toBe(200);
      const json = await resp.json() as { pubkey: string; admin_secret: string };
      expect(json.pubkey).toBe('mykey');
      expect(json.admin_secret).toBe('[redacted]');
    });

    it('GET /v1/admin/linkers/:pubkey returns 404 for unknown', async () => {
      const resp = await app.request('/v1/admin/linkers/unknown', {
        headers: authHeader(),
      });
      expect(resp.status).toBe(404);
    });

    it('PATCH /v1/admin/linkers/:pubkey updates capabilities', async () => {
      await seedLinker('patchkey');
      const resp = await app.request('/v1/admin/linkers/patchkey', {
        method: 'PATCH',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['dht_read', 'dht_write', 'k2'] }),
      });
      expect(resp.status).toBe(200);
      const json = await resp.json() as { capabilities: string[] };
      expect(json.capabilities).toEqual(['dht_read', 'dht_write', 'k2']);
    });

    it('PATCH /v1/admin/linkers/:pubkey rejects invalid capabilities', async () => {
      await seedLinker('patchkey');
      const resp = await app.request('/v1/admin/linkers/patchkey', {
        method: 'PATCH',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['invalid_cap'] }),
      });
      expect(resp.status).toBe(400);
    });

    it('DELETE /v1/admin/linkers/:pubkey removes the linker', async () => {
      await seedLinker('delkey');
      const resp = await app.request('/v1/admin/linkers/delkey', {
        method: 'DELETE',
        headers: authHeader(),
      });
      expect(resp.status).toBe(204);

      const getResp = await app.request('/v1/admin/linkers/delkey', {
        headers: authHeader(),
      });
      expect(getResp.status).toBe(404);
    });

    it('DELETE /v1/admin/linkers/:pubkey returns 404 for unknown', async () => {
      const resp = await app.request('/v1/admin/linkers/unknown', {
        method: 'DELETE',
        headers: authHeader(),
      });
      expect(resp.status).toBe(404);
    });
  });
});
