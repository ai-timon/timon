/**
 * MCP tools mirroring the CLI commands around the Kanban: `task get`,
 * a partial edit of a task description,
 * `series … clear`, `worktree`, `pipeline`, `routine`.
 */

const enc = encodeURIComponent;
const series_id = { type: 'string', description: 'Series id; defaults to THIS mission\'s series.' };
const group = { type: 'string', minLength: 1, maxLength: 60, description: 'Group of volets of the series plan; omitted = the series-wide rule.' };
const TASK_TYPES = ['code', 'review', 'merge', 'research', 'doc', 'chore'];
const id = (what) => ({ type: 'string', description: `${what} id.` });

export const tools = [
  {
    name: 'kanban_get',
    title: 'Read a Kanban task',
    description: 'Reads one task with all its fields, its attached files included (id, name, size, type; CLI `timon task get`).',
    inputSchema: { type: 'object', properties: { id: id('Task') }, required: ['id'] },
  },
  {
    name: 'kanban_edit_description',
    title: 'Edit part of a task description',
    description:
      'Replaces one exact passage of a task\'s description, without resending the rest of it: old_text must '
      + 'appear exactly once (add surrounding text until it does). Use it to tick a checkbox or to insert a '
      + 'section after a known line; kanban_update replaces the whole description.',
    inputSchema: {
      type: 'object',
      properties: {
        id: id('Task'),
        old_text: { type: 'string', minLength: 1, description: 'Exact text to replace; must occur once.' },
        new_text: { type: 'string', description: 'Replacement; empty deletes old_text.' },
      },
      required: ['id', 'old_text', 'new_text'],
    },
  },
  {
    name: 'series_fallback_clear',
    title: 'Clear a series fallback',
    description: 'Removes the fallback rule of one scope for a series (CLI `timon series fallback clear`).',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', description: 'orchestrator, code, review, merge, doc, chore or *.' }, group, series_id },
      required: ['scope'],
    },
  },
  {
    name: 'series_role_clear',
    title: 'Clear a series role choice',
    description: 'Removes the role choice of one scope for a series, so project roles apply again (CLI `timon series role clear`).',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', description: 'code, review, merge, research, doc or chore.' }, group, series_id },
      required: ['scope'],
    },
  },
  {
    name: 'worktree_info',
    title: 'Read a task worktree',
    description: 'Shows the worktree, branch, base branch and merged sha of a code task (CLI `timon worktree info`).',
    inputSchema: { type: 'object', properties: { task_id: id('Task') }, required: ['task_id'] },
  },
  {
    name: 'worktree_create',
    title: 'Create a task worktree',
    description: 'Force-creates the git worktree of a task (the dispatcher already does it for `code` tasks). CLI `timon worktree create`.',
    inputSchema: {
      type: 'object',
      properties: { task_id: id('Task'), base: { type: 'string', description: 'Base branch of the worktree.' } },
      required: ['task_id'],
    },
  },
  {
    name: 'worktree_dispose',
    title: 'Dispose of a task worktree',
    description:
      'Unmounts a task\'s worktree and deletes its local branch (CLI `timon worktree dispose`). ' +
      'Only after the task is DONE and merged: disposing a live task destroys the coder\'s uncommitted work.',
    inputSchema: {
      type: 'object',
      properties: { task_id: id('Task'), force: { type: 'boolean' } },
      required: ['task_id'],
    },
  },
  { name: 'pipeline_list', title: 'List pipelines', description: 'Lists the multi-agent pipeline templates (CLI `timon pipeline list`).', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'pipeline_get',
    title: 'Read a pipeline',
    description: 'Reads one pipeline template (CLI `timon pipeline get`).',
    inputSchema: { type: 'object', properties: { id: id('Pipeline') }, required: ['id'] },
  },
  {
    name: 'pipeline_create',
    title: 'Create a pipeline',
    description: 'Creates a pipeline template (CLI `timon pipeline create`). `definition` is `{ steps: [...] }`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        definition: { type: 'object', description: 'The pipeline definition: { steps: [...] }.' },
      },
      required: ['name', 'definition'],
    },
  },
  {
    name: 'pipeline_run',
    title: 'Run a pipeline',
    description: 'Runs a pipeline; it produces Kanban tasks (CLI `timon pipeline run`). Follow it with pipeline_run_status.',
    inputSchema: {
      type: 'object',
      properties: { id: id('Pipeline'), input: { type: 'object', description: 'Input of the run.' } },
      required: ['id'],
    },
  },
  {
    name: 'pipeline_run_status',
    title: 'Read a pipeline run',
    description: 'State of a pipeline run (CLI `timon pipeline run-status`).',
    inputSchema: { type: 'object', properties: { run_id: id('Run') }, required: ['run_id'] },
  },
  {
    name: 'pipeline_delete',
    title: 'Delete a pipeline',
    description: 'Deletes a pipeline template (CLI `timon pipeline delete`).',
    inputSchema: { type: 'object', properties: { id: id('Pipeline') }, required: ['id'] },
  },
  { name: 'routine_list', title: 'List routines', description: 'Lists the routines: a cron expression that creates a Kanban task on each tick (CLI `timon routine list`).', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'routine_create',
    title: 'Create a routine',
    description: 'Creates a routine (CLI `timon routine create`): each due tick creates a Kanban task for `agent_name`. ' +
      'Created by you, it is SAVED SWITCHED OFF: it runs only once the user switches it on in the Triggers page — tell them. ' +
      'You cannot switch a routine on, and changing what an enabled one does switches it off.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        agent_name: { type: 'string' },
        cron: { type: 'string', description: 'Cron expression.' },
        prompt: { type: 'string', description: 'Brief of the task created at each tick.' },
        task_type: { type: 'string', enum: TASK_TYPES },
        project: { type: 'string', description: 'Project slug.' },
        enabled: { type: 'boolean', description: 'Default true; ignored from an agent (always switched off).' },
      },
      required: ['name', 'agent_name', 'cron', 'prompt'],
    },
  },
  {
    name: 'routine_update',
    title: 'Edit a routine',
    description: 'Edits a routine (CLI `timon routine update`); pass only what changes. `project: null` detaches it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: id('Routine'),
        name: { type: 'string' },
        agent_name: { type: 'string' },
        cron: { type: 'string' },
        prompt: { type: 'string' },
        task_type: { type: 'string', enum: TASK_TYPES },
        project: { type: ['string', 'null'] },
        enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'routine_delete',
    title: 'Delete a routine',
    description: 'Deletes a routine (CLI `timon routine delete`).',
    inputSchema: { type: 'object', properties: { id: id('Routine') }, required: ['id'] },
  },
];

export const handlers = {
  async kanban_get(args, { call }) {
    return (await call('GET', `/api/tasks/${enc(args.id)}`)).task;
  },
  async kanban_edit_description(args, { call }) {
    if (typeof args.old_text !== 'string' || args.old_text.length === 0) throw new Error('old_text must be a non-empty string');
    if (typeof args.new_text !== 'string') throw new Error('new_text must be a string');
    const task = (await call('GET', `/api/tasks/${enc(args.id)}`)).task;
    if (!task) throw new Error('task not found');
    const description = task.description ?? '';
    const first = description.indexOf(args.old_text);
    if (first === -1) throw new Error('old_text was not found in the description');
    if (description.indexOf(args.old_text, first + args.old_text.length) !== -1) {
      throw new Error('old_text appears more than once: add surrounding text until it is unique');
    }
    // Sliced, not String#replace: `$&` or `$1` in new_text must stay literal.
    const next = description.slice(0, first) + args.new_text + description.slice(first + args.old_text.length);
    return (await call('PUT', `/api/tasks/${enc(args.id)}`, { description: next })).task;
  },
  async series_fallback_clear(args, { call }) {
    const query = args.group ? `?group=${enc(args.group)}` : '';
    return await call('DELETE', `/api/series/${enc(args.series_id ?? 'current')}/fallbacks/${enc(args.scope)}${query}`);
  },
  async series_role_clear(args, { call }) {
    const query = args.group ? `?group=${enc(args.group)}` : '';
    return await call('DELETE', `/api/series/${enc(args.series_id ?? 'current')}/roles/${enc(args.scope)}${query}`);
  },
  async worktree_info(args, { call }) {
    const t = (await call('GET', `/api/tasks/${enc(args.task_id)}`)).task;
    if (!t) throw new Error('task not found');
    return {
      task_id: t.id, worktree_path: t.worktree_path, branch_name: t.branch_name,
      base_branch: t.base_branch, merged_commit_sha: t.merged_commit_sha,
    };
  },
  async worktree_create(args, { call }) {
    const r = await call('POST', `/api/tasks/${enc(args.task_id)}/worktree`, args.base ? { base: args.base } : {});
    return r.worktree;
  },
  async worktree_dispose(args, { call }) {
    const r = await call('DELETE', `/api/tasks/${enc(args.task_id)}/worktree${args.force ? '?force=1' : ''}`);
    return { task_id: args.task_id, disposed: Boolean(r.disposed) };
  },
  async pipeline_list(_args, { call }) {
    return (await call('GET', '/api/pipelines')).pipelines ?? [];
  },
  async pipeline_get(args, { call }) {
    return (await call('GET', `/api/pipelines/${enc(args.id)}`)).pipeline;
  },
  async pipeline_create(args, { call }) {
    const body = { name: args.name, definition: args.definition };
    if (args.description !== undefined) body.description = args.description;
    return (await call('POST', '/api/pipelines', body)).pipeline;
  },
  async pipeline_run(args, { call }) {
    return await call('POST', `/api/pipelines/${enc(args.id)}/run`, { input: args.input ?? {} });
  },
  async pipeline_run_status(args, { call }) {
    return await call('GET', `/api/pipelines/runs/${enc(args.run_id)}`);
  },
  async pipeline_delete(args, { call }) {
    await call('DELETE', `/api/pipelines/${enc(args.id)}`);
    return { id: args.id, deleted: true };
  },
  async routine_list(_args, { call }) {
    return (await call('GET', '/api/routines')).routines ?? [];
  },
  async routine_create(args, { call }) {
    const body = {
      name: args.name, agent_name: args.agent_name, prompt: args.prompt, cron_expr: args.cron,
      enabled: args.enabled !== false,
    };
    if (args.task_type !== undefined) body.task_type = args.task_type;
    if (args.project !== undefined) body.project = args.project;
    const created = await call('POST', '/api/routines', body);
    // The agent must read that its routine waits for the user.
    return created.needs_activation ? { ...created.routine, needs_activation: true, message: created.message } : created.routine;
  },
  async routine_update(args, { call }) {
    const fields = {};
    for (const [from, to] of [['name', 'name'], ['agent_name', 'agent_name'], ['cron', 'cron_expr'], ['prompt', 'prompt'],
      ['task_type', 'task_type'], ['project', 'project'], ['enabled', 'enabled']]) {
      if (args[from] !== undefined) fields[to] = args[from];
    }
    const updated = await call('PUT', `/api/routines/${enc(args.id)}`, fields);
    return updated.needs_activation ? { ...updated.routine, needs_activation: true, message: updated.message } : updated.routine;
  },
  async routine_delete(args, { call }) {
    await call('DELETE', `/api/routines/${enc(args.id)}`);
    return { id: args.id, deleted: true };
  },
};
