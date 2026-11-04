import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID (26 chars, Crockford base32): 48-bit millisecond timestamp + 80 random bits. Lexicographic
 * order follows creation time, which keeps `ORDER BY run_id` meaningful.
 */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
