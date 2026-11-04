import { parseUserConfig } from '@aperture/contracts';
import { describe, expect, it } from 'vitest';
import { ModelRegistry, UnknownModelError } from './registry.ts';

const CUSTOM_PRICING = { inputPerMTok: 1, outputPerMTok: 2, cacheWrite5mPerMTok: 3, cacheWrite1hPerMTok: 4, cacheReadPerMTok: 0.5 };

describe('ModelRegistry', () => {
  it('loads the default Sonnet and Haiku pricing from models.default.json (§8 table)', () => {
    const registry = new ModelRegistry();
    expect(registry.get('claude-sonnet-5-5').pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 10, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4, cacheReadPerMTok: 0.1 });
    expect(registry.get('claude-haiku-5-5').pricing).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5, cacheWrite5mPerMTok: 0.125, cacheWrite1hPerMTok: 0.2, cacheReadPerMTok: 0.01 });
    expect(registry.get('claude-haiku-5-5').longContext).toEqual({
      thresholdTokens: 100_000,
      pricing: { inputPerMTok: 0.5, outputPerMTok: 2.5, cacheWrite5mPerMTok: 0.625, cacheWrite1hPerMTok: 1, cacheReadPerMTok: 0.05 },
    });
  });

  it('lists only real model ids (the _comment key is not a model)', () => {
    const registry = new ModelRegistry();
    expect(registry.ids().sort()).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(registry.has('_comment')).toBe(false);
    expect(registry.has('claude-sonnet-5-5')).toBe(true);
  });

  it('refuses unknown models with UnknownModelError carrying the model id', () => {
    const registry = new ModelRegistry();
    expect(registry.has('claude-opus-9')).toBe(false);
    let error: unknown;
    try {
      registry.get('claude-opus-9');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(UnknownModelError);
    expect(error).toMatchObject({ name: 'UnknownModelError', modelId: 'claude-opus-9' });
    expect((error as Error).message).toContain('models.registry');
    expect(() => registry.pricingFor('claude-opus-9', 10)).toThrow(UnknownModelError);
  });

  it('applies overrides on top of the defaults (adding and replacing entries)', () => {
    const registry = new ModelRegistry({
      'custom-model': { pricing: CUSTOM_PRICING },
      'claude-sonnet-5-5': { pricing: CUSTOM_PRICING, maxOutputTokens: 1000 },
    });
    expect(registry.get('custom-model').pricing).toEqual(CUSTOM_PRICING);
    expect(registry.get('claude-sonnet-5-5')).toEqual({ pricing: CUSTOM_PRICING, maxOutputTokens: 1000 });
    expect(registry.get('claude-haiku-5-5').pricing.inputPerMTok).toBe(0.1);
  });

  it('builds from the user config models.registry', () => {
    const registry = ModelRegistry.fromConfig(parseUserConfig({ models: { registry: { 'custom-model': { pricing: CUSTOM_PRICING } } } }));
    expect(registry.has('custom-model')).toBe(true);
    expect(registry.has('claude-sonnet-5-5')).toBe(true);
  });

  describe('pricingFor', () => {
    const registry = new ModelRegistry();

    it('always uses the standard tier for models without a long-context tier', () => {
      expect(registry.pricingFor('claude-sonnet-5-5', 900_000)).toEqual({ pricing: registry.get('claude-sonnet-5-5').pricing, tier: 'standard' });
    });

    it('switches Haiku to the long-context tier only above 100K prompt tokens', () => {
      expect(registry.pricingFor('claude-haiku-5-5', 100_000).tier).toBe('standard');
      const long = registry.pricingFor('claude-haiku-5-5', 100_001);
      expect(long.tier).toBe('long');
      expect(long.pricing.inputPerMTok).toBe(0.5);
    });
  });
});
