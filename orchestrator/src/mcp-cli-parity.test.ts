/**
 * The MCP shim must offer what the CLI offers (docs/AUDIT-CLI-VS-MCP.md): each
 * tool relays to the same daemon route, with the same verb, as its CLI command.
 * A stub daemon records the calls; nothing here launches a real agent.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cli, session, withDaemon, type Seen } from '../tests/helpers/mcp-cli-parity.js';

/** [tool, args, expected "METHOD /path", optional body subset] */
const CASES: Array<[string, Record<string, unknown>, string, Record<string, unknown>?]> = [
  ['agent_update', { name: 'a.b', model: 'm', skills: ['s'] }, 'PATCH /api/agents/a.b/config', { model: 'm', skills: ['s'] }],
  ['agent_set_scope', { name: 'a.b', scope: 'agent' }, 'PATCH /api/agents/a.b/config', { memory_scope: 'AGENT' }],
  ['agent_delete', { name: 'a.b' }, 'DELETE /api/agents/a.b'],
  ['agent_rename', { name: 'a.b', new_name: 'c.d' }, 'POST /api/agents/a.b/rename', { newName: 'c.d' }],
  ['agent_trash_list', {}, 'GET /api/agent-trash'],
  ['agent_trash_restore', { id: '20261028-101500000-a.b' }, 'POST /api/agent-trash/20261028-101500000-a.b/restore'],
  ['agent_doc_list', { name: 'a.b' }, 'GET /api/agents/a.b/docs'],
  ['agent_doc_get', { name: 'a.b', file: 'SOUL.md' }, 'GET /api/agents/a.b/docs/SOUL.md?format=json'],
  ['agent_doc_put', { name: 'a.b', file: 'SOUL.md', content: '# me' }, 'PUT /api/agents/a.b/docs/SOUL.md', { content: '# me' }],
  ['agent_doc_rm', { name: 'a.b', file: 'SOUL.md' }, 'DELETE /api/agents/a.b/docs/SOUL.md'],
  ['agent_extra_dirs', { name: 'a.b' }, 'GET /api/agents/a.b/extra-dirs'],
  ['agent_extra_dirs', { name: 'a.b', action: 'add', path: '/srv/notes' }, 'POST /api/agents/a.b/extra-dirs', { path: '/srv/notes', mode: 'read' }],
  ['agent_extra_dirs', { name: 'a.b', action: 'add', path: '/srv/notes', mode: 'write', restart: true }, 'POST /api/agents/a.b/extra-dirs', { path: '/srv/notes', mode: 'write', restart: true }],
  ['agent_extra_dirs', { name: 'a.b', action: 'remove', path: '/srv/notes' }, 'DELETE /api/agents/a.b/extra-dirs', { path: '/srv/notes' }],
  ['backends_list', {}, 'GET /api/backends/catalog'],
  ['skill_list', {}, 'GET /api/skills'],
  ['skill_get', { id: 'x' }, 'GET /api/skills/x'],
  ['skill_get', { id: 'x', file: 'references/a b.md' }, 'GET /api/skills/x/file?path=references%2Fa%20b.md'],
  ['skill_put', { id: 'x', content: '# s' }, 'POST /api/skills', { id: 'x', content: '# s' }],
  ['skill_put', { id: 'x', content: '# s', create_only: true }, 'POST /api/skills', { id: 'x', content: '# s', create_only: true }],
  ['skill_rm', { id: 'x' }, 'DELETE /api/skills/x'],
  ['skill_attachment_list', { scope: 'role', target: 'coder' }, 'GET /api/skill-attachments?scope=role&target=coder'],
  ['skill_attach', { skill: 'x', scope: 'agent', target: 'a.b', mode: 'import' }, 'POST /api/skill-attachments', { skill: 'x', scope: 'agent', target: 'a.b', mode: 'import' }],
  ['skill_detach', { id: 7 }, 'DELETE /api/skill-attachments/7'],
  ['skill_resolve', { agent: 'a.b' }, 'GET /api/agents/a.b/skills'],
  ['skill_reads', { agent: 'a.b' }, 'GET /api/agents/a.b/skill-reads'],
  ['mcp_server_list', {}, 'GET /api/mcp'],
  ['mcp_server_get', { id: 'x' }, 'GET /api/mcp/x'],
  ['mcp_server_put', { id: 'x', config: { transport: { type: 'stdio', command: 'c' } } }, 'POST /api/mcp', { id: 'x' }],
  ['mcp_server_rm', { id: 'x' }, 'DELETE /api/mcp/x'],
  ['mission_send', { mission_id: 'm', input: 'hi' }, 'POST /api/agents/m/send', { input: 'hi\n' }],
  ['mission_steer', { mission_id: 'm', input: 'go left' }, 'POST /api/missions/m/steer', { input: 'go left' }],
  ['mission_status', { mission_id: 'm' }, 'GET /api/missions/m?view=status'],
  ['mission_status', { mission_id: 'm', view: 'full' }, 'GET /api/missions/m'],
  ['mission_kill', { mission_id: 'm' }, 'DELETE /api/missions/m'],
  ['stop_scope', { project: 'p' }, 'POST /api/stop', { project: 'p' }],
  ['mission_summarize', { mission_id: 'm', force: true }, 'POST /api/missions/m/summarize', { force: true }],
  ['mission_fork', { mission_id: 'm', to: 'b', message: 'go' }, 'POST /api/missions/m/fork', { agent: 'b', message: 'go' }],
  ['mission_permission_mode_get', { mission_id: 'm' }, 'GET /api/missions/m/permission-mode'],
  // Only the mode crosses: the route's body schema is strict.
  ['mission_permission_mode_set', { mission_id: 'm', mode: 'plan' }, 'POST /api/missions/m/permission-mode', { mode: 'plan' }],
  ['mission_egress', { mission_id: 'm' }, 'GET /api/missions/m/egress'],
  ['mission_egress', { mission_id: 'm', limit: 20, before: 41 }, 'GET /api/missions/m/egress?limit=20&before=41'],
  ['mission_reindex', {}, 'POST /api/missions/search/reindex'],
  ['trace_backfill', { days: 2 }, 'POST /api/trace/backfill', { days: 2 }],
  ['kanban_get', { id: 't' }, 'GET /api/tasks/t'],
  ['kanban_attach_series', { id: 't' }, 'POST /api/tasks/t/attach-series', { series: 'current' }],
  ['kanban_attach_series', { id: 't', series_id: 's1' }, 'POST /api/tasks/t/attach-series', { series: 's1' }],
  ['series_fallback_clear', { scope: 'code' }, 'DELETE /api/series/current/fallbacks/code'],
  ['series_role_clear', { scope: 'review', series_id: 's1' }, 'DELETE /api/series/s1/roles/review'],
  // A group rule is cleared by name, as a query (a label, never a path segment).
  ['series_fallback_clear', { scope: 'code', group: 'simple' }, 'DELETE /api/series/current/fallbacks/code?group=simple'],
  ['series_role_clear', { scope: 'review', group: 'hard one', series_id: 's1' }, 'DELETE /api/series/s1/roles/review?group=hard%20one'],
  ['kanban_push_branch', { id: 't', branch: 'SELP-1_a', source_task: 's', set_upstream: true }, 'POST /api/tasks/t/push-branch', { branch: 'SELP-1_a', source_task: 's', set_upstream: true }],
  ['worktree_info', { task_id: 't' }, 'GET /api/tasks/t'],
  ['worktree_create', { task_id: 't', base: 'main' }, 'POST /api/tasks/t/worktree', { base: 'main' }],
  ['worktree_dispose', { task_id: 't', force: true }, 'DELETE /api/tasks/t/worktree?force=1'],
  ['pipeline_list', {}, 'GET /api/pipelines'],
  ['pipeline_get', { id: 'p' }, 'GET /api/pipelines/p'],
  ['pipeline_create', { name: 'n', definition: { steps: [] } }, 'POST /api/pipelines', { name: 'n', definition: { steps: [] } }],
  ['pipeline_run', { id: 'p', input: { a: 1 } }, 'POST /api/pipelines/p/run', { input: { a: 1 } }],
  ['pipeline_run_status', { run_id: 'r' }, 'GET /api/pipelines/runs/r'],
  ['pipeline_delete', { id: 'p' }, 'DELETE /api/pipelines/p'],
  ['routine_list', {}, 'GET /api/routines'],
  ['routine_create', { name: 'n', agent_name: 'a', cron: '0 * * * *', prompt: 'p' }, 'POST /api/routines', { cron_expr: '0 * * * *', enabled: true }],
  ['routine_update', { id: '7', cron: '1 * * * *', enabled: false }, 'PUT /api/routines/7', { cron_expr: '1 * * * *', enabled: false }],
  ['routine_delete', { id: '7' }, 'DELETE /api/routines/7'],
  ['project_list', {}, 'GET /api/projects'],
  ['project_roles', { slug: 'p' }, 'GET /api/projects/p/roles'],
  ['project_set_role', { slug: 'p', role: 'code', agent: 'a', model: 'm' }, 'PATCH /api/projects/p/roles/code', { agent: 'a', model: 'm' }],
  ['project_integration_get', { slug: 'p' }, 'GET /api/projects/p/integration'],
  ['project_integration_get', { slug: 'p', check: true }, 'POST /api/projects/p/integration/check'],
  ['project_integration_set', { slug: 'p', mode: 'pr', account: 'bot', gh_config_dir: null }, 'PUT /api/projects/p/integration', { mode: 'pr', account: 'bot', gh_config_dir: null }],
  ['project_integration_set', { slug: 'p', reset: true }, 'DELETE /api/projects/p/integration'],
  ['memory_rule_rm', { id: 4 }, 'DELETE /api/memory/rules/4'],
  ['memory_search', { query: 'a b' }, 'GET /api/memory/search?q=a%20b'],
  ['memory_overview', {}, 'GET /api/memory/overview'],
  ['memory_show', { scope: 'project', id: 'p' }, 'GET /api/projects/p/memory'],
  ['notify', { type: 'report', title: 'done' }, 'POST /api/notifications', { type: 'report', urgent: 0, title: 'done' }],
  ['agent_reply', { message_id: 'm9', payload: 'ok' }, 'POST /api/messages', { to_agent: 'sender', kind: 'response', in_reply_to: 'm9' }],
  ['browser_status', { slug: 'p' }, 'GET /api/browser/p/status'],
  ['browser_start', { slug: 'p' }, 'POST /api/browser/p/start'],
  ['browser_stop', { slug: 'p' }, 'POST /api/browser/p/stop'],
  ['browser_list', {}, 'GET /api/browser'],
  ['browser_recording_get', { id: 'br-1' }, 'GET /api/native-browser/recordings/br-1'],
  ['browser_annotations_get', {}, 'GET /api/native-browser/annotations'],
  ['browser_annotations_get', { batch: 'bab-1', status: 'resolved' }, 'GET /api/native-browser/annotations?batch=bab-1&status=resolved'],
  ['browser_annotations_get', { id: 'ba-1' }, 'GET /api/native-browser/annotations/ba-1'],
  ['browser_annotations_resolve', { id: 'ba-1', status: 'resolved', summary: 'done' }, 'POST /api/native-browser/annotations/ba-1/resolve', { status: 'resolved', summary: 'done' }],
  ['browser_annotations_resolve', { id: 'ba-1', status: 'dismissed', reason: 'no' }, 'POST /api/native-browser/annotations/ba-1/resolve', { status: 'dismissed', reason: 'no' }],
  ['plugin_list', {}, 'GET /api/plugins'],
  ['plugin_set_enabled', { id: '@timon/x', enabled: false }, 'POST /api/plugins/%40timon%2Fx/enabled', { enabled: false }],
  ['doctor', {}, 'GET /api/doctor'],
  ['health', {}, 'GET /api/health/resources'],
  ['backup_status', {}, 'GET /api/backup/status'],
  ['backup_enable', {}, 'POST /api/backup/enable'],
  ['widgets_get', { view: '/', project: '' }, 'GET /api/widgets?view=%2F&project='],
  ['widgets_preset_save', { name: 'Focus', view: '/', replace: true }, 'POST /api/widgets/presets', { name: 'Focus', view: '/', replace: true }],
  ['islands_get', { view: '/kanban', project: '' }, 'GET /api/islands?view=%2Fkanban&project='],
  ['islands_preset_save', { name: 'Split', view: '/kanban' }, 'POST /api/widgets/presets', { name: 'Split', view: '/kanban' }],
  ['islands_arrangements_list', {}, 'GET /api/islands/arrangements'],
  ['islands_arrangements_list', { full: true }, 'GET /api/islands/arrangements?full=1'],
  ['islands_arrangement_save', { name: 'Code', view: '/kanban', replace: true }, 'POST /api/islands/arrangements', { name: 'Code', view: '/kanban', replace: true }],
  ['islands_arrangement_save', { name: 'Split', layout: { root: { tabs: [{ type: 'host:route' }] } } }, 'POST /api/islands/arrangements', { name: 'Split', layout: { root: { tabs: [{ type: 'host:route' }] } } }],
  ['ui_routes', {}, 'GET /api/navigate/routes'],
];

test('setup: the main agent\'s tools and `timon setup` take the same routes, and only inside a mission', async () => {
  await withDaemon(async (base, seen) => {
    const [outside] = await session(base, [{ method: 'tools/call', params: { name: 'setup_finish', arguments: {} } }]);
    assert.equal(outside!.result?.isError, true);
    seen.length = 0;
    await session(base, [
      { method: 'tools/call', params: { name: 'setup_set_soul', arguments: { soul: 'Direct.', objective: 'Keep me organised.' } } },
      { method: 'tools/call', params: { name: 'setup_request_avatar', arguments: {} } },
      { method: 'tools/call', params: { name: 'setup_recruit_team', arguments: { coder: 'Ada', reviewer: 'Linus' } } },
      { method: 'tools/call', params: { name: 'setup_create_tim', arguments: { name: 'Iris', role: 'research', job: 'Sorts my emails.' } } },
      { method: 'tools/call', params: { name: 'setup_finish', arguments: { tour: false } } },
    ], true);
    assert.deepEqual(seen.find((x) => x.url === '/api/setup/agent/soul')?.body, { soul: 'Direct.', objective: 'Keep me organised.' });
    assert.deepEqual(seen.find((x) => x.url === '/api/setup/agent/team')?.body, { coder: 'Ada', reviewer: 'Linus' });
    assert.deepEqual(seen.find((x) => x.url === '/api/setup/agent/tim')?.body, { name: 'Iris', role: 'research', job: 'Sorts my emails.' });
    assert.deepEqual(seen.find((x) => x.url === '/api/setup/agent/finish')?.body, { tour: false });
    assert.ok(seen.some((x) => x.method === 'POST' && x.url === '/api/setup/agent/avatar-request'));
    assert.ok(seen.some((x) => x.method === 'POST' && x.url === '/api/setup/agent/finish'));
    seen.length = 0;
    assert.equal((await cli(base, ['setup', 'avatar'])).code, 0);
    assert.equal((await cli(base, ['setup', 'team', '--coder', 'Ada', '--reviewer', 'Linus'])).code, 0);
    assert.equal((await cli(base, ['setup', 'tim', '--name', 'Iris', '--role', 'research', '--job', 'Sorts my emails.'])).code, 0);
    assert.equal((await cli(base, ['setup', 'finish', '--no-tour'])).code, 0);
    assert.ok(seen.some((x) => x.url === '/api/setup/agent/avatar-request'));
    assert.deepEqual(seen.find((x) => x.url === '/api/setup/agent/tim')?.body, { name: 'Iris', role: 'research', job: 'Sorts my emails.' });
    assert.deepEqual(seen.find((x) => x.url === '/api/setup/agent/team')?.body, { coder: 'Ada', reviewer: 'Linus' });
    assert.deepEqual(seen.find((x) => x.url === '/api/setup/agent/finish')?.body, { tour: false });
    assert.equal((await cli(base, ['setup', 'team', '--coder', 'Ada'])).code, 64);
    assert.equal((await cli(base, ['setup', 'tim', '--name', 'Iris'])).code, 64);
    assert.equal((await cli(base, ['setup', 'nope'])).code, 64);
  });
});

test('notify: an action_required lifecycle reaches the route the same way from the MCP and the CLI', async () => {
  await withDaemon(async (base, seen) => {
    const want = { type: 'action_required', title: 'Renew', dismiss_on: ['reply', 'task_done'], ttl_minutes: 30 };
    await session(base, [{ method: 'tools/call', params: { name: 'notify', arguments: { type: 'action_required', title: 'Renew', dismiss_on: ['reply', 'task_done'], ttl_minutes: 30 } } }]);
    const fromMcp = seen.find((x) => x.url === '/api/notifications')?.body;
    assert.deepEqual({ type: fromMcp?.type, title: fromMcp?.title, dismiss_on: fromMcp?.dismiss_on, ttl_minutes: fromMcp?.ttl_minutes }, want);
    seen.length = 0;
    const run = await cli(base, ['notify', 'action_required', 'Renew', '--dismiss-on', 'reply,task_done', '--ttl', '30']);
    assert.equal(run.code, 0, run.out);
    const fromCli = seen.find((x) => x.url === '/api/notifications')?.body;
    assert.deepEqual({ type: fromCli?.type, title: fromCli?.title, dismiss_on: fromCli?.dismiss_on, ttl_minutes: fromCli?.ttl_minutes }, want);
    assert.equal((await cli(base, ['notify', 'action_required', 'Renew', '--ttl', 'soon'])).code, 64);
  });
});

test('navigate: ui_navigate and `timon navigate go` take the same route; a proposal needs a mission', async () => {
  await withDaemon(async (base, seen) => {
    const [outside] = await session(base, [{ method: 'tools/call', params: { name: 'ui_navigate', arguments: { path: '/agents' } } }]);
    assert.equal(outside!.result?.isError, true);
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'ui_navigate', arguments: { path: '/settings', params: { section: 'agents' }, note: 'why' } } }], true);
    assert.deepEqual(seen.find((x) => x.url === '/api/navigate/proposals')?.body, { path: '/settings', params: { section: 'agents' }, note: 'why' });
    seen.length = 0;
    const run = await cli(base, ['navigate', 'go', '/settings', '--param', 'section=agents', '--note', 'why']);
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(seen.find((x) => x.url === '/api/navigate/proposals')?.body, { path: '/settings', params: { section: 'agents' }, note: 'why' });
    assert.equal((await cli(base, ['navigate', 'go'])).code, 64);
    assert.equal((await cli(base, ['navigate', 'routes'])).code, 0);
  });
});

test('ui_render, ui_document_get and `timon ui-doc` take the same routes; a document needs a mission', async () => {
  await withDaemon(async (base, seen) => {
    const [outside] = await session(base, [{ method: 'tools/call', params: { name: 'ui_render', arguments: { title: 't', html: '<p>x</p>' } } }]);
    assert.equal(outside!.result?.isError, true);
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'ui_render', arguments: { title: 'Pick', html: '<p>x</p>', height: 200 } } }], true);
    assert.deepEqual(seen.find((x) => x.url === '/api/ui-documents')?.body, { title: 'Pick', html: '<p>x</p>', height: 200 });
    seen.length = 0;
    const file = join(mkdtempSync(join(tmpdir(), 'timon-ui-doc-')), 'page.html');
    writeFileSync(file, '<p>x</p>');
    const run = await cli(base, ['ui-doc', 'render', file, '--title', 'From a file']);
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(seen.find((x) => x.url === '/api/ui-documents')?.body, { title: 'From a file', path: file });
    assert.equal((await cli(base, ['ui-doc', 'render'])).code, 64);
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'ui_render', arguments: { title: 'Ask', html: '<p>x</p>', reply: true } } }], true);
    assert.deepEqual(seen.find((x) => x.url === '/api/ui-documents')?.body, { title: 'Ask', html: '<p>x</p>', reply: true });
    seen.length = 0;
    assert.equal((await cli(base, ['ui-doc', 'render', file, '--title', 'Ask', '--reply'])).code, 0);
    assert.deepEqual(seen.find((x) => x.url === '/api/ui-documents')?.body, { title: 'Ask', path: file, reply: true });
    const id = '0b6f1c2e-6a1b-4c1e-9b3a-2f4d5e6a7b8c';
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'ui_document_get', arguments: { id } } }], true);
    assert.equal(seen.find((x) => x.url === `/api/ui-documents/${id}`)?.method, 'GET');
    seen.length = 0;
    assert.equal((await cli(base, ['ui-doc', 'get', id])).code, 0);
    assert.equal(seen.find((x) => x.url === `/api/ui-documents/${id}`)?.method, 'GET');
    assert.equal((await cli(base, ['ui-doc', 'get'])).code, 64);
  });
});

test('nav, onboarding profile, demo project: the MCP tools and the CLI take the same routes', async () => {
  await withDaemon(async (base, seen) => {
    const [outside] = await session(base, [{ method: 'tools/call', params: { name: 'nav_propose', arguments: { hidden: ['/kanban'] } } }]);
    assert.equal(outside!.result?.isError, true);
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'nav_propose', arguments: { hidden: ['/kanban'], note: 'why' } } }], true);
    assert.deepEqual(seen.find((x) => x.url === '/api/nav/proposals')?.body, { hidden: ['/kanban'], note: 'why' });
    seen.length = 0;
    assert.equal((await cli(base, ['nav', 'propose', '--hide', '/kanban', '--note', 'why'])).code, 0);
    assert.deepEqual(seen.find((x) => x.url === '/api/nav/proposals')?.body, { hidden: ['/kanban'], note: 'why' });
    seen.length = 0;
    const layout = { order: ['/', '---', '/kanban'], footer: ['/plugins'] };
    await session(base, [{ method: 'tools/call', params: { name: 'nav_propose', arguments: layout } }], true);
    assert.deepEqual(seen.find((x) => x.url === '/api/nav/proposals')?.body, layout);
    seen.length = 0;
    assert.equal((await cli(base, ['nav', 'propose', '--order', '/,---,/kanban', '--footer', '/plugins'])).code, 0);
    assert.deepEqual(seen.find((x) => x.url === '/api/nav/proposals')?.body, layout, 'no --hide: the hidden pages stay as they are');
    seen.length = 0;
    assert.equal((await cli(base, ['nav', 'propose'])).code, 0);
    assert.deepEqual(seen.find((x) => x.url === '/api/nav/proposals')?.body, { hidden: [] }, 'no flag at all still shows every page');
    assert.equal((await cli(base, ['nav', 'get'])).code, 0);
    assert.ok(seen.some((x) => x.method === 'GET' && x.url === '/api/nav'));
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'onboarding_profile_set', arguments: { profile: 'developer' } } }], true);
    assert.deepEqual(seen.find((x) => x.url === '/api/onboarding/profile')?.body, { profile: 'developer' });
    seen.length = 0;
    assert.equal((await cli(base, ['onboarding', 'profile', 'set', 'beginner'])).code, 0);
    assert.deepEqual(seen.find((x) => x.method === 'PUT' && x.url === '/api/onboarding/profile')?.body, { profile: 'beginner' });
    assert.equal((await cli(base, ['onboarding', 'nope'])).code, 64);
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'project_demo_create', arguments: {} } }], true);
    assert.ok(seen.some((x) => x.method === 'POST' && x.url === '/api/projects/demo'));
    seen.length = 0;
    assert.equal((await cli(base, ['project', 'demo'])).code, 0);
    assert.ok(seen.some((x) => x.method === 'POST' && x.url === '/api/projects/demo'));
  });
});

test('project get/set-integration: the CLI takes the routes of the MCP tools, with the same body', async () => {
  await withDaemon(async (base, seen) => {
    const path = '/api/projects/acme/integration';
    await session(base, [{ method: 'tools/call', params: { name: 'project_integration_set', arguments: { slug: 'acme', mode: 'pr', account: 'bot', gh_config_dir: null, branch_prefix: 'sec/', remote_url: 'git@github.com:acme/app.git' } } }], true);
    const viaMcp = seen.find((x) => x.method === 'PUT' && x.url === path);
    seen.length = 0;
    assert.equal((await cli(base, ['project', 'set-integration', 'acme', '--mode', 'pr', '--account', 'bot', '--gh-config-dir', '', '--branch-prefix', 'sec/', '--remote-url', 'git@github.com:acme/app.git'])).code, 0);
    assert.deepEqual(seen.find((x) => x.method === 'PUT' && x.url === path)?.body, viaMcp?.body);
    assert.deepEqual(viaMcp?.body, { mode: 'pr', account: 'bot', gh_config_dir: null, branch_prefix: 'sec/', remote_url: 'git@github.com:acme/app.git' });
    seen.length = 0;
    assert.equal((await cli(base, ['project', 'set-integration', 'acme', '--reset'])).code, 0);
    assert.ok(seen.some((x) => x.method === 'DELETE' && x.url === path));
    seen.length = 0;
    assert.equal((await cli(base, ['project', 'get-integration', 'acme', '--check'])).code, 0);
    assert.ok(seen.some((x) => x.method === 'GET' && x.url === path));
    assert.ok(seen.some((x) => x.method === 'POST' && x.url === `${path}/check`));
    seen.length = 0;
    // No field, a field with --reset, or no slug: a usage error, never a request.
    assert.equal((await cli(base, ['project', 'set-integration', 'acme'])).code, 64);
    assert.equal((await cli(base, ['project', 'set-integration', 'acme', '--reset', '--mode', 'pr'])).code, 64);
    assert.equal((await cli(base, ['project', 'get-integration'])).code, 64);
    assert.equal(seen.length, 0);
  });
});

test('pr open: the CLI takes the routes of the MCP tool, with the same body, a file body included', async () => {
  await withDaemon(async (base, seen) => {
    const body = 'Adds x.\n\nWhy: y needed it.\n';
    await session(base, [{ method: 'tools/call', params: { name: 'pr_open', arguments: { id: 't1', title: 'Add x', body } } }], true);
    const viaMcp = seen.filter((x) => x.method === 'POST' && x.url.endsWith('/pull-request'));
    assert.ok(viaMcp.length >= 1);
    assert.equal(viaMcp[0]?.url, '/api/tasks/t1/pull-request');
    assert.deepEqual(viaMcp[0]?.body, { title: 'Add x', body });
    seen.length = 0;
    const file = join(mkdtempSync(join(tmpdir(), 'timon-pr-body-')), 'body.md');
    writeFileSync(file, body);
    await cli(base, ['pr', 'open', 't1', '--title', 'Add x', '--body-file', file]);
    const viaCli = seen.filter((x) => x.method === 'POST' && x.url.endsWith('/pull-request'));
    assert.deepEqual(viaCli.map((x) => x.url), viaMcp.map((x) => x.url));
    assert.deepEqual(viaCli[0]?.body, viaMcp[0]?.body);
    seen.length = 0;
    // No title, two bodies, or no id: a usage error, never a request.
    assert.equal((await cli(base, ['pr', 'open', 't1'])).code, 64);
    assert.equal((await cli(base, ['pr', 'open', 't1', '--title', 'x', '--body', 'a', '--body-file', file])).code, 64);
    assert.equal((await cli(base, ['pr', 'open', '--title', 'x'])).code, 64);
    assert.equal(seen.length, 0);
  });
});

test('pr open: the series is asked only when no task has the id, never after another refusal', async () => {
  const urls = (seen: Seen[]) => seen.filter((x) => x.url.endsWith('/pull-request')).map((x) => x.url);
  const notFound = { status: 404, body: { error: 'no task has this id', code: 'pr_target_not_found' } };
  await withDaemon(async (base, seen) => {
    await session(base, [{ method: 'tools/call', params: { name: 'pr_open', arguments: { id: 's1', title: 'x' } } }], true);
    assert.deepEqual(urls(seen), ['/api/tasks/s1/pull-request', '/api/series/s1/pull-request']);
    seen.length = 0;
    assert.equal((await cli(base, ['pr', 'open', 's1', '--title', 'x'])).code, 2);
    assert.deepEqual(urls(seen), ['/api/tasks/s1/pull-request', '/api/series/s1/pull-request']);
  }, notFound);
  const refused = { status: 409, body: { error: 'account: gh signs in as someone', code: 'pr_precheck_failed' } };
  await withDaemon(async (base, seen) => {
    await session(base, [{ method: 'tools/call', params: { name: 'pr_open', arguments: { id: 't1', title: 'x' } } }], true);
    assert.deepEqual(urls(seen), ['/api/tasks/t1/pull-request']);
    seen.length = 0;
    const out = await cli(base, ['pr', 'open', 't1', '--title', 'x']);
    assert.equal(out.code, 2);
    assert.deepEqual(urls(seen), ['/api/tasks/t1/pull-request']);
  }, refused);
});

test('pr land: the CLI takes the route of the MCP tool, with the same body', async () => {
  await withDaemon(async (base, seen) => {
    const posted = () => seen.filter((x) => x.method === 'POST' && x.url.endsWith('/land')).map((x) => [x.url, x.body]);
    await session(base, [{ method: 'tools/call', params: { name: 'pr_land', arguments: { id: 'j1' } } }], true);
    const bare = posted();
    assert.deepEqual(bare, [['/api/kanban/landings/j1/land', {}]]);
    seen.length = 0;
    assert.equal((await cli(base, ['pr', 'land', 'j1'])).code, 0);
    assert.deepEqual(posted(), bare);
    seen.length = 0;
    const body = 'Adds x.\n';
    await session(base, [{ method: 'tools/call', params: { name: 'pr_land', arguments: { id: 'j1', title: 'Add x', body } } }], true);
    const titled = posted();
    assert.deepEqual(titled, [['/api/kanban/landings/j1/land', { title: 'Add x', body }]]);
    seen.length = 0;
    const file = join(mkdtempSync(join(tmpdir(), 'timon-pr-land-')), 'body.md');
    writeFileSync(file, body);
    assert.equal((await cli(base, ['pr', 'land', 'j1', '--title', 'Add x', '--body-file', file])).code, 0);
    assert.deepEqual(posted(), titled);
    seen.length = 0;
    // No id, two ids, or two bodies: a usage error, never a request.
    assert.equal((await cli(base, ['pr', 'land'])).code, 64);
    assert.equal((await cli(base, ['pr', 'land', 'a', 'b'])).code, 64);
    assert.equal((await cli(base, ['pr', 'land', 'j1', '--body', 'a', '--body-file', file])).code, 64);
    assert.equal(seen.length, 0);
  });
});

test('pr branch: the CLI takes the route of the MCP tool, THIS series by default', async () => {
  await withDaemon(async (base, seen) => {
    const posted = () => seen.filter((x) => x.method === 'POST' && x.url.endsWith('/integration-branch'));
    await session(base, [{ method: 'tools/call', params: { name: 'pr_branch', arguments: { branch: 'feat/x' } } }], true);
    const viaMcp = posted();
    assert.deepEqual(viaMcp.map((x) => [x.url, x.body]), [['/api/series/current/integration-branch', { branch: 'feat/x' }]]);
    seen.length = 0;
    await cli(base, ['pr', 'branch', 'feat/x']);
    assert.deepEqual(posted().map((x) => [x.url, x.body]), viaMcp.map((x) => [x.url, x.body]));
    seen.length = 0;
    await cli(base, ['pr', 'branch', 'feat/x', '--series', 's1']);
    assert.deepEqual(posted().map((x) => x.url), ['/api/series/s1/integration-branch']);
    seen.length = 0;
    // No branch, or two: a usage error, never a request.
    assert.equal((await cli(base, ['pr', 'branch'])).code, 64);
    assert.equal((await cli(base, ['pr', 'branch', 'a', 'b'])).code, 64);
    assert.equal(seen.length, 0);
    // `job branch`, the neutral name for a project that merges locally: the same request.
    await cli(base, ['job', 'branch', 'feat/x', '--series', 's1']);
    assert.deepEqual(posted().map((x) => [x.url, x.body]), [['/api/series/s1/integration-branch', { branch: 'feat/x' }]]);
    seen.length = 0;
    const usage = await cli(base, ['job', 'branch']);
    assert.equal(usage.code, 64);
    assert.match(usage.out, /usage: timon job branch/);
    assert.equal(seen.length, 0);
  });
});

test('project create/update and workspace list: the MCP tools and the CLI take the same routes, with the same body', async () => {
  await withDaemon(async (base, seen) => {
    const flags = ['--name', 'Acme', '--cwd', '/srv/acme', '--workspace', 'Design Studio', '--speech', 'pitch'];
    const fields = { name: 'Acme', cwd: '/srv/acme', workspace: 'Design Studio', speech: 'pitch' };
    await session(base, [{ method: 'tools/call', params: { name: 'project_create', arguments: { slug: 'acme', ...fields } } }], true);
    const viaMcp = seen.find((x) => x.method === 'POST' && x.url === '/api/projects');
    seen.length = 0;
    assert.equal((await cli(base, ['project', 'create', 'acme', ...flags])).code, 0);
    assert.deepEqual(seen.find((x) => x.method === 'POST' && x.url === '/api/projects')?.body, viaMcp?.body);
    assert.deepEqual(viaMcp?.body, { slug: 'acme', workspace_policy: 'existing', ...fields });
    seen.length = 0;
    assert.equal((await cli(base, ['project', 'create', 'acme', '--workspace', 'New', '--create-workspace'])).code, 0);
    assert.deepEqual(seen.find((x) => x.url === '/api/projects')?.body, { slug: 'acme', workspace_policy: 'create', workspace: 'New' });

    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'project_update', arguments: { slug: 'acme', ...fields } } }], true);
    const updateViaMcp = seen.find((x) => x.method === 'PUT' && x.url === '/api/projects/acme/meta');
    seen.length = 0;
    assert.equal((await cli(base, ['project', 'update', 'acme', ...flags])).code, 0);
    assert.deepEqual(seen.find((x) => x.method === 'PUT' && x.url === '/api/projects/acme/meta')?.body, updateViaMcp?.body);
    seen.length = 0;
    assert.equal((await cli(base, ['project', 'update', 'acme', '--speech', ''])).code, 0);
    assert.deepEqual(seen.find((x) => x.url === '/api/projects/acme/meta')?.body, { workspace_policy: 'existing', speech: '' }, 'an empty value clears');
    assert.equal((await cli(base, ['project', 'create'])).code, 64);
    assert.equal((await cli(base, ['project', 'update'])).code, 64);

    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'workspace_list', arguments: {} } }], true);
    assert.ok(seen.some((x) => x.method === 'GET' && x.url === '/api/workspaces'));
    seen.length = 0;
    assert.equal((await cli(base, ['workspace', 'list'])).code, 0);
    assert.ok(seen.some((x) => x.method === 'GET' && x.url === '/api/workspaces'));
    assert.equal((await cli(base, ['workspace', 'nope'])).code, 64);
  });
});

test('islands: the MCP tools and `timon islands` take the same routes; a proposal needs a mission', async () => {
  await withDaemon(async (base, seen) => {
    const proposal = { open: { content: { type: '@timon/terminal-web:session', params: { sessionId: 's1' } }, edge: 'right' } };
    const [outside] = await session(base, [{ method: 'tools/call', params: { name: 'islands_propose', arguments: proposal } }]);
    assert.equal(outside!.result?.isError, true, 'outside a mission there is no conversation to show the card in');
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'islands_propose', arguments: { ...proposal, note: 'why' } } }], true);
    assert.deepEqual(seen.find((s) => s.url === '/api/islands/proposals')?.body, { ...proposal, note: 'why' });
    seen.length = 0;
    const run = await cli(base, ['islands', 'propose', '--view', '/kanban', '--note', 'why'], {}, JSON.stringify(proposal));
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(seen.find((s) => s.url === '/api/islands/proposals')?.body, { ...proposal, view: '/kanban', note: 'why' });
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'islands_propose', arguments: { arrangement: 'a-1', view: '/kanban' } } }], true);
    assert.deepEqual(seen.filter((s) => s.url === '/api/islands/proposals').at(-1)?.body, { arrangement: 'a-1', view: '/kanban' });
    const recall = await cli(base, ['islands', 'propose', '--arrangement', 'a-1', '--view', '/kanban']);
    assert.equal(recall.code, 0, recall.out);
    assert.deepEqual(seen.filter((s) => s.url === '/api/islands/proposals').at(-1)?.body, { arrangement: 'a-1', view: '/kanban' });
    assert.equal((await cli(base, ['islands', 'get', '--view', '/'])).code, 0);
    assert.ok(seen.some((s) => s.method === 'GET' && s.url === '/api/islands?view=%2F'));
    seen.length = 0;
    assert.equal((await cli(base, ['islands', 'preset-save', 'Deep', 'work', '--replace'])).code, 0);
    assert.deepEqual(seen.find((s) => s.url === '/api/widgets/presets')?.body, { name: 'Deep work', replace: true });
    assert.equal((await cli(base, ['islands', 'preset-save'])).code, 64);
    seen.length = 0;
    assert.equal((await cli(base, ['islands', 'arrangements', '--full'])).code, 0);
    assert.ok(seen.some((s) => s.method === 'GET' && s.url === '/api/islands/arrangements?full=1'));
    seen.length = 0;
    assert.equal((await cli(base, ['islands', 'arrangement-save', 'Deep', 'work', '--view', '/kanban', '--replace'])).code, 0);
    assert.deepEqual(seen.find((s) => s.url === '/api/islands/arrangements')?.body, { name: 'Deep work', view: '/kanban', replace: true });
    const layoutFile = join(mkdtempSync(join(tmpdir(), 'timon-arr-')), 'layout.json');
    writeFileSync(layoutFile, JSON.stringify({ root: { tabs: [{ type: 'host:route' }] } }));
    seen.length = 0;
    assert.equal((await cli(base, ['islands', 'arrangement-save', 'Split', '--file', layoutFile])).code, 0);
    assert.deepEqual(seen.find((s) => s.url === '/api/islands/arrangements')?.body, { name: 'Split', layout: { root: { tabs: [{ type: 'host:route' }] } } });
    assert.equal((await cli(base, ['islands', 'arrangement-save'])).code, 64);
  });
});

test('skill put: create_only reaches the route the same way from the MCP and the CLI, and only when asked', async () => {
  await withDaemon(async (base, seen) => {
    await session(base, [
      { method: 'tools/call', params: { name: 'skill_put', arguments: { id: 'x', content: '# s', create_only: true } } },
      { method: 'tools/call', params: { name: 'skill_put', arguments: { id: 'y', content: '# s' } } },
    ]);
    const viaMcp = seen.filter((s) => s.url === '/api/skills').map((s) => s.body);
    assert.deepEqual(viaMcp, [{ id: 'x', content: '# s', create_only: true }, { id: 'y', content: '# s' }]);
    seen.length = 0;
    assert.equal((await cli(base, ['skill', 'put', 'x', '--create-only'], {}, '# s')).code, 0);
    assert.equal((await cli(base, ['skill', 'put', 'y'], {}, '# s')).code, 0);
    const viaCli = seen.filter((s) => s.url === '/api/skills').map((s) => s.body);
    assert.deepEqual(viaCli, viaMcp);
  });
});

test('widgets: the MCP tools and `timon widgets` take the same routes; a proposal needs a mission', async () => {
  await withDaemon(async (base, seen) => {
    const proposal = { zones: { 'chat.right.widget': ['plugin:@timon/git:Git'] } };
    const [outside] = await session(base, [{ method: 'tools/call', params: { name: 'widgets_propose', arguments: proposal } }]);
    assert.equal(outside!.result?.isError, true, 'outside a mission there is no conversation to show the card in');
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'widgets_propose', arguments: { ...proposal, note: 'why' } } }], true);
    assert.deepEqual(seen.find((s) => s.url === '/api/widgets/proposals')?.body, { ...proposal, note: 'why' });
    seen.length = 0;
    const run = await cli(base, ['widgets', 'propose', '--view', '/chat', '--note', 'why'], {}, JSON.stringify(proposal));
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(seen.find((s) => s.url === '/api/widgets/proposals')?.body, { ...proposal, view: '/chat', note: 'why' });
    seen.length = 0;
    assert.equal((await cli(base, ['widgets', 'get', '--view', '/'])).code, 0);
    assert.ok(seen.some((s) => s.method === 'GET' && s.url === '/api/widgets?view=%2F'));
    seen.length = 0;
    assert.equal((await cli(base, ['widgets', 'preset-save', 'Deep', 'work', '--replace'])).code, 0);
    assert.deepEqual(seen.find((s) => s.url === '/api/widgets/presets')?.body, { name: 'Deep work', replace: true });
    assert.equal((await cli(base, ['widgets', 'preset-save'])).code, 64);
  });
});

test('skill attachments: the MCP tools and `timon skill` take the same routes, with the same body', async () => {
  await withDaemon(async (base, seen) => {
    await session(base, [
      { method: 'tools/call', params: { name: 'skill_attach', arguments: { skill: 'x', scope: 'project', target: 'p', exclude: true } } },
      { method: 'tools/call', params: { name: 'skill_get', arguments: { id: 'x' } } },
    ]);
    const viaMcp = seen.find((s) => s.method === 'POST' && s.url === '/api/skill-attachments')?.body;
    seen.length = 0;
    assert.equal((await cli(base, ['skill', 'attach', 'x', '--scope', 'project', '--target', 'p', '--exclude'])).code, 0);
    assert.deepEqual(seen.find((s) => s.method === 'POST' && s.url === '/api/skill-attachments')?.body, viaMcp);
    assert.deepEqual(viaMcp, { skill: 'x', scope: 'project', target: 'p', exclude: true });
    seen.length = 0;
    assert.equal((await cli(base, ['skill', 'attachments', '--scope', 'role', '--target', 'coder'])).code, 0);
    assert.ok(seen.some((s) => s.method === 'GET' && s.url === '/api/skill-attachments?scope=role&target=coder'));
    assert.equal((await cli(base, ['skill', 'detach', '7'])).code, 0);
    assert.ok(seen.some((s) => s.method === 'DELETE' && s.url === '/api/skill-attachments/7'));
    assert.equal((await cli(base, ['skill', 'resolve', 'a.b'])).code, 0);
    assert.ok(seen.some((s) => s.method === 'GET' && s.url === '/api/agents/a.b/skills'));
    assert.equal((await cli(base, ['skill', 'get', 'x', '--file', 'references/a b.md'])).code, 0);
    assert.ok(seen.some((s) => s.method === 'GET' && s.url === '/api/skills/x/file?path=references%2Fa%20b.md'));
    assert.equal((await cli(base, ['skill', 'reads', 'a.b', '--json'])).code, 0);
    assert.ok(seen.some((s) => s.method === 'GET' && s.url === '/api/agents/a.b/skill-reads'));
    seen.length = 0;
    // Usage errors never reach the daemon.
    assert.equal((await cli(base, ['skill', 'attach', 'x'])).code, 64);
    assert.equal((await cli(base, ['skill', 'detach'])).code, 64);
    assert.equal((await cli(base, ['skill', 'resolve'])).code, 64);
    assert.equal((await cli(base, ['skill', 'reads', '--json'])).code, 64);
    assert.equal(seen.length, 0);
  });
});

test('`timon skill reads` lists the read skills, most read first; --json prints the reply as is', async () => {
  const body = { agent: 'a.b', window_days: 30, missions: 4, skills: { rare: { reads: 1, missions: 1 }, often: { reads: 5, missions: 3 } } };
  await withDaemon(async (base) => {
    const text = (await cli(base, ['skill', 'reads', 'a.b'])).out;
    assert.match(text, /^a\.b: 4 mission\(s\) in 30 days\n/);
    assert.ok(text.indexOf('often  5 read(s), 3 mission(s)') < text.indexOf('rare  1 read(s), 1 mission(s)'));
    assert.deepEqual(JSON.parse((await cli(base, ['skill', 'reads', 'a.b', '--json'])).out), body);
  }, { status: 200, body });
});

test('every parity tool relays to the CLI\'s daemon route', async () => {
  // One MCP process for every case: a process per case cost ~1 s each under a
  // loaded mission cgroup and pushed the file past the runner's 120 s limit.
  // The shim answers concurrently, so calls and replies are matched by
  // content and id, never by arrival order.
  await withDaemon(async (base, seen) => {
    const replies = await session(base, CASES.map(([tool, args]) => ({ method: 'tools/call', params: { name: tool, arguments: args } })));
    const byId = new Map(replies.map((r) => [r.id, r]));
    const subset = (hit: Seen, body: Record<string, unknown>) => Object.fromEntries(Object.keys(body).map((k) => [k, hit.body[k]]));
    CASES.forEach(([tool, , route, body], i) => {
      const reply = byId.get(i + 1);
      assert.ok(reply && !reply.result?.isError, `${tool}: ${reply?.result?.content?.[0]?.text}`);
      const hits = seen.filter((s) => `${s.method} ${s.url}` === route);
      assert.ok(hits.length > 0, `${tool}: expected ${route}, saw ${seen.map((s) => `${s.method} ${s.url}`).join(', ')}`);
      if (body) {
        const match = hits.find((h) => JSON.stringify(subset(h, body)) === JSON.stringify(body));
        assert.deepEqual(match ? subset(match, body) : subset(hits[0]!, body), body, tool);
      }
    });
  });
});

test('agent_extra_dirs and `timon agent extra-dirs` take the same routes and bodies', async () => {
  await withDaemon(async (base, seen) => {
    const runs: Array<[string[], string, Record<string, unknown>?]> = [
      [['agent', 'extra-dirs', 'list', 'a.b'], 'GET /api/agents/a.b/extra-dirs'],
      [['agent', 'extra-dirs', 'add', 'a.b', '/srv/notes'], 'POST /api/agents/a.b/extra-dirs', { path: '/srv/notes', mode: 'read' }],
      [['agent', 'extra-dirs', 'add', 'a.b', '/srv/notes', '--write', '--restart'], 'POST /api/agents/a.b/extra-dirs', { path: '/srv/notes', mode: 'write', restart: true }],
      [['agent', 'extra-dirs', 'rm', 'a.b', '/srv/notes'], 'DELETE /api/agents/a.b/extra-dirs', { path: '/srv/notes' }],
    ];
    for (const [argv, route, body] of runs) {
      seen.length = 0;
      const run = await cli(base, argv);
      assert.equal(run.code, 0, run.out);
      assert.equal(`${seen[0]?.method} ${seen[0]?.url}`, route, argv.join(' '));
      if (body) assert.deepEqual(seen[0]?.body, body, argv.join(' '));
    }
    seen.length = 0;
    // A gesture without its folder is a usage error, never a request.
    assert.equal((await cli(base, ['agent', 'extra-dirs', 'add', 'a.b'])).code, 64);
    assert.equal((await cli(base, ['agent', 'extra-dirs', 'rm', 'a.b', '/srv/notes', '--write'])).code, 64);
    assert.equal((await cli(base, ['agent', 'extra-dirs', 'grant', 'a.b'])).code, 64);
    const [missing] = await session(base, [{ method: 'tools/call', params: { name: 'agent_extra_dirs', arguments: { name: 'a.b', action: 'remove' } } }]);
    assert.equal(missing!.result?.isError, true);
    assert.deepEqual(seen, []);
  });
});

test('timon steer takes the route of mission_steer, and --json stays out of the instruction', async () => {
  await withDaemon(async (base, seen) => {
    const run = await cli(base, ['steer', 'm 1', 'go', 'left', '--json']);
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(JSON.parse(run.out), { ok: true, method: 'restart' });
    const post = seen.find((x) => x.method === 'POST' && x.url === '/api/missions/m%201/steer');
    assert.deepEqual(post?.body, { input: 'go left' });
    const plain = await cli(base, ['steer', 'm1', 'go left']);
    assert.match(plain.out, /^steered m1: the turn was stopped/);
    seen.length = 0;
    // No instruction is a usage error, never a request: a blank steer would cost a turn.
    assert.equal((await cli(base, ['steer', 'm1'])).code, 64);
    assert.equal((await cli(base, ['steer', 'm1', '--json'])).code, 64);
    assert.equal(seen.length, 0);
  }, { status: 200, body: { ok: true, method: 'restart' } });
});

test('a refused steer reaches the caller with its code, from the CLI and from the MCP', async () => {
  await withDaemon(async (base) => {
    const run = await cli(base, ['steer', 'm1', 'go left']);
    assert.equal(run.code, 2);
    assert.match(run.out, /no_turn_to_steer/);
    const [reply] = await session(base, [{ method: 'tools/call', params: { name: 'mission_steer', arguments: { mission_id: 'm1', input: 'go left' } } }]);
    assert.equal(reply!.result?.isError, true);
    assert.match(reply!.result?.content?.[0]?.text ?? '', /409.*\[no_turn_to_steer\]/);
  }, { status: 409, body: { error: 'no turn is running: send a normal message instead', code: 'no_turn_to_steer' } });
});

test('timon mission permission-mode get|set take the routes of mission_permission_mode_*', async () => {
  await withDaemon(async (base, seen) => {
    assert.equal((await cli(base, ['mission', 'permission-mode', 'get', 'm 1'])).code, 0);
    assert.ok(seen.some((x) => x.method === 'GET' && x.url === '/api/missions/m%201/permission-mode'));
    seen.length = 0;
    assert.equal((await cli(base, ['mission', 'permission-mode', 'set', 'm1', 'acceptEdits'])).code, 0);
    const post = seen.find((x) => x.method === 'POST' && x.url === '/api/missions/m1/permission-mode');
    assert.deepEqual(post?.body, { mode: 'acceptEdits' });
    seen.length = 0;
    // A set without its mode is a usage error, never a request with an empty body.
    assert.equal((await cli(base, ['mission', 'permission-mode', 'set', 'm1'])).code, 64);
    assert.equal(seen.length, 0);
  });
});

test('routine extras: the MCP tools and `timon routine` send the same lists, and an empty value clears', async () => {
  await withDaemon(async (base, seen) => {
    const extras = { extra_mcp_servers: ['mail', 'docs'], extra_skills: ['inbox-rules'], extra_allowed_tools: ['Read'] };
    const flags = ['--extra-mcp', 'mail,docs', '--extra-skills', 'inbox-rules', '--allow', 'Read'];
    const create = { name: 'n', agent_name: 'a', cron: '0 * * * *', prompt: 'p' };
    await session(base, [{ method: 'tools/call', params: { name: 'routine_create', arguments: { ...create, ...extras } } }], true);
    const viaMcp = seen.find((x) => x.method === 'POST' && x.url === '/api/routines');
    assert.deepEqual(viaMcp?.body, { name: 'n', agent_name: 'a', prompt: 'p', cron_expr: '0 * * * *', enabled: true, ...extras });
    seen.length = 0;
    assert.equal((await cli(base, ['routine', 'create', '--name', 'n', '--agent', 'a', '--cron', '0 * * * *', '--prompt', 'p', ...flags])).code, 0);
    assert.deepEqual(seen.find((x) => x.method === 'POST' && x.url === '/api/routines')?.body, viaMcp?.body);

    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'routine_update', arguments: { id: '7', ...extras } } }], true);
    const updateViaMcp = seen.find((x) => x.method === 'PUT' && x.url === '/api/routines/7');
    assert.deepEqual(updateViaMcp?.body, extras);
    seen.length = 0;
    assert.equal((await cli(base, ['routine', 'update', '7', ...flags])).code, 0);
    assert.deepEqual(seen.find((x) => x.method === 'PUT' && x.url === '/api/routines/7')?.body, updateViaMcp?.body);
    seen.length = 0;
    assert.equal((await cli(base, ['routine', 'update', '7', '--extra-mcp', ''])).code, 0);
    assert.deepEqual(seen.find((x) => x.url === '/api/routines/7')?.body, { extra_mcp_servers: [] }, 'an empty value clears');
  });
});
