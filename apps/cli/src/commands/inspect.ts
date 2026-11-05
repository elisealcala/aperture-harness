import { setTimeout as sleep } from 'node:timers/promises';
import { isTerminal } from '@aperture/core';
import { openHarness, type GlobalOptions } from '../context.ts';
import { colorDiff, createStyle } from '../render/style.ts';
import { formatTimestamped, usd } from '../render/text.ts';
import { renderOptions } from './run.ts';

export async function statusCommand(runId: string | undefined, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  try {
    if (!runId) {
      const runs = harness.store.listRuns(20);
      if (runs.length === 0) {
        process.stdout.write('no runs yet\n');
        return 0;
      }
      for (const run of runs) {
        const task = harness.store.getTask(run.taskId);
        process.stdout.write(`${run.runId}  ${run.state.padEnd(22)} ${usd(harness.store.spentUsd(run.runId)).padStart(7)}  ${task?.title ?? ''}\n`);
      }
      return 0;
    }
    const run = harness.getRun(runId);
    const task = harness.store.getTask(run.taskId)!;
    const contract = run.contractId ? harness.store.getContract(run.contractId) : undefined;
    const lines = [
      `RUN       ${run.runId}`,
      `STATE     ${run.state}${run.terminalReason ? ` — ${run.terminalReason}` : ''}`,
      `TASK      ${task.title} (${task.sourceRef})`,
      `MODEL     ${run.modelId}`,
      `CONTRACT  ${contract ? `v${contract.version} sha256:${contract.sha256.slice(0, 16)} approved by ${contract.approvedBy}` : 'not approved'}`,
      `REPO      ${run.repoPath}`,
      `WORKSPACE ${run.workspace} ${run.worktreePath ?? '-'} (${run.branch ?? '-'})`,
      `BASELINE  ${run.baselineRef} ${run.baselineSha?.slice(0, 12) ?? ''}`,
      `ISOLATION ${run.isolation}    QUESTIONS ${run.questionMode}`,
      `COUNTERS  turns ${run.turns}  patches ${run.patchAttempts}  verifications ${run.verificationAttempts}`,
      `SPENT     implementation ${usd(harness.store.spentUsd(run.runId, 'implementation'))}  pr ${usd(harness.store.spentUsd(run.runId, 'pr_draft'))}`,
    ];
    for (const q of harness.store.questionsForRun(run.runId, 'open')) {
      const payload = JSON.parse(q.payloadJson) as { question?: string; additionalPaths?: string[] };
      lines.push(`OPEN      ${q.questionId} ${q.kind}: ${payload.question ?? payload.additionalPaths?.join(', ') ?? ''}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    harness.close();
  }
}

export interface LogsOptions {
  format: string;
  follow?: boolean;
  verbose?: boolean;
  showModelText?: boolean;
  filter?: string;
}

export async function logsCommand(runId: string, opts: LogsOptions, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  try {
    const run = harness.getRun(runId);
    if (opts.format !== 'text' && opts.format !== 'jsonl') throw new Error('--format must be text or jsonl');
    const render = renderOptions(opts);
    let after = 0;
    for (;;) {
      for (const event of harness.events.list(run.runId, { afterSequence: after })) {
        after = event.sequence;
        if (render.filters && !render.filters.some((f) => event.type.startsWith(f))) continue;
        if (opts.format === 'jsonl') process.stdout.write(`${JSON.stringify(event)}\n`);
        else {
          const line = formatTimestamped(event, { ...render, color: Boolean(process.stdout.isTTY) });
          if (line !== null) process.stdout.write(`${line}\n`);
        }
      }
      if (!opts.follow || isTerminal(harness.getRun(run.runId).state)) return 0;
      await sleep(500);
    }
  } finally {
    harness.close();
  }
}

export async function diffCommand(runId: string, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  try {
    const run = harness.getRun(runId);
    if (!run.worktreePath || !run.baselineSha) {
      process.stdout.write('run has no worktree yet\n');
      return 0;
    }
    const diff = await harness.worktrees.diff(run.worktreePath, run.baselineSha);
    process.stdout.write(diff.length > 0 ? `${colorDiff(createStyle(), diff)}${diff.endsWith('\n') ? '' : '\n'}` : 'no changes\n');
    return 0;
  } finally {
    harness.close();
  }
}
