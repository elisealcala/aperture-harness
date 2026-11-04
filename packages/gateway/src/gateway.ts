import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovedContract, CommandSpec } from '@aperture/contracts';
import { redactString, type EventStore, type ReasonCode } from '@aperture/events';
import { git, type SandboxCommand, type SandboxResult } from '@aperture/sandbox';
import { newId, type ApertureStore } from '@aperture/storage';
import { CommandRegistry } from './commands.ts';
import { parseSingleFilePatch } from './patch.ts';
import { normalizeRepoPath, PathPolicy } from './path-policy.ts';
import { parseToolRequest, type ToolInput, type ToolRequest } from './tools.ts';

export interface CheckRunner {
  readonly mode: string;
  run(command: SandboxCommand): Promise<SandboxResult>;
}

export type PauseRequest =
  | { type: 'question'; toolCallId: string; question: string; choices: string[]; reason: string; requirementIds: string[] }
  | { type: 'scope_change'; toolCallId: string; reason: string; additionalPaths: string[] }
  | { type: 'blocked'; toolCallId: string; reason: string; evidence: string[] };

export type ToolOutcome =
  | { kind: 'result'; toolCallId: string; isError: boolean; content: string; reasonCode?: ReasonCode }
  | { kind: 'pause'; toolCallId: string; pause: PauseRequest };

export type CheckStatus = 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT';

export interface CheckExecution {
  checkRunId: string;
  checkId: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  artifactPath: string;
  outputTail: string;
  outputSha256: string;
  isolation: string;
}

export interface GatewayOptions {
  runId: string;
  contract: ApprovedContract;
  worktreePath: string;
  runner: CheckRunner;
  events: EventStore;
  store: ApertureStore;
  artifactsDir: string;
  configCommands?: Readonly<Record<string, CommandSpec>>;
  maxReadBytes?: number;
  maxReadLines?: number;
  redactLiterals?: readonly string[];
}

const MODEL_OUTPUT_LIMIT = 6_000;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `…[${text.length - limit} earlier chars omitted]…\n${text.slice(-limit)}`;
}

function isBinary(absPath: string): boolean {
  const fd = openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * The restricted tool gateway (§9). Every model tool call is parsed, authorized against the
 * approved contract, executed against the worktree only, persisted as an operation, and logged.
 * Re-delivering a tool call id that already completed returns the recorded result instead of
 * executing again, which is what makes crash recovery safe for non-idempotent patches.
 */
export class ToolGateway {
  readonly policy: PathPolicy;
  readonly commands: CommandRegistry;
  private readonly requirementIds: ReadonlySet<string>;
  private readonly maxReadBytes: number;
  private readonly maxReadLines: number;

  constructor(private readonly options: GatewayOptions) {
    const spec = options.contract.contract.spec;
    this.policy = new PathPolicy(options.worktreePath, spec.scope);
    this.commands = new CommandRegistry(options.contract, options.configCommands);
    this.requirementIds = new Set(spec.requirements.map((r) => r.id));
    this.maxReadBytes = options.maxReadBytes ?? 5 * 1024 * 1024;
    this.maxReadLines = options.maxReadLines ?? 2000;
  }

  private get runId(): string {
    return this.options.runId;
  }

  async execute(raw: { id: string; name: string; input: unknown }): Promise<ToolOutcome> {
    const { events, store } = this.options;
    const prior = store.getToolOp(raw.id);
    if (prior && prior.status !== 'started' && prior.resultJson) {
      return JSON.parse(prior.resultJson) as ToolOutcome;
    }

    events.append(this.runId, 'tool.requested', { toolCallId: raw.id, name: raw.name, input: raw.input });
    const parsed = parseToolRequest(raw);
    if (!parsed.ok) return this.reject(raw.id, raw.name, raw.input, parsed.reasonCode, parsed.message);
    const request = parsed.request;

    if (prior?.status === 'started' && request.name === 'propose_patch') {
      return this.resumePatch(request, prior.inputJson);
    }

    switch (request.name) {
      case 'read_file':
        return this.readFile(request.id, request.input);
      case 'search_code':
        return this.searchCode(request.id, request.input);
      case 'propose_patch':
        return this.proposePatch(request.id, request.input);
      case 'run_check':
        return this.runCheckTool(request.id, request.input);
      case 'ask_user':
      case 'request_scope_change':
      case 'report_blocked':
        return this.pauseTool(request);
    }
  }

  // ---- shared helpers ----------------------------------------------------------------------

  private record(toolCallId: string, tool: string, input: unknown, outcome: ToolOutcome, status: 'completed' | 'rejected' | 'applied' | 'failed'): ToolOutcome {
    const { store } = this.options;
    const resultJson = JSON.stringify(outcome);
    const now = new Date().toISOString();
    const existing = store.getToolOp(toolCallId);
    if (existing) {
      store.updateToolOp(toolCallId, { status, resultJson, resultSha256: sha256(resultJson) });
    } else {
      const inputJson = JSON.stringify(input ?? null);
      store.insertToolOp({ opId: toolCallId, runId: this.runId, tool, status, inputJson, inputSha256: sha256(inputJson), resultJson, resultSha256: sha256(resultJson), createdAt: now, updatedAt: now });
    }
    return outcome;
  }

  private reject(toolCallId: string, name: string, input: unknown, reasonCode: ReasonCode, message: string, extra: Record<string, unknown> = {}): ToolOutcome {
    this.options.events.append(this.runId, 'tool.rejected', { toolCallId, name, reasonCode, message, ...extra });
    const outcome: ToolOutcome = { kind: 'result', toolCallId, isError: true, reasonCode, content: `REJECTED (${reasonCode}): ${message}` };
    return this.record(toolCallId, name, input, outcome, 'rejected');
  }

  private complete(toolCallId: string, name: string, input: unknown, content: string, summary: Record<string, unknown>, isError = false, status: 'completed' | 'applied' | 'failed' = 'completed'): ToolOutcome {
    const safe = redactString(content, { literals: this.options.redactLiterals ?? [] });
    const outcome: ToolOutcome = { kind: 'result', toolCallId, isError, content: safe };
    this.options.events.append(this.runId, 'tool.completed', { toolCallId, name, isError, resultSha256: sha256(safe), ...summary });
    return this.record(toolCallId, name, input, outcome, status);
  }

  // ---- read_file -----------------------------------------------------------------------------

  private readFile(id: string, input: ToolInput<'read_file'>): ToolOutcome {
    const decision = this.policy.checkRead(input.path);
    if (!decision.allowed) return this.reject(id, 'read_file', input, decision.reasonCode, decision.message, { path: decision.path ?? input.path });
    if (!decision.exists) return this.reject(id, 'read_file', input, 'NOT_FOUND', `${decision.path} does not exist`, { path: decision.path });
    const stat = statSync(decision.absPath);
    if (!stat.isFile()) return this.reject(id, 'read_file', input, 'PATH_INVALID', `${decision.path} is not a regular file`, { path: decision.path });
    if (stat.size > this.maxReadBytes) return this.reject(id, 'read_file', input, 'FILE_TOO_LARGE', `${decision.path} is ${stat.size} bytes`, { path: decision.path });
    if (isBinary(decision.absPath)) return this.reject(id, 'read_file', input, 'BINARY_FILE', `${decision.path} is a binary file`, { path: decision.path });
    this.options.events.append(this.runId, 'tool.approved', { toolCallId: id, name: 'read_file', path: decision.path });

    const lines = readFileSync(decision.absPath, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const start = Math.max(1, input.startLine ?? 1);
    const requestedEnd = Math.min(lines.length, input.endLine ?? lines.length);
    const end = Math.min(requestedEnd, start + this.maxReadLines - 1);
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(width, ' ')}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`)
      .join('\n');
    const note = end < requestedEnd ? `\n[truncated at line ${end}; request startLine=${end + 1} to continue]` : '';
    const header = `${decision.path} (lines ${lines.length === 0 ? 0 : start}-${end} of ${lines.length})`;
    return this.complete(id, 'read_file', input, `${header}\n${body}${note}`, { path: decision.path, startLine: start, endLine: end, totalLines: lines.length });
  }

  // ---- search_code -----------------------------------------------------------------------------

  private async searchCode(id: string, input: ToolInput<'search_code'>): Promise<ToolOutcome> {
    const pathspecs: string[] = [];
    if (input.within && input.within.length > 0) {
      for (const w of input.within) {
        const norm = normalizeRepoPath(w);
        if (!norm.ok) return this.reject(id, 'search_code', input, norm.reasonCode, `within ${JSON.stringify(w)}: ${norm.message}`);
        if (this.policy.denied(norm.path)) return this.reject(id, 'search_code', input, 'PATH_DENIED', `${norm.path} is denied by the contract`, { path: norm.path });
        pathspecs.push(`:(literal)${norm.path}`);
      }
    } else {
      const { readable, writable } = this.policy.scope;
      for (const g of [...readable, ...writable]) pathspecs.push(`:(glob)${g}`);
    }
    for (const d of this.policy.scope.denied) pathspecs.push(`:(exclude,glob,icase)${d}`);
    this.options.events.append(this.runId, 'tool.approved', { toolCallId: id, name: 'search_code', pattern: input.pattern });

    const result = await git(
      this.policy.worktreeRoot,
      ['grep', '-n', '-I', '-E', '--no-color', '--full-name', '--max-count=20', '-e', input.pattern, '--', ...pathspecs],
      { allowFailure: true, timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024 },
    );
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return this.complete(id, 'search_code', input, `search failed: ${result.stderr.trim().slice(0, 500)}`, { pattern: input.pattern, matches: 0 }, true);
    }
    const maxMatches = 100;
    const matches: string[] = [];
    let filtered = 0;
    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      const colon = line.indexOf(':');
      const path = line.slice(0, colon);
      if (!this.policy.checkRead(path).allowed) {
        filtered++;
        continue;
      }
      if (matches.length >= maxMatches) break;
      matches.push(line.length > 300 ? `${line.slice(0, 300)}…` : line);
    }
    const content = matches.length === 0 ? 'no matches in the readable scope' : `${matches.join('\n')}${matches.length >= maxMatches ? `\n[stopped at ${maxMatches} matches; narrow the pattern or use within]` : ''}`;
    return this.complete(id, 'search_code', input, content, { pattern: input.pattern, matches: matches.length, filtered });
  }

  // ---- propose_patch ------------------------------------------------------------------------

  private async proposePatch(id: string, input: ToolInput<'propose_patch'>): Promise<ToolOutcome> {
    const { store, contract, events } = this.options;
    const unknown = input.requirementIds.filter((r) => !this.requirementIds.has(r));
    if (unknown.length > 0) {
      return this.reject(id, 'propose_patch', input, 'UNKNOWN_REQUIREMENT', `unknown requirement ids ${unknown.join(', ')}; valid ids: ${[...this.requirementIds].join(', ')}`, { path: input.path, requirementIds: input.requirementIds });
    }
    const decision = this.policy.checkWrite(input.path);
    if (!decision.allowed) {
      return this.reject(id, 'propose_patch', input, decision.reasonCode, decision.message, { path: decision.path ?? input.path, requirementIds: input.requirementIds });
    }
    const parsed = parseSingleFilePatch(decision.path, input.unifiedDiff);
    if (!parsed.ok) return this.reject(id, 'propose_patch', input, parsed.reasonCode, parsed.message, { path: decision.path, requirementIds: input.requirementIds });
    const patch = parsed.patch;
    if (patch.kind === 'create' && decision.exists) {
      return this.reject(id, 'propose_patch', input, 'PATCH_DOES_NOT_APPLY', `${decision.path} already exists; send a modification diff instead of /dev/null`, { path: decision.path });
    }
    if (patch.kind !== 'create' && !decision.exists) {
      return this.reject(id, 'propose_patch', input, 'NOT_FOUND', `${decision.path} does not exist; use "--- /dev/null" to create it`, { path: decision.path });
    }

    const attempts = store.incrementRunCounter(this.runId, 'patch_attempts');
    const limit = contract.contract.spec.limits.maxPatchAttempts;
    if (attempts > limit) {
      return this.reject(id, 'propose_patch', input, 'PATCH_LIMIT_REACHED', `patch attempt limit (${limit}) reached`, { path: decision.path });
    }
    events.append(this.runId, 'tool.approved', { toolCallId: id, name: 'propose_patch', path: decision.path, requirementIds: input.requirementIds, attempt: attempts });

    // Persist intent before touching the worktree; recovery reconciles a dangling `started` row.
    const opInput = { ...input, path: decision.path, canonicalPatch: patch.canonical };
    const inputJson = JSON.stringify(opInput);
    const now = new Date().toISOString();
    store.insertToolOp({ opId: id, runId: this.runId, tool: 'propose_patch', status: 'started', inputJson, inputSha256: sha256(inputJson), resultJson: null, resultSha256: null, createdAt: now, updatedAt: now });
    return this.applyCanonicalPatch(id, opInput, patch.canonical, decision.path, input.requirementIds, patch.kind, patch.added, patch.removed);
  }

  private async applyCanonicalPatch(id: string, opInput: unknown, canonical: string, path: string, requirementIds: string[], kind: string, added: number, removed: number): Promise<ToolOutcome> {
    const root = this.policy.worktreeRoot;
    const check = await git(root, ['apply', '--check', '--recount', '--whitespace=nowarn', '-p1', '-'], { input: canonical, allowFailure: true });
    if (check.exitCode !== 0) {
      const message = `patch does not apply to the current ${path}: ${check.stderr.trim().slice(0, 1500)}. Re-read the file and send a fresh diff.`;
      this.options.events.append(this.runId, 'tool.rejected', { toolCallId: id, name: 'propose_patch', reasonCode: 'PATCH_DOES_NOT_APPLY', path, message });
      const outcome: ToolOutcome = { kind: 'result', toolCallId: id, isError: true, reasonCode: 'PATCH_DOES_NOT_APPLY', content: `REJECTED (PATCH_DOES_NOT_APPLY): ${message}` };
      return this.record(id, 'propose_patch', opInput, outcome, 'failed');
    }
    await git(root, ['apply', '--recount', '--whitespace=nowarn', '--intent-to-add', '-p1', '-'], { input: canonical });
    if (kind !== 'delete') {
      const after = this.policy.checkWrite(path);
      if (!after.allowed || !after.exists) throw new Error(`post-apply validation failed for ${path}: ${after.allowed ? 'missing' : after.message}`);
    }
    return this.complete(
      id,
      'propose_patch',
      opInput,
      `applied patch to ${path} (+${added} -${removed}) for ${requirementIds.join(', ')}`,
      { path, kind, added, removed, requirementIds, patchSha256: sha256(canonical), diff: canonical },
      false,
      'applied',
    );
  }

  /**
   * Resolves a patch operation that was `started` but never recorded as finished (crash between
   * persisting intent and recording the result). Never re-applies blindly.
   */
  async reconcilePatch(opId: string): Promise<'applied' | 'not_applied' | 'conflict'> {
    const op = this.options.store.getToolOp(opId);
    if (!op || op.tool !== 'propose_patch') throw new Error(`no patch operation ${opId}`);
    if (op.status === 'applied') return 'applied';
    const { canonicalPatch } = JSON.parse(op.inputJson) as { canonicalPatch: string };
    const root = this.policy.worktreeRoot;
    const reverse = await git(root, ['apply', '--check', '--reverse', '--recount', '-p1', '-'], { input: canonicalPatch, allowFailure: true });
    if (reverse.exitCode === 0) return 'applied';
    const forward = await git(root, ['apply', '--check', '--recount', '-p1', '-'], { input: canonicalPatch, allowFailure: true });
    return forward.exitCode === 0 ? 'not_applied' : 'conflict';
  }

  private async resumePatch(request: Extract<ToolRequest, { name: 'propose_patch' }>, inputJson: string): Promise<ToolOutcome> {
    const state = await this.reconcilePatch(request.id);
    const opInput = JSON.parse(inputJson) as { path: string; canonicalPatch: string; requirementIds: string[] };
    this.options.events.append(this.runId, 'recovery.reconciled', { toolCallId: request.id, path: opInput.path, state });
    if (state === 'applied') {
      return this.complete(request.id, 'propose_patch', opInput, `applied patch to ${opInput.path} (recovered after interruption) for ${opInput.requirementIds.join(', ')}`, { path: opInput.path, requirementIds: opInput.requirementIds, recovered: true, diff: opInput.canonicalPatch }, false, 'applied');
    }
    if (state === 'not_applied') {
      const outcome: ToolOutcome = { kind: 'result', toolCallId: request.id, isError: true, reasonCode: 'PATCH_DOES_NOT_APPLY', content: 'The harness was interrupted before this patch was applied; it was NOT applied. Re-read the file and propose it again if still needed.' };
      return this.record(request.id, 'propose_patch', opInput, outcome, 'failed');
    }
    const outcome: ToolOutcome = { kind: 'result', toolCallId: request.id, isError: true, reasonCode: 'PATCH_DOES_NOT_APPLY', content: `The harness was interrupted while applying this patch and ${opInput.path} no longer matches either side. Re-read the file before making further changes.` };
    return this.record(request.id, 'propose_patch', opInput, outcome, 'failed');
  }

  // ---- run_check ----------------------------------------------------------------------------

  private async runCheckTool(id: string, input: ToolInput<'run_check'>): Promise<ToolOutcome> {
    const resolved = this.commands.resolve(input.checkId);
    if (!resolved) {
      const known = this.commands.checks.map((c) => c.id).join(', ') || '(none)';
      return this.reject(id, 'run_check', input, 'UNKNOWN_CHECK', `unknown check ${JSON.stringify(input.checkId)}; declared checks: ${known}`);
    }
    this.options.events.append(this.runId, 'tool.approved', { toolCallId: id, name: 'run_check', checkId: input.checkId });
    const execution = await this.runCheck(input.checkId, 0);
    const content = `check ${execution.checkId}: ${execution.status} (exit ${execution.exitCode ?? 'none'}, ${execution.durationMs}ms)\n${execution.outputTail}`;
    return this.complete(id, 'run_check', input, content, { checkId: execution.checkId, status: execution.status, exitCode: execution.exitCode }, execution.status !== 'PASS');
  }

  /** Runs a declared check inside the sandbox. `attempt` 0 = agent-initiated, ≥1 = verification round. */
  async runCheck(checkId: string, attempt: number): Promise<CheckExecution> {
    const resolved = this.commands.resolve(checkId);
    if (!resolved) throw new Error(`check ${checkId} has no resolvable command`);
    const { events, store, runner } = this.options;
    const checkRunId = newId('chk');
    const startedAt = new Date().toISOString();
    store.insertCheckRun({ checkRunId, checkId, runId: this.runId, attempt, status: 'RUNNING', exitCode: null, artifactPath: null, outputSha256: null, startedAt, finishedAt: null });
    events.append(this.runId, 'check.started', { checkRunId, checkId, attempt, commandId: resolved.check.commandId, exec: resolved.command.exec, args: resolved.command.args, isolation: runner.mode });

    const result = await runner.run({ exec: resolved.command.exec, args: resolved.command.args, timeoutMs: resolved.command.timeoutSeconds * 1000 });
    const output = redactString(`$ ${[resolved.command.exec, ...resolved.command.args].join(' ')}\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}`, { literals: this.options.redactLiterals ?? [] });
    const status: CheckStatus = result.timedOut ? 'TIMEOUT' : result.exitCode === 0 ? 'PASS' : result.exitCode === 127 && /spawn failed/.test(result.stderr) ? 'ERROR' : 'FAIL';
    mkdirSync(join(this.options.artifactsDir, 'checks'), { recursive: true, mode: 0o700 });
    const artifactPath = join(this.options.artifactsDir, 'checks', `${checkId}-${checkRunId}.log`);
    writeFileSync(artifactPath, output, { mode: 0o600 });
    const outputSha256 = sha256(output);
    const finishedAt = new Date().toISOString();
    store.finishCheckRun(checkRunId, { status, exitCode: result.exitCode, artifactPath, outputSha256, finishedAt });
    const outputTail = tail(output, MODEL_OUTPUT_LIMIT);
    events.append(this.runId, 'check.completed', { checkRunId, checkId, attempt, status, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, outputTail: tail(output, 2_000), artifactPath });
    return { checkRunId, checkId, status, exitCode: result.exitCode, durationMs: result.durationMs, artifactPath, outputTail, outputSha256, isolation: runner.mode };
  }

  // ---- pausing tools -------------------------------------------------------------------------

  private pauseTool(request: Extract<ToolRequest, { name: 'ask_user' | 'request_scope_change' | 'report_blocked' }>): ToolOutcome {
    const id = request.id;
    switch (request.name) {
      case 'ask_user': {
        const unknown = request.input.requirementIds.filter((r) => !this.requirementIds.has(r));
        if (unknown.length > 0) return this.reject(id, 'ask_user', request.input, 'UNKNOWN_REQUIREMENT', `unknown requirement ids ${unknown.join(', ')}`);
        this.options.events.append(this.runId, 'tool.approved', { toolCallId: id, name: 'ask_user' });
        return { kind: 'pause', toolCallId: id, pause: { type: 'question', toolCallId: id, question: request.input.question, choices: request.input.choices ?? [], reason: request.input.reason, requirementIds: request.input.requirementIds } };
      }
      case 'request_scope_change': {
        const paths: string[] = [];
        for (const p of request.input.additionalPaths) {
          const norm = normalizeRepoPath(p);
          if (!norm.ok) return this.reject(id, 'request_scope_change', request.input, norm.reasonCode, `${JSON.stringify(p)}: ${norm.message}`);
          // Denied paths can only be granted by the operator editing the contract, never via a model request.
          if (this.policy.denied(norm.path)) return this.reject(id, 'request_scope_change', request.input, 'PATH_DENIED', `${norm.path} is denied by the contract and cannot be requested`, { path: norm.path });
          if (!this.policy.writable(norm.path)) paths.push(norm.path);
        }
        if (paths.length === 0) return this.complete(id, 'request_scope_change', request.input, 'all requested paths are already writable', {});
        this.options.events.append(this.runId, 'tool.approved', { toolCallId: id, name: 'request_scope_change', additionalPaths: paths });
        return { kind: 'pause', toolCallId: id, pause: { type: 'scope_change', toolCallId: id, reason: request.input.reason, additionalPaths: paths } };
      }
      case 'report_blocked':
        this.options.events.append(this.runId, 'tool.approved', { toolCallId: id, name: 'report_blocked' });
        return { kind: 'pause', toolCallId: id, pause: { type: 'blocked', toolCallId: id, reason: request.input.reason, evidence: request.input.evidence ?? [] } };
    }
  }

  /** Records the final result of a pausing tool once the user/orchestrator has resolved it. */
  resolvePause(toolCallId: string, name: string, input: unknown, content: string, isError = false): ToolOutcome {
    return this.complete(toolCallId, name, input, content, { resolved: true }, isError);
  }
}
