/**
 * Developer mode, the Settings › Plugins switch:
 *
 *   GET /api/plugins/-/developer   → `DeveloperModeState`
 *   PUT /api/plugins/-/developer   { enabled: boolean } → `DeveloperModeState`
 *
 * Writes `developer.unsignedPlugins` into `timon.config.json`, then recomposes
 * the third-party tree before answering: an unsigned plugin already installed
 * mounts when the mode goes on and unmounts when it goes off, without a
 * restart, and the answer already tells the truth.
 *
 * Same gate as the install routes, for the same reason: what this switch opens
 * is unsigned code running in the daemon's process with the operator's rights
 * (SECURITY.md §9). A superadmin SIGNED IN TO THE APP only — not the daemon
 * token, not a mission token even when its launcher is a superadmin: an agent
 * must not be able to admit the plugin it has just written. Anonymous is 401,
 * first run included.
 */
import type { Router } from 'express';
import { z } from 'zod';
import { LicenseCapabilityError } from '../../license/capabilities.js';
import { developerModeState, setUnsignedPluginsSetting } from '../../plugins/install.js';
import { loaderFromApp } from '../../plugins/runtime.js';
import { auditRequest } from '../../users/audit-actor.js';
import { requireAppSuperadmin } from './install-routes.js';

export const DEVELOPER_MODE_PATH = '/api/plugins/-/developer';

const bodySchema = z.object({ enabled: z.boolean() }).strict();

export function registerDeveloperModeRoutes(router: Router): void {
  router.get(DEVELOPER_MODE_PATH, (req, res) => {
    if (!requireAppSuperadmin(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(developerModeState());
  });

  router.put(DEVELOPER_MODE_PATH, async (req, res) => {
    if (!requireAppSuperadmin(req, res)) return;
    const body = bodySchema.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: 'invalid-body', message: 'expected `{ enabled: boolean }`' });
    const { enabled } = body.data;
    try {
      setUnsignedPluginsSetting(enabled);
    } catch (err) {
      if (err instanceof LicenseCapabilityError) return void res.status(403).json({ error: err.code, message: err.message });
      throw err;
    }
    auditRequest(req, enabled ? 'plugins.developer-mode.on' : 'plugins.developer-mode.off', null);
    // Awaited, unlike the config watcher's pass: the Settings switch and the
    // install sheet read the state right after, and must not see the old tree.
    try {
      await loaderFromApp(req.app)?.update();
    } catch (err) {
      console.warn(`[plugins] developer mode: live recomposition failed — ${(err as Error).message}`);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(developerModeState());
  });
}
