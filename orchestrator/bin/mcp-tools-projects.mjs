/**
 * MCP tools mirroring the CLI commands on projects (`project list|roles|set-role`),
 * memory (`memory rule rm|search|overview|show`), notifications (`notify`) and
 * `msg reply`.
 */

const enc = encodeURIComponent;
const ROLES = ['code', 'review', 'merge', 'research', 'doc', 'chore'];

export const tools = [
  { name: 'project_list', title: 'List projects', description: 'Lists the registered projects (CLI `timon project list`).', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'project_roles',
    title: 'List a project\'s roles',
    description: 'Shows which agent holds each role on a project (CLI `timon project roles`).',
    inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'Project slug.' } }, required: ['slug'] },
  },
  {
    name: 'project_set_role',
    title: 'Assign a project role',
    description:
      'Assigns the agent (and optionally backend, model, permission mode) that runs a role on a project ' +
      '(CLI `timon project set-role`). An empty `agent` clears the role. Run it BEFORE dispatching tasks of that type: ' +
      'a project with no role holder makes every dispatch fail.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Project slug.' },
        role: { type: 'string', enum: ROLES },
        agent: { type: 'string', description: 'Agent name; empty string clears the role.' },
        backend: { type: 'string', description: 'See backends_list.' },
        model: { type: 'string' },
        permission_mode: { type: 'string', description: 'default, acceptEdits or bypassPermissions.' },
      },
      required: ['slug', 'role', 'agent'],
    },
  },
  {
    name: 'memory_rule_rm',
    title: 'Delete a memory rule',
    description: 'Deletes a memory rule by id (CLI `timon memory rule rm`); ids come from memory_rule_list. The agents the rule may have reached start a fresh conversation at their next mission (`fresh_conversation`).',
    inputSchema: { type: 'object', properties: { id: { type: ['string', 'number'] } }, required: ['id'] },
  },
  {
    name: 'memory_search',
    title: 'Search memory',
    description: 'Cross-cutting search in memory rules and facts, ranked by relevance (CLI `timon memory search`).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'memory_overview',
    title: 'Show memory counters',
    description: 'Memory counters and pending proposals (CLI `timon memory overview`).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_show',
    title: 'Read memory files',
    description:
      'Reads the reference memory files of a project or an agent (CLI `timon memory show`). ' +
      'Without `file`, lists the files; with it, returns the file content.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'agent'] },
        id: { type: 'string', description: 'Project slug or agent name.' },
        file: { type: 'string', description: 'File name from the listing.' },
      },
      required: ['scope', 'id'],
    },
  },
  {
    name: 'notify',
    title: 'Notify the user',
    description:
      'Posts to the user\'s notification center (CLI `timon notify`). `report`: end-of-task result worth seeing; ' +
      '`alert`: you are blocked (add `urgent`); `action_required`: the user must do something — it closes by itself ' +
      'on `dismiss_on` (default: the user replying in your mission, and the task reaching DONE when `task_id` is set), ' +
      'or after `ttl_minutes` (default 24 h with no trigger, 7 days with one). One short report beats three. ' +
      'If the notifications module is disabled the notification is dropped, not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['report', 'alert', 'action_required'] },
        title: { type: 'string' },
        body: { type: 'string' },
        urgent: { type: 'boolean' },
        task_id: { type: 'string' },
        mission_id: { type: 'string', description: 'Defaults to the current mission.' },
        dismiss_on: {
          type: 'array',
          items: { type: 'string', enum: ['reply', 'task_done'] },
          description: 'action_required only: `reply` = the user writes in the mission, `task_done` = task_id reaches DONE.',
        },
        ttl_minutes: { type: 'integer', minimum: 1, description: 'action_required only: dismissed after this many minutes.' },
      },
      required: ['type', 'title'],
    },
  },
  {
    name: 'agent_reply',
    title: 'Reply to an inbox message',
    description: 'Replies to a message of your inbox: sends a `response` to its sender, linked to it (CLI `timon msg reply`).',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string' }, payload: { type: 'string' } },
      required: ['message_id', 'payload'],
    },
  },
];

export const handlers = {
  async project_list(_args, { call }) {
    const r = await call('GET', '/api/projects');
    return r.projects ?? r;
  },
  async project_roles(args, { call }) {
    return (await call('GET', `/api/projects/${enc(args.slug)}/roles`)).roles;
  },
  async project_set_role(args, { call }) {
    const body = args.agent === '' ? {} : { agent: args.agent };
    for (const key of ['backend', 'model', 'permission_mode']) if (args[key] !== undefined) body[key] = args[key];
    return (await call('PATCH', `/api/projects/${enc(args.slug)}/roles/${enc(args.role)}`, body)).roles;
  },
  async memory_rule_rm(args, { call }) {
    const r = await call('DELETE', `/api/memory/rules/${enc(String(args.id))}`);
    const fresh = Array.isArray(r.fresh_conversation) ? r.fresh_conversation : [];
    return {
      deleted: r.deleted ?? { id: args.id },
      fresh_conversation: fresh,
      ...(fresh.length ? { note: 'The agent will start a fresh conversation at its next mission: its earlier session still held the rule.' } : {}),
    };
  },
  async memory_search(args, { call }) {
    return await call('GET', `/api/memory/search?q=${enc(args.query)}`);
  },
  async memory_overview(_args, { call }) {
    return await call('GET', '/api/memory/overview');
  },
  async memory_show(args, { call, TextResult }) {
    const base = args.scope === 'project' ? `/api/projects/${enc(args.id)}/memory` : `/api/agents/${enc(args.id)}/memory`;
    if (!args.file) return (await call('GET', base)).files ?? [];
    const r = await call('GET', `${base}/${enc(args.file)}`);
    return new TextResult(typeof r?.raw === 'string' ? r.raw : JSON.stringify(r, null, 2));
  },
  async notify(args, { call, env }) {
    const body = {
      type: args.type, urgent: args.urgent ? 1 : 0, title: args.title, body: args.body ?? null,
      task_id: args.task_id ?? null, mission_id: args.mission_id ?? env?.missionId ?? null,
    };
    if (args.dismiss_on !== undefined) body.dismiss_on = args.dismiss_on;
    if (args.ttl_minutes !== undefined) body.ttl_minutes = args.ttl_minutes;
    try {
      const r = await call('POST', '/api/notifications', body);
      return { notification_id: (r.notification ?? r).id };
    } catch (err) {
      // `notifications` is a switchable module: its absence is a configuration choice, not a failure.
      if (/→ (404|503)\b/.test(String(err?.message))) return { dropped: true, reason: 'notifications module disabled' };
      throw err;
    }
  },
  async agent_reply(args, { call, env }) {
    const orig = (await call('GET', `/api/messages/${enc(args.message_id)}`)).message;
    if (!orig) throw new Error(`message ${args.message_id} not found`);
    const body = {
      to_agent: orig.from_agent, to_mission: orig.from_mission, kind: 'response',
      in_reply_to: args.message_id, payload: args.payload,
    };
    if (env?.traceId) body.trace_id = env.traceId;
    const r = await call('POST', '/api/messages', body);
    return { message_id: r.message_id, created_at: r.created_at };
  },
};
