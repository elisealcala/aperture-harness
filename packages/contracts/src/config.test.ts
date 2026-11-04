import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, expandHome, loadUserConfig, parseUserConfig, resolveStorageDirectory } from './config.ts';

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
    expect(config.runtime).toEqual({ isolation: 'required', network: 'deny', questionMode: 'interactive' });
    expect(config.pr.requireApproval).toBe(true);
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
    expect(config.runtime).toEqual({ isolation: 'reduced', network: 'deny', questionMode: 'noninteractive' });
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
