import { describe, it, expect } from 'vitest';
import { buildAuthPlugins } from '../src/auth-plugins.js';
import { resolveConfig } from '../src/config.js';
import { FileTransport } from '../src/email/file.js';
import { HcAuthClient } from '../src/hc-auth/index.js';
import { MemoryAllowedAgentStore } from '../src/agent-registration/memory-store.js';
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
};

const ALL_CONCRETE_METHODS = Object.keys(SUPPORTED_BY_SWITCH) as ConcreteAuthMethod[];

describe('buildAuthPlugins', () => {
  it('produces a plugin for every method the switch claims to support, given its deps', async () => {
    const config = resolveConfig({
      happ: { id: 'test-app', name: 'Test App' },
      auth_methods: ALL_CONCRETE_METHODS,
      delegated_verification: { trusted_partners: [] },
    });

    const deps = {
      emailTransport: new FileTransport('/tmp/test-emails'),
      hcAuthClient: new HcAuthClient({ url: 'https://auth.example.com', api_token: 'tok' }),
      allowedAgentStore: new MemoryAllowedAgentStore(),
    };

    const plugins = buildAuthPlugins(config, deps);

    for (const method of ALL_CONCRETE_METHODS) {
      if (SUPPORTED_BY_SWITCH[method]) {
        expect(plugins.has(method), `expected a plugin for "${method}"`).toBe(true);
      } else {
        expect(plugins.has(method), `did not expect a plugin for "${method}"`).toBe(false);
      }
    }
  });

  it('throws for email_code without an emailTransport', () => {
    const config = resolveConfig({
      happ: { id: 'test-app', name: 'Test App' },
      auth_methods: ['email_code'],
    });
    expect(() => buildAuthPlugins(config, {})).toThrow(/email_code auth requires/);
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
