import { describe, it, expect } from 'vitest';
import { createTestApp, fakeAgentKey } from './helpers.js';

describe('Invite code flow', () => {
  it('valid invite code joins immediately', async () => {
    const { request } = await createTestApp({
      auth_methods: ['invite_code'],
      invite_codes: ['VALID-CODE-123', 'ANOTHER-CODE'],
    });
    const agentKey = fakeAgentKey();

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { invite_code: 'VALID-CODE-123' },
      }),
    });

    expect(joinRes.status).toBe(201);
    const body = await joinRes.json();
    expect(body.status).toBe('ready');
  });

  it('invalid invite code is rejected', async () => {
    const { request } = await createTestApp({
      auth_methods: ['invite_code'],
      invite_codes: ['VALID-CODE-123'],
    });
    const agentKey = fakeAgentKey(1);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { invite_code: 'WRONG-CODE' },
      }),
    });

    expect(joinRes.status).toBe(403);
    const body = await joinRes.json();
    expect(body.error.code).toBe('join_rejected');
  });

  it('invite code is single-use', async () => {
    const { request } = await createTestApp({
      auth_methods: ['invite_code'],
      invite_codes: ['SINGLE-USE'],
    });

    // First use — succeeds
    const res1 = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: fakeAgentKey(1),
        claims: { invite_code: 'SINGLE-USE' },
      }),
    });
    expect((await res1.json()).status).toBe('ready');

    // Second use with different agent — rejected
    const res2 = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: fakeAgentKey(2),
        claims: { invite_code: 'SINGLE-USE' },
      }),
    });
    expect(res2.status).toBe(403);
    expect((await res2.json()).error.code).toBe('join_rejected');
  });

  it('missing invite_code claim returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['invite_code'],
      invite_codes: ['CODE'],
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: fakeAgentKey(3),
        claims: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_claims');
  });

  it('provision available after invite code join', async () => {
    const { request } = await createTestApp({
      auth_methods: ['invite_code'],
      invite_codes: ['CRED-TEST'],
    });
    const agentKey = fakeAgentKey(4);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { invite_code: 'CRED-TEST' },
      }),
    });
    const { session } = await joinRes.json();

    const credRes = await request(`/v1/join/${session}/provision`);
    expect(credRes.status).toBe(200);
    const creds = await credRes.json();
    expect(creds.linker_urls).toEqual([{ url: 'wss://linker.example.com:8090' }]);
  });
});
