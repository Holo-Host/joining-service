import { vi } from 'vitest';
import { createTestApp, postJson, signingAgent } from '../helpers.js';
import { FileTransport } from '../../src/email/file.js';
import type { ServiceConfig } from '../../src/config.js';
import type { HcAuthClient } from '../../src/hc-auth/index.js';
import type { UrlProvider } from '../../src/urls/provider.js';
import { FakeDidit } from './fake-didit.js';
import { DIDIT_SERVICE } from './fixtures.js';

export interface SentEmail {
  to: string;
  subject: string;
  body: string;
}

export type Agent = Awaited<ReturnType<typeof signingAgent>>;
export type Request = (path: string, init?: RequestInit) => Promise<Response>;

/** Every email the file transport is asked to send, captured instead of written. */
export function captureEmails(): SentEmail[] {
  const sent: SentEmail[] = [];
  vi.spyOn(FileTransport.prototype, 'send').mockImplementation(async (to, subject, body) => {
    sent.push({ to, subject, body });
  });
  return sent;
}

export function linkToken(email: SentEmail): string {
  return /\/v1\/didit\/([A-Za-z0-9_-]{43})/.exec(email.body)![1];
}

/**
 * A didit_with_email service with its emails captured and Didit faked. It
 * stores sessions in sqlite, whose reads are copies, so a step that forgets
 * to save fails its test.
 */
export async function diditApp(
  overrides: Partial<ServiceConfig> = {},
  hcAuthClient?: HcAuthClient,
  urlProvider?: UrlProvider,
) {
  const emails = captureEmails();
  const didit = new FakeDidit();
  didit.install();
  const app = await createTestApp(
    { session: { store: 'sqlite', pending_ttl_seconds: 86400 }, ...DIDIT_SERVICE, ...overrides },
    undefined,
    urlProvider,
    hcAuthClient,
  );
  return { ...app, emails, didit };
}

export async function signedJoin(
  request: Request,
  agent: Agent,
  email = 'ada@example.com',
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return postJson(request, '/v1/join', { agent_key: agent.agentKey, claims: { email }, ...(await agent.sign()), ...extra });
}

export function pressContinue(request: Request, token: string): Promise<Response> {
  return request(`/v1/didit/${token}`, { method: 'POST' });
}

export async function status(request: Request, session: string) {
  return (await request(`/v1/join/${session}/status`)).json();
}

export { signingAgent, postJson };
