import { describe, it, expect } from 'vitest';
import { createAdminNetworkRoutes } from '../../src/routes/admin-networks.js';
import { MemoryNetworkStore } from '../../src/network-registration/index.js';
import { fakeAgentKey, fakeDnaHash } from '../helpers.js';

const SECRET = 'test-network-admin-secret';
const STATIC_HAPP_ID = 'static-app';

function setup(requireDnaHash = false, staticHappId = STATIC_HAPP_ID, staticDnaHashes: string[] = []) {
  const store = new MemoryNetworkStore();
  const app = createAdminNetworkRoutes(store, {
    adminSecret: SECRET,
    requireDnaHash,
    staticHappId,
    staticDnaHashes,
  });
  const request = (path: string, init?: RequestInit) =>
    app.request(path, init);
  const authed = (path: string, init: RequestInit = {}) =>
    request(path, {
      ...init,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...init.headers },
    });
  return { store, request, authed };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    happ_id: 'acme-net',
    roles: {
      main: { dna_hash: fakeDnaHash(1) },
      chat: { dna_hash: fakeDnaHash(2) },
    },
    allowed_agents: [fakeAgentKey(10)],
    happ: { name: 'Acme Network' },
    ...overrides,
  };
}

describe('admin networks routes', () => {
  it('rejects requests without Authorization', async () => {
    const { request } = setup();
    const res = await request('/v1/admin/networks');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong admin secret', async () => {
    const { request } = setup();
    const res = await request('/v1/admin/networks', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(403);
  });

  describe.each([
    ['POST', '/v1/admin/networks', () => JSON.stringify(validBody())],
    ['GET', '/v1/admin/networks', undefined],
    ['GET', '/v1/admin/networks/acme-net', undefined],
    ['DELETE', '/v1/admin/networks/acme-net', undefined],
  ] as const)('auth matrix: %s %s', (method, path, body) => {
    it('401s with no Authorization header', async () => {
      const { request } = setup();
      const res = await request(path, { method, body: body?.() });
      expect(res.status).toBe(401);
    });

    it('403s with a wrong admin secret', async () => {
      const { request } = setup();
      const res = await request(path, {
        method,
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
        body: body?.(),
      });
      expect(res.status).toBe(403);
    });
  });

  it('registers a two-role network with allowed_agents and happ metadata, and lists it', async () => {
    const { authed } = setup();
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.happ_id).toBe('acme-net');
    expect(created.happ).toEqual({ name: 'Acme Network' });
    expect(Object.keys(created.roles)).toEqual(['main', 'chat']);
    expect(created.allowed_agents).toEqual([fakeAgentKey(10)]);
    expect(created.registered_at).toBeTypeOf('string');

    const list = await (await authed('/v1/admin/networks')).json();
    expect(list.networks).toHaveLength(1);
    expect(list.networks[0].happ_id).toBe('acme-net');
  });

  it('rejects an invalid happ_id with 400 invalid_happ_id', async () => {
    const { authed } = setup();
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody({ happ_id: 'Not Valid!' })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_happ_id');
  });

  it('accepts a happ_id containing dots', async () => {
    const { authed } = setup();
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody({ happ_id: 'org.example.acme' })),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).happ_id).toBe('org.example.acme');
  });

  it('rejects registering the service\'s static happ id with 400 invalid_happ_id', async () => {
    const { authed } = setup(false, STATIC_HAPP_ID);
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody({ happ_id: STATIC_HAPP_ID })),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_happ_id');
    expect(body.error.message).toContain('static happ id');
  });

  it('rejects empty roles with 400 invalid_role_config', async () => {
    const { authed } = setup();
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody({ roles: {} })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_role_config');
  });

  it('rejects a bad dna_hash in roles, naming the offending role', async () => {
    const { authed } = setup();
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(
        validBody({
          roles: {
            main: { dna_hash: fakeDnaHash(1) },
            broken: { dna_hash: 'not-a-hash' },
          },
        }),
      ),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_role_config');
    expect(body.error.message).toContain('broken');
  });

  it('registers a role with no dna_hash when membrane proofs are disabled', async () => {
    const { authed } = setup(false);
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody({ roles: { main: {} } })),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.roles.main.dna_hash).toBeUndefined();
  });

  it('rejects a role with no dna_hash when membrane proofs are enabled, naming the offending role', async () => {
    const { authed } = setup(true);
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody({ roles: { main: {} } })),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_role_config');
    expect(body.error.message).toContain('main');
  });

  it('rejects a bad dna_hash in roles even when membrane proofs are disabled', async () => {
    const { authed } = setup(false);
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody({ roles: { main: { dna_hash: 'not-a-hash' } } })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_role_config');
  });

  it('rejects a non-string modifiers.network_seed with 400', async () => {
    const { authed } = setup();
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(
        validBody({
          roles: {
            main: { dna_hash: fakeDnaHash(1), modifiers: { network_seed: 123 } },
          },
        }),
      ),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed allowed_agents entry with 400 invalid_agent_key', async () => {
    const { authed } = setup();
    const res = await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody({ allowed_agents: ['not-a-key'] })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_agent_key');
  });

  it('gets a registered network by id; 404 for unknown', async () => {
    const { authed } = setup();
    await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody()),
    });

    const found = await authed('/v1/admin/networks/acme-net');
    expect(found.status).toBe(200);
    expect((await found.json()).happ_id).toBe('acme-net');

    const missing = await authed('/v1/admin/networks/does-not-exist');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('not_found');
  });

  it('deletes a registered network; 404 for unknown', async () => {
    const { authed, store } = setup();
    await authed('/v1/admin/networks', {
      method: 'POST',
      body: JSON.stringify(validBody()),
    });

    const del = await authed('/v1/admin/networks/acme-net', { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await store.get('acme-net')).toBeNull();

    const again = await authed('/v1/admin/networks/acme-net', { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  describe('dna_hash uniqueness across networks', () => {
    it('rejects a dna_hash already registered to another network, naming both', async () => {
      const { authed } = setup();
      await authed('/v1/admin/networks', {
        method: 'POST',
        body: JSON.stringify(validBody({ happ_id: 'network-a' })),
      });

      const res = await authed('/v1/admin/networks', {
        method: 'POST',
        body: JSON.stringify(
          validBody({
            happ_id: 'network-b',
            roles: { main: { dna_hash: fakeDnaHash(1) } },
          }),
        ),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('duplicate_dna_hash');
      expect(body.error.message).toContain(fakeDnaHash(1));
      expect(body.error.message).toContain('network-a');
    });

    it('rejects a dna_hash already used by the static config, naming it', async () => {
      const { authed } = setup(false, STATIC_HAPP_ID, [fakeDnaHash(1)]);
      const res = await authed('/v1/admin/networks', {
        method: 'POST',
        body: JSON.stringify(
          validBody({
            happ_id: 'network-a',
            roles: { main: { dna_hash: fakeDnaHash(1) } },
          }),
        ),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('duplicate_dna_hash');
      expect(body.error.message).toContain(fakeDnaHash(1));
      expect(body.error.message).toContain(STATIC_HAPP_ID);
    });

    it('allows re-registering the same happ_id with its own hashes unchanged', async () => {
      const { authed } = setup();
      await authed('/v1/admin/networks', {
        method: 'POST',
        body: JSON.stringify(validBody({ happ_id: 'network-a' })),
      });

      const res = await authed('/v1/admin/networks', {
        method: 'POST',
        body: JSON.stringify(validBody({ happ_id: 'network-a' })),
      });

      expect(res.status).toBe(201);
    });

    it('allows two networks with entirely distinct dna_hashes', async () => {
      const { authed } = setup();
      await authed('/v1/admin/networks', {
        method: 'POST',
        body: JSON.stringify(validBody({ happ_id: 'network-a' })),
      });

      const res = await authed('/v1/admin/networks', {
        method: 'POST',
        body: JSON.stringify(
          validBody({
            happ_id: 'network-b',
            roles: {
              main: { dna_hash: fakeDnaHash(3) },
              chat: { dna_hash: fakeDnaHash(4) },
            },
          }),
        ),
      });

      expect(res.status).toBe(201);
    });
  });
});
