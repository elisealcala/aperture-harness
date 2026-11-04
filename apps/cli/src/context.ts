import { defaultConfigPath, loadUserConfig, resolveStorageDirectory, type UserConfig } from '@aperture/contracts';
import { Harness } from '@aperture/core';

export interface GlobalOptions {
  config?: string;
  home?: string;
}

/** Environment variable values that must never appear in logs, whatever field they end up in. */
export function secretLiterals(config: UserConfig, env: NodeJS.ProcessEnv): string[] {
  const names = [config.providers.anthropic.apiKeyEnv, config.providers.github.tokenEnv, config.providers.linear.apiKeyEnv, 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN'];
  return names.map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.length >= 8);
}

export function loadConfig(options: GlobalOptions, env: NodeJS.ProcessEnv = process.env): { config: UserConfig; configPath: string; storageDir: string } {
  const configPath = options.config ?? defaultConfigPath(env);
  const config = loadUserConfig(configPath);
  const storageDir = options.home ?? resolveStorageDirectory(config, env);
  return { config, configPath, storageDir };
}

export function openHarness(options: GlobalOptions, env: NodeJS.ProcessEnv = process.env, extra: Partial<ConstructorParameters<typeof Harness>[0]> = {}): Harness {
  const { config, storageDir } = loadConfig(options, env);
  return new Harness({ config, storageDir, env, redactLiterals: secretLiterals(config, env), ...extra });
}
