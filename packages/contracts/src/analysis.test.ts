import { describe, expect, it } from 'vitest';
import { contractWith, validContractInput } from '../../../tests/helpers/contracts.ts';
import { analyzeContract } from './analysis.ts';
import { parseContract } from './load.ts';

function codes(contract: unknown, known?: Set<string>): string[] {
  return analyzeContract(parseContract(contract), known).map((f) => `${f.level}:${f.code}`);
}

describe('analyzeContract', () => {
  it('returns no findings for a clean contract', () => {
    expect(analyzeContract(parseContract(validContractInput()))).toEqual([]);
  });

  it('warns when an explicit writable path is also denied (deny wins)', () => {
    const input = validContractInput();
    input.spec.scope.writable = ['src/api/session.ts', 'package.json'];
    const findings = analyzeContract(parseContract(input));
    expect(findings).toEqual([expect.objectContaining({ level: 'warning', code: 'WRITABLE_DENIED_OVERLAP', message: expect.stringContaining('package.json') })]);
  });

  it('matches the deny list case-insensitively when reporting overlaps', () => {
    const input = validContractInput();
    input.spec.scope.writable = ['PACKAGE.JSON'];
    expect(codes(input)).toEqual(['warning:WRITABLE_DENIED_OVERLAP']);
  });

  it('warns about glob writable entries', () => {
    const input = validContractInput();
    input.spec.scope.writable = ['src/api/**'];
    expect(codes(input)).toEqual(['warning:WRITABLE_GLOB']);
  });

  it('errors when a check references an undefined command', () => {
    const input = contractWith(['spec', 'checks'], [{ id: 'typecheck', commandId: 'tsc', required: true }]);
    const findings = analyzeContract(parseContract(input));
    expect(findings).toEqual([expect.objectContaining({ level: 'error', code: 'UNKNOWN_COMMAND', message: expect.stringContaining('tsc') })]);
  });

  it('accepts commands supplied by the trusted user config', () => {
    const input = contractWith(['spec', 'checks'], [{ id: 'typecheck', commandId: 'tsc', required: true }]);
    expect(codes(input, new Set(['tsc']))).toEqual([]);
  });

  it('warns when no check is required', () => {
    expect(codes(contractWith(['spec', 'checks'], [{ id: 'unit', commandId: 'unit', required: false }]))).toEqual(['warning:NO_REQUIRED_CHECKS']);
    expect(codes(contractWith(['spec', 'checks'], []))).toEqual(['warning:NO_REQUIRED_CHECKS']);
  });
});
