/**
 * The gallery's "Install a plugin" flow (TODO #332), over
 * `plugins/install-sources.ts`:
 *
 *   GET    /api/plugins/-/install/candidates      packages dropped in ~/.timon/plugins, not installed
 *   POST   /api/plugins/-/install/stage           { source: 'path', path } | { source: 'detected', name } → preview
 *   POST   /api/plugins/-/install/upload          raw .tgz or .zip bytes → preview (sniffed, never the name/MIME)
 *   POST   /api/plugins/-/install/confirm         { token, confirm: true, authorizeExec?, authorizeExecChildren?, vault?, vaultChildren? } → `addPlugin`
 *   DELETE /api/plugins/-/install/staged/:token   drop a preview
 *
 * Every route is for a superadmin SIGNED IN TO THE APP, and nobody else: an
 * installed plugin runs inside the daemon with the operator's rights
 * (SECURITY.md §10.1). Not the daemon token, not a mission token even when its
 * launcher is a superadmin — the terminal keeps `timon plugin add`, an agent
 * gets no new door to load code. Anonymous is 401 even on a loopback without
 * auth: the first-run hole of `rejectIfNotSuperadmin` does not apply here.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { LicenseCapabilityError } from '../../license/capabilities.js';
import { PLUGIN_INSTALL_PREFIX, PLUGIN_UPLOAD_MAX_BYTES } from '../../plugins/install-path.js';
import { MAX_BUNDLE_CHILDREN, PluginInstallSources, PluginSourceError } from '../../plugins/install-sources.js';
import { PluginEngineError, heldForWhiteLabel } from '../../plugins/install.js';
import { whiteLabelAllowed } from '../../license/capabilities.js';
import { licenseState } from '../../license/runtime.js';
import { forbidden, isPersonAuth } from '../../users/identity.js';

const KEY = 'timon.pluginInstallSources';

type AppStore = { get(key: string): unknown; set(key: string, value: unknown): unknown };

/** Tests attach their own (temporary roots, fake npm); the daemon gets the default lazily. */
export function attachPluginInstallSources(app: AppStore, sources: PluginInstallSources): void {
  app.set(KEY, sources);
}

function sourcesOf(app: AppStore): PluginInstallSources {
  const existing: unknown = app.get(KEY);
  if (existing instanceof PluginInstallSources) return existing;
  const created = new PluginInstallSources();
  app.set(KEY, created);
  return created;
}

const stageSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('path'), path: z.string().min(1).max(4096) }).strict(),
  // An entry name of the drop folder, never a path.
  z.object({ source: z.literal('detected'), name: z.string().min(1).max(255).regex(/^[^/\\\0]+$/).refine((n) => n !== '.' && n !== '..') }).strict(),
]);
const vaultSecretLines = z.array(z.object({
  name: z.string().min(1).max(128),
  mode: z.enum(['read', 'broker']),
  state: z.enum(['granted', 'grantable', 'missing', 'ambiguous', 'vault-off']),
  grant: z.boolean(),
}).strict()).max(20);
const vaultHostLines = z.array(z.object({
  host: z.string().min(1).max(255),
  allowedBy: z.enum(['global', 'plugin']).nullable(),
  grant: z.boolean(),
}).strict()).max(20);
const confirmSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{48}$/),
  confirm: z.literal(true),
  /** A provider: the resolved binary paths the superadmin was shown and accepted. */
  authorizeExec: z.array(z.string().min(1).max(4096)).max(8).optional(),
  /**
   * A bundle: the same paths, for each provider of the preview's `children` whose
   * programs were accepted (TODO #673). A child left out is authorized later, if at all.
   */
  authorizeExecChildren: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{3,40}$/),
    pkg: z.string().min(1).max(214),
    version: z.string().min(1).max(256),
    paths: z.array(z.string().min(1).max(4096)).max(8),
  }).strict()).max(MAX_BUNDLE_CHILDREN).optional(),
  /**
   * The preview's `vault` lines, each as it was shown, and whether it was ticked
   * (TODO #599). Bounds are the manifest's own (20 secrets, 20 hosts).
   */
  vault: z.object({ secrets: vaultSecretLines, hosts: vaultHostLines }).strict().optional(),
  /**
   * A bundle: the same lines for each child of the preview's `children` that
   * names something (TODO #660). Absent: nothing is granted to any child.
   */
  vaultChildren: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{3,40}$/),
    pkg: z.string().min(1).max(214),
    version: z.string().min(1).max(256),
    secrets: vaultSecretLines,
    hosts: vaultHostLines,
  }).strict()).max(MAX_BUNDLE_CHILDREN).optional(),
}).strict();
const tokenSchema = z.string().regex(/^[a-f0-9]{48}$/);

export function requireAppSuperadmin(req: Request, res: Response): boolean {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  if (!isPersonAuth(req.auth) || !req.auth.isSuperadmin) {
    forbidden(req, res, {
      kind: 'operator',
      reason: 'only a superadmin signed in to the app may install a plugin from the gallery',
      hint: 'from a terminal, use `timon plugin add <folder|archive>`',
    });
    return false;
  }
  return true;
}

function sendError(res: Response, err: unknown, context: string): void {
  if (err instanceof PluginSourceError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof LicenseCapabilityError) {
    res.status(403).json({ error: err.code, message: err.message });
    return;
  }
  // The message names Node versions and the package, nothing of the machine's folders.
  if (err instanceof PluginEngineError) {
    res.status(422).json({ error: 'node-engine', message: err.message });
    return;
  }
  // npm's stderr names folders of this machine: logged, never sent back.
  const message = (err as Error).message ?? String(err);
  console.warn(`[plugins] ${context}: ${message}`);
  const npmMissing = (err as { code?: string }).code === 'ENOENT' || /\bnpm\b.*(not found|ENOENT)/i.test(message);
  res.status(npmMissing ? 503 : 500).json(npmMissing
    ? { error: 'npm-missing', message: 'npm is not available on this machine — install Node.js, then try again' }
    : { error: 'install-failed', message: 'the plugin could not be installed — the daemon log has the details' });
}

export function registerInstallRoutes(router: Router): void {
  const raw = express.raw({ type: () => true, limit: PLUGIN_UPLOAD_MAX_BYTES, inflate: false });

  router.get(`${PLUGIN_INSTALL_PREFIX}/candidates`, (req, res) => {
    if (!requireAppSuperadmin(req, res)) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ candidates: sourcesOf(req.app).candidates() });
    } catch (err) { sendError(res, err, 'candidates'); }
  });

  router.post(`${PLUGIN_INSTALL_PREFIX}/stage`, (req, res) => {
    if (!requireAppSuperadmin(req, res)) return;
    const body = stageSchema.safeParse(req.body ?? {});
    // zod's issues would quote the path back: a fixed message instead.
    if (!body.success) return void res.status(400).json({ error: 'invalid-body', message: "expected `{ source: 'path', path }` or `{ source: 'detected', name }`" });
    try {
      const sources = sourcesOf(req.app);
      const preview = body.data.source === 'path' ? sources.stagePath(body.data.path) : sources.stageDetected(body.data.name);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(preview);
    } catch (err) { sendError(res, err, 'stage'); }
  });

  // Auth BEFORE the body is read: an anonymous 25 MB upload is never buffered.
  router.post(`${PLUGIN_INSTALL_PREFIX}/upload`, (req, res) => {
    if (!requireAppSuperadmin(req, res)) return;
    raw(req, res, (err?: unknown) => {
      if (err) {
        const status = (err as { status?: number }).status;
        if (status === 413) return void res.status(413).json({ error: 'too-large', message: 'archive is larger than the allowed size' });
        return void res.status(400).json({ error: 'invalid-body', message: 'could not read the uploaded archive' });
      }
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return void res.status(400).json({ error: 'invalid-body', message: 'expected the archive bytes (application/octet-stream)' });
      }
      try {
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json(sourcesOf(req.app).stageUpload(body));
      } catch (e) { sendError(res, e, 'upload'); }
    });
  });

  router.post(`${PLUGIN_INSTALL_PREFIX}/confirm`, async (req, res) => {
    if (!requireAppSuperadmin(req, res)) return;
    const body = confirmSchema.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: 'invalid-body', message: 'expected `{ token, confirm: true, authorizeExec?: string[], authorizeExecChildren?: [{ id, pkg, version, paths }], vault?: { secrets, hosts }, vaultChildren?: [{ id, pkg, version, secrets, hosts }] }`' });
    try {
      const result = await sourcesOf(req.app).installStaged(body.data.token, {
        authorizeExec: body.data.authorizeExec,
        authorizeExecChildren: body.data.authorizeExecChildren,
        vault: body.data.vault,
        vaultChildren: body.data.vaultChildren,
      });
      // Installed with its permissions agreed, but held back until the licence
      // includes White Label: said like a refusal, or the install card would
      // announce as done a layout the interface never shows.
      const heldBack = result.refused === null && result.manifest !== null
        && heldForWhiteLabel(result.manifest, () => whiteLabelAllowed(licenseState()));
      res.json({
        ok: result.refused === null && !heldBack,
        id: result.id,
        pkg: result.pkg,
        version: result.version,
        refused: heldBack ? 'skipped:unlicensed' : result.refused,
        signature: result.signature.ok ? { state: 'signed', keyId: result.signature.keyId } : { state: result.signature.code },
        children: result.children.map((c) => ({ id: c.id, state: c.state })),
        /** Secrets granted to `agent:plugin:<id>` and hosts opened to it by this click. */
        vault: result.vaultGranted,
        /** Child by child, what this click granted — or why it granted nothing. `null` without `vaultChildren`. */
        vaultChildren: result.vaultChildren,
        /** Child by child, the programs this click allowlisted — or why it allowlisted none. `null` without `authorizeExecChildren`. */
        authorizeExecChildren: result.authorizeExecChildren,
      });
    } catch (err) { sendError(res, err, 'install'); }
  });

  router.delete(`${PLUGIN_INSTALL_PREFIX}/staged/:token`, (req, res) => {
    if (!requireAppSuperadmin(req, res)) return;
    const token = tokenSchema.safeParse(req.params.token);
    if (!token.success) return void res.status(400).json({ error: 'invalid-token' });
    sourcesOf(req.app).discard(token.data);
    res.status(204).end();
  });
}
