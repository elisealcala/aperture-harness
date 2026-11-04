import type Anthropic from '@anthropic-ai/sdk';
import {
  ModelExecutor,
  type ContractProposal,
  type ContractReviewResult,
  type Interaction,
  type QuestionAnswer,
  type QuestionPrompt,
  type ScopeChangePrompt,
  type ScopeDecision,
} from '../../packages/core/src/index.ts';
import { ModelRegistry, ScriptedModelProvider, type ModelRequest, type ScriptedResponder, type ScriptedTurn } from '../../packages/models/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import type { HarnessFixture } from './harness.ts';

/** A ModelExecutor wired to a ScriptedModelProvider (no network). */
export function scriptedModel(turns: readonly ScriptedResponder[], options: { reserveFraction?: number } = {}): { provider: ScriptedModelProvider; executor: ModelExecutor } {
  const provider = new ScriptedModelProvider(turns);
  return { provider, executor: new ModelExecutor({ provider, registry: new ModelRegistry(), ...options }) };
}

/** Ingests the fixture contract (reduced isolation); the run waits in NEEDS_CONTRACT_REVIEW. */
export async function ingestFixture(fx: HarnessFixture): Promise<RunRecord> {
  return fx.harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation: 'reduced', questionMode: 'interactive' });
}

/**
 * Interactive test double: approves contracts and answers questions / scope requests from queues.
 * An exhausted queue (or an explicit `null`) means "not now", which leaves the run waiting.
 */
export class ScriptedInteraction implements Interaction {
  readonly interactive = true;
  readonly questions: QuestionPrompt[] = [];
  readonly scopePrompts: ScopeChangePrompt[] = [];
  private readonly answers: Array<QuestionAnswer | null>;
  private readonly scopeDecisions: Array<ScopeDecision | null>;

  constructor(
    script: { answers?: Array<QuestionAnswer | null>; scope?: Array<ScopeDecision | null> } = {},
    readonly actor = 'tester',
  ) {
    this.answers = [...(script.answers ?? [])];
    this.scopeDecisions = [...(script.scope ?? [])];
  }

  async reviewContract(_proposal: ContractProposal): Promise<ContractReviewResult | null> {
    return { action: 'approve' };
  }

  async askQuestion(prompt: QuestionPrompt): Promise<QuestionAnswer | null> {
    this.questions.push(prompt);
    return this.answers.shift() ?? null;
  }

  async decideScopeChange(prompt: ScopeChangePrompt): Promise<ScopeDecision | null> {
    this.scopePrompts.push(prompt);
    return this.scopeDecisions.shift() ?? null;
  }

  async confirm(): Promise<boolean> {
    return false;
  }
}

// ---- scripted turn builders ------------------------------------------------------------------

export function readTurn(path: string, id = `toolu_read_${path.replace(/\W/g, '_')}`): ScriptedTurn {
  return { text: `Reading ${path}.`, toolCalls: [{ id, name: 'read_file', input: { path } }] };
}

export function patchCall(path: string, unifiedDiff: string, requirementIds: string[], id: string): { id: string; name: string; input: unknown } {
  return { id, name: 'propose_patch', input: { path, unifiedDiff, requirementIds } };
}

export function patchTurn(path: string, unifiedDiff: string, requirementIds: string[], id: string): ScriptedTurn {
  return { toolCalls: [patchCall(path, unifiedDiff, requirementIds, id)] };
}

export function askTurn(id: string, question: string, extra: { choices?: string[]; requirementIds?: string[] } = {}): ScriptedTurn {
  return { toolCalls: [{ id, name: 'ask_user', input: { question, reason: 'the contract does not decide this', requirementIds: extra.requirementIds ?? ['R1'], blocking: true, ...(extra.choices ? { choices: extra.choices } : {}) } }] };
}

export function scopeTurn(id: string, additionalPaths: string[]): ScriptedTurn {
  return { toolCalls: [{ id, name: 'request_scope_change', input: { reason: 'types belong in their own module', additionalPaths } }] };
}

export const DONE: ScriptedTurn = { text: 'R1 and R2 implemented in src/api/session.ts.' };

// ---- request inspection ----------------------------------------------------------------------

type Block = { type: string } & Record<string, unknown>;

function blocks(message: Anthropic.MessageParam | undefined): Block[] {
  if (!message) return [];
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content as unknown as Block[]);
}

/** The tool_result blocks in the last (user) message of a request. */
export function lastToolResults(request: ModelRequest): Array<{ tool_use_id: string; content: string; is_error?: boolean }> {
  const last = request.messages.at(-1);
  if (last?.role !== 'user') return [];
  return blocks(last).filter((b) => b.type === 'tool_result') as unknown as Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
}

/** Tool_use blocks of a persisted assistant message. */
export function toolUseIds(message: Anthropic.MessageParam | undefined): string[] {
  return blocks(message)
    .filter((b) => b.type === 'tool_use')
    .map((b) => String(b.id));
}
