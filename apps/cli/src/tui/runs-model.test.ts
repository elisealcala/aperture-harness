import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@aperture/storage';
import { clampSelection, filterRuns, relativeTime, stateColor, truncate, visibleWindow } from './runs-model.ts';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function summary(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    state: 'EXECUTING',
    modelId: 'claude-sonnet-5-5',
    repoPath: '/tmp/repo',
    workspace: 'worktree',
    branch: null,
    terminalReason: null,
    startedAt: '2026-11-04T20:00:00.000Z',
    updatedAt: '2026-11-04T20:00:00.000Z',
    title: `Task ${runId}`,
    sourceRef: `local:/tmp/${runId}.yaml`,
    costUsd: 0,
    ...overrides,
  };
}

describe('relativeTime', () => {
  it('says "just now" under a minute and for future timestamps', () => {
    expect(relativeTime(ago(0), NOW)).toBe('just now');
    expect(relativeTime(ago(59), NOW)).toBe('just now');
    expect(relativeTime(ago(-3600), NOW)).toBe('just now');
  });

  it('uses whole minutes, hours and days at each boundary', () => {
    expect(relativeTime(ago(60), NOW)).toBe('1m ago');
    expect(relativeTime(ago(3599), NOW)).toBe('59m ago');
    expect(relativeTime(ago(3600), NOW)).toBe('1h ago');
    expect(relativeTime(ago(86_399), NOW)).toBe('23h ago');
    expect(relativeTime(ago(86_400), NOW)).toBe('1d ago');
    expect(relativeTime(ago(30 * 86_400 - 1), NOW)).toBe('29d ago');
  });

  it('falls back to the ISO date from 30 days on', () => {
    expect(relativeTime(ago(30 * 86_400), NOW)).toBe('2026-10-06');
    expect(relativeTime('2025-01-15T08:30:00.000Z', NOW)).toBe('2025-01-15');
  });

  it('defaults "now" to the current time', () => {
    expect(relativeTime(new Date().toISOString())).toBe('just now');
  });
});

describe('filterRuns', () => {
  const runs = [
    summary('run_01AAA', { title: 'Fix login redirect', sourceRef: 'github:org/web#12', state: 'BLOCKED', branch: 'aperture/login', repoPath: '/src/web' }),
    summary('run_01BBB', { title: 'Add agent metrics', sourceRef: 'linear:ENG-42', state: 'COMPLETED_LOCAL', workspace: 'in-place', repoPath: '/src/agents' }),
    summary('run_01CCC', { title: 'Blocked agents cleanup', sourceRef: 'local:/tmp/c.yaml', state: 'EXECUTING', repoPath: '/src/ops' }),
  ];
  const ids = (q: string) => filterRuns(runs, q).map((r) => r.runId);

  it('returns every run (as a copy) for an empty or whitespace-only query', () => {
    expect(ids('')).toEqual(['run_01AAA', 'run_01BBB', 'run_01CCC']);
    expect(ids('   \t ')).toEqual(['run_01AAA', 'run_01BBB', 'run_01CCC']);
    const all = filterRuns(runs, '');
    expect(all).not.toBe(runs);
  });

  it('matches case-insensitively', () => {
    expect(ids('LOGIN')).toEqual(['run_01AAA']);
    expect(ids('completed_local')).toEqual(['run_01BBB']);
  });

  it('searches title, source, state, run id, branch, repository and workspace', () => {
    expect(ids('redirect')).toEqual(['run_01AAA']);
    expect(ids('eng-42')).toEqual(['run_01BBB']);
    expect(ids('executing')).toEqual(['run_01CCC']);
    expect(ids('run_01ccc')).toEqual(['run_01CCC']);
    expect(ids('aperture/login')).toEqual(['run_01AAA']);
    expect(ids('/src/ops')).toEqual(['run_01CCC']);
    expect(ids('in-place')).toEqual(['run_01BBB']);
  });

  it('requires every whitespace-separated term to match', () => {
    expect(ids('blocked')).toEqual(['run_01AAA', 'run_01CCC']);
    expect(ids('agents')).toEqual(['run_01BBB', 'run_01CCC']);
    expect(ids('blocked  agents')).toEqual(['run_01CCC']);
    expect(ids('blocked nothing-matches')).toEqual([]);
  });

  it('lets terms match different fields of the same run', () => {
    expect(ids('github blocked')).toEqual(['run_01AAA']);
  });
});

describe('stateColor', () => {
  it('maps success, failure, canceled, waiting and in-progress states', () => {
    for (const s of ['COMPLETED_LOCAL', 'PR_CREATED', 'READY_FOR_REVIEW']) expect(stateColor(s)).toBe('green');
    for (const s of ['BLOCKED', 'FAILED']) expect(stateColor(s)).toBe('red');
    expect(stateColor('CANCELED')).toBe('gray');
    for (const s of ['WAITING_FOR_USER', 'NEEDS_CONTRACT_REVIEW', 'PR_APPROVAL']) expect(stateColor(s)).toBe('yellow');
    for (const s of ['INGESTING', 'EXECUTING', 'VERIFYING', 'SOMETHING_NEW']) expect(stateColor(s)).toBe('cyan');
  });
});

describe('clampSelection', () => {
  it('keeps the selection inside the list', () => {
    expect(clampSelection(2, 5)).toBe(2);
    expect(clampSelection(-1, 5)).toBe(0);
    expect(clampSelection(5, 5)).toBe(4);
    expect(clampSelection(99, 1)).toBe(0);
  });

  it('returns 0 for an empty list', () => {
    expect(clampSelection(3, 0)).toBe(0);
    expect(clampSelection(-3, 0)).toBe(0);
  });
});

describe('visibleWindow', () => {
  it('shows everything when the list fits', () => {
    expect(visibleWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
    expect(visibleWindow(4, 5, 10)).toEqual({ start: 0, end: 5 });
    expect(visibleWindow(9, 10, 10)).toEqual({ start: 0, end: 10 });
  });

  it('pins the window to the top near the start', () => {
    expect(visibleWindow(0, 100, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(5, 100, 10)).toEqual({ start: 0, end: 10 });
  });

  it('centers the selection in the middle of a long list', () => {
    expect(visibleWindow(50, 100, 10)).toEqual({ start: 45, end: 55 });
    expect(visibleWindow(50, 100, 11)).toEqual({ start: 45, end: 56 });
  });

  it('pins the window to the bottom near the end', () => {
    expect(visibleWindow(99, 100, 10)).toEqual({ start: 90, end: 100 });
    expect(visibleWindow(96, 100, 10)).toEqual({ start: 90, end: 100 });
  });

  it('always contains the selection and has exactly `height` rows', () => {
    for (let selected = 0; selected < 37; selected++) {
      const { start, end } = visibleWindow(selected, 37, 7);
      expect(end - start).toBe(7);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(37);
      expect(selected).toBeGreaterThanOrEqual(start);
      expect(selected).toBeLessThan(end);
    }
  });
});

describe('truncate', () => {
  it('leaves text that fits unchanged', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hello', 80)).toBe('hello');
    expect(truncate('', 10)).toBe('');
  });

  it('cuts longer text to exactly `width` characters ending in an ellipsis', () => {
    expect(truncate('hello world', 6)).toBe('hello…');
    expect(truncate('hello world', 6)).toHaveLength(6);
    expect(truncate('abc', 2)).toBe('a…');
  });

  it('keeps text that fits, shows only an ellipsis at width 1, and nothing below that', () => {
    expect(truncate('a', 1)).toBe('a');
    expect(truncate('hello', 1)).toBe('…');
    expect(truncate('hello', 0)).toBe('');
    expect(truncate('hello', -5)).toBe('');
  });
});
