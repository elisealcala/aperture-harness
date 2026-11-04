import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, classifyError } from './anthropic.ts';
import { ModelProviderError, type ModelRequest } from './provider.ts';

const TOOL_SCHEMA = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    modelId: 'claude-sonnet-5-5',
    system: 'stable system prefix',
    tools: [
      { name: 'read_file', description: 'Read a file', inputSchema: TOOL_SCHEMA },
      { name: 'run_check', description: 'Run a check', inputSchema: { type: 'object', properties: {} } },
    ],
    messages: [{ role: 'user', content: 'kickoff' }],
    maxTokens: 4096,
    cache: { enabled: true, ttl: '5m' },
    ...overrides,
  };
}

// An explicit key keeps construction hermetic; buildParams never touches the network.
const provider = new AnthropicProvider({ apiKey: 'sk-ant-test-not-real', maxRetries: 0 });

describe('AnthropicProvider.buildParams', () => {
  it('puts an ephemeral cache breakpoint with the configured TTL on the system block and at the top level', () => {
    const params = provider.buildParams(request({ cache: { enabled: true, ttl: '1h' } }));
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.max_tokens).toBe(4096);
    expect(params.system).toEqual([{ type: 'text', text: 'stable system prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect((params as unknown as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('renders every tool with input_schema and eager input streaming, preserving order', () => {
    const params = provider.buildParams(request());
    expect(params.tools).toEqual([
      { name: 'read_file', description: 'Read a file', input_schema: TOOL_SCHEMA, eager_input_streaming: true },
      { name: 'run_check', description: 'Run a check', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true },
    ]);
  });

  it('passes the messages through unchanged', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'kickoff' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ];
    expect(provider.buildParams(request({ messages })).messages).toEqual(messages);
  });

  it('sets output_config.effort only when an effort is requested', () => {
    expect((provider.buildParams(request({ effort: 'high' })) as unknown as { output_config?: unknown }).output_config).toEqual({ effort: 'high' });
    expect(provider.buildParams(request())).not.toHaveProperty('output_config');
  });

  it('omits every cache_control marker when caching is disabled', () => {
    const params = provider.buildParams(request({ cache: { enabled: false, ttl: '5m' } }));
    expect(params).not.toHaveProperty('cache_control');
    expect(params.system).toEqual([{ type: 'text', text: 'stable system prefix' }]);
    expect(JSON.stringify(params)).not.toContain('cache_control');
  });

  it('never forwards the abort signal or the text callback as request params', () => {
    const params = provider.buildParams(request({ signal: new AbortController().signal, onText: () => {} }));
    expect(params).not.toHaveProperty('signal');
    expect(params).not.toHaveProperty('onText');
  });
});

type SdkApiError = InstanceType<typeof Anthropic.APIError>;
// Subclasses narrow their constructor parameters (e.g. status: 401), so accept any constructor here.
type ApiErrorCtor = abstract new (...args: never[]) => SdkApiError;

function apiError(Ctor: ApiErrorCtor, status: number): SdkApiError {
  const Make = Ctor as unknown as new (status: number, error: object, message: string, headers: Headers) => SdkApiError;
  return new Make(status, { type: 'error', error: { type: 'api_error', message: 'boom' } }, 'boom', new Headers());
}

describe('classifyError', () => {
  it('passes ModelProviderError through unchanged', () => {
    const original = new ModelProviderError('already classified', 'retryable', 503);
    expect(classifyError(original)).toBe(original);
  });

  it('maps a user abort to aborted', () => {
    expect(classifyError(new Anthropic.APIUserAbortError())).toMatchObject({ kind: 'aborted' });
  });

  it.each([
    ['AuthenticationError', Anthropic.AuthenticationError, 401, 'auth'],
    ['PermissionDeniedError', Anthropic.PermissionDeniedError, 403, 'auth'],
    ['RateLimitError', Anthropic.RateLimitError, 429, 'retryable'],
    ['InternalServerError', Anthropic.InternalServerError, 529, 'retryable'],
    ['BadRequestError', Anthropic.BadRequestError, 400, 'bad_request'],
    ['NotFoundError', Anthropic.NotFoundError, 404, 'bad_request'],
    ['UnprocessableEntityError', Anthropic.UnprocessableEntityError, 422, 'bad_request'],
    ['ConflictError (other APIError)', Anthropic.ConflictError, 409, 'fatal'],
  ] as const)('maps %s to %s with its HTTP status', (_label, Ctor, status, kind) => {
    const classified = classifyError(apiError(Ctor, status));
    expect(classified).toBeInstanceOf(ModelProviderError);
    expect(classified.kind).toBe(kind);
    expect(classified.status).toBe(status);
  });

  it('maps connection failures (incl. timeouts) to retryable without a status', () => {
    expect(classifyError(new Anthropic.APIConnectionError({ message: 'socket hang up' }))).toMatchObject({ kind: 'retryable', status: undefined });
    expect(classifyError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ kind: 'retryable' });
  });

  it('maps unparseable streamed tool JSON to invalid_tool_json', () => {
    expect(classifyError(new SyntaxError('Unexpected end of input'))).toMatchObject({ kind: 'invalid_tool_json' });
    expect(classifyError(new Error('Failed to parse JSON in tool input'))).toMatchObject({ kind: 'invalid_tool_json' });
  });

  it('maps anything else to fatal', () => {
    expect(classifyError(new Error('something odd'))).toMatchObject({ kind: 'fatal', message: 'something odd' });
    expect(classifyError('a string')).toMatchObject({ kind: 'fatal', message: 'a string' });
  });
});
