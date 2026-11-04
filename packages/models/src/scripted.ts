import type Anthropic from '@anthropic-ai/sdk';
import { ulid } from '@aperture/storage';
import { ModelProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from './provider.ts';

export interface ScriptedTurn {
  /** Visible text emitted before any tool calls. */
  text?: string;
  toolCalls?: Array<{ id?: string; name: string; input: unknown }>;
  stopReason?: Anthropic.StopReason;
  usage?: Partial<{ input: number; output: number; cacheWrite: number; cacheRead: number }>;
  /** Throw instead of answering (e.g. to simulate a provider outage). */
  error?: ModelProviderError;
}

export type ScriptedResponder = ScriptedTurn | ((request: ModelRequest, turn: number) => ScriptedTurn);

/** Builds an SDK-shaped `Message` for offline providers and tests. */
export function fakeMessage(modelId: string, turn: ScriptedTurn): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (turn.text) content.push({ type: 'text', text: turn.text, citations: null } as Anthropic.TextBlock);
  for (const call of turn.toolCalls ?? []) {
    content.push({ type: 'tool_use', id: call.id ?? `toolu_${ulid()}`, name: call.name, input: call.input, caller: null } as unknown as Anthropic.ToolUseBlock);
  }
  const usage = turn.usage ?? {};
  return {
    id: `msg_${ulid()}`,
    type: 'message',
    role: 'assistant',
    model: modelId,
    content,
    stop_reason: turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: usage.input ?? 1000,
      output_tokens: usage.output ?? 200,
      cache_creation_input_tokens: usage.cacheWrite ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: null,
    },
  } as unknown as Anthropic.Message;
}

/**
 * Deterministic provider that replays scripted turns. Each request is recorded so tests can assert
 * on prompt layout, cache markers and budgets without network access.
 */
export class ScriptedModelProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly turns: readonly ScriptedResponder[]) {}

  get remaining(): number {
    return this.turns.length - this.index;
  }

  async send(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new ModelProviderError('request aborted', 'aborted');
    this.requests.push(structuredClone({ ...request, signal: undefined, onText: undefined }));
    const responder = this.turns[this.index];
    if (!responder) throw new ModelProviderError('scripted provider has no more turns', 'fatal');
    const turn = typeof responder === 'function' ? responder(request, this.index) : responder;
    this.index++;
    if (turn.error) throw turn.error;
    if (turn.text && request.onText) request.onText(turn.text);
    return { message: fakeMessage(request.modelId, turn), requestId: `req_${ulid()}` };
  }
}
