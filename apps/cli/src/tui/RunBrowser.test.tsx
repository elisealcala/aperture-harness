import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { render, renderToString, type Instance } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '@aperture/storage';
import { runRecord } from '../../../../tests/helpers/records.ts';
import type { TuiSnapshot } from './model.ts';
import { RunBrowser } from './RunBrowser.tsx';

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
    startedAt: ago(5 * 60),
    updatedAt: ago(5 * 60),
    title: `Task ${runId}`,
    sourceRef: `local:/tmp/${runId}.yaml`,
    costUsd: 0,
    ...overrides,
  };
}

const RUNS: RunSummary[] = [
  summary('run_01AAA', { title: 'Fix login redirect', state: 'BLOCKED', costUsd: 0.1234, sourceRef: 'github:org/web#12', branch: 'aperture/login', terminalReason: 'STALLED: identical failure repeated' }),
  summary('run_01BBB', { title: 'Add agent metrics', state: 'COMPLETED_LOCAL', costUsd: 1.5, startedAt: ago(3 * 3600), sourceRef: 'linear:ENG-42', workspace: 'in-place' }),
  summary('run_01CCC', { title: 'Blocked agents cleanup', state: 'EXECUTING', startedAt: ago(10) }),
];

function snapshot(runId: string): TuiSnapshot {
  return {
    run: runRecord(runId, 'task_1', { state: 'READY_FOR_REVIEW' }),
    title: `Title of ${runId}`,
    sourceRef: 'github:org/repo#142',
    events: [],
    checks: [],
    usage: [],
    spent: { implementation: 0, pr: 0 },
    questions: [],
    diff: '',
  };
}

const loadRun = (runId: string) => snapshot(runId);

describe('RunBrowser first frame (renderToString)', () => {
  // renderToString uses the real clock for "now", so pin it for the WHEN column.
  afterEach(() => vi.useRealTimers());

  function first(runs: RunSummary[], extra: { initialRunId?: string } = {}): string {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    return renderToString(<RunBrowser listRuns={() => runs} loadRun={loadRun} {...extra} />, { columns: 200 });
  }

  it('renders the header with the run count, column headings and one row per run', () => {
    const out = first(RUNS);
    expect(out).toContain('RUNS 3 · ↑↓ select · enter open · / filter · r refresh · q quit');
    expect(out).toMatch(/STATE\s+COST\s+WHEN\s+TITLE/);
    expect(out).toMatch(/BLOCKED\s+\$0\.123\s+5m ago\s+Fix login redirect/);
    expect(out).toMatch(/COMPLETED_LOCAL\s+\$1\.500\s+3h ago\s+Add agent metrics/);
    expect(out).toMatch(/EXECUTING\s+\$0\.000\s+just now\s+Blocked agents cleanup/);
  });

  it('keeps the rows in the order listRuns returns them', () => {
    const out = first(RUNS);
    const positions = ['Fix login redirect', 'Add agent metrics', 'Blocked agents cleanup'].map((t) => out.indexOf(t));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('marks the first run as selected and shows its details and terminal reason', () => {
    const out = first(RUNS);
    const rows = out.split('\n');
    expect(rows.find((l) => l.includes('Fix login redirect'))).toMatch(/^▶ /);
    expect(rows.find((l) => l.includes('Add agent metrics'))).toMatch(/^ {2}\S/);
    expect(out.match(/▶/g)).toHaveLength(1);
    expect(out).toContain('run_01AAA · github:org/web#12 · worktree aperture/login · claude-sonnet-5-5');
    expect(out).toContain('STALLED: identical failure repeated');
  });

  it('omits the branch and terminal reason in the details line when absent', () => {
    const out = first([RUNS[1]!]);
    expect(out).toContain('RUNS 1 ·');
    expect(out).toContain('run_01BBB · linear:ENG-42 · in-place · claude-sonnet-5-5');
    expect(out).not.toContain('STALLED');
  });

  it('shows an empty state when there are no runs', () => {
    const out = first([]);
    expect(out).toContain('RUNS 0 ·');
    expect(out).toContain('no runs yet — start one with `aperture run <task>`');
    expect(out).not.toContain('▶');
  });

  it('opens the run view directly for initialRunId, with a "back to runs" footer', () => {
    const out = first(RUNS, { initialRunId: 'run_01BBB' });
    expect(out).toContain('RUN run_01BBB');
    expect(out).toContain('GOAL Title of run_01BBB');
    expect(out).toContain('q back to runs');
    expect(out).not.toContain('RUNS 3');
  });
});

// ---- Interactive tests: ink's own `render` with fake TTY streams (no ink-testing-library). ----

class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  columns = 120;
  rows = 30;
  readonly frames: string[] = [];
  write(chunk: string, callback?: () => void): boolean {
    if (chunk !== '') this.frames.push(chunk);
    // ink waits on the write callback before settling waitUntilExit().
    callback?.();
    return true;
  }
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  private readonly queue: string[] = [];
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  send(data: string): void {
    this.queue.push(data);
    this.emit('readable');
  }
}

const KEY = { up: '\u001B[A', down: '\u001B[B', pageDown: '\u001B[6~', pageUp: '\u001B[5~', enter: '\r', escape: '\u001B', backspace: '\u007F' };

interface Session {
  stdin: FakeStdin;
  stdout: FakeStdout;
  instance: Instance;
  frame(): string;
  press(...keys: string[]): Promise<void>;
  exited: () => boolean;
}

let sessions: Session[] = [];
afterEach(() => {
  for (const s of sessions) s.instance.unmount();
  sessions = [];
});

async function mount(listRuns: () => RunSummary[], props: { initialRunId?: string; rows?: number; columns?: number } = {}): Promise<Session> {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  if (props.rows) stdout.rows = props.rows;
  if (props.columns) stdout.columns = props.columns;
  const instance = render(<RunBrowser listRuns={listRuns} loadRun={loadRun} pollMs={60_000} {...(props.initialRunId ? { initialRunId: props.initialRunId } : {})} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  let exited = false;
  void instance.waitUntilExit().then(() => {
    exited = true;
  });
  const session: Session = {
    stdin,
    stdout,
    instance,
    frame: () => stdout.frames.at(-1) ?? '',
    press: async (...keys) => {
      for (const key of keys) {
        stdin.send(key);
        // A lone ESC is held back ~20ms by ink's input parser before being emitted.
        await sleep(key === KEY.escape ? 60 : 15);
      }
    },
    exited: () => exited,
  };
  sessions.push(session);
  await sleep(15);
  return session;
}

const selectedLine = (frame: string) => frame.split('\n').find((l) => l.startsWith('▶ ')) ?? '';

describe('RunBrowser keyboard', () => {
  it('moves the selection with ↓/↑ and j/k, clamped to the list', async () => {
    const s = await mount(() => RUNS);
    expect(selectedLine(s.frame())).toContain('Fix login redirect');

    await s.press(KEY.down);
    expect(selectedLine(s.frame())).toContain('Add agent metrics');
    expect(s.frame()).toContain('run_01BBB · linear:ENG-42 · in-place');

    await s.press('j', 'j', 'j');
    expect(selectedLine(s.frame())).toContain('Blocked agents cleanup');

    await s.press('k');
    expect(selectedLine(s.frame())).toContain('Add agent metrics');

    await s.press(KEY.up, KEY.up, KEY.up);
    expect(selectedLine(s.frame())).toContain('Fix login redirect');
  });

  it('jumps with g / G and pages with PageDown / PageUp', async () => {
    const many = Array.from({ length: 25 }, (_, i) => summary(`run_${String(i).padStart(2, '0')}`, { title: `Run number ${String(i).padStart(2, '0')}` }));
    const s = await mount(() => many, { rows: 40 });

    await s.press('G');
    expect(selectedLine(s.frame())).toContain('Run number 24');
    await s.press('g');
    expect(selectedLine(s.frame())).toContain('Run number 00');
    await s.press(KEY.pageDown);
    expect(selectedLine(s.frame())).toContain('Run number 10');
    await s.press(KEY.pageDown, KEY.pageDown);
    expect(selectedLine(s.frame())).toContain('Run number 24');
    await s.press(KEY.pageUp);
    expect(selectedLine(s.frame())).toContain('Run number 14');
    await s.press(KEY.pageUp, KEY.pageUp);
    expect(selectedLine(s.frame())).toContain('Run number 00');
  });

  it('scrolls a long list so the selected row stays visible', async () => {
    const many = Array.from({ length: 40 }, (_, i) => summary(`run_${String(i).padStart(2, '0')}`, { title: `Run number ${String(i).padStart(2, '0')}` }));
    // rows 16 → list height max(5, 16 - 9) = 7
    const s = await mount(() => many, { rows: 16 });
    const visibleRows = () => s.frame().split('\n').filter((l) => l.includes('Run number')).length;
    expect(visibleRows()).toBe(7);
    expect(s.frame()).not.toContain('Run number 07');

    await s.press('G');
    expect(selectedLine(s.frame())).toContain('Run number 39');
    expect(visibleRows()).toBe(7);
    expect(s.frame()).toContain('Run number 33');
    expect(s.frame()).not.toContain('Run number 32');
    expect(s.frame()).not.toContain('Run number 00');
  });

  it('truncates long titles to the terminal width', async () => {
    const long = summary('run_long', { title: `Start ${'x'.repeat(200)} end` });
    const s = await mount(() => [long], { columns: 80 });
    // titleWidth = max(20, 80 - 47) = 33 (the cost column is 8 wide so $100+ stays aligned)
    expect(s.frame()).toContain(`Start ${'x'.repeat(26)}…`);
    expect(s.frame()).not.toContain(' end');
  });

  it('filters with "/", shows "N of M", and clears with Esc', async () => {
    const s = await mount(() => RUNS);
    await s.press('/');
    expect(s.frame()).toContain('filter: █');

    await s.press('a', 'g', 'e', 'n', 't');
    expect(s.frame()).toContain('filter: agent█');
    expect(s.frame()).toContain('RUNS 2 of 3');
    expect(s.frame()).not.toContain('Fix login redirect');
    expect(selectedLine(s.frame())).toContain('Add agent metrics');

    await s.press('s');
    expect(s.frame()).toContain('filter: agents█');
    expect(s.frame()).toContain('RUNS 1 of 3');
    expect(selectedLine(s.frame())).toContain('Blocked agents cleanup');

    await s.press(KEY.backspace);
    expect(s.frame()).toContain('filter: agent█');
    expect(s.frame()).toContain('RUNS 2 of 3');

    await s.press(KEY.enter);
    expect(s.frame()).toContain('filter: agent');
    expect(s.frame()).not.toContain('█');
    expect(s.frame()).toContain('RUNS 2 of 3');

    await s.press(KEY.escape);
    expect(s.frame()).not.toContain('filter:');
    expect(s.frame()).toContain('RUNS 3 ·');
    expect(s.frame()).toContain('Fix login redirect');
  });

  it('treats q as text while editing the filter instead of quitting', async () => {
    const s = await mount(() => RUNS);
    await s.press('/', 'q');
    expect(s.frame()).toContain('filter: q█');
    expect(s.exited()).toBe(false);
  });

  it('Esc while editing discards the filter', async () => {
    const s = await mount(() => RUNS);
    await s.press('/', 'z', 'z');
    expect(s.frame()).toContain('no runs match the filter');
    expect(s.frame()).toContain('RUNS 0 of 3');
    await s.press(KEY.escape);
    expect(s.frame()).not.toContain('filter:');
    expect(s.frame()).toContain('RUNS 3 ·');
  });

  it('resets the selection to the top when the filter changes', async () => {
    const s = await mount(() => RUNS);
    await s.press('G');
    expect(selectedLine(s.frame())).toContain('Blocked agents cleanup');
    await s.press('/', 'a');
    expect(selectedLine(s.frame())).toContain('Fix login redirect');
  });

  it('r reloads the list from listRuns', async () => {
    let runs = [RUNS[0]!];
    const listRuns = vi.fn(() => runs);
    const s = await mount(listRuns);
    expect(s.frame()).toContain('RUNS 1 ·');
    runs = RUNS;
    await s.press('r');
    expect(s.frame()).toContain('RUNS 3 ·');
    expect(s.frame()).toContain('Add agent metrics');
  });

  it('polls listRuns while the list is shown', async () => {
    let runs: RunSummary[] = [];
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const instance = render(<RunBrowser listRuns={() => runs} loadRun={loadRun} pollMs={20} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
    sessions.push({ stdin, stdout, instance, frame: () => '', press: async () => {}, exited: () => false });
    await sleep(15);
    expect(stdout.frames.at(-1)).toContain('no runs yet');
    runs = RUNS;
    for (let i = 0; i < 100 && !stdout.frames.at(-1)?.includes('RUNS 3 ·'); i++) await sleep(10);
    expect(stdout.frames.at(-1)).toContain('RUNS 3 ·');
  });

  it('enter opens the selected run; q returns to the list without exiting', async () => {
    const listRuns = vi.fn(() => RUNS);
    const s = await mount(listRuns);
    await s.press('j', KEY.enter);
    expect(s.frame()).toContain('RUN run_01BBB');
    expect(s.frame()).toContain('q back to runs');

    const callsBefore = listRuns.mock.calls.length;
    await s.press('q');
    expect(s.exited()).toBe(false);
    expect(s.frame()).toContain('RUNS 3 ·');
    expect(selectedLine(s.frame())).toContain('Add agent metrics');
    expect(listRuns.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('Esc in the run view also returns to the list', async () => {
    const s = await mount(() => RUNS);
    await s.press(KEY.enter);
    expect(s.frame()).toContain('RUN run_01AAA');
    await s.press(KEY.escape);
    expect(s.frame()).toContain('RUNS 3 ·');
    expect(s.exited()).toBe(false);
  });

  it('returns from an initialRunId view to the list', async () => {
    const s = await mount(() => RUNS, { initialRunId: 'run_01CCC' });
    expect(s.frame()).toContain('RUN run_01CCC');
    await s.press('q');
    expect(s.frame()).toContain('RUNS 3 ·');
    expect(s.exited()).toBe(false);
  });

  it('enter does nothing when the filter matches no runs', async () => {
    const s = await mount(() => RUNS);
    await s.press('/', 'z', KEY.enter, KEY.enter);
    expect(s.frame()).toContain('no runs match the filter');
    expect(s.frame()).not.toContain('RUN run_');
  });

  it('q on the list exits; Esc without a filter does not', async () => {
    const s = await mount(() => RUNS);
    await s.press(KEY.escape);
    expect(s.exited()).toBe(false);
    await s.press('q');
    expect(s.exited()).toBe(true);
  });

  it('Ctrl+C on the list exits', async () => {
    const s = await mount(() => RUNS);
    await s.press('\u0003');
    expect(s.exited()).toBe(true);
  });
});
