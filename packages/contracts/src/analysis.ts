import { compileGlobs, isGlobPattern } from './glob.ts';
import type { ExecutionContract } from './schema.ts';

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

  if (!checks.some((c) => c.required)) {
    findings.push({ level: 'warning', code: 'NO_REQUIRED_CHECKS', message: 'no required checks: every requirement will be UNVERIFIED and need manual review' });
  }

  return findings;
}
