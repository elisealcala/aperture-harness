import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid, type ApertureStore, type StorageLayout } from '@aperture/storage';
import { redact, type RedactOptions } from './redact.ts';
import { EVENT_SCHEMA_VERSION, type EventEnvelope, type EventType } from './types.ts';

export type EventListener = (event: EventEnvelope) => void;

interface EventRow {
  run_id: string;
  sequence: number;
  event_id: string;
  type: string;
  payload_json: string;
  timestamp: string;
}

const DEFAULT_MAX_STRING = 16_000;

/**
 * Append-only event log. SQLite is authoritative (ADR-006); `runs/<id>/events.jsonl` is a
 * projection that can always be rebuilt from it. Payloads are redacted and size-bounded before they
 * are persisted, so neither store ever holds raw secrets or unbounded tool output.
 */
export class EventStore {
  private readonly listeners = new Set<EventListener>();
  private readonly redactOptions: RedactOptions;

  constructor(
    private readonly store: ApertureStore,
    private readonly layout: StorageLayout,
    options: { redactLiterals?: readonly string[]; maxStringLength?: number } = {},
  ) {
    this.redactOptions = { literals: options.redactLiterals ?? [], maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING };
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Persists an event. When called inside an outer `store.transaction`, the event commits (or rolls
   * back) together with the state change it describes; listeners and the JSONL projection are
   * updated immediately, and `syncProjection` repairs the file if a rollback or crash intervenes.
   */
  append<P extends object>(runId: string, type: EventType, payload: P): EventEnvelope<P> {
    const safePayload = redact(payload, this.redactOptions);
    const envelope = this.store.transaction(() => {
      const row = this.store.sql.get<{ v: number }>('SELECT COALESCE(MAX(sequence), 0) AS v FROM events WHERE run_id = :id', { id: runId });
      const sequence = (row?.v ?? 0) + 1;
      const env: EventEnvelope<P> = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: `evt_${ulid()}`,
        runId,
        sequence,
        timestamp: new Date().toISOString(),
        type,
        payload: safePayload,
      };
      this.store.sql.run(
        'INSERT INTO events (run_id, sequence, event_id, type, payload_json, timestamp) VALUES (:run_id, :sequence, :event_id, :type, :payload_json, :timestamp)',
        { run_id: runId, sequence, event_id: env.eventId, type, payload_json: JSON.stringify(safePayload), timestamp: env.timestamp },
      );
      return env;
    });
    this.project(envelope as EventEnvelope);
    for (const listener of this.listeners) {
      try {
        listener(envelope as EventEnvelope);
      } catch {
        // A failing renderer must never break the durable log.
      }
    }
    return envelope;
  }

  list(runId: string, options: { afterSequence?: number; types?: readonly EventType[]; limit?: number } = {}): EventEnvelope[] {
    const rows = this.store.sql.all<EventRow>(
      'SELECT * FROM events WHERE run_id = :id AND sequence > :after ORDER BY sequence LIMIT :limit',
      { id: runId, after: options.afterSequence ?? 0, limit: options.limit ?? 1_000_000 },
    );
    const events = rows.map(rowToEnvelope);
    return options.types ? events.filter((e) => options.types!.includes(e.type)) : events;
  }

  lastSequence(runId: string): number {
    return this.store.sql.get<{ v: number }>('SELECT COALESCE(MAX(sequence), 0) AS v FROM events WHERE run_id = :id', { id: runId })?.v ?? 0;
  }

  jsonlPath(runId: string): string {
    return join(this.layout.runDir(runId), 'events.jsonl');
  }

  /** Rewrites the JSONL projection from SQLite if it is missing, short, or ahead of the database. */
  syncProjection(runId: string): { rebuilt: boolean } {
    const path = this.jsonlPath(runId);
    const events = this.list(runId);
    const expected = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
    const actual = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (actual === expected) return { rebuilt: false };
    mkdirSync(this.layout.runDir(runId), { recursive: true, mode: 0o700 });
    writeFileSync(path, expected, { mode: 0o600 });
    return { rebuilt: true };
  }

  private project(envelope: EventEnvelope): void {
    try {
      mkdirSync(this.layout.runDir(envelope.runId), { recursive: true, mode: 0o700 });
      appendFileSync(this.jsonlPath(envelope.runId), `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    } catch {
      // Projection failures are repaired by syncProjection; SQLite already holds the event.
    }
  }
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: row.event_id,
    runId: row.run_id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    type: row.type as EventType,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}
