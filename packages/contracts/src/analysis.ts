import { compileGlobs, isGlobPattern } from './glob.ts';
import type { ExecutionContract } from './schema.ts';

/** Placeholder left by the contract compiler where a person must decide. */
export const PLACEHOLDER = '__EDIT_ME__';

export interface ContractFinding {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

/**
 * Static review of a contract before approval. Errors block approval; warnings are shown to the
 * approver. The gateway still enforces deny-wins at runtime regardless of these findings.
 */
export function analyzeContract(contract: ExecutionContract, knownCommandIds: ReadonlySet<string> = new Set()): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const { scope, checks, commands } = contract.spec;
  const denied = compileGlobs(scope.denied, { nocase: true });

  for (const w of scope.writable) {
    if (!isGlobPattern(w) && denied(w)) {
      findings.push({ level: 'warning', code: 'WRITABLE_DENIED_OVERLAP', message: `writable path ${w} is also denied; deny wins and it cannot be modified` });
    } else if (isGlobPattern(w)) {
      findings.push({ level: 'warning', code: 'WRITABLE_GLOB', message: `writable entry ${w} is a glob; prefer explicit file paths for atomic tasks` });
    }
  }

  for (const check of checks) {
    if (!Object.hasOwn(commands, check.commandId) && !knownCommandIds.has(check.commandId)) {
      findings.push({ level: 'error', code: 'UNKNOWN_COMMAND', message: `check ${check.id} references command ${check.commandId}, which is not defined in the contract or user config` });
    }
  }

  const placeholders = [
    ...contract.spec.requirements.filter((r) => r.text.includes(PLACEHOLDER)).map((r) => `requirement ${r.id}`),
    ...[...scope.writable, ...scope.readable].filter((p) => p.includes(PLACEHOLDER)).map((p) => `path ${p}`),
    ...(contract.spec.goal.includes(PLACEHOLDER) ? ['goal'] : []),
  ];
  if (placeholders.length > 0) {
    findings.push({ level: 'error', code: 'NEEDS_EDIT', message: `fill in the ${PLACEHOLDER} placeholders before approving (${placeholders.join(', ')})` });
  }

  if (!checks.some((c) => c.required)) {
    findings.push({ level: 'warning', code: 'NO_REQUIRED_CHECKS', message: 'no required checks: every requirement will be UNVERIFIED and need manual review' });
  }

  return findings;
}
