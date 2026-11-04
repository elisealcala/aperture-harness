import { join } from 'node:path';
import { SqliteDatabase, type SqlParams } from './database.ts';

export type RunState =
  | 'INGESTING'
  | 'NEEDS_CONTRACT_REVIEW'
  | 'PREPARING'
  | 'EXECUTING'
  | 'WAITING_FOR_USER'
  | 'VERIFYING'
  | 'READY_FOR_REVIEW'
  | 'PR_DRAFTING'
  | 'PR_APPROVAL'
  | 'PR_PUBLISHING'
  | 'PR_CREATED'
  | 'COMPLETED_LOCAL'
  | 'BLOCKED'
  | 'FAILED'
  | 'CANCELED';

export interface TaskRecord {
  taskId: string;
  sourceType: string;
  sourceRef: string;
  repository: string | null;
  title: string;
  snapshotJson: string;
  snapshotSha256: string;
  createdAt: string;
}

export type ContractStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';

export interface ContractRecord {
  contractId: string;
  taskId: string;
  version: number;
  canonicalJson: string;
  sha256: string;
  schemaVersion: number;
  sourceRevision: string | null;
  status: ContractStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  contractId: string | null;
  state: RunState;
  modelId: string;
  repoPath: string;
  worktreePath: string | null;
  branch: string | null;
  baselineRef: string;
  baselineSha: string | null;
  isolation: 'required' | 'reduced';
  questionMode: 'interactive' | 'noninteractive';
  turns: number;
  patchAttempts: number;
  verificationAttempts: number;
  lastFailureSignature: string | null;
  reviewDiffSha256: string | null;
  reviewApprovedAt: string | null;
  terminalReason: string | null;
  startedAt: string;
  updatedAt: string;
  executingSince: string | null;
  executingMs: number;
}

export interface QuestionRecord {
  questionId: string;
  runId: string;
  toolCallId: string | null;
  kind: 'question' | 'scope_change';
  payloadJson: string;
  status: 'open' | 'answered' | 'canceled';
  createdAt: string;
  answeredAt: string | null;
}

export interface DecisionRecord {
  decisionId: string;
  runId: string;
  questionId: string | null;
  kind: string;
  answerJson: string;
  actor: string;
  contractVersion: number;
  createdAt: string;
}

export type UsagePhase = 'implementation' | 'pr_draft' | 'contract_draft';

export interface UsageRecord {
  requestId: string;
  runId: string;
  phase: UsagePhase;
  modelId: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number;
  estimatedUsd: number | null;
  createdAt: string;
}

export interface CheckRunRecord {
  checkRunId: string;
  checkId: string;
  runId: string;
  attempt: number;
  status: string;
  exitCode: number | null;
  artifactPath: string | null;
  outputSha256: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ArtifactRecord {
  artifactId: string;
  runId: string;
  type: string;
  path: string;
  sha256: string;
  createdAt: string;
}

export interface PrPublicationRecord {
  runId: string;
  operationId: string;
  repository: string;
  branch: string;
  baseBranch: string;
  headSha: string | null;
  status: 'approved' | 'pushed' | 'created' | 'failed';
  prNumber: number | null;
  prUrl: string | null;
  approvedAt: string;
  updatedAt: string;
}

export interface ConversationEntry {
  runId: string;
  seq: number;
  role: 'user' | 'assistant';
  contentJson: string;
  createdAt: string;
}

export type ToolOpStatus = 'started' | 'applied' | 'completed' | 'rejected' | 'failed';

export interface ToolOperationRecord {
  opId: string;
  runId: string;
  tool: string;
  status: ToolOpStatus;
  inputJson: string;
  inputSha256: string;
  resultJson: string | null;
  resultSha256: string | null;
  createdAt: string;
  updatedAt: string;
}

function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/sha_256/g, 'sha256');
}

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function camelize<T>(row: Record<string, unknown> | undefined): T | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out as T;
}

function snakeParams(record: object): SqlParams {
  const out: SqlParams = {};
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    out[toSnake(k)] = typeof v === 'boolean' ? (v ? 1 : 0) : (v as SqlParams[string]);
  }
  return out;
}

function insertSql(table: string, params: SqlParams): string {
  const cols = Object.keys(params);
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`;
}

const RUN_COLUMNS = new Set([
  'contract_id', 'state', 'model_id', 'worktree_path', 'branch', 'baseline_sha', 'turns', 'patch_attempts',
  'verification_attempts', 'last_failure_signature', 'review_diff_sha256', 'review_approved_at', 'terminal_reason',
  'updated_at', 'executing_since', 'executing_ms', 'isolation', 'question_mode',
]);

/** Typed data access for every table. All writes that must be atomic go through `transaction`. */
export class ApertureStore {
  constructor(readonly sql: SqliteDatabase) {}

  static open(path: string): ApertureStore {
    return new ApertureStore(new SqliteDatabase(path));
  }

  transaction<T>(fn: () => T): T {
    return this.sql.transaction(fn);
  }

  close(): void {
    this.sql.close();
  }

  // ---- tasks ------------------------------------------------------------------------------
  insertTask(task: TaskRecord): void {
    const p = snakeParams(task);
    this.sql.run(insertSql('tasks', p), p);
  }

  /** Associates a GitHub repository with a task whose source had none (e.g. an unmapped Linear team). */
  setTaskRepository(taskId: string, repository: string): void {
    this.sql.run('UPDATE tasks SET repository = :repository WHERE task_id = :id', { id: taskId, repository });
  }

  getTask(taskId: string): TaskRecord | undefined {
    return camelize(this.sql.get('SELECT * FROM tasks WHERE task_id = :task_id', { task_id: taskId }));
  }

  // ---- contracts --------------------------------------------------------------------------
  insertContract(contract: ContractRecord): void {
    const p = snakeParams(contract);
    this.sql.run(insertSql('contracts', p), p);
  }

  getContract(contractId: string): ContractRecord | undefined {
    return camelize(this.sql.get('SELECT * FROM contracts WHERE contract_id = :id', { id: contractId }));
  }

  contractsForTask(taskId: string): ContractRecord[] {
    return this.sql
      .all<Record<string, unknown>>('SELECT * FROM contracts WHERE task_id = :id ORDER BY version', { id: taskId })
      .map((r) => camelize<ContractRecord>(r)!);
  }

  nextContractVersion(taskId: string): number {
    const row = this.sql.get<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM contracts WHERE task_id = :id', { id: taskId });
    return (row?.v ?? 0) + 1;
  }

  markContractApproved(contractId: string, approvedBy: string, approvedAt: string): void {
    this.sql.run(
      "UPDATE contracts SET status = 'approved', approved_by = :by, approved_at = :at WHERE contract_id = :id AND status = 'proposed'",
      { id: contractId, by: approvedBy, at: approvedAt },
    );
  }

  setContractStatus(contractId: string, status: ContractStatus): void {
    this.sql.run('UPDATE contracts SET status = :status WHERE contract_id = :id', { id: contractId, status });
  }

  // ---- runs -------------------------------------------------------------------------------
  insertRun(run: RunRecord): void {
    const p = snakeParams(run);
    this.sql.run(insertSql('runs', p), p);
  }

  getRun(runId: string): RunRecord | undefined {
    return camelize(this.sql.get('SELECT * FROM runs WHERE run_id = :id', { id: runId }));
  }

  findRun(prefix: string): RunRecord | undefined {
    const exact = this.getRun(prefix);
    if (exact) return exact;
    const rows = this.sql.all<Record<string, unknown>>('SELECT * FROM runs WHERE run_id LIKE :p ORDER BY started_at DESC LIMIT 2', { p: `${prefix}%` });
    return rows.length === 1 ? camelize(rows[0]) : undefined;
  }

  listRuns(limit = 20): RunRecord[] {
    return this.sql
      .all<Record<string, unknown>>('SELECT * FROM runs ORDER BY started_at DESC LIMIT :limit', { limit })
      .map((r) => camelize<RunRecord>(r)!);
  }

  updateRun(runId: string, fields: Partial<Omit<RunRecord, 'runId' | 'taskId' | 'startedAt'>>): void {
    const p = snakeParams({ ...fields, updatedAt: fields.updatedAt ?? new Date().toISOString() });
    const cols = Object.keys(p).filter((c) => RUN_COLUMNS.has(c));
    if (cols.length === 0) return;
    const params: SqlParams = { run_id: runId };
    for (const c of cols) params[c] = p[c]!;
    this.sql.run(`UPDATE runs SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE run_id = :run_id`, params);
  }

  incrementRunCounter(runId: string, counter: 'turns' | 'patch_attempts' | 'verification_attempts'): number {
    this.sql.run(`UPDATE runs SET ${counter} = ${counter} + 1, updated_at = :now WHERE run_id = :id`, { id: runId, now: new Date().toISOString() });
    return this.sql.get<{ v: number }>(`SELECT ${counter} AS v FROM runs WHERE run_id = :id`, { id: runId })!.v;
  }

  // ---- questions & decisions ----------------------------------------------------------------
  insertQuestion(question: QuestionRecord): void {
    const p = snakeParams(question);
    this.sql.run(insertSql('questions', p), p);
  }

  getQuestion(questionId: string): QuestionRecord | undefined {
    return camelize(this.sql.get('SELECT * FROM questions WHERE question_id = :id', { id: questionId }));
  }

  questionsForRun(runId: string, status?: QuestionRecord['status']): QuestionRecord[] {
    const rows = status
      ? this.sql.all<Record<string, unknown>>('SELECT * FROM questions WHERE run_id = :id AND status = :status ORDER BY created_at', { id: runId, status })
      : this.sql.all<Record<string, unknown>>('SELECT * FROM questions WHERE run_id = :id ORDER BY created_at', { id: runId });
    return rows.map((r) => camelize<QuestionRecord>(r)!);
  }

  setQuestionStatus(questionId: string, status: QuestionRecord['status'], at: string): void {
    this.sql.run('UPDATE questions SET status = :status, answered_at = :at WHERE question_id = :id', { id: questionId, status, at });
  }

  insertDecision(decision: DecisionRecord): void {
    const p = snakeParams(decision);
    this.sql.run(insertSql('decisions', p), p);
  }

  decisionsForRun(runId: string): DecisionRecord[] {
    return this.sql
      .all<Record<string, unknown>>('SELECT * FROM decisions WHERE run_id = :id ORDER BY created_at', { id: runId })
      .map((r) => camelize<DecisionRecord>(r)!);
  }

  decisionForQuestion(questionId: string): DecisionRecord | undefined {
    return camelize(this.sql.get('SELECT * FROM decisions WHERE question_id = :id ORDER BY created_at DESC LIMIT 1', { id: questionId }));
  }

  // ---- usage ------------------------------------------------------------------------------
  insertUsage(usage: UsageRecord): void {
    const p = snakeParams(usage);
    this.sql.run(insertSql('model_usage', p), p);
  }

  usageForRun(runId: string): UsageRecord[] {
    return this.sql
      .all<Record<string, unknown>>('SELECT * FROM model_usage WHERE run_id = :id ORDER BY created_at', { id: runId })
      .map((r) => camelize<UsageRecord>(r)!);
  }

  spentUsd(runId: string, phase?: UsagePhase): number {
    const row = phase
      ? this.sql.get<{ v: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS v FROM model_usage WHERE run_id = :id AND phase = :phase', { id: runId, phase })
      : this.sql.get<{ v: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS v FROM model_usage WHERE run_id = :id', { id: runId });
    return row?.v ?? 0;
  }

  // ---- checks -----------------------------------------------------------------------------
  insertCheckRun(check: CheckRunRecord): void {
    const p = snakeParams(check);
    this.sql.run(insertSql('checks', p), p);
  }

  finishCheckRun(checkRunId: string, fields: { status: string; exitCode: number | null; artifactPath: string | null; outputSha256: string | null; finishedAt: string }): void {
    this.sql.run(
      'UPDATE checks SET status = :status, exit_code = :exit_code, artifact_path = :artifact_path, output_sha256 = :output_sha256, finished_at = :finished_at WHERE check_run_id = :id',
      { id: checkRunId, status: fields.status, exit_code: fields.exitCode, artifact_path: fields.artifactPath, output_sha256: fields.outputSha256, finished_at: fields.finishedAt },
    );
  }

  checksForRun(runId: string): CheckRunRecord[] {
    return this.sql
      .all<Record<string, unknown>>('SELECT * FROM checks WHERE run_id = :id ORDER BY started_at', { id: runId })
      .map((r) => camelize<CheckRunRecord>(r)!);
  }

  // ---- artifacts --------------------------------------------------------------------------
  upsertArtifact(artifact: ArtifactRecord): void {
    const p = snakeParams(artifact);
    this.sql.run(
      `${insertSql('artifacts', p)} ON CONFLICT(artifact_id) DO UPDATE SET path = excluded.path, sha256 = excluded.sha256, created_at = excluded.created_at`,
      p,
    );
  }

  artifactsForRun(runId: string): ArtifactRecord[] {
    return this.sql
      .all<Record<string, unknown>>('SELECT * FROM artifacts WHERE run_id = :id ORDER BY created_at', { id: runId })
      .map((r) => camelize<ArtifactRecord>(r)!);
  }

  // ---- PR publications ----------------------------------------------------------------------
  getPublication(runId: string): PrPublicationRecord | undefined {
    return camelize(this.sql.get('SELECT * FROM pr_publications WHERE run_id = :id', { id: runId }));
  }

  upsertPublication(pub: PrPublicationRecord): void {
    const p = snakeParams(pub);
    const updates = Object.keys(p)
      .filter((c) => c !== 'run_id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    this.sql.run(`${insertSql('pr_publications', p)} ON CONFLICT(run_id) DO UPDATE SET ${updates}`, p);
  }

  // ---- conversation -----------------------------------------------------------------------
  appendConversation(runId: string, role: 'user' | 'assistant', contentJson: string): number {
    const row = this.sql.get<{ v: number }>('SELECT COALESCE(MAX(seq), 0) AS v FROM conversation WHERE run_id = :id', { id: runId });
    const seq = (row?.v ?? 0) + 1;
    this.sql.run('INSERT INTO conversation (run_id, seq, role, content_json, created_at) VALUES (:run_id, :seq, :role, :content_json, :created_at)', {
      run_id: runId,
      seq,
      role,
      content_json: contentJson,
      created_at: new Date().toISOString(),
    });
    return seq;
  }

  loadConversation(runId: string): ConversationEntry[] {
    return this.sql
      .all<Record<string, unknown>>('SELECT * FROM conversation WHERE run_id = :id ORDER BY seq', { id: runId })
      .map((r) => camelize<ConversationEntry>(r)!);
  }

  // ---- tool operations ----------------------------------------------------------------------
  getToolOp(opId: string): ToolOperationRecord | undefined {
    return camelize(this.sql.get('SELECT * FROM tool_operations WHERE op_id = :id', { id: opId }));
  }

  insertToolOp(op: ToolOperationRecord): void {
    const p = snakeParams(op);
    this.sql.run(insertSql('tool_operations', p), p);
  }

  updateToolOp(opId: string, fields: { status: ToolOpStatus; resultJson?: string | null; resultSha256?: string | null }): void {
    this.sql.run(
      'UPDATE tool_operations SET status = :status, result_json = COALESCE(:result_json, result_json), result_sha256 = COALESCE(:result_sha256, result_sha256), updated_at = :now WHERE op_id = :id',
      { id: opId, status: fields.status, result_json: fields.resultJson ?? null, result_sha256: fields.resultSha256 ?? null, now: new Date().toISOString() },
    );
  }

  toolOpsForRun(runId: string, status?: ToolOpStatus): ToolOperationRecord[] {
    const rows = status
      ? this.sql.all<Record<string, unknown>>('SELECT * FROM tool_operations WHERE run_id = :id AND status = :status ORDER BY created_at', { id: runId, status })
      : this.sql.all<Record<string, unknown>>('SELECT * FROM tool_operations WHERE run_id = :id ORDER BY created_at', { id: runId });
    return rows.map((r) => camelize<ToolOperationRecord>(r)!);
  }
}

/** Filesystem layout for durable per-run artifacts (§16). */
export class StorageLayout {
  constructor(readonly root: string) {}

  get databasePath(): string {
    return join(this.root, 'aperture.db');
  }

  runDir(runId: string): string {
    return join(this.root, 'runs', runId);
  }

  worktreeDir(runId: string): string {
    return join(this.root, 'worktrees', runId);
  }

  runTmpDir(runId: string): string {
    return join(this.root, 'tmp', runId);
  }
}
