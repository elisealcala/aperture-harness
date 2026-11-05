/**
 * Amendment A1 §21.3: the default in-place workspace. AT-20 (work on the user's branch; `.git`
 * unwritable by checks), AT-21 (refusals before any change), AT-22 (branch switched mid-run), and
 * `cancel --cleanup` never deleting in-place work. Git remotes, GitHub and the model are faked.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelCommand } from '../../apps/cli/src/commands/lifecycle.ts';
import { parseUserConfig } from '../../packages/contracts/src/index.ts';
import { Harness, NonInteractive, Orchestrator, type IngestOptions } from '../../packages/core/src/index.ts';
import type { ToolOutcome } from '../../packages/gateway/src/index.ts';
import { ModelRegistry, ScriptedModelProvider, type ModelRequest } from '../../packages/models/src/index.ts';
import { PrWorkflow, type EvidencePacket } from '../../packages/pr/src/index.ts';
import { detectIsolation } from '../../packages/sandbox/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import { createHarnessFixture, fixtureContract, reopenHarness, type HarnessFixture } from '../helpers/harness.ts';
import { DONE, patchTurn, scriptedModel } from '../helpers/model.ts';
import { gitSync, SESSION_METADATA_PATCH, SESSION_TS, SESSION_TS_WITH_METADATA, setOriginHead, switchToUserBranch } from '../helpers/repo.ts';
import { createTicketFixture, driveTicket, FakePullRequestApi, FakePusher, ingestTicket, type TicketFixture } from '../helpers/tickets.ts';
import { TempDirs } from '../helpers/tmp.ts';

const BRANCH = 'feature/session-metadata';
const IN_PLACE = { runtime: { workspace: 'in-place' } };
const PATCH_INPUT = { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R1', 'R2'] };
const IMPLEMENT = () => scriptedModel([patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_meta'), DONE]);
const approve = () => new NonInteractive('alice', { approveContracts: true });
const seatbeltAvailable = detectIsolation() === 'macos-seatbelt';

const tmp = new TempDirs();
const harnesses: Harness[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) {
    try {
      h.close();
    } catch {
      // already closed
    }
  }
  tmp.cleanup();
});

/** Fixture harness configured for in-place runs, with `origin/HEAD -> main` like a fresh clone. */
function inPlaceFixture(contract = fixtureContract()): HarnessFixture {
  const fx = createHarnessFixture(tmp, contract, { config: IN_PLACE });
  harnesses.push(fx.harness);
  setOriginHead(fx.repo.path, 'main');
  return fx;
}

function ingest(fx: HarnessFixture, extra: IngestOptions = {}): Promise<RunRecord> {
  return fx.harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation: 'reduced', questionMode: 'noninteractive', ...extra });
}

/** Ingest -> approve -> prepare. */
async function prepareInPlace(fx: HarnessFixture, extra: IngestOptions = {}): Promise<RunRecord> {
  const run = await ingest(fx, extra);
  fx.harness.approvePending(run.runId, 'alice');
  fx.harness.transition(run.runId, 'PREPARING', 'contract approved');
  return fx.harness.prepare(run.runId);
}

function git(path: string, ...args: string[]): string {
  return gitSync(path, args).trim();
}

/** What the user would see in the clone (works with a detached HEAD too). */
function cloneState(path: string): { head: string; symbolic: string; status: string; refs: string; session: string } {
  return {
    head: git(path, 'rev-parse', 'HEAD'),
    symbolic: gitSync(path, ['symbolic-ref', '-q', 'HEAD']).trim(),
    status: gitSync(path, ['status', '--porcelain', '--untracked-files=all']),
    refs: git(path, 'for-each-ref', '--format=%(refname) %(objectname)'),
    session: readFileSync(join(path, 'src/api/session.ts'), 'utf8'),
  };
}

function cloneStateDetached(path: string): Omit<ReturnType<typeof cloneState>, 'symbolic'> {
  return { head: git(path, 'rev-parse', 'HEAD'), status: gitSync(path, ['status', '--porcelain', '--untracked-files=all']), refs: git(path, 'for-each-ref', '--format=%(refname) %(objectname)'), session: readFileSync(join(path, 'src/api/session.ts'), 'utf8') };
}

function asResult(outcome: ToolOutcome): Extract<ToolOutcome, { kind: 'result' }> {
  if (outcome.kind !== 'result') throw new Error(`expected a result outcome, got ${JSON.stringify(outcome)}`);
  return outcome;
}

// ---- AT-20 ------------------------------------------------------------------------------------

describe('AT-20: in-place run on a user branch', () => {
  let fx: HarnessFixture;
  let branchHead: string;

  beforeEach(() => {
    fx = inPlaceFixture();
    branchHead = switchToUserBranch(fx.repo.path, BRANCH, { rel: 'docs/notes.md', content: 'branch-only notes\n' });
  });

  it('records the current branch and HEAD as the baseline and works in the clone itself', async () => {
    const ingested = await ingest(fx);
    expect(ingested).toMatchObject({ workspace: 'in-place', worktreePath: null, branch: null });

    fx.harness.approvePending(ingested.runId, 'alice');
    fx.harness.transition(ingested.runId, 'PREPARING', 'contract approved');
    const run = await fx.harness.prepare(ingested.runId);
    expect(run).toMatchObject({ state: 'EXECUTING', workspace: 'in-place', worktreePath: fx.repo.path, branch: BRANCH, baselineSha: branchHead });
    expect(branchHead).not.toBe(fx.repo.headSha);

    const prepared = fx.harness.events.list(run.runId, { types: ['sandbox.prepared'] });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.payload).toMatchObject({ workspace: 'in-place', worktreePath: fx.repo.path, branch: BRANCH, baselineSha: branchHead });
    const baseline = JSON.parse(readFileSync(join(fx.harness.layout.runDir(run.runId), 'baseline.json'), 'utf8')) as Record<string, unknown>;
    expect(baseline).toMatchObject({ workspace: 'in-place', branch: BRANCH, baselineSha: branchHead });
    expect(baseline.files).toHaveProperty(['docs/notes.md']);

    // No worktree, no harness-created branch.
    expect(existsSync(fx.harness.layout.worktreeDir(run.runId))).toBe(false);
    expect(gitSync(fx.repo.path, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
    expect(git(fx.repo.path, 'branch', '--list', 'aperture/*')).toBe('');

    // Checks run in the clone with `.git` read-only.
    const policy = fx.harness.createRunner(run).effectivePolicy;
    expect(policy.worktreePath).toBe(fx.repo.path);
    expect(policy.readOnlyPaths).toEqual([join(fx.repo.path, '.git')]);
  });

  it('applies patches in the clone, verifies, and reaches READY_FOR_REVIEW without committing or switching', async () => {
    const run = await ingest(fx);
    const { executor } = IMPLEMENT();
    const orchestrator = new Orchestrator(fx.harness);
    const final = await orchestrator.drive(run.runId, { executor, interaction: approve() });

    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(readFileSync(join(fx.repo.path, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS_WITH_METADATA);
    expect(git(fx.repo.path, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(git(fx.repo.path, 'rev-parse', 'HEAD')).toBe(branchHead);
    expect(git(fx.repo.path, 'rev-parse', 'main')).toBe(fx.repo.headSha);
    expect(gitSync(fx.repo.path, ['status', '--porcelain', '--untracked-files=all'])).toBe(' M src/api/session.ts\n');

    expect(fx.harness.events.list(run.runId, { types: ['verification.completed'] }).at(-1)!.payload).toMatchObject({ result: 'PASS' });
    const checks = fx.harness.events.list(run.runId, { types: ['check.completed'] }).map((e) => `${String(e.payload.checkId)}:${String(e.payload.status)}`);
    expect(checks).toEqual(expect.arrayContaining(['unit:PASS', 'has-metadata:PASS']));

    // The review diff is the clone's diff against the branch HEAD (not against main).
    const diff = await fx.harness.worktrees.diff(fx.repo.path, branchHead);
    expect(diff).toContain('+  metadata?: Record<string, string>;');
    expect(diff).not.toContain('docs/notes.md');
    const reviewed = await orchestrator.approveReview(run.runId, 'alice', { acceptLocal: false });
    expect(reviewed.reviewDiffSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('AT-20: the PR is committed on and pushed from the user branch', () => {
  let tfx: TicketFixture;

  function draftFromEvidence(request: ModelRequest): { text: string; usage: { input: number; output: number } } {
    const packet = JSON.parse(String(request.messages[0]!.content).replace(/^Evidence \(JSON\):\n/, '')) as EvidencePacket;
    return {
      usage: { input: 2000, output: 300 },
      text: JSON.stringify({ title: 'Add optional session metadata', summary: 'Adds metadata.', changes: ['src/api/session.ts'], testing: packet.checks.map((c) => `${c.checkId}: ${c.status}`), risks: [], issueReference: packet.issueReference }),
    };
  }

  async function reviewedInPlace(): Promise<{ run: RunRecord; workflow: PrWorkflow; api: FakePullRequestApi; pusher: FakePusher; branchHead: string }> {
    tfx = createTicketFixture(tmp, { config: IN_PLACE });
    harnesses.push(tfx.harness);
    const branchHead = switchToUserBranch(tfx.repo.path, BRANCH);
    const ingested = await ingestTicket(tfx, 'github:org/repo#142');
    expect(ingested.workspace).toBe('in-place');
    const { final, orchestrator } = await driveTicket(tfx, ingested.runId);
    expect(final).toMatchObject({ state: 'READY_FOR_REVIEW', worktreePath: tfx.repo.path, branch: BRANCH });
    const run = await orchestrator.approveReview(final.runId, 'alice', { acceptLocal: false });
    const api = new FakePullRequestApi();
    const pusher = new FakePusher();
    const workflow = new PrWorkflow({ harness: tfx.harness, orchestrator, provider: new ScriptedModelProvider([draftFromEvidence]), registry: new ModelRegistry(), github: api, pusher });
    return { run, workflow, api, pusher, branchHead };
  }

  it('drafts for the user branch, commits there after approval, and pushes that branch', async () => {
    const { run, workflow, api, pusher, branchHead } = await reviewedInPlace();
    const draft = await workflow.draft(run.runId);
    expect(draft.branch).toBe(BRANCH);

    const result = await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    expect(result).toMatchObject({ existing: false, number: 101 });
    expect(pusher.pushes).toEqual([{ worktreePath: tfx.repo.path, branch: BRANCH }]);
    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]!.input.head).toBe(BRANCH);

    // One new commit on the user's branch, parented on the run's baseline; main is untouched.
    expect(git(tfx.repo.path, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(git(tfx.repo.path, 'rev-parse', 'HEAD~1')).toBe(branchHead);
    expect(git(tfx.repo.path, 'log', '-1', '--format=%B')).toContain(`Aperture-Run: ${run.runId}`);
    expect(git(tfx.repo.path, 'rev-parse', 'main')).toBe(tfx.repo.headSha);
    expect(gitSync(tfx.repo.path, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(tfx.harness.getRun(run.runId).state).toBe('PR_CREATED');
  });

  // ---- AT-22 (publish) ----------------------------------------------------------------------

  it('AT-22: refuses to publish after a branch switch, and publishes once the branch is back', async () => {
    const { run, workflow, api, pusher, branchHead } = await reviewedInPlace();
    await workflow.draft(run.runId);
    expect(tfx.harness.getRun(run.runId).state).toBe('PR_APPROVAL');

    // The uncommitted change carries over: session.ts is identical on main and the branch.
    gitSync(tfx.repo.path, ['switch', '-q', 'main']);
    await expect(workflow.publish(run.runId, { approved: true, actor: 'alice' })).rejects.toMatchObject({ code: 'IN_PLACE_BRANCH_CHANGED', message: expect.stringContaining(`git switch ${BRANCH}`) });
    expect(pusher.pushes).toEqual([]);
    expect(api.creates).toEqual([]);
    expect(git(tfx.repo.path, 'rev-parse', 'main')).toBe(tfx.repo.headSha);
    expect(git(tfx.repo.path, 'rev-parse', BRANCH)).toBe(branchHead);
    expect(tfx.harness.getRun(run.runId).state).toBe('PR_APPROVAL');
    expect(tfx.harness.store.getPublication(run.runId)).toBeUndefined();

    gitSync(tfx.repo.path, ['switch', '-q', BRANCH]);
    await expect(workflow.publish(run.runId, { approved: true, actor: 'alice' })).resolves.toMatchObject({ existing: false });
    expect(pusher.pushes).toEqual([{ worktreePath: tfx.repo.path, branch: BRANCH }]);
  });
});

describe.skipIf(!seatbeltAvailable)('AT-20: checks cannot write into <clone>/.git (macOS seatbelt)', () => {
  it('blocks writes under .git while the working tree stays writable', async () => {
    const contract = fixtureContract({
      extraCommands: {
        'write-git': { exec: 'node', args: ['-e', "const fs=require('node:fs');for(const p of ['.git/aperture-escape.txt','.git/hooks/pre-commit']){try{fs.writeFileSync(p,'#!/bin/sh\\n');console.log('wrote '+p)}catch(e){console.log('blocked '+p+' '+e.code)}}try{fs.appendFileSync('.git/config','[core]\\n\\thooksPath=/tmp\\n');console.log('wrote config')}catch(e){console.log('blocked config '+e.code)}"], timeoutSeconds: 30 },
        'write-tree': { exec: 'node', args: ['-e', "require('node:fs').writeFileSync('check-scratch.txt','ok');console.log('wrote tree')"], timeoutSeconds: 30 },
      },
      extraChecks: [
        { id: 'write-git', commandId: 'write-git', required: false },
        { id: 'write-tree', commandId: 'write-tree', required: false },
      ],
    });
    const fx = inPlaceFixture(contract);
    switchToUserBranch(fx.repo.path, BRANCH);
    const gitConfig = readFileSync(join(fx.repo.path, '.git/config'), 'utf8');
    const run = await prepareInPlace(fx, { isolation: 'required' });
    expect(fx.harness.isolationMode(run)).toBe('macos-seatbelt');
    const gateway = fx.harness.createGateway(run);

    const blocked = asResult(await gateway.execute({ id: 'check_git', name: 'run_check', input: { checkId: 'write-git' } }));
    expect(blocked.content).toContain('blocked .git/aperture-escape.txt EPERM');
    expect(blocked.content).toContain('blocked .git/hooks/pre-commit EPERM');
    expect(blocked.content).toContain('blocked config EPERM');
    expect(blocked.content).not.toMatch(/^wrote /m);
    expect(existsSync(join(fx.repo.path, '.git/aperture-escape.txt'))).toBe(false);
    expect(existsSync(join(fx.repo.path, '.git/hooks/pre-commit'))).toBe(false);
    expect(readFileSync(join(fx.repo.path, '.git/config'), 'utf8')).toBe(gitConfig);

    const tree = asResult(await gateway.execute({ id: 'check_tree', name: 'run_check', input: { checkId: 'write-tree' } }));
    expect(tree.content).toMatch(/^check write-tree: PASS/);
    expect(readFileSync(join(fx.repo.path, 'check-scratch.txt'), 'utf8')).toBe('ok');
  });
});

// ---- AT-21 ------------------------------------------------------------------------------------

describe('AT-21: in-place refused before any change', () => {
  let fx: HarnessFixture;

  beforeEach(() => {
    fx = inPlaceFixture();
  });

  async function expectIngestRefused(code: string, message?: RegExp): Promise<void> {
    await expect(ingest(fx)).rejects.toMatchObject({ name: 'HarnessError', code, ...(message ? { message: expect.stringMatching(message) } : {}) });
    expect(fx.harness.store.listRuns()).toEqual([]);
    expect(existsSync(join(fx.storageDir, 'runs'))).toBe(false);
  }

  it('refuses a detached HEAD', async () => {
    gitSync(fx.repo.path, ['switch', '-q', '--detach', 'HEAD']);
    const before = cloneStateDetached(fx.repo.path);
    await expectIngestRefused('IN_PLACE_DETACHED', /detached HEAD.*git switch -c/);
    expect(cloneStateDetached(fx.repo.path)).toEqual(before);
  });

  it('refuses the remote default branch (origin/HEAD)', async () => {
    const before = cloneState(fx.repo.path);
    await expectIngestRefused('IN_PLACE_BASE_BRANCH', /base branch main.*create and check out a branch/);
    expect(cloneState(fx.repo.path)).toEqual(before);
  });

  it('is the default workspace: a plain config refuses the base branch too', async () => {
    const harness = new Harness({ config: parseUserConfig({}), storageDir: tmp.make('aperture-storage-') });
    harnesses.push(harness);
    expect(harness.config.runtime.workspace).toBe('in-place');
    await expect(harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation: 'reduced' })).rejects.toMatchObject({ code: 'IN_PLACE_BASE_BRANCH' });
    expect(harness.store.listRuns()).toEqual([]);
  });

  it.each(['main', 'master'])('still refuses %s when no default branch is known (no origin/HEAD, no mapping)', async (name) => {
    gitSync(fx.repo.path, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    if (name !== 'main') gitSync(fx.repo.path, ['switch', '-q', '-c', name]);
    const before = cloneState(fx.repo.path);
    await expectIngestRefused('IN_PLACE_BASE_BRANCH', new RegExp(`base branch ${name}.*create and check out a branch`));
    expect(cloneState(fx.repo.path)).toEqual(before);
  });

  it('allows any other branch when no default branch is known (no origin/HEAD, no mapping)', async () => {
    gitSync(fx.repo.path, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    gitSync(fx.repo.path, ['switch', '-q', '-c', 'trunk']);
    const run = await ingest(fx);
    expect(run).toMatchObject({ state: 'NEEDS_CONTRACT_REVIEW', workspace: 'in-place' });
  });

  it.each([
    ['a modified tracked file', (repo: string) => writeFileSync(join(repo, 'README.md'), 'edited\n'), 'README.md'],
    ['a staged new file', (repo: string) => (writeFileSync(join(repo, 'staged.ts'), 'x\n'), gitSync(repo, ['add', 'staged.ts'])), 'staged.ts'],
    ['an untracked file', (repo: string) => writeFileSync(join(repo, 'src/api/scratch.ts'), 'x\n'), 'src/api/scratch.ts'],
    ['a deleted tracked file', (repo: string) => unlinkSync(join(repo, 'README.md')), 'README.md'],
  ])('refuses %s', async (_label, dirty, path) => {
    switchToUserBranch(fx.repo.path, BRANCH);
    dirty(fx.repo.path);
    const before = cloneState(fx.repo.path);
    await expectIngestRefused('IN_PLACE_DIRTY', new RegExp(`uncommitted changes \\(.*${path.replace(/[.]/g, '\\.')}`));
    expect(cloneState(fx.repo.path)).toEqual(before);
  });

  it('accepts git-ignored files (installed dependencies stay in place)', async () => {
    switchToUserBranch(fx.repo.path, BRANCH, { rel: '.gitignore', content: 'node_modules/\n' });
    mkdirSync(join(fx.repo.path, 'node_modules/dep'), { recursive: true });
    writeFileSync(join(fx.repo.path, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
    await expect(ingest(fx)).resolves.toMatchObject({ workspace: 'in-place' });
  });

  it('refuses a second in-place run while another one holds the clone, and allows it after cancel', async () => {
    switchToUserBranch(fx.repo.path, BRANCH);
    const first = await prepareInPlace(fx);
    expect(first.state).toBe('EXECUTING');
    const before = cloneState(fx.repo.path);

    await expect(ingest(fx)).rejects.toMatchObject({ code: 'IN_PLACE_BUSY', message: expect.stringContaining(first.runId) });
    expect(fx.harness.store.listRuns().map((r) => r.runId)).toEqual([first.runId]);
    expect(cloneState(fx.repo.path)).toEqual(before);

    fx.harness.transition(first.runId, 'CANCELED', 'test');
    await expect(ingest(fx)).resolves.toMatchObject({ state: 'NEEDS_CONTRACT_REVIEW' });
  });

  it('a worktree run does not hold the clone', async () => {
    switchToUserBranch(fx.repo.path, BRANCH);
    const wt = await prepareInPlace(fx, { workspace: 'worktree' });
    expect(wt.worktreePath).not.toBe(fx.repo.path);
    await expect(ingest(fx)).resolves.toMatchObject({ workspace: 'in-place' });
  });

  it('re-checks at prepare: a second ingested run cannot prepare while the first holds the clone', async () => {
    switchToUserBranch(fx.repo.path, BRANCH);
    const a = await ingest(fx);
    const b = await ingest(fx);
    fx.harness.approvePending(a.runId, 'alice');
    fx.harness.transition(a.runId, 'PREPARING', 'approved');
    await fx.harness.prepare(a.runId);
    fx.harness.approvePending(b.runId, 'alice');
    fx.harness.transition(b.runId, 'PREPARING', 'approved');
    await expect(fx.harness.prepare(b.runId)).rejects.toMatchObject({ code: 'IN_PLACE_BUSY' });
    expect(fx.harness.getRun(b.runId)).toMatchObject({ state: 'FAILED', worktreePath: null, terminalReason: expect.stringMatching(/^in-place workspace refused: run .* is still active/) });
    expect(fx.harness.getRun(a.runId).state).toBe('EXECUTING');
  });

  it('re-checks at prepare: changes made after ingest fail the run without touching them', async () => {
    switchToUserBranch(fx.repo.path, BRANCH);
    const run = await ingest(fx);
    fx.harness.approvePending(run.runId, 'alice');
    fx.harness.transition(run.runId, 'PREPARING', 'approved');
    writeFileSync(join(fx.repo.path, 'src/api/session.ts'), `${SESSION_TS}// user edit\n`);
    await expect(fx.harness.prepare(run.runId)).rejects.toMatchObject({ code: 'IN_PLACE_DIRTY' });
    expect(fx.harness.getRun(run.runId)).toMatchObject({ state: 'FAILED', worktreePath: null, baselineSha: null });
    expect(readFileSync(join(fx.repo.path, 'src/api/session.ts'), 'utf8')).toBe(`${SESSION_TS}// user edit\n`);
  });

  it('leaves worktree mode unaffected by a dirty checkout on the base branch', async () => {
    writeFileSync(join(fx.repo.path, 'README.md'), 'edited\n');
    const run = await prepareInPlace(fx, { workspace: 'worktree' });
    expect(run).toMatchObject({ state: 'EXECUTING', workspace: 'worktree', branch: expect.stringMatching(/^aperture\//) });
    expect(run.worktreePath!.startsWith(fx.storageDir)).toBe(true);
  });
});

describe('AT-21: base branch from the repository mapping', () => {
  it('refuses the configured baseBranch even without origin/HEAD', async () => {
    const tfx = createTicketFixture(tmp, { config: { ...IN_PLACE, repositories: { 'org/repo': { path: '/unused', baseBranch: 'release' } } } });
    harnesses.push(tfx.harness);
    gitSync(tfx.repo.path, ['switch', '-q', '-c', 'release']);
    await expect(ingestTicket(tfx, 'github:org/repo#142')).rejects.toMatchObject({ code: 'IN_PLACE_BASE_BRANCH', message: expect.stringContaining('base branch release') });
    expect(tfx.harness.store.listRuns()).toEqual([]);
    expect(tfx.fetch.calls.length).toBeGreaterThan(0);

    gitSync(tfx.repo.path, ['switch', '-q', '-c', BRANCH]);
    await expect(ingestTicket(tfx, 'github:org/repo#142')).resolves.toMatchObject({ workspace: 'in-place' });
  });
});

// ---- AT-22 (resume) ---------------------------------------------------------------------------

describe('AT-22: branch switched mid-run', () => {
  let fx: HarnessFixture;
  let run: RunRecord;

  beforeEach(async () => {
    fx = inPlaceFixture();
    switchToUserBranch(fx.repo.path, BRANCH);
    run = await prepareInPlace(fx);
  });

  it.each([
    ['another branch', (repo: string) => gitSync(repo, ['switch', '-q', '-c', 'other-work']), 'other-work checked out'],
    ['the base branch', (repo: string) => gitSync(repo, ['switch', '-q', 'main']), 'main checked out'],
    ['a detached HEAD', (repo: string) => gitSync(repo, ['switch', '-q', '--detach', 'HEAD']), 'a detached HEAD checked out'],
  ])('refuses to resume on %s, then resumes after switching back', async (_label, switchAway, has) => {
    switchAway(fx.repo.path);
    const harness = reopenHarness(fx);
    harnesses.push(harness);
    const { provider, executor } = IMPLEMENT();
    await expect(new Orchestrator(harness).resume(run.runId, { executor, interaction: approve() })).rejects.toMatchObject({
      name: 'HarnessError',
      code: 'IN_PLACE_BRANCH_CHANGED',
      message: expect.stringContaining(`works on branch ${BRANCH}, but ${fx.repo.path} has ${has}`),
    });
    expect(provider.requests).toHaveLength(0);
    expect(harness.events.list(run.runId, { types: ['run.resumed'] })).toEqual([]);
    expect(harness.getRun(run.runId).state).toBe('EXECUTING');
    expect(readFileSync(join(fx.repo.path, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS);

    gitSync(fx.repo.path, ['switch', '-q', BRANCH]);
    const final = await new Orchestrator(harness).resume(run.runId, { executor, interaction: approve() });
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(harness.events.list(run.runId, { types: ['run.resumed'] })).toHaveLength(1);
    expect(git(fx.repo.path, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(readFileSync(join(fx.repo.path, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS_WITH_METADATA);
  });

  it('assertWorkspaceBranch passes while the run branch is checked out', async () => {
    await expect(fx.harness.assertWorkspaceBranch(fx.harness.getRun(run.runId))).resolves.toBeUndefined();
  });
});

// ---- cancel --cleanup -------------------------------------------------------------------------

describe('cancel --cleanup', () => {
  let stdout: string[];

  beforeEach(() => {
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  function globals(fx: HarnessFixture): { home: string; config: string } {
    return { home: fx.storageDir, config: join(fx.root, 'no-config.yaml') };
  }

  it('never deletes the in-place branch or the work in the clone', async () => {
    const fx = inPlaceFixture();
    const branchHead = switchToUserBranch(fx.repo.path, BRANCH);
    const run = await prepareInPlace(fx);
    expect(asResult(await fx.harness.createGateway(run).execute({ id: 'toolu_patch', name: 'propose_patch', input: PATCH_INPUT })).isError).toBe(false);
    const before = cloneState(fx.repo.path);
    fx.harness.close();

    expect(await cancelCommand(run.runId, { cleanup: true }, globals(fx))).toBe(0);
    expect(stdout.join('')).toContain(`run ${run.runId} canceled (in-place run: your branch ${BRANCH} and working tree were left as they are)`);

    expect(cloneState(fx.repo.path)).toEqual(before);
    expect(git(fx.repo.path, 'rev-parse', BRANCH)).toBe(branchHead);
    expect(readFileSync(join(fx.repo.path, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS_WITH_METADATA);
    expect(existsSync(join(fx.repo.path, '.git/HEAD'))).toBe(true);

    const harness = new Harness({ ...fx.harnessOptions, storageDir: fx.storageDir });
    harnesses.push(harness);
    expect(harness.getRun(run.runId).state).toBe('CANCELED');
    expect(harness.store.activeInPlaceRuns(fx.repo.path)).toEqual([]);
  });

  it('still removes a worktree run and its aperture branch', async () => {
    const fx = inPlaceFixture();
    switchToUserBranch(fx.repo.path, BRANCH);
    const run = await prepareInPlace(fx, { workspace: 'worktree' });
    expect(existsSync(run.worktreePath!)).toBe(true);
    fx.harness.close();

    expect(await cancelCommand(run.runId, { cleanup: true }, globals(fx))).toBe(0);
    expect(stdout.join('')).toContain(`run ${run.runId} canceled and worktree removed`);
    expect(existsSync(run.worktreePath!)).toBe(false);
    expect(git(fx.repo.path, 'branch', '--list', run.branch!)).toBe('');
    expect(git(fx.repo.path, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
  });
});
