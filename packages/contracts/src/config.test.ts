import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ConfigError, DEFAULT_CONFIG_YAML, expandHome, loadUserConfig, parseUserConfig, resolveStorageDirectory } from './config.ts';

function configError(raw: unknown): ConfigError {
  try {
    parseUserConfig(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected ConfigError');
}

describe('parseUserConfig', () => {
  it('applies defaults to an empty config', () => {
    const config = parseUserConfig({});
    expect(config.providers.anthropic).toEqual({ apiKeyEnv: 'ANTHROPIC_API_KEY' });
    expect(config.providers.github).toEqual({ tokenEnv: 'GITHUB_TOKEN', useGhCli: true, apiUrl: 'https://api.github.com' });
    expect(config.models.implementation).toBe('claude-sonnet-5-5');
    expect(config.models.prDraft).toBe('claude-haiku-5-5');
    expect(config.cache).toEqual({ enabled: true, ttl: '5m' });
    expect(config.limits.maxCostPerRunUsd).toBe(0.5);
    expect(config.runtime).toEqual({ isolation: 'required', network: 'allowlist', questionMode: 'interactive', workspace: 'in-place' });
    expect(config.pr).toEqual({ draftByDefault: false, requireApproval: true });
    expect(config.commands).toEqual({});
  });

  it.each([null, undefined])('treats %s as an empty config', (raw) => {
    expect(parseUserConfig(raw)).toEqual(parseUserConfig({}));
  });

  it('fills nested defaults inside a partially specified section', () => {
    const config = parseUserConfig({ providers: { anthropic: { apiKeyEnv: 'MY_KEY_VAR' } }, limits: { maxModelTurns: 4 } });
    expect(config.providers.anthropic.apiKeyEnv).toBe('MY_KEY_VAR');
    expect(config.providers.linear.apiKeyEnv).toBe('LINEAR_API_KEY');
    expect(config.limits).toMatchObject({ maxModelTurns: 4, maxPatchAttempts: 8, reserveFraction: 0.05 });
  });

  it('parses trusted commands with defaults', () => {
    const config = parseUserConfig({ commands: { typecheck: { exec: 'pnpm', args: ['exec', 'tsc', '--noEmit'] } } });
    expect(config.commands.typecheck).toEqual({ exec: 'pnpm', args: ['exec', 'tsc', '--noEmit'], timeoutSeconds: 300 });
  });

  describe('inline secrets', () => {
    it.each([
      [{ providers: { anthropic: { apiKey: 'sk-ant-api03-xxxxxxxxxxxxxxxx' } } }, 'providers.anthropic.apiKey', 'sk-ant-api03-xxxxxxxxxxxxxxxx'],
      [{ providers: { github: { token: 'ghp_abcdefghijklmnopqrstuvwxyz' } } }, 'providers.github.token', 'ghp_abcdefghijklmnopqrstuvwxyz'],
      [{ providers: { linear: { api_key: 'lin_api_secretvalue' } } }, 'providers.linear.api_key', 'lin_api_secretvalue'],
      [{ repositories: { 'org/repo': { path: '/x', password: 'hunter2hunter2' } } }, 'repositories.org/repo.password', 'hunter2hunter2'],
      [{ clientSecret: 'shh-very-secret' }, 'clientSecret', 'shh-very-secret'],
    ])('rejects %j', (raw, path, secretValue) => {
      const err = configError(raw);
      expect(err.message).toMatch(/secrets must come from environment variables/);
      expect(err.issues).toEqual([path]);
      // The secret value itself must never be echoed back in the error.
      expect(err.message).not.toContain(secretValue);
    });

    it('allows *Env indirections that name environment variables', () => {
      expect(() => parseUserConfig({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' }, github: { tokenEnv: 'GH_TOKEN' } } })).not.toThrow();
    });
  });

  describe('unknown keys and privileged values', () => {
    it.each([
      [{ unknownTopLevel: true }],
      [{ providers: { openai: {} } }],
      [{ runtime: { sandbox: 'off' } }],
      [{ limits: { maxCostPerRunUsd: 1, unlimited: true } }],
      [{ pr: { autoMerge: true } }],
    ])('rejects unknown keys in %j', (raw) => {
      const err = configError(raw);
      expect(err.message).toMatch(/invalid aperture config/);
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it.each([
      [{ runtime: { network: 'allow' } }, /runtime\.network/],
      [{ runtime: { isolation: 'none' } }, /runtime\.isolation/],
      [{ pr: { requireApproval: false } }, /pr\.requireApproval/],
      [{ limits: { reserveFraction: 0.9 } }, /limits\.reserveFraction/],
      [{ repositories: { 'not a slug': { path: '/x' } } }, /repositories/],
      [{ commands: { evil: { exec: 'sh -c', args: [] } } }, /commands\.evil\.exec/],
    ])('rejects %j', (raw, issue) => {
      expect(configError(raw).issues.join('\n')).toMatch(issue);
    });
  });
});

describe('loadUserConfig', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmpFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'aperture-config-'));
    dirs.push(dir);
    const path = join(dir, 'config.yaml');
    writeFileSync(path, content);
    return path;
  }

  it('returns defaults when the file does not exist', () => {
    expect(loadUserConfig(join(tmpdir(), 'aperture-does-not-exist', 'config.yaml'))).toEqual(parseUserConfig({}));
  });

  it('parses a YAML file', () => {
    const config = loadUserConfig(tmpFile('runtime:\n  isolation: reduced\n  questionMode: noninteractive\n'));
    expect(config.runtime).toEqual({ isolation: 'reduced', network: 'allowlist', questionMode: 'noninteractive', workspace: 'in-place' });
  });

  it('rejects invalid YAML with a ConfigError', () => {
    expect(() => loadUserConfig(tmpFile('runtime: [unclosed\n'))).toThrow(/is not valid YAML/);
  });

  it('rejects inline secrets in the file', () => {
    expect(() => loadUserConfig(tmpFile('providers:\n  anthropic:\n    apiKey: sk-ant-api03-abcdefghijkl\n'))).toThrow(ConfigError);
  });
});

describe('path helpers', () => {
  it('expandHome expands ~ and ~/ only', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/data', '/home/u')).toBe('/home/u/data');
    expect(expandHome('/abs/~/x', '/home/u')).toBe('/abs/~/x');
  });

  it('resolveStorageDirectory honours APERTURE_HOME', () => {
    const config = parseUserConfig({ storage: { directory: '/var/lib/aperture' } });
    expect(resolveStorageDirectory(config, { APERTURE_HOME: '/tmp/ah' })).toBe(resolve('/tmp/ah'));
    expect(resolveStorageDirectory(config, {})).toBe('/var/lib/aperture');
  });
});

describe('runtime workspace and network (A1)', () => {
  it('accepts runtime.workspace worktree and runtime.network deny', () => {
    expect(parseUserConfig({ runtime: { workspace: 'worktree', network: 'deny' } }).runtime).toEqual({ isolation: 'required', network: 'deny', questionMode: 'interactive', workspace: 'worktree' });
  });

  it.each([
    [{ workspace: 'clone' }, 'workspace'],
    [{ workspace: 'inplace' }, 'workspace'],
    [{ network: 'open' }, 'network'],
    [{ network: true }, 'network'],
  ])('rejects runtime %j', (runtime, key) => {
    expect(configError({ runtime }).issues.join('\n')).toMatch(new RegExp(`runtime\\.${key}`));
  });

  it('DEFAULT_CONFIG_YAML documents the in-place and allowlist defaults and parses to the defaults', () => {
    const parsed = parseUserConfig(parseYaml(DEFAULT_CONFIG_YAML));
    expect(parsed.runtime).toEqual(parseUserConfig({}).runtime);
    expect(DEFAULT_CONFIG_YAML).toMatch(/workspace: in-place/);
    expect(DEFAULT_CONFIG_YAML).toMatch(/network: allowlist/);
  });

  it('DEFAULT_CONFIG_YAML opens ready-for-review PRs by default', () => {
    const parsed = parseUserConfig(parseYaml(DEFAULT_CONFIG_YAML));
    expect(parsed.pr).toEqual({ draftByDefault: false, requireApproval: true });
    expect(DEFAULT_CONFIG_YAML).toMatch(/^ {2}draftByDefault: false\b/m);
  });

  it('honors an explicit pr.draftByDefault: true', () => {
    expect(parseUserConfig({ pr: { draftByDefault: true } }).pr).toEqual({ draftByDefault: true, requireApproval: true });
  });
});

describe('formatters (auto-format)', () => {
  const biome = { exec: 'pnpm', args: ['exec', 'biome', 'format', '--write'], include: ['studio/**/*.ts'] };

  it('defaults to no formatters', () => {
    expect(parseUserConfig({}).formatters).toEqual({});
  });

  it('parses a formatter and fills args and timeoutSeconds defaults', () => {
    expect(parseUserConfig({ formatters: { fmt: { exec: 'node', include: ['**/*.ts'] } } }).formatters).toEqual({ fmt: { exec: 'node', args: [], include: ['**/*.ts'], timeoutSeconds: 120 } });
  });

  it('keeps an explicit cwd, args and timeout', () => {
    const config = parseUserConfig({ formatters: { 'studio-biome': { ...biome, cwd: 'studio', timeoutSeconds: 30 } } });
    expect(config.formatters['studio-biome']).toEqual({ ...biome, cwd: 'studio', timeoutSeconds: 30 });
  });

  it.each(['studio', 'apps/web', 'apps/web/', 'packages/a-b_c.d'])('accepts the plain repository-relative cwd %j', (cwd) => {
    expect(parseUserConfig({ formatters: { fmt: { ...biome, cwd } } }).formatters.fmt!.cwd).toBe(cwd);
  });

  it.each([
    ['..', 'parent traversal'],
    ['../outside', 'parent traversal'],
    ['studio/../..', 'parent traversal'],
    ['/abs/studio', 'absolute'],
    ['C:/studio', 'drive-absolute'],
    ['~/studio', 'home-relative'],
    ['studio\\web', 'backslash'],
    ['.git', '.git'],
    ['studio/.git', 'nested .git'],
    ['studio/*', 'star glob'],
    ['apps/**', 'globstar'],
    ['app?', 'question-mark glob'],
    ['apps/[ab]', 'character class'],
    ['{a,b}', 'brace expansion'],
    ['studio\u0000', 'control character'],
  ])('rejects cwd %j (%s)', (cwd) => {
    expect(configError({ formatters: { fmt: { ...biome, cwd } } }).issues.join('\n')).toMatch(/formatters\.fmt\.cwd/);
  });

  it('rejects a cwd longer than 512 characters', () => {
    expect(configError({ formatters: { fmt: { ...biome, cwd: 'a'.repeat(513) } } }).issues.join('\n')).toMatch(/formatters\.fmt\.cwd/);
  });

  it.each([
    [{ exec: 'node' }, 'missing include'],
    [{ exec: 'node', include: [] }, 'empty include'],
  ])('requires at least one include glob (%j, %s)', (spec, _label) => {
    expect(configError({ formatters: { fmt: spec } }).issues.join('\n')).toMatch(/formatters\.fmt\.include/);
  });

  it.each(['../outside/**', '/abs/**', '.git/**'])('rejects the unsafe include glob %j', (glob) => {
    expect(configError({ formatters: { fmt: { exec: 'node', include: [glob] } } }).issues.join('\n')).toMatch(/formatters\.fmt\.include/);
  });

  it.each(['pnpm exec biome', 'sh -c', 'a;b', '$(whoami)', 'fmt|tee', ''])('rejects the exec %j (no shell syntax)', (exec) => {
    expect(configError({ formatters: { fmt: { ...biome, exec } } }).issues.join('\n')).toMatch(/formatters\.fmt\.exec/);
  });

  it('accepts an exec given as a relative or absolute path', () => {
    expect(parseUserConfig({ formatters: { a: { ...biome, exec: './node_modules/.bin/biome' }, b: { ...biome, exec: '/usr/local/bin/prettier' } } }).formatters.b!.exec).toBe('/usr/local/bin/prettier');
  });

  it.each([0, -1, 1.5, 1801])('rejects timeoutSeconds %j', (timeoutSeconds) => {
    expect(configError({ formatters: { fmt: { ...biome, timeoutSeconds } } }).issues.join('\n')).toMatch(/formatters\.fmt\.timeoutSeconds/);
  });

  it('rejects more than 64 args', () => {
    expect(configError({ formatters: { fmt: { ...biome, args: Array.from({ length: 65 }, () => 'x') } } }).issues.join('\n')).toMatch(/formatters\.fmt\.args/);
  });

  it.each(['-leading-dash', '.hidden', 'has space', 'a/b', 'x'.repeat(65)])('rejects the formatter id %j', (id) => {
    expect(configError({ formatters: { [id]: biome } }).issues.length).toBeGreaterThan(0);
  });

  it('rejects unknown formatter keys (strict)', () => {
    expect(configError({ formatters: { fmt: { ...biome, shell: true } } }).message).toMatch(/invalid aperture config/);
  });

  it('DEFAULT_CONFIG_YAML still parses to the defaults (formatters {}) and its commented example is valid', () => {
    expect(parseUserConfig(parseYaml(DEFAULT_CONFIG_YAML)).formatters).toEqual({});
    const lines = DEFAULT_CONFIG_YAML.split('\n');
    const start = lines.indexOf('# formatters:');
    expect(start).toBeGreaterThan(0);
    const example: string[] = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith('# ') || (example.length > 0 && !line.startsWith('#  '))) break;
      example.push(line.slice(2));
    }
    const parsed = parseUserConfig(parseYaml(example.join('\n')));
    expect(parsed.formatters['studio-biome']).toMatchObject({ exec: 'pnpm', cwd: 'studio', include: ['studio/**/*.{ts,tsx,js,jsx,json}'], timeoutSeconds: 120 });
  });
});
