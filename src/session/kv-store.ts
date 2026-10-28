/**
 * SessionStore backed by Cloudflare Workers KV.
 *
 * Each session is stored as a JSON value keyed by session ID. Index keys
 * map agent_key, each link token hash and each done hash to a session ID.
 * Each limit event is a key of its own, so concurrent writers add keys
 * rather than overwrite one value.
 *
 * TTL is handled by KV's built-in expiration. A session holding a link
 * challenge expires at an absolute time (`expiration`), so writes never move
 * it; any other pending session uses `expirationTtl`.
 */

import { createHash } from 'node:crypto';
import type { LinkSessionStore, SessionData } from './store.js';
import { applyUpdate, holdsLink, isExpired, linkHashes, holdsLinkHash, pendingExpiresAt } from './store.js';

/** Cloudflare KV namespace binding (subset of the runtime type). */
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete?: boolean; cursor?: string }>;
}

interface KvPutOptions {
  expirationTtl?: number;
  expiration?: number;
}

/** The Workers runtime's default cache (subset of the runtime type). */
declare const caches: { default: Pick<Cache, 'match' | 'put'> };

const SESSION_PREFIX = 'session:';
const AGENT_INDEX_PREFIX = 'agent:';
const LINK_HASH_PREFIX = 'link:';
const EVENT_PREFIX = 'event:';
const CLAIM_ORIGIN = 'https://claims.invalid/';

/** KV refuses an expiration less than 60 seconds ahead. */
const MIN_EXPIRATION_AHEAD_SECONDS = 60;
const MAX_RESERVATIONS_KEPT = 100;

function expirationAt(ms: number): number {
  return Math.max(Math.ceil(ms / 1000), Math.floor(Date.now() / 1000) + MIN_EXPIRATION_AHEAD_SECONDS);
}

/** Composite agent-index key: session uniqueness is per (agent, network). */
function agentIndexKey(agentKey: string, network?: string): string {
  return `${AGENT_INDEX_PREFIX}${agentKey}\0${network ?? ''}`;
}

function eventPrefix(key: string): string {
  return `${EVENT_PREFIX}${key}\0`;
}

/** Prefix under which all of an agent's (agent, network) index entries live. */
function agentIndexPrefix(agentKey: string): string {
  return `${AGENT_INDEX_PREFIX}${agentKey}\0`;
}

export class KvSessionStore implements LinkSessionStore {
  private kv: KVNamespace;
  private pendingTtlSeconds: number;
  /** The event keys this store recorded, by `key\0at`, so a give-back needs no list, which can lag a new key. */
  private reserved = new Map<string, string[]>();

  constructor(
    kv: KVNamespace,
    pendingTtlSeconds = 86400,
  ) {
    this.kv = kv;
    this.pendingTtlSeconds = pendingTtlSeconds;
  }

  async create(data: SessionData): Promise<void> {
    const opts = this.kvOptions(data);
    await this.kv.put(
      SESSION_PREFIX + data.id,
      JSON.stringify(data),
      opts,
    );
    await this.kv.put(
      agentIndexKey(data.agent_key, data.network),
      data.id,
      opts,
    );
    await this.indexLinkHashes(data, linkHashes(data), opts);
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const raw = await this.kv.get(SESSION_PREFIX + sessionId);
    if (!raw) return null;
    const session = JSON.parse(raw) as SessionData;
    if (holdsLink(session) && isExpired(session, this.pendingTtlSeconds * 1000)) return null;
    return session;
  }

  async update(sessionId: string, data: Partial<SessionData>): Promise<void> {
    const existing = await this.get(sessionId);
    if (!existing) return;

    const updated = applyUpdate(existing, data);
    const opts = this.kvOptions(updated);

    await this.kv.put(
      SESSION_PREFIX + sessionId,
      JSON.stringify(updated),
      opts,
    );

    // Refresh the agent index entry if status changed
    if (data.status) {
      await this.kv.put(
        agentIndexKey(updated.agent_key, updated.network),
        sessionId,
        opts,
      );
    }

    const known = new Set(linkHashes(existing));
    await this.indexLinkHashes(
      updated,
      linkHashes(updated).filter((hash) => !known.has(hash)),
      opts,
    );
  }

  async delete(sessionId: string): Promise<void> {
    const existing = await this.get(sessionId);
    if (existing) {
      await this.kv.delete(agentIndexKey(existing.agent_key, existing.network));
      for (const hash of linkHashes(existing)) {
        await this.kv.delete(LINK_HASH_PREFIX + hash);
      }
    }
    await this.kv.delete(SESSION_PREFIX + sessionId);
  }

  async findByAgentKey(agentKey: string, network?: string): Promise<SessionData | null> {
    const sessionId = await this.kv.get(agentIndexKey(agentKey, network));
    if (!sessionId) return null;
    return this.get(sessionId);
  }

  /**
   * Considers every live session for the agent across all networks (not just
   * the first found in `list()` order) and prefers a ready one -- a pending
   * session on one network must not shadow a ready session on another, the
   * same rule MemorySessionStore and SqliteSessionStore apply. Expired
   * entries are pruned by KV itself or dropped by `get()`, so `get()`
   * returning null is the only "expired" case this store needs to skip past.
   */
  async findAnyByAgentKey(agentKey: string): Promise<SessionData | null> {
    const { keys } = await this.kv.list({ prefix: agentIndexPrefix(agentKey) });
    let best: SessionData | null = null;
    for (const key of keys) {
      const sessionId = await this.kv.get(key.name);
      if (!sessionId) continue;
      const candidate = await this.get(sessionId);
      if (!candidate) continue;
      if (
        !best ||
        (candidate.status === 'ready' && best.status !== 'ready') ||
        (candidate.status === best.status && candidate.created_at > best.created_at)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  async findByLinkHash(hash: string): Promise<SessionData | null> {
    const sessionId = await this.kv.get(LINK_HASH_PREFIX + hash);
    const session = sessionId ? await this.get(sessionId) : null;
    return holdsLinkHash(session, hash) ? session : null;
  }

  /** Records before it counts: counting first would miss a reservation made at the same moment. */
  async reserveEvents(keys: string[], at: number, ttlMs: number, wait: (earlier: number[][]) => number): Promise<number> {
    const mine = keys.map((key) => `${eventPrefix(key)}${at}\0${crypto.randomUUID()}`);
    for (const name of mine) await this.kv.put(name, '', { expiration: expirationAt(at + ttlMs) });
    const earlier: number[][] = [];
    for (const [i, key] of keys.entries()) earlier.push(await this.eventTimes(key, at - ttlMs, mine[i]));
    const delay = wait(earlier);
    if (delay > 0) {
      for (const name of mine) await this.kv.delete(name);
      return delay;
    }
    keys.forEach((key, i) => {
      const id = `${key}\0${at}`;
      this.reserved.set(id, [...(this.reserved.get(id) ?? []), mine[i]]);
    });
    while (this.reserved.size > MAX_RESERVATIONS_KEPT) this.reserved.delete(this.reserved.keys().next().value!);
    return 0;
  }

  async removeEvents(keys: string[], at: number): Promise<void> {
    for (const key of keys) {
      const id = `${key}\0${at}`;
      const [name, ...rest] = this.reserved.get(id) ?? [];
      if (rest.length > 0) this.reserved.set(id, rest);
      else this.reserved.delete(id);
      if (name) await this.kv.delete(name);
    }
  }

  /**
   * Kept in the Workers cache, so a claim spends no KV operation. Cloudflare
   * logs Cache API requests with their URL, and a key can carry a session id,
   * which is a bearer credential, so the URL holds the key's hash.
   */
  async claim(key: string, ttlMs: number): Promise<boolean> {
    const url = CLAIM_ORIGIN + createHash('sha256').update(key).digest('hex');
    if (await caches.default.match(url)) return false;
    await caches.default.put(url, new Response(null, { headers: { 'Cache-Control': `max-age=${Math.ceil(ttlMs / 1000)}` } }));
    return true;
  }

  private async eventTimes(key: string, after: number, except: string): Promise<number[]> {
    const prefix = eventPrefix(key);
    const times: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, cursor });
      for (const { name } of page.keys) {
        const t = Number(name.slice(prefix.length).split('\0')[0]);
        if (name !== except && t > after) times.push(t);
      }
      cursor = page.list_complete === false ? page.cursor : undefined;
    } while (cursor);
    return times.sort((a, b) => a - b);
  }

  private async indexLinkHashes(session: SessionData, hashes: string[], opts: KvPutOptions): Promise<void> {
    for (const hash of hashes) {
      await this.kv.put(LINK_HASH_PREFIX + hash, session.id, opts);
    }
  }

  private kvOptions(session: SessionData): KvPutOptions {
    if (session.status === 'ready') return {};
    if (holdsLink(session)) {
      return { expiration: expirationAt(pendingExpiresAt(session, this.pendingTtlSeconds * 1000)) };
    }
    return { expirationTtl: this.pendingTtlSeconds };
  }
}
