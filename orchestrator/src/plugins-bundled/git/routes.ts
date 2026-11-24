/**
 * Module `git` — a project's repository state: branches, checkout, GitHub
 * remote, an agent's repo state. Tier `std`, requires the `git` binary.
 *
 * Routes extracted from `kanban-code/routes.ts` (TODO #275). Every params,
 * query and body is checked by a strict zod schema before reaching git or the
 * disk (docs/SECURITY.md): an unknown field is a 400, not silently ignored.
 *
 * Every caller is authenticated by the daemon middleware; every route also
 * says so itself with `requireAuth`, so it stays closed if it is ever mounted
 * behind a router without it (first-run setup lets an anonymous caller
 * through). Whatever moves the repository or its publication — create a
 * remote, push, fetch, checkout, delete a branch, edit the remotes — is
 * `projects:manage`, the permission of editing the project itself: being
 * signed in is not enough to push a project's code (TODO #525).
 *
 * Reading the repository follows the Git card of the chat (TODO #689, after
 * #645 put the card behind `widget:git`): hiding the card was not enough while
 * any session could still read branches, working tree and commits here.
 *
 * A project may hold several repositories (TODO #923): every route takes an
 * optional `repo`, a path relative to the project folder that names one of
 * them (`GET /api/git/repos` lists them). Absent, the route works on the
 * project folder itself, exactly as before.
 */
import { isValidAgentName, normalizeAgentName } from '../../agent-name.js';
import type { Response, Router } from 'express';
import { z } from 'zod';
import { readMeta } from '../../projects.js';
import { GIT_LOG_MAX, GitNoAnswerError, gitCheckout, gitDashboard, gitDeleteBranch, gitInfo, gitLog, gitWorktrees, validBranchName } from '../../git.js';
import { rejectIfDenied, rejectUnlessAny, requireAuth } from '../../users/identity.js';
import {
  addRemote, createRemote as createGitRemote, fetch as gitRemoteFetch, getStatus as getGitRemoteStatus,
  listRemotes, push as gitRemotePush, removeRemote, setRemoteUrl,
} from '../../gitremote.js';
import { checkRemoteUrl, REMOTE_URL_MAX, REMOTE_URL_MESSAGES } from '../../git-remote-url.js';
import { apiError } from '../../api-error.js';
import { discoverRepos, REPO_PATH, resolveRepoCwd } from '../../project-repos.js';

/** Resolves a project's host working dir from its meta. Returns null if the
 *  project has no `cwd` configured. */
function resolveProjectCwd(slug: string): string | null {
  try {
    const meta = readMeta(slug);
    return meta.cwd || null;
  } catch {
    return null;
  }
}

// A slug or agent name lands in a filesystem path: `.` and `..` would
// resolve to the parent directory, so they are refused with the separators.
const pathSegment = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9._-]+$/)
  .refine((s) => s !== '.' && s !== '..', { message: 'invalid name' });
const SLUG = pathSegment(64);
const AGENT_NAME = z.string().max(128).transform(normalizeAgentName).refine(isValidAgentName, { message: 'invalid name' });
const BRANCH = z.string().max(255).refine(validBranchName, { message: 'invalid branch name' });

const AgentParams = z.object({ name: AGENT_NAME }).strict();
const SlugParams = z.object({ slug: SLUG }).strict();
const REPO = REPO_PATH.optional();
const StatusQuery = z.object({ slug: SLUG, repo: REPO }).strict();
const ReposQuery = z.object({ slug: SLUG }).strict();
// The project whose checkout the composer's picker switches: with it, the
// answer says whether the agent's folder belongs to that repository at all.
// A `repo` names one of that project's repositories, so it needs the project.
const AgentGitQuery = z.object({ slug: SLUG.optional(), repo: REPO }).strict()
  .refine((q) => q.repo === undefined || q.slug !== undefined, { message: 'repo needs a slug', path: ['repo'] });
// A query value is a string; digits only, so `1e3`, `-1` or ` 5` are refused
// rather than coerced. A repeated parameter arrives as an array: refused too.
const count = (min: number, max: number) => z.string().regex(/^\d{1,6}$/).transform(Number)
  .pipe(z.number().int().min(min).max(max));
const LogQuery = z.object({
  slug: SLUG,
  limit: count(1, GIT_LOG_MAX).optional(),
  skip: count(0, 100_000).optional(),
  repo: REPO,
}).strict();
// The routes keyed by a slug in the path take only the repository in their
// query: a stray parameter is refused, not ignored.
const RepoQuery = z.object({ repo: REPO }).strict();
const EmptyQuery = z.object({}).strict();
// Limits are GitHub's own (repository name 100, description 350): a longer
// value would only fail later, inside `gh repo create`.
const CreateRemoteBody = z.object({
  private: z.boolean().optional(),
  name: z.string().max(100).optional(),
  description: z.string().max(350).optional(),
}).strict();
const EmptyBody = z.object({}).strict();
// git accepts more in a remote name; this is what a person types, and it can
// neither start with `-` nor climb out of `refs/remotes/`.
const REMOTE_NAME = z.string().min(1).max(64).regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/)
  .refine((s) => !s.includes('..') && !s.endsWith('.') && !s.endsWith('.lock'), { message: 'invalid remote name' });
// The message names the refusal, never the URL: it may be the secret refused.
const REMOTE_URL = z.string().max(REMOTE_URL_MAX).superRefine((url, ctx) => {
  const checked = checkRemoteUrl(url);
  if (!checked.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: REMOTE_URL_MESSAGES[checked.reason] });
});
const RemoteParams = z.object({ slug: SLUG, name: REMOTE_NAME }).strict();
// An empty branch keeps its historical meaning: the current branch. No
// `remote` is the branch's own tracking remote; a named one must be declared
// in the repository, which `push` checks before git sees it.
const PushBody = z.object({
  branch: z.union([z.literal(''), BRANCH]).optional(),
  remote: REMOTE_NAME.optional(),
}).strict();
// `check: false` saves without contacting the remote.
const AddRemoteBody = z.object({ name: REMOTE_NAME, url: REMOTE_URL, check: z.boolean().optional() }).strict();
const SetRemoteUrlBody = z.object({ url: REMOTE_URL, check: z.boolean().optional() }).strict();
const CheckoutBody = z.object({ slug: SLUG, branch: BRANCH, repo: REPO }).strict();
const DeleteBranchBody = z.object({ slug: SLUG, branch: BRANCH, force: z.boolean().optional(), repo: REPO }).strict();

/**
 * Who reads a project's repository: its manager, and whoever holds the Git
 * card (the composer's branch bar is part of it). The publication state is
 * also what the project cards of `/agents` show, so that page opens it too —
 * only it: the branches and the working tree stay behind the card.
 */
const READ_GIT = ['projects:manage', 'widget:git', 'plugin:@timon/git'] as const;
const READ_GIT_REMOTE = [...READ_GIT, 'page:/agents'] as const;

/** Parses a request part, or answers 400 with what is wrong and returns null. */
function parseOr400<T>(schema: z.ZodType<T>, value: unknown, res: Response): T | null {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  res.status(400).json(apiError('invalid_detail', `invalid request: ${issues}`, { detail: issues }));
  return null;
}

/**
 * The folder a route works in: the project's, or its repository `repo`.
 * Answers 400 and returns null when there is none, or when `repo` leaves the
 * project (a link pointing out of it).
 */
function workCwdOr400(slug: string, repo: string | undefined, res: Response): string | null {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) { res.status(400).json(apiError('project_no_cwd', 'project has no configured cwd')); return null; }
  try { return resolveRepoCwd(cwd, repo); }
  catch (err) { res.status(400).json(apiError('invalid_repo', (err as Error).message)); return null; }
}

export function registerRoutes(app: Router): void {
  app.get('/api/agents/:name/git', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectUnlessAny(req, res, READ_GIT)) return;
    const params = parseOr400(AgentParams, req.params, res);
    const query = params && parseOr400(AgentGitQuery, req.query, res);
    if (!params || !query) return;
    try {
      let projectCwd: string | null | undefined;
      if (query.slug !== undefined) {
        projectCwd = resolveProjectCwd(query.slug);
        if (projectCwd && query.repo !== undefined) {
          projectCwd = workCwdOr400(query.slug, query.repo, res);
          if (!projectCwd) return;
        }
      }
      const info = await gitInfo(params.name, projectCwd);
      res.json(info);
    } catch (err) {
      res.status(err instanceof GitNoAnswerError ? 503 : 500).json(apiError('git_info_failed', (err as Error).message, { detail: (err as Error).message }));
    }
  });

  app.get('/api/git-remote/:slug', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectUnlessAny(req, res, READ_GIT_REMOTE)) return;
    const params = parseOr400(SlugParams, req.params, res);
    const query = params && parseOr400(RepoQuery, req.query, res);
    if (!params || !query) return;
    try { res.json({ git: await getGitRemoteStatus(params.slug, query.repo) }); }
    catch (err) { res.status(400).json(apiError('git_remote_status_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  // Creating the GitHub repository publishes the project under the account
  // `gh` is signed in with: a project edit, not a read.
  app.post('/api/git-remote/:slug/create-remote', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const params = parseOr400(SlugParams, req.params, res);
    const query = params && parseOr400(RepoQuery, req.query, res);
    const body = query && parseOr400(CreateRemoteBody, req.body, res);
    if (!params || !query || !body) return;
    try {
      res.json({ git: await createGitRemote(params.slug, body, query.repo) });
    } catch (err) { res.status(400).json(apiError('git_remote_create_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.get('/api/git-remote/:slug/remotes', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectUnlessAny(req, res, READ_GIT)) return;
    const params = parseOr400(SlugParams, req.params, res);
    const query = params && parseOr400(RepoQuery, req.query, res);
    if (!params || !query) return;
    try { res.json({ remotes: await listRemotes(params.slug, query.repo) }); }
    catch (err) { res.status(400).json(apiError('git_remotes_list_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  // Changing a remote decides where the project's code is pushed: the same
  // permission as editing the project itself, not just being signed in.
  app.post('/api/git-remote/:slug/remotes', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const params = parseOr400(SlugParams, req.params, res);
    const query = params && parseOr400(RepoQuery, req.query, res);
    const body = query && parseOr400(AddRemoteBody, req.body, res);
    if (!params || !query || !body) return;
    try { res.json(await addRemote(params.slug, body, query.repo)); }
    catch (err) { res.status(400).json(apiError('git_remote_add_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.patch('/api/git-remote/:slug/remotes/:name', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const params = parseOr400(RemoteParams, req.params, res);
    const query = params && parseOr400(RepoQuery, req.query, res);
    const body = query && parseOr400(SetRemoteUrlBody, req.body, res);
    if (!params || !query || !body) return;
    try { res.json(await setRemoteUrl(params.slug, { name: params.name, ...body }, query.repo)); }
    catch (err) { res.status(400).json(apiError('git_remote_update_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.delete('/api/git-remote/:slug/remotes/:name', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const params = parseOr400(RemoteParams, req.params, res);
    const query = params && parseOr400(RepoQuery, req.query, res);
    if (!params || !query || !parseOr400(EmptyBody, req.body, res)) return;
    try { res.json(await removeRemote(params.slug, params.name, query.repo)); }
    catch (err) { res.status(400).json(apiError('git_remote_remove_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  // Push and fetch run under the host's git credentials and rewrite refs, on
  // the remote or locally: same permission as changing where the code goes.
  app.post('/api/git-remote/:slug/push', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const params = parseOr400(SlugParams, req.params, res);
    const query = params && parseOr400(RepoQuery, req.query, res);
    const body = query && parseOr400(PushBody, req.body, res);
    if (!params || !query || !body) return;
    try {
      res.json({ git: await gitRemotePush(params.slug, body.branch || undefined, query.repo, body.remote) });
    } catch (err) { res.status(400).json(apiError('git_push_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/git-remote/:slug/fetch', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const params = parseOr400(SlugParams, req.params, res);
    const query = params && parseOr400(RepoQuery, req.query, res);
    if (!params || !query || !parseOr400(EmptyBody, req.body, res)) return;
    try { res.json({ git: await gitRemoteFetch(params.slug, query.repo) }); }
    catch (err) { res.status(400).json(apiError('git_fetch_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.get('/api/git/status', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectUnlessAny(req, res, READ_GIT)) return;
    const query = parseOr400(StatusQuery, req.query, res);
    if (!query) return;
    const cwd = workCwdOr400(query.slug, query.repo, res);
    if (!cwd) return;
    res.json(await gitDashboard(cwd));
  });

  // The repositories of the project the widget can switch between: the root
  // first, then the nested ones it ignores or declares in `.worktreelinks`.
  app.get('/api/git/repos', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectUnlessAny(req, res, READ_GIT)) return;
    const query = parseOr400(ReposQuery, req.query, res);
    if (!query) return;
    const cwd = resolveProjectCwd(query.slug);
    if (!cwd) { res.status(400).json(apiError('project_no_cwd', 'project has no configured cwd')); return; }
    res.json({ repos: await discoverRepos(cwd) });
  });

  app.get('/api/git/worktrees', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectUnlessAny(req, res, READ_GIT)) return;
    const query = parseOr400(StatusQuery, req.query, res);
    if (!query) return;
    const cwd = workCwdOr400(query.slug, query.repo, res);
    if (!cwd) return;
    res.json(await gitWorktrees(cwd));
  });

  app.get('/api/git/log', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectUnlessAny(req, res, READ_GIT)) return;
    const query = parseOr400(LogQuery, req.query, res);
    if (!query) return;
    const cwd = workCwdOr400(query.slug, query.repo, res);
    if (!cwd) return;
    res.json(await gitLog(cwd, { limit: query.limit ?? 100, skip: query.skip ?? 0 }));
  });

  // The checkout is shared by every agent and person on the project: switching
  // or deleting a branch under them is a project edit.
  app.post('/api/git/checkout', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const body = parseOr400(EmptyQuery, req.query, res) && parseOr400(CheckoutBody, req.body, res);
    if (!body) return;
    const { slug, branch, repo } = body;
    const cwd = workCwdOr400(slug, repo, res);
    if (!cwd) return;
    const r = await gitCheckout(cwd, branch);
    if (!r.ok) { res.status(400).json(r); return; }
    res.json(r);
  });

  app.post('/api/git/delete-branch', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const body = parseOr400(EmptyQuery, req.query, res) && parseOr400(DeleteBranchBody, req.body, res);
    if (!body) return;
    const { slug, branch, force, repo } = body;
    const cwd = workCwdOr400(slug, repo, res);
    if (!cwd) return;
    const r = await gitDeleteBranch(cwd, branch, Boolean(force));
    if (!r.ok) { res.status(400).json(r); return; }
    res.json(r);
  });
}
