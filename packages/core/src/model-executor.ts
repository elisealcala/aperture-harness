import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { buildContextSnapshot, buildKickoffMessage, buildSystemPrompt, type SnapshotFile } from '@aperture/context';
import { toolDefinitions, type ToolGateway } from '@aperture/gateway';
import {
  BudgetMeter,
  computeCost,
  estimateTokens,
  ModelProviderError,
  normalizeUsage,
  UnknownModelError,
  type Effort,
  type ModelProvider,
  type ModelRegistry,
} from '@aperture/models';
import { gitStdout } from '@aperture/sandbox';
import type { NormalizedTask } from '@aperture/sources';
import type { ExecutionContext, Executor, ExecutorOutcome } from './executor.ts';
import type { Harness } from './harness.ts';

export interface ModelExecutorOptions {
  provider: ModelProvider;
  registry: ModelRegistry;
  effort?: Effort;
  reserveFraction?: number;
  /** Coalesce streamed text into events of at most this many characters. */
  deltaChunkChars?: number;
}

type ToolUse = { id: string; name: string; input: unknown };

const BUDGET_WARNING_FRACTION = 0.8;

function contentBlocks(message: Anthropic.MessageParam): Array<{ type: string } & Record<string, unknown>> {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content as unknown as Array<{ type: string } & Record<string, unknown>>);
}

function toolUsesOf(message: Anthropic.MessageParam): ToolUse[] {
  return contentBlocks(message)
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: String(b.id), name: String(b.name), input: b.input }));
}

function textOf(message: Anthropic.MessageParam): string {
  return contentBlocks(message)
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text))
    .join('\n')
    .trim();
}

/** Buffers streamed text so the event log gets readable chunks instead of single tokens. */
class DeltaBuffer {
  private buffer = '';
  constructor(
    private readonly flushTo: (text: string) => void,
    private readonly maxChars: number,
  ) {}

  push(delta: string): void {
    this.buffer += delta;
    if (this.buffer.length >= this.maxChars || delta.includes('\n')) this.flush();
  }

  flush(): void {
    if (this.buffer.length > 0) this.flushTo(this.buffer);
    this.buffer = '';
  }
}

/**
 * The Sonnet execution worker (§8–§9): a bounded, persisted, manual streaming tool loop. Every
 * request passes the budget gate first; every assistant turn is persisted before its tools run, so
 * a crash leaves an exact record of which tool calls were pending.
 */
export class ModelExecutor implements Executor {
  readonly modelId = 'model';

  constructor(private readonly options: ModelExecutorOptions) {}

  async run(ctx: ExecutionContext): Promise<ExecutorOutcome> {
    const { harness, contract, gateway, signal } = ctx;
    const runId = ctx.run.runId;
    const spec = contract.contract.spec;
    const modelId = spec.models.implement;
    const { registry, provider } = this.options;
    try {
      registry.get(modelId);
    } catch (err) {
      if (err instanceof UnknownModelError) return { type: 'failed', reason: err.message };
      throw err;
    }

    const system = buildSystemPrompt(contract, await this.contextSnapshot(harness, ctx));
    const tools = toolDefinitions();
    const ttl = spec.cache.ttl;

    if (harness.store.loadConversation(runId).length === 0) {
      const task = JSON.parse(harness.store.getTask(ctx.run.taskId)!.snapshotJson) as NormalizedTask;
      harness.store.appendConversation(runId, 'user', JSON.stringify(buildKickoffMessage(contract, task)));
    }

    // Resume: finish any tool calls of the last assistant turn before asking the model again.
    const last = this.conversation(harness, runId).at(-1);
    if (last?.role === 'assistant') {
      const pending = toolUsesOf(last);
      if (pending.length === 0) return { type: 'candidate', summary: textOf(last) || 'model finished' };
      const step = await this.executeTools(harness, runId, gateway, pending);
      if (step) return step;
    }

    const meter = new BudgetMeter({
      registry,
      modelId,
      budgetUsd: spec.limits.maxCostUsd,
      reserveFraction: this.options.reserveFraction ?? harness.config.limits.reserveFraction,
      spentUsd: () => harness.store.spentUsd(runId, 'implementation'),
      ttl,
    });
    const maxOutput = registry.get(modelId).maxOutputTokens ?? 64_000;
    let maxTokensCap = Math.min(spec.limits.maxOutputTokensPerTurn, maxOutput);
    let invalidJsonRetries = 0;

    for (;;) {
      if (signal.aborted) return { type: 'interrupted' };
      const run = harness.getRun(runId);
      if (run.state !== 'EXECUTING') return { type: 'interrupted' };
      if (run.turns >= spec.limits.maxModelTurns) return { type: 'blocked', code: 'TURN_LIMIT', reason: `reached the ${spec.limits.maxModelTurns}-turn limit` };
      if (harness.executingElapsedMs(run) > spec.limits.maxWallClockMinutes * 60_000) {
        return { type: 'blocked', code: 'TIME_LIMIT', reason: `exceeded ${spec.limits.maxWallClockMinutes} minutes of execution` };
      }

      const messages = this.conversation(harness, runId);
      const promptEstimate = estimateTokens(system) + estimateTokens(JSON.stringify(tools)) + estimateTokens(JSON.stringify(messages));
      const admission = meter.admit(promptEstimate, maxTokensCap);
      if (!admission.admitted) {
        harness.emit(runId, 'budget.exhausted', { phase: 'implementation', reason: admission.reason, spentUsd: meter.spent(), budgetUsd: meter.budgetUsd });
        return { type: 'blocked', code: 'BUDGET_EXHAUSTED', reason: admission.reason ?? 'budget exhausted' };
      }

      const turn = harness.store.incrementRunCounter(runId, 'turns');
      harness.emit(runId, 'model.request.started', { turn, modelId, maxTokens: admission.maxTokens, estimatedPromptTokens: promptEstimate, estimatedMaxUsd: admission.worstCaseUsd, cache: spec.cache });
      const deltas = new DeltaBuffer((text) => harness.emit(runId, 'model.output.delta', { turn, text }), this.options.deltaChunkChars ?? 400);

      let response;
      try {
        response = await provider.send({
          modelId,
          system,
          tools,
          messages,
          maxTokens: admission.maxTokens,
          cache: spec.cache,
          ...(this.options.effort ? { effort: this.options.effort } : {}),
          signal,
          onText: (d) => deltas.push(d),
        });
      } catch (err) {
        deltas.flush();
        const error = err instanceof ModelProviderError ? err : new ModelProviderError(String(err), 'fatal');
        if (error.kind === 'aborted') {
          // Usage of an aborted stream is unknown: charge the conservative preflight estimate.
          this.recordUsage(harness, runId, modelId, `aborted_${turn}_${Date.now()}`, null, admission.worstCaseUsd, meter);
          return { type: 'interrupted' };
        }
        harness.emit(runId, 'error', { message: error.message, kind: error.kind, status: error.status ?? null, turn });
        if (error.kind === 'invalid_tool_json' && invalidJsonRetries++ < 2) continue;
        if (error.kind === 'retryable') return { type: 'interrupted', reason: `provider unavailable after retries: ${error.message}` };
        return { type: 'failed', reason: error.message };
      }
      deltas.flush();
      invalidJsonRetries = 0;

      const message = response.message;
      const usage = normalizeUsage(message.usage, ttl);
      const hasToolUse = message.content.some((b) => b.type === 'tool_use');
      const appendAssistant = !(message.stop_reason === 'max_tokens' && hasToolUse) && message.stop_reason !== 'refusal';
      harness.store.transaction(() => {
        this.recordUsage(harness, runId, modelId, response.requestId, usage, admission.worstCaseUsd, meter);
        if (appendAssistant) harness.store.appendConversation(runId, 'assistant', JSON.stringify(message.content));
      });
      harness.emit(runId, 'model.response.completed', { turn, stopReason: message.stop_reason, toolCalls: message.content.filter((b) => b.type === 'tool_use').length });

      switch (message.stop_reason) {
        case 'refusal': {
          const details = (message as Anthropic.Message & { stop_details?: { category?: string | null } | null }).stop_details;
          return { type: 'blocked', code: 'MODEL_REFUSAL', reason: `model declined the request${details?.category ? ` (${details.category})` : ''}` };
        }
        case 'model_context_window_exceeded':
          return { type: 'blocked', code: 'CONTEXT_EXHAUSTED', reason: 'conversation exceeded the model context window' };
        case 'max_tokens':
          if (hasToolUse) {
            // A truncated tool input can still parse; never run it. Retry the turn with more room.
            if (maxTokensCap >= maxOutput) return { type: 'blocked', code: 'OUTPUT_LIMIT', reason: 'tool input exceeded the maximum output size' };
            maxTokensCap = Math.min(maxTokensCap * 2, maxOutput);
            continue;
          }
          return { type: 'candidate', summary: `${textOf({ role: 'assistant', content: message.content })} [truncated at max_tokens]` };
        case 'pause_turn':
          continue;
        case 'tool_use': {
          const step = await this.executeTools(harness, runId, gateway, toolUsesOf({ role: 'assistant', content: message.content }));
          if (step) return step;
          continue;
        }
        default:
          return { type: 'candidate', summary: textOf({ role: 'assistant', content: message.content }) || 'model finished' };
      }
    }
  }

  private conversation(harness: Harness, runId: string): Anthropic.MessageParam[] {
    return harness.store.loadConversation(runId).map((entry) => ({ role: entry.role, content: JSON.parse(entry.contentJson) as Anthropic.MessageParam['content'] }));
  }

  private recordUsage(harness: Harness, runId: string, modelId: string, requestId: string, usage: ReturnType<typeof normalizeUsage> | null, estimatedUsd: number, meter: BudgetMeter): void {
    const cost = usage ? computeCost(this.options.registry, modelId, usage) : { usd: estimatedUsd, tier: 'standard' as const };
    const before = meter.spent();
    harness.store.insertUsage({
      requestId,
      runId,
      phase: 'implementation',
      modelId,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheWrite: (usage?.cacheWrite5m ?? 0) + (usage?.cacheWrite1h ?? 0),
      cacheRead: usage?.cacheRead ?? 0,
      costUsd: cost.usd,
      estimatedUsd,
      createdAt: new Date().toISOString(),
    });
    const spent = meter.spent();
    harness.emit(runId, 'model.usage.recorded', {
      requestId,
      phase: 'implementation',
      modelId,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheWrite: (usage?.cacheWrite5m ?? 0) + (usage?.cacheWrite1h ?? 0),
      cacheRead: usage?.cacheRead ?? 0,
      costUsd: cost.usd,
      estimatedMaxUsd: estimatedUsd,
      tier: cost.tier,
      actual: usage !== null,
      spentUsd: spent,
      budgetUsd: meter.budgetUsd,
    });
    if (before < meter.budgetUsd * BUDGET_WARNING_FRACTION && spent >= meter.budgetUsd * BUDGET_WARNING_FRACTION) {
      harness.emit(runId, 'budget.warning', { phase: 'implementation', spentUsd: spent, budgetUsd: meter.budgetUsd });
    }
  }

  /** Runs tool calls in order; returns an outcome when the loop must stop (pause / block). */
  private async executeTools(harness: Harness, runId: string, gateway: ToolGateway, toolUses: ToolUse[]): Promise<ExecutorOutcome | undefined> {
    const results: Anthropic.ToolResultBlockParam[] = [];
    let patchLimit = false;
    for (const use of toolUses) {
      const outcome = await gateway.execute({ id: use.id, name: use.name, input: use.input });
      if (outcome.kind === 'pause') {
        if (outcome.pause.type === 'blocked') return { type: 'blocked', code: 'AGENT_REPORTED_BLOCKED', reason: outcome.pause.reason };
        // Results gathered so far are recorded by the gateway and replayed on resume.
        return { type: 'paused', pause: outcome.pause };
      }
      if (outcome.reasonCode === 'PATCH_LIMIT_REACHED') patchLimit = true;
      results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
    }
    harness.store.appendConversation(runId, 'user', JSON.stringify(results));
    if (patchLimit) return { type: 'blocked', code: 'PATCH_LIMIT', reason: 'patch attempt limit reached' };
    return undefined;
  }

  private async contextSnapshot(harness: Harness, ctx: ExecutionContext): Promise<string> {
    const path = join(harness.layout.runDir(ctx.run.runId), 'context.snapshot.txt');
    if (existsSync(path)) return readFileSync(path, 'utf8');
    const worktree = ctx.run.worktreePath!;
    const baseline = ctx.run.baselineSha!;
    const tracked = (await gitStdout(worktree, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', baseline])).split('\0').filter(Boolean);
    const readable = tracked.filter((p) => ctx.gateway.policy.readable(p));
    const writableFiles: SnapshotFile[] = [];
    for (const p of tracked.filter((t) => ctx.gateway.policy.writable(t))) {
      const content = await gitStdout(worktree, ['show', `${baseline}:${p}`], { maxOutputBytes: 512 * 1024 });
      if (!content.includes('\0')) writableFiles.push({ path: p, content });
    }
    const snapshot = buildContextSnapshot({ readablePaths: readable, writableFiles });
    harness.writeArtifact(ctx.run.runId, 'context.snapshot.txt', snapshot, 'context_snapshot');
    return snapshot;
  }
}
