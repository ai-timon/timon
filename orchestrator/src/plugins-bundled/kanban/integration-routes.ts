/**
 * How a project's Kanban jobs land (`project-integration.ts`): read, change,
 * reset, and check that `gh` signs in as the account the setting names.
 *
 * Every verb needs a signed-in caller holding `projects:manage`, reads
 * included: the setting names a folder of this machine and the account the
 * daemon will push as. The daemon token passes, as for every project setting
 * the CLI and the agents write.
 *
 * Letting Timon resolve a contributor's conflict itself (`contributor_conflicts:
 * "resolve"`, `forge-conflicts.ts`) is a person's choice: a write that turns
 * it on from the daemon token, a mission's or a plugin's is refused, whatever
 * else it holds. Turning it off stays open to every caller. While it is on,
 * the fields that decide where a resolution is fetched from and pushed to, and
 * as whom (`PUSH_TARGET_FIELDS`), are a person's too: an agent that could
 * point `remote_url` elsewhere would choose where the next push a person
 * validates goes. Refused rather than silently switched back to "ask": the
 * caller learns why, and a person's choice is never undone behind them.
 *
 * One exception, `POST …/integration/branch`: the Kanban planner checks the
 * branch of a new job while the person types or picks it, a new one or one
 * the repository has (`kind`), in any project. It needs `kanban:write` (the
 * plan creates Kanban tasks) and answers nothing of the setting beyond the
 * name the job would get.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { ghLogin, type GhLoginOutcome } from '../../host/gh.js';
import { checkPlanBranch, landingSetting, MAX_PLAN_BRANCH_CHARS } from '../../plan-landing.js';
import { announceProjectUpdated } from '../../project-service.js';
import {
  changedPushTargetFields, checkProjectIntegration, clearProjectIntegration, ProjectIntegrationError, ProjectIntegrationPatchSchema,
  readProjectIntegration, updateProjectIntegration, type ProjectIntegration,
} from '../../project-integration.js';
import { readMeta } from '../../projects.js';
import { todoOriginFromRequest } from '../../todo-origin.js';
import { auditRequest } from '../../users/audit-actor.js';
import { isPersonAuth, rejectIfDenied, requireAuth } from '../../users/identity.js';

export type IntegrationRouteDeps = {
  /** Stands in for `gh api user` in tests: nothing here reaches GitHub. */
  ghLogin?: (configDir: string | null) => Promise<GhLoginOutcome>;
  /** Stands in for the user's home in tests. */
  home?: string;
};

/** Auth, permission and the project: answers the refusal itself and returns
 *  null when the request stops there. */
function projectForRoute(req: Request, res: Response): string | null {
  if (!requireAuth(req, res)) return null;
  if (rejectIfDenied(req, res, 'projects:manage')) return null;
  const slug = req.params.slug;
  if (typeof slug !== 'string') {
    res.status(400).json(apiError('project_refused', 'invalid project slug', { detail: 'invalid project slug' }));
    return null;
  }
  // `readMeta` validates the slug and brings a project still described by its
  // legacy file into the table, where the setting lives.
  try { readMeta(slug); } catch {
    res.status(400).json(apiError('project_refused', 'invalid project slug', { detail: 'invalid project slug' }));
    return null;
  }
  return slug;
}

/** A write only a signed-in person may make (`guard` of the PUT). */
class PersonRequired extends Error {}

function answerError(res: Response, err: unknown): void {
  if (err instanceof PersonRequired) {
    res.status(403).json(apiError('person_required', err.message));
    return;
  }
  if (err instanceof ProjectIntegrationError) {
    if (err.code === 'not_found') { res.status(404).json(apiError('project_not_found', err.message)); return; }
    res.status(400).json(apiError('integration_invalid', err.message, { detail: err.message }));
    return;
  }
  // Not echoed: an unexpected failure may quote the folder the setting names.
  console.error('[kanban] project integration request failed:', (err as Error).message);
  res.status(500).json(apiError('project_request_failed', 'the integration setting could not be handled', {
    detail: 'the integration setting could not be handled',
  }));
}

/** A draft the settings dialog checks before it is saved: the account and
 *  the folder only, held to the same rules as a write. */
const CheckDraftBody = ProjectIntegrationPatchSchema.pick({ account: true, gh_config_dir: true }).strict();

const PlanBranchBody = z.object({
  branch: z.string().max(MAX_PLAN_BRANCH_CHARS),
  /** `new` (default) cuts a branch, `existing` starts from one the repository has. */
  kind: z.enum(['new', 'existing']).optional(),
}).strict();

/** Auth, permission and a valid slug for the planner's branch check. */
function plannerProject(req: Request, res: Response): string | null {
  if (!requireAuth(req, res)) return null;
  if (rejectIfDenied(req, res, 'kanban:write')) return null;
  const slug = req.params.slug;
  if (typeof slug !== 'string') {
    res.status(400).json(apiError('project_refused', 'invalid project slug', { detail: 'invalid project slug' }));
    return null;
  }
  try { readMeta(slug); } catch {
    res.status(400).json(apiError('project_refused', 'invalid project slug', { detail: 'invalid project slug' }));
    return null;
  }
  return slug;
}

export function registerIntegrationRoutes(app: Router, deps: IntegrationRouteDeps = {}): void {
  const login = deps.ghLogin ?? ((dir: string | null) => ghLogin(dir));

  app.get('/api/projects/:slug/integration', (req, res) => {
    const slug = projectForRoute(req, res);
    if (!slug) return;
    try { res.json(readProjectIntegration(slug)); } catch (err) { answerError(res, err); }
  });

  app.put('/api/projects/:slug/integration', (req, res) => {
    const slug = projectForRoute(req, res);
    if (!slug) return;
    const person = !!req.auth && isPersonAuth(req.auth);
    const guard = (current: ProjectIntegration, next: ProjectIntegration): void => {
      if (person || next.contributor_conflicts !== 'resolve') return;
      if (current.contributor_conflicts !== 'resolve') {
        throw new PersonRequired('only a signed-in person lets Timon resolve a contributor\'s conflict');
      }
      const changed = changedPushTargetFields(current, next);
      if (changed.length > 0) {
        throw new PersonRequired(
          `while Timon resolves contributors' conflicts, only a signed-in person changes ${changed.join(', ')}`,
        );
      }
    };
    try {
      const integration = updateProjectIntegration(slug, req.body, { ...(deps.home ? { home: deps.home } : {}), guard });
      auditRequest(req, 'project.integration_set', `${slug}:${integration.mode}`);
      announceProjectUpdated(slug, ['integration'], todoOriginFromRequest(req));
      res.json({ integration, configured: true });
    } catch (err) { answerError(res, err); }
  });

  app.delete('/api/projects/:slug/integration', (req, res) => {
    const slug = projectForRoute(req, res);
    if (!slug) return;
    try {
      clearProjectIntegration(slug);
      auditRequest(req, 'project.integration_cleared', slug);
      announceProjectUpdated(slug, ['integration'], todoOriginFromRequest(req));
      res.json(readProjectIntegration(slug));
    } catch (err) { answerError(res, err); }
  });

  // One network call to the forge, on demand only: never on a read. The body
  // may carry a draft (`account`, `gh_config_dir`) to check before saving it;
  // nothing is written either way.
  app.post('/api/projects/:slug/integration/check', async (req, res) => {
    const slug = projectForRoute(req, res);
    if (!slug) return;
    const draft = CheckDraftBody.safeParse(req.body ?? {});
    if (!draft.success) {
      const detail = draft.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      res.status(400).json(apiError('integration_invalid', detail, { detail }));
      return;
    }
    const drafted = Object.keys(draft.data).length > 0;
    let read;
    try { read = readProjectIntegration(slug); } catch (err) { answerError(res, err); return; }
    if (read.invalid && !drafted) {
      res.status(409).json(apiError('integration_invalid', `the stored setting is invalid: ${read.invalid}`, { detail: read.invalid }));
      return;
    }
    let checked = read.integration;
    if (drafted) {
      // `local` so a draft without its account still reaches gh: the check is
      // what tells the person which login to type.
      try {
        checked = checkProjectIntegration(
          { ...read.integration, ...draft.data, mode: 'local' }, deps.home ? { home: deps.home } : {},
        );
      } catch (err) { answerError(res, err); return; }
    }
    const { account, gh_config_dir: configDir } = checked;
    const out = await login(configDir);
    if (!out.ok) {
      res.json({ ok: false, expected: account, code: out.code, reason: out.reason });
      return;
    }
    // GitHub logins ignore case.
    const matches = account !== null && out.login.toLowerCase() === account.toLowerCase();
    res.json({ ok: matches, login: out.login, expected: account, matches });
  });

  // The planner's check: the same rules and numbering as the plan's answer
  // (`checkPlanBranch`, a branch named with its kind), so the field never
  // accepts a name the daemon refuses.
  app.post('/api/projects/:slug/integration/branch', (req, res) => {
    const slug = plannerProject(req, res);
    if (!slug) return;
    const parsed = PlanBranchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      res.status(400).json(apiError('plan_branch_refused', detail, { detail }));
      return;
    }
    const found = landingSetting(slug);
    if (!found) {
      res.status(409).json(apiError('plan_branch_unavailable', `the integration setting of project ${slug} cannot be read`));
      return;
    }
    const out = checkPlanBranch(parsed.data.branch, found.setting, found.repo, {
      kind: parsed.data.kind ?? 'new', strict: true, local: found.setting.mode !== 'pr',
    });
    if (!out.ok) {
      res.status(400).json({
        ...apiError('plan_branch_refused', out.refusal, { detail: out.refusal }),
        ok: false, branch: out.branch, refusal: out.refusal,
      });
      return;
    }
    res.json({ ok: true, branch: out.branch });
  });
}
