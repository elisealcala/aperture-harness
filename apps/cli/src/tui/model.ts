import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseContract } from '@aperture/contracts';
import type { Harness, QuestionPayload } from '@aperture/core';
import type { EventEnvelope } from '@aperture/events';
import type { CheckRunRecord, RunRecord, UsageRecord } from '@aperture/storage';
import type { VerificationReport } from '@aperture/verifier';

export interface TuiSnapshot {
  run: RunRecord;
  title: string;
  sourceRef: string;
  contract?: { version: number; sha256: string; goal: string; requirements: Array<{ id: string; text: string }>; budgetUsd: number; prBudgetUsd: number };
  events: EventEnvelope[];
  checks: CheckRunRecord[];
  verification?: VerificationReport;
  usage: UsageRecord[];
  spent: { implementation: number; pr: number };
  questions: Array<{ questionId: string; payload: QuestionPayload }>;
  diff: string;
}

const EVENT_WINDOW = 2_000;

/** Reads everything the TUI shows from durable state, so `attach` and a live run render identically. */
export function loadSnapshot(harness: Harness, runId: string): TuiSnapshot {
  const run = harness.getRun(runId);
  const task = harness.store.getTask(run.taskId)!;
  const record = run.contractId ? harness.store.getContract(run.contractId) : harness.store.contractsForTask(run.taskId).at(-1);
  let contract: TuiSnapshot['contract'];
  if (record) {
    const c = parseContract(JSON.parse(record.canonicalJson));
    contract = { version: record.version, sha256: record.sha256, goal: c.spec.goal, requirements: c.spec.requirements, budgetUsd: c.spec.limits.maxCostUsd, prBudgetUsd: c.spec.limits.prBudgetUsd };
  }
  const last = harness.events.lastSequence(run.runId);
  const events = harness.events.list(run.runId, { afterSequence: Math.max(0, last - EVENT_WINDOW) });
  const verificationPath = join(harness.layout.runDir(run.runId), 'verification.json');
  const patchPath = join(harness.layout.runDir(run.runId), 'proposed.patch');
  const diffEvents = events.filter((e) => e.type === 'tool.completed' && (e.payload as { name?: string }).name === 'propose_patch');
  const diff = existsSync(patchPath)
    ? readFileSync(patchPath, 'utf8')
    : diffEvents.map((e) => String((e.payload as { diff?: string }).diff ?? '')).join('\n');
  return {
    run,
    title: task.title,
    sourceRef: task.sourceRef,
    ...(contract ? { contract } : {}),
    events,
    checks: harness.store.checksForRun(run.runId),
    ...(existsSync(verificationPath) ? { verification: JSON.parse(readFileSync(verificationPath, 'utf8')) as VerificationReport } : {}),
    usage: harness.store.usageForRun(run.runId),
    spent: { implementation: harness.store.spentUsd(run.runId, 'implementation'), pr: harness.store.spentUsd(run.runId, 'pr_draft') },
    questions: harness.store.questionsForRun(run.runId, 'open').map((q) => ({ questionId: q.questionId, payload: JSON.parse(q.payloadJson) as QuestionPayload })),
    diff,
  };
}

export const ACTIVITY_FILTERS = ['all', 'model', 'tool', 'policy', 'check', 'question', 'error'] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export function matchesFilter(event: EventEnvelope, filter: ActivityFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'model':
      return event.type.startsWith('model.');
    case 'tool':
      return event.type.startsWith('tool.');
    case 'policy':
      return event.type === 'tool.rejected' || event.type.startsWith('scope.') || event.type.startsWith('contract.');
    case 'check':
      return event.type.startsWith('check.') || event.type.startsWith('verification.');
    case 'question':
      return event.type.startsWith('question.') || event.type.startsWith('scope.');
    case 'error':
      return event.type === 'error' || event.type === 'budget.exhausted' || event.type === 'tool.rejected';
  }
}

/** Requirement checklist for the overview: verification status when known, else patch evidence. */
export function requirementProgress(snapshot: TuiSnapshot): Array<{ id: string; text: string; mark: '✓' | '~' | '✗' | ' ' }> {
  const verified = new Map(snapshot.verification?.requirements.map((r) => [r.id, r.status]) ?? []);
  const patched = new Set(
    snapshot.events
      .filter((e) => e.type === 'tool.completed' && (e.payload as { name?: string }).name === 'propose_patch')
      .flatMap((e) => ((e.payload as { requirementIds?: string[] }).requirementIds ?? [])),
  );
  return (snapshot.contract?.requirements ?? []).map((r) => {
    const status = verified.get(r.id);
    const mark = status === 'VERIFIED' ? '✓' : status === 'FAILED' ? '✗' : status === 'UNVERIFIED' || patched.has(r.id) ? '~' : ' ';
    return { id: r.id, text: r.text, mark };
  });
}

export function bar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}
