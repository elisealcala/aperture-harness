import { canonicalJson, deepFreeze, sha256Hex } from './canonical.ts';
import { parseContract } from './load.ts';
import type { ExecutionContract } from './schema.ts';

export const CONTRACT_SCHEMA_VERSION = 1;

/**
 * The immutable, approved form of a contract. Everything downstream (gateway, verifier, PR
 * publisher) reads scope and limits from this record — never from model output or source tickets.
 */
export interface ApprovedContract {
  readonly contractId: string;
  readonly taskId: string;
  readonly version: number;
  readonly contract: ExecutionContract;
  readonly canonicalJson: string;
  readonly sha256: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly schemaVersion: number;
  readonly sourceRevision: string | null;
}

export interface ApproveOptions {
  taskId: string;
  version: number;
  approvedBy: string;
  approvedAt?: Date;
  sourceRevision?: string | null;
}

export function contractDigest(contract: ExecutionContract): { canonicalJson: string; sha256: string } {
  const json = canonicalJson(contract);
  return { canonicalJson: json, sha256: sha256Hex(json) };
}

export function approveContract(contract: ExecutionContract, options: ApproveOptions): ApprovedContract {
  // Re-validate so an in-memory edit after loading cannot smuggle an invalid contract into approval.
  const validated = parseContract(structuredClone(contract));
  const { canonicalJson: json, sha256 } = contractDigest(validated);
  return deepFreeze({
    contractId: `${options.taskId}.v${options.version}`,
    taskId: options.taskId,
    version: options.version,
    contract: validated,
    canonicalJson: json,
    sha256,
    approvedBy: options.approvedBy,
    approvedAt: (options.approvedAt ?? new Date()).toISOString(),
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceRevision: options.sourceRevision ?? null,
  });
}

/** Rebuilds an approved record from persisted fields, failing if the stored digest does not match. */
export function restoreApprovedContract(row: Omit<ApprovedContract, 'contract'>): ApprovedContract {
  const actual = sha256Hex(row.canonicalJson);
  if (actual !== row.sha256) {
    throw new Error(`approved contract ${row.contractId} failed integrity check (digest mismatch)`);
  }
  const contract = parseContract(JSON.parse(row.canonicalJson));
  if (canonicalJson(contract) !== row.canonicalJson) {
    throw new Error(`approved contract ${row.contractId} does not round-trip through the current schema`);
  }
  return deepFreeze({ ...row, contract });
}

export type ContractChangeKind = 'goal' | 'requirements' | 'scope' | 'permissions' | 'commands' | 'checks' | 'limits' | 'models' | 'cache' | 'metadata';

/** Lists the top-level sections that differ between two contracts (used to label amendments). */
export function diffContracts(a: ExecutionContract, b: ExecutionContract): ContractChangeKind[] {
  const changes: ContractChangeKind[] = [];
  if (canonicalJson(a.metadata) !== canonicalJson(b.metadata)) changes.push('metadata');
  const keys: Array<Exclude<ContractChangeKind, 'metadata'>> = ['goal', 'requirements', 'scope', 'permissions', 'commands', 'checks', 'limits', 'models', 'cache'];
  for (const key of keys) {
    if (canonicalJson(a.spec[key]) !== canonicalJson(b.spec[key])) changes.push(key);
  }
  return changes;
}

/** Produces a new (unapproved) contract revision with extra writable paths. */
export function withAdditionalWritablePaths(contract: ExecutionContract, paths: readonly string[]): ExecutionContract {
  const next = structuredClone(contract) as ExecutionContract;
  const writable = new Set(next.spec.scope.writable);
  for (const p of paths) writable.add(p);
  next.spec.scope.writable = [...writable];
  return parseContract(next);
}
