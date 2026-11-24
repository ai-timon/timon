/**
 * Kernel license routes — `GET /api/license`, `PUT /api/license`,
 * `POST /api/license/activate`, `…/deactivate` and `…/name`.
 *
 * The license gate lives in the kernel (`capabilities.ts`, `registry.ts`), so
 * its routes belong there too rather than to a bundled module: licensing is
 * not a feature one can uninstall, and it has no business showing up as a
 * card in the plugin gallery. Mounted by `@timon/http`, the only holder of the
 * Express router.
 *
 * Who may call what (SECU-LICENCES L-3, L-8):
 *   - `GET` — any authenticated caller; it drives the banner every user sees.
 *     The body is the public shape only (no device id, no activation list).
 *   - `PUT` / `POST …/activate` — a superadmin SESSION or the daemon-token.
 *     A mission's api-token is refused even though the daemon-token that
 *     spawned it is superadmin: an injected agent must not be able to
 *     downgrade the instance or rotate its device id. Every attempt, accepted
 *     or refused, lands in `audit_log`.
 */
import type { Application, Request, Response, Router } from 'express';
import { assertLicenseCompatible } from '../../license/compliance.js';
import { LicenseCapabilityError } from '../../license/capabilities.js';
import { dbApi } from '../../db.js';
import { buildInfo } from '../../build-info.js';
import { config } from '../../config/load.js';
import { rmSync } from 'node:fs';
import { LICENSE_FILE } from '../../paths.js';
import { activate, deactivate, LicenseServerError, parseMachineName, setMachineName, MACHINE_NAME_MAX } from '../../license/client.js';
import { deviceId } from '../../license/device.js';
import { isDowngrade } from '../../license/downgrade.js';
import { effectiveEdition, installLicenseToken, unlicensed, type LicenseState } from '../../license/license.js';
import { clearLicenseAlerts, forgetLicenseKey, paidRightsLapse, readLicenseKey, recordServerContact, writeLicenseKey } from '../../license/refresh.js';
import { licenseRevision, licenseState, setLicenseState } from '../../license/runtime.js';
import { forgetMachineName, readLicenseStore, writeLicenseStore } from '../../license/store.js';
import { loaderFromApp } from '../../plugins/runtime.js';
import { auditRequest } from '../../users/audit-actor.js';
import { requireSuperadmin, forbidden } from '../../users/identity.js';
import { reconcilerFromApp } from '../bundled-reload.js';
import { apiError } from '../../api-error.js';

/**
 * A newly installed licence can widen what's allowed to run — bundled
 * modules AND third-party plugins alike (lic-6). Both already know how to
 * recompose without a restart (the config-file watch, the plugin directory
 * watch); this just fires the same recomposition on the licence's own
 * schedule instead of waiting for one of those to poll again. `null` outside
 * a booted kernel (tests, CLI-only install) — nothing to nudge, and that's
 * fine: the licence itself is applied either way.
 *
 * Takes the Express app rather than a request: the refresh loop (L-1) calls
 * it from a timer, where there is no request.
 */
export async function applyLicensedSurfaces(app: Pick<Application, 'get'>): Promise<void> {
  const reconciler = reconcilerFromApp(app as Application);
  const loader = loaderFromApp(app as Application);
  await Promise.all([
    reconciler?.reconcile().catch((err: Error) => console.warn('[kernel] recomposition after licence change:', err.message)),
    loader?.update().catch((err: Error) => console.warn('[plugins] recomposition after licence change:', err.message)),
  ]);
}

export function publicState() {
  const state = licenseState();
  const build = buildInfo();
  const freeOwner = state.localFree ? dbApi.getActiveSuperadmin()?.id : undefined;
  return {
    status: state.status,
    localFree: state.localFree === true,
    restrictedAccounts: state.localFree ? dbApi.listUsers().filter((user) => user.status !== 'disabled' && user.id !== freeOwner).length : 0,
    reason: state.reason,
    edition: effectiveEdition(config().edition, state.edition),
    // Named on purpose: the edition is a capability tier, the plan is what the
    // user pays for and the only string the licence page can show them.
    plan: state.plan,
    lifetime: state.lifetime,
    capabilities: state.capabilities ?? null,
    users: state.users,
    expiresAt: state.expiresAt,
    subscriptionExpiresAt: state.subscriptionExpiresAt,
    paymentStatus: state.paymentStatus,
    offlineSince: state.offlineSince,
    // Paid rights really lost on a build that fell back to Free: the one
    // thing about the licence the web app shows as a card. An outage within
    // the tolerance is `offlineSince` alone, and shows nothing.
    lapse: paidRightsLapse(state),
    // What a beta tester needs to see coming: the channel and the build's end
    // date. Nothing of how the end is judged (clock marks, build stamp time).
    build: { channel: build.channel, expiresAt: build.expiresAt },
    // §5.10. Read from the local store rather than the token: the name is not
    // a claim, and no route hands it back. `machineName` is what this install
    // successfully wrote; `machineNameLocked` also covers the name someone
    // else wrote (the admin console, a reinstalled home) — known only through
    // a `409 name_locked`, without the name itself.
    ...(state.localFree ? { machineName: null, machineNameLocked: false } : machineNaming()),
  };
}

function machineNaming(): { machineName: string | null; machineNameLocked: boolean } {
  const store = readLicenseStore();
  return { machineName: store.machineName ?? null, machineNameLocked: store.machineNameLocked === true };
}

/**
 * Superadmin session or daemon-token, never an api-token. `requireSuperadmin`
 * alone is not enough: a mission token is never `isSuperadmin`, but refusing
 * the kind explicitly is what documents the intent and survives a future
 * token kind that would be. Writes the refusal to the audit log — a 403 here
 * is a signal worth keeping (L-3: an agent trying to downgrade the instance).
 */
function guard(req: Request, res: Response, action: string): boolean {
  if (req.auth?.kind === 'api-token') {
    auditRequest(req, `${action}.denied`, 'api-token');
    forbidden(req, res, { kind: 'operator' });
    return false;
  }
  if (!requireSuperadmin(req, res)) {
    if (req.auth) auditRequest(req, `${action}.denied`, null);
    return false;
  }
  return true;
}

function rejectInvalid(res: Response, state: LicenseState): void {
  // `invalid:machine` on its own is a dead end: the operator cannot get a
  // valid token issued without knowing the device this daemon announces.
  // Not a leak — it is its own identifier, on a superadmin-only route.
  const device = state.reason === 'invalid:machine' ? { device: deviceId() } : {};
  res.status(400).json({ error: 'invalid license', reason: state.reason, ...device });
}

/**
 * Verifies, refuses a silent downgrade, installs, then recomposes. Shared by
 * the two install routes so the rules cannot drift between them. `true` when
 * the token was installed.
 */
function installFromRoute(req: Request, res: Response, token: string, action: string): boolean {
  const force = req.body?.force === true;
  const current = licenseState();
  const next = installLicenseToken(token, undefined, { fresh: true, dryRun: true });
  if (next.status === 'unlicensed') {
    auditRequest(req, `${action}.rejected`, next.reason);
    rejectInvalid(res, next);
    return false;
  }
  try { assertLicenseCompatible(next); }
  catch (err) {
    if (!(err instanceof LicenseCapabilityError)) throw err;
    res.status(409).json({ error: err.code, message: err.message });
    return false;
  }
  if (!force && isDowngrade(current, next)) {
    auditRequest(req, `${action}.downgrade_refused`, next.plan);
    res.status(409).json({
      error: 'downgrade',
      message: 'This licence grants less than the one installed. Send { force: true } to replace it anyway.',
      current: { edition: current.edition, plan: current.plan },
      next: { edition: next.edition, plan: next.plan },
    });
    return false;
  }
  const state = installLicenseToken(token, undefined, { fresh: true });
  if (state.status === 'unlicensed') { rejectInvalid(res, state); return false; }
  setLicenseState(state);
  void clearLicenseAlerts();
  auditRequest(req, action, state.plan);
  return true;
}

export function registerRoutes(router: Router): void {
  router.post('/api/license/deactivate', async (req, res) => {
    if (!guard(req, res, 'license.deactivate')) return;
    if (licenseState().localFree) { res.status(409).json({ error: 'local_free' }); return; }
    const key = readLicenseKey();
    if (!key) { res.status(409).json({ error: 'activation_key_missing' }); return; }
    const revision = licenseRevision();
    try {
      await deactivate(key);
      if (revision !== licenseRevision()) { res.status(409).json({ error: 'license_changed' }); return; }
      // Only a signed successful server acknowledgement releases this install.
      // The restriction receipt stays: deleting a bearer cannot unlock Free.
      forgetLicenseKey();
      forgetMachineName();
      rmSync(LICENSE_FILE, { force: true });
      setLicenseState(unlicensed('deactivated'));
      auditRequest(req, 'license.deactivate', null);
      await applyLicensedSurfaces(req.app);
      res.json(publicState());
    } catch (err) {
      if (err instanceof LicenseServerError) {
        res.status(err.isRefusal ? err.status : 502).json({ error: err.code, message: err.message });
        return;
      }
      res.status(502).json(apiError('license_server_unreachable', 'license server unreachable'));
    }
  });
  // §5.10 — names this machine, once. Same audience as its neighbours: a
  // superadmin session or the daemon-token, never a mission's api-token.
  router.post('/api/license/name', async (req, res) => {
    if (!guard(req, res, 'license.name')) return;
    const name = parseMachineName(req.body?.name);
    if (name === null) {
      res.status(400).json({ error: 'invalid_name', message: `name must be 1 to ${MACHINE_NAME_MAX} characters, without control characters` });
      return;
    }
    if (licenseState().localFree) { res.status(409).json({ error: 'local_free' }); return; }
    const key = readLicenseKey();
    if (!key) { res.status(409).json({ error: 'activation_key_missing' }); return; }
    const revision = licenseRevision();
    try {
      const stored = await setMachineName(key, name);
      // The licence may have been replaced while the request was in flight;
      // recording the name then would label this machine after a licence it
      // no longer holds.
      if (revision !== licenseRevision()) { res.status(409).json({ error: 'license_changed' }); return; }
      writeLicenseStore({ machineName: stored, machineNameLocked: true, machineNameLicense: licenseState().licenseId ?? null });
      auditRequest(req, 'license.name', stored);
      res.json(publicState());
    } catch (err) {
      if (err instanceof LicenseServerError) {
        auditRequest(req, 'license.name.refused', err.code);
        // `name_locked` is the one refusal worth remembering: the machine has
        // a name we will never learn, so the page must stop offering a field.
        // The server sends no name back (§5.10) — none is invented here.
        if (err.code === 'name_locked' && err.isRefusal && revision === licenseRevision()) {
          writeLicenseStore({ machineNameLocked: true, machineNameLicense: licenseState().licenseId ?? null });
        }
        res.status(err.isRefusal ? err.status : 502).json({ error: err.code, message: err.message });
        return;
      }
      res.status(502).json(apiError('license_server_unreachable', 'license server unreachable'));
    }
  });
  router.get('/api/license', (_req, res) => res.json(publicState()));
  router.put('/api/license', (req, res) => {
    if (!guard(req, res, 'license.install')) return;
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    // Read before the install, for the same reason `…/activate` reads the key
    // it holds: what tells a repair from a replacement is the identity the name
    // was filed under. `lic` is that identity — one licence, however many
    // tokens. Taken from the STORE, not from `licenseState()`: a hand-pasted
    // token usually arrives because the live one expired, and an expired state
    // carries no `lic` at all — every repair would read as a replacement.
    const namedUnder = readLicenseStore().machineNameLicense ?? licenseState().licenseId;
    if (!installFromRoute(req, res, token, 'license.install')) return;
    const installed = licenseState().licenseId;
    // Unknown identity cannot justify renewing the old key over a new token.
    if (namedUnder !== installed) {
      // Another licence: the name belonged to the activation that just left,
      // and the stored key renews THAT one — the refresh loop would put its
      // token back over the one just pasted. Both go, before the answer is
      // composed: `publicState()` must never show the old licence's name.
      forgetMachineName();
      forgetLicenseKey();
      writeLicenseStore({ lastContact: undefined, every: undefined, offlineHours: undefined });
    }
    applyLicensedSurfaces(req.app).finally(() => res.json(publicState()));
  });
  // Exchanges an activation KEY (the short `TMN-XXXX-…` code the license
  // server issues) for a JWT via the §5.1 contract, then installs it exactly
  // like `PUT /api/license` would — this route only adds the network hop.
  router.post('/api/license/activate', (req, res) => {
    if (!guard(req, res, 'license.activate')) return;
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!key) { res.status(400).json({ error: 'missing license key' }); return; }
    // Rotating the device id is a destructive recovery (the installed token
    // stops verifying): only this interactive, superadmin-guarded path may
    // allow it. The refresh loop never does.
    const revision = licenseRevision();
    // Read before the network hop: what tells a repair (same key, re-activated)
    // from a replacement (another licence) is the key we were holding.
    const previousKey = readLicenseKey();
    activate(key, { allowRotate: true }).then((response) => {
      if (revision !== licenseRevision()) { res.status(409).json({ error: 'license_changed' }); return; }
      if (!installFromRoute(req, res, response.token, 'license.activate')) return;
      // The key is what the refresh loop renews with (L-1); the schedule is
      // the server's, not ours.
      writeLicenseKey(key);
      // A name belongs to the ACTIVATION of one licence: another licence's
      // name is not this one's. Re-activating the SAME key, though, is a
      // repair — forgetting there would drop a name that can never be read
      // back (§5.10 answers `name_locked` without it). `PUT /api/license`
      // draws the same line on the `lic` claim, the only identity a raw JWT
      // carries.
      if (previousKey !== key) {
        forgetMachineName();
        // The renewal schedule was the previous licence's: an answer without
        // `refresh` must not leave its cadence on the new one.
        writeLicenseStore({ lastContact: undefined, every: undefined, offlineHours: undefined });
      }
      recordServerContact(response.refresh);
      return applyLicensedSurfaces(req.app).finally(() => res.json(publicState()));
    }).catch((err: unknown) => {
      if (err instanceof LicenseServerError) {
        auditRequest(req, 'license.activate.refused', err.code);
        const status = err.status >= 400 && err.status < 500 ? err.status : 502;
        // `seat_limit` carries the list of the licence's machines (host names
        // included). The guard above already limits who gets here; keeping
        // the relay conditional documents that it is an inventory (L-8).
        const body = err.body && typeof err.body === 'object' && req.auth?.isSuperadmin ? { body: err.body } : {};
        res.status(status).json({ error: err.code, message: err.message, ...body });
        return;
      }
      res.status(502).json(apiError('license_server_unreachable', 'license server unreachable'));
    });
  });
}
