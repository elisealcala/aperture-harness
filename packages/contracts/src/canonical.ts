import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys sorted recursively, no insignificant whitespace,
 * `undefined` members dropped. Two semantically equal contracts always produce identical bytes, so
 * their SHA-256 digests match.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('canonicalJson: non-finite numbers are not representable');
  }
  return value;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Recursively freezes an object graph so approved artifacts cannot be mutated in-process. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
