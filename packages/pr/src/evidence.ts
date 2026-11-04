import type { Harness, Orchestrator } from '@aperture/core';
import type { NormalizedTask } from '@aperture/sources';

export interface EvidencePacket {
  runId: string;
  title: string;
  goal: string;
  sourceRef: string;
  issueUrl: string | null;
  issueReference: string;
  repository: string | null;
  contract: { version: number; sha256: string };
  requirements: Array<{ id: string; text: string; status: string; note: string }>;
  changedFiles: Array<{ path: string; status: string; added: number | null; removed: number | null }>;
  /** Bounded excerpts of the verified diff. */
  diffExcerpt: string;
  checks: Array<{ checkId: string; required: boolean; status: string }>;
  exceptions: string[];
  verificationResult: string;
  implementationModel: string;
}

const MAX_DIFF_CHARS = 8_000;
const MAX_FILE_DIFF_CHARS = 2_500;

/** Truncates a unified diff per file and overall, keeping hunk headers. */
export function excerptDiff(diff: string, maxTotal = MAX_DIFF_CHARS, maxPerFile = MAX_FILE_DIFF_CHARS): string {
  const files = diff.split(/(?=^diff --git )/m).filter((f) => f.trim().length > 0);
  const parts: string[] = [];
  let total = 0;
  for (const file of files) {
    const piece = file.length > maxPerFile ? `${file.slice(0, maxPerFile)}\n… [diff truncated]\n` : file;
    if (total + piece.length > maxTotal) {
      parts.push(`… [${files.length - parts.length} more file diffs omitted]\n`);
      break;
    }
    parts.push(piece);
    total += piece.length;
  }
  return parts.join('');
}

export function issueReferenceFor(task: Pick<NormalizedTask, 'sourceType' | 'sourceRef' | 'taskKey' | 'repository'>, targetRepository: string | null): string {
  if (task.sourceType === 'github') {
    const number = task.taskKey.replace(/^GH-/, '');
    return task.repository && task.repository === targetRepository ? `Closes #${number}` : `Refs ${task.repository}#${number}`;
  }
  if (task.sourceType === 'linear') return `Refs ${task.taskKey}`;
  return `Contract ${task.taskKey}`;
}

/**
 * The small, verified evidence packet the PR drafter sees (§13 flow step 1). It is built only from
 * the approved contract, the verification report and the reviewed diff — never from model output.
 */
export async function buildEvidencePacket(harness: Harness, orchestrator: Orchestrator, runId: string): Promise<EvidencePacket> {
  const run = harness.getRun(runId);
  const contract = harness.approvedContract(run);
  const taskRecord = harness.store.getTask(run.taskId)!;
  const task = JSON.parse(taskRecord.snapshotJson) as NormalizedTask;
  const report = orchestrator.latestVerification(run.runId);
  if (!report) throw new Error('run has no verification report');
  const diff = await harness.worktrees.diff(run.worktreePath!, run.baselineSha!);
  const review = harness.store.decisionsForRun(run.runId).filter((d) => d.kind === 'review').at(-1);
  const acknowledged = review ? ((JSON.parse(review.answerJson) as { acknowledgedUnverified?: string[] }).acknowledgedUnverified ?? []) : [];
  const exceptions = [
    ...acknowledged.map((id) => `${id} accepted on manual review without check evidence`),
    ...report.checks.filter((c) => !c.required && c.status !== 'PASS').map((c) => `optional check ${c.checkId} ${c.status}`),
  ];
  return {
    runId: run.runId,
    title: contract.contract.metadata.title,
    goal: contract.contract.spec.goal,
    sourceRef: taskRecord.sourceRef,
    issueUrl: task.url,
    issueReference: issueReferenceFor({ ...task, repository: task.repository }, taskRecord.repository),
    repository: taskRecord.repository,
    contract: { version: contract.version, sha256: contract.sha256 },
    requirements: report.requirements.map((r) => ({ id: r.id, text: r.text, status: r.status, note: r.note })),
    changedFiles: report.changes.map((c) => ({ path: c.path, status: c.status, added: c.added, removed: c.removed })),
    diffExcerpt: excerptDiff(diff),
    checks: report.checks.map((c) => ({ checkId: c.checkId, required: c.required, status: c.status })),
    exceptions,
    verificationResult: report.result,
    implementationModel: run.modelId,
  };
}
