import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmailParts, EmailTransport } from './transport.js';

export class FileTransport implements EmailTransport {
  private outputDir: string;

  constructor(outputDir = './dev-emails') {
    this.outputDir = outputDir;
    mkdirSync(this.outputDir, { recursive: true });
  }

  async send(to: string, subject: string, body: string, parts: EmailParts = {}): Promise<void> {
    const now = new Date();
    const timestamp = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
    const filepath = join(this.outputDir, `${timestamp}_${to}`);

    const content = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${now.toISOString()}`,
      '',
      body,
      '',
    ].join('\n');

    writeFileSync(`${filepath}.txt`, content, 'utf-8');
    if (parts.html) writeFileSync(`${filepath}.html`, parts.html, 'utf-8');
  }
}
