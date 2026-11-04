import type Anthropic from '@anthropic-ai/sdk';
import type { CacheTtl } from '@aperture/contracts';

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelRequest {
  modelId: string;
  /** Stable system prefix (instructions + contract + context snapshot); cached. */
  system: string;
  tools: readonly ModelToolDefinition[];
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  cache: { enabled: boolean; ttl: CacheTtl };
  effort?: Effort;
  signal?: AbortSignal;
  /** Observable text deltas (never hidden reasoning). */
  onText?: (delta: string) => void;
}

export interface ModelResponse {
  message: Anthropic.Message;
  requestId: string;
}

export type ModelErrorKind = 'aborted' | 'retryable' | 'invalid_tool_json' | 'auth' | 'bad_request' | 'fatal';

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ModelErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

/** A model backend. The harness owns the loop, tools and state; providers only send one request. */
export interface ModelProvider {
  readonly name: string;
  send(request: ModelRequest): Promise<ModelResponse>;
}
