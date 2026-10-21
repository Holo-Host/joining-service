/**
 * SessionStore backed by Cloudflare Workers KV.
 *
 * Each session is stored as a JSON value keyed by session ID. Index keys
 * map agent_key and each emailed link token to a session ID, and event keys
 * hold the email limits' event times.
 *
 * TTL is handled by KV's built-in expiration. A session holding a link
 * challenge expires at an absolute time (`expiration`), so writes never move
 * it; any other pending session uses `expirationTtl`.
 */

import type { LinkSessionStore, SessionData } from './store.js';
import { applyUpdate, holdsLink, isExpired, linkTokenHashes, ownsLinkToken, pendingExpiresAt, withoutOne } from './store.js';

/** Cloudflare KV namespace binding (subset of the runtime type). */
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

interface KvPutOptions {
  expirationTtl?: number;
  expiration?: number;
}

const SESSION_PREFIX = 'session:';
const AGENT_INDEX_PREFIX = 'agent:';
const LINK_TOKEN_PREFIX = 'link:';
const EVENT_PREFIX = 'event:';

/** KV refuses an expiration less than 60 seconds ahead. */
const MIN_EXPIRATION_AHEAD_SECONDS = 60;

function expirationAt(ms: number): number {
  return Math.max(Math.ceil(ms / 1000), Math.floor(Date.now() / 1000) + MIN_EXPIRATION_AHEAD_SECONDS);
}

/** Composite agent-index key: session uniqueness is per (agent, network). */
function agentIndexKey(agentKey: string, network?: string): string {
  return `${AGENT_INDEX_PREFIX}${agentKey}\0${network ?? ''}`;
}

/** Prefix under which all of an agent's (agent, network) index entries live. */
function agentIndexPrefix(agentKey: string): string {
  return `${AGENT_INDEX_PREFIX}${agentKey}\0`;
}

export class KvSessionStore implements LinkSessionStore {
  private kv: KVNamespace;
  private pendingTtlSeconds: number;

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
    await this.indexLinkTokens(data, linkTokenHashes(data), opts);
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

    const known = new Set(linkTokenHashes(existing));
    await this.indexLinkTokens(
      updated,
      linkTokenHashes(updated).filter((hash) => !known.has(hash)),
      opts,
    );
  }

  async delete(sessionId: string): Promise<void> {
    const existing = await this.get(sessionId);
    if (existing) {
      await this.kv.delete(agentIndexKey(existing.agent_key, existing.network));
      for (const hash of linkTokenHashes(existing)) {
        await this.kv.delete(LINK_TOKEN_PREFIX + hash);
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

  async findByLinkToken(tokenHash: string): Promise<SessionData | null> {
    const sessionId = await this.kv.get(LINK_TOKEN_PREFIX + tokenHash);
    const session = sessionId ? await this.get(sessionId) : null;
    return ownsLinkToken(session, tokenHash) ? session : null;
  }

  async reserveEvents(keys: string[], at: number, ttlMs: number, wait: (earlier: number[][]) => number): Promise<number> {
    const earlier: number[][] = [];
    for (const key of keys) earlier.push((await this.readEvents(key)).filter((t) => t > at - ttlMs));
    const delay = wait(earlier);
    if (delay > 0) return delay;
    for (const [i, key] of keys.entries()) await this.writeEvents(key, [...earlier[i], at], at + ttlMs);
    return 0;
  }

  async removeEvents(keys: string[], at: number, ttlMs: number): Promise<void> {
    for (const key of keys) {
      await this.writeEvents(key, withoutOne(await this.readEvents(key), at), at + ttlMs);
    }
  }

  private async readEvents(key: string): Promise<number[]> {
    const raw = await this.kv.get(EVENT_PREFIX + key);
    return raw ? (JSON.parse(raw) as number[]) : [];
  }

  private async writeEvents(key: string, times: number[], expiresAt: number): Promise<void> {
    await this.kv.put(EVENT_PREFIX + key, JSON.stringify(times), { expiration: expirationAt(expiresAt) });
  }

  private async indexLinkTokens(session: SessionData, hashes: string[], opts: KvPutOptions): Promise<void> {
    for (const hash of hashes) {
      await this.kv.put(LINK_TOKEN_PREFIX + hash, session.id, opts);
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
