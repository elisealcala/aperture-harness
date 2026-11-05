import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseContract, parseUserConfig } from '../../contracts/src/index.ts';
import { createHarnessFixture, fixtureContract, prepareRun, type HarnessFixture, type PreparedRun } from '../../../tests/helpers/harness.ts';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { Harness } from './harness.ts';

const tmp = new TempDirs();
let p: PreparedRun | undefined;
let extra: Harness | undefined;
let fx: HarnessFixture | undefined;

afterEach(() => {
  fx?.harness.close();
  fx = undefined;
  extra?.close();
  extra = undefined;
  p?.fx.harness.close();
  p = undefined;
  tmp.cleanup();
});

describe('Harness extraHiddenPaths', () => {
  it('appends extraHiddenPaths to the sandbox hiddenPaths of createRunner', async () => {
    p = await prepareRun(tmp);
    const secretDir = tmp.make('aperture-secrets-');
    const hidden = [join(secretDir, '.env'), join(secretDir, 'other.env')];
    p.fx.harness.close();
    extra = new Harness({ config: parseUserConfig({}), storageDir: p.fx.storageDir, extraHiddenPaths: hidden });
    // The fixture's harness is already closed; avoid closing it twice.
    p.fx.harness = extra;
    extra = undefined;

    const withExtra = p.fx.harness.createRunner(p.fx.harness.getRun(p.run.runId)).effectivePolicy.hiddenPaths;
    expect(withExtra.slice(-hidden.length)).toEqual(hidden);
    expect(withExtra).toContain(join(p.fx.storageDir, 'runs'));
  });

  it('adds nothing beyond the defaults when extraHiddenPaths is omitted', async () => {
    p = await prepareRun(tmp);
    const base = p.fx.harness.createRunner(p.run).effectivePolicy.hiddenPaths;
    expect(base.at(-1)).toBe(join(p.fx.storageDir, 'runs'));
  });
});

describe('Harness.analyze egress policy (A1)', () => {
  const egressContract = () => fixtureContract({ mutate: (c) => void (c.spec.permissions = { network: { mode: 'allowlist', hosts: ['studio.example.workers.dev'] } }) });

  it('reports EGRESS_FORBIDDEN when config runtime.network is deny and refuses approval', async () => {
    fx = createHarnessFixture(tmp, egressContract(), { config: { runtime: { network: 'deny' } } });
    const codes = fx.harness.analyze(parseContract(egressContract())).map((f) => `${f.level}:${f.code}`);
    expect(codes).toEqual(expect.arrayContaining(['error:EGRESS_FORBIDDEN', 'warning:EGRESS_GRANTED']));

    const run = await fx.harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation: 'reduced', questionMode: 'noninteractive' });
    const proposed = fx.harness.events.list(run.runId, { types: ['contract.proposed'] })[0]!.payload.findings as Array<{ code: string }>;
    expect(proposed.map((f) => f.code)).toContain('EGRESS_FORBIDDEN');
    expect(() => fx!.harness.approvePending(run.runId, 'tester')).toThrow(expect.objectContaining({ code: 'CONTRACT_INVALID', message: expect.stringContaining('runtime.network is deny') }));
  });

  it('allows an allowlisting contract under the default runtime.network allowlist (warning only)', () => {
    fx = createHarnessFixture(tmp, egressContract());
    const findings = fx.harness.analyze(parseContract(egressContract()));
    expect(findings.filter((f) => f.level === 'error')).toEqual([]);
    expect(findings.map((f) => f.code)).toContain('EGRESS_GRANTED');
  });

  it('does not flag a deny-network contract even when config forbids egress', () => {
    fx = createHarnessFixture(tmp, fixtureContract(), { config: { runtime: { network: 'deny' } } });
    expect(fx.harness.analyze(parseContract(fixtureContract())).map((f) => f.code)).not.toContain('EGRESS_FORBIDDEN');
  });
});

describe('Harness worktree-mode runs (A1 guards do not apply)', () => {
  it('gives worktree runs no read-only paths and never checks their branch', async () => {
    p = await prepareRun(tmp);
    expect(p.run.workspace).toBe('worktree');
    expect(p.fx.harness.createRunner(p.run).effectivePolicy.readOnlyPaths).toBeUndefined();
    await expect(p.fx.harness.assertWorkspaceBranch({ ...p.run, branch: 'someone-else' })).resolves.toBeUndefined();
  });
});
