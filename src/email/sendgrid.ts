import type { EmailParts, EmailTransport } from './transport.js';

export class SendGridTransport implements EmailTransport {
  private apiKey: string;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(to: string, subject: string, body: string, parts: EmailParts = {}): Promise<void> {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: parts.senderName ? { email: this.from, name: parts.senderName } : { email: this.from },
        subject,
        content: [
          { type: 'text/plain', value: body },
          ...(parts.html ? [{ type: 'text/html', value: parts.html }] : []),
        ],
        // Tracking would send the link through the provider's redirect.
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
          subscription_tracking: { enable: false },
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SendGrid API error (${response.status}): ${text}`);
    }
  }
}
