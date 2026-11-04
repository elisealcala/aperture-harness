/**
 * Stage 2 pauses: ask_user and request_scope_change through the model loop. Covers interactive
 * answers and detach/resume (AT-06), noninteractive blocking and preauthorized answers (AT-16), and
 * contract amendment on approved scope changes.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, NonInteractive, Orchestrator } from '../../packages/core/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarnessFixture, fixtureContract, reopenHarness, type HarnessFixture } from '../helpers/harness.ts';
import { askTurn, DONE, ingestFixture, lastToolResults, patchCall, patchTurn, scopeTurn, scriptedModel, ScriptedInteraction } from '../helpers/model.ts';
import { NEW_TYPES_FILE_PATCH, SESSION_METADATA_PATCH } from '../helpers/repo.ts';
import { TempDirs } from '../helpers/tmp.ts';

const QUESTION = 'Should metadata be persisted to the session store?';
const META_TURN = patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_meta');

const tmp = new TempDirs();
let fx: HarnessFixture;

afterEach(() => {
  fx.harness.close();
  tmp.cleanup();
});

async function setup(): Promise<RunRecord> {
  fx = createHarnessFixture(tmp, fixtureContract());
  return ingestFixture(fx);
}

function eventPayloads(runId: string, type: string): Array<Record<string, unknown>> {
  return fx.harness.events.list(runId, { types: [type as never] }).map((e) => e.payload);
}

function stateChanges(runId: string): string[] {
  return eventPayloads(runId, 'state.changed').map((p) => `${String(p.from)}->${String(p.to)}`);
}

describe('AT-06: ask_user with an interactive user', () => {
  it('delivers the answer to the model as the tool_result of that tool_use id', async () => {
    const run = await setup();
    const { provider, executor } = scriptedModel([askTurn('toolu_ask', QUESTION, { choices: ['yes', 'no'], requirementIds: ['R1'] }), META_TURN, DONE]);
    const interaction = new ScriptedInteraction({ answers: [{ answer: 'no', choiceIndex: 1, rationale: 'keep it in memory' }] });
    const final = await new Orchestrator(fx.harness).drive(run.runId, { executor, interaction });

    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(interaction.questions).toEqual([expect.objectContaining({ runId: run.runId, question: QUESTION, choices: ['yes', 'no'], requirementIds: ['R1'], reason: 'the contract does not decide this' })]);
    expect(provider.requests).toHaveLength(3);
    expect(lastToolResults(provider.requests[1]!)).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'Answer from tester: no\nRationale: keep it in memory' }]);

    const [question] = fx.harness.store.questionsForRun(run.runId);
    expect(question).toMatchObject({ toolCallId: 'toolu_ask', kind: 'question', status: 'answered' });
    expect(fx.harness.store.decisionsForRun(run.runId)).toEqual([expect.objectContaining({ questionId: question!.questionId, kind: 'answer', actor: 'tester', contractVersion: 1 })]);
    expect(JSON.parse(fx.harness.store.decisionsForRun(run.runId)[0]!.answerJson)).toEqual({ answer: 'no', choiceIndex: 1, rationale: 'keep it in memory' });
    expect(eventPayloads(run.runId, 'question.asked')).toEqual([expect.objectContaining({ questionId: question!.questionId, toolCallId: 'toolu_ask', question: QUESTION })]);
    expect(eventPayloads(run.runId, 'question.answered')).toEqual([expect.objectContaining({ questionId: question!.questionId, answer: 'no', choiceIndex: 1, actor: 'tester' })]);
    expect(stateChanges(run.runId)).toEqual(expect.arrayContaining(['EXECUTING->WAITING_FOR_USER', 'WAITING_FOR_USER->EXECUTING']));
  });

  it('waits when the user does not answer, then resumes with an answer recorded later', async () => {
    const run = await setup();
    const first = scriptedModel([askTurn('toolu_ask', QUESTION)]);
    const detached = new ScriptedInteraction(); // returns null: "not now"
    const paused = await new Orchestrator(fx.harness).drive(run.runId, { executor: first.executor, interaction: detached });

    expect(paused.state).toBe('WAITING_FOR_USER');
    expect(paused.terminalReason).toBeNull();
    expect(detached.questions).toHaveLength(1);
    expect(first.provider.requests).toHaveLength(1);
    const open = fx.harness.store.questionsForRun(run.runId, 'open');
    expect(open).toEqual([expect.objectContaining({ toolCallId: 'toolu_ask', kind: 'question', status: 'open', answeredAt: null })]);

    // A later process answers (`aperture answer`) and resumes.
    const harness = reopenHarness(fx);
    const orchestrator = new Orchestrator(harness);
    expect(orchestrator.pauses.open(run.runId).map((q) => q.payload)).toEqual([expect.objectContaining({ type: 'question', toolCallId: 'toolu_ask', question: QUESTION })]);
    orchestrator.pauses.answer(run.runId, open[0]!.questionId, { answer: 'no' }, 'alice');
    expect(harness.store.questionsForRun(run.runId, 'open')).toEqual([]);

    const second = scriptedModel([META_TURN, DONE]);
    const later = new ScriptedInteraction();
    const final = await orchestrator.resume(run.runId, { executor: second.executor, interaction: later });

    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(later.questions).toEqual([]);
    expect(lastToolResults(second.provider.requests[0]!)).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'Answer from alice: no' }]);
    expect(second.provider.requests[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(eventPayloads(run.runId, 'run.resumed')).toEqual([expect.objectContaining({ state: 'WAITING_FOR_USER', danglingOperations: [] })]);
    expect(harness.store.decisionsForRun(run.runId)).toEqual([expect.objectContaining({ kind: 'answer', actor: 'alice' })]);
  });

  it('rejects answers to unknown, already answered, or wrong-kind questions', async () => {
    const run = await setup();
    const { executor } = scriptedModel([askTurn('toolu_ask', QUESTION)]);
    const orchestrator = new Orchestrator(fx.harness);
    await orchestrator.drive(run.runId, { executor, interaction: new ScriptedInteraction() });
    const [question] = fx.harness.store.questionsForRun(run.runId);

    const codeOf = (fn: () => void): string | undefined => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        return (err as HarnessError).code;
      }
      return undefined;
    };
    expect(codeOf(() => orchestrator.pauses.answer(run.runId, 'q_missing', { answer: 'x' }, 'alice'))).toBe('QUESTION_NOT_FOUND');
    expect(codeOf(() => orchestrator.pauses.decideScope(run.runId, question!.questionId, { approved: true }, 'alice'))).toBe('WRONG_KIND');
    orchestrator.pauses.answer(run.runId, question!.questionId, { answer: 'no' }, 'alice');
    expect(codeOf(() => orchestrator.pauses.answer(run.runId, question!.questionId, { answer: 'yes' }, 'alice'))).toBe('QUESTION_CLOSED');
    expect(fx.harness.store.decisionsForRun(run.runId)).toHaveLength(1);
  });
});

describe('AT-16: noninteractive clarification', () => {
  it('blocks with NEEDS_USER_DECISION and leaves the question open', async () => {
    const run = await setup();
    const { provider, executor } = scriptedModel([askTurn('toolu_ask', QUESTION), META_TURN, DONE]);
    const final = await new Orchestrator(fx.harness).drive(run.runId, { executor, interaction: new NonInteractive('ci', { approveContracts: true }) });

    expect(final.state).toBe('BLOCKED');
    const [question] = fx.harness.store.questionsForRun(run.runId);
    expect(question).toMatchObject({ toolCallId: 'toolu_ask', status: 'open' });
    expect(final.terminalReason).toBe(`NEEDS_USER_DECISION (noninteractive) — question ${question!.questionId}: ${QUESTION}`);
    expect(provider.requests).toHaveLength(1);
    expect(fx.harness.store.decisionsForRun(run.runId)).toEqual([]);
    expect(eventPayloads(run.runId, 'question.asked')).toHaveLength(1);
    expect(eventPayloads(run.runId, 'run.finished')).toEqual([expect.objectContaining({ state: 'BLOCKED' })]);
    expect(stateChanges(run.runId)).not.toContain('EXECUTING->WAITING_FOR_USER');
  });

  it('blocks a scope change request the same way', async () => {
    const run = await setup();
    const { executor } = scriptedModel([scopeTurn('toolu_scope', ['src/api/types.ts'])]);
    const final = await new Orchestrator(fx.harness).drive(run.runId, { executor, interaction: new NonInteractive('ci', { approveContracts: true }) });
    const [question] = fx.harness.store.questionsForRun(run.runId);
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe(`NEEDS_USER_DECISION (noninteractive) — scope change ${question!.questionId}: src/api/types.ts`);
    expect(question).toMatchObject({ kind: 'scope_change', status: 'open' });
  });

  it('continues with a matching preauthorized answer', async () => {
    const run = await setup();
    const { provider, executor } = scriptedModel([askTurn('toolu_ask', QUESTION), META_TURN, DONE]);
    const final = await new Orchestrator(fx.harness).drive(run.runId, {
      executor,
      interaction: new NonInteractive('ci', { approveContracts: true }),
      preauthorized: [
        { match: 'unrelated question', answer: 'ignored' },
        { match: 'METADATA BE PERSISTED', answer: 'no, keep it in memory' },
      ],
    });

    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(lastToolResults(provider.requests[1]!)).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'Answer from preauthorized: no, keep it in memory' }]);
    expect(fx.harness.store.questionsForRun(run.runId)).toEqual([expect.objectContaining({ status: 'answered' })]);
    expect(fx.harness.store.decisionsForRun(run.runId)).toEqual([expect.objectContaining({ kind: 'answer', actor: 'preauthorized' })]);
    expect(stateChanges(run.runId)).not.toContain('EXECUTING->WAITING_FOR_USER');
  });
});

describe('request_scope_change', () => {
  const TYPES_AND_META = { toolCalls: [patchCall('src/api/types.ts', NEW_TYPES_FILE_PATCH, ['R1'], 'toolu_types'), patchCall('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_meta')] };

  it('approved: amends the contract to v2 and the patch to the new path succeeds', async () => {
    const run = await setup();
    const { provider, executor } = scriptedModel([scopeTurn('toolu_scope', ['src/api/types.ts']), TYPES_AND_META, DONE]);
    const interaction = new ScriptedInteraction({ scope: [{ approved: true, rationale: 'fine' }] });
    const final = await new Orchestrator(fx.harness).drive(run.runId, { executor, interaction });

    expect(interaction.scopePrompts).toEqual([expect.objectContaining({ additionalPaths: ['src/api/types.ts'], currentWritable: ['src/api/session.ts', 'src/api/session.test.ts'], reason: 'types belong in their own module' })]);

    // Contract v2 is the approved revision; v1 is superseded.
    expect(final.contractId).toMatch(/\.v2$/);
    const amended = fx.harness.approvedContract(final);
    expect(amended.version).toBe(2);
    expect(amended.approvedBy).toBe('tester');
    expect(amended.contract.spec.scope.writable).toContain('src/api/types.ts');
    expect(fx.harness.store.contractsForTask(final.taskId).map((c) => [c.version, c.status])).toEqual([
      [1, 'superseded'],
      [2, 'approved'],
    ]);
    expect(eventPayloads(run.runId, 'contract.amended')).toEqual([expect.objectContaining({ version: 2, sha256: amended.sha256, addedWritable: ['src/api/types.ts'], actor: 'tester', changes: expect.arrayContaining(['scope']) })]);
    expect(fx.harness.store.decisionsForRun(run.runId)).toEqual([expect.objectContaining({ kind: 'scope_change', actor: 'tester', contractVersion: 2 })]);

    // The model is told, and its next prompt carries the amended contract.
    const [scopeResult] = lastToolResults(provider.requests[1]!);
    expect(scopeResult).toMatchObject({ tool_use_id: 'toolu_scope' });
    expect(scopeResult!.content).toMatch(/^Scope change approved by tester: contract v2 \(sha256 [0-9a-f]{16}\) now also allows writing src\/api\/types\.ts\.$/);
    expect(scopeResult!.is_error).toBeUndefined();
    expect(provider.requests[0]!.system).toContain('version="1"');
    expect(provider.requests[1]!.system).toContain(`version="2" sha256="${amended.sha256}"`);
    expect(provider.requests[1]!.system).toContain('writable files (you may modify only these):\n  - src/api/session.ts\n  - src/api/session.test.ts\n  - src/api/types.ts');

    // The new file is created and passes verification under v2.
    expect(fx.harness.store.getToolOp('toolu_types')).toMatchObject({ status: 'applied' });
    expect(existsSync(join(final.worktreePath!, 'src/api/types.ts'))).toBe(true);
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(eventPayloads(run.runId, 'verification.completed').at(-1)).toMatchObject({ result: 'PASS', violations: [] });
  });

  it('denied: the contract stays at v1 and a patch to that path is still rejected PATH_NOT_WRITABLE', async () => {
    const run = await setup();
    const { provider, executor } = scriptedModel([scopeTurn('toolu_scope', ['src/api/types.ts']), TYPES_AND_META, DONE]);
    const interaction = new ScriptedInteraction({ scope: [{ approved: false, rationale: 'keep the change small' }] });
    const final = await new Orchestrator(fx.harness).drive(run.runId, { executor, interaction });

    expect(final.contractId).toMatch(/\.v1$/);
    expect(eventPayloads(run.runId, 'contract.amended')).toEqual([]);
    expect(lastToolResults(provider.requests[1]!)).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_scope',
        is_error: true,
        content: 'Scope change denied by tester: keep the change small. Continue within the current writable scope, or call report_blocked if the task cannot be completed.',
      },
    ]);
    expect(fx.harness.store.decisionsForRun(run.runId)).toEqual([expect.objectContaining({ kind: 'scope_change', contractVersion: 1 })]);

    expect(fx.harness.store.getToolOp('toolu_types')).toMatchObject({ status: 'rejected' });
    expect(eventPayloads(run.runId, 'tool.rejected')).toEqual([expect.objectContaining({ toolCallId: 'toolu_types', reasonCode: 'PATH_NOT_WRITABLE', path: 'src/api/types.ts' })]);
    const results = lastToolResults(provider.requests[2]!);
    expect(results.find((r) => r.tool_use_id === 'toolu_types')).toMatchObject({ is_error: true, content: expect.stringMatching(/^REJECTED \(PATH_NOT_WRITABLE\)/) });
    expect(existsSync(join(final.worktreePath!, 'src/api/types.ts'))).toBe(false);
    expect(final.state).toBe('READY_FOR_REVIEW');
  });

  it('a denied path is rejected immediately with PATH_DENIED and never becomes a question', async () => {
    const run = await setup();
    const { provider, executor } = scriptedModel([scopeTurn('toolu_scope', ['package.json']), META_TURN, DONE]);
    const interaction = new ScriptedInteraction({ scope: [{ approved: true }] });
    const final = await new Orchestrator(fx.harness).drive(run.runId, { executor, interaction });

    expect(interaction.scopePrompts).toEqual([]);
    expect(fx.harness.store.questionsForRun(run.runId)).toEqual([]);
    expect(eventPayloads(run.runId, 'scope.change.requested')).toEqual([]);
    expect(eventPayloads(run.runId, 'tool.rejected')).toEqual([expect.objectContaining({ toolCallId: 'toolu_scope', name: 'request_scope_change', reasonCode: 'PATH_DENIED', path: 'package.json' })]);
    expect(lastToolResults(provider.requests[1]!)).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_scope', is_error: true, content: 'REJECTED (PATH_DENIED): package.json is denied by the contract and cannot be requested' },
    ]);
    expect(stateChanges(run.runId)).not.toContain('EXECUTING->WAITING_FOR_USER');
    expect(final.contractId).toMatch(/\.v1$/);
    expect(final.state).toBe('READY_FOR_REVIEW');
  });
});
