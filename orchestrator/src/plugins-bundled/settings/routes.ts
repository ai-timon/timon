/**
 * Module `@timon/settings` — settings registry and export/import of the
 * installation. Tier `core`: everything else reads its values.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { saveBackgroundImage, readBackgroundImage, deleteBackgroundImage } from '../../uploads.js';
import { config } from '../../config/load.js';
import { db, dbApi } from '../../db.js';
import { exportTimon } from '../../export.js';
import { isBetaBuild } from '../../license/build-policy.js';
import { licenseState } from '../../license/runtime.js';
import { TIMON_HOME } from '../../paths.js';
import { resolve, resolveAll, setSetting, settingGroups } from '../../settings.js';
import { join, resolve as resolvePath, sep } from 'node:path';
import { forbidden, rejectIfDenied, requireAuth, requireSuperadmin, isPersonAuth } from '../../users/identity.js';
import { memoryPresetSettings, resourceMemoryInfo } from '../../resource-memory-presets.js';
import { changeServiceSessionMode, runOnboardingAction } from '../../onboarding.js';
import { SERVICE_SESSION_MODES } from '../../host/service-session-mode.js';
import { daemonDiagnosticReport, systemInfo } from '../../system-info.js';
import { apiError } from '../../api-error.js';

const sessionModeSchema = z.object({ mode: z.enum(SERVICE_SESSION_MODES) }).strict();

const memoryPresetSchema = z.object({ ramGb: z.union([z.literal(8), z.literal(16), z.literal(32), z.literal(64)]) }).strict();

/**
 * Widget placement — the daemon owns it so it follows the user from one
 * browser or machine to the next, and so `timon export` carries it (the base
 * travels whole). The value stays opaque JSON: its shape belongs to the front.
 */
const LAYOUT_DEFAULT_SCOPE = 'cockpit';
/** A placement is a few hundred bytes. The cap is not about memory but about
 *  refusing to become a general-purpose blob store on a route with no schema.
 *
 *  Exported because the browser mirrors it (`MAX_PRESETS_BYTES` in
 *  `app/src/lib/layout-presets.ts`): a named layout is measured before its
 *  write leaves, so the refusal is a sentence in the menu rather than a 400
 *  landing after the form closed. The two packages are independent, so the
 *  value is copied, not imported — both copies are pinned by a test at the
 *  exact boundary. */
export const LAYOUT_MAX_BYTES = 64 * 1024;
const LAYOUT_SCOPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function layoutScope(raw: unknown): string | null {
  if (raw === undefined) return LAYOUT_DEFAULT_SCOPE;
  if (typeof raw !== 'string' || !LAYOUT_SCOPE.test(raw)) return null;
  return raw;
}

/**
 * `?prefix=` reads a whole family of scopes at once.
 *
 * Validated against the same shape as a scope: a prefix IS the head of a
 * scope, and letting anything else through would turn a placement route into
 * a way to sweep the table. An empty prefix is refused for the same reason —
 * it would return every row of the caller, which no caller has a use for.
 */
function layoutPrefix(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || !LAYOUT_SCOPE.test(raw)) return null;
  return raw;
}

/**
 * `?expected=` makes a write conditional on the version its writer read
 * (`updatedAt` of the GET; `none` when nothing was stored). Two windows open on
 * the same view each hold their own copy of a row: without this, the one left
 * on an old copy rewrites the whole row at its first gesture and erases what
 * the other added. Absent, the write is unconditional, as it always was — the
 * recall of a preset or an applied proposal means to replace.
 */
const LAYOUT_EXPECTED = z.union([z.literal('none'), z.string().regex(/^\d{1,16}$/)]).optional();

function layoutExpected(raw: unknown): { ok: true; value: number | null | undefined } | { ok: false } {
  const parsed = LAYOUT_EXPECTED.safeParse(raw);
  if (!parsed.success) return { ok: false };
  if (parsed.data === undefined) return { ok: true, value: undefined };
  return { ok: true, value: parsed.data === 'none' ? null : Number(parsed.data) };
}

/** Answers 409 when the row moved since the caller read it; `true` if it did. */
function refuseStaleLayout(res: Response, owner: string, scope: string, expected: number | null | undefined): boolean {
  if (expected === undefined) return false;
  // The version the GET served, template fallback included: a caller that
  // read the machine template and writes its own row first is not stale.
  const updatedAt = dbApi.uiLayoutGet(owner, scope)?.updated_at ?? null;
  if (updatedAt === expected) return false;
  res.status(409).json({ error: 'conflict', scope, updatedAt });
  return true;
}

/** Session / attached user → their chrome. No user → machine template. */
function layoutOwner(req: Request): string {
  return req.auth?.user?.id ?? '';
}

/**
 * An agent never rewrites its owner's screen directly: every change goes
 * through a proposal the owner applies from its card (`widgets_propose`,
 * `layout-proposals.ts`). Its mission token reads the layout, it does not
 * write it — without this, `timon_http_call` would turn the card into a
 * formality.
 */
function refuseMissionWrite(req: Request, res: Response): boolean {
  if (req.auth?.kind !== 'api-token' || !req.auth.missionId) return false;
  forbidden(req, res, {
    kind: 'scope',
    reason: 'an agent mission cannot rewrite its owner\'s layout',
    hint: 'Propose the arrangement with widgets_propose (cards, columns) or islands_propose (islands): the user applies it from the card in your conversation.',
  });
  return true;
}

export function registerRoutes(app: Router): void {
  app.post('/api/appearance/background-image', (req, res) => {
    const owner = isPersonAuth(req.auth) ? req.auth.user?.id : null;
    if (!owner) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.json(saveBackgroundImage(owner, req.body ?? {})); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  app.get('/api/appearance/background-image/:file', (req, res) => {
    const owner = isPersonAuth(req.auth) ? req.auth.user?.id : null;
    if (!owner) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { bytes, contentType } = readBackgroundImage(owner, req.params.file);
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'private, no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.send(bytes);
    } catch { res.status(404).json(apiError('not_found', 'not found')); }
  });
  app.delete('/api/appearance/background-image/:file', (req, res) => {
    const owner = isPersonAuth(req.auth) ? req.auth.user?.id : null;
    if (!owner) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { deleteBackgroundImage(owner, req.params.file); res.json({ ok: true }); }
    catch { res.status(400).json({ error: 'invalid file' }); }
  });
  app.get('/api/settings', (req, res) => {
    if (rejectIfDenied(req, res, 'page:/settings')) return;
    res.json({
      settings: resolveAll().map((r) => ({
        key: r.def.key,
        type: r.def.type,
        group: r.def.group,
        label: r.def.label,
        description: r.def.description ?? null,
        unit: r.def.unit ?? null,
        advanced: r.def.advanced ?? false,
        owner: r.def.owner ?? null,
        input: r.def.input ?? null,
        min: r.def.min ?? null,
        max: r.def.max ?? null,
        value: r.value,
        default: r.def.default,
        source: r.source,
        overridden: r.dbValue !== null,
      })),
      groups: settingGroups(),
      resourceMemory: resourceMemoryInfo(),
    });
  });

  app.post('/api/settings/resource-memory-preset', (req, res) => {
    if (!requireAuth(req, res) || rejectIfDenied(req, res, 'settings:write')) return;
    const parsed = memoryPresetSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'ramGb must be 8, 16, 32 or 64' }); return; }
    db.transaction(() => {
      for (const [key, value] of Object.entries(memoryPresetSettings(parsed.data.ramGb))) {
        setSetting(key, String(value));
      }
    })();
    res.json({ ok: true });
  });

  app.put('/api/settings/:key', (req, res) => {
    if (rejectIfDenied(req, res, 'settings:write')) return;
    const raw = req.body?.value;
    const value = raw === null || raw === undefined ? null : String(raw);
    const out = setSetting(req.params.key, value);
    if (!out.ok) { res.status(400).json({ error: out.error }); return; }
    res.json({ ok: true, setting: resolve(req.params.key) });
  });

  app.post('/api/admin/export', (req, res) => {
    // A full dump of the database is an operator gesture, and it lands under
    // TIMON_HOME only: a caller-chosen path would let the daemon write a copy
    // of `timon.db` anywhere it can (SECU-USERS U-3).
    if (!requireSuperadmin(req, res)) return;
    const body = req.body ?? {};
    const withArchive = body.withArchive === true;
    // The one route the beta wall leaves open besides licence and auth: a tester
    // whose build ended must still be able to take their data out. It stays a
    // read of the install — a caller-chosen `out` could name `license.state.json`
    // or `timon.db` and have the tarball overwrite it, so a locked build only
    // writes the default archive name.
    if (isBetaBuild() && licenseState().status !== 'valid' && body.out !== undefined) {
      res.status(400).json({ error: 'out_not_allowed' });
      return;
    }
    const out = typeof body.out === 'string' && body.out.trim()
      ? resolvePath(TIMON_HOME, body.out.trim())
      : join(TIMON_HOME, `timon-export-${new Date().toISOString().slice(0, 10)}.tar.gz`);
    if (!out.startsWith(resolvePath(TIMON_HOME) + sep)) {
      res.status(400).json({ error: 'out must be a path under TIMON_HOME' });
      return;
    }
    try {
      const result = exportTimon({
        out,
        withArchive,
        profile: config().profile,
        vacuumInto: (dest) => { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); },
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * How this Timon runs on the machine (Settings › System › Installation,
   * TODO #333): versions, paths, daemon mode, service, ports. Superadmin only:
   * it describes the machine, not an account. No secret in the payload
   * (`system-info.ts`).
   */
  app.get('/api/admin/system', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    try {
      res.json(systemInfo());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * The support report (TODO #343): what a tester pastes when something
   * breaks. Superadmin only, like the facts it gathers; secrets are masked
   * in the text itself (`host/diagnostic-report.ts`). `app` is the desktop's
   * version, which only the window knows.
   */
  const diagnosticQuery = z.object({ app: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).optional() });
  app.get('/api/admin/system/diagnostic', async (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    const query = diagnosticQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'invalid app version' });
      return;
    }
    try {
      res.json(await daemonDiagnosticReport(query.data.app ?? null));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * The onboarding's "install the service" button, offered again from
   * Settings at the maintainer's request (TODO #333). Amends the rule of
   * `POST /api/onboarding` ("outside the first run it is `timon service
   * install`"): that route stays first-run only — it also carries
   * `install-binary` and `check-path` — and this one runs the SAME action,
   * never a second install path. Refused when there is nothing to do, and
   * when this daemon is the service itself: reinstalling would stop the
   * process answering this request, so the pane shows the command instead.
   */
  app.post('/api/admin/service/install', async (req, res) => {
    const auth = requireSuperadmin(req, res);
    if (!auth) return;
    // A person at the screen, never the daemon token of the CLI, MCP servers
    // and agents: it raises an administrator prompt, and the CLI already has
    // `timon service install`.
    if (!isPersonAuth(auth)) {
      res.status(403).json({ error: 'This operation requires a signed-in user.' });
      return;
    }
    try {
      const { service } = systemInfo();
      if (service.action === null) {
        res.status(409).json({ error: 'nothing_to_do', command: null });
        return;
      }
      if (!service.actionHere) {
        res.status(409).json({ error: 'run_from_terminal', command: service.command });
        return;
      }
      const answer = await runOnboardingAction({ action: 'install-service' });
      // Never trust the click: ask the machine what it now holds.
      const status = await runOnboardingAction({ action: 'service-status' });
      res.json({ ...answer, installed: status.installed === true, running: status.ok });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Settings › System: does the service keep running once the user logs out?
   * The onboarding asked it; this changes the answer (`changeServiceSessionMode`).
   * Same gates as the install above: a signed-in superadmin, never the daemon
   * token, since turning lingering on lets agents run with nobody at the screen.
   */
  app.post('/api/admin/service/session-mode', async (req, res) => {
    const auth = requireSuperadmin(req, res);
    if (!auth) return;
    if (!isPersonAuth(auth)) {
      res.status(403).json({ error: 'This operation requires a signed-in user.' });
      return;
    }
    const body = sessionModeSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'mode must be "session" or "always"' });
      return;
    }
    try {
      const { service, daemon } = systemInfo();
      if (!service.sessionModeSupported) {
        res.status(409).json({ error: 'not_supported', command: null });
        return;
      }
      const answer = await changeServiceSessionMode(body.data.mode, daemon.mode === 'service');
      const status = await runOnboardingAction({ action: 'service-status' });
      res.status(answer.ok ? 200 : 500).json({ ...answer, offSession: status.offSession ?? null, sessionMode: status.sessionMode ?? null });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Identity is the caller, never a `?user=` query: a neighbour must not
  // be able to read or write someone else's chrome. No user (first-run,
  // daemon-token before any account) writes the machine template.

  // A scope with no stored row is not an error: the front falls back to the
  // registry defaults, which is exactly the first-run experience.
  app.get('/api/layout', (req, res) => {
    // A workspace stores its arrangement across several scopes; `?prefix=`
    // hands them over together so a caller can photograph it without knowing
    // which ones a plugin happens to have opened.
    if (req.query.prefix !== undefined) {
      const prefix = layoutPrefix(req.query.prefix);
      if (prefix === null) { res.status(400).json({ error: 'invalid prefix' }); return; }
      const layouts = dbApi.uiLayoutList(layoutOwner(req), prefix).map((row) => ({
        scope: row.scope, layout: JSON.parse(row.value), updatedAt: row.updated_at,
      }));
      res.json({ prefix, layouts });
      return;
    }
    const scope = layoutScope(req.query.scope);
    if (scope === null) { res.status(400).json(apiError('invalid_scope', 'invalid scope')); return; }
    const row = dbApi.uiLayoutGet(layoutOwner(req), scope);
    if (!row) { res.json({ scope, layout: null, updatedAt: null }); return; }
    res.json({ scope, layout: JSON.parse(row.value), updatedAt: row.updated_at });
  });

  app.put('/api/layout', (req, res) => {
    if (refuseMissionWrite(req, res)) return;
    const scope = layoutScope(req.query.scope);
    if (scope === null) { res.status(400).json(apiError('invalid_scope', 'invalid scope')); return; }
    const layout = req.body?.layout;
    if (layout === undefined || layout === null) {
      res.status(400).json({ error: 'layout is required' });
      return;
    }
    const expected = layoutExpected(req.query.expected);
    if (!expected.ok) { res.status(400).json({ error: 'invalid expected' }); return; }
    const value = JSON.stringify(layout);
    if (Buffer.byteLength(value) > LAYOUT_MAX_BYTES) {
      res.status(400).json({ error: `layout exceeds ${LAYOUT_MAX_BYTES} bytes` });
      return;
    }
    // Check and write in the same synchronous turn: no other request can
    // land between them.
    const owner = layoutOwner(req);
    if (refuseStaleLayout(res, owner, scope, expected.value)) return;
    const updatedAt = dbApi.uiLayoutSet(owner, scope, value);
    res.json({ ok: true, scope, updatedAt });
  });

  // Deleting a scope one never wrote is a success: a recall erases whatever
  // the view holds and the preset does not, and it has no reason to know
  // which of those rows actually existed.
  app.delete('/api/layout', (req, res) => {
    if (refuseMissionWrite(req, res)) return;
    const scope = layoutScope(req.query.scope);
    if (scope === null) { res.status(400).json(apiError('invalid_scope', 'invalid scope')); return; }
    const expected = layoutExpected(req.query.expected);
    if (!expected.ok) { res.status(400).json({ error: 'invalid expected' }); return; }
    const owner = layoutOwner(req);
    if (refuseStaleLayout(res, owner, scope, expected.value)) return;
    dbApi.uiLayoutDelete(owner, scope);
    // What a reader now gets: the machine template's version, or none.
    res.json({ ok: true, scope, updatedAt: dbApi.uiLayoutGet(owner, scope)?.updated_at ?? null });
  });
}
