import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ApertureStore, StorageLayout } from '@aperture/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedRun } from '../../../tests/helpers/records.ts';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { EventStore } from './store.ts';
import type { EventEnvelope } from './types.ts';

const tmp = new TempDirs();

function readJsonl(path: string): EventEnvelope[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EventEnvelope);
}

describe('EventStore', () => {
  let store: ApertureStore;
  let layout: StorageLayout;
  let events: EventStore;

  beforeEach(() => {
    const root = tmp.make('aperture-events-');
    layout = new StorageLayout(root);
    store = ApertureStore.open(layout.databasePath);
    events = new EventStore(store, layout, { redactLiterals: ['literal-secret-value'] });
    seedRun(store, 'run_1');
    seedRun(store, 'run_2');
  });

  afterEach(() => {
    store.close();
    tmp.cleanup();
  });

  describe('append and list', () => {
    it('assigns a monotonic sequence per run', () => {
      const a1 = events.append('run_1', 'run.created', { n: 1 });
      const b1 = events.append('run_2', 'run.created', { n: 1 });
      const a2 = events.append('run_1', 'state.changed', { from: 'INGESTING', to: 'NEEDS_CONTRACT_REVIEW' });
      const a3 = events.append('run_1', 'tool.requested', { n: 3 });
      expect([a1.sequence, a2.sequence, a3.sequence]).toEqual([1, 2, 3]);
      expect(b1.sequence).toBe(1);
      expect(events.lastSequence('run_1')).toBe(3);
      expect(events.lastSequence('run_unknown')).toBe(0);
    });

    it('returns a complete envelope and persists it unchanged', () => {
      const env = events.append('run_1', 'tool.rejected', { toolCallId: 'call_1', reasonCode: 'PATH_DENIED' });
      expect(env).toMatchObject({ schemaVersion: 1, runId: 'run_1', sequence: 1, type: 'tool.rejected', payload: { toolCallId: 'call_1', reasonCode: 'PATH_DENIED' } });
      expect(env.eventId).toMatch(/^evt_[0-9A-Z]{26}$/);
      expect(Number.isNaN(Date.parse(env.timestamp))).toBe(false);
      expect(events.list('run_1')).toEqual([env]);
    });

    it('lists after a sequence, by type, and with a limit', () => {
      for (let i = 0; i < 5; i++) events.append('run_1', i % 2 === 0 ? 'tool.requested' : 'tool.completed', { i });
      expect(events.list('run_1', { afterSequence: 3 }).map((e) => e.sequence)).toEqual([4, 5]);
      expect(events.list('run_1', { types: ['tool.completed'] }).map((e) => e.sequence)).toEqual([2, 4]);
      expect(events.list('run_1', { limit: 2 }).map((e) => e.sequence)).toEqual([1, 2]);
    });

    it('notifies subscribers and survives a throwing listener', () => {
      const seen: number[] = [];
      events.subscribe(() => {
        throw new Error('renderer crashed');
      });
      const unsubscribe = events.subscribe((e) => seen.push(e.sequence));
      events.append('run_1', 'run.created', {});
      unsubscribe();
      events.append('run_1', 'run.finished', {});
      expect(seen).toEqual([1]);
      expect(events.lastSequence('run_1')).toBe(2);
    });

    it('rejects events for unknown runs (foreign key)', () => {
      expect(() => events.append('run_missing', 'run.created', {})).toThrow(/FOREIGN KEY/);
    });
  });

  describe('redaction', () => {
    const SECRETS = {
      anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      github: 'ghp_0123456789abcdefghijABCDEFGHIJ012345',
      bearer: 'abcdef0123456789bearer',
    };

    it('scrubs secret-looking values and keys before they reach SQLite or JSONL', () => {
      const env = events.append('run_1', 'check.completed', {
        outputTail: `ANTHROPIC_API_KEY=${SECRETS.anthropic}\ngit push https://x:${SECRETS.github}@github.com\nauthorization: Bearer ${SECRETS.bearer}`,
        headers: { apiKey: 'any-value-here', 'x-api-key': 'another-value' },
        note: 'contains literal-secret-value inline',
        exitCode: 0,
      });

      expect(env.payload).toEqual({
        outputTail: 'ANTHROPIC_API_KEY=[REDACTED]\ngit push https://x:[REDACTED]@github.com\nauthorization: [REDACTED]',
        headers: { apiKey: '[REDACTED]', 'x-api-key': '[REDACTED]' },
        note: 'contains [REDACTED] inline',
        exitCode: 0,
      });

      const raw = store.sql.get<{ payload_json: string }>('SELECT payload_json FROM events WHERE run_id = :id', { id: 'run_1' })!.payload_json;
      const jsonl = readFileSync(events.jsonlPath('run_1'), 'utf8');
      for (const secret of [...Object.values(SECRETS), 'any-value-here', 'another-value', 'literal-secret-value']) {
        expect(raw).not.toContain(secret);
        expect(jsonl).not.toContain(secret);
      }
    });

    it('truncates long strings to the configured bound', () => {
      const bounded = new EventStore(store, layout, { maxStringLength: 50 });
      const env = bounded.append('run_1', 'tool.completed', { content: 'y'.repeat(10_000) });
      const content = (env.payload as { content: string }).content;
      expect(content.length).toBeLessThan(200);
      expect(content).toMatch(/^y{50}…\[truncated 9950 chars, sha256:[0-9a-f]{16}\]$/);
    });

    it('applies a 16k default string bound', () => {
      const env = events.append('run_1', 'tool.completed', { content: 'z'.repeat(20_000) });
      expect((env.payload as { content: string }).content).toMatch(/^z{16000}…\[truncated 4000 chars/);
    });
  });

  describe('JSONL projection', () => {
    it('writes runs/<id>/events.jsonl mirroring SQLite', () => {
      events.append('run_1', 'run.created', { a: 1 });
      events.append('run_1', 'state.changed', { from: 'INGESTING', to: 'NEEDS_CONTRACT_REVIEW' });
      events.append('run_2', 'run.created', { b: 2 });
      expect(events.jsonlPath('run_1')).toBe(`${layout.runDir('run_1')}/events.jsonl`);
      expect(readJsonl(events.jsonlPath('run_1'))).toEqual(events.list('run_1'));
      expect(readJsonl(events.jsonlPath('run_2'))).toEqual(events.list('run_2'));
      expect(events.syncProjection('run_1')).toEqual({ rebuilt: false });
    });

    it('rebuilds a deleted projection from SQLite', () => {
      events.append('run_1', 'run.created', {});
      events.append('run_1', 'run.finished', {});
      rmSync(events.jsonlPath('run_1'));
      expect(events.syncProjection('run_1')).toEqual({ rebuilt: true });
      expect(readJsonl(events.jsonlPath('run_1'))).toEqual(events.list('run_1'));
    });

    it('rebuilds a deleted run directory', () => {
      events.append('run_1', 'run.created', {});
      rmSync(layout.runDir('run_1'), { recursive: true });
      expect(events.syncProjection('run_1')).toEqual({ rebuilt: true });
      expect(readJsonl(events.jsonlPath('run_1'))).toHaveLength(1);
    });

    it('rebuilds a truncated or corrupted projection', () => {
      events.append('run_1', 'run.created', {});
      events.append('run_1', 'run.finished', {});
      const path = events.jsonlPath('run_1');
      writeFileSync(path, readFileSync(path, 'utf8').slice(0, 40));
      expect(events.syncProjection('run_1')).toEqual({ rebuilt: true });
      expect(readJsonl(path)).toEqual(events.list('run_1'));

      writeFileSync(path, '{"forged":true}\n');
      expect(events.syncProjection('run_1')).toEqual({ rebuilt: true });
      expect(readJsonl(path)).toEqual(events.list('run_1'));
    });

    it('drops projected lines whose transaction rolled back', () => {
      events.append('run_1', 'run.created', {});
      expect(() =>
        store.transaction(() => {
          events.append('run_1', 'state.changed', { from: 'INGESTING', to: 'FAILED' });
          throw new Error('checkpoint failed');
        }),
      ).toThrow('checkpoint failed');
      expect(events.list('run_1')).toHaveLength(1);
      expect(readJsonl(events.jsonlPath('run_1'))).toHaveLength(2);
      expect(events.syncProjection('run_1')).toEqual({ rebuilt: true });
      expect(readJsonl(events.jsonlPath('run_1'))).toEqual(events.list('run_1'));
    });

    it('keeps the durable SQLite event when the projection cannot be written', () => {
      // Root the layout at a regular file so creating runs/<id>/ fails with ENOTDIR.
      writeFileSync(`${layout.root}/runs-blocker`, '');
      const blocked = new EventStore(store, new StorageLayout(`${layout.root}/runs-blocker`));
      const warn = vi.fn();
      blocked.subscribe(warn);
      blocked.append('run_1', 'run.created', {});
      expect(events.list('run_1')).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(existsSync(blocked.jsonlPath('run_1'))).toBe(false);
    });

    it('treats a missing projection for a run without events as in sync', () => {
      expect(events.syncProjection('run_2')).toEqual({ rebuilt: false });
      expect(existsSync(events.jsonlPath('run_2'))).toBe(false);
    });
  });
});
