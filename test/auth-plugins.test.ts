import { describe, it, expect, vi } from 'vitest';
import { buildAuthPlugins } from '../src/auth-plugins.js';
import { resolveConfig } from '../src/config.js';
import { FileTransport } from '../src/email/file.js';
import { HcAuthClient } from '../src/hc-auth/index.js';
import { MemoryAllowedAgentStore } from '../src/agent-registration/memory-store.js';
import { MemorySessionStore } from '../src/session/memory-store.js';
import { BASE_URL, DIDIT_SERVICE } from './didit/fixtures.js';
import { captureEmails, signingAgent } from './didit/harness.js';
import { takeLink, type DiditWithEmailAuthMethod } from '../src/auth-methods/didit-with-email.js';
import type { AuthMethod } from '../src/types.js';

/**
 * The compile-time exhaustiveness guard lives in src/auth-plugins.ts itself
 * (under src/, so it's covered by `npm run typecheck`; this test file is
 * not). This file only verifies runtime behavior: each method the switch
 * claims to support actually yields a plugin map entry when given its
 * deps, and each unsupported one doesn't.
 */
type ConcreteAuthMethod = Exclude<AuthMethod, `x-${string}`>;

/** Whether buildAuthPlugins currently has a case that produces a plugin for this method. */
const SUPPORTED_BY_SWITCH: Record<ConcreteAuthMethod, boolean> = {
  open: true,
  email_code: true,
  // sms_code, evm_signature, and solana_signature have no server-side
  // AuthMethodPlugin implementation under src/auth-methods/ -- they appear
  // only as client-side UI form hints (src/ui/joining-claims-form.ts etc).
  // buildAuthPlugins falls through to the `default: console.warn(...)`
  // branch for them, so no plugin is registered.
  sms_code: false,
  evm_signature: false,
  solana_signature: false,
  invite_code: true,
  agent_allow_list: true,
  hc_auth_approval: true,
  delegated_verification: true,
  didit_with_email: true,
};

const ALL_CONCRETE_METHODS = Object.keys(SUPPORTED_BY_SWITCH) as ConcreteAuthMethod[];

describe('buildAuthPlugins', () => {
  // email_code and didit_with_email cannot share a config, so each runs with the other left out.
  it.each([
    ['email_code', 'didit_with_email', {}],
    ['didit_with_email', 'email_code', DIDIT_SERVICE],
  ])('produces a plugin for every method the switch claims to support, given its deps, with %s', async (_name, excluded, extra) => {
    const methods = ALL_CONCRETE_METHODS.filter((m) => m !== excluded);
    const config = resolveConfig({
      ...extra,
      happ: { id: 'test-app', name: 'Test App' },
      auth_methods: methods,
      delegated_verification: { trusted_partners: [] },
    });

    const deps = {
      emailTransport: new FileTransport('/tmp/test-emails'),
      hcAuthClient: new HcAuthClient({ url: 'https://auth.example.com', api_token: 'tok' }),
      allowedAgentStore: new MemoryAllowedAgentStore(),
      sessionStore: new MemorySessionStore(),
    };

    const plugins = buildAuthPlugins(config, deps);

    for (const method of methods) {
      if (SUPPORTED_BY_SWITCH[method]) {
        expect(plugins.has(method), `expected a plugin for "${method}"`).toBe(true);
      } else {
        expect(plugins.has(method), `did not expect a plugin for "${method}"`).toBe(false);
      }
    }
  });

  it('builds didit_with_email from config, so its links start with base_url and its email names network_name as happ.name', async () => {
    const sent = captureEmails();
    const config = resolveConfig({ ...DIDIT_SERVICE, happ: { id: 'test-app', name: 'Acme' }, network_name: 'Acme Mainnet' });
    const plugin = buildAuthPlugins(config, {
      emailTransport: new FileTransport('/tmp/test-emails'),
      sessionStore: new MemorySessionStore(),
    }).get('didit_with_email') as DiditWithEmailAuthMethod;
    const { agentKey } = await signingAgent();
    const [challenge] = await plugin.createChallenges(agentKey, { email: 'ada@example.com' }, config);
    await plugin.sendFirst(agentKey, 'ada@example.com', { expires_at: Date.now(), ...takeLink(challenge) });
    expect(sent[0].subject).toBe('Verify your identity to join Acme Mainnet');
    expect(sent[0].senderName).toBe('Acme');
    expect(sent[0].body).toContain(`${BASE_URL}/v1/didit/`);
    vi.restoreAllMocks();
  });

  it('throws for email_code without an emailTransport', () => {
    const config = resolveConfig({
      happ: { id: 'test-app', name: 'Test App' },
      auth_methods: ['email_code'],
    });
    expect(() => buildAuthPlugins(config, {})).toThrow(/email_code auth requires/);
  });

  it('throws for didit_with_email without an emailTransport or a session store', () => {
    const config = resolveConfig({ ...DIDIT_SERVICE, happ: { id: 'test-app', name: 'Test App' } });
    expect(() => buildAuthPlugins(config, { sessionStore: new MemorySessionStore() })).toThrow(
      /didit_with_email auth requires email config/,
    );
    expect(() => buildAuthPlugins(config, { emailTransport: new FileTransport('/tmp/test-emails') })).toThrow(
      /didit_with_email auth requires a session store/,
    );
  });

  it('throws for hc_auth_approval without an hcAuthClient', () => {
    const config = resolveConfig({
      happ: { id: 'test-app', name: 'Test App' },
      auth_methods: ['hc_auth_approval'],
    });
    expect(() => buildAuthPlugins(config, {})).toThrow(/hc_auth_approval auth method requires/);
  });

  it('throws for delegated_verification without config.delegated_verification', () => {
    const config = resolveConfig({
      happ: { id: 'test-app', name: 'Test App' },
      auth_methods: ['delegated_verification'],
    });
    expect(() => buildAuthPlugins(config, {})).toThrow(/delegated_verification auth method requires/);
  });

  it('agent_allow_list works without an allowedAgentStore (static allow list only)', () => {
    const config = resolveConfig({
      happ: { id: 'test-app', name: 'Test App' },
      auth_methods: ['agent_allow_list'],
    });
    const plugins = buildAuthPlugins(config, {});
    expect(plugins.has('agent_allow_list')).toBe(true);
  });
});
