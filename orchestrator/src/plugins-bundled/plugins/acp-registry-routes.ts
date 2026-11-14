/**
 * The generic ACP provider's screen (`providers/acp-registry/service.ts`):
 *
 *   GET    /api/plugins/-/providers/acp-registry               the registry, what this machine can install, what is installed
 *   POST   /api/plugins/-/providers/acp-registry/install       { agentId, acceptUnverified? } install or update
 *   POST   /api/plugins/-/providers/acp-registry/:agentId/auth-methods   ask the installed agent how it signs in
 *   DELETE /api/plugins/-/providers/acp-registry/:agentId      uninstall
 *
 * Downloading a program the daemon will launch is the strongest thing a
 * browser can ask for here, so: a superadmin SIGNED IN TO THE APP, nobody else
 * (not the daemon token, not a mission token — an agent must not install the
 * program it will then be run by). Reading the sign-in methods starts the
 * agent's program, so it is a POST behind the same gate, with an empty body.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { acpRegistryService } from '../../providers/acp-registry/index.js';
import { AcpRegistryError } from '../../providers/acp-registry/service.js';
import { requireAppSuperadmin } from './install-routes.js';

const PREFIX = '/api/plugins/-/providers/acp-registry';
const agentId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const installBody = z.object({ agentId, acceptUnverified: z.boolean().optional() }).strict();
const emptyBody = z.object({}).strict();

function send(res: Response, err: unknown, context: string): void {
  if (err instanceof AcpRegistryError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  // File paths of this machine stay in the log.
  console.warn(`[acp-registry] ${context}: ${(err as Error).message}`);
  res.status(500).json({ error: 'failed', message: 'the operation failed — the daemon log has the details' });
}

export function registerAcpRegistryRoutes(router: Router): void {
  router.get(PREFIX, async (req: Request, res: Response) => {
    if (!requireAppSuperadmin(req, res)) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await acpRegistryService().list({ refresh: req.query.refresh === '1' }));
    } catch (err) { send(res, err, 'list'); }
  });

  router.post(`${PREFIX}/install`, async (req: Request, res: Response) => {
    if (!requireAppSuperadmin(req, res)) return;
    const body = installBody.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: 'invalid-body', message: 'expected `{ agentId, acceptUnverified? }`' });
    try {
      res.json({ agent: await acpRegistryService().install(body.data.agentId, { acceptUnverified: body.data.acceptUnverified }) });
    } catch (err) { send(res, err, 'install'); }
  });

  router.post(`${PREFIX}/:agentId/auth-methods`, async (req: Request, res: Response) => {
    if (!requireAppSuperadmin(req, res)) return;
    const id = agentId.safeParse(req.params.agentId);
    if (!id.success) return void res.status(400).json({ error: 'invalid-id' });
    if (!emptyBody.safeParse(req.body ?? {}).success) return void res.status(400).json({ error: 'invalid-body', message: 'expected an empty body' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await acpRegistryService().authMethods(id.data));
    } catch (err) { send(res, err, 'auth-methods'); }
  });

  router.delete(`${PREFIX}/:agentId`, async (req: Request, res: Response) => {
    if (!requireAppSuperadmin(req, res)) return;
    const id = agentId.safeParse(req.params.agentId);
    if (!id.success) return void res.status(400).json({ error: 'invalid-id' });
    try {
      await acpRegistryService().remove(id.data);
      res.status(204).end();
    } catch (err) { send(res, err, 'remove'); }
  });
}
