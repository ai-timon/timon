/**
 * Module `docker-supervision` — state and control of a project's containers.
 * Tier `dev`, requires the `containers` capability: without a usable Docker, these
 * routes can only return errors.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Router } from 'express';
import { rejectIfDenied, rejectUnlessAny } from '../../users/identity.js';
import { act as dockerAct, getStatus as getDockerStatus, isDockerAction, listStatuses as listDockerStatuses, rebuild as dockerRebuild } from '../../docker.js';
import { apiError } from '../../api-error.js';

/**
 * Reading follows the card of the chat (TODO #645) and the project cards of
 * `/agents`, which show the same status. Driving the containers is a project
 * edit, like pushing its code (TODO #525): seeing the card is not enough.
 */
const READ_DOCKER = ['projects:manage', 'widget:docker-supervision', 'plugin:@timon/docker-supervision', 'page:/agents'];

export function registerRoutes(app: Router): void {
  app.get('/api/docker', (req, res) => {
    if (rejectUnlessAny(req, res, READ_DOCKER)) return;
    try { res.json({ services: listDockerStatuses() }); }
    catch (err) { res.status(500).json(apiError('docker_status_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.get('/api/docker/:slug', (req, res) => {
    if (rejectUnlessAny(req, res, READ_DOCKER)) return;
    try { res.json({ docker: getDockerStatus(req.params.slug) }); }
    catch (err) { res.status(400).json(apiError('docker_status_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/docker/:slug/rebuild', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const body = (req.body ?? {}) as { container?: unknown };
    const target = typeof body.container === 'string' && body.container ? body.container : undefined;
    try {
      dockerRebuild(req.params.slug, target);
      res.json({ started: true });
    } catch (err) { res.status(400).json(apiError('docker_rebuild_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/docker/:slug/:action', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const { action } = req.params;
    if (!isDockerAction(action)) {
      res.status(400).json(apiError('docker_action_invalid', 'action must be start|stop|restart'));
      return;
    }
    const body = (req.body ?? {}) as { container?: unknown };
    const target = typeof body.container === 'string' && body.container ? body.container : undefined;
    try { res.json({ docker: dockerAct(req.params.slug, action, target) }); }
    catch (err) { res.status(400).json(apiError('docker_action_failed', (err as Error).message, { detail: (err as Error).message })); }
  });
}
