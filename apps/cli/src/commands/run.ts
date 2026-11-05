import { loadPreauthorizedAnswers, isTerminal, type Harness } from '@aperture/core';
import type { RunRecord } from '@aperture/storage';
import { openHarness, type GlobalOptions } from '../context.ts';
import { createExecutor } from '../executors.ts';
import { driveWithUi } from './drive-ui.ts';
import { formatEvent, usd, type TextRenderOptions } from '../render/text.ts';

export interface RunCommandOptions {
  repo?: string;
  model?: string;
  budget?: string;
  cache?: string;
  interactive: boolean;
  reducedSecurity?: boolean;
  yes?: boolean;
  script?: string;
  showModelText?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  filter?: string;
  answers?: string;
  tui?: boolean;
  workspace?: string;
}

export const EXIT = { OK: 0, ERROR: 1, NOT_COMPLETED: 2, WAITING: 3 } as const;

export function exitCodeFor(run: RunRecord): number {
  if (run.state === 'READY_FOR_REVIEW' || run.state === 'COMPLETED_LOCAL' || run.state === 'PR_CREATED') return EXIT.OK;
  if (isTerminal(run.state)) return EXIT.NOT_COMPLETED;
  return EXIT.WAITING;
}

export function attachRenderer(harness: Harness, options: TextRenderOptions & { quiet?: boolean }): () => void {
  if (options.quiet) return () => undefined;
  return harness.events.subscribe((event) => {
    const line = formatEvent(event, { ...options, color: options.color ?? Boolean(process.stdout.isTTY) });
    if (line !== null) process.stdout.write(`${line}\n`);
  });
}

export function renderOptions(opts: { verbose?: boolean; showModelText?: boolean; quiet?: boolean; filter?: string }): TextRenderOptions & { quiet?: boolean } {
  return {
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
    ...(opts.showModelText !== undefined ? { showModelText: opts.showModelText } : {}),
    ...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
    ...(opts.filter ? { filters: opts.filter.split(',').map((f) => f.trim()).filter(Boolean) } : {}),
  };
}

export function printSummary(harness: Harness, run: RunRecord): void {
  const spent = harness.store.spentUsd(run.runId);
  const lines = [`\nRUN ${run.runId}  STATE ${run.state}  MODEL ${run.modelId}  SPENT ${usd(spent)}`];
  if (run.terminalReason) lines.push(`reason: ${run.terminalReason}`);
  const open = harness.store.questionsForRun(run.runId, 'open');
  for (const q of open) lines.push(`open ${q.kind === 'question' ? 'question' : 'scope request'} ${q.questionId}: answer with \`aperture answer ${run.runId} ${q.questionId}\``);
  if (run.state === 'READY_FOR_REVIEW') lines.push(`next: \`aperture review ${run.runId}\` or \`aperture pr draft ${run.runId}\``);
  if (!isTerminal(run.state) && run.state !== 'READY_FOR_REVIEW' && open.length === 0) lines.push(`resume with \`aperture resume ${run.runId}\``);
  process.stdout.write(`${lines.join('\n')}\n`);
}

export async function runCommand(reference: string, opts: RunCommandOptions, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  try {
    const budgetUsd = opts.budget !== undefined ? Number(opts.budget) : undefined;
    if (budgetUsd !== undefined && !(budgetUsd > 0)) throw new Error(`--budget must be a positive number of USD, got ${opts.budget}`);
    if (opts.cache !== undefined && opts.cache !== '5m' && opts.cache !== '1h' && opts.cache !== 'off') throw new Error('--cache must be 5m, 1h or off');
    const executor = createExecutor(harness, { ...(opts.script ? { script: opts.script } : {}) });
    const preauthorized = opts.answers ? loadPreauthorizedAnswers(opts.answers) : undefined;
    if (opts.workspace !== undefined && opts.workspace !== 'in-place' && opts.workspace !== 'worktree') throw new Error('--workspace must be in-place or worktree');
    const run = await harness.ingest(reference, {
      ...(opts.repo ? { repoPath: opts.repo } : {}),
      cwd: process.cwd(),
      questionMode: opts.interactive ? 'interactive' : 'noninteractive',
      ...(opts.reducedSecurity ? { isolation: 'reduced' as const } : {}),
      ...(opts.workspace ? { workspace: opts.workspace as 'in-place' | 'worktree' } : {}),
      overrides: {
        ...(opts.model ? { model: opts.model } : {}),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...(opts.cache === 'off' ? { cacheEnabled: false } : opts.cache ? { cacheTtl: opts.cache as '5m' | '1h', cacheEnabled: true } : {}),
      },
    });
    const task = harness.store.getTask(run.taskId)!;
    if (!opts.tui && !opts.quiet) {
      // Replay what ingestion already logged so the stream starts with the run header.
      for (const event of harness.events.list(run.runId)) {
        const line = formatEvent(event, { ...renderOptions(opts), color: Boolean(process.stdout.isTTY) });
        if (line !== null) process.stdout.write(`${line}\n`);
      }
    }
    const final = await driveWithUi(harness, run.runId, {
      executor,
      interactive: opts.interactive,
      // A local contract file is the operator's own artifact: with --no-interactive it is preapproved.
      preapproveContract: Boolean(opts.yes) || (task.sourceType === 'local' && !opts.interactive),
      ...(opts.tui ? { tui: true } : {}),
      ...(preauthorized ? { preauthorized } : {}),
      render: renderOptions(opts),
      mode: 'drive',
    });
    printSummary(harness, final);
    return exitCodeFor(final);
  } finally {
    harness.close();
  }
}
