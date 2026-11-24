/**
 * Module `browser-embedded` — a Chromium browser per project (persistent
 * profile, remote desktop through Traefik). Tier `opt`, requires `containers` AND
 * `traefik`: the desktop proxy has no equivalent without them.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Request, Response, Router } from 'express';
import { dbApi } from '../../db.js';
import { getBrowserSession, listBrowserSessions, startBrowserSession, stopBrowserSession } from '../../browser-sessions.js';
import { viewerFromRequest } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import { apiError } from '../../api-error.js';

/** A fixed native assignment (including explicit "none") must never expose
 * another browser's CDP URL or let an agent fall back to legacy credentials. */
function rejectBoundMission(req: Request, res: Response): boolean {
  const mission = req.auth?.missionId ? scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId) : null;
  if (!mission?.browser_profile_resolved) return false;
  res.status(403).json(apiError('browser_profile_bound', 'This mission may only use its assigned browser profile through the managed browser API.'));
  return true;
}

export function registerRoutes(app: Router): void {
  app.get('/api/browser', (req, res) => {
    if (rejectBoundMission(req, res)) return;
    try { res.json({ sessions: listBrowserSessions(viewerFromRequest(req)) }); }
    catch (err) { res.status(500).json(apiError('browser_sessions_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.get('/api/browser/:slug/status', (req, res) => {
    if (rejectBoundMission(req, res)) return;
    try { res.json({ session: getBrowserSession(req.params.slug, viewerFromRequest(req)) }); }
    catch (err) { res.status(400).json(apiError('browser_session_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/browser/:slug/start', async (req, res) => {
    if (rejectBoundMission(req, res)) return;
    try {
      const viewer = viewerFromRequest(req);
      if (scopedDb(viewer).browserSessionAccess(req.params.slug) === 'forbidden') {
        res.status(404).json(apiError('not_found', 'not found'));
        return;
      }
      res.json({ session: await startBrowserSession(req.params.slug, viewer) });
    } catch (err) { res.status(400).json(apiError('browser_start_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/browser/:slug/stop', async (req, res) => {
    if (rejectBoundMission(req, res)) return;
    try {
      const viewer = viewerFromRequest(req);
      if (scopedDb(viewer).browserSessionAccess(req.params.slug) === 'forbidden') {
        res.status(404).json(apiError('not_found', 'not found'));
        return;
      }
      await stopBrowserSession(req.params.slug);
      res.json({ session: getBrowserSession(req.params.slug, viewer) });
    } catch (err) { res.status(400).json(apiError('browser_stop_failed', (err as Error).message, { detail: (err as Error).message })); }
  });
}
