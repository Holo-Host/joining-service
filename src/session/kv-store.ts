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
}

const SESSION_PREFIX = 'session:';
const AGENT_INDEX_PREFIX = 'agent:';

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
      AGENT_INDEX_PREFIX + data.agent_key,
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
        AGENT_INDEX_PREFIX + updated.agent_key,
        sessionId,
        opts,
      );
    }
  }

  async delete(sessionId: string): Promise<void> {
    const existing = await this.get(sessionId);
    if (existing) {
      await this.kv.delete(AGENT_INDEX_PREFIX + existing.agent_key);
    }
    await this.kv.delete(SESSION_PREFIX + sessionId);
  }

  async findByAgentKey(agentKey: string): Promise<SessionData | null> {
    const sessionId = await this.kv.get(AGENT_INDEX_PREFIX + agentKey);
    if (!sessionId) return null;
    return this.get(sessionId);
  }

  /** Ready sessions never expire; pending sessions use the configured TTL. */
  private kvOptions(status: string): { expirationTtl?: number } {
    return status === 'ready' ? {} : { expirationTtl: this.pendingTtlSeconds };
  }
}
