import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AllowedAgentStore } from '../../src/agent-registration/store.js';
import { MemoryAllowedAgentStore } from '../../src/agent-registration/memory-store.js';
import { SqliteAllowedAgentStore } from '../../src/agent-registration/sqlite-store.js';
import { KvAllowedAgentStore } from '../../src/agent-registration/kv-store.js';
import { createMockKV } from '../linker-registration/helpers.js';
import { fakeAgentKey } from '../helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function implementations(): Array<[string, () => AllowedAgentStore]> {
  return [
    ['memory', () => new MemoryAllowedAgentStore()],
    ['sqlite', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-store-'));
      const store = new SqliteAllowedAgentStore(join(dir, 'agents.db'));
      cleanups.push(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      });
      return store;
    }],
    ['kv', () => new KvAllowedAgentStore(createMockKV())],
  ];
}

describe.each(implementations())('AllowedAgentStore (%s)', (_name, make) => {
  it('put/get/has round-trips an agent', async () => {
    const store = make();
    const key = fakeAgentKey(1);
    await store.put({ agent_key: key, label: 'progenitor', registered_at: '2026-08-13T00:00:00.000Z' });
    expect(await store.has(key)).toBe(true);
    const got = await store.get(key);
    expect(got?.label).toBe('progenitor');
  });

  it('has/get return false/null for unknown agents', async () => {
    const store = make();
    expect(await store.has(fakeAgentKey(9))).toBe(false);
    expect(await store.get(fakeAgentKey(9))).toBeNull();
  });

  it('put is an idempotent upsert by agent_key', async () => {
    const store = make();
    const key = fakeAgentKey(2);
    await store.put({ agent_key: key, registered_at: '2026-08-13T00:00:00.000Z' });
    await store.put({ agent_key: key, label: 'updated', registered_at: '2026-08-13T01:00:00.000Z' });
    expect((await store.list()).filter((a) => a.agent_key === key)).toHaveLength(1);
    expect((await store.get(key))?.label).toBe('updated');
  });

  it('list returns all registered agents', async () => {
    const store = make();
    await store.put({ agent_key: fakeAgentKey(3), registered_at: '2026-08-13T00:00:00.000Z' });
    await store.put({ agent_key: fakeAgentKey(4), registered_at: '2026-08-13T00:00:00.000Z' });
    expect(await store.list()).toHaveLength(2);
  });

  it('delete removes an agent and tolerates unknown keys', async () => {
    const store = make();
    const key = fakeAgentKey(5);
    await store.put({ agent_key: key, registered_at: '2026-08-13T00:00:00.000Z' });
    await store.delete(key);
    expect(await store.has(key)).toBe(false);
    await store.delete(key); // must not throw
  });
});
