import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { Challenge, DiditWithEmailMetadata, DiditWithEmailState } from '../types.js';

/** A challenge the person completes away from the app, from an emailed link. */
export const LINK_CHALLENGE_TYPE = 'didit_with_email';

export interface ChallengeResendDetail {
  challengeId: string;
}

export const LINK_CLAIM_INPUT = {
  label: 'Email',
  type: 'email',
  placeholder: 'you@example.com',
  claimKey: 'email',
  description:
    'To join this network, please provide your email address. We will email you a link to verify your identity, which needs an identity document and a phone camera.',
};

const STATE_LINES: Record<DiditWithEmailState, string> = {
  link_sent: 'Waiting for you to open the link.',
  in_progress: 'Verification in progress.',
  in_review: 'Your verification is in review. This can take a few hours.',
  declined: 'Your verification did not pass. Open the link in the email to try again.',
  expired: 'Your verification timed out. Open the link in the email to start again.',
  approved: 'Your identity is verified.',
};

function linkMetadata(challenge: Challenge): Partial<DiditWithEmailMetadata> {
  return (challenge.metadata ?? {}) as Partial<DiditWithEmailMetadata>;
}

export function linkStateLine(challenge: Challenge): string {
  const state = linkMetadata(challenge).state;
  return state && Object.hasOwn(STATE_LINES, state) ? STATE_LINES[state] : STATE_LINES.link_sent;
}

/** setTimeout fires at once for a longer delay. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Re-renders its host when the challenge's resend becomes available. */
export class ResendClock implements ReactiveController {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly challenge: () => Challenge | null,
  ) {
    host.addController(this);
  }

  get ready(): boolean {
    return this.wait() <= 0;
  }

  hostUpdated(): void {
    clearTimeout(this.timer);
    const wait = this.wait();
    if (wait > 0) this.timer = setTimeout(() => this.host.requestUpdate(), Math.min(wait, MAX_TIMEOUT_MS));
  }

  hostDisconnected(): void {
    clearTimeout(this.timer);
  }

  private wait(): number {
    const challenge = this.challenge();
    const at = challenge ? Date.parse(linkMetadata(challenge).resend_available_at ?? '') : NaN;
    return Number.isNaN(at) ? 0 : at - Date.now();
  }
}
