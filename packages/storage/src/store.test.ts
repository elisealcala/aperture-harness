import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRecord, seedRun, taskRecord } from '../../../tests/helpers/records.ts';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { SqliteDatabase } from './database.ts';
import { MIGRATIONS } from './migrations.ts';
import { ApertureStore, StorageLayout, type ToolOperationRecord } from './store.ts';

const EXPECTED_TABLES = [
  'artifacts',
  'checks',
  'contracts',
  'conversation',
  'decisions',
  'events',
  'model_usage',
  'pr_publications',
  'questions',
  'runs',
  'schema_migrations',
  'tasks',
  'tool_operations',
];

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

describe('SqliteDatabase migrations', () => {
  it('creates every §11 table plus the recovery tables on a new file database', () => {
    const path = join(tmp.make('aperture-db-'), 'nested', 'aperture.db');
    const db = new SqliteDatabase(path);
    try {
      const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
      expect(tables).toEqual(EXPECTED_TABLES);
      expect(db.schemaVersion).toBe(MIGRATIONS.length);
      expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
      expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    } finally {
      db.close();
    }
  });

  it('creates the database file with owner-only permissions', () => {
    const path = join(tmp.make('aperture-db-'), 'aperture.db');
    new SqliteDatabase(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('does not re-apply migrations when reopened', () => {
    const path = join(tmp.make('aperture-db-'), 'aperture.db');
    new SqliteDatabase(path).close();
    const reopened = new SqliteDatabase(path);
    try {
      expect(reopened.all('SELECT * FROM schema_migrations')).toHaveLength(MIGRATIONS.length);
    } finally {
      reopened.close();
    }
  });

  it('rolls back a failed transaction and joins nested transactions to the outer one', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      db.run('CREATE TABLE t (v INTEGER)');
      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO t (v) VALUES (1)');
          db.transaction(() => db.run('INSERT INTO t (v) VALUES (2)'));
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(db.all('SELECT * FROM t')).toEqual([]);

      db.transaction(() => {
        db.run('INSERT INTO t (v) VALUES (3)');
        db.transaction(() => db.run('INSERT INTO t (v) VALUES (4)'));
      });
      expect(db.all<{ v: number }>('SELECT v FROM t ORDER BY v').map((r) => r.v)).toEqual([3, 4]);
    } finally {
      db.close();
    }
  });
});

describe('ApertureStore', () => {
  let store: ApertureStore;

  beforeEach(() => {
    store = ApertureStore.open(join(tmp.make('aperture-store-'), 'aperture.db'));
  });
  afterEach(() => store.close());

  describe('tasks and runs', () => {
    it('round-trips a task and a run through snake_case columns', () => {
      store.insertTask(taskRecord('task_1', { repository: 'org/repo' }));
      const run = runRecord('run_1', 'task_1', { baselineSha: 'abc123', branch: 'aperture/run-1' });
      store.insertRun(run);
      expect(store.getTask('task_1')).toEqual(taskRecord('task_1', { repository: 'org/repo' }));
      expect(store.getRun('run_1')).toEqual(run);
      expect(store.getRun('run_missing')).toBeUndefined();
    });

    it('enforces foreign keys (a run needs its task)', () => {
      expect(() => store.insertRun(runRecord('run_orphan', 'task_missing'))).toThrow(/FOREIGN KEY/);
    });

    it('updateRun changes only whitelisted columns and bumps updated_at', () => {
      seedRun(store, 'run_1');
      store.updateRun('run_1', { state: 'EXECUTING', worktreePath: '/tmp/wt', executingSince: '2026-11-04T21:00:00.000Z', repoPath: '/elsewhere' } as never);
      const run = store.getRun('run_1')!;
      expect(run.state).toBe('EXECUTING');
      expect(run.worktreePath).toBe('/tmp/wt');
      expect(run.executingSince).toBe('2026-11-04T21:00:00.000Z');
      expect(run.repoPath).toBe('/tmp/repo');
      expect(run.updatedAt).not.toBe(run.startedAt);
    });

    it('updateRun can null out a column', () => {
      seedRun(store, 'run_1', { executingSince: '2026-11-04T21:00:00.000Z' });
      store.updateRun('run_1', { executingSince: null });
      expect(store.getRun('run_1')?.executingSince).toBeNull();
    });

    it('incrementRunCounter increments and returns the new value per counter', () => {
      seedRun(store, 'run_1');
      expect(store.incrementRunCounter('run_1', 'patch_attempts')).toBe(1);
      expect(store.incrementRunCounter('run_1', 'patch_attempts')).toBe(2);
      expect(store.incrementRunCounter('run_1', 'turns')).toBe(1);
      expect(store.incrementRunCounter('run_1', 'verification_attempts')).toBe(1);
      expect(store.getRun('run_1')).toMatchObject({ patchAttempts: 2, turns: 1, verificationAttempts: 1 });
    });

    it('findRun resolves exact ids and unique prefixes only', () => {
      seedRun(store, 'run_ABC1');
      seedRun(store, 'run_ABC2');
      seedRun(store, 'run_XYZ');
      expect(store.findRun('run_XYZ')?.runId).toBe('run_XYZ');
      expect(store.findRun('run_X')?.runId).toBe('run_XYZ');
      expect(store.findRun('run_ABC')).toBeUndefined();
      expect(store.findRun('nope')).toBeUndefined();
    });
  });

  describe('conversation', () => {
    it('appends with a per-run monotonic seq and loads in order', () => {
      seedRun(store, 'run_1');
      seedRun(store, 'run_2');
      expect(store.appendConversation('run_1', 'user', '"first"')).toBe(1);
      expect(store.appendConversation('run_1', 'assistant', '"second"')).toBe(2);
      expect(store.appendConversation('run_2', 'user', '"other run"')).toBe(1);
      expect(store.appendConversation('run_1', 'user', '"third"')).toBe(3);

      const entries = store.loadConversation('run_1');
      expect(entries.map((e) => [e.seq, e.role, e.contentJson])).toEqual([
        [1, 'user', '"first"'],
        [2, 'assistant', '"second"'],
        [3, 'user', '"third"'],
      ]);
      expect(store.loadConversation('run_2')).toHaveLength(1);
    });

    it('rejects roles other than user/assistant', () => {
      seedRun(store, 'run_1');
      expect(() => store.appendConversation('run_1', 'system' as never, '{}')).toThrow(/CHECK constraint/);
    });
  });

  describe('tool operations', () => {
    function op(opId: string, overrides: Partial<ToolOperationRecord> = {}): ToolOperationRecord {
      return {
        opId,
        runId: 'run_1',
        tool: 'propose_patch',
        status: 'started',
        inputJson: '{"path":"src/a.ts"}',
        inputSha256: 'b'.repeat(64),
        resultJson: null,
        resultSha256: null,
        createdAt: '2026-11-04T20:00:00.000Z',
        updatedAt: '2026-11-04T20:00:00.000Z',
        ...overrides,
      };
    }

    beforeEach(() => {
      seedRun(store, 'run_1');
    });

    it('round-trips an operation', () => {
      store.insertToolOp(op('call_1'));
      expect(store.getToolOp('call_1')).toEqual(op('call_1'));
      expect(store.getToolOp('call_missing')).toBeUndefined();
    });

    it('updates status and result, keeping an earlier result when none is given', () => {
      store.insertToolOp(op('call_1'));
      store.updateToolOp('call_1', { status: 'applied', resultJson: '{"ok":true}', resultSha256: 'c'.repeat(64) });
      expect(store.getToolOp('call_1')).toMatchObject({ status: 'applied', resultJson: '{"ok":true}', resultSha256: 'c'.repeat(64) });

      store.updateToolOp('call_1', { status: 'failed' });
      expect(store.getToolOp('call_1')).toMatchObject({ status: 'failed', resultJson: '{"ok":true}' });
    });

    it('rejects unknown statuses and duplicate op ids', () => {
      expect(() => store.insertToolOp(op('call_bad', { status: 'done' as never }))).toThrow(/CHECK constraint/);
      store.insertToolOp(op('call_1'));
      expect(() => store.insertToolOp(op('call_1'))).toThrow(/UNIQUE|PRIMARY KEY/);
    });

    it('lists operations for a run, optionally filtered by status', () => {
      store.insertToolOp(op('call_1', { createdAt: '2026-11-04T20:00:01.000Z' }));
      store.insertToolOp(op('call_2', { status: 'applied', createdAt: '2026-11-04T20:00:02.000Z' }));
      store.insertToolOp(op('call_3', { status: 'rejected', tool: 'read_file', createdAt: '2026-11-04T20:00:03.000Z' }));
      expect(store.toolOpsForRun('run_1').map((o) => o.opId)).toEqual(['call_1', 'call_2', 'call_3']);
      expect(store.toolOpsForRun('run_1', 'started').map((o) => o.opId)).toEqual(['call_1']);
      expect(store.toolOpsForRun('run_other')).toEqual([]);
    });
  });
});

describe('StorageLayout', () => {
  it('places the database and per-run directories under the root', () => {
    const layout = new StorageLayout('/data/aperture');
    expect(layout.databasePath).toBe('/data/aperture/aperture.db');
    expect(layout.runDir('run_1')).toBe('/data/aperture/runs/run_1');
    expect(layout.worktreeDir('run_1')).toBe('/data/aperture/worktrees/run_1');
    expect(layout.runTmpDir('run_1')).toBe('/data/aperture/tmp/run_1');
  });
});
