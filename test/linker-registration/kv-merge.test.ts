import { describe, it, expect, beforeEach } from 'vitest';
import { KvUrlProvider } from '../../src/urls/kv.js';
import { LinkerRegistrationStore } from '../../src/linker-registration/store.js';
import type { LinkerRegistration } from '../../src/linker-auth/types.js';
import { createMockKV } from './helpers.js';

describe('KvUrlProvider merge', () => {
  let kv: ReturnType<typeof createMockKV>;
  let regStore: LinkerRegistrationStore;

  beforeEach(() => {
    kv = createMockKV();
    regStore = new LinkerRegistrationStore(kv);
  });

  it('returns static registrations when no store provided', async () => {
    const staticRegs: LinkerRegistration[] = [
      { linker_url: { url: 'wss://static.example.com' } },
    ];
    kv.store.set('linker_registrations', { value: JSON.stringify(staticRegs) });

    const provider = new KvUrlProvider(kv);
    const result = await provider.getLinkerRegistrations();
    expect(result).toHaveLength(1);
    expect(result![0].linker_url.url).toBe('wss://static.example.com');
  });

  it('returns dynamic registrations when no static key exists', async () => {
    await regStore.putLinker(
      {
        pubkey: 'key1',
        invite_token: 'lnk_test',
        capabilities: ['dht_read'],
        admin_secret: 'secret',
        linker_url: 'wss://dynamic.example.com',
        admin_url: 'https://dynamic.example.com',
        last_heartbeat: new Date().toISOString(),
      },
      600,
    );

    const provider = new KvUrlProvider(kv, regStore);
    const result = await provider.getLinkerRegistrations();
    expect(result).toHaveLength(1);
    expect(result![0].linker_url.url).toBe('wss://dynamic.example.com');
    expect(result![0].admin?.url).toBe('https://dynamic.example.com');
  });

  it('merges static and dynamic, deduplicating by URL (static wins)', async () => {
    const staticRegs: LinkerRegistration[] = [
      { linker_url: { url: 'wss://shared.example.com' }, admin: { url: 'https://static-admin', secret: 'static-secret' } },
      { linker_url: { url: 'wss://static-only.example.com' } },
    ];
    kv.store.set('linker_registrations', { value: JSON.stringify(staticRegs) });

    await regStore.putLinker(
      {
        pubkey: 'key1',
        invite_token: 'lnk_test',
        capabilities: ['dht_read'],
        admin_secret: 'dynamic-secret',
        linker_url: 'wss://shared.example.com', // duplicate
        admin_url: 'https://dynamic-admin',
        last_heartbeat: new Date().toISOString(),
      },
      600,
    );
    await regStore.putLinker(
      {
        pubkey: 'key2',
        invite_token: 'lnk_test',
        capabilities: ['dht_read'],
        admin_secret: 'secret2',
        linker_url: 'wss://dynamic-only.example.com',
        admin_url: 'https://dynamic2',
        last_heartbeat: new Date().toISOString(),
      },
      600,
    );

    const provider = new KvUrlProvider(kv, regStore);
    const result = await provider.getLinkerRegistrations();

    // 2 static + 1 unique dynamic = 3 (shared URL deduped)
    expect(result).toHaveLength(3);

    // The shared URL should use static admin info
    const shared = result!.find((r) => r.linker_url.url === 'wss://shared.example.com');
    expect(shared!.admin?.secret).toBe('static-secret');
  });

  it('returns undefined when both sources are empty', async () => {
    const provider = new KvUrlProvider(kv, regStore);
    const result = await provider.getLinkerRegistrations();
    expect(result).toBeUndefined();
  });

  it('getHttpGateways is unchanged', async () => {
    const gateways = [{ url: 'https://gw.example.com', dna_hashes: ['hash1'], status: 'available' as const }];
    kv.store.set('http_gateways', { value: JSON.stringify(gateways) });

    const provider = new KvUrlProvider(kv, regStore);
    const result = await provider.getHttpGateways();
    expect(result).toHaveLength(1);
  });
});
