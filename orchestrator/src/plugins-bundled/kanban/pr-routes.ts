/**
 * Open the pull request of a Kanban job (`pr-open.ts`), named by one of its
 * tasks (`POST /api/tasks/:id/pull-request`) or by its series
 * (`POST /api/series/:id/pull-request`). The CLI `timon pr open` and the MCP
 * tool `pr_open` call the first, then the second when no task has the id.
 *
 * Authentication is required, and `projects:manage`: the gesture pushes to
 * the remote of a project and writes on its forge with the account its
 * setting names. The daemon token passes, as for every project setting the
 * CLI and the agents write; an anonymous request never reaches the checks.
 *
 * `POST /api/series/:id/integration-branch` (`timon pr branch`, MCP
 * `pr_branch`) cuts the integration branch of a sequential job and gives its
 * pilot a worktree (`series-integration.ts`). It writes nothing on the forge:
 * `kanban:write`, what creating the job's first Kanban task would need for the
 * dispatcher to cut the same branch, and a series the caller can see.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { MAX_PLAN_BRANCH_CHARS } from '../../plan-landing.js';
import { openPullRequest, type PrOpenDeps, type PrOpenRefusalCode } from '../../pr-open.js';
import { prepareSeriesBranch, type SeriesBranchDeps, type SeriesBranchRefusalCode } from '../../series-integration.js';
import { resolveSeriesId, SeriesParamSchema, seriesVisibleTo } from '../../series-service.js';
import { auditRequest } from '../../users/audit-actor.js';
import { rejectIfDenied, requireAuth, viewerFromRequest } from '../../users/identity.js';

const PrOpenParams = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'a task or series id'),
});

const PrOpenBody = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(16_000).default(''),
}).strict();

const SeriesBranchBody = z.object({
  branch: z.string().trim().min(1).max(MAX_PLAN_BRANCH_CHARS),
}).strict();

function zodDetail(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

/** One literal per code, so the webview's messages can be checked against them.
 *  Also answers the landing gesture of a job that opens its pull request. */
export function refusalBody(code: PrOpenRefusalCode, reason: string) {
  const params = { detail: reason };
  switch (code) {
    case 'pr_target_not_found': return apiError('pr_target_not_found', reason, params);
    case 'pr_refused': return apiError('pr_refused', reason, params);
    case 'pr_open_busy': return apiError('pr_open_busy', reason, params);
    case 'pr_precheck_failed': return apiError('pr_precheck_failed', reason, params);
    case 'pr_push_failed': return apiError('pr_push_failed', reason, params);
    case 'pr_create_failed': return apiError('pr_create_failed', reason, params);
  }
}

/** One literal per code, so the webview's messages can be checked against them. */
function seriesBranchBody(code: SeriesBranchRefusalCode, reason: string) {
  const params = { detail: reason };
  switch (code) {
    case 'series_not_found': return apiError('series_not_found', reason);
    case 'series_branch_not_pr': return apiError('series_branch_not_pr', reason, params);
    case 'series_branch_refused': return apiError('series_branch_refused', reason, params);
    case 'series_branch_unavailable': return apiError('series_branch_unavailable', reason, params);
    case 'series_worktree_failed': return apiError('series_worktree_failed', reason, params);
  }
}

export function registerPrRoutes(app: Router, deps: PrOpenDeps & SeriesBranchDeps = {}): void {
  const handler = (target: 'task' | 'series') => async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const params = PrOpenParams.safeParse(req.params);
    const parsed = PrOpenBody.safeParse(req.body ?? {});
    if (!params.success || !parsed.success) {
      const detail = !params.success ? zodDetail(params.error) : !parsed.success ? zodDetail(parsed.error) : '';
      res.status(400).json(apiError('pr_request_invalid', detail, { detail }));
      return;
    }
    let out;
    try {
      out = await openPullRequest({ target, id: params.data.id, ...parsed.data }, deps);
    } catch (err) {
      // Not echoed: an unexpected failure may quote a path of this machine.
      console.error('[kanban] opening a pull request failed:', (err as Error).message);
      res.status(500).json(apiError('pr_request_failed', 'the pull request could not be opened'));
      return;
    }
    if (!out.ok) {
      res.status(out.status).json({
        ...refusalBody(out.code, out.reason),
        ...(out.checks ? { checks: out.checks } : {}),
      });
      return;
    }
    auditRequest(req, 'integration.pr_opened', `${out.repository}#${out.pr.number}`);
    res.json(out);
  };
  app.post('/api/tasks/:id/pull-request', handler('task'));
  app.post('/api/series/:id/pull-request', handler('series'));

  app.post('/api/series/:id/integration-branch', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const params = SeriesParamSchema.safeParse(req.params);
    const parsed = SeriesBranchBody.safeParse(req.body ?? {});
    if (!params.success || !parsed.success) {
      const detail = !params.success ? 'invalid series identifier' : !parsed.success ? zodDetail(parsed.error) : '';
      res.status(400).json(apiError('series_branch_invalid', detail, { detail }));
      return;
    }
    const seriesId = resolveSeriesId(params.data.id, req.header('X-TIMON-Mission') ?? undefined);
    // "Not found" rather than a refusal: a refusal would confirm the series exists.
    if (!seriesId || !seriesVisibleTo(viewerFromRequest(req), seriesId)) {
      res.status(404).json(apiError('series_not_found', 'series not found'));
      return;
    }
    let out;
    try {
      out = await prepareSeriesBranch(seriesId, parsed.data.branch, deps);
    } catch (err) {
      console.error('[kanban] preparing a series integration branch failed:', (err as Error).message);
      res.status(500).json(apiError('series_branch_failed', 'the integration branch could not be prepared'));
      return;
    }
    if (!out.ok) {
      res.status(out.status).json(seriesBranchBody(out.code, out.reason));
      return;
    }
    auditRequest(req, 'integration.series_branch', `${out.project}:${out.branch}`);
    res.json(out);
  });
}
