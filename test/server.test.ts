import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAllowedAgentStore } from '../src/server.js';
import { resolveConfig } from '../src/config.js';
import { MemoryAllowedAgentStore } from '../src/agent-registration/memory-store.js';
import { SqliteAllowedAgentStore } from '../src/agent-registration/sqlite-store.js';

// buildAllowedAgentStore derives the allowed-agents backend from
// session.store/db_path. This only covers the store's identity/type --
// full startup wiring (auth_methods warnings, plugin construction) has no
// test harness since startServer() binds a real network port.
describe('buildAllowedAgentStore', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('returns a MemoryAllowedAgentStore for memory session store', () => {
    const config = resolveConfig({
      happ: { id: 'a', name: 'A' },
      auth_methods: ['open'],
      session: { store: 'memory', pending_ttl_seconds: 86400 },
    });
    const store = buildAllowedAgentStore(config);
    expect(store).toBeInstanceOf(MemoryAllowedAgentStore);
  });

  it('returns a MemoryAllowedAgentStore when sqlite db_path is ":memory:"', () => {
    const config = resolveConfig({
      happ: { id: 'a', name: 'A' },
      auth_methods: ['open'],
      session: { store: 'sqlite', db_path: ':memory:', pending_ttl_seconds: 86400 },
    });
    const store = buildAllowedAgentStore(config);
    expect(store).toBeInstanceOf(MemoryAllowedAgentStore);
  });

  it('derives a sibling allowed-agents.db for a real sqlite db_path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'server-test-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const config = resolveConfig({
      happ: { id: 'a', name: 'A' },
      auth_methods: ['open'],
      session: { store: 'sqlite', db_path: join(dir, 'sessions.db'), pending_ttl_seconds: 86400 },
    });
    const store = buildAllowedAgentStore(config);
    expect(store).toBeInstanceOf(SqliteAllowedAgentStore);
    (store as SqliteAllowedAgentStore).close();
  });
});
