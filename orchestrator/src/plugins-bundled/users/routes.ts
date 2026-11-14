/**
 * Auth routes (Phase M.1): setup, login, the person's own account and
 * preferences, and the operator's account recovery. Administering accounts
 * belongs to the plugin that serves them (`ctx.accountProvider`).
 */
import { writeAppearance } from '../../appearance.js';
import type { Router, Request, RequestHandler, Response } from 'express';
import { freeAccountAllowed, FREE_ACCOUNT_RESTRICTED_MESSAGE } from '../../users/free-access.js';
import { config } from '../../config/load.js';
import { setupPolicy, type SetupPolicy } from '../../users/setup-policy.js';
import { consumeSetupToken, readOrCreateSetupToken, setupListenerExposed, verifySetupToken } from '../../users/setup-token.js';
import { activate, LicenseServerError, type ClientOptions } from '../../license/client.js';
import { installLicenseToken } from '../../license/license.js';
import { writeLicenseKey, recordServerContact } from '../../license/refresh.js';
import { licenseState, setLicenseState } from '../../license/runtime.js';
import { applyLicensedSurfaces } from '../../kernel/routes/license.js';
import {
  dbApi,
  DuplicateEmailError,
  isColorScheme,
  type UserPrefs,
} from '../../db.js';
import {
  checkThrottle,
  clearThrottle,
} from '../../users/login-throttle.js';
import { auditRequest } from '../../users/audit-actor.js';
import {
  throttleKeys,
  sendThrottled,
  noteAuthFailure,
  testCredential,
} from '../../users/throttle-http.js';
import { createNotification } from '../../notifications.js';
import { readAvatar, saveAvatar } from '../../uploads.js';
import { generateTemporaryPassword, hashPassword, needsRehash, verifyAccountPassword, verifyPassword } from '../../users/password.js';
import { galleryPlugins, loaderFromApp } from '../../plugins/runtime.js';
import {
  forbidden,
  requireAuth,
  requestHasPermission,
  toPublicUser,
  viewerFromRequest,
  type PublicUser,
} from '../../users/identity.js';
import { assertLicenseCompatible } from '../../license/compliance.js';
import { LicenseCapabilityError } from '../../license/capabilities.js';
import { resolveChromeChoice } from '../../users/surfaces.js';
import { MODEL_FAVORITES_MAX, ModelFavoritesBodySchema } from '../../users/model-favorites.js';
import { onboardingStep } from '../../onboarding-events.js';
import { PLAN_PRESET_NAME_MAX, PLAN_PRESETS_MAX, PlanPresetsBodySchema } from '../../users/plan-presets.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  hashSessionToken,
  issueInviteToken,
  readCookie,
} from '../../users/session.js';
import { cookieOpts, cookieSecure, setSession } from '../../users/session-open.js';
import { accountProviderHolder } from '../../users/account-provider-state.js';
import { apiError } from '../../api-error.js';
import type { EmailCodeStore } from '../../users/email-code.js';
import type { MailRelayOptions } from '../../users/mail-relay.js';
import {
  checkSetupEmailCode,
  confirmSetupEmail,
  defaultEmailCodeDeps,
  registerEmailCodeRoutes,
} from './email-code-routes.js';

const MIN_PASSWORD = 8;
let setupInProgress = false;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Confirmation window for an email change. Shorter than an invitation: the
 *  account already exists and its owner is at their keyboard. */
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
/** The only origin an avatar may be served from — see `PATCH /api/auth/profile`. */
const AVATAR_URL_PREFIX = '/api/uploads/avatars/';

type AuthBody = {
  licenseKey?: unknown;
  licenseMode?: unknown;
  email?: unknown;
  name?: unknown;
  password?: unknown;
  is_superadmin?: unknown;
  status?: unknown;
  token?: unknown;
  /** The scheme the onboarding showed, so the account keeps it (#132). */
  scheme?: unknown;
  /** One-time proof of presence an exposed install asks for (TODO #327). */
  setupToken?: unknown;
  /** The emailed code that confirms the address (`docs/EMAIL-CODES.md`). */
  challengeId?: unknown;
  code?: unknown;
};

function parseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

function parseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

function parsePassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.length >= MIN_PASSWORD ? raw : null;
}

function audit(req: Request, action: string, target: string | null): void {
  auditRequest(req, action, target);
}

/**
 * `null` clears the picture, a string must point at our own uploads route.
 * `undefined` means the value is unusable — the caller answers 400.
 */
function parseAvatarUrl(raw: unknown): string | null | undefined {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value.startsWith(AVATAR_URL_PREFIX)) return undefined;
  // No traversal back out of the uploads namespace: the serving route guards
  // the filesystem, this guards what we agree to store.
  if (value.includes('..')) return undefined;
  return value;
}

/**
 * One notification per active superadmin. `ownerUserId` is what scopes a row
 * to a person; a single unowned notification would be an announcement to the
 * whole instance, which is not what an identity move deserves.
 */
function notifySuperadmins(title: string, body: string): void {
  for (const admin of dbApi.listUsers()) {
    if (!admin.is_superadmin || admin.status !== 'active') continue;
    createNotification({ type: 'alert', title, body, ownerUserId: admin.id });
  }
}

/**
 * The permissions the UI greys a control on, answered for the caller. A closed
 * list, evaluated by the same `requestHasPermission` the routes refuse with:
 * the UI must not grow its own reading of the grants, and the account's whole
 * grant list is not what a button needs. The route keeps refusing either way;
 * this only spares a click on a button that can only answer 403 (TODO #560).
 * `agents:manage` greys every skill attachment write, the agent scope included;
 * `agents:privileged-config` greys the global / project / role ones on top
 * (skill-attachment-routes.ts, TODO #620, #693).
 * `providers:manage` / `providers:accounts` give the level of the Providers
 * screen (`users/provider-access.ts`): which of it the app paints at all.
 */
export const ME_CAN_PERMISSIONS = [
  'projects:manage', 'agents:manage', 'agents:privileged-config', 'providers:manage', 'providers:accounts',
] as const;
export type MeCan = Record<(typeof ME_CAN_PERMISSIONS)[number], boolean>;

function meCan(req: Request): MeCan {
  const can = {} as MeCan;
  for (const permission of ME_CAN_PERMISSIONS) can[permission] = requestHasPermission(req, permission);
  return can;
}

/**
 * The upgrade welcome (docs/ONBOARDING.md, `Upgrade welcome`), as the app reads
 * it: `returning` to a signed-out browser while an account made before the new
 * onboarding has not signed in again (the login hands over to the onboarding's
 * welcome), `mascot` to such an account once signed in (its main agent's
 * mascot is offered), `null` otherwise.
 */
export type MeWelcome = 'returning' | 'mascot' | null;

function meWelcome(userId: string | null): MeWelcome {
  if (userId) return dbApi.userWelcomeStage(userId) === 'mascot' ? 'mascot' : null;
  return dbApi.anyUserAwaitingWelcomeSignin() ? 'returning' : null;
}

function mePayload(req: Request, signedOut = false): {
  user: PublicUser | null;
  needsSetup: boolean;
  setupRequiresToken: boolean;
  prefs: UserPrefs;
  can: MeCan;
  welcome: MeWelcome;
} {
  const needsSetup = dbApi.countUsers() === 0;
  const user = signedOut ? null : req.auth?.user ?? null;
  const can = signedOut
    ? Object.fromEntries(ME_CAN_PERMISSIONS.map((permission) => [permission, false])) as MeCan
    : meCan(req);
  return {
    user: user ? toPublicUser(user) : null,
    needsSetup,
    setupRequiresToken: needsSetup && setupListenerExposed(config()),
    prefs: dbApi.userPrefsGet(user?.id),
    can,
    welcome: meWelcome(user?.id ?? null),
  };
}

/**
 * First `/api/auth/me` of a browser session whose account still has to sign in
 * again (`welcome_stage = 'signin'`): every session of that account goes, once,
 * so the person meets the new onboarding's sign-in. Only a browser session —
 * a paired device, the CLI's daemon token and an agent's api token are left
 * alone. The stage moves on at the next successful login, not here.
 */
function endPreWelcomeSession(req: Request, res: Response): boolean {
  const user = req.auth?.kind === 'session' ? req.auth.user : null;
  if (!user || dbApi.userWelcomeStage(user.id) !== 'signin') return false;
  dbApi.deleteSessionsForUser(user.id);
  res.setHeader('Set-Cookie', clearSessionCookie({ secure: cookieSecure() }));
  return true;
}

export type UserRoutesOptions = {
  setupPolicy?: SetupPolicy;
  /**
   * The first account is created only once its email is confirmed by a
   * mailed code (`docs/EMAIL-CODES.md`). Off unless asked: the many tests that
   * bootstrap an account through `/api/auth/setup` are not about email. The
   * bundled plugin passes `BUNDLED_USER_ROUTES` (on), and a test holds it on.
   */
  emailVerification?: boolean;
  emailCodes?: EmailCodeStore;
  mailRelay?: MailRelayOptions;
};

/** What the bundled `@timon/users` plugin mounts the routes with. */
export const BUNDLED_USER_ROUTES: UserRoutesOptions = Object.freeze({
  emailVerification: true,
});

/**
 * The machine's operator only: the CLI's daemon token, never a browser session,
 * a mission token or a device. Anyone else reads 404, as for a route that does
 * not exist.
 */
export const operatorOnly: RequestHandler = (req, res, next) => {
  if (req.auth?.kind === 'daemon-token') { next(); return; }
  res.status(404).json(apiError('not_found', 'not found'));
};

/** Tests exercise both release policies explicitly. The bundled plugin always
 * uses the shipped policy; neither config nor request data can override admission. */
export function registerRoutes(app: Router, options: UserRoutesOptions = {}): void {
  const requiresLicense = (options.setupPolicy ?? setupPolicy()) === 'beta';
  const emailVerification = options.emailVerification === true;
  const emailDeps = defaultEmailCodeDeps({ store: options.emailCodes, relay: options.mailRelay });
  app.get('/api/auth/me', (req, res) => {
    const me = mePayload(req, endPreWelcomeSession(req, res));
    res.json({ ...me, setupRequiresLicense: requiresLicense, setupRequiresEmailCode: me.needsSetup && emailVerification });
  });
  registerEmailCodeRoutes(app, emailDeps);

  /**
   * Which plugin serves the accounts beyond the first superadmin, if any. Public:
   * the invitation page has no session yet and must know whose routes to call,
   * rather than trust a plugin id written in the link it was sent.
   */
  app.get('/api/auth/account-provider', (_req, res) => {
    res.json({ provider: accountProviderHolder() });
  });

  /**
   * Chrome preferences (T.2 scheme, T.7 theme / layout). Identity is
   * `req.auth.user.id`; there is no `?user=` query. Partial merge: each
   * present key is validated on its own. A daemon-token with no attached
   * account has nothing to hang a row on: GET already returned the
   * defaults, PUT is 403.
   *
   * Unknown / inactive / wrong-kind / ungranted theme or layout is 404,
   * not 403 — M.4 must not confirm a hidden third-party package exists.
   */
  app.put('/api/prefs', (req, res) => {
    const userId = req.auth?.user?.id;
    if (!userId) {
      forbidden(req, res, { kind: 'account_required' });
      return;
    }
    const body = (req.body ?? {}) as { theme?: unknown; layout?: unknown; scheme?: unknown };
    const patch: Partial<UserPrefs> = {};
    if (body.scheme !== undefined) {
      if (!isColorScheme(body.scheme)) {
        res.status(400).json({ error: 'scheme must be light or dark' });
        return;
      }
      patch.scheme = body.scheme;
    }
    const plugins = galleryPlugins(loaderFromApp(req.app));
    const viewer = viewerFromRequest(req);
    if (body.theme !== undefined) {
      const chosen = resolveChromeChoice(plugins, viewer, body.theme, 'theme');
      if (!chosen) {
        res.status(404).json(apiError('not_found', 'not found'));
        return;
      }
      patch.theme = chosen.id;
    }
    if (body.layout !== undefined) {
      const chosen = resolveChromeChoice(plugins, viewer, body.layout, 'layout');
      if (!chosen) {
        res.status(404).json(apiError('not_found', 'not found'));
        return;
      }
      patch.layout = chosen.id;
    }
    if (patch.theme === undefined && patch.layout === undefined && patch.scheme === undefined) {
      res.status(400).json({ error: 'theme, layout or scheme required' });
      return;
    }
    const prefs = dbApi.userPrefsSet(userId, patch);
    if (patch.scheme !== undefined) writeAppearance(patch.scheme);
    res.json({ prefs });
  });

  /**
   * The caller's favourite models (ModelPicker, `docs/MODEL-PICKER.md`).
   * Explicit authentication (`requireAuth`): anonymous is 401. The identity is
   * `req.auth.user`, never a parameter — nobody reads or writes another
   * account's stars. A daemon-token with no account has none: GET is `[]`,
   * PUT is 403, like `/api/prefs`.
   */
  app.get('/api/prefs/model-favorites', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json({ favorites: dbApi.userModelFavoritesGet(auth.user?.id) });
  });

  /** Replaces the whole ordered list: `{ favorites: [{ backend, model }] }`, at most 200, zod-strict. */
  app.put('/api/prefs/model-favorites', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const userId = auth.user?.id;
    if (!userId) {
      forbidden(req, res, { kind: 'account_required' });
      return;
    }
    const parsed = ModelFavoritesBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: `favorites must be at most ${MODEL_FAVORITES_MAX} { backend, model } pairs` });
      return;
    }
    res.json({ favorites: dbApi.userModelFavoritesSet(userId, parsed.data.favorites) });
  });

  /**
   * The caller's model presets for the series planner (`kanban_plan`,
   * `docs/MODEL-PICKER.md` § Presets). Same authentication as the favourites:
   * `requireAuth`, identity from `req.auth.user` only, a daemon-token with no
   * account reads `[]` and cannot write.
   */
  app.get('/api/prefs/plan-presets', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json({ presets: dbApi.userPlanPresetsGet(auth.user?.id) });
  });

  /** Replaces the whole ordered list: `{ presets: [{ id, name, roles }] }`, at most 50, zod-strict. */
  app.put('/api/prefs/plan-presets', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const userId = auth.user?.id;
    if (!userId) {
      forbidden(req, res, { kind: 'account_required' });
      return;
    }
    const parsed = PlanPresetsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: `presets must be at most ${PLAN_PRESETS_MAX} { id, name (1-${PLAN_PRESET_NAME_MAX} characters), roles } entries, each setting at least one role`,
      });
      return;
    }
    res.json({ presets: dbApi.userPlanPresetsSet(userId, parsed.data.presets) });
  });

  /**
   * The one-time token an exposed install asks for at first setup. Operator
   * only (daemon-token): printed by `timon setup-token`. Never a browser route.
   */
  app.post('/api/auth/setup-token', (req, res) => {
    if (req.auth?.kind !== 'daemon-token') {
      res.status(403).json({ error: 'daemon token required' });
      return;
    }
    if (dbApi.countUsers() > 0) {
      res.status(409).json(apiError('already_set_up', 'already set up'));
      return;
    }
    res.json({ token: readOrCreateSetupToken(), required: setupListenerExposed(config()) });
  });

  app.post('/api/auth/setup', async (req, res) => {
    if (dbApi.countUsers() > 0) {
      res.status(409).json(apiError('already_set_up', 'already set up'));
      return;
    }
    // A build past its end date is not a place to start: no licence would
    // make it run, so no account is created on it.
    if (licenseState().reason === 'build_expired') {
      res.status(403).json({ error: 'build_expired' });
      return;
    }
    // On the loopback the caller is the OS account. On an exposed listener
    // (the daemon's own, or the WebUI's: the UI proxy reaches the daemon from
    // the loopback whoever the visitor is) the first superadmin goes to the
    // holder of the daemon-token, or of the one-time setup token that only
    // someone able to read the home can print (SECU-USERS U-9, TODO #327).
    const body = (req.body ?? {}) as AuthBody;
    if (setupListenerExposed(config()) && req.auth?.kind !== 'daemon-token') {
      const tokenKeys = throttleKeys(req, 'setup-token', null);
      const tokenVerdict = checkThrottle(tokenKeys);
      if (!tokenVerdict.allowed) { sendThrottled(res, tokenVerdict); return; }
      if (!verifySetupToken(body.setupToken)) {
        if (typeof body.setupToken === 'string' && body.setupToken) noteAuthFailure(req, tokenKeys);
        res.status(403).json({ error: 'setup_token_required' });
        return;
      }
    }
    const email = parseEmail(body.email);
    const name = parseName(body.name);
    const password = parsePassword(body.password);
    if (!email || !name || !password) {
      res.status(400).json({
        error: 'email, name and password (min 8 characters) required',
      });
      return;
    }
    if (body.scheme !== undefined && !isColorScheme(body.scheme)) {
      res.status(400).json({ error: 'scheme must be light or dark' });
      return;
    }
    // A browser confirms the address before the account exists; the operator
    // (daemon-token, CLI) is trusted with the address it types.
    let emailChallenge: string | null = null;
    if (emailVerification && req.auth?.kind !== 'daemon-token') {
      emailChallenge = checkSetupEmailCode(req, res, emailDeps, body, email);
      if (!emailChallenge) return;
    }
    // Hold the admission lock across the network hop: only one request may
    // activate a key and claim the first account, even across mounted routers.
    if (setupInProgress) {
      res.status(409).json({ error: 'setup_in_progress' });
      return;
    }
    const key = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
    const free = body.licenseMode === 'free';
    if ((body.licenseMode !== undefined && body.licenseMode !== 'free' && body.licenseMode !== 'key') || (free && key)) {
      res.status(400).json({ error: 'invalid_license_mode' });
      return;
    }
    if ((requiresLicense || body.licenseMode === 'key') && !key) {
      res.status(400).json({ error: 'license_required' });
      return;
    }
    const keys = throttleKeys(req, 'setup', null);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) { sendThrottled(res, verdict); return; }
    setupInProgress = true;
    try {
      // Hashed before anything is written: the account and the licence land
      // together or not at all.
      const passwordHash = await hashPassword(password);
      // Another account-creation path may have run while the hash was computed.
      if (dbApi.countUsers() > 0) {
        res.status(409).json(apiError('already_set_up', 'already set up'));
        return;
      }
      if (key) {
        const client: ClientOptions = {
          // A stalled service must release the admission lock so the user can retry.
          fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
        };
        const response = await activate(key, client).then((payload) => ({ ...payload, key })).catch((err: unknown) => {
          if (err instanceof LicenseServerError) throw err;
          throw new LicenseServerError(502, 'license_unavailable');
        });
        // The signed response is necessary but not sufficient: verify the JWT
        // claims, expiry and device binding before writing any account/session.
        const verified = installLicenseToken(response.token, undefined, { fresh: true, dryRun: true });
        if (verified.status !== 'valid') {
          noteAuthFailure(req, keys);
          audit(req, 'license.setup.rejected', verified.reason);
          res.status(400).json({ error: 'license_invalid' });
          return;
        }
        if (verified.users !== null && verified.users < 1) {
          res.status(409).json({ error: 'user_limit' });
          return;
        }
        // Another account-creation path may have run while activation awaited.
        if (dbApi.countUsers() > 0) {
          res.status(409).json(apiError('already_set_up', 'already set up'));
          return;
        }
        assertLicenseCompatible(verified);
        const state = installLicenseToken(response.token, undefined, { fresh: true });
        if (state.status !== 'valid') {
          res.status(400).json({ error: 'license_invalid' });
          return;
        }
        writeLicenseKey(response.key);
        recordServerContact(response.refresh);
        setLicenseState(state);
        audit(req, 'license.setup.activated', state.plan);
      }
      const user = dbApi.createUser({
        email,
        name,
        passwordHash,
        isSuperadmin: true,
        status: 'active',
        source: 'setup',
      });
      dbApi.assignUnownedOwnedTo(user.id);
      consumeSetupToken();
      if (emailChallenge) confirmSetupEmail(emailDeps, emailChallenge, email);
      // Without a row the account falls back on the product default (dark),
      // and the app flipped away from the scheme the onboarding had shown.
      if (isColorScheme(body.scheme)) {
        dbApi.userPrefsSet(user.id, { scheme: body.scheme });
        writeAppearance(body.scheme);
      }
      audit(req, 'user.create', `user:${user.id}`);
      setSession(res, user.id, req.header('user-agent') ?? undefined);
      onboardingStep('account', 'completed');
      res.status(201).json({ user: toPublicUser(user) });
      // Recomposition must not hold up admission or turn a successful account
      // creation into an HTTP error. The helper already reports surface failures.
      if (key) void applyLicensedSurfaces(req.app).catch(() => {
        console.warn('[setup] licensed surface recomposition failed');
      });
    } catch (err: unknown) {
      if (err instanceof LicenseCapabilityError) { res.status(409).json({ error: err.code, message: err.message }); return; }
      if (err instanceof LicenseServerError) {
        noteAuthFailure(req, keys);
        audit(req, 'license.setup.refused', err.code);
        // Never relay the server body: seat_limit includes other machines.
        const code = err.isRefusal ? err.code : 'license_unavailable';
        res.status(err.isRefusal ? err.status : 502).json({ error: code });
      } else {
        res.status(502).json({ error: 'setup_failed' });
      }
    } finally {
      setupInProgress = false;
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const body = (req.body ?? {}) as AuthBody;
    const email = parseEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const keys = throttleKeys(req, 'login', email);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) {
      sendThrottled(res, verdict);
      return;
    }
    if (!email || password.length === 0) {
      res.status(400).json({ error: 'email and password required' });
      return;
    }
    const user = dbApi.getUserByEmail(email);
    // Same 401, in the same time, whether the email is unknown, disabled, or
    // the password is wrong — do not leak which. The check runs first so an
    // unknown e-mail pays the dummy hash too.
    const passwordOk = await testCredential(keys, () => verifyAccountPassword(password, user));
    // Re-read: the account may have been disabled or given a new password
    // while the hash was computed.
    const latest = user ? dbApi.getUserById(user.id) : undefined;
    if (!passwordOk || !user || !latest || latest.status !== 'active' || latest.password_hash !== user.password_hash) {
      noteAuthFailure(req, keys);
      res.status(401).json(apiError('invalid_credentials', 'invalid credentials'));
      return;
    }
    if (!freeAccountAllowed(user.id)) {
      res.status(403).json({ error: 'free_account_restricted', message: FREE_ACCOUNT_RESTRICTED_MESSAGE });
      return;
    }
    clearThrottle(keys);
    // The only moment the plain password is at hand: move a hash written with
    // an older cost onto the current one — unless the password changed while
    // the new hash was computed, which the old one must not overwrite.
    if (needsRehash(user.password_hash)) {
      const rehashed = await hashPassword(password);
      if (dbApi.getUserById(user.id)?.password_hash === user.password_hash) dbApi.setUserPassword(user.id, rehashed);
    }
    setSession(res, user.id, req.header('user-agent') ?? undefined);
    // Signed in again after the upgrade: the mascot is offered next.
    if (dbApi.userWelcomeStage(user.id) === 'signin') dbApi.setUserWelcomeStage(user.id, 'mascot');
    res.json({ user: toPublicUser(user) });
  });

  /**
   * The upgrade welcome is over for this account (its mascot kept or skipped).
   * Under the public `/api/auth/` mount but not public: only the person's own
   * browser session closes it — no device, daemon token or agent api token.
   */
  app.post('/api/auth/welcome/done', (req, res) => {
    const user = req.auth?.kind === 'session' ? req.auth.user : null;
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    dbApi.setUserWelcomeStage(user.id, null);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const raw = readCookie(
      typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
      SESSION_COOKIE,
    );
    if (raw) dbApi.deleteSession(hashSessionToken(raw));
    res.setHeader('Set-Cookie', clearSessionCookie({ secure: cookieSecure() }));
    res.json({ ok: true });
  });

  /**
   * secu-9 — self-service password rotation. Without it a user has to ask a
   * superadmin for a reset, which pushes towards shared credentials.
   *
   * The route sits under the public `/api/auth/` mount but is NOT public: the
   * handler demands a live session identity itself. A daemon-token or an
   * agent's api-token is refused too — rotating a human's password is a
   * browser gesture, and both of those authenticate as somebody else.
   *
   * The old password is required (a stolen cookie alone must not lock the
   * owner out), throttled like a login (it is a credential test), and every
   * OTHER session of the account is revoked: if the reason for rotating is a
   * leak, leaving the thief's cookie alive defeats the point. The caller keeps
   * working through a freshly issued session.
   */
  app.post('/api/auth/password', async (req, res) => {
    const session = req.auth?.kind === 'session' ? req.auth.user : null;
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = (req.body ?? {}) as AuthBody & { current_password?: unknown };
    const current = typeof body.current_password === 'string' ? body.current_password : '';
    const next = parsePassword(body.password);
    const keys = throttleKeys(req, 'password', session.email);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) {
      sendThrottled(res, verdict);
      return;
    }
    if (!next) {
      res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` });
      return;
    }
    const user = dbApi.getUserById(session.id);
    const verdicts = await testCredential(keys, async () => {
      const currentOk = await verifyAccountPassword(current, user);
      return { currentOk, sameAsCurrent: currentOk && user ? await verifyPassword(next, user.password_hash) : false };
    });
    if (!user || !verdicts.currentOk) {
      noteAuthFailure(req, keys);
      res.status(401).json(apiError('invalid_credentials', 'invalid credentials'));
      return;
    }
    if (verdicts.sameAsCurrent) {
      res.status(400).json({ error: 'the new password must differ from the current one' });
      return;
    }
    clearThrottle(keys);
    dbApi.setUserPassword(user.id, await hashPassword(next));
    dbApi.deleteSessionsForUser(user.id);
    audit(req, 'user.change_password', `user:${user.id}`);
    setSession(res, user.id, req.header('user-agent') ?? undefined);
    res.json({ ok: true });
  });

  /**
   * Self-service profile: display name and picture. Same doorway as the
   * password route — a live session, nothing else: a daemon-token or a
   * mission's api-token authenticates as somebody else, and neither has a
   * profile to edit.
   *
   * The avatar is a URL served by our own uploads route, never arbitrary:
   * accepting any string would let a profile pull a remote image and turn
   * every page that renders it into a beacon for whoever hosts it.
   */
  app.patch('/api/auth/profile', (req, res) => {
    const session = req.auth?.kind === 'session' ? req.auth.user : null;
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = (req.body ?? {}) as { name?: unknown; avatar_url?: unknown };
    if (body.name === undefined && body.avatar_url === undefined) {
      res.status(400).json({ error: 'name or avatar_url required' });
      return;
    }
    let user = dbApi.getUserById(session.id);
    if (!user) {
      res.status(404).json(apiError('user_not_found', 'user not found'));
      return;
    }
    if (body.name !== undefined) {
      const name = parseName(body.name);
      if (!name) {
        res.status(400).json(apiError('name_required', 'name is required'));
        return;
      }
      user = dbApi.setUserName(user.id, name);
    }
    if (body.avatar_url !== undefined) {
      const avatar = parseAvatarUrl(body.avatar_url);
      if (avatar === undefined) {
        res.status(400).json({ error: `avatar_url must be null or start with ${AVATAR_URL_PREFIX}` });
        return;
      }
      user = dbApi.setUserAvatar(user.id, avatar);
    }
    audit(req, 'user.update_profile', `user:${user.id}`);
    res.json({ user: toPublicUser(user) });
  });

  /**
   * Requests a move of the login identity. The address is NOT written onto
   * the account here: it is parked in `email_changes` until whoever reads it
   * follows the confirmation link. Otherwise a typo — or a stolen cookie —
   * locks the owner out of their own login.
   *
   * The current password is required for that same reason, and the attempt is
   * throttled like a login because it tests one.
   *
   * There is no mailer in the product (invitations are delivered the same
   * way): the route returns the confirmation token so the UI can hand over a
   * link to copy. Every superadmin is notified — an identity moving on an
   * instance they administer is theirs to know about.
   */
  app.post('/api/auth/email', async (req, res) => {
    const session = req.auth?.kind === 'session' ? req.auth.user : null;
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = (req.body ?? {}) as { email?: unknown; current_password?: unknown };
    const email = parseEmail(body.email);
    const current = typeof body.current_password === 'string' ? body.current_password : '';
    const keys = throttleKeys(req, 'email', session.email);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) {
      sendThrottled(res, verdict);
      return;
    }
    if (!email) {
      res.status(400).json({ error: 'a valid email is required' });
      return;
    }
    const user = dbApi.getUserById(session.id);
    if (!user || !(await testCredential(keys, () => verifyAccountPassword(current, user)))) {
      noteAuthFailure(req, keys);
      res.status(401).json(apiError('invalid_credentials', 'invalid credentials'));
      return;
    }
    clearThrottle(keys);
    if (email === user.email) {
      res.status(400).json({ error: 'the new email must differ from the current one' });
      return;
    }
    if (dbApi.getUserByEmail(email)) {
      res.status(409).json(apiError('email_taken', 'email already exists'));
      return;
    }
    const token = issueInviteToken();
    const expiresAt = Date.now() + EMAIL_CHANGE_TTL_MS;
    dbApi.createEmailChange({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      newEmail: email,
      expiresAt,
    });
    audit(req, 'user.request_email_change', `user:${user.id}`);
    notifySuperadmins(
      'Email change requested',
      `${user.name} (${user.email}) asked to move their login to ${email}. Pending confirmation.`,
    );
    res.status(201).json({ token, email, expires_at: expiresAt });
  });

  /**
   * Consumes a confirmation token. Public on purpose (see `PUBLIC_ENDPOINTS`
   * in `@timon/http`): the link is followed from a mail client, which carries
   * no session cookie of ours. The token is the whole credential, so it is
   * single-use and short-lived.
   *
   * The address is re-checked here and not only at request time: a superadmin
   * — or another user's own confirmed change — may have claimed it in the
   * meantime, and the unique index would surface as a 500 rather than a
   * refusal one can act on.
   */
  app.post('/api/auth/email/confirm', (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'token required' });
      return;
    }
    const tokenHash = hashSessionToken(token);
    const pending = dbApi.getPendingEmailChange(tokenHash);
    if (!pending) {
      res.status(400).json({ error: 'invalid or expired token' });
      return;
    }
    const user = dbApi.getUserById(pending.user_id);
    if (!user || user.status !== 'active') {
      res.status(400).json({ error: 'invalid or expired token' });
      return;
    }
    const taken = dbApi.getUserByEmail(pending.new_email);
    if (taken && taken.id !== user.id) {
      res.status(409).json(apiError('email_taken', 'email already exists'));
      return;
    }
    const previous = user.email;
    try {
      dbApi.setUserEmail(user.id, pending.new_email);
    } catch (err) {
      if (err instanceof LicenseCapabilityError) { res.status(409).json({ error: err.code, message: err.message }); return; }
      if (err instanceof DuplicateEmailError) {
        res.status(409).json(apiError('email_taken', 'email already exists'));
        return;
      }
      throw err;
    }
    dbApi.markEmailChangeConfirmed(tokenHash);
    audit(req, 'user.change_email', `user:${user.id}`);
    notifySuperadmins(
      'Email change confirmed',
      `${user.name} moved their login from ${previous} to ${pending.new_email}.`,
    );
    res.json({ ok: true, email: pending.new_email });
  });

  /**
   * Profile picture upload / serving. Mounted here and not with the project
   * icons: only a signed-in account may drop one, and only for itself.
   *
   * The image is downscaled client-side (canvas) before it gets here — the
   * daemon has no native image lib and is not about to grow one for a 256px
   * thumbnail. `uploads.ts` validates the mime, caps the size, and guards the
   * traversal on the way back out.
   */
  app.post('/api/uploads/avatars', (req, res) => {
    if (req.auth?.kind !== 'session') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    try {
      res.json(saveAvatar(body));
    } catch (err) {
      if (err instanceof LicenseCapabilityError) { res.status(409).json({ error: err.code, message: err.message }); return; }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/uploads/avatars/:file', (req, res) => {
    try {
      const { bytes, contentType } = readAvatar(req.params.file);
      res.setHeader('content-type', contentType);
      // Immutable: the name is a fresh uuid on every upload, so a changed
      // picture is a different URL — nothing to invalidate.
      res.setHeader('cache-control', 'private, max-age=31536000, immutable');
      res.send(bytes);
    } catch (err) {
      if (err instanceof LicenseCapabilityError) { res.status(409).json({ error: err.code, message: err.message }); return; }
      const msg = (err as Error).message;
      res.status(msg === 'not found' ? 404 : 400).json({ error: msg });
    }
  });

  // The operator's account recovery (`timon user list`, `timon user reset-password`,
  // docs/remote-access.md): the CLI's daemon token only, with or without an account
  // provider. Administering accounts belongs to that provider plugin, not to the core.
  app.get('/api/users', operatorOnly, (_req, res) => {
    res.json({ users: dbApi.listUsers().map(toPublicUser) });
  });

  app.post('/api/users/:id/reset-password', operatorOnly, async (req, res) => {
    const user = dbApi.getUserById(String(req.params.id));
    if (!user) {
      res.status(404).json(apiError('user_not_found', 'user not found'));
      return;
    }
    const password = generateTemporaryPassword();
    dbApi.setUserPassword(user.id, await hashPassword(password));
    dbApi.revokeUserAccess(user.id);
    audit(req, 'user.reset_password', `user:${user.id}`);
    res.json({ user: toPublicUser(dbApi.getUserById(user.id)!), password });
  });
}
