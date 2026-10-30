import type { EmailParts, EmailTransport } from './transport.js';

export class CloudflareTransport implements EmailTransport {
  private accountId: string;
  private apiKey: string;
  private from: string;

  constructor(accountId: string, apiKey: string, from: string) {
    this.accountId = accountId;
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(to: string, subject: string, body: string, parts: EmailParts = {}): Promise<void> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/email/sending/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: parts.senderName ? { address: this.from, name: parts.senderName } : this.from,
        to,
        subject,
        text: body,
        ...(parts.html && { html: parts.html }),
      }),
    });

    const text = await response.text();
    if (!response.ok || !JSON.parse(text).success) {
      throw new Error(`Cloudflare API error (${response.status}): ${text}`);
    }
  }
}
