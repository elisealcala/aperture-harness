import type { RunRecord } from '@aperture/storage';
import type { Executor, ExecutorOutcome } from './executor.ts';
import type { Harness } from './harness.ts';
import type { Interaction } from './interaction.ts';
import { isTerminal } from './state-machine.ts';

export interface DriveOptions {
  executor: Executor;
  interaction: Interaction;
  signal?: AbortSignal;
}

/**
 * Advances a run through the state machine until it reaches a state that needs an explicit
 * user command (review, PR), a pause, a terminal state, or an interruption.
 */
export class Orchestrator {
  constructor(protected readonly harness: Harness) {}

  async drive(runId: string, options: DriveOptions): Promise<RunRecord> {
    const signal = options.signal ?? new AbortController().signal;
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
        case 'EXECUTING': {
          const outcome = await this.execute(run, options, signal);
          if (outcome === 'stop') return this.harness.getRun(runId);
          break;
        }
        case 'VERIFYING':
          await this.verify(run, options, signal);
          break;
        default:
          return run;
      }
    }
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

  protected async execute(run: RunRecord, options: DriveOptions, signal: AbortSignal, verificationFeedback?: string): Promise<'continue' | 'stop'> {
    const contract = this.harness.approvedContract(run);
    const gateway = this.harness.createGateway(run, contract);
    const outcome = await options.executor.run({
      harness: this.harness,
      run,
      contract,
      gateway,
      signal,
      ...(verificationFeedback ? { verificationFeedback } : {}),
    });
    return this.applyOutcome(run, outcome, options);
  }

  protected async applyOutcome(run: RunRecord, outcome: ExecutorOutcome, _options: DriveOptions): Promise<'continue' | 'stop'> {
    switch (outcome.type) {
      case 'candidate':
        this.harness.transition(run.runId, 'VERIFYING', outcome.summary ?? 'candidate implementation produced');
        return 'continue';
      case 'paused':
        this.harness.transition(run.runId, 'WAITING_FOR_USER', `${outcome.pause.type} pending`);
        return 'stop';
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

  /** Phase 1 verification: every changed path authorized and every required check passing. */
  protected async verify(run: RunRecord, _options: DriveOptions, _signal: AbortSignal): Promise<void> {
    const contract = this.harness.approvedContract(run);
    const gateway = this.harness.createGateway(run, contract);
    const attempt = this.harness.store.incrementRunCounter(run.runId, 'verification_attempts');
    this.harness.emit(run.runId, 'verification.started', { attempt });
    const changes = await this.harness.worktrees.nameStatus(run.worktreePath!, run.baselineSha!);
    const unauthorized = changes.filter((c) => !gateway.policy.writable(c.path)).map((c) => c.path);
    const results = [];
    for (const check of contract.contract.spec.checks.filter((c) => c.required)) {
      results.push(await gateway.runCheck(check.id, attempt));
    }
    const failed = results.filter((r) => r.status !== 'PASS');
    const result = unauthorized.length > 0 ? 'BLOCKED' : failed.length > 0 ? 'FAIL' : 'PASS';
    this.harness.emit(run.runId, 'verification.completed', { attempt, result, unauthorized, checks: results.map((r) => ({ checkId: r.checkId, status: r.status })) });
    if (result === 'PASS') this.harness.transition(run.runId, 'READY_FOR_REVIEW', 'all mandatory checks passed');
    else this.harness.transition(run.runId, 'BLOCKED', result === 'BLOCKED' ? `unauthorized changes: ${unauthorized.join(', ')}` : `failed checks: ${failed.map((f) => f.checkId).join(', ')}`);
  }
}
