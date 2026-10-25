import { describe, it, expect, vi, afterEach } from 'vitest';
import { PostmarkTransport } from '../src/email/postmark.js';

describe('PostmarkTransport', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    ['text alone', undefined, { From: 'noreply@example.com', TextBody: 'Text' }],
    [
      'the HTML part and sender name',
      { html: '<p>Html</p>', senderName: 'Unyt' },
      { From: '"Unyt" <noreply@example.com>', TextBody: 'Text', HtmlBody: '<p>Html</p>' },
    ],
  ])('sends %s with link and open tracking off', async (_name, parts, fields) => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    await new PostmarkTransport('pm-key', 'noreply@example.com').send('user@example.com', 'Subj', 'Text', parts);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(options.headers['X-Postmark-Server-Token']).toBe('pm-key');
    expect(JSON.parse(options.body)).toEqual({
      To: 'user@example.com',
      Subject: 'Subj',
      TrackLinks: 'None',
      TrackOpens: false,
      ...fields,
    });
  });
});
