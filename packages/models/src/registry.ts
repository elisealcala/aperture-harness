import { readFileSync } from 'node:fs';
import type { ModelRegistryEntry, UserConfig } from '@aperture/contracts';

export type Pricing = ModelRegistryEntry['pricing'];

const DEFAULTS = JSON.parse(readFileSync(new URL('./models.default.json', import.meta.url), 'utf8')) as Record<string, ModelRegistryEntry | string>;

export class UnknownModelError extends Error {
  constructor(readonly modelId: string) {
    super(`model ${modelId} is not in the model registry; add its pricing under models.registry in the config before using it`);
    this.name = 'UnknownModelError';
  }
}

/**
 * Central registry of model ids → pricing, output limits and context window (§15). Unknown models
 * are refused: the harness cannot enforce a budget for a model it cannot price.
 */
export class ModelRegistry {
  private readonly entries = new Map<string, ModelRegistryEntry>();

  constructor(overrides: Readonly<Record<string, ModelRegistryEntry>> = {}) {
    for (const [id, entry] of Object.entries(DEFAULTS)) {
      if (!id.startsWith('_') && typeof entry !== 'string') this.entries.set(id, entry);
    }
    for (const [id, entry] of Object.entries(overrides)) this.entries.set(id, entry);
  }

  static fromConfig(config: UserConfig): ModelRegistry {
    return new ModelRegistry(config.models.registry);
  }

  has(modelId: string): boolean {
    return this.entries.has(modelId);
  }

  get(modelId: string): ModelRegistryEntry {
    const entry = this.entries.get(modelId);
    if (!entry) throw new UnknownModelError(modelId);
    return entry;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Pricing tier for a request whose total prompt (uncached + cache write + cache read) is `promptTokens`. */
  pricingFor(modelId: string, promptTokens: number): { pricing: Pricing; tier: 'standard' | 'long' } {
    const entry = this.get(modelId);
    if (entry.longContext && promptTokens > entry.longContext.thresholdTokens) return { pricing: entry.longContext.pricing, tier: 'long' };
    return { pricing: entry.pricing, tier: 'standard' };
  }
}
