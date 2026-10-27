import type { LinkSessionStore, SessionData } from './store.js';
import { applyUpdate, isExpired, linkHashes, holdsLinkHash, withoutOne } from './store.js';

/** Composite agent-index key: session uniqueness is per (agent, network). */
function agentIndexKey(agentKey: string, network?: string): string {
  return `${agentKey}\0${network ?? ''}`;
}

export class MemorySessionStore implements LinkSessionStore {
  private sessions = new Map<string, SessionData>();
  private agentIndex = new Map<string, string>();
  private linkIndex = new Map<string, string>();
  private events = new Map<string, number[]>();
  private claims = new Map<string, number>();
  private pendingTtlMs: number;

  constructor(pendingTtlSeconds = 86400) {
    this.pendingTtlMs = pendingTtlSeconds * 1000;
  }

  async create(data: SessionData): Promise<void> {
    this.sessions.set(data.id, { ...data });
    this.agentIndex.set(agentIndexKey(data.agent_key, data.network), data.id);
    this.indexLinkHashes(data);
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (isExpired(session, this.pendingTtlMs)) {
      this.remove(session);
      return null;
    }
    return { ...session };
  }

  async update(
    sessionId: string,
    data: Partial<SessionData>,
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    const updated = applyUpdate(existing, data);
    this.sessions.set(sessionId, updated);
    this.indexLinkHashes(updated);
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) this.remove(session);
  }

  async findByAgentKey(agentKey: string, network?: string): Promise<SessionData | null> {
    const sessionId = this.agentIndex.get(agentIndexKey(agentKey, network));
    if (!sessionId) return null;
    return this.get(sessionId);
  }

  /**
   * Considers every live session for the agent across all networks (not just
   * the first found) and prefers a ready one -- an expired pending session on
   * one network must not shadow a live ready session on another. Candidates
   * are routed through get() so expiry is decided by the store's own logic
   * (and expired entries are pruned as a side effect, same as elsewhere).
   */
  async findAnyByAgentKey(agentKey: string): Promise<SessionData | null> {
    let best: SessionData | null = null;
    for (const session of this.sessions.values()) {
      if (session.agent_key !== agentKey) continue;
      const candidate = await this.get(session.id);
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
    const sessionId = this.linkIndex.get(hash);
    const session = sessionId ? await this.get(sessionId) : null;
    return holdsLinkHash(session, hash) ? session : null;
  }

  async reserveEvents(keys: string[], at: number, ttlMs: number, wait: (earlier: number[][]) => number): Promise<number> {
    const earlier = keys.map((key) => (this.events.get(key) ?? []).filter((t) => t > at - ttlMs));
    const delay = wait(earlier);
    if (delay > 0) return delay;
    keys.forEach((key, i) => this.events.set(key, [...earlier[i], at]));
    return 0;
  }

  async removeEvents(keys: string[], at: number): Promise<void> {
    for (const key of keys) {
      const left = withoutOne(this.events.get(key) ?? [], at);
      if (left.length > 0) this.events.set(key, left);
      else this.events.delete(key);
    }
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    if ((this.claims.get(key) ?? 0) > now) return false;
    this.claims.set(key, now + ttlMs);
    return true;
  }

  private indexLinkHashes(session: SessionData): void {
    for (const hash of linkHashes(session)) this.linkIndex.set(hash, session.id);
  }

  private remove(session: SessionData): void {
    this.sessions.delete(session.id);
    this.agentIndex.delete(agentIndexKey(session.agent_key, session.network));
    for (const hash of linkHashes(session)) this.linkIndex.delete(hash);
  }
}
