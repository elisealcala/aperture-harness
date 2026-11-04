import { ModelExecutor, ScriptedExecutor, type Executor, type Harness } from '@aperture/core';
import { AnthropicProvider, ModelRegistry } from '@aperture/models';

export interface ExecutorOptions {
  script?: string;
}

/**
 * `--script` replays tool calls offline; otherwise the configured implementation model runs via
 * the Anthropic API. The API key is read from the configured env var only; when it is unset the
 * SDK resolves credentials itself (ANTHROPIC_AUTH_TOKEN, `ant auth login` profile, ...).
 */
export function createExecutor(harness: Harness, options: ExecutorOptions): Executor {
  if (options.script) return ScriptedExecutor.fromFile(options.script);
  const config = harness.config;
  const anthropic = config.providers.anthropic;
  const apiKey = harness.env[anthropic.apiKeyEnv];
  const baseURL = anthropic.baseUrlEnv ? harness.env[anthropic.baseUrlEnv] : undefined;
  return new ModelExecutor({
    provider: new AnthropicProvider({ ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) }),
    registry: ModelRegistry.fromConfig(config),
    effort: config.models.implementationEffort,
    reserveFraction: config.limits.reserveFraction,
  });
}
