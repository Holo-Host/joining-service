import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  DiditClient,
  DiditUnavailableError,
  resolveDiditConfig,
  stateOf,
  subjectId,
  type DiditConfig,
} from '../../src/didit/client.js';

import { DIDIT_CONFIG as CONFIG, SUBJECT_KEY, WORKFLOW_ID } from './fixtures.js';

const SECRET_URL = 'https://verify.didit.me/session/SECRET-SESSION-URL';
const SECRET_TOKEN = 'SECRET-SESSION-TOKEN';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchSpy: MockInstance<typeof fetch>;
let client: DiditClient;

beforeEach(() => {
  vi.restoreAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  client = new DiditClient(resolveDiditConfig(CONFIG));
});

describe('resolveDiditConfig', () => {
  it('fills the limit defaults', () => {
    expect(resolveDiditConfig(CONFIG)).toMatchObject({
      max_sessions_per_email: 3,
      max_sessions_per_day: 100,
      link_ttl_seconds: 604_800,
      resend_interval_seconds: 60,
      max_emails_per_address: 5,
      max_emails_per_agent: 5,
    });
  });

  it.each([
    ['no block', undefined, /requires a didit block/],
    ['no api_key', { ...CONFIG, api_key: '' }, /didit\.api_key/],
    ['a short subject_key', { ...CONFIG, subject_key: 'abcd' }, /didit\.subject_key/],
    ['a workflow_id that is not a UUID', { ...CONFIG, workflow_id: 'workflow-1' }, /didit\.workflow_id/],
    ['an environment other than live or sandbox', { ...CONFIG, environment: 'staging' }, /live" or "sandbox/],
    ['a zero limit', { ...CONFIG, max_emails_per_agent: 0 }, /max_emails_per_agent must be a positive integer/],
    ['a fractional limit', { ...CONFIG, link_ttl_seconds: 1.5 }, /link_ttl_seconds must be a positive integer/],
    ['a template with no link', { ...CONFIG, email_template: 'Join {{network}}' }, /email_template must contain \{\{link\}\}/],
    ['a subject with the link', { ...CONFIG, email_subject: 'Open {{link}}' }, /email_subject must not contain \{\{link\}\}/],
  ])('refuses %s', (_name, raw, message) => {
    expect(() => resolveDiditConfig(raw as Partial<DiditConfig>)).toThrow(message);
  });
});

describe('subjectId', () => {
  it('is the lowercase hex HMAC-SHA256 of the trimmed email, with ASCII letters only lower-cased', () => {
    const expected = createHmac('sha256', Buffer.from(SUBJECT_KEY, 'hex')).update('ada@example.com').digest('hex');
    expect(subjectId('  Ada@Example.COM ', SUBJECT_KEY)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(subjectId('ÄDA@example.com', SUBJECT_KEY)).not.toBe(subjectId('äda@example.com', SUBJECT_KEY));
  });
});

describe('stateOf', () => {
  it.each([
    ['Not Started', 'in_progress'],
    ['In Progress', 'in_progress'],
    ['Resubmitted', 'in_progress'],
    ['Awaiting User', 'in_progress'],
    ['In Review', 'in_review'],
    ['Declined', 'declined'],
    ['Expired', 'expired'],
    ['Abandoned', 'expired'],
    ['Kyc Expired', 'expired'],
    ['Approved', 'approved'],
    ['approved', undefined],
    ['constructor', undefined],
  ])('maps %s to %s', (status, state) => {
    expect(stateOf(status)).toBe(state);
  });
});

describe('DiditClient', () => {
  it('creates a session with exactly the workflow, vendor_data, callback, agent key and email', async () => {
    fetchSpy.mockResolvedValueOnce(
      json({ session_id: 's1', session_token: SECRET_TOKEN, url: SECRET_URL, status: 'Not Started', workflow_version: 4 }, 201),
    );
    const created = await client.createSession({ vendorData: 'v1', callback: 'https://join.example.com/done', agentKey: 'uhCAk1', email: 'Ada@Example.com' });

    expect(created).toEqual({ session_id: 's1', url: SECRET_URL, status: 'Not Started' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://verification.didit.me/v3/session/');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-api-key': 'didit-test-key', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      workflow_id: WORKFLOW_ID,
      vendor_data: 'v1',
      callback: 'https://join.example.com/done',
      callback_method: 'both',
      metadata: { agent_key: 'uhCAk1', email: 'Ada@Example.com' },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads a decision and keeps only the fields it compares, or null for a session Didit no longer has', async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        session_id: 's1',
        status: 'Approved',
        workflow_id: WORKFLOW_ID,
        workflow_version: 4,
        vendor_data: 'v1',
        environment: 'sandbox',
        metadata: { agent_key: 'uhCAk1', email: 'Ada@Example.com' },
        id_verifications: [{ first_name: 'Ada', last_name: 'Lovelace' }],
      }),
    );
    const decision = await client.decision('s1');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://verification.didit.me/v3/session/s1/decision/');
    expect(decision).toEqual({
      session_id: 's1',
      status: 'Approved',
      workflow_id: WORKFLOW_ID,
      vendor_data: 'v1',
      environment: 'sandbox',
      agent_key: 'uhCAk1',
    });
    fetchSpy.mockResolvedValueOnce(json({ detail: 'Not found.' }, 404));
    expect(await client.decision('gone')).toBeNull();
  });

  it('lists this workflow\'s sessions for a vendor_data, keeping only ids and statuses', async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        count: 2,
        next: null,
        previous: null,
        results: [
          { session_id: 's2', status: 'In Progress', full_name: 'Ada Lovelace', email_address: 'ada@example.com' },
          { session_id: 's1', status: 'Declined', portrait_image: 'https://images.example/ada.jpg' },
        ],
      }),
    );
    const listed = await client.listSessions('v1');
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('https://verification.didit.me/v3/sessions/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ vendor_data: 'v1', workflow_id: WORKFLOW_ID });
    expect(listed).toEqual({
      count: 2,
      sessions: [
        { session_id: 's2', status: 'In Progress' },
        { session_id: 's1', status: 'Declined' },
      ],
    });
  });

  it('treats a refusal, a timeout, a network failure or an unreadable body as unavailable', async () => {
    fetchSpy.mockResolvedValue(json({ detail: 'down' }, 503));
    await expect(client.decision('s1')).rejects.toBeInstanceOf(DiditUnavailableError);
    await expect(client.listSessions('v1')).rejects.toBeInstanceOf(DiditUnavailableError);
    await expect(client.createSession({ vendorData: 'v', callback: 'c', agentKey: 'k' })).rejects.toBeInstanceOf(
      DiditUnavailableError,
    );
    fetchSpy.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(client.decision('s1')).rejects.toThrow(/TimeoutError/);
    fetchSpy.mockRejectedValueOnce(new TypeError(`fetch failed ${SECRET_URL}`, { cause: { code: 'ENOTFOUND' } }));
    await expect(client.decision('s1')).rejects.toThrow(/^Didit decision failed: TypeError ENOTFOUND$/);
    fetchSpy.mockResolvedValueOnce(new Response('{"status":', { status: 200 }));
    await expect(client.decision('s1')).rejects.toThrow(/^Didit decision body could not be read: SyntaxError$/);
  });

  it('logs a key, scope or workflow fault as a config error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockResolvedValueOnce(json({ detail: 'bad key' }, 401));
    await expect(client.decision('s1')).rejects.toBeInstanceOf(DiditUnavailableError);
    expect(errors.mock.calls.join(' ')).toMatch(/didit\.api_key/);
    fetchSpy.mockResolvedValueOnce(json({ detail: 'no such workflow' }, 400));
    await expect(client.listSessions('v1')).rejects.toBeInstanceOf(DiditUnavailableError);
    expect(errors.mock.calls.join(' ')).toMatch(/didit\.workflow_id/);
    fetchSpy.mockResolvedValueOnce(json({ session_id: 's1', url: null, status: 'Not Started' }, 201));
    await expect(client.createSession({ vendorData: 'v', callback: 'c', agentKey: 'k' })).rejects.toBeInstanceOf(
      DiditUnavailableError,
    );
    expect(errors.mock.calls.join(' ')).toMatch(/Sessions write/);
  });

  it('never logs a Didit body, URL or token', async () => {
    const lines: unknown[][] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        lines.push(args);
      });
    }
    const subject = subjectId('ada@example.com', SUBJECT_KEY);
    const body = { detail: `${SECRET_TOKEN} ${SECRET_URL}`, session_token: SECRET_TOKEN, url: SECRET_URL, vendor_data: subject };
    for (const status of [400, 401]) {
      fetchSpy.mockResolvedValue(json(body, status));
      await client.decision('s1').catch(() => {});
      await client.listSessions(subject).catch(() => {});
      await client.createSession({ vendorData: subject, callback: 'c', agentKey: 'k' }).catch(() => {});
    }
    fetchSpy.mockResolvedValue(json({ ...body, session_id: 's1', status: 'Not Started', url: null }, 201));
    await client.createSession({ vendorData: subject, callback: 'c', agentKey: 'k' }).catch(() => {});

    expect(lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(lines.map((args) => args.map(String)));
    expect(logged).not.toContain(SECRET_TOKEN);
    expect(logged).not.toContain('SECRET-SESSION-URL');
    expect(logged).not.toContain('verification.didit.me');
    expect(logged).not.toContain('didit-test-key');
    expect(logged).not.toContain(subject);
  });

  describe('mismatch', () => {
    const belongs = {
      session_id: 's1',
      status: 'Approved',
      workflow_id: WORKFLOW_ID,
      vendor_data: 'v1',
      environment: 'sandbox',
      agent_key: 'uhCAk1',
    };
    const expected = { vendorData: 'v1', agentKey: 'uhCAk1' };

    it.each([
      ['no field for a decision of this join', undefined, {}],
      ['workflow_id', 'workflow_id', { workflow_id: '99999999-2222-4333-8444-555555555555' }],
      ['vendor_data', 'vendor_data', { vendor_data: 'v2' }],
      ['environment', 'environment', { environment: 'live' }],
      ['metadata.agent_key', 'metadata.agent_key', { agent_key: 'uhCAk2' }],
    ])('names %s', (_name, field, change) => {
      expect(client.mismatch({ ...belongs, ...change }, expected)).toBe(field);
    });
  });
});
