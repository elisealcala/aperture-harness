import type { ApertureStore, RunRecord, TaskRecord } from '../../packages/storage/src/index.ts';

const T0 = '2026-11-04T20:00:00.000Z';

export function taskRecord(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    sourceType: 'local',
    sourceRef: `local:/tmp/${taskId}.yaml`,
    repository: null,
    title: `Task ${taskId}`,
    snapshotJson: '{"title":"x"}',
    snapshotSha256: 'a'.repeat(64),
    createdAt: T0,
    ...overrides,
  };
}

export function runRecord(runId: string, taskId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    taskId,
    contractId: null,
    state: 'INGESTING',
    modelId: 'claude-sonnet-5-5',
    repoPath: '/tmp/repo',
    worktreePath: null,
    branch: null,
    baselineRef: 'HEAD',
    baselineSha: null,
    isolation: 'reduced',
    questionMode: 'noninteractive',
    turns: 0,
    patchAttempts: 0,
    verificationAttempts: 0,
    lastFailureSignature: null,
    reviewDiffSha256: null,
    reviewApprovedAt: null,
    terminalReason: null,
    startedAt: T0,
    updatedAt: T0,
    executingSince: null,
    executingMs: 0,
    ...overrides,
  };
}

/** Inserts a task and a run (foreign keys are enforced) and returns the run id. */
export function seedRun(store: ApertureStore, runId: string, overrides: Partial<RunRecord> = {}): string {
  const taskId = `task_for_${runId}`;
  store.insertTask(taskRecord(taskId));
  store.insertRun(runRecord(runId, taskId, overrides));
  return runId;
}
