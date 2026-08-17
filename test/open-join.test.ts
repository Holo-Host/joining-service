import { describe, it, expect } from 'vitest';
import { createTestApp, fakeAgentKey, fakeDnaHash } from './helpers.js';

describe('Open join flow', () => {
  it('GET /.well-known/holo-joining returns discovery document', async () => {
    const { request } = await createTestApp();
    const res = await request('http://localhost/.well-known/holo-joining');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.joining_service_url).toBe('http://localhost/v1');
    expect(body.happ_id).toBe('test-app');
    expect(body.version).toBe('1.0');
  });

  it('GET /.well-known/holo-joining uses base_url from config', async () => {
    const { request } = await createTestApp({ base_url: 'https://app.example.com' });
    const res = await request('/.well-known/holo-joining');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.joining_service_url).toBe('https://app.example.com/v1');
  });

  it('GET /v1/info returns service info', async () => {
    const { request } = await createTestApp();
    const res = await request('/v1/info');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.happ.id).toBe('test-app');
    expect(body.happ.name).toBe('Test App');
    expect(body.auth_methods).toEqual(['open']);
    expect(body.happ_bundle_url).toBe('https://example.com/test.happ');
    expect(res.headers.get('X-Joining-Service-Version')).toBe('1.0');
  });

  it('POST /v1/join with open auth returns ready immediately', async () => {
    const { request } = await createTestApp();
    const agentKey = fakeAgentKey();

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.session).toMatch(/^js_/);
    expect(body.challenges).toBeUndefined();
  });

  it('GET /v1/join/:session/provision returns linker URLs', async () => {
    const { request } = await createTestApp();
    const agentKey = fakeAgentKey();

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    const { session } = await joinRes.json();

    const credRes = await request(`/v1/join/${session}/provision`);
    expect(credRes.status).toBe(200);

    const creds = await credRes.json();
    expect(creds.linker_urls).toEqual([{ url: 'wss://linker.example.com:8090' }]);
    expect(creds.happ_bundle_url).toBe('https://example.com/test.happ');
  });

  it('GET /v1/join/:session/status returns ready', async () => {
    const { request } = await createTestApp();
    const agentKey = fakeAgentKey();

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    const { session } = await joinRes.json();

    const statusRes = await request(`/v1/join/${session}/status`);
    expect(statusRes.status).toBe(200);
    const body = await statusRes.json();
    expect(body.status).toBe('ready');
  });

  it('rejects invalid agent key', async () => {
    const { request } = await createTestApp();

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: 'not-valid-base64!!!' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_agent_key');
  });

  it('rejects agent key with wrong length', async () => {
    const { request } = await createTestApp();
    const shortKey = `u${Buffer.from(new Uint8Array(10)).toString('base64url')}`;

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: shortKey }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_agent_key');
  });

  it('returns 409 if agent already joined', async () => {
    const { request } = await createTestApp();
    const agentKey = fakeAgentKey();

    // First join
    await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });

    // Second join
    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('agent_already_joined');
  });

  it('returns 401 for invalid session token', async () => {
    const { request } = await createTestApp();

    const res = await request('/v1/join/js_nonexistent/provision');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_session');
  });

  it('provision include membrane proofs when configured', async () => {
    const { request } = await createTestApp({
      membrane_proof: { enabled: true },
      roles: { app_role: { dna_hash: fakeDnaHash(1) } },
    });
    const agentKey = fakeAgentKey();

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    const { session } = await joinRes.json();

    const credRes = await request(`/v1/join/${session}/provision`);
    const creds = await credRes.json();

    expect(creds.roles.app_role.membrane_proof).toBeDefined();
    // Should be a base64 string
    expect(typeof creds.roles.app_role.membrane_proof).toBe('string');
  });
});
