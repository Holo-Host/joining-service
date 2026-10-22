import { describe, it, expect } from 'vitest';
import { resolveConfig, type ServiceConfig } from '../../src/config.js';
import { DIDIT_SERVICE } from './fixtures.js';

const HAPP = { id: 'test-app', name: 'Test App' };

function resolve(overrides: Partial<ServiceConfig>) {
  return () => resolveConfig({ ...DIDIT_SERVICE, happ: HAPP, ...overrides });
}

describe('resolveConfig for didit_with_email', () => {
  it('accepts the documented config', () => {
    expect(resolve({})).not.toThrow();
    expect(resolve({ auth_methods: [{ any_of: ['agent_allow_list', 'delegated_verification', 'didit_with_email'] }] }))
      .not.toThrow();
  });

  it.each([
    ['no didit section', { didit: undefined }, /requires a didit block/],
    ['no email transport', { email: undefined }, /requires an email transport/],
    ['an http base_url', { base_url: 'http://join.example.com' }, /https base_url/],
    ['a base_url that is not a URL', { base_url: 'join.example.com' }, /https base_url/],
    ['email_code in its group', { auth_methods: [{ any_of: ['email_code', 'didit_with_email'] }] }, /didit_with_email and email_code/],
  ] as [string, Partial<ServiceConfig>, RegExp][])('refuses %s', (_name, overrides, message) => {
    expect(resolve(overrides)).toThrow(message);
  });

  it('changes nothing for a didit section without the method', () => {
    expect(() =>
      resolveConfig({ happ: HAPP, auth_methods: ['email_code'], didit: { api_key: '' } as never }),
    ).not.toThrow();
  });
});
