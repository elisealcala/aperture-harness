import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@aperture/contracts';
import type { RunRecord } from '@aperture/storage';
import { verifyRun, failureFeedback, type AppliedPatch, type VerificationReport } from '@aperture/verifier';
import type { Executor, ExecutorOutcome } from './executor.ts';
import { HarnessError, type Harness } from './harness.ts';
import type { Interaction } from './interaction.ts';
import { findPreauthorized, PauseService, type PreauthorizedAnswer } from './pauses.ts';
import { renderReport, usageTotals } from './report.ts';
import { isTerminal } from './state-machine.ts';

export interface DriveOptions {
  executor: Executor;
  interaction: Interaction;
  signal?: AbortSignal;
  /** Answers authorized ahead of time for noninteractive runs (`--answers`). */
  preauthorized?: readonly PreauthorizedAnswer[];
}

/**
 * Advances a run through the state machine until it reaches a state that needs an explicit user
 * command (review, PR), an unanswered pause, a terminal state, or an interruption.
 */
export class Orchestrator {
  readonly pauses: PauseService;

  constructor(protected readonly harness: Harness) {
    this.pauses = new PauseService(harness);
  }

  async drive(runId: string, options: DriveOptions): Promise<RunRecord> {
    const signal = options.signal ?? new AbortController().signal;
    try {
      for (;;) {
        const run = this.harness.getRun(runId);
        if (isTerminal(run.state) || signal.aborted) return run;
        switch (run.state) {
          case 'INGESTING':
            this.harness.transition(runId, 'FAILED', 'ingestion did not complete');
            break;
          case 'NEEDS_CONTRACT_REVIEW':
            if (!(await this.reviewContract(run, options.interaction))) return this.harness.getRun(runId);
            break;
          case 'PREPARING':
            await this.harness.prepare(runId);
            break;
          case 'EXECUTING':
            if ((await this.execute(run, options, signal)) === 'stop') return this.harness.getRun(runId);
            break;
          case 'WAITING_FOR_USER':
            if ((await this.resolveQuestions(run, options)) === 'waiting') return this.harness.getRun(runId);
            break;
          case 'VERIFYING':
            await this.verify(run);
            break;
          default:
            return run;
        }
      }
    } finally {
      this.finalize(runId);
    }
  }

  /** Continues an interrupted or paused run from its persisted state (AT-06, AT-07). */
  async resume(runId: string, options: DriveOptions): Promise<RunRecord> {
    const run = this.harness.getRun(runId);
    if (isTerminal(run.state)) return run;
    await this.harness.assertWorkspaceBranch(run);
    const { rebuilt } = this.harness.events.syncProjection(run.runId);
    if (run.state === 'EXECUTING' && run.executingSince) {
      // Do not count the time the process was down against the wall-clock limit.
      const lastEvent = this.harness.events.list(run.runId).at(-1);
      const until = lastEvent ? Math.max(Date.parse(lastEvent.timestamp), Date.parse(run.executingSince)) : Date.parse(run.executingSince);
      this.harness.store.updateRun(run.runId, { executingMs: run.executingMs + (until - Date.parse(run.executingSince)), executingSince: new Date().toISOString() });
    }
    const dangling = this.harness.store.toolOpsForRun(run.runId, 'started').map((op) => op.opId);
    this.harness.emit(run.runId, 'run.resumed', { state: run.state, projectionRebuilt: rebuilt, danglingOperations: dangling });
    // Report (never apply) source ticket drift since the snapshot was pinned.
    await this.harness.checkSourceDrift(run.runId);
    return this.drive(run.runId, options);
  }

  /** Returns false when the contract is still awaiting a decision. */
  protected async reviewContract(run: RunRecord, interaction: Interaction): Promise<boolean> {
    const pending = this.harness.pendingProposal(run.runId);
    if (!pending) {
      this.harness.transition(run.runId, 'CANCELED', 'no contract proposal to review');
      return true;
    }
    const decision = await interaction.reviewContract({
      runId: run.runId,
      version: pending.record.version,
      contract: pending.contract,
      yaml: this.harness.contractYaml(pending.contract),
      sha256: pending.record.sha256,
      findings: this.harness.analyze(pending.contract),
      notes: (this.harness.events.list(run.runId, { types: ['contract.proposed'] }).at(-1)?.payload.notes as string[] | undefined) ?? [],
    });
    if (!decision) return false;
    switch (decision.action) {
      case 'approve':
        this.harness.approvePending(run.runId, interaction.actor);
        this.harness.transition(run.runId, 'PREPARING', 'contract approved');
        return true;
      case 'reject':
        this.harness.rejectPending(run.runId, decision.reason ?? 'rejected by user');
        this.harness.transition(run.runId, 'CANCELED', `contract rejected${decision.reason ? `: ${decision.reason}` : ''}`);
        return true;
      case 'edit':
        this.harness.proposeContract(run.runId, decision.contract, ['edited by user']);
        return true;
    }
  }

  protected async execute(run: RunRecord, options: DriveOptions, signal: AbortSignal): Promise<'continue' | 'stop'> {
    const contract = this.harness.approvedContract(run);
    const gateway = this.harness.createGateway(run, contract);
    const outcome = await options.executor.run({ harness: this.harness, run, contract, gateway, signal });
    return this.applyOutcome(run, outcome, options);
  }

  protected async applyOutcome(run: RunRecord, outcome: ExecutorOutcome, options: DriveOptions): Promise<'continue' | 'stop'> {
    switch (outcome.type) {
      case 'candidate':
        this.harness.transition(run.runId, 'VERIFYING', 'candidate implementation produced', outcome.summary ? { summary: outcome.summary.slice(0, 2000) } : {});
        return 'continue';
      case 'paused': {
        const pause = outcome.pause;
        if (pause.type === 'blocked') {
          this.harness.transition(run.runId, 'BLOCKED', `AGENT_REPORTED_BLOCKED: ${pause.reason}`);
          return 'stop';
        }
        const question = this.pauses.record(run.runId, pause);
        const preauth = pause.type === 'question' ? findPreauthorized(pause.question, options.preauthorized ?? []) : undefined;
        if (preauth) {
          this.pauses.answer(run.runId, question.questionId, { answer: preauth.answer }, 'preauthorized');
          return 'continue';
        }
        if (!options.interaction.interactive) {
          // Never answer from model preference: without a person or a preauthorized answer, stop (AT-16).
          const what = pause.type === 'question' ? `question ${question.questionId}: ${pause.question}` : `scope change ${question.questionId}: ${pause.additionalPaths.join(', ')}`;
          this.harness.transition(run.runId, 'BLOCKED', `NEEDS_USER_DECISION (noninteractive) — ${what}`);
          return 'stop';
        }
        this.harness.transition(run.runId, 'WAITING_FOR_USER', `${pause.type} ${question.questionId} pending`);
        return 'continue';
      }
      case 'blocked':
        this.harness.transition(run.runId, 'BLOCKED', `${outcome.code}: ${outcome.reason}`);
        return 'stop';
      case 'failed':
        this.harness.transition(run.runId, 'FAILED', outcome.reason);
        return 'stop';
      case 'interrupted':
        return 'stop';
    }
  }

  /** Asks the user (or applies preauthorized answers) for every open question. */
  protected async resolveQuestions(run: RunRecord, options: DriveOptions): Promise<'resumed' | 'waiting'> {
    for (const { record, payload } of this.pauses.open(run.runId)) {
      if (payload.type === 'question') {
        const preauth = findPreauthorized(payload.question, options.preauthorized ?? []);
        if (preauth) {
          this.pauses.answer(run.runId, record.questionId, { answer: preauth.answer }, 'preauthorized');
          continue;
        }
        if (!options.interaction.interactive) return 'waiting';
        const answer = await options.interaction.askQuestion({ runId: run.runId, questionId: record.questionId, question: payload.question, choices: payload.choices, reason: payload.reason, requirementIds: payload.requirementIds });
        if (!answer) return 'waiting';
        this.pauses.answer(run.runId, record.questionId, answer, options.interaction.actor);
      } else {
        if (!options.interaction.interactive) return 'waiting';
        const contract = this.harness.approvedContract(run);
        const decision = await options.interaction.decideScopeChange({ runId: run.runId, questionId: record.questionId, reason: payload.reason, additionalPaths: payload.additionalPaths, currentWritable: contract.contract.spec.scope.writable });
        if (!decision) return 'waiting';
        this.pauses.decideScope(run.runId, record.questionId, decision, options.interaction.actor);
      }
    }
    this.harness.transition(run.runId, 'EXECUTING', 'clarification recorded');
    return 'resumed';
  }

  appliedPatches(runId: string): AppliedPatch[] {
    return this.harness.store
      .toolOpsForRun(runId, 'applied')
      .filter((op) => op.tool === 'propose_patch')
      .map((op) => {
        const input = JSON.parse(op.inputJson) as { path: string; requirementIds: string[] };
        return { opId: op.opId, path: input.path, requirementIds: input.requirementIds };
      });
  }

  /** Independent verification with a bounded, stall-aware fix loop (§12, AT-08, AT-09). */
  protected async verify(run: RunRecord): Promise<VerificationReport> {
    const contract = this.harness.approvedContract(run);
    const gateway = this.harness.createGateway(run, contract);
    const attempt = this.harness.store.incrementRunCounter(run.runId, 'verification_attempts');
    this.harness.emit(run.runId, 'verification.started', { attempt });
    const report = await verifyRun({
      attempt,
      contract,
      gateway,
      worktrees: this.harness.worktrees,
      worktreePath: run.worktreePath!,
      baselineSha: run.baselineSha!,
      appliedPatches: this.appliedPatches(run.runId),
      isolation: this.harness.isolationMode(run),
    });
    this.harness.writeArtifact(run.runId, 'verification.json', `${JSON.stringify(report, null, 2)}\n`, 'verification');
    this.harness.writeArtifact(run.runId, 'proposed.patch', await this.harness.worktrees.diff(run.worktreePath!, run.baselineSha!), 'patch');
    this.harness.emit(run.runId, 'verification.completed', {
      attempt,
      result: report.result,
      summary: report.summary,
      diffSha256: report.diffSha256,
      requirements: report.requirements.map((r) => ({ id: r.id, status: r.status })),
      checks: report.checks.map((c) => ({ checkId: c.checkId, status: c.status })),
      violations: report.violations,
    });

    const limits = contract.contract.spec.limits;
    switch (report.result) {
      case 'PASS':
        this.harness.transition(run.runId, 'READY_FOR_REVIEW', 'all mandatory checks passed and every requirement has evidence');
        break;
      case 'UNVERIFIED':
        this.harness.transition(run.runId, 'READY_FOR_REVIEW', `checks passed; ${report.summary} (manual review required)`);
        break;
      case 'BLOCKED':
        this.harness.transition(run.runId, 'BLOCKED', `SCOPE_VIOLATION: ${report.summary}`);
        break;
      case 'FAIL': {
        const fresh = this.harness.getRun(run.runId);
        if (attempt >= limits.maxVerificationAttempts) {
          this.harness.transition(run.runId, 'BLOCKED', `VERIFICATION_FAILED after ${attempt} attempts: ${report.summary}`);
        } else if (report.failureSignature && report.failureSignature === fresh.lastFailureSignature) {
          this.harness.transition(run.runId, 'BLOCKED', `STALLED: identical failure repeated (${report.summary})`);
        } else {
          this.harness.store.transaction(() => {
            this.harness.store.updateRun(run.runId, { lastFailureSignature: report.failureSignature });
            // Feedback joins the persisted conversation so a crash cannot lose it.
            const conversation = this.harness.store.loadConversation(run.runId);
            if (conversation.at(-1)?.role === 'assistant') this.harness.store.appendConversation(run.runId, 'user', JSON.stringify(failureFeedback(report)));
            this.harness.transition(run.runId, 'EXECUTING', `bounded fix ${attempt}/${limits.maxVerificationAttempts}: ${report.summary}`);
          });
        }
        break;
      }
    }
    return report;
  }

  latestVerification(runId: string): VerificationReport | undefined {
    const path = join(this.harness.layout.runDir(runId), 'verification.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as VerificationReport) : undefined;
  }

  /**
   * Records human acceptance of the exact verified diff (§12 step 6). Fails if the worktree changed
   * since verification; unverified requirements must be acknowledged explicitly.
   */
  async approveReview(runId: string, actor: string, options: { acceptLocal: boolean; acknowledgedUnverified?: readonly string[] }): Promise<RunRecord> {
    const run = this.harness.getRun(runId);
    if (run.state !== 'READY_FOR_REVIEW') throw new HarnessError(`run is ${run.state}, not READY_FOR_REVIEW`, 'NOT_READY');
    const report = this.latestVerification(run.runId);
    if (!report) throw new HarnessError('run has no verification report', 'NOT_VERIFIED');
    const diffSha = sha256Hex(await this.harness.worktrees.diff(run.worktreePath!, run.baselineSha!));
    if (diffSha !== report.diffSha256) throw new HarnessError('the worktree changed after verification; resume the run to re-verify before review', 'DIFF_CHANGED');
    const unverified = report.requirements.filter((r) => r.status !== 'VERIFIED').map((r) => r.id);
    const missing = unverified.filter((id) => !(options.acknowledgedUnverified ?? []).includes(id));
    if (missing.length > 0) throw new HarnessError(`unverified requirements need explicit acknowledgement: ${missing.join(', ')}`, 'UNVERIFIED');
    const contract = this.harness.approvedContract(run);
    const now = new Date().toISOString();
    this.harness.store.transaction(() => {
      this.harness.store.insertDecision({
        decisionId: this.harness.newDecisionId(),
        runId,
        questionId: null,
        kind: 'review',
        answerJson: JSON.stringify({ diffSha256: diffSha, acceptLocal: options.acceptLocal, acknowledgedUnverified: unverified, verificationAttempt: report.attempt }),
        actor,
        contractVersion: contract.version,
        createdAt: now,
      });
      this.harness.store.updateRun(runId, { reviewDiffSha256: diffSha, reviewApprovedAt: now });
      this.harness.emit(runId, 'review.approved', { actor, diffSha256: diffSha, acceptLocal: options.acceptLocal, acknowledgedUnverified: unverified });
      if (options.acceptLocal) this.harness.transition(runId, 'COMPLETED_LOCAL', `accepted locally by ${actor}`);
    });
    this.finalize(runId);
    return this.harness.getRun(runId);
  }

  /** Refreshes report.md and usage.json (cheap; safe to call repeatedly). */
  finalize(runId: string): void {
    try {
      const report = this.latestVerification(runId);
      this.harness.writeArtifact(runId, 'usage.json', `${JSON.stringify({ requests: this.harness.store.usageForRun(runId), totals: usageTotals(this.harness, runId) }, null, 2)}\n`, 'usage');
      this.harness.writeArtifact(runId, 'report.md', renderReport(this.harness, runId, report), 'report');
    } catch {
      // Reports are projections; failing to write one must not mask the run's real outcome.
    }
  }
}
