import { describe, it, expect } from 'vitest';
import { createTestApp, fakeAgentKey, fakeDnaHash } from './helpers.js';

describe('per-role provision and info', () => {
  it('provision returns per-role membrane proofs and modifiers', async () => {
    const dnaA = fakeDnaHash(1);
    const dnaB = fakeDnaHash(2);
    const { request } = await createTestApp({
      membrane_proof: { enabled: true },
      roles: {
        main: { dna_hash: dnaA, modifiers: { network_seed: 'seed-main' } },
        chat: { dna_hash: dnaB, modifiers: { properties: { progenitor: 'uhCAkX' } } },
      },
    });
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });
    const { session } = await joinRes.json();
    const prov = await (await request(`/v1/join/${session}/provision`)).json();

    expect(prov.roles.main.membrane_proof).toBeTypeOf('string');
    expect(prov.roles.main.dna_modifiers).toEqual({ network_seed: 'seed-main' });
    expect(prov.roles.chat.membrane_proof).toBeTypeOf('string');
    expect(prov.roles.chat.dna_modifiers).toEqual({ properties: { progenitor: 'uhCAkX' } });
    expect(prov.roles.main.membrane_proof).not.toBe(prov.roles.chat.membrane_proof);
  });

  it('provision returns per-role modifiers without proofs when membrane_proof disabled', async () => {
    const { request } = await createTestApp({
      roles: { main: { dna_hash: fakeDnaHash(3), modifiers: { network_seed: 's' } } },
    });
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: fakeAgentKey() }),
    });
    const { session } = await joinRes.json();
    const prov = await (await request(`/v1/join/${session}/provision`)).json();
    expect(prov.roles.main.membrane_proof).toBeUndefined();
    expect(prov.roles.main.dna_modifiers).toEqual({ network_seed: 's' });
  });

  it('info exposes per-role modifiers but never dna hashes or proofs', async () => {
    const { request } = await createTestApp({
      roles: { main: { dna_hash: fakeDnaHash(4), modifiers: { network_seed: 'pub' } } },
    });
    const info = await (await request('/v1/info')).json();
    expect(info.roles.main.dna_modifiers).toEqual({ network_seed: 'pub' });
    expect(info.roles.main.dna_hash).toBeUndefined();
    expect(info.roles.main.membrane_proof).toBeUndefined();
  });
});
