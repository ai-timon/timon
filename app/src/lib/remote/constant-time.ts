import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare two secrets without leaking, through the response time, how many
 * leading characters match or how long the expected value is: both sides are
 * hashed to the same fixed length first, so `timingSafeEqual` never sees a
 * length mismatch it would have to short-circuit on.
 */
export function secretEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
