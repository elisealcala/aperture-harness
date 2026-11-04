import Anthropic from '@anthropic-ai/sdk';
import { ulid } from '@aperture/storage';
import { ModelProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from './provider.ts';

export interface AnthropicProviderOptions {
  /** Explicit key (from the configured env var). Omit to let the SDK resolve credentials itself. */
  apiKey?: string;
  baseURL?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Streaming Anthropic Messages adapter. Prompt layout for caching (§8): one explicit breakpoint on
 * the stable system prefix (which also covers the tool definitions rendered before it) plus
 * top-level automatic caching that follows the growing conversation tail.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: options.maxRetries ?? 3,
      timeout: options.timeoutMs ?? 10 * 60 * 1000,
    });
  }

  buildParams(request: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
    const cacheControl: Anthropic.CacheControlEphemeral | undefined = request.cache.enabled ? { type: 'ephemeral', ttl: request.cache.ttl } : undefined;
    return {
      model: request.modelId,
      max_tokens: request.maxTokens,
      system: [{ type: 'text', text: request.system, ...(cacheControl ? { cache_control: cacheControl } : {}) }],
      ...(request.tools.length > 0 ? { tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        // Stream large inputs (diffs) as generated; the gateway validates every input with Zod.
        eager_input_streaming: true,
      })) } : {}),
      messages: request.messages,
      ...(cacheControl ? { cache_control: cacheControl } : {}),
      ...(request.effort || request.outputSchema
        ? { output_config: { ...(request.effort ? { effort: request.effort } : {}), ...(request.outputSchema ? { format: { type: 'json_schema' as const, schema: request.outputSchema } } : {}) } }
        : {}),
    };
  }

  async send(request: ModelRequest): Promise<ModelResponse> {
    const params = this.buildParams(request);
    try {
      const stream = this.client.messages.stream(params, request.signal ? { signal: request.signal } : {});
      if (request.onText) stream.on('text', request.onText);
      const message = await stream.finalMessage();
      const requestId = (message as Anthropic.Message & { _request_id?: string | null })._request_id ?? `req_${ulid()}`;
      return { message, requestId };
    } catch (err) {
      throw classifyError(err);
    }
  }
}

export function classifyError(err: unknown): ModelProviderError {
  if (err instanceof ModelProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ModelProviderError('request aborted', 'aborted');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ModelProviderError(`authentication failed: ${err.message}`, 'auth', err.status);
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return new ModelProviderError(`provider unavailable: ${err.message}`, 'retryable', err instanceof Anthropic.APIError ? err.status : undefined);
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError) {
    return new ModelProviderError(`request rejected: ${err.message}`, 'bad_request', err.status);
  }
  if (err instanceof Anthropic.APIError) return new ModelProviderError(`provider error: ${err.message}`, 'fatal', err.status);
  // With eager input streaming, unparseable tool JSON surfaces as a plain (non-API) error.
  if (err instanceof SyntaxError || (err instanceof Error && /JSON/i.test(err.message))) {
    return new ModelProviderError(`model emitted unparseable tool input: ${err.message}`, 'invalid_tool_json');
  }
  return new ModelProviderError(err instanceof Error ? err.message : String(err), 'fatal');
}
