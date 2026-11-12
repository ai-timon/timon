/**
 * `GET /api/plugins` / `GET /api/plugins/:id` — the real state of the loader.
 * `GET /plugins/:id/client.js` — the browser half, if it is served.
 * `GET /plugins/:id/cover` — the gallery cover, served even when unplugged.
 * `GET /api/plugins/:id/-/dictation-models` — the speech models pack of a dictation plugin.
 * `POST /api/plugins/:id/enabled` — the gallery toggle (writes the config).
 * `/api/plugins/:id/-/webhooks…` — the plugin's incoming webhooks: status,
 *   secret generation (shown once), end of a rotation.
 * `/api/plugins/-/install/…` — install from the gallery (`install-routes.ts`).
 * `/api/plugins/-/developer` — the developer-mode switch (`developer-routes.ts`).
 *
 * This is not a boundary: anyone who reaches the daemon reads these
 * routes, like the rest of `/api`. They expose what the loader
 * decided, refusals included (`skipped:unlicensed`, `forbidden-inject`,
 * unknown `apiVersion`, throw in `apply`).
 */
import type { Request, Router } from 'express';
import { z } from 'zod';
import { bundleRouter } from '../../plugins/bundles.js';
import { registerInstallRoutes } from './install-routes.js';
import { registerDeveloperModeRoutes } from './developer-routes.js';
import { registerProviderRoutes } from './provider-routes.js';
import { registerAcpRegistryRoutes } from './acp-registry-routes.js';
import { coverRouter } from '../../plugins/covers.js';
import { readDictationPack } from '../../plugins/dictation-packs.js';
import { galleryPlugins, loaderFromApp } from '../../plugins/runtime.js';
import { applyToggle, assertToggleMutable, resolveId, resolveToggleTarget } from '../../plugins/toggle.js';
import { CoreModuleError } from '../../kernel/module-config.js';
import { dbApi } from '../../db.js';
import { isSealed } from '../../secrets/box.js';
import { sealPluginKvValue } from '../../secrets/plugins.js';
import { forbidden, rejectIfDenied, rejectIfNotSuperadmin, viewerFromRequest, isPersonAuth } from '../../users/identity.js';
import { filterGallery, pluginVisible, thirdPartyPluginVisible } from '../../users/surfaces.js';
import { LicenseCapabilityError } from '../../license/capabilities.js';
import { collectUsage } from '../../usage.js';
import {
  PluginWebhookSecretError, pluginWebhookStatus, revokePreviousPluginWebhookSecret, rotatePluginWebhookSecret,
  setPluginWebhookSecret, webhookPublisherOf, type PluginWebhookPublisher,
} from '../../plugins/webhooks.js';
import type { PluginWebhookDecl } from '../../plugins/manifest.js';
import { apiError } from '../../api-error.js';

const SETTINGS_PREFIX = '@settings/';
const toggleIdSchema = z.string().refine((id) => id.trim().length > 0);
const toggleBodySchema = z.object({ enabled: z.boolean() });
const rotateBodySchema = z.object({ keepPrevious: z.boolean().optional() }).strict();
/** A pasted secret or public key; its shape per format is checked by the engine. */
const provideBodySchema = z.object({ secret: z.string().min(1).max(512), keepPrevious: z.boolean().optional() }).strict();

/**
 * `kind` of an installed third-party plugin, from the loader. Empty when the
 * loader is absent or does not know the id — the asset curtain then falls back
 * to the strict `plugin:<id>` grant (`users/surfaces.ts`).
 */
function pluginKindsOf(req: { app: { get(key: string): unknown; set(key: string, value: unknown): unknown } }, id: string): readonly string[] {
  const loader = loaderFromApp(req.app);
  if (!loader) return [];
  // `list()`, not `publicPlugins()`: this runs on every asset request (a
  // gallery page fires one per card), and building the public shape of every
  // installed plugin to read one `kind` would pay N times for one lookup.
  return loader.list().find((s) => s.id === id)?.manifest?.kind ?? [];
}

function settingKvKey(key: string): string {
  return `${SETTINGS_PREFIX}${key}`;
}

function settingStatus(id: string, setting: { key: string; type: string; label: string; default?: string | number | boolean }) {
  const kvKey = settingKvKey(setting.key);
  const raw = dbApi.pluginKvGet(id, kvKey);
  if (setting.type === 'secret') {
    // Lazy migration §10.4: a cleartext row is resealed on first read. The
    // value still never leaves this function — `configured` is the only
    // signal the UI is allowed.
    if (raw !== undefined && !isSealed(raw)) {
      dbApi.pluginKvSet(id, kvKey, sealPluginKvValue(id, kvKey, raw));
    }
    return { ...setting, value: '', configured: raw !== undefined };
  }
  return { ...setting, value: raw === undefined ? setting.default : JSON.parse(raw), configured: raw !== undefined };
}

function visiblePlugin(req: Request, id: string) {
  const found = galleryPlugins(loaderFromApp(req.app)).find((p) => p.id === id) ?? null;
  if (!found || !pluginVisible(found, viewerFromRequest(req))) return null;
  return found;
}

export function registerRoutes(router: Router): void {
  // First: `/api/plugins/-/...` must never reach a `:id` route.
  registerInstallRoutes(router);
  registerDeveloperModeRoutes(router);
  registerProviderRoutes(router);
  registerAcpRegistryRoutes(router);

  router.get('/api/plugins', (req, res) => {
    const viewer = viewerFromRequest(req);
    res.json({ plugins: filterGallery(galleryPlugins(loaderFromApp(req.app)), viewer) });
  });

  router.get('/api/plugins/:id', (req, res) => {
    const raw = req.params.id;
    const id = resolveId(typeof raw === 'string' ? raw : '');
    const found = visiblePlugin(req, id);
    if (!found) {
      res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
      return;
    }
    res.json(found);
  });

  /**
   * `GET /api/plugins/:id/-/usage` — LLM quotas for the BROWSER half of a
   * plugin (§10.15, `clientCtx.usage`).
   *
   * The `-` segment is reserved for the platform: it carries the capabilities a
   * plugin's client gets without having a host half (a lone widget has
   * no `ctx.router()` to put this route on). A plugin must therefore never
   * declare a route starting with `/-/` — it would be shadowed by this one,
   * registered before the plugin routers are mounted.
   *
   * Two locks, in this order: the M.4 curtain (an invisible plugin does not
   * confirm it exists → 404), then the manifest's `usage:read` permission
   * (declared or not → 403). No token, no file path goes through: the
   * `UsageEntry` contract carries only usage rates.
   *
   * `?refresh=1`: a person's ↻, which skips the probes' cache
   * (floor `FORCED_PROBE_FLOOR_MS` per backend). Read AFTER both locks.
   */
  router.get('/api/plugins/:id/-/usage', async (req, res) => {
    const id = String(req.params.id ?? '');
    const status = loaderFromApp(req.app)?.list().find((p) => p.id === id);
    if (!status || status.state !== 'active' || !thirdPartyPluginVisible(viewerFromRequest(req), id)) {
      return void res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    }
    if (!status.manifest?.permissions.includes('usage:read')) {
      return void res.status(403).json({ error: `plugin \`${id}\`: permission \`usage:read\` is missing from the manifest` });
    }
    try {
      // The caller's subscription accounts only (TODO #330).
      res.json({ entries: await collectUsage(viewerFromRequest(req), req.query.refresh === '1' ? { force: true } : undefined) });
    } catch (error) {
      res.status(503).json({ error: (error as Error).message });
    }
  });

  /**
   * `GET /api/plugins/:id/-/dictation-models` — the `models` pack of an
   * active `kind: dictation` plugin (TODO #584): `{ pluginId, version, models }`.
   *
   * The desktop reads it itself, by plugin id, before its native box: the
   * entry the user confirms is the one the installed package ships, not one
   * a page of the shared realm wrote. Same curtain as `-/usage` (an invisible
   * or inactive plugin is a 404); no permission beyond `dictation:engine`,
   * which a dictation plugin cannot be admitted without.
   */
  router.get('/api/plugins/:id/-/dictation-models', (req, res) => {
    const id = String(req.params.id ?? '');
    const status = loaderFromApp(req.app)?.list().find((p) => p.id === id);
    if (!status || status.state !== 'active' || !thirdPartyPluginVisible(viewerFromRequest(req), id)) {
      return void res.status(404).json({ error: 'plugin inconnu' });
    }
    const pack = readDictationPack(status.dir, status.manifest);
    res.set('Cache-Control', 'no-store');
    if (!pack.ok) return void res.status(pack.code === 'no-pack' ? 404 : 422).json({ error: pack.code, message: pack.message });
    res.json({ pluginId: id, version: status.version, models: pack.models });
  });

  /**
   * `POST /api/plugins/:id/enabled` — the local gallery toggle (§10.12).
   *
   * Writes the wanted state into `timon.config.json`, exactly like
   * `timon plugin|module enable|disable`, then recomposes the tree — both
   * halves of the gallery are hot. For a third-party package the loader's watcher
   * recomposes; for a bundled module, the recomposition is
   * awaited here so that the read that follows already tells the truth.
   *
   * A refused package (`skipped:*`) can always be toggled: the config says what
   * the user wants, not what the daemon accepts. The gallery, for its part,
   * greys out the toggle and shows `reason`.
   */
  router.post('/api/plugins/:id/enabled', async (req, res) => {
    // Express decodes scoped ids; legacy aliases remain supported.
    const parsedId = toggleIdSchema.safeParse(req.params.id);
    if (!parsedId.success) return void res.status(400).json({ error: '`id` must be a non-empty string' });
    const parsedBody = toggleBodySchema.safeParse(req.body);
    if (!parsedBody.success) return void res.status(400).json({ error: '`enabled` must be a boolean' });
    const target = resolveToggleTarget(parsedId.data);
    const { id } = target;
    const { enabled } = parsedBody.data;
    try { assertToggleMutable(target); }
    catch (err) { if (err instanceof LicenseCapabilityError) { res.status(403).json({ error: err.code, message: err.message }); return; } throw err; }

    if (target.module) {
      // audit CLI/MCP P2-7: this branch had NO guard — any session, employee or mission
      // token could toggle a bundled module (Timon's own code, but still a
      // config write that recomposes the daemon). `plugins:manage` is the same
      // gate as the gallery lists ("install, enable and disable plugins");
      // unlike the third-party branch below it is not superadmin-only, because
      // a bundled module runs no third-party code in the daemon's process.
      if (rejectIfDenied(req, res, 'plugins:manage')) return;
      try {
        await applyToggle(req.app, target, enabled);
      } catch (err) {
        if (err instanceof CoreModuleError) return void res.status(403).json({ error: err.message });
        throw err;
      }
      return void res.json({ ok: true, id, enabled });
    }

    // secu-5: activating a THIRD-PARTY plugin is a superadmin gesture. A
    // loaded plugin runs in the daemon's process (SECURITY.md §9: it is T1 in
    // practice), so turning one on is equivalent to running its code as the
    // operator — not something a delegated admin decides. Bundled modules keep
    // their own path above: they are Timon's own code, already installed.
    // Unauthenticated requests fall through, like every other guard: that hole
    // only exists while the users table is empty (first run).
    if (rejectIfNotSuperadmin(req, res)) return;

    if (!(await applyToggle(req.app, target, enabled))) return void res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    res.json({ ok: true, id, enabled });
  });

  router.get('/api/plugins/:id/settings', (req, res) => {
    const id = String(req.params.id ?? '');
    if (!visiblePlugin(req, id)) return void res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    const status = loaderFromApp(req.app)?.list().find((p) => p.id === id);
    if (!status?.manifest) return void res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    res.json({ id, settings: status.manifest.settings.map((setting) => settingStatus(id, setting)) });
  });

  router.put('/api/plugins/:id/settings', (req, res) => {
    const id = String(req.params.id ?? '');
    if (!visiblePlugin(req, id)) return void res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    const status = loaderFromApp(req.app)?.list().find((p) => p.id === id);
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    const setting = status?.manifest?.settings.find((candidate) => candidate.key === key);
    if (!setting) return void res.status(400).json({ error: 'undeclared setting' });
    const value: unknown = req.body?.value;
    const valid = setting.type === 'string' || setting.type === 'secret' ? typeof value === 'string'
      : setting.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === 'boolean';
    if (!valid) return void res.status(400).json({ error: `invalid ${setting.type} value` });
    const json = JSON.stringify(value);
    const kvKey = settingKvKey(key);
    // Type `secret` is sealed with the vault envelope. `settingStatus` still
    // returns `''` — the UI never sees the value, at rest or on the wire.
    dbApi.pluginKvSet(id, kvKey, setting.type === 'secret' ? sealPluginKvValue(id, kvKey, json) : json);
    res.json({ ok: true, configured: true });
  });

  /**
   * The webhooks a visible plugin declares and the package on disk under its
   * id, `null` when it is not visible. A secret is bound to that package.
   */
  const declaredWebhooks = (req: Request, id: string): { decls: PluginWebhookDecl[]; publisher: PluginWebhookPublisher } | null => {
    if (!visiblePlugin(req, id)) return null;
    const status = loaderFromApp(req.app)?.list().find((p) => p.id === id);
    if (!status?.manifest) return null;
    return { decls: status.manifest.webhooks ?? [], publisher: webhookPublisherOf(status) };
  };
  const paramOf = (req: Request, key: string): string => String(req.params[key] ?? '');

  router.get('/api/plugins/:id/-/webhooks', (req, res) => {
    const id = paramOf(req, 'id');
    const declared = declaredWebhooks(req, id);
    if (!declared) return void res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ id, webhooks: declared.decls.map((w) => pluginWebhookStatus(id, w.name, w.auth, declared.publisher)) });
  });

  // Generating a secret opens a public entry into the plugin's code, run as
  // the generating account: a superadmin gesture, like enabling the plugin.
  router.post('/api/plugins/:id/-/webhooks/:name/secret', (req, res) => {
    if (rejectIfNotSuperadmin(req, res)) return;
    const id = paramOf(req, 'id');
    const name = paramOf(req, 'name');
    const declared = declaredWebhooks(req, id);
    if (!declared) return void res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    const { publisher } = declared;
    const decl = declared.decls.find((w) => w.name === name);
    if (!decl) return void res.status(404).json({ error: 'webhook not declared' });
    const body = rotateBodySchema.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: '`keepPrevious` must be a boolean' });
    let secret: string;
    try {
      secret = rotatePluginWebhookSecret(id, name, req.auth?.user?.id ?? null, publisher, { keepPrevious: body.data.keepPrevious, auth: decl.auth });
    } catch (err) {
      if (err instanceof PluginWebhookSecretError) return void res.status(400).json({ error: err.message });
      console.warn(`[plugins] ${id}/${name}: webhook secret not stored — ${(err as Error).message}`);
      return void res.status(503).json(apiError('vault_unavailable', 'secrets vault unavailable'));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ secret, webhook: pluginWebhookStatus(id, name, decl.auth, publisher) });
  });

  // The secret a service makes itself (Stripe, Slack, a Discord public key…)
  // is pasted here. A browser session of a superadmin only: neither the
  // daemon token nor a mission token may plant the key that authenticates a
  // public entry into a plugin. The value is never echoed nor logged.
  router.post('/api/plugins/:id/-/webhooks/:name/provided-secret', (req, res) => {
    if (!isPersonAuth(req.auth) || !req.auth.isSuperadmin) {
      return void forbidden(req, res, {
        kind: 'operator',
        reason: 'only a superadmin signed in to the app may set a webhook secret',
        hint: 'paste it from Settings › Plugins in the app',
      });
    }
    const id = paramOf(req, 'id');
    const name = paramOf(req, 'name');
    const declared = declaredWebhooks(req, id);
    if (!declared) return void res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    const { publisher } = declared;
    const decl = declared.decls.find((w) => w.name === name);
    if (!decl) return void res.status(404).json({ error: 'webhook not declared' });
    const body = provideBodySchema.safeParse(req.body ?? {});
    // zod's issues would quote the input: a fixed message instead.
    if (!body.success) return void res.status(400).json({ error: 'expected `{ secret: string, keepPrevious?: boolean }`' });
    let verifyToken: string | null;
    try {
      ({ verifyToken } = setPluginWebhookSecret(id, name, req.auth.user?.id ?? null, publisher, body.data.secret, {
        keepPrevious: body.data.keepPrevious, auth: decl.auth,
      }));
    } catch (err) {
      if (err instanceof PluginWebhookSecretError) return void res.status(400).json({ error: err.message });
      console.warn(`[plugins] ${id}/${name}: webhook secret not stored — ${(err as Error).message}`);
      return void res.status(503).json(apiError('vault_unavailable', 'secrets vault unavailable'));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ ...(verifyToken ? { verifyToken } : {}), webhook: pluginWebhookStatus(id, name, decl.auth, publisher) });
  });

  router.post('/api/plugins/:id/-/webhooks/:name/revoke-previous', (req, res) => {
    if (rejectIfNotSuperadmin(req, res)) return;
    const id = paramOf(req, 'id');
    const name = paramOf(req, 'name');
    const declared = declaredWebhooks(req, id);
    const decl = declared?.decls.find((w) => w.name === name);
    if (!declared || !decl) return void res.status(404).json({ error: 'webhook not declared' });
    const revoked = revokePreviousPluginWebhookSecret(id, name);
    res.json({ ok: true, revoked, webhook: pluginWebhookStatus(id, name, decl.auth, declared.publisher) });
  });

  // Mounted at the root: the public URL is `/plugins/<id>/client.js`, outside
  // `/api` — it is an asset. `req.app` reads again the loader hooked by boot.ts.
  // The second argument returns the RESOLVED identity of the id (T.5): `layout:<short>`
  // must only open an asset if the package really is `kind: layout`, and
  // it is the loader — not the permission — that knows it.
  router.use(bundleRouter((req) => loaderFromApp(req.app)?.bundles ?? null, pluginKindsOf));
  // Same for the covers: `/plugins/<id>/cover`, outside `/api`.
  router.use(coverRouter((req) => loaderFromApp(req.app)?.covers ?? null, pluginKindsOf));
}
