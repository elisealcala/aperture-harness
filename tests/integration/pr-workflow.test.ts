/**
 * Stage 4 PR workflow on a reviewed GitHub-issue run: Haiku drafting from verified evidence with
 * its own budget (AT-12), no push or PR POST without approval (AT-13), idempotent publication and
 * existing-PR lookup (AT-14), plus invalidation when the diff or the remote changes.
 * GitHub, the model and `git push` are all faked; the commit is made in a real worktree.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Orchestrator } from '../../packages/core/src/index.ts';
import { computeCost, ModelRegistry, ScriptedModelProvider, type ModelRequest, type ScriptedResponder } from '../../packages/models/src/index.ts';
import { PR_DRAFT_JSON_SCHEMA, PrWorkflow, type EvidencePacket } from '../../packages/pr/src/index.ts';
import { SourceError } from '../../packages/sources/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { gitSync } from '../helpers/repo.ts';
import { createTicketFixture, driveTicket, FakePullRequestApi, FakePusher, ingestTicket, pullRequest, type TicketFixture } from '../helpers/tickets.ts';
import { TempDirs } from '../helpers/tmp.ts';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const registry = new ModelRegistry();

const tmp = new TempDirs();
let fx: TicketFixture;

afterEach(() => {
  fx.harness.close();
  tmp.cleanup();
});

function evidenceOf(request: ModelRequest): EvidencePacket {
  return JSON.parse(String(request.messages[0]!.content).replace(/^Evidence \(JSON\):\n/, '')) as EvidencePacket;
}

/** Haiku stand-in: a valid draft built from the evidence it was given. */
function draftFromEvidence(request: ModelRequest): { text: string; usage: { input: number; output: number } } {
  const packet = evidenceOf(request);
  return {
    usage: { input: 2400, output: 350 },
    text: JSON.stringify({
      title: 'Add optional session metadata',
      summary: 'Sessions accept an optional metadata field that is forwarded unchanged.',
      changes: packet.changedFiles.map((f) => `${f.path}: add optional metadata`),
      testing: packet.checks.map((c) => `${c.checkId}: ${c.status}`),
      risks: [],
      issueReference: packet.issueReference,
    }),
  };
}

interface Reviewed {
  run: RunRecord;
  orchestrator: Orchestrator;
  prModel: ScriptedModelProvider;
  api: FakePullRequestApi;
  pusher: FakePusher;
  workflow: PrWorkflow;
}

/** github:org/repo#142 → approved → implemented → verified → review approved (not accepted locally). */
async function reviewedRun(prTurns: ScriptedResponder[] = [draftFromEvidence], options: { origin?: string; config?: Record<string, unknown> } = {}): Promise<Reviewed> {
  fx = createTicketFixture(tmp, { ...(options.origin ? { origin: options.origin } : {}), ...(options.config ? { config: options.config } : {}) });
  const ingested = await ingestTicket(fx, 'github:org/repo#142');
  const { final, orchestrator } = await driveTicket(fx, ingested.runId);
  expect(final.state).toBe('READY_FOR_REVIEW');
  const run = await orchestrator.approveReview(final.runId, 'alice', { acceptLocal: false });
  expect(run).toMatchObject({ state: 'READY_FOR_REVIEW', reviewDiffSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const prModel = new ScriptedModelProvider(prTurns);
  const api = new FakePullRequestApi();
  const pusher = new FakePusher();
  const workflow = new PrWorkflow({ harness: fx.harness, orchestrator, provider: prModel, registry, github: api, pusher });
  return { run, orchestrator, prModel, api, pusher, workflow };
}

function transitions(runId: string): string[] {
  return fx.harness.events.list(runId, { types: ['state.changed'] }).map((e) => `${String(e.payload.from)}->${String(e.payload.to)}`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function head(worktree: string): string {
  return gitSync(worktree, ['rev-parse', 'HEAD']).trim();
}

function touch(worktree: string): void {
  const path = join(worktree, 'src/api/session.ts');
  writeFileSync(path, `${readFileSync(path, 'utf8')}// edited after review\n`);
}

describe('AT-12: Haiku PR draft', () => {
  it('drafts with claude-haiku-5-5 from the evidence packet and moves to PR_APPROVAL', async () => {
    const { run, prModel, workflow } = await reviewedRun();
    const stored = await workflow.draft(run.runId);

    expect(prModel.requests).toHaveLength(1);
    const request = prModel.requests[0]!;
    expect(request).toMatchObject({ modelId: HAIKU, tools: [], outputSchema: PR_DRAFT_JSON_SCHEMA });
    const packet = evidenceOf(request);
    expect(packet).toMatchObject({
      runId: run.runId,
      sourceRef: 'github:org/repo#142',
      issueReference: 'Closes #142',
      repository: 'org/repo',
      checks: [{ checkId: 'unit', required: true, status: 'PASS' }],
      changedFiles: [{ path: 'src/api/session.ts', status: 'M', added: 2, removed: 1 }],
      verificationResult: 'PASS',
      implementationModel: SONNET,
      exceptions: [],
    });
    expect(packet.diffExcerpt).toContain('+  metadata?: Record<string, string>;');

    expect(stored).toMatchObject({
      runId: run.runId,
      repository: 'org/repo',
      branch: run.branch,
      base: 'main',
      title: 'Add optional session metadata',
      modelId: HAIKU,
      fallback: false,
      problems: [],
      diffSha256: run.reviewDiffSha256,
      draftPr: false,
    });
    expect(transitions(run.runId).slice(-2)).toEqual(['READY_FOR_REVIEW->PR_DRAFTING', 'PR_DRAFTING->PR_APPROVAL']);
    expect(fx.harness.getRun(run.runId).state).toBe('PR_APPROVAL');
    expect(fx.harness.events.list(run.runId, { types: ['pr.draft.created'] })[0]?.payload).toMatchObject({ modelId: HAIKU, fallback: false });
    expect(fx.harness.events.list(run.runId, { types: ['pr.approval.requested'] })[0]?.payload).toEqual({ repository: 'org/repo', branch: run.branch, base: 'main', title: stored.title, draftPr: false });

    const path = join(fx.harness.layout.runDir(run.runId), 'pr-draft.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(stored);
    expect(workflow.loadDraft(run.runId)).toEqual(stored);
  });

  it('cites only checks that actually ran, with their real status', async () => {
    const { run, workflow } = await reviewedRun();
    const { body } = await workflow.draft(run.runId);
    expect(body).toContain('## Testing\n- unit: PASS\n');
    const checkRows = body.split('\n').filter((l) => /^\| \S+ \| (yes|no) \|/.test(l));
    expect(checkRows).toEqual(['| unit | yes | PASS |']);
    expect(body).toContain('\nCloses #142\n');
    expect(body).toContain(`description ${HAIKU}`);
  });

  it('records PR usage under pr_draft, separate from implementation', async () => {
    const { run, workflow } = await reviewedRun();
    const implementationBefore = fx.harness.store.spentUsd(run.runId, 'implementation');
    await workflow.draft(run.runId);

    const rows = fx.harness.store.usageForRun(run.runId);
    const prRows = rows.filter((r) => r.phase === 'pr_draft');
    expect(prRows).toEqual([expect.objectContaining({ modelId: HAIKU, input: 2400, output: 350 })]);
    expect(rows.filter((r) => r.phase === 'implementation').every((r) => r.modelId === SONNET)).toBe(true);
    const expected = computeCost(registry, HAIKU, { input: 2400, output: 350, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }).usd;
    expect(prRows[0]!.costUsd).toBeCloseTo(expected, 12);
    expect(fx.harness.store.spentUsd(run.runId, 'pr_draft')).toBeCloseTo(expected, 12);
    expect(fx.harness.store.spentUsd(run.runId, 'implementation')).toBe(implementationBefore);
    expect(fx.harness.events.list(run.runId, { types: ['model.usage.recorded'] }).at(-1)?.payload).toMatchObject({ phase: 'pr_draft', modelId: HAIKU, budgetUsd: 0.02, actual: true });
    const usageJson = JSON.parse(readFileSync(join(fx.harness.layout.runDir(run.runId), 'usage.json'), 'utf8')) as { requests: unknown[] };
    expect(usageJson.requests.length).toBeGreaterThanOrEqual(rows.length - 1);
  });

  it('uses the PR budget even when the implementation budget is spent', async () => {
    const { run, prModel, workflow } = await reviewedRun();
    fx.harness.store.insertUsage({ requestId: 'req_exhaust', runId: run.runId, phase: 'implementation', modelId: SONNET, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0.5, estimatedUsd: null, createdAt: new Date().toISOString() });
    const stored = await workflow.draft(run.runId);
    expect(stored.fallback).toBe(false);
    expect(prModel.requests).toHaveLength(1);
  });

  it('falls back to the deterministic template when the PR budget is spent, without calling Haiku', async () => {
    const { run, prModel, workflow } = await reviewedRun();
    fx.harness.store.insertUsage({ requestId: 'req_pr_spent', runId: run.runId, phase: 'pr_draft', modelId: HAIKU, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0.02, estimatedUsd: null, createdAt: new Date().toISOString() });
    const stored = await workflow.draft(run.runId);
    expect(stored).toMatchObject({ fallback: true, problems: [expect.stringMatching(/^PR budget:/)] });
    expect(stored.body).toContain('description deterministic template');
    expect(prModel.requests).toEqual([]);
    expect(fx.harness.getRun(run.runId).state).toBe('PR_APPROVAL');
  });

  it('falls back when Haiku claims a check that never ran', async () => {
    const { run, workflow } = await reviewedRun([
      (req) => {
        const good = JSON.parse(draftFromEvidence(req).text) as Record<string, unknown>;
        return { text: JSON.stringify({ ...good, testing: ['unit: PASS', 'typecheck: PASS'] }) };
      },
    ]);
    const stored = await workflow.draft(run.runId);
    expect(stored).toMatchObject({ fallback: true, problems: ['testing line does not cite a verified check: "typecheck: PASS"'] });
    expect(stored.body).not.toContain('typecheck');
    expect(stored.body).toContain('## Testing\n- unit: PASS\n');
    // The failed attempt still cost money and is on the ledger.
    expect(fx.harness.store.usageForRun(run.runId).filter((r) => r.phase === 'pr_draft')).toHaveLength(1);
  });

  it('refuses to draft before review approval or from the wrong state', async () => {
    fx = createTicketFixture(tmp);
    const ingested = await ingestTicket(fx, 'github:org/repo#142');
    const { orchestrator } = await driveTicket(fx, ingested.runId);
    const workflow = new PrWorkflow({ harness: fx.harness, orchestrator, provider: new ScriptedModelProvider([]), registry, github: new FakePullRequestApi(), pusher: new FakePusher() });
    await expect(workflow.draft(ingested.runId)).rejects.toMatchObject({ code: 'NOT_REVIEWED' });
    await orchestrator.approveReview(ingested.runId, 'alice', { acceptLocal: true });
    await expect(workflow.draft(ingested.runId)).rejects.toMatchObject({ code: 'NOT_READY' });
  });
});

describe('AT-13: publishing without approval', () => {
  it('throws NOT_APPROVED and pushes, looks up and creates nothing', async () => {
    const { run, api, pusher, workflow } = await reviewedRun();
    await workflow.draft(run.runId);

    await expect(workflow.publish(run.runId, { approved: false, actor: 'alice' })).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    expect(pusher.pushes).toEqual([]);
    expect(api.finds).toEqual([]);
    expect(api.creates).toEqual([]);
    expect(fx.harness.getRun(run.runId).state).toBe('PR_APPROVAL');
    expect(fx.harness.store.getPublication(run.runId)).toBeUndefined();
    expect(fx.harness.store.decisionsForRun(run.runId).filter((d) => d.kind === 'pr_publish')).toEqual([]);
    expect(head(run.worktreePath!)).toBe(run.baselineSha);
    expect(existsSync(join(fx.harness.layout.runDir(run.runId), 'pr-publication.json'))).toBe(false);
  });

  it('plan() describes the publication without side effects', async () => {
    const { run, api, pusher, workflow } = await reviewedRun();
    const stored = await workflow.draft(run.runId);
    const plan = await workflow.plan(run.runId);
    expect(plan).toEqual({
      repository: 'org/repo',
      remoteUrl: 'https://github.com/org/repo.git',
      branch: run.branch,
      base: 'main',
      title: stored.title,
      body: stored.body,
      draftPr: false,
      changedFiles: ['M src/api/session.ts'],
      action: `commit 1 file(s) on ${run.branch}, push to origin (org/repo), open a ready-for-review PR into main`,
    });
    expect([pusher.pushes, api.finds, api.creates]).toEqual([[], [], []]);
  });

  it('refuses to publish without a draft', async () => {
    const { run, pusher, workflow } = await reviewedRun();
    await expect(workflow.publish(run.runId, { approved: true, actor: 'alice' })).rejects.toMatchObject({ code: 'NO_DRAFT' });
    await expect(workflow.plan(run.runId)).rejects.toMatchObject({ code: 'NO_DRAFT' });
    expect(pusher.pushes).toEqual([]);
  });
});

describe('AT-14: publication and duplicate-PR protection', () => {
  it('commits exactly the reviewed diff, pushes once, creates one ready-for-review PR and records it', async () => {
    const { run, api, pusher, workflow } = await reviewedRun();
    const stored = await workflow.draft(run.runId);
    const userHead = gitSync(fx.repo.path, ['rev-parse', 'main']).trim();

    const result = await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    expect(result).toEqual({ url: 'https://github.com/org/repo/pull/101', number: 101, existing: false });

    const worktree = run.worktreePath!;
    const commit = head(worktree);
    expect(commit).not.toBe(run.baselineSha);
    expect(gitSync(worktree, ['rev-parse', 'HEAD~1']).trim()).toBe(run.baselineSha);
    expect(sha256(gitSync(worktree, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-renames', run.baselineSha!, 'HEAD', '--']))).toBe(run.reviewDiffSha256);
    expect(gitSync(worktree, ['status', '--porcelain'])).toBe('');
    const message = gitSync(worktree, ['log', '-1', '--format=%B']);
    expect(message).toContain('Add optional session metadata');
    expect(message).toContain('Closes #142');
    expect(message).toContain(`Aperture-Run: ${run.runId}`);
    expect(gitSync(fx.repo.path, ['rev-parse', 'main']).trim()).toBe(userHead);

    expect(pusher.pushes).toEqual([{ worktreePath: worktree, branch: run.branch }]);
    expect(api.finds).toEqual([{ owner: 'org', repo: 'repo', branch: run.branch }]);
    expect(api.creates).toEqual([{ owner: 'org', repo: 'repo', input: { title: stored.title, body: stored.body, head: run.branch, base: 'main', draft: false } }]);

    expect(fx.harness.getRun(run.runId).state).toBe('PR_CREATED');
    const publication = fx.harness.store.getPublication(run.runId)!;
    expect(publication).toMatchObject({ repository: 'org/repo', branch: run.branch, baseBranch: 'main', status: 'created', prNumber: 101, prUrl: 'https://github.com/org/repo/pull/101', headSha: commit });
    expect(JSON.parse(readFileSync(join(fx.harness.layout.runDir(run.runId), 'pr-publication.json'), 'utf8'))).toEqual(publication);

    const decision = fx.harness.store.decisionsForRun(run.runId).find((d) => d.kind === 'pr_publish')!;
    expect(decision.actor).toBe('alice');
    expect(JSON.parse(decision.answerJson)).toEqual({ repository: 'org/repo', branch: run.branch, base: 'main', title: stored.title, bodySha256: sha256(stored.body), diffSha256: run.reviewDiffSha256 });
    expect(transitions(run.runId).slice(-2)).toEqual(['PR_APPROVAL->PR_PUBLISHING', 'PR_PUBLISHING->PR_CREATED']);
    expect(fx.harness.events.list(run.runId, { types: ['pr.published'] }).map((e) => e.payload)).toEqual([{ url: 'https://github.com/org/repo/pull/101', number: 101, existing: false, branch: run.branch, headSha: commit }]);
  });

  it('returns the same PR on a repeated publish without new git or GitHub calls', async () => {
    const { run, api, pusher, workflow } = await reviewedRun();
    await workflow.draft(run.runId);
    const first = await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    const commit = head(run.worktreePath!);

    const again = await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    expect(again).toEqual({ url: first.url, number: first.number, existing: true });
    expect(pusher.pushes).toHaveLength(1);
    expect(api.finds).toHaveLength(1);
    expect(api.creates).toHaveLength(1);
    expect(head(run.worktreePath!)).toBe(commit);
  });

  it('reuses an existing PR for the branch instead of creating another', async () => {
    const { run, api, pusher, workflow } = await reviewedRun();
    await workflow.draft(run.runId);
    api.remote = [pullRequest(55, 'someone-else/feature'), pullRequest(77, run.branch!)];

    const result = await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    expect(result).toEqual({ url: 'https://github.com/org/repo/pull/77', number: 77, existing: true });
    expect(api.creates).toEqual([]);
    expect(pusher.pushes).toHaveLength(1);
    expect(fx.harness.getRun(run.runId).state).toBe('PR_CREATED');
    expect(fx.harness.store.getPublication(run.runId)).toMatchObject({ status: 'created', prNumber: 77 });
    expect(fx.harness.events.list(run.runId, { types: ['pr.published'] })[0]?.payload).toMatchObject({ number: 77, existing: true });
  });

  it('after a lost create response, a retry finds the PR and neither re-pushes nor re-creates', async () => {
    const { run, api, pusher, workflow } = await reviewedRun();
    await workflow.draft(run.runId);
    api.failNextCreateAfterCommit = new SourceError('request to api.github.com failed: socket hang up', 'TRANSPORT');

    await expect(workflow.publish(run.runId, { approved: true, actor: 'alice' })).rejects.toMatchObject({ code: 'TRANSPORT' });
    expect(fx.harness.getRun(run.runId).state).toBe('PR_PUBLISHING');
    expect(fx.harness.store.getPublication(run.runId)).toMatchObject({ status: 'pushed', prNumber: null });
    expect(fx.harness.events.list(run.runId, { types: ['error'] }).at(-1)?.payload.message).toContain('PR publication failed');

    const retry = await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    expect(retry).toEqual({ url: 'https://github.com/org/repo/pull/101', number: 101, existing: true });
    expect(pusher.pushes).toHaveLength(1);
    expect(api.creates).toHaveLength(1);
    expect(api.finds).toHaveLength(2);
    expect(fx.harness.getRun(run.runId).state).toBe('PR_CREATED');
  });

  it('blocks the run on a permanent GitHub error', async () => {
    const { run, api, workflow } = await reviewedRun();
    await workflow.draft(run.runId);
    api.failNextCreateAfterCommit = new SourceError('GitHub rejected the pull request: Validation Failed', 'INVALID_CONTENT');
    await expect(workflow.publish(run.runId, { approved: true, actor: 'alice' })).rejects.toMatchObject({ code: 'INVALID_CONTENT' });
    expect(fx.harness.getRun(run.runId)).toMatchObject({ state: 'BLOCKED', terminalReason: expect.stringContaining('PR publication failed') });
  });
});

describe('draft vs ready-for-review PRs', () => {
  it('opens a ready-for-review PR by default (createPullRequest receives draft: false)', async () => {
    const { run, api, workflow } = await reviewedRun();
    expect(fx.harness.config.pr.draftByDefault).toBe(false);
    const stored = await workflow.draft(run.runId);
    expect(stored.draftPr).toBe(false);

    await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]!.input.draft).toBe(false);
  });

  it('opens a GitHub draft PR when draft() is called with draftPr: true', async () => {
    const { run, api, workflow } = await reviewedRun();
    const stored = await workflow.draft(run.runId, { draftPr: true });
    expect(stored.draftPr).toBe(true);
    expect(workflow.loadDraft(run.runId)?.draftPr).toBe(true);
    expect(fx.harness.events.list(run.runId, { types: ['pr.approval.requested'] })[0]?.payload).toMatchObject({ draftPr: true });

    const plan = await workflow.plan(run.runId);
    expect(plan.draftPr).toBe(true);
    expect(plan.action).toBe(`commit 1 file(s) on ${run.branch}, push to origin (org/repo), open a GitHub draft PR into main`);

    await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]!.input.draft).toBe(true);
  });

  it('opens a GitHub draft PR when the config sets pr.draftByDefault: true', async () => {
    const { run, api, workflow } = await reviewedRun([draftFromEvidence], { config: { pr: { draftByDefault: true } } });
    expect(fx.harness.config.pr.draftByDefault).toBe(true);
    const stored = await workflow.draft(run.runId);
    expect(stored.draftPr).toBe(true);
    expect((await workflow.plan(run.runId)).action).toContain('open a GitHub draft PR into main');

    await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    expect(api.creates[0]!.input.draft).toBe(true);
  });

  it('an explicit draftPr: false overrides pr.draftByDefault: true', async () => {
    const { run, api, workflow } = await reviewedRun([draftFromEvidence], { config: { pr: { draftByDefault: true } } });
    const stored = await workflow.draft(run.runId, { draftPr: false });
    expect(stored.draftPr).toBe(false);

    await workflow.publish(run.runId, { approved: true, actor: 'alice' });
    expect(api.creates[0]!.input.draft).toBe(false);
  });
});

describe('diff changed after review', () => {
  it('draft throws DIFF_CHANGED and clears the review approval', async () => {
    const { run, prModel, workflow } = await reviewedRun();
    touch(run.worktreePath!);
    await expect(workflow.draft(run.runId)).rejects.toMatchObject({ code: 'DIFF_CHANGED' });
    expect(fx.harness.getRun(run.runId)).toMatchObject({ state: 'READY_FOR_REVIEW', reviewDiffSha256: null, reviewApprovedAt: null });
    expect(prModel.requests).toEqual([]);
    expect(workflow.loadDraft(run.runId)).toBeUndefined();
    // Still unreviewed on the next attempt.
    await expect(workflow.draft(run.runId)).rejects.toMatchObject({ code: 'NOT_REVIEWED' });
  });

  it('publish throws DIFF_CHANGED, returns to READY_FOR_REVIEW and pushes nothing', async () => {
    const { run, api, pusher, workflow } = await reviewedRun();
    await workflow.draft(run.runId);
    touch(run.worktreePath!);

    await expect(workflow.publish(run.runId, { approved: true, actor: 'alice' })).rejects.toMatchObject({ code: 'DIFF_CHANGED' });
    expect(fx.harness.getRun(run.runId)).toMatchObject({ state: 'READY_FOR_REVIEW', reviewDiffSha256: null, reviewApprovedAt: null });
    expect(transitions(run.runId).at(-1)).toBe('PR_APPROVAL->READY_FOR_REVIEW');
    expect([pusher.pushes, api.finds, api.creates]).toEqual([[], [], []]);
    expect(head(run.worktreePath!)).toBe(run.baselineSha);
    expect(fx.harness.store.getPublication(run.runId)).toBeUndefined();
  });
});

describe('remote mismatch', () => {
  it('refuses to push when origin points at another repository', async () => {
    const { run, api, pusher, workflow } = await reviewedRun();
    await workflow.draft(run.runId);
    gitSync(fx.repo.path, ['remote', 'set-url', 'origin', 'git@github.com:attacker/fork.git']);

    await expect(workflow.publish(run.runId, { approved: true, actor: 'alice' })).rejects.toMatchObject({ code: 'REMOTE_MISMATCH', message: expect.stringContaining('attacker/fork') });
    expect([pusher.pushes, api.finds, api.creates]).toEqual([[], [], []]);
    expect(fx.harness.getRun(run.runId).state).toBe('PR_APPROVAL');
    expect(fx.harness.store.getPublication(run.runId)).toBeUndefined();
    expect(head(run.worktreePath!)).toBe(run.baselineSha);
  });

  it('refuses a non-GitHub origin', async () => {
    const { run, pusher, workflow } = await reviewedRun([draftFromEvidence], { origin: 'https://gitlab.example.test/org/repo.git' });
    await workflow.draft(run.runId);
    await expect(workflow.publish(run.runId, { approved: true, actor: 'alice' })).rejects.toMatchObject({ code: 'REMOTE_MISMATCH', message: expect.stringContaining('an unrecognized remote') });
    expect(pusher.pushes).toEqual([]);
  });

  it('accepts the same repository in a different case or over ssh', async () => {
    const { run, workflow } = await reviewedRun([draftFromEvidence], { origin: 'git@github.com:Org/Repo.git' });
    await workflow.draft(run.runId);
    await expect(workflow.publish(run.runId, { approved: true, actor: 'alice' })).resolves.toMatchObject({ number: 101 });
  });
});
