import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';

export type SqlParams = Record<string, SQLInputValue>;

/**
 * Thin wrapper over `node:sqlite` with WAL mode, a busy timeout for the attach/run process pair,
 * migrations, and explicit `BEGIN IMMEDIATE` transactions around state transitions.
 */
export class SqliteDatabase {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(readonly path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    const isNew = path === ':memory:' || !existsSync(path);
    this.db = new DatabaseSync(path);
    if (isNew && path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
    for (let i = row.v; i < MIGRATIONS.length; i++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString());
      });
    }
  }

  get schemaVersion(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
  }

  run(sql: string, params: SqlParams = {}): void {
    this.db.prepare(sql).run(params);
  }

  get<T>(sql: string, params: SqlParams = {}): T | undefined {
    return this.db.prepare(sql).get(params) as T | undefined;
  }

  all<T>(sql: string, params: SqlParams = {}): T[] {
    return this.db.prepare(sql).all(params) as T[];
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.db.close();
  }
}
