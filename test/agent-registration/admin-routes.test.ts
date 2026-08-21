import { describe, it, expect } from 'vitest';
import { createAdminAgentRoutes } from '../../src/routes/admin-agents.js';
import { MemoryAllowedAgentStore } from '../../src/agent-registration/index.js';
import { fakeAgentKey } from '../helpers.js';

const SECRET = 'test-admin-secret';

function setup() {
  const store = new MemoryAllowedAgentStore();
  const app = createAdminAgentRoutes(store, SECRET);
  const request = (path: string, init?: RequestInit) =>
    app.request(path, init);
  const authed = (path: string, init: RequestInit = {}) =>
    request(path, {
      ...init,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...init.headers },
    });
  return { store, request, authed };
}

describe('admin allowed-agents routes', () => {
  it('rejects requests without Authorization', async () => {
    const { request } = setup();
    const res = await request('/v1/admin/allowed-agents');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong admin secret', async () => {
    const { request } = setup();
    const res = await request('/v1/admin/allowed-agents', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(403);
  });

  describe.each([
    ['POST', '/v1/admin/allowed-agents', () => JSON.stringify({ agent_key: fakeAgentKey(50) })],
    ['DELETE', `/v1/admin/allowed-agents/${encodeURIComponent(fakeAgentKey(51))}`, undefined],
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

  it('registers an agent and lists it', async () => {
    const { authed } = setup();
    const key = fakeAgentKey(40);
    const res = await authed('/v1/admin/allowed-agents', {
      method: 'POST',
      body: JSON.stringify({ agent_key: key, label: 'acme progenitor' }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.agent_key).toBe(key);
    expect(created.registered_at).toBeTypeOf('string');

    const list = await (await authed('/v1/admin/allowed-agents')).json();
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0].label).toBe('acme progenitor');
  });

  it('preserves registered_at when re-registering an existing agent', async () => {
    const { authed, store } = setup();
    const key = fakeAgentKey(42);
    const firstRegistration = '2026-08-13T00:00:00.000Z';
    await store.put({ agent_key: key, label: 'typo', registered_at: firstRegistration });

    const res = await authed('/v1/admin/allowed-agents', {
      method: 'POST',
      body: JSON.stringify({ agent_key: key, label: 'acme progenitor' }),
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.label).toBe('acme progenitor');
    expect(updated.registered_at).toBe(firstRegistration);
    expect((await store.get(key))?.registered_at).toBe(firstRegistration);
  });

  it('stamps a fresh registered_at after an agent is unregistered', async () => {
    const { authed, store } = setup();
    const key = fakeAgentKey(43);
    await store.put({ agent_key: key, registered_at: '2026-08-13T00:00:00.000Z' });
    await authed(`/v1/admin/allowed-agents/${encodeURIComponent(key)}`, { method: 'DELETE' });

    const res = await authed('/v1/admin/allowed-agents', {
      method: 'POST',
      body: JSON.stringify({ agent_key: key }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).registered_at).not.toBe('2026-08-13T00:00:00.000Z');
  });

  it('rejects a malformed agent key with 400 invalid_agent_key', async () => {
    const { authed } = setup();
    const res = await authed('/v1/admin/allowed-agents', {
      method: 'POST',
      body: JSON.stringify({ agent_key: 'not-a-key' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_agent_key');
  });

  it('deletes a registered agent; 404 for unknown', async () => {
    const { authed, store } = setup();
    const key = fakeAgentKey(41);
    await store.put({ agent_key: key, registered_at: '2026-08-13T00:00:00.000Z' });
    const del = await authed(`/v1/admin/allowed-agents/${encodeURIComponent(key)}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await store.has(key)).toBe(false);
    const again = await authed(`/v1/admin/allowed-agents/${encodeURIComponent(key)}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});
