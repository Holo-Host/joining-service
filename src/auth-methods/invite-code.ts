import type { Challenge } from '../types.js';
import type { AuthMethodPlugin } from './plugin.js';

export class InviteCodeAuthMethod implements AuthMethodPlugin {
  type = 'invite_code';

  private validCodes: Set<string>;

  constructor(validCodes: string[]) {
    this.validCodes = new Set(validCodes);
  }

  async createChallenges(
    _agentKey: string,
    claims: Record<string, string>,
  ): Promise<Challenge[]> {
    const code = claims.invite_code;
    if (!code) {
      throw new Error('invite_code claim is required');
    }

    // Invite codes are validated at join time, not as a challenge flow.
    // We create a single challenge that is auto-verified.
    return [
      {
        id: `ch_invite_${Date.now()}`,
        type: 'invite_code',
        description: 'Validating invite code',
        metadata: { invite_code: code },
      },
    ];
  }

  async verifyChallengeResponse(
    challenge: Challenge,
    response: string,
  ): Promise<{ passed: boolean; reason?: string }> {
    const code =
      response || (challenge.metadata?.invite_code as string | undefined);
    if (!code) {
      return { passed: false, reason: 'No invite code provided' };
    }

    if (this.validCodes.has(code)) {
      // Single-use: remove after successful use
      this.validCodes.delete(code);
      return { passed: true };
    }

    return { passed: false, reason: 'Invalid or already-used invite code' };
  }

  restore(code: string): void {
    this.validCodes.add(code);
  }
}
