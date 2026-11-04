import { describe, expect, it } from 'vitest';
import { ModelProviderError, type ModelRequest } from './provider.ts';
import { fakeMessage, ScriptedModelProvider } from './scripted.ts';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    modelId: 'claude-sonnet-5-5',
    system: 'system',
    tools: [],
    messages: [{ role: 'user', content: 'go' }],
    maxTokens: 1000,
    cache: { enabled: true, ttl: '5m' },
    ...overrides,
  };
}

describe('fakeMessage', () => {
  it('builds text then tool_use blocks with tool_use as the default stop reason', () => {
    const message = fakeMessage('claude-sonnet-5-5', { text: 'reading', toolCalls: [{ id: 'toolu_a', name: 'read_file', input: { path: 'x' } }, { name: 'run_check', input: { checkId: 'unit' } }] });
    expect(message.model).toBe('claude-sonnet-5-5');
    expect(message.role).toBe('assistant');
    expect(message.stop_reason).toBe('tool_use');
    expect(message.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use']);
    expect(message.content[1]).toMatchObject({ id: 'toolu_a', name: 'read_file', input: { path: 'x' } });
    expect((message.content[2] as { id: string }).id).toMatch(/^toolu_/);
  });

  it('defaults to end_turn without tool calls and honors an explicit stop reason', () => {
    expect(fakeMessage('m', { text: 'done' }).stop_reason).toBe('end_turn');
    expect(fakeMessage('m', { text: 'cut', stopReason: 'max_tokens' }).stop_reason).toBe('max_tokens');
  });

  it('maps scripted usage onto the SDK usage fields with defaults', () => {
    expect(fakeMessage('m', {}).usage).toMatchObject({ input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null });
    expect(fakeMessage('m', { usage: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } }).usage).toMatchObject({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 });
  });
});

describe('ScriptedModelProvider', () => {
  it('replays turns in order, records each request, and streams text to onText', async () => {
    const provider = new ScriptedModelProvider([{ text: 'first' }, { text: 'second' }]);
    const deltas: string[] = [];
    const a = await provider.send(request({ onText: (d) => deltas.push(d) }));
    const b = await provider.send(request({ maxTokens: 7 }));
    expect([a.message.content[0], b.message.content[0]]).toMatchObject([{ text: 'first' }, { text: 'second' }]);
    expect(a.requestId).toMatch(/^req_/);
    expect(a.requestId).not.toBe(b.requestId);
    expect(deltas).toEqual(['first']);
    expect(provider.requests.map((r) => r.maxTokens)).toEqual([1000, 7]);
    expect(provider.remaining).toBe(0);
  });

  it('records requests without the signal or callback and as a deep copy', async () => {
    const provider = new ScriptedModelProvider([{ text: 'ok' }]);
    const req = request({ signal: new AbortController().signal, onText: () => {} });
    await provider.send(req);
    expect(provider.requests[0]!.signal).toBeUndefined();
    expect(provider.requests[0]!.onText).toBeUndefined();
    req.messages.push({ role: 'assistant', content: 'mutated later' });
    expect(provider.requests[0]!.messages).toHaveLength(1);
  });

  it('passes the request and turn index to function responders', async () => {
    const seen: Array<[number, number]> = [];
    const provider = new ScriptedModelProvider([
      (req, turn) => {
        seen.push([turn, req.messages.length]);
        return { text: `turn ${turn}` };
      },
      (req, turn) => {
        seen.push([turn, req.messages.length]);
        return { text: `turn ${turn}` };
      },
    ]);
    await provider.send(request());
    await provider.send(request({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }));
    expect(seen).toEqual([
      [0, 1],
      [1, 3],
    ]);
  });

  it('throws a scripted error (and still consumes the turn)', async () => {
    const provider = new ScriptedModelProvider([{ error: new ModelProviderError('overloaded', 'retryable', 529) }, { text: 'recovered' }]);
    await expect(provider.send(request())).rejects.toMatchObject({ kind: 'retryable', status: 529 });
    await expect(provider.send(request())).resolves.toMatchObject({ message: { content: [{ text: 'recovered' }] } });
  });

  it('fails fatally when the script is exhausted', async () => {
    const provider = new ScriptedModelProvider([]);
    await expect(provider.send(request())).rejects.toMatchObject({ kind: 'fatal' });
  });

  it('refuses an already-aborted request without consuming or recording a turn', async () => {
    const provider = new ScriptedModelProvider([{ text: 'unused' }]);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.send(request({ signal: controller.signal }))).rejects.toMatchObject({ kind: 'aborted' });
    expect(provider.requests).toHaveLength(0);
    expect(provider.remaining).toBe(1);
  });
});
