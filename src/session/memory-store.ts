import type { SessionData, SessionStore } from './store.js';

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();
  private agentIndex = new Map<string, string>();
  private pendingTtlMs: number;

  constructor(pendingTtlSeconds = 86400) {
    this.pendingTtlMs = pendingTtlSeconds * 1000;
  }

  async create(data: SessionData): Promise<void> {
    this.sessions.set(data.id, { ...data });
    this.agentIndex.set(data.agent_key, data.id);
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.isExpired(session)) {
      this.sessions.delete(sessionId);
      this.agentIndex.delete(session.agent_key);
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
      this.agentIndex.delete(session.agent_key);
    }
    this.sessions.delete(sessionId);
  }

  async findByAgentKey(agentKey: string): Promise<SessionData | null> {
    const sessionId = this.agentIndex.get(agentKey);
    if (!sessionId) return null;
    return this.get(sessionId);
  }

  /** Ready sessions never expire; pending sessions use the configured TTL. */
  private isExpired(session: SessionData): boolean {
    if (session.status === 'ready') return false;
    return Date.now() - session.created_at > this.pendingTtlMs;
  }
}
