import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JoiningClient } from '../../src/client/joining.js';
import { BASE_URL } from '../didit/fixtures.js';
import { diditApp, linkToken, pressContinue, signingAgent, type Agent } from '../didit/harness.js';

const SERVICE = `${BASE_URL}/v1`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function signer(agent: Agent) {
  return async (message: string) => new Uint8Array(Buffer.from(await agent.signBytes(new TextEncoder().encode(message)), 'base64'));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JoiningClient against a didit_with_email service', () => {
  /** Routes the client's requests to the app, and Didit's to the fake. */
  async function routed() {
    const service = await diditApp();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      return url.startsWith(BASE_URL)
        ? service.request(url.slice(BASE_URL.length), init)
        : service.didit.respond(url, init ?? {});
    });
    return service;
  }

  it('signs join and resume, resends the link, and polls the join to ready', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { request, emails, didit } = await routed();
    const agent = await signingAgent();
    const client = JoiningClient.fromUrl(SERVICE);

    const joined = await client.join(agent.agentKey, { email: 'ada@example.com' }, undefined, signer(agent));
    expect(joined.status).toBe('pending');
    const [challenge] = joined.challenges!;

    const resumed = await client.resume(agent.agentKey, signer(agent));
    expect(resumed.sessionToken).toBe(joined.sessionToken);
    expect(resumed.pollIntervalMs).toBe(5000);

    vi.setSystemTime(Date.now() + 61_000);
    const resent = await resumed.resend(challenge.id);
    expect(resent.status).toBe('pending');
    expect(emails).toHaveLength(2);

    await pressContinue(request, linkToken(emails[1]));
    didit.sessions[0].status = 'Approved';
    vi.setSystemTime(Date.now() + 301_000);
    expect((await resent.pollStatus()).status).toBe('ready');
  });
});

describe('JoiningClient.resume', () => {
  it('posts the signed agent key with the discovered network, as join does', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse({ joining_service_url: SERVICE, happ_id: 'net-1', version: '1.0' }));
    const client = await JoiningClient.discover('app.example.com');
    const sign = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));

    fetchSpy.mockResolvedValueOnce(jsonResponse({ session: 'js_1', status: 'pending', challenges: [] }));
    await client.resume('uhCAkAgent', sign);

    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${SERVICE}/join/resume`);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ agent_key: 'uhCAkAgent', timestamp: body.timestamp, signature: 'AQID', network: 'net-1' });
    expect(sign).toHaveBeenCalledWith(`resume:${body.timestamp}`);
  });
});
