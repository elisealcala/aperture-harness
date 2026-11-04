import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseContract, parseUserConfig, type UserConfig } from '@aperture/contracts';
import type { NormalizedTask, RepoContext } from '@aperture/sources';
import { validContractInput } from '../../../tests/helpers/contracts.ts';
import { FakeFetch, fakeGitHub, fakeLinear, SAMPLE_COMMENT, sampleIssue, sampleLinearIssue } from '../../../tests/helpers/fetch.ts';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { stringify as toYaml } from 'yaml';
import { SourceRegistry } from './sources.ts';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

const REPO: RepoContext = { trackedFiles: ['src/api/session.ts'], baselineRef: 'HEAD' };

function config(raw: Record<string, unknown> = {}): UserConfig {
  return parseUserConfig({ providers: { github: { useGhCli: false } }, ...raw });
}

/** One fetch for both APIs, so the test can see which adapter called what. */
function bothApis(): FakeFetch {
  const github = fakeGitHub({ issue: sampleIssue(), comments: [SAMPLE_COMMENT] });
  const linear = fakeLinear({ issue: sampleLinearIssue() });
  return new FakeFetch((req) => {
    const fake = req.url.startsWith('https://api.linear.app/') ? linear : github;
    return fake.route(req);
  });
}

describe('SourceRegistry.withDefaults', () => {
  it('routes github: references to the GitHub adapter with the env token and the injected fetch', async () => {
    const fake = bothApis();
    const registry = SourceRegistry.withDefaults(config(), { GITHUB_TOKEN: 'gh-env-token' }, fake.fetch);
    const task = await registry.fetch('github:org/repo#142');
    expect(task).toMatchObject({ sourceType: 'github', taskKey: 'GH-142', repository: 'org/repo' });
    expect(fake.calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(fake.calls[0]!.headers.authorization).toBe('Bearer gh-env-token');
  });

  it('honors the configured GitHub token env var and API URL', async () => {
    const fake = new FakeFetch(() => ({ json: { ...sampleIssue(), comments: 0 } }));
    const cfg = config({ providers: { github: { tokenEnv: 'ACME_GH', useGhCli: false, apiUrl: 'https://ghe.example.test/api/v3' } } });
    await SourceRegistry.withDefaults(cfg, { ACME_GH: 'acme' }, fake.fetch).fetch('org/repo#142');
    expect(fake.calls[0]).toMatchObject({ url: 'https://ghe.example.test/api/v3/repos/org/repo/issues/142', headers: { authorization: 'Bearer acme' } });
  });

  it('routes linear: references to the Linear adapter with the env key and team mapping', async () => {
    const fake = bothApis();
    const cfg = config({ linear: { teamRepositories: { ENG: 'org/repo' } } });
    const task = await SourceRegistry.withDefaults(cfg, { LINEAR_API_KEY: 'lin_api_env' }, fake.fetch).fetch('linear:eng-123');
    expect(task).toMatchObject({ sourceType: 'linear', taskKey: 'ENG-123', repository: 'org/repo' });
    expect(fake.calls).toEqual([expect.objectContaining({ method: 'POST', url: 'https://api.linear.app/graphql', headers: expect.objectContaining({ authorization: 'lin_api_env' }) })]);
  });

  it('reads the Linear key from the configured env var and fails with AUTH when it is missing', async () => {
    const fake = bothApis();
    const cfg = config({ providers: { linear: { apiKeyEnv: 'ACME_LINEAR' } } });
    await expect(SourceRegistry.withDefaults(cfg, { LINEAR_API_KEY: 'ignored' }, fake.fetch).fetch('linear:ENG-123')).rejects.toMatchObject({ code: 'AUTH' });
    expect(fake.calls).toEqual([]);
    await expect(SourceRegistry.withDefaults(cfg, { ACME_LINEAR: 'k' }, fake.fetch).fetch('linear:ENG-123')).resolves.toMatchObject({ taskKey: 'ENG-123', repository: null });
  });

  it('routes contract paths to the YAML adapter relative to cwd', async () => {
    const dir = tmp.make();
    writeFileSync(join(dir, 'task.yaml'), toYaml(validContractInput()));
    const fake = bothApis();
    const task = await SourceRegistry.withDefaults(config(), {}, fake.fetch).fetch('task.yaml', dir);
    expect(task).toMatchObject({ sourceType: 'local', sourceRef: `local:${join(dir, 'task.yaml')}`, taskKey: 'LOCAL-1' });
    expect(task.contract).toBeDefined();
    expect(fake.calls).toEqual([]);
  });

  it('rejects unrecognized references', async () => {
    await expect(SourceRegistry.withDefaults(config(), {}, bothApis().fetch).fetch('jira:ABC-1')).rejects.toMatchObject({ code: 'INVALID_REF' });
  });
});

describe('SourceRegistry', () => {
  it('reports UNSUPPORTED when no adapter is registered for the reference type', async () => {
    await expect(new SourceRegistry().fetch('github:org/repo#1')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('lets a later registration replace an adapter', async () => {
    const stub = { type: 'github' as const, fetch: async () => ({ title: 'stubbed' }) as unknown as NormalizedTask };
    const registry = SourceRegistry.withDefaults(config(), {}, bothApis().fetch).register(stub);
    await expect(registry.fetch('github:org/repo#142')).resolves.toEqual({ title: 'stubbed' });
  });

  it('returns a local task contract as-is and compiles every other task', async () => {
    const seen: NormalizedTask[] = [];
    const compiled = parseContract(validContractInput());
    const registry = new SourceRegistry((task) => {
      seen.push(task);
      return { contract: compiled, notes: ['compiled'] };
    });
    const local = { sourceType: 'local', contract: parseContract(validContractInput()) } as NormalizedTask;
    await expect(registry.proposeContract(local, config(), REPO)).resolves.toEqual({ contract: local.contract, notes: [] });
    expect(seen).toEqual([]);

    const ticket = { sourceType: 'github', title: 't', body: '' } as unknown as NormalizedTask;
    await expect(registry.proposeContract(ticket, config(), REPO)).resolves.toEqual({ contract: compiled, notes: ['compiled'] });
    expect(seen).toEqual([ticket]);
  });

  it('uses compileContract by default', async () => {
    const task = await SourceRegistry.withDefaults(config(), {}, bothApis().fetch).fetch('github:org/repo#142');
    const { contract, notes } = await new SourceRegistry().proposeContract(task, config(), REPO);
    expect(contract.metadata.id).toBe('GH-142');
    expect(contract.spec.scope.writable).toEqual(['src/api/session.ts']);
    expect(notes[0]).toMatch(/untrusted ticket text/);
  });
});
