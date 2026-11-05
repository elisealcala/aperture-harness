import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { formatZodIssues } from './load.ts';
import { CacheTtlSchema, CommandSpecSchema } from './schema.ts';

const PricingSchema = z.strictObject({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheWrite5mPerMTok: z.number().nonnegative(),
  cacheWrite1hPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
});

const ModelEntrySchema = z.strictObject({
  pricing: PricingSchema,
  /** Optional long-prompt tier: applies when a request's total input exceeds `thresholdTokens`. */
  longContext: z.strictObject({ thresholdTokens: z.number().int().positive(), pricing: PricingSchema }).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().optional(),
});
export type ModelRegistryEntry = z.infer<typeof ModelEntrySchema>;

const RepoSlug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

/**
 * User configuration (§15). Every object is strict: unknown keys — including attempts to put
 * secrets such as `apiKey` directly in YAML — are rejected instead of ignored.
 */
export const UserConfigSchema = z.strictObject({
  providers: z
    .strictObject({
      anthropic: z.strictObject({ apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'), baseUrlEnv: z.string().optional() }).default({ apiKeyEnv: 'ANTHROPIC_API_KEY' }),
      github: z.strictObject({ tokenEnv: z.string().default('GITHUB_TOKEN'), useGhCli: z.boolean().default(true), apiUrl: z.url().default('https://api.github.com') }).default({ tokenEnv: 'GITHUB_TOKEN', useGhCli: true, apiUrl: 'https://api.github.com' }),
      linear: z.strictObject({ apiKeyEnv: z.string().default('LINEAR_API_KEY'), apiUrl: z.url().default('https://api.linear.app/graphql') }).default({ apiKeyEnv: 'LINEAR_API_KEY', apiUrl: 'https://api.linear.app/graphql' }),
    })
    .default({
      anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      github: { tokenEnv: 'GITHUB_TOKEN', useGhCli: true, apiUrl: 'https://api.github.com' },
      linear: { apiKeyEnv: 'LINEAR_API_KEY', apiUrl: 'https://api.linear.app/graphql' },
    }),
  models: z
    .strictObject({
      implementation: z.string().default('claude-sonnet-5-5'),
      prDraft: z.string().default('claude-haiku-5-5'),
      /** Optional effort for the implementation model (`low` | `medium` | `high` | `xhigh` | `max`). */
      implementationEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
      registry: z.record(z.string(), ModelEntrySchema).default({}),
    })
    .default({ implementation: 'claude-sonnet-5-5', prDraft: 'claude-haiku-5-5', implementationEffort: 'medium', registry: {} }),
  cache: z.strictObject({ enabled: z.boolean().default(true), ttl: CacheTtlSchema.default('5m') }).default({ enabled: true, ttl: '5m' }),
  limits: z
    .strictObject({
      maxCostPerRunUsd: z.number().positive().default(0.5),
      maxPrDraftCostUsd: z.number().positive().default(0.02),
      maxModelTurns: z.number().int().positive().default(12),
      maxPatchAttempts: z.number().int().positive().default(8),
      /** Fraction of the stage budget kept in reserve; requests whose worst case would eat into it are refused. */
      reserveFraction: z.number().min(0).max(0.5).default(0.05),
    })
    .default({ maxCostPerRunUsd: 0.5, maxPrDraftCostUsd: 0.02, maxModelTurns: 12, maxPatchAttempts: 8, reserveFraction: 0.05 }),
  runtime: z
    .strictObject({
      /** `required` fails closed without an OS sandbox; `reduced` must be chosen explicitly. */
      isolation: z.enum(['required', 'reduced']).default('required'),
      network: z.literal('deny').default('deny'),
      questionMode: z.enum(['interactive', 'noninteractive']).default('interactive'),
      /** `in-place` (default): work on the user's checked-out branch; `worktree`: disposable worktree per run. */
      workspace: z.enum(['in-place', 'worktree']).default('in-place'),
    })
    .default({ isolation: 'required', network: 'deny', questionMode: 'interactive', workspace: 'in-place' }),
  storage: z.strictObject({ directory: z.string().default('~/.local/share/aperture') }).default({ directory: '~/.local/share/aperture' }),
  pr: z
    .strictObject({
      draftByDefault: z.boolean().default(true),
      // Approval can never be disabled in the MVP.
      requireApproval: z.literal(true).default(true),
    })
    .default({ draftByDefault: true, requireApproval: true }),
  /** Trusted command registry used by `run_check` when a contract does not define the command itself. */
  commands: z.record(z.string(), CommandSpecSchema).default({}),
  /** Maps GitHub repositories to local clones, and Linear team keys to GitHub repositories. */
  repositories: z
    .record(RepoSlug, z.strictObject({ path: z.string(), baseBranch: z.string().default('main') }))
    .default({}),
  linear: z.strictObject({ teamRepositories: z.record(z.string(), RepoSlug).default({}) }).default({ teamRepositories: {} }),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.APERTURE_CONFIG) return resolve(env.APERTURE_CONFIG);
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'aperture', 'config.yaml');
}

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password)$/i;

function findInlineSecrets(value: unknown, path: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string') found.push([...path, key].join('.'));
    found.push(...findInlineSecrets(child, [...path, key]));
  }
  return found;
}

export function parseUserConfig(raw: unknown): UserConfig {
  const secrets = findInlineSecrets(raw);
  if (secrets.length > 0) {
    throw new ConfigError(`secrets must come from environment variables or the OS keychain, not config YAML (found: ${secrets.join(', ')})`, secrets);
  }
  const result = UserConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = formatZodIssues(result.error);
    throw new ConfigError(`invalid aperture config:\n  ${issues.join('\n  ')}`, issues);
  }
  return result.data;
}

export function loadUserConfig(path: string = defaultConfigPath()): UserConfig {
  if (!existsSync(path)) return parseUserConfig({});
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'), { maxAliasCount: 50, uniqueKeys: true });
  } catch (err) {
    throw new ConfigError(`config ${path} is not valid YAML: ${(err as Error).message}`);
  }
  return parseUserConfig(raw);
}

export function resolveStorageDirectory(config: UserConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (env.APERTURE_HOME) return resolve(env.APERTURE_HOME);
  return resolve(expandHome(config.storage.directory));
}

export const DEFAULT_CONFIG_YAML = `# Aperture Harness configuration (see docs/system-design.md §15)
providers:
  anthropic:
    apiKeyEnv: ANTHROPIC_API_KEY
models:
  implementation: claude-sonnet-5-5
  prDraft: claude-haiku-5-5
cache:
  enabled: true
  ttl: 5m
limits:
  maxCostPerRunUsd: 0.50
  maxPrDraftCostUsd: 0.02
  maxModelTurns: 12
  maxPatchAttempts: 8
runtime:
  isolation: required
  network: deny
  questionMode: interactive
  workspace: in-place        # run on your checked-out branch; or `worktree`
storage:
  directory: ~/.local/share/aperture
pr:
  draftByDefault: true
  requireApproval: true
# Trusted check commands, referenced by contract checks via commandId:
# commands:
#   typecheck:
#     exec: pnpm
#     args: [exec, tsc, --noEmit]
#     timeoutSeconds: 300
# Local clones for GitHub repositories:
# repositories:
#   org/repo:
#     path: ~/code/repo
#     baseBranch: main
`;
