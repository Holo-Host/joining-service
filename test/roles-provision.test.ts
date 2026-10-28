import { describe, it, expect } from 'vitest';
import { createTestApp, fakeAgentKey, fakeDnaHash } from './helpers.js';

describe('per-role provision and info', () => {
  it('provision returns per-role membrane proofs and modifiers, and info returns no proof', async () => {
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
    expect((await (await request('/v1/info')).json()).roles).toEqual({
      main: { dna_hash: dnaA, dna_modifiers: { network_seed: 'seed-main' } },
      chat: { dna_hash: dnaB, dna_modifiers: { properties: { progenitor: 'uhCAkX' } } },
    });
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

  it('provision omits membrane_proof but keeps dna_modifiers for a hash-less role when proofs are disabled', async () => {
    const { request } = await createTestApp({
      roles: { main: { modifiers: { network_seed: 's' } } },
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

  it('info returns each role\'s dna hash beside its modifiers, and none for a role without one', async () => {
    const dna = fakeDnaHash(4);
    const { request } = await createTestApp({
      roles: {
        main: { dna_hash: dna, modifiers: { network_seed: 'pub' } },
        chat: { modifiers: { network_seed: 'chat' } },
      },
    });
    const info = await (await request('/v1/info')).json();
    expect(info.roles).toEqual({
      main: { dna_hash: dna, dna_modifiers: { network_seed: 'pub' } },
      chat: { dna_modifiers: { network_seed: 'chat' } },
    });
  });
});
