import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestApp, fakeAgentKey } from './helpers.js';

describe('Email verification flow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'joining-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readCodeFromEmailFile(): string {
    const files = readdirSync(tmpDir).filter((f) => f.endsWith('.txt'));
    expect(files.length).toBeGreaterThan(0);

    const content = readFileSync(join(tmpDir, files[files.length - 1]), 'utf-8');
    const match = content.match(/verification code is: (\d{6})/);
    expect(match).not.toBeNull();
    return match![1];
  }

  it('full email join flow: join → verify → provision', async () => {
    const { request } = await createTestApp({
      auth_methods: ['email_code'],
      email: { provider: 'file', output_dir: tmpDir },
    });
    const agentKey = fakeAgentKey();

    // Step 1: POST /v1/join with email claim
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { email: 'test@example.com' },
      }),
    });

    expect(joinRes.status).toBe(201);
    const joinBody = await joinRes.json();
    expect(joinBody.status).toBe('pending');
    expect(joinBody.challenges).toHaveLength(1);
    expect(joinBody.challenges[0].type).toBe('email_code');
    expect(joinBody.challenges[0].description).toContain('te***@example.com');
    // expected_code should NOT be in the response
    expect(joinBody.challenges[0].metadata?.expected_code).toBeUndefined();

    const session = joinBody.session;
    const challengeId = joinBody.challenges[0].id;

    // Step 2: Read code from file
    const code = readCodeFromEmailFile();
    expect(readdirSync(tmpDir).filter((f) => !f.endsWith('.txt'))).toEqual([]);

    // Step 3: POST /v1/join/:session/verify
    const verifyRes = await request(`/v1/join/${session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challengeId,
        response: code,
      }),
    });

    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.status).toBe('ready');

    // Step 4: GET /v1/join/:session/provision
    const credRes = await request(`/v1/join/${session}/provision`);
    expect(credRes.status).toBe(200);

    const creds = await credRes.json();
    expect(creds.linker_urls).toEqual([{ url: 'wss://linker.example.com:8090' }]);
  });

  it('wrong code returns verification_failed', async () => {
    const { request } = await createTestApp({
      auth_methods: ['email_code'],
      email: { provider: 'file', output_dir: tmpDir },
    });
    const agentKey = fakeAgentKey(1);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { email: 'wrong@example.com' },
      }),
    });

    const { session, challenges } = await joinRes.json();

    const verifyRes = await request(`/v1/join/${session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challenges[0].id,
        response: '000000',
      }),
    });

    expect(verifyRes.status).toBe(422);
    const body = await verifyRes.json();
    expect(body.error.code).toBe('verification_failed');
  });

  it('provision returns 403 while session is pending', async () => {
    const { request } = await createTestApp({
      auth_methods: ['email_code'],
      email: { provider: 'file', output_dir: tmpDir },
    });
    const agentKey = fakeAgentKey(2);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { email: 'pending@example.com' },
      }),
    });

    const { session } = await joinRes.json();

    const credRes = await request(`/v1/join/${session}/provision`);
    expect(credRes.status).toBe(403);
    const body = await credRes.json();
    expect(body.error.code).toBe('not_ready');
  });

  it('status endpoint shows pending challenges', async () => {
    const { request } = await createTestApp({
      auth_methods: ['email_code'],
      email: { provider: 'file', output_dir: tmpDir },
    });
    const agentKey = fakeAgentKey(3);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { email: 'status@example.com' },
      }),
    });

    const { session } = await joinRes.json();

    const statusRes = await request(`/v1/join/${session}/status`);
    expect(statusRes.status).toBe(200);
    const body = await statusRes.json();
    expect(body.status).toBe('pending');
    expect(body.challenges).toHaveLength(1);
    expect(body.challenges[0].completed).toBe(false);
    expect(body.poll_interval_ms).toBe(2000);
  });

  it('join without email claim returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['email_code'],
      email: { provider: 'file', output_dir: tmpDir },
    });
    const agentKey = fakeAgentKey(4);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });

    expect(joinRes.status).toBe(400);
    const body = await joinRes.json();
    expect(body.error.code).toBe('missing_claims');
  });

  it('email file is written with correct format', async () => {
    const { request } = await createTestApp({
      auth_methods: ['email_code'],
      email: { provider: 'file', output_dir: tmpDir },
    });
    const agentKey = fakeAgentKey(5);

    await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { email: 'format@example.com' },
      }),
    });

    const files = readdirSync(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('format@example.com');
    expect(files[0]).toMatch(/\.txt$/);

    const content = readFileSync(join(tmpDir, files[0]), 'utf-8');
    expect(content).toContain('To: format@example.com');
    expect(content).toContain('Subject:');
    expect(content).toContain('Date:');
    expect(content).toMatch(/verification code is: \d{6}/);
  });

  it('rate limits after too many verify attempts', async () => {
    const { request } = await createTestApp({
      auth_methods: ['email_code'],
      email: { provider: 'file', output_dir: tmpDir },
    });
    const agentKey = fakeAgentKey(6);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { email: 'ratelimit@example.com' },
      }),
    });

    const { session, challenges } = await joinRes.json();
    const challengeId = challenges[0].id;

    // Attempt 6 wrong codes (limit is 5)
    for (let i = 0; i < 6; i++) {
      const res = await request(`/v1/join/${session}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: challengeId,
          response: '000000',
        }),
      });

      if (i < 5) {
        expect(res.status).toBe(422);
      } else {
        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.error.code).toBe('rate_limited');
      }
    }
  });
});
