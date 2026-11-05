import { canTransition, loadPreauthorizedAnswers, Orchestrator, PauseService, renderReport, usageTotals } from '@aperture/core';
import { startTui } from '../tui/index.tsx';
import { driveWithUi } from './drive-ui.ts';
import type { VerificationReport } from '@aperture/verifier';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHarness, type GlobalOptions } from '../context.ts';
import { createExecutor } from '../executors.ts';
import { createInteraction } from '../interaction/factory.ts';
import { defaultActor } from '../interaction/readline.ts';
import { exitCodeFor, printSummary, renderOptions } from './run.ts';
import { usd } from '../render/text.ts';

export interface ResumeOptions {
  script?: string;
  interactive: boolean;
  answers?: string;
  showModelText?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  filter?: string;
  tui?: boolean;
}

export async function resumeCommand(runId: string, opts: ResumeOptions, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  try {
    const run = harness.getRun(runId);
    const executor = createExecutor(harness, { ...(opts.script ? { script: opts.script } : {}) });
    const final = await driveWithUi(harness, run.runId, {
      executor,
      interactive: opts.interactive,
      preapproveContract: false,
      ...(opts.tui ? { tui: true } : {}),
      ...(opts.answers ? { preauthorized: loadPreauthorizedAnswers(opts.answers) } : {}),
      render: renderOptions(opts),
      mode: 'resume',
    });
    printSummary(harness, final);
    return exitCodeFor(final);
  } finally {
    harness.close();
  }
}

export async function attachCommand(runId: string, opts: { showModelText?: boolean }, globals: GlobalOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('attach needs an interactive terminal; use `aperture logs <run-id> --follow` instead');
  const harness = openHarness(globals);
  try {
    const run = harness.getRun(runId);
    const tui = startTui(harness, () => run.runId, { ...(opts.showModelText !== undefined ? { showModelText: opts.showModelText } : {}), onQuit: () => undefined });
    await tui.waitUntilExit();
    return 0;
  } finally {
    harness.close();
  }
}

export interface AnswerOptions {
  answer?: string;
  choice?: string;
  approve?: boolean;
  deny?: boolean;
  rationale?: string;
}

export async function answerCommand(runId: string, questionId: string, words: string[], opts: AnswerOptions, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  try {
    const run = harness.getRun(runId);
    const service = new PauseService(harness);
    const question = service.open(run.runId).find((q) => q.record.questionId === questionId || q.record.questionId.endsWith(questionId));
    if (!question) throw new Error(`no open question ${questionId} on run ${run.runId}`);
    if (run.state !== 'WAITING_FOR_USER') {
      process.stderr.write(`warning: run is ${run.state}; the answer is recorded but the run cannot continue${run.state === 'BLOCKED' ? ' (start a new run with --answers to preauthorize it)' : ''}\n`);
    }
    const actor = defaultActor();
    if (question.payload.type === 'scope_change') {
      if (!opts.approve && !opts.deny) throw new Error('scope requests need --approve or --deny');
      service.decideScope(run.runId, question.record.questionId, { approved: Boolean(opts.approve), ...(opts.rationale ? { rationale: opts.rationale } : {}) }, actor);
      process.stdout.write(`scope request ${opts.approve ? 'approved' : 'denied'}; continue with \`aperture resume ${run.runId}\`\n`);
      return 0;
    }
    let text = opts.answer ?? (words.length > 0 ? words.join(' ') : undefined);
    let choiceIndex: number | undefined;
    if (opts.choice !== undefined) {
      const n = Number(opts.choice);
      const choice = question.payload.choices[n - 1];
      if (!Number.isInteger(n) || !choice) throw new Error(`--choice must be between 1 and ${question.payload.choices.length}`);
      text = choice;
      choiceIndex = n - 1;
    }
    if (!text) {
      const choice = createInteraction({ interactive: true, preapproveContract: false });
      try {
        const answer = await choice.interaction.askQuestion({ runId: run.runId, questionId: question.record.questionId, question: question.payload.question, choices: question.payload.choices, reason: question.payload.reason, requirementIds: question.payload.requirementIds });
        if (!answer) return 3;
        service.answer(run.runId, question.record.questionId, { ...answer, ...(opts.rationale ? { rationale: opts.rationale } : {}) }, actor);
      } finally {
        choice.close();
      }
    } else {
      service.answer(run.runId, question.record.questionId, { answer: text, ...(choiceIndex !== undefined ? { choiceIndex } : {}), ...(opts.rationale ? { rationale: opts.rationale } : {}) }, actor);
    }
    process.stdout.write(`answer recorded; continue with \`aperture resume ${run.runId}\`\n`);
    return 0;
  } finally {
    harness.close();
  }
}

export async function cancelCommand(runId: string, opts: { reason?: string; cleanup?: boolean }, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  try {
    const run = harness.getRun(runId);
    if (!canTransition(run.state, 'CANCELED')) throw new Error(`run in state ${run.state} cannot be canceled`);
    for (const q of harness.store.questionsForRun(run.runId, 'open')) harness.store.setQuestionStatus(q.questionId, 'canceled', new Date().toISOString());
    harness.transition(run.runId, 'CANCELED', opts.reason ?? `canceled by ${defaultActor()}`);
    // In-place runs live in the user's own clone and branch: never delete anything there.
    const removable = opts.cleanup && run.workspace === 'worktree' && run.worktreePath;
    if (removable) await harness.worktrees.remove(run.repoPath, run.worktreePath!, run.branch ?? undefined);
    const note = opts.cleanup && !removable ? ` (in-place run: your branch ${run.branch ?? ''} and working tree were left as they are)` : removable ? ' and worktree removed' : '';
    process.stdout.write(`run ${run.runId} canceled${note}\n`);
    return 0;
  } finally {
    harness.close();
  }
}

export async function usageCommand(runId: string, opts: { format?: string }, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  try {
    const run = harness.getRun(runId);
    const rows = harness.store.usageForRun(run.runId);
    if (opts.format === 'json') {
      process.stdout.write(`${JSON.stringify({ runId: run.runId, requests: rows, totals: usageTotals(harness, run.runId) }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write('PHASE           MODEL               INPUT   OUTPUT  CACHE_W  CACHE_R     COST  EST.MAX\n');
    for (const u of rows) {
      process.stdout.write(
        `${u.phase.padEnd(15)} ${u.modelId.padEnd(18)} ${String(u.input).padStart(6)} ${String(u.output).padStart(8)} ${String(u.cacheWrite).padStart(8)} ${String(u.cacheRead).padStart(8)} ${usd(u.costUsd).padStart(8)} ${u.estimatedUsd !== null ? usd(u.estimatedUsd).padStart(8) : '       -'}\n`,
      );
    }
    for (const t of usageTotals(harness, run.runId)) {
      const promptTokens = t.input + t.cacheWrite + t.cacheRead;
      const hit = promptTokens > 0 ? ((t.cacheRead / promptTokens) * 100).toFixed(1) : '0.0';
      process.stdout.write(`total ${t.phase}: ${t.requests} requests, ${usd(t.costUsd)}, cache hit ${hit}% of prompt tokens\n`);
    }
    return 0;
  } finally {
    harness.close();
  }
}

export interface ReviewOptions {
  acceptLocal?: boolean;
  approve?: boolean;
  acknowledgeUnverified?: boolean;
  reject?: boolean;
}

/** Human review gate (§12 step 6): shows evidence, then records approval of the exact diff. */
export async function reviewCommand(runId: string, opts: ReviewOptions, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  const choice = createInteraction({ interactive: true, preapproveContract: false });
  try {
    const run = harness.getRun(runId);
    const verificationPath = join(harness.layout.runDir(run.runId), 'verification.json');
    if (!existsSync(verificationPath)) throw new Error('run has not been verified yet');
    const report = JSON.parse(readFileSync(verificationPath, 'utf8')) as VerificationReport;
    process.stdout.write(renderReport(harness, run.runId, report));
    if (run.state !== 'READY_FOR_REVIEW') {
      process.stdout.write(`\nrun is ${run.state}; nothing to approve\n`);
      return 0;
    }
    const orchestrator = new Orchestrator(harness);
    if (opts.reject) {
      harness.transition(run.runId, 'CANCELED', `diff rejected in review by ${defaultActor()}`);
      return 2;
    }
    const unverified = report.requirements.filter((r) => r.status !== 'VERIFIED');
    let acknowledge = Boolean(opts.acknowledgeUnverified);
    let decision: 'local' | 'approve' | undefined = opts.acceptLocal ? 'local' : opts.approve ? 'approve' : undefined;
    if (!decision) {
      if (!choice.interaction.interactive) throw new Error('pass --accept-local or --approve (and --acknowledge-unverified if needed) when not on a terminal');
      if (await choice.interaction.confirm('Accept this result locally (COMPLETED_LOCAL)?')) decision = 'local';
      else if (await choice.interaction.confirm('Approve this diff for a pull request?')) decision = 'approve';
      else return 0;
    }
    if (unverified.length > 0 && !acknowledge) {
      acknowledge = choice.interaction.interactive && (await choice.interaction.confirm(`${unverified.map((r) => r.id).join(', ')} are not verified by checks. Accept them on manual review?`));
      if (!acknowledge) throw new Error(`unverified requirements ${unverified.map((r) => r.id).join(', ')} need --acknowledge-unverified`);
    }
    await orchestrator.approveReview(run.runId, defaultActor(), { acceptLocal: decision === 'local', acknowledgedUnverified: unverified.map((r) => r.id) });
    process.stdout.write(decision === 'local' ? `run ${run.runId} completed locally\n` : `diff approved; next: \`aperture pr draft ${run.runId}\`\n`);
    return 0;
  } finally {
    choice.close();
    harness.close();
  }
}
