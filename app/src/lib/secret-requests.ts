/**
 * A secret an agent asks its user for (`secret_request`), shown as a card in
 * the mission's conversation. Mirrors `SecretRequestView`
 * (orchestrator/src/plugins-bundled/secrets-vault/requests.ts): the app and the
 * daemon are separate packages, no import possible.
 *
 * The card's events (`secret_request`, `secret_request_resolved`) carry the
 * request and its outcome, never a value: a value typed here goes once, in the
 * body of one POST, to the vault (`provideSecretRequest`), and is not kept.
 */

export const SECRET_REQUEST_EVENT = 'secret_request';
export const SECRET_REQUEST_RESOLVED_EVENT = 'secret_request_resolved';

export const SECRET_REQUEST_LIFETIMES = ['once', 'mission', 'persistent'] as const;
export type SecretRequestLifetime = (typeof SECRET_REQUEST_LIFETIMES)[number];

export const SECRET_REQUEST_STATUSES = ['pending', 'provided', 'refused', 'expired'] as const;
export type SecretRequestStatus = (typeof SECRET_REQUEST_STATUSES)[number];

/** Same bound as the daemon's: a key, a password, a code — not a file. */
export const MAX_SECRET_VALUE_CHARS = 16_384;

export type SecretRequestView = {
  id: string;
  missionId: string;
  agent: string;
  name: string;
  reason: string;
  lifetime: SecretRequestLifetime;
  /** Hosts the vault may send it to on the agent's behalf; null = a page origin or the agent's environment. */
  hosts: string[] | null;
  header: string | null;
  /** The exact page origin the built-in browser may fill it into; null = hosts or the environment. */
  origin: string | null;
  project: string | null;
  missionTitle: string;
  status: SecretRequestStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/;
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * The payload of a `secret_request` event, or null when it is not one. The
 * strings end up as text nodes; a control character in them is a forged card,
 * refused rather than drawn.
 */
export function parseSecretRequest(raw: unknown): SecretRequestView | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  const missionId = str(p.missionId);
  const agent = str(p.agent);
  const name = str(p.name);
  const reason = str(p.reason);
  const lifetime = oneOf(SECRET_REQUEST_LIFETIMES, p.lifetime);
  if (!id || !missionId || !agent || !name || !reason || !lifetime || !NAME_RE.test(name)) return null;
  if ([agent, reason].some((text) => CONTROL_CHARS.test(text))) return null;
  const hosts = Array.isArray(p.hosts) ? p.hosts.filter((h): h is string => typeof h === 'string' && !CONTROL_CHARS.test(h)) : null;
  const origin = str(p.origin);
  if (origin && CONTROL_CHARS.test(origin)) return null;
  return {
    id,
    missionId,
    agent,
    name,
    reason,
    lifetime,
    hosts: hosts && hosts.length > 0 ? hosts : null,
    header: str(p.header),
    origin: hosts && hosts.length > 0 ? null : origin,
    project: str(p.project),
    missionTitle: str(p.missionTitle) ?? '',
    status: oneOf(SECRET_REQUEST_STATUSES, p.status) ?? 'pending',
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
    expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0,
    resolvedAt: typeof p.resolvedAt === 'number' ? p.resolvedAt : null,
  };
}

export type SecretRequestResolution = { id: string; status: Exclude<SecretRequestStatus, 'pending'>; resolvedAt: number | null };

export function parseSecretRequestResolution(raw: unknown): SecretRequestResolution | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  const status = oneOf(SECRET_REQUEST_STATUSES, p.status);
  if (!id || !status || status === 'pending') return null;
  return { id, status, resolvedAt: typeof p.resolvedAt === 'number' ? p.resolvedAt : null };
}

/** An outcome is final: a late or replayed event never sends a card back to pending. */
export function applySecretRequestResolution(request: SecretRequestView, resolution: SecretRequestResolution): SecretRequestView {
  if (request.id !== resolution.id || request.status !== 'pending') return request;
  return { ...request, status: resolution.status, resolvedAt: resolution.resolvedAt };
}

/** Pending on the daemon's side, but past its expiry here: the card stops offering the field. */
export function secretRequestExpired(request: SecretRequestView, now: number = Date.now()): boolean {
  return request.status === 'pending' && request.expiresAt > 0 && request.expiresAt <= now;
}

export type SecretAnswerError = 'not_found' | 'already_decided' | 'expired' | 'duplicate' | 'not_stored' | 'invalid_request' | 'session_required' | 'network';
export type SecretAnswerOutcome = { ok: true; request: SecretRequestView } | { ok: false; error: SecretAnswerError };

const ERRORS: readonly SecretAnswerError[] = ['not_found', 'already_decided', 'expired', 'duplicate', 'not_stored', 'invalid_request', 'session_required'];

/** The daemon's `code` for each refusal; an older daemon put the bare name in `error`. */
const CODES: Readonly<Record<string, SecretAnswerError>> = {
  secret_request_not_found: 'not_found',
  secret_request_decided: 'already_decided',
  secret_request_expired: 'expired',
  secret_request_duplicate: 'duplicate',
  secret_request_not_stored: 'not_stored',
  secret_request_value_invalid: 'invalid_request',
  invalid_request: 'invalid_request',
  secret_request_session_required: 'session_required',
};

/** Which refusal a failed answer is, `null` when the body names none. */
export function secretAnswerError(body: unknown): SecretAnswerError | null {
  const raw = body && typeof body === 'object' ? body as { code?: unknown; error?: unknown } : {};
  if (typeof raw.code === 'string' && Object.prototype.hasOwnProperty.call(CODES, raw.code)) return CODES[raw.code]!;
  return oneOf(ERRORS, raw.error);
}

async function answer(id: string, verb: 'provide' | 'refuse', body: unknown): Promise<SecretAnswerOutcome> {
  let res: Response;
  try {
    // In the body, never the URL: a query string lands in logs, history and `Referer`.
    res = await fetch(`/api/ui/secrets/requests/${encodeURIComponent(id)}/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  const json = (await res.json().catch(() => null)) as { request?: unknown; error?: unknown; code?: unknown } | null;
  if (res.ok) {
    const request = parseSecretRequest(json?.request);
    return request ? { ok: true, request } : { ok: false, error: 'network' };
  }
  return { ok: false, error: secretAnswerError(json) ?? 'network' };
}

/** Sends the typed value to the vault. The caller drops it from memory whatever the outcome. */
export function provideSecretRequest(id: string, value: string): Promise<SecretAnswerOutcome> {
  return answer(id, 'provide', { value });
}

export function refuseSecretRequest(id: string): Promise<SecretAnswerOutcome> {
  return answer(id, 'refuse', {});
}
