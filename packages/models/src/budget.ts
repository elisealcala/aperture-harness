import type { CacheTtl } from '@aperture/contracts';
import { worstCaseCost } from './cost.ts';
import type { ModelRegistry } from './registry.ts';

export interface BudgetAdmission {
  admitted: boolean;
  /** `max_tokens` to send: the configured cap, reduced so the worst case still fits the budget. */
  maxTokens: number;
  worstCaseUsd: number;
  remainingUsd: number;
  reason?: string;
}

export interface BudgetMeterOptions {
  registry: ModelRegistry;
  modelId: string;
  budgetUsd: number;
  reserveFraction: number;
  spentUsd: () => number;
  /** Smallest useful response; below this the request is refused rather than starved. */
  minOutputTokens?: number;
  ttl?: CacheTtl;
}

/**
 * Per-stage budget gate (§8). Before each request it compares the worst-case cost of the request
 * with what remains after the reserve, shrinking `max_tokens` when that is enough and refusing
 * the request otherwise. Actual spend always comes from the ledger (`spentUsd`).
 */
export class BudgetMeter {
  constructor(private readonly options: BudgetMeterOptions) {}

  get budgetUsd(): number {
    return this.options.budgetUsd;
  }

  get reserveUsd(): number {
    return this.options.budgetUsd * this.options.reserveFraction;
  }

  spent(): number {
    return this.options.spentUsd();
  }

  remaining(): number {
    return this.options.budgetUsd - this.spent();
  }

  admit(promptTokenEstimate: number, maxTokensCap: number): BudgetAdmission {
    const { registry, modelId } = this.options;
    const ttl = this.options.ttl ?? '5m';
    const minOutput = Math.min(this.options.minOutputTokens ?? 1024, maxTokensCap);
    const available = this.remaining() - this.reserveUsd;
    const full = worstCaseCost(registry, modelId, promptTokenEstimate, maxTokensCap, ttl);
    if (full <= available) return { admitted: true, maxTokens: maxTokensCap, worstCaseUsd: full, remainingUsd: this.remaining() };
    const promptOnly = worstCaseCost(registry, modelId, promptTokenEstimate, 0, ttl);
    const outputRate = registry.pricingFor(modelId, promptTokenEstimate).pricing.outputPerMTok / 1_000_000;
    const affordable = outputRate > 0 ? Math.floor((available - promptOnly) / outputRate) : maxTokensCap;
    if (affordable >= minOutput) {
      const maxTokens = Math.min(maxTokensCap, affordable);
      return { admitted: true, maxTokens, worstCaseUsd: worstCaseCost(registry, modelId, promptTokenEstimate, maxTokens, ttl), remainingUsd: this.remaining() };
    }
    return {
      admitted: false,
      maxTokens: 0,
      worstCaseUsd: worstCaseCost(registry, modelId, promptTokenEstimate, minOutput, ttl),
      remainingUsd: this.remaining(),
      reason: `remaining budget $${Math.max(0, this.remaining()).toFixed(4)} (reserve $${this.reserveUsd.toFixed(4)}) cannot cover a ${promptTokenEstimate}-token prompt plus ${minOutput} output tokens`,
    };
  }
}
