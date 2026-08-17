import { describe, it, expect } from 'vitest';
import { MemorySessionStore } from '../src/session/memory-store.js';
import type { SessionData } from '../src/session/store.js';

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: `js_${Math.random().toString(36).slice(2)}`,
    agent_key: 'uhCAkTestAgent',
    status: 'pending',
    challenges: [],
    claims: {},
    created_at: Date.now(),
    ...overrides,
  };
}

describe('MemorySessionStore', () => {
  it('findByAgentKey matches only the exact network scope', async () => {
    const store = new MemorySessionStore();
    await store.create(makeSession({ id: 'js_net_a', network: 'network-a' }));
    await store.create(makeSession({ id: 'js_net_b', network: 'network-b' }));

    expect((await store.findByAgentKey('uhCAkTestAgent', 'network-a'))!.id).toBe('js_net_a');
    expect((await store.findByAgentKey('uhCAkTestAgent', 'network-b'))!.id).toBe('js_net_b');
    expect(await store.findByAgentKey('uhCAkTestAgent', 'network-c')).toBeNull();
  });

  it('treats undefined network as its own scope, distinct from a named network', async () => {
    const store = new MemorySessionStore();
    await store.create(makeSession({ id: 'js_default_scope' }));
    await store.create(makeSession({ id: 'js_named_scope', network: 'network-a' }));

    expect((await store.findByAgentKey('uhCAkTestAgent'))!.id).toBe('js_default_scope');
    expect((await store.findByAgentKey('uhCAkTestAgent', 'network-a'))!.id).toBe('js_named_scope');
  });

  it(
    'findAnyByAgentKey does not let an expired pending session on one network shadow a ' +
      'live ready session on another (expired session created first)',
    async () => {
      const store = new MemorySessionStore(1); // 1 second pending TTL

      await store.create(makeSession({
        id: 'js_shadow_pending',
        network: 'network-a',
        status: 'pending',
        created_at: Date.now() - 2000,
      }));
      await store.create(makeSession({
        id: 'js_shadow_ready',
        network: 'network-b',
        status: 'ready',
        created_at: Date.now() - 10000,
      }));

      const found = await store.findAnyByAgentKey('uhCAkTestAgent');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('js_shadow_ready');
    },
  );

  it(
    'findAnyByAgentKey does not let an expired pending session on one network shadow a ' +
      'live ready session on another (expired session created last)',
    async () => {
      const store = new MemorySessionStore(1); // 1 second pending TTL

      await store.create(makeSession({
        id: 'js_shadow_ready2',
        network: 'network-b',
        status: 'ready',
        created_at: Date.now() - 10000,
      }));
      await store.create(makeSession({
        id: 'js_shadow_pending2',
        network: 'network-a',
        status: 'pending',
        created_at: Date.now() - 2000,
      }));

      const found = await store.findAnyByAgentKey('uhCAkTestAgent');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('js_shadow_ready2');
    },
  );

  it('findAnyByAgentKey returns null when the agent has no sessions', async () => {
    const store = new MemorySessionStore();
    expect(await store.findAnyByAgentKey('uhCAkUnknown')).toBeNull();
  });
});
