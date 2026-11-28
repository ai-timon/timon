/**
 * `POST /api/tasks/:id/push-branch` (`timon task push`, MCP `kanban_push_branch`):
 * the merger mission of merge task `:id` asks the daemon to push the branch of
 * one task of its project to a ticket branch of the remote
 * (`ticket-branch-push.ts` holds the rule).
 *
 * Authentication is required and the caller must be a mission token: the
 * mission is read from the token, never from the body, and the daemon token has
 * no mission, so it is refused. An anonymous request is refused before anything
 * is read.
 */
import type { Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { pushTicketBranch, type TicketPushDeps } from '../../ticket-branch-push-service.js';
import { auditRequest } from '../../users/audit-actor.js';
import { requireAuth } from '../../users/identity.js';

const Params = z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) });
const Body = z.object({
  branch: z.string().trim().min(1).max(200),
  source_task: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  set_upstream: z.boolean().optional(),
}).strict();

export function registerPushBranchRoutes(app: Router, deps: TicketPushDeps = {}): void {
  app.post('/api/tasks/:id/push-branch', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const params = Params.safeParse(req.params);
    const body = Body.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      const detail = 'a task id and a branch are required';
      res.status(400).json(apiError('ticket_push_refused', detail, { detail }));
      return;
    }
    if (auth.kind !== 'api-token' || !auth.missionId) {
      const detail = 'only the merger mission of the merge task can ask for this push';
      res.status(403).json(apiError('ticket_push_refused', detail, { detail }));
      return;
    }
    const out = await pushTicketBranch({
      missionId: auth.missionId,
      taskId: params.data.id,
      branch: body.data.branch,
      ...(body.data.source_task ? { sourceTask: body.data.source_task } : {}),
      ...(body.data.set_upstream ? { setUpstream: true } : {}),
    }, { audit: (action, target) => auditRequest(req, action, target), ...deps });
    if (out.ok) {
      res.json({ ok: true, remote: out.remote, branch: out.branch, source: out.source });
      return;
    }
    // Literal codes: the webview's message check reads them from the source.
    const detail = { detail: out.reason };
    res.status(out.status).json(out.code === 'push_failed' || out.code === 'push_rejected'
      ? apiError('ticket_push_failed', out.reason, detail)
      : apiError('ticket_push_refused', out.reason, detail));
  });
}
