/**
 * MCP tools mirroring the CLI commands around the Kanban: `task get`,
 * `task attach`, `series … clear`, `worktree`, `pr open`, `pipeline`, `routine`.
 */

const enc = encodeURIComponent;
const series_id = { type: 'string', description: 'Series id; defaults to THIS mission\'s series.' };
const group = { type: 'string', minLength: 1, maxLength: 60, description: 'Group of volets of the series plan; omitted = the series-wide rule.' };
const TASK_TYPES = ['code', 'review', 'merge', 'research', 'doc', 'chore'];
const id = (what) => ({ type: 'string', description: `${what} id.` });
/**
 * Copied onto every task the routine opens: a task starts with zero MCP server
 * by default, so an agent outside any project role needs them to reach its tools.
 */
const ROUTINE_EXTRAS = {
  extra_mcp_servers: {
    type: ['array', 'null'], items: { type: 'string' },
    description: 'MCP server ids given to every task this routine opens (see mcp_server_list); [] or null clears. From a mission, no stdio server the agent does not already hold.',
  },
  extra_skills: {
    type: ['array', 'null'], items: { type: 'string' },
    description: 'Skill ids injected into every task this routine opens; [] or null clears. From a mission, no skill whose `allowed-tools` the agent does not already hold.',
  },
  extra_allowed_tools: {
    type: ['array', 'null'], items: { type: 'string' },
    description: 'Tool patterns pre-allowed for every task this routine opens; [] or null clears. From a mission, only tools the agent already holds.',
  },
};
const ROUTINE_EXTRA_KEYS = Object.keys(ROUTINE_EXTRAS);

export const tools = [
  {
    name: 'kanban_get',
    title: 'Read a Kanban task',
    description: 'Reads one task with all its fields, its attached files included (id, name, size, type; CLI `timon task get`). ' +
      'A running task whose mission waits on an Allow / Deny card or a question carries `pending_permission` (tool, since, time left).',
    inputSchema: { type: 'object', properties: { id: id('Task') }, required: ['id'] },
  },
  {
    name: 'kanban_attach_series',
    title: 'Attach a task chain to a series',
    description:
      'Attaches a task and its whole chain (the root it comes from, its reviews, merge, doc and repair iterations) ' +
      'to a series and its current pilot (CLI `timon task attach`). For a chain created outside a mission ' +
      '(a `curl`, the board): without a series its returns reach no pilot and its reviews ignore the series roles. ' +
      'A task created with `kanban_add` or `timon task create` from inside a mission already belongs to its series.',
    inputSchema: {
      type: 'object',
      properties: {
        id: id('Task (any task of the chain)'),
        series_id: { type: 'string', description: 'Series id, or the id of the mission piloting it; defaults to THIS mission (`current`).' },
      },
      required: ['id'],
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
      'Only for a DONE task whose worktree is clean and whose HEAD is merged: anything else is refused and kept.',
    inputSchema: {
      type: 'object',
      properties: { task_id: id('Task'), force: { type: 'boolean', description: 'Ignored, kept for older callers: a removal is never forced.' } },
      required: ['task_id'],
    },
  },
  {
    name: 'kanban_push_branch',
    title: 'Push a ticket branch',
    description:
      'For the merger of a merge task: asks the daemon to push the branch `timon/task/<id>` of a task of the project ' +
      'to a ticket branch of the remote (CLI `timon task push-branch`), with no approval card. The daemon pushes only ' +
      '`<PREFIX>-<n>_<description>` (the prefixes of the project when it declares them), never develop, main, master, ' +
      'production or release, never forced, from your own merge task, and audits every push. Anything else is refused: ' +
      'then use the normal `git push` path.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The merge task this mission runs.' },
        branch: { type: 'string', description: 'The ticket branch to push to, like SELP-123_short-description.' },
        source_task: { type: 'string', description: 'The task whose timon/task/<id> branch is pushed; defaults to the merge task itself.' },
        set_upstream: { type: 'boolean', description: 'Also set the upstream of the branch (git push -u).' },
      },
      required: ['id', 'branch'],
    },
  },
  {
    name: 'pr_open',
    title: 'Open a job\'s pull request',
    description:
      'Opens the pull request of a Kanban job whose project lands through pull requests (CLI `timon pr open`). ' +
      'The daemon checks first, and pushes nothing if one check fails: gh signs in as the project\'s account, the remote ' +
      'pushes to the expected URL, every commit has the repository\'s identity, no task id or TODO number in a commit ' +
      'message, the title or the body, no ignored file (docs/) in the diff, the repository\'s public tree check passes, ' +
      'and a branch already pushed only moves forward (never forced). Then it pushes the integration branch and opens ' +
      'the pull request. A sec/ branch (embargo) is always refused. Title and body in English, without attribution. ' +
      'Needs projects:manage.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A task of the job, or its series id.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Description of the pull request (markdown).' },
      },
      required: ['id', 'title'],
    },
  },
  {
    name: 'pr_land',
    title: 'Land a job kept on its branch',
    description:
      'Lands a Kanban job whose plan kept its work on its branch (CLI `timon pr land`). In a project that merges ' +
      'locally, the daemon merges the branch into the local target: a fast-forward, else a merge commit written by git ' +
      'without a working tree; a conflict is refused with its files, never resolved; when the target is checked out, ' +
      'its working directory must be clean. In a project that lands through pull requests, it opens the job\'s pull ' +
      'request with the checks of `pr_open` (a title is then required); when its previous pull request was closed ' +
      'without a merge, it opens a new one. The job\'s ideas close and its doc task is ' +
      'created once the branch is in the target. Refused while a task of the job still waits or runs. A second call ' +
      'answers that the job already landed. Needs projects:manage.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The job\'s id (Jobs widget, `/api/kanban/landings`), or its series id when it has one job.' },
        title: { type: 'string', description: 'Pull request projects: title of the pull request.' },
        body: { type: 'string', description: 'Pull request projects: description (markdown).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'pr_branch',
    title: 'Prepare a sequential job\'s branch',
    description:
      'For a job coded in a mission (`kanban_plan` modes sequential-here / sequential-new-mission) whose project lands ' +
      'through pull requests (CLI `timon pr branch`): the daemon cuts the job\'s integration branch from the remote\'s ' +
      'target (never from the local one, never checked out), records it for the series, and returns a worktree of your ' +
      'own, detached on its tip. Code and commit only there, then move the branch by reference. Run the command ' +
      '`kanban_plan` gave, with its branch name. Needs kanban:write.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'The integration branch the plan named (`feat/<topic>`).' },
        series_id: { type: 'string', description: 'Series id, or the id of the mission piloting it; defaults to THIS mission (`current`).' },
      },
      required: ['branch'],
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
        ...ROUTINE_EXTRAS,
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
        ...ROUTINE_EXTRAS,
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
  async kanban_attach_series(args, { call }) {
    return await call('POST', `/api/tasks/${enc(args.id)}/attach-series`, { series: args.series_id ?? 'current' });
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
  async kanban_push_branch(args, { call }) {
    const payload = { branch: args.branch };
    if (args.source_task !== undefined) payload.source_task = args.source_task;
    if (args.set_upstream !== undefined) payload.set_upstream = args.set_upstream;
    return await call('POST', `/api/tasks/${enc(args.id)}/push-branch`, payload);
  },
  async pr_open(args, { call }) {
    const payload = { title: args.title, body: args.body ?? '' };
    // The id names a task of the job or its series: the series is asked only
    // when the task route says no task has it (never after any other refusal,
    // which would run the checks and the push a second time).
    try {
      return await call('POST', `/api/tasks/${enc(args.id)}/pull-request`, payload);
    } catch (err) {
      if (!/ → 404 .*\[pr_target_not_found\]/.test(String(err?.message))) throw err;
      return await call('POST', `/api/series/${enc(args.id)}/pull-request`, payload);
    }
  },
  async pr_land(args, { call }) {
    const payload = {};
    if (args.title !== undefined) payload.title = args.title;
    if (args.body !== undefined) payload.body = args.body;
    return await call('POST', `/api/kanban/landings/${enc(args.id)}/land`, payload);
  },
  async pr_branch(args, { call }) {
    return await call('POST', `/api/series/${enc(args.series_id ?? 'current')}/integration-branch`, { branch: args.branch });
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
    for (const key of ROUTINE_EXTRA_KEYS) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    const created = await call('POST', '/api/routines', body);
    // The agent must read that its routine waits for the user.
    return created.needs_activation ? { ...created.routine, needs_activation: true, message: created.message } : created.routine;
  },
  async routine_update(args, { call }) {
    const fields = {};
    for (const [from, to] of [['name', 'name'], ['agent_name', 'agent_name'], ['cron', 'cron_expr'], ['prompt', 'prompt'],
      ['task_type', 'task_type'], ['project', 'project'], ['enabled', 'enabled'],
      ...ROUTINE_EXTRA_KEYS.map((key) => [key, key])]) {
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
