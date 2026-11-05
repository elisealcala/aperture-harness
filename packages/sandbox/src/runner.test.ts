import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { detectIsolation, IsolationUnavailableError, SandboxRunner, seatbeltProfile, type SandboxPolicy } from './runner.ts';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

function policy(extra: Partial<SandboxPolicy> = {}): SandboxPolicy {
  const root = tmp.make('aperture-runner-');
  const worktreePath = join(root, 'clone');
  mkdirSync(join(worktreePath, '.git'), { recursive: true });
  return { worktreePath, tmpDir: join(root, 'tmp'), hiddenPaths: [join(root, 'secrets')], ...extra };
}

/** Runs `node -e` printing the given env names as JSON. */
const PRINT_ENV = (names: string[]) => ({ exec: process.execPath, args: ['-e', `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, process.env[n] ?? null]))))`], timeoutMs: 20_000 });

describe('seatbeltProfile (A1)', () => {
  const base: SandboxPolicy = { worktreePath: '/w/clone', tmpDir: '/w/tmp', hiddenPaths: ['/home/u/.ssh'] };

  it('denies all IP egress and adds no exception without a proxy port', () => {
    const profile = seatbeltProfile(base);
    expect(profile).toContain('(deny network-outbound (remote ip))');
    expect(profile).not.toMatch(/allow network-outbound/);
  });

  it('allows only the loopback proxy port when one is given, after the blanket deny', () => {
    const profile = seatbeltProfile(base, { proxyPort: 54321 });
    const deny = profile.indexOf('(deny network-outbound (remote ip))');
    const allow = profile.indexOf('(allow network-outbound (remote ip "localhost:54321"))');
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(allow).toBeGreaterThan(deny);
    expect(profile.match(/allow network-outbound/g)).toHaveLength(1);
    // Inbound/bind stay denied even with a proxy.
    expect(profile).toContain('(deny network-inbound (local ip))');
    expect(profile).toContain('(deny network-bind (local ip))');
  });

  it('truncates a fractional proxy port instead of emitting it verbatim', () => {
    expect(seatbeltProfile(base, { proxyPort: 8080.9 })).toContain('"localhost:8080"');
  });

  it('denies writes to read-only paths after the worktree write allowance (later rules win)', () => {
    const profile = seatbeltProfile({ ...base, readOnlyPaths: ['/w/clone/.git'] });
    const allowWorktree = profile.lastIndexOf('(allow file-read* file-write* (subpath "/w/clone")');
    const denyGit = profile.indexOf('(deny file-write* (subpath "/w/clone/.git"))');
    expect(allowWorktree).toBeGreaterThanOrEqual(0);
    expect(denyGit).toBeGreaterThan(allowWorktree);
  });

  it('emits no read-only rule when there are no read-only paths', () => {
    expect(seatbeltProfile({ ...base, readOnlyPaths: [] })).not.toMatch(/\.git/);
  });

  it('quotes paths so they cannot break out of the profile string', () => {
    expect(seatbeltProfile({ ...base, readOnlyPaths: ['/w/a"b\\c/.git'] })).toContain('(subpath "/w/a\\"b\\\\c/.git")');
  });
});

describe('SandboxRunner env and proxy (A1)', () => {
  it('realpaths existing read-only paths and keeps missing ones as given', () => {
    const p = policy();
    const runner = new SandboxRunner('reduced', { ...p, readOnlyPaths: [join(p.worktreePath, '.git'), join(p.worktreePath, 'missing')] });
    expect(runner.effectivePolicy.readOnlyPaths).toEqual([realpathSync(join(p.worktreePath, '.git')), join(p.worktreePath, 'missing')]);
  });

  it('injects the command env and the proxy variables for that command only', async () => {
    const runner = new SandboxRunner('reduced', policy(), { PATH: process.env.PATH, OPERATOR_TOKEN: 'must-not-leak' });
    const names = ['STUDIO_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'OPERATOR_TOKEN'];
    const withProxy = await runner.run({ ...PRINT_ENV(names), env: { STUDIO_BASE_URL: 'https://studio.example.dev' }, proxyPort: 41234 });
    expect(withProxy.exitCode).toBe(0);
    const proxy = 'http://127.0.0.1:41234';
    expect(JSON.parse(withProxy.stdout)).toEqual({ STUDIO_BASE_URL: 'https://studio.example.dev', HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1', OPERATOR_TOKEN: null });

    const plain = await runner.run(PRINT_ENV(names));
    expect(Object.values(JSON.parse(plain.stdout) as Record<string, unknown>).every((v) => v === null)).toBe(true);
  });

  it('never lets command env override the sandbox variables', async () => {
    const p = policy();
    const runner = new SandboxRunner('reduced', p);
    const result = await runner.run({ ...PRINT_ENV(['HOME', 'TMPDIR', 'NODE_OPTIONS', 'HTTPS_PROXY']), env: { HOME: '/', TMPDIR: '/', NODE_OPTIONS: '--require /tmp/x.js', HTTPS_PROXY: 'http://attacker.example:1' }, proxyPort: 40000 });
    const tmpDir = realpathSync(p.tmpDir);
    expect(JSON.parse(result.stdout)).toEqual({ HOME: tmpDir, TMPDIR: tmpDir, NODE_OPTIONS: '', HTTPS_PROXY: 'http://127.0.0.1:40000' });
  });

  it('fails closed for allowlisted egress under bubblewrap, before spawning anything', async () => {
    const runner = new SandboxRunner('linux-bwrap', policy());
    await expect(runner.run({ exec: 'definitely-not-run', args: [], timeoutMs: 1000, proxyPort: 40000 })).rejects.toBeInstanceOf(IsolationUnavailableError);
    await expect(runner.run({ exec: 'definitely-not-run', args: [], timeoutMs: 1000, proxyPort: 40000 })).rejects.toThrow(/bubblewrap/);
  });
});

/** Runs `node -e` printing its working directory. */
const PRINT_CWD = (cwd?: string) => ({ exec: process.execPath, args: ['-e', 'console.log(process.cwd())'], timeoutMs: 20_000, ...(cwd !== undefined ? { cwd } : {}) });

describe('SandboxCommand.cwd (auto-format)', () => {
  it('runs in the worktree root without a cwd', async () => {
    const p = policy();
    const result = await new SandboxRunner('reduced', p).run(PRINT_CWD());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(realpathSync(p.worktreePath));
  });

  it.each(['studio', 'studio/', 'apps/web'])('runs in the repository-relative subdirectory %j', async (cwd) => {
    const p = policy();
    mkdirSync(join(p.worktreePath, cwd), { recursive: true });
    const result = await new SandboxRunner('reduced', p).run(PRINT_CWD(cwd));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(realpathSync(join(p.worktreePath, cwd)));
  });

  it('follows a symlinked directory that stays inside the worktree', async () => {
    const p = policy();
    mkdirSync(join(p.worktreePath, 'packages/studio'), { recursive: true });
    symlinkSync(join(p.worktreePath, 'packages/studio'), join(p.worktreePath, 'studio'));
    const result = await new SandboxRunner('reduced', p).run(PRINT_CWD('studio'));
    expect(result.stdout.trim()).toBe(realpathSync(join(p.worktreePath, 'packages/studio')));
  });

  it('throws when a symlinked directory points outside the worktree, before spawning', async () => {
    const p = policy();
    const outside = tmp.make('aperture-outside-');
    symlinkSync(outside, join(p.worktreePath, 'escape'));
    const runner = new SandboxRunner('reduced', p);
    await expect(runner.run(PRINT_CWD('escape'))).rejects.toThrow('cwd escape escapes the worktree');
    await expect(runner.run(PRINT_CWD('escape/'))).rejects.toThrow(/escapes the worktree/);
  });

  it.each(['..', '../..'])('throws for a cwd %j that resolves above the worktree', async (cwd) => {
    await expect(new SandboxRunner('reduced', policy()).run(PRINT_CWD(cwd))).rejects.toThrow(/escapes the worktree/);
  });

  it('throws when the cwd does not exist', async () => {
    await expect(new SandboxRunner('reduced', policy()).run(PRINT_CWD('missing'))).rejects.toThrow(/ENOENT/);
  });

  it.skipIf(detectIsolation() !== 'macos-seatbelt')('honors cwd under macOS seatbelt', async () => {
    const p = policy();
    mkdirSync(join(p.worktreePath, 'studio'), { recursive: true });
    const result = await new SandboxRunner('macos-seatbelt', p).run(PRINT_CWD('studio'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(realpathSync(join(p.worktreePath, 'studio')));
  });
});
