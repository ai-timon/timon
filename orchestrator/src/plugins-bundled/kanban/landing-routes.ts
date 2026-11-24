/**
 * The landing of Kanban jobs, as the island of the board reads it
 * (`integration-preview.ts`):
 *
 * - `GET  /api/kanban/landings[?project=…|series=…|todo=…]`: the jobs'
 *   integration branches and pull requests (`todo`: the jobs of one idea);
 * - `GET  /api/kanban/landings/:id`: one of them;
 * - `POST /api/kanban/landings/:id/checks`: reads the checks of its open pull
 *   request from the forge, at most about once a minute;
 * - `POST /api/kanban/landings/:id/preview`: commits, diff, conflict and the
 *   pull request's pre-checks run dry, before anything is pushed;
 * - `POST /api/kanban/landings/:id/repairs` (`{ kind }`): a person asks to fix
 *   the failing checks, the review comments or the conflict of the job's open
 *   pull request (`landing-repair.ts`): one `code` task, at most three per job.
 * - `POST /api/kanban/landings/:id/land` (`{ title?, body? }`): lands a job kept
 *   on its branch (`integration-land.ts`): merged into the local target in a
 *   project that merges locally, its pull request opened in one that lands
 *   through pull requests (the title is then required). `:id` is the job's id,
 *   or its series (`current` included) when the series has exactly one job.
 *   `projects:manage`, as opening a pull request: it moves the target branch,
 *   or pushes and writes on the forge. The daemon token passes: the CLI
 *   (`timon pr land`) and the MCP tool (`pr_land`) call it.
 *
 * Not under `/api/integrations`: that prefix belongs to the messaging
 * integrations of plugins (`/api/integrations/receipts`…).
 *
 * Every route needs a signed-in caller and reads through its scope: a job the
 * caller cannot see is "not found", like its series. The dry pre-checks also
 * need `projects:manage`, as opening the pull request does: they ask the
 * forge which account the project's credentials sign in as. The daemon token
 * passes, as on every Kanban read the CLI and the agents make.
 *
 * Asking for a repair needs a signed-in **person** holding `projects:manage`:
 * the daemon token, a mission's token and a plugin's are refused
 * (`person_required`), so no agent ever starts one, and nothing starts one on
 * its own.
 *
 * Every job comes with its `links` (`forge-links.ts`): its ideas, their issues
 * and the ones its pull request closes, its series and pilot mission, each
 * through the caller's scope; its `repairs`: how many were used, the one
 * under way, what the pull request's last known state calls for; and whether
 * the planner kept it on its branch (`kept`, `under_way`, `last_merge`), for
 * the widget's landing gesture.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { dbApi, type IntegrationRow } from '../../db.js';
import {
  integrationView, integrationVisibleTo, listIntegrationViews, previewIntegration, refreshIntegrationChecks,
  type PreviewDeps,
} from '../../integration-preview.js';
import { withJobLinks } from '../../forge-links.js';
import {
  isPrRefusal, landIntegrationBranch, withKeptState, type LandDeps, type LandRefusalCode,
} from '../../integration-land.js';
import { resolveSeriesId } from '../../series-service.js';
import { refusalBody as prRefusalBody } from './pr-routes.js';
import {
  REPAIR_KINDS, requestRepair, withRepairs, type RepairDeps, type RepairRefusalCode,
} from '../../landing-repair.js';
import { auditRequest } from '../../users/audit-actor.js';
import { isPersonAuth, rejectIfDenied, requestHasPermission, requireAuth, viewerFromRequest } from '../../users/identity.js';

const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'an id');

const ListQuery = z.object({
  project: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'a project slug').optional(),
  series: Id.optional(),
  todo: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

const PreviewBody = z.object({
  title: z.string().max(256).optional(),
  body: z.string().max(16_000).optional(),
}).strict();

const EmptyBody = z.object({}).strict();

const RepairBody = z.object({ kind: z.enum(REPAIR_KINDS) }).strict();

const LandBody = z.object({
  title: z.string().trim().min(1).max(256).optional(),
  body: z.string().max(16_000).optional(),
}).strict();

function zodDetail(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

function invalid(res: Response, detail: string): void {
  res.status(400).json(apiError('landing_request_invalid', detail, { detail }));
}

/** Auth and the row, through the caller's scope: answers the refusal itself
 *  and returns null when the request stops there. */
function landingForRoute(req: Request, res: Response): IntegrationRow | null {
  if (!requireAuth(req, res)) return null;
  const id = Id.safeParse(req.params.id);
  if (!id.success) { invalid(res, zodDetail(id.error)); return null; }
  const row = dbApi.getIntegrationById(id.data);
  if (!row || !integrationVisibleTo(viewerFromRequest(req), row)) {
    res.status(404).json(apiError('landing_not_found', 'no job with this id'));
    return null;
  }
  return row;
}

/** One literal per code, so the webview's messages can be checked against them. */
function repairRefusal(code: RepairRefusalCode, reason: string) {
  const params = { detail: reason };
  switch (code) {
    case 'landing_repair_refused': return apiError('landing_repair_refused', reason, params);
    case 'landing_repair_cap': return apiError('landing_repair_cap', reason, params);
    case 'landing_repair_busy': return apiError('landing_repair_busy', reason, params);
    case 'landing_repair_unavailable': return apiError('landing_repair_unavailable', reason, params);
  }
}

/** The row `:id` names for the landing gesture: the job itself, else the
 *  only job of the series it names, through the caller's scope. */
function landingToLand(req: Request, res: Response): IntegrationRow | null {
  const id = Id.safeParse(req.params.id);
  if (!id.success) { invalid(res, zodDetail(id.error)); return null; }
  const viewer = viewerFromRequest(req);
  const notFound = (): null => {
    res.status(404).json(apiError('landing_not_found', 'no job with this id'));
    return null;
  };
  const direct = dbApi.getIntegrationById(id.data);
  if (direct) return integrationVisibleTo(viewer, direct) ? direct : notFound();
  const seriesId = resolveSeriesId(id.data, req.header('X-TIMON-Mission') ?? undefined);
  const rows = seriesId ? dbApi.listIntegrationsBySeries(seriesId).filter((r) => integrationVisibleTo(viewer, r)) : [];
  if (rows.length === 0) return notFound();
  if (rows.length > 1) {
    const reason = `the series has several jobs (${rows.map((r) => r.branch).join(', ')}): land one by its id`;
    res.status(409).json(apiError('landing_refused', reason, { detail: reason }));
    return null;
  }
  return rows[0]!;
}

/** One literal per code, so the webview's messages can be checked against them. */
function landRefusal(code: LandRefusalCode, reason: string, files?: string[]) {
  const params = { detail: reason };
  const extra = files ? { files } : {};
  switch (code) {
    case 'landing_refused': return { ...apiError('landing_refused', reason, params), ...extra };
    case 'landing_busy': return { ...apiError('landing_busy', reason, params), ...extra };
    case 'landing_job_running': return { ...apiError('landing_job_running', reason, params), ...extra };
    case 'landing_conflict': return { ...apiError('landing_conflict', reason, params), ...extra };
    case 'landing_target_dirty': return { ...apiError('landing_target_dirty', reason, params), ...extra };
    case 'landing_move_failed': return { ...apiError('landing_move_failed', reason, params), ...extra };
  }
}

function failed(res: Response, what: string, err: unknown): void {
  // Not echoed: an unexpected failure may quote a path of this machine.
  console.error(`[kanban] ${what} failed:`, (err as Error).message);
  res.status(500).json(apiError('landing_request_failed', 'the landing of the job could not be read'));
}

export function registerLandingRoutes(app: Router, deps: PreviewDeps & RepairDeps & LandDeps = {}): void {
  app.get('/api/kanban/landings', (req, res) => {
    if (!requireAuth(req, res)) return;
    const query = ListQuery.safeParse(req.query);
    if (!query.success) { invalid(res, zodDetail(query.error)); return; }
    try {
      const viewer = viewerFromRequest(req);
      res.json({ landings: withKeptState(withRepairs(withJobLinks(listIntegrationViews(query.data, viewer), viewer))) });
    } catch (err) { failed(res, 'listing the landings', err); }
  });

  app.get('/api/kanban/landings/:id', (req, res) => {
    const row = landingForRoute(req, res);
    if (!row) return;
    try {
      const [landing] = withKeptState(withRepairs(withJobLinks([integrationView(row)], viewerFromRequest(req))));
      res.json({ landing });
    } catch (err) { failed(res, 'reading the links of a job', err); }
  });

  app.post('/api/kanban/landings/:id/checks', async (req, res) => {
    const row = landingForRoute(req, res);
    if (!row) return;
    const body = EmptyBody.safeParse(req.body ?? {});
    if (!body.success) { invalid(res, zodDetail(body.error)); return; }
    try {
      const out = await refreshIntegrationChecks(row, deps);
      if (!out.ok) {
        // The reason comes from `host/forge.ts`, which masks every credential.
        const status = out.code === 'checks_not_applicable' ? 409 : 502;
        res.status(status).json(apiError('landing_checks_unavailable', out.reason, { detail: out.reason }));
        return;
      }
      const [landing] = withKeptState(withRepairs(withJobLinks([out.integration], viewerFromRequest(req))));
      res.json({ landing, fresh: out.fresh });
    } catch (err) { failed(res, 'reading the checks of a pull request', err); }
  });

  app.post('/api/kanban/landings/:id/preview', async (req, res) => {
    const row = landingForRoute(req, res);
    if (!row) return;
    const body = PreviewBody.safeParse(req.body ?? {});
    if (!body.success) { invalid(res, zodDetail(body.error)); return; }
    try {
      const preview = await previewIntegration(row, {
        ...body.data,
        prechecks: requestHasPermission(req, 'projects:manage'),
      }, deps);
      res.json(preview);
    } catch (err) { failed(res, 'previewing a pull request', err); }
  });

  app.post('/api/kanban/landings/:id/repairs', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (!isPersonAuth(auth) || !auth.user) {
      res.status(403).json(apiError('person_required', 'a repair of a pull request is asked for by a signed-in person'));
      return;
    }
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const row = landingForRoute(req, res);
    if (!row) return;
    const body = RepairBody.safeParse(req.body ?? {});
    if (!body.success) { invalid(res, zodDetail(body.error)); return; }
    try {
      const out = await requestRepair(row, body.data.kind, auth.user.id, deps);
      if (!out.ok) { res.status(out.status).json(repairRefusal(out.code, out.reason)); return; }
      auditRequest(req, 'integration.repair_requested', `${row.branch}:${body.data.kind}`);
      const fresh = dbApi.getIntegrationById(row.id) ?? row;
      const [landing] = withKeptState(withRepairs(withJobLinks([integrationView(fresh)], viewerFromRequest(req))));
      res.status(201).json({ repair: out.repair, task_id: out.task_id, landing });
    } catch (err) { failed(res, 'asking for a repair', err); }
  });
  app.post('/api/kanban/landings/:id/land', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const row = landingToLand(req, res);
    if (!row) return;
    const body = LandBody.safeParse(req.body ?? {});
    if (!body.success) { invalid(res, zodDetail(body.error)); return; }
    try {
      const out = await landIntegrationBranch(row, body.data, deps);
      if (!out.ok) {
        if (isPrRefusal(out)) {
          res.status(out.status).json({ ...prRefusalBody(out.code, out.reason), ...(out.checks ? { checks: out.checks } : {}) });
        } else {
          res.status(out.status).json(landRefusal(out.code, out.reason, out.files));
        }
        return;
      }
      if (!out.already) {
        auditRequest(req, out.outcome === 'merged' ? 'integration.landed' : 'integration.pr_opened', row.branch);
      }
      const fresh = dbApi.getIntegrationById(row.id) ?? row;
      const [landing] = withKeptState(withRepairs(withJobLinks([integrationView(fresh)], viewerFromRequest(req))));
      res.json({ ...out, landing });
    } catch (err) { failed(res, 'landing a job', err); }
  });
}
