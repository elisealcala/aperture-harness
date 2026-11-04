import { describe, expect, it } from 'vitest';
import { validContractInput } from '../../../tests/helpers/contracts.ts';
import { contractDigest } from './approval.ts';
import { canonicalJson, deepFreeze, sha256Hex } from './canonical.ts';
import { parseContract } from './load.ts';

/** Rebuilds an object with its keys inserted in reverse order, recursively. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reverseKeys(v)]));
  }
  return value;
}

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('is independent of key insertion order', () => {
    const a = { metadata: { id: 'X', title: 'T' }, spec: { goal: 'g', limits: { maxCostUsd: 1, maxModelTurns: 2 } } };
    const b = { spec: { limits: { maxModelTurns: 2, maxCostUsd: 1 }, goal: 'g' }, metadata: { title: 'T', id: 'X' } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserves array order (order is semantically meaningful)', () => {
    expect(canonicalJson(['b', 'a'])).not.toBe(canonicalJson(['a', 'b']));
  });

  it('drops undefined members', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('throws on non-finite number %s', (n) => {
    expect(() => canonicalJson({ n })).toThrow(TypeError);
  });
});

describe('sha256Hex', () => {
  it('matches the standard test vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes strings and bytes identically', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });
});

describe('contractDigest', () => {
  it('is stable across key order for the same contract', () => {
    const a = parseContract(validContractInput());
    const b = parseContract(reverseKeys(validContractInput()));
    expect(contractDigest(a)).toEqual(contractDigest(b));
    expect(contractDigest(a).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any scope entry changes', () => {
    const a = parseContract(validContractInput());
    const input = validContractInput();
    input.spec.scope.writable = ['src/api/session.ts', 'src/api/other.ts'];
    expect(contractDigest(parseContract(input)).sha256).not.toBe(contractDigest(a).sha256);
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });
});
