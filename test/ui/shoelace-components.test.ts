// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AuthMethodEntry } from '../../src/types.js';
import type { Challenge } from '../../src/types.js';
import '../../src/ui/shoelace/index.js';
import type { JoiningClaimsFormSl } from '../../src/ui/shoelace/joining-claims-form-sl.js';
import type { JoiningChallengeDialogSl } from '../../src/ui/shoelace/joining-challenge-dialog-sl.js';
import type { JoiningStatusSl } from '../../src/ui/shoelace/joining-status-sl.js';
import type { JoiningFlowSl } from '../../src/ui/shoelace/joining-flow-sl.js';
import type { ClaimsSubmittedDetail } from '../../src/ui/joining-claims-form.js';
import type { ChallengeResponseDetail } from '../../src/ui/joining-challenge-dialog.js';
import type { JoinCompleteDetail } from '../../src/ui/joining-flow.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('JoiningClaimsFormSl', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders nothing for automatic auth methods', async () => {
    const el = document.createElement('joining-claims-form-sl') as JoiningClaimsFormSl;
    el.authMethods = ['open'];
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('form')).toBeNull();
  });

  it('renders sl-input for invite_code', async () => {
    const el = document.createElement('joining-claims-form-sl') as JoiningClaimsFormSl;
    el.authMethods = ['invite_code'];
    document.body.appendChild(el);
    await el.updateComplete;
    const input = el.shadowRoot!.querySelector('sl-input');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('label')).toBe('Invite Code');
  });

  it('renders sl-tab-group for OR groups', async () => {
    const el = document.createElement('joining-claims-form-sl') as JoiningClaimsFormSl;
    el.authMethods = [{ any_of: ['invite_code', 'email_code'] }];
    document.body.appendChild(el);
    await el.updateComplete;
    const tabGroup = el.shadowRoot!.querySelector('sl-tab-group');
    expect(tabGroup).not.toBeNull();
    const tabs = el.shadowRoot!.querySelectorAll('sl-tab');
    expect(tabs.length).toBe(2);
  });

  it('emits claims-submitted with collected values', async () => {
    const el = document.createElement('joining-claims-form-sl') as JoiningClaimsFormSl;
    el.authMethods = ['invite_code'];
    document.body.appendChild(el);
    await el.updateComplete;

    // Simulate input by setting value directly on the component's internal state
    const slInput = el.shadowRoot!.querySelector('sl-input') as HTMLElement;
    // Shoelace inputs emit sl-input events
    Object.defineProperty(slInput, 'value', { value: 'TEST123', writable: true });
    slInput.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
    await el.updateComplete;

    const submitted = new Promise<ClaimsSubmittedDetail>((resolve) => {
      el.addEventListener('claims-submitted', ((e: CustomEvent<ClaimsSubmittedDetail>) => {
        resolve(e.detail);
      }) as EventListener);
    });

    // Click the submit button
    const form = el.shadowRoot!.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const detail = await submitted;
    expect(detail.claims).toEqual({ invite_code: 'TEST123' });
  });

  it('emits claims-cancelled on cancel', async () => {
    const el = document.createElement('joining-claims-form-sl') as JoiningClaimsFormSl;
    el.authMethods = ['invite_code'];
    document.body.appendChild(el);
    await el.updateComplete;

    const cancelled = new Promise<void>((resolve) => {
      el.addEventListener('claims-cancelled', () => resolve());
    });

    const cancelBtn = el.shadowRoot!.querySelector('sl-button[variant="default"]') as HTMLElement;
    cancelBtn.click();
    await cancelled;
  });
});

describe('JoiningChallengeDialogSl', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function makeChallenge(overrides: Partial<Challenge> = {}): Challenge {
    return {
      id: 'ch_1',
      type: 'invite_code',
      description: 'Enter your invite code',
      ...overrides,
    };
  }

  it('renders nothing when no challenge', async () => {
    const el = document.createElement('joining-challenge-dialog-sl') as JoiningChallengeDialogSl;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('sl-dialog')).toBeNull();
  });

  it('renders inline challenge content when open with challenge', async () => {
    const el = document.createElement('joining-challenge-dialog-sl') as JoiningChallengeDialogSl;
    el.challenge = makeChallenge();
    el.open = true;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.heading')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('.description')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('sl-input')).not.toBeNull();
  });

  it('renders spinner for polling types', async () => {
    const el = document.createElement('joining-challenge-dialog-sl') as JoiningChallengeDialogSl;
    el.challenge = makeChallenge({ type: 'hc_auth_approval', description: 'Awaiting approval' });
    el.open = true;
    document.body.appendChild(el);
    await el.updateComplete;
    const spinner = el.shadowRoot!.querySelector('sl-spinner');
    expect(spinner).not.toBeNull();
    // No input for polling types
    expect(el.shadowRoot!.querySelector('sl-input')).toBeNull();
  });

  it('renders nothing for agent_allow_list', async () => {
    const el = document.createElement('joining-challenge-dialog-sl') as JoiningChallengeDialogSl;
    el.challenge = makeChallenge({ type: 'agent_allow_list' });
    el.open = true;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('sl-dialog')).toBeNull();
  });

  it('prompt() resolves with user response', async () => {
    const el = document.createElement('joining-challenge-dialog-sl') as JoiningChallengeDialogSl;
    document.body.appendChild(el);
    await el.updateComplete;

    const challenge = makeChallenge({ id: 'ch_prompt' });
    const resultPromise = el.prompt(challenge);
    await el.updateComplete;

    // Simulate challenge-response event (mimics what happens when user submits)
    el.dispatchEvent(
      new CustomEvent<ChallengeResponseDetail>('challenge-response', {
        detail: { challengeId: 'ch_prompt', response: 'MY_ANSWER' },
        bubbles: true,
        composed: true,
      }),
    );

    const result = await resultPromise;
    expect(result).toBe('MY_ANSWER');
  });
});

describe('JoiningStatusSl', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders nothing when idle', async () => {
    const el = document.createElement('joining-status-sl') as JoiningStatusSl;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('sl-alert')).toBeNull();
  });

  it('renders sl-alert for connecting status', async () => {
    const el = document.createElement('joining-status-sl') as JoiningStatusSl;
    el.status = 'connecting';
    document.body.appendChild(el);
    await el.updateComplete;
    const alert = el.shadowRoot!.querySelector('sl-alert');
    expect(alert).not.toBeNull();
    expect(alert!.getAttribute('variant')).toBe('primary');
  });

  it('renders spinner for loading states', async () => {
    const el = document.createElement('joining-status-sl') as JoiningStatusSl;
    el.status = 'verifying';
    document.body.appendChild(el);
    await el.updateComplete;
    const spinner = el.shadowRoot!.querySelector('sl-spinner');
    expect(spinner).not.toBeNull();
  });

  it('renders danger alert with retry for error', async () => {
    const el = document.createElement('joining-status-sl') as JoiningStatusSl;
    el.status = 'error';
    el.reason = 'Network failed';
    document.body.appendChild(el);
    await el.updateComplete;
    const alert = el.shadowRoot!.querySelector('sl-alert');
    expect(alert!.getAttribute('variant')).toBe('danger');
    const reason = el.shadowRoot!.querySelector('.reason');
    expect(reason!.textContent).toBe('Network failed');
    const retryBtn = el.shadowRoot!.querySelector('sl-button');
    expect(retryBtn).not.toBeNull();
  });

  it('emits retry event', async () => {
    const el = document.createElement('joining-status-sl') as JoiningStatusSl;
    el.status = 'error';
    document.body.appendChild(el);
    await el.updateComplete;

    const retried = new Promise<void>((resolve) => {
      el.addEventListener('retry', () => resolve());
    });

    const retryBtn = el.shadowRoot!.querySelector('sl-button') as HTMLElement;
    retryBtn.click();
    await retried;
  });
});

describe('JoiningFlowSl', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockFetch.mockReset();
  });

  it('completes open auth flow', async () => {
    // Use URL-based routing because Shoelace sl-icon components also call
    // fetch() to load SVGs, which would consume sequential mocks.
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/info')) {
        return Promise.resolve(jsonResponse({
          happ: { id: 'test', name: 'Test' },
          auth_methods: ['open'],
        }));
      }
      if (urlStr.endsWith('/join') && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ session: 'sess_1', status: 'ready' }, 201));
      }
      if (urlStr.includes('/join/sess_1/provision')) {
        return Promise.resolve(jsonResponse({
          linker_urls: [{ url: 'wss://linker.example.com' }],
          membrane_proofs: { dna1: 'proof' },
        }));
      }
      // Shoelace icon fetches or other requests — return empty response
      return Promise.resolve(new Response('', { status: 200 }));
    });

    const el = document.createElement('joining-flow-sl') as JoiningFlowSl;
    el.agentKey = 'uhCAkTestKey';
    el.serviceUrl = 'https://joining.example.com/v1';

    const completed = new Promise<JoinCompleteDetail>((resolve) => {
      el.addEventListener('join-complete', ((e: CustomEvent<JoinCompleteDetail>) => {
        resolve(e.detail);
      }) as EventListener);
    });

    document.body.appendChild(el);
    const detail = await completed;

    expect(detail.provision.linker_urls).toEqual([{ url: 'wss://linker.example.com' }]);
  });

  it('shows claims form when needed', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).endsWith('/info')) {
        return Promise.resolve(jsonResponse({
          happ: { id: 'test', name: 'Test' },
          auth_methods: ['invite_code'],
        }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    });

    const el = document.createElement('joining-flow-sl') as JoiningFlowSl;
    el.agentKey = 'uhCAkTestKey';
    el.serviceUrl = 'https://joining.example.com/v1';

    document.body.appendChild(el);
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    const claimsForm = el.shadowRoot!.querySelector('joining-claims-form-sl');
    expect(claimsForm).not.toBeNull();
  });
});
