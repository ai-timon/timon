/**
 * The publications proposed on the forge of a project (`forge-proposals.ts`):
 *
 *   GET  /api/projects/:slug/forge-proposals[?state=]     the list, newest first
 *   GET  /api/projects/:slug/forge-proposals/:id          one proposal
 *   POST /api/projects/:slug/forge-proposals              a person proposes a comment
 *   PATCH /api/projects/:slug/forge-proposals/:id         a person edits its text
 *   POST /api/projects/:slug/forge-proposals/:id/publish  a person publishes it on GitHub
 *   POST /api/projects/:slug/forge-proposals/:id/discard  a person declines it
 *
 * Authentication:
 * - reading needs `projects:manage`, whoever asks (the daemon token passes, as
 *   for every project setting);
 * - every write needs a signed-in person (session or paired device) holding
 *   `projects:manage`. The daemon token, a mission's token and a plugin's are
 *   refused: an agent never proposes nor publishes on GitHub. The daemon
 *   proposes through `proposeForgeWrite`, in process, not through a route.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import {
  discardForgeProposal, editForgeProposal, FORGE_PROPOSAL_BODY_LIMIT, FORGE_PROPOSAL_STATES, FORGE_PROPOSAL_TARGETS,
  getForgeProposal, listForgeProposals, proposeForgeWrite, publishForgeProposal, viewOf,
  type ForgeProposalDeps, type ForgeProposalRefusal,
} from '../../forge-proposals.js';
import { auditRequest } from '../../users/audit-actor.js';
import { isPersonAuth, rejectIfDenied, requireAuth } from '../../users/identity.js';

const Params = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'a project slug'),
  id: z.uuid().optional(),
});

const ListQuery = z.object({ state: z.enum(FORGE_PROPOSAL_STATES).optional() }).strict();

const Body = z.string().max(FORGE_PROPOSAL_BODY_LIMIT);

const CreateBody = z.object({
  kind: z.literal('comment'),
  target: z.object({
    type: z.enum(FORGE_PROPOSAL_TARGETS),
    number: z.number().int().positive().max(1_000_000_000),
  }).strict(),
  body: Body,
}).strict();

const EditBody = z.object({ body: Body }).strict();
const PublishBody = z.object({ body: Body.optional() }).strict();
const DiscardBody = z.object({}).strict();

function zodDetail(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

/** One literal per code, so the webview's messages can be checked against them. */
export function refusalBody(out: ForgeProposalRefusal) {
  const params = { detail: out.reason };
  const extra = out.proposal ? { proposal: out.proposal } : {};
  switch (out.code) {
    case 'project_not_found': return { ...apiError('project_not_found', out.reason), ...extra };
    case 'integration_invalid': return { ...apiError('integration_invalid', out.reason, params), ...extra };
    case 'integration_not_pr': return { ...apiError('integration_not_pr', out.reason), ...extra };
    case 'pr_repository_unknown': return { ...apiError('pr_repository_unknown', out.reason), ...extra };
    case 'forge_proposal_not_found': return { ...apiError('forge_proposal_not_found', out.reason), ...extra };
    case 'forge_proposal_invalid': return { ...apiError('forge_proposal_invalid', out.reason, params), ...extra };
    case 'forge_proposal_closed': return { ...apiError('forge_proposal_closed', out.reason), ...extra };
    case 'forge_proposal_busy': return { ...apiError('forge_proposal_busy', out.reason), ...extra };
    case 'forge_proposal_repository_changed': return { ...apiError('forge_proposal_repository_changed', out.reason, params), ...extra };
    case 'forge_account_unset': return { ...apiError('forge_account_unset', out.reason), ...extra };
    case 'forge_account_unknown': return { ...apiError('forge_account_unknown', out.reason, params), ...extra };
    case 'forge_account_mismatch': return { ...apiError('forge_account_mismatch', out.reason, params), ...extra };
    case 'forge_publish_failed': return { ...apiError('forge_publish_failed', out.reason, params), ...extra };
    case 'forge_proposal_not_editable': return { ...apiError('forge_proposal_not_editable', out.reason), ...extra };
    case 'forge_read_failed': return { ...apiError('forge_read_failed', out.reason, params), ...extra };
    case 'forge_pull_closed': return { ...apiError('forge_pull_closed', out.reason, params), ...extra };
    case 'forge_pull_not_behind': return { ...apiError('forge_pull_not_behind', out.reason, params), ...extra };
    case 'forge_pull_not_conflicting': return { ...apiError('forge_pull_not_conflicting', out.reason, params), ...extra };
    case 'forge_pull_not_fork': return { ...apiError('forge_pull_not_fork', out.reason), ...extra };
    case 'forge_head_unknown': return { ...apiError('forge_head_unknown', out.reason), ...extra };
    case 'forge_head_moved': return { ...apiError('forge_head_moved', out.reason), ...extra };
    case 'forge_branch_not_modifiable': return { ...apiError('forge_branch_not_modifiable', out.reason, params), ...extra };
    case 'forge_branch_conflict': return { ...apiError('forge_branch_conflict', out.reason), ...extra };
    case 'forge_branch_forbidden': return { ...apiError('forge_branch_forbidden', out.reason, params), ...extra };
    case 'forge_push_rejected': return { ...apiError('forge_push_rejected', out.reason, params), ...extra };
    case 'forge_conflict_changed': return { ...apiError('forge_conflict_changed', out.reason, params), ...extra };
    case 'conflict_resolution_disabled': return { ...apiError('conflict_resolution_disabled', out.reason), ...extra };
    case 'conflict_not_found': return { ...apiError('conflict_not_found', out.reason), ...extra };
    case 'conflict_closed': return { ...apiError('conflict_closed', out.reason, params), ...extra };
    case 'conflict_invalid': return { ...apiError('conflict_invalid', out.reason, params), ...extra };
    case 'conflict_git_unavailable': return { ...apiError('conflict_git_unavailable', out.reason, params), ...extra };
    case 'conflict_fetch_failed': return { ...apiError('conflict_fetch_failed', out.reason, params), ...extra };
    case 'conflict_fetch_too_large': return { ...apiError('conflict_fetch_too_large', out.reason, params), ...extra };
    case 'conflict_none': return { ...apiError('conflict_none', out.reason), ...extra };
    case 'conflict_unsupported': return { ...apiError('conflict_unsupported', out.reason, params), ...extra };
    case 'conflict_markers_left': return { ...apiError('conflict_markers_left', out.reason, params), ...extra };
    case 'conflict_unresolved': return { ...apiError('conflict_unresolved', out.reason, params), ...extra };
    case 'conflict_outside_files': return { ...apiError('conflict_outside_files', out.reason, params), ...extra };
    case 'conflict_suggest_unavailable': return { ...apiError('conflict_suggest_unavailable', out.reason, params), ...extra };
    case 'conflict_suggest_failed': return { ...apiError('conflict_suggest_failed', out.reason, params), ...extra };
  }
}

type Parsed = { slug: string; id?: string | undefined };

function parseParams(req: Request, res: Response): Parsed | null {
  const params = Params.safeParse(req.params);
  if (!params.success) {
    const detail = zodDetail(params.error);
    res.status(400).json(apiError('forge_proposal_invalid', detail, { detail }));
    return null;
  }
  return params.data;
}

function parseBody<T extends z.ZodTypeAny>(req: Request, res: Response, schema: T): z.infer<T> | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const detail = zodDetail(parsed.error);
    res.status(400).json(apiError('forge_proposal_invalid', detail, { detail }));
    return null;
  }
  return parsed.data as z.infer<T>;
}

/** Reading: any caller holding `projects:manage`. */
function reader(req: Request, res: Response): Parsed | null {
  if (!requireAuth(req, res)) return null;
  if (rejectIfDenied(req, res, 'projects:manage')) return null;
  return parseParams(req, res);
}

/** Writing: a person at a screen holding `projects:manage`; returns their id. */
export function personAt(req: Request, res: Response): { userId: string } | null {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (!isPersonAuth(auth) || !auth.user) {
    res.status(403).json(apiError('person_required', 'a publication on GitHub is proposed and validated by a signed-in person'));
    return null;
  }
  if (rejectIfDenied(req, res, 'projects:manage')) return null;
  return { userId: auth.user.id };
}

function person(req: Request, res: Response): (Parsed & { userId: string }) | null {
  const who = personAt(req, res);
  if (!who) return null;
  const params = parseParams(req, res);
  return params ? { ...params, userId: who.userId } : null;
}

function failed(res: Response, err: unknown): void {
  // Not echoed: an unexpected failure may quote a path of this machine.
  console.error('[kanban] forge proposal request failed:', (err as Error).name);
  res.status(500).json(apiError('forge_proposal_failed', 'the proposal could not be handled'));
}

export function registerForgeProposalRoutes(app: Router, deps: ForgeProposalDeps = {}): void {
  app.get('/api/projects/:slug/forge-proposals', (req, res) => {
    const p = reader(req, res);
    if (!p) return;
    const query = ListQuery.safeParse(req.query ?? {});
    if (!query.success) {
      const detail = zodDetail(query.error);
      res.status(400).json(apiError('forge_proposal_invalid', detail, { detail }));
      return;
    }
    try {
      res.json({ proposals: listForgeProposals(p.slug, query.data.state).map(viewOf) });
    } catch (err) { failed(res, err); }
  });

  app.get('/api/projects/:slug/forge-proposals/:id', (req, res) => {
    const p = reader(req, res);
    if (!p?.id) return;
    const row = getForgeProposal(p.slug, p.id);
    if (!row) { res.status(404).json(apiError('forge_proposal_not_found', 'no proposal has this id in this project')); return; }
    res.json({ proposal: viewOf(row) });
  });

  app.post('/api/projects/:slug/forge-proposals', (req, res) => {
    const p = person(req, res);
    if (!p) return;
    const body = parseBody(req, res, CreateBody);
    if (!body) return;
    try {
      const out = proposeForgeWrite({
        project: p.slug, kind: body.kind, target: body.target, body: body.body, trigger: 'person', createdBy: p.userId,
      }, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      if (out.created) auditRequest(req, 'forge.proposal_created', `${p.slug}:${out.proposal.id}`);
      res.status(out.created ? 201 : 200).json({ proposal: viewOf(out.proposal), created: out.created });
    } catch (err) { failed(res, err); }
  });

  app.patch('/api/projects/:slug/forge-proposals/:id', (req, res) => {
    const p = person(req, res);
    if (!p?.id) return;
    const body = parseBody(req, res, EditBody);
    if (!body) return;
    try {
      const out = editForgeProposal(p.slug, p.id, body.body, p.userId, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      res.json({ proposal: viewOf(out.proposal) });
    } catch (err) { failed(res, err); }
  });

  app.post('/api/projects/:slug/forge-proposals/:id/publish', async (req, res) => {
    const p = person(req, res);
    if (!p?.id) return;
    const body = parseBody(req, res, PublishBody);
    if (!body) return;
    try {
      const out = await publishForgeProposal(p.slug, p.id, p.userId, body.body, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      if (!out.already) auditRequest(req, 'forge.proposal_published', `${p.slug}:${p.id}`);
      res.json({ proposal: viewOf(out.proposal), already: out.already });
    } catch (err) { failed(res, err); }
  });

  app.post('/api/projects/:slug/forge-proposals/:id/discard', (req, res) => {
    const p = person(req, res);
    if (!p?.id) return;
    if (!parseBody(req, res, DiscardBody)) return;
    try {
      const out = discardForgeProposal(p.slug, p.id, p.userId, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      auditRequest(req, 'forge.proposal_discarded', `${p.slug}:${p.id}`);
      res.json({ proposal: viewOf(out.proposal) });
    } catch (err) { failed(res, err); }
  });
}
