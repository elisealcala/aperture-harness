import type { VerificationReport } from '@aperture/verifier';
import type { Harness } from './harness.ts';

function usd(v: number): string {
  return `$${v.toFixed(4)}`;
}

export interface UsageTotals {
  phase: string;
  modelIds: string[];
  requests: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number;
}

export function usageTotals(harness: Harness, runId: string): UsageTotals[] {
  const byPhase = new Map<string, UsageTotals>();
  for (const u of harness.store.usageForRun(runId)) {
    const t = byPhase.get(u.phase) ?? { phase: u.phase, modelIds: [], requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 };
    if (!t.modelIds.includes(u.modelId)) t.modelIds.push(u.modelId);
    t.requests++;
    t.input += u.input;
    t.output += u.output;
    t.cacheWrite += u.cacheWrite;
    t.cacheRead += u.cacheRead;
    t.costUsd += u.costUsd;
    byPhase.set(u.phase, t);
  }
  return [...byPhase.values()];
}

/** Human-readable final report (§16). `verification.json` is the machine-readable counterpart. */
export function renderReport(harness: Harness, runId: string, verification?: VerificationReport): string {
  const run = harness.getRun(runId);
  const task = harness.store.getTask(run.taskId)!;
  const contract = run.contractId ? harness.store.getContract(run.contractId) : undefined;
  const publication = harness.store.getPublication(runId);
  const rejected = harness.events.list(runId, { types: ['tool.rejected'] });
  const decisions = harness.store.decisionsForRun(runId);
  const totals = usageTotals(harness, runId);
  const lines: string[] = [
    `# Aperture run ${run.runId}`,
    '',
    `- **State:** ${run.state}${run.terminalReason ? ` — ${run.terminalReason}` : ''}`,
    `- **Task:** ${task.title} (\`${task.sourceRef}\`)`,
    `- **Contract:** ${contract ? `v${contract.version}, sha256 \`${contract.sha256}\`, approved by ${contract.approvedBy}` : 'not approved'}`,
    `- **Implementation model:** ${run.modelId}`,
    `- **Baseline:** \`${run.baselineRef}\` @ \`${run.baselineSha ?? '-'}\``,
    `- **Isolation:** ${run.isolation}${verification ? ` (${verification.isolation})` : ''}`,
    `- **PR:** ${publication?.prUrl ? `${publication.prUrl} (head \`${publication.headSha}\`)` : 'not published'}`,
    '',
  ];
  if (verification) {
    lines.push(`## Verification (attempt ${verification.attempt}): ${verification.result}`, '', verification.summary, '', '### Requirements', '', '| Id | Status | Evidence |', '|---|---|---|');
    for (const r of verification.requirements) lines.push(`| ${r.id} | ${r.status} | ${r.note.replace(/\|/g, '\\|')} |`);
    lines.push('', '### Changed files', '', '| Path | Status | + | - |', '|---|---|---:|---:|');
    for (const c of verification.changes) lines.push(`| \`${c.path}\` | ${c.status} | ${c.added ?? 'bin'} | ${c.removed ?? 'bin'} |`);
    lines.push('', '### Checks', '', '| Check | Required | Status | Exit |', '|---|---|---|---:|');
    for (const c of verification.checks) lines.push(`| ${c.checkId} | ${c.required ? 'yes' : 'no'} | ${c.status} | ${c.exitCode ?? '-'} |`);
    if (verification.violations.length > 0) {
      lines.push('', '### Scope violations', '');
      for (const v of verification.violations) lines.push(`- \`${v.path}\`: ${v.code} — ${v.detail}`);
    }
    lines.push('');
  }
  lines.push('## Denied actions', '');
  if (rejected.length === 0) lines.push('None.');
  for (const e of rejected) {
    const p = e.payload as Record<string, unknown>;
    lines.push(`- ${String(p.name)} ${p.path ? `\`${String(p.path)}\` ` : ''}— ${String(p.reasonCode)}: ${String(p.message ?? '')}`);
  }
  lines.push('', '## Decisions', '');
  if (decisions.length === 0) lines.push('None.');
  for (const d of decisions) lines.push(`- ${d.kind} (${d.actor}, contract v${d.contractVersion}): ${d.answerJson}`);
  lines.push('', '## Usage', '', '| Phase | Models | Requests | Input | Output | Cache write | Cache read | Cost |', '|---|---|---:|---:|---:|---:|---:|---:|');
  for (const t of totals) lines.push(`| ${t.phase} | ${t.modelIds.join(', ')} | ${t.requests} | ${t.input} | ${t.output} | ${t.cacheWrite} | ${t.cacheRead} | ${usd(t.costUsd)} |`);
  lines.push('', `**Total actual cost:** ${usd(totals.reduce((s, t) => s + t.costUsd, 0))}`, '');
  const unverified = verification?.requirements.filter((r) => r.status !== 'VERIFIED') ?? [];
  lines.push('## Remaining risks', '');
  if (unverified.length === 0 && verification) lines.push('- Passing checks do not prove product behavior; human review of the diff is still required.');
  for (const r of unverified) lines.push(`- ${r.id} is ${r.status}: ${r.note}`);
  if (!verification) lines.push('- Run was not verified.');
  return `${lines.join('\n')}\n`;
}
