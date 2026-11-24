/**
 * The browser's side of the email code routes (docs/EMAIL-CODES.md): the
 * first account's confirmation, the forgotten password, and the signed-in
 * account confirming an address made without a code. Every call goes
 * through the same-origin proxy (`/api/ui/auth/…`), which anchors `/api/auth/*`
 * on this computer's daemon.
 *
 * Each call answers a value or a `CodeFailure` — never throws: a screen shows
 * every refusal, including no answer at all.
 */
import { getLocale, t } from '@/lib/i18n';
import { setupErrorMessage } from '@/lib/setup-license';
import { codeFailure, networkFailure, retryAfterSeconds, type CodeFailure } from './email-code-failure';

export type CodeResult<T> = { ok: true; value: T } | { ok: false; failure: CodeFailure };

/** A code sent: the challenge it belongs to, and when "Resend" opens (ms, this browser's clock). */
export type CodeChallenge = { challengeId: string; resendAt: number };

/** The daemon waits 60 s between two codes (`EMAIL_CODE_RESEND_MS`). */
export const RESEND_MS = 60_000;

type Fetch = typeof fetch;

type Answer = { status: number; body: unknown; retryAfter: string | null };

async function post(path: string, body: unknown, fetchImpl: Fetch): Promise<Answer | null> {
  try {
    const res = await fetchImpl(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const parsed: unknown = await res.json().catch(() => null);
    return { status: res.status, body: parsed, retryAfter: res.headers.get('retry-after') };
  } catch {
    return null;
  }
}

/**
 * The daemon's clock may not be this browser's: "Resend" opens at most
 * 60 s from now, and a refusal (`email_code_too_soon`) corrects an early one.
 */
function localResendAt(serverResendAt: unknown, now: number): number {
  const asked = typeof serverResendAt === 'number' && Number.isFinite(serverResendAt) ? serverResendAt - now : RESEND_MS;
  return now + Math.min(RESEND_MS, Math.max(0, asked));
}

function challengeOf(body: unknown, now: number): CodeChallenge | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as { challengeId?: unknown; resendAt?: unknown };
  if (typeof raw.challengeId !== 'string' || !raw.challengeId) return null;
  return { challengeId: raw.challengeId, resendAt: localResendAt(raw.resendAt, now) };
}

/** A refusal read in full: the body, and the `Retry-After` header when the body has no delay. */
function refusal(answer: Answer, now: number, fallback?: (error: string | undefined) => string): CodeFailure {
  return codeFailure(answer.status, answer.body, now, fallback, retryAfterSeconds(answer.retryAfter, now));
}

/** The setup's own refusals carry no code: the login page's sentences name them. */
const setupFallback = (error: string | undefined): string => setupErrorMessage(error, t);

async function challengeCall(path: string, body: unknown, fetchImpl: Fetch, fallback?: (error: string | undefined) => string): Promise<CodeResult<CodeChallenge>> {
  const answer = await post(path, body, fetchImpl);
  const now = Date.now();
  if (!answer) return { ok: false, failure: networkFailure() };
  const challenge = answer.status === 202 ? challengeOf(answer.body, now) : null;
  if (challenge) return { ok: true, value: challenge };
  return { ok: false, failure: refusal(answer, now, fallback) };
}

export function requestSetupCode(input: { email: string; setupToken?: string }, fetchImpl: Fetch = fetch): Promise<CodeResult<CodeChallenge>> {
  const body = { email: input.email, locale: getLocale(), ...(input.setupToken ? { setupToken: input.setupToken } : {}) };
  return challengeCall('/api/ui/auth/setup/email-code', body, fetchImpl, setupFallback);
}

export function resendSetupCode(challengeId: string, fetchImpl: Fetch = fetch): Promise<CodeResult<CodeChallenge>> {
  return challengeCall('/api/ui/auth/setup/email-code/resend', { challengeId }, fetchImpl, setupFallback);
}

export type NewAccount = {
  email: string;
  name: string;
  password: string;
  scheme?: 'light' | 'dark';
  setupToken?: string;
  challengeId: string;
  code: string;
};

/** Creates the first account, the code proving the address; the daemon answers with the session cookie. */
export async function createAccount(input: NewAccount, fetchImpl: Fetch = fetch): Promise<CodeResult<null>> {
  const { setupToken, scheme, ...rest } = input;
  const body = { ...rest, ...(scheme ? { scheme } : {}), ...(setupToken ? { setupToken } : {}) };
  const answer = await post('/api/ui/auth/setup', body, fetchImpl);
  if (!answer) return { ok: false, failure: networkFailure() };
  if (answer.status === 201) return { ok: true, value: null };
  return { ok: false, failure: refusal(answer, Date.now(), setupFallback) };
}

export function requestResetCode(email: string, fetchImpl: Fetch = fetch): Promise<CodeResult<CodeChallenge>> {
  return challengeCall('/api/ui/auth/password-reset', { email, locale: getLocale() }, fetchImpl);
}

export function resendResetCode(challengeId: string, fetchImpl: Fetch = fetch): Promise<CodeResult<CodeChallenge>> {
  return challengeCall('/api/ui/auth/password-reset/resend', { challengeId }, fetchImpl);
}

export async function confirmReset(input: { challengeId: string; code: string; password: string }, fetchImpl: Fetch = fetch): Promise<CodeResult<null>> {
  const answer = await post('/api/ui/auth/password-reset/confirm', input, fetchImpl);
  if (!answer) return { ok: false, failure: networkFailure() };
  if (answer.status === 200) return { ok: true, value: null };
  return { ok: false, failure: refusal(answer, Date.now()) };
}

/** A code to the signed-in account's own address, made without one (member, admin made offline, moved login). */
export function requestEmailVerification(fetchImpl: Fetch = fetch): Promise<CodeResult<CodeChallenge>> {
  return challengeCall('/api/ui/auth/email-verification', { locale: getLocale() }, fetchImpl);
}

export function resendEmailVerification(challengeId: string, fetchImpl: Fetch = fetch): Promise<CodeResult<CodeChallenge>> {
  return challengeCall('/api/ui/auth/email-verification/resend', { challengeId }, fetchImpl);
}

export async function confirmEmailVerification(input: { challengeId: string; code: string }, fetchImpl: Fetch = fetch): Promise<CodeResult<null>> {
  const answer = await post('/api/ui/auth/email-verification/confirm', input, fetchImpl);
  if (!answer) return { ok: false, failure: networkFailure() };
  if (answer.status === 200) return { ok: true, value: null };
  return { ok: false, failure: refusal(answer, Date.now()) };
}

/**
 * A challenge that can no longer send (expired, already used, five codes
 * spent) is replaced by a new request rather than left as a dead end: the
 * reader asked for a code, they get one.
 */
export const RESTART_CODES: ReadonlySet<string> = new Set(['email_code_expired', 'email_code_send_limit']);
