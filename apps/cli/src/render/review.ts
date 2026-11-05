import { usageTotals, type Harness } from '@aperture/core';
import type { VerificationReport } from '@aperture/verifier';
import { banner, createStyle, heading, wrap, type Style, type StyleName } from './style.ts';

const RESULT_COLOR: Record<string, StyleName> = { PASS: 'green', UNVERIFIED: 'yellow', FAIL: 'red', BLOCKED: 'red' };
const REQUIREMENT_MARK: Record<string, [string, StyleName]> = { VERIFIED: ['✓', 'green'], UNVERIFIED: ['~', 'yellow'], FAILED: ['✗', 'red'] };
const CHECK_MARK: Record<string, [string, StyleName]> = { PASS: ['✓', 'green'], FAIL: ['✗', 'red'], ERROR: ['✗', 'red'], TIMEOUT: ['⏱', 'red'] };

function usd(v: number): string {
  return `$${v.toFixed(4)}`;
}

/**
 * Terminal view of the verification evidence a reviewer needs before accepting a diff: result,
 * requirement matrix, changed files, checks, scope violations, denied actions, cost and risks.
 */
export function formatReview(harness: Harness, runId: string, report: VerificationReport, style: Style = createStyle()): string {
  const run = harness.getRun(runId);
  const task = harness.store.getTask(run.taskId)!;
  const contract = run.contractId ? harness.store.getContract(run.contractId) : undefined;
  const w = style.width;
  const out: string[] = [];
  const resultColor = RESULT_COLOR[report.result] ?? 'yellow';

  out.push(
    banner(style, `Review · ${run.runId}`, [
      style('bold', wrap(task.title, w - 6, 2)),
      `${style('gray', 'state')} ${style('bold', run.state)}   ${style('gray', 'workspace')} ${run.workspace} ${run.branch ?? ''}   ${style('gray', 'contract')} v${contract?.version ?? '?'} ${style('dim', (contract?.sha256 ?? '').slice(0, 12))}`,
      `${style('gray', 'verification')} ${style([resultColor, 'bold'], report.result)} ${style('gray', `(attempt ${report.attempt})`)} — ${wrap(report.summary, w - 30, 4)}`,
    ]),
  );

  out.push('', heading(style, 'REQUIREMENTS'));
  for (const r of report.requirements) {
    const [mark, color] = REQUIREMENT_MARK[r.status] ?? ['?', 'gray'];
    out.push(`  ${style([color, 'bold'], `${mark} ${r.id.padEnd(4)}`)} ${style(color, r.status.padEnd(10))} ${wrap(r.text, w - 22, 20)}`);
    out.push(`  ${' '.repeat(18)}${style('gray', wrap(r.note, w - 22, 20))}`);
  }

  const added = report.changes.reduce((n, c) => n + (c.added ?? 0), 0);
  const removed = report.changes.reduce((n, c) => n + (c.removed ?? 0), 0);
  out.push('', heading(style, 'CHANGES', `${style('gray', `(${report.changes.length} files,`)} ${style('green', `+${added}`)} ${style('red', `−${removed}`)}${style('gray', ')')}`));
  if (report.changes.length === 0) out.push(`  ${style('gray', 'no changes')}`);
  for (const c of report.changes) {
    const status = c.status.startsWith('A') ? style('green', 'A') : c.status.startsWith('D') ? style('red', 'D') : style('yellow', c.status[0] ?? '?');
    out.push(`  ${status}  ${c.path.padEnd(Math.min(60, w - 24))} ${style('green', `+${c.added ?? 'bin'}`.padStart(6))} ${style('red', `−${c.removed ?? 'bin'}`.padStart(6))}`);
  }

  out.push('', heading(style, 'CHECKS'));
  if (report.checks.length === 0) out.push(`  ${style('yellow', '▲ no checks ran')}`);
  for (const c of report.checks) {
    const [mark, color] = CHECK_MARK[c.status] ?? ['?', 'gray'];
    out.push(`  ${style(color, mark)} ${style('bold', c.checkId.padEnd(16))} ${style(color, c.status.padEnd(8))} ${style('gray', `exit ${c.exitCode ?? '-'} · ${(c.durationMs / 1000).toFixed(1)}s${c.required ? '' : ' · optional'}`)}`);
  }

  if (report.violations.length > 0) {
    out.push('', heading(style, style('red', 'SCOPE VIOLATIONS')));
    for (const v of report.violations) out.push(`  ${style(['red', 'bold'], '✗')} ${v.path} ${style('red', v.code)} ${style('gray', v.detail)}`);
  }

  const rejected = harness.events.list(run.runId, { types: ['tool.rejected', 'network.denied'] });
  if (rejected.length > 0) {
    out.push('', heading(style, 'DENIED ACTIONS', style('gray', `(${rejected.length})`)));
    for (const e of rejected.slice(-10)) {
      const p = e.payload as Record<string, unknown>;
      const what = e.type === 'network.denied' ? `egress ${String(p.host)}:${String(p.port)}` : `${String(p.name)} ${String(p.path ?? '')}`;
      out.push(`  ${style('red', '!')} ${what.trim()} ${style('red', String(p.reasonCode ?? p.reason ?? ''))}`);
    }
    if (rejected.length > 10) out.push(`  ${style('gray', `… ${rejected.length - 10} more in \`aperture logs ${run.runId} --filter tool.rejected\``)}`);
  }

  const decisions = harness.store.decisionsForRun(run.runId);
  if (decisions.length > 0) {
    out.push('', heading(style, 'DECISIONS'));
    for (const d of decisions) out.push(`  ${style('cyan', d.kind.padEnd(13))} ${style('gray', d.actor)} ${wrap(d.answerJson, w - 40, 16)}`);
  }

  out.push('', heading(style, 'COST'));
  for (const t of usageTotals(harness, run.runId)) {
    const prompt = t.input + t.cacheWrite + t.cacheRead;
    const hit = prompt > 0 ? `${((t.cacheRead / prompt) * 100).toFixed(0)}% cache hit` : 'no cache';
    out.push(`  ${t.phase.padEnd(15)} ${style('bold', usd(t.costUsd))}  ${style('gray', `${t.requests} requests · ${t.modelIds.join(', ')} · ${hit}`)}`);
  }

  const risks = report.requirements.filter((r) => r.status !== 'VERIFIED');
  out.push('', heading(style, 'RISKS'));
  for (const r of risks) out.push(`  ${style('yellow', '▲')} ${r.id} ${r.status}: ${style('gray', r.note)}`);
  out.push(`  ${style('yellow', '▲')} ${style('gray', 'passing checks do not prove product behavior; read the diff before accepting')}`);
  return out.join('\n');
}
