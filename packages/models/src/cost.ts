import type { CacheTtl } from '@aperture/contracts';
import type { ModelRegistry } from './registry.ts';

/** Provider-reported token usage for one request, normalized. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface CostBreakdown {
  usd: number;
  tier: 'standard' | 'long';
  components: { input: number; output: number; cacheWrite: number; cacheRead: number };
}

const PER_MTOK = 1_000_000;

/** Normalizes the SDK `usage` object; unbroken cache writes are attributed to the requested TTL. */
export function normalizeUsage(
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  },
  requestedTtl: CacheTtl = '5m',
): TokenUsage {
  const totalWrite = usage.cache_creation_input_tokens ?? 0;
  let cacheWrite5m: number;
  let cacheWrite1h: number;
  if (usage.cache_creation) {
    cacheWrite5m = usage.cache_creation.ephemeral_5m_input_tokens;
    cacheWrite1h = usage.cache_creation.ephemeral_1h_input_tokens;
  } else {
    cacheWrite5m = requestedTtl === '5m' ? totalWrite : 0;
    cacheWrite1h = requestedTtl === '1h' ? totalWrite : 0;
  }
  return { input: usage.input_tokens, output: usage.output_tokens, cacheWrite5m, cacheWrite1h, cacheRead: usage.cache_read_input_tokens ?? 0 };
}

export function promptTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead;
}

/** Charges a response from actual usage and the active pricing tier (§8 cost ledger formula). */
export function computeCost(registry: ModelRegistry, modelId: string, usage: TokenUsage): CostBreakdown {
  const { pricing, tier } = registry.pricingFor(modelId, promptTokens(usage));
  const input = (usage.input * pricing.inputPerMTok) / PER_MTOK;
  const output = (usage.output * pricing.outputPerMTok) / PER_MTOK;
  const cacheWrite = (usage.cacheWrite5m * pricing.cacheWrite5mPerMTok + usage.cacheWrite1h * pricing.cacheWrite1hPerMTok) / PER_MTOK;
  const cacheRead = (usage.cacheRead * pricing.cacheReadPerMTok) / PER_MTOK;
  return { usd: input + output + cacheWrite + cacheRead, tier, components: { input, output, cacheWrite, cacheRead } };
}

/**
 * Conservative token estimate for text that has not been sent yet (≈3 characters per token, which
 * over-counts typical English and code). Used only for preflight checks, never for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3) + 8;
}

/**
 * Worst-case cost of a request before it is sent: every prompt token billed at the most expensive
 * input rate (uncached or cache write for the TTL) plus the full `maxTokens` of output.
 */
export function worstCaseCost(registry: ModelRegistry, modelId: string, promptTokenEstimate: number, maxTokens: number, ttl: CacheTtl = '5m'): number {
  const { pricing } = registry.pricingFor(modelId, promptTokenEstimate);
  const inputRate = Math.max(pricing.inputPerMTok, ttl === '1h' ? pricing.cacheWrite1hPerMTok : pricing.cacheWrite5mPerMTok);
  return (promptTokenEstimate * inputRate + maxTokens * pricing.outputPerMTok) / PER_MTOK;
}
