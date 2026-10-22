// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../../src/ui/joining-flow.js';
import type { JoiningFlow, JoinCompleteDetail, JoinErrorDetail } from '../../src/ui/joining-flow.js';
import { JoiningClient } from '../../src/client/joining.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SERVICE_URL = 'https://joining.example.com/v1';

const MOCK_PROVISION = {
  linker_urls: [{ url: 'wss://linker.example.com' }],
  roles: { dna1: { membrane_proof: 'base64proof' } },
};

function createFlow(opts: {
  agentKey?: string;
  serviceUrl?: string;
  claims?: Record<string, string>;
  signNonce?: (nonce: Uint8Array) => Promise<Uint8Array>;
} = {}): JoiningFlow {
  const el = document.createElement('joining-flow') as JoiningFlow;
  el.agentKey = opts.agentKey ?? 'uhCAkTestAgentKey123456789012345678901234567890';
  el.serviceUrl = opts.serviceUrl ?? SERVICE_URL;
  if (opts.claims) el.claims = opts.claims;
  if (opts.signNonce) el.signNonce = opts.signNonce;
  return el;
}

describe('JoiningFlow', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockFetch.mockReset();
  });

  it('completes open auth flow without user interaction', async () => {
    // getInfo -> open auth
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        happ: { id: 'test', name: 'Test' },
        auth_methods: ['open'],
      }),
    );
    // join -> ready immediately
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ session: 'sess_1', status: 'ready' }, 201),
    );
    // provision
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_PROVISION));

    const el = createFlow();

    const completed = new Promise<JoinCompleteDetail>((resolve) => {
      el.addEventListener('join-complete', ((e: CustomEvent<JoinCompleteDetail>) => {
        resolve(e.detail);
      }) as EventListener);
    });

    document.body.appendChild(el);
    const detail = await completed;

    expect(detail.provision.linker_urls).toEqual(MOCK_PROVISION.linker_urls);
    expect(detail.provision.roles).toEqual(MOCK_PROVISION.roles);
  });

  it('completes invite_code flow with pre-filled claims', async () => {
    // getInfo
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        happ: { id: 'test', name: 'Test' },
        auth_methods: ['invite_code'],
      }),
    );
    // join -> pending with challenge
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        session: 'sess_2',
        status: 'pending',
        challenges: [{
          id: 'ch_1',
          type: 'invite_code',
          description: 'Enter invite code',
          completed: true,
        }],
      }, 201),
    );
    // Since challenge is completed, poll -> ready
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ session: 'sess_2', status: 'ready' }),
    );
    // provision
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_PROVISION));

    const el = createFlow({ claims: { invite_code: 'ABC123' } });

    const completed = new Promise<JoinCompleteDetail>((resolve) => {
      el.addEventListener('join-complete', ((e: CustomEvent<JoinCompleteDetail>) => {
        resolve(e.detail);
      }) as EventListener);
    });

    document.body.appendChild(el);
    const detail = await completed;

    expect(detail.claims).toEqual({ invite_code: 'ABC123' });
    expect(detail.provision).toEqual(MOCK_PROVISION);

    // Verify claims were actually sent in the join request body
    const joinCall = mockFetch.mock.calls[1];
    const joinBody = JSON.parse(joinCall[1].body);
    expect(joinBody.claims).toEqual({ invite_code: 'ABC123' });
  });

  it('shows claims form when no pre-filled claims for invite_code', async () => {
    // getInfo
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        happ: { id: 'test', name: 'Test' },
        auth_methods: ['invite_code'],
      }),
    );

    const el = createFlow();
    document.body.appendChild(el);
    await el.updateComplete;

    // Should be in collecting-claims state and show the claims form
    // Need to wait for the async start() to proceed
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    const claimsForm = el.querySelector('joining-claims-form');
    expect(claimsForm).not.toBeNull();
  });

  it('handles agent_allow_list automatically', async () => {
    const signNonce = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));

    // getInfo
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        happ: { id: 'test', name: 'Test' },
        auth_methods: ['agent_allow_list'],
      }),
    );
    // join -> pending with agent_allow_list challenge
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        session: 'sess_3',
        status: 'pending',
        challenges: [{
          id: 'ch_aw',
          type: 'agent_allow_list',
          description: 'Sign nonce',
          metadata: { nonce: btoa('testnonce') },
        }],
      }, 201),
    );
    // verify -> ready
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: 'ready' }),
    );
    // provision
    mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_PROVISION));

    const el = createFlow({ signNonce });

    const completed = new Promise<JoinCompleteDetail>((resolve) => {
      el.addEventListener('join-complete', ((e: CustomEvent<JoinCompleteDetail>) => {
        resolve(e.detail);
      }) as EventListener);
    });

    document.body.appendChild(el);
    const detail = await completed;

    expect(signNonce).toHaveBeenCalledOnce();
    expect(detail.provision).toEqual(MOCK_PROVISION);
  });

  it('emits join-error on rejection', async () => {
    // getInfo
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        happ: { id: 'test', name: 'Test' },
        auth_methods: ['open'],
      }),
    );
    // join -> rejected (403 with error details)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        error: {
          code: 'join_rejected',
          message: 'Not allowed',
        },
      }, 403),
    );

    const el = createFlow();

    const errored = new Promise<JoinErrorDetail>((resolve) => {
      el.addEventListener('join-error', ((e: CustomEvent<JoinErrorDetail>) => {
        resolve(e.detail);
      }) as EventListener);
    });

    document.body.appendChild(el);
    const detail = await errored;

    expect(detail.error.message).toBe('Not allowed');
    expect((el as any).flowStatus).toBe('rejected');
  });

  it('stops waiting for hc-auth approval once its dialog is cancelled', async () => {
    const challenge = { id: 'ch_hc', type: 'hc_auth_approval', description: 'Waiting for approval' };
    mockFetch.mockResolvedValueOnce(jsonResponse({ happ: { id: 't', name: 'T' }, auth_methods: ['hc_auth_approval'] }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ session: 'js_hc', status: 'pending', challenges: [challenge], poll_interval_ms: 1 }, 201),
    );
    let answer!: (res: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));
    mockFetch.mockRejectedValue(new TypeError('no answer queued'));
    const el = createFlow({ claims: { hc_auth_approval: 'ada@example.com' } });
    const errors: JoinErrorDetail[] = [];
    el.addEventListener('join-error', ((e: CustomEvent<JoinErrorDetail>) => {
      errors.push(e.detail);
    }) as EventListener);
    document.body.appendChild(el);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    await el.updateComplete;

    el.querySelector('joining-challenge-dialog')!.dispatchEvent(new CustomEvent('challenge-cancelled'));
    answer(jsonResponse({ status: 'pending', challenges: [challenge], poll_interval_ms: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await el.updateComplete;
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(el.querySelector('joining-challenge-dialog')).toBeNull();
    expect(errors).toHaveLength(1);
    el.remove();
  });

  it('emits join-error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const el = createFlow();

    const errored = new Promise<JoinErrorDetail>((resolve) => {
      el.addEventListener('join-error', ((e: CustomEvent<JoinErrorDetail>) => {
        resolve(e.detail);
      }) as EventListener);
    });

    document.body.appendChild(el);
    const detail = await errored;

    expect(detail.error.message).toBe('Network error');
    expect((el as any).flowStatus).toBe('error');
  });
});
