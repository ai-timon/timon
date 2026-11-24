'use client';

import { useEffect, useState } from 'react';
import { formatDateTime } from './intl';
import { sseOn } from './sse-stream';
import { apiErrorMessage } from '@/lib/api-error';

/**
 * Mirrors `publicState()` in `orchestrator/src/kernel/routes/license.ts`, field
 * for field. There is no local grace period any more: a token that no longer
 * verifies is `unlicensed` on the spot, and a late subscription stays `valid`
 * with `paymentStatus: 'past_due'` — a notice card, never a gate.
 */
export type PublicLicense = {
  localFree?: boolean;
  restrictedAccounts?: number;
  capabilities?: { version: 1; plugins: 'fixed' | 'extensible'; accounts: 'single-superadmin' | 'standard' } | null;
  users?: number | null;
  status: 'valid' | 'unlicensed';
  reason: string | null;
  edition: 'lite' | 'expert';
  /** Commercial plan name as the licence server worded it. `null` when there
   *  is nothing to name — this is what the licence page shows the user. */
  plan: string | null;
  /** Plan that never ends: no renewal to keep up with, no expiry to announce. */
  lifetime: boolean;
  /** Token expiry (15 min, refreshed by the client) — not a user-facing date. */
  expiresAt: string | null;
  /** End of the subscription, `null` when the plan never expires. */
  subscriptionExpiresAt: string | null;
  paymentStatus: 'active' | 'past_due';
  /** The licence server has been unreachable since this instant and the token
   *  is kept on the offline tolerance. `null` when everything is fine. Never
   *  shown: a passing outage is not the person's doing. */
  offlineSince: string | null;
  /** Paid rights really lost on a build that fell back to Free: the tolerance
   *  ran out (`offline`) or the server refused the licence (`refused`).
   *  `since` (last server contact) marks the episode. Older daemons do not say. */
  lapse?: { cause: 'offline' | 'refused'; since: string | null } | null;
  /** The build this daemon is (older daemons do not say). `expiresAt` is the
   *  end date of a build that stops running, `null` when it never does. */
  build?: { channel: 'beta' | 'stable' | 'dev'; expiresAt: string | null };
  /** The name this install gave the machine (PRD §5.10), `null` while it has
   *  none — or while it has one this daemon never learned, since the server
   *  hands the name back only to the call that wrote it. */
  machineName?: string | null;
  /** The machine already carries a name, whoever wrote it: naming is done and
   *  the page must not offer a field that could only fail. */
  machineNameLocked?: boolean;
};

/**
 * A bottom-left card the licence asks for (docs/NOTICES.md). `id` is the
 * card's key within its plugin: it changes with the episode, so a card the
 * account closed comes back only when the state changes.
 */
export type LicenseCard =
  | { kind: 'paused'; id: string }
  | { kind: 'refused'; id: string }
  | { kind: 'pastDue'; id: string; until: string | null }
  | { kind: 'ends'; id: string; at: string; urgent: boolean };

/**
 * What the licence has to say, as cards. Pure, so it can be tested.
 *
 * - Paid rights really lost (`lapse`): paused until the server answers, or
 *   refused for good. Only a daemon that fell back to Free says so.
 * - A licence in force: a late payment (quiet during the beta, as it always
 *   was) and its end, 14 days ahead, insisted on at 3.
 * - Nothing else. An unreachable server within the offline tolerance is not
 *   the person's doing; Free has nothing to warn about, whatever happened to
 *   the licence before it; a locked beta build gets its lock screen.
 */
export function licenseCards(license: PublicLicense | null, nowMs: number, { beta = false }: { beta?: boolean } = {}): LicenseCard[] {
  if (!license) return [];
  if (license.status !== 'valid') {
    const lapse = license.lapse;
    if (!lapse) return [];
    const parsed = lapse.since ? Date.parse(lapse.since) : Number.NaN;
    const episode = Number.isNaN(parsed) ? 'unknown' : String(Math.floor(parsed / 1000));
    return [lapse.cause === 'refused' ? { kind: 'refused', id: `license-refused-${episode}` } : { kind: 'paused', id: `license-paused-${episode}` }];
  }
  const cards: LicenseCard[] = [];
  if (license.paymentStatus === 'past_due' && !beta) {
    const until = license.subscriptionExpiresAt;
    cards.push({ kind: 'pastDue', id: `license-past-due-${until ? until.slice(0, 10) : 'open'}`, until });
  }
  for (const ending of expiryNotices(license, nowMs)) {
    if (ending.kind !== 'license') continue;
    cards.push({ kind: 'ends', id: `license-ends-${ending.at.slice(0, 10)}${ending.urgent ? '-urgent' : ''}`, at: ending.at, urgent: ending.urgent });
  }
  return cards;
}

/** Why a beta build is locked, as far as the person has to act on it. */
export type BetaLock = { kind: 'build_expired' | 'beta_ended' | 'other'; buildExpiresAt: string | null };

/**
 * A beta build that is not `valid` never falls back to Free: the daemon then
 * answers 403 on everything but the licence, so the app shows one screen
 * instead of the cockpit. `null` for every other build and for a valid licence.
 */
export function betaLock(license: PublicLicense | null): BetaLock | null {
  if (!license || license.build?.channel !== 'beta') return null;
  if (license.status !== 'unlicensed' || license.localFree === true) return null;
  const kind = license.reason === 'build_expired' || license.reason === 'beta_ended' ? license.reason : 'other';
  return { kind, buildExpiresAt: license.build.expiresAt };
}

/** Days ahead at which an end date starts to be announced, then insisted on. */
export const EXPIRY_WARN_DAYS = 14;
export const EXPIRY_URGENT_DAYS = 3;

export type ExpiryNotice = { kind: 'build' | 'license'; at: string; days: number; urgent: boolean };

const DAY_MS = 86_400_000;

function expiryIn(at: string | null | undefined, nowMs: number): number | null {
  if (!at) return null;
  const end = Date.parse(at);
  if (Number.isNaN(end) || end <= nowMs) return null;
  const days = Math.ceil((end - nowMs) / DAY_MS);
  return days <= EXPIRY_WARN_DAYS ? days : null;
}

/**
 * The end of the build and the end of the licence, announced 14 days ahead.
 * Nothing for a `dev` build (the repository, the sandbox), for a build that
 * never expires, for a lifetime plan, or once the date has passed — the locked
 * screen speaks then. Pure: `nowMs` comes from the caller.
 */
export function expiryNotices(license: PublicLicense | null, nowMs: number): ExpiryNotice[] {
  if (!license || license.status !== 'valid' || license.build?.channel === 'dev') return [];
  const notices: ExpiryNotice[] = [];
  const buildDays = expiryIn(license.build?.expiresAt, nowMs);
  if (buildDays !== null) notices.push({ kind: 'build', at: license.build!.expiresAt!, days: buildDays, urgent: buildDays <= EXPIRY_URGENT_DAYS });
  const licenseDays = license.lifetime ? null : expiryIn(license.subscriptionExpiresAt, nowMs);
  if (licenseDays !== null) notices.push({ kind: 'license', at: license.subscriptionExpiresAt!, days: licenseDays, urgent: licenseDays <= EXPIRY_URGENT_DAYS });
  return notices;
}

export function useLicense(): PublicLicense | null {
  const [license, setLicense] = useState<PublicLicense | null>(null);
  useEffect(() => {
    const load = () => {
      void fetch('/api/ui/license', { cache: 'no-store' })
        .then((r) => r.ok ? r.json() as Promise<PublicLicense> : null)
        .then(setLicense).catch(() => setLicense(null));
    };
    load();
    // The refresh loop publishes `license_changed` on the global stream: a
    // revocation or rights coming back reach the cards without a reload.
    return sseOn('license_changed', load);
  }, []);
  return license;
}

/** Body of a `PUT /api/license` (or `POST /api/license/activate`) refusal.
 *  `device` is only joined on `invalid:machine`; `message` only on an
 *  activation refusal the license server named. */
export type LicenseRejection = { error?: string; code?: string; params?: Record<string, string | number>; reason?: string; device?: string; message?: string; current?: { edition: string; plan: string | null }; next?: { edition: string; plan: string | null }; /** The licence server's own refusal, relayed by the daemon to a superadmin (`retry_at` on `transfer_pending`). */ body?: { retry_at?: number } };

/**
 * Tells apart the two things `/activate` accepts: a JWT (three dot-separated
 * base64url segments, installed locally by `PUT /api/license`) and a short
 * activation key (`TMN-XXXX-XXXX-XXXX-XXXX`, exchanged for a JWT by
 * `POST /api/license/activate`). A JWT never contains `-`; a key never
 * contains `.` — checking for a dot is enough to route correctly.
 */
export function isActivationKey(value: string): boolean {
  return !value.trim().includes('.');
}

/**
 * A token minted for another machine is the common paste mistake: name the
 * device this daemon expects, or the operator has nothing to act on — same
 * wording as `timon license install`. Takes the translator so the composed
 * message stays testable without a React tree.
 */
export function activationErrorMessage(
  body: LicenseRejection,
  translate: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const code = body.error;
  // The seat of a machine released with `deactivate` stays leased until its
  // last token expires (licence contract §5); the server says WHEN, and a
  // tester left waiting without that time reported the transfer as broken.
  if (code === 'transfer_pending' && typeof body.body?.retry_at === 'number') {
    return translate('freeLicense.transfer_pending_until', { until: formatDateTime(body.body.retry_at * 1000) });
  }
  if (code && ['plugin_composition_fixed', 'single_superadmin_required', 'free_incompatible', 'license_changed', 'activation_key_missing', 'local_free', 'transfer_pending', 'client_upgrade_required'].includes(code)) {
    return translate(`freeLicense.${code}`);
  }
  const base = apiErrorMessage(body, translate('activate.rejected'));
  const reason = body.reason ? ` (${body.reason})` : '';
  const message = body.message ? ` — ${body.message}` : '';
  const device = body.device ? ` — ${translate('activate.deviceMismatch', { device: body.device })}` : '';
  return `${base}${reason}${message}${device}`;
}

/** What entering a key or a token came to. `refused` carries the daemon's
 *  body, for `activationErrorMessage`. */
export type LicenseSubmitResult =
  | { status: 'installed'; edition: string }
  | { status: 'cancelled' }
  | { status: 'refused'; body: LicenseRejection };

/**
 * Sends what the person pasted to the right route — a short key to
 * `/activate`, a JWT to `PUT /api/license` — and, when the daemon refuses a
 * silent downgrade (SECU-LICENCES L-3), asks `confirmDowngrade` before sending
 * it again with `force`. Shared by the licence page and the profile, so the
 * two cannot drift apart on the downgrade rule.
 */
export async function submitLicense(
  value: string,
  confirmDowngrade: (refusal: LicenseRejection) => Promise<boolean>,
): Promise<LicenseSubmitResult> {
  const trimmed = value.trim();
  const send = (force: boolean) => isActivationKey(trimmed)
    ? fetch('/api/ui/license/activate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: trimmed, force }),
    })
    : fetch('/api/ui/license', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: trimmed, force }),
    });
  let response = await send(false);
  let body = await response.json() as LicenseRejection & { edition?: string };
  if (response.status === 409 && body.error === 'downgrade') {
    if (!(await confirmDowngrade(body))) return { status: 'cancelled' };
    response = await send(true);
    body = await response.json() as LicenseRejection & { edition?: string };
  }
  return response.ok ? { status: 'installed', edition: body.edition ?? '' } : { status: 'refused', body };
}

/**
 * What the profile says about the licence, in three cases: Free (no key, the
 * default since the product opened), a paid plan, or neither (a key that
 * stopped verifying on a build that does not fall back to Free). Pure.
 */
export type LicenseSummary =
  | { tier: 'free' }
  | { tier: 'paid'; plan: string | null; expiresAt: string | null; pastDue: boolean }
  | { tier: 'none'; reason: string | null };

export function licenseSummary(license: PublicLicense): LicenseSummary {
  if (license.localFree === true) return { tier: 'free' };
  if (license.status === 'valid') {
    return {
      tier: 'paid',
      plan: license.plan,
      // A lifetime plan has no end; `expiresAt` is the 15-minute token, never shown.
      expiresAt: license.lifetime ? null : license.subscriptionExpiresAt,
      pastDue: license.paymentStatus === 'past_due',
    };
  }
  return { tier: 'none', reason: license.reason };
}
