import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NetworkStore } from '../../src/network-registration/store.js';
import { MemoryNetworkStore } from '../../src/network-registration/memory-store.js';
import { SqliteNetworkStore } from '../../src/network-registration/sqlite-store.js';
import { KvNetworkStore } from '../../src/network-registration/kv-store.js';
import { createMockKV } from '../linker-registration/helpers.js';
import { fakeDnaHash } from '../helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function implementations(): Array<[string, () => NetworkStore]> {
  return [
    ['memory', () => new MemoryNetworkStore()],
    ['sqlite', () => {
      const dir = mkdtempSync(join(tmpdir(), 'network-store-'));
      const store = new SqliteNetworkStore(join(dir, 'networks.db'));
      cleanups.push(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      });
      return store;
    }],
    ['kv', () => new KvNetworkStore(createMockKV())],
  ];
}

describe.each(implementations())('NetworkStore (%s)', (_name, make) => {
  it('put/get round-trips a network with roles, happ metadata, and allowed_agents', async () => {
    const store = make();
    const network = {
      happ_id: 'test-network-1',
      happ: { name: 'test-net', description: 'A test network', icon_url: 'https://example.com/icon.png' },
      roles: {
        role_a: { dna_hash: fakeDnaHash(1) },
        role_b: { dna_hash: fakeDnaHash(2) },
      },
      allowed_agents: ['AgentA', 'AgentB'],
      registered_at: '2026-08-13T00:00:00.000Z',
    };
    await store.put(network);
    const got = await store.get('test-network-1');
    expect(got).toEqual(network);
  });

  it('get returns null for unknown happ_id', async () => {
    const store = make();
    expect(await store.get('unknown-network')).toBeNull();
  });

  it('put is an idempotent upsert by happ_id', async () => {
    const store = make();
    const happId = 'test-network-2';
    const first = {
      happ_id: happId,
      roles: { role_a: { dna_hash: fakeDnaHash(1) } },
      happ: { name: 'first' },
      registered_at: '2026-08-13T00:00:00.000Z',
    };
    const second = {
      happ_id: happId,
      roles: { role_a: { dna_hash: fakeDnaHash(1) }, role_c: { dna_hash: fakeDnaHash(3) } },
      happ: { name: 'updated' },
      registered_at: '2026-08-13T01:00:00.000Z',
    };
    await store.put(first);
    await store.put(second);
    expect((await store.list()).filter((n) => n.happ_id === happId)).toHaveLength(1);
    expect((await store.get(happId))?.happ?.name).toBe('updated');
    expect((await store.get(happId))?.roles).toEqual(second.roles);
  });

  it('list returns all registered networks', async () => {
    const store = make();
    await store.put({
      happ_id: 'net-1',
      roles: { role_a: { dna_hash: fakeDnaHash(1) } },
      registered_at: '2026-08-13T00:00:00.000Z',
    });
    await store.put({
      happ_id: 'net-2',
      roles: { role_b: { dna_hash: fakeDnaHash(2) } },
      registered_at: '2026-08-13T00:00:00.000Z',
    });
    expect(await store.list()).toHaveLength(2);
  });

  it('delete removes a network and tolerates unknown happ_ids', async () => {
    const store = make();
    const happId = 'net-to-delete';
    await store.put({
      happ_id: happId,
      roles: { role_a: { dna_hash: fakeDnaHash(1) } },
      registered_at: '2026-08-13T00:00:00.000Z',
    });
    await store.delete(happId);
    expect(await store.get(happId)).toBeNull();
    await store.delete(happId); // must not throw
  });
});
