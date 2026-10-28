import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySessionStore } from '../src/session/memory-store.js';
import { SqliteSessionStore } from '../src/session/sqlite-store.js';
import { KvSessionStore } from '../src/session/kv-store.js';
import type { ChallengeState, DiditAttempt, LinkSessionStore, SessionData } from '../src/session/store.js';
import { createMockKV } from './linker-registration/helpers.js';

const TTL_SECONDS = 3600;
const TTL_MS = TTL_SECONDS * 1000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const LINK_EXPIRES = NOW + 7 * DAY;

function attempt(overrides: Partial<DiditAttempt> = {}): DiditAttempt {
  return { session_id: 'didit_1', status: 'In Progress', recorded_at: NOW, read_at: NOW, ...overrides };
}

function linkChallenge(overrides: Partial<ChallengeState> = {}, link: Partial<ChallengeState['link']> = {}): ChallengeState {
  return {
    challenge: {
      id: 'ch_link',
      type: 'didit_with_email' as ChallengeState['challenge']['type'],
      description: 'Open the link we sent to ad***@example.com',
      expires_at: new Date(LINK_EXPIRES).toISOString(),
      metadata: { state: 'link_sent', resend_available_at: new Date(NOW + 60_000).toISOString() },
    },
    expected_response: '',
    completed: false,
    attempts: 0,
    expires_at: LINK_EXPIRES,
    link: { state: 'link_sent', subject_id: 'subject', network_name: 'Test App', token_hashes: ['hash_1'], done_hash: 'done_1', resend_at: NOW + 60_000, ...link },
    ...overrides,
  };
}

function session(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'js_link',
    agent_key: 'uhCAk_agent',
    status: 'pending',
    challenges: [linkChallenge()],
    claims: { email: 'ada@example.com' },
    created_at: NOW,
    network: 'acme-net',
    ...overrides,
  };
}

type Factory = () => { store: LinkSessionStore; second?: () => LinkSessionStore; close: () => void };

/** Reserves with no limit, keeping what each reservation saw. */
function recorder(target: LinkSessionStore) {
  const seen: number[][][] = [];
  const record = (keys: string[], at: number) =>
    target.reserveEvents(keys, at, DAY, (earlier) => {
      seen.push(earlier);
      return 0;
    });
  return { seen, record };
}

/** The Workers cache as the KV store uses it: a response per URL until its max-age passes. */
function fakeWorkersCache() {
  const expires = new Map<string, number>();
  return {
    urls: () => [...expires.keys()],
    match: async (url: string) => ((expires.get(url) ?? 0) > Date.now() ? new Response() : undefined),
    put: async (url: string, response: Response) => {
      const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('Cache-Control')!)![1]);
      expires.set(url, Date.now() + maxAge * 1000);
    },
  };
}

let dir: string;

const factories: Array<[string, Factory]> = [
  ['memory', () => ({ store: new MemorySessionStore(TTL_SECONDS), close: () => {} })],
  [
    'sqlite',
    () => {
      const path = join(dir, 'sessions.db');
      const stores = [new SqliteSessionStore(path, TTL_SECONDS)];
      return {
        store: stores[0],
        second: () => {
          const next = new SqliteSessionStore(path, TTL_SECONDS);
          stores.push(next);
          return next;
        },
        close: () => stores.forEach((s) => s.close()),
      };
    },
  ],
  [
    'cloudflare-kv',
    () => {
      const kv = createMockKV({ latencyMs: 5, pageSize: 2 });
      return { store: new KvSessionStore(kv, TTL_SECONDS), second: () => new KvSessionStore(kv, TTL_SECONDS), close: () => {} };
    },
  ],
];

describe.each(factories)('%s store, link sessions', (_name, factory) => {
  let store: LinkSessionStore;
  let built: ReturnType<Factory>;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    vi.stubGlobal('caches', { default: fakeWorkersCache() });
    dir = mkdtempSync(join(tmpdir(), 'session-links-'));
    built = factory();
    store = built.store;
  });

  afterEach(() => {
    built.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('expiry', () => {
    it('keeps a pending link session until its link expires, past the pending TTL, and a write never moves that', async () => {
      await store.create(session());
      vi.setSystemTime(NOW + 2 * TTL_MS);
      expect(await store.get('js_link')).not.toBeNull();
      vi.setSystemTime(LINK_EXPIRES - 1000);
      await store.update('js_link', { challenges: [linkChallenge({ attempts: 1 })] });
      vi.setSystemTime(LINK_EXPIRES + 1);
      expect(await store.get('js_link')).toBeNull();
    });

    it('never expires a ready link session', async () => {
      await store.create(session());
      await store.update('js_link', { status: 'ready' });
      vi.setSystemTime(LINK_EXPIRES + DAY);
      expect((await store.get('js_link'))?.status).toBe('ready');
    });
  });

  describe('link tokens', () => {
    it('finds a session by its done hash and each token hash, including one added by an update', async () => {
      await store.create(session());
      await store.update('js_link', {
        challenges: [linkChallenge({}, { token_hashes: ['hash_1', 'hash_2'] })],
      });
      expect((await store.findByLinkHash('hash_2'))?.id).toBe('js_link');
      expect((await store.findByLinkHash('hash_1'))?.id).toBe('js_link');
      expect((await store.findByLinkHash('done_1'))?.id).toBe('js_link');
      expect(await store.findByLinkHash('hash_unknown')).toBeNull();
    });

    it('finds a ready session, and nothing once the session is deleted or expired', async () => {
      await store.create(session());
      await store.update('js_link', { status: 'ready' });
      expect((await store.findByLinkHash('hash_1'))?.status).toBe('ready');

      await store.create(session({ id: 'js_deleted', challenges: [linkChallenge({}, { token_hashes: ['hash_d'] })] }));
      await store.delete('js_deleted');
      expect(await store.findByLinkHash('hash_d')).toBeNull();

      await store.create(session({ id: 'js_expired', challenges: [linkChallenge({}, { token_hashes: ['hash_e'] })] }));
      vi.setSystemTime(LINK_EXPIRES + 1);
      expect(await store.findByLinkHash('hash_e')).toBeNull();
    });
  });

  describe('progress never goes back', () => {
    const approved = attempt({ status: 'Approved', read_at: NOW + 10 });
    const newer = attempt({ session_id: 'didit_2', recorded_at: NOW + 20, read_at: NOW + 20 });
    const reread = attempt({ status: 'In Review', read_at: NOW + 20_000 });
    const plain: ChallengeState = {
      challenge: { id: 'ch_email', type: 'email_code', description: 'Enter the code' },
      expected_response: '123456',
      completed: true,
      attempts: 1,
      expires_at: NOW + 600_000,
    };

    it.each<[string, ChallengeState, ChallengeState, object]>([
      [
        'keeps a completed link challenge complete over a write of a newer, open attempt',
        linkChallenge({ completed: true }, { state: 'approved', attempt: approved }),
        linkChallenge({ attempts: 1 }, { state: 'in_progress', attempt: newer }),
        { completed: true, attempts: 1, link: { attempt: approved }, challenge: { metadata: { state: 'approved' } } },
      ],
      [
        'takes an incoming approval over a stored newer, open attempt',
        linkChallenge({}, { state: 'in_progress', attempt: newer }),
        linkChallenge({ completed: true }, { state: 'approved', attempt: approved }),
        { completed: true, link: { attempt: approved }, challenge: { metadata: { state: 'approved' } } },
      ],
      [
        'keeps a newer Didit session over a stale write of an older one',
        linkChallenge({}, { state: 'in_progress', attempt: newer }),
        linkChallenge({}, { state: 'declined', attempt: attempt({ status: 'Declined', read_at: NOW + 6000 }) }),
        { link: { attempt: newer } },
      ],
      [
        'keeps a recorded Didit session over a stale write without one',
        linkChallenge({}, { state: 'in_progress', attempt: attempt() }),
        linkChallenge(),
        { link: { attempt: { session_id: 'didit_1' } }, challenge: { metadata: { state: 'in_progress' } } },
      ],
      [
        'takes a newer read of the same Didit session',
        linkChallenge({}, { state: 'in_progress', attempt: attempt() }),
        linkChallenge({}, { state: 'in_review', attempt: reread }),
        { link: { attempt: reread } },
      ],
      [
        'keeps every emailed token and the latest resend time over a stale write',
        linkChallenge({}, { token_hashes: ['hash_1', 'hash_2'], resend_at: NOW + 120_000 }),
        linkChallenge({}, { state: 'in_progress', attempt: attempt() }),
        {
          link: { token_hashes: ['hash_1', 'hash_2'] },
          challenge: { metadata: { resend_available_at: new Date(NOW + 120_000).toISOString() } },
        },
      ],
      ['leaves a challenge without link data exactly as written', plain, { ...plain, completed: false, attempts: 0 }, { completed: false, attempts: 0 }],
    ])('%s', async (_name, stored, written, expected) => {
      await store.create(session({ challenges: [stored] }));
      await store.update('js_link', { challenges: [written] });
      const [cs] = (await store.get('js_link'))!.challenges;
      expect(cs).toMatchObject(expected);
      for (const hash of cs.link?.token_hashes ?? []) expect((await store.findByLinkHash(hash))?.id).toBe('js_link');
    });
  });

  describe('event counters', () => {
    it("shows each key's earlier events within the TTL, oldest first, and records", async () => {
      const { seen, record } = recorder(store);
      expect(await record(['address:a'], NOW - 2 * DAY)).toBe(0);
      await record(['address:a'], NOW - 1000);
      await record(['address:a', 'agent:k'], NOW);
      await record(['address:a', 'agent:k'], NOW + 1);
      expect(seen).toEqual([[[]], [[]], [[NOW - 1000], []], [[NOW - 1000, NOW], [NOW]]]);
    });

    it('records nothing when the wait is positive, and returns it', async () => {
      const { seen, record } = recorder(store);
      expect(await store.reserveEvents(['address:a', 'agent:k'], NOW, DAY, () => 5000)).toBe(5000);
      await record(['address:a', 'agent:k'], NOW + 1);
      expect(seen).toEqual([[[], []]]);
    });

    it('removes one event recorded at a time, from every key', async () => {
      const { seen, record } = recorder(store);
      await record(['address:a', 'agent:k'], NOW);
      await record(['address:a', 'agent:k'], NOW);
      await store.removeEvents(['address:a', 'agent:k'], NOW);
      await store.removeEvents(['address:a', 'agent:k'], NOW);
      await record(['address:a', 'agent:k'], NOW + 1);
      expect(seen.at(-1)).toEqual([[], []]);
    });

    it('shares events across store instances', async () => {
      if (!built.second) return;
      await recorder(store).record(['agent:k'], NOW);
      const other = recorder(built.second());
      await other.record(['agent:k'], NOW + 1);
      expect(other.seen).toEqual([[[NOW]]]);
    });
  });

  describe('claims', () => {
    it('holds a key for its TTL, and claims it again once the TTL passes', async () => {
      expect(await store.claim('read:a', 15_000)).toBe(true);
      vi.setSystemTime(NOW + 14_999);
      expect(await store.claim('read:a', 15_000)).toBe(false);
      expect(await store.claim('read:b', 15_000)).toBe(true);
      vi.setSystemTime(NOW + 15_000);
      expect(await store.claim('read:a', 15_000)).toBe(true);
    });
  });
});

describe.each(factories)('%s store, concurrent writes', (name, factory) => {
  let built: ReturnType<Factory>;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    dir = mkdtempSync(join(tmpdir(), 'session-links-'));
    built = factory();
  });

  afterEach(() => {
    built.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('lets at most one of 30 reservations made at once through a limit of one, and keeps the one it records', async () => {
    const onlyFirst = (earlier: number[][]) => (earlier[0].length > 0 ? 1000 : 0);
    const waits = await Promise.all(Array.from({ length: 30 }, () => built.store.reserveEvents(['address:a'], NOW, DAY, onlyFirst)));
    const passed = waits.filter((wait) => wait === 0).length;
    // KV records before it counts, so reservations that see each other can all refuse.
    if (name === 'cloudflare-kv') expect(passed).toBeLessThanOrEqual(1);
    else expect(passed).toBe(1);
    const { seen, record } = recorder(built.store);
    await record(['address:a'], NOW + 1);
    expect(seen[0][0]).toHaveLength(passed);
  });

  it.skipIf(name === 'cloudflare-kv')('merges two updates made at once', async () => {
    await built.store.create(session());
    const adding = (hash: string) => linkChallenge({}, { token_hashes: ['hash_1', hash] });
    await Promise.all([
      built.store.update('js_link', { challenges: [adding('hash_2')] }),
      built.store.update('js_link', { challenges: [adding('hash_3')] }),
    ]);
    expect((await built.store.get('js_link'))!.challenges[0].link?.token_hashes).toEqual(['hash_1', 'hash_2', 'hash_3']);
  });
});

describe('link session expiry in sqlite cleanup and KV writes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('claims in the Workers cache, with no KV operation and no session id in the URL', async () => {
    const cache = fakeWorkersCache();
    vi.stubGlobal('caches', { default: cache });
    const kv = createMockKV();
    const store = new KvSessionStore(kv, TTL_SECONDS);
    expect(await store.claim('didit_read:js_link:ch_link', 15_000)).toBe(true);
    expect(await store.claim('didit_read:js_link:ch_link', 15_000)).toBe(false);
    for (const op of [kv.get, kv.put, kv.delete, kv.list]) expect(op).not.toHaveBeenCalled();
    expect(cache.urls().join()).not.toContain('js_link');
  });

  it('drops events past their own TTL, keeps a live link session older than the pending TTL, and removes it and its link tokens once expired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-links-'));
    const dbPath = join(dir, 'links.db');
    const store = new SqliteSessionStore(dbPath, TTL_SECONDS);
    await store.create(session());
    await store.reserveEvents(['agent:k'], NOW, TTL_MS, () => 0);
    vi.setSystemTime(NOW + 2 * TTL_MS);
    const { seen, record } = recorder(store);
    await record(['agent:k'], NOW + 2 * TTL_MS);
    expect(seen).toEqual([[[]]]);
    store.cleanup();
    expect(await store.findByLinkHash('hash_1')).not.toBeNull();

    vi.setSystemTime(LINK_EXPIRES + 1);
    store.cleanup();
    vi.setSystemTime(NOW);
    expect(await store.get('js_link')).toBeNull();
    store.close();
    const db = new Database(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS n FROM link_tokens').get()).toEqual({ n: 0 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives back a KV event that a list does not show yet', async () => {
    const store = new KvSessionStore(createMockKV({ listLagMs: 60_000 }), TTL_SECONDS);
    await store.reserveEvents(['agent:k'], NOW, DAY, () => 0);
    await store.removeEvents(['agent:k'], NOW);
    vi.setSystemTime(NOW + 60_000);
    const { seen, record } = recorder(store);
    await record(['agent:k'], NOW + 60_000);
    expect(seen).toEqual([[[]]]);
  });

  it('expires a pending KV link session at the link expiry, at least 60 seconds ahead as KV requires, and a ready one never', async () => {
    const kv = createMockKV();
    const store = new KvSessionStore(kv, TTL_SECONDS);
    await store.create(session());
    vi.setSystemTime(NOW + DAY);
    await store.update('js_link', { status: 'pending', challenges: [linkChallenge({ attempts: 1 })] });

    const expiration = Math.ceil(LINK_EXPIRES / 1000);
    for (const key of ['session:js_link', 'agent:uhCAk_agent\0acme-net', 'link:hash_1']) {
      expect(kv.store.get(key)).toMatchObject({ expiration, expirationTtl: undefined });
    }
    for (const call of vi.mocked(kv.put).mock.calls) {
      expect(call[2]).toEqual({ expiration });
    }

    vi.setSystemTime(LINK_EXPIRES - 10_000);
    await store.update('js_link', { challenges: [linkChallenge({ attempts: 2 })] });
    expect(kv.store.get('session:js_link')?.expiration).toBe(Math.floor((LINK_EXPIRES - 10_000) / 1000) + 60);

    await store.update('js_link', { status: 'ready' });
    expect(kv.store.get('session:js_link')).toMatchObject({ expiration: undefined, expirationTtl: undefined });
  });
});
