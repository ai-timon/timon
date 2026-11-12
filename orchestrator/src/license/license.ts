import { createHash, verify as verifyCrypto } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { LICENSE_FILE } from '../paths.js';
import { CommercialCapabilitiesSchema, type CommercialCapabilities } from './capabilities.js';
import { deviceId } from './device.js';
import { fingerprint } from './fingerprint.js';
import { activeKeyring, type LicensePublicKey } from './pubkey.js';
import { fileClockAnchor, readLicenseStore, writeLicenseStore, type ClockAnchor } from './store.js';

/**
 * Short-lived token issued by the license server (contract: `timon-site`
 * `docs/PRD-S0.md` §5.5, fixture `fixtures/token-claims.json`, vendored here
 * as `fixtures/token-claims.json`).
 *
 * Every claim of the frozen contract is required — the server emits them all,
 * so a token missing one did not come from that server. Only `sub_exp` may be
 * `null` (a plan that never expires), and it is still a required key: absent,
 * we could not tell "never expires" from "the server forgot the end of the
 * subscription". Unknown claims are stripped rather than rejected, so the
 * server can add one without bricking deployed daemons.
 *
 * `plan_name`, `fph` and `users` are the three OPTIONAL claims, and
 * deliberately so: all were added after the contract was frozen (the maintainer's
 * approvals, 03/09, 04/09 and 05/09/2026) and tokens issued before them lack
 * them. Absent `plan_name`, the plan id is what we show. Absent `fph`, the
 * device binding rests on `did` alone; present, it must match this machine
 * (SECU-LICENCES L-2). Absent `users`, no quota restricts account creation.
 */
const MODULE_ID = /^@timon\/[a-z0-9][a-z0-9-]*$/;
const ClaimsSchema = z.object({
  sub: z.string().min(1),
  lic: z.string().min(1),
  did: z.string().min(1),
  plan: z.string().min(1),
  edition: z.enum(['lite', 'expert']),
  // Shape only, never catalog membership: a newer server may sell a module
  // this daemon does not know yet, and rejecting the token would lock out a
  // customer whose licence is perfectly valid.
  modules: z.union([z.literal('*'), z.array(z.string().regex(MODULE_ID))]),
  // Plugin ids are third-party npm names, not `@timon/*`.
  plugins: z.union([z.literal('*'), z.array(z.string().min(1))]),
  features: z.array(z.string()),
  // `null` = unlimited machines (v4). Still a REQUIRED key: the server always
  // sends it, and a token without it did not come from that server.
  seats: z.number().int().nullable(),
  iat: z.number().int(),
  nbf: z.number().int(),
  exp: z.number().int(),
  srv: z.number().int(),
  jti: z.string().min(1),
  sub_exp: z.number().int().nullable(),
  status: z.enum(['active', 'past_due']),
  /** Human label of the plan ("Developer"), when the server sends one. */
  plan_name: z.string().min(1).optional(),
  /** SHA-256 (hex) of the `fp` the activation was bound to. The daemon
   *  recomputes its own and refuses a token minted for another machine —
   *  what makes a copied `~/.timon` inert without a network round-trip. */
  fph: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Distinct app user profiles allowed on THIS machine, `null` for unlimited.
   *  OPTIONAL like `plan_name` and `fph`: added in v4, after the contract was
   *  frozen, so tokens issued before it lack the claim — and its absence must
   *  restrict nothing. Only the daemon can count local profiles, which is why
   *  the server signs the number and we are the ones enforcing it. */
  // Zero is not "unlimited" (that is `null`): it would refuse every profile,
  // the first superadmin's included, so it is a malformed token.
  users: z.number().int().min(1).nullable().optional(),
  capabilities: CommercialCapabilitiesSchema.optional(),
}).superRefine((claims, ctx) => {
  if (claims.plan !== 'free' && claims.capabilities?.accounts !== 'single-superadmin') return;
  // Free grants every module and plugin (the maintainer's decision, 03/11/2026): only
  // the account axis is constrained, so the composition claims stay free-form.
  if (!claims.capabilities || claims.capabilities.accounts !== 'single-superadmin'
      || claims.users !== 1 || claims.seats !== 1 || !claims.fph) {
    ctx.addIssue({ code: 'custom', message: 'Free requires explicit capabilities, one machine and one superadmin.' });
  }
  if (claims.exp - claims.iat !== 900 || claims.iat - claims.nbf !== 60) {
    ctx.addIssue({ code: 'custom', message: 'Free requires a 900-second token lifetime and a 60-second not-before offset.' });
  }
  // Contract v5: Free is never billed, so the server only ever mints it
  // `active` and without an end of subscription. A Free token carrying
  // `past_due` or a dated `sub_exp` was not issued by that server — unlike a
  // paid one, where `past_due` is a banner and `sub_exp` a real date.
  if (claims.status !== 'active' || claims.sub_exp !== null) {
    ctx.addIssue({ code: 'custom', message: 'Free is issued active and without a subscription end.' });
  }
});
/** `{ alg: "EdDSA", typ: "JWT", kid }`. Unknown fields ignored: the pinned
 *  `kid` and `alg` are what verification rests on, an extra field changes
 *  nothing and must not brick a daemon. */
const HeaderSchema = z.object({
  alg: z.literal('EdDSA'),
  typ: z.literal('JWT'),
  kid: z.string().min(1),
});
export type LicenseClaims = z.infer<typeof ClaimsSchema>;

export type LicenseStatus = 'valid' | 'unlicensed';
/** `past_due` is a valid license whose subscription is late: banner, not gate. */
export type PaymentStatus = 'active' | 'past_due';
export type LicenseReason =
  | 'missing' | 'invalid:format' | 'invalid:key' | 'invalid:signature'
  | 'invalid:clock'
  /** `srv` older than one already accepted, or a local clock behind the last
   *  instant seen: a wound-back clock, not a drift (L-5). */
  | 'invalid:clock:rollback'
  | 'invalid:machine'
  /** `fph` present and not this machine's: the token was minted for another
   *  installation and copied here (L-2). */
  | 'invalid:fingerprint'
  | 'expired'
  /** The server said so on `renew` (L-1): no token expiry to wait for. */
  | 'revoked' | 'deactivated'
  /** Beta builds only (`build-policy.ts`). The build's own end date passed —
   *  whatever the licence says, online or not. */
  | 'build_expired'
  /** Beta builds only. The licence expired, was revoked or was deactivated:
   *  during the beta Free does not exist, so nothing takes its place. */
  | 'beta_ended'
  | null;
export type LicenseState = {
  /** Local product rights, independent of any token or server. */
  localFree?: boolean;
  capabilities?: CommercialCapabilities;
  status: LicenseStatus;
  reason: LicenseReason;
  edition: 'lite' | 'expert';
  /** Commercial plan name as the licence server worded it (`plan_name`, or
   *  the `plan` id when it sent none). The local baseline is named Free. */
  plan: string | null;
  /** Stable signed plan id, independent of the display label. */
  planId?: string;
  /** Signed identity of the licence itself (`lic`), what tells one licence
   *  from another across two tokens. Internal: it never reaches `publicState`,
   *  it exists so an install can ask "same licence, or another one?" — the
   *  question `POST …/activate` answers with the activation key it holds. */
  licenseId?: string;
  /** Plan that never ends (`sub_exp: null`). Its TOKEN still expires and is
   *  renewed like any other — "lifetime" is about the subscription, never
   *  about the bearer (SECU-LICENCES L-2). */
  lifetime: boolean;
  modules: readonly string[] | '*';
  plugins: readonly string[] | '*';
  /** Signed feature entitlements (`features` claim), exact strings, never a
   *  wildcard. Optional because a state built before the daemon read the claim
   *  (a test helper, a remote snapshot) has none: absent means no feature,
   *  which is the safe reading. Internal: `publicState` never hands it out. */
  features?: readonly string[];
  /** How many app user profiles this machine may hold (`users` claim), `null`
   *  for unlimited on paid legacy claims. Free allows one superadmin; surplus
   *  accounts keep their rows but lose access until paid rights return. */
  users: number | null;
  /** Token expiry — 15 minutes, refreshed by the client. Not a user-facing date. */
  expiresAt: string | null;
  /** End of the subscription (`sub_exp`), `null` when the plan never expires. */
  subscriptionExpiresAt: string | null;
  paymentStatus: PaymentStatus;
  /** Set while the licence server has been unreachable and the token is kept
   *  on the offline tolerance (L-7). ISO of the last successful contact. */
  offlineSince: string | null;
};

/** Clock skew tolerated on `nbf`/`iat`/`exp` — same 60 s the server applies. */
const CLOCK_SKEW_SECONDS = 60;
/**
 * `srv` is the issuing server's clock. It measures a DRIFT, never an age
 * (SECU-LICENCES L-6): compared to the local clock only when the token has
 * just arrived from the server (`fresh`), where a gap wider than this means a
 * grossly unset clock. Re-read from disk, a token is as old as it is — `exp`
 * judges that — and `srv` is only checked against `iat`, both server values
 * that must agree. Deliberately generous: a threshold tighter than the TTL
 * would be a new lockout vector for no gain.
 */
const SERVER_CLOCK_DRIFT_SECONDS = 60 * 60;

export const unlicensed = (reason: LicenseReason): LicenseState => ({
  status: 'unlicensed', reason, edition: 'expert', plan: 'Free', planId: 'free', lifetime: true,
  // Every module and every plugin: Free withholds only additional accounts,
  // the axis kept for paid offers (the maintainer's decision, 03/11/2026).
  localFree: true, modules: '*', plugins: '*', features: [], users: 1,
  capabilities: { version: 1, plugins: 'extensible', accounts: 'single-superadmin' },
  expiresAt: null, subscriptionExpiresAt: null, paymentStatus: 'active', offlineSince: null,
});

export type VerifyOptions = {
  keys?: readonly LicensePublicKey[];
  now?: Date;
  device?: string;
  /** This machine's `fingerprint()`; computed when omitted and `fph` is present. */
  fingerprint?: string;
  /** The token was just received from the server: `srv` is compared to the
   *  local clock. Off (a re-read from disk), it is compared to `iat`. */
  fresh?: boolean;
  /** Clock anchors (L-5). None by default: the pure verification is what the
   *  file-based entry points build on, and they supply the production anchor. */
  anchor?: ClockAnchor;
  /** Offline tolerance (L-7), Unix seconds: an expired token is still accepted
   *  until this instant. Set by the boot from the last successful server
   *  contact plus the plan's `offlineHours`. */
  graceUntil?: number;
  /** Internal restriction receipt verification, never used to grant rights. */
  restrictionOnly?: boolean;
};

/**
 * Rights the verifier granted against the PINNED keyring, most recent last.
 * Outside the test runner, `setLicenseState` admits a valid state only if its
 * rights are one of these (`runtime.ts`): code sharing the daemon's process —
 * a third-party plugin importing the build — can neither hand it a state it
 * built itself nor one checked against keys it brought (`opts.keys`).
 *
 * Keyed by content, not by object identity: the daemon legitimately copies a
 * state (`licenseState()`) and marks it offline (`offlineSince`) before setting
 * it again. Only what grants rights is compared; `offlineSince`, `localFree`
 * and `reason` are rewritten by the runtime itself. A few entries, not one: a
 * dry-run verification (a downgrade the route then refuses) must not evict the
 * state actually in force.
 */
const verifiedRights: string[] = [];
const VERIFIED_RIGHTS_KEPT = 8;

function rightsOf(state: LicenseState): string {
  const caps = state.capabilities;
  return JSON.stringify([
    state.status, state.edition, state.plan, state.planId ?? null, state.licenseId ?? null,
    state.lifetime, state.modules, state.plugins, [...(state.features ?? [])].sort(), state.users,
    caps ? [caps.version, caps.plugins, caps.accounts] : null,
    state.expiresAt, state.subscriptionExpiresAt, state.paymentStatus,
  ]);
}

function rememberVerified(state: LicenseState): void {
  const rights = rightsOf(state);
  const known = verifiedRights.indexOf(rights);
  if (known !== -1) verifiedRights.splice(known, 1);
  verifiedRights.push(rights);
  if (verifiedRights.length > VERIFIED_RIGHTS_KEPT) verifiedRights.shift();
}

/** Did the verifier grant exactly these rights, against the pinned keyring? */
export function isVerifiedLicense(state: LicenseState): boolean {
  return verifiedRights.includes(rightsOf(state));
}

/**
 * Called by the runtime when a licence goes off (revoked, expired,
 * deactivated): a copy of the state that was in force must not be able to
 * bring it back.
 */
export function forgetVerifiedLicenses(): void {
  verifiedRights.length = 0;
}

/** Hex SHA-256 of a fingerprint — the `fph` claim the server derives from `fp`. */
export function fingerprintHash(fp: string): string {
  return createHash('sha256').update(fp).digest('hex');
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function verifyLicenseToken(token: string, opts: VerifyOptions = {}): LicenseState {
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const parts = token.trim().split('.');
  if (parts.length !== 3) return unlicensed('invalid:format');
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  let header: z.infer<typeof HeaderSchema>;
  let claims: LicenseClaims;
  try {
    header = HeaderSchema.parse(JSON.parse(decodeBase64Url(encodedHeader).toString('utf8')) as unknown);
    claims = ClaimsSchema.parse(JSON.parse(decodeBase64Url(encodedClaims).toString('utf8')) as unknown);
  } catch { return unlicensed('invalid:format'); }
  const key = (opts.keys ?? activeKeyring()).find((candidate) => candidate.keyId === header.kid);
  if (!key) return unlicensed('invalid:key');
  if (key.expiresAt && Date.parse(key.expiresAt) <= now * 1000) return unlicensed('invalid:key');
  try {
    const valid = verifyCrypto(null, Buffer.from(`${encodedHeader}.${encodedClaims}`), key.publicKey, decodeBase64Url(encodedSignature));
    if (!valid) return unlicensed('invalid:signature');
  } catch { return unlicensed('invalid:signature'); }
  if (claims.iat - CLOCK_SKEW_SECONDS > now) return unlicensed('invalid:clock');
  if (claims.nbf - CLOCK_SKEW_SECONDS > now) return unlicensed('invalid:clock');
  if (opts.fresh) {
    if (Math.abs(claims.srv - now) > SERVER_CLOCK_DRIFT_SECONDS) return unlicensed('invalid:clock');
  } else if (Math.abs(claims.srv - claims.iat) > CLOCK_SKEW_SECONDS) {
    return unlicensed('invalid:clock');
  }
  if (opts.anchor?.check(claims.srv, now) === 'rollback') return unlicensed('invalid:clock:rollback');
  // `exp` is a deadline for EVERY token, lifetime plans included (L-2). A plan
  // that never ends (`sub_exp: null`) is still renewed every `refresh.every`
  // seconds by the loop in `refresh.ts`; what "lifetime" buys is the absence
  // of a subscription end, not a token that outlives its revocation. No local
  // grace period either: since PRD 03, revocation is "no renewal + token
  // expiry" (≤ 15 min). Offline tolerance is the caller's `graceUntil`, fed
  // from the last successful server contact — never a constant here.
  const lifetime = claims.sub_exp === null;
  if (!opts.restrictionOnly && now > claims.exp + CLOCK_SKEW_SECONDS && !(claims.capabilities?.plugins !== 'fixed' && opts.graceUntil !== undefined && now <= opts.graceUntil)) {
    return unlicensed('expired');
  }
  // Device binding is not optional: a token is issued FOR one machine. Without
  // this check, a token copied from one installation to another would run on
  // both. The id is the daemon's own (`deviceId()`), the same value activate /
  // renew send to the server — a divergence here means the token was issued
  // for another device, or the local id was lost.
  let device: string;
  try { device = opts.device ?? deviceId(); }
  catch { return unlicensed('invalid:machine'); }
  if (claims.did !== device) return unlicensed('invalid:machine');
  // `did` is a file the user controls; `fph` is derived from the OS machine id
  // and is what a `cp -r ~/.timon` cannot carry (L-2). Only checked when the
  // server emitted it — tokens from before the amendment have none.
  if (claims.fph !== undefined) {
    let fp: string;
    try { fp = opts.fingerprint ?? fingerprint(); }
    catch { return unlicensed('invalid:fingerprint'); }
    if (fingerprintHash(fp) !== claims.fph) return unlicensed('invalid:fingerprint');
  }
  opts.anchor?.commit(claims.srv, now);
  const state: LicenseState = {
    status: 'valid', reason: null, edition: claims.edition,
    // The label the server worded, and the id it bills on when it sent none.
    plan: claims.plan_name ?? claims.plan,
    planId: claims.plan,
    licenseId: claims.lic,
    lifetime,
    // No legacy id translation: the licence server went live on the `@timon/`
    // scope, the schema accepts nothing else, and a mapping that can never fire
    // is a mapping nobody maintains.
    modules: claims.modules,
    plugins: claims.plugins,
    features: [...claims.features],
    users: claims.users ?? null,
    ...(claims.capabilities ? { capabilities: claims.capabilities } : {}),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    subscriptionExpiresAt: claims.sub_exp == null ? null : new Date(claims.sub_exp * 1000).toISOString(),
    paymentStatus: claims.status,
    offlineSince: null,
  };
  // Keys the caller brought prove nothing to the runtime; nor does a check
  // that skipped the expiry (`restrictionOnly` reads old receipts, never grants).
  if (opts.keys === undefined && !opts.restrictionOnly) rememberVerified(state);
  return state;
}

/** The production clock anchor unless the caller brought one (tests). */
const withAnchor = (opts: VerifyOptions): VerifyOptions => ({ anchor: fileClockAnchor(), ...opts });

export function readLicense(file = LICENSE_FILE, opts: VerifyOptions = {}): LicenseState {
  const state = readLicenseFile(file, opts);
  if (file !== LICENSE_FILE) return state;
  if (state.status === 'valid') return state.planId === 'free' ? unlicensed('missing') : state;
  // Old Free credentials are historical records only. Even an expired receipt
  // needs no renewal: the same fixed rights are now part of the local product.
  try {
    const old = verifyLicenseToken(readFileSync(file, 'utf8'), { ...opts, fresh: false, anchor: undefined, restrictionOnly: true });
    if (old.status === 'valid' && old.planId === 'free') return unlicensed('missing');
  } catch { /* Missing credentials are the normal Free installation. */ }
  return state;
}

function readLicenseFile(file: string, opts: VerifyOptions): LicenseState {
  const keyring = opts.keys ?? activeKeyring();
  if (!existsSync(file)) return unlicensed('missing');
  if (keyring.length === 0) return unlicensed('invalid:key');
  try {
    const token = readFileSync(file, 'utf8');
    const refusal = file === LICENSE_FILE ? readLicenseStore().refusedToken : undefined;
    if (refusal?.digest === createHash('sha256').update(token.trim()).digest('hex')) return unlicensed(refusal.reason);
    return verifyLicenseToken(token, withAnchor(opts));
  }
  catch { return unlicensed('invalid:format'); }
}

export function effectiveEdition(configured: 'lite' | 'expert', licensed: 'lite' | 'expert'): 'lite' | 'expert' {
  return configured === 'lite' || licensed === 'lite' ? 'lite' : 'expert';
}

export function allowed(value: readonly string[] | '*'): readonly string[] {
  return value === '*' ? ['*'] : value;
}

export function covers(value: readonly string[] | '*', id: string): boolean {
  return value === '*' || value.includes(id);
}

/**
 * Verifies then writes. `dryRun` verifies only (the routes use it to refuse a
 * downgrade before touching the file); the anchor is then NOT committed, so a
 * refused token leaves no trace.
 */
export function installLicenseToken(
  token: string,
  file = LICENSE_FILE,
  opts: VerifyOptions & { dryRun?: boolean } = {},
): LicenseState {
  const { dryRun, ...verifyOpts } = opts;
  const anchor = fileClockAnchor();
  const state = verifyLicenseToken(token, dryRun
    ? { anchor: { check: anchor.check, commit: () => undefined }, ...verifyOpts }
    : withAnchor(verifyOpts));
  if (state.status === 'unlicensed' || dryRun) return state;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, token.trim() + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  if (file === LICENSE_FILE) writeLicenseStore({ restrictionToken: state.capabilities?.plugins === 'fixed' ? token.trim() : null });
  return state;
}
