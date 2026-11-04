import { describe, expect, it } from 'vitest';
import { BudgetMeter, type BudgetMeterOptions } from './budget.ts';
import { worstCaseCost } from './cost.ts';
import { ModelRegistry } from './registry.ts';

const registry = new ModelRegistry();
const SONNET = 'claude-sonnet-5-5';

function meter(overrides: Partial<BudgetMeterOptions> = {}): BudgetMeter {
  return new BudgetMeter({ registry, modelId: SONNET, budgetUsd: 1, reserveFraction: 0.1, spentUsd: () => 0, ...overrides });
}

describe('BudgetMeter', () => {
  it('exposes the budget, reserve, spend (from the ledger) and remaining amount', () => {
    let spent = 0.25;
    const m = meter({ spentUsd: () => spent });
    expect(m.budgetUsd).toBe(1);
    expect(m.reserveUsd).toBeCloseTo(0.1, 12);
    expect(m.spent()).toBe(0.25);
    expect(m.remaining()).toBeCloseTo(0.75, 12);
    spent = 0.5;
    expect(m.remaining()).toBeCloseTo(0.5, 12);
  });

  it('admits the full max_tokens cap when the worst case fits within budget minus reserve', () => {
    const admission = meter().admit(10_000, 16_000);
    expect(admission).toEqual({ admitted: true, maxTokens: 16_000, worstCaseUsd: worstCaseCost(registry, SONNET, 10_000, 16_000), remainingUsd: 1 });
  });

  it('shrinks max_tokens so the worst case still fits when the full cap does not', () => {
    // available = 0.1 - 0.01 reserve = 0.09; prompt worst case = 10K × $2.50/M = 0.025 → ~6500 output tokens at $10/M.
    const m = meter({ budgetUsd: 0.1 });
    const admission = m.admit(10_000, 16_000);
    expect(admission.admitted).toBe(true);
    expect(admission.maxTokens).toBeLessThan(16_000);
    expect(Math.abs(admission.maxTokens - 6500)).toBeLessThanOrEqual(1);
    expect(admission.worstCaseUsd).toBeLessThanOrEqual(0.09 + 1e-12);
    expect(admission.worstCaseUsd).toBeCloseTo(worstCaseCost(registry, SONNET, 10_000, admission.maxTokens), 12);
  });

  it('refuses when even the minimum useful output does not fit', () => {
    // available = 0.03; prompt 0.025 → only ~500 output tokens affordable, below the 1024 default minimum.
    const admission = meter({ budgetUsd: 0.03, reserveFraction: 0 }).admit(10_000, 16_000);
    expect(admission.admitted).toBe(false);
    expect(admission.maxTokens).toBe(0);
    expect(admission.remainingUsd).toBeCloseTo(0.03, 12);
    expect(admission.worstCaseUsd).toBeCloseTo(worstCaseCost(registry, SONNET, 10_000, 1024), 12);
    expect(admission.reason).toMatch(/remaining budget \$0\.0300 \(reserve \$0\.0000\) cannot cover a 10000-token prompt plus 1024 output tokens/);
  });

  it('honors a smaller configured minOutputTokens', () => {
    const admission = meter({ budgetUsd: 0.03, reserveFraction: 0, minOutputTokens: 100 }).admit(10_000, 16_000);
    expect(admission.admitted).toBe(true);
    expect(Math.abs(admission.maxTokens - 500)).toBeLessThanOrEqual(1);
  });

  it('never requires more than the cap as the minimum output', () => {
    // cap 600: min output becomes 600, but only ~500 tokens are affordable → refused with "600 output tokens".
    const refused = meter({ budgetUsd: 0.03, reserveFraction: 0 }).admit(10_000, 600);
    expect(refused.admitted).toBe(false);
    expect(refused.reason).toContain('plus 600 output tokens');
    // cap 400: the full request fits outright.
    expect(meter({ budgetUsd: 0.03, reserveFraction: 0 }).admit(10_000, 400)).toMatchObject({ admitted: true, maxTokens: 400 });
  });

  it('refuses everything once spend has eaten into the reserve (AT-10)', () => {
    const m = meter({ spentUsd: () => 0.95 });
    const admission = m.admit(100, 1024);
    expect(admission.admitted).toBe(false);
    expect(admission.remainingUsd).toBeCloseTo(0.05, 12);
    expect(admission.reason).toContain('reserve $0.1000');
  });

  it('reports a non-negative remaining amount in the refusal reason when overspent', () => {
    const admission = meter({ spentUsd: () => 1.5 }).admit(100, 1024);
    expect(admission.admitted).toBe(false);
    expect(admission.remainingUsd).toBeCloseTo(-0.5, 12);
    expect(admission.reason).toContain('remaining budget $0.0000');
  });

  it('prices the worst case with the configured cache TTL', () => {
    const admission = meter({ ttl: '1h' }).admit(10_000, 1000);
    expect(admission.worstCaseUsd).toBeCloseTo(worstCaseCost(registry, SONNET, 10_000, 1000, '1h'), 12);
  });
});
