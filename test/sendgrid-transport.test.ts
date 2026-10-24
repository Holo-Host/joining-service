import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SendGridTransport } from '../src/email/sendgrid.js';

describe('SendGridTransport', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends email with correct payload and headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
    });
    globalThis.fetch = mockFetch;

    const transport = new SendGridTransport('SG.test-key', 'noreply@example.com');
    await transport.send('user@example.com', 'Test Subject', 'Hello there');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer SG.test-key');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.personalizations).toEqual([{ to: [{ email: 'user@example.com' }] }]);
    expect(body.from).toEqual({ email: 'noreply@example.com' });
    expect(body.subject).toBe('Test Subject');
    expect(body.content).toEqual([{ type: 'text/plain', value: 'Hello there' }]);
  });

  it('sends the HTML part after the text, from the sender name, with no tracking', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    globalThis.fetch = mockFetch;

    const transport = new SendGridTransport('SG.test-key', 'noreply@example.com');
    await transport.send('user@example.com', 'Subj', 'Text', { html: '<p>Html</p>', senderName: 'Unyt' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.from).toEqual({ email: 'noreply@example.com', name: 'Unyt' });
    expect(body.content).toEqual([
      { type: 'text/plain', value: 'Text' },
      { type: 'text/html', value: '<p>Html</p>' },
    ]);
    expect(body.tracking_settings).toEqual({
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    });
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    globalThis.fetch = mockFetch;

    const transport = new SendGridTransport('SG.bad-key', 'noreply@example.com');
    await expect(transport.send('user@example.com', 'Subj', 'Body')).rejects.toThrow(
      'SendGrid API error (401): Unauthorized',
    );
  });
});
