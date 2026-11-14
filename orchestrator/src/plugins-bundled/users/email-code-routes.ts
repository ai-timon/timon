/**
 * Email code routes (`docs/EMAIL-CODES.md`): confirming the address of the
 * first account before it exists, and resetting a forgotten password.
 *
 * All public (`PUBLIC_ENDPOINTS` in `@timon/http`): the caller has no session
 * by definition. What authenticates is the six-digit code mailed to the
 * address, bound to an opaque 128-bit challenge id the request returned.
 *
 * The validation of the setup code is `POST /api/auth/setup` itself (see
 * `checkSetupEmailCode`): the password travels with the code and goes straight
 * into the account's hash, so it is never held anywhere in between.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../../config/load.js';
import { dbApi } from '../../db.js';
import { apiError } from '../../api-error.js';
import { licenseState } from '../../license/runtime.js';
import { setupListenerExposed, verifySetupToken } from '../../users/setup-token.js';
import { checkThrottle, clearThrottle } from '../../users/login-throttle.js';
import { noteAuthFailure, sendThrottled, throttleIp, throttleKeys } from '../../users/throttle-http.js';
import { auditRequest } from '../../users/audit-actor.js';
import { hashPassword } from '../../users/password.js';
import { installId } from '../../users/install-id.js';
import { EmailCodeStore, emailCodeOrigin, type CheckResult } from '../../users/email-code.js';
import {
  relayLocale,
  reportVerifiedEmail,
  sendMailCode,
  type MailOutcome,
  type MailRelayOptions,
} from '../../users/mail-relay.js';

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The daemon's one store. Routes take it as a parameter so tests can drive the clock. */
export const defaultEmailCodeStore = new EmailCodeStore();

export type EmailCodeDeps = {
  store: EmailCodeStore;
  relay: MailRelayOptions;
  installId: () => string;
};

export function defaultEmailCodeDeps(overrides: Partial<EmailCodeDeps> = {}): EmailCodeDeps {
  return {
    store: overrides.store ?? defaultEmailCodeStore,
    relay: overrides.relay ?? {},
    installId: overrides.installId ?? (() => installId()),
  };
}

const EmailField = z.string().trim().toLowerCase().max(254).regex(EMAIL_RE);
const LocaleField = z.string().max(16).optional();
const ChallengeField = z.string().regex(/^[0-9a-f]{32}$/);

const RequestBody = z.object({ email: EmailField, locale: LocaleField, setupToken: z.string().max(512).optional() });
const ResendBody = z.object({ challengeId: ChallengeField });
const ResetConfirmBody = z.object({
  challengeId: ChallengeField,
  code: z.string().max(16),
  password: z.string().min(MIN_PASSWORD).max(1024),
});

function sendInvalidBody(res: Response, message: string): void {
  res.status(400).json(apiError('invalid_request', message));
}

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** 429 with the wait both in the header and in the body, for a countdown. */
function sendTooSoon(res: Response, retryAfterMs: number): void {
  const wait = seconds(retryAfterMs);
  res.setHeader('Retry-After', String(wait));
  res.status(429).json({
    ...apiError('email_code_too_soon', `wait ${wait} seconds before asking for another code`, { seconds: wait }),
    retryAfter: wait,
  });
}

/**
 * Too many mails asked from the caller's network in the window, setup and
 * reset together. Same answer for every address, account or not.
 */
function sendOriginLimited(res: Response, retryAfterMs: number): void {
  const wait = seconds(retryAfterMs);
  res.setHeader('Retry-After', String(wait));
  res.status(429).json({
    ...apiError('email_code_origin_limited', `too many code requests from this network, try again in ${wait} seconds`, { seconds: wait }),
    retryAfter: wait,
  });
}

/** Every slot holds a live code asked from a different network: none is evicted for a stranger. */
function sendBusy(res: Response, retryAfterMs: number): void {
  const wait = seconds(retryAfterMs);
  res.setHeader('Retry-After', String(wait));
  res.status(429).json({
    ...apiError('email_code_busy', `too many codes are pending, try again in ${wait} seconds`, { seconds: wait }),
    retryAfter: wait,
  });
}

/** An `issue` refusal: per address, per network, or a full store. */
function sendIssueRefusal(res: Response, refusal: { reason: 'too_soon' | 'origin_limited' | 'busy'; retryAfterMs: number }): void {
  if (refusal.reason === 'origin_limited') sendOriginLimited(res, refusal.retryAfterMs);
  else if (refusal.reason === 'busy') sendBusy(res, refusal.retryAfterMs);
  else sendTooSoon(res, refusal.retryAfterMs);
}

/** Key of the caller's request quota (`EMAIL_CODE_ORIGIN_REQUESTS`). */
function originOf(req: Request): string {
  return emailCodeOrigin(throttleIp(req));
}

/**
 * The relay's answer, as the UI needs it. Offline and a relay that answers
 * without mailing (its 503, a 404 from a site without the route, a proxy's
 * 502) call for different gestures: the user can fix their connection, not
 * Timon's service. Each has its code; `reason` stays for a diagnostic.
 */
export function sendRelayFailure(res: Response, outcome: Exclude<MailOutcome, { ok: true }>): void {
  switch (outcome.kind) {
    case 'offline':
      res.status(503).json({
        ...apiError('email_connection_required', 'an internet connection is needed to confirm the email address'),
        reason: outcome.kind,
      });
      return;
    case 'mail_unavailable':
      res.status(503).json({
        ...apiError('email_service_unavailable', "Timon's email service is unavailable right now, try again later"),
        reason: outcome.kind,
      });
      return;
    case 'rate_limited':
      res.setHeader('Retry-After', String(outcome.retryAfterSec));
      res.status(429).json({
        ...apiError('email_rate_limited', `too many emails sent to this address, try again in ${outcome.retryAfterSec} seconds`, { seconds: outcome.retryAfterSec }),
        retryAfter: outcome.retryAfterSec,
      });
      return;
    case 'invalid':
    case 'unverified_email':
      res.status(400).json(apiError('email_rejected', 'this email address cannot receive a code'));
      return;
  }
}

/** A refused code. `attemptsLeft` is top-level too, for the "N attempts left" line. */
export function sendCodeRefusal(res: Response, result: Exclude<CheckResult, { ok: true }>): void {
  if (result.reason === 'invalid') {
    res.status(400).json({
      ...apiError('email_code_invalid', `wrong code, ${result.attemptsLeft} attempt(s) left`, { attemptsLeft: result.attemptsLeft }),
      attemptsLeft: result.attemptsLeft,
    });
    return;
  }
  if (result.reason === 'exhausted') {
    res.status(400).json({ ...apiError('email_code_exhausted', 'too many wrong codes, ask for a new one'), attemptsLeft: 0 });
    return;
  }
  res.status(410).json(apiError('email_code_expired', 'this code has expired or was already used, ask for a new one'));
}

/**
 * The same admission as `POST /api/auth/setup`: nobody set up yet, a build
 * still in date, and on an exposed listener the one-time setup token. Asking
 * for a code is the first step of creating the superadmin; it must not be
 * open to whoever the setup itself refuses.
 */
function setupOpen(req: Request, res: Response, setupToken: unknown): boolean {
  if (dbApi.countUsers() > 0) {
    res.status(409).json(apiError('already_set_up', 'already set up'));
    return false;
  }
  if (licenseState().reason === 'build_expired') {
    res.status(403).json({ error: 'build_expired' });
    return false;
  }
  if (setupListenerExposed(config()) && req.auth?.kind !== 'daemon-token') {
    const keys = throttleKeys(req, 'setup-token', null);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) { sendThrottled(res, verdict); return false; }
    if (!verifySetupToken(setupToken)) {
      if (typeof setupToken === 'string' && setupToken) noteAuthFailure(req, keys);
      res.status(403).json({ error: 'setup_token_required' });
      return false;
    }
  }
  return true;
}

/**
 * Called by `POST /api/auth/setup` before it creates anything. Returns the
 * challenge to consume once the account exists, or `null` with the refusal
 * already sent. The submitted email must be the one the code went to.
 */
export function checkSetupEmailCode(req: Request, res: Response, deps: EmailCodeDeps, body: { challengeId?: unknown; code?: unknown }, email: string): string | null {
  if (body.challengeId === undefined || body.code === undefined) {
    res.status(400).json(apiError('email_code_required', 'confirm the email address with the code it received first'));
    return null;
  }
  const keys = throttleKeys(req, 'email-code', null);
  const verdict = checkThrottle(keys);
  if (!verdict.allowed) { sendThrottled(res, verdict); return null; }
  const result = deps.store.check(body.challengeId, 'verify', body.code, email);
  if (!result.ok) {
    if (result.reason !== 'expired') noteAuthFailure(req, keys);
    sendCodeRefusal(res, result);
    return null;
  }
  return result.id;
}

/** After the account is created: the code is spent, and the relay learns the address is confirmed. */
export function confirmSetupEmail(deps: EmailCodeDeps, challengeId: string, email: string): void {
  deps.store.consume(challengeId);
  let id: string;
  try { id = deps.installId(); } catch { return; }
  void reportVerifiedEmail({ email, installId: id }, deps.relay).then((ok) => {
    if (!ok) console.warn('[users] the site relay did not record the confirmed email; password reset by email will be unavailable');
  });
}

export function registerEmailCodeRoutes(app: Router, deps: EmailCodeDeps): void {
  const { store } = deps;

  /** Sends one code; `null` when the relay refused, the refusal already answered. */
  async function mail(res: Response, purpose: 'verify' | 'reset', email: string, code: string, locale: string): Promise<boolean> {
    let id: string;
    try { id = deps.installId(); } catch {
      res.status(500).json({ error: 'install_id_unavailable' });
      return false;
    }
    const outcome = await sendMailCode({ purpose, email, code, locale, installId: id }, deps.relay);
    // A reset to an address the relay never saw confirmed for this install is
    // answered like a sent one: telling them apart would reveal which
    // addresses hold an account here.
    if (outcome.ok || (purpose === 'reset' && outcome.kind === 'unverified_email')) return true;
    sendRelayFailure(res, outcome);
    return false;
  }

  app.post('/api/auth/setup/email-code', async (req, res) => {
    const raw = (req.body ?? {}) as { setupToken?: unknown };
    if (!setupOpen(req, res, raw.setupToken)) return;
    const parsed = RequestBody.safeParse(req.body ?? {});
    if (!parsed.success) { sendInvalidBody(res, 'a valid email is required'); return; }
    const { email } = parsed.data;
    const locale = relayLocale(parsed.data.locale);
    const issued = store.issue({ purpose: 'verify', email, userId: null, locale, origin: originOf(req) });
    if (!issued.ok) { sendIssueRefusal(res, issued); return; }
    if (!(await mail(res, 'verify', email, issued.issued.code, locale))) {
      store.drop(issued.issued.id);
      return;
    }
    res.status(202).json({
      challengeId: issued.issued.id,
      email,
      expiresAt: issued.issued.expiresAt,
      resendAt: issued.issued.resendAt,
    });
  });

  app.post('/api/auth/setup/email-code/resend', async (req, res) => {
    if (dbApi.countUsers() > 0) {
      res.status(409).json(apiError('already_set_up', 'already set up'));
      return;
    }
    await resend(req, res, 'verify');
  });

  /**
   * Same answer whether an active account holds the address or not: an
   * unknown address gets a challenge too, mailed through the relay like a
   * real one (which, never having seen it confirmed here, sends nothing).
   * Same work on both paths, so neither the body nor the timing tells.
   */
  app.post('/api/auth/password-reset', async (req, res) => {
    const parsed = RequestBody.safeParse(req.body ?? {});
    if (!parsed.success) { sendInvalidBody(res, 'a valid email is required'); return; }
    const { email } = parsed.data;
    const keys = throttleKeys(req, 'password-reset', email);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) { sendThrottled(res, verdict); return; }
    const user = dbApi.getUserByEmail(email);
    const userId = user && user.status === 'active' ? user.id : null;
    const locale = relayLocale(parsed.data.locale);
    const issued = store.issue({ purpose: 'reset', email, userId, locale, origin: originOf(req) });
    if (!issued.ok) { sendIssueRefusal(res, issued); return; }
    if (!(await mail(res, 'reset', email, issued.issued.code, locale))) {
      store.drop(issued.issued.id);
      return;
    }
    res.status(202).json({ challengeId: issued.issued.id, expiresAt: issued.issued.expiresAt, resendAt: issued.issued.resendAt });
  });

  app.post('/api/auth/password-reset/resend', async (req, res) => {
    await resend(req, res, 'reset');
  });

  /**
   * The code and the new password together. Every session and api token of
   * the account is revoked: whoever forgot the password may be reclaiming an
   * account someone else got into. No session is opened here — the owner
   * signs in with the new password, which proves it was typed right.
   */
  app.post('/api/auth/password-reset/confirm', async (req, res) => {
    const parsed = ResetConfirmBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const passwordIssue = parsed.error.issues.some((issue) => issue.path[0] === 'password');
      if (passwordIssue) {
        res.status(400).json(apiError('password_too_short', `the password must be at least ${MIN_PASSWORD} characters`, { min: MIN_PASSWORD }));
      } else {
        sendInvalidBody(res, 'challengeId, code and password are required');
      }
      return;
    }
    const { challengeId, code, password } = parsed.data;
    const keys = throttleKeys(req, 'email-code', null);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) { sendThrottled(res, verdict); return; }
    const result = store.check(challengeId, 'reset', code);
    if (!result.ok) {
      if (result.reason !== 'expired') noteAuthFailure(req, keys);
      sendCodeRefusal(res, result);
      return;
    }
    const user = result.userId ? dbApi.getUserById(result.userId) : undefined;
    if (!user || user.status !== 'active' || user.email !== result.email) {
      // The address held no account (or no longer does): the code was right
      // by a one-in-a-million chance, and changes nothing.
      store.consume(result.id);
      sendCodeRefusal(res, { ok: false, reason: 'expired' });
      return;
    }
    // Spent before the hash is awaited: a second request carrying the same
    // code must find it gone, not pass the check while this one computes.
    store.consume(result.id);
    clearThrottle(keys);
    dbApi.setUserPassword(user.id, await hashPassword(password));
    dbApi.revokeUserAccess(user.id);
    auditRequest(req, 'user.reset_password_by_email', `user:${user.id}`);
    res.json({ ok: true });
  });

  async function resend(req: Request, res: Response, purpose: 'verify' | 'reset'): Promise<void> {
    const parsed = ResendBody.safeParse(req.body ?? {});
    if (!parsed.success) { sendInvalidBody(res, 'challengeId is required'); return; }
    const attempt = store.resend(parsed.data.challengeId, purpose, originOf(req));
    if (!attempt.ok) {
      if (attempt.reason === 'too_soon') { sendTooSoon(res, attempt.retryAfterMs); return; }
      if (attempt.reason === 'origin_limited') { sendOriginLimited(res, attempt.retryAfterMs); return; }
      if (attempt.reason === 'send_limit') {
        res.status(429).json(apiError('email_code_send_limit', 'too many codes sent for this request, start over'));
        return;
      }
      sendCodeRefusal(res, { ok: false, reason: 'expired' });
      return;
    }
    if (!(await mail(res, purpose, attempt.email, attempt.code, attempt.locale))) {
      attempt.release();
      return;
    }
    attempt.commit();
    res.status(202).json({ challengeId: parsed.data.challengeId, expiresAt: attempt.expiresAt, resendAt: attempt.resendAt });
  }
}
