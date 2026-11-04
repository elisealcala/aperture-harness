/**
 * AT-07: crash recovery without duplicate edits. Each scenario recreates the exact persisted state a
 * crash would leave behind, restarts the harness on the same storage, and resumes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NonInteractive, Orchestrator } from '../../packages/core/src/index.ts';
import { ToolGateway } from '../../packages/gateway/src/index.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarnessFixture, fixtureContract, prepareRun, reopenHarness, type HarnessFixture, type PreparedRun } from '../helpers/harness.ts';
import { DONE, ingestFixture, lastToolResults, patchTurn, scriptedModel } from '../helpers/model.ts';
import { SESSION_METADATA_PATCH, SESSION_TS, SESSION_TS_WITH_METADATA } from '../helpers/repo.ts';
import { TempDirs } from '../helpers/tmp.ts';

const PATCH_INPUT = { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R1', 'R2'] };
const interaction = () => new NonInteractive('test', { approveContracts: true });

const tmp = new TempDirs();
let fx: HarnessFixture;

afterEach(() => {
  vi.restoreAllMocks();
  fx.harness.close();
  tmp.cleanup();
});

function eventPayloads(runId: string, type: string): Array<Record<string, unknown>> {
  return fx.harness.events.list(runId, { types: [type as never] }).map((e) => e.payload);
}

function sessionFile(worktree: string): string {
  return readFileSync(join(worktree, 'src/api/session.ts'), 'utf8');
}

/** Persists the kickoff and an assistant turn whose only tool call is the session patch. */
function persistAssistantPatchTurn(p: PreparedRun, toolUseId: string): void {
  const { store } = p.fx.harness;
  store.appendConversation(p.run.runId, 'user', JSON.stringify('Implement approved contract LOCAL-142 v1.'));
  store.appendConversation(p.run.runId, 'assistant', JSON.stringify([{ type: 'text', text: 'Applying the change.' }, { type: 'tool_use', id: toolUseId, name: 'propose_patch', input: PATCH_INPUT }]));
}

/** Rewinds a recorded patch operation to the state a crash between apply and record leaves behind. */
function rewindToStarted(p: PreparedRun, opId: string): void {
  p.fx.harness.store.sql.run("UPDATE tool_operations SET status = 'started', result_json = NULL, result_sha256 = NULL WHERE op_id = :id", { id: opId });
}

describe('AT-07 (a): crash after a patch was applied but before its result was recorded', () => {
  it('reconciles the started operation as applied and does not apply it again', async () => {
    const p = await prepareRun(tmp);
    fx = p.fx;
    expect(await p.gateway.execute({ id: 'toolu_patch', name: 'propose_patch', input: PATCH_INPUT })).toMatchObject({ isError: false });
    rewindToStarted(p, 'toolu_patch');
    persistAssistantPatchTurn(p, 'toolu_patch');
    expect(fx.harness.store.getToolOp('toolu_patch')).toMatchObject({ status: 'started', resultJson: null });
    expect(sessionFile(p.worktree)).toBe(SESSION_TS_WITH_METADATA);

    const harness = reopenHarness(fx);
    const { provider, executor } = scriptedModel([DONE]);
    const final = await new Orchestrator(harness).resume(p.run.runId, { executor, interaction: interaction() });

    expect(eventPayloads(p.run.runId, 'run.resumed')).toEqual([expect.objectContaining({ state: 'EXECUTING', danglingOperations: ['toolu_patch'] })]);
    expect(eventPayloads(p.run.runId, 'recovery.reconciled')).toEqual([{ toolCallId: 'toolu_patch', path: 'src/api/session.ts', state: 'applied' }]);

    // The change is present exactly once and was not re-applied or re-counted.
    expect(sessionFile(p.worktree)).toBe(SESSION_TS_WITH_METADATA);
    expect(sessionFile(p.worktree).match(/metadata\?: Record<string, string>;/g)).toHaveLength(1);
    expect(final.patchAttempts).toBe(1);
    expect(eventPayloads(p.run.runId, 'tool.approved').filter((e) => e.name === 'propose_patch')).toHaveLength(1);
    expect(harness.store.getToolOp('toolu_patch')).toMatchObject({ status: 'applied' });

    // The model receives the recovered result for the pending tool_use and finishes.
    expect(provider.requests).toHaveLength(1);
    expect(lastToolResults(provider.requests[0]!)).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_patch', content: 'applied patch to src/api/session.ts (recovered after interruption) for R1, R2' }]);
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(eventPayloads(p.run.runId, 'verification.completed').at(-1)).toMatchObject({ result: 'PASS' });
  });

  it('reports a started-but-never-applied patch as NOT applied so the model can retry', async () => {
    const p = await prepareRun(tmp);
    fx = p.fx;
    await p.gateway.execute({ id: 'toolu_patch', name: 'propose_patch', input: PATCH_INPUT });
    rewindToStarted(p, 'toolu_patch');
    writeFileSync(join(p.worktree, 'src/api/session.ts'), SESSION_TS); // the crash happened before `git apply`
    persistAssistantPatchTurn(p, 'toolu_patch');

    const harness = reopenHarness(fx);
    const { provider, executor } = scriptedModel([patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_retry'), DONE]);
    const final = await new Orchestrator(harness).resume(p.run.runId, { executor, interaction: interaction() });

    expect(eventPayloads(p.run.runId, 'recovery.reconciled')).toEqual([expect.objectContaining({ toolCallId: 'toolu_patch', state: 'not_applied' })]);
    expect(lastToolResults(provider.requests[0]!)).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_patch', is_error: true, content: expect.stringContaining('it was NOT applied') },
    ]);
    expect(harness.store.getToolOp('toolu_patch')).toMatchObject({ status: 'failed' });
    expect(harness.store.getToolOp('toolu_retry')).toMatchObject({ status: 'applied' });
    expect(sessionFile(p.worktree)).toBe(SESSION_TS_WITH_METADATA);
    expect(final.state).toBe('READY_FOR_REVIEW');
  });

  it('reconcilePatch distinguishes applied, not applied and conflicting worktree states', async () => {
    const p = await prepareRun(tmp);
    fx = p.fx;
    await p.gateway.execute({ id: 'toolu_patch', name: 'propose_patch', input: PATCH_INPUT });
    expect(await p.gateway.reconcilePatch('toolu_patch')).toBe('applied'); // recorded as applied
    rewindToStarted(p, 'toolu_patch');
    expect(await p.gateway.reconcilePatch('toolu_patch')).toBe('applied'); // reverse-applies cleanly
    writeFileSync(join(p.worktree, 'src/api/session.ts'), SESSION_TS);
    expect(await p.gateway.reconcilePatch('toolu_patch')).toBe('not_applied');
    writeFileSync(join(p.worktree, 'src/api/session.ts'), 'export const unrelated = 1;\n');
    expect(await p.gateway.reconcilePatch('toolu_patch')).toBe('conflict');
    await expect(p.gateway.reconcilePatch('toolu_missing')).rejects.toThrow('no patch operation toolu_missing');
  });
});

describe('AT-07 (b): crash after the assistant turn was persisted but before its tools ran', () => {
  it('executes the pending tool call exactly once on resume and continues', async () => {
    fx = createHarnessFixture(tmp, fixtureContract());
    const run = await ingestFixture(fx);
    const first = scriptedModel([patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_patch'), DONE]);
    vi.spyOn(ToolGateway.prototype, 'execute').mockRejectedValueOnce(new Error('simulated crash: process killed'));
    await expect(new Orchestrator(fx.harness).drive(run.runId, { executor: first.executor, interaction: interaction() })).rejects.toThrow('simulated crash');
    vi.restoreAllMocks();

    const crashed = fx.harness.getRun(run.runId);
    expect(crashed.state).toBe('EXECUTING');
    expect(fx.harness.store.loadConversation(run.runId).map((e) => e.role)).toEqual(['user', 'assistant']);
    expect(fx.harness.store.getToolOp('toolu_patch')).toBeUndefined();
    expect(sessionFile(crashed.worktreePath!)).toBe(SESSION_TS);
    expect(first.provider.requests).toHaveLength(1);

    const harness = reopenHarness(fx);
    const second = scriptedModel([DONE]);
    const final = await new Orchestrator(harness).resume(run.runId, { executor: second.executor, interaction: interaction() });

    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(final.patchAttempts).toBe(1);
    expect(harness.store.getToolOp('toolu_patch')).toMatchObject({ status: 'applied' });
    expect(eventPayloads(run.runId, 'tool.requested').filter((e) => e.toolCallId === 'toolu_patch')).toHaveLength(1);
    expect(eventPayloads(run.runId, 'recovery.reconciled')).toEqual([]);
    expect(sessionFile(final.worktreePath!)).toBe(SESSION_TS_WITH_METADATA);
    // The resumed loop asks the model only after the pending tool ran, with its result attached.
    expect(second.provider.requests).toHaveLength(1);
    expect(lastToolResults(second.provider.requests[0]!)).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_patch', content: 'applied patch to src/api/session.ts (+2 -1) for R1, R2' }]);
  });

  it('replays the recorded result when the tool finished but its result never reached the conversation', async () => {
    const p = await prepareRun(tmp);
    fx = p.fx;
    await p.gateway.execute({ id: 'toolu_patch', name: 'propose_patch', input: PATCH_INPUT });
    persistAssistantPatchTurn(p, 'toolu_patch');

    const harness = reopenHarness(fx);
    const { provider, executor } = scriptedModel([DONE]);
    const final = await new Orchestrator(harness).resume(p.run.runId, { executor, interaction: interaction() });

    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(final.patchAttempts).toBe(1);
    expect(eventPayloads(p.run.runId, 'tool.requested')).toHaveLength(1); // only the original execution
    expect(eventPayloads(p.run.runId, 'recovery.reconciled')).toEqual([]);
    expect(sessionFile(p.worktree)).toBe(SESSION_TS_WITH_METADATA);
    expect(lastToolResults(provider.requests[0]!)).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_patch', content: 'applied patch to src/api/session.ts (+2 -1) for R1, R2' }]);
  });
});
