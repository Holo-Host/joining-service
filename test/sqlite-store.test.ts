import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteSessionStore } from '../src/session/sqlite-store.js';
import type { SessionData } from '../src/session/store.js';

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: `js_${Math.random().toString(36).slice(2)}`,
    agent_key: 'uhCAkTestAgent',
    status: 'pending',
    challenges: [],
    claims: { email: 'test@example.com' },
    created_at: Date.now(),
    ...overrides,
  };
}

describe('SqliteSessionStore', () => {
  let tmpDir: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-test-'));
    store = new SqliteSessionStore(join(tmpDir, 'sessions.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates and retrieves a session', async () => {
    const session = makeSession({ id: 'js_abc123' });
    await store.create(session);

    const retrieved = await store.get('js_abc123');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('js_abc123');
    expect(retrieved!.agent_key).toBe('uhCAkTestAgent');
    expect(retrieved!.status).toBe('pending');
    expect(retrieved!.claims).toEqual({ email: 'test@example.com' });
  });

  it('returns null for nonexistent session', async () => {
    const result = await store.get('js_nonexistent');
    expect(result).toBeNull();
  });

  it('updates session status and challenges', async () => {
    const session = makeSession({
      id: 'js_update',
      challenges: [
        {
          challenge: {
            id: 'ch_1',
            type: 'email_code',
            description: 'Enter code',
          },
          expected_response: '123456',
          completed: false,
          attempts: 0,
          expires_at: Date.now() + 600_000,
        },
      ],
    });
    await store.create(session);

    // Mark challenge completed and status ready
    const updatedChallenges = [...session.challenges];
    updatedChallenges[0].completed = true;
    updatedChallenges[0].attempts = 1;

    await store.update('js_update', {
      status: 'ready',
      challenges: updatedChallenges,
    });

    const retrieved = await store.get('js_update');
    expect(retrieved!.status).toBe('ready');
    expect(retrieved!.challenges[0].completed).toBe(true);
    expect(retrieved!.challenges[0].attempts).toBe(1);
  });

  it('deletes a session', async () => {
    const session = makeSession({ id: 'js_delete' });
    await store.create(session);

    await store.delete('js_delete');
    const result = await store.get('js_delete');
    expect(result).toBeNull();
  });

  it('finds session by agent key', async () => {
    const session = makeSession({
      id: 'js_byagent',
      agent_key: 'uhCAkSpecificAgent',
    });
    await store.create(session);

    const found = await store.findByAgentKey('uhCAkSpecificAgent');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('js_byagent');
  });

  it('returns null for unknown agent key', async () => {
    const found = await store.findByAgentKey('uhCAkUnknown');
    expect(found).toBeNull();
  });

  it('matches only the exact network scope', async () => {
    await store.create(makeSession({
      id: 'js_net_a',
      agent_key: 'uhCAkMultiNet',
      network: 'network-a',
    }));
    await store.create(makeSession({
      id: 'js_net_b',
      agent_key: 'uhCAkMultiNet',
      network: 'network-b',
    }));

    const onA = await store.findByAgentKey('uhCAkMultiNet', 'network-a');
    expect(onA!.id).toBe('js_net_a');

    const onB = await store.findByAgentKey('uhCAkMultiNet', 'network-b');
    expect(onB!.id).toBe('js_net_b');

    expect(await store.findByAgentKey('uhCAkMultiNet', 'network-c')).toBeNull();
  });

  it('treats undefined network as its own scope, distinct from a named network', async () => {
    await store.create(makeSession({
      id: 'js_default_scope',
      agent_key: 'uhCAkScopeAgent',
    }));
    await store.create(makeSession({
      id: 'js_named_scope',
      agent_key: 'uhCAkScopeAgent',
      network: 'network-a',
    }));

    const defaultScope = await store.findByAgentKey('uhCAkScopeAgent');
    expect(defaultScope!.id).toBe('js_default_scope');

    const namedScope = await store.findByAgentKey('uhCAkScopeAgent', 'network-a');
    expect(namedScope!.id).toBe('js_named_scope');
  });

  it('findAnyByAgentKey finds a session for the agent regardless of network', async () => {
    await store.create(makeSession({
      id: 'js_any_net',
      agent_key: 'uhCAkAnyAgent',
      network: 'network-a',
    }));

    const found = await store.findAnyByAgentKey('uhCAkAnyAgent');
    expect(found!.id).toBe('js_any_net');
  });

  it('findAnyByAgentKey returns null for unknown agent key', async () => {
    const found = await store.findAnyByAgentKey('uhCAkUnknown');
    expect(found).toBeNull();
  });

  it('findAnyByAgentKey does not let an expired pending session on one network shadow a live ready session on another (expired session created first)', async () => {
    const shortStore = new SqliteSessionStore(
      join(tmpDir, 'shadow-expired-first.db'),
      1, // 1 second pending TTL
    );

    // Backdated so it is expired, but still the most recently created row --
    // the bug this guards against picked the newest row and bailed if it
    // happened to be expired, ignoring an older but live ready session.
    await shortStore.create(makeSession({
      id: 'js_shadow_pending',
      agent_key: 'uhCAkShadowAgent',
      network: 'network-a',
      status: 'pending',
      created_at: Date.now() - 2000,
    }));
    await shortStore.create(makeSession({
      id: 'js_shadow_ready',
      agent_key: 'uhCAkShadowAgent',
      network: 'network-b',
      status: 'ready',
      created_at: Date.now() - 10000,
    }));

    const found = await shortStore.findAnyByAgentKey('uhCAkShadowAgent');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('js_shadow_ready');

    shortStore.close();
  });

  it('findAnyByAgentKey does not let an expired pending session on one network shadow a live ready session on another (expired session created last)', async () => {
    const shortStore = new SqliteSessionStore(
      join(tmpDir, 'shadow-expired-last.db'),
      1, // 1 second pending TTL
    );

    await shortStore.create(makeSession({
      id: 'js_shadow_ready2',
      agent_key: 'uhCAkShadowAgent2',
      network: 'network-b',
      status: 'ready',
      created_at: Date.now() - 10000,
    }));
    await shortStore.create(makeSession({
      id: 'js_shadow_pending2',
      agent_key: 'uhCAkShadowAgent2',
      network: 'network-a',
      status: 'pending',
      created_at: Date.now() - 2000,
    }));

    const found = await shortStore.findAnyByAgentKey('uhCAkShadowAgent2');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('js_shadow_ready2');

    shortStore.close();
  });

  it('expires pending sessions after TTL', async () => {
    const shortStore = new SqliteSessionStore(
      join(tmpDir, 'short-ttl.db'),
      1, // 1 second pending TTL
    );

    const session = makeSession({
      id: 'js_expire',
      created_at: Date.now() - 2000, // 2 seconds ago
    });
    await shortStore.create(session);

    const result = await shortStore.get('js_expire');
    expect(result).toBeNull();

    shortStore.close();
  });

  it('does not expire ready sessions within TTL', async () => {
    const session = makeSession({
      id: 'js_ready',
      status: 'ready',
    });
    await store.create(session);

    const result = await store.get('js_ready');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ready');
  });

  it('persists data across store instances', async () => {
    const dbPath = join(tmpDir, 'persist.db');
    const store1 = new SqliteSessionStore(dbPath);

    const session = makeSession({ id: 'js_persist', status: 'ready' });
    await store1.create(session);
    store1.close();

    // Open a new store on the same file
    const store2 = new SqliteSessionStore(dbPath);
    const retrieved = await store2.get('js_persist');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('js_persist');
    expect(retrieved!.status).toBe('ready');
    store2.close();
  });

  it('cleanup removes expired pending sessions but keeps ready sessions', async () => {
    const shortStore = new SqliteSessionStore(
      join(tmpDir, 'cleanup.db'),
      1, // 1 second pending TTL
    );

    await shortStore.create(
      makeSession({
        id: 'js_old_pending',
        status: 'pending',
        created_at: Date.now() - 5000,
      }),
    );
    await shortStore.create(
      makeSession({
        id: 'js_old_ready',
        status: 'ready',
        agent_key: 'agent2',
        created_at: Date.now() - 5000,
      }),
    );
    await shortStore.create(
      makeSession({
        id: 'js_fresh',
        status: 'ready',
        agent_key: 'agent3',
      }),
    );

    shortStore.cleanup();

    // Old pending session should be gone
    expect(await shortStore.get('js_old_pending')).toBeNull();
    // Ready sessions never expire (even old ones)
    expect(await shortStore.get('js_old_ready')).not.toBeNull();
    // Fresh session should remain
    expect(await shortStore.get('js_fresh')).not.toBeNull();

    shortStore.close();
  });

  it('stores and retrieves reason field', async () => {
    const session = makeSession({
      id: 'js_rejected',
      status: 'rejected',
      reason: 'Invalid invite code',
    });
    await store.create(session);

    const retrieved = await store.get('js_rejected');
    expect(retrieved!.reason).toBe('Invalid invite code');
  });

  it('round-trips the network field', async () => {
    const session = makeSession({ id: 'js_network', network: 'acme-net' });
    await store.create(session);

    const retrieved = await store.get('js_network');
    expect(retrieved!.network).toBe('acme-net');
  });

  it('leaves network undefined when not provided', async () => {
    const session = makeSession({ id: 'js_no_network' });
    await store.create(session);

    const retrieved = await store.get('js_no_network');
    expect(retrieved!.network).toBeUndefined();
  });
});
