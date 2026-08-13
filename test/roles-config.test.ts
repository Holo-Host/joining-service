import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { fakeDnaHash, fakeAgentKey } from './helpers.js';

const BASE = {
  happ: { id: 'test-happ', name: 'Test' },
  auth_methods: ['open' as const],
};

describe('roles config', () => {
  it('accepts the new roles format with valid DnaHashes', () => {
    const dna = fakeDnaHash(1);
    const cfg = resolveConfig({
      ...BASE,
      roles: {
        main: { dna_hash: dna, modifiers: { network_seed: 'seed-a' } },
        chat: { dna_hash: fakeDnaHash(2) },
      },
    });
    expect(cfg.roles).toBeDefined();
    expect(cfg.roles!.main.dna_hash).toBe(dna);
    expect(cfg.roles!.main.modifiers?.network_seed).toBe('seed-a');
    expect(cfg.roles!.chat.modifiers).toBeUndefined();
  });

  it('rejects a roles entry whose dna_hash is not a valid DnaHash', () => {
    expect(() =>
      resolveConfig({
        ...BASE,
        roles: { main: { dna_hash: 'my_dna_name' } },
      }),
    ).toThrow(/dna_hash/);
  });

  it('rejects an agent-pubkey-prefixed hash in roles.dna_hash', () => {
    // fakeAgentKey produces a 39-byte AgentPubKey (0x84 0x20 0x24) — wrong prefix for a DnaHash (0x84 0x2d 0x24)
    expect(() =>
      resolveConfig({
        ...BASE,
        roles: { main: { dna_hash: fakeAgentKey(1) } },
      }),
    ).toThrow(/dna_hash/);
  });

  it('leaves roles undefined when no DNA config is present', () => {
    const cfg = resolveConfig({ ...BASE });
    expect(cfg.roles).toBeUndefined();
  });

  it('treats an explicitly empty roles map as absent', () => {
    const cfg = resolveConfig({ ...BASE, roles: {} });
    expect(cfg.roles).toBeUndefined();
  });

  it('throws the migration error when dna_hashes is present, in either form', () => {
    const flatArray = { ...BASE, dna_hashes: [fakeDnaHash(1)] };
    expect(() => resolveConfig(flatArray)).toThrow(
      /dna_hashes\/dna_modifiers have been replaced by roles/,
    );

    const roleKeyed = { ...BASE, dna_hashes: { main: fakeDnaHash(1) } };
    expect(() => resolveConfig(roleKeyed)).toThrow(
      /dna_hashes\/dna_modifiers have been replaced by roles/,
    );
  });

  it('throws the migration error when dna_modifiers is present', () => {
    const withModifiers = { ...BASE, dna_modifiers: { network_seed: 'z' } };
    expect(() => resolveConfig(withModifiers)).toThrow(
      /dna_hashes\/dna_modifiers have been replaced by roles/,
    );
  });
});
