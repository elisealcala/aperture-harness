import { describe, expect, it } from 'vitest';
import { computeCost, estimateTokens, normalizeUsage, promptTokens, worstCaseCost, type TokenUsage } from './cost.ts';
import { ModelRegistry } from './registry.ts';

const registry = new ModelRegistry();

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, ...overrides };
}

describe('normalizeUsage', () => {
  it('uses the provider cache_creation breakdown when present, regardless of the requested TTL', () => {
    const normalized = normalizeUsage(
      { input_tokens: 120, output_tokens: 45, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 } },
      '5m',
    );
    expect(normalized).toEqual({ input: 120, output: 45, cacheWrite5m: 300, cacheWrite1h: 700, cacheRead: 5000 });
  });

  it.each([
    ['5m', { cacheWrite5m: 1000, cacheWrite1h: 0 }],
    ['1h', { cacheWrite5m: 0, cacheWrite1h: 1000 }],
  ] as const)('attributes unbroken cache writes to the requested TTL (%s)', (ttl, expected) => {
    const normalized = normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, cache_creation: null }, ttl);
    expect(normalized).toMatchObject(expected);
  });

  it('defaults the requested TTL to 5m', () => {
    expect(normalizeUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 42 })).toMatchObject({ cacheWrite5m: 42, cacheWrite1h: 0 });
  });

  it('treats missing or null cache fields as zero', () => {
    expect(normalizeUsage({ input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: null, cache_read_input_tokens: null })).toEqual({ input: 7, output: 3, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  });
});

describe('promptTokens', () => {
  it('sums uncached input, both cache-write TTLs and cache reads (not output)', () => {
    expect(promptTokens(usage({ input: 1, cacheWrite5m: 10, cacheWrite1h: 100, cacheRead: 1000, output: 99999 }))).toBe(1111);
  });
});

describe('computeCost', () => {
  it('charges each Sonnet usage component at its own rate', () => {
    const cost = computeCost(registry, 'claude-sonnet-5-5', usage({ input: 1000, output: 500, cacheWrite5m: 2000, cacheWrite1h: 1000, cacheRead: 10_000 }));
    expect(cost.tier).toBe('standard');
    expect(cost.components.input).toBeCloseTo(0.002, 12);
    expect(cost.components.output).toBeCloseTo(0.005, 12);
    expect(cost.components.cacheWrite).toBeCloseTo(0.005 + 0.004, 12);
    expect(cost.components.cacheRead).toBeCloseTo(0.001, 12);
    expect(cost.usd).toBeCloseTo(0.017, 12);
  });

  it('prices cache reads far below uncached input (AT-11)', () => {
    const uncached = computeCost(registry, 'claude-sonnet-5-5', usage({ input: 100_000 }));
    const cached = computeCost(registry, 'claude-sonnet-5-5', usage({ cacheRead: 100_000 }));
    expect(uncached.usd).toBeCloseTo(0.2, 12);
    expect(cached.usd).toBeCloseTo(0.01, 12);
  });

  it('keeps Haiku at the standard tier at exactly 100K prompt tokens', () => {
    const cost = computeCost(registry, 'claude-haiku-5-5', usage({ input: 60_000, cacheRead: 40_000, output: 1000 }));
    expect(cost.tier).toBe('standard');
    expect(cost.usd).toBeCloseTo((60_000 * 0.1 + 40_000 * 0.01 + 1000 * 0.5) / 1e6, 12);
  });

  it('switches Haiku to long-context pricing for every component above 100K prompt tokens', () => {
    const cost = computeCost(registry, 'claude-haiku-5-5', usage({ input: 60_000, cacheRead: 40_001, cacheWrite5m: 0, output: 1000 }));
    expect(cost.tier).toBe('long');
    expect(cost.components.input).toBeCloseTo((60_000 * 0.5) / 1e6, 12);
    expect(cost.components.cacheRead).toBeCloseTo((40_001 * 0.05) / 1e6, 12);
    expect(cost.components.output).toBeCloseTo((1000 * 2.5) / 1e6, 12);
  });

  it('counts cache writes toward the long-context threshold', () => {
    expect(computeCost(registry, 'claude-haiku-5-5', usage({ input: 1, cacheWrite1h: 100_000 })).tier).toBe('long');
  });
});

describe('estimateTokens', () => {
  it('over-counts at ~3 characters per token plus a fixed overhead', () => {
    expect(estimateTokens('')).toBe(8);
    expect(estimateTokens('abc')).toBe(9);
    expect(estimateTokens('abcd')).toBe(10);
    expect(estimateTokens('x'.repeat(3000))).toBe(1008);
  });
});

describe('worstCaseCost', () => {
  it('bills every prompt token at the 5m cache-write rate when it exceeds the input rate', () => {
    expect(worstCaseCost(registry, 'claude-sonnet-5-5', 10_000, 2000)).toBeCloseTo((10_000 * 2.5 + 2000 * 10) / 1e6, 12);
  });

  it('uses the 1h cache-write rate for 1h TTL', () => {
    expect(worstCaseCost(registry, 'claude-sonnet-5-5', 10_000, 2000, '1h')).toBeCloseTo((10_000 * 4 + 2000 * 10) / 1e6, 12);
  });

  it('uses the uncached input rate when it is the most expensive', () => {
    const custom = new ModelRegistry({ cheapcache: { pricing: { inputPerMTok: 5, outputPerMTok: 1, cacheWrite5mPerMTok: 1, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 0.1 } } });
    expect(worstCaseCost(custom, 'cheapcache', 1000, 1000)).toBeCloseTo((1000 * 5 + 1000 * 1) / 1e6, 12);
  });

  it('applies the long-context tier based on the prompt estimate', () => {
    expect(worstCaseCost(registry, 'claude-haiku-5-5', 200_000, 1000)).toBeCloseTo((200_000 * 0.625 + 1000 * 2.5) / 1e6, 12);
  });

  it('is zero for an empty request', () => {
    expect(worstCaseCost(registry, 'claude-sonnet-5-5', 0, 0)).toBe(0);
  });
});
