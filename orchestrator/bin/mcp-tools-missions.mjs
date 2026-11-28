/**
 * MCP tools mirroring the CLI mission commands (`send`, `steer`, `wait`, `status`,
 * `kill`, `stop`, `mission summarize|fork|reindex|permission-mode|egress`, `trace backfill`).
 */

const enc = encodeURIComponent;
const mission_id = { type: 'string', description: 'Mission id (returned by mission_spawn).' };

export const tools = [
  {
    name: 'mission_send',
    title: 'Message a running mission',
    description:
      'Sends a follow-up message to a mission, without ever stopping its turn (CLI `timon send`). With no turn ' +
      'running it opens the next one. During a turn, the agent takes it when its backend can (between two ' +
      'steps or after the turn); a backend that cannot refuses with `turn_in_progress`. To change course now, use mission_steer.',
    inputSchema: {
      type: 'object',
      properties: { mission_id, input: { type: 'string', description: 'Message to deliver.' } },
      required: ['mission_id', 'input'],
    },
  },
  {
    name: 'mission_steer',
    title: 'Redirect a running mission turn',
    description:
      'Redirects the turn running NOW in another mission (CLI `timon steer`); mission_send, by contrast, never ' +
      'interrupts. The answer says how the instruction landed: `method: "live"` the agent reads it inside the ' +
      'running turn; `method: "restart"` the turn was stopped and the instruction opened the next one in the ' +
      'same session, so a step it had not finished is redone. Refused with `no_turn_to_steer` when no turn is ' +
      'running and `steer_unsupported` when this agent cannot be redirected right now (use mission_send for ' +
      'both), `steer_self` on your own mission. Then call mission_wait for the redirected turn\'s answer.',
    inputSchema: {
      type: 'object',
      properties: { mission_id, input: { type: 'string', description: 'The instruction, 20000 characters at most.' } },
      required: ['mission_id', 'input'],
    },
  },
  {
    name: 'mission_status',
    title: 'Read a mission',
    description:
      'Reads a mission (CLI `timon status`). `view: "status"` (default) is the light state ' +
      '(status, turn flags, `pending_permission` when a card waits on a person: tool, since, time left); ' +
      '`view: "full"` adds the whole transcript, which can be very large.',
    inputSchema: {
      type: 'object',
      properties: { mission_id, view: { type: 'string', enum: ['status', 'full'] } },
      required: ['mission_id'],
    },
  },
  {
    name: 'mission_wait',
    title: 'Wait for a mission turn',
    description:
      'Blocks until the mission\'s turn ends (or the mission finishes), then returns its assistant text ' +
      '(CLI `timon wait`). `timeout_s` defaults to 120, capped at 600. On timeout it returns ' +
      '`timed_out: true` and the mission keeps running: call it again.',
    inputSchema: {
      type: 'object',
      properties: { mission_id, timeout_s: { type: 'number', description: 'Seconds to wait, default 120, max 600.' } },
      required: ['mission_id'],
    },
  },
  {
    name: 'mission_kill',
    title: 'Stop a mission',
    description: 'Terminates a running mission (CLI `timon kill`).',
    inputSchema: { type: 'object', properties: { mission_id }, required: ['mission_id'] },
  },
  {
    name: 'stop_scope',
    title: 'Stop an agent or a project',
    description:
      'Technical stop of ONE agent or ONE project (CLI `timon stop`): kills its running missions, empties its ' +
      'inbox, settles its open requests, blocks its PENDING/IN_PROGRESS tasks, switches off its triggers, cancels the workflow runs it takes part in and switches off the workflows that would start new ones. ' +
      'Pass exactly one of `agent` or `project`. Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Agent name.' }, project: { type: 'string', description: 'Project slug.' } },
    },
  },
  {
    name: 'mission_permission_mode_get',
    title: 'Read a mission\'s permission level',
    description:
      'Reads the permission level of a mission (CLI `timon mission permission-mode get`): `mode`, its ' +
      '`source` (mission override, agent config or default), whether its backend can change it mid-mission ' +
      '(`switchable`) and the `choices` YOU may set on it.',
    inputSchema: { type: 'object', properties: { mission_id }, required: ['mission_id'] },
  },
  {
    name: 'mission_permission_mode_set',
    title: 'Set a mission\'s permission level',
    description:
      'Changes the permission level of a mission from its next message (CLI `timon mission permission-mode set`). ' +
      'Claude modes (plan, default, acceptEdits, auto, dontAsk, bypassPermissions) or codex sandbox names ' +
      '(read-only, workspace-write, danger-full-access). Without `agents:privileged-config` only default, ' +
      'acceptEdits, plan and auto; never above the level your own mission runs in. Read the allowed ' +
      '`choices` with mission_permission_mode_get first.',
    inputSchema: {
      type: 'object',
      properties: { mission_id, mode: { type: 'string', description: 'Permission mode name.' } },
      required: ['mission_id', 'mode'],
    },
  },
  {
    name: 'mission_summarize',
    title: 'Summarize a mission',
    description: 'Compresses a mission transcript into a summary usable for cross-LLM continuation (CLI `timon mission summarize`).',
    inputSchema: {
      type: 'object',
      properties: { mission_id, force: { type: 'boolean', description: 'Recompute even if a summary is cached.' } },
      required: ['mission_id'],
    },
  },
  {
    name: 'mission_fork',
    title: 'Fork a mission to another agent',
    description: 'Spawns a continuation of a mission on another agent, seeded with its summary (CLI `timon mission fork`).',
    inputSchema: {
      type: 'object',
      properties: { mission_id, to: { type: 'string', description: 'Target agent name.' }, message: { type: 'string', description: 'Optional first message.' } },
      required: ['mission_id', 'to'],
    },
  },
  {
    name: 'mission_propose_archive',
    title: 'Propose archiving this conversation',
    description:
      'Proposes that the person archives THIS conversation (the one you are running in), which then shows an ' +
      '"the agent suggests archiving" prompt with Archive and Dismiss buttons. Call it when the work you were ' +
      'asked for is finished and no follow-up is expected. You never archive anything yourself: the person ' +
      'decides, and a new message from them clears the proposal. Give a short `reason` (200 characters at most). ' +
      'Refused with `already_archived` when the conversation is archived, and outside a mission.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', maxLength: 200, description: 'One short sentence telling the person why this can be archived.' } },
    },
  },
  {
    name: 'mission_egress',
    title: 'Read a mission\'s outbound connections',
    description:
      'Lists the outbound connections a mission made through the egress proxy, most recent first ' +
      '(CLI `timon mission egress`): method, host, port, status, bytes, duration and upstream error code — never a ' +
      'path or a credential. Also `hosts` (one line per host) and `new_hosts` (hosts this mission was the first of ' +
      'its project to reach). Nothing is blocked; a process that ignores the proxy variables is not listed. ' +
      'The proxy is off by default: the answer then carries `notice` (journal disabled, how to enable it), and an ' +
      'empty list says nothing about what the mission reached. ' +
      'Page with `before` = the `next_before` of the previous answer.',
    inputSchema: {
      type: 'object',
      properties: {
        mission_id,
        limit: { type: 'number', description: 'Connections per page, 1-500, default 100.' },
        before: { type: 'number', description: 'Return connections older than this id (`next_before`).' },
      },
      required: ['mission_id'],
    },
  },
  {
    name: 'mission_reindex',
    title: 'Rebuild the mission search index',
    description: 'Rebuilds the mission search index until it is up to date (CLI `timon mission reindex`).',
    inputSchema: { type: 'object', properties: { batch: { type: 'number', description: 'Events per batch, default 500.' } } },
  },
  {
    name: 'trace_backfill',
    title: 'Backfill traces from events',
    description: 'Replays cold events into spans (CLI `timon trace backfill`). `days` limits how far back; without it, stops at the span retention horizon, since older spans would be removed again.',
    inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
  },
];

/** A `user` event that really opens a turn (tool results are persisted as `user` events too). */
function isTurnStart(event) {
  if (event.type !== 'user') return false;
  const content = event.payload?.message?.content;
  if (!Array.isArray(content)) return true;
  return !content.some((b) => b && b.type === 'tool_result');
}

/** Assistant text of `events`; `sinceLastTurn` keeps only what follows the last user input. */
export function pickAssistantText(events, sinceLastTurn = false) {
  let scanned = events || [];
  if (sinceLastTurn) {
    let start = 0;
    for (let i = 0; i < scanned.length; i += 1) if (isTurnStart(scanned[i])) start = i + 1;
    scanned = scanned.slice(start);
  }
  const out = [];
  for (const e of scanned) {
    if (e.type !== 'assistant') continue;
    const blocks = e.payload?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) if (b.type === 'text' && b.text) out.push(b.text);
  }
  return out.join('\n').trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const handlers = {
  async mission_send(args, { call }) {
    // The route really takes a mission id despite its /agents prefix (see the CLI).
    return await call('POST', `/api/agents/${enc(args.mission_id)}/send`, { input: `${args.input}\n` });
  },
  async mission_steer(args, { call }) {
    return await call('POST', `/api/missions/${enc(args.mission_id)}/steer`, { input: args.input });
  },
  async mission_status(args, { call }) {
    const view = args.view === 'full' ? '' : '?view=status';
    return await call('GET', `/api/missions/${enc(args.mission_id)}${view}`);
  },
  async mission_wait(args, { call }) {
    const timeout = Math.min(Math.max(Number(args.timeout_s ?? 120) || 120, 1), 600);
    const deadline = Date.now() + timeout * 1000;
    const poll = `/api/missions/${enc(args.mission_id)}?view=status`;
    let last;
    let turnEnded = false;
    while (Date.now() < deadline) {
      last = await call('GET', poll);
      if (last.status && last.status !== 'running' && last.status !== 'queued') break;
      // A persistent backend keeps its process after the turn: the end of the turn IS the answer.
      if (last.turn_complete && !last.turn_active) { turnEnded = true; break; }
      await sleep(1500);
    }
    if (!turnEnded && (!last || last.status === 'running' || last.status === 'queued')) {
      return { mission_id: args.mission_id, timed_out: true, status: last?.status ?? null };
    }
    const full = await call('GET', `/api/missions/${enc(args.mission_id)}`);
    const text = pickAssistantText(full.events, turnEnded) || pickAssistantText(full.events);
    return { mission_id: args.mission_id, timed_out: false, status: full.status ?? last?.status ?? null, text };
  },
  async mission_kill(args, { call }) {
    return await call('DELETE', `/api/missions/${enc(args.mission_id)}`);
  },
  async stop_scope(args, { call }) {
    const given = [args.agent, args.project].filter((v) => v !== undefined);
    if (given.length !== 1) throw new Error('pass exactly one of agent or project');
    return await call('POST', '/api/stop', args.agent !== undefined ? { agent: args.agent } : { project: args.project });
  },
  async mission_permission_mode_get(args, { call }) {
    return await call('GET', `/api/missions/${enc(args.mission_id)}/permission-mode`);
  },
  async mission_permission_mode_set(args, { call }) {
    // The daemon holds the guard; only the mode crosses (its body schema is strict).
    return await call('POST', `/api/missions/${enc(args.mission_id)}/permission-mode`, { mode: args.mode });
  },
  async mission_egress(args, { call }) {
    const query = new URLSearchParams();
    if (args.limit !== undefined) query.set('limit', String(args.limit));
    if (args.before !== undefined) query.set('before', String(args.before));
    const qs = query.toString();
    return await call('GET', `/api/missions/${enc(args.mission_id)}/egress${qs ? `?${qs}` : ''}`);
  },
  async mission_summarize(args, { call }) {
    return await call('POST', `/api/missions/${enc(args.mission_id)}/summarize`, { force: args.force === true });
  },
  async mission_propose_archive(args, { call, env }) {
    if (!env.missionId) throw new Error('mission_propose_archive only works inside a mission (TIMON_MISSION_ID is not set)');
    const body = args.reason === undefined ? {} : { reason: args.reason };
    return await call('POST', `/api/missions/${enc(env.missionId)}/archive-suggestion`, body);
  },
  async mission_fork(args, { call }) {
    const body = { agent: args.to };
    if (args.message !== undefined) body.message = args.message;
    const r = await call('POST', `/api/missions/${enc(args.mission_id)}/fork`, body);
    return { mission_id: r.missionId, cached_summary: r.cached };
  },
  async mission_reindex(args, { call }) {
    const batch = Number(args.batch ?? 500) || 500;
    let total = 0;
    // Bounded: a runaway index must not pin the tool call forever.
    for (let i = 0; i < 200; i += 1) {
      const r = await call('POST', '/api/missions/search/reindex', { batch });
      total += r.indexed || 0;
      if (r.done) return { done: true, fragments_added: total };
    }
    return { done: false, fragments_added: total, note: 'stopped after 200 batches; call again to continue' };
  },
  async trace_backfill(args, { call }) {
    return await call('POST', '/api/trace/backfill', args.days === undefined ? {} : { days: Number(args.days) });
  },
};
