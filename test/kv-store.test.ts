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
        'agent:uhCAk_test_agent_key',
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
        'agent:uhCAk_test_agent_key',
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
      expect(kv.delete).toHaveBeenCalledWith('agent:uhCAk_test_agent_key');
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
  });
});
