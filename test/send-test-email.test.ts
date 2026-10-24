import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BASE_URL, DIDIT_SERVICE } from './didit/fixtures.js';

const run = promisify(execFile);
const KEY = 'SG.key-from-the-env';

describe('npm run send-test-email', () => {
  let dir: string;
  let config: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'send-test-email-'));
    config = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sendTestEmail() {
    return run('npm', ['run', '--silent', 'send-test-email', '--', config], {
      env: { ...process.env, EMAIL_API_KEY: KEY, TEST_EMAIL_TO: 'ada@example.com' },
    });
  }

  it('writes one email with both parts through the file transport, and never prints the API key', async () => {
    const outbox = join(dir, 'outbox');
    writeFileSync(config, JSON.stringify({
      ...DIDIT_SERVICE,
      happ: { id: 'unyt', name: 'Unyt' },
      email: { provider: 'file', output_dir: outbox, api_key: 'key-from-the-file' },
    }));

    const { stdout, stderr } = await sendTestEmail();

    expect(stdout).toContain('sent to ada@example.com through file');
    for (const secret of [KEY, 'key-from-the-file']) expect(stdout + stderr).not.toContain(secret);
    const files = readdirSync(outbox).sort();
    expect(files).toEqual([expect.stringMatching(/_ada@example\.com\.html$/), expect.stringMatching(/_ada@example\.com\.txt$/)]);
    const [html, text] = files.map((f) => readFileSync(join(outbox, f), 'utf-8'));
    const link = new RegExp(`${BASE_URL}/v1/didit/[A-Za-z0-9_-]{43}`).exec(text)![0];
    expect(html).toContain(`<a href="${link}"`);
    expect(html).toContain('>Verify your identity</a>');
  }, 30_000);

  it('exits non-zero on a config that is not JSON, without quoting it', async () => {
    writeFileSync(config, '{"email": {"api_key": SG.key-in-a-broken-file}}');

    const failed = await sendTestEmail().then(() => undefined, (err) => err);

    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('is not valid JSON');
    expect(failed.stdout + failed.stderr).not.toContain('key-in');
  }, 30_000);
});
