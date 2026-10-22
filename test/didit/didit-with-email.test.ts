import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { HcAuthClient } from '../../src/hc-auth/client.js';
import { subjectId } from '../../src/didit/client.js';
import { FileTransport } from '../../src/email/file.js';
import { resetRateLimitState } from '../../src/auth-methods/delegated-verification.js';
import { createTestApp, fakeDnaHash } from '../helpers.js';
import { agentPubKeyFrom32, decodeHashFromBase64, encodeHashToBase64 } from '../../src/utils.js';
import type { UrlProvider } from '../../src/urls/provider.js';
import type { LinkSessionStore } from '../../src/session/store.js';
import { BASE_URL, DIDIT_SERVICE, SUBJECT_KEY, WORKFLOW_ID } from './fixtures.js';
import {
  diditApp,
  linkToken,
  postJson,
  pressContinue,
  signedJoin,
  signingAgent,
  status,
  type Agent,
  type Request,
} from './harness.js';

const EMAIL = 'Ada@Example.com';
const SUBJECT = subjectId(EMAIL, SUBJECT_KEY);
const HC = { url: 'https://auth.example.com', api_token: 'tok', required: true, forward_claims: ['email'] };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Joins, returning the session token, the link token and the join response. */
async function joined(request: Request, emails: { body: string }[], agent: Agent, email = EMAIL) {
  const res = await signedJoin(request, agent, email);
  expect(res.status).toBe(201);
  const body = await res.json();
  return { session: body.session as string, token: linkToken(emails[emails.length - 1] as never), join: body };
}

function shortKey(agentKey: string) {
  return `${agentKey.slice(0, 8)}…${agentKey.slice(-6)}`;
}

const PARTNER_KEY = 'partner-key';
const PARTNER = {
  trusted_partners: [
    {
      partner_id: 'p',
      name: 'Partner',
      api_key_hash: 'sha256:' + createHash('sha256').update(PARTNER_KEY).digest('hex'),
      allowed_claims: ['email'],
      rate_limit: 100,
      rate_limit_window_minutes: 60,
    },
  ],
};

function partnerJoin(request: Request, agentKey: string, extra: Record<string, unknown> = {}) {
  return request('/v1/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Partner-Api-Key': PARTNER_KEY },
    body: JSON.stringify({
      agent_key: agentKey,
      claims: { email: EMAIL },
      delegated_verification: {
        partner_id: 'p',
        verified_at: new Date().toISOString(),
        verification_method: 'email_code',
        attested_claims: { email: EMAIL },
      },
      ...extra,
    }),
  });
}

/** Moves the clock forward, by default past the longest read interval. */
function later(ms = 301_000) {
  vi.setSystemTime(Date.now() + ms);
}

describe('didit_with_email join', () => {
  it('emails one link under base_url, naming the network, the short agent key and the expiry, and calls no Didit', async () => {
    const { request, emails, didit } = await diditApp();
    const agent = await signingAgent();
    const { join } = await joined(request, emails, agent);

    expect(emails).toHaveLength(1);
    const [email] = emails;
    expect(email.to).toBe(EMAIL);
    expect(email.subject).toBe('Verify your identity to join Test App');
    expect(email.body).toContain(`${BASE_URL}/v1/didit/${linkToken(email)}`);
    expect(email.body).toContain(
      `This request is for the device with agent key ${shortKey(agent.agentKey)}. Continue only if that is the key shown in your app.`,
    );
    expect(email.body).toMatch(/It works until \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} UTC\./);
    expect(email.body).not.toMatch(/\b\d{6}\b/);
    expect(didit.requests).toHaveLength(0);

    expect(join.status).toBe('pending');
    expect(join.poll_interval_ms).toBe(5000);
  });

  it('fills every placeholder of a configured subject and template', async () => {
    const { request, emails } = await diditApp({
      didit: {
        ...DIDIT_SERVICE.didit!,
        email_subject: 'Join {{network}}',
        email_template: '{{network}}|{{link}}|{{expires_at}}|{{agent_key}}|{{code}}',
      },
    });
    const agent = await signingAgent();
    await joined(request, emails, agent);
    const [network, link, expires, key, untouched] = emails[0].body.split('|');
    expect(emails[0].subject).toBe('Join Test App');
    expect(network).toBe('Test App');
    expect(link).toMatch(/^https:\/\/join\.example\.com\/v1\/didit\/[A-Za-z0-9_-]{43}$/);
    expect(expires).toMatch(/UTC$/);
    expect(key).toBe(shortKey(agent.agentKey));
    expect(untouched).toBe('{{code}}');
  });

  it('shows the client exactly id, type, description, expiry, group and {state, resend_available_at}', async () => {
    const { request, emails } = await diditApp({
      auth_methods: [{ any_of: ['agent_allow_list', 'didit_with_email'] }],
    });
    const agent = await signingAgent();
    const { session, join } = await joined(request, emails, agent);

    const challenge = join.challenges.find((c: { type: string }) => c.type === 'didit_with_email');
    expect(Object.keys(challenge).sort()).toEqual(['description', 'expires_at', 'group', 'id', 'metadata', 'type']);
    expect(challenge.description).toBe('Open the link we sent to Ad***@Example.com');
    expect(Object.keys(challenge.metadata).sort()).toEqual(['resend_available_at', 'state']);
    expect(challenge.metadata.state).toBe('link_sent');

    const polled = await status(request, session);
    const shown = polled.challenges.find((c: { type: string }) => c.type === 'didit_with_email');
    expect(Object.keys(shown.metadata).sort()).toEqual(['resend_available_at', 'state']);
  });

  it.each([
    'ada@example.com, eve@example.com',
    '"Ada" <ada@example.com>',
    'ada',
    'ada@example.com/../../notes',
    'ada@\uff45xample.com',
    ['ada@example.com'],
  ])('refuses %j as the email, and sends nothing', async (email) => {
    const { request, emails } = await diditApp();
    const res = await signedJoin(request, await signingAgent(), email as string);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('missing_claims');
    expect(emails).toHaveLength(0);
  });

  it('refuses an unsigned join with an email before it sends anything', async () => {
    const { request, emails } = await diditApp();
    const agent = await signingAgent();
    const res = await postJson(request, '/v1/join', { agent_key: agent.agentKey, claims: { email: EMAIL } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('signature_required');
    expect(emails).toHaveLength(0);
  });

  it('keeps unsigned joins without an email, and partner-verified joins, as they were', async () => {
    resetRateLimitState();
    const { request, ctx } = await diditApp({
      auth_methods: [{ any_of: ['agent_allow_list', 'delegated_verification', 'didit_with_email'] }],
      delegated_verification: PARTNER,
    });
    const listed = await signingAgent();
    await ctx.allowedAgentStore!.put({ agent_key: listed.agentKey, registered_at: new Date().toISOString() });
    const allowListJoin = await postJson(request, '/v1/join', { agent_key: listed.agentKey });
    expect(allowListJoin.status).toBe(201);
    expect((await allowListJoin.json()).challenges[0].type).toBe('agent_allow_list');

    const partnered = await partnerJoin(request, (await signingAgent()).agentKey);
    expect(partnered.status).toBe(201);
    expect((await partnered.json()).status).toBe('ready');
  });

  it('keeps a pending link session when a signed join that would replace it fails at hc-auth', async () => {
    resetRateLimitState();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request, ctx, emails } = await diditApp(
      { hc_auth: HC, auth_methods: [{ any_of: ['delegated_verification', 'didit_with_email'] }], delegated_verification: PARTNER },
      new HcAuthClient(HC),
    );
    vi.spyOn(HcAuthClient.prototype, 'registerAndAuthorize').mockRejectedValue(new Error('hc-auth down'));
    const agent = await signingAgent();
    const first = await joined(request, emails, agent);
    const before = await ctx.sessionStore.get(first.session);

    expect((await partnerJoin(request, agent.agentKey, await agent.sign())).status).toBe(503);
    expect(await ctx.sessionStore.get(first.session)).toEqual(before);
    expect((await request(`/v1/didit/${first.token}`)).status).toBe(200);
  });

  it('refuses an agent key in any form but its canonical one, and sends nothing', async () => {
    const { request, emails } = await diditApp();
    const agent = await signingAgent();
    const bytes = decodeHashFromBase64(agent.agentKey);
    bytes[38] ^= 1;
    for (const agentKey of [`${agent.agentKey}=`, encodeHashToBase64(bytes)]) {
      const res = await postJson(request, '/v1/join', { agent_key: agentKey, claims: { email: EMAIL }, ...(await agent.sign()) });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_agent_key');
    }
    expect(emails).toHaveLength(0);
  });

  it('refuses a small-order agent key, for which one fixed signature verifies any timestamp', async () => {
    const { request, emails } = await diditApp();
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const signature = Buffer.from([1, ...new Array(63).fill(0)]).toString('base64');
    const res = await postJson(request, '/v1/join', {
      agent_key: encodeHashToBase64(agentPubKeyFrom32(identity)),
      claims: { email: EMAIL },
      timestamp: new Date().toISOString(),
      signature,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_agent_key');
    expect(emails).toHaveLength(0);
  });

  it('emails the address without the spaces around it', async () => {
    const { request, emails } = await diditApp();
    await joined(request, emails, await signingAgent(), `  ${EMAIL}\t`);
    expect(emails[0].to).toBe(EMAIL);
  });

  it('answers a verify that leaves the link open with the link poll interval', async () => {
    const { request, ctx, emails } = await diditApp({ auth_methods: ['agent_allow_list', 'didit_with_email'] });
    const agent = await signingAgent();
    await ctx.allowedAgentStore!.put({ agent_key: agent.agentKey, registered_at: new Date().toISOString() });
    const { session, join } = await joined(request, emails, agent);
    const nonce = join.challenges.find((c: { type: string }) => c.type === 'agent_allow_list');
    const signature = await agent.signBytes(Buffer.from(nonce.metadata.nonce, 'base64'));

    const res = await postJson(request, `/v1/join/${session}/verify`, { challenge_id: nonce.id, response: signature });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'pending', poll_interval_ms: 5000 });
  });

  it('answers 409 join_in_progress to an unsigned join over a pending link session, and changes nothing', async () => {
    const { request, ctx, emails } = await diditApp({
      auth_methods: [{ any_of: ['agent_allow_list', 'didit_with_email'] }],
    });
    const agent = await signingAgent();
    const { session } = await joined(request, emails, agent);
    const before = await ctx.sessionStore.get(session);

    const res = await postJson(request, '/v1/join', { agent_key: agent.agentKey });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('join_in_progress');
    expect(await ctx.sessionStore.get(session)).toEqual(before);
  });

  it('replaces a pending link session on a signed join, and its old link stops working', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, ctx, emails } = await diditApp();
    const agent = await signingAgent();
    const first = await joined(request, emails, agent);
    later(61_000);
    const second = await joined(request, emails, agent);

    expect(second.session).not.toBe(first.session);
    expect(await ctx.sessionStore.get(first.session)).toBeNull();
    expect((await request(`/v1/didit/${first.token}`)).status).toBe(404);
    expect((await request(`/v1/didit/${second.token}`)).status).toBe(200);

    const resumed = await postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign()) });
    expect((await resumed.json()).session).toBe(second.session);
  });

  it('leaves a pending link session and its link working when a signed join fails', async () => {
    const { request, ctx, emails } = await diditApp();
    const agent = await signingAgent();
    const first = await joined(request, emails, agent);
    const before = await ctx.sessionStore.get(first.session);

    const refused = await signedJoin(request, agent, EMAIL);
    expect(refused.status).toBe(429);
    expect(await ctx.sessionStore.get(first.session)).toEqual(before);
    expect((await request(`/v1/didit/${first.token}`)).status).toBe(200);
  });

  it('answers 503 and keeps no session when the email cannot be sent, logging no address, and lets the join retry at once', async () => {
    const { request, ctx, emails } = await diditApp();
    vi.spyOn(FileTransport.prototype, 'send').mockRejectedValueOnce(
      new Error(`Postmark API error (422): {"Message":"Invalid 'To' address: ${EMAIL}"}`),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const agent = await signingAgent();
    const res = await signedJoin(request, agent, EMAIL);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('service_unavailable');
    expect(await ctx.sessionStore.findByAgentKey(agent.agentKey)).toBeNull();
    expect(emails).toHaveLength(0);
    expect(errors.mock.calls.flat().join(' ')).toContain('Postmark API error (422)');
    expect(errors.mock.calls.flat().join(' ')).not.toContain(EMAIL);

    expect((await signedJoin(request, agent, EMAIL)).status).toBe(201);
  });

  it('answers 503 when the store cannot record the email, and sends nothing', async () => {
    const { request, ctx, emails } = await diditApp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ctx.sessionStore as LinkSessionStore, 'reserveEvents').mockRejectedValueOnce(new Error('KV write limit'));
    const res = await signedJoin(request, await signingAgent());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('service_unavailable');
    expect(emails).toHaveLength(0);
  });

  it('answers a bad email, an email limit or a mail failure inside an any_of group, unless another method admits the agent', async () => {
    const { request, ctx } = await diditApp({ auth_methods: [{ any_of: ['agent_allow_list', 'didit_with_email'] }] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = await signedJoin(request, await signingAgent(), 'ada');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('missing_claims');
    expect((await signedJoin(request, await signingAgent(), EMAIL)).status).toBe(201);

    const limited = await signedJoin(request, await signingAgent(), EMAIL);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe('rate_limited');
    expect(Number(limited.headers.get('Retry-After'))).toBeLessThanOrEqual(60);

    vi.spyOn(FileTransport.prototype, 'send').mockRejectedValueOnce(new Error('mail down'));
    const unsent = await signedJoin(request, await signingAgent(), 'grace@example.com');
    expect(unsent.status).toBe(503);

    const listed = await signingAgent();
    await ctx.allowedAgentStore!.put({ agent_key: listed.agentKey, registered_at: new Date().toISOString() });
    const admitted = await signedJoin(request, listed, EMAIL);
    expect(admitted.status).toBe(201);
    expect((await admitted.json()).challenges.map((c: { type: string }) => c.type)).toEqual(['agent_allow_list']);
  });

  it('answers verify with 422 and counts it toward the attempt limit', async () => {
    const { request, emails } = await diditApp();
    const { session, join } = await joined(request, emails, await signingAgent());
    const verify = () =>
      postJson(request, `/v1/join/${session}/verify`, { challenge_id: join.challenges[0].id, response: '123456' });

    const first = await verify();
    expect(first.status).toBe(422);
    expect((await first.json()).error.message).toBe('Open the link in the email to continue');
    for (let i = 0; i < 4; i++) await verify();
    expect((await verify()).status).toBe(429);
  });
});

describe('didit_with_email email limits', () => {
  it('refuses the sixth email to one address in 24 hours with Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, emails } = await diditApp();
    for (let i = 0; i < 5; i++) {
      expect((await signedJoin(request, await signingAgent(), EMAIL)).status).toBe(201);
      later(61_000);
    }
    const res = await signedJoin(request, await signingAgent(), ' ada@EXAMPLE.com ');
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('rate_limited');
    const retry = Number(res.headers.get('Retry-After'));
    expect(retry).toBeGreaterThan(86_400 - 6 * 61);
    expect(retry).toBeLessThanOrEqual(86_400);
    expect(emails).toHaveLength(5);
  });

  it('counts no refused email against the limits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, emails } = await diditApp();
    expect((await signedJoin(request, await signingAgent(), EMAIL)).status).toBe(201);
    later(30_000);
    expect((await signedJoin(request, await signingAgent(), EMAIL)).status).toBe(429);
    later(31_000);
    expect((await signedJoin(request, await signingAgent(), EMAIL)).status).toBe(201);
    expect(emails).toHaveLength(2);
  });

  it('answers an agent key over its limit with its own wait, saying nothing about the address', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request } = await diditApp();
    const prober = await signingAgent();
    for (let i = 0; i < 5; i++) await signedJoin(request, prober, `person${i}@example.com`);
    later(86_400_000 - 10_000);
    await signedJoin(request, await signingAgent(), EMAIL);
    later(1000);

    const res = await signedJoin(request, prober, EMAIL);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeLessThanOrEqual(9);
  });

});

describe('GET /v1/didit/{token}', () => {
  it('shows the request, the short key and Continue, and changes and calls nothing', async () => {
    const { request, ctx, emails, didit } = await diditApp();
    const agent = await signingAgent();
    const { session, token } = await joined(request, emails, agent);
    const before = await ctx.sessionStore.get(session);

    const res = await request(`/v1/didit/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Someone started joining Test App with this email address on');
    expect(html).toContain(
      `This request is for the device with agent key ${shortKey(agent.agentKey)}. Continue only if that is the key shown in your app.`,
    );
    expect(html).toContain('Did you start joining Test App? If not, close this page and do not continue.');
    expect(html).toContain('<form method="post"><button type="submit">Continue</button></form>');
    expect(html).not.toContain('<script');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");

    expect(didit.requests).toHaveLength(0);
    expect(await ctx.sessionStore.get(session)).toEqual(before);
  });

  it('answers a page, not JSON, when the store fails', async () => {
    const { request, ctx, emails } = await diditApp();
    const { token } = await joined(request, emails, await signingAgent());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ctx.sessionStore as LinkSessionStore, 'findByLinkToken').mockRejectedValue(new Error('KV down'));
    for (const res of [await request(`/v1/didit/${token}`), await pressContinue(request, token), await request(`/v1/didit/${token}/done`)]) {
      expect(res.status).toBe(503);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(await res.text()).toContain('Identity verification is not available right now.');
    }
  });

  it('answers one page for a token it does not know', async () => {
    const { request } = await diditApp();
    const res = await request(`/v1/didit/${'A'.repeat(43)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('This link is no longer valid, or this join is finished. Open the app to continue.');
  });
});

describe('POST /v1/didit/{token}', () => {
  it('creates a session for the subject id and agent key, with the done callback, and answers 303 to it', async () => {
    const { request, ctx, emails, didit } = await diditApp();
    const agent = await signingAgent();
    const { session, token } = await joined(request, emails, agent);

    const res = await pressContinue(request, token);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(didit.sessions[0].url);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

    const [create] = didit.calls('create');
    expect(create.body).toEqual({
      workflow_id: WORKFLOW_ID,
      vendor_data: SUBJECT,
      callback: `${BASE_URL}/v1/didit/${token}/done`,
      callback_method: 'both',
      metadata: { agent_key: agent.agentKey },
    });
    const stored = JSON.stringify(await ctx.sessionStore.get(session));
    expect(stored).not.toContain('SESSION-URL');
    expect(stored).not.toContain('SESSION-TOKEN');
    expect((await status(request, session)).challenges[0].metadata.state).toBe('in_progress');
  });

  it('reuses an open session without the cap, whichever key opened it', async () => {
    const { request, emails, didit } = await diditApp({ didit: { ...DIDIT_SERVICE.didit!, max_sessions_per_email: 1 } });
    const open = didit.seed({ vendor_data: SUBJECT, status: 'In Progress', metadata: { agent_key: 'uhCAkOther' } });
    const agent = await signingAgent();
    const { token } = await joined(request, emails, agent);

    const res = await pressContinue(request, token);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(open.url);
    expect(didit.sessions).toHaveLength(1);
    expect(open.metadata).toEqual({ agent_key: agent.agentKey });
  });

  it("completes from this key's earlier approval with no new session", async () => {
    const register = vi.spyOn(HcAuthClient.prototype, 'registerAndAuthorize').mockResolvedValue();
    const { request, emails, didit } = await diditApp({ hc_auth: HC }, new HcAuthClient(HC));
    const agent = await signingAgent();
    didit.seed({ vendor_data: SUBJECT, status: 'Approved', metadata: { agent_key: agent.agentKey } });
    const { session, token } = await joined(request, emails, agent);

    const res = await pressContinue(request, token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Your identity is verified. Go back to the app. It finishes joining by itself.');
    expect(didit.calls('create')).toHaveLength(0);
    expect((await status(request, session)).status).toBe('ready');
  });

  it("never completes from another key's approval, and starts a new session under the cap", async () => {
    const { request, emails, didit } = await diditApp();
    didit.seed({ vendor_data: SUBJECT, status: 'Approved', metadata: { agent_key: 'uhCAkOther' } });
    const { session, token } = await joined(request, emails, await signingAgent());

    const res = await pressContinue(request, token);
    expect(res.status).toBe(303);
    expect(didit.calls('create')).toHaveLength(1);
    expect(didit.sessions).toHaveLength(2);
    expect((await status(request, session)).status).toBe('pending');
  });

  it('takes up an in-review session of this key, and polls it slowly', async () => {
    const { request, emails, didit } = await diditApp();
    const agent = await signingAgent();
    didit.seed({ vendor_data: SUBJECT, status: 'In Review', metadata: { agent_key: agent.agentKey } });
    const { session, token } = await joined(request, emails, agent);

    const res = await pressContinue(request, token);
    expect(await res.text()).toContain('Your verification is in review. After the review, the app continues by itself.');
    expect(didit.calls('create')).toHaveLength(0);
    const polled = await status(request, session);
    expect(polled.challenges[0].metadata.state).toBe('in_review');
    expect(polled.poll_interval_ms).toBe(60_000);
  });

  it("completes from this key's older approval before another key's newer open session", async () => {
    const { request, emails, didit } = await diditApp();
    const agent = await signingAgent();
    didit.seed({ vendor_data: SUBJECT, status: 'Approved', metadata: { agent_key: agent.agentKey } });
    const open = didit.seed({ vendor_data: SUBJECT, status: 'In Progress', metadata: { agent_key: 'uhCAkOther' } });
    const { token } = await joined(request, emails, agent);

    const res = await pressContinue(request, token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Your identity is verified.');
    expect(didit.calls('create')).toHaveLength(0);
    expect(open.metadata).toEqual({ agent_key: 'uhCAkOther' });
  });

  it('makes the join ready from the Continue page itself, and still answers a page when hc-auth fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const register = vi
      .spyOn(HcAuthClient.prototype, 'registerAndAuthorize')
      .mockRejectedValueOnce(new Error('hc-auth 503'))
      .mockResolvedValue();
    const { request, ctx, emails, didit } = await diditApp({ hc_auth: HC }, new HcAuthClient(HC));
    const agent = await signingAgent();
    didit.seed({ vendor_data: SUBJECT, status: 'Approved', metadata: { agent_key: agent.agentKey } });
    const { session, token } = await joined(request, emails, agent);

    const failed = await pressContinue(request, token);
    expect(failed.status).toBe(200);
    expect(failed.headers.get('Content-Type')).toContain('text/html');
    expect((await ctx.sessionStore.get(session))!.status).toBe('pending');

    await pressContinue(request, token);
    expect(register).toHaveBeenCalledTimes(2);
    expect((await ctx.sessionStore.get(session))!.status).toBe('ready');
  });

  it('answers unavailable for a listed session of another environment, and rejects nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { request, emails, didit } = await diditApp({ didit: { ...DIDIT_SERVICE.didit!, max_sessions_per_email: 1 } });
    const agent = await signingAgent();
    didit.seed({ vendor_data: SUBJECT, status: 'Approved', environment: 'live', metadata: { agent_key: agent.agentKey } });
    const { session, token } = await joined(request, emails, agent);

    const res = await pressContinue(request, token);
    expect(res.status).toBe(503);
    expect(errors.mock.calls.flat().join(' ')).toContain('check didit.environment');
    expect((await status(request, session)).status).toBe('pending');
    expect(didit.calls('create')).toHaveLength(0);
  });

  it('rejects the join at the cap with no create, and logs why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { request, emails, didit } = await diditApp();
    for (const s of ['Declined', 'Expired', 'Abandoned']) didit.seed({ vendor_data: SUBJECT, status: s });
    const { session, token } = await joined(request, emails, await signingAgent());

    const res = await pressContinue(request, token);
    expect(res.status).toBe(403);
    expect(warn.mock.calls.flat().join(' ')).toContain('3 Didit sessions for this email reach the cap of 3');
    const text = 'This email address has no identity verification attempts left. Contact support.';
    expect(await res.text()).toContain(text);
    expect(didit.calls('create')).toHaveLength(0);
    expect(await status(request, session)).toEqual({ status: 'rejected', reason: text });
  });

  it('answers unavailable rather than rejecting at the cap when a listed session has a status it does not know', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request, emails, didit } = await diditApp();
    for (const s of ['Declined', 'Expired', 'Awaiting Payment Review']) didit.seed({ vendor_data: SUBJECT, status: s });
    const { session, token } = await joined(request, emails, await signingAgent());

    const res = await pressContinue(request, token);
    expect(res.status).toBe(503);
    expect(errors.mock.calls.flat().join(' ')).toContain('unknown status "Awaiting Payment Review"');
    expect(didit.calls('create')).toHaveLength(0);
    expect((await status(request, session)).status).toBe('pending');
  });

  it('changes nothing while Didit is unreachable', async () => {
    const { request, ctx, emails, didit } = await diditApp();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { session, token } = await joined(request, emails, await signingAgent());
    const before = await ctx.sessionStore.get(session);
    didit.down = true;

    const res = await pressContinue(request, token);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(
      'Identity verification is not available right now. Try the link again in a few minutes.',
    );
    expect(await ctx.sessionStore.get(session)).toEqual(before);
  });

  it('sends a second Continue back to the recorded open session', async () => {
    const { request, emails, didit } = await diditApp();
    const { token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);
    const again = await pressContinue(request, token);

    expect(again.status).toBe(303);
    expect(again.headers.get('Location')).toBe(didit.sessions[0].url);
    expect(didit.sessions).toHaveLength(1);
    expect(didit.calls('list')).toHaveLength(1);
  });

  it('starts a new attempt after a decline, and after Didit forgets the session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, emails, didit } = await diditApp();
    const { session, token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);
    didit.sessions[0].status = 'Declined';
    later();
    expect((await status(request, session)).challenges[0].metadata.state).toBe('declined');

    const page = await (await request(`/v1/didit/${token}`)).text();
    expect(page).toContain('Your last verification did not pass. Continue to start a new attempt.');
    expect((await pressContinue(request, token)).headers.get('Location')).toBe(didit.sessions[1].url);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    didit.sessions.splice(1, 1);
    expect((await pressContinue(request, token)).headers.get('Location')).toBe(didit.sessions[1].url);
    expect(didit.sessions).toHaveLength(2);
    expect((await status(request, session)).challenges[0].metadata.state).toBe('in_progress');
  });
});

describe('status for a didit_with_email join', () => {
  it.each([
    ['In Progress', 15_000],
    ['In Review', 60_000],
    ['Declined', 300_000],
    ['Expired', 300_000],
  ])('reads Didit at most once per interval after %s, however many polls arrive', async (diditStatus, interval) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, emails, didit } = await diditApp();
    const { session, token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);
    didit.sessions[0].status = diditStatus;
    later();
    await status(request, session);
    const reads = () => didit.calls('decision').length;
    const start = reads();

    later(interval - 1000);
    await status(request, session);
    await status(request, session);
    expect(reads()).toBe(start);
    later(1000);
    await status(request, session);
    await status(request, session);
    expect(reads()).toBe(start + 1);
  });

  it('makes the join ready on an Approved decision for this join', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const register = vi.spyOn(HcAuthClient.prototype, 'registerAndAuthorize').mockResolvedValue();
    const { request, emails, didit } = await diditApp({ hc_auth: HC }, new HcAuthClient(HC));
    const agent = await signingAgent();
    const { session, token } = await joined(request, emails, agent);
    await pressContinue(request, token);
    expect(register).not.toHaveBeenCalled();

    didit.sessions[0].status = 'Approved';
    later();
    expect((await status(request, session)).status).toBe('ready');
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][1]).toEqual({ agent_key: agent.agentKey, happ_id: 'test-app', email: EMAIL });
  });

  it.each([
    ['another workflow', 'workflow_id', { workflow_id: '99999999-2222-4333-8444-555555555555' }],
    ['another environment', 'environment', { environment: 'live' }],
  ])('never completes on a decision with %s, and keeps the session as a config fault', async (_name, field, change) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request, emails, didit } = await diditApp();
    const { session, token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);

    Object.assign(didit.sessions[0], { status: 'Approved' }, change);
    later();
    const polled = await status(request, session);
    expect(polled.status).toBe('pending');
    expect(polled.challenges[0].metadata.state).toBe('in_progress');
    expect(errors.mock.calls.flat().join(' ')).toContain(
      `has ${field} ${JSON.stringify((change as Record<string, string>)[field])}, configured `,
    );
    expect(errors.mock.calls.flat().join(' ')).toContain(`check didit.${field}`);
  });

  it.each([
    ['another agent key', { metadata: { agent_key: 'uhCAkOther' } }],
    ['an unknown status', { status: 'Approved Pending Payment' }],
  ])('never completes on a decision with %s', async (_name, change) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { request, emails, didit } = await diditApp();
    const { session, token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);

    Object.assign(didit.sessions[0], { status: 'Approved' }, change);
    later();
    const polled = await status(request, session);
    expect(polled.status).toBe('pending');
    expect(polled.challenges[0].completed).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/differs|unknown status/);
  });

  it("never completes the first key's join from a session a second key took over", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { request, emails, didit } = await diditApp();
    const first = await signingAgent();
    const second = await signingAgent();
    const a = await joined(request, emails, first);
    await pressContinue(request, a.token);
    later(61_000);
    const b = await joined(request, emails, second);

    const takeover = await pressContinue(request, b.token);
    expect(takeover.headers.get('Location')).toBe(didit.sessions[0].url);
    expect(didit.sessions).toHaveLength(1);
    expect(didit.sessions[0].metadata).toEqual({ agent_key: second.agentKey });

    didit.sessions[0].status = 'Approved';
    later();
    const firstPoll = await status(request, a.session);
    expect(firstPoll.status).toBe('pending');
    expect(firstPoll.challenges[0].metadata.state).toBe('link_sent');
    expect((await status(request, b.session)).status).toBe('ready');

    later();
    expect((await status(request, a.session)).status).toBe('pending');
  });

  it("keeps reading other joins' sessions while one session's reads fail", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request, emails, didit } = await diditApp();
    const stuck = await joined(request, emails, await signingAgent(), 'stuck@example.com');
    const other = await joined(request, emails, await signingAgent());
    await pressContinue(request, stuck.token);
    await pressContinue(request, other.token);

    didit.sessions[0].workflow_id = '99999999-2222-4333-8444-555555555555';
    didit.sessions[1].status = 'Approved';
    later();
    await status(request, stuck.session);
    expect((await status(request, other.session)).status).toBe('ready');
  });

  it('forgets a session recorded under an earlier didit.workflow_id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { request, ctx, emails, didit } = await diditApp();
    const { session, token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);
    const earlier = '99999999-2222-4333-8444-555555555555';
    const stored = (await ctx.sessionStore.get(session))!;
    stored.challenges[0].link!.attempt!.workflow_id = earlier;
    await ctx.sessionStore.update(session, { challenges: stored.challenges });
    didit.sessions[0].workflow_id = earlier;

    later();
    expect((await status(request, session)).challenges[0].metadata.state).toBe('link_sent');
    expect(warn.mock.calls.flat().join(' ')).toContain('was recorded under an earlier didit.workflow_id');
  });

  it('serves the stored state while Didit is unreachable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { request, emails, didit } = await diditApp();
    const { session, token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);
    didit.down = true;
    later();
    const polled = await status(request, session);
    expect(polled.status).toBe('pending');
    expect(polled.challenges[0].metadata.state).toBe('in_progress');

    const reads = () => didit.calls('decision').length;
    const failed = reads();
    later(14_000);
    await status(request, session);
    expect(reads()).toBe(failed);
    later(1000);
    await status(request, session);
    expect(reads()).toBe(failed + 1);
  });
});

describe('the ready path of a didit_with_email join', () => {
  it('leaves the session pending with the challenge approved when hc-auth fails, and the next status completes it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const register = vi
      .spyOn(HcAuthClient.prototype, 'registerAndAuthorize')
      .mockRejectedValueOnce(new Error('hc-auth 503'))
      .mockResolvedValue();
    const { request, ctx, emails, didit } = await diditApp({ hc_auth: HC }, new HcAuthClient(HC));
    const { session, token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);
    didit.sessions[0].status = 'Approved';
    later();

    const failed = await request(`/v1/join/${session}/status`);
    expect(failed.status).toBe(503);
    const stored = (await ctx.sessionStore.get(session))!;
    expect(stored.status).toBe('pending');
    expect(stored.challenges[0].completed).toBe(true);

    const earlier = '99999999-2222-4333-8444-555555555555';
    stored.challenges[0].link!.attempt!.workflow_id = earlier;
    await ctx.sessionStore.update(session, { challenges: stored.challenges });

    const reads = didit.calls('decision').length;
    expect((await status(request, session)).status).toBe('ready');
    expect(didit.calls('decision')).toHaveLength(reads);
    expect(register).toHaveBeenCalledTimes(2);
  });
});

describe('didit_with_email beside the rest of the ready path', () => {
  it('authorizes the agent on every linker when the join turns ready, and not before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const linkers = ['https://l1.example.com', 'https://l2.example.com'];
    const urlProvider: UrlProvider = {
      getLinkerRegistrations: async () =>
        linkers.map((url, i) => ({ linker_url: { url: `wss://l${i + 1}.example.com:8090` }, admin: { url, secret: `s${i}` } })),
      getHttpGateways: async () => undefined,
    };
    const { request, emails, didit } = await diditApp({ linker_auth: { capabilities: ['dht_read'] } }, undefined, urlProvider);
    const authorized: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.endsWith('/admin/agents')) return didit.respond(url, init ?? {});
      authorized.push(url);
      return new Response(null, { status: 204 });
    });
    const { session, token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);
    expect(authorized).toHaveLength(0);

    didit.sessions[0].status = 'Approved';
    later();
    expect((await status(request, session)).status).toBe('ready');
    expect(authorized.sort()).toEqual(linkers.map((url) => `${url}/admin/agents`));
  });

  it.each(['the admin approves first', 'Didit approves first'])(
    'completes beside hc_auth_approval when %s, and leaves authorizing the key to hc-auth',
    async (order) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const client = new HcAuthClient(HC);
      let state: 'pending' | 'authorized' = 'pending';
      vi.spyOn(client, 'getRecord').mockResolvedValueOnce(null).mockImplementation(async () => ({ state, pubKey: 'k' }));
      vi.spyOn(client, 'requestAuth').mockResolvedValue();
      const register = vi.spyOn(client, 'registerAndAuthorize').mockResolvedValue();
      const { request, emails, didit } = await diditApp({ auth_methods: ['hc_auth_approval', 'didit_with_email'], hc_auth: HC }, client);
      const { session, token } = await joined(request, emails, await signingAgent());
      await pressContinue(request, token);

      const admin = () => {
        state = 'authorized';
      };
      const diditApproves = () => {
        didit.sessions[0].status = 'Approved';
        later();
      };
      const [first, second] = order === 'the admin approves first' ? [admin, diditApproves] : [diditApproves, admin];
      first();
      expect((await status(request, session)).status).toBe('pending');
      second();
      expect((await status(request, session)).status).toBe('ready');
      expect(register).not.toHaveBeenCalled();
    },
  );

  it('names a registered network in the email and on the page, and resumes only in its scope', async () => {
    const { request, emails } = await diditApp({ network_registration: { admin_secret: 'net-admin' } });
    const registered = await request('/v1/admin/networks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer net-admin' },
      body: JSON.stringify({ happ_id: 'acme-net', happ: { name: 'Acme' }, roles: { main: { dna_hash: fakeDnaHash(2) } } }),
    });
    expect(registered.status).toBe(201);
    const agent = await signingAgent();
    const join = await signedJoin(request, agent, EMAIL, { network: 'acme-net' });
    expect(join.status).toBe(201);
    const { session } = await join.json();

    expect(emails[0].subject).toBe('Verify your identity to join Acme');
    expect(await (await request(`/v1/didit/${linkToken(emails[0])}`)).text()).toContain('Someone started joining Acme');
    const resume = async (extra: Record<string, unknown>) =>
      postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign()), ...extra });
    expect((await (await resume({ network: 'acme-net' })).json()).session).toBe(session);
    expect((await resume({})).status).toBe(404);
  });
});

describe('POST /v1/join/resume for a didit_with_email join', () => {
  it('returns the refreshed challenge, and never emails or creates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, emails, didit } = await diditApp();
    const agent = await signingAgent();
    const { session, token } = await joined(request, emails, agent);
    await pressContinue(request, token);
    didit.sessions[0].status = 'In Review';
    later();

    const res = await postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign()) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBe(session);
    expect(body.challenges[0].metadata.state).toBe('in_review');
    expect(body.poll_interval_ms).toBe(60_000);
    expect(emails).toHaveLength(1);
    expect(didit.calls('create')).toHaveLength(1);
  });

});

describe('GET /v1/didit/{token}/done', () => {
  it.each([
    ['In Progress', 'Your verification is still in progress. Go back to the app. It continues by itself.'],
    ['In Review', 'Your verification is in review. After the review, the app continues by itself.'],
    ['Declined', 'Your verification did not pass. To try again, open the link in your email again.'],
    ['Expired', 'Your verification did not pass. To try again, open the link in your email again.'],
    [undefined, 'We could not find your verification. To start again, open the link in your email and press Continue.'],
  ])('shows where a %s verification stands', async (didStatus, text) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { request, emails, didit } = await diditApp();
    const { token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);
    if (didStatus) didit.sessions[0].status = didStatus;
    else didit.sessions.splice(0, 1);
    later();
    const res = await request(`/v1/didit/${token}/done?verificationSessionId=forged&status=Approved`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(text);
  });

  it('completes the join on approval, whatever its query string says', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, ctx, emails, didit } = await diditApp();
    const { session, token } = await joined(request, emails, await signingAgent());
    await pressContinue(request, token);

    const early = await request(`/v1/didit/${token}/done?status=Approved`);
    expect(await early.text()).toContain('still in progress');
    expect((await status(request, session)).status).toBe('pending');

    didit.sessions[0].status = 'Approved';
    later();
    const res = await request(`/v1/didit/${token}/done?status=Declined`);
    expect(await res.text()).toContain('Your identity is verified. Go back to the app. It finishes joining by itself.');
    expect((await ctx.sessionStore.get(session))!.status).toBe('ready');
  });
});

describe('POST /v1/join/{session}/resend', () => {
  it('emails a new link after the interval, and every link keeps working', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, emails } = await diditApp();
    const { session, token, join } = await joined(request, emails, await signingAgent());
    const challenge_id = join.challenges[0].id;

    later(61_000);
    const res = await postJson(request, `/v1/join/${session}/resend`, { challenge_id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('pending');
    expect(Date.parse(body.challenges[0].metadata.resend_available_at)).toBe(Date.now() + 60_000);
    expect(emails).toHaveLength(2);

    const fresh = linkToken(emails[1]);
    expect(fresh).not.toBe(token);
    expect((await request(`/v1/didit/${token}`)).status).toBe(200);
    expect((await request(`/v1/didit/${fresh}`)).status).toBe(200);
  });

  it('answers 401, 404, 429 and 503 as the contract says', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request, emails } = await diditApp();
    const { session, join } = await joined(request, emails, await signingAgent());
    const challenge_id = join.challenges[0].id;
    const resend = (id: string, body: unknown) => postJson(request, `/v1/join/${id}/resend`, body);

    expect((await resend('js_unknown', { challenge_id })).status).toBe(401);
    expect((await resend(session, { challenge_id: 'ch_other' })).status).toBe(404);
    const limited = await resend(session, { challenge_id });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');

    later(61_000);
    vi.spyOn(FileTransport.prototype, 'send').mockRejectedValueOnce(new Error('mail down'));
    expect((await resend(session, { challenge_id })).status).toBe(503);

    later(604_800_000);
    expect((await resend(session, { challenge_id })).status).toBe(401);
  });

});

describe('didit_with_email leaks nothing', () => {
  it('puts no token, hash, Didit id or subject id in a response, and no Didit body, URL or token in a log', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lines: unknown[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        lines.push(...args.map(String));
      });
    }
    const { request, ctx, emails, didit } = await diditApp({
      auth_methods: [{ any_of: ['agent_allow_list', 'didit_with_email'] }],
    });
    const agent = await signingAgent();
    const bodies: string[] = [];
    const keep = async (res: Response) => {
      bodies.push(await res.clone().text());
      return res;
    };

    const join = await keep(await signedJoin(request, agent));
    const { session } = await join.json();
    const token = linkToken(emails[0]);
    await keep(await request(`/v1/didit/${token}`));
    await keep(await pressContinue(request, token));
    await keep(await request(`/v1/join/${session}/status`));
    didit.sessions[0].status = 'In Review';
    later();
    await keep(await request(`/v1/didit/${token}/done`));
    await keep(await postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign()) }));
    await keep(await postJson(request, `/v1/join/${session}/resend`, { challenge_id: 'none' }));
    didit.sessions[0].metadata = { agent_key: 'uhCAkOther' };
    later();
    await keep(await request(`/v1/join/${session}/status`));
    didit.down = true;
    await keep(await pressContinue(request, token));

    const stored = (await ctx.sessionStore.get(session))!;
    const link = stored.challenges.find((cs) => cs.link)!.link!;
    const secrets = [token, ...link.token_hashes, didit.sessions[0].session_id, SUBJECT];
    for (const body of bodies) {
      for (const secret of secrets) expect(body).not.toContain(secret);
    }

    const logged = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of ['SESSION-URL', 'SESSION-TOKEN', 'didit-test-key', 'Ada Lovelace', token, SUBJECT]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('didit_with_email beside other stores', () => {
  it('is absent from a service that does not configure it', async () => {
    const { request } = await createTestApp({ didit: DIDIT_SERVICE.didit });
    expect((await request(`/v1/didit/${'A'.repeat(43)}`)).status).toBe(404);
    const agent = await signingAgent();
    const res = await postJson(request, '/v1/join', { agent_key: agent.agentKey, claims: { email: EMAIL } });
    expect(res.status).toBe(201);
    const unclaimed = await postJson(request, '/v1/join', { agent_key: (await signingAgent()).agentKey, claims: null });
    expect(unclaimed.status).toBe(201);
  });
});
