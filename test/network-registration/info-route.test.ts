import { describe, it, expect } from 'vitest';
import { createTestApp, fakeAgentKey, fakeDnaHash } from '../helpers.js';

const ADMIN_SECRET = 'info-admin-secret';

async function registerNetwork(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  body: Record<string, unknown>,
) {
  const res = await request('/v1/admin/networks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe('GET /v1/info/:happ_id', () => {
  it('serves a registered network, falling back happ.name to happ_id and happ_bundle_url to undefined when unset', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
      happ: { id: 'test-app', name: 'Test App', happ_bundle_url: 'https://example.com/static.happ' },
    });

    await registerNetwork(request, {
      happ_id: 'acme-net',
      roles: { main: { dna_hash: fakeDnaHash(1), modifiers: { network_seed: 'acme-seed' } } },
    });

    const res = await request('/v1/info/acme-net');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.happ.id).toBe('acme-net');
    expect(body.happ.name).toBe('acme-net'); // falls back to happ_id when no happ.name registered
    // No fallback to the service's own happ_bundle_url.
    expect(body.happ_bundle_url).toBeUndefined();
    expect(body.roles).toEqual({
      main: { dna_modifiers: { network_seed: 'acme-seed' } },
    });
  });

  it('uses the registered network\'s own happ metadata when present', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    await registerNetwork(request, {
      happ_id: 'beta-net',
      happ: {
        name: 'Beta Network',
        description: 'A beta deployment',
        icon_url: 'https://example.com/beta.png',
        happ_bundle_url: 'https://example.com/beta.happ',
      },
      roles: { main: { dna_hash: fakeDnaHash(2) } },
    });

    const res = await request('/v1/info/beta-net');
    const body = await res.json();
    expect(body.happ).toEqual({
      id: 'beta-net',
      name: 'Beta Network',
      description: 'A beta deployment',
      icon_url: 'https://example.com/beta.png',
    });
    expect(body.happ_bundle_url).toBe('https://example.com/beta.happ');
  });

  it('aliases the bare /v1/info response for the service\'s own static happ id', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
      roles: { main: { dna_hash: fakeDnaHash(3) } },
    });

    const bare = await (await request('/v1/info')).json();
    // createTestApp's default happ.id is 'test-app'.
    const named = await (await request('/v1/info/test-app')).json();
    expect(named).toEqual(bare);
  });

  it('404s unknown_network for an unregistered id', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    const res = await request('/v1/info/does-not-exist');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('unknown_network');
  });

  it('404s unknown_network for an id that fails the happ_id format, without a store round-trip', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    const res = await request('/v1/info/' + encodeURIComponent('not a valid id!'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('unknown_network');
  });

  it('omits roles for a network gated by allowed_agents (role modifiers are not public)', async () => {
    const agentKey = fakeAgentKey(90);
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    await registerNetwork(request, {
      happ_id: 'gated-info-net',
      roles: { main: { dna_hash: fakeDnaHash(5), modifiers: { network_seed: 'secret-seed' } } },
      allowed_agents: [agentKey],
    });

    const res = await request('/v1/info/gated-info-net');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.happ.id).toBe('gated-info-net');
    expect(body.roles).toBeUndefined();
  });

  it('includes roles for a network with no allowed_agents restriction', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    await registerNetwork(request, {
      happ_id: 'ungated-info-net',
      roles: { main: { dna_hash: fakeDnaHash(6), modifiers: { network_seed: 'public-seed' } } },
    });

    const res = await request('/v1/info/ungated-info-net');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toEqual({
      main: { dna_modifiers: { network_seed: 'public-seed' } },
    });
  });

  it('404s unknown_network for any id when network_registration is not configured', async () => {
    const { request } = await createTestApp({});

    const res = await request('/v1/info/anything');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('unknown_network');
  });

  it('does not shadow or get shadowed by the bare GET /v1/info route', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
      roles: { main: { dna_hash: fakeDnaHash(4) } },
    });

    const bareRes = await request('/v1/info');
    expect(bareRes.status).toBe(200);
    expect((await bareRes.json()).happ.id).toBe('test-app');
  });
});
