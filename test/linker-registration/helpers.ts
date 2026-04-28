import { vi } from 'vitest';
import type { KVNamespace } from '../../src/urls/kv.js';
import type { LinkerInvite, RegisteredLinker } from '../../src/linker-registration/types.js';

export function createMockKV(): KVNamespace & { store: Map<string, { value: string; expirationTtl?: number }> } {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, expirationTtl: opts?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options: { prefix: string }) => {
      const keys: Array<{ name: string }> = [];
      for (const name of store.keys()) {
        if (name.startsWith(options.prefix)) keys.push({ name });
      }
      return { keys };
    }),
  };
}

export function makeInvite(overrides: Partial<LinkerInvite> = {}): LinkerInvite {
  return {
    token: 'lnk_test123',
    capabilities: ['dht_read', 'dht_write'],
    used_by: [],
    created_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeLinker(overrides: Partial<RegisteredLinker> = {}): RegisteredLinker {
  return {
    pubkey: 'dGVzdC1wdWJrZXk=',
    invite_token: 'lnk_test123',
    capabilities: ['dht_read', 'dht_write'],
    admin_secret: 'secret123',
    linker_url: 'wss://linker.example.com:8090',
    admin_url: 'https://linker.example.com',
    last_heartbeat: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}
