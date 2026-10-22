import Database from 'better-sqlite3';
import type { SessionData, LinkSessionStore, ChallengeState } from './store.js';
import { applyUpdate, isExpired, linkExpiresAt, linkHashes, holdsLinkHash } from './store.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL,
    status TEXT NOT NULL,
    challenges TEXT NOT NULL,
    claims TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reason TEXT,
    network TEXT,
    link_expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_agent_key ON sessions(agent_key);
  CREATE TABLE IF NOT EXISTS link_tokens (
    hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_link_tokens_session ON link_tokens(session_id);
  CREATE TABLE IF NOT EXISTS events (
    key TEXT NOT NULL,
    at INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_key_at ON events(key, at);
  CREATE INDEX IF NOT EXISTS idx_events_expires ON events(expires);
`;

export class SqliteSessionStore implements LinkSessionStore {
  private db: Database.Database;
  private pendingTtlMs: number;

  private stmtInsert: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtUpdate: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtFindByAgent: Database.Statement;
  private stmtFindByAgentScoped: Database.Statement;
  private stmtCleanup: Database.Statement;
  private stmtInsertLinkToken: Database.Statement;
  private stmtFindLinkToken: Database.Statement;
  private stmtInsertEvent: Database.Statement;
  private stmtPruneEvents: Database.Statement;
  private stmtEventTimes: Database.Statement;
  private stmtRemoveEvent: Database.Statement;
  private stmtExpireEvents: Database.Statement;

  constructor(
    dbPath: string,
    pendingTtlSeconds = 86400,
  ) {
    this.pendingTtlMs = pendingTtlSeconds * 1000;

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'link_expires_at')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN link_expires_at INTEGER');
    }
    // Composite index for the exact-scope (agent_key, network) lookup that
    // backs join's uniqueness check.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_agent_network ON sessions(agent_key, network)',
    );

    this.stmtInsert = this.db.prepare(`
      INSERT INTO sessions (id, agent_key, status, challenges, claims, created_at, reason, network, link_expires_at)
      VALUES (@id, @agent_key, @status, @challenges, @claims, @created_at, @reason, @network, @link_expires_at)
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

    // Prefers a ready session, so a pending row on one network cannot shadow
    // a ready session on another.
    this.stmtFindByAgent = this.db.prepare(`
      SELECT * FROM sessions
      WHERE agent_key = ? AND (status = 'ready' OR created_at >= ?)
      ORDER BY (status = 'ready') DESC, created_at DESC
      LIMIT 1
    `);

    // "IS" (rather than "=") NULL-safely matches the no-network scope when
    // the bound network parameter is null.
    this.stmtFindByAgentScoped = this.db.prepare(`
      SELECT * FROM sessions WHERE agent_key = ? AND network IS ? ORDER BY created_at DESC LIMIT 1
    `);

    this.stmtCleanup = this.db.prepare(`
      DELETE FROM sessions WHERE
        status != 'ready' AND COALESCE(link_expires_at, created_at + ?) < ?
    `);

    this.stmtInsertLinkToken = this.db.prepare(
      'INSERT OR IGNORE INTO link_tokens (hash, session_id) VALUES (?, ?)',
    );
    this.stmtFindLinkToken = this.db.prepare('SELECT session_id FROM link_tokens WHERE hash = ?');
    this.stmtInsertEvent = this.db.prepare('INSERT INTO events (key, at, expires) VALUES (?, ?, ?)');
    this.stmtExpireEvents = this.db.prepare('DELETE FROM events WHERE expires <= ?');
    this.stmtPruneEvents = this.db.prepare('DELETE FROM events WHERE key = ? AND at <= ?');
    this.stmtEventTimes = this.db.prepare('SELECT at FROM events WHERE key = ? ORDER BY at');
    this.stmtRemoveEvent = this.db.prepare(
      'DELETE FROM events WHERE rowid = (SELECT rowid FROM events WHERE key = ? AND at = ? LIMIT 1)',
    );
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
      network: data.network ?? null,
      link_expires_at: linkExpiresAt(data) ?? null,
    });
    this.indexLinkHashes(data);
  }

  async get(sessionId: string): Promise<SessionData | null> {
    return this.read(sessionId);
  }

  private read(sessionId: string): SessionData | null {
    const row = this.stmtGet.get(sessionId) as RawRow | undefined;
    if (!row) return null;

    const session = rowToSession(row);
    if (isExpired(session, this.pendingTtlMs)) {
      this.stmtDelete.run(sessionId);
      return null;
    }
    return session;
  }

  async update(
    sessionId: string,
    data: Partial<SessionData>,
  ): Promise<void> {
    const existing = this.read(sessionId);
    if (!existing) return;

    const updated = applyUpdate(existing, data);
    this.stmtUpdate.run({
      id: sessionId,
      status: data.status ?? existing.status,
      challenges: JSON.stringify(updated.challenges),
      reason: data.reason ?? existing.reason ?? null,
    });
    this.indexLinkHashes(updated);
  }

  async delete(sessionId: string): Promise<void> {
    this.stmtDelete.run(sessionId);
  }

  async findByAgentKey(agentKey: string, network?: string): Promise<SessionData | null> {
    const row = this.stmtFindByAgentScoped.get(agentKey, network ?? null) as RawRow | undefined;
    if (!row) return null;

    const session = rowToSession(row);
    if (isExpired(session, this.pendingTtlMs)) {
      this.stmtDelete.run(session.id);
      return null;
    }
    return session;
  }

  async findAnyByAgentKey(agentKey: string): Promise<SessionData | null> {
    const row = this.stmtFindByAgent.get(agentKey, Date.now() - this.pendingTtlMs) as
      | RawRow
      | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  async findByLinkHash(hash: string): Promise<SessionData | null> {
    const row = this.stmtFindLinkToken.get(hash) as { session_id: string } | undefined;
    const session = row ? await this.get(row.session_id) : null;
    return holdsLinkHash(session, hash) ? session : null;
  }

  async reserveEvents(keys: string[], at: number, ttlMs: number, wait: (earlier: number[][]) => number): Promise<number> {
    return this.db.transaction(() => {
      this.stmtExpireEvents.run(at);
      const earlier = keys.map((key) => {
        this.stmtPruneEvents.run(key, at - ttlMs);
        return (this.stmtEventTimes.all(key) as { at: number }[]).map((row) => row.at);
      });
      const delay = wait(earlier);
      if (delay > 0) return delay;
      for (const key of keys) this.stmtInsertEvent.run(key, at, at + ttlMs);
      return 0;
    })();
  }

  async removeEvents(keys: string[], at: number): Promise<void> {
    for (const key of keys) this.stmtRemoveEvent.run(key, at);
  }

  cleanup(): void {
    this.stmtCleanup.run(this.pendingTtlMs, Date.now());
  }

  close(): void {
    this.db.close();
  }

  private indexLinkHashes(session: SessionData): void {
    for (const hash of linkHashes(session)) this.stmtInsertLinkToken.run(hash, session.id);
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
  network: string | null;
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
    network: row.network ?? undefined,
  };
}
