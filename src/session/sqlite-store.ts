import Database from 'better-sqlite3';
import type { SessionData, SessionStore, ChallengeState } from './store.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL,
    status TEXT NOT NULL,
    challenges TEXT NOT NULL,
    claims TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_agent_key ON sessions(agent_key);
`;

export class SqliteSessionStore implements SessionStore {
  private db: Database.Database;
  private pendingTtlMs: number;

  private stmtInsert: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtUpdate: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtFindByAgent: Database.Statement;
  private stmtCleanup: Database.Statement;

  constructor(
    dbPath: string,
    pendingTtlSeconds = 86400,
  ) {
    this.pendingTtlMs = pendingTtlSeconds * 1000;

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO sessions (id, agent_key, status, challenges, claims, created_at, reason)
      VALUES (@id, @agent_key, @status, @challenges, @claims, @created_at, @reason)
    `);

    this.stmtGet = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);

    this.stmtUpdate = this.db.prepare(`
      UPDATE sessions
      SET status = @status, challenges = @challenges, reason = @reason
      WHERE id = @id
    `);

    this.stmtDelete = this.db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `);

    this.stmtFindByAgent = this.db.prepare(`
      SELECT * FROM sessions WHERE agent_key = ? ORDER BY created_at DESC LIMIT 1
    `);

    this.stmtCleanup = this.db.prepare(`
      DELETE FROM sessions WHERE
        status != 'ready' AND created_at < ?
    `);
  }

  async create(data: SessionData): Promise<void> {
    this.stmtInsert.run({
      id: data.id,
      agent_key: data.agent_key,
      status: data.status,
      challenges: JSON.stringify(data.challenges),
      claims: JSON.stringify(data.claims),
      created_at: data.created_at,
      reason: data.reason ?? null,
    });
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const row = this.stmtGet.get(sessionId) as RawRow | undefined;
    if (!row) return null;

    const session = rowToSession(row);
    if (this.isExpired(session)) {
      this.stmtDelete.run(sessionId);
      return null;
    }
    return session;
  }

  async update(
    sessionId: string,
    data: Partial<SessionData>,
  ): Promise<void> {
    const existing = await this.get(sessionId);
    if (!existing) return;

    this.stmtUpdate.run({
      id: sessionId,
      status: data.status ?? existing.status,
      challenges: JSON.stringify(data.challenges ?? existing.challenges),
      reason: data.reason ?? existing.reason ?? null,
    });
  }

  async delete(sessionId: string): Promise<void> {
    this.stmtDelete.run(sessionId);
  }

  async findByAgentKey(agentKey: string): Promise<SessionData | null> {
    const row = this.stmtFindByAgent.get(agentKey) as RawRow | undefined;
    if (!row) return null;

    const session = rowToSession(row);
    if (this.isExpired(session)) {
      this.stmtDelete.run(session.id);
      return null;
    }
    return session;
  }

  cleanup(): void {
    const now = Date.now();
    this.stmtCleanup.run(now - this.pendingTtlMs);
  }

  close(): void {
    this.db.close();
  }

  /** Ready sessions never expire; pending sessions use the configured TTL. */
  private isExpired(session: SessionData): boolean {
    if (session.status === 'ready') return false;
    return Date.now() - session.created_at > this.pendingTtlMs;
  }
}

interface RawRow {
  id: string;
  agent_key: string;
  status: string;
  challenges: string;
  claims: string;
  created_at: number;
  reason: string | null;
}

function rowToSession(row: RawRow): SessionData {
  return {
    id: row.id,
    agent_key: row.agent_key,
    status: row.status as SessionData['status'],
    challenges: JSON.parse(row.challenges) as ChallengeState[],
    claims: JSON.parse(row.claims) as Record<string, string>,
    created_at: row.created_at,
    reason: row.reason ?? undefined,
  };
}
