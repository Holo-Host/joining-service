import { describe, it, expect } from 'vitest';
import { createTestApp, fakeAgentKey } from '../helpers.js';

const SECRET = 'integration-admin-secret';

describe('dynamic allowed-agent registration', () => {
  it('an agent registered via the admin API can join through agent_allow_list', async () => {
    const { request } = await createTestApp({
      auth_methods: ['agent_allow_list'],
      agent_registration: { admin_secret: SECRET },
    });
    const key = fakeAgentKey(50);

    const reg = await request('/v1/admin/allowed-agents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: key, label: 'test progenitor' }),
    });
    expect(reg.status).toBe(201);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: key }),
    });
    const body = await joinRes.json();
    expect(body.status).toBe('pending');
    expect(body.challenges[0].type).toBe('agent_allow_list');
  });

  it('admin routes are absent when agent_registration is not configured', async () => {
    const { request } = await createTestApp({ auth_methods: ['open'] });
    const res = await request('/v1/admin/allowed-agents', {
      headers: { Authorization: 'Bearer whatever' },
    });
    expect(res.status).toBe(404);
  });
});
