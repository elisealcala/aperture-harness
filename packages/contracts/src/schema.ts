import { z } from 'zod';

/** Requirement identifiers such as `R1`, `R12`, `AC-3`. */
export const RequirementIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, 'requirement ids must be short alphanumeric identifiers like R1');

/**
 * A repository-relative glob or path. Rejects absolute paths, traversal segments, backslashes and
 * control characters at the schema level; the gateway re-validates every concrete path at use time.
 */
export const RepoGlobSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, ctx) => {
    const problem = repoPatternProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: `${JSON.stringify(value)}: ${problem}` });
  });

/** True when the string contains ASCII control characters (including NUL and DEL). */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function repoPatternProblem(value: string): string | undefined {
  if (hasControlChars(value)) return 'contains control characters';
  if (value.includes('\\')) return 'backslashes are not allowed; use forward slashes';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'absolute paths are not allowed';
  if (value.startsWith('~')) return 'home-relative paths are not allowed';
  const segments = value.split('/');
  if (segments.some((s) => s === '..')) return 'parent-directory traversal is not allowed';
  if (segments.some((s) => s === '.git')) return 'the .git directory is never in scope';
  return undefined;
}

const EnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'env names must be UPPER_SNAKE_CASE');

/** Variables a contract may never set for a command: the sandbox and proxy own them. */
export const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
]);

export const CommandEnvValueSchema = z.union([
  z.strictObject({ value: z.string().max(2000) }),
  /** Resolved from the operator's environment at execution time; never stored in the contract. */
  z.strictObject({ fromEnv: EnvNameSchema, secret: z.boolean().default(true) }),
]);
export type CommandEnvValue = z.infer<typeof CommandEnvValueSchema>;

/** `host`, `host:port` or `*.domain[:port]`; IP literals, `localhost` and bare `*` are rejected. */
export const EgressHostSchema = z
  .string()
  .max(253)
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?$/i, 'egress hosts must be DNS names (optionally *.domain) with an optional :port; IP literals and bare * are not allowed')
  .refine((h) => !/(^|\.)localhost(:\d+)?$/i.test(h), 'localhost names are not allowed')
  .refine((h) => {
    const port = /:(\d+)$/.exec(h)?.[1];
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
  }, 'port must be between 1 and 65535');

export const NetworkPermissionSchema = z.union([
  z.literal('deny'),
  z.strictObject({
    mode: z.literal('allowlist'),
    hosts: z.array(EgressHostSchema).min(1).max(20),
    /** Only harness-mapped check commands may use egress; the model never does. */
    phases: z.array(z.literal('checks')).min(1).default(['checks']),
  }),
]);
export type NetworkPermission = z.infer<typeof NetworkPermissionSchema>;

export const CommandSpecSchema = z.strictObject({
  exec: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._/+-]+$/, 'exec must be a bare executable name or path without shell syntax'),
  args: z.array(z.string().max(4096)).max(64).default([]),
  timeoutSeconds: z.number().int().positive().max(3600).default(300),
  env: z
    .record(EnvNameSchema, CommandEnvValueSchema)
    .optional()
    .superRefine((env, ctx) => {
      for (const name of Object.keys(env ?? {})) if (RESERVED_ENV_NAMES.has(name)) ctx.addIssue({ code: 'custom', message: `${name} is reserved and cannot be set by a contract` });
    }),
});
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export const CheckSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  required: z.boolean().default(true),
  /** Requirement ids this check provides behavioral evidence for. Omitted = all requirements. */
  covers: z.array(RequirementIdSchema).optional(),
});
export type Check = z.infer<typeof CheckSchema>;

export const SourceRefSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('github'),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    issueNumber: z.number().int().positive(),
    revision: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal('linear'),
    issueId: z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional(),
    revision: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal('local'),
    path: z.string().optional(),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional(),
  }),
]);
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const LimitsSchema = z.strictObject({
  maxModelTurns: z.number().int().positive().max(200).default(12),
  maxPatchAttempts: z.number().int().positive().max(200).default(8),
  maxCostUsd: z.number().positive().max(100).default(0.5),
  maxWallClockMinutes: z.number().positive().max(24 * 60).default(30),
  maxVerificationAttempts: z.number().int().positive().max(20).default(3),
  prBudgetUsd: z.number().positive().max(10).default(0.02),
  maxOutputTokensPerTurn: z.number().int().positive().max(128_000).default(16_000),
});
export type Limits = z.infer<typeof LimitsSchema>;

export const PermissionsSchema = z.strictObject({
  // The MVP supports only the restrictive value for each privileged capability; anything else is
  // rejected at load time rather than silently ignored.
  network: NetworkPermissionSchema.default('deny'),
  dependencies: z.literal('deny').default('deny'),
  shell: z.literal('approved-checks-only').default('approved-checks-only'),
  issueWrites: z.literal('deny').default('deny'),
  pullRequestCreate: z.enum(['approval-required', 'deny']).default('approval-required'),
});
export type Permissions = z.infer<typeof PermissionsSchema>;

export const CacheTtlSchema = z.enum(['5m', '1h']);
export type CacheTtl = z.infer<typeof CacheTtlSchema>;

export const ContractSpecSchema = z.strictObject({
  goal: z.string().min(1).max(4000),
  requirements: z
    .array(z.strictObject({ id: RequirementIdSchema, text: z.string().min(1).max(4000) }))
    .min(1, 'a contract needs at least one requirement'),
  scope: z.strictObject({
    writable: z.array(RepoGlobSchema).min(1),
    readable: z.array(RepoGlobSchema).default([]),
    denied: z.array(RepoGlobSchema).default([]),
  }),
  permissions: PermissionsSchema.default({
    network: 'deny',
    dependencies: 'deny',
    shell: 'approved-checks-only',
    issueWrites: 'deny',
    pullRequestCreate: 'approval-required',
  }),
  commands: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/), CommandSpecSchema).default({}),
  checks: z.array(CheckSchema).default([]),
  limits: LimitsSchema.default(LimitsSchema.parse({})),
  models: z
    .strictObject({
      implement: z.string().min(1).default('claude-sonnet-5-5'),
      prDraft: z.string().min(1).default('claude-haiku-5-5'),
    })
    .default({ implement: 'claude-sonnet-5-5', prDraft: 'claude-haiku-5-5' }),
  cache: z
    .strictObject({ enabled: z.boolean().default(true), ttl: CacheTtlSchema.default('5m') })
    .default({ enabled: true, ttl: '5m' }),
});

export const ExecutionContractSchema = z
  .strictObject({
    apiVersion: z.literal('aperture.dev/v1'),
    kind: z.literal('ExecutionContract'),
    metadata: z.strictObject({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
      source: SourceRefSchema,
      baselineRef: z.string().min(1).max(255).default('HEAD'),
      title: z.string().min(1).max(500),
    }),
    spec: ContractSpecSchema,
  })
  .superRefine((contract, ctx) => {
    const reqIds = new Set<string>();
    for (const r of contract.spec.requirements) {
      if (reqIds.has(r.id)) ctx.addIssue({ code: 'custom', path: ['spec', 'requirements'], message: `duplicate requirement id ${r.id}` });
      reqIds.add(r.id);
    }
    const checkIds = new Set<string>();
    for (const [i, check] of contract.spec.checks.entries()) {
      if (checkIds.has(check.id)) ctx.addIssue({ code: 'custom', path: ['spec', 'checks', i, 'id'], message: `duplicate check id ${check.id}` });
      checkIds.add(check.id);
      for (const covered of check.covers ?? []) {
        if (!reqIds.has(covered)) {
          ctx.addIssue({ code: 'custom', path: ['spec', 'checks', i, 'covers'], message: `check ${check.id} covers unknown requirement ${covered}` });
        }
      }
    }
  });

export type ExecutionContract = z.infer<typeof ExecutionContractSchema>;
export type ContractInput = z.input<typeof ExecutionContractSchema>;
