/**
 * Module `kanban-code` — the "code" half of the Kanban: git worktrees per task,
 * integration. Tier `dev`, requires the `git` binary.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4). The project's git
 * routes (status, checkout, remote, an agent's repo) moved to `@timon/git`
 * (TODO #275).
 *
 * Every route here writes (TODO #787): identity 401, `kanban:write` 403, a
 * strict body 400, then a task the caller cannot see 404 — the order of the
 * task routes, so a refused caller learns neither the shape nor the task.
 */
import type { Response, Router } from 'express';
import { dbApi } from '../../db.js';
import { scopedDb } from '../../users/scoped-db.js';
import { createTaskWorktree, detachTaskWorktree, disposeTaskWorktree, WorktreeServiceError } from '../../worktree-service.js';
import { rejectIfDenied, requireAuth, viewerFromRequest } from '../../users/identity.js';
import { isOwnMissionTask } from '../kanban/own-task.js';
import { mergeCloseRefusal, pullRequestCloseRefusal } from '../kanban/routes.js';
import { parseEmptyBody, parseMergedShaBody, parseWorktreeCreateBody } from '../kanban/task-write-bodies.js';
import { apiError } from '../../api-error.js';

export function registerRoutes(app: Router): void {
  const answer = (res: Response, err: unknown): void => {
    if (!(err instanceof WorktreeServiceError)) throw err;
    // One literal per code: the translation check reads them.
    if (err.code === 'busy') res.status(409).json(apiError('worktree_busy', err.message));
    else if (err.code === 'invalid') res.status(400).json(apiError('worktree_invalid', err.message, { detail: err.message }));
    else res.status(500).json(apiError('worktree_failed', err.message, { detail: err.message }));
  };

  app.post('/api/tasks/:id/worktree', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const parsed = parseWorktreeCreateBody(req.body);
    if (!parsed.ok) { res.status(400).json(apiError('task_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const task = scopedDb(viewerFromRequest(req)).getTask(req.params.id);
    if (!task) { res.status(404).json(apiError('not_found', 'not found')); return; }
    const base = parsed.value.base;
    try {
      res.json({ worktree: await createTaskWorktree(task, base) });
    } catch (err) { answer(res, err); }
  });

  app.delete('/api/tasks/:id/worktree', async (req, res) => {
    if (!requireAuth(req, res)) return;
    // A merger disposes of its own worktree as part of closing (the
    // `timon-worktree` skill runs `timon worktree dispose` before or after
    // `timon task done`): its own task needs no `kanban:write`, like the close.
    if (!isOwnMissionTask(req, req.params.id) && rejectIfDenied(req, res, 'kanban:write')) return;
    const task = scopedDb(viewerFromRequest(req)).getTask(req.params.id);
    if (!task) { res.status(404).json(apiError('not_found', 'not found')); return; }
    const force = req.query.force === '1' || req.query.force === 'true';
    try {
      // Idempotent: no worktree to dispose is fine (`disposed: false`).
      res.json({ ok: true, ...(await disposeTaskWorktree(task, force)) });
    } catch (err) { answer(res, err); }
  });

  // TIM-0113 — the board's "Detach the worktree": folder removed, branch kept.
  app.post('/api/tasks/:id/worktree/detach', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const parsed = parseEmptyBody(req.body);
    if (!parsed.ok) { res.status(400).json(apiError('task_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const task = scopedDb(viewerFromRequest(req)).getTask(req.params.id);
    if (!task) { res.status(404).json(apiError('task_not_found', 'Task not found.')); return; }
    try {
      res.json({ ok: true, ...(await detachTaskWorktree(task)) });
    } catch (err) { answer(res, err); }
  });

  app.post('/api/tasks/:id/merged-sha', (req, res) => {
    if (!requireAuth(req, res)) return;
    // `timon task done --merged-sha` records the sha here before its closing
    // PUT: a mission may do it on the task it runs, like the closing itself.
    if (!isOwnMissionTask(req, req.params.id) && rejectIfDenied(req, res, 'kanban:write')) return;
    const parsed = parseMergedShaBody(req.body);
    if (!parsed.ok) { res.status(400).json(apiError('task_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const scope = scopedDb(viewerFromRequest(req));
    const task = scope.getTask(req.params.id);
    if (!task) { res.status(404).json(apiError('not_found', 'not found')); return; }
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
      res.status(400).json(apiError('sha_invalid', 'sha (7-40 hex chars) required'));
      return;
    }
    // `timon task done --merged-sha` records here first: a merge that is not
    // proven is refused before a wrong sha lands on the task (TODO #1012).
    // The sha of a PR task is the tip it published: none before `pr open`.
    const prRefusal = pullRequestCloseRefusal(task);
    if (prRefusal) { res.status(409).json(apiError('pr_not_opened', prRefusal, { detail: prRefusal })); return; }
    const refusal = mergeCloseRefusal(task, sha);
    if (refusal) { res.status(409).json(apiError('merge_not_proven', refusal, { detail: refusal })); return; }
    dbApi.setTaskMergedSha(task.id, sha);
    res.json({ task: scope.getTask(task.id) });
  });
}
