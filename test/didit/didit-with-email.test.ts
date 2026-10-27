import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { HcAuthClient } from '../../src/hc-auth/client.js';
import { subjectId } from '../../src/didit/client.js';
import { FileTransport } from '../../src/email/file.js';
import { resetRateLimitState } from '../../src/auth-methods/delegated-verification.js';
import { DiditWithEmailAuthMethod, NO_ATTEMPTS_LEFT } from '../../src/auth-methods/didit-with-email.js';
import { TEXT, linkPages } from '../../src/auth-methods/didit-with-email-pages.js';
import { renderLinkEmail } from '../../src/auth-methods/didit-with-email-mail.js';
import { createTestApp, fakeDnaHash, smallOrderSigned } from '../helpers.js';
import { decodeHashFromBase64, encodeHashToBase64 } from '../../src/utils.js';
import type { ServiceConfig } from '../../src/config.js';
import type { UrlProvider } from '../../src/urls/provider.js';
import type { LinkSessionStore } from '../../src/session/store.js';
import type { DiditWithEmailState } from '../../src/types.js';
import type { FakeDidit, FakeSession } from './fake-didit.js';
import { BASE_URL, DIDIT_SERVICE, SUBJECT_KEY, WORKFLOW_ID } from './fixtures.js';
import {
  diditApp,
  joinMessage,
  linkToken,
  postJson,
  pressContinue,
  resumeMessage,
  signedJoin,
  signingAgent,
  status,
  type Agent,
  type Request,
  type SentEmail,
} from './harness.js';

const EMAIL = 'Ada@Example.com';
const SUBJECT = subjectId(EMAIL, SUBJECT_KEY);
const HC = { url: 'https://auth.example.com', api_token: 'tok', required: true, forward_claims: ['email'] };
const OTHER_WORKFLOW = '99999999-2222-4333-8444-555555555555';
const VERIFIED = 'Your identity is verified. Go back to the app. It finishes joining by itself.';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

async function joined(request: Request, emails: SentEmail[], agent: Agent, email = EMAIL) {
  const res = await signedJoin(request, agent, email);
  expect(res.status).toBe(201);
  const body = await res.json();
  return { session: body.session as string, token: linkToken(emails[emails.length - 1]), join: body };
}

async function joinedApp(overrides: Partial<ServiceConfig> = {}, hcAuthClient?: HcAuthClient) {
  const app = await diditApp(overrides, hcAuthClient);
  const agent = await signingAgent();
  return { ...app, agent, ...(await joined(app.request, app.emails, agent)) };
}

function captureLogs(levels: ('log' | 'warn' | 'error' | 'info' | 'debug')[] = ['warn', 'error']): string[] {
  const lines: string[] = [];
  for (const level of levels) {
    vi.spyOn(console, level).mockImplementation((...args) => {
      lines.push(...args.map(String));
    });
  }
  return lines;
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

function donePath(didit: FakeDidit): string {
  return new URL(didit.calls('create')[0].body!.callback as string).pathname;
}

/** Moves the clock forward, by default past the longest read interval. */
function later(ms = 301_000) {
  vi.setSystemTime(Date.now() + ms);
}

function linkersAt(urls: string[]): UrlProvider {
  return {
    getLinkerRegistrations: async () =>
      urls.map((url, i) => ({ linker_url: { url: `wss://l${i + 1}.example.com:8090` }, admin: { url, secret: `s${i}` } })),
    getHttpGateways: async () => undefined,
  };
}

describe('didit_with_email join', () => {
  it('emails one link under base_url to the trimmed address, naming the network, the full agent key and the expiry, and calls no Didit', async () => {
    const { request, emails, didit } = await diditApp();
    const agent = await signingAgent();
    const { join } = await joined(request, emails, agent, `  ${EMAIL}\t`);

    expect(emails).toHaveLength(1);
    const [email] = emails;
    expect(email.to).toBe(EMAIL);
    expect(email.subject).toBe('Verify your identity to join Test App');
    expect(email.body).toContain(`${BASE_URL}/v1/didit/${linkToken(email)}`);
    expect(email.body).toContain('Request to verify your identity to join Test App with this email address.');
    expect(email.body).toContain(
      `For the device with this agent key:\n${agent.agentKey}\nContinue only if that is the key shown in your app.`,
    );
    expect(email.body).toMatch(/It works until \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} UTC\./);
    expect(email.body).not.toMatch(/\b\d{6}\b/);
    expect(email.senderName).toBe('Test App');
    expect(email.html).toContain(`user-select:all">${agent.agentKey}</p>`);
    expect(email.html).toContain(`>${BASE_URL}/v1/didit/${linkToken(email)}</a>`);
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
    expect(key).toBe(agent.agentKey);
    expect(untouched).toBe('{{code}}');
  });

  it('shows the client exactly id, type, description, expiry, group and {state, resend_available_at}', async () => {
    const { request, session, join } = await joinedApp({
      auth_methods: [{ any_of: ['agent_allow_list', 'didit_with_email'] }],
    });

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
    'ada@ｅxample.com',
    ['ada@example.com'],
  ])('refuses %j as the email, and sends nothing', async (email) => {
    const { request, emails } = await diditApp();
    const res = await signedJoin(request, await signingAgent(), email as string);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('missing_claims');
    expect(emails).toHaveLength(0);
  });

  it('sends no email, and counts none toward its limits, for a join another method refuses or another method already meets its group, and keeps the invite code of a join whose email fails', async () => {
    const { request, emails } = await diditApp({ auth_methods: ['didit_with_email', 'invite_code'], invite_codes: ['GOOD'] });
    captureLogs();
    const agent = await signingAgent();
    const join = (invite_code: string) => signedJoin(request, agent, EMAIL, { claims: { email: EMAIL, invite_code } });

    expect((await join('BAD')).status).toBe(403);
    vi.spyOn(FileTransport.prototype, 'send').mockRejectedValueOnce(new Error('mail down'));
    expect((await join('GOOD')).status).toBe(503);
    expect(emails).toHaveLength(0);
    expect((await join('GOOD')).status).toBe(201);
    expect(emails).toHaveLength(1);

    const grouped = await diditApp({ auth_methods: [{ any_of: ['didit_with_email', 'invite_code'] }], invite_codes: ['GOOD'] });
    const admitted = await signedJoin(grouped.request, await signingAgent(), EMAIL, { claims: { email: EMAIL, invite_code: 'GOOD' } });
    expect((await admitted.json()).status).toBe('ready');
    expect(grouped.emails).toHaveLength(0);
  });

  it('refuses an unsigned join with an email, and keeps unsigned joins without one and partner-verified joins as they were, even over a pending link session', async () => {
    resetRateLimitState();
    const { request, ctx, emails } = await diditApp({
      auth_methods: [{ any_of: ['agent_allow_list', 'delegated_verification', 'didit_with_email'] }],
      delegated_verification: PARTNER,
    });
    const listed = await signingAgent();
    const unsigned = await postJson(request, '/v1/join', { agent_key: listed.agentKey, claims: { email: EMAIL } });
    expect(unsigned.status).toBe(400);
    expect((await unsigned.json()).error.code).toBe('signature_required');
    expect(emails).toHaveLength(0);

    await ctx.allowedAgentStore!.put({ agent_key: listed.agentKey, registered_at: new Date().toISOString() });
    const allowListJoin = await postJson(request, '/v1/join', { agent_key: listed.agentKey });
    expect(allowListJoin.status).toBe(201);
    expect((await allowListJoin.json()).challenges[0].type).toBe('agent_allow_list');

    const linked = await signingAgent();
    const { session } = await joined(request, emails, linked);
    const partnered = await partnerJoin(request, linked.agentKey);
    expect(partnered.status).toBe(201);
    expect((await partnered.json()).status).toBe('ready');
    expect(await ctx.sessionStore.get(session)).toBeNull();
  });

  it.each([
    ['an unsigned join', 409, 'join_in_progress', (request: Request, agent: Agent) => postJson(request, '/v1/join', { agent_key: agent.agentKey })],
    ['a signed join with another email over the email limit', 429, 'rate_limited', (request: Request, agent: Agent) => signedJoin(request, agent, 'grace@example.com')],
    [
      'a signed partner join that fails at hc-auth',
      503,
      'service_unavailable',
      async (request: Request, agent: Agent) => partnerJoin(request, agent.agentKey, await agent.sign(joinMessage(EMAIL))),
    ],
  ])('keeps a pending link session and its link working when %s is refused', async (_name, code, error, refused) => {
    resetRateLimitState();
    captureLogs();
    vi.spyOn(HcAuthClient.prototype, 'registerAndAuthorize').mockRejectedValue(new Error('hc-auth down'));
    const { request, ctx, agent, session, token } = await joinedApp(
      {
        hc_auth: HC,
        auth_methods: [{ any_of: ['agent_allow_list', 'delegated_verification', 'didit_with_email'] }],
        delegated_verification: PARTNER,
        didit: { ...DIDIT_SERVICE.didit!, max_emails_per_agent: 1 },
      },
      new HcAuthClient(HC),
    );
    const before = await ctx.sessionStore.get(session);

    const res = await refused(request, agent);
    expect(res.status).toBe(code);
    expect((await res.json()).error.code).toBe(error);
    expect(await ctx.sessionStore.get(session)).toEqual(before);
    expect((await request(`/v1/didit/${token}`)).status).toBe(200);
  });

  it.each([
    ['with padding', async (agent: Agent) => ({ agent_key: `${agent.agentKey}=`, ...(await agent.sign(joinMessage(EMAIL))) })],
    [
      'with a changed DHT location',
      async (agent: Agent) => {
        const bytes = decodeHashFromBase64(agent.agentKey);
        bytes[38] ^= 1;
        return { agent_key: encodeHashToBase64(bytes), ...(await agent.sign(joinMessage(EMAIL))) };
      },
    ],
    ['of small order, for which one fixed signature verifies any message', async () => smallOrderSigned()],
  ])('refuses an agent key %s, and sends nothing', async (_name, body) => {
    const { request, emails } = await diditApp();
    const res = await postJson(request, '/v1/join', { claims: { email: EMAIL }, ...(await body(await signingAgent())) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_signature');
    expect(emails).toHaveLength(0);
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

  it('gives a signed join with the email of the pending link session, in any letter case, that session as resume does, and replaces it on another email, whose old link stops working', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, ctx, emails, didit, agent, ...first } = await joinedApp();
    await pressContinue(request, first.token);
    didit.sessions[0].status = 'In Review';
    later();
    const reserve = vi.spyOn(ctx.sessionStore as LinkSessionStore, 'reserveEvents');
    const resume = async () => postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign(resumeMessage)) });

    const unsigned = await postJson(request, '/v1/join', { agent_key: agent.agentKey, claims: { email: EMAIL }, delegated_verification: {} });
    expect(unsigned.status).toBe(403);
    const same = await signedJoin(request, agent, ' ada@EXAMPLE.com ');
    expect(same.status).toBe(200);
    expect(emails).toHaveLength(1);
    expect(reserve.mock.calls.flatMap(([keys]) => keys).filter((key) => /^didit_(email|agent):/.test(key))).toEqual([]);
    const back = await same.json();
    expect(back).toMatchObject({ session: first.session, challenges: [{ metadata: { state: 'in_review' } }] });
    expect(back).toEqual(await (await resume()).json());

    const second = await joined(request, emails, agent, 'grace@example.com');
    expect(second.session).not.toBe(first.session);
    expect(await ctx.sessionStore.get(first.session)).toBeNull();
    const old = await request(`/v1/didit/${first.token}`);
    expect(old.status).toBe(404);
    expect(await old.text()).toContain('This link is no longer valid, or this join is finished. Open the app to continue.');
    expect((await request(`/v1/didit/${second.token}`)).status).toBe(200);

    expect((await (await resume()).json()).session).toBe(second.session);
  });

  it.each([
    [
      'the email cannot be sent, logging no address',
      `Postmark API error (422): {"Message":"Invalid 'To' address: ${EMAIL}"}`,
      'Postmark API error (422)',
      () => vi.spyOn(FileTransport.prototype, 'send'),
    ],
    ['the store cannot record the email', 'KV write limit', 'KV write limit', (store: LinkSessionStore) => vi.spyOn(store, 'reserveEvents')],
  ])('answers 503 and keeps no session when %s, and lets the join retry at once', async (_name, message, logged, fail) => {
    const { request, ctx, emails } = await diditApp();
    fail(ctx.sessionStore as LinkSessionStore).mockRejectedValueOnce(new Error(message));
    const lines = captureLogs();
    const agent = await signingAgent();
    const res = await signedJoin(request, agent, EMAIL);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('service_unavailable');
    expect(await ctx.sessionStore.findByAgentKey(agent.agentKey)).toBeNull();
    expect(emails).toHaveLength(0);
    expect(lines.join('\n')).toContain(logged);
    expect(lines.join('\n')).not.toContain(EMAIL);

    expect((await signedJoin(request, agent, EMAIL)).status).toBe(201);
  });

  it('answers a bad email, an email limit or a mail failure inside an any_of group, unless another method admits the agent, and lets an unexpected error through even then', async () => {
    const { request, ctx } = await diditApp({ auth_methods: [{ any_of: ['agent_allow_list', 'didit_with_email'] }] });
    captureLogs();
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
    vi.spyOn(DiditWithEmailAuthMethod.prototype, 'sendFirst').mockRejectedValueOnce(new TypeError('a bug'));
    expect((await signedJoin(request, listed, EMAIL)).status).toBe(500);
    const admitted = await signedJoin(request, listed, EMAIL);
    expect(admitted.status).toBe(201);
    expect((await admitted.json()).challenges.map((c: { type: string }) => c.type)).toEqual(['agent_allow_list']);
  });

  it('answers verify with 422 and counts it toward the attempt limit', async () => {
    const { request, session, join } = await joinedApp();
    const verify = () =>
      postJson(request, `/v1/join/${session}/verify`, { challenge_id: join.challenges[0].id, response: '123456' });

    const first = await verify();
    expect(first.status).toBe(422);
    expect((await first.json()).error.message).toBe('Open the link in the email to continue');
    for (let i = 0; i < 4; i++) await verify();
    expect((await verify()).status).toBe(429);
  });
});

describe('the didit_with_email email', () => {
  it('escapes every value and the template, sets the first paragraph bold and a last one without the button small, wraps long words, and makes a line holding only the link a button over the URL and one holding only the key a selectable box', () => {
    const link = 'https://join.example.com/v1/didit/a&b';
    const href = 'https://join.example.com/v1/didit/a&#38;b';
    const { subject, text, html } = renderLinkEmail(
      'Ada & Co',
      {
        email_subject: 'Join <i>{{network}}</i>',
        email_template: '<b>Hi</b> {{network}}, key {{agent_key}}\n{{link}}\n\n{{agent_key}}\n\nUntil {{expires_at}}. See {{link}}',
      },
      { network: '<img src=x>', link, expires_at: '1 May', agent_key: '"key"' },
    );
    expect(subject).toBe('Join <i><img src=x></i>');
    expect(text).toBe(`<b>Hi</b> <img src=x>, key "key"\n${link}\n\n"key"\n\nUntil 1 May. See ${link}`);
    expect(html).not.toMatch(/<(i|b|img|script)\b/);
    expect(html).toContain('>Ada &#38; Co</p>');
    expect(html).toContain('>Join &#60;i&#62;&#60;img src=x&#62;&#60;/i&#62;</h1>');
    expect(html).toContain('font-weight:600;color:#ffffff">&#60;b&#62;Hi&#60;/b&#62; &#60;img src=x&#62;, key &#34;key&#34;</p>');
    expect(html).toContain('user-select:all">&#34;key&#34;</p>');
    expect(html.match(/>Verify your identity<\/a>/g)).toHaveLength(1);
    expect(html.match(new RegExp(`<a href="${href}"`, 'g'))).toHaveLength(2);
    expect(html).toContain(`>${href}</a></p>`);
    expect(html).toContain(`font-size:13px;line-height:20px;color:#8e8e93">Until 1 May. See ${href}</p>`);

    const endsOnButton = renderLinkEmail('A', { email_template: 'Hi\n\nOpen it:\n{{link}}' }, { network: 'N', link, expires_at: '1 May', agent_key: 'k' });
    expect(endsOnButton.html).toContain('color:#bbbbbc;overflow-wrap:anywhere;word-break:break-word">Open it:</p>');
  });
});

describe('didit_with_email email limits', () => {
  it('refuses the sixth email to one address in 24 hours with Retry-After, counting no refused email', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, emails } = await diditApp();
    for (let i = 0; i < 5; i++) {
      expect((await signedJoin(request, await signingAgent(), EMAIL)).status).toBe(201);
      later(30_000);
      expect((await signedJoin(request, await signingAgent(), EMAIL)).status).toBe(429);
      later(31_000);
    }
    const res = await signedJoin(request, await signingAgent(), ' ada@EXAMPLE.com ');
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('rate_limited');
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
    const retry = Number(res.headers.get('Retry-After'));
    expect(retry).toBeGreaterThan(86_400 - 6 * 61);
    expect(retry).toBeLessThanOrEqual(86_400);
    expect(emails).toHaveLength(5);
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
  it('shows the request first, the full key with a Copy button that only the script shows, Continue and the caution, and changes and calls nothing', async () => {
    const { request, ctx, didit, agent, session, token } = await joinedApp();
    const before = await ctx.sessionStore.get(session);

    const res = await request(`/v1/didit/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<h1>Identity verification</h1>\n<p class="lead">Request to verify your identity to join Test App with this email address.</p>',
    );
    expect(html).toContain(`<code id="key">${agent.agentKey}</code><button type="button" id="copy" aria-live="polite" hidden>Copy</button>`);
    expect(html).toContain('<p>Continue only if that is the key shown in your app.</p>');
    expect(html).toContain('<form method="post"><button type="submit">Continue</button></form>');
    expect(html).toContain('<p class="caution">If you did not start this, close this page and do not continue.</p>');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");

    expect(didit.requests).toHaveLength(0);
    expect(await ctx.sessionStore.get(session)).toEqual(before);
  });

  it('answers a page, not JSON, when the store fails', async () => {
    const { request, ctx, token } = await joinedApp();
    captureLogs();
    vi.spyOn(ctx.sessionStore as LinkSessionStore, 'findByLinkHash').mockRejectedValue(new Error('KV down'));
    const done = `/v1/didit/done/${'d'.repeat(43)}`;
    for (const res of [await request(`/v1/didit/${token}`), await pressContinue(request, token), await request(done)]) {
      expect(res.status).toBe(503);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(await res.text()).toContain('Identity verification is not available right now.');
    }
  });
});

describe('link pages', () => {
  const landing = { network: 'Test App', agentKey: `uhCAk${'a'.repeat(48)}` };

  it('shows each page as one card under happ.name and the heading, with one CSP and no remote resource, Copy on every landing page and Continue only where it can continue', async () => {
    const pages = linkPages('Ada & <Co>');
    const states: DiditWithEmailState[] = ['link_sent', 'in_progress', 'in_review', 'approved', 'declined', 'expired'];
    const shown = [
      ...states.map((state) => [pages.landing({ ...landing, state }), state === 'in_review' || state === 'approved' ? 1 : 2, 1] as const),
      ...states.map((state) => [pages.done(state), 0, 0] as const),
      ...Object.values(TEXT).map((text) => [pages.message(text, 503), 0, 0] as const),
    ];
    const csp = pages.landing({ ...landing, state: 'link_sent' }).headers.get('Content-Security-Policy');
    for (const [res, buttons, scripts] of shown) {
      const html = await res.text();
      expect(html).toContain('<p class="app">Ada &#38; &#60;Co&#62;</p>\n<h1>Identity verification</h1>\n<p class="lead">');
      expect(html.match(/<button/g) ?? []).toHaveLength(buttons);
      expect(html.match(/<script>/g) ?? []).toHaveLength(scripts);
      expect(html.replace(/<script>.*?<\/script>/s, '')).not.toMatch(/<script|https?:|url\(|src=|href=/i);
      expect(res.headers.get('Content-Security-Policy')).toBe(csp);
    }
  });

  it('allows through the CSP only the hash of the inline script', async () => {
    const res = linkPages('Test App').landing({ ...landing, state: 'link_sent' });
    const [script] = (await res.text()).match(/(?<=<script>).*?(?=<\/script>)/s)!;
    const hash = createHash('sha256').update(script).digest('base64');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; frame-ancestors 'none'`,
    );
  });
});

describe('POST /v1/didit/{token}', () => {
  it('creates a session for the subject id and agent key, with a done callback that cannot Continue, and answers 303 to it', async () => {
    const { request, ctx, didit, agent, session, token } = await joinedApp();

    const res = await pressContinue(request, token);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(didit.sessions[0].url);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

    const [create] = didit.calls('create');
    expect(create.body).toEqual({
      workflow_id: WORKFLOW_ID,
      vendor_data: SUBJECT,
      callback: expect.stringMatching(/\/v1\/didit\/done\/[A-Za-z0-9_-]{43}$/),
      callback_method: 'both',
      metadata: { agent_key: agent.agentKey },
    });
    expect(create.body!.callback).toBe(`${BASE_URL}${donePath(didit)}`);
    const credential = donePath(didit).split('/').pop()!;
    for (const res of [await request(`/v1/didit/${credential}`), await pressContinue(request, credential), await request(`/v1/didit/${token}/done`)]) {
      expect(res.status).toBe(404);
    }
    const stored = JSON.stringify(await ctx.sessionStore.get(session));
    expect(stored).not.toContain('SESSION-URL');
    expect(stored).not.toContain('SESSION-TOKEN');
    expect((await status(request, session)).challenges[0].metadata.state).toBe('in_progress');
  });

  const capText = 'This email address has no identity verification attempts left. Contact support.';
  type Seed = [status: string, by?: 'own' | 'other', extra?: Partial<FakeSession>];
  type Outcome = { seeds: Seed[]; max?: number; code: number; creates?: number; polled: { status: string; [field: string]: unknown }; says?: string; logged?: string };
  it.each<[string, Outcome]>([
    ["this key's approval", { seeds: [['Approved', 'own']], code: 200, polled: { status: 'ready' }, says: VERIFIED }],
    ["another key's approval", { seeds: [['Approved', 'other']], code: 303, creates: 1, polled: { status: 'pending' } }],
    [
      "another key's session in progress",
      {
        seeds: [['In Progress', 'other']],
        code: 409,
        polled: { status: 'pending', challenges: [{ metadata: { state: 'link_sent' } }] },
        says: 'Another device is verifying this email. Finish there, or try again when it ends.',
        logged: "another key's verification under way",
      },
    ],
    [
      "this key's session in progress",
      { seeds: [['In Progress', 'own']], code: 303, creates: 1, polled: { status: 'pending', challenges: [{ metadata: { state: 'in_progress' } }] } },
    ],
    [
      "this key's session in review",
      {
        seeds: [['In Review', 'own']],
        code: 200,
        polled: { status: 'pending', challenges: [{ metadata: { state: 'in_review' } }] },
        says: 'Your verification is in review. After the review, the app continues by itself.',
      },
    ],
    [
      "this key's older approval before another key's newer open session",
      { seeds: [['Approved', 'own'], ['In Progress', 'other']], code: 200, polled: { status: 'ready' }, says: VERIFIED },
    ],
    [
      'a listed session of another environment at the cap',
      { seeds: [['Approved', 'own', { environment: 'live' }]], max: 1, code: 503, polled: { status: 'pending' }, logged: 'check didit.environment' },
    ],
    [
      'three ended sessions at the cap',
      {
        seeds: [['Declined'], ['Expired'], ['Abandoned']],
        code: 403,
        polled: { status: 'rejected', reason: capText },
        says: capText,
        logged: '3 Didit sessions for this email reach the cap of 3',
      },
    ],
    [
      'a listed status it does not know at the cap',
      {
        seeds: [['Declined'], ['Expired'], ['Awaiting Payment Review']],
        code: 503,
        polled: { status: 'pending' },
        logged: 'unknown status "Awaiting Payment Review"',
      },
    ],
  ])('answers Continue over %s', async (_name, { seeds, max, code, creates = 0, polled, says, logged }) => {
    const lines = captureLogs();
    const register = vi.spyOn(HcAuthClient.prototype, 'registerAndAuthorize').mockResolvedValue();
    const didit = max ? { ...DIDIT_SERVICE.didit!, max_sessions_per_email: max } : DIDIT_SERVICE.didit;
    const app = await joinedApp({ hc_auth: HC, didit }, new HcAuthClient(HC));
    const owner = { own: app.agent.agentKey, other: 'uhCAkOther' };
    const seeded = seeds.map(([s, by, extra]) =>
      app.didit.seed({ vendor_data: SUBJECT, status: s, metadata: by ? { agent_key: owner[by] } : null, ...extra }),
    );
    const metadata = structuredClone(seeded.map((s) => s.metadata));

    const res = await pressContinue(app.request, app.token);
    expect(res.status).toBe(code);
    if (code === 303) expect(res.headers.get('Location')).toBe(app.didit.sessions.at(-1)!.url);
    if (says) expect(await res.text()).toContain(says);
    if (logged) expect(lines.join('\n')).toContain(logged);
    expect(app.didit.calls('create')).toHaveLength(creates);
    expect(seeded.map((s) => s.metadata)).toEqual(metadata);
    const shown = await status(app.request, app.session);
    expect(shown).toMatchObject(polled);
    if (polled.status === 'rejected') expect(shown).toEqual(polled);
    expect(register).toHaveBeenCalledTimes(polled.status === 'ready' ? 1 : 0);
  });

  it('opens new Didit sessions while fewer than didit.max_sessions_per_day were billed in 24 hours, counting each billed session once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lines = captureLogs();
    const app = await joinedApp({ didit: { ...DIDIT_SERVICE.didit!, max_sessions_per_day: 1 } });
    const join = async (email: string) => joined(app.request, app.emails, await signingAgent(), email);
    const [other, third, fourth] = [await join('grace@example.com'), await join('hopper@example.com'), await join('lovelace@example.com')];
    const billed = async (didit: FakeSession, didStatus: string, session: string) => {
      didit.status = didStatus;
      later();
      await status(app.request, session);
      return Date.now();
    };
    await pressContinue(app.request, app.token);
    expect((await pressContinue(app.request, other.token)).status).toBe(303);
    const [mine, others] = app.didit.sessions;

    mine.status = 'Declined';
    later();
    const declined = Date.now();
    const refused = await pressContinue(app.request, app.token);
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain('Identity verification is not available right now.');
    expect(lines.join('\n')).toContain('billed Didit sessions in 24 hours reach didit.max_sessions_per_day of 1');
    later(10_000);
    expect((await pressContinue(app.request, app.token)).status).toBe(503);
    vi.setSystemTime(declined + 86_400_001);
    expect((await pressContinue(app.request, third.token)).status).toBe(303);

    await billed(app.didit.sessions[2], 'Approved', third.session);
    expect((await pressContinue(app.request, fourth.token)).status).toBe(503);
    const inReview = await billed(others, 'In Review', other.session);
    await billed(others, 'Approved', other.session);
    vi.setSystemTime(inReview + 86_400_001);
    expect((await pressContinue(app.request, fourth.token)).status).toBe(303);
  });

  it('changes nothing while Didit is unreachable', async () => {
    const { request, ctx, didit, session, token } = await joinedApp();
    captureLogs();
    const before = await ctx.sessionStore.get(session);
    didit.down = true;

    const res = await pressContinue(request, token);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(
      'Identity verification is not available right now. Try the link again in a few minutes.',
    );
    expect(await ctx.sessionStore.get(session)).toEqual(before);
  });

  it('sends a later Continue back to the recorded open session, and reaches Didit at most once per 10 seconds and 10 times an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lines = captureLogs();
    const { request, didit, session, token } = await joinedApp();
    await pressContinue(request, token);
    const tooSoon = await pressContinue(request, token);
    expect(tooSoon.status).toBe(503);
    expect(await tooSoon.text()).toContain('Identity verification is not available right now.');
    expect(lines.join('\n')).toContain('over its Continue limit of one per 10 seconds and 10 an hour');
    expect(lines.join('\n')).not.toContain(session);
    const calls = didit.requests.length;

    for (let i = 1; i < 10; i++) {
      later(10_000);
      const again = await pressContinue(request, token);
      expect(again.status).toBe(303);
      expect(again.headers.get('Location')).toBe(didit.sessions[0].url);
    }
    later(10_000);
    expect((await pressContinue(request, token)).status).toBe(503);
    expect(didit.requests.length - calls).toBe(9 * 2);
    expect(didit.sessions).toHaveLength(1);
    expect(didit.calls('list')).toHaveLength(1);
    later(3_600_000);
    expect((await pressContinue(request, token)).status).toBe(303);
  });

  it('starts a new attempt after a decline, and after Didit forgets the session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, didit, session, token } = await joinedApp();
    await pressContinue(request, token);
    didit.sessions[0].status = 'Declined';
    later();
    expect((await status(request, session)).challenges[0].metadata.state).toBe('declined');

    const page = await (await request(`/v1/didit/${token}`)).text();
    expect(page).toContain('Your last verification did not pass. Continue to start a new attempt.');
    expect((await pressContinue(request, token)).headers.get('Location')).toBe(didit.sessions[1].url);

    captureLogs();
    didit.sessions.splice(1, 1);
    later(10_000);
    expect((await pressContinue(request, token)).headers.get('Location')).toBe(didit.sessions[1].url);
    expect(didit.sessions).toHaveLength(2);
    expect((await status(request, session)).challenges[0].metadata.state).toBe('in_progress');
  });
});

describe('status for a didit_with_email join', () => {
  it.each<[string, (didit: FakeDidit) => void, number, string]>([
    ['In Progress', (d) => (d.sessions[0].status = 'In Progress'), 15_000, 'in_progress'],
    ['In Review', (d) => (d.sessions[0].status = 'In Review'), 60_000, 'in_review'],
    ['Declined', (d) => (d.sessions[0].status = 'Declined'), 300_000, 'declined'],
    ['Expired', (d) => (d.sessions[0].status = 'Expired'), 300_000, 'expired'],
    ['a failed read', (d) => (d.down = true), 15_000, 'in_progress'],
    ['an unchanged decision', () => {}, 15_000, 'in_progress'],
  ])('reads Didit at most once per interval after %s, however many polls arrive', async (_name, change, interval, state) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    captureLogs();
    const { request, didit, session, token } = await joinedApp();
    await pressContinue(request, token);
    change(didit);
    later();
    expect(await status(request, session)).toMatchObject({ status: 'pending', challenges: [{ metadata: { state } }] });
    const reads = () => didit.calls('decision').length;
    const start = reads();

    later(interval - 1000);
    await status(request, session);
    await status(request, session);
    expect(reads()).toBe(start);
    later(1000);
    await Promise.all([status(request, session), status(request, session), status(request, session)]);
    expect(reads()).toBe(start + 1);
  });

  it.each<[string, (didit: FakeDidit) => void]>([
    ['an unchanged decision', () => {}],
    ['a failed read', (d) => (d.down = true)],
  ])('saves no session and records no event on a status poll that finds %s', async (_name, change) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    captureLogs();
    const { request, ctx, didit, session, token } = await joinedApp();
    await pressContinue(request, token);
    change(didit);
    later();
    const store = ctx.sessionStore as LinkSessionStore;
    const writes = [vi.spyOn(store, 'update'), vi.spyOn(store, 'reserveEvents')];
    const reads = didit.calls('decision').length;

    expect(await status(request, session)).toMatchObject({ status: 'pending', challenges: [{ metadata: { state: 'in_progress' } }] });
    expect(didit.calls('decision')).toHaveLength(reads + 1);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it.each<[string, (session: FakeSession) => void, object]>([
    ['a new status in the same state', (s) => (s.status = 'In Progress'), { state: 'in_progress', attempt: { status: 'In Progress' } }],
    ['its session taken by another agent key', (s) => (s.metadata = { agent_key: 'uhCAkOther' }), { state: 'link_sent', attempt: { gone: true } }],
  ])('saves a status poll that finds %s', async (_name, change, link) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    captureLogs();
    const { request, ctx, didit, session, token } = await joinedApp();
    await pressContinue(request, token);
    change(didit.sessions[0]);
    later();

    await status(request, session);
    expect((await ctx.sessionStore.get(session))!.challenges[0].link).toMatchObject(link);
  });

  it('makes the join ready on an Approved decision for this join, and registers the email as sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const register = vi.spyOn(HcAuthClient.prototype, 'registerAndAuthorize').mockResolvedValue();
    const { request, emails, didit } = await diditApp({ hc_auth: HC }, new HcAuthClient(HC));
    const agent = await signingAgent();
    const { session, token } = await joined(request, emails, agent, ` ${EMAIL}`);
    await pressContinue(request, token);
    expect(register).not.toHaveBeenCalled();

    didit.sessions[0].status = 'Approved';
    later();
    expect((await status(request, session)).status).toBe('ready');
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][1]).toEqual({ agent_key: agent.agentKey, happ_id: 'test-app', email: ` ${EMAIL}` });
  });

  it.each<[string, Partial<FakeSession>, string, string[]]>([
    ['another workflow', { workflow_id: OTHER_WORKFLOW }, 'in_progress', [`has workflow_id "${OTHER_WORKFLOW}", configured `, 'check didit.workflow_id']],
    ['another environment', { environment: 'live' }, 'in_progress', ['has environment "live", configured ', 'check didit.environment']],
    ['another agent key', { metadata: { agent_key: 'uhCAkOther' } }, 'link_sent', ['differs']],
    ['an unknown status', { status: 'Approved Pending Payment' }, 'in_progress', ['unknown status']],
  ])('never completes on a decision with %s', async (_name, change, state, logged) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lines = captureLogs();
    const { request, didit, session, token } = await joinedApp();
    await pressContinue(request, token);

    Object.assign(didit.sessions[0], { status: 'Approved' }, change);
    later();
    expect(await status(request, session)).toMatchObject({
      status: 'pending',
      challenges: [{ completed: false, metadata: { state } }],
    });
    for (const text of logged) expect(lines.join('\n')).toContain(text);
  });

  it("reuses another key's open session at the cap, and never completes the first key's join from it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    captureLogs();
    const { request, emails, didit, ...first } = await joinedApp({ didit: { ...DIDIT_SERVICE.didit!, max_sessions_per_email: 1 } });
    await pressContinue(request, first.token);
    later(61_000);
    const secondAgent = await signingAgent();
    const second = await joined(request, emails, secondAgent);

    const takeover = await pressContinue(request, second.token);
    expect(takeover.headers.get('Location')).toBe(didit.sessions[0].url);
    expect(didit.sessions).toHaveLength(1);
    expect(didit.sessions[0].metadata).toEqual({ agent_key: secondAgent.agentKey });

    didit.sessions[0].status = 'Approved';
    later();
    const firstPoll = await status(request, first.session);
    expect(firstPoll.status).toBe('pending');
    expect(firstPoll.challenges[0].metadata.state).toBe('link_sent');
    expect((await status(request, second.session)).status).toBe('ready');

    later();
    expect((await status(request, first.session)).status).toBe('pending');
  });

  it("keeps reading other joins' sessions while one session's reads fail", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    captureLogs();
    const { request, emails, didit } = await diditApp();
    const stuck = await joined(request, emails, await signingAgent(), 'stuck@example.com');
    const other = await joined(request, emails, await signingAgent());
    await pressContinue(request, stuck.token);
    await pressContinue(request, other.token);

    didit.sessions[0].workflow_id = OTHER_WORKFLOW;
    didit.sessions[1].status = 'Approved';
    later();
    await status(request, stuck.session);
    expect((await status(request, other.session)).status).toBe('ready');
  });

  it('forgets a session recorded under an earlier didit.workflow_id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lines = captureLogs();
    const { request, ctx, didit, session, token } = await joinedApp();
    await pressContinue(request, token);
    const stored = (await ctx.sessionStore.get(session))!;
    stored.challenges[0].link!.attempt!.workflow_id = OTHER_WORKFLOW;
    await ctx.sessionStore.update(session, { challenges: stored.challenges });
    didit.sessions[0].workflow_id = OTHER_WORKFLOW;

    later();
    expect((await status(request, session)).challenges[0].metadata.state).toBe('link_sent');
    expect(lines.join('\n')).toContain('was recorded under an earlier didit.workflow_id');
  });
});

describe('the ready path of a didit_with_email join', () => {
  it("keeps an approval read by status when hc-auth fails, retries the ready path on status and on Continue within Continue's limit, and the next status completes it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    captureLogs();
    const register = vi
      .spyOn(HcAuthClient.prototype, 'registerAndAuthorize')
      .mockRejectedValueOnce(new Error('hc-auth 503'))
      .mockRejectedValueOnce(new Error('hc-auth 503'))
      .mockResolvedValue();
    const { request, ctx, didit, session, token } = await joinedApp({ hc_auth: HC }, new HcAuthClient(HC));
    await pressContinue(request, token);
    didit.sessions[0].status = 'Approved';
    later();

    expect(await status(request, session)).toMatchObject({ status: 'pending', challenges: [{ completed: true, metadata: { state: 'approved' } }] });
    const stored = (await ctx.sessionStore.get(session))!;
    expect(stored.status).toBe('pending');
    expect(stored.challenges[0].completed).toBe(true);

    const page = await pressContinue(request, token);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toContain('text/html');
    expect(register).toHaveBeenCalledTimes(2);
    expect((await pressContinue(request, token)).status).toBe(503);
    expect(register).toHaveBeenCalledTimes(2);
    expect((await ctx.sessionStore.get(session))!.status).toBe('pending');

    const reads = didit.calls('decision').length;
    expect((await status(request, session)).status).toBe('ready');
    expect(didit.calls('decision')).toHaveLength(reads);
    expect(register).toHaveBeenCalledTimes(3);
  });

  it.each<[string, Partial<ServiceConfig>, HcAuthClient | undefined, string]>([
    ['hc-auth', { hc_auth: HC }, new HcAuthClient(HC), `${HC.url}/`],
    ['a linker', { linker_auth: { capabilities: ['dht_read'], required: true } }, undefined, 'https://l1.example.com/admin/agents'],
  ])('answers status with the approved join still pending when %s never answers in 5 seconds', async (_name, config, hcAuth, hung) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lines = captureLogs(['log', 'warn', 'error']);
    const { request, emails, didit } = await diditApp(config, hcAuth, linkersAt(['https://l1.example.com']));
    const agent = await signingAgent();
    const { session, token } = await joined(request, emails, agent);
    await pressContinue(request, token);
    didit.sessions[0].status = 'Approved';
    later();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith(hung)) return didit.respond(url, init ?? {});
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    });
    // Fake timers cannot advance AbortSignal.timeout, so it is cut to 1 ms and the test checks the 5000 ms asked for.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const bound = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(1));

    expect(await status(request, session)).toMatchObject({ status: 'pending', challenges: [{ completed: true, metadata: { state: 'approved' } }] });
    expect(bound).toHaveBeenLastCalledWith(5000);
    expect(lines.join('\n')).toContain(`[ready path] agent ${agent.agentKey.slice(0, 20)}... stays pending`);
    expect(lines.join('\n')).not.toContain(session);
  });

  it('authorizes the agent on every linker when the join turns ready, and not before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const linkers = ['https://l1.example.com', 'https://l2.example.com'];
    const { request, emails, didit } = await diditApp({ linker_auth: { capabilities: ['dht_read'] } }, undefined, linkersAt(linkers));
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
    'completes beside hc_auth_approval when %s, leaves authorizing the key to hc-auth, and writes the proven email to verified',
    async (order) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const client = new HcAuthClient(HC);
      let state: 'pending' | 'authorized' = 'pending';
      vi.spyOn(client, 'getRecord').mockResolvedValueOnce(null).mockImplementation(async () => ({ state, pubKey: 'k' }));
      vi.spyOn(client, 'requestAuth').mockResolvedValue();
      const register = vi.spyOn(client, 'registerAndAuthorize').mockResolvedValue();
      const verified = vi.spyOn(client, 'setVerified').mockResolvedValue();
      const { request, didit, session, token } = await joinedApp(
        { auth_methods: ['hc_auth_approval', 'didit_with_email'], hc_auth: HC },
        client,
      );
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
      expect(verified).toHaveBeenCalledWith(expect.any(String), { email: EMAIL });
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
    expect(await (await request(`/v1/didit/${linkToken(emails[0])}`)).text()).toContain('Request to verify your identity to join Acme');
    const resume = async (extra: Record<string, unknown>) =>
      postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign(resumeMessage)), ...extra });
    expect((await (await resume({ network: 'acme-net' })).json()).session).toBe(session);
    expect((await resume({})).status).toBe(404);
  });
});

describe('POST /v1/join/resume for a didit_with_email join', () => {
  it('returns the refreshed challenge, and never emails or creates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, emails, didit, agent, session, token } = await joinedApp();
    await pressContinue(request, token);
    didit.sessions[0].status = 'In Review';
    later();

    const res = await postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign(resumeMessage)) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBe(session);
    expect(body.challenges[0].metadata.state).toBe('in_review');
    expect(body.poll_interval_ms).toBe(60_000);
    expect(emails).toHaveLength(1);
    expect(didit.calls('create')).toHaveLength(1);
  });
});

describe('GET /v1/didit/done/{credential}', () => {
  it.each([
    ['In Progress', 'pending', 'Your verification is still in progress. Go back to the app. It continues by itself.'],
    ['In Review', 'pending', 'Your verification is in review. After the review, the app continues by itself.'],
    ['Declined', 'pending', 'Your verification did not pass. To try again, open the link in your email again.'],
    ['Expired', 'pending', 'Your verification did not pass. To try again, open the link in your email again.'],
    ['forgotten', 'pending', 'We could not find your verification. To start again, open the link in your email and press Continue.'],
    ['Approved', 'pending', VERIFIED],
    ['Approved', 'ready', VERIFIED],
    ['In Progress', 'rejected', NO_ATTEMPTS_LEFT],
  ])('shows where the %s verification stands in a %s join, whatever the query says', async (didStatus, joinStatus, text) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    captureLogs();
    const { request, ctx, didit, session, token } = await joinedApp();
    await pressContinue(request, token);
    if (didStatus === 'forgotten') didit.sessions.splice(0, 1);
    else didit.sessions[0].status = didStatus;
    later();
    if (joinStatus === 'ready') expect((await status(request, session)).status).toBe('ready');
    if (joinStatus === 'rejected') await ctx.sessionStore.update(session, { status: 'rejected', reason: NO_ATTEMPTS_LEFT });
    const query = didStatus === 'Approved' ? 'status=Declined' : 'verificationSessionId=forged&status=Approved';
    const res = await request(`${donePath(didit)}?${query}`);
    expect(res.status).toBe(joinStatus === 'rejected' ? 403 : 200);
    expect(await res.text()).toContain(text);
    expect((await ctx.sessionStore.get(session))!.status).toBe(joinStatus);
    if (joinStatus !== 'pending') {
      expect((await request(`/v1/didit/${token}`)).status).toBe(404);
      later(604_800_000);
      expect((await request(donePath(didit))).status).toBe(404);
    }
  });
});

describe('POST /v1/join/{session}/resend', () => {
  it('emails a new link after the interval, keeps every link working, and answers 401, 404, 429 and 503 as the contract says', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    captureLogs();
    const { request, emails, session, token, join } = await joinedApp();
    const challenge_id = join.challenges[0].id;
    const resend = (id: string, body: unknown) => postJson(request, `/v1/join/${id}/resend`, body);

    expect((await resend('js_unknown', { challenge_id })).status).toBe(401);
    expect((await resend(session, { challenge_id: 'ch_other' })).status).toBe(404);
    const limited = await resend(session, { challenge_id });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');

    later(61_000);
    const res = await resend(session, { challenge_id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('pending');
    expect(Date.parse(body.challenges[0].metadata.resend_available_at)).toBe(Date.now() + 60_000);
    expect(emails).toHaveLength(2);
    const fresh = linkToken(emails[1]);
    expect(fresh).not.toBe(token);
    expect((await request(`/v1/didit/${token}`)).status).toBe(200);
    expect((await request(`/v1/didit/${fresh}`)).status).toBe(200);

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
    const lines = captureLogs(['log', 'warn', 'error', 'info', 'debug']);
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
    await keep(await request(donePath(didit)));
    await keep(await postJson(request, '/v1/join/resume', { agent_key: agent.agentKey, ...(await agent.sign(resumeMessage)) }));
    await keep(await postJson(request, `/v1/join/${session}/resend`, { challenge_id: 'none' }));
    didit.sessions[0].metadata = { agent_key: 'uhCAkOther' };
    later();
    await keep(await request(`/v1/join/${session}/status`));
    didit.down = true;
    await keep(await pressContinue(request, token));

    const stored = (await ctx.sessionStore.get(session))!;
    const link = stored.challenges.find((cs) => cs.link)!.link!;
    const credential = donePath(didit).split('/').pop()!;
    const secrets = [token, ...link.token_hashes, credential, link.done_hash, didit.sessions[0].session_id, SUBJECT];
    for (const body of bodies) {
      for (const secret of secrets) expect(body).not.toContain(secret);
    }

    const logged = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of ['SESSION-URL', 'SESSION-TOKEN', 'didit-test-key', 'Ada Lovelace', token, credential, SUBJECT]) {
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
