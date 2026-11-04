import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

export interface EnvFileResult {
  path: string;
  /** Variables set from this file. */
  loaded: string[];
  /** Variables in the file that were already set (the existing value wins). */
  skipped: string[];
  warnings: string[];
}

/**
 * Env files the CLI reads, in priority order. An explicit `--env-file` / `$APERTURE_ENV_FILE`
 * replaces the defaults. The defaults are the harness checkout's own `.env` and the per-user one
 * next to the config — never the target repository's `.env`, which lives in the worktree.
 */
export function envFileCandidates(options: { explicit?: string; harnessRoot: string; env?: NodeJS.ProcessEnv; cwd?: string }): string[] {
  const env = options.env ?? process.env;
  const explicit = options.explicit ?? env.APERTURE_ENV_FILE;
  if (explicit) return [resolve(options.cwd ?? process.cwd(), explicit)];
  const configHome = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config');
  return [join(options.harnessRoot, '.env'), join(configHome, 'aperture', '.env')];
}

/**
 * Loads `KEY=value` files into `env` without overriding variables that are already set, so the real
 * environment always wins over a file and an earlier file wins over a later one.
 */
export function loadEnvFiles(paths: readonly string[], env: NodeJS.ProcessEnv = process.env, options: { required?: boolean } = {}): EnvFileResult[] {
  const results: EnvFileResult[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      if (options.required) throw new Error(`env file ${path} does not exist`);
      continue;
    }
    const warnings: string[] = [];
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      warnings.push(`${path} is readable by other users; run \`chmod 600 ${path}\``);
    }
    const parsed = parseEnv(readFileSync(path, 'utf8'));
    const loaded: string[] = [];
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (value === undefined) continue;
      if (env[key] !== undefined) {
        skipped.push(key);
        continue;
      }
      env[key] = value;
      loaded.push(key);
    }
    results.push({ path, loaded, skipped, warnings });
  }
  return results;
}
