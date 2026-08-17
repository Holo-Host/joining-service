/**
 * SessionStore backed by Cloudflare Workers KV.
 *
 * Each session is stored as a JSON value keyed by session ID.
 * An additional index key maps agent_key → session_id for lookups.
 *
 * TTL is handled by KV's built-in expiration (expirationTtl).
 */

import type { SessionData, SessionStore } from './store.js';

/** Cloudflare KV namespace binding (subset of the runtime type). */
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

const SESSION_PREFIX = 'session:';
const AGENT_INDEX_PREFIX = 'agent:';

/** Composite agent-index key: session uniqueness is per (agent, network). */
function agentIndexKey(agentKey: string, network?: string): string {
  return `${AGENT_INDEX_PREFIX}${agentKey}\0${network ?? ''}`;
}

/** Prefix under which all of an agent's (agent, network) index entries live. */
function agentIndexPrefix(agentKey: string): string {
  return `${AGENT_INDEX_PREFIX}${agentKey}\0`;
}

export class KvSessionStore implements SessionStore {
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
    const opts = this.kvOptions(data.status);
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
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const raw = await this.kv.get(SESSION_PREFIX + sessionId);
    if (!raw) return null;
    return JSON.parse(raw) as SessionData;
  }

  async update(sessionId: string, data: Partial<SessionData>): Promise<void> {
    const existing = await this.get(sessionId);
    if (!existing) return;

    const updated = { ...existing, ...data };
    const opts = this.kvOptions(updated.status);

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
  }

  async delete(sessionId: string): Promise<void> {
    const existing = await this.get(sessionId);
    if (existing) {
      await this.kv.delete(agentIndexKey(existing.agent_key, existing.network));
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
   * same rule MemorySessionStore and SqliteSessionStore apply. KV's own TTL
   * (`expirationTtl`) prunes truly expired entries server-side, so `get()`
   * returning null for a stale index entry is the only "expired" case this
   * store needs to skip past.
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

  /** Ready sessions never expire; pending sessions use the configured TTL. */
  private kvOptions(status: string): { expirationTtl?: number } {
    return status === 'ready' ? {} : { expirationTtl: this.pendingTtlSeconds };
  }
}
