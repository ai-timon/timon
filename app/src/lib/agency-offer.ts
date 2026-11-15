/**
 * Who the account uses Timon for, and the agency offer an `agency` account may
 * ask for. Pure helpers over the daemon's routes (through the Next proxy), so
 * the onboarding step, the Settings row and their tests share them.
 *
 * The daemon owns both: it stores the answer (`PUT /api/onboarding/usage-kind`)
 * and it alone sends the offer request to the site (`/api/partners/lead`). The
 * browser never talks to the site.
 */

/** The daemon's list (`onboarding-usage-kind.ts`), mirrored: the app and the daemon are separate packages. */
export const USAGE_KINDS = ['solo', 'team', 'agency'] as const;
export type UsageKind = typeof USAGE_KINDS[number];

export const USAGE_KIND_PATH = '/api/ui/onboarding/usage-kind';
export const AGENCY_OFFER_PATH = '/api/ui/partners/lead';

export function isUsageKind(value: unknown): value is UsageKind {
  return typeof value === 'string' && (USAGE_KINDS as readonly string[]).includes(value);
}

export type AgencyOfferState = 'none' | 'pending' | 'subscribed' | 'withdrawing' | 'rejected';
export type AgencyOfferError =
  | 'unavailable' | 'unreachable' | 'rate_limited' | 'server_error' | 'invalid' | 'too_large' | 'refused' | 'invalid_response';

export type AgencyOfferView = { state: AgencyOfferState; email: string | null; error: AgencyOfferError | null; at: number | null };

const STATES: readonly AgencyOfferState[] = ['none', 'pending', 'subscribed', 'withdrawing', 'rejected'];
const ERRORS: readonly AgencyOfferError[] = [
  'unavailable', 'unreachable', 'rate_limited', 'server_error', 'invalid', 'too_large', 'refused', 'invalid_response',
];

export const NO_AGENCY_OFFER: AgencyOfferView = Object.freeze({ state: 'none', email: null, error: null, at: null });

/** The daemon's answer, or `null` when it is not one. */
export function parseAgencyOffer(raw: unknown): AgencyOfferView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== 'string' || !(STATES as readonly string[]).includes(r.state)) return null;
  return {
    state: r.state as AgencyOfferState,
    email: typeof r.email === 'string' ? r.email : null,
    error: typeof r.error === 'string' && (ERRORS as readonly string[]).includes(r.error) ? r.error as AgencyOfferError : null,
    at: typeof r.at === 'number' ? r.at : null,
  };
}

/** The status line's i18n key for a state. */
export function agencyOfferStatusKey(view: AgencyOfferView): string {
  switch (view.state) {
    case 'subscribed': return 'agencyOffer.status.subscribed';
    case 'pending': return 'agencyOffer.status.pending';
    case 'withdrawing': return 'agencyOffer.status.withdrawing';
    case 'rejected': return view.error === 'invalid' ? 'agencyOffer.status.invalid' : 'agencyOffer.status.refused';
    default: return 'agencyOffer.status.none';
  }
}

/** A plausible address, as the field checks it before the daemon does. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class AgencyOfferRequestError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`agency offer request failed (${status})`);
  }
}

async function failure(res: Response): Promise<AgencyOfferRequestError> {
  const body = await res.json().catch(() => ({})) as { error?: unknown };
  return new AgencyOfferRequestError(res.status, typeof body.error === 'string' ? body.error : null);
}

export async function loadUsageKind(fetcher: Fetcher = fetch): Promise<UsageKind | null> {
  const res = await fetcher(USAGE_KIND_PATH, { cache: 'no-store' });
  if (!res.ok) throw await failure(res);
  const body = await res.json() as { usageKind?: unknown };
  return isUsageKind(body.usageKind) ? body.usageKind : null;
}

export async function saveUsageKind(usageKind: UsageKind, fetcher: Fetcher = fetch): Promise<void> {
  const res = await fetcher(USAGE_KIND_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usageKind }),
  });
  if (!res.ok) throw await failure(res);
}

export async function loadAgencyOffer(fetcher: Fetcher = fetch): Promise<AgencyOfferView> {
  const res = await fetcher(AGENCY_OFFER_PATH, { cache: 'no-store' });
  if (!res.ok) throw await failure(res);
  return parseAgencyOffer(await res.json()) ?? NO_AGENCY_OFFER;
}

/** Asks for the offer; the daemon answers with the state it reached (sent, waiting, or refused). */
export async function subscribeAgencyOffer(email: string, locale: string, fetcher: Fetcher = fetch): Promise<AgencyOfferView> {
  const res = await fetcher(AGENCY_OFFER_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), locale }),
  });
  if (!res.ok) throw await failure(res);
  return parseAgencyOffer(await res.json()) ?? NO_AGENCY_OFFER;
}

export async function withdrawAgencyOffer(fetcher: Fetcher = fetch): Promise<AgencyOfferView> {
  const res = await fetcher(AGENCY_OFFER_PATH, { method: 'DELETE' });
  if (!res.ok) throw await failure(res);
  return parseAgencyOffer(await res.json()) ?? NO_AGENCY_OFFER;
}
