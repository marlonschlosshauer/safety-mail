import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MailMessage, MessageSummaryPage } from '../shared/types.js';

export class MailStore {
  private constructor(private SQL: SqlJsStatic, private db: Database, private path?: string) {}
  static async open(path?: string) {
    const require = createRequire(import.meta.url);
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const db = new SQL.Database(path && existsSync(path) ? readFileSync(path) : undefined);
    db.run(`CREATE TABLE IF NOT EXISTS mailbox (account TEXT PRIMARY KEY, validity TEXT NOT NULL, highest INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, account TEXT NOT NULL, uid INTEGER NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_date ON messages(date DESC, id DESC);`);
    return new MailStore(SQL, db, path);
  }
  cursor(account: string): { validity: string; highest: number } | undefined {
    const rows = this.db.exec('SELECT validity, highest FROM mailbox WHERE account = ?', [account]);
    const row = rows[0]?.values[0];
    return row ? { validity: String(row[0]), highest: Number(row[1]) } : undefined;
  }
  commitBatch(account: string, validity: string, messages: MailMessage[], highest: number) {
    const before = this.db.export();
    try {
      this.db.run('BEGIN');
      const cursor = this.cursor(account);
      if (cursor && cursor.validity !== validity) this.db.run('DELETE FROM messages WHERE account = ?', [account]);
      for (const m of messages)
        this.db.run('INSERT OR REPLACE INTO messages VALUES (?, ?, ?, ?, ?)', [m.id, account, m.uid, m.date, JSON.stringify(m)]);
      const next = cursor?.validity === validity ? Math.max(cursor.highest, highest) : highest;
      this.db.run('INSERT OR REPLACE INTO mailbox VALUES (?, ?, ?)', [account, validity, next]);
      this.db.run('COMMIT');
      if (this.path) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        writeFileSync(`${this.path}.tmp`, Buffer.from(this.db.export()), { mode: 0o600 });
        renameSync(`${this.path}.tmp`, this.path);
      }
    } catch (error) {
      this.db.close();
      this.db = new this.SQL.Database(before);
      throw error;
    }
  }
  get(id: string): MailMessage {
    const row = this.db.exec('SELECT data FROM messages WHERE id = ?', [id])[0]?.values[0];
    if (!row) throw new Error('This message is no longer in the local inbox.');
    return JSON.parse(String(row[0]));
  }
  recentUids(account: string): number[] {
    return (this.db.exec('SELECT uid FROM messages WHERE account = ? ORDER BY uid DESC LIMIT 100', [account])[0]?.values ?? [])
      .map(row => Number(row[0]));
  }
  list(input: { cursor?: string; limit: number }): MessageSummaryPage {
    const offset = input.cursor ? Number(input.cursor) : 0;
    const rows = this.db.exec('SELECT data FROM messages ORDER BY date DESC, id DESC LIMIT ? OFFSET ?', [input.limit + 1, offset])[0]?.values ?? [];
    const messages = rows.slice(0, input.limit).map(row => {
      const { body: _body, links: _links, attachments: _attachments, replyTo: _reply, returnPath: _return, ...summary } = JSON.parse(String(row[0])) as MailMessage;
      return summary;
    });
    return { messages, nextCursor: rows.length > input.limit ? String(offset + input.limit) : undefined };
  }
  close() { this.db.close(); }
}
