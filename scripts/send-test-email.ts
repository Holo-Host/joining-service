#!/usr/bin/env tsx
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveConfig } from '../src/config.js';
import { buildEmailTransport } from '../src/server.js';
import { flattenMethods } from '../src/auth-plugins.js';
import { DiditClient, resolveDiditConfig } from '../src/didit/client.js';
import { DiditWithEmailAuthMethod, takeLink } from '../src/auth-methods/didit-with-email.js';
import { MemorySessionStore } from '../src/session/memory-store.js';
import type { EmailTransport } from '../src/email/transport.js';
import { agentPubKeyFrom32, encodeHashToBase64 } from '../src/utils.js';

const apiKey = process.env.EMAIL_API_KEY ?? '';
const to = process.env.TEST_EMAIL_TO;
const configPath = process.argv[2];

function fail(message: string): never {
  console.error(`send-test-email: ${apiKey ? message.replaceAll(apiKey, '[EMAIL_API_KEY]') : message}`);
  process.exit(1);
}

if (!configPath) fail('usage: npm run send-test-email -- <config.json>');
if (!to) fail('set TEST_EMAIL_TO to the address to send to');
if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) fail('EMAIL_API_KEY holds a space or a character that is not printable ASCII');

let raw;
try {
  raw = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch (err) {
  // JSON.parse quotes the text around a syntax error, which can be a secret.
  fail(err instanceof SyntaxError ? `${configPath} is not valid JSON` : String(err));
}

let refused: unknown;
try {
  const config = resolveConfig({ ...raw, email: raw.email && { ...raw.email, api_key: apiKey || undefined } });
  if (!flattenMethods(config.auth_methods).includes('didit_with_email')) fail('the config does not use didit_with_email');
  if (config.email!.provider !== 'file' && !apiKey) fail('set EMAIL_API_KEY to the email provider API key');
  const provider = buildEmailTransport(config);
  if (!provider) fail('email.provider must be postmark, sendgrid, cloudflare or file');
  // The method logs only the provider's status, and a test send shows its whole answer.
  const transport: EmailTransport = {
    send: (...args) => provider.send(...args).catch((err) => {
      refused = err;
      throw err;
    }),
  };

  const method = new DiditWithEmailAuthMethod({
    client: new DiditClient(resolveDiditConfig(config.didit)),
    store: new MemorySessionStore(),
    transport,
    baseUrl: config.base_url!,
    happName: config.happ.name,
  });
  const agentKey = encodeHashToBase64(agentPubKeyFrom32(randomBytes(32)));
  const [challenge] = await method.createChallenges(agentKey, { email: to }, undefined);
  await method.sendFirst(agentKey, to, { ...takeLink(challenge), expires_at: Date.parse(challenge.expires_at!) });
  console.log(`send-test-email: sent to ${to} through ${config.email!.provider}`);
} catch (err) {
  const shown = refused ?? err;
  fail(shown instanceof Error ? shown.message : String(shown));
}
