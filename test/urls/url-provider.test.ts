import { describe, it, expect } from 'vitest';
import { StaticUrlProvider } from '../../src/urls/static.js';
import { KvUrlProvider } from '../../src/urls/kv.js';
import type { HttpGateway } from '../../src/types.js';
import type { LinkerRegistration } from '../../src/linker-auth/types.js';

const GATEWAY: HttpGateway = { url: 'https://gw.example.com', dna_hashes: ['uhC0k123'], status: 'available' };

describe('StaticUrlProvider', () => {
  it('wraps plain string URLs as open linker registrations', async () => {
    const p = new StaticUrlProvider(['wss://l1.example.com:8090', 'wss://l2.example.com:8090']);
    expect(await p.getLinkerRegistrations()).toEqual([
      { linker_url: { url: 'wss://l1.example.com:8090' } },
      { linker_url: { url: 'wss://l2.example.com:8090' } },
    ]);
  });

  it('returns undefined when no linker URLs configured', async () => {
    const p = new StaticUrlProvider();
    expect(await p.getLinkerRegistrations()).toBeUndefined();
  });

  it('returns undefined for empty linker URL array', async () => {
    const p = new StaticUrlProvider([]);
    expect(await p.getLinkerRegistrations()).toBeUndefined();
  });

  it('accepts full LinkerRegistration objects', async () => {
    const regs: LinkerRegistration[] = [
      {
        linker_url: { url: 'wss://l1.example.com:8090' },
        admin: { url: 'https://l1.example.com', secret: 'secret-1' },
      },
    ];
    const p = new StaticUrlProvider(regs);
    expect(await p.getLinkerRegistrations()).toEqual(regs);
  });

  it('returns configured gateways', async () => {
    const p = new StaticUrlProvider(undefined, [GATEWAY]);
    expect(await p.getHttpGateways()).toEqual([GATEWAY]);
  });

  it('returns undefined when no gateways configured', async () => {
    const p = new StaticUrlProvider();
    expect(await p.getHttpGateways()).toBeUndefined();
  });
});

describe('KvUrlProvider', () => {
  function makeKv(data: Record<string, string>) {
    return {
      async get(key: string) { return data[key] ?? null; },
      async put() {},
      async delete() {},
      async list(options: { prefix: string }) {
        const keys = Object.keys(data)
          .filter((k) => k.startsWith(options.prefix))
          .map((name) => ({ name }));
        return { keys };
      },
    };
  }

  it('returns registrations from KV (with expiry)', async () => {
    const reg: LinkerRegistration = {
      linker_url: { url: 'wss://l1.example.com:8090', expires_at: '2026-03-01T00:00:00Z' },
      admin: { url: 'https://l1.example.com', secret: 'secret-1' },
    };
    const kv = makeKv({ linker_registrations: JSON.stringify([reg]) });
    const p = new KvUrlProvider(kv);
    expect(await p.getLinkerRegistrations()).toEqual([reg]);
  });

  it('returns open registrations (no admin credentials) from KV', async () => {
    const reg: LinkerRegistration = { linker_url: { url: 'wss://l1.example.com:8090' } };
    const kv = makeKv({ linker_registrations: JSON.stringify([reg]) });
    const p = new KvUrlProvider(kv);
    expect(await p.getLinkerRegistrations()).toEqual([reg]);
  });

  it('returns undefined when linker_registrations key absent', async () => {
    const p = new KvUrlProvider(makeKv({}));
    expect(await p.getLinkerRegistrations()).toBeUndefined();
  });

  it('returns undefined when linker_registrations is empty array in KV', async () => {
    const p = new KvUrlProvider(makeKv({ linker_registrations: '[]' }));
    expect(await p.getLinkerRegistrations()).toBeUndefined();
  });

  it('returns gateways from KV', async () => {
    const kv = makeKv({ http_gateways: JSON.stringify([GATEWAY]) });
    const p = new KvUrlProvider(kv);
    expect(await p.getHttpGateways()).toEqual([GATEWAY]);
  });

  it('returns undefined when http_gateways key absent', async () => {
    const p = new KvUrlProvider(makeKv({}));
    expect(await p.getHttpGateways()).toBeUndefined();
  });

  it('reflects KV updates between calls', async () => {
    const data: Record<string, string> = {};
    const kv = makeKv(data);
    const p = new KvUrlProvider(kv);

    expect(await p.getLinkerRegistrations()).toBeUndefined();

    const reg: LinkerRegistration = { linker_url: { url: 'wss://new.example.com:8090' } };
    data.linker_registrations = JSON.stringify([reg]);
    expect(await p.getLinkerRegistrations()).toEqual([reg]);
  });
});
