import type { EmailParts, EmailTransport } from './transport.js';

export class PostmarkTransport implements EmailTransport {
  private apiKey: string;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(to: string, subject: string, body: string, parts: EmailParts = {}): Promise<void> {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': this.apiKey,
      },
      body: JSON.stringify({
        From: parts.senderName ? `"${parts.senderName}" <${this.from}>` : this.from,
        To: to,
        Subject: subject,
        TextBody: body,
        ...(parts.html && { HtmlBody: parts.html }),
        // Tracking would send the link through the provider's redirect.
        TrackLinks: 'None',
        TrackOpens: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Postmark API error (${response.status}): ${text}`);
    }
  }
}
