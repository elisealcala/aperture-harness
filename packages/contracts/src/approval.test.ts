import { describe, expect, it } from 'vitest';
import { validContractInput } from '../../../tests/helpers/contracts.ts';
import { approveContract, CONTRACT_SCHEMA_VERSION, diffContracts, restoreApprovedContract, withAdditionalWritablePaths, type ApprovedContract } from './approval.ts';
import { canonicalJson, sha256Hex } from './canonical.ts';
import { ContractValidationError, parseContract } from './load.ts';
import type { ExecutionContract } from './schema.ts';

const APPROVED_AT = new Date('2026-11-04T20:00:00.000Z');

function contract(): ExecutionContract {
  return parseContract(validContractInput());
}

function approve(c: ExecutionContract = contract()): ApprovedContract {
  return approveContract(c, { taskId: 'task_1', version: 2, approvedBy: 'alice', approvedAt: APPROVED_AT, sourceRevision: 'sha256:abc' });
}

function persistedRow(approved: ApprovedContract): Omit<ApprovedContract, 'contract'> {
  const { contract: _contract, ...row } = approved;
  return { ...row };
}

describe('approveContract', () => {
  it('records identity, digest, approver, timestamp, schema version and source revision', () => {
    const approved = approve();
    expect(approved.contractId).toBe('task_1.v2');
    expect(approved.taskId).toBe('task_1');
    expect(approved.version).toBe(2);
    expect(approved.approvedBy).toBe('alice');
    expect(approved.approvedAt).toBe('2026-11-04T20:00:00.000Z');
    expect(approved.schemaVersion).toBe(CONTRACT_SCHEMA_VERSION);
    expect(approved.sourceRevision).toBe('sha256:abc');
    expect(approved.canonicalJson).toBe(canonicalJson(approved.contract));
    expect(approved.sha256).toBe(sha256Hex(approved.canonicalJson));
  });

  it('defaults sourceRevision to null', () => {
    const approved = approveContract(contract(), { taskId: 't', version: 1, approvedBy: 'bob' });
    expect(approved.sourceRevision).toBeNull();
    expect(Number.isNaN(Date.parse(approved.approvedAt))).toBe(false);
  });

  it('deep-freezes the approved record so scope cannot be widened in-process', () => {
    const approved = approve();
    expect(Object.isFrozen(approved)).toBe(true);
    expect(Object.isFrozen(approved.contract.spec.scope.writable)).toBe(true);
    expect(() => {
      (approved.contract.spec.scope.writable as string[]).push('package.json');
    }).toThrow(TypeError);
    expect(() => {
      (approved.contract.spec.permissions as { network: string }).network = 'allow';
    }).toThrow(TypeError);
    expect(approved.contract.spec.scope.writable).toEqual(['src/api/session.ts']);
  });

  it('does not freeze or alias the caller-owned contract', () => {
    const original = contract();
    const approved = approve(original);
    expect(Object.isFrozen(original)).toBe(false);
    original.spec.scope.writable.push('src/other.ts');
    expect(approved.contract.spec.scope.writable).toEqual(['src/api/session.ts']);
  });

  it('re-validates, so an invalid in-memory edit cannot be approved', () => {
    const tampered = contract();
    tampered.spec.scope.writable.push('../escape.txt');
    expect(() => approve(tampered)).toThrow(ContractValidationError);

    const widened = contract();
    (widened.spec.permissions as { network: string }).network = 'allow';
    expect(() => approve(widened)).toThrow(ContractValidationError);
  });
});

describe('restoreApprovedContract', () => {
  it('round-trips a persisted approval', () => {
    const approved = approve();
    const restored = restoreApprovedContract(persistedRow(approved));
    expect(restored).toEqual(approved);
    expect(Object.isFrozen(restored.contract)).toBe(true);
  });

  it('detects a tampered canonical JSON (digest mismatch)', () => {
    const approved = approve();
    const tamperedJson = approved.canonicalJson.replace('"writable":["src/api/session.ts"]', '"writable":["src/api/session.ts","package.json"]');
    expect(tamperedJson).not.toBe(approved.canonicalJson);
    expect(() => restoreApprovedContract({ ...persistedRow(approved), canonicalJson: tamperedJson })).toThrow(/failed integrity check/);
  });

  it('detects a tampered digest', () => {
    const approved = approve();
    expect(() => restoreApprovedContract({ ...persistedRow(approved), sha256: sha256Hex('something else') })).toThrow(/digest mismatch/);
  });

  it('rejects JSON whose digest matches but which is not canonical', () => {
    const approved = approve();
    const pretty = JSON.stringify(JSON.parse(approved.canonicalJson), null, 2);
    expect(() => restoreApprovedContract({ ...persistedRow(approved), canonicalJson: pretty, sha256: sha256Hex(pretty) })).toThrow(/does not round-trip/);
  });

  it('rejects stored JSON that no longer passes the schema even with a matching digest', () => {
    const approved = approve();
    const obj = JSON.parse(approved.canonicalJson) as { spec: { permissions: { network: string } } };
    obj.spec.permissions.network = 'allow';
    const json = canonicalJson(obj);
    expect(() => restoreApprovedContract({ ...persistedRow(approved), canonicalJson: json, sha256: sha256Hex(json) })).toThrow(ContractValidationError);
  });
});

describe('diffContracts', () => {
  it('returns no changes for equal contracts', () => {
    expect(diffContracts(contract(), contract())).toEqual([]);
  });

  it('labels each changed section', () => {
    const a = contract();
    const b = contract();
    b.spec.goal = 'A different goal';
    b.spec.scope.writable.push('src/types/session.ts');
    b.spec.limits.maxCostUsd = 0.25;
    b.metadata.title = 'Renamed';
    expect(diffContracts(a, b)).toEqual(['metadata', 'goal', 'scope', 'limits']);
  });

  it('detects requirement, check and command edits', () => {
    const a = contract();
    const b = contract();
    b.spec.requirements.push({ id: 'R3', text: 'new' });
    b.spec.checks.push({ id: 'lint', commandId: 'unit', required: false });
    b.spec.commands.unit = { exec: 'node', args: ['--test', 'other'], timeoutSeconds: 60 };
    expect(diffContracts(a, b)).toEqual(['requirements', 'commands', 'checks']);
  });
});

describe('withAdditionalWritablePaths', () => {
  it('adds new writable paths without duplicating existing ones', () => {
    const next = withAdditionalWritablePaths(contract(), ['src/types/session.ts', 'src/api/session.ts']);
    expect(next.spec.scope.writable).toEqual(['src/api/session.ts', 'src/types/session.ts']);
    expect(diffContracts(contract(), next)).toEqual(['scope']);
  });

  it('does not mutate the input contract', () => {
    const original = contract();
    withAdditionalWritablePaths(original, ['src/types/session.ts']);
    expect(original.spec.scope.writable).toEqual(['src/api/session.ts']);
  });

  it('works on a frozen approved contract', () => {
    const approved = approve();
    const next = withAdditionalWritablePaths(approved.contract, ['src/types/session.ts']);
    expect(next.spec.scope.writable).toContain('src/types/session.ts');
    expect(Object.isFrozen(next)).toBe(false);
  });

  it.each(['../outside.txt', '/etc/passwd', '.git/config'])('re-validates and rejects %j', (path) => {
    expect(() => withAdditionalWritablePaths(contract(), [path])).toThrow(ContractValidationError);
  });
});
