import type { Challenge } from '../types.js';
import type { NetworkRecord } from '../network-registration/store.js';

/** Per-join context available to auth methods, e.g. the named network being joined. */
export interface JoinContext {
  network?: NetworkRecord;
}

/** Answers the request with this error. During a join, any other throw from a method only rules that method out. */
export class JoinRequestError extends Error {
  constructor(
    readonly status: 400 | 429 | 503,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'JoinRequestError';
  }
}

export interface AuthMethodPlugin {
  type: string;

  createChallenges(
    agentKey: string,
    claims: Record<string, string>,
    config: unknown,
    joinContext?: JoinContext,
  ): Promise<Challenge[]>;

  verifyChallengeResponse(
    challenge: Challenge,
    response: string,
    claims: Record<string, string>,
  ): Promise<{ passed: boolean; reason?: string }>;
}
