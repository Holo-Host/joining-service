import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KvSessionStore } from '../src/session/kv-store.js';
import type { SessionData } from '../src/session/store.js';

function createMockKV() {
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
    list: vi.fn(async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? '';
      const keys: Array<{ name: string }> = [];
      for (const name of store.keys()) {
        if (name.startsWith(prefix)) keys.push({ name });
      }
      return { keys };
    }),
  };
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'sess-123',
    agent_key: 'uhCAk_test_agent_key',
    status: 'pending',
    challenges: [],
    claims: {},
    created_at: Date.now(),
    ...overrides,
  };
}

describe('KvSessionStore', () => {
  let kv: ReturnType<typeof createMockKV>;
  let store: KvSessionStore;

  beforeEach(() => {
    kv = createMockKV();
    store = new KvSessionStore(kv, 86400);
  });

  describe('create', () => {
    it('stores session and agent index in KV', async () => {
      const session = makeSession();
      await store.create(session);

      expect(kv.put).toHaveBeenCalledTimes(2);
      expect(kv.put).toHaveBeenCalledWith(
        'session:sess-123',
        JSON.stringify(session),
        { expirationTtl: 86400 },
      );
      expect(kv.put).toHaveBeenCalledWith(
        'agent:uhCAk_test_agent_key\0',
        'sess-123',
        { expirationTtl: 86400 },
      );
    });

    it('does not set TTL for ready sessions', async () => {
      const session = makeSession({ status: 'ready' });
      await store.create(session);

      expect(kv.put).toHaveBeenCalledWith(
        'session:sess-123',
        expect.any(String),
        {},
      );
    });
  });

  describe('get', () => {
    it('returns session data', async () => {
      const session = makeSession();
      await store.create(session);

      const result = await store.get('sess-123');
      expect(result).toEqual(session);
    });

    it('returns null for missing session', async () => {
      const result = await store.get('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('merges partial data', async () => {
      const session = makeSession();
      await store.create(session);

      await store.update('sess-123', { status: 'ready' });

      const result = await store.get('sess-123');
      expect(result?.status).toBe('ready');
      expect(result?.agent_key).toBe('uhCAk_test_agent_key');
    });

    it('refreshes agent index on status change', async () => {
      const session = makeSession();
      await store.create(session);
      kv.put.mockClear();

      await store.update('sess-123', { status: 'ready' });

      // Should write both session and agent index (no TTL for ready)
      expect(kv.put).toHaveBeenCalledWith(
        'agent:uhCAk_test_agent_key\0',
        'sess-123',
        {},
      );
    });

    it('does nothing for missing session', async () => {
      kv.put.mockClear();
      await store.update('nonexistent', { status: 'ready' });
      expect(kv.put).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('removes session and agent index', async () => {
      const session = makeSession();
      await store.create(session);

      await store.delete('sess-123');

      expect(kv.delete).toHaveBeenCalledWith('session:sess-123');
      expect(kv.delete).toHaveBeenCalledWith('agent:uhCAk_test_agent_key\0');
    });

    it('handles deleting nonexistent session', async () => {
      await store.delete('nonexistent');
      expect(kv.delete).toHaveBeenCalledWith('session:nonexistent');
    });
  });

  describe('findByAgentKey', () => {
    it('finds session by agent key', async () => {
      const session = makeSession();
      await store.create(session);

      const result = await store.findByAgentKey('uhCAk_test_agent_key');
      expect(result).toEqual(session);
    });

    it('returns null for unknown agent key', async () => {
      const result = await store.findByAgentKey('unknown');
      expect(result).toBeNull();
    });

    it('matches only the exact network scope', async () => {
      const onNetworkA = makeSession({ id: 'sess-a', network: 'network-a' });
      const onNetworkB = makeSession({ id: 'sess-b', network: 'network-b' });
      await store.create(onNetworkA);
      await store.create(onNetworkB);

      expect(await store.findByAgentKey('uhCAk_test_agent_key', 'network-a')).toEqual(onNetworkA);
      expect(await store.findByAgentKey('uhCAk_test_agent_key', 'network-b')).toEqual(onNetworkB);
      expect(await store.findByAgentKey('uhCAk_test_agent_key', 'network-c')).toBeNull();
    });

    it('treats undefined network as its own scope, distinct from a named network', async () => {
      const noNetwork = makeSession({ id: 'sess-default' });
      const named = makeSession({ id: 'sess-named', network: 'network-a' });
      await store.create(noNetwork);
      await store.create(named);

      expect(await store.findByAgentKey('uhCAk_test_agent_key')).toEqual(noNetwork);
      expect(await store.findByAgentKey('uhCAk_test_agent_key', 'network-a')).toEqual(named);
    });
  });

  describe('findAnyByAgentKey', () => {
    it('finds a session for the agent regardless of network', async () => {
      const session = makeSession({ id: 'sess-a', network: 'network-a' });
      await store.create(session);

      const result = await store.findAnyByAgentKey('uhCAk_test_agent_key');
      expect(result).toEqual(session);
    });

    it('finds one of several sessions across networks for the same agent', async () => {
      const onNetworkA = makeSession({ id: 'sess-a', network: 'network-a' });
      const onNetworkB = makeSession({ id: 'sess-b', network: 'network-b' });
      await store.create(onNetworkA);
      await store.create(onNetworkB);

      const result = await store.findAnyByAgentKey('uhCAk_test_agent_key');
      expect(['sess-a', 'sess-b']).toContain(result?.id);
    });

    it('returns null for unknown agent key', async () => {
      const result = await store.findAnyByAgentKey('unknown');
      expect(result).toBeNull();
    });

    it('does not let a stale index entry on one network shadow a live session on another', async () => {
      const pendingOnA = makeSession({ id: 'sess-pending', network: 'network-a', status: 'pending' });
      const readyOnB = makeSession({ id: 'sess-ready', network: 'network-b', status: 'ready' });
      await store.create(pendingOnA);
      await store.create(readyOnB);

      // Simulate KV's native TTL having expired the pending session's value
      // while its agent-index entry has not yet been swept -- the fix must
      // continue past this stale entry rather than stopping on it.
      kv.store.delete('session:sess-pending');

      const found = await store.findAnyByAgentKey('uhCAk_test_agent_key');
      expect(found).toEqual(readyOnB);
    });

    it('does not let a stale index entry shadow a live session, regardless of creation order', async () => {
      const readyOnB = makeSession({ id: 'sess-ready', network: 'network-b', status: 'ready' });
      const pendingOnA = makeSession({ id: 'sess-pending', network: 'network-a', status: 'pending' });
      await store.create(readyOnB);
      await store.create(pendingOnA);

      kv.store.delete('session:sess-pending');

      const found = await store.findAnyByAgentKey('uhCAk_test_agent_key');
      expect(found).toEqual(readyOnB);
    });

    it('does not let a live pending session on one network shadow a ready session on another (pending created first)', async () => {
      const pendingOnA = makeSession({ id: 'sess-pending', network: 'network-a', status: 'pending' });
      const readyOnB = makeSession({ id: 'sess-ready', network: 'network-b', status: 'ready' });
      await store.create(pendingOnA);
      await store.create(readyOnB);

      const found = await store.findAnyByAgentKey('uhCAk_test_agent_key');
      expect(found).toEqual(readyOnB);
    });

    it('does not let a live pending session on one network shadow a ready session on another (pending created last)', async () => {
      const readyOnB = makeSession({ id: 'sess-ready', network: 'network-b', status: 'ready' });
      const pendingOnA = makeSession({ id: 'sess-pending', network: 'network-a', status: 'pending' });
      await store.create(readyOnB);
      await store.create(pendingOnA);

      const found = await store.findAnyByAgentKey('uhCAk_test_agent_key');
      expect(found).toEqual(readyOnB);
    });
  });
});
