/**
 * Module `routines` — recurring tasks driven by a cron expression.
 * Tier `std`. Injects `kanban`: a routine creates tasks.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { dbApi, isTaskType, type RoutineExtras, type RoutineRow, type TaskType } from '../../db.js';
import { delegationRefusal } from '../../delegation-guard.js';
import { automationOriginOf, emitAutomationEvent } from '../../plugins/automation-events.js';
import { backupStatus, createRoutine, enableBackupRoutine, routineTaskExtras, updateRoutine } from '../../routines.js';
import { forbidden, requestHasPermission } from '../../users/identity.js';
import { rejectOverride, spawnWideningDenied } from '../../users/privileged-overrides.js';
import { loadConfig, type AgentConfig } from '../../agent-config.js';
import { readSkillsAllowedTools } from '../../skills.js';
import { apiError, type ApiErrorBody } from '../../api-error.js';

/**
 * A routine is a schedule trigger (same rows, same Triggers page): the routes
 * ask what `/api/triggers` asks — an identity, `triggers:manage`, and the
 * caller only reaches its own rows (superadmin: all). Ownerless rows (the
 * daemon's, the nightly backup) are the superadmin's (TODO #573).
 */
const ROUTINES_PERMISSION = 'triggers:manage';
/** A routine opens tasks: what a trigger's `task` action needs. */
const TASK_PERMISSION = 'kanban:write';

function manager(req: Request, res: Response): boolean {
  if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return false; }
  if (!requestHasPermission(req, ROUTINES_PERMISSION)) {
    forbidden(req, res, { kind: 'permission', permission: ROUTINES_PERMISSION });
    return false;
  }
  return true;
}

function visible(req: Request, row: RoutineRow): boolean {
  if (req.auth?.isSuperadmin) return true;
  const me = req.auth?.user?.id ?? null;
  return me !== null && row.owner_user_id === me;
}

/** Someone else's routine answers like a missing one: its id leaks nothing. */
function loadVisible(req: Request, res: Response): RoutineRow | null {
  const value: unknown = req.params.id;
  const row = typeof value === 'string' ? dbApi.getRoutine(value) : undefined;
  if (!row || !visible(req, row)) { res.status(404).json(apiError('not_found', 'not found')); return null; }
  return row;
}

/**
 * Can this caller make `agent` receive a task at every tick? Its rows carry no
 * grants nor acting agent, so the run does not re-check: the save does, as a
 * trigger's save does — delegation first, then the task permission.
 */
function taskRefusal(req: Request, agent: string): ApiErrorBody | null {
  const denied = delegationRefusal(req, agent);
  if (denied) return apiError('orchestration_denied', `task refused: ${denied}`, { detail: denied });
  if (!requestHasPermission(req, TASK_PERMISSION)) {
    return apiError('routine_not_permitted', `not permitted: a routine opens tasks, which needs ${TASK_PERMISSION}`, { permission: TASK_PERMISSION });
  }
  return null;
}

/**
 * A routine opens a task at every tick, long after the mission that made it
 * and its revoked token: like a trigger (TODO #529), what an agent sets up is
 * born off and runs once a person switched it on. An agent cannot switch one
 * on, and changing what an enabled one does switches it off.
 */
const AGENT_ROUTINE_OFF = 'Saved switched off: a routine an agent sets up only runs once the user switches it on '
  + '(Triggers page). Tell the user it is waiting for them; do not create it again.';
const ROUTINE_BEHAVIOUR = ['agent_name', 'prompt', 'task_type', 'cron_expr', 'project'] as const;

/**
 * The extras a routine copies onto each task it opens (`kanban_add`'s fields,
 * same bounds). Absent = unchanged on an update; null or an empty list clears.
 */
const extrasList = z.array(z.string().min(1).max(512)).max(256).nullable().optional();
const extrasSchema = z.object({
  extra_skills: extrasList,
  extra_mcp_servers: extrasList,
  extra_allowed_tools: extrasList,
});

/** The extras of a request body, or the zod message that refuses them. */
function parseExtras(body: unknown): { ok: true; value: RoutineExtras } | { ok: false; error: string } {
  const parsed = extrasSchema.safeParse(body ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` };
}

function hasExtras(extras: RoutineExtras): boolean {
  return extras.extra_skills !== undefined || extras.extra_mcp_servers !== undefined
    || extras.extra_allowed_tools !== undefined;
}

/**
 * The extras go to a task at every tick, which then starts like one a person
 * wrote (the dispatcher re-judges only a mission's tasks): the rule is
 * `kanban_add`'s, applied at the save. From an agent's token, no tool, no
 * skill that pre-authorises one and no stdio MCP server the agent does not
 * already hold. `kept` is the routine being edited, when its agent stays: the
 * extras it already carries were judged then, and re-sending them grants
 * nothing new.
 */
function extrasWidening(req: Request, extras: RoutineExtras, agent: string, kept: RoutineRow | null): string | null {
  if (!hasExtras(extras)) return null;
  const config = (() => { try { return loadConfig(agent); } catch { return null; } })();
  let granted: AgentConfig | null = config;
  if (kept) {
    const stored = routineTaskExtras(kept);
    granted = {
      ...config,
      allowed_tools: [...(config?.allowed_tools ?? []), ...stored.extraAllowedTools, ...readSkillsAllowedTools(stored.extraSkills)],
      mcp_servers: [...(config?.mcp_servers ?? []), ...stored.extraMcpServers],
    } as AgentConfig;
  }
  return spawnWideningDenied(req, extras, granted, agent);
}

/** Whether `extras` changes what `row` copies onto its tasks (order counts, as stored). */
function extrasChanged(extras: RoutineExtras, row: RoutineRow): boolean {
  return (['extra_skills', 'extra_mcp_servers', 'extra_allowed_tools'] as const).some((key) => {
    const sent = extras[key];
    if (sent === undefined) return false;
    return (sent?.length ? JSON.stringify(sent) : null) !== row[key];
  });
}

/** Mission tokens are agents. Read from the credential, never from a header. */
function callerIsAgent(req: Request): boolean {
  return req.auth?.kind === 'api-token';
}

/**
 * The nightly backup archives the whole home, every account's data included,
 * and its status names where those archives lie: the superadmin's, like
 * `POST /api/admin/export` and `ctx.backup.enable` (TODO #611). A mission
 * reaches it only when its owner is a developer account; an ordinary one is
 * capped and gets a 403 pointing to the CLI.
 */
function backupOperator(req: Request, res: Response): boolean {
  if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return false; }
  if (!req.auth.isSuperadmin) {
    forbidden(req, res, {
      kind: 'operator',
      hint: 'The nightly backup covers every account: a superadmin manages it, or the operator runs `timon backup status|enable` from a terminal.',
    });
    return false;
  }
  return true;
}

export function registerRoutes(app: Router): void {
  app.get('/api/backup/status', (req, res) => {
    if (!backupOperator(req, res)) return;
    res.json(backupStatus());
  });

  app.post('/api/backup/enable', (req, res) => {
    if (!backupOperator(req, res)) return;
    try {
      res.json({ ok: true, ...enableBackupRoutine() });
    } catch (err) {
      res.status(400).json(apiError('backup_enable_failed', (err as Error).message, { detail: (err as Error).message }));
    }
  });

  app.get('/api/routines', (req, res) => {
    if (!manager(req, res)) return;
    res.json({ routines: dbApi.listRoutines().filter((r) => visible(req, r)) });
  });

  app.get('/api/routines/:id', (req, res) => {
    if (!manager(req, res)) return;
    const r = loadVisible(req, res);
    if (r) res.json({ routine: r });
  });

  app.post('/api/routines', (req, res) => {
    if (!manager(req, res)) return;
    const body = req.body as {
      name?: string; agent_name?: string; prompt?: string;
      task_type?: string; cron_expr?: string; enabled?: boolean;
      project?: string | null;
    };
    if (!body.name || !body.agent_name || !body.prompt || !body.cron_expr) {
      res.status(400).json(apiError('routine_fields_required', 'name, agent_name, prompt, cron_expr required'));
      return;
    }
    if (body.task_type !== undefined && !isTaskType(body.task_type)) {
      res.status(400).json(apiError('task_type_invalid', `invalid task_type "${body.task_type}"`, { type: String(body.task_type) }));
      return;
    }
    const extras = parseExtras(req.body);
    if (!extras.ok) { res.status(400).json({ error: extras.error }); return; }
    const refused = taskRefusal(req, body.agent_name);
    if (refused) { res.status(403).json(refused); return; }
    const widening = extrasWidening(req, extras.value, body.agent_name, null);
    if (widening) { rejectOverride(req, res, 'routine.override_denied', `agent:${body.agent_name}`, widening); return; }
    const byAgent = callerIsAgent(req);
    try {
      const r = createRoutine({
        name: body.name,
        agent_name: body.agent_name,
        prompt: body.prompt,
        task_type: body.task_type as TaskType | undefined,
        cron_expr: body.cron_expr,
        enabled: byAgent ? false : body.enabled,
        project: body.project ?? null,
        ownerUserId: req.auth?.user?.id ?? null,
        ...extras.value,
      });
      emitAutomationEvent({ kind: 'routine_created', row: r, origin: automationOriginOf(req) });
      res.status(201).json({ routine: r, ...(byAgent ? { needs_activation: true, message: AGENT_ROUTINE_OFF } : {}) });
    } catch (err) {
      res.status(400).json(apiError('routine_save_failed', (err as Error).message, { detail: (err as Error).message }));
    }
  });

  app.put('/api/routines/:id', (req, res) => {
    if (!manager(req, res)) return;
    const r = loadVisible(req, res);
    if (!r) return;
    const body = req.body as Record<string, unknown>;
    if (body.task_type !== undefined && !isTaskType(body.task_type)) {
      res.status(400).json(apiError('task_type_invalid', `invalid task_type "${body.task_type}"`, { type: String(body.task_type) }));
      return;
    }
    const extras = parseExtras(body);
    if (!extras.ok) { res.status(400).json({ error: extras.error }); return; }
    const fields = {
      name: typeof body.name === 'string' ? body.name : undefined,
      agent_name: typeof body.agent_name === 'string' ? body.agent_name : undefined,
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      task_type: body.task_type as TaskType | undefined,
      cron_expr: typeof body.cron_expr === 'string' ? body.cron_expr : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      project: 'project' in body ? (body.project as string | null) : undefined,
      ...extras.value,
    };
    // Switching off (or renaming) asks nothing more; anything that leaves it
    // opening tasks needs the caller to be allowed to open them, as on create.
    const offOnly = Object.entries(fields).every(([key, value]) => value === undefined || key === 'name'
      || (key === 'enabled' && value === false));
    if (!offOnly) {
      const refused = taskRefusal(req, fields.agent_name ?? r.agent_name);
      if (refused) { res.status(403).json(refused); return; }
    }
    // A routine handed to another agent carries its extras there: they are
    // judged again against that agent, as a reassigned task's are.
    const agent = fields.agent_name ?? r.agent_name;
    const reassigned = agent !== r.agent_name;
    const stored = routineTaskExtras(r);
    const judged: RoutineExtras = reassigned ? {
      extra_skills: fields.extra_skills === undefined ? stored.extraSkills : fields.extra_skills,
      extra_mcp_servers: fields.extra_mcp_servers === undefined ? stored.extraMcpServers : fields.extra_mcp_servers,
      extra_allowed_tools: fields.extra_allowed_tools === undefined ? stored.extraAllowedTools : fields.extra_allowed_tools,
    } : extras.value;
    const widening = extrasWidening(req, judged, agent, reassigned ? null : r);
    if (widening) { rejectOverride(req, res, 'routine.override_denied', `agent:${agent}`, widening); return; }
    let switchedOff = false;
    if (callerIsAgent(req)) {
      if (r.enabled !== 1 && fields.enabled === true) {
        res.status(403).json(apiError('routine_enable_by_agent', 'an agent cannot switch a routine on: the user does it (Triggers page)'));
        return;
      }
      switchedOff = r.enabled === 1 && fields.enabled !== false
        && (ROUTINE_BEHAVIOUR.some((key) => fields[key] !== undefined && fields[key] !== r[key])
          || extrasChanged(extras.value, r));
      if (switchedOff) fields.enabled = false;
    }
    try {
      const updated = updateRoutine(r.id, fields);
      emitAutomationEvent({ kind: 'routine_updated', row: updated, origin: automationOriginOf(req) });
      res.json({ routine: updated, ...(switchedOff ? { needs_activation: true, message: AGENT_ROUTINE_OFF } : {}) });
    } catch (err) {
      res.status(400).json(apiError('routine_save_failed', (err as Error).message, { detail: (err as Error).message }));
    }
  });

  app.delete('/api/routines/:id', (req, res) => {
    if (!manager(req, res)) return;
    const r = loadVisible(req, res);
    if (!r) return;
    dbApi.deleteRoutine(r.id);
    emitAutomationEvent({ kind: 'routine_deleted', row: r, origin: automationOriginOf(req) });
    res.json({ ok: true });
  });
}
