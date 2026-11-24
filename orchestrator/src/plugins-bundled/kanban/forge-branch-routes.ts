/**
 * What a person may do about the branch of a pull request:
 *
 *   POST /api/projects/:slug/pull-requests/:number/update-branch
 *        prepares "update the branch" (`forge-branch-update.ts`) as a
 *        publication; the person publishes it with
 *        `POST /api/projects/:slug/forge-proposals/:id/publish`.
 *   POST /api/projects/:slug/pull-requests/:number/conflict/ask
 *        prepares the comment that asks the contributor to resolve their
 *        conflict (`forge-conflicts.ts`), published the same way.
 *   POST /api/projects/:slug/pull-requests/:number/conflict
 *        merges the pull request without a working tree and keeps what
 *        conflicts (refused unless the project allows it).
 *   GET  /api/projects/:slug/forge-conflicts/:id            the resolution, its files' versions
 *   PUT  /api/projects/:slug/forge-conflicts/:id/files      one file's resolution
 *   POST /api/projects/:slug/forge-conflicts/:id/suggest    an agent with no tool suggests a text (not applied)
 *   POST /api/projects/:slug/forge-conflicts/:id/propose    commits it and prepares its publication
 *   POST /api/projects/:slug/forge-conflicts/:id/discard    drops it
 *
 * Authentication: every write needs a signed-in person (session or paired
 * device) holding `projects:manage`, like every write proposed on the forge.
 * The daemon token, a mission's token and a plugin's are refused
 * (`person_required`): an agent neither prepares nor publishes a write on
 * GitHub, and never starts a suggestion. Reading a resolution needs
 * `projects:manage`, as reading a pull request's diff does.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { proposeBranchUpdate } from '../../forge-branch-update.js';
import {
  conflictView, discardConflict, getForgeConflict, MAX_CONFLICT_FILE_BYTES, prepareConflict, proposeAskContributor,
  proposeConflictResolution, resolutionDiff, resolveConflictFile, suggestConflictResolution, type ConflictDeps,
} from '../../forge-conflicts.js';
import { viewOf } from '../../forge-proposals.js';
import { auditRequest } from '../../users/audit-actor.js';
import { rejectIfDenied, requireAuth } from '../../users/identity.js';
import { personAt, refusalBody } from './forge-proposal-routes.js';

const PullParams = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'a project slug'),
  number: z.coerce.number().int().positive().max(1_000_000_000),
});

const ConflictParams = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'a project slug'),
  id: z.uuid(),
});

const EmptyBody = z.object({}).strict();
const PathField = z.string().min(1).max(4096);
const FileBody = z.discriminatedUnion('choice', [
  z.object({ path: PathField, choice: z.literal('contributor') }).strict(),
  z.object({ path: PathField, choice: z.literal('target') }).strict(),
  // Bytes are checked again once decoded; characters bound the body first.
  z.object({ path: PathField, choice: z.literal('text'), text: z.string().max(MAX_CONFLICT_FILE_BYTES) }).strict(),
]);
const SuggestBody = z.object({ path: PathField }).strict();

function zodDetail(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

function invalid(res: Response, err: z.ZodError): void {
  const detail = zodDetail(err);
  res.status(400).json(apiError('forge_proposal_invalid', detail, { detail }));
}

/** The person, the pull request and an empty body, or null once answered. */
function pullRequest(req: Request, res: Response): { slug: string; number: number; userId: string } | null {
  const who = personAt(req, res);
  if (!who) return null;
  const params = PullParams.safeParse(req.params);
  if (!params.success) { invalid(res, params.error); return null; }
  const body = EmptyBody.safeParse(req.body ?? {});
  if (!body.success) { invalid(res, body.error); return null; }
  return { ...params.data, userId: who.userId };
}

/** A person, a resolution and a body matching `schema`, or null once answered. */
function conflictWrite<T extends z.ZodTypeAny>(req: Request, res: Response, schema: T): { slug: string; id: string; userId: string; body: z.infer<T> } | null {
  const who = personAt(req, res);
  if (!who) return null;
  const params = ConflictParams.safeParse(req.params);
  if (!params.success) { invalid(res, params.error); return null; }
  const body = schema.safeParse(req.body ?? {});
  if (!body.success) { invalid(res, body.error); return null; }
  return { ...params.data, userId: who.userId, body: body.data as z.infer<T> };
}

function failed(res: Response, err: unknown): void {
  // Not echoed: an unexpected failure may quote a path of this machine.
  console.error('[kanban] branch request failed:', (err as Error).name);
  res.status(500).json(apiError('forge_proposal_failed', 'the proposal could not be handled'));
}

export function registerForgeBranchRoutes(app: Router, deps: ConflictDeps = {}): void {
  app.post('/api/projects/:slug/pull-requests/:number/update-branch', async (req, res) => {
    const p = pullRequest(req, res);
    if (!p) return;
    try {
      const out = await proposeBranchUpdate(p.slug, p.number, p.userId, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      if (out.created) auditRequest(req, 'forge.branch_update_proposed', `${p.slug}:${out.proposal.id}`);
      res.status(out.created ? 201 : 200).json({ proposal: viewOf(out.proposal), created: out.created });
    } catch (err) { failed(res, err); }
  });

  app.post('/api/projects/:slug/pull-requests/:number/conflict/ask', async (req, res) => {
    const p = pullRequest(req, res);
    if (!p) return;
    try {
      const out = await proposeAskContributor(p.slug, p.number, p.userId, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      if (out.created) auditRequest(req, 'forge.conflict_ask_proposed', `${p.slug}:${out.proposal.id}`);
      res.status(out.created ? 201 : 200).json({ proposal: viewOf(out.proposal), created: out.created });
    } catch (err) { failed(res, err); }
  });

  app.post('/api/projects/:slug/pull-requests/:number/conflict', async (req, res) => {
    const p = pullRequest(req, res);
    if (!p) return;
    try {
      const out = await prepareConflict(p.slug, p.number, p.userId, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      if (out.created) auditRequest(req, 'forge.conflict_prepared', `${p.slug}:${out.row.id}`);
      res.status(out.created ? 201 : 200).json({ conflict: await conflictView(out.row, deps), created: out.created });
    } catch (err) { failed(res, err); }
  });

  app.get('/api/projects/:slug/forge-conflicts/:id', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const params = ConflictParams.safeParse(req.params);
    if (!params.success) { invalid(res, params.error); return; }
    try {
      const row = getForgeConflict(params.data.slug, params.data.id);
      if (!row) { res.status(404).json(apiError('conflict_not_found', 'no conflict resolution has this id in this project')); return; }
      res.json({ conflict: await conflictView(row, deps), diff: await resolutionDiff(row, deps) });
    } catch (err) { failed(res, err); }
  });

  app.put('/api/projects/:slug/forge-conflicts/:id/files', async (req, res) => {
    const p = conflictWrite(req, res, FileBody);
    if (!p) return;
    try {
      const out = await resolveConflictFile(p.slug, p.id, p.body, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      res.json({ conflict: await conflictView(out.row, deps) });
    } catch (err) { failed(res, err); }
  });

  app.post('/api/projects/:slug/forge-conflicts/:id/suggest', async (req, res) => {
    const p = conflictWrite(req, res, SuggestBody);
    if (!p) return;
    try {
      const out = await suggestConflictResolution(p.slug, p.id, p.body.path, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      auditRequest(req, 'forge.conflict_suggested', `${p.slug}:${p.id}`);
      res.json({ path: p.body.path, text: out.text });
    } catch (err) { failed(res, err); }
  });

  app.post('/api/projects/:slug/forge-conflicts/:id/propose', async (req, res) => {
    const p = conflictWrite(req, res, EmptyBody);
    if (!p) return;
    try {
      const out = await proposeConflictResolution(p.slug, p.id, p.userId, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      auditRequest(req, 'forge.conflict_proposed', `${p.slug}:${out.proposal.id}`);
      res.status(201).json({ conflict: await conflictView(out.row, deps), proposal: viewOf(out.proposal), diff: out.diff });
    } catch (err) { failed(res, err); }
  });

  app.post('/api/projects/:slug/forge-conflicts/:id/discard', (req, res) => {
    const p = conflictWrite(req, res, EmptyBody);
    if (!p) return;
    try {
      const out = discardConflict(p.slug, p.id, p.userId, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      auditRequest(req, 'forge.conflict_discarded', `${p.slug}:${p.id}`);
      res.json({ state: out.row.state });
    } catch (err) { failed(res, err); }
  });
}
