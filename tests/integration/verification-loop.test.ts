/**
 * Stage 2 verification gating through the orchestrator: bounded fix loop with stall detection
 * (AT-08), unverified requirements and review approval (AT-09), and scope violations found only at
 * verification time.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractInput } from '../../packages/contracts/src/index.ts';
import { HarnessError, NonInteractive, Orchestrator } from '../../packages/core/src/index.ts';
import type { ScriptedModelProvider, ScriptedResponder } from '../../packages/models/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import { failureFeedback, type VerificationReport } from '../../packages/verifier/src/index.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarnessFixture, fixtureContract, type HarnessFixture } from '../helpers/harness.ts';
import { DONE, ingestFixture, patchTurn, scriptedModel } from '../helpers/model.ts';
import { SESSION_COMMENT_PATCH, SESSION_METADATA_PATCH } from '../helpers/repo.ts';
import { TempDirs } from '../helpers/tmp.ts';

const COMMENT_TURN = patchTurn('src/api/session.ts', SESSION_COMMENT_PATCH, ['R1', 'R2'], 'toolu_comment');
const META_TURN = patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_meta');

/** `has-metadata` becomes a required check: it fails until SESSION_METADATA_PATCH lands. */
function requireMetadata(c: ContractInput): void {
  c.spec.checks = c.spec.checks!.map((check) => (check.id === 'has-metadata' ? { ...check, required: true } : check));
}

const tmp = new TempDirs();
let fx: HarnessFixture;
let orchestrator: Orchestrator;

afterEach(() => {
  fx.harness.close();
  tmp.cleanup();
});

async function driveWith(mutate: ((c: ContractInput) => void) | undefined, turns: ScriptedResponder[]): Promise<{ final: RunRecord; provider: ScriptedModelProvider }> {
  fx = createHarnessFixture(tmp, fixtureContract(mutate ? { mutate } : {}));
  const run = await ingestFixture(fx);
  const { provider, executor } = scriptedModel(turns);
  orchestrator = new Orchestrator(fx.harness);
  const final = await orchestrator.drive(run.runId, { executor, interaction: new NonInteractive('test', { approveContracts: true }) });
  return { final, provider };
}

function verifications(runId: string): Array<Record<string, unknown>> {
  return fx.harness.events.list(runId, { types: ['verification.completed'] }).map((e) => e.payload);
}

function stateChangeReasons(runId: string): string[] {
  return fx.harness.events.list(runId, { types: ['state.changed'] }).map((e) => `${String(e.payload.from)}->${String(e.payload.to)}: ${String(e.payload.reason ?? '')}`);
}

describe('AT-08: failed required check', () => {
  it('feeds the failure back, returns to EXECUTING, and reaches READY_FOR_REVIEW once fixed', async () => {
    const { final, provider } = await driveWith(requireMetadata, [COMMENT_TURN, DONE, META_TURN, DONE]);

    expect(verifications(final.runId).map((v) => v.result)).toEqual(['FAIL', 'PASS']);
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(final.verificationAttempts).toBe(2);
    expect(final.lastFailureSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(stateChangeReasons(final.runId)).toContain('VERIFYING->EXECUTING: bounded fix 1/3: required checks failed: has-metadata (FAIL)');

    // The feedback joined the persisted conversation as a user message and reached the model.
    const conversation = fx.harness.store.loadConversation(final.runId);
    const feedback = conversation.map((e) => JSON.parse(e.contentJson) as unknown).find((c) => typeof c === 'string' && c.startsWith('Harness verification attempt 1: FAIL')) as string | undefined;
    expect(feedback).toBeDefined();
    expect(feedback).toContain('Check has-metadata FAIL (exit 1):');
    expect(feedback).toContain('metadata field missing from SessionInput');
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[2]!.messages.at(-1)).toEqual({ role: 'user', content: feedback });
    expect(provider.requests[2]!.messages.at(-2)?.role).toBe('assistant');
  });

  it('feeds back exactly failureFeedback(report) of the failed attempt', async () => {
    let feedbackSeen: unknown;
    let reportAtThatTime: VerificationReport | undefined;
    const { final } = await driveWith(requireMetadata, [
      COMMENT_TURN,
      DONE,
      (request) => {
        // While the model is fixing, verification.json still holds the failed attempt's report.
        const runId = fx.harness.store.listRuns(1)[0]!.runId;
        reportAtThatTime = JSON.parse(readFileSync(join(fx.storageDir, 'runs', runId, 'verification.json'), 'utf8')) as VerificationReport;
        feedbackSeen = request.messages.at(-1)?.content;
        return META_TURN;
      },
      DONE,
    ]);
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(reportAtThatTime).toMatchObject({ attempt: 1, result: 'FAIL' });
    expect(feedbackSeen).toBe(failureFeedback(reportAtThatTime!));
    expect(orchestrator.latestVerification(final.runId)).toMatchObject({ attempt: 2, result: 'PASS' });
  });

  it('blocks as STALLED when the next attempt fails identically', async () => {
    const { final, provider } = await driveWith(requireMetadata, [COMMENT_TURN, DONE, DONE, DONE]);
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('STALLED: identical failure repeated (required checks failed: has-metadata (FAIL))');
    expect(verifications(final.runId).map((v) => v.result)).toEqual(['FAIL', 'FAIL']);
    expect(provider.requests).toHaveLength(3);
    expect(provider.remaining).toBe(1);
  });

  it('blocks as VERIFICATION_FAILED when maxVerificationAttempts is reached', async () => {
    const { final, provider } = await driveWith(
      (c) => {
        requireMetadata(c);
        c.spec.limits!.maxVerificationAttempts = 1;
      },
      [COMMENT_TURN, DONE, META_TURN, DONE],
    );
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('VERIFICATION_FAILED after 1 attempts: required checks failed: has-metadata (FAIL)');
    expect(provider.requests).toHaveLength(2);
    // No feedback is appended once the loop is over.
    expect(fx.harness.store.loadConversation(final.runId).at(-1)?.role).toBe('assistant');
  });

  it('distinguishes different failures from a stall and stops at the attempt limit', async () => {
    // Attempt 1: empty diff. Attempt 2: has-metadata fails. Different signatures, so not STALLED.
    const { final } = await driveWith(
      (c) => {
        requireMetadata(c);
        c.spec.limits!.maxVerificationAttempts = 2;
      },
      [DONE, COMMENT_TURN, DONE],
    );
    expect(verifications(final.runId).map((v) => [v.result, v.summary])).toEqual([
      ['FAIL', 'no changes were made to the worktree'],
      ['FAIL', 'required checks failed: has-metadata (FAIL)'],
    ]);
    expect(final.terminalReason).toBe('VERIFICATION_FAILED after 2 attempts: required checks failed: has-metadata (FAIL)');
  });
});

describe('AT-09: passing checks but a requirement without evidence', () => {
  async function unverifiedRun(): Promise<RunRecord> {
    const { final } = await driveWith(undefined, [patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1'], 'toolu_meta'), DONE]);
    return final;
  }

  it('marks R2 UNVERIFIED and stops at READY_FOR_REVIEW, not completed', async () => {
    const final = await unverifiedRun();
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(verifications(final.runId)).toEqual([
      expect.objectContaining({
        result: 'UNVERIFIED',
        requirements: [
          { id: 'R1', status: 'VERIFIED' },
          { id: 'R2', status: 'UNVERIFIED' },
        ],
      }),
    ]);
    expect(stateChangeReasons(final.runId)).toContain('VERIFYING->READY_FOR_REVIEW: checks passed; unverified requirements: R2 (manual review required)');
    const report = readFileSync(join(fx.storageDir, 'runs', final.runId, 'report.md'), 'utf8');
    expect(report).toContain('## Verification (attempt 1): UNVERIFIED');
    expect(report).toContain('- R2 is UNVERIFIED: no applied change references this requirement; needs manual review');
  });

  it('approveReview refuses until every unverified requirement is acknowledged', async () => {
    const final = await unverifiedRun();
    await expect(orchestrator.approveReview(final.runId, 'alice', { acceptLocal: true })).rejects.toMatchObject({ code: 'UNVERIFIED', message: expect.stringContaining('R2') });
    await expect(orchestrator.approveReview(final.runId, 'alice', { acceptLocal: true, acknowledgedUnverified: ['R1'] })).rejects.toBeInstanceOf(HarnessError);
    expect(fx.harness.getRun(final.runId).state).toBe('READY_FOR_REVIEW');
    expect(fx.harness.store.decisionsForRun(final.runId)).toEqual([]);
  });

  it('acceptLocal with the acknowledgement completes the run locally and pins the reviewed diff', async () => {
    const final = await unverifiedRun();
    const report = orchestrator.latestVerification(final.runId)!;
    const completed = await orchestrator.approveReview(final.runId, 'alice', { acceptLocal: true, acknowledgedUnverified: ['R2'] });

    expect(completed.state).toBe('COMPLETED_LOCAL');
    expect(completed.terminalReason).toBe('accepted locally by alice');
    expect(completed.reviewDiffSha256).toBe(report.diffSha256);
    expect(completed.reviewApprovedAt).not.toBeNull();
    const [decision] = fx.harness.store.decisionsForRun(final.runId);
    expect(decision).toMatchObject({ kind: 'review', actor: 'alice', questionId: null, contractVersion: 1 });
    expect(JSON.parse(decision!.answerJson)).toEqual({ diffSha256: report.diffSha256, acceptLocal: true, acknowledgedUnverified: ['R2'], verificationAttempt: 1 });
    expect(fx.harness.events.list(final.runId, { types: ['review.approved'] }).map((e) => e.payload)).toEqual([{ actor: 'alice', diffSha256: report.diffSha256, acceptLocal: true, acknowledgedUnverified: ['R2'] }]);

    await expect(orchestrator.approveReview(final.runId, 'alice', { acceptLocal: true, acknowledgedUnverified: ['R2'] })).rejects.toMatchObject({ code: 'NOT_READY' });
  });

  it('without acceptLocal records the review but leaves the run READY_FOR_REVIEW', async () => {
    const final = await unverifiedRun();
    const reviewed = await orchestrator.approveReview(final.runId, 'alice', { acceptLocal: false, acknowledgedUnverified: ['R2'] });
    expect(reviewed.state).toBe('READY_FOR_REVIEW');
    expect(reviewed.reviewDiffSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a worktree edit after verification makes approveReview throw DIFF_CHANGED', async () => {
    const final = await unverifiedRun();
    const path = join(final.worktreePath!, 'src/api/session.ts');
    writeFileSync(path, `${readFileSync(path, 'utf8')}// edited after verification\n`);
    await expect(orchestrator.approveReview(final.runId, 'alice', { acceptLocal: true, acknowledgedUnverified: ['R2'] })).rejects.toMatchObject({ code: 'DIFF_CHANGED' });
    expect(fx.harness.getRun(final.runId)).toMatchObject({ state: 'READY_FOR_REVIEW', reviewDiffSha256: null });
    expect(fx.harness.store.decisionsForRun(final.runId)).toEqual([]);
  });
});

describe('scope violations found at verification', () => {
  it('blocks with SCOPE_VIOLATION when an untracked file appears outside propose_patch', async () => {
    let worktree = '';
    const { final } = await driveWith(undefined, [
      META_TURN,
      () => {
        // e.g. a generator run by a check: the file never went through the gateway.
        worktree = fx.harness.store.listRuns(1)[0]!.worktreePath!;
        writeFileSync(join(worktree, 'src/api/generated.ts'), 'export {};\n');
        return DONE;
      },
    ]);
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('SCOPE_VIOLATION: scope violations: src/api/generated.ts (UNTRACKED_FILE)');
    expect(verifications(final.runId)).toEqual([expect.objectContaining({ result: 'BLOCKED', violations: [expect.objectContaining({ path: 'src/api/generated.ts', code: 'UNTRACKED_FILE' })] })]);
    expect(readFileSync(join(fx.storageDir, 'runs', final.runId, 'report.md'), 'utf8')).toContain('### Scope violations');
  });
});
