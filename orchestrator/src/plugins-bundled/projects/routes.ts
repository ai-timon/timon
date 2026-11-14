/**
 * Module `@timon/projects` — projects: list, meta, activity, roles per task
 * type, and the uploaded images that illustrate them. Tier `std`: the module
 * switches off, the helpers of `projects.ts` stay readable by the others.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Router } from 'express';
import { listAgents, loadConfig } from '../../agent.js';
import { db, dbApi } from '../../db.js';
import { autoColorFor, listProjects, readMeta, readRoles, type RoleSpec, writeRoles } from '../../projects.js';
import { ProjectHasAgentsError, removeProject, type AgentsFate } from '../../project-removal.js';
import { ensureProjectOrchestrator, inheritedLlm, previewRoleAgent, roleForTaskType } from '../../agent-seed.js';
import { readProjectIcon, saveProjectIcon } from '../../uploads.js';
import { createDemoProject } from '../../project-demo.js';
import { rejectIfDenied } from '../../users/identity.js';
import { agentConfigRefusal, agentWideningDenied, isPrivilegedCaller, overrideAuthority, rejectOverride } from '../../users/privileged-overrides.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  announceProjectUpdated, createProjectFromBody, parseRoleSpecInput, ProjectServiceError, roleAgentCwdError,
  setProjectRoleFromInput, TASK_ROLES, updateProjectFromBody,
} from '../../project-service.js';
import { todoOriginFromRequest } from '../../todo-origin.js';
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaceRecords, updateWorkspace } from '../../workspaces.js';
import { apiError } from '../../api-error.js';

const HEX_COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const AGENT_NAME = z.string().trim().min(1).max(120);
const WorkspaceCreate = z.object({
  name: z.string().trim().min(1).max(60),
  color: HEX_COLOR.nullable().optional(),
  lead_agent: AGENT_NAME.nullable().optional(),
}).strict();
const WorkspacePatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: HEX_COLOR.nullable().optional(),
  lead_agent: AGENT_NAME.nullable().optional(),
}).strict();

/** The service's refusal as the route answers it; a cwd refusal also leaves its audit trail. */
function answerProjectError(req: Request, res: Response, err: unknown): void {
  if (!(err instanceof ProjectServiceError)) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }
  if (err.audit) {
    rejectOverride(req, res, err.audit.action, err.audit.target, err.message);
    return;
  }
  res.status(err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400).json({ error: err.message });
}

/**
 * A role pin runs over the agent's own config at dispatch: a non-privileged
 * caller may not pin more than it could give an agent itself (the plugin
 * facade already held to this). Judged on the spec as it will be stored, and
 * against the pin already there, so an unchanged admin pin re-sent with the
 * others is not refused.
 */
function roleLlmRefusal(req: Request, slug: string, role: string, spec: RoleSpec | null): string | null {
  if (!spec) return null;
  let current: RoleSpec | undefined;
  try { current = readRoles(slug)[role as keyof ReturnType<typeof readRoles>]; } catch { current = undefined; }
  // A role's MCP servers replace its agent's at dispatch: attaching a stdio one
  // there needs a person, whatever an agent's token holds (same rule as the
  // agent's own `mcp_servers`). What the pin or the agent already holds passes.
  if (spec.mcp_servers) {
    let agentServers: string[] = [];
    try { agentServers = loadConfig(spec.agent).mcp_servers ?? []; } catch { /* unknown agent: holds none */ }
    const widening = agentWideningDenied(
      req,
      { mcp_servers: spec.mcp_servers },
      { mcp_servers: [...(current?.mcp_servers ?? []), ...agentServers] },
      { mcp_servers: `role ${role} mcp_servers` },
    );
    if (widening) return widening;
  }
  if (isPrivilegedCaller(req)) return null;
  const llm: Record<string, unknown> = {};
  if (spec.backend !== undefined) llm.backend = spec.backend;
  if (spec.model !== undefined) llm.model = spec.model;
  if (spec.permission_mode !== undefined) llm.permission_mode = spec.permission_mode;
  if (!Object.keys(llm).length) return null;
  const pinned = current
    ? { backend: current.backend ?? undefined, model: current.model ?? undefined, permission_mode: current.permission_mode ?? undefined }
    : null;
  return agentConfigRefusal(llm, pinned, overrideAuthority(req));
}

/** Who writes, as the shared operations need it. */
const writerOf = (req: Request) => ({ privileged: isPrivilegedCaller(req), origin: todoOriginFromRequest(req) });

export function registerRoutes(app: Router): void {
  app.get('/api/projects', (_req, res) => {
    // Returns the slugs + their aggregated meta to avoid an N+1 fan-out
    // on the UI side (agents canvas and workspace picker both call it).
    // The returned colour is always defined: meta.color if present,
    // otherwise auto-derived from the name/slug so that consumers have
    // a visual signature even when the user configured nothing.
    const slugs = listProjects();
    const projects = slugs.map((slug) => {
      const meta = readMeta(slug);
      return {
        slug,
        ...meta,
        color: meta.color || autoColorFor(meta.name || slug),
      };
    });
    // Names of every pole, empty ones included (the table), which also
    // covers every tag a project carries (synced into the table on read).
    res.json({ projects, workspaces: listWorkspaceRecords().map((w) => w.name).sort() });
  });

  // Poles. Reads are open like the project list; writing one is
  // `projects:manage`, the same permission as creating the projects it groups.
  app.get('/api/workspaces', (_req, res) => {
    try { res.json({ workspaces: listWorkspaceRecords() }); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/workspaces', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const parsed = WorkspaceCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try { res.status(201).json({ workspace: createWorkspace(parsed.data) }); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.patch('/api/workspaces/:slug', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const parsed = WorkspacePatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    if (!getWorkspace(req.params.slug)) {
      res.status(404).json(apiError('workspace_unknown', 'unknown workspace'));
      return;
    }
    try { res.json({ workspace: updateWorkspace(req.params.slug, parsed.data) }); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.delete('/api/workspaces/:slug', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    if (!getWorkspace(req.params.slug)) {
      res.status(404).json(apiError('workspace_unknown', 'unknown workspace'));
      return;
    }
    try { deleteWorkspace(req.params.slug); res.json({ ok: true }); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.get('/api/projects/activity', (_req, res) => {
    try {
      const byProject = new Map<string, number>();
      const bump = (slug: string | null | undefined, at: number | null | undefined) => {
        if (!slug || !at) return;
        const key = slug.toLowerCase();
        byProject.set(key, Math.max(byProject.get(key) ?? 0, at));
      };

      for (const row of dbApi.listProjectRows()) bump(row.slug, row.last_activity);

      const projectOfAgent = new Map<string, string>();
      for (const a of listAgents()) {
        if (a.project) projectOfAgent.set(a.name, a.project);
      }
      for (const r of dbApi.lastActivityByAgent()) {
        bump(projectOfAgent.get(r.agent_name), r.at);
      }

      res.json({ activity: Object.fromEntries(byProject) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Creating, deleting or reconfiguring a project (its `cwd` widens the set
  // of directories a spawn override may target — `privileged-overrides.ts`)
  // is `projects:manage` (SECU-USERS U-3). Reads stay open: slugs and meta
  // are what every picker needs.
  app.post('/api/projects', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try {
      const { project, warnings } = createProjectFromBody(req.body, writerOf(req));
      // The onboarding tour asks for it: a project it creates has its own
      // orchestrator, under the main agent, for its coder to report to. Route
      // only — the plugin facade runs in jobs, which have no cwd to seed from.
      const orchestrator = (req.body as { with_orchestrator?: unknown } | undefined)?.with_orchestrator === true
        ? ensureProjectOrchestrator(project.slug, { cwd: project.cwd ?? null, inherit: inheritedLlm(req.auth?.missionId) })
        : undefined;
      res.json({
        project,
        ...(orchestrator !== undefined ? { orchestrator } : {}),
        ...(warnings.length ? { warnings } : {}),
      });
    } catch (err) { answerProjectError(req, res, err); }
  });

  // The developer tour's sample repository: same right as any project creation.
  app.post('/api/projects/demo', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try {
      res.json(createDemoProject({ inherit: inheritedLlm(req.auth?.missionId), origin: todoOriginFromRequest(req) }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/uploads/projects', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    try {
      res.json(saveProjectIcon(body));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/uploads/projects/:file', (req, res) => {
    try {
      const { bytes, contentType } = readProjectIcon(req.params.file);
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      res.send(bytes);
    } catch (err) {
      const msg = (err as Error).message;
      res.status(msg === 'not found' ? 404 : 400).json({ error: msg });
    }
  });

  // What becomes of the project's agents is the caller's call: `?agents=delete|detach` or
  // `?agents=move&to=<slug>`. Without it, a project that still has agents is refused (409)
  // and the agents are listed, instead of being orphaned behind the user's back.
  const projectRemovalQuery = z.object({
    agents: z.enum(['delete', 'detach', 'move']).optional(),
    to: z.string().min(1).max(100).optional(),
  }).strict().refine((q) => (q.agents === 'move') === (q.to !== undefined), {
    message: '`to` goes with `agents=move`, and only with it',
  });

  app.delete('/api/projects/:slug', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const query = projectRemovalQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.issues[0]?.message ?? 'invalid query' });
      return;
    }
    const { agents, to } = query.data;
    // Deleting, detaching or moving agents changes agents, not just the project.
    if (agents && rejectIfDenied(req, res, 'agents:manage')) return;
    try {
      const fate: AgentsFate | undefined = agents === 'move' ? { mode: 'move', to: to! } : agents ? { mode: agents } : undefined;
      res.json({ ok: true, ...removeProject(req.params.slug, fate) });
    } catch (err) {
      if (err instanceof ProjectHasAgentsError) {
        res.status(409).json({ error: err.message, agents: err.agents });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/projects/:slug/meta', (req, res) => {
    try { res.json({ meta: readMeta(req.params.slug) }); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.put('/api/projects/:slug/meta', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try {
      const { meta, warnings } = updateProjectFromBody(req.params.slug, req.body, writerOf(req));
      res.json({ meta, ...(warnings.length ? { warnings } : {}) });
    } catch (err) { answerProjectError(req, res, err); }
  });

  app.get('/api/projects/:slug/roles', (req, res) => {
    try {
      const roles = readRoles(req.params.slug);
      // `resolved` says WHO would actually run each kind of task — the pin if
      // there is one, else the agent of the project that carries the role,
      // else the name that would be created on the first task. Without it, a
      // screen showing roles.json shows the exception and hides the rule: most
      // projects pin nothing and are dispatched by role.
      const resolved: Record<string, unknown> = {};
      for (const type of TASK_ROLES) {
        const preview = previewRoleAgent(req.params.slug, roleForTaskType(type), roles[type]);
        if (preview) resolved[type] = preview;
      }
      res.json({ roles, resolved });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/projects/:slug/roles', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'body must be an object {role: {agent, model?, permission_mode?}}' });
      return;
    }
    const force = body.force === true;
    const roles: Record<string, RoleSpec> = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === 'force') continue; // override flag, not a role
      if (!(TASK_ROLES as string[]).includes(k)) {
        res.status(400).json({ error: `invalid role "${k}"` });
        return;
      }
      const spec = parseRoleSpecInput(v);
      if (spec) {
        const err = roleAgentCwdError(req.params.slug, k, spec.agent, force);
        if (err) { res.status(400).json({ error: err }); return; }
        const refusal = roleLlmRefusal(req, req.params.slug, k, spec);
        if (refusal) { rejectOverride(req, res, 'project.role_denied', `${req.params.slug}/${k}`, refusal); return; }
        roles[k] = spec;
      }
    }
    try {
      const written = writeRoles(req.params.slug, roles);
      announceProjectUpdated(req.params.slug, ['roles'], todoOriginFromRequest(req));
      res.json({ roles: written });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/projects/:slug/roles/:role', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try {
      const force = (req.body as Record<string, unknown> | undefined)?.force === true;
      const refusal = roleLlmRefusal(req, req.params.slug, req.params.role, parseRoleSpecInput(req.body));
      if (refusal) { rejectOverride(req, res, 'project.role_denied', `${req.params.slug}/${req.params.role}`, refusal); return; }
      res.json({ roles: setProjectRoleFromInput(req.params.slug, req.params.role, req.body, { force, origin: todoOriginFromRequest(req) }) });
    } catch (err) { answerProjectError(req, res, err); }
  });
}
