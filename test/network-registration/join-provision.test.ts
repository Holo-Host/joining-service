import { describe, it, expect } from 'vitest';
import { createTestApp, fakeAgentKey, fakeDnaHash } from '../helpers.js';
import type { AgentAllowListAuthMethod } from '../../src/auth-methods/agent-allow-list.js';

const ADMIN_SECRET = 'net-admin-secret';

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

describe('network-aware join and provision', () => {
  it('join naming a registered network: provision returns that network\'s roles, not the default', async () => {
    const defaultDna = fakeDnaHash(1);
    const networkDna = fakeDnaHash(2);
    const { request } = await createTestApp({
      membrane_proof: { enabled: true },
      network_registration: { admin_secret: ADMIN_SECRET },
      roles: { main: { dna_hash: defaultDna, modifiers: { network_seed: 'default-seed' } } },
    });

    await registerNetwork(request, {
      happ_id: 'acme-net',
      roles: { acme_role: { dna_hash: networkDna, modifiers: { network_seed: 'acme-seed' } } },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(), network: 'acme-net' }),
    });
    expect(joinRes.status).toBe(201);
    const { session } = await joinRes.json();

    const prov = await (await request(`/v1/join/${session}/provision`)).json();
    expect(Object.keys(prov.roles)).toEqual(['acme_role']);
    expect(prov.roles.acme_role.membrane_proof).toBeTypeOf('string');
    expect(prov.roles.acme_role.dna_modifiers).toEqual({ network_seed: 'acme-seed' });
    // The default config.roles entry ("main") must not leak into a network-scoped provision.
    expect(prov.roles.main).toBeUndefined();
  });

  it('join naming a registered network with its own happ_bundle_url: provision returns that URL, not the service\'s', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
      happ: { id: 'test-app', name: 'Test App', happ_bundle_url: 'https://example.com/static.happ' },
    });

    await registerNetwork(request, {
      happ_id: 'bundle-net',
      happ: { happ_bundle_url: 'https://example.com/bundle-net.happ' },
      roles: { main: { dna_hash: fakeDnaHash(15) } },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(80), network: 'bundle-net' }),
    });
    expect(joinRes.status).toBe(201);
    const { session } = await joinRes.json();

    const prov = await (await request(`/v1/join/${session}/provision`)).json();
    expect(prov.happ_bundle_url).toBe('https://example.com/bundle-net.happ');
  });

  it('join naming a registered network with no happ_bundle_url of its own: provision omits happ_bundle_url (no fallback to the service\'s)', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
      happ: { id: 'test-app', name: 'Test App', happ_bundle_url: 'https://example.com/static.happ' },
    });

    await registerNetwork(request, {
      happ_id: 'no-bundle-net',
      roles: { main: { dna_hash: fakeDnaHash(16) } },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(81), network: 'no-bundle-net' }),
    });
    expect(joinRes.status).toBe(201);
    const { session } = await joinRes.json();

    const prov = await (await request(`/v1/join/${session}/provision`)).json();
    expect(prov.happ_bundle_url).toBeUndefined();
  });

  it('join without network: provision still returns the service\'s own static happ_bundle_url', async () => {
    const { request } = await createTestApp({
      happ: { id: 'test-app', name: 'Test App', happ_bundle_url: 'https://example.com/static.happ' },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(82) }),
    });
    expect(joinRes.status).toBe(201);
    const { session } = await joinRes.json();

    const prov = await (await request(`/v1/join/${session}/provision`)).json();
    expect(prov.happ_bundle_url).toBe('https://example.com/static.happ');
  });

  it('registers a network with hash-less roles when membrane proofs are disabled; provision returns dna_modifiers with no membrane_proof', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    await registerNetwork(request, {
      happ_id: 'no-proof-net',
      roles: { main: { modifiers: { network_seed: 'no-proof-seed' } } },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(), network: 'no-proof-net' }),
    });
    expect(joinRes.status).toBe(201);
    const { session } = await joinRes.json();

    const prov = await (await request(`/v1/join/${session}/provision`)).json();
    expect(Object.keys(prov.roles)).toEqual(['main']);
    expect(prov.roles.main.dna_modifiers).toEqual({ network_seed: 'no-proof-seed' });
    expect(prov.roles.main.membrane_proof).toBeUndefined();
  });

  it('join without network: provision returns the default config.roles output unchanged', async () => {
    const { request } = await createTestApp({
      membrane_proof: { enabled: true },
      network_registration: { admin_secret: ADMIN_SECRET },
      roles: { main: { dna_hash: fakeDnaHash(3), modifiers: { network_seed: 'default-seed' } } },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });
    expect(joinRes.status).toBe(201);
    const { session } = await joinRes.json();

    const prov = await (await request(`/v1/join/${session}/provision`)).json();
    expect(Object.keys(prov.roles)).toEqual(['main']);
    expect(prov.roles.main.membrane_proof).toBeTypeOf('string');
    expect(prov.roles.main.dna_modifiers).toEqual({ network_seed: 'default-seed' });
  });

  it('join naming an unregistered network: 400 unknown_network', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(), network: 'nonexistent' }),
    });
    expect(joinRes.status).toBe(400);
    const body = await joinRes.json();
    expect(body.error.code).toBe('unknown_network');
  });

  it('join naming a network id that fails the format regex: 400 unknown_network', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    // Spaces and `!` never match HAPP_ID_RE, so this is rejected by the
    // format check itself, without a store lookup.
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(), network: 'Not A Valid Id!' }),
    });
    expect(joinRes.status).toBe(400);
    const body = await joinRes.json();
    expect(body.error.code).toBe('unknown_network');
  });

  it('join with a non-string network: 400 unknown_network', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(), network: 42 }),
    });
    expect(joinRes.status).toBe(400);
    const body = await joinRes.json();
    expect(body.error.code).toBe('unknown_network');
  });

  it('network allowed_agents grants a challenge only when the network is named', async () => {
    const agentKey = fakeAgentKey(20);
    const { request, ctx } = await createTestApp({
      auth_methods: ['agent_allow_list'],
      allowed_agents: [],
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    await registerNetwork(request, {
      happ_id: 'allow-net',
      roles: { main: { dna_hash: fakeDnaHash(5) } },
      allowed_agents: [agentKey],
    });

    // With the network named: the agent is in the network's allow list, so
    // the standalone agent_allow_list method issues a pending challenge.
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'allow-net' }),
    });
    expect(joinRes.status).toBe(201);
    const joinBody = await joinRes.json();
    expect(joinBody.status).toBe('pending');
    expect(joinBody.challenges).toHaveLength(1);
    expect(joinBody.challenges[0].type).toBe('agent_allow_list');

    // Without the network, agent_allow_list has no basis to admit the agent
    // (it's not in the static list, the store, or any network's allow list),
    // so its eligibility must be verified at the plugin's createChallenges
    // boundary -- that's the actual decision point for "is this method
    // satisfiable," independent of how the join endpoint reports it.
    const plugin = ctx.authPlugins.get('agent_allow_list') as AgentAllowListAuthMethod;
    const challenges = await plugin.createChallenges(agentKey, {}, ctx.config);
    expect(challenges).toHaveLength(0);
  });

  it('network deleted between join and provision: provision returns 404 unknown_network', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
      roles: { main: { dna_hash: fakeDnaHash(6) } },
    });

    await registerNetwork(request, {
      happ_id: 'temp-net',
      roles: { temp_role: { dna_hash: fakeDnaHash(7) } },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(), network: 'temp-net' }),
    });
    const { session } = await joinRes.json();

    const delRes = await request('/v1/admin/networks/temp-net', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    });
    expect(delRes.status).toBe(204);

    const provRes = await request(`/v1/join/${session}/provision`);
    expect(provRes.status).toBe(404);
    const body = await provRes.json();
    expect(body.error.code).toBe('unknown_network');
  });

  it('network allowed_agents rejects an agent not on the list, even under open auth (issue #13)', async () => {
    const agentA = fakeAgentKey(30);
    const agentB = fakeAgentKey(31);
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    await registerNetwork(request, {
      happ_id: 'gated-net',
      roles: { main: { dna_hash: fakeDnaHash(8) } },
      allowed_agents: [agentA],
    });

    // Open auth alone would admit any agent; the network's allowed_agents
    // must still gate membership for agents naming that network.
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentB, network: 'gated-net' }),
    });
    expect(joinRes.status).toBe(403);
    const body = await joinRes.json();
    expect(body.error.code).toBe('join_rejected');
  });

  it('network allowed_agents admits a listed agent and provisions that network\'s roles', async () => {
    const agentA = fakeAgentKey(30);
    const { request } = await createTestApp({
      membrane_proof: { enabled: true },
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    await registerNetwork(request, {
      happ_id: 'gated-net',
      roles: { gated_role: { dna_hash: fakeDnaHash(9) } },
      allowed_agents: [agentA],
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentA, network: 'gated-net' }),
    });
    expect(joinRes.status).toBe(201);
    const { session, status } = await joinRes.json();
    expect(status).toBe('ready');

    const prov = await (await request(`/v1/join/${session}/provision`)).json();
    expect(Object.keys(prov.roles)).toEqual(['gated_role']);
  });

  it('network without allowed_agents is unrestricted: any agent may join it', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    await registerNetwork(request, {
      happ_id: 'open-net',
      roles: { main: { dna_hash: fakeDnaHash(10) } },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey(33), network: 'open-net' }),
    });
    expect(joinRes.status).toBe(201);
    expect((await joinRes.json()).status).toBe('ready');
  });

  it('rejecting a bogus network on join does not destroy an existing pending session', async () => {
    const agentKey = fakeAgentKey(40);
    const { request } = await createTestApp({
      auth_methods: ['agent_allow_list'],
      allowed_agents: [agentKey],
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    expect(joinRes.status).toBe(201);
    const { session, status } = await joinRes.json();
    expect(status).toBe('pending');

    // A bogus `network` on a second join attempt must be rejected before any
    // stale-pending-session cleanup runs, or it would delete the session
    // above as a side effect of a request that never got that far.
    const badJoinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'nonexistent' }),
    });
    expect(badJoinRes.status).toBe(400);
    expect((await badJoinRes.json()).error.code).toBe('unknown_network');

    const statusRes = await request(`/v1/join/${session}/status`);
    expect(statusRes.status).toBe(200);
    expect((await statusRes.json()).status).toBe('pending');
  });

  it('a second join on the same network still 409s', async () => {
    const agentKey = fakeAgentKey(51);
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    await registerNetwork(request, {
      happ_id: 'network-a',
      roles: { role_a: { dna_hash: fakeDnaHash(52) } },
    });

    const first = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'network-a' }),
    });
    expect(first.status).toBe(201);
    expect((await first.json()).status).toBe('ready');

    const second = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'network-a' }),
    });
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('agent_already_joined');
  });

  it('joining by the service\'s own static happ id normalizes to the same session scope as a bare join', async () => {
    const agentKey = fakeAgentKey(60);
    // No network_registration needed: normalization happens before any store
    // lookup, so this must work even when there is no network store at all.
    const { request } = await createTestApp({
      roles: { main: { dna_hash: fakeDnaHash(60) } },
    });

    // createTestApp's default happ.id is 'test-app'.
    const namedJoin = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'test-app' }),
    });
    expect(namedJoin.status).toBe(201);
    expect((await namedJoin.json()).status).toBe('ready');

    // A second, bare join for the same agent must 409 -- naming the static
    // happ id and omitting `network` share the same (undefined) scope.
    const bareJoin = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    expect(bareJoin.status).toBe(409);
    expect((await bareJoin.json()).error.code).toBe('agent_already_joined');
  });

  it('registering the service\'s own static happ id is rejected end-to-end', async () => {
    const { request } = await createTestApp({
      network_registration: { admin_secret: ADMIN_SECRET },
    });

    const res = await request('/v1/admin/networks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ happ_id: 'test-app', roles: { main: { dna_hash: fakeDnaHash(61) } } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_happ_id');
  });

  describe('dynamic-only mode (no config.roles)', () => {
    it('register + join + provision returns the registered network\'s roles', async () => {
      const { request } = await createTestApp({
        network_registration: { admin_secret: ADMIN_SECRET },
        // No config.roles at all -- this service has no static network.
      });

      await registerNetwork(request, {
        happ_id: 'dyn-net',
        roles: { main: { modifiers: { network_seed: 'dyn-seed' } } },
      });

      const joinRes = await request('/v1/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_key: fakeAgentKey(70), network: 'dyn-net' }),
      });
      expect(joinRes.status).toBe(201);
      const { session } = await joinRes.json();

      const prov = await (await request(`/v1/join/${session}/provision`)).json();
      expect(Object.keys(prov.roles)).toEqual(['main']);
      expect(prov.roles.main.dna_modifiers).toEqual({ network_seed: 'dyn-seed' });
    });

    it('bare GET /v1/info works with no roles field', async () => {
      const { request } = await createTestApp({
        network_registration: { admin_secret: ADMIN_SECRET },
      });

      const res = await request('/v1/info');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.roles).toBeUndefined();
      expect(body.happ.id).toBe('test-app');
    });

    it('join without network succeeds and provisions without roles (linker-urls-only session)', async () => {
      const { request } = await createTestApp({
        network_registration: { admin_secret: ADMIN_SECRET },
      });

      const joinRes = await request('/v1/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_key: fakeAgentKey(71) }),
      });
      expect(joinRes.status).toBe(201);
      const { session, status } = await joinRes.json();
      expect(status).toBe('ready');

      const prov = await (await request(`/v1/join/${session}/provision`)).json();
      expect(prov.roles).toBeUndefined();
      expect(prov.linker_urls).toBeTruthy();
    });

    it('GET /v1/info/<registered happ_id> serves that network', async () => {
      const { request } = await createTestApp({
        network_registration: { admin_secret: ADMIN_SECRET },
      });

      await registerNetwork(request, {
        happ_id: 'dyn-info-net',
        happ: { name: 'Dyn Info Net' },
        roles: { main: { modifiers: { network_seed: 'dyn-info-seed' } } },
      });

      const res = await request('/v1/info/dyn-info-net');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.happ.id).toBe('dyn-info-net');
      expect(body.happ.name).toBe('Dyn Info Net');
      expect(body.roles).toEqual({
        main: { dna_modifiers: { network_seed: 'dyn-info-seed' } },
      });
    });
  });
});
