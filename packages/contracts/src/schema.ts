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

export function repoPatternProblem(value: string): string | undefined {
  if (value.includes('\0') || /[\u0000-\u001f]/.test(value)) return 'contains control characters';
  if (value.includes('\\')) return 'backslashes are not allowed; use forward slashes';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'absolute paths are not allowed';
  if (value.startsWith('~')) return 'home-relative paths are not allowed';
  const segments = value.split('/');
  if (segments.some((s) => s === '..')) return 'parent-directory traversal is not allowed';
  if (segments.some((s) => s === '.git')) return 'the .git directory is never in scope';
  return undefined;
}

export const CommandSpecSchema = z.strictObject({
  exec: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._/+-]+$/, 'exec must be a bare executable name or path without shell syntax'),
  args: z.array(z.string().max(4096)).max(64).default([]),
  timeoutSeconds: z.number().int().positive().max(3600).default(300),
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
  network: z.literal('deny').default('deny'),
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
