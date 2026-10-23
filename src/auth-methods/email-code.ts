import { randomInt } from 'node:crypto';
import type { EmailTransport } from '../email/transport.js';
import type { Challenge } from '../types.js';
import type { AuthMethodPlugin } from './plugin.js';

interface EmailCodeConfig {
  transport: EmailTransport;
  subject?: string;
  template?: string;
  code_ttl_seconds?: number;
}

function generateCode(): string {
  return String(randomInt(100000, 999999));
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

// We store the expected code in challenge.metadata.expected_code so the
// verify step can compare it. This field is stripped before sending to client.
export class EmailCodeAuthMethod implements AuthMethodPlugin {
  type = 'email_code';

  private transport: EmailTransport;
  private subject: string;
  private template: string;
  private codeTtlSeconds: number;

  constructor(config: EmailCodeConfig) {
    this.transport = config.transport;
    this.subject = config.subject ?? 'Your verification code';
    this.template = config.template ?? 'Your verification code is: {{code}}';
    this.codeTtlSeconds = config.code_ttl_seconds ?? 600;
  }

  async createChallenges(
    _agentKey: string,
    claims: Record<string, string>,
  ): Promise<Challenge[]> {
    const email = claims.email;
    if (!email) {
      throw new Error('email claim is required for email_code auth');
    }

    const code = generateCode();
    const body = this.template.replace('{{code}}', code);
    await this.transport.send(email, this.subject, body);

    const expiresAt = new Date(
      Date.now() + this.codeTtlSeconds * 1000,
    ).toISOString();

    return [
      {
        id: `ch_email_${Date.now()}`,
        type: 'email_code',
        description: `Enter the 6-digit code sent to ${maskEmail(email)}`,
        expires_at: expiresAt,
        metadata: { expected_code: code },
      },
    ];
  }

  async verifyChallengeResponse(
    challenge: Challenge,
    response: string,
  ): Promise<{ passed: boolean; reason?: string }> {
    const expected = challenge.metadata?.expected_code as string | undefined;
    if (!expected) {
      return { passed: false, reason: 'Challenge state missing' };
    }

    if (response.trim() === expected) {
      return { passed: true };
    }

    return { passed: false, reason: 'Incorrect verification code' };
  }
}
