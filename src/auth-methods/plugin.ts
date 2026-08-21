import type { Challenge } from '../types.js';
import type { NetworkRecord } from '../network-registration/store.js';

/** Per-join context available to auth methods, e.g. the named network being joined. */
export interface JoinContext {
  network?: NetworkRecord;
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
