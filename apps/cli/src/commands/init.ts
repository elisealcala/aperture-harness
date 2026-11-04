import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG_YAML } from '@aperture/contracts';
import { detectIsolation } from '@aperture/sandbox';
import { existsSync as exists } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, type GlobalOptions } from '../context.ts';
import { envFileCandidates } from '../env-file.ts';

export async function initCommand(globals: GlobalOptions): Promise<number> {
  const { configPath: path } = loadConfig(globals);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, DEFAULT_CONFIG_YAML, { mode: 0o600 });
    process.stdout.write(`wrote ${path}\n`);
  } else {
    process.stdout.write(`config exists: ${path}\n`);
  }
  const { config, storageDir } = loadConfig(globals);
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const isolation = detectIsolation();
  const lines = [
    `storage:   ${storageDir}`,
    `models:    implementation=${config.models.implementation} prDraft=${config.models.prDraft}`,
    `budget:    ${config.limits.maxCostPerRunUsd} USD per run, ${config.limits.maxPrDraftCostUsd} USD per PR draft`,
    `isolation: ${isolation ?? 'none available'} (policy: ${config.runtime.isolation})`,
    `anthropic: ${process.env[config.providers.anthropic.apiKeyEnv] ? `${config.providers.anthropic.apiKeyEnv} is set` : `${config.providers.anthropic.apiKeyEnv} is not set`}`,
  ];
  const harnessRoot = fileURLToPath(new URL('../../../..', import.meta.url));
  const envFiles = envFileCandidates({ harnessRoot, ...(globals.envFile ? { explicit: globals.envFile } : {}) });
  lines.push(`env files: ${envFiles.map((f) => `${f} (${exists(f) ? 'found' : 'missing'})`).join(', ')}`);
  if (!isolation && config.runtime.isolation === 'required') lines.push('warning: no OS sandbox found; runs will fail closed unless you pass --reduced-security');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
