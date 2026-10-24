// @vitest-environment happy-dom

import { describe, it, expect, vi } from 'vitest';
import { linkPages } from '../../src/auth-methods/didit-with-email-pages.js';

describe('the Copy button on the landing page', () => {
  it.each([
    ['copies the key and says Copied', true],
    ['hides itself, selects the key and asks to copy by hand when the browser refuses', false],
  ])('%s', async (_, allowed) => {
    const key = `uhCAk${'a'.repeat(48)}`;
    const html = await linkPages('Test App').landing({ network: 'Test App', agentKey: key, state: 'link_sent' }).text();
    document.body.innerHTML = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
    const writeText = vi.fn(() => (allowed ? Promise.resolve() : Promise.reject(new Error('NotAllowedError'))));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    new Function(document.querySelector('script')!.textContent!)();

    const copy = document.getElementById('copy')!;
    const failed = document.getElementById('copy-failed')!;
    expect(copy.hidden).toBe(false);
    copy.click();
    expect(writeText).toHaveBeenCalledWith(key);
    if (allowed) {
      await vi.waitFor(() => expect(copy.textContent).toBe('Copied'));
      expect(failed.hidden).toBe(true);
    } else {
      await vi.waitFor(() => expect(failed.hidden).toBe(false));
      expect(copy.hidden).toBe(true);
      expect(getSelection()!.toString()).toBe(key);
    }
  });
});
