/**
 * HTTP-side helpers shared by every route that tests a credential: which
 * throttle buckets an attempt counts against, the 429 body, and the audit row
 * of a lockout. Extracted verbatim from the users plugin so a second plugin
 * (secrets reveal) throttles exactly like a login.
 */
import type { Request, Response } from 'express';
import { config } from '../config/load.js';
import { auditRequest } from './audit-actor.js';
import { holdAttempt, recordFailure, type ThrottleVerdict } from './login-throttle.js';
import { apiError } from '../api-error.js';

/**
 * Address a throttle bucket is counted against (audit finding #6). The TCP
 * peer by default — a header cannot forge it. `authThrottle.trustProxy` switches
 * to the first `X-Forwarded-For` hop, which is only meaningful behind a reverse
 * proxy that rewrites it; trusting it on a direct listener would let an
 * attacker shed its bucket with every request.
 */
export function throttleIp(req: Request): string | null {
  if (config().authThrottle.trustProxy) {
    const forwarded = req.header('x-forwarded-for');
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0]!.trim() || null;
    }
  }
  return req.socket.remoteAddress ?? null;
}

/** `subject` is the submitted email or invitation token hash — never a resolved account. */
export function throttleKeys(req: Request, scope: string, subject: string | null): string[] {
  const keys: string[] = [];
  const ip = throttleIp(req);
  if (ip) keys.push(`${scope}:ip:${ip}`);
  if (subject) keys.push(`${scope}:subject:${subject}`);
  return keys;
}

/** Same body for every locked-out caller, whatever the account behind it. */
export function sendThrottled(res: Response, verdict: Extract<ThrottleVerdict, { allowed: false }>): void {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))));
  res.status(429).json(apiError('too_many_attempts', 'too many attempts, try again later'));
}

/**
 * Runs a password test with the attempt counted against `keys` while it runs
 * (`holdAttempt`). Call it right after the `checkThrottle` that admitted the
 * attempt, with nothing awaited in between.
 */
export async function testCredential<T>(keys: readonly string[], test: () => Promise<T>): Promise<T> {
  const release = holdAttempt(keys);
  try {
    return await test();
  } finally {
    release();
  }
}

/** Counts the failure and audits the lockout it opens, once per bucket. */
export function noteAuthFailure(req: Request, keys: readonly string[]): void {
  for (const key of recordFailure(keys)) auditRequest(req, 'auth.lockout', key);
}
