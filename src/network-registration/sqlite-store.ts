import Database from 'better-sqlite3';
import type { NetworkStore, NetworkRecord } from './store.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS networks (
    happ_id TEXT PRIMARY KEY,
    record TEXT NOT NULL
  );
`;

export class SqliteNetworkStore implements NetworkStore {
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
      INSERT INTO networks (happ_id, record)
      VALUES (@happ_id, @record)
      ON CONFLICT(happ_id) DO UPDATE SET record = @record
    `);
    this.stmtGet = this.db.prepare('SELECT record FROM networks WHERE happ_id = ?');
    this.stmtList = this.db.prepare('SELECT record FROM networks');
    this.stmtDelete = this.db.prepare('DELETE FROM networks WHERE happ_id = ?');
  }

  async put(network: NetworkRecord): Promise<void> {
    this.stmtPut.run({
      happ_id: network.happ_id,
      record: JSON.stringify(network),
    });
  }
  async get(happId: string): Promise<NetworkRecord | null> {
    const row = this.stmtGet.get(happId) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as NetworkRecord) : null;
  }
  async list(): Promise<NetworkRecord[]> {
    const rows = this.stmtList.all() as Array<{ record: string }>;
    return rows.map((r) => JSON.parse(r.record) as NetworkRecord);
  }
  async delete(happId: string): Promise<void> {
    this.stmtDelete.run(happId);
  }
  close(): void {
    this.db.close();
  }
}
