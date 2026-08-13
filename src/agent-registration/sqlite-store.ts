import Database from 'better-sqlite3';
import type { AllowedAgentStore, RegisteredAgent } from './store.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS allowed_agents (
    agent_key TEXT PRIMARY KEY,
    label TEXT,
    registered_at TEXT NOT NULL
  );
`;

export class SqliteAllowedAgentStore implements AllowedAgentStore {
  private db: Database.Database;
  private stmtPut: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtList: Database.Statement;
  private stmtDelete: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.stmtPut = this.db.prepare(`
      INSERT INTO allowed_agents (agent_key, label, registered_at)
      VALUES (@agent_key, @label, @registered_at)
      ON CONFLICT(agent_key) DO UPDATE SET label = @label, registered_at = @registered_at
    `);
    this.stmtGet = this.db.prepare('SELECT * FROM allowed_agents WHERE agent_key = ?');
    this.stmtList = this.db.prepare('SELECT * FROM allowed_agents');
    this.stmtDelete = this.db.prepare('DELETE FROM allowed_agents WHERE agent_key = ?');
  }

  async put(agent: RegisteredAgent): Promise<void> {
    this.stmtPut.run({ label: null, ...agent });
  }
  async get(agentKey: string): Promise<RegisteredAgent | null> {
    const row = this.stmtGet.get(agentKey) as (RegisteredAgent & { label: string | null }) | undefined;
    return row ? { ...row, label: row.label ?? undefined } : null;
  }
  async has(agentKey: string): Promise<boolean> {
    return (await this.get(agentKey)) !== null;
  }
  async list(): Promise<RegisteredAgent[]> {
    const rows = this.stmtList.all() as Array<RegisteredAgent & { label: string | null }>;
    return rows.map((r) => ({ ...r, label: r.label ?? undefined }));
  }
  async delete(agentKey: string): Promise<void> {
    this.stmtDelete.run(agentKey);
  }
  close(): void {
    this.db.close();
  }
}
