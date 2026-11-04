import { chmodSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
