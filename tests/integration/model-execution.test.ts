/**
 * Stage 2 model loop: ModelExecutor + Orchestrator against a real worktree with a scripted provider
 * (no network). Covers the happy path, prompt/caching layout, the usage ledger (AT-11), budget stops
 * (AT-10), the turn limit, and the per-run artifacts written after verification.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_INSTRUCTIONS } from '../../packages/context/src/index.ts';
import { NonInteractive, Orchestrator } from '../../packages/core/src/index.ts';
import { TOOL_NAMES, toolDefinitions } from '../../packages/gateway/src/index.ts';
import { computeCost, ModelProviderError, ModelRegistry, normalizeUsage, type ScriptedModelProvider } from '../../packages/models/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import type { VerificationReport } from '../../packages/verifier/src/index.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarnessFixture, fixtureContract, prepareRun, type FixtureContractOptions, type HarnessFixture } from '../helpers/harness.ts';
import { DONE, ingestFixture, lastToolResults, patchTurn, readTurn, scriptedModel, toolUseIds } from '../helpers/model.ts';
import { SESSION_METADATA_PATCH, SESSION_TS } from '../helpers/repo.ts';
import { TempDirs } from '../helpers/tmp.ts';

const SONNET = 'claude-sonnet-5-5';
const registry = new ModelRegistry();
const approveOnly = () => new NonInteractive('test', { approveContracts: true });

function eventPayloads(fx: HarnessFixture, runId: string, type: string): Array<Record<string, unknown>> {
  return fx.harness.events.list(runId, { types: [type as never] }).map((e) => e.payload);
}

describe('happy path: read → patch → end_turn → verification → READY_FOR_REVIEW', () => {
  const tmp = new TempDirs();
  let fx: HarnessFixture;
  let provider: ScriptedModelProvider;
  let final: RunRecord;

  beforeAll(async () => {
    // A non-default cache TTL proves the request settings come from the approved contract.
    fx = createHarnessFixture(tmp, fixtureContract({ mutate: (c) => void (c.spec.cache = { enabled: true, ttl: '1h' }) }));
    const run = await ingestFixture(fx);
    const model = scriptedModel([readTurn('src/api/session.ts', 'toolu_read'), patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_patch'), DONE]);
    provider = model.provider;
    final = await new Orchestrator(fx.harness).drive(run.runId, { executor: model.executor, interaction: approveOnly() });
  });

  afterAll(() => {
    fx.harness.close();
    tmp.cleanup();
  });

  it('reaches READY_FOR_REVIEW after a passing verification', () => {
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(final.terminalReason).toBeNull();
    expect(final).toMatchObject({ turns: 3, patchAttempts: 1, verificationAttempts: 1, modelId: SONNET });
    expect(eventPayloads(fx, final.runId, 'verification.completed')).toEqual([expect.objectContaining({ attempt: 1, result: 'PASS', violations: [] })]);
    expect(provider.remaining).toBe(0);
  });

  it('sends system + tools with the cache settings and model from the contract', () => {
    expect(provider.requests).toHaveLength(3);
    for (const request of provider.requests) {
      expect(request.modelId).toBe(SONNET);
      expect(request.cache).toEqual({ enabled: true, ttl: '1h' });
      expect(request.tools).toEqual(toolDefinitions());
      expect(request.maxTokens).toBe(16_000);
    }
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    const contract = fx.harness.approvedContract(final);
    const system = provider.requests[0]!.system;
    expect(system.startsWith(SYSTEM_INSTRUCTIONS)).toBe(true);
    expect(system).toContain(`<approved_contract id="LOCAL-142" version="1" sha256="${contract.sha256}">`);
    expect(system).toContain(`<file path="src/api/session.ts">\n${SESSION_TS}\n</file>`);
  });

  it('keeps the cached prefix byte-identical across turns and persists the snapshot', () => {
    const systems = new Set(provider.requests.map((r) => r.system));
    expect(systems.size).toBe(1);
    const snapshotPath = join(fx.harness.layout.runDir(final.runId), 'context.snapshot.txt');
    expect(provider.requests[0]!.system.endsWith(readFileSync(snapshotPath, 'utf8'))).toBe(true);
  });

  it('grows the message history append-only and feeds tool results back by tool_use id', () => {
    const [r0, r1, r2] = provider.requests;
    expect(r0!.messages).toHaveLength(1);
    expect(r0!.messages[0]!.role).toBe('user');
    expect(r0!.messages[0]!.content).toContain('<source_ticket ref="local:');
    expect(r0!.messages[0]!.content).toContain('trust="untrusted"');
    expect(r1!.messages.slice(0, r0!.messages.length)).toEqual(r0!.messages);
    expect(r2!.messages.slice(0, r1!.messages.length)).toEqual(r1!.messages);
    expect(lastToolResults(r1!)).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_read', content: expect.stringMatching(/^src\/api\/session\.ts \(lines 1-8 of 8\)\n1\t\/\/ SESSION_MARKER/) }]);
    expect(lastToolResults(r2!)).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_patch', content: 'applied patch to src/api/session.ts (+2 -1) for R1, R2' }]);
  });

  it('persists the full conversation, including the final assistant turn', () => {
    const conversation = fx.harness.store.loadConversation(final.runId);
    expect(conversation.map((e) => e.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    const parsed = conversation.map((e) => ({ role: e.role, content: JSON.parse(e.contentJson) as never }));
    expect(toolUseIds(parsed[1])).toEqual(['toolu_read']);
    expect(toolUseIds(parsed[3])).toEqual(['toolu_patch']);
    expect(parsed[5]!.content).toEqual([expect.objectContaining({ type: 'text', text: DONE.text })]);
    // What the provider saw is exactly what was persisted (minus the final turn).
    expect(provider.requests[2]!.messages).toEqual(parsed.slice(0, 5));
  });

  it('records one implementation usage row per request, priced by computeCost', () => {
    const rows = fx.harness.store.usageForRun(final.runId);
    expect(rows).toHaveLength(3);
    const expected = computeCost(registry, SONNET, { input: 1000, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }).usd;
    for (const row of rows) {
      expect(row).toMatchObject({ runId: final.runId, phase: 'implementation', modelId: SONNET, input: 1000, output: 200, cacheWrite: 0, cacheRead: 0 });
      expect(row.requestId).toMatch(/^req_/);
      expect(row.costUsd).toBeCloseTo(expected, 12);
      expect(row.estimatedUsd).toBeGreaterThan(row.costUsd);
    }
    expect(fx.harness.store.spentUsd(final.runId, 'implementation')).toBeCloseTo(3 * expected, 12);
  });

  it('emits request/usage/stream events and no budget warning', () => {
    const started = eventPayloads(fx, final.runId, 'model.request.started');
    expect(started.map((p) => p.turn)).toEqual([1, 2, 3]);
    expect(started[0]).toMatchObject({ modelId: SONNET, maxTokens: 16_000, cache: { enabled: true, ttl: '1h' } });
    expect(eventPayloads(fx, final.runId, 'model.usage.recorded')).toHaveLength(3);
    expect(eventPayloads(fx, final.runId, 'model.usage.recorded').every((p) => p.actual === true && p.phase === 'implementation')).toBe(true);
    expect(eventPayloads(fx, final.runId, 'model.output.delta').map((p) => p.text)).toEqual(['Reading src/api/session.ts.', DONE.text]);
    expect(eventPayloads(fx, final.runId, 'budget.warning')).toEqual([]);
  });

  it('writes verification.json, proposed.patch, report.md and usage.json under runs/<id>/', () => {
    const dir = join(fx.storageDir, 'runs', final.runId);
    for (const name of ['verification.json', 'proposed.patch', 'report.md', 'usage.json']) expect(existsSync(join(dir, name)), name).toBe(true);

    const verification = JSON.parse(readFileSync(join(dir, 'verification.json'), 'utf8')) as VerificationReport;
    expect(verification).toMatchObject({ result: 'PASS', attempt: 1, baselineSha: fx.repo.headSha });
    expect(verification.requirements.map((r) => [r.id, r.status, r.patchOperations])).toEqual([
      ['R1', 'VERIFIED', ['toolu_patch']],
      ['R2', 'VERIFIED', ['toolu_patch']],
    ]);

    const patch = readFileSync(join(dir, 'proposed.patch'), 'utf8');
    expect(patch).toContain('diff --git a/src/api/session.ts b/src/api/session.ts');
    expect(patch).toContain('+  metadata?: Record<string, string>;');

    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(report).toContain(`# Aperture run ${final.runId}`);
    expect(report).toContain('- **State:** READY_FOR_REVIEW');
    expect(report).toContain('## Verification (attempt 1): PASS');
    expect(report).toContain('| R1 | VERIFIED |');
    expect(report).toContain('| `src/api/session.ts` | M | 2 | 1 |');
    expect(report).toContain(`| implementation | ${SONNET} | 3 | 3000 | 600 | 0 | 0 |`);

    const usage = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')) as { requests: unknown[]; totals: Array<Record<string, unknown>> };
    expect(usage.requests).toHaveLength(3);
    expect(usage.totals).toEqual([expect.objectContaining({ phase: 'implementation', modelIds: [SONNET], requests: 3, input: 3000, output: 600 })]);

    const types = fx.harness.store.artifactsForRun(final.runId).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(['verification', 'patch', 'report', 'usage', 'context_snapshot']));
  });
});

describe('model loop limits and ledger', () => {
  const tmp = new TempDirs();
  let fx: HarnessFixture;

  afterEach(() => {
    fx.harness.close();
    tmp.cleanup();
  });

  async function driveWith(contractOptions: FixtureContractOptions, turns: Parameters<typeof scriptedModel>[0]): Promise<{ final: RunRecord; provider: ScriptedModelProvider }> {
    fx = createHarnessFixture(tmp, fixtureContract(contractOptions));
    const run = await ingestFixture(fx);
    const model = scriptedModel(turns);
    const final = await new Orchestrator(fx.harness).drive(run.runId, { executor: model.executor, interaction: approveOnly() });
    return { final, provider: model.provider };
  }

  describe('AT-11: prompt cache usage is recorded separately', () => {
    const USAGES = [
      { input: 40, output: 120, cacheWrite: 6000, cacheRead: 0 },
      { input: 300, output: 400, cacheWrite: 500, cacheRead: 6000 },
      { input: 50, output: 80, cacheWrite: 0, cacheRead: 6500 },
    ];

    function sdkUsage(u: (typeof USAGES)[number]) {
      return { input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: u.cacheWrite, cache_read_input_tokens: u.cacheRead };
    }

    it('stores cache writes and reads in their own model_usage columns, costed with computeCost', async () => {
      const { final } = await driveWith({}, [
        { ...readTurn('src/api/session.ts', 'toolu_read'), usage: USAGES[0] },
        { ...patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_patch'), usage: USAGES[1] },
        { ...DONE, usage: USAGES[2] },
      ]);
      expect(final.state).toBe('READY_FOR_REVIEW');
      const rows = fx.harness.store.usageForRun(final.runId);
      expect(rows.map((r) => ({ input: r.input, output: r.output, cacheWrite: r.cacheWrite, cacheRead: r.cacheRead }))).toEqual(USAGES);
      rows.forEach((row, i) => {
        expect(row.costUsd).toBeCloseTo(computeCost(registry, SONNET, normalizeUsage(sdkUsage(USAGES[i]!), '5m')).usd, 12);
      });
      // Cache reads are billed at $0.10/M and 5m writes at $2.50/M, not at the $2/M input rate.
      expect(rows[2]!.costUsd).toBeCloseTo((50 * 2 + 80 * 10 + 6500 * 0.1) / 1e6, 12);
      expect(rows[0]!.costUsd).toBeCloseTo((40 * 2 + 120 * 10 + 6000 * 2.5) / 1e6, 12);

      const recorded = eventPayloads(fx, final.runId, 'model.usage.recorded');
      expect(recorded.map((p) => [p.cacheWrite, p.cacheRead])).toEqual(USAGES.map((u) => [u.cacheWrite, u.cacheRead]));
      expect(readFileSync(join(fx.storageDir, 'runs', final.runId, 'report.md'), 'utf8')).toContain(`| implementation | ${SONNET} | 3 | 390 | 600 | 6500 | 12500 |`);
    });

    it('prices cache writes at the 1h rate when the contract requests a 1h TTL', async () => {
      const { final } = await driveWith({ mutate: (c) => void (c.spec.cache = { enabled: true, ttl: '1h' }) }, [
        { ...patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_patch'), usage: { input: 10, output: 10, cacheWrite: 1000, cacheRead: 0 } },
        { ...DONE, usage: { input: 10, output: 10, cacheWrite: 0, cacheRead: 1000 } },
      ]);
      const rows = fx.harness.store.usageForRun(final.runId);
      expect(rows[0]!.costUsd).toBeCloseTo((10 * 2 + 10 * 10 + 1000 * 4) / 1e6, 12);
      expect(rows[1]!.costUsd).toBeCloseTo((10 * 2 + 10 * 10 + 1000 * 0.1) / 1e6, 12);
    });
  });

  describe('AT-10: budget', () => {
    it('stops with BUDGET_EXHAUSTED and makes no further model calls once the reserve is insufficient', async () => {
      // Turn 1 costs 21K × $2/M + 200 × $10/M = $0.044 of a $0.05 budget (reserve $0.0025).
      const { final, provider } = await driveWith({ mutate: (c) => void (c.spec.limits!.maxCostUsd = 0.05) }, [
        { ...readTurn('src/api/session.ts', 'toolu_read'), usage: { input: 21_000, output: 200 } },
        patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_patch'),
        DONE,
      ]);
      expect(final.state).toBe('BLOCKED');
      expect(final.terminalReason).toMatch(/^BUDGET_EXHAUSTED: remaining budget \$0\.0060 \(reserve \$0\.0025\) cannot cover a \d+-token prompt/);
      expect(provider.requests).toHaveLength(1);
      expect(provider.remaining).toBe(2);
      expect(final.turns).toBe(1);

      // The first request was admitted with max_tokens shrunk to fit the budget.
      expect(provider.requests[0]!.maxTokens).toBeLessThan(16_000);
      expect(eventPayloads(fx, final.runId, 'model.request.started')).toEqual([expect.objectContaining({ turn: 1, maxTokens: provider.requests[0]!.maxTokens })]);

      expect(eventPayloads(fx, final.runId, 'budget.warning')).toEqual([expect.objectContaining({ phase: 'implementation', budgetUsd: 0.05 })]);
      const exhausted = eventPayloads(fx, final.runId, 'budget.exhausted');
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]).toMatchObject({ phase: 'implementation', budgetUsd: 0.05 });
      expect(exhausted[0]!.spentUsd as number).toBeCloseTo(0.044, 12);

      const types = fx.harness.events.list(final.runId).map((e) => e.type);
      expect(types.indexOf('budget.exhausted')).toBeLessThan(types.lastIndexOf('state.changed'));
      expect(types.filter((t) => t.startsWith('verification.'))).toEqual([]);
    });

    it('never calls the model when the budget cannot cover even the first request', async () => {
      const { final, provider } = await driveWith({ mutate: (c) => void (c.spec.limits!.maxCostUsd = 0.002) }, [DONE]);
      expect(final.state).toBe('BLOCKED');
      expect(final.terminalReason).toMatch(/^BUDGET_EXHAUSTED: /);
      expect(provider.requests).toHaveLength(0);
      expect(final.turns).toBe(0);
      expect(fx.harness.store.usageForRun(final.runId)).toEqual([]);
      expect(eventPayloads(fx, final.runId, 'model.request.started')).toEqual([]);
      expect(eventPayloads(fx, final.runId, 'budget.exhausted')).toHaveLength(1);
    });
  });

  it('stops with TURN_LIMIT after maxModelTurns requests', async () => {
    const { final, provider } = await driveWith({ mutate: (c) => void (c.spec.limits!.maxModelTurns = 2) }, [
      readTurn('src/api/session.ts', 'toolu_read_1'),
      readTurn('src/api/session.ts', 'toolu_read_2'),
      DONE,
    ]);
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('TURN_LIMIT: reached the 2-turn limit');
    expect(provider.requests).toHaveLength(2);
    expect(final.turns).toBe(2);
    // The results of the last turn are still persisted for inspection.
    expect(fx.harness.store.loadConversation(final.runId).at(-1)).toMatchObject({ role: 'user', contentJson: expect.stringContaining('toolu_read_2') });
  });
});

describe('ModelExecutor stop conditions and provider errors', () => {
  const tmp = new TempDirs();
  let fx: HarnessFixture;
  const META_TURN = patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_meta');

  afterEach(() => {
    fx.harness.close();
    tmp.cleanup();
  });

  async function driveWith(turns: Parameters<typeof scriptedModel>[0], options: { mutate?: FixtureContractOptions['mutate']; signal?: AbortSignal } = {}): Promise<{ final: RunRecord; provider: ScriptedModelProvider }> {
    fx = createHarnessFixture(tmp, fixtureContract(options.mutate ? { mutate: options.mutate } : {}));
    const run = await ingestFixture(fx);
    const model = scriptedModel(turns);
    const final = await new Orchestrator(fx.harness).drive(run.runId, { executor: model.executor, interaction: approveOnly(), ...(options.signal ? { signal: options.signal } : {}) });
    return { final, provider: model.provider };
  }

  it('a retryable provider failure interrupts the run without failing it (resumable)', async () => {
    const { final } = await driveWith([{ error: new ModelProviderError('overloaded', 'retryable', 529) }]);
    expect(final.state).toBe('EXECUTING');
    expect(final.terminalReason).toBeNull();
    expect(eventPayloads(fx, final.runId, 'error')).toEqual([expect.objectContaining({ kind: 'retryable', status: 529, turn: 1 })]);
    expect(fx.harness.store.usageForRun(final.runId)).toEqual([]);
  });

  it.each([
    ['fatal', 'provider exploded'],
    ['bad_request', 'request rejected: bad'],
    ['auth', 'authentication failed'],
  ] as const)('a %s provider error fails the run', async (kind, message) => {
    const { final } = await driveWith([{ error: new ModelProviderError(message, kind) }]);
    expect(final.state).toBe('FAILED');
    expect(final.terminalReason).toBe(message);
  });

  it('retries unparseable tool JSON twice, then succeeds', async () => {
    const invalid = { error: new ModelProviderError('bad tool json', 'invalid_tool_json') };
    const { final, provider } = await driveWith([invalid, invalid, META_TURN, DONE]);
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(provider.requests).toHaveLength(4);
    expect(eventPayloads(fx, final.runId, 'error').map((p) => p.kind)).toEqual(['invalid_tool_json', 'invalid_tool_json']);
  });

  it('fails after a third consecutive unparseable tool JSON response', async () => {
    const invalid = { error: new ModelProviderError('bad tool json', 'invalid_tool_json') };
    const { final, provider } = await driveWith([invalid, invalid, invalid, DONE]);
    expect(final.state).toBe('FAILED');
    expect(final.terminalReason).toBe('bad tool json');
    expect(provider.requests).toHaveLength(3);
  });

  it('charges the preflight estimate for an aborted request and stops', async () => {
    const controller = new AbortController();
    const { final } = await driveWith(
      [
        () => {
          controller.abort();
          return { error: new ModelProviderError('request aborted', 'aborted') };
        },
      ],
      { signal: controller.signal },
    );
    expect(final.state).toBe('EXECUTING');
    const [row] = fx.harness.store.usageForRun(final.runId);
    expect(row).toMatchObject({ phase: 'implementation', input: 0, output: 0, requestId: expect.stringMatching(/^aborted_1_/) });
    expect(row!.costUsd).toBe(row!.estimatedUsd);
    expect(eventPayloads(fx, final.runId, 'model.usage.recorded')).toEqual([expect.objectContaining({ actual: false })]);
  });

  it('never runs a tool call truncated by max_tokens; retries with a doubled cap', async () => {
    const truncated = { ...patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_truncated'), stopReason: 'max_tokens' as const };
    const { final, provider } = await driveWith([truncated, META_TURN, DONE]);
    expect(fx.harness.store.getToolOp('toolu_truncated')).toBeUndefined();
    expect(provider.requests.map((r) => r.maxTokens)).toEqual([16_000, 32_000, 32_000]);
    // The truncated assistant turn is not persisted, so the retry sees the same history.
    expect(provider.requests[1]!.messages).toEqual(provider.requests[0]!.messages);
    expect(fx.harness.store.usageForRun(final.runId)).toHaveLength(3);
    expect(final.state).toBe('READY_FOR_REVIEW');
  });

  it('treats a text-only max_tokens response as a (truncated) candidate', async () => {
    const { final } = await driveWith([META_TURN, { text: 'Partial summary', stopReason: 'max_tokens' }]);
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(eventPayloads(fx, final.runId, 'state.changed').find((p) => p.to === 'VERIFYING')).toMatchObject({ summary: 'Partial summary [truncated at max_tokens]' });
  });

  it.each([
    ['refusal', 'MODEL_REFUSAL: model declined the request'],
    ['model_context_window_exceeded', 'CONTEXT_EXHAUSTED: conversation exceeded the model context window'],
  ] as const)('blocks on stop_reason %s', async (stopReason, reason) => {
    const { final } = await driveWith([{ text: 'stopping', stopReason }]);
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe(reason);
  });

  it('does not persist a refused assistant turn', async () => {
    const { final } = await driveWith([{ text: 'I will not do that', stopReason: 'refusal' }]);
    expect(fx.harness.store.loadConversation(final.runId).map((e) => e.role)).toEqual(['user']);
    expect(fx.harness.store.usageForRun(final.runId)).toHaveLength(1);
  });

  it('blocks with AGENT_REPORTED_BLOCKED when the model calls report_blocked', async () => {
    const { final } = await driveWith([{ toolCalls: [{ id: 'toolu_blocked', name: 'report_blocked', input: { reason: 'needs a schema migration' } }] }]);
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('AGENT_REPORTED_BLOCKED: needs a schema migration');
  });

  it('blocks with PATCH_LIMIT once the patch attempt limit is exceeded', async () => {
    const { final, provider } = await driveWith([META_TURN, patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1'], 'toolu_again'), DONE], {
      mutate: (c) => void (c.spec.limits!.maxPatchAttempts = 1),
    });
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('PATCH_LIMIT: patch attempt limit reached');
    expect(fx.harness.store.getToolOp('toolu_again')).toMatchObject({ status: 'rejected' });
    expect(provider.requests).toHaveLength(2);
  });

  it('fails without calling the provider when the contract names an unregistered model', async () => {
    const { final, provider } = await driveWith([DONE], { mutate: (c) => void (c.spec.models = { implement: 'claude-unknown-9', prDraft: 'claude-haiku-5-5' }) });
    expect(final.state).toBe('FAILED');
    expect(final.terminalReason).toMatch(/model claude-unknown-9 is not in the model registry/);
    expect(provider.requests).toHaveLength(0);
  });

  it('blocks with TIME_LIMIT once the execution wall clock is exhausted', async () => {
    const p = await prepareRun(tmp, fixtureContract());
    fx = p.fx;
    fx.harness.store.updateRun(p.run.runId, { executingMs: 31 * 60_000 });
    const { provider, executor } = scriptedModel([DONE]);
    const final = await new Orchestrator(fx.harness).drive(p.run.runId, { executor, interaction: approveOnly() });
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('TIME_LIMIT: exceeded 30 minutes of execution');
    expect(provider.requests).toHaveLength(0);
  });
});
