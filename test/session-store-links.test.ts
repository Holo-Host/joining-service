import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    link: { state: 'link_sent', subject_id: 'subject', network_name: 'Test App', token_hashes: ['hash_1'], resend_at: NOW + 60_000, ...link },
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
      const kv = createMockKV();
      return { store: new KvSessionStore(kv, TTL_SECONDS), second: () => new KvSessionStore(kv, TTL_SECONDS), close: () => {} };
    },
  ],
];

describe.each(factories)('%s store, link sessions', (_name, factory) => {
  let store: LinkSessionStore;
  let built: ReturnType<Factory>;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    dir = mkdtempSync(join(tmpdir(), 'session-links-'));
    built = factory();
    store = built.store;
  });

  afterEach(() => {
    built.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('expiry', () => {
    it('keeps a pending link session until its link expires, past the pending TTL', async () => {
      await store.create(session());
      vi.setSystemTime(NOW + 2 * TTL_MS);
      expect(await store.get('js_link')).not.toBeNull();
      vi.setSystemTime(LINK_EXPIRES + 1);
      expect(await store.get('js_link')).toBeNull();
    });

    it('does not move a pending expiry on a write', async () => {
      await store.create(session());
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
    it('finds a pending session by each token hash, including one added by an update', async () => {
      await store.create(session());
      await store.update('js_link', {
        challenges: [linkChallenge({}, { token_hashes: ['hash_1', 'hash_2'] })],
      });
      expect((await store.findByLinkToken('hash_2'))?.id).toBe('js_link');
      expect((await store.findByLinkToken('hash_1'))?.id).toBe('js_link');
      expect(await store.findByLinkToken('hash_unknown')).toBeNull();
    });

    it('finds nothing once the session is ready, deleted or expired', async () => {
      await store.create(session());
      await store.update('js_link', { status: 'ready' });
      expect(await store.findByLinkToken('hash_1')).toBeNull();

      await store.create(session({ id: 'js_deleted', challenges: [linkChallenge({}, { token_hashes: ['hash_d'] })] }));
      await store.delete('js_deleted');
      expect(await store.findByLinkToken('hash_d')).toBeNull();

      await store.create(session({ id: 'js_expired', challenges: [linkChallenge({}, { token_hashes: ['hash_e'] })] }));
      vi.setSystemTime(LINK_EXPIRES + 1);
      expect(await store.findByLinkToken('hash_e')).toBeNull();
    });
  });

  describe('progress never goes back', () => {
    it('keeps a completed link challenge complete over a write of a newer, open attempt', async () => {
      const approved = attempt({ status: 'Approved', read_at: NOW + 10 });
      await store.create(session({ challenges: [linkChallenge({ completed: true }, { state: 'approved', attempt: approved })] }));
      const newer = attempt({ session_id: 'didit_2', recorded_at: NOW + 20, read_at: NOW + 20 });
      await store.update('js_link', {
        challenges: [linkChallenge({ attempts: 1 }, { state: 'in_progress', attempt: newer })],
      });
      const [cs] = (await store.get('js_link'))!.challenges;
      expect(cs.completed).toBe(true);
      expect(cs.link?.attempt).toEqual(approved);
      expect(cs.challenge.metadata?.state).toBe('approved');
      expect(cs.attempts).toBe(1);
    });

    it('takes an incoming approval over a stored newer, open attempt', async () => {
      const newer = attempt({ session_id: 'didit_2', recorded_at: NOW + 20, read_at: NOW + 20 });
      await store.create(session({ challenges: [linkChallenge({}, { state: 'in_progress', attempt: newer })] }));
      const approved = attempt({ status: 'Approved', read_at: NOW + 10 });
      await store.update('js_link', {
        challenges: [linkChallenge({ completed: true }, { state: 'approved', attempt: approved })],
      });
      const [cs] = (await store.get('js_link'))!.challenges;
      expect(cs.completed).toBe(true);
      expect(cs.link?.attempt).toEqual(approved);
      expect(cs.challenge.metadata?.state).toBe('approved');
    });

    it('keeps a newer Didit session over a stale write of an older one', async () => {
      const newer = attempt({ session_id: 'didit_2', recorded_at: NOW + 5000, read_at: NOW + 5000 });
      await store.create(session({ challenges: [linkChallenge({}, { state: 'in_progress', attempt: newer })] }));
      await store.update('js_link', {
        challenges: [linkChallenge({}, { state: 'declined', attempt: attempt({ status: 'Declined', read_at: NOW + 6000 }) })],
      });
      expect((await store.get('js_link'))!.challenges[0].link?.attempt).toEqual(newer);
    });

    it('keeps a recorded Didit session over a stale write without one', async () => {
      await store.create(session({ challenges: [linkChallenge({}, { state: 'in_progress', attempt: attempt() })] }));
      await store.update('js_link', { challenges: [linkChallenge()] });
      const [cs] = (await store.get('js_link'))!.challenges;
      expect(cs.link?.attempt?.session_id).toBe('didit_1');
      expect(cs.challenge.metadata?.state).toBe('in_progress');
    });

    it('takes a newer read of the same Didit session', async () => {
      await store.create(session({ challenges: [linkChallenge({}, { state: 'in_progress', attempt: attempt() })] }));
      const reread = attempt({ status: 'In Review', read_at: NOW + 20_000 });
      await store.update('js_link', { challenges: [linkChallenge({}, { state: 'in_review', attempt: reread })] });
      expect((await store.get('js_link'))!.challenges[0].link?.attempt).toEqual(reread);
    });

    it('keeps every emailed token and the latest resend time over a stale write', async () => {
      await store.create(session({
        challenges: [linkChallenge({}, { token_hashes: ['hash_1', 'hash_2'], resend_at: NOW + 120_000 })],
      }));
      await store.update('js_link', { challenges: [linkChallenge({}, { state: 'in_progress', attempt: attempt() })] });
      const [cs] = (await store.get('js_link'))!.challenges;
      expect(cs.link?.token_hashes).toEqual(['hash_1', 'hash_2']);
      expect(cs.challenge.metadata?.resend_available_at).toBe(new Date(NOW + 120_000).toISOString());
      expect((await store.findByLinkToken('hash_2'))?.id).toBe('js_link');
    });

    it('leaves a challenge without link data exactly as written', async () => {
      const plain: ChallengeState = {
        challenge: { id: 'ch_email', type: 'email_code', description: 'Enter the code' },
        expected_response: '123456',
        completed: true,
        attempts: 1,
        expires_at: NOW + 600_000,
      };
      await store.create(session({ challenges: [plain] }));
      await store.update('js_link', { challenges: [{ ...plain, completed: false, attempts: 0 }] });
      expect((await store.get('js_link'))!.challenges[0]).toMatchObject({ completed: false, attempts: 0 });
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
      await store.removeEvents(['address:a', 'agent:k'], NOW, DAY);
      await store.removeEvents(['address:a', 'agent:k'], NOW, DAY);
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
});

describe.each(factories.filter(([name]) => name !== 'cloudflare-kv'))('%s store, concurrent writes', (_name, factory) => {
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

  it('lets one of two reservations made at once through a limit of one', async () => {
    const onlyFirst = (earlier: number[][]) => (earlier[0].length > 0 ? 1000 : 0);
    const waits = await Promise.all([
      built.store.reserveEvents(['address:a'], NOW, DAY, onlyFirst),
      built.store.reserveEvents(['address:a'], NOW, DAY, onlyFirst),
    ]);
    expect(waits).toEqual([0, 1000]);
  });

  it('merges two updates made at once', async () => {
    await built.store.create(session());
    const adding = (hash: string) => linkChallenge({}, { token_hashes: ['hash_1', hash] });
    await Promise.all([
      built.store.update('js_link', { challenges: [adding('hash_2')] }),
      built.store.update('js_link', { challenges: [adding('hash_3')] }),
    ]);
    expect((await built.store.get('js_link'))!.challenges[0].link?.token_hashes).toEqual(['hash_1', 'hash_2', 'hash_3']);
  });
});

describe('sqlite cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a live link session older than the pending TTL and removes it once expired', async () => {
    const store = new SqliteSessionStore(':memory:', TTL_SECONDS);
    await store.create(session());
    vi.setSystemTime(NOW + 2 * TTL_MS);
    store.cleanup();
    expect(await store.findByLinkToken('hash_1')).not.toBeNull();

    vi.setSystemTime(LINK_EXPIRES + 1);
    store.cleanup();
    vi.setSystemTime(NOW);
    expect(await store.get('js_link')).toBeNull();
    expect(await store.findByLinkToken('hash_1')).toBeNull();
    store.close();
  });
});

describe('KV writes for link sessions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('use an absolute expiration at the link expiry, on create and on update', async () => {
    const kv = createMockKV();
    const store = new KvSessionStore(kv, TTL_SECONDS);
    await store.create(session());
    vi.setSystemTime(NOW + DAY);
    await store.update('js_link', { status: 'pending', challenges: [linkChallenge({ attempts: 1 })] });

    const expiration = Math.ceil(LINK_EXPIRES / 1000);
    for (const key of ['session:js_link', 'agent:uhCAk_agent\0acme-net', 'link:hash_1']) {
      expect(kv.store.get(key)).toMatchObject({ expiration, expirationTtl: undefined });
    }
    for (const call of kv.put.mock.calls) {
      expect(call[2]).toEqual({ expiration });
    }
  });

  it('write a link session close to its expiry 60 seconds ahead, as KV requires', async () => {
    const kv = createMockKV();
    const store = new KvSessionStore(kv, TTL_SECONDS);
    await store.create(session());
    vi.setSystemTime(LINK_EXPIRES - 10_000);
    await store.update('js_link', { challenges: [linkChallenge({ attempts: 1 })] });
    expect(kv.store.get('session:js_link')?.expiration).toBe(Math.floor((LINK_EXPIRES - 10_000) / 1000) + 60);
  });

  it('write a ready link session with no expiry', async () => {
    const kv = createMockKV();
    const store = new KvSessionStore(kv, TTL_SECONDS);
    await store.create(session());
    await store.update('js_link', { status: 'ready' });
    expect(kv.store.get('session:js_link')).toMatchObject({ expiration: undefined, expirationTtl: undefined });
  });
});
