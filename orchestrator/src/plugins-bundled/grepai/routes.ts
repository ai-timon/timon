/**
 * Module `grepai` — local semantic index per project, and its watchers.
 * Tier `dev`, requires the `grepai` binary and `systemd` (the watchers run
 * as transient units, outside the daemon's cgroup).
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Router } from 'express';
import { rejectIfDenied, rejectUnlessAny } from '../../users/identity.js';
import { getStatus as getGrepaiStatus, initProject as initGrepaiProject, listStatuses as listGrepaiStatuses, rebuildProject as rebuildGrepaiProject, startWatcher as startGrepaiWatcher, stopWatcher as stopGrepaiWatcher, tailWatcherLog as tailGrepaiLog } from '../../grepai.js';
import { apiError } from '../../api-error.js';

/**
 * Reading follows the card of the chat (TODO #645) and the project cards of
 * `/agents`, which show the same status. Driving the watchers is a project
 * edit, like pushing its code (TODO #525): seeing the card is not enough.
 */
const READ_GREPAI = ['projects:manage', 'widget:grepai', 'plugin:@timon/grepai', 'page:/agents'];

export function registerRoutes(app: Router): void {
  app.get('/api/grepai', (req, res) => {
    if (rejectUnlessAny(req, res, READ_GREPAI)) return;
    try { res.json({ watchers: listGrepaiStatuses() }); }
    catch (err) { res.status(500).json(apiError('grepai_status_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.get('/api/grepai/:slug', (req, res) => {
    if (rejectUnlessAny(req, res, READ_GREPAI)) return;
    try { res.json({ watcher: getGrepaiStatus(req.params.slug), log: tailGrepaiLog(req.params.slug) }); }
    catch (err) { res.status(400).json(apiError('grepai_status_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/grepai/:slug/start', async (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try { res.json({ watcher: await startGrepaiWatcher(req.params.slug) }); }
    catch (err) { res.status(400).json(apiError('grepai_start_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/grepai/:slug/init', async (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try { res.json({ watcher: await initGrepaiProject(req.params.slug) }); }
    catch (err) { res.status(400).json(apiError('grepai_init_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/grepai/:slug/rebuild', async (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try { res.json({ watcher: await rebuildGrepaiProject(req.params.slug) }); }
    catch (err) { res.status(400).json(apiError('grepai_rebuild_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/grepai/:slug/stop', async (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try { res.json({ watcher: await stopGrepaiWatcher(req.params.slug) }); }
    catch (err) { res.status(400).json(apiError('grepai_stop_failed', (err as Error).message, { detail: (err as Error).message })); }
  });
}
