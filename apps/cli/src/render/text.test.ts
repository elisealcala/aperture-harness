import type { EventEnvelope } from '@aperture/events';
import { describe, expect, it } from 'vitest';
import { formatEvent, formatTimestamped } from './text.ts';

function formatCompleted(payload: Record<string, unknown>): EventEnvelope {
  return { schemaVersion: 1, eventId: 'evt_1', runId: 'run_1', sequence: 7, timestamp: '2026-11-05T12:00:00.000Z', type: 'format.completed', payload };
}

describe('formatEvent: format.completed (auto-format)', () => {
  it('renders FORMATTED as a ✓ line with the file count and formatter id', () => {
    expect(formatEvent(formatCompleted({ formatterId: 'studio-biome', files: ['studio/a.ts', 'studio/b.ts'], status: 'FORMATTED', exitCode: 0 }))).toBe('[✓] Formatted 2 file(s) with studio-biome');
  });

  it('paints FORMATTED green when color is enabled', () => {
    expect(formatEvent(formatCompleted({ formatterId: 'fmt', files: ['a.ts'], status: 'FORMATTED', exitCode: 0 }), { color: true })).toBe('\u001b[32m[✓] Formatted 1 file(s) with fmt\u001b[0m');
  });

  it('renders FAILED as a yellow ! line with the exit code', () => {
    const event = formatCompleted({ formatterId: 'fmt', files: ['a.ts'], status: 'FAILED', exitCode: 3, outputTail: 'boom' });
    expect(formatEvent(event)).toBe('[!] Formatted 1 file(s) with fmt — exit 3');
    expect(formatEvent(event, { color: true })).toBe('\u001b[33m[!] Formatted 1 file(s) with fmt — exit 3\u001b[0m');
  });

  it('still renders a FAILED line when the exit code is null (killed / timed out)', () => {
    // NOTE: the exit code currently renders empty here (`— exit `); check.completed falls back to `none`.
    expect(formatEvent(formatCompleted({ formatterId: 'fmt', files: ['a.ts'], status: 'FAILED', exitCode: null }))).toMatch(/^\[!\] Formatted 1 file\(s\) with fmt — exit/);
  });

  it('hides SKIPPED', () => {
    expect(formatEvent(formatCompleted({ formatterId: 'fmt', files: [], status: 'SKIPPED', exitCode: null }))).toBeNull();
    expect(formatTimestamped(formatCompleted({ formatterId: 'fmt', files: [], status: 'SKIPPED', exitCode: null }))).toBeNull();
  });

  it('tolerates a payload without files', () => {
    expect(formatEvent(formatCompleted({ formatterId: 'fmt', status: 'FORMATTED', exitCode: 0 }))).toBe('[✓] Formatted 0 file(s) with fmt');
  });

  it('is shown by the "format" filter and hidden by other filters', () => {
    const event = formatCompleted({ formatterId: 'fmt', files: ['a.ts'], status: 'FORMATTED', exitCode: 0 });
    expect(formatEvent(event, { filters: ['format'] })).toBe('[✓] Formatted 1 file(s) with fmt');
    expect(formatEvent(event, { filters: ['check', 'tool'] })).toBeNull();
  });
});
