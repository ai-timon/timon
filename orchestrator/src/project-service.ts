/**
 * Project operations shared by the HTTP routes (`plugins-bundled/projects`) and
 * the plugin facade (`plugins/projects-facade.ts`): what a body may contain,
 * how a workspace is resolved, how a role spec is read. Extracted verbatim from
 * the routes so both callers apply one rule.
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { asBackendName } from './backends/index.js';
import { getAgent } from './agent.js';
import { bus, type ProjectEventOrigin } from './bus.js';
import { dbApi } from './db.js';
import { checkCwd, type CwdError } from './project-cwd.js';
import { createProject, isProjectIcon, listProjects, PROJECT_ICON_TEXT_MAX, setRole, writeMeta, type ProjectMeta, type ProjectRoles, type RoleSpec, type TaskRole } from './projects.js';
import { checkRoleAgentCwd } from './task-guards.js';
import { findWorkspaceByTag, listWorkspaceRecords } from './workspaces.js';

/** Body of a project create/update. Lenient on purpose about WHICH keys may
 *  come (the UI also sends `slug`, and `workspace: ''` clears the pole), strict
 *  about each field's type and size. `workspace_policy` is how a caller opts in
 *  to workspace validation: the UI keeps typing free text and lets a new pole
 *  appear, the MCP tools ask for `existing` (a typo is refused) or `create`. */
export const ProjectMetaBody = z.object({
  slug: z.string().max(120).optional(),
  // Ceilings are generous on purpose: the edit dialog sends back everything
  // already stored, so a bound a legacy value could exceed would lock the
  // project out of any save.
  name: z.string().max(500).optional(),
  color: z.string().max(200).optional(),
  // The edit dialog sends the stored icon back, but a stored value that breaks
  // this rule already reads as null (`projectIcon`), so it cannot lock a save.
  icon: z.string().refine(isProjectIcon, {
    message: `an emoji or short text (up to ${PROJECT_ICON_TEXT_MAX} characters) or a picture uploaded to Timon (/api/uploads/projects/…); a web address is refused`,
  }).optional(),
  workspace: z.string().max(200).optional(),
  cwd: z.string().max(4096).optional(),
  speech: z.string().max(20000).optional(),
  kind: z.string().max(200).optional(),
  status: z.string().max(200).optional(),
  workspace_policy: z.enum(['free', 'existing', 'create']).optional(),
  /** Creation, HTTP route only: seed the project's orchestrator with it (needs `cwd`). */
  with_orchestrator: z.boolean().optional(),
  /** Empty string clears the field (back to the local default). */
  integration: z.enum(['local', 'pull-request', '']).optional(),
  /** Empty string clears the field (back to squash). Read only when integration is pull-request. */
  merge_strategy: z.enum(['squash', 'merge', 'rebase', '']).optional(),
});
export type WorkspacePolicy = 'free' | 'existing' | 'create';

/** Filters a create/update body into a ProjectMeta. Absent fields stay
 *  undefined so writeMeta keeps the slug's auto-color when nothing is pushed.
 *  Returns the validation error (→ 400) instead of silently dropping a field
 *  of the wrong type. */
export function parseProjectMetaBody(raw: unknown): { meta: ProjectMeta; policy: WorkspacePolicy } | { error: string } {
  const parsed = ProjectMetaBody.safeParse(raw && typeof raw === 'object' ? raw : {});
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') };
  }
  const body = parsed.data;
  const meta: ProjectMeta = {};
  if (body.name !== undefined) meta.name = body.name;
  if (body.color !== undefined) meta.color = body.color;
  if (body.icon !== undefined) meta.icon = body.icon;
  if (body.workspace !== undefined) meta.workspace = body.workspace;
  if (body.cwd !== undefined) meta.cwd = body.cwd;
  if (body.speech !== undefined) meta.speech = body.speech;
  // kind/status: empty string = explicit clear (→ null).
  if (body.kind !== undefined) meta.kind = body.kind.trim() || null;
  if (body.status !== undefined) meta.status = body.status.trim() || null;
  if (body.integration !== undefined) meta.integration = body.integration || null;
  if (body.merge_strategy !== undefined) meta.merge_strategy = body.merge_strategy || null;
  return { meta, policy: body.workspace_policy ?? 'free' };
}

/** Applies the workspace policy to `meta.workspace` and returns an error text
 *  (→ 400) or null. `existing` stores the pole's canonical name, so "agence ia"
 *  and "Design Studio" can never become two poles; `create` makes the pole only
 *  once the project is written (`commit`), so a refused request leaves no orphan
 *  pole behind. */
export function resolveWorkspace(meta: ProjectMeta, policy: WorkspacePolicy): { error: string } | { commit: () => void } {
  const tag = meta.workspace?.trim();
  if (policy === 'free' || !tag) return { commit: () => {} };
  const pole = findWorkspaceByTag(tag);
  if (pole) {
    meta.workspace = pole.name;
    return { commit: () => {} };
  }
  if (policy === 'existing') {
    const known = listWorkspaceRecords().map((w) => w.name).sort();
    return { error: `unknown workspace "${tag}" (known: ${known.length ? known.join(', ') : 'none'}); pass create_workspace to create it` };
  }
  meta.workspace = tag;
  // The tag on the project row is what makes the pole: reading it back syncs
  // the table, which is the one way a pole has ever been born from a tag.
  return { commit: () => { findWorkspaceByTag(tag); } };
}

/** Accepts a raw entry (legacy string or object {agent, model?, permission_mode?})
 *  and returns a normalised RoleSpec, or null if invalid/empty. */
export function parseRoleSpecInput(raw: unknown): RoleSpec | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'string') return { agent: raw };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.agent !== 'string' || !o.agent) return null;
  const spec: RoleSpec = { agent: o.agent };
  const backend = asBackendName(o.backend);
  if (backend) spec.backend = backend;
  if (typeof o.model === 'string' && o.model) spec.model = o.model;
  if (typeof o.permission_mode === 'string' && o.permission_mode) {
    spec.permission_mode = o.permission_mode;
  }
  // `mcp_servers` was read when READING the file (`normalizeSpec`) but not on
  // write: changing a role's model therefore erased its MCPs without a
  // word. The librarian lost its notes connector that way — the agent then ran
  // without its search tool, and nothing in the response said so.
  if (Array.isArray(o.mcp_servers)) {
    spec.mcp_servers = (o.mcp_servers as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  return spec;
}

/** Refuses to assign to a project role an agent that works in ANOTHER
 *  repo. Returns the error message (→ 400) or null if the assignment is
 *  sound. See `checkRoleAgentCwd` (task-guards.ts) for the detail and
 *  the founding incident of 2026-08-06. */
export function roleAgentCwdError(slug: string, role: string, agent: string, force: boolean): string | null {
  let exists = false;
  let agentCwd: string | null = null;
  try {
    const a = getAgent(agent);
    exists = !!a;
    agentCwd = a?.cwd ?? null;
  } catch {
    // Invalid name: not this guard's call, let it through.
    return null;
  }
  return checkRoleAgentCwd({
    slug,
    role,
    agent,
    agentCwd,
    projectCwd: dbApi.getProjectRow(slug)?.cwd ?? null,
    agentExists: exists,
    force,
  });
}

// ── Operations (shared by the routes and the plugin facade) ──────────────────

export const TASK_ROLES: TaskRole[] = ['code', 'review', 'merge', 'research', 'doc', 'chore'];

/** `code`: `invalid` (400), `not_found` (404), `forbidden` (403). A refusal that
 *  the route must audit carries `audit` (the `project.cwd_denied` trail). */
export type ProjectErrorCode = 'invalid' | 'not_found' | 'forbidden';

export class ProjectServiceError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
    readonly audit?: { action: string; target: string },
  ) {
    super(message);
    this.name = 'ProjectServiceError';
  }
}

/** What the cwd gate tells the caller about a path the daemon cannot use. The
 *  UI turns `error` into a sentence; `message` is for CLI, MCP and plugin callers. */
export type CwdWarning = { field: 'cwd'; error: CwdError; code: string; path: string; message: string };

/**
 * The cwd bound shared by create and edit. Absolute for everybody. A path the
 * daemon cannot `stat` is refused for a non-privileged caller (a mission token
 * holds `projects:manage` through the cap, TIM-0013, and so does a human
 * manager who is not superadmin) and only WARNED about for a privileged one:
 * the owner may register a path from another machine or an unmounted volume.
 * The check runs even when the cwd is unchanged — the edit dialog sends the
 * stored cwd back on every save, and a path that went bad since must surface —
 * but an unchanged path is never refused, or nobody could save another field.
 * An already-registered cwd is not moved by a non-privileged caller: role
 * agents (`checkRoleAgentCwd`), the grepai watcher (keyed by cwd) and task
 * worktrees all hang off the old directory.
 */
export function gateProjectCwd(slug: string, cwd: string | undefined, privileged: boolean): CwdWarning[] {
  if (cwd === undefined || cwd === '') return [];
  const unchanged = dbApi.getProjectRow(slug)?.cwd === cwd;
  if (!unchanged && !isAbsolute(cwd)) {
    throw new ProjectServiceError('invalid', `cwd must be an absolute path: "${cwd}"`);
  }
  const check = checkCwd(cwd);
  if (!check.ok) {
    if (!unchanged && !privileged) {
      throw new ProjectServiceError(
        'forbidden',
        `cwd must be an existing directory on the host: "${cwd}" (${check.code})`,
        { action: 'project.cwd_denied', target: `project:${slug}` },
      );
    }
    return [{
      field: 'cwd', error: check.error, code: check.code, path: cwd,
      message: `the daemon cannot use "${cwd}" as a working directory (${check.error}, ${check.code})`,
    }];
  }
  if (unchanged || privileged) return [];
  const current = dbApi.getProjectRow(slug)?.cwd;
  if (current && current !== cwd) {
    throw new ProjectServiceError(
      'forbidden',
      `the cwd of a registered project is not changed here (role agents, grepai and worktrees follow it): "${current}"`,
      { action: 'project.cwd_denied', target: `project:${slug}` },
    );
  }
  return [];
}

export type ProjectWriteContext = {
  /** Lifts the cwd refusals (superadmin, or the unauthenticated first run). */
  privileged: boolean;
  origin: ProjectEventOrigin;
};

/** Registers a project. `createdBy` (`plugin:<id>`) is the facade's mark; no body field reaches it. */
export function createProjectFromBody(
  raw: unknown,
  ctx: ProjectWriteContext & { createdBy?: string },
): { project: ProjectMeta & { slug: string }; warnings: CwdWarning[] } {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (!slug) throw new ProjectServiceError('invalid', 'slug required');
  const parsed = parseProjectMetaBody(body);
  if ('error' in parsed) throw new ProjectServiceError('invalid', parsed.error);
  const { meta, policy } = parsed;
  const warnings = gateProjectCwd(slug, meta.cwd ?? undefined, ctx.privileged);
  try {
    const ws = resolveWorkspace(meta, policy);
    if ('error' in ws) throw new ProjectServiceError('invalid', ws.error);
    createProject(slug, meta);
    ws.commit();
    if (ctx.createdBy) dbApi.setProjectCreatedBy(slug, ctx.createdBy);
  } catch (err) {
    if (err instanceof ProjectServiceError) throw err;
    throw new ProjectServiceError('invalid', (err as Error).message);
  }
  bus.publish({ kind: 'project_created', slug, origin: ctx.origin });
  return { project: { slug, ...meta }, warnings };
}

/**
 * Edits a project's metadata. `requireExisting` defaults to "the caller opted
 * into workspace validation": `writeMeta` upserts, so without it a typo in the
 * slug mints a ghost row — the UI has always been able to save a project whose
 * row was never written, so only strict callers get the refusal.
 */
export function updateProjectFromBody(
  slug: string,
  raw: unknown,
  ctx: ProjectWriteContext & { requireExisting?: boolean },
): { meta: ProjectMeta; warnings: CwdWarning[] } {
  if (!raw || typeof raw !== 'object') {
    throw new ProjectServiceError('invalid', 'body must be {name?, color?, icon?, workspace?, cwd?, speech?}');
  }
  const parsed = parseProjectMetaBody(raw);
  if ('error' in parsed) throw new ProjectServiceError('invalid', parsed.error);
  const { meta, policy } = parsed;
  if ((ctx.requireExisting ?? policy !== 'free') && !listProjects().includes(slug)) {
    throw new ProjectServiceError('not_found', `unknown project: "${slug}"`);
  }
  const warnings = gateProjectCwd(slug, meta.cwd ?? undefined, ctx.privileged);
  let written: ProjectMeta;
  try {
    const ws = resolveWorkspace(meta, policy);
    if ('error' in ws) throw new ProjectServiceError('invalid', ws.error);
    written = writeMeta(slug, meta);
    ws.commit();
  } catch (err) {
    if (err instanceof ProjectServiceError) throw err;
    throw new ProjectServiceError('invalid', (err as Error).message);
  }
  bus.publish({ kind: 'project_updated', slug, changed: Object.keys(meta), origin: ctx.origin });
  return { meta: written, warnings };
}

/** Pins (or clears, with a null spec) the agent that runs `role` on a project. */
export function setProjectRoleFromInput(
  slug: string,
  role: string,
  rawSpec: unknown,
  ctx: { force: boolean; origin: ProjectEventOrigin },
): ProjectRoles {
  if (!(TASK_ROLES as string[]).includes(role)) throw new ProjectServiceError('invalid', `invalid role "${role}"`);
  // Two formats (back-compat): `{ agent: "X" }`, or `{ agent, backend?, model?, permission_mode? }`;
  // `{ agent: "" }` or an empty body clears the role.
  const spec = parseRoleSpecInput(rawSpec);
  if (spec) {
    const refusal = roleAgentCwdError(slug, role, spec.agent, ctx.force);
    if (refusal) throw new ProjectServiceError('invalid', refusal);
  }
  let roles: ProjectRoles;
  try {
    roles = setRole(slug, role as TaskRole, spec);
  } catch (err) {
    throw new ProjectServiceError('invalid', (err as Error).message);
  }
  announceProjectUpdated(slug, ['roles'], ctx.origin);
  return roles;
}

export function announceProjectUpdated(slug: string, changed: readonly string[], origin: ProjectEventOrigin): void {
  bus.publish({ kind: 'project_updated', slug, changed, origin });
}
