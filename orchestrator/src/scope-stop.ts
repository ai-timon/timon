/**
 * Technical stop of a scope — one agent, or every agent of a project.
 *
 * A "STOP" typed in a chat stops nothing: the inbox still wakes the agent, an
 * open request still gets its automatic reply, the dispatcher still starts the
 * next PENDING task and a schedule still fires. And an empty Kanban does not
 * prove the triggers are idle. This neutralises every one of those paths in
 * one gesture, and lists what it touched.
 *
 * Order is load-bearing:
 *  1. tasks go BLOCKED before their mission dies — a deliberate kill exits as
 *     `completed`, which the dispatcher would otherwise read as a DONE task and
 *     chain a review on;
 *  2. the missions' work return is marked delivered and their open request
 *     deliveries settled before the kill — the exit handler would otherwise
 *     post a `mission_complete` to the pilot and a "could not complete" reply
 *     to every requester, each of which wakes someone;
 *  3. pending messages are taken off the inbox, so the wake-loop finds nothing
 *     to deliver when the dead missions report in;
 *  4. the scope's live workflow runs are cancelled before any of their
 *     missions dies — a killed node mission on a run still `running` is
 *     retried or reported to the run's pilot, which respawns the very agent
 *     being stopped; the cancellation report the engine posts to that pilot
 *     is taken off the inbox for the same reason;
 *  5. only then are the processes signalled.
 *
 * The workflows the scope pilots, files or runs a node of are switched off
 * (`workflows.enabled = 0`), not just their triggers: a façade trigger is
 * re-aligned on that switch at every boot, and a plugin entry node checks it
 * at every emit, so a trigger switched off alone would fire again. Same
 * gesture the user makes on the workflow's switch, undone the same way;
 * manual runs stay possible.
 *
 * None of these writes publishes `task_blocked`: that event wakes the series
 * pilot (which may re-queue the task) and fires the user's event triggers —
 * the very activity a stop is meant to end.
 *
 * Ownership: `owner` undefined acts on every row (superadmin); a user id acts
 * on that user's rows only, whatever `:read:all` grant they hold — reading
 * everyone's missions is not stopping them.
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { canonicalAgentName } from './agent-config.js';
import { killAgent, listAgents } from './agent.js';
import { daemonMessage, encodeDaemonMessage } from './daemon-message.js';
import { db, dbApi, type TaskStatus } from './db.js';
import { agentDir } from './paths.js';
import { redactText } from './secrets/redact.js';
import { disableTriggerRow, listTriggerRows, parseTrigger } from './triggers/store.js';
import { cancelRun } from './workflows/engine.js';
import { disarmWorkflowTriggers } from './workflows/triggers.js';
import { workflowAgentName } from './workflows/nodes/agent.js';
import { parseStoredWorkflowDefinition } from './workflows/schema.js';

/** An agent name is a directory name: no separator, no `.`/`..`. */
const SCOPE_NAME = z.string().trim().min(1).max(200)
  .regex(/^[^/\\\0]+$/).refine((name) => name !== '.' && name !== '..');
export const StopBodySchema = z.union([
  z.object({ agent: SCOPE_NAME }).strict(),
  z.object({ project: SCOPE_NAME }).strict(),
]);

export type StopScope = { agent: string } | { project: string };

export type StopReport = {
  scope: { kind: 'agent' | 'project'; name: string };
  agents: string[];
  missions: { id: string; agent: string; outcome: 'killed' | 'closed' | 'not_found' }[];
  messages: { id: string; from_agent: string; to_agent: string; kind: string }[];
  deliveries: { request_id: string; mission_id: string }[];
  tasks: { id: string; title: string; agent: string; status: TaskStatus; scheduled_at: number | null }[];
  triggers: { id: string; name: string; source: string }[];
  workflow_runs: { id: string; workflow: string }[];
  workflows: { id: string; workflow: string }[];
};

/** The scope names nothing this daemon knows. */
export class UnknownScopeError extends Error {}

/** Sender of human escalations: they wait for a person, never wake an agent. */
const HUMAN_ESCALATION_SENDER = 'orchestrator';

function resolveAgents(scope: StopScope): { kind: 'agent' | 'project'; name: string; agents: string[]; project: string | null } {
  if ('agent' in scope) {
    const name = canonicalAgentName(scope.agent);
    if (!existsSync(agentDir(name))) throw new UnknownScopeError(`unknown agent: ${scope.agent}`);
    return { kind: 'agent', name, agents: [name], project: null };
  }
  const agents = listAgents().filter((a) => a.project === scope.project).map((a) => a.name);
  if (agents.length === 0 && !dbApi.getProjectRow(scope.project)) {
    throw new UnknownScopeError(`unknown project: ${scope.project}`);
  }
  return { kind: 'project', name: scope.project, agents, project: scope.project };
}

/** Agents a version's `agent`/`skill` nodes run: a `ref`, or the inline `wf.<slug>.<node>` identity. */
function nodeAgents(workflowId: string, versionNumber: number, slug: string): string[] {
  const version = dbApi.getWorkflowVersion(workflowId, versionNumber);
  if (!version) return [];
  try {
    return parseStoredWorkflowDefinition(JSON.parse(version.definition)).nodes
      .filter((node) => node.type === 'agent' || node.type === 'skill')
      .flatMap((node) => typeof node.config.ref === 'string' && node.config.ref ? [canonicalAgentName(node.config.ref)]
        : node.config.identity ? [workflowAgentName(slug, node.id)] : []);
  } catch {
    return [];
  }
}

/**
 * Live workflow runs the scope takes part in: piloted by one of its agents,
 * filed under its project, already running a mission on one of its agents,
 * or with a node still to come that would start one (a `ref` to the agent or
 * the inline `wf.<slug>.<node>` identity).
 */
function scopeRuns(agents: Set<string>, project: string | null, owner: string | undefined): StopReport['workflow_runs'] {
  const own = ownerClause(owner, 'r.owner_user_id');
  const rows = db.prepare(
    `SELECT r.id, r.workflow_id, r.version, w.slug, w.agent_name, w.project FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflow_id
      WHERE r.status IN ('pending', 'running', 'waiting') AND ${own.sql}`,
  ).all(...own.params) as { id: string; workflow_id: string; version: number; slug: string; agent_name: string | null; project: string | null }[];
  const agentsJson = JSON.stringify([...agents]);
  const hasMission = db.prepare(
    `SELECT 1 FROM missions WHERE workflow_run_id = ? AND agent_name IN (SELECT value FROM json_each(?)) LIMIT 1`,
  );
  return rows
    .filter((row) => (row.agent_name !== null && agents.has(canonicalAgentName(row.agent_name)))
      || (project !== null && row.project === project)
      || hasMission.get(row.id, agentsJson) !== undefined
      || nodeAgents(row.workflow_id, row.version, row.slug).some((name) => agents.has(name)))
    .map((row) => ({ id: row.id, workflow: row.slug }));
}

/**
 * Switched-on published workflows whose next automatic run would put the scope
 * to work: piloted by one of its agents, filed under its project, or with an
 * `agent`/`skill` node on one of its agents. A draft never fires.
 */
function scopeWorkflows(agents: Set<string>, project: string | null, owner: string | undefined): StopReport['workflows'] {
  const own = ownerClause(owner);
  const rows = db.prepare(
    `SELECT id, slug, agent_name, project, published_version FROM workflows
      WHERE enabled = 1 AND published_version IS NOT NULL AND ${own.sql}`,
  ).all(...own.params) as { id: string; slug: string; agent_name: string | null; project: string | null; published_version: number }[];
  return rows
    .filter((row) => (row.agent_name !== null && agents.has(canonicalAgentName(row.agent_name)))
      || (project !== null && row.project === project)
      || nodeAgents(row.id, row.published_version, row.slug).some((name) => agents.has(name)))
    .map((row) => ({ id: row.id, workflow: row.slug }));
}

function pickMessages(messages: StopReport['messages'], now: number): void {
  const pick = db.prepare(`UPDATE agent_messages SET status = 'picked', picked_at = ? WHERE id = ? AND status = 'pending'`);
  for (const m of messages) pick.run(now, m.id);
  if (messages.length) {
    dbApi.upsertSpans(messages.map((m) => ({
      op: 'close' as const, id: `message:${m.id}`, status: 'interrupted' as const, ended_at: now, event_id_end: now,
    })));
  }
}

function ownerClause(owner: string | undefined, column = 'owner_user_id'): { sql: string; params: unknown[] } {
  return owner === undefined ? { sql: '1=1', params: [] } : { sql: `${column} = ?`, params: [owner] };
}

export function stopScope(scope: StopScope, opts: { owner: string | undefined; by: string }): StopReport {
  const resolved = resolveAgents(scope);
  const agentsJson = JSON.stringify(resolved.agents);
  const inAgents = (column: string) => `${column} IN (SELECT value FROM json_each(?))`;
  const now = Date.now();
  const reason = `Stopped by ${opts.by} (timon stop ${resolved.kind} ${resolved.name})`;
  const reasonCode = encodeDaemonMessage(
    daemonMessage('task_stopped_by_scope', { by: opts.by, kind: resolved.kind, name: resolved.name }),
    redactText,
  );

  const agentSet = new Set(resolved.agents);
  const plan = db.transaction(() => {
    const own = ownerClause(opts.owner);
    const runs = scopeRuns(agentSet, resolved.project, opts.owner);
    // A project's task can run on an agent attached elsewhere: its mission is
    // in the scope through the task, not through the agent. Same for a run.
    const scoped = db.prepare(
      `SELECT id, agent_name FROM missions
        WHERE status = 'running' AND ${own.sql}
          AND (${inAgents('agent_name')}
               OR (? IS NOT NULL AND id IN (SELECT mission_id FROM tasks WHERE project = ? AND mission_id IS NOT NULL)))`,
    ).all(...own.params, agentsJson, resolved.project, resolved.project) as { id: string; agent_name: string }[];
    const ofRuns = db.prepare(
      `SELECT id, agent_name FROM missions
        WHERE status = 'running' AND workflow_run_id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(runs.map((r) => r.id))) as { id: string; agent_name: string }[];
    const missions = [...new Map([...scoped, ...ofRuns].map((m) => [m.id, m])).values()];

    const tasks = db.prepare(
      `SELECT id, title, agent_name, status, scheduled_at FROM tasks
        WHERE status IN ('PENDING', 'IN_PROGRESS') AND mirror = 0 AND ${own.sql}
          AND (${inAgents('agent_name')} OR (? IS NOT NULL AND project = ?))`,
    ).all(...own.params, agentsJson, resolved.project, resolved.project) as
      { id: string; title: string; agent_name: string; status: TaskStatus; scheduled_at: number | null }[];
    const blockTask = db.prepare(
      `UPDATE tasks SET status = 'BLOCKED', blocked_reason = ?, blocked_reason_code = ?, return_notified = 1, updated_at = ?
        WHERE id = ? AND mirror = 0 AND status IN ('PENDING', 'IN_PROGRESS')`,
    );
    for (const task of tasks) {
      const prev = dbApi.getTask(task.id);
      blockTask.run(reason, reasonCode, now, task.id);
      dbApi.publishTaskChange(prev);
    }

    for (const m of missions) dbApi.markMissionReturnNotified(m.id);

    // Both directions: a request the scope is answering, and a request the
    // scope sent elsewhere — its answer would come back and wake the scope.
    const msgOwn = ownerClause(opts.owner, 'm.owner_user_id');
    const missionIds = JSON.stringify(missions.map((m) => m.id));
    const deliveries = db.prepare(
      `SELECT d.request_id, d.mission_id FROM agent_request_deliveries d
         JOIN agent_messages m ON m.id = d.request_id
        WHERE d.settled_at IS NULL AND ${msgOwn.sql}
          AND (d.mission_id IN (SELECT value FROM json_each(?))
               OR d.mission_id IN (SELECT id FROM missions WHERE ${inAgents('agent_name')})
               OR ${inAgents('m.from_agent')})`,
    ).all(...msgOwn.params, missionIds, agentsJson, agentsJson) as { request_id: string; mission_id: string }[];
    const settle = db.prepare(`UPDATE agent_request_deliveries SET settled_at = ? WHERE request_id = ? AND settled_at IS NULL`);
    for (const d of deliveries) settle.run(now, d.request_id);

    const messages = db.prepare(
      `SELECT id, from_agent, to_agent, kind FROM agent_messages
        WHERE status = 'pending' AND from_agent != ? AND ${own.sql}
          AND (${inAgents('to_agent')} OR ${inAgents('from_agent')} OR ${inAgents('to_mission')})`,
    ).all(HUMAN_ESCALATION_SENDER, ...own.params, agentsJson, agentsJson, missionIds) as StopReport['messages'];
    pickMessages(messages, now);

    // Before the trigger loop: the façades follow the switch, and a user's
    // trigger with a `workflow` action on one of these is told apart below.
    const switchOff = db.prepare(`UPDATE workflows SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1`);
    const workflows = scopeWorkflows(agentSet, resolved.project, opts.owner)
      .filter((w) => switchOff.run(now, w.id).changes === 1);
    for (const w of workflows) disarmWorkflowTriggers(w.id);
    const stoppedWorkflows = new Set(workflows.flatMap((w) => [w.id, w.workflow]));

    // A trigger belongs to the scope when it starts the scope's work, or when
    // the scope made it. `todo` actions only file an idea and stay on.
    const triggers: StopReport['triggers'] = [];
    for (const row of listTriggerRows({ ownerId: opts.owner })) {
      if (row.enabled !== 1) continue;
      const trigger = parseTrigger(row);
      if (!trigger) continue;
      const mine = (trigger.actingAgent !== null && agentSet.has(trigger.actingAgent))
        || (trigger.creatorAgent !== null && agentSet.has(trigger.creatorAgent))
        || trigger.actions.some((a) => a.type === 'task'
          && (agentSet.has(canonicalAgentName(a.agent)) || (resolved.project !== null && a.project === resolved.project)))
        || trigger.actions.some((a) => a.type === 'workflow' && stoppedWorkflows.has(a.workflow));
      if (mine && disableTriggerRow(row.id)) triggers.push({ id: row.id, name: row.name, source: row.source });
    }

    return { missions, tasks, deliveries, messages, triggers, runs, workflows };
  });
  const done = plan();

  const outcomes = new Map<string, StopReport['missions'][number]['outcome']>();
  const kill = (id: string) => {
    if (!outcomes.has(id)) outcomes.set(id, killAgent(id, { source: 'stop scope', actor: opts.by, detail: `${resolved.kind} ${resolved.name}` }));
  };
  for (const run of done.runs) cancelRun(run.id, kill);
  const reports = done.runs.length === 0 ? [] : db.prepare(
    `SELECT id, from_agent, to_agent, kind FROM agent_messages
      WHERE status = 'pending'
        AND EXISTS (SELECT 1 FROM json_each(?) r WHERE agent_messages.id LIKE 'workflow-report:' || r.value || ':%')`,
  ).all(JSON.stringify(done.runs.map((r) => r.id))) as StopReport['messages'];
  pickMessages(reports, Date.now());
  const missions = done.missions.map((m) => {
    kill(m.id);
    return { id: m.id, agent: m.agent_name, outcome: outcomes.get(m.id)! };
  });
  const messages = [...done.messages, ...reports];
  console.warn(
    `[stop] ${resolved.kind} ${resolved.name} by ${opts.by}: ${missions.length} mission(s), ` +
    `${messages.length} message(s), ${done.deliveries.length} request(s), ` +
    `${done.tasks.length} task(s), ${done.triggers.length} trigger(s), ${done.runs.length} workflow run(s), ` +
    `${done.workflows.length} workflow(s) switched off`,
  );
  return {
    scope: { kind: resolved.kind, name: resolved.name },
    agents: resolved.agents,
    missions,
    messages,
    deliveries: done.deliveries,
    tasks: done.tasks.map((t) => ({ id: t.id, title: t.title, agent: t.agent_name, status: t.status, scheduled_at: t.scheduled_at })),
    triggers: done.triggers,
    workflow_runs: done.runs,
    workflows: done.workflows,
  };
}
