import { daemonMessage } from '../daemon-message.js';
import { randomUUID } from 'node:crypto';
import { db, dbApi, type WorkflowRow, type WorkflowRunNodeRow } from '../db.js';
import { bus } from '../bus.js';
import { notifyUser, systemMissionId } from '../notify.js';
import { createNotification, resolveAnchor } from '../notifications.js';
import { evaluateExpr } from './expr.js';
import { MAX_LOOP_ITERATIONS, loopBody, parseStoredWorkflowDefinition, parseWorkflowDefinition, type WorkflowDefinition } from './schema.js';
import { pluginNodeReference, workflowNodeSpec } from './nodes/registry.js';
import { abortPluginExecutors, executePluginWorkflowNode, pluginExecutorActive } from './plugin-executors.js';
import { PluginIntegrationError } from '../plugins/integration-primitives.js';
import { contextValue, interpolateTemplate } from './template.js';
import { parseAgentOutput, spawnWorkflowAgent, workflowAgentName } from './nodes/agent.js';
import { appendMemory, deleteAgent, killAgent, upsertAgent } from '../agent.js';
import type { AgentConfig } from '../agent-config.js';
import { addMemoryRule } from '../memory-rule-add.js';
import { isSkillId } from '../skill-attachments.js';
import { getHost } from '../host/index.js';
import { TIMON_HOME } from '../paths.js';
import { secretsEnvFor, systemEnv } from '../secrets/env.js';
import { redactDeep } from '../secrets/redact.js';
import { scriptNodeApproval, scriptNodeDenied } from './nodes/script.js';
import { runHttpNode } from './nodes/http.js';
import { prepareWorkflowCoordinator, reportToWorkflowCoordinator } from './coordinator.js';

/** Per loop edge: how many times it was followed, whether its budget ran out,
 * and which attempt of its source was last weighed (so one outcome counts once). */
type LoopState = { count: number; exhausted?: boolean; source_attempt?: number };
type RunContext = { supervised?: boolean; coordinatorMissionId?: string; loops?: Record<string, LoopState>; iterationBase?: Record<string, number>; input: unknown; vars: Record<string, unknown>; trigger: unknown; nodes: Record<string, { status: string; output?: unknown; taken_port?: string | null; mission_id?: string | null }>; run: { id: string; started_at: number }; output?: unknown };
const parseJson = (value: string | null, fallback: unknown = {}) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const publish = (runId: string, nodeId: string | undefined, status: string) => {
  bus.publish({ kind: 'workflow_run', runId, nodeId, status });
  if (!nodeId && ['completed', 'failed', 'cancelled'].includes(status)) {
    const run = dbApi.getWorkflowRun(runId);
    reportToWorkflowCoordinator(runId, 'terminal', { status, context: run ? parseJson(run.context) : null, error: run?.error });
  }
};
const latestNodes = (rows: WorkflowRunNodeRow[]) => rows.filter((row) => !rows.some((other) => other.node_id === row.node_id && other.attempt > row.attempt));

// The run page is the anchor: a card with neither mission nor task opens it on click.
function runPageAnchor(runId: string): string | null {
  const run = dbApi.getWorkflowRun(runId);
  const workflow = run ? dbApi.getWorkflow(run.workflow_id) : undefined;
  return workflow ? `/workflows/${encodeURIComponent(workflow.slug)}/runs/${encodeURIComponent(runId)}` : null;
}
// One anchor per question, so answering one human node closes only its own card.
const humanAnchor = (runId: string, nodeId: string) => { const page = runPageAnchor(runId); return page ? `${page}?node=${encodeURIComponent(nodeId)}` : null; };
const closeHumanCard = (runId: string, nodeId: string) => { const anchor = humanAnchor(runId, nodeId); if (anchor) resolveAnchor(anchor); };

/**
 * A script node refused because its files are not the ones a person
 * approved: only a person can approve them, so they are told even when the
 * graph handles the failure — but once, not at every run that hits the same refusal.
 */
function alertUnapprovedScript(workflow: WorkflowRow, runId: string, nodeId: string, problem: string): void {
  const reason = String(redactDeep(problem));
  const last = db.prepare(
    `SELECT n.error FROM workflow_run_nodes n JOIN workflow_runs r ON r.id = n.run_id
      WHERE r.workflow_id = ? AND n.node_id = ? AND n.run_id <> ? AND n.ended_at IS NOT NULL
      ORDER BY n.ended_at DESC LIMIT 1`,
  ).get(workflow.id, nodeId, runId) as { error: string | null } | undefined;
  if (last?.error === reason) return;
  try {
    const run = dbApi.getWorkflowRun(runId);
    createNotification({
      type: 'alert', title: `Script not run: ${workflow.name}`, body: `${nodeId}: ${reason}`,
      message: daemonMessage('workflow_script_not_run', { name: workflow.name }),
      ownerUserId: run?.owner_user_id ?? workflow.owner_user_id, source: `workflow:${workflow.slug}`, anchor: runPageAnchor(runId),
    });
  } catch (err) {
    console.warn(`[workflows] script alert for ${workflow.slug}/${nodeId} not sent: ${(err as Error).message}`);
  }
}

function inlineAgentNodes(definition: WorkflowDefinition) {
  return definition.nodes.filter((node) => (node.type === 'agent' || node.type === 'skill') && node.config.identity && !node.config.ref);
}

/**
 * The schema takes any string as a skill id and `upsertAgent` refuses a bad
 * one: a workflow published before that refusal would no longer publish nor
 * run. Such an id never resolved to a skill anyway, so it is dropped, loudly.
 */
function inlineSkillIds(slug: string, nodeId: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (isSkillId(id)) ids.push(id);
    else console.warn(`[workflows] ${slug}/${nodeId}: ignored skill ${JSON.stringify(item)}: not a skill id`);
  }
  return ids;
}

export function provisionInlineWorkflowAgents(slug: string, definition: WorkflowDefinition): void {
  for (const node of inlineAgentNodes(definition)) {
    const identity = node.config.identity as Record<string, unknown>;
    upsertAgent({
      name: workflowAgentName(slug, node.id),
      system_prompt: typeof identity.instructions === 'string' && identity.instructions.trim() ? identity.instructions : 'You are an autonomous workflow agent. Follow the workflow brief precisely.',
      config: {
        backend: typeof identity.backend === 'string' ? identity.backend as AgentConfig['backend'] : undefined,
        model: typeof identity.model === 'string' ? identity.model : undefined,
        reasoningEffort: typeof identity.reasoningEffort === 'string' ? identity.reasoningEffort : null,
        skills: inlineSkillIds(slug, node.id, identity.skills),
        mcp_servers: Array.isArray(identity.mcpServers) ? identity.mcpServers.filter((item): item is string => typeof item === 'string') : [],
        allowed_tools: Array.isArray(identity.allowedTools) ? identity.allowedTools.filter((item): item is string => typeof item === 'string') : [],
        permission_mode: typeof identity.permissionMode === 'string' ? identity.permissionMode : undefined,
        browser_profile_id: identity.browserProfileId === null ? null : typeof identity.browserProfileId === 'string' ? identity.browserProfileId : undefined,
        cwd: typeof identity.cwd === 'string' ? identity.cwd : undefined,
        project: typeof identity.project === 'string' ? identity.project : undefined,
      },
    });
  }
}

export function removeInlineWorkflowAgents(slug: string, definitions: WorkflowDefinition[]): void {
  const names = new Set(definitions.flatMap((definition) => inlineAgentNodes(definition).map((node) => workflowAgentName(slug, node.id))));
  for (const name of names) deleteAgent(name, { purge: true });
}

function versionForRun(workflowId: string, draft: boolean | undefined, ownerUserId: string | null | undefined, supervised: boolean | undefined) {
  const workflow = dbApi.getWorkflow(workflowId);
  if (!workflow) throw new Error('workflow not found');
  // Checked before a draft version is frozen: a run without a pilot must not
  // leave a version row behind.
  if (supervised && !workflow.agent_name) throw new Error('workflow has no assigned agent');
  if (!draft) {
    if (!workflow.published_version) throw new Error('workflow has no published version');
    const version = dbApi.getWorkflowVersion(workflow.id, workflow.published_version);
    if (!version) throw new Error('published version missing');
    return { workflow, version };
  }
  const definition = parseWorkflowDefinition(parseJson(workflow.draft));
  // Frozen under its own number and left unpublished: only a person's publish
  // moves `published_version`, so the next published run still reads that one.
  const version = { workflow_id: workflow.id, version: dbApi.nextWorkflowVersion(workflow.id), definition: JSON.stringify({ ...definition, draft: true }), published_at: Date.now(), published_by: ownerUserId ?? null };
  dbApi.insertWorkflowDraftVersion(version);
  return { workflow, version };
}

export function createRun(workflowId: string, opts: { trigger: unknown; input?: unknown; draft?: boolean; ownerUserId?: string | null; queued?: boolean; supervised?: boolean }) {
  const { workflow, version } = versionForRun(workflowId, opts.draft, opts.ownerUserId, opts.supervised);
  const definition = parseWorkflowDefinition(parseJson(version.definition));
  if (opts.supervised) provisionInlineWorkflowAgents(workflow.slug, definition);
  const id = randomUUID(); const startedAt = Date.now();
  const context: RunContext = { supervised: opts.supervised, input: opts.input ?? {}, vars: Object.fromEntries(definition.variables.map((variable) => [variable.name, variable.default])), trigger: opts.trigger, nodes: {}, run: { id, started_at: startedAt } };
  dbApi.insertWorkflowRun({ id, workflow_id: workflow.id, version: version.version, status: opts.queued ? 'pending' : 'running', trigger: JSON.stringify(opts.trigger), input: JSON.stringify(opts.input ?? {}), context: JSON.stringify(context), error: null, started_at: startedAt, ended_at: null, owner_user_id: opts.ownerUserId ?? workflow.owner_user_id, tokens_in: null, tokens_out: null, cost_usd: null });
  for (const node of definition.nodes) dbApi.insertWorkflowRunNode({ run_id: id, node_id: node.id, attempt: 1, status: 'pending', mission_id: null, input: null, output: null, error: null, taken_port: null, started_at: null, ended_at: null, tokens_in: null, tokens_out: null });
  dbApi.upsertSpans([{ op: 'open', id: `workflow:${id}`, trace_id: id, mission_id: systemMissionId(), workflow_run_id: id, seq: startedAt, kind: 'workflow', name: workflow.slug, started_at: startedAt }]);
  publish(id, undefined, opts.queued ? 'pending' : 'running');
  if (!opts.queued) void advance(id);
  return dbApi.getWorkflowRun(id)!;
}

/** Product entry point: all manual and automatic runs have their own pilot. */
export function startWorkflowRun(workflowId: string, opts: Parameters<typeof createRun>[1]) {
  return createRun(workflowId, { ...opts, supervised: true });
}

function load(runId: string) {
  const run = dbApi.getWorkflowRun(runId); if (!run) throw new Error('run not found');
  const version = dbApi.getWorkflowVersion(run.workflow_id, run.version); if (!version) throw new Error('workflow version not found');
  return { run, definition: parseStoredWorkflowDefinition(parseJson(version.definition)), context: parseJson(run.context) as RunContext };
}

/**
 * Whether an entry node starts this run. An automatic start (schedule,
 * webhook, event, a native trigger) names its node; a person's run (the Run
 * button, a draft test, the API) names none and starts the manual triggers.
 * Any other entry node stays put, so a pause after a schedule is not
 * bypassed by a manual trigger beside it.
 */
function startsRun(nodeId: string, definition: WorkflowDefinition, context: RunContext): boolean {
  const named = (context.trigger as { node_id?: unknown } | null | undefined)?.node_id;
  if (typeof named === 'string') return named === nodeId;
  return definition.nodes.find((item) => item.id === nodeId)?.type === 'trigger.manual';
}

/**
 * The non-loop edges into a node, without those leaving a trigger that did
 * not start the run: "schedule → X ← manual" must run X from either trigger,
 * not wait for the one that will never fire.
 */
function liveIncoming(nodeId: string, definition: WorkflowDefinition, context: RunContext) {
  return definition.edges.filter((edge) => {
    if (edge.to !== nodeId || edge.loop) return false;
    const source = definition.nodes.find((node) => node.id === edge.from);
    if (!source?.type.startsWith('trigger.')) return true;
    const entry = !definition.edges.some((other) => other.to === source.id && !other.loop);
    return !entry || startsRun(source.id, definition, context);
  });
}

function incomingSatisfied(nodeId: string, definition: WorkflowDefinition, rows: WorkflowRunNodeRow[], context: RunContext) {
  if (!definition.edges.some((edge) => edge.to === nodeId && !edge.loop)) return startsRun(nodeId, definition, context);
  const incoming = liveIncoming(nodeId, definition, context);
  if (!incoming.length) return false;
  const target = definition.nodes.find((node) => node.id === nodeId)!;
  const satisfied = incoming.filter((edge) => {
    const source = rows.find((row) => row.node_id === edge.from);
    return source?.status === 'ok' && source.taken_port === edge.fromPort && (!edge.condition || evaluateExpr(edge.condition, context));
  });
  if (target.type !== 'join') return satisfied.length === incoming.length;
  const config = target.config as { mode?: string; n?: number };
  if (config.mode === 'any') return satisfied.length > 0;
  if (config.mode === 'n') return satisfied.length >= (config.n ?? 1);
  return satisfied.length === incoming.length;
}

const SETTLED = ['ok', 'error', 'timeout', 'skipped', 'cancelled'];

/**
 * Pending nodes no edge can reach any more: the branch a condition, a switch,
 * a human answer or a `done`/`failed` port did not take, the successors of a
 * failure under `onError: continue`, an entry node another trigger did not
 * start. Without this they stay `pending` and the run never completes.
 * Skipping one can starve its successors, hence the fixpoint.
 */
function skipUnreachable(runId: string, definition: WorkflowDefinition, context: RunContext): number {
  let skipped = 0;
  for (;;) {
    const rows = latestNodes(dbApi.listWorkflowRunNodes(runId));
    const dead = rows.filter((row) => row.status === 'pending' && !incomingSatisfied(row.node_id, definition, rows, context) && !reachable(row.node_id, definition, rows, context));
    if (!dead.length) return skipped;
    const now = Date.now();
    for (const row of dead) { dbApi.updateWorkflowRunNode(runId, row.node_id, { status: 'skipped', ended_at: now }); publish(runId, row.node_id, 'skipped'); }
    skipped += dead.length;
  }
}

/** Whether a pending node can still be satisfied once its open sources settle. */
function reachable(nodeId: string, definition: WorkflowDefinition, rows: WorkflowRunNodeRow[], context: RunContext): boolean {
  // An entry node only runs when its own trigger started the run, decided at creation.
  if (!definition.edges.some((edge) => edge.to === nodeId && !edge.loop)) return false;
  const incoming = liveIncoming(nodeId, definition, context);
  if (!incoming.length) return false;
  const open = incoming.filter((edge) => {
    const source = rows.find((row) => row.node_id === edge.from);
    if (!source || !SETTLED.includes(source.status)) return true;
    return source.status === 'ok' && source.taken_port === edge.fromPort && (!edge.condition || evaluateExpr(edge.condition, context));
  }).length;
  const target = definition.nodes.find((node) => node.id === nodeId)!;
  if (target.type !== 'join') return open === incoming.length;
  const config = target.config as { mode?: string; n?: number };
  if (config.mode === 'any') return open > 0;
  if (config.mode === 'n') return open >= (config.n ?? 1);
  return open === incoming.length;
}

/**
 * Follow the loop edges whose source just took their port: every node from
 * the edge's target onwards (the body, which holds the source since a loop
 * edge must close a cycle) gets a fresh `pending` attempt, so the target runs
 * again with the rest of the graph as it stands. An edge is followed once the
 * current pass of its body has nothing left to run, at most `maxIterations`
 * times; past that it is `exhausted` and the run carries on without it.
 * Returns whether anything changed, so the caller schedules the next pass.
 */
function followLoops(runId: string, definition: WorkflowDefinition, context: RunContext): boolean {
  const edges = definition.edges.filter((edge) => edge.loop);
  if (!edges.length) return false;
  return db.transaction(() => {
    const saved = parseJson(dbApi.getWorkflowRun(runId)?.context ?? null) as RunContext;
    const loops = { ...(saved.loops ?? {}) }; const base = { ...(saved.iterationBase ?? {}) };
    let changed = false;
    for (const edge of edges) {
      const rows = latestNodes(dbApi.listWorkflowRunNodes(runId));
      const source = rows.find((row) => row.node_id === edge.from);
      const state: LoopState = { ...(loops[edge.id] ?? { count: 0 }) };
      if (source?.status !== 'ok' || source.taken_port !== edge.fromPort || state.source_attempt === source.attempt) continue;
      const body = loopBody(definition, edge.to);
      const bodyRows = rows.filter((row) => body.has(row.node_id));
      // Running, waiting, a retry queued, or a node the source's port just made
      // ready: this pass is not over, and resetting it would orphan its work.
      const busy = bodyRows.some((row) => ['running', 'waiting'].includes(row.status)
        || (row.status === 'pending' && (row.attempt > (base[row.node_id] ?? 1) || incomingSatisfied(row.node_id, definition, rows, { ...context, loops }))));
      if (busy) continue;
      state.source_attempt = source.attempt;
      if (edge.condition && !evaluateExpr(edge.condition, { ...context, loops })) { loops[edge.id] = state; changed = true; continue; }
      if (state.count >= Math.min(edge.maxIterations ?? 1, MAX_LOOP_ITERATIONS)) {
        state.exhausted = true; loops[edge.id] = state; changed = true; continue;
      }
      for (const row of bodyRows) {
        // A node the last pass never reached is already fresh.
        if (row.status === 'pending') { base[row.node_id] = row.attempt; continue; }
        dbApi.insertWorkflowRunNode({ ...row, attempt: row.attempt + 1, status: 'pending', mission_id: null, input: null, output: null, error: null, taken_port: null, started_at: null, ended_at: null, tokens_in: null, tokens_out: null });
        base[row.node_id] = row.attempt + 1;
      }
      // A loop nested in this body starts each outer pass with its full budget.
      for (const inner of edges) if (inner.id !== edge.id && body.has(inner.from) && body.has(inner.to)) delete loops[inner.id];
      loops[edge.id] = { count: state.count + 1, source_attempt: source.attempt };
      changed = true;
    }
    if (changed) {
      dbApi.updateWorkflowRun(runId, { context: JSON.stringify({ ...saved, loops, iterationBase: base }) });
      context.loops = loops; context.iterationBase = base;
    }
    return changed;
  })();
}

function snapshotContext(runId: string, context: RunContext) {
  // Another advancement may have completed the output node while this one
  // awaited an executor. Do not erase that durable output with an older context.
  const saved = parseJson(dbApi.getWorkflowRun(runId)?.context ?? null) as RunContext;
  if (context.output === undefined && saved.output !== undefined) context.output = saved.output;
  // Loop state is written by `followLoops` alone, straight to the run row: an
  // advancement that started before a loop was followed must not roll it back.
  context.loops = saved.loops ?? {}; context.iterationBase = saved.iterationBase ?? {};
  // Rows come in attempt order. A node a loop sent back to `pending` keeps the
  // output of its previous iteration until it completes again: the next pass
  // of the body reads the feedback that made the loop go round.
  for (const row of dbApi.listWorkflowRunNodes(runId)) {
    const output = parseJson(row.output, null) ?? (row.attempt > 1 ? context.nodes[row.node_id]?.output ?? null : null);
    context.nodes[row.node_id] = { status: row.status, output, taken_port: row.taken_port, mission_id: row.mission_id };
  }
  dbApi.updateWorkflowRun(runId, { context: JSON.stringify(context) });
}

function openNodeSpan(runId: string, nodeId: string, label: string, startedAt: number) {
  dbApi.upsertSpans([{ op: 'open', id: `workflow:${runId}:node:${nodeId}`, trace_id: runId, mission_id: systemMissionId(), workflow_run_id: runId, workflow_node_id: nodeId, seq: startedAt, kind: 'node', name: label, started_at: startedAt }]);
}
function closeNodeSpan(runId: string, nodeId: string, status: 'ok' | 'error', error?: string | null, output?: unknown) {
  dbApi.upsertSpans([{ op: 'close', id: `workflow:${runId}:node:${nodeId}`, status, ended_at: Date.now(), error: error ?? null, output: output === undefined ? null : JSON.stringify(redactDeep(output)) }]);
}

export async function advance(runId: string): Promise<void> {
  const initial = dbApi.getWorkflowRun(runId); if (!initial || !['running', 'waiting'].includes(initial.status)) return;
  let { definition, context } = load(runId);
  if (context.supervised && !context.coordinatorMissionId) {
    try {
      await prepareWorkflowCoordinator(runId);
      if (!['running', 'waiting'].includes(dbApi.getWorkflowRun(runId)?.status ?? '')) return;
      ({ definition, context } = load(runId));
      publish(runId, undefined, 'running');
    } catch (error) {
      const message = String(redactDeep((error as Error).message));
      const now = Date.now();
      dbApi.updateWorkflowRun(runId, { status: 'failed', error: message, ended_at: now });
      for (const node of dbApi.listWorkflowRunNodes(runId)) dbApi.updateWorkflowRunNode(runId, node.node_id, { status: 'skipped', ended_at: now });
      dbApi.upsertSpans([{ op: 'close', id: `workflow:${runId}`, status: 'error', ended_at: now, error: message }]);
      publish(runId, undefined, 'failed');
      return;
    }
  }
  // A completed agent writes its output before scheduling its successor.
  snapshotContext(runId, context);
  // A wait stores its deadline in the durable output payload. No in-memory timer
  // is required, so a daemon restart cannot strand the run.
  for (const row of dbApi.listWorkflowRunNodes(runId).filter((row) => row.status === 'waiting')) {
    const deadline = (parseJson(row.output, {}) as { next_run_at?: unknown }).next_run_at;
    if (typeof deadline === 'number' && deadline <= Date.now()) {
      const node = definition.nodes.find((item) => item.id === row.node_id);
      const port = node?.type === 'human' ? 'timeout' : 'out';
      dbApi.updateWorkflowRunNode(runId, row.node_id, { status: 'ok', taken_port: port, ended_at: Date.now() });
      if (node?.type === 'human') closeHumanCard(runId, row.node_id);
      closeNodeSpan(runId, row.node_id, 'ok'); publish(runId, row.node_id, 'ok');
    }
  }
  // Before claiming: a source that settled since the last pass sends its body
  // back to `pending` first, so nothing of the old pass is started twice.
  const looped = followLoops(runId, definition, context);
  if (looped) snapshotContext(runId, context);
  const rows = latestNodes(dbApi.listWorkflowRunNodes(runId));
  const limit = definition.settings.maxParallel ?? 3;
  const slots = Math.max(0, limit - rows.filter((row) => row.status === 'running').length);
  const candidates = rows.filter((row) => row.status === 'pending' && incomingSatisfied(row.node_id, definition, rows, context)).slice(0, slots);
  // Claiming is synchronous and happens before any effect. A concurrent advance
  // sees `running`, never a second opportunity to notify/spawn.
  db.transaction(() => {
    for (const row of candidates) {
      const node = definition.nodes.find((item) => item.id === row.node_id)!;
      const now = Date.now();
      dbApi.updateWorkflowRunNode(runId, row.node_id, { status: 'running', started_at: now });
      openNodeSpan(runId, row.node_id, node.label ?? node.id, now);
    }
  })();
  await Promise.all(candidates.map(async (row) => {
    if (!['running', 'waiting'].includes(dbApi.getWorkflowRun(runId)?.status ?? '')) return;
    publish(runId, row.node_id, 'running'); await runNode(runId, row.node_id, definition, context);
  }));
  if (!['running', 'waiting'].includes(dbApi.getWorkflowRun(runId)?.status ?? '')) return;
  snapshotContext(runId, context);
  const after = latestNodes(dbApi.listWorkflowRunNodes(runId));
  const terminalError = after.some((row) => ['error', 'timeout'].includes(row.status));
  if (terminalError && definition.settings.onError !== 'continue') {
    abortPluginExecutors(runId);
    for (const row of after.filter((item) => ['pending', 'running', 'waiting'].includes(item.status))) {
      dbApi.updateWorkflowRunNode(runId, row.node_id, { status: 'skipped', ended_at: Date.now() });
      if (row.status === 'waiting') closeHumanCard(runId, row.node_id);
    }
    dbApi.updateWorkflowRun(runId, { status: 'failed', ended_at: Date.now() });
    dbApi.upsertSpans([{ op: 'close', id: `workflow:${runId}`, status: 'error', ended_at: Date.now() }]);
    publish(runId, undefined, 'failed'); return;
  }
  // An in-process source (a condition) settled during this pass: follow its
  // loop before the untaken branches are pruned and the run is judged over.
  const relooped = followLoops(runId, definition, context);
  if (relooped) snapshotContext(runId, context);
  const pruned = skipUnreachable(runId, definition, context);
  const settled = pruned || relooped ? latestNodes(dbApi.listWorkflowRunNodes(runId)) : after;
  const active = settled.some((row) => ['pending', 'running', 'waiting'].includes(row.status));
  if (!active) {
    const failed = settled.some((row) => ['error', 'timeout'].includes(row.status));
    const status = failed && definition.settings.onError !== 'continue' ? 'failed' : 'completed';
    dbApi.updateWorkflowRun(runId, { status, ended_at: Date.now() });
    dbApi.upsertSpans([{ op: 'close', id: `workflow:${runId}`, status: status === 'completed' ? 'ok' : 'error', ended_at: Date.now() }]);
    publish(runId, undefined, status);
  } else if (candidates.length || looped || relooped) void advance(runId);
}

async function runNode(runId: string, nodeId: string, definition: WorkflowDefinition, context: RunContext) {
  const node = definition.nodes.find((item) => item.id === nodeId)!;
  const plugin = pluginNodeReference(node.type);
  if (plugin?.kind === 'executor') {
    const attempt = latestNodes(dbApi.listWorkflowRunNodes(runId)).find((row) => row.node_id === nodeId)?.attempt;
    const stillRunning = () => {
      const row = latestNodes(dbApi.listWorkflowRunNodes(runId)).find((item) => item.node_id === nodeId);
      return row?.attempt === attempt && row?.status === 'running';
    };
    try {
      const result = await executePluginWorkflowNode(runId, node, context.input, definition.settings.timeoutMs, context.iterationBase?.[nodeId] ?? 1);
      if (stillRunning()) finishAgentNode(runId, nodeId, 'ok', null, redactDeep(result.output), result.port);
    } catch (error) {
      const status = error instanceof PluginIntegrationError && error.code === 'timeout' ? 'timeout' : 'error';
      if (stillRunning()) finishAgentNode(runId, nodeId, status, String(redactDeep(error instanceof Error ? error.message : String(error))));
    }
    return;
  }
  let status = 'ok'; let port = 'out'; let output: unknown = {}; let error: string | null = null;
  try {
    switch (node.type) {
      case 'trigger.manual': case 'trigger.schedule': case 'trigger.webhook': case 'trigger.event': case 'trigger.business':
      case 'parallel': case 'join': break;
      case 'condition': port = evaluateExpr(String(node.config.expr), context) ? 'true' : 'false'; break;
      case 'switch': { const value = contextValue(context, String(node.config.on)); const match = (node.config.cases as Array<{ port: string; value: unknown }> ?? []).find((item) => JSON.stringify(item.value) === JSON.stringify(value)); port = match?.port ?? 'default'; break; }
      case 'wait': status = 'waiting'; output = { next_run_at: Date.now() + Number(node.config.ms) }; break;
      case 'notify': {
        const run = dbApi.getWorkflowRun(runId)!; const workflow = dbApi.getWorkflow(run.workflow_id)!;
        const row = createNotification({
          type: node.config.type === 'alert' ? 'alert' : 'report',
          title: interpolateTemplate(String(node.config.title), context), body: interpolateTemplate(String(node.config.body ?? ''), context),
          ownerUserId: run.owner_user_id, source: `workflow:${workflow.slug}`, anchor: runPageAnchor(runId),
        });
        // A node that wrote nothing must not report ok: the run would lie about the notification.
        if (!row) throw new Error('notifications are disabled');
        output = { notification_id: row.id };
        break;
      }
      case 'output': output = interpolateTemplate(String(node.config.template), context); context.output = output; break;
      case 'human': {
        status = 'waiting';
        const deadline = typeof node.config.timeoutMs === 'number' ? Date.now() + node.config.timeoutMs : undefined;
        const run = dbApi.getWorkflowRun(runId)!; const workflow = dbApi.getWorkflow(run.workflow_id)!;
        // The card is what the owner sees; the question stays answerable from the run
        // page and /messages, so a disabled notification centre does not fail the node.
        const card = createNotification({
          type: 'action_required', title: String(node.config.question), body: workflow.name,
          ownerUserId: run.owner_user_id, source: `workflow:${workflow.slug}`, anchor: humanAnchor(runId, nodeId),
        });
        output = { question: node.config.question, options: node.config.options ?? [], next_run_at: deadline, notification_id: card?.id ?? null };
        notifyUser(String(node.config.question), JSON.stringify({ run_id: runId, node_id: nodeId, options: node.config.options ?? [] }), { type: 'action_required' });
        break;
      }
      case 'memory.read': {
        const cfg = node.config as { query?: string; scope?: string; agent?: string; project?: string; role?: string };
        output = dbApi.searchRules(String(cfg.query ?? ''), { agent: cfg.agent, project: cfg.project, role: cfg.role, includeGlobal: cfg.scope === 'global' || cfg.scope === undefined });
        break;
      }
      case 'memory.write': {
        const cfg = node.config as { text: string; kind?: string; scope?: string; agent?: string; project?: string; role?: string };
        const text = interpolateTemplate(cfg.text, context);
        if ((cfg.scope ?? 'agent') === 'agent' && cfg.agent) appendMemory(cfg.agent, 'learnings.jsonl', `${JSON.stringify({ kind: cfg.kind ?? 'pitfall', text, ts: new Date().toISOString() })}\n`);
        else addMemoryRule({ text, kind: cfg.kind, scope: cfg.scope, agent: cfg.agent, project: cfg.project, role: cfg.role, source: 'workflow' });
        output = { ok: true };
        break;
      }
      case 'script': {
        const cfg = node.config as { bin: string; args?: string[]; cwd?: string; timeoutMs?: number; env?: string[] };
        const run = dbApi.getWorkflowRun(runId)!; const workflow = dbApi.getWorkflow(run.workflow_id)!;
        // Re-read at every run, before anything touches the disk: a grant
        // revoked since publish stops here, and so does a run started for
        // someone else than the owner who armed the script.
        const denied = scriptNodeDenied(workflow.owner_user_id) ?? (run.owner_user_id === workflow.owner_user_id ? null : scriptNodeDenied(run.owner_user_id));
        if (denied) throw new Error(denied);
        const secrets = secretsEnvFor({ agent: `wf.${workflow.slug}.${nodeId}`, project: workflow.project });
        const env = Object.fromEntries((cfg.env ?? []).filter((name) => Object.hasOwn(secrets, name)).map((name) => [name, secrets[name]!])) as NodeJS.ProcessEnv;
        // Checked right before the spawn, nothing awaited in between: what
        // runs is what was read, and only what a person approved.
        const { cwd, problem } = scriptNodeApproval(workflow, cfg);
        if (problem) { alertUnapprovedScript(workflow, runId, nodeId, problem); throw new Error(problem); }
        // The system whitelist, never the daemon's own environment: the secrets
        // `loadSecretsAtBoot` puts there would reach any program a workflow names
        // (same rule as a trigger's script, `triggers/script-run.ts`).
        const result = await getHost().execAsync(cfg.bin, cfg.args ?? [], { cwd, env: { ...systemEnv(), TIMON_HOME, ...env }, timeout: cfg.timeoutMs ?? 30_000, maxBuffer: 1_048_576 });
        if (result.code !== 0) throw new Error(String(redactDeep(`script failed (code ${result.code}): ${result.stderr}`)));
        try { output = JSON.parse(result.stdout); } catch { output = { text: result.stdout }; }
        output = redactDeep(output);
        break;
      }
      case 'http': {
        const run = dbApi.getWorkflowRun(runId)!; const workflow = dbApi.getWorkflow(run.workflow_id)!;
        // The node's own vault scope, the one a script node of the same id reads.
        output = await runHttpNode({
          config: node.config, context, ownerUserId: run.owner_user_id,
          secrets: () => secretsEnvFor({ agent: `wf.${workflow.slug}.${nodeId}`, project: workflow.project }),
        });
        break;
      }
      case 'agent': case 'skill': {
        const run = dbApi.getWorkflowRun(runId)!;
        const workflow = dbApi.getWorkflow(run.workflow_id)!;
        // Every agent node is a sub-agent of the pilot (decision of 20/10/2026):
        // a precise task in its own mission, whose result reports to the pilot.
        const missionId = await spawnWorkflowAgent({ parentMissionId: context.coordinatorMissionId, ownerUserId: run.owner_user_id, runId, nodeId, slug: workflow.slug, node, context: context as unknown as Record<string, unknown>, skillId: node.type === 'skill' ? String(node.config.skillId) : undefined, extraSkillIds: node.config.completion === 'explicit' ? ['timon-workflow'] : [] });
        if (!['running', 'waiting'].includes(dbApi.getWorkflowRun(runId)?.status ?? '')) {
          killAgent(missionId, { source: 'workflow: run no longer active', detail: `run ${runId}, node ${nodeId}` });
          return;
        }
        dbApi.updateWorkflowRunNode(runId, nodeId, { input: JSON.stringify(interpolateTemplate(String(node.config.input ?? ''), context)), output: null, error: null });
        db.prepare(`UPDATE workflow_run_nodes SET mission_id=? WHERE run_id=? AND node_id=? AND attempt=(SELECT MAX(attempt) FROM workflow_run_nodes WHERE run_id=? AND node_id=?)`).run(missionId, runId, nodeId, runId, nodeId);
        return;
      }
      default:
        if (plugin?.kind === 'trigger') break;
        throw new Error(`not implemented: ${node.type}`);
    }
  } catch (caught) { status = 'error'; port = 'failed'; error = String(redactDeep((caught as Error).message)); }
  // An in-process node with `done` / `failed` ports (script, http) follows the
  // agent rule (`finishAgentNode`): success leaves by `done`, and a failure the
  // graph wired a `failed` edge for is handled, not fatal to the run.
  const declared = workflowNodeSpec(node.type)?.ports.out ?? [];
  if (status === 'ok' && port === 'out' && !declared.includes('out') && declared.includes('done')) port = 'done';
  const failure = status === 'error';
  if (failure && declared.includes('failed') && definition.edges.some((edge) => edge.from === nodeId && edge.fromPort === 'failed')) status = 'ok';
  if (status === 'waiting') {
    dbApi.updateWorkflowRunNode(runId, nodeId, { status, output: JSON.stringify(output) });
    publish(runId, nodeId, status); return;
  }
  dbApi.updateWorkflowRunNode(runId, nodeId, { status, output: JSON.stringify(output), error, taken_port: port, ended_at: Date.now() });
  if (node.type === 'output' && status === 'ok') snapshotContext(runId, context);
  closeNodeSpan(runId, nodeId, failure ? 'error' : 'ok', error, output); publish(runId, nodeId, status);
}

/** `kill` lets a caller that stops the missions itself (`scope-stop.ts`) record
 * each outcome instead of signalling a process twice. */
export function cancelRun(runId: string, kill: (missionId: string) => unknown = (id) => killAgent(id, { source: 'workflow: run cancelled', detail: `run ${runId}` })) {
  const run = dbApi.getWorkflowRun(runId); if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return false;
  for (const node of dbApi.listWorkflowRunNodes(runId).filter((row) => ['pending', 'running', 'waiting'].includes(row.status))) {
    dbApi.updateWorkflowRunNode(runId, node.node_id, { status: 'cancelled', ended_at: Date.now() });
    if (node.mission_id) kill(node.mission_id);
    if (node.status === 'running' || node.status === 'waiting') closeNodeSpan(runId, node.node_id, 'error', 'cancelled');
    if (node.status === 'waiting') closeHumanCard(runId, node.node_id);
  }
  dbApi.updateWorkflowRun(runId, { status: 'cancelled', ended_at: Date.now() }); abortPluginExecutors(runId); dbApi.upsertSpans([{ op: 'close', id: `workflow:${runId}`, status: 'interrupted', ended_at: Date.now(), error: 'cancelled' }]); publish(runId, undefined, 'cancelled'); return true;
}

function missionNodeId(missionId: string, runId: string): string | undefined {
  return latestNodes(dbApi.listWorkflowRunNodes(runId)).find((row) => row.mission_id === missionId && ['running', 'waiting'].includes(row.status))?.node_id;
}

export async function reconcile() {
  for (const row of db.prepare("SELECT id FROM workflow_runs WHERE status IN ('running','waiting')").all() as Array<{ id: string }>) {
    const { definition } = load(row.id);
    for (const node of dbApi.listWorkflowRunNodes(row.id).filter((item) => item.status === 'running')) {
      // Live plugin calls own their deadline. Only a missing in-process call is
      // stranded after restart; treating every mission-less node as lost would
      // race a legitimate asynchronous executor on every reconciliation tick.
      if (pluginExecutorActive(row.id, node.node_id)) continue;
      const spec = definition.nodes.find((item) => item.id === node.node_id);
      const timeout = Number(spec?.config.timeoutMs ?? definition.settings.timeoutMs ?? 0);
      if (timeout > 0 && node.started_at && node.started_at + timeout <= Date.now()) {
        finishAgentNode(row.id, node.node_id, 'timeout', 'node timeout');
      } else if (node.mission_id && dbApi.getMission(node.mission_id)?.status === 'running') continue;
      else {
        finishAgentNode(row.id, node.node_id, 'error', 'reconciled after restart');
      }
    }
    await advance(row.id);
  }
}

function finishAgentNode(runId: string, nodeId: string, status: 'ok' | 'error' | 'timeout', error: string | null, output: unknown = {}, port = 'failed') {
  const run = dbApi.getWorkflowRun(runId); if (!run || !['running', 'waiting'].includes(run.status)) return;
  const { definition, context } = load(runId); const row = latestNodes(dbApi.listWorkflowRunNodes(runId)).find((item) => item.node_id === nodeId);
  if (!row || !['running', 'waiting'].includes(row.status)) return;
  const config = definition.nodes.find((item) => item.id === nodeId)?.config as { retries?: unknown } | undefined;
  const retries = Number(config?.retries ?? 0);
  // Attempts count from the current loop pass: an earlier pass does not eat this one's retries.
  const passAttempt = row.attempt - (context.iterationBase?.[nodeId] ?? 1) + 1;
  if (status !== 'ok' && passAttempt <= retries) {
    dbApi.updateWorkflowRunNode(runId, nodeId, { status: 'error', error, ended_at: Date.now() });
    dbApi.insertWorkflowRunNode({ ...row, attempt: row.attempt + 1, status: 'pending', mission_id: null, input: null, output: null, error: null, taken_port: null, started_at: null, ended_at: null, tokens_in: null, tokens_out: null });
  } else {
    const hasFailedPort = definition.edges.some((edge) => edge.from === nodeId && edge.fromPort === 'failed');
    const actualStatus = status === 'ok' || hasFailedPort ? 'ok' : status;
    dbApi.updateWorkflowRunNode(runId, nodeId, { status: actualStatus, output: JSON.stringify(output), error, taken_port: status === 'ok' ? port : hasFailedPort ? 'failed' : port, ended_at: Date.now() });
    closeNodeSpan(runId, nodeId, status === 'ok' ? 'ok' : 'error', error);
    publish(runId, nodeId, actualStatus);
    reportToWorkflowCoordinator(runId, `node:${nodeId}:${row.attempt}`, { node_id: nodeId, status, output, error, route: port }, row.mission_id ?? undefined);
  }
  void advance(runId);
}

export function completeWorkflowTurn(missionId: string, payload: unknown): void {
  const mission = dbApi.getMission(missionId); if (!mission?.workflow_run_id) return;
  const nodeId = mission.workflow_node_id ?? missionNodeId(missionId, mission.workflow_run_id);
  if (!nodeId) {
    if (dbApi.getWorkflowRun(mission.workflow_run_id)) aggregateRunUsage(mission.workflow_run_id);
    return;
  }
  const { definition } = load(mission.workflow_run_id);
  const node = definition.nodes.find((item) => item.id === nodeId);
  if (!node || node.config.completion === 'explicit') return;
  if (resultFailed(payload)) finishAgentNode(mission.workflow_run_id, nodeId, 'error', resultFailureMessage(payload));
  else {
    const result = parseAgentOutput(payload);
    finishAgentNode(mission.workflow_run_id, nodeId, 'ok', null, result.output, result.port);
  }
  aggregateRunUsage(mission.workflow_run_id);
}

function resultFailed(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const result = payload as Record<string, unknown>;
  return result.is_error === true || result.status === 'error' || result.subtype === 'error' || result.type === 'error';
}

function resultFailureMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'agent result failed';
  const result = payload as Record<string, unknown>;
  for (const key of ['error', 'message', 'result']) if (typeof result[key] === 'string' && result[key]) return result[key] as string;
  return 'agent result failed';
}

export function failWorkflowMission(missionId: string, error: string): void {
  const mission = dbApi.getMission(missionId); if (!mission?.workflow_run_id) return;
  const nodeId = mission.workflow_node_id ?? missionNodeId(missionId, mission.workflow_run_id);
  if (nodeId) finishAgentNode(mission.workflow_run_id, nodeId, 'error', error);
}

export function completeWorkflowNode(runId: string, nodeId: string, output: unknown, route = 'done'): boolean {
  const row = latestNodes(dbApi.listWorkflowRunNodes(runId)).find((item) => item.node_id === nodeId);
  if (!row || !row.mission_id || !['running', 'waiting'].includes(row.status)) return false;
  finishAgentNode(runId, nodeId, 'ok', null, output, route); return true;
}

export function answerWorkflowHuman(runId: string, nodeId: string, answer: string): boolean {
  const { definition } = load(runId);
  const node = definition.nodes.find((item) => item.id === nodeId);
  const row = latestNodes(dbApi.listWorkflowRunNodes(runId)).find((item) => item.node_id === nodeId);
  if (!node || node.type !== 'human' || !row || row.status !== 'waiting') return false;
  const options = Array.isArray(node.config.options) ? node.config.options.filter((item): item is string => typeof item === 'string') : [];
  const port = answer === 'approved' || answer === 'rejected' || options.includes(answer) ? answer : 'rejected';
  dbApi.updateWorkflowRunNode(runId, nodeId, { status: 'ok', output: JSON.stringify({ answer }), taken_port: port, ended_at: Date.now() });
  closeHumanCard(runId, nodeId);
  closeNodeSpan(runId, nodeId, 'ok'); publish(runId, nodeId, 'ok'); void advance(runId); return true;
}

function aggregateRunUsage(runId: string): void {
  const rows = latestNodes(dbApi.listWorkflowRunNodes(runId)).filter((row) => row.mission_id);
  const missions = [...new Set(rows.map((row) => row.mission_id!))].map((id) => dbApi.getMission(id)).filter((item): item is NonNullable<typeof item> => !!item);
  const pilot = dbApi.listMissionsByTrace(runId).find((mission) => mission.workflow_run_id === runId && mission.workflow_node_id === null);
  if (pilot && !missions.some((mission) => mission.id === pilot.id)) missions.push(pilot);
  const tokensIn = missions.reduce((n, mission) => n + (mission.tokens_in ?? 0), 0);
  const tokensOut = missions.reduce((n, mission) => n + (mission.tokens_out ?? 0), 0);
  const cost = missions.reduce((n, mission) => n + (mission.total_cost_usd ?? 0), 0);
  dbApi.updateWorkflowRun(runId, { tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost });
  const { definition } = load(runId);
  if (['running', 'waiting'].includes(dbApi.getWorkflowRun(runId)?.status ?? '') && definition.settings.maxCostUsd !== undefined && cost > definition.settings.maxCostUsd) {
    const now = Date.now();
    for (const node of latestNodes(dbApi.listWorkflowRunNodes(runId)).filter((node) => ['pending', 'running', 'waiting'].includes(node.status))) {
      dbApi.updateWorkflowRunNode(runId, node.node_id, { status: 'skipped', error: 'max cost exceeded', ended_at: now });
      closeNodeSpan(runId, node.node_id, 'error', 'max cost exceeded');
      if (node.status === 'waiting') closeHumanCard(runId, node.node_id);
    }
    dbApi.updateWorkflowRun(runId, { status: 'failed', error: 'max cost exceeded', ended_at: now });
    dbApi.upsertSpans([{ op: 'close', id: `workflow:${runId}`, status: 'error', ended_at: now, error: 'max cost exceeded' }]);
    publish(runId, undefined, 'failed');
  }
}
