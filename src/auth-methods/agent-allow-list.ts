import { randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import type { AgentPubKeyB64, Challenge } from '../types.js';
import type { AuthMethodPlugin } from './plugin.js';
import type { AllowedAgentStore } from '../agent-registration/store.js';
import { fromBase64, decodeHashFromBase64 } from '../utils.js';

export class AgentAllowListAuthMethod implements AuthMethodPlugin {
  type = 'agent_allow_list';

  private allowedAgents: Set<AgentPubKeyB64>;

  constructor(
    allowedAgents: AgentPubKeyB64[],
    private readonly store?: AllowedAgentStore,
  ) {
    this.allowedAgents = new Set(allowedAgents);
  }

  async createChallenges(
    agentKey: string,
    _claims: Record<string, string>,
  ): Promise<Challenge[]> {
    const allowed =
      this.allowedAgents.has(agentKey) ||
      (this.store ? await this.store.has(agentKey) : false);
    if (!allowed) {
      // Return empty -- in an OR group, other methods can still work.
      // In an AND context, app.ts detects this as an unsatisfiable method.
      return [];
    }

    const nonce = randomBytes(32).toString('base64');
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    return [
      {
        id: `ch_agent_al_${Date.now()}`,
        type: 'agent_allow_list',
        description: 'Sign the nonce with your agent key to prove identity',
        expires_at: expiresAt,
        metadata: { nonce, agent_key: agentKey },
      },
    ];
  }

  async verifyChallengeResponse(
    challenge: Challenge,
    response: string,
  ): Promise<{ passed: boolean; reason?: string }> {
    const nonce = challenge.metadata?.nonce as string | undefined;
    const agentKey = challenge.metadata?.agent_key as string | undefined;

    if (!nonce || !agentKey) {
      return { passed: false, reason: 'Challenge state missing' };
    }

    let sigBytes: Uint8Array;
    try {
      sigBytes = fromBase64(response);
    } catch {
      return { passed: false, reason: 'Invalid signature encoding' };
    }

    const nonceBytes = fromBase64(nonce);
    // Extract raw 32-byte ed25519 public key from 39-byte AgentPubKey
    // (skip 3-byte HoloHash prefix, take 32 bytes, skip 4-byte DHT location)
    const agentKeyBytes = decodeHashFromBase64(agentKey);
    const publicKey = agentKeyBytes.slice(3, 35);

    let valid: boolean;
    try {
      valid = await ed.verifyAsync(sigBytes, nonceBytes, publicKey);
    } catch {
      valid = false;
    }

    if (!valid) {
      return { passed: false, reason: 'Signature does not verify against agent key' };
    }

    return { passed: true };
  }
}
