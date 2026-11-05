import { chmodSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApertureStore } from '@aperture/storage';
import { runRecord, taskRecord } from '../../../tests/helpers/records.ts';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { main } from './main.ts';

const tmp = new TempDirs();
const VAR = 'APERTURE_MAIN_TEST_SECRET';
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.APERTURE_ENV_FILE;
  delete process.env[VAR];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  tmp.cleanup();
});

function writeEnv(dir: string, content: string, mode = 0o600): string {
  const path = join(dir, 'test.env');
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function statusArgv(dir: string, envFile: string): string[] {
  return ['node', 'aperture', '--env-file', envFile, '--home', dir, '--config', join(dir, 'c.yaml'), 'status'];
}

describe('main --env-file', () => {
  it('loads the explicit env file before the command runs and records it in APERTURE_ENV_FILE', async () => {
    const dir = tmp.make();
    const file = writeEnv(dir, `${VAR}=from-file\n`);
    expect(await main(statusArgv(dir, file))).toBe(0);
    expect(process.env[VAR]).toBe('from-file');
    expect(process.env.APERTURE_ENV_FILE).toBe(file);
  });

  it('resolves a relative --env-file to an absolute APERTURE_ENV_FILE', async () => {
    const dir = tmp.make();
    const file = writeEnv(dir, `${VAR}=relative\n`);
    expect(await main(statusArgv(dir, relative(process.cwd(), file)))).toBe(0);
    expect(process.env[VAR]).toBe('relative');
    expect(process.env.APERTURE_ENV_FILE).toBe(file);
  });

  it('does not override a variable already set in the environment', async () => {
    const dir = tmp.make();
    process.env[VAR] = 'from-shell';
    const file = writeEnv(dir, `${VAR}=from-file\n`);
    expect(await main(statusArgv(dir, file))).toBe(0);
    expect(process.env[VAR]).toBe('from-shell');
  });

  it('fails with exit code 1 when the explicit file does not exist', async () => {
    const dir = tmp.make();
    const missing = join(dir, 'missing.env');
    expect(await main(statusArgv(dir, missing))).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(`aperture: env file ${missing} does not exist\n`);
    expect(process.env.APERTURE_ENV_FILE).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('prints a warning for a group/other-readable env file but still loads it', async () => {
    const dir = tmp.make();
    const file = writeEnv(dir, `${VAR}=loose\n`, 0o644);
    expect(await main(statusArgv(dir, file))).toBe(0);
    expect(process.env[VAR]).toBe('loose');
    expect(process.stderr.write).toHaveBeenCalledWith(`warning: ${file} is readable by other users; run \`chmod 600 ${file}\`\n`);
  });
});

describe('main run browser (`aperture` / `aperture ui`) off a terminal', () => {
  const saved = { stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY') };

  function setTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): void {
    Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true });
  }

  beforeEach(() => {
    setTTY(process.stdin, false);
    setTTY(process.stdout, false);
  });

  afterEach(() => {
    for (const [stream, desc] of [
      [process.stdin, saved.stdin],
      [process.stdout, saved.stdout],
    ] as const) {
      if (desc) Object.defineProperty(stream, 'isTTY', desc);
      else delete (stream as { isTTY?: boolean }).isTTY;
    }
  });

  const argv = (dir: string, ...rest: string[]) => ['node', 'aperture', '--home', dir, '--config', join(dir, 'c.yaml'), ...rest];
  const stdout = () => vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');

  function seed(dir: string): void {
    const store = ApertureStore.open(join(dir, 'aperture.db'));
    try {
      store.insertTask(taskRecord('task_a', { title: 'Fix the login bug', sourceRef: 'github:org/web#7' }));
      store.insertTask(taskRecord('task_b', { title: 'Add metrics' }));
      store.insertRun(runRecord('run_01OLD', 'task_a', { state: 'BLOCKED', startedAt: '2026-11-01T00:00:00.000Z' }));
      store.insertRun(runRecord('run_01NEW', 'task_b', { state: 'EXECUTING', startedAt: '2026-11-03T00:00:00.000Z' }));
      store.insertUsage({ requestId: 'req_1', runId: 'run_01OLD', phase: 'implementation', modelId: 'claude-sonnet-5-5', input: 1, output: 1, cacheWrite: 0, cacheRead: 0, costUsd: 0.25, estimatedUsd: null, createdAt: '2026-11-01T00:00:01.000Z' });
    } finally {
      store.close();
    }
  }

  it('with no command prints "no runs yet" for an empty store', async () => {
    const dir = tmp.make();
    expect(await main(argv(dir))).toBe(0);
    expect(stdout()).toBe('no runs yet\n');
  });

  it('with no command prints the plain run list, newest first', async () => {
    const dir = tmp.make();
    seed(dir);
    expect(await main(argv(dir))).toBe(0);
    expect(stdout()).toBe(`run_01NEW  ${'EXECUTING'.padEnd(22)}  $0.000  Add metrics\nrun_01OLD  ${'BLOCKED'.padEnd(22)}  $0.250  Fix the login bug\n`);
  });

  it('falls back when only stdout is not a terminal', async () => {
    const dir = tmp.make();
    seed(dir);
    setTTY(process.stdin, true);
    expect(await main(argv(dir, 'ui'))).toBe(0);
    expect(stdout()).toContain('run_01NEW  EXECUTING');
  });

  it('falls back when only stdin is not a terminal', async () => {
    const dir = tmp.make();
    seed(dir);
    setTTY(process.stdout, true);
    expect(await main(argv(dir, 'ui'))).toBe(0);
    expect(stdout()).toContain('run_01OLD  BLOCKED');
  });

  it('`ui <run-id>` prints the run status, resolving a unique prefix', async () => {
    const dir = tmp.make();
    seed(dir);
    expect(await main(argv(dir, 'ui', 'run_01OL'))).toBe(0);
    const out = stdout();
    expect(out).toContain('RUN       run_01OLD\n');
    expect(out).toContain('STATE     BLOCKED\n');
    expect(out).toContain('TASK      Fix the login bug (github:org/web#7)\n');
    expect(out).toContain('SPENT     implementation $0.250  pr $0.000\n');
    expect(out).not.toContain('run_01NEW');
  });

  it('`ui <unknown-id>` fails with exit code 1', async () => {
    const dir = tmp.make();
    seed(dir);
    expect(await main(argv(dir, 'ui', 'run_missing'))).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith('aperture: run run_missing not found\n');
  });
});
