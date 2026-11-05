import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import {
  analyzeContract,
  approveContract,
  contractDigest,
  parseContract,
  restoreApprovedContract,
  sha256Hex,
  type ApprovedContract,
  type CacheTtl,
  type ContractFinding,
  type ExecutionContract,
  type UserConfig,
} from '@aperture/contracts';
import { EventStore, type EventType } from '@aperture/events';
import { ToolGateway } from '@aperture/gateway';
import { defaultHiddenPaths, gitStdout, resolveIsolation, SandboxRunner, WorktreeManager, type IsolationMode } from '@aperture/sandbox';
import { snapshotTask, taskContentDigest, type NormalizedTask } from '@aperture/sources';
import { ApertureStore, newId, StorageLayout, ulid, type ContractRecord, type RunRecord, type RunState } from '@aperture/storage';
import { SourceRegistry } from './sources.ts';
import { assertTransition, isTerminal } from './state-machine.ts';

export interface HarnessOptions {
  config: UserConfig;
  storageDir: string;
  env?: NodeJS.ProcessEnv;
  sources?: SourceRegistry;
  /** Secret values to scrub from every persisted event (e.g. resolved API keys). */
  redactLiterals?: readonly string[];
  /** Additional files/directories sandboxed checks must not read (e.g. env files with secrets). */
  extraHiddenPaths?: readonly string[];
}

export interface IngestOptions {
  repoPath?: string;
  questionMode?: 'interactive' | 'noninteractive';
  isolation?: 'required' | 'reduced';
  workspace?: 'in-place' | 'worktree';
  overrides?: {
    model?: string;
    budgetUsd?: number;
    cacheTtl?: CacheTtl;
    cacheEnabled?: boolean;
  };
  cwd?: string;
}

export class HarnessError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}

/**
 * Durable run services shared by the CLI, the orchestrator and the PR workflow: ingestion,
 * contract proposal/approval, state transitions, worktree preparation, and artifacts.
 */
export class Harness {
  readonly store: ApertureStore;
  readonly events: EventStore;
  readonly layout: StorageLayout;
  readonly worktrees = new WorktreeManager();
  readonly sources: SourceRegistry;
  readonly env: NodeJS.ProcessEnv;

  constructor(readonly options: HarnessOptions) {
    this.layout = new StorageLayout(options.storageDir);
    mkdirSync(options.storageDir, { recursive: true, mode: 0o700 });
    this.store = ApertureStore.open(this.layout.databasePath);
    this.events = new EventStore(this.store, this.layout, { redactLiterals: options.redactLiterals ?? [] });
    this.env = options.env ?? process.env;
    this.sources = options.sources ?? SourceRegistry.withDefaults(options.config, this.env);
  }

  get config(): UserConfig {
    return this.options.config;
  }

  close(): void {
    this.store.close();
  }

  // ---- runs & transitions -------------------------------------------------------------------

  getRun(runIdOrPrefix: string): RunRecord {
    const run = this.store.findRun(runIdOrPrefix);
    if (!run) throw new HarnessError(`run ${runIdOrPrefix} not found`, 'RUN_NOT_FOUND');
    return run;
  }

  /** Atomically checks, applies and logs a state transition (event + checkpoint in one transaction). */
  transition(runId: string, to: RunState, reason?: string, extra: Record<string, unknown> = {}): RunRecord {
    return this.store.transaction(() => {
      const run = this.getRun(runId);
      assertTransition(run.state, to);
      const now = new Date();
      const fields: Partial<RunRecord> = { state: to, updatedAt: now.toISOString() };
      if (to === 'EXECUTING') fields.executingSince = now.toISOString();
      if (run.state === 'EXECUTING' && run.executingSince) {
        fields.executingMs = run.executingMs + (now.getTime() - Date.parse(run.executingSince));
        fields.executingSince = null;
      }
      if (isTerminal(to)) fields.terminalReason = reason ?? null;
      this.store.updateRun(runId, fields);
      this.events.append(runId, 'state.changed', { from: run.state, to, ...(reason ? { reason } : {}), ...extra });
      if (isTerminal(to)) this.events.append(runId, 'run.finished', { state: to, ...(reason ? { reason } : {}) });
      return this.getRun(runId);
    });
  }

  emit(runId: string, type: EventType, payload: Record<string, unknown>): void {
    this.events.append(runId, type, payload);
  }

  /** Wall-clock time spent in EXECUTING, including the current stretch. */
  executingElapsedMs(run: RunRecord, now: number = Date.now()): number {
    return run.executingMs + (run.executingSince ? now - Date.parse(run.executingSince) : 0);
  }

  // ---- ingestion & contracts ------------------------------------------------------------------

  async ingest(reference: string, options: IngestOptions = {}): Promise<RunRecord> {
    const task = await this.sources.fetch(reference, options.cwd);
    return this.ingestTask(task, options);
  }

  async ingestTask(task: NormalizedTask, options: IngestOptions = {}): Promise<RunRecord> {
    const runId = `run_${ulid()}`;
    const taskId = `task_${ulid()}`;
    const now = new Date().toISOString();
    const snapshot = snapshotTask(task);
    const repoPath = await this.resolveRepoPath(task, options);
    const workspace = options.workspace ?? this.config.runtime.workspace;
    // Fail fast, before a run exists, when the user's checkout cannot host an in-place run.
    if (workspace === 'in-place') await this.assertInPlaceReady(repoPath, task.repository);

    this.store.transaction(() => {
      this.store.insertTask({ taskId, sourceType: task.sourceType, sourceRef: task.sourceRef, repository: task.repository, title: task.title, snapshotJson: snapshot.json, snapshotSha256: snapshot.sha256, createdAt: now });
      this.store.insertRun({
        runId,
        taskId,
        contractId: null,
        state: 'INGESTING',
        modelId: options.overrides?.model ?? this.config.models.implementation,
        repoPath,
        worktreePath: null,
        branch: null,
        baselineRef: 'HEAD',
        baselineSha: null,
        isolation: options.isolation ?? this.config.runtime.isolation,
        questionMode: options.questionMode ?? this.config.runtime.questionMode,
        workspace,
        turns: 0,
        patchAttempts: 0,
        verificationAttempts: 0,
        lastFailureSignature: null,
        reviewDiffSha256: null,
        reviewApprovedAt: null,
        terminalReason: null,
        startedAt: now,
        updatedAt: now,
        executingSince: null,
        executingMs: 0,
      });
      this.events.append(runId, 'run.created', { taskId, sourceRef: task.sourceRef, title: task.title, repository: task.repository, repoPath, snapshotSha256: snapshot.sha256, revision: task.revision });
    });
    this.writeArtifact(runId, 'source.snapshot.json', `${JSON.stringify(JSON.parse(snapshot.json), null, 2)}\n`, 'source_snapshot');

    let proposal: { contract: ExecutionContract; notes: string[] };
    try {
      proposal = await this.sources.proposeContract(task, this.config, await this.repoContext(repoPath, task));
    } catch (err) {
      this.transition(runId, 'FAILED', `contract proposal failed: ${(err as Error).message}`);
      throw err;
    }
    const contract = applyOverrides(proposal.contract, options.overrides ?? {}, this.config);
    this.proposeContract(runId, contract, proposal.notes);
    this.transition(runId, 'NEEDS_CONTRACT_REVIEW');
    return this.getRun(runId);
  }

  private async resolveRepoPath(task: NormalizedTask, options: IngestOptions): Promise<string> {
    const configured = task.repository ? this.config.repositories[task.repository]?.path : undefined;
    const candidate = options.repoPath ?? configured ?? options.cwd ?? process.cwd();
    try {
      return await this.worktrees.resolveRepoRoot(candidate.replace(/^~(?=\/)/, this.env.HOME ?? '~'));
    } catch {
      throw new HarnessError(`${candidate} is not inside a git repository; pass --repo <path> or map ${task.repository ?? 'the repository'} in config.repositories`, 'NOT_A_REPO');
    }
  }

  private async repoContext(repoPath: string, task: NormalizedTask): Promise<{ trackedFiles: string[]; baselineRef: string }> {
    const baselineRef = (task.repository ? this.config.repositories[task.repository]?.baseBranch : undefined) ?? 'HEAD';
    const sha = await this.worktrees.resolveCommit(repoPath, baselineRef).catch(() => this.worktrees.resolveCommit(repoPath, 'HEAD'));
    const listing = await gitStdout(repoPath, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha]);
    return { trackedFiles: listing.split('\0').filter(Boolean), baselineRef };
  }

  /**
   * Re-fetches the source ticket and compares it with the pinned snapshot (§14 "source ticket
   * changes mid-run"). Drift is reported, never applied: the approved contract stays authoritative.
   */
  async checkSourceDrift(runId: string): Promise<{ drifted: boolean; pinnedRevision: string; currentRevision?: string; error?: string }> {
    const run = this.getRun(runId);
    const task = this.store.getTask(run.taskId)!;
    const pinned = JSON.parse(task.snapshotJson) as NormalizedTask;
    try {
      const current = await this.sources.fetch(pinned.sourceRef);
      const drifted = taskContentDigest(current) !== taskContentDigest(pinned) || (pinned.sourceType === 'local' && current.revision !== pinned.revision);
      if (drifted) this.emit(runId, 'source.drift.detected', { sourceRef: pinned.sourceRef, pinnedRevision: pinned.revision, currentRevision: current.revision });
      return { drifted, pinnedRevision: pinned.revision, currentRevision: current.revision };
    } catch (err) {
      return { drifted: false, pinnedRevision: pinned.revision, error: (err as Error).message };
    }
  }

  knownCommandIds(): Set<string> {
    return new Set(Object.keys(this.config.commands));
  }

  analyze(contract: ExecutionContract): ContractFinding[] {
    return analyzeContract(contract, this.knownCommandIds());
  }

  /** Stores a new proposed contract version for the run's task (status `proposed`). */
  proposeContract(runId: string, contract: ExecutionContract, notes: string[] = []): ContractRecord {
    const run = this.getRun(runId);
    const validated = parseContract(structuredClone(contract));
    const { canonicalJson, sha256 } = contractDigest(validated);
    const task = this.store.getTask(run.taskId)!;
    const record = this.store.transaction(() => {
      for (const prior of this.store.contractsForTask(run.taskId)) {
        if (prior.status === 'proposed') this.store.setContractStatus(prior.contractId, 'superseded');
      }
      const version = this.store.nextContractVersion(run.taskId);
      const rec: ContractRecord = {
        contractId: `${run.taskId}.v${version}`,
        taskId: run.taskId,
        version,
        canonicalJson,
        sha256,
        schemaVersion: 1,
        sourceRevision: sha256Hex(task.snapshotJson),
        status: 'proposed',
        approvedBy: null,
        approvedAt: null,
        createdAt: new Date().toISOString(),
      };
      this.store.insertContract(rec);
      this.events.append(runId, 'contract.proposed', { contractId: rec.contractId, version, sha256, notes, findings: this.analyze(validated) });
      return rec;
    });
    return record;
  }

  pendingProposal(runId: string): { record: ContractRecord; contract: ExecutionContract } | undefined {
    const run = this.getRun(runId);
    const record = this.store.contractsForTask(run.taskId).filter((c) => c.status === 'proposed').at(-1);
    if (!record) return undefined;
    return { record, contract: parseContract(JSON.parse(record.canonicalJson)) };
  }

  contractYaml(contract: ExecutionContract): string {
    return toYaml(contract, { lineWidth: 120 });
  }

  /** Approves the pending proposal; the stored digest is the identity of the approved scope. */
  approvePending(runId: string, actor: string): ApprovedContract {
    const run = this.getRun(runId);
    const pending = this.pendingProposal(runId);
    if (!pending) throw new HarnessError('no proposed contract awaiting approval', 'NO_PROPOSAL');
    const errors = this.analyze(pending.contract).filter((f) => f.level === 'error');
    if (errors.length > 0) throw new HarnessError(`contract cannot be approved:\n  ${errors.map((e) => e.message).join('\n  ')}`, 'CONTRACT_INVALID');
    const task = this.store.getTask(run.taskId)!;
    const approved = approveContract(pending.contract, { taskId: run.taskId, version: pending.record.version, approvedBy: actor, sourceRevision: sha256Hex(task.snapshotJson) });
    if (approved.sha256 !== pending.record.sha256) throw new HarnessError('proposed contract changed between proposal and approval', 'CONTRACT_DRIFT');
    this.store.transaction(() => {
      this.store.markContractApproved(pending.record.contractId, actor, approved.approvedAt);
      for (const prior of this.store.contractsForTask(run.taskId)) {
        if (prior.status === 'approved' && prior.contractId !== pending.record.contractId) this.store.setContractStatus(prior.contractId, 'superseded');
      }
      this.store.updateRun(runId, { contractId: pending.record.contractId, modelId: approved.contract.spec.models.implement, baselineRef: approved.contract.metadata.baselineRef });
      this.events.append(runId, 'contract.approved', { contractId: approved.contractId, version: approved.version, sha256: approved.sha256, approvedBy: actor });
    });
    this.writeArtifact(runId, `contract.v${approved.version}.json`, `${JSON.stringify(JSON.parse(approved.canonicalJson), null, 2)}\n`, 'contract');
    return approved;
  }

  rejectPending(runId: string, reason: string): void {
    const pending = this.pendingProposal(runId);
    if (pending) this.store.setContractStatus(pending.record.contractId, 'rejected');
    this.emit(runId, 'contract.rejected', { reason, ...(pending ? { contractId: pending.record.contractId } : {}) });
  }

  approvedContract(run: RunRecord): ApprovedContract {
    if (!run.contractId) throw new HarnessError(`run ${run.runId} has no approved contract`, 'NO_CONTRACT');
    const rec = this.store.getContract(run.contractId);
    if (!rec || rec.status !== 'approved' || !rec.approvedBy || !rec.approvedAt) {
      throw new HarnessError(`contract ${run.contractId} is not approved`, 'NO_CONTRACT');
    }
    return restoreApprovedContract({
      contractId: rec.contractId,
      taskId: rec.taskId,
      version: rec.version,
      canonicalJson: rec.canonicalJson,
      sha256: rec.sha256,
      approvedBy: rec.approvedBy,
      approvedAt: rec.approvedAt,
      schemaVersion: rec.schemaVersion,
      sourceRevision: rec.sourceRevision,
    });
  }

  // ---- preparation ----------------------------------------------------------------------------

  isolationMode(run: RunRecord): IsolationMode {
    return resolveIsolation(run.isolation, this.env);
  }

  async prepare(runId: string): Promise<RunRecord> {
    let run = this.getRun(runId);
    const contract = this.approvedContract(run);
    let isolation: IsolationMode;
    try {
      isolation = this.isolationMode(run);
    } catch (err) {
      this.transition(runId, 'FAILED', (err as Error).message);
      throw err;
    }
    if (!run.worktreePath && run.workspace === 'in-place') {
      try {
        const task = this.store.getTask(run.taskId)!;
        const branch = await this.assertInPlaceReady(run.repoPath, task.repository, runId);
        const baselineSha = await this.worktrees.headSha(run.repoPath);
        const hashes = await this.worktrees.snapshotHashes(run.repoPath, baselineSha);
        this.store.updateRun(runId, { worktreePath: run.repoPath, branch, baselineSha });
        this.writeArtifact(runId, 'baseline.json', `${JSON.stringify({ workspace: 'in-place', branch, baselineSha, files: hashes }, null, 2)}\n`, 'baseline');
        this.emit(runId, 'sandbox.prepared', { workspace: 'in-place', worktreePath: run.repoPath, branch, baselineRef: branch, baselineSha, isolation, trackedFiles: Object.keys(hashes).length });
      } catch (err) {
        this.transition(runId, 'FAILED', `in-place workspace refused: ${(err as Error).message}`);
        throw err;
      }
    } else if (!run.worktreePath) {
      const branch = `aperture/${runId.toLowerCase().replace(/_/g, '-')}`;
      try {
        const info = await this.worktrees.create({ repoPath: run.repoPath, baselineRef: contract.contract.metadata.baselineRef, worktreePath: this.layout.worktreeDir(runId), branch });
        const hashes = await this.worktrees.snapshotHashes(info.worktreePath, info.baselineSha);
        this.store.updateRun(runId, { worktreePath: info.worktreePath, branch, baselineSha: info.baselineSha });
        this.writeArtifact(runId, 'baseline.json', `${JSON.stringify({ baselineRef: info.baselineRef, baselineSha: info.baselineSha, treeSha: info.baselineTreeSha, files: hashes }, null, 2)}\n`, 'baseline');
        this.emit(runId, 'sandbox.prepared', { worktreePath: info.worktreePath, branch, baselineRef: info.baselineRef, baselineSha: info.baselineSha, isolation, trackedFiles: Object.keys(hashes).length });
      } catch (err) {
        this.transition(runId, 'FAILED', `worktree preparation failed: ${(err as Error).message}`);
        throw err;
      }
    }
    mkdirSync(this.layout.runTmpDir(runId), { recursive: true, mode: 0o700 });
    run = this.transition(runId, 'EXECUTING', undefined, { isolation });
    return run;
  }

  /**
   * Guards for the default in-place workspace (§21.3): a checked-out branch (not detached, not the
   * base branch), no uncommitted or untracked changes, and no other active in-place run on the clone.
   * Returns the branch name.
   */
  async assertInPlaceReady(repoPath: string, repository: string | null, runId?: string): Promise<string> {
    const branch = await this.worktrees.currentBranch(repoPath);
    if (!branch) throw new HarnessError(`${repoPath} has a detached HEAD; check out the branch for this task first (git switch -c <branch>)`, 'IN_PLACE_DETACHED');
    const base = (repository ? this.config.repositories[repository]?.baseBranch : undefined) ?? (await this.worktrees.remoteDefaultBranch(repoPath));
    if (base && branch === base) throw new HarnessError(`${repoPath} is on the base branch ${base}; create and check out a branch for this task first (git switch -c <branch>)`, 'IN_PLACE_BASE_BRANCH');
    const dirty = await this.worktrees.uncommittedPaths(repoPath);
    if (dirty.length > 0) {
      throw new HarnessError(`${repoPath} has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}); commit or stash them so they don't mix into this task's diff`, 'IN_PLACE_DIRTY');
    }
    const others = this.store.activeInPlaceRuns(repoPath).filter((r) => r.runId !== runId);
    if (others.length > 0) throw new HarnessError(`run ${others[0]!.runId} is still active in ${repoPath}; finish or cancel it first`, 'IN_PLACE_BUSY');
    return branch;
  }

  /** Refuses to continue an in-place run after the user switched branches (§21.3). */
  async assertWorkspaceBranch(run: RunRecord): Promise<void> {
    if (run.workspace !== 'in-place' || !run.branch || !run.worktreePath) return;
    const current = await this.worktrees.currentBranch(run.worktreePath);
    if (current !== run.branch) {
      throw new HarnessError(`run ${run.runId} works on branch ${run.branch}, but ${run.worktreePath} has ${current ?? 'a detached HEAD'} checked out; switch back (git switch ${run.branch}) to continue`, 'IN_PLACE_BRANCH_CHANGED');
    }
  }

  createRunner(run: RunRecord): SandboxRunner {
    if (!run.worktreePath) throw new HarnessError('run has no worktree', 'NO_WORKTREE');
    return new SandboxRunner(this.isolationMode(run), {
      worktreePath: run.worktreePath,
      ...(run.workspace === 'in-place' ? { readOnlyPaths: [join(run.worktreePath, '.git')] } : {}),
      tmpDir: this.layout.runTmpDir(run.runId),
      hiddenPaths: [...defaultHiddenPaths(this.env.HOME), this.layout.databasePath, join(this.layout.root, 'runs'), ...(this.options.extraHiddenPaths ?? [])],
    }, this.env);
  }

  createGateway(run: RunRecord, contract: ApprovedContract = this.approvedContract(run)): ToolGateway {
    if (!run.worktreePath) throw new HarnessError('run has no worktree', 'NO_WORKTREE');
    return new ToolGateway({
      runId: run.runId,
      contract,
      worktreePath: run.worktreePath,
      runner: this.createRunner(run),
      events: this.events,
      store: this.store,
      artifactsDir: this.layout.runDir(run.runId),
      configCommands: this.config.commands,
      redactLiterals: this.options.redactLiterals ?? [],
    });
  }

  // ---- artifacts ------------------------------------------------------------------------------

  writeArtifact(runId: string, name: string, content: string, type: string): string {
    const dir = this.layout.runDir(runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o600 });
    this.store.upsertArtifact({ artifactId: `${runId}:${name}`, runId, type, path, sha256: sha256Hex(content), createdAt: new Date().toISOString() });
    return path;
  }

  newDecisionId(): string {
    return newId('dec');
  }
}

export function applyOverrides(contract: ExecutionContract, overrides: NonNullable<IngestOptions['overrides']>, config: UserConfig): ExecutionContract {
  const next = structuredClone(contract) as ExecutionContract;
  if (overrides.model) next.spec.models.implement = overrides.model;
  if (overrides.budgetUsd !== undefined) next.spec.limits.maxCostUsd = overrides.budgetUsd;
  if (overrides.cacheTtl) next.spec.cache.ttl = overrides.cacheTtl;
  if (overrides.cacheEnabled !== undefined) next.spec.cache.enabled = overrides.cacheEnabled;
  // Global ceilings always clamp contract limits.
  next.spec.limits.maxCostUsd = Math.min(next.spec.limits.maxCostUsd, Math.max(config.limits.maxCostPerRunUsd, overrides.budgetUsd ?? 0));
  next.spec.limits.prBudgetUsd = Math.min(next.spec.limits.prBudgetUsd, config.limits.maxPrDraftCostUsd);
  return parseContract(next);
}
