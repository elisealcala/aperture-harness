import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolGateway, ToolOutcome } from '../../packages/gateway/src/index.ts';
import { detectIsolation } from '../../packages/sandbox/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import { createHarnessFixture, fixtureContract, type HarnessFixture } from '../helpers/harness.ts';
import { PACKAGE_JSON, SESSION_METADATA_PATCH, SESSION_TS } from '../helpers/repo.ts';
import { TempDirs } from '../helpers/tmp.ts';

type ResultOutcome = Extract<ToolOutcome, { kind: 'result' }>;

function asResult(outcome: ToolOutcome): ResultOutcome {
  if (outcome.kind !== 'result') throw new Error(`expected a result outcome, got ${JSON.stringify(outcome)}`);
  return outcome;
}

interface PreparedRun {
  fx: HarnessFixture;
  run: RunRecord;
  worktree: string;
  gateway: ToolGateway;
}

/** Ingest -> approve -> prepare, returning a gateway bound to the EXECUTING run. */
async function prepareRun(tmp: TempDirs, isolation: 'reduced' | 'required', contract = fixtureContract()): Promise<PreparedRun> {
  const fx = createHarnessFixture(tmp, contract);
  const ingested = await fx.harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation, questionMode: 'noninteractive' });
  expect(ingested.state).toBe('NEEDS_CONTRACT_REVIEW');
  fx.harness.approvePending(ingested.runId, 'integration-test');
  fx.harness.transition(ingested.runId, 'PREPARING', 'contract approved');
  const run = await fx.harness.prepare(ingested.runId);
  expect(run.state).toBe('EXECUTING');
  expect(run.worktreePath).toBeTruthy();
  return { fx, run, worktree: run.worktreePath!, gateway: fx.harness.createGateway(run) };
}

function eventTypes(fx: HarnessFixture, runId: string): string[] {
  return fx.harness.events.list(runId).map((e) => e.type);
}

describe('ToolGateway against a real worktree (reduced isolation)', () => {
  const tmp = new TempDirs();
  let p: PreparedRun;

  beforeEach(async () => {
    p = await prepareRun(tmp, 'reduced');
  });

  afterEach(() => {
    p.fx.harness.close();
    tmp.cleanup();
  });

  it('prepares an isolated worktree at the baseline commit', () => {
    expect(p.run.baselineSha).toBe(p.fx.repo.headSha);
    expect(p.worktree.startsWith(p.fx.storageDir)).toBe(true);
    expect(readFileSync(join(p.worktree, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS);
    const prepared = p.fx.harness.events.list(p.run.runId, { types: ['sandbox.prepared'] });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.payload).toMatchObject({ isolation: 'reduced', baselineSha: p.fx.repo.headSha });
  });

  describe('read_file', () => {
    it('returns numbered lines for a file within the readable scope', async () => {
      const out = asResult(await p.gateway.execute({ id: 'read_1', name: 'read_file', input: { path: 'src/api/session.ts', startLine: 2, endLine: 3 } }));
      expect(out.isError).toBe(false);
      expect(out.content).toBe('src/api/session.ts (lines 2-3 of 8)\n2\texport interface SessionInput {\n3\t  userId: string;');
      expect(p.fx.harness.store.getToolOp('read_1')).toMatchObject({ tool: 'read_file', status: 'completed' });
      expect(eventTypes(p.fx, p.run.runId).slice(-3)).toEqual(['tool.requested', 'tool.approved', 'tool.completed']);
    });

    it.each([
      ['package.json', 'PATH_DENIED'],
      ['PACKAGE.JSON', 'PATH_DENIED'],
      ['src/secrets/key.ts', 'PATH_DENIED'],
      ['README.md', 'PATH_NOT_READABLE'],
      ['../repo/package.json', 'PATH_TRAVERSAL'],
      ['.git/config', 'PATH_DENIED'],
      ['src/api/missing.ts', 'NOT_FOUND'],
    ])('rejects reading %j with %s', async (path, reasonCode) => {
      const out = asResult(await p.gateway.execute({ id: 'read_bad', name: 'read_file', input: { path } }));
      expect(out).toMatchObject({ isError: true, reasonCode });
      expect(out.content).not.toContain('aperture-fixture');
      const rejected = p.fx.harness.events.list(p.run.runId, { types: ['tool.rejected'] });
      expect(rejected.at(-1)?.payload).toMatchObject({ toolCallId: 'read_bad', name: 'read_file', reasonCode });
      expect(p.fx.harness.store.getToolOp('read_bad')?.status).toBe('rejected');
    });
  });

  describe('search_code', () => {
    it('only returns matches inside the readable, non-denied scope', async () => {
      const out = asResult(await p.gateway.execute({ id: 'search_1', name: 'search_code', input: { pattern: 'SESSION_MARKER' } }));
      expect(out.isError).toBe(false);
      // SESSION_MARKER also occurs in package.json (denied), src/secrets/key.ts (denied) and README.md (not readable).
      expect(out.content).toBe('src/api/session.ts:1:// SESSION_MARKER: session endpoint');
    });

    it('rejects a denied `within` root', async () => {
      const out = asResult(await p.gateway.execute({ id: 'search_2', name: 'search_code', input: { pattern: 'name', within: ['package.json'] } }));
      expect(out).toMatchObject({ isError: true, reasonCode: 'PATH_DENIED' });
    });

    it('rejects a traversal `within` root', async () => {
      const out = asResult(await p.gateway.execute({ id: 'search_3', name: 'search_code', input: { pattern: 'x', within: ['../'] } }));
      expect(out).toMatchObject({ isError: true, reasonCode: 'PATH_TRAVERSAL' });
    });

    it('filters out non-readable results even when `within` names an out-of-scope file', async () => {
      const out = asResult(await p.gateway.execute({ id: 'search_4', name: 'search_code', input: { pattern: 'SESSION_MARKER', within: ['README.md'] } }));
      expect(out).toMatchObject({ isError: false, content: 'no matches in the readable scope' });
      expect(p.fx.harness.events.list(p.run.runId, { types: ['tool.completed'] }).at(-1)?.payload).toMatchObject({ matches: 0, filtered: 1 });
    });
  });

  describe('propose_patch', () => {
    it('applies a permitted patch to the worktree and records it as applied', async () => {
      const out = asResult(await p.gateway.execute({ id: 'patch_1', name: 'propose_patch', input: { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R1'] } }));
      expect(out).toMatchObject({ isError: false, content: 'applied patch to src/api/session.ts (+2 -1) for R1' });

      const after = readFileSync(join(p.worktree, 'src/api/session.ts'), 'utf8');
      expect(after).toContain('  metadata?: Record<string, string>;\n');
      expect(after).toContain('return { userId: input.userId, metadata: input.metadata };');

      const op = p.fx.harness.store.getToolOp('patch_1');
      expect(op).toMatchObject({ tool: 'propose_patch', status: 'applied' });
      expect(JSON.parse(op!.inputJson)).toMatchObject({ path: 'src/api/session.ts', requirementIds: ['R1'], canonicalPatch: expect.stringContaining('diff --git a/src/api/session.ts') });
      expect(p.fx.harness.getRun(p.run.runId).patchAttempts).toBe(1);

      const diff = await p.fx.harness.worktrees.diff(p.worktree, p.run.baselineSha!, ['src/api/session.ts']);
      expect(diff).toContain('+  metadata?: Record<string, string>;');
      // The user's checkout is untouched.
      expect(readFileSync(join(p.fx.repo.path, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS);
      expect(readFileSync(join(p.worktree, 'package.json'), 'utf8')).toBe(PACKAGE_JSON);
    });

    // BUG (gateway.ts applyCanonicalPatch): `git apply --intent-to-add` is passed for every patch.
    // With git 2.50.1 (Apple Git-155) applying a *modification* that way rewrites the worktree index
    // to hold only the patched path, so every other tracked file shows up as deleted against the
    // baseline. Left failing on purpose: the outcome depends on the installed git version.
    it('leaves the rest of the worktree index intact (only the patched file differs from baseline)', async () => {
      await p.gateway.execute({ id: 'patch_1', name: 'propose_patch', input: { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R1'] } });
      const changes = await p.fx.harness.worktrees.nameStatus(p.worktree, p.run.baselineSha!);
      expect(changes).toEqual([{ status: 'M', path: 'src/api/session.ts' }]);
    });

    it('returns the recorded result for a re-delivered tool call id without re-applying', async () => {
      const call = { id: 'patch_1', name: 'propose_patch', input: { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R1'] } };
      const first = await p.gateway.execute(call);
      const contentAfterFirst = readFileSync(join(p.worktree, 'src/api/session.ts'), 'utf8');
      const eventCount = p.fx.harness.events.lastSequence(p.run.runId);

      // A fresh gateway (as after a restart) must also honour the recorded operation.
      const second = await p.fx.harness.createGateway(p.fx.harness.getRun(p.run.runId)).execute(call);

      expect(second).toEqual(first);
      expect(readFileSync(join(p.worktree, 'src/api/session.ts'), 'utf8')).toBe(contentAfterFirst);
      expect(p.fx.harness.getRun(p.run.runId).patchAttempts).toBe(1);
      expect(p.fx.harness.events.lastSequence(p.run.runId)).toBe(eventCount);
      expect(p.fx.harness.store.toolOpsForRun(p.run.runId).filter((o) => o.opId === 'patch_1')).toHaveLength(1);
    });

    it('rejects a patch to a denied file before mutating anything', async () => {
      const diff = ['--- a/package.json', '+++ b/package.json', '@@ -1 +1 @@', '-{', '+{ "evil": true,', ''].join('\n');
      const out = asResult(await p.gateway.execute({ id: 'patch_bad', name: 'propose_patch', input: { path: 'package.json', unifiedDiff: diff, requirementIds: ['R1'] } }));
      expect(out).toMatchObject({ isError: true, reasonCode: 'PATH_DENIED' });
      expect(readFileSync(join(p.worktree, 'package.json'), 'utf8')).toBe(PACKAGE_JSON);
      expect(p.fx.harness.getRun(p.run.runId).patchAttempts).toBe(0);
    });

    it('rejects unknown requirement ids', async () => {
      const out = asResult(await p.gateway.execute({ id: 'patch_req', name: 'propose_patch', input: { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R99'] } }));
      expect(out).toMatchObject({ isError: true, reasonCode: 'UNKNOWN_REQUIREMENT' });
      expect(readFileSync(join(p.worktree, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS);
    });

    it('records a stale patch as failed with PATCH_DOES_NOT_APPLY', async () => {
      const stale = SESSION_METADATA_PATCH.replaceAll('userId: string;', 'accountId: string;');
      const out = asResult(await p.gateway.execute({ id: 'patch_stale', name: 'propose_patch', input: { path: 'src/api/session.ts', unifiedDiff: stale, requirementIds: ['R1'] } }));
      expect(out).toMatchObject({ isError: true, reasonCode: 'PATCH_DOES_NOT_APPLY' });
      expect(p.fx.harness.store.getToolOp('patch_stale')?.status).toBe('failed');
      expect(readFileSync(join(p.worktree, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS);
    });
  });

  describe('run_check', () => {
    it('reports FAIL then PASS for a declared check, with a log artifact each time', async () => {
      const failed = asResult(await p.gateway.execute({ id: 'check_1', name: 'run_check', input: { checkId: 'has-metadata' } }));
      expect(failed.isError).toBe(true);
      expect(failed.content).toMatch(/^check has-metadata: FAIL \(exit 1, \d+ms\)/);
      expect(failed.content).toContain('metadata field missing from SessionInput');

      await p.gateway.execute({ id: 'patch_1', name: 'propose_patch', input: { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R1'] } });

      const passed = asResult(await p.gateway.execute({ id: 'check_2', name: 'run_check', input: { checkId: 'has-metadata' } }));
      expect(passed.isError).toBe(false);
      expect(passed.content).toMatch(/^check has-metadata: PASS \(exit 0, \d+ms\)/);

      const rows = p.fx.harness.store.checksForRun(p.run.runId);
      expect(rows.map((r) => [r.checkId, r.status, r.exitCode, r.attempt])).toEqual([
        ['has-metadata', 'FAIL', 1, 0],
        ['has-metadata', 'PASS', 0, 0],
      ]);
      for (const row of rows) {
        expect(row.artifactPath).toBeTruthy();
        expect(row.artifactPath!.startsWith(join(p.fx.storageDir, 'runs', p.run.runId, 'checks'))).toBe(true);
        expect(readFileSync(row.artifactPath!, 'utf8')).toMatch(/^\$ node test\/check-metadata\.mjs\n/);
      }
      const completed = p.fx.harness.events.list(p.run.runId, { types: ['check.completed'] }).map((e) => e.payload.status);
      expect(completed).toEqual(['FAIL', 'PASS']);
    });

    it('runs the passing node test check', async () => {
      const out = asResult(await p.gateway.execute({ id: 'check_unit', name: 'run_check', input: { checkId: 'unit' } }));
      expect(out.isError).toBe(false);
      expect(out.content).toMatch(/^check unit: PASS/);
      const started = p.fx.harness.events.list(p.run.runId, { types: ['check.started'] }).at(-1)?.payload;
      expect(started).toMatchObject({ checkId: 'unit', exec: 'node', args: ['--test', 'test/session.test.mjs'], isolation: 'reduced' });
    });

    it('rejects an undeclared checkId without running anything', async () => {
      const out = asResult(await p.gateway.execute({ id: 'check_bad', name: 'run_check', input: { checkId: 'npm-install' } }));
      expect(out).toMatchObject({ isError: true, reasonCode: 'UNKNOWN_CHECK' });
      expect(out.content).toContain('declared checks: unit, has-metadata');
      expect(p.fx.harness.store.checksForRun(p.run.runId)).toEqual([]);
      expect(existsSync(join(p.fx.storageDir, 'runs', p.run.runId, 'checks'))).toBe(false);
    });
  });

  describe('protocol errors', () => {
    it('rejects unknown tools and invalid input with a logged event', async () => {
      const unknown = asResult(await p.gateway.execute({ id: 'bad_1', name: 'shell', input: { command: 'cat ~/.ssh/id_rsa' } }));
      expect(unknown).toMatchObject({ isError: true, reasonCode: 'UNKNOWN_TOOL' });
      const invalid = asResult(await p.gateway.execute({ id: 'bad_2', name: 'run_check', input: { command: 'npm test' } }));
      expect(invalid).toMatchObject({ isError: true, reasonCode: 'INVALID_INPUT' });
      const rejected = p.fx.harness.events.list(p.run.runId, { types: ['tool.rejected'] }).map((e) => e.payload.reasonCode);
      expect(rejected).toEqual(['UNKNOWN_TOOL', 'INVALID_INPUT']);
    });

    // BUG (tools.ts parseToolRequest): a tool named after an Object.prototype member throws a
    // TypeError out of ToolGateway.execute instead of being rejected as UNKNOWN_TOOL.
    it('rejects a tool named "constructor" as UNKNOWN_TOOL instead of throwing', async () => {
      const out = asResult(await p.gateway.execute({ id: 'bad_3', name: 'constructor', input: {} }));
      expect(out).toMatchObject({ isError: true, reasonCode: 'UNKNOWN_TOOL' });
    });
  });
});

const seatbeltAvailable = detectIsolation() === 'macos-seatbelt';

describe.skipIf(!seatbeltAvailable)('ToolGateway with the macOS seatbelt sandbox', () => {
  const tmp = new TempDirs();
  let p: PreparedRun;
  let outsideTarget: string;

  beforeEach(async () => {
    outsideTarget = join(tmp.make('aperture-outside-'), 'escaped.txt');
    const contract = fixtureContract({
      extraCommands: {
        'write-outside': { exec: 'node', args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'escaped')", outsideTarget], timeoutSeconds: 30 },
      },
      extraChecks: [{ id: 'write-outside', commandId: 'write-outside', required: false }],
    });
    p = await prepareRun(tmp, 'required', contract);
  });

  afterEach(() => {
    p.fx.harness.close();
    tmp.cleanup();
  });

  it('resolves required isolation to macos-seatbelt', () => {
    expect(p.fx.harness.isolationMode(p.run)).toBe('macos-seatbelt');
  });

  it('reads, patches and runs checks inside the sandbox', async () => {
    expect(asResult(await p.gateway.execute({ id: 'read_1', name: 'read_file', input: { path: 'src/api/session.ts' } })).isError).toBe(false);
    expect(asResult(await p.gateway.execute({ id: 'patch_1', name: 'propose_patch', input: { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R1'] } })).isError).toBe(false);

    const unit = asResult(await p.gateway.execute({ id: 'check_1', name: 'run_check', input: { checkId: 'unit' } }));
    expect(unit.content).toMatch(/^check unit: PASS/);
    const meta = asResult(await p.gateway.execute({ id: 'check_2', name: 'run_check', input: { checkId: 'has-metadata' } }));
    expect(meta.content).toMatch(/^check has-metadata: PASS/);

    const started = p.fx.harness.events.list(p.run.runId, { types: ['check.started'] }).map((e) => e.payload.isolation);
    expect(started).toEqual(['macos-seatbelt', 'macos-seatbelt']);
  });

  it('blocks a check command from writing outside the worktree', async () => {
    const out = asResult(await p.gateway.execute({ id: 'check_escape', name: 'run_check', input: { checkId: 'write-outside' } }));
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/^check write-outside: FAIL/);
    expect(out.content).toMatch(/EPERM|operation not permitted/i);
    expect(existsSync(outsideTarget)).toBe(false);
  });
});
