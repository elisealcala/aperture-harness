import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { ApprovedContract } from '@aperture/contracts';
import type { CheckExecution, ToolGateway } from '@aperture/gateway';
import type { WorktreeManager } from '@aperture/sandbox';

export type VerificationResult = 'PASS' | 'FAIL' | 'UNVERIFIED' | 'BLOCKED';
export type RequirementStatus = 'VERIFIED' | 'UNVERIFIED' | 'FAILED';

export interface ChangedFile {
  path: string;
  status: string;
  added: number | null;
  removed: number | null;
  authorized: boolean;
}

export interface ScopeViolation {
  path: string;
  code: 'NOT_WRITABLE' | 'DENIED' | 'UNTRACKED_FILE' | 'BINARY_CHANGE' | 'MODE_CHANGE' | 'SYMLINK' | 'TYPE_CHANGE' | 'DEPENDENCY_EDIT';
  detail: string;
}

export interface CheckOutcome {
  checkId: string;
  required: boolean;
  status: CheckExecution['status'];
  exitCode: number | null;
  durationMs: number;
  artifactPath: string;
  outputTail: string;
}

export interface RequirementEvidence {
  id: string;
  text: string;
  status: RequirementStatus;
  files: string[];
  patchOperations: string[];
  checks: string[];
  note: string;
}

export interface AppliedPatch {
  opId: string;
  path: string;
  requirementIds: string[];
}

export interface VerificationReport {
  schemaVersion: 1;
  attempt: number;
  result: VerificationResult;
  summary: string;
  baselineSha: string;
  contractVersion: number;
  contractSha256: string;
  diffSha256: string;
  changes: ChangedFile[];
  violations: ScopeViolation[];
  checks: CheckOutcome[];
  requirements: RequirementEvidence[];
  failureSignature: string | null;
  isolation: string;
  verifiedAt: string;
}

export interface VerifyInput {
  attempt: number;
  contract: ApprovedContract;
  gateway: ToolGateway;
  worktrees: WorktreeManager;
  worktreePath: string;
  baselineSha: string;
  /** Patches recorded as applied by the gateway for this run (requirement traceability). */
  appliedPatches: readonly AppliedPatch[];
  isolation: string;
}

const DEPENDENCY_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile',
  'Pipfile.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
]);

/** Removes volatile fragments (timings, temp paths, hex ids) so equal failures hash equally. */
export function normalizeFailureText(text: string): string {
  return text
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds)\b/g, '<t>')
    .replace(/\/(private\/)?(var|tmp)\/[^\s:'"]+/g, '<tmp>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Independent verification (§12): scope → static/behavioral checks → requirement evidence. The
 * model's own claims are never an input; only the worktree, the contract and check results are.
 */
export async function verifyRun(input: VerifyInput): Promise<VerificationReport> {
  const { contract, gateway, worktrees, worktreePath, baselineSha } = input;
  const spec = contract.contract.spec;

  // Checks first: a check that rewrites files (formatters, generators) must show up in the scope stage.
  const checks: CheckOutcome[] = [];
  for (const check of spec.checks) {
    const exec = await gateway.runCheck(check.id, input.attempt);
    checks.push({ checkId: check.id, required: check.required, status: exec.status, exitCode: exec.exitCode, durationMs: exec.durationMs, artifactPath: exec.artifactPath, outputTail: exec.outputTail });
  }

  // Scope.
  const [nameStatus, numstat, summary, untracked, special] = await Promise.all([
    worktrees.nameStatus(worktreePath, baselineSha),
    worktrees.numstat(worktreePath, baselineSha),
    worktrees.summary(worktreePath, baselineSha),
    worktrees.untracked(worktreePath),
    worktrees.specialModes(worktreePath),
  ]);
  const stats = new Map(numstat.map((n) => [n.path, n]));
  const violations: ScopeViolation[] = [];
  const changes: ChangedFile[] = nameStatus.map((c) => {
    const authorized = gateway.policy.writable(c.path);
    if (gateway.policy.denied(c.path)) violations.push({ path: c.path, code: 'DENIED', detail: 'changed a denied path' });
    else if (!authorized) violations.push({ path: c.path, code: 'NOT_WRITABLE', detail: 'changed a path outside the writable scope' });
    if (c.status.startsWith('T')) violations.push({ path: c.path, code: 'TYPE_CHANGE', detail: 'file type changed' });
    const stat = stats.get(c.path);
    if (stat && stat.added === null) violations.push({ path: c.path, code: 'BINARY_CHANGE', detail: 'binary change' });
    if (spec.permissions.dependencies === 'deny' && DEPENDENCY_FILES.has(basename(c.path))) {
      violations.push({ path: c.path, code: 'DEPENDENCY_EDIT', detail: 'dependency manifests and lockfiles may not change' });
    }
    return { path: c.path, status: c.status, added: stat?.added ?? null, removed: stat?.removed ?? null, authorized };
  });
  for (const line of summary) {
    if (/mode change/.test(line)) violations.push({ path: line.replace(/^.*mode change \d+ => \d+ /, ''), code: 'MODE_CHANGE', detail: line });
    if (/create mode 120000|create mode 160000/.test(line)) violations.push({ path: line.replace(/^.*create mode \d+ /, ''), code: 'SYMLINK', detail: line });
  }
  const changedPaths = new Set(changes.map((c) => c.path));
  for (const s of special) {
    if (changedPaths.has(s.path)) violations.push({ path: s.path, code: 'SYMLINK', detail: `mode ${s.mode}` });
  }
  for (const path of untracked) violations.push({ path, code: 'UNTRACKED_FILE', detail: 'unexpected untracked file (not created through propose_patch)' });

  // Requirements.
  const finalPaths = new Set(changes.map((c) => c.path));
  const requirements: RequirementEvidence[] = spec.requirements.map((req) => {
    const patches = input.appliedPatches.filter((p) => p.requirementIds.includes(req.id) && finalPaths.has(p.path));
    const covering = checks.filter((c) => {
      const declared = spec.checks.find((d) => d.id === c.checkId);
      return declared?.covers ? declared.covers.includes(req.id) : true;
    });
    const failedCovering = covering.filter((c) => c.required && c.status !== 'PASS');
    const passingCovering = covering.filter((c) => c.status === 'PASS');
    let status: RequirementStatus;
    let note: string;
    if (failedCovering.length > 0) {
      status = 'FAILED';
      note = `covering check(s) failed: ${failedCovering.map((c) => c.checkId).join(', ')}`;
    } else if (patches.length === 0) {
      status = 'UNVERIFIED';
      note = 'no applied change references this requirement; needs manual review';
    } else if (passingCovering.length === 0) {
      status = 'UNVERIFIED';
      note = 'changed files reference it but no passing check covers it; needs manual review';
    } else {
      status = 'VERIFIED';
      note = `diff evidence in ${[...new Set(patches.map((p) => p.path))].join(', ')}; checks ${passingCovering.map((c) => c.checkId).join(', ')} passed`;
    }
    return { id: req.id, text: req.text, status, files: [...new Set(patches.map((p) => p.path))], patchOperations: patches.map((p) => p.opId), checks: passingCovering.map((c) => c.checkId), note };
  });

  const failedRequired = checks.filter((c) => c.required && c.status !== 'PASS');
  let result: VerificationResult;
  let summaryText: string;
  if (violations.length > 0) {
    result = 'BLOCKED';
    summaryText = `scope violations: ${violations.map((v) => `${v.path} (${v.code})`).join(', ')}`;
  } else if (changes.length === 0) {
    result = 'FAIL';
    summaryText = 'no changes were made to the worktree';
  } else if (failedRequired.length > 0) {
    result = 'FAIL';
    summaryText = `required checks failed: ${failedRequired.map((c) => `${c.checkId} (${c.status})`).join(', ')}`;
  } else if (requirements.every((r) => r.status === 'VERIFIED')) {
    result = 'PASS';
    summaryText = `all ${requirements.length} requirements have diff and check evidence`;
  } else {
    result = 'UNVERIFIED';
    summaryText = `unverified requirements: ${requirements.filter((r) => r.status !== 'VERIFIED').map((r) => r.id).join(', ')}`;
  }

  const failureSignature =
    result === 'FAIL'
      ? sha256(JSON.stringify({ empty: changes.length === 0, checks: failedRequired.map((c) => [c.checkId, c.status, normalizeFailureText(c.outputTail)]) }))
      : null;
  const diff = await worktrees.diff(worktreePath, baselineSha);

  return {
    schemaVersion: 1,
    attempt: input.attempt,
    result,
    summary: summaryText,
    baselineSha,
    contractVersion: contract.version,
    contractSha256: contract.sha256,
    diffSha256: sha256(diff),
    changes,
    violations,
    checks,
    requirements,
    failureSignature,
    isolation: input.isolation,
    verifiedAt: new Date().toISOString(),
  };
}

/** Actionable diagnostics fed back to the executor after a FAIL (bounded). */
export function failureFeedback(report: VerificationReport): string {
  const lines = [`Harness verification attempt ${report.attempt}: ${report.result}. ${report.summary}.`];
  for (const check of report.checks.filter((c) => c.status !== 'PASS')) {
    lines.push(`\nCheck ${check.checkId} ${check.status} (exit ${check.exitCode ?? 'none'}):\n${check.outputTail.slice(-4000)}`);
  }
  for (const req of report.requirements.filter((r) => r.status !== 'VERIFIED')) lines.push(`Requirement ${req.id} ${req.status}: ${req.note}`);
  lines.push('\nFix these failures within the approved contract, then reply with your summary. Do not modify tests to hide failures unless the contract requires it.');
  return lines.join('\n');
}
