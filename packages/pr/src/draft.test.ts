import { describe, expect, it } from 'vitest';
import { computeCost, ModelProviderError, ModelRegistry, ScriptedModelProvider, type ScriptedResponder } from '@aperture/models';
import { draftPullRequest, fallbackDraft, PR_DRAFT_JSON_SCHEMA, PR_SYSTEM_PROMPT, renderPrBody, validateDraft, type DraftOptions, type PrDraft } from './draft.ts';
import type { EvidencePacket } from './evidence.ts';

const HAIKU = 'claude-haiku-5-5';
const registry = new ModelRegistry();

function packet(overrides: Partial<EvidencePacket> = {}): EvidencePacket {
  return {
    runId: 'run_01TEST',
    title: 'Add optional session metadata',
    goal: 'Accept and forward optional session metadata',
    sourceRef: 'github:org/repo#142',
    issueUrl: 'https://github.com/org/repo/issues/142',
    issueReference: 'Closes #142',
    repository: 'org/repo',
    contract: { version: 1, sha256: 'a'.repeat(64) },
    requirements: [
      { id: 'R1', text: 'Accept metadata', status: 'VERIFIED', note: 'unit passed' },
      { id: 'R2', text: 'Preserve compatibility', status: 'UNVERIFIED', note: 'no applied change references this requirement' },
    ],
    changedFiles: [{ path: 'src/api/session.ts', status: 'M', added: 2, removed: 1 }],
    diffExcerpt: 'diff --git a/src/api/session.ts b/src/api/session.ts\n',
    checks: [
      { checkId: 'unit', required: true, status: 'PASS' },
      { checkId: 'lint', required: false, status: 'FAIL' },
    ],
    exceptions: ['R2 accepted on manual review without check evidence'],
    verificationResult: 'UNVERIFIED',
    implementationModel: 'claude-sonnet-5-5',
    ...overrides,
  };
}

function goodDraft(overrides: Partial<PrDraft> = {}): PrDraft {
  return {
    title: 'Add optional session metadata',
    summary: 'Adds an optional metadata field to session creation.',
    changes: ['src/api/session.ts: accept and forward metadata'],
    testing: ['unit: PASS', 'lint: FAIL (optional)'],
    risks: ['R2 was accepted on manual review'],
    issueReference: 'Closes #142',
    ...overrides,
  };
}

describe('validateDraft', () => {
  it('accepts a draft that matches the evidence', () => {
    const result = validateDraft(goodDraft(), packet());
    expect(result).toEqual({ ok: true, problems: [], draft: goodDraft() });
  });

  it('reports schema problems by field', () => {
    const result = validateDraft({ ...goodDraft(), title: 'two\nlines', changes: [], extra: 1 }, packet());
    expect(result.ok).toBe(false);
    expect(result.draft).toBeUndefined();
    expect(result.problems.join('\n')).toMatch(/title: title must be one line/);
    expect(result.problems.join('\n')).toMatch(/changes:/);
    expect(result.problems.join('\n')).toMatch(/extra/);
    expect(validateDraft('not an object', packet()).ok).toBe(false);
  });

  it('requires the exact issue reference (whitespace aside)', () => {
    expect(validateDraft(goodDraft({ issueReference: 'Fixes #142' }), packet()).problems).toEqual(['issueReference must be exactly "Closes #142"']);
    expect(validateDraft(goodDraft({ issueReference: '  Closes #142 ' }), packet())).toMatchObject({ ok: true, draft: { issueReference: 'Closes #142' } });
  });

  it('rejects testing lines that cite no check that ran', () => {
    const result = validateDraft(goodDraft({ testing: ['unit: PASS', 'typecheck: PASS', 'Manually tested in staging'] }), packet());
    expect(result.problems).toEqual(['testing line does not cite a verified check: "typecheck: PASS"', 'testing line does not cite a verified check: "Manually tested in staging"']);
  });

  it('matches check ids as whole tokens, not substrings', () => {
    expect(validateDraft(goodDraft({ testing: ['unit-extra: PASS'] }), packet()).problems).toEqual(['testing line does not cite a verified check: "unit-extra: PASS"']);
    expect(validateDraft(goodDraft({ testing: ['Ran (unit) — PASS'] }), packet()).ok).toBe(true);
  });

  it('rejects claiming that a failed check passed', () => {
    for (const line of ['lint: passed', 'lint is green', 'lint succeeded', 'unit and lint pass']) {
      expect(validateDraft(goodDraft({ testing: [line] }), packet()).problems).toEqual(['testing line claims lint passed but it was FAIL']);
    }
  });

  // Regression: success words are looked for outside the cited check ids, so an id containing
  // "pass" (or "green") is not mistaken for a claim that the check passed.
  it('accepts an accurate FAIL line for a check whose id contains "pass"', () => {
    const p = packet({ checks: [{ checkId: 'pass-through', required: true, status: 'FAIL' }] });
    expect(validateDraft(goodDraft({ testing: ['pass-through: FAIL'] }), p).ok).toBe(true);
  });

  it('escapes regex characters in check ids', () => {
    const p = packet({ checks: [{ checkId: 'test:unit+e2e', required: true, status: 'PASS' }] });
    expect(validateDraft(goodDraft({ testing: ['test:unit+e2e PASS'] }), p).ok).toBe(true);
    expect(validateDraft(goodDraft({ testing: ['test:unitXe2e PASS'] }), p).ok).toBe(false);
  });

  it('allows an empty testing list', () => {
    expect(validateDraft(goodDraft({ testing: [] }), packet()).ok).toBe(true);
  });

  it('redacts secret-looking values and literals from every text field', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    const literal = 'super-secret-literal';
    const result = validateDraft(
      goodDraft({ title: ` Add metadata ${literal} `, summary: `token ${token}`, changes: [`uses ${token}`], testing: [`unit: PASS ${literal}`], risks: [`leak ${token}`] }),
      packet(),
      [literal],
    );
    expect(result.ok).toBe(true);
    expect(result.draft).toEqual(
      goodDraft({ title: 'Add metadata [REDACTED]', summary: 'token [REDACTED]', changes: ['uses [REDACTED]'], testing: ['unit: PASS [REDACTED]'], risks: ['leak [REDACTED]'] }),
    );
  });
});

describe('fallbackDraft', () => {
  it('is built only from the evidence and passes validation', () => {
    const p = packet();
    const draft = fallbackDraft(p);
    expect(draft).toEqual({
      title: 'Add optional session metadata',
      summary: 'Accept and forward optional session metadata',
      changes: ['M src/api/session.ts (+2 -1)'],
      testing: ['unit: PASS', 'lint: FAIL (optional)'],
      risks: ['R2 UNVERIFIED: no applied change references this requirement', 'R2 accepted on manual review without check evidence'],
      issueReference: 'Closes #142',
    });
    expect(validateDraft(draft, p).ok).toBe(true);
  });

  it('truncates long titles and handles binary or missing changes', () => {
    const long = packet({ title: 'T'.repeat(150), changedFiles: [{ path: 'img.png', status: 'A', added: null, removed: null }] });
    expect(fallbackDraft(long).title).toBe(`${'T'.repeat(97)}...`);
    expect(fallbackDraft(long).changes).toEqual(['A img.png (+? -?)']);
    expect(fallbackDraft(packet({ changedFiles: [] })).changes).toEqual(['(no file changes)']);
  });
});

describe('renderPrBody', () => {
  it('renders sections, the verification tables, risks and the issue reference', () => {
    const body = renderPrBody(goodDraft(), packet(), { draftModel: HAIKU });
    expect(body).toContain('## Changes\n- src/api/session.ts: accept and forward metadata\n');
    expect(body).toContain('## Testing\n- unit: PASS\n- lint: FAIL (optional)\n');
    expect(body).toContain('| unit | yes | PASS |');
    expect(body).toContain('| lint | no | FAIL |');
    expect(body).toContain('| R2 | UNVERIFIED |');
    expect(body).toContain('## Risks\n- R2 was accepted on manual review\n');
    expect(body).toContain('\nCloses #142\n');
    expect(body).toContain(`implementation claude-sonnet-5-5 · description ${HAIKU}`);
    expect(body.endsWith('\n')).toBe(true);
  });

  it('says no checks ran and omits risks when there are none', () => {
    const body = renderPrBody(goodDraft({ testing: [], risks: [] }), packet({ checks: [] }), { draftModel: 'deterministic template' });
    expect(body).toContain('## Testing\n- No checks ran.\n');
    expect(body).not.toContain('## Risks');
  });
});

describe('draftPullRequest', () => {
  function options(provider: ScriptedModelProvider, overrides: Partial<DraftOptions> = {}): DraftOptions {
    return { provider, registry, modelId: HAIKU, budgetUsd: 0.02, spentUsd: () => 0, cache: { enabled: true, ttl: '5m' }, ...overrides };
  }

  function replying(...turns: ScriptedResponder[]): ScriptedModelProvider {
    return new ScriptedModelProvider(turns);
  }

  it('drafts with the PR model using structured output and records usage', async () => {
    const provider = replying({ text: JSON.stringify(goodDraft()), usage: { input: 1500, output: 300 } });
    const p = packet();
    const result = await draftPullRequest(p, options(provider));

    expect(result).toMatchObject({ draft: goodDraft(), fallback: false, modelId: HAIKU, problems: [] });
    const expectedCost = computeCost(registry, HAIKU, { input: 1500, output: 300, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }).usd;
    expect(result.usage).toMatchObject({ input: 1500, output: 300, cacheWrite: 0, cacheRead: 0 });
    expect(result.usage!.requestId).toMatch(/^req_/);
    expect(result.usage!.costUsd).toBeCloseTo(expectedCost, 12);
    expect(result.usage!.estimatedUsd).toBeGreaterThan(0);

    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request).toMatchObject({ modelId: HAIKU, system: PR_SYSTEM_PROMPT, tools: [], maxTokens: 2_000, cache: { enabled: false, ttl: '5m' }, outputSchema: PR_DRAFT_JSON_SCHEMA });
    expect(request.messages).toEqual([{ role: 'user', content: `Evidence (JSON):\n${JSON.stringify(p, null, 2)}` }]);
  });

  it('sends the requested model id and cache ttl', async () => {
    const provider = replying({ text: JSON.stringify(goodDraft()) });
    await draftPullRequest(packet(), options(provider, { modelId: 'claude-sonnet-5-5', cache: { enabled: true, ttl: '1h' } }));
    expect(provider.requests[0]).toMatchObject({ modelId: 'claude-sonnet-5-5', cache: { enabled: false, ttl: '1h' } });
  });

  it('falls back (keeping usage) when the output is not JSON', async () => {
    const provider = replying({ text: 'Here is your PR: **Add metadata**' });
    const result = await draftPullRequest(packet(), options(provider));
    expect(result).toMatchObject({ draft: fallbackDraft(packet()), fallback: true, modelId: HAIKU, problems: ['model output was not valid JSON'] });
    expect(result.usage).toBeDefined();
    expect(provider.requests).toHaveLength(1);
  });

  it('falls back (keeping usage) when the draft fails validation', async () => {
    const provider = replying({ text: JSON.stringify(goodDraft({ testing: ['lint: passed'] })) });
    const result = await draftPullRequest(packet(), options(provider));
    expect(result).toMatchObject({ fallback: true, problems: ['testing line claims lint passed but it was FAIL'], draft: fallbackDraft(packet()) });
    expect(result.usage).toBeDefined();
  });

  it('falls back without calling the model when the PR budget cannot cover the request', async () => {
    const provider = replying({ text: JSON.stringify(goodDraft()) });
    const result = await draftPullRequest(packet(), options(provider, { budgetUsd: 0.02, spentUsd: () => 0.02 }));
    expect(result.fallback).toBe(true);
    expect(result.problems).toEqual([expect.stringMatching(/^PR budget: remaining budget \$0\.0000/)]);
    expect(result.usage).toBeUndefined();
    expect(provider.requests).toEqual([]);
  });

  it('falls back on a provider error and never retries with another model', async () => {
    const provider = replying({ error: new ModelProviderError('overloaded', 'retryable', 529) }, { text: JSON.stringify(goodDraft()) });
    const result = await draftPullRequest(packet(), options(provider));
    expect(result).toMatchObject({ fallback: true, modelId: HAIKU, problems: ['retryable: overloaded'], draft: fallbackDraft(packet()) });
    expect(result.usage).toBeUndefined();
    expect(provider.requests.map((r) => r.modelId)).toEqual([HAIKU]);
    expect(provider.remaining).toBe(1);
  });

  it('falls back for an unknown model without sending anything', async () => {
    const provider = replying({ text: JSON.stringify(goodDraft()) });
    const result = await draftPullRequest(packet(), options(provider, { modelId: 'claude-imaginary-9' }));
    expect(result).toMatchObject({ fallback: true, modelId: 'claude-imaginary-9' });
    expect(result.problems[0]).toContain('claude-imaginary-9');
    expect(provider.requests).toEqual([]);
  });
});
