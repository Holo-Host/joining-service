import { describe, it, expect, vi, afterEach } from 'vitest';
import { CloudflareTransport } from '../src/email/cloudflare.js';
import { buildEmailTransport } from '../src/server.js';
import { resolveConfig, type ServiceConfig } from '../src/config.js';
import worker from '../deploy/cloudflare/worker-entry.js';
import { createMockKV } from './linker-registration/helpers.js';
import { fakeAgentKey } from './helpers.js';

const SEND_URL = 'https://api.cloudflare.com/client/v4/accounts/acct-1/email/sending/send';
const EMAIL = { provider: 'cloudflare', account_id: 'acct-1', api_key: 'cf-token', from: 'noreply@example.com' } as const;
const CONFIG: Partial<ServiceConfig> = { happ: { id: 'test', name: 'Test' }, auth_methods: ['email_code'], email: EMAIL };

function answer(status: number, success: boolean, errors: object[] = []) {
  return new Response(JSON.stringify({ success, errors, messages: [], result: success ? { delivered: [], permanent_bounces: [], queued: [] } : null }), { status });
}

describe('CloudflareTransport', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    ['text alone', undefined, { from: 'noreply@example.com', text: 'Text' }],
    [
      'the HTML part and sender name',
      { html: '<p>Html</p>', senderName: 'Unyt' },
      { from: { address: 'noreply@example.com', name: 'Unyt' }, text: 'Text', html: '<p>Html</p>' },
    ],
  ])('sends %s to the account with the bearer token', async (_name, parts, fields) => {
    const mockFetch = vi.fn().mockResolvedValue(answer(200, true));
    globalThis.fetch = mockFetch;

    await new CloudflareTransport('acct-1', 'cf-token', 'noreply@example.com').send('user@example.com', 'Subj', 'Text', parts);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(SEND_URL);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer cf-token' });
    expect(JSON.parse(options.body)).toEqual({ to: 'user@example.com', subject: 'Subj', ...fields });
  });

  it.each([
    ['a non-ok response', new Response('Bad Gateway', { status: 502 }), 'Cloudflare API error (502): Bad Gateway'],
    [
      'an ok response that is not a success',
      answer(200, false, [{ code: 10001, message: 'email.sending.error.invalid_request_schema' }]),
      'Cloudflare API error (200): {"success":false,"errors":[{"code":10001',
    ],
  ])('throws on %s', async (_name, response, message) => {
    globalThis.fetch = vi.fn().mockResolvedValue(response);

    const sent = new CloudflareTransport('acct-1', 'cf-token', 'noreply@example.com').send('user@example.com', 'Subj', 'Text');

    await expect(sent).rejects.toThrow(message);
  });

  it.each([
    ['Node server', () => buildEmailTransport(resolveConfig(CONFIG))!.send('ada@example.com', 'Subj', 'Text')],
    [
      'Worker join',
      async () => {
        const res = await worker.fetch(
          new Request('https://join.example.com/v1/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_key: fakeAgentKey(), claims: { email: 'ada@example.com' } }),
          }),
          { SESSIONS: createMockKV(), CONFIG_JSON: JSON.stringify(CONFIG) },
        );
        expect(res.status).toBe(201);
      },
    ],
  ])('the %s email goes through Cloudflare', async (_name, sendOne) => {
    const mockFetch = vi.fn().mockResolvedValue(answer(200, true));
    globalThis.fetch = mockFetch;

    await sendOne();

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(SEND_URL);
    expect(options.headers.Authorization).toBe('Bearer cf-token');
    expect(JSON.parse(options.body)).toMatchObject({ to: 'ada@example.com', from: 'noreply@example.com' });
  });

  it('the Node server needs account_id', () => {
    const { account_id: _, ...withoutAccount } = EMAIL;
    expect(() => buildEmailTransport(resolveConfig({ ...CONFIG, email: withoutAccount }))).toThrow(
      'Cloudflare requires account_id, api_key and from',
    );
  });
});
