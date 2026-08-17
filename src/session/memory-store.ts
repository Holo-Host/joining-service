import type { SessionData, SessionStore } from './store.js';

/** Composite agent-index key: session uniqueness is per (agent, network). */
function agentIndexKey(agentKey: string, network?: string): string {
  return `${agentKey}\0${network ?? ''}`;
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();
  private agentIndex = new Map<string, string>();
  private pendingTtlMs: number;

  constructor(pendingTtlSeconds = 86400) {
    this.pendingTtlMs = pendingTtlSeconds * 1000;
  }

  async create(data: SessionData): Promise<void> {
    this.sessions.set(data.id, { ...data });
    this.agentIndex.set(agentIndexKey(data.agent_key, data.network), data.id);
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.isExpired(session)) {
      this.sessions.delete(sessionId);
      this.agentIndex.delete(agentIndexKey(session.agent_key, session.network));
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
    this.sessions.set(sessionId, { ...existing, ...data });
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.agentIndex.delete(agentIndexKey(session.agent_key, session.network));
    }
    this.sessions.delete(sessionId);
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

  /** Ready sessions never expire; pending sessions use the configured TTL. */
  private isExpired(session: SessionData): boolean {
    if (session.status === 'ready') return false;
    return Date.now() - session.created_at > this.pendingTtlMs;
  }
}
