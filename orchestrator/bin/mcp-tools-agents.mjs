/**
 * MCP tools mirroring `timon agent|skill|mcp|backends` — same daemon routes as
 * the CLI, for installs where `timon` is not on the PATH. Each handler receives
 * `{ call }` (authenticated daemon call) from timon-mcp.mjs.
 */

const STR_LIST = { type: 'array', items: { type: 'string' } };

/** The mascot's lists, as `src/agent-look.ts` checks them (a test keeps the two equal). */
export const AGENT_LOOK_SHAPES = ['squircle', 'tri', 'gem', 'round', 'bean', 'cloud', 'hex'];
export const AGENT_LOOK_COLORS = [
  '#d4a373', '#b8743d', '#e6c9a2', '#8a5a3b', '#c98e5a', '#a8826a', '#d9b48a', '#7a4f35', '#e0b07a',
  '#ff5fbf', '#3fa9ff', '#7ed957',
  '#ffc233', '#ff8a2a', '#a35bff',
];
export const AGENT_LOOK_EYES = ['pill', 'big', 'happy', 'wink', 'surprised', 'squint', 'sleepy', 'heart', 'star', 'code'];
export const AGENT_LOOK_ACCESSORIES = [
  'none', 'loupe', 'pen', 'quill', 'hammer', 'wrench', 'baton', 'telescope', 'envelope', 'calendar',
  'clipboard', 'hourglass', 'teacher', 'calculator', 'chart', 'brush', 'globe', 'megaphone', 'shield', 'coffee',
  'whip', 'wizard', 'chef', 'crown', 'idea', 'rocket', 'chemist', 'gamer', 'photographer', 'gardener', 'musician',
];

/** The avatar modes, as `src/agent-look.ts` checks them (same test). */
export const AGENT_AVATAR_MODES = ['emoji', 'image', 'mascot'];

/**
 * A part a mascot pack adds, `<pluginId>:<part>` (same pattern as
 * `MASCOT_PART_ID_RE` in `src/agent-look.ts`, kept equal by the parity test).
 * The schema cannot list them — they come and go with the plugins — so it
 * admits their form and the daemon decides: a part no enabled pack declares
 * is refused (400) with the ones that are.
 */
export const MASCOT_PART_ID_PATTERN = '^[a-z0-9-]{3,40}:[a-z0-9][a-z0-9-]{0,39}$';

/** Any fur off the palette, `#rrggbb` (same pattern as `AGENT_LOOK_CUSTOM_COLOR_RE`, kept equal by the parity test). */
export const AGENT_LOOK_CUSTOM_COLOR_PATTERN = '^#[0-9a-fA-F]{6}$';

/** One look field: a product value, or a pack's part checked by the daemon. */
function lookField(values, description, extra = []) {
  return {
    anyOf: [
      { type: 'string', enum: values },
      { type: 'string', pattern: MASCOT_PART_ID_PATTERN, description: 'A part of an installed and enabled mascot pack, `<plugin>:<part>`.' },
      ...extra,
    ],
    description,
  };
}

/** The mascot look as a JSON schema, shared by agent_update / agent_create and agent_set_look. */
const LOOK_SCHEMA = {
  type: 'object',
  properties: {
    shape: lookField(AGENT_LOOK_SHAPES, 'Skull of the mascot.'),
    color: lookField(AGENT_LOOK_COLORS, 'Fur colour: #rrggbb from this palette, any other #rrggbb, or a pack\'s fur.',
      [{ type: 'string', pattern: AGENT_LOOK_CUSTOM_COLOR_PATTERN, description: 'Any other fur, #rrggbb.' }]),
    eyes: lookField(AGENT_LOOK_EYES, 'Resting eyes.'),
    acc: lookField(AGENT_LOOK_ACCESSORIES, 'Job accessory held by the mascot.'),
  },
  required: ['shape', 'color', 'eyes'],
  additionalProperties: false,
};

/** Agent config fields shared by agent_create and agent_update (CLI `takeConfigFlags`). */
export const AGENT_CONFIG_PROPERTIES = {
  cwd: { type: 'string', description: 'Absolute working directory on the host; must exist and lie inside a registered project (a sub-folder counts). Not registered yet: call project_create with this directory first.' },
  project: { type: 'string', description: 'Project slug the agent belongs to.' },
  role: { type: 'string', description: 'Role held on the project (orchestrator, coder, reviewer, merger…).' },
  backend: { type: 'string', description: 'LLM backend id (see backends_list). Leave unset to inherit. Without the `agents:privileged-config` permission a call is refused (403, with a reason) for a backend that cannot arbitrate tool uses per call, such as codex.' },
  model: { type: 'string', description: 'Model slug for that backend (see backends_list). Leave unset to inherit.' },
  permission_mode: { type: 'string', description: 'Claude modes (plan, default, acceptEdits, auto, dontAsk, bypassPermissions) or codex sandbox names (read-only, workspace-write, danger-full-access), which sit on the same ladder. Never above the level of the calling agent; without `agents:privileged-config` only default, acceptEdits, plan and auto. A value the agent already holds is never refused.' },
  skills: { ...STR_LIST, description: 'The whole set of skills checked on the agent (see skill_list), stored as its own skill attachments, not in config.json: a new id gets a catalogue (include) attachment, a listed one keeps its mode, an unlisted one is detached. Import mode or an exclusion: skill_attach. From a mission, a new skill whose `allowed-tools` the agent does not already hold is refused.' },
  mcp_servers: { ...STR_LIST, description: 'MCP server ids attached to the agent (see mcp_server_list). From a mission, a stdio server (a command on the host) the agent does not already hold is refused (403 with a reason): the user attaches it from the Agents page. Without `agents:privileged-config` a call cannot attach any on a NEW agent: leave unset.' },
  allowed_tools: { ...STR_LIST, description: 'Tool patterns pre-allowed, e.g. `Bash(timon:*)`; a bare `Bash` pre-allows every shell command, except in auto mode where the claude CLI ignores it (the answer then carries a warning). From a mission a call cannot add one the agent does not already hold (403 with a reason), whatever the account holds: the user adds tools from the Agents page. Removing tools, or sending the list unchanged, passes.' },
  disallowed_tools: { ...STR_LIST, description: 'Tool patterns refused. From a mission, a pattern already refused cannot be lifted.' },
  excluded_mcp_servers: { ...STR_LIST, description: 'MCP servers excluded for this agent.' },
  memory_scope: { type: 'string', enum: ['NONE', 'SESSION', 'AGENT', 'GLOBAL'], description: 'Memory scope.' },
  reports_to: { type: ['string', 'null'], description: 'Name of the agent this one reports to (team hierarchy); null clears it.' },
  emoji: { type: 'string', description: 'Emoji shown for the agent.' },
  color: { type: 'string', description: 'Accent colour of the agent.' },
  look: {
    ...LOOK_SCHEMA,
    type: ['object', 'null'],
    description:
      'Mascot look drawn when the agent has no profile picture; null clears it. ' +
      'A part of a mascot pack (`<plugin>:<part>`) is accepted while that plugin is enabled. ' +
      'An unknown value is refused (400) with the accepted ones. `acc` defaults to none.',
  },
  avatar: {
    type: ['string', 'null'],
    enum: [...AGENT_AVATAR_MODES, null],
    description:
      'Which head the agent shows: `emoji`, `image` (its profile picture) or `mascot` (its `look`); ' +
      'null clears it (back to picture, project logo, emoji, initial). The settings of the other modes are kept.',
  },
};

/** Fields kept when a full upsert rewrites the agent (prompt change): the editable
 *  ones plus the ones the CLI's round-trip used to drop (role, picture, context). */
export const PRESERVED_ON_REWRITE = ['role', 'icon_url', 'global_context', 'browser_profile_id', 'look', 'avatar'];

export const AGENT_CONFIG_KEYS = Object.keys(AGENT_CONFIG_PROPERTIES);

/** Pick the config fields present in `args` (undefined = untouched, null kept: it clears). */
export function pickAgentConfig(args) {
  const config = {};
  for (const key of AGENT_CONFIG_KEYS) if (args[key] !== undefined) config[key] = args[key];
  return config;
}

const name = (extra = '') => ({ type: 'string', description: `Exact agent name, from agent_list.${extra}` });

export const tools = [
  {
    name: 'agent_update',
    title: 'Update an agent',
    description:
      'Partially updates an existing agent (CLI `timon agent update`): pass only the fields to change. ' +
      'Without `system_prompt` the prompt stays untouched; with it, the prompt is replaced and the ' +
      'existing config is kept, merged with your fields. Requires `agents:manage`; a 403 carries a `reason` that names the refused field.',
    inputSchema: {
      type: 'object',
      properties: {
        name: name(),
        system_prompt: { type: 'string', description: 'New full system prompt (markdown). Omit to keep the current one.' },
        ...AGENT_CONFIG_PROPERTIES,
      },
      required: ['name'],
    },
  },
  {
    name: 'agent_set_look',
    title: 'Change an agent\'s look',
    description:
      'Changes the mascot look of YOUR agent (leave `agent` out), or of an agent you orchestrate (`PUT /api/agent-look`): ' +
      'when the user asks "put on your chef\'s hat", pick the closest accessory, eyes, shape and colour from the lists. ' +
      '`use_mascot: true` also makes the mascot the head the agent shows (instead of its emoji or picture), without ' +
      'erasing them; left out, the head shown does not change. Any other agent is refused (403) whatever your rights: ' +
      'use agent_update for that. Requires `agents:manage` on the launcher account; an unknown value is refused (400) ' +
      'with the accepted ones.',
    inputSchema: {
      type: 'object',
      properties: {
        look: { ...LOOK_SCHEMA, description: 'The new look. `acc` defaults to none (no accessory).' },
        use_mascot: { type: 'boolean', description: 'Also show the mascot as the agent\'s head (avatar mode `mascot`).' },
        agent: { type: 'string', description: 'Exact name of an agent you orchestrate, from agent_list. Omit for yourself.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agent_delete',
    title: 'Delete an agent',
    description:
      'Deletes an agent (`DELETE /api/agents/:name`): its folder (config, system prompt, identity docs, memory) moves ' +
      'to the trash and comes back with `agent_trash_restore` until the trash is emptied (Settings > Agent trash; ' +
      'final when the trash is off). Confirm with the user first. Requires `agents:manage`; the daemon refuses deleting the main agent.',
    inputSchema: { type: 'object', properties: { name: name() }, required: ['name'] },
  },
  {
    name: 'agent_trash_list',
    title: 'List deleted agents',
    description:
      'Deleted agents waiting in the trash, newest first, with the id to restore, who deleted them and when the ' +
      'automatic purge takes them (CLI `timon agent trash list`). Requires `agents:read` or `agents:manage`.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_trash_restore',
    title: 'Restore a deleted agent',
    description:
      'Puts a deleted agent back under its name, from its trash `id` given by `agent_trash_list` (CLI ' +
      '`timon agent trash restore`). Refused (409) while another agent holds that name. Approval rules and the ' +
      'pending inbox dropped at deletion do not come back. Requires `agents:manage`. Emptying the trash for good ' +
      'stays a person\'s gesture (app or CLI).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Trash entry id, as listed by agent_trash_list.' } },
      required: ['id'],
    },
  },
  {
    name: 'agent_rename',
    title: 'Rename an agent',
    description:
      'Renames an agent (CLI `timon agent rename`): moves its directory and rewrites its references — ' +
      'missions, tasks, routines, triggers, messages, memory rules, secret grants, project roles, hierarchy. ' +
      'Requires `agents:manage`; refused (409) when `new_name` exists or a mission of the agent is running. ' +
      'The answer lists in `triggers_to_check` the event triggers whose filter matches the old name by pattern or substring: ' +
      'they are left unchanged and their owner is notified, tell the user.',
    inputSchema: {
      type: 'object',
      properties: { name: name(), new_name: { type: 'string', description: 'New agent name; must not exist yet.' } },
      required: ['name', 'new_name'],
    },
  },
  {
    name: 'agent_set_scope',
    title: 'Set an agent\'s memory scope',
    description: 'Sets an agent\'s memory scope (CLI `timon agent set-scope`): NONE, SESSION, AGENT or GLOBAL.',
    inputSchema: {
      type: 'object',
      properties: { name: name(), scope: { type: 'string', enum: ['NONE', 'SESSION', 'AGENT', 'GLOBAL'] } },
      required: ['name', 'scope'],
    },
  },
  {
    name: 'agent_doc_list',
    title: 'List an agent\'s identity docs',
    description:
      'Lists the identity docs of an agent (CLI `timon agent doc list`): the *.md files at its root ' +
      '(SOUL.md, system-prompt.md…), injected into every mission it runs. Not its memory, not its cwd.',
    inputSchema: { type: 'object', properties: { name: name() }, required: ['name'] },
  },
  {
    name: 'agent_doc_get',
    title: 'Read an identity doc',
    description: 'Returns one identity doc of an agent as text (CLI `timon agent doc get`).',
    inputSchema: {
      type: 'object',
      properties: { name: name(), file: { type: 'string', description: 'Doc file name, e.g. SOUL.md (a *.md at the agent root).' } },
      required: ['name', 'file'],
    },
  },
  {
    name: 'agent_doc_put',
    title: 'Write an identity doc',
    description:
      'Creates or replaces one identity doc of an agent (CLI `timon agent doc put`), e.g. SOUL.md; at most 2 MB. ' +
      'From a mission: your own agent, or one you orchestrate that runs no higher than you (403 otherwise). ' +
      'Docs only: the config, backend, permissions and MCP servers go through agent_update.',
    inputSchema: {
      type: 'object',
      properties: {
        name: name(),
        file: { type: 'string', description: 'Doc file name, e.g. SOUL.md (a *.md at the agent root).' },
        content: { type: 'string', description: 'Full markdown content of the doc.' },
      },
      required: ['name', 'file', 'content'],
    },
  },
  {
    name: 'agent_doc_rm',
    title: 'Delete an identity doc',
    description:
      'Deletes one identity doc of an agent (CLI `timon agent doc rm`); system-prompt.md cannot be deleted. ' +
      'Same rule as agent_doc_put from a mission.',
    inputSchema: {
      type: 'object',
      properties: { name: name(), file: { type: 'string', description: 'Doc file name, e.g. SOUL.md.' } },
      required: ['name', 'file'],
    },
  },
  {
    name: 'backends_list',
    title: 'List backends and models',
    description:
      'Backends and models actually available on this install (CLI `timon backends`). ' +
      'Use it to pick `backend`/`model` values: never list models from memory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_list',
    title: 'List skills',
    description: 'Lists the installed skills (CLI `timon skill list`).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_get',
    title: 'Read a skill',
    description:
      'Returns the SKILL.md body of a skill, then the files next to it (CLI `timon skill get`). Read a skill of your ' +
      '"Skills available on demand" catalogue with it before applying it. With `file`, returns that file of the ' +
      'skill folder instead (a path the body cites or the list names, e.g. `references/api.md`). Vault values read as ' +
      '`***`: skill_put refuses that text back over them.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Skill id.' },
        file: { type: 'string', description: 'Optional: a file next to SKILL.md, relative to the skill folder, `/` separated.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'skill_attachment_list',
    title: 'List skill attachments',
    description:
      'Lists skill attachments: which skill reaches which agents, and how (CLI `timon skill attachments`). ' +
      'Filter by `scope`, `target` or `skill`.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project', 'role', 'agent'] },
        target: { type: 'string', description: 'Project slug, role id or agent name.' },
        skill: { type: 'string', description: 'Skill id.' },
      },
    },
  },
  {
    name: 'skill_attach',
    title: 'Attach a skill',
    description:
      'Attaches a skill to agents (CLI `timon skill attach`). `scope`: global, project, role or agent, with ' +
      '`target` (project slug, role id, agent name; none for global). `mode`: `include` (default) puts one ' +
      'catalogue line `id — description` in the prompt, the agent reads the body with skill_get; `import` pastes ' +
      'the whole body. `exclude: true` removes, at this scope, a skill inherited from a wider one. The narrowest ' +
      'scope wins: global < project < role < agent. Writing the same skill, scope and target again replaces it. ' +
      'Agent scope: only an agent you orchestrate; a wider scope needs agents:privileged-config. ' +
      'From a mission, a skill whose `allowed-tools` the agent does not already hold is refused (403 with a reason), ' +
      'at any scope: the user attaches it from the Agents or Skills page.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill id (see skill_list).' },
        scope: { type: 'string', enum: ['global', 'project', 'role', 'agent'] },
        target: { type: 'string', description: 'Project slug, role id or agent name. Omit for global.' },
        mode: { type: 'string', enum: ['include', 'import'] },
        exclude: { type: 'boolean' },
      },
      required: ['skill', 'scope'],
    },
  },
  {
    name: 'skill_detach',
    title: 'Detach a skill',
    description: 'Removes a skill attachment by id (CLI `timon skill detach`). Ids come from skill_attachment_list.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'Attachment id.' } }, required: ['id'] },
  },
  {
    name: 'skill_resolve',
    title: 'Resolve an agent\'s skills',
    description:
      'The skills an agent spawns with, attachments and its config resolved, each with its mode and where it ' +
      'comes from (CLI `timon skill resolve`). Skills a task or a workflow adds to one mission are not listed.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
  },
  {
    name: 'skill_reads',
    title: 'Skill reads of an agent',
    description:
      'How often the agent\'s missions read each skill with skill_get over the last 30 days, counted on the ' +
      'missions you may see (CLI `timon skill reads`): `missions` started in the window, and per skill id ' +
      '`reads` and distinct `missions`. A skill never read is absent: cross with skill_resolve (mode include) ' +
      'to find a catalogue skill whose description does not make the agent reach for it. Reads made natively ' +
      '(a backend opening the skill file itself) are not counted.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
  },
  {
    name: 'skill_put',
    title: 'Write a skill',
    description:
      'Creates or replaces a skill (CLI `timon skill put`). `content` is the full SKILL.md, ' +
      'with its frontmatter (name, description). Attach it to an agent with skill_attach (or agent_update `skills`). ' +
      'From a mission: by id only, never a product skill (timon-task, timon-worktree, …), and no ' +
      '`allowed_tools` (it pre-authorises tools: the user writes such a skill from the Skills page). ' +
      '`create_only: true` never replaces: an id that already exists answers 409, pick another one.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string', description: 'Full SKILL.md body.' },
        create_only: { type: 'boolean', description: 'Create only: refuse (409) when the skill already exists.' },
      },
      required: ['id', 'content'],
    },
  },
  {
    name: 'skill_rm',
    title: 'Delete a skill',
    description: 'Deletes a skill (CLI `timon skill rm`).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'mcp_server_list',
    title: 'List MCP servers',
    description: 'Lists the MCP servers declared in Timon (CLI `timon mcp list`), the ones agents can attach.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mcp_server_get',
    title: 'Read an MCP server',
    description: 'Returns the config of a declared MCP server (CLI `timon mcp get`); from a mission, stdio env values, headers and OAuth tokens are masked (`***`).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'mcp_server_put',
    title: 'Declare an MCP server',
    description:
      'Creates or replaces an MCP server declaration (CLI `timon mcp put`). `config` is ' +
      '`{ name?, description?, transport }`, transport being a stdio or http transport object. ' +
      'Attach it to an agent with agent_update `mcp_servers`. From a mission it needs `mcp:manage`; ' +
      'an http server (public http(s) url) is accepted; a stdio server (a command on the host) is never ' +
      'declared or changed from a mission, the user does it from the MCP servers page; ' +
      'the change of a server this agent did not declare needs `agents:privileged-config`, and ' +
      'servers Timon injects or account connectors are never writable. Secrets read back masked ' +
      '(`***`): send them back as is to keep the stored value.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, config: { type: 'object', description: '{ name?, description?, transport }' } },
      required: ['id', 'config'],
    },
  },
  {
    name: 'mcp_server_rm',
    title: 'Delete an MCP server',
    description: 'Deletes a declared MCP server (CLI `timon mcp rm`). From a mission: needs `mcp:manage`, and a server this agent did not declare, or a stdio one, needs `agents:privileged-config`.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const enc = encodeURIComponent;

export const handlers = {
  async agent_update(args, { call }) {
    const patch = pickAgentConfig(args);
    // Existence probe, like the CLI: a typo must not create an agent.
    const current = await call('GET', `/api/agents/${enc(args.name)}`);
    if (args.system_prompt !== undefined) {
      // The prompt travels with the full upsert: keep what is already configured.
      const merged = {};
      for (const key of [...AGENT_CONFIG_KEYS, ...PRESERVED_ON_REWRITE]) {
        const value = current?.[key];
        if (value === undefined || value === null) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        merged[key] = value;
      }
      Object.assign(merged, patch);
      await call('POST', '/api/agents', { name: args.name, system_prompt: args.system_prompt, config: merged });
      return { name: args.name, updated: Object.keys(patch).concat('system_prompt') };
    }
    if (Object.keys(patch).length === 0) throw new Error('nothing to update: pass system_prompt or at least one config field');
    await call('PATCH', `/api/agents/${enc(args.name)}/config`, patch);
    return { name: args.name, updated: Object.keys(patch) };
  },
  async agent_set_look(args, { call }) {
    if (args.look === undefined && args.use_mascot !== true) throw new Error('nothing to change: pass look, or use_mascot: true');
    const body = {};
    if (args.agent !== undefined) body.agent = args.agent;
    if (args.look !== undefined) body.look = args.look;
    if (args.use_mascot !== undefined) body.use_mascot = args.use_mascot;
    const r = await call('PUT', '/api/agent-look', body);
    return { name: r.name, look: r.look, avatar: r.avatar };
  },
  async agent_delete(args, { call }) {
    return await call('DELETE', `/api/agents/${enc(args.name)}`);
  },
  async agent_trash_list(_args, { call }) {
    return await call('GET', '/api/agent-trash');
  },
  async agent_trash_restore(args, { call }) {
    return await call('POST', `/api/agent-trash/${enc(args.id)}/restore`, {});
  },
  async agent_rename(args, { call }) {
    return await call('POST', `/api/agents/${enc(args.name)}/rename`, { newName: args.new_name });
  },
  async agent_set_scope(args, { call }) {
    await call('PATCH', `/api/agents/${enc(args.name)}/config`, { memory_scope: String(args.scope).toUpperCase() });
    return { name: args.name, memory_scope: String(args.scope).toUpperCase() };
  },
  async agent_doc_list(args, { call }) {
    return (await call('GET', `/api/agents/${enc(args.name)}/docs`)).files ?? [];
  },
  async agent_doc_get(args, { call, TextResult }) {
    const r = await call('GET', `/api/agents/${enc(args.name)}/docs/${enc(args.file)}?format=json`);
    // A daemon older than this tool ignores ?format=json and sends the text itself.
    return new TextResult(typeof r?.content === 'string' ? r.content : typeof r?.raw === 'string' ? r.raw : JSON.stringify(r));
  },
  async agent_doc_put(args, { call }) {
    // An empty write would wipe the doc: deleting is agent_doc_rm, said explicitly.
    if (!String(args.content ?? '').trim()) throw new Error('empty content (to delete the doc: agent_doc_rm)');
    const r = await call('PUT', `/api/agents/${enc(args.name)}/docs/${enc(args.file)}`, { content: args.content });
    // A daemon older than this tool reads a JSON body as an empty doc and says 200.
    const expected = new TextEncoder().encode(String(args.content)).length;
    if (typeof r?.size === 'number' && r.size !== expected) {
      throw new Error(`the daemon stored ${r.size} bytes instead of ${expected}: it is older than this tool, ask the user to restart Timon`);
    }
    return r;
  },
  async agent_doc_rm(args, { call }) {
    return await call('DELETE', `/api/agents/${enc(args.name)}/docs/${enc(args.file)}`);
  },
  async backends_list(_args, { call }) {
    return await call('GET', '/api/backends/catalog');
  },
  async skill_list(_args, { call }) {
    return (await call('GET', '/api/skills')).skills ?? [];
  },
  async skill_get(args, { call, TextResult }) {
    if (args.file) {
      const f = await call('GET', `/api/skills/${enc(args.id)}/file?path=${enc(args.file)}`);
      return new TextResult(`skill: ${f.id ?? args.id}\nfile: ${f.path ?? args.file}\n\n${f.content ?? ''}`);
    }
    const r = await call('GET', `/api/skills/${enc(args.id)}`);
    // The exact id first: the agent checks it read the skill its catalogue names.
    // Same trailer as `skillGetText` (prompt-injections.ts), which weighs this answer.
    const files = Array.isArray(r.files) ? r.files.map((f) => `\`${f.path}\``) : [];
    const trailer = files.length > 0 ? `\n\n---\nFiles next to this SKILL.md: ${files.join(', ')}. Read one with skill_get (id, file).` : '';
    return new TextResult(`skill: ${r.id ?? args.id}\n\n${r.content ?? ''}${trailer}`);
  },
  async skill_attachment_list(args, { call }) {
    const q = new URLSearchParams();
    for (const key of ['scope', 'target', 'skill']) if (args[key]) q.set(key, String(args[key]));
    const qs = q.toString();
    return (await call('GET', `/api/skill-attachments${qs ? `?${qs}` : ''}`)).attachments ?? [];
  },
  async skill_attach(args, { call }) {
    const body = { skill: args.skill, scope: args.scope };
    if (args.target !== undefined) body.target = args.target;
    if (args.mode !== undefined) body.mode = args.mode;
    if (args.exclude !== undefined) body.exclude = args.exclude;
    return await call('POST', '/api/skill-attachments', body);
  },
  async skill_detach(args, { call }) {
    return await call('DELETE', `/api/skill-attachments/${enc(args.id)}`);
  },
  async skill_resolve(args, { call }) {
    return await call('GET', `/api/agents/${enc(args.agent)}/skills`);
  },
  async skill_reads(args, { call }) {
    return await call('GET', `/api/agents/${enc(args.agent)}/skill-reads`);
  },
  async skill_put(args, { call }) {
    if (!String(args.content ?? '').trim()) throw new Error('empty content');
    const body = { id: args.id, content: args.content };
    if (args.create_only === true) body.create_only = true;
    return await call('POST', '/api/skills', body);
  },
  async skill_rm(args, { call }) {
    return await call('DELETE', `/api/skills/${enc(args.id)}`);
  },
  async mcp_server_list(_args, { call }) {
    return (await call('GET', '/api/mcp')).servers ?? [];
  },
  async mcp_server_get(args, { call }) {
    return await call('GET', `/api/mcp/${enc(args.id)}`);
  },
  async mcp_server_put(args, { call }) {
    if (!args.config || typeof args.config !== 'object' || !args.config.transport) {
      throw new Error('config must include "transport" (stdio or http)');
    }
    return await call('POST', '/api/mcp', { id: args.id, ...args.config });
  },
  async mcp_server_rm(args, { call }) {
    return await call('DELETE', `/api/mcp/${enc(args.id)}`);
  },
};
