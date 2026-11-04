import { afterEach, describe, expect, it } from 'vitest';
import { NonInteractive, Orchestrator } from '@aperture/core';
import type { EventEnvelope, EventType } from '@aperture/events';
import type { VerificationReport } from '@aperture/verifier';
import { createHarnessFixture, prepareRun, type HarnessFixture } from '../../../../tests/helpers/harness.ts';
import { DONE, ingestFixture, patchTurn, scriptedModel } from '../../../../tests/helpers/model.ts';
import { runRecord } from '../../../../tests/helpers/records.ts';
import { SESSION_METADATA_PATCH } from '../../../../tests/helpers/repo.ts';
import { TempDirs } from '../../../../tests/helpers/tmp.ts';
import { ACTIVITY_FILTERS, bar, loadSnapshot, matchesFilter, requirementProgress, type ActivityFilter, type TuiSnapshot } from './model.ts';

const tmp = new TempDirs();
let fx: HarnessFixture | undefined;

afterEach(() => {
  fx?.harness.close();
  fx = undefined;
  tmp.cleanup();
});

function event(type: EventType, payload: Record<string, unknown> = {}, sequence = 1): EventEnvelope {
  return { schemaVersion: 1, eventId: `evt_${sequence}`, runId: 'run_1', sequence, timestamp: '2026-11-04T20:00:00.000Z', type, payload };
}

function snapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    run: runRecord('run_1', 'task_1'),
    title: 'Task',
    sourceRef: 'github:org/repo#142',
    events: [],
    checks: [],
    usage: [],
    spent: { implementation: 0, pr: 0 },
    questions: [],
    diff: '',
    ...overrides,
  };
}

describe('loadSnapshot', () => {
  it('shows the pending proposal before approval, with empty activity panels', async () => {
    fx = createHarnessFixture(tmp);
    const run = await ingestFixture(fx);
    const s = loadSnapshot(fx.harness, run.runId);
    const pending = fx.harness.pendingProposal(run.runId)!;
    expect(s.run).toMatchObject({ runId: run.runId, state: 'NEEDS_CONTRACT_REVIEW', contractId: null });
    expect(s.title).toBe('Add optional session metadata');
    expect(s.sourceRef).toBe(`local:${fx.contractPath}`);
    expect(s.contract).toEqual({
      version: 1,
      sha256: pending.record.sha256,
      goal: pending.contract.spec.goal,
      requirements: pending.contract.spec.requirements,
      budgetUsd: 0.5,
      prBudgetUsd: pending.contract.spec.limits.prBudgetUsd,
    });
    expect(s.events.map((e) => e.type)).toEqual(['run.created', 'contract.proposed', 'state.changed']);
    expect(s).toMatchObject({ checks: [], usage: [], spent: { implementation: 0, pr: 0 }, questions: [], diff: '' });
    expect(s.verification).toBeUndefined();
  });

  it('falls back to propose_patch event diffs while no proposed.patch exists', async () => {
    const p = await prepareRun(tmp);
    fx = p.fx;
    await p.gateway.execute({ id: 'toolu_patch', name: 'propose_patch', input: { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R1'] } });
    const s = loadSnapshot(fx.harness, p.run.runId);
    expect(s.diff).toContain('+  metadata?: Record<string, string>;');
    expect(s.contract?.version).toBe(1);
    expect(requirementProgress(s).map((r) => [r.id, r.mark])).toEqual([
      ['R1', '~'],
      ['R2', ' '],
    ]);
  });

  it('includes verification, the verified patch, checks and usage after a run', async () => {
    fx = createHarnessFixture(tmp);
    const run = await ingestFixture(fx);
    const { executor } = scriptedModel([patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_meta'), DONE]);
    await new Orchestrator(fx.harness).drive(run.runId, { executor, interaction: new NonInteractive('test', { approveContracts: true }) });
    const s = loadSnapshot(fx.harness, run.runId);
    expect(s.run.state).toBe('READY_FOR_REVIEW');
    expect(s.verification).toMatchObject({ attempt: 1, result: 'PASS' });
    expect(s.diff).toMatch(/^diff --git a\/src\/api\/session\.ts/);
    expect(s.checks.map((c) => c.checkId).sort()).toEqual(['has-metadata', 'unit']);
    expect(s.usage).toHaveLength(2);
    expect(s.spent.implementation).toBeGreaterThan(0);
    expect(s.spent.pr).toBe(0);
    expect(requirementProgress(s).map((r) => r.mark)).toEqual(['✓', '✓']);
  });

  it('throws for an unknown run', () => {
    fx = createHarnessFixture(tmp);
    expect(() => loadSnapshot(fx!.harness, 'run_missing')).toThrow(/not found/);
  });
});

describe('matchesFilter', () => {
  const cases: Array<[EventType, ActivityFilter[]]> = [
    ['model.request.started', ['all', 'model']],
    ['model.usage.recorded', ['all', 'model']],
    ['tool.completed', ['all', 'tool']],
    ['tool.rejected', ['all', 'tool', 'policy', 'error']],
    ['contract.approved', ['all', 'policy']],
    ['scope.change.requested', ['all', 'policy', 'question']],
    ['check.completed', ['all', 'check']],
    ['verification.completed', ['all', 'check']],
    ['question.asked', ['all', 'question']],
    ['error', ['all', 'error']],
    ['budget.exhausted', ['all', 'error']],
    ['budget.warning', ['all']],
    ['state.changed', ['all']],
  ];

  it.each(cases)('%s matches exactly %j', (type, expected) => {
    expect(ACTIVITY_FILTERS.filter((f) => matchesFilter(event(type), f))).toEqual(expected);
  });
});

describe('requirementProgress', () => {
  const requirements = ['R1', 'R2', 'R3', 'R4', 'R5'].map((id) => ({ id, text: `req ${id}` }));
  const contract = { version: 1, sha256: 'x', goal: 'g', requirements, budgetUsd: 0.5, prBudgetUsd: 0.02 };

  it('prefers verification status and falls back to patch evidence', () => {
    const verification = {
      requirements: [
        { id: 'R1', status: 'VERIFIED' },
        { id: 'R2', status: 'FAILED' },
        { id: 'R3', status: 'UNVERIFIED' },
      ],
    } as unknown as VerificationReport;
    const events = [event('tool.completed', { name: 'propose_patch', requirementIds: ['R2', 'R4'] }), event('tool.completed', { name: 'read_file', requirementIds: ['R5'] }, 2)];
    expect(requirementProgress(snapshot({ contract, verification, events }))).toEqual([
      { id: 'R1', text: 'req R1', mark: '✓' },
      { id: 'R2', text: 'req R2', mark: '✗' },
      { id: 'R3', text: 'req R3', mark: '~' },
      { id: 'R4', text: 'req R4', mark: '~' },
      { id: 'R5', text: 'req R5', mark: ' ' },
    ]);
  });

  it('is empty without a contract', () => {
    expect(requirementProgress(snapshot())).toEqual([]);
  });
});

describe('bar', () => {
  it('fills proportionally with a default width of 20', () => {
    expect(bar(0)).toBe('░'.repeat(20));
    expect(bar(1)).toBe('█'.repeat(20));
    expect(bar(0.5, 10)).toBe('█████░░░░░');
    expect(bar(0.26, 10)).toBe('███░░░░░░░');
  });

  it('clamps out-of-range fractions', () => {
    expect(bar(2, 4)).toBe('████');
    expect(bar(-1, 4)).toBe('░░░░');
  });
});
