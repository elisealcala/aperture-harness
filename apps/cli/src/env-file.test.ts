import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { envFileCandidates, loadEnvFiles } from './env-file.ts';

const tmp = new TempDirs();

afterEach(() => {
  tmp.cleanup();
});

function writeEnv(dir: string, name: string, content: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

describe('envFileCandidates', () => {
  it('defaults to the harness .env, then the per-user one under XDG_CONFIG_HOME', () => {
    expect(envFileCandidates({ harnessRoot: '/opt/harness', env: { XDG_CONFIG_HOME: '/xdg', HOME: '/home/me' } })).toEqual([
      join('/opt/harness', '.env'),
      join('/xdg', 'aperture', '.env'),
    ]);
  });

  it('falls back to $HOME/.config when XDG_CONFIG_HOME is unset', () => {
    expect(envFileCandidates({ harnessRoot: '/opt/harness', env: { HOME: '/home/me' } })).toEqual([
      join('/opt/harness', '.env'),
      join('/home/me', '.config', 'aperture', '.env'),
    ]);
  });

  it('uses only the explicit path, resolved against cwd', () => {
    expect(envFileCandidates({ explicit: 'secrets/dev.env', harnessRoot: '/opt/harness', env: { HOME: '/home/me' }, cwd: '/work' })).toEqual([
      resolve('/work', 'secrets/dev.env'),
    ]);
    expect(envFileCandidates({ explicit: '/abs/x.env', harnessRoot: '/opt/harness', env: {}, cwd: '/work' })).toEqual(['/abs/x.env']);
  });

  it('uses APERTURE_ENV_FILE when no explicit path is given', () => {
    expect(envFileCandidates({ harnessRoot: '/opt/harness', env: { APERTURE_ENV_FILE: 'from-env.env', HOME: '/home/me' }, cwd: '/work' })).toEqual([
      resolve('/work', 'from-env.env'),
    ]);
  });

  it('prefers the explicit option over APERTURE_ENV_FILE', () => {
    expect(envFileCandidates({ explicit: '/a.env', harnessRoot: '/opt/harness', env: { APERTURE_ENV_FILE: '/b.env' }, cwd: '/work' })).toEqual(['/a.env']);
  });
});

describe('loadEnvFiles', () => {
  it('parses KEY=value files (comments, quotes) into env and reports loaded keys', () => {
    const dir = tmp.make();
    const path = writeEnv(dir, '.env', '# comment\nAPI_KEY=sk-123\nQUOTED="hello world"\n\nEMPTY=\n');
    const env: NodeJS.ProcessEnv = {};
    const results = loadEnvFiles([path], env);
    expect(env).toEqual({ API_KEY: 'sk-123', QUOTED: 'hello world', EMPTY: '' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ path, skipped: [], warnings: [] });
    // Key order follows node:util parseEnv, which is not part of the contract.
    expect([...(results[0]?.loaded ?? [])].sort()).toEqual(['API_KEY', 'EMPTY', 'QUOTED']);
  });

  it('never overrides variables already present in env', () => {
    const dir = tmp.make();
    const path = writeEnv(dir, '.env', 'API_KEY=from-file\nOTHER=x\n');
    const env: NodeJS.ProcessEnv = { API_KEY: 'from-shell' };
    const [result] = loadEnvFiles([path], env);
    expect(env.API_KEY).toBe('from-shell');
    expect(env.OTHER).toBe('x');
    expect(result?.loaded).toEqual(['OTHER']);
    expect(result?.skipped).toEqual(['API_KEY']);
  });

  it('treats an existing empty string as set', () => {
    const dir = tmp.make();
    const path = writeEnv(dir, '.env', 'API_KEY=from-file\n');
    const env: NodeJS.ProcessEnv = { API_KEY: '' };
    const [result] = loadEnvFiles([path], env);
    expect(env.API_KEY).toBe('');
    expect(result?.skipped).toEqual(['API_KEY']);
  });

  it('lets an earlier file win over a later one', () => {
    const dir = tmp.make();
    const first = writeEnv(dir, 'first.env', 'SHARED=first\nONLY_FIRST=1\n');
    const second = writeEnv(dir, 'second.env', 'SHARED=second\nONLY_SECOND=2\n');
    const env: NodeJS.ProcessEnv = {};
    const results = loadEnvFiles([first, second], env);
    expect(env).toEqual({ SHARED: 'first', ONLY_FIRST: '1', ONLY_SECOND: '2' });
    expect(results.map((r) => r.path)).toEqual([first, second]);
    expect(results[1]).toMatchObject({ loaded: ['ONLY_SECOND'], skipped: ['SHARED'] });
  });

  it('skips missing files silently by default', () => {
    const dir = tmp.make();
    const present = writeEnv(dir, 'present.env', 'A=1\n');
    const env: NodeJS.ProcessEnv = {};
    const results = loadEnvFiles([join(dir, 'missing.env'), present], env);
    expect(results.map((r) => r.path)).toEqual([present]);
    expect(env).toEqual({ A: '1' });
    expect(loadEnvFiles([join(dir, 'missing.env')], {})).toEqual([]);
  });

  it('throws on a missing file when required', () => {
    const dir = tmp.make();
    const missing = join(dir, 'missing.env');
    expect(() => loadEnvFiles([missing], {}, { required: true })).toThrow(`env file ${missing} does not exist`);
  });

  it('loads an existing file normally when required', () => {
    const dir = tmp.make();
    const path = writeEnv(dir, '.env', 'A=1\n');
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFiles([path], env, { required: true })[0]?.loaded).toEqual(['A']);
    expect(env.A).toBe('1');
  });

  it('writes into process.env when no env is passed', () => {
    const dir = tmp.make();
    const key = `APERTURE_ENV_FILE_TEST_${process.pid}`;
    const path = writeEnv(dir, '.env', `${key}=default-target\n`);
    try {
      loadEnvFiles([path]);
      expect(process.env[key]).toBe('default-target');
    } finally {
      delete process.env[key];
    }
  });

  it.skipIf(process.platform === 'win32')('warns when the file is readable by group or others', () => {
    const dir = tmp.make();
    const loose = writeEnv(dir, 'loose.env', 'A=1\n', 0o644);
    const groupOnly = writeEnv(dir, 'group.env', 'B=1\n', 0o640);
    const [looseResult, groupResult] = loadEnvFiles([loose, groupOnly], {});
    expect(looseResult?.warnings).toEqual([`${loose} is readable by other users; run \`chmod 600 ${loose}\``]);
    expect(groupResult?.warnings).toHaveLength(1);
    // Still loaded despite the warning.
    expect(looseResult?.loaded).toEqual(['A']);
  });

  it.skipIf(process.platform === 'win32')('does not warn for owner-only files', () => {
    const dir = tmp.make();
    const path = writeEnv(dir, '.env', 'A=1\n', 0o600);
    expect(loadEnvFiles([path], {})[0]?.warnings).toEqual([]);
  });
});
