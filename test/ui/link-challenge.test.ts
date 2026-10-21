// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Challenge, DiditWithEmailState } from '../../src/types.js';
import '../../src/ui/joining-challenge-dialog.js';
import '../../src/ui/joining-claims-form.js';
import '../../src/ui/joining-flow.js';
import '../../src/ui/shoelace/joining-challenge-dialog-sl.js';
import '../../src/ui/shoelace/joining-claims-form-sl.js';
import type { JoiningChallengeDialog } from '../../src/ui/joining-challenge-dialog.js';
import type { JoiningClaimsForm } from '../../src/ui/joining-claims-form.js';
import type { JoiningFlow, JoinCompleteDetail } from '../../src/ui/joining-flow.js';
import type { JoiningChallengeDialogSl } from '../../src/ui/shoelace/joining-challenge-dialog-sl.js';
import type { JoiningClaimsFormSl } from '../../src/ui/shoelace/joining-claims-form-sl.js';
import type { ChallengeResendDetail } from '../../src/ui/link-challenge.js';

const SERVICE_URL = 'https://joining.example.com/v1';

type FetchSpy = ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

function linkChallenge(state: DiditWithEmailState = 'link_sent', resendInMs = -1): Challenge {
  return {
    id: 'ch_didit_1',
    type: 'didit_with_email',
    description: 'Open the link we sent to ad***@example.com',
    expires_at: new Date(Date.now() + 604_800_000).toISOString(),
    metadata: { state, resend_available_at: new Date(Date.now() + resendInMs).toISOString() },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the challenge dialog for didit_with_email', () => {
  it.each([
    ['link_sent', 'Waiting for you to open the link.'],
    ['in_progress', 'Verification in progress.'],
    ['in_review', 'Your verification is in review. This can take a few hours.'],
    ['declined', 'Your verification did not pass. Open the link in the email to try again.'],
    ['expired', 'Your verification timed out. Open the link in the email to start again.'],
  ] as [DiditWithEmailState, string][])('shows the %s line, a resend button and no code input', async (state, line) => {
    const el = document.createElement('joining-challenge-dialog') as JoiningChallengeDialog;
    el.challenge = linkChallenge(state);
    el.open = true;
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.querySelector('[part="description"]')?.textContent).toBe('Open the link we sent to ad***@example.com');
    expect(el.querySelector('[part="state"]')?.textContent).toBe(line);
    expect(el.querySelector('[part="resend-button"]')).not.toBeNull();
    expect(el.querySelector('input')).toBeNull();
    expect(el.querySelector('form')).toBeNull();
    expect(el.innerHTML).not.toContain('http');
  });

  it('enables resend at resend_available_at, and emits challenge-resend', async () => {
    vi.useFakeTimers();
    const el = document.createElement('joining-challenge-dialog') as JoiningChallengeDialog;
    el.challenge = linkChallenge('link_sent', 60_000);
    el.open = true;
    document.body.appendChild(el);
    await el.updateComplete;
    const button = () => el.querySelector('[part="resend-button"]') as HTMLButtonElement;
    expect(button().disabled).toBe(true);

    vi.advanceTimersByTime(60_000);
    await el.updateComplete;
    expect(button().disabled).toBe(false);

    const resent = new Promise<ChallengeResendDetail>((resolve) => {
      el.addEventListener('challenge-resend', ((e: CustomEvent<ChallengeResendDetail>) => resolve(e.detail)) as EventListener);
    });
    button().click();
    expect(await resent).toEqual({ challengeId: 'ch_didit_1' });
  });

  it('waits for a resend_available_at beyond the longest setTimeout without re-rendering', async () => {
    vi.useFakeTimers();
    const el = document.createElement('joining-challenge-dialog') as JoiningChallengeDialog;
    el.challenge = linkChallenge('link_sent', 30 * 86_400_000);
    el.open = true;
    document.body.appendChild(el);
    await el.updateComplete;
    const update = vi.spyOn(el, 'requestUpdate');

    vi.advanceTimersByTime(1000);
    await el.updateComplete;
    expect(update).not.toHaveBeenCalled();
    expect((el.querySelector('[part="resend-button"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the same in the Shoelace dialog', async () => {
    const el = document.createElement('joining-challenge-dialog-sl') as JoiningChallengeDialogSl;
    el.challenge = linkChallenge('in_review', 60_000);
    el.open = true;
    document.body.appendChild(el);
    await el.updateComplete;
    const root = el.shadowRoot!;
    expect(root.querySelector('[part="state"]')?.textContent).toBe('Your verification is in review. This can take a few hours.');
    expect(root.querySelector('sl-input')).toBeNull();
    expect(root.querySelector('sl-button')?.hasAttribute('disabled')).toBe(true);
  });
});

describe('the claims forms for didit_with_email', () => {
  it('collect an email, saying a link and an identity document follow', async () => {
    const el = document.createElement('joining-claims-form') as JoiningClaimsForm;
    el.authMethods = [{ any_of: ['agent_allow_list', 'didit_with_email'] }];
    document.body.appendChild(el);
    await el.updateComplete;
    const input = el.querySelector('input#claim-didit_with_email') as HTMLInputElement;
    expect(input.type).toBe('email');
    expect(el.textContent).toContain('We will email you a link to verify your identity');

    const sl = document.createElement('joining-claims-form-sl') as JoiningClaimsFormSl;
    sl.authMethods = ['didit_with_email'];
    document.body.appendChild(sl);
    await sl.updateComplete;
    expect(sl.shadowRoot!.querySelector('sl-input')?.getAttribute('type')).toBe('email');
  });
});

describe('JoiningFlow with didit_with_email', () => {
  type Gate = { resolve: (res: Response) => void; reject: (err: Error) => void };

  function linkFlow() {
    const el = document.createElement('joining-flow') as JoiningFlow;
    el.agentKey = 'uhCAkAgent';
    el.serviceUrl = SERVICE_URL;
    el.claims = { didit_with_email: 'ada@example.com' };
    el.signTimestamp = vi.fn().mockResolvedValue(new Uint8Array([1]));
    return el;
  }

  function spyFetch() {
    return vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('no answer queued'));
  }

  function gate(fetchSpy: FetchSpy): Gate {
    const gate = {} as Gate;
    fetchSpy.mockReturnValueOnce(new Promise<Response>((resolve, reject) => Object.assign(gate, { resolve, reject })));
    return gate;
  }

  const info = () => jsonResponse({ happ: { id: 't', name: 'T' }, auth_methods: ['didit_with_email'] });
  const joined = (pollIntervalMs: number, state: DiditWithEmailState = 'link_sent') =>
    jsonResponse({ session: 'js_1', status: 'pending', challenges: [linkChallenge(state)], poll_interval_ms: pollIntervalMs }, 201);
  const pending = (pollIntervalMs: number, state: DiditWithEmailState = 'link_sent', resendInMs?: number) =>
    jsonResponse({ status: 'pending', challenges: [linkChallenge(state, resendInMs)], poll_interval_ms: pollIntervalMs });
  const tooManyEmails = () => jsonResponse({ error: { code: 'rate_limited', message: 'Too many emails' } }, 429);

  function mockJoin(fetchSpy: FetchSpy, pollIntervalMs = 1) {
    fetchSpy.mockResolvedValueOnce(info());
    fetchSpy.mockResolvedValueOnce(joined(pollIntervalMs));
  }

  const statusCalls = (fetchSpy: FetchSpy) =>
    fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/status')).length;
  const dialogPart = (el: JoiningFlow, part: string) => el.querySelector(`joining-challenge-dialog [part="${part}"]`);
  const resend = (el: JoiningFlow) => (dialogPart(el, 'resend-button') as HTMLButtonElement).click();

  it.each([
    ['a 401 from a status poll', 'Unknown session', (poll: Gate) =>
      poll.resolve(jsonResponse({ error: { code: 'invalid_session', message: 'Unknown session' } }, 401))],
    ['a status poll answer that is not JSON', 'JSON', (poll: Gate) => poll.resolve(new Response('<html>', { status: 200 }))],
  ])('ends the flow with join-error on %s', async (_name, message, end) => {
    const fetchSpy = spyFetch();
    mockJoin(fetchSpy);
    const poll = gate(fetchSpy);
    const el = linkFlow();
    const failed = new Promise<Error>((resolve) => {
      el.addEventListener('join-error', ((e: CustomEvent<{ error: Error }>) => resolve(e.detail.error)) as EventListener);
    });
    document.body.appendChild(el);
    await vi.waitFor(() => expect(statusCalls(fetchSpy)).toBe(1));

    end(poll);
    expect((await failed).message).toContain(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statusCalls(fetchSpy)).toBe(1);
    expect(el.querySelector('joining-challenge-dialog')).toBeNull();
    el.remove();
  });

  it('shows why a resend was refused, a failing poll over that, and clears both once they succeed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = spyFetch();
    mockJoin(fetchSpy);
    const failing = gate(fetchSpy);
    fetchSpy.mockResolvedValueOnce(tooManyEmails());
    const answering = gate(fetchSpy);
    fetchSpy.mockResolvedValueOnce(pending(60_000, 'in_progress', 60_000));
    const el = linkFlow();
    document.body.appendChild(el);
    const notice = () => dialogPart(el, 'notice')?.textContent;
    await vi.waitFor(() => expect(statusCalls(fetchSpy)).toBe(1));
    await el.updateComplete;
    resend(el);
    await vi.waitFor(() => expect(notice()).toBe('Too many emails'));

    failing.reject(new TypeError('fetch failed'));
    await vi.waitFor(() => expect(notice()).toBe('The joining service is unavailable. Retrying.'));
    expect(warn).toHaveBeenCalledOnce();

    answering.resolve(pending(60_000, 'in_progress'));
    await vi.waitFor(() => expect(dialogPart(el, 'state')?.textContent).toBe('Verification in progress.'));
    expect(notice()).toBe('Too many emails');

    resend(el);
    await vi.waitFor(() => expect(notice()).toBeUndefined());
    expect(String(fetchSpy.mock.calls[5][0])).toBe(`${SERVICE_URL}/join/js_1/resend`);
    expect((dialogPart(el, 'resend-button') as HTMLButtonElement).disabled).toBe(true);
    el.remove();
  });

  it('stays ended once the dialog is cancelled, whatever answers or wakes later', async () => {
    const fetchSpy = spyFetch();
    mockJoin(fetchSpy, 200);
    const resent = gate(fetchSpy);
    const el = linkFlow();
    const errors: Error[] = [];
    el.addEventListener('join-error', ((e: CustomEvent<{ error: Error }>) => errors.push(e.detail.error)) as EventListener);
    document.body.appendChild(el);
    await vi.waitFor(() => expect(dialogPart(el, 'resend-button')).not.toBeNull());

    resend(el);
    el.querySelector('joining-challenge-dialog')!.dispatchEvent(new CustomEvent('challenge-cancelled'));
    resent.resolve(pending(60_000));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(el.querySelector('joining-challenge-dialog')).toBeNull();

    el.remove();
    await new Promise((resolve) => setTimeout(resolve, 250));
    document.body.appendChild(el);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(errors.map((e) => e.message)).toEqual(['Challenge cancelled']);
    el.remove();
  });

  it('drops the flow it replaces when started again, at whatever that flow was waiting on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = spyFetch();
    const el = linkFlow();
    const errors: unknown[] = [];
    el.addEventListener('join-error', (e) => errors.push(e));

    const firstInfo = gate(fetchSpy);
    document.body.appendChild(el);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    fetchSpy.mockResolvedValueOnce(info());
    const secondJoin = gate(fetchSpy);
    el.start();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));

    mockJoin(fetchSpy);
    const thirdPoll = gate(fetchSpy);
    fetchSpy.mockResolvedValueOnce(tooManyEmails());
    el.start();
    await vi.waitFor(() => expect(statusCalls(fetchSpy)).toBe(1));
    await el.updateComplete;
    resend(el);
    await vi.waitFor(() => expect(dialogPart(el, 'notice')?.textContent).toBe('Too many emails'));

    fetchSpy.mockResolvedValueOnce(info());
    const fourthJoin = gate(fetchSpy);
    el.start();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(9));

    mockJoin(fetchSpy, 60_000);
    el.start();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(11));

    firstInfo.resolve(info());
    secondJoin.resolve(joined(60_000, 'in_review'));
    thirdPoll.reject(new TypeError('fetch failed'));
    fourthJoin.resolve(jsonResponse({ error: { code: 'service_unavailable', message: 'Down' } }, 503));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).toHaveBeenCalledTimes(11);
    expect(errors).toHaveLength(0);
    expect(dialogPart(el, 'state')?.textContent).toBe('Waiting for you to open the link.');
    expect(dialogPart(el, 'notice')).toBeNull();
    el.remove();
  });

  it('keeps polling the same join when the element moves in the page', async () => {
    const fetchSpy = spyFetch();
    mockJoin(fetchSpy);
    const poll = gate(fetchSpy);
    fetchSpy.mockResolvedValueOnce(pending(60_000));
    const el = linkFlow();
    const errors: unknown[] = [];
    el.addEventListener('join-error', (e) => errors.push(e));
    document.body.appendChild(el);
    await vi.waitFor(() => expect(statusCalls(fetchSpy)).toBe(1));

    document.body.appendChild(document.createElement('div'));
    document.body.insertBefore(el, document.body.lastChild);
    poll.resolve(pending(1));
    await vi.waitFor(() => expect(statusCalls(fetchSpy)).toBe(2));
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(errors).toHaveLength(0);
    el.remove();
  });

  it('stops polling once removed from the page, and starts again when added back', async () => {
    const fetchSpy = spyFetch();
    mockJoin(fetchSpy);
    const poll = gate(fetchSpy);
    const el = linkFlow();
    document.body.appendChild(el);
    await vi.waitFor(() => expect(statusCalls(fetchSpy)).toBe(1));

    el.remove();
    poll.resolve(pending(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statusCalls(fetchSpy)).toBe(1);

    mockJoin(fetchSpy, 60_000);
    document.body.appendChild(el);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(5));
    el.remove();
  });

  it('signs the join, polls past the attempt cap while the link is open, completes, and stays complete when moved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = spyFetch();
    mockJoin(fetchSpy);
    for (let i = 0; i < 35; i++) fetchSpy.mockResolvedValueOnce(pending(1, i < 20 ? 'link_sent' : 'in_progress'));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { code: 'service_unavailable', message: 'hc-auth' } }, 503));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'ready' }));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ roles: {} }));

    const sign = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const el = linkFlow();
    el.signTimestamp = sign;
    const completed = new Promise<JoinCompleteDetail>((resolve) => {
      el.addEventListener('join-complete', ((e: CustomEvent<JoinCompleteDetail>) => resolve(e.detail)) as EventListener);
    });
    document.body.appendChild(el);
    await completed;

    const join = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(join).toMatchObject({ timestamp: sign.mock.calls[0][0], signature: 'AQID' });
    expect(statusCalls(fetchSpy)).toBe(37);

    document.body.appendChild(document.createElement('div'));
    document.body.insertBefore(el, document.body.lastChild);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).toHaveBeenCalledTimes(40);
    el.remove();
  });
});
