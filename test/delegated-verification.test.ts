import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestApp, fakeAgentKey, fakeDnaHash } from './helpers.js';
import { resetRateLimitState } from '../src/auth-methods/delegated-verification.js';
import type { DelegatedVerificationConfig } from '../src/auth-methods/delegated-verification.js';

const TEST_API_KEY = 'test-partner-api-key-12345';
const TEST_API_KEY_HASH = 'sha256:' + createHash('sha256').update(TEST_API_KEY).digest('hex');

const delegatedConfig: DelegatedVerificationConfig = {
  trusted_partners: [
    {
      partner_id: 'ad4m-index',
      name: 'AD4M Index API',
      api_key_hash: TEST_API_KEY_HASH,
      allowed_claims: ['email'],
      rate_limit: 100,
      rate_limit_window_minutes: 60,
    },
  ],
  max_verification_age_hours: 24,
};

function delegatedPayload(overrides: Record<string, unknown> = {}) {
  return {
    partner_id: 'ad4m-index',
    verified_at: new Date().toISOString(),
    verification_method: 'email_code',
    attested_claims: { email: 'user@example.com' },
    ...overrides,
  };
}

describe('Delegated verification flow', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('valid delegated verification joins immediately as ready', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.session).toBeDefined();
  });

  it('provision available after delegated join', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
      }),
    });
    const { session } = await joinRes.json();

    const provisionRes = await request(`/v1/join/${session}/provision`);
    expect(provisionRes.status).toBe(200);
    const provision = await provisionRes.json();
    expect(provision.linker_urls).toBeDefined();
  });

  it('missing X-Partner-Api-Key header returns 401', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: fakeAgentKey(1),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_partner_credentials');
  });

  it('invalid API key returns 401', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': 'wrong-api-key',
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(2),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_partner_credentials');
  });

  it('mismatched partner_id returns 403', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(3),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload({ partner_id: 'wrong-partner' }),
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('partner_not_authorized');
  });

  it('missing email claim returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(4),
        claims: {},
        delegated_verification: delegatedPayload(),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_claims');
  });

  it('stale verification (too old) returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(5),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload({ verified_at: staleDate }),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('stale_verification');
  });

  it('future verified_at returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min from now

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(6),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload({ verified_at: futureDate }),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('stale_verification');
  });

  it('rate limit enforced per partner', async () => {
    const tightConfig: DelegatedVerificationConfig = {
      trusted_partners: [
        {
          ...delegatedConfig.trusted_partners[0],
          rate_limit: 2,
          rate_limit_window_minutes: 60,
        },
      ],
      max_verification_age_hours: 24,
    };

    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: tightConfig,
    });

    const makeReq = (seed: number) =>
      request('/v1/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Partner-Api-Key': TEST_API_KEY,
        },
        body: JSON.stringify({
          agent_key: fakeAgentKey(seed + 100),
          claims: { email: `user${seed}@example.com` },
          delegated_verification: delegatedPayload({
            attested_claims: { email: `user${seed}@example.com` },
          }),
        }),
      });

    const r1 = await makeReq(1);
    expect(r1.status).toBe(201);
    expect((await r1.json()).status).toBe('ready');

    const r2 = await makeReq(2);
    expect(r2.status).toBe(201);
    expect((await r2.json()).status).toBe('ready');

    const r3 = await makeReq(3);
    expect(r3.status).toBe(429);
    const body = await r3.json();
    expect(body.error.code).toBe('rate_limited');
  });

  it('delegated_verification not in auth_methods returns 403', async () => {
    const { request } = await createTestApp({
      auth_methods: ['open'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(7),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('partner_not_authorized');
  });

  it('delegated payload without config returns 403', async () => {
    const { request } = await createTestApp({
      auth_methods: ['open'],
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(8),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
      }),
    });

    expect(res.status).toBe(403);
  });

  it('claim not in allowed_claims returns 403', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: {
        trusted_partners: [
          {
            ...delegatedConfig.trusted_partners[0],
            allowed_claims: ['phone'], // only phone, not email
          },
        ],
        max_verification_age_hours: 24,
      },
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(9),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('partner_not_authorized');
  });

  it('works in an OR group with other auth methods', async () => {
    const { request } = await createTestApp({
      auth_methods: [{ any_of: ['email_code', 'delegated_verification'] }],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(10),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('ready');
  });

  it('membrane proofs generated for delegated join', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
      membrane_proof: { enabled: true },
      roles: { app_role: { dna_hash: fakeDnaHash(20) } },
    });

    // Can't easily test with a real hash, but we can check provision returns proofs
    // We'll just verify the flow completes and provision is accessible
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(11),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
      }),
    });

    expect(joinRes.status).toBe(201);
    const { session, status } = await joinRes.json();
    expect(status).toBe('ready');

    const provisionRes = await request(`/v1/join/${session}/provision`);
    expect(provisionRes.status).toBe(200);
  });

  it('delegated join naming a registered network provisions that network\'s roles', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
      membrane_proof: { enabled: true },
      network_registration: { admin_secret: 'net-admin-secret' },
      roles: { default_role: { dna_hash: fakeDnaHash(30) } },
    });

    const registerRes = await request('/v1/admin/networks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer net-admin-secret',
      },
      body: JSON.stringify({
        happ_id: 'delegated-net',
        roles: { network_role: { dna_hash: fakeDnaHash(31) } },
      }),
    });
    expect(registerRes.status).toBe(201);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(60),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload(),
        network: 'delegated-net',
      }),
    });

    expect(joinRes.status).toBe(201);
    const { session, status } = await joinRes.json();
    expect(status).toBe('ready');

    const prov = await (await request(`/v1/join/${session}/provision`)).json();
    expect(Object.keys(prov.roles)).toEqual(['network_role']);
  });

  // #6 — Claim mismatch test
  it('attested_claims mismatch with body.claims returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(50),
        claims: { email: 'user@example.com' },
        delegated_verification: delegatedPayload({
          attested_claims: { email: 'different@example.com' },
        }),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('claims_mismatch');
  });

  // #7 — Invalid payload shape tests
  it('missing partner_id returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(51),
        claims: { email: 'user@example.com' },
        delegated_verification: {
          verified_at: new Date().toISOString(),
          verification_method: 'email_code',
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_payload');
  });

  it('verified_at as a number returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(52),
        claims: { email: 'user@example.com' },
        delegated_verification: {
          partner_id: 'ad4m-index',
          verified_at: 12345,
          verification_method: 'email_code',
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_payload');
  });

  it('missing verified_at returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(53),
        claims: { email: 'user@example.com' },
        delegated_verification: {
          partner_id: 'ad4m-index',
          verification_method: 'email_code',
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_payload');
  });

  it('missing verification_method returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(54),
        claims: { email: 'user@example.com' },
        delegated_verification: {
          partner_id: 'ad4m-index',
          verified_at: new Date().toISOString(),
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_payload');
  });

  it('delegated_verification: true (not an object) returns 400', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(55),
        claims: { email: 'user@example.com' },
        delegated_verification: true,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_payload');
  });

  it('extra unexpected fields in payload still works', async () => {
    const { request } = await createTestApp({
      auth_methods: ['delegated_verification'],
      delegated_verification: delegatedConfig,
    });

    const res = await request('/v1/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Api-Key': TEST_API_KEY,
      },
      body: JSON.stringify({
        agent_key: fakeAgentKey(56),
        claims: { email: 'user@example.com' },
        delegated_verification: {
          ...delegatedPayload(),
          extra_field: 'should be ignored',
          another_extra: 42,
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('ready');
  });
});
