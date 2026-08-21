import { describe, it, expect } from 'vitest';
import { createTestApp, fakeAgentKey } from '../helpers.js';

// Regression test for a middleware collision: both admin sub-apps used to
// register their bearer-auth middleware on the broad `/v1/admin/*` path.
// `app.route('', subApp)` flattens routes and middleware into one router, so
// whichever sub-app mounted first (linker-auth) shadowed the other
// (agent-registration) -- every /v1/admin/allowed-agents request was
// checked against the linker secret and 403'd even with a valid agent
// secret. Each admin surface must only gate its own path family.
describe('combined admin surfaces (agent-registration + linker-auth + network-registration)', () => {
  const AGENT_SECRET = 'agent-admin-secret';
  const LINKER_SECRET = 'linker-admin-secret';
  const NETWORK_SECRET = 'network-admin-secret';

  async function setup() {
    return createTestApp({
      agent_registration: { admin_secret: AGENT_SECRET },
      linker_auth: {
        capabilities: ['dht_read', 'dht_write'],
        admin_secret: LINKER_SECRET,
      },
      network_registration: { admin_secret: NETWORK_SECRET },
    });
  }

  it('agent endpoints accept the agent secret and reject the linker secret', async () => {
    const { request } = await setup();

    const withAgentSecret = await request('/v1/admin/allowed-agents', {
      headers: { Authorization: `Bearer ${AGENT_SECRET}` },
    });
    expect(withAgentSecret.status).toBe(200);

    const withLinkerSecret = await request('/v1/admin/allowed-agents', {
      headers: { Authorization: `Bearer ${LINKER_SECRET}` },
    });
    expect(withLinkerSecret.status).toBe(403);
  });

  it('linker endpoints accept the linker secret and reject the agent secret', async () => {
    const { request } = await setup();

    const withLinkerSecret = await request('/v1/admin/linkers', {
      headers: { Authorization: `Bearer ${LINKER_SECRET}` },
    });
    expect(withLinkerSecret.status).toBe(200);

    const withAgentSecret = await request('/v1/admin/linkers', {
      headers: { Authorization: `Bearer ${AGENT_SECRET}` },
    });
    expect(withAgentSecret.status).toBe(403);
  });

  it('network endpoints accept the network secret and reject the other secrets', async () => {
    const { request } = await setup();

    const withNetworkSecret = await request('/v1/admin/networks', {
      headers: { Authorization: `Bearer ${NETWORK_SECRET}` },
    });
    expect(withNetworkSecret.status).toBe(200);

    const withAgentSecret = await request('/v1/admin/networks', {
      headers: { Authorization: `Bearer ${AGENT_SECRET}` },
    });
    expect(withAgentSecret.status).toBe(403);

    const withLinkerSecret = await request('/v1/admin/networks', {
      headers: { Authorization: `Bearer ${LINKER_SECRET}` },
    });
    expect(withLinkerSecret.status).toBe(403);
  });

  it('unauthenticated requests 401 on all three surfaces', async () => {
    const { request } = await setup();

    expect((await request('/v1/admin/allowed-agents')).status).toBe(401);
    expect((await request('/v1/admin/linkers')).status).toBe(401);
    expect((await request('/v1/admin/linker-invites')).status).toBe(401);
    expect((await request('/v1/admin/networks')).status).toBe(401);
  });

  it('agent secret cannot reach linker-invites; linker secret cannot reach allowed-agents/:key delete', async () => {
    const { request } = await setup();

    const inviteWithAgentSecret = await request('/v1/admin/linker-invites', {
      headers: { Authorization: `Bearer ${AGENT_SECRET}` },
    });
    expect(inviteWithAgentSecret.status).toBe(403);

    const deleteWithLinkerSecret = await request(
      `/v1/admin/allowed-agents/${encodeURIComponent(fakeAgentKey(60))}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${LINKER_SECRET}` } },
    );
    expect(deleteWithLinkerSecret.status).toBe(403);
  });

  it('network secret cannot reach allowed-agents or linkers; other secrets cannot reach networks/:id delete', async () => {
    const { request } = await setup();

    const agentsWithNetworkSecret = await request('/v1/admin/allowed-agents', {
      headers: { Authorization: `Bearer ${NETWORK_SECRET}` },
    });
    expect(agentsWithNetworkSecret.status).toBe(403);

    const linkersWithNetworkSecret = await request('/v1/admin/linkers', {
      headers: { Authorization: `Bearer ${NETWORK_SECRET}` },
    });
    expect(linkersWithNetworkSecret.status).toBe(403);

    const deleteWithAgentSecret = await request('/v1/admin/networks/some-net', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AGENT_SECRET}` },
    });
    expect(deleteWithAgentSecret.status).toBe(403);

    const deleteWithLinkerSecret = await request('/v1/admin/networks/some-net', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${LINKER_SECRET}` },
    });
    expect(deleteWithLinkerSecret.status).toBe(403);
  });
});
