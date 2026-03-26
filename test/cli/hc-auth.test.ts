import { describe, it, expect } from 'vitest';
import { formatAuthOutput } from '../../src/cli/hc-auth.js';

describe('formatAuthOutput', () => {
  const result = {
    authBody: '{"pubKey":"abc","payload":"xyz","signature":"sig"}',
    authMaterialBase64: 'eyJwdWJLZXkiOiJhYmMifQ==',
  };

  it('base64 format returns authMaterialBase64', () => {
    expect(formatAuthOutput(result, 'base64')).toBe(result.authMaterialBase64);
  });

  it('json format returns authBody', () => {
    expect(formatAuthOutput(result, 'json')).toBe(result.authBody);
  });

  it('conductor-yaml-patch format returns YAML key-value', () => {
    const output = formatAuthOutput(result, 'conductor-yaml-patch');
    expect(output).toBe(`base64_auth_material: "${result.authMaterialBase64}"`);
  });
});
