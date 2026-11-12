/**
 * `title` on a Timon MCP tool is the protocol's display name (MCP 2025-06-18),
 * shown to people by the clients, never internal metadata
 * (docs/MCP-TOOL-CONVENTIONS.md). This guard holds every tool to the
 * convention: since #612 the whole catalog is titled, so a new tool without a
 * title fails here instead of showing its snake_case name to people.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMcpCatalog } from './remote-mcp/catalog.js';

const TITLE_MAX = 40;
/** Tools given a title, module by module (the pass of #612), kept titled. */
const TITLED = [
  // mcp-tools-navigate.mjs: the convention's pilot
  'ui_routes', 'ui_navigate', 'nav_get', 'nav_propose',
  // mcp-tools-agents.mjs
  'agent_update', 'agent_delete', 'agent_trash_list', 'agent_trash_restore', 'agent_rename',
  'agent_set_scope', 'agent_doc_list', 'agent_doc_get', 'agent_doc_put', 'agent_doc_rm', 'backends_list',
  'skill_list', 'skill_get', 'skill_attachment_list', 'skill_attach', 'skill_detach', 'skill_resolve', 'skill_reads',
  'skill_put', 'skill_rm', 'mcp_server_list', 'mcp_server_get', 'mcp_server_put', 'mcp_server_rm',
  // mcp-tools-missions.mjs
  'mission_send', 'mission_steer', 'mission_status', 'mission_wait', 'mission_kill', 'stop_scope',
  'mission_permission_mode_get', 'mission_permission_mode_set', 'mission_summarize', 'mission_fork', 'mission_egress',
  'mission_reindex', 'trace_backfill',
  // mcp-tools-kanban.mjs
  'kanban_get', 'series_fallback_clear', 'series_role_clear', 'worktree_info', 'worktree_create',
  'worktree_dispose', 'pipeline_list', 'pipeline_get', 'pipeline_create', 'pipeline_run',
  'pipeline_run_status', 'pipeline_delete', 'routine_list', 'routine_create', 'routine_update',
  'routine_delete',
  // mcp-tools-projects.mjs
  'project_list', 'project_roles', 'project_set_role', 'memory_rule_rm', 'memory_search', 'memory_overview',
  'memory_show', 'notify', 'agent_reply',
  // mcp-tools-system.mjs
  'browser_status', 'browser_start', 'browser_stop', 'browser_list', 'browser_recording_get',
  'browser_annotations_get', 'browser_annotations_resolve', 'plugin_list', 'plugin_set_enabled', 'doctor',
  'health', 'backup_status', 'backup_enable',
  // mcp-tools-widgets.mjs
  'widgets_get', 'widgets_propose', 'widgets_preset_save',
  // mcp-tools-islands.mjs
  'islands_get', 'islands_propose', 'islands_preset_save', 'islands_arrangements_list', 'islands_arrangement_save',
  // mcp-tools-onboarding.mjs
  'onboarding_profile_get', 'onboarding_profile_set',
  // mcp-tools-setup.mjs
  'setup_request_avatar', 'setup_set_soul', 'setup_recruit_team', 'setup_finish',
  // mcp-tools-ui-documents.mjs
  'ui_render', 'ui_document_get',
  // timon-mcp-catalog.mjs
  'agent_list', 'kanban_add', 'kanban_update', 'kanban_mark_as_done', 'kanban_mark_as_failed', 'kanban_list',
  'kanban_delete', 'series_fallback_set', 'series_role_set', 'series_role_list', 'series_fallback_list',
  'agent_send_message', 'agent_recv_messages', 'agent_pick_message', 'project_todo_list', 'project_todo_add',
  'project_todo_update', 'project_todo_promote', 'project_todo_delete', 'project_todo_attachments_list',
  'project_todo_attachments_add', 'project_todo_attachments_remove', 'trigger_create', 'trigger_list',
  'trigger_test', 'trigger_remove', 'memory_rule_add', 'memory_rule_list', 'docs_search', 'docs_read',
  'mission_search', 'trace_get', 'workflow_list', 'workflow_status', 'workflow_run', 'workflow_get',
  'workflow_node_types', 'workflow_propose', 'workflow_node_done', 'mission_message_get', 'chat_show_media', 'chat_post_message', 'terminal_propose',
  'mission_spawn', 'agent_create', 'agent_set_avatar', 'project_create', 'project_update',
  'project_demo_create', 'workspace_list', 'timon_http_call', 'secret_create', 'secret_request',
];

test('a tool title follows the convention', async () => {
  const { TOOLS } = await loadMcpCatalog();
  const seen = new Map<string, string>();
  for (const tool of TOOLS) {
    const raw = (tool as { title?: unknown }).title;
    const annotations = (tool as { annotations?: { title?: unknown } }).annotations;
    assert.equal(annotations?.title, undefined, `${tool.name}: the display name lives in \`title\`, not \`annotations.title\``);
    if (raw === undefined) continue;
    assert.equal(typeof raw, 'string', tool.name);
    const title = raw as string;
    assert.ok(title.length > 0 && title.length <= TITLE_MAX, `${tool.name}: 1 to ${TITLE_MAX} characters`);
    assert.match(title, /^[A-Z]/, `${tool.name}: starts with a capital (a verb)`);
    assert.doesNotMatch(title, /[.`\n]|^Timon\b/, `${tool.name}: no period, backtick, line break or product prefix`);
    assert.notEqual(title, tool.name, `${tool.name}: the title is not the name again`);
    assert.equal(seen.get(title), undefined, `${tool.name}: same title as ${seen.get(title)}`);
    seen.set(title, tool.name);
  }
  for (const name of TITLED) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool?.title, `${name} keeps its title`);
  }
});

test('every catalog tool carries a title', async () => {
  const { TOOLS } = await loadMcpCatalog();
  const untitled = TOOLS.filter((t) => t.title === undefined).map((t) => t.name);
  assert.deepEqual(untitled, [], 'give each new tool a `title` (docs/MCP-TOOL-CONVENTIONS.md)');
});

test('the stdio server lists each tool with its title', async () => {
  const { TOOLS } = await loadMcpCatalog();
  const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-mcp-titles-')) };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/timon-mcp.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const reply = await new Promise<{ result: { tools: { name: string; title?: string }[] } }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 10_000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => { clearTimeout(timer); child.kill(); lines.close(); resolve(JSON.parse(line)); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  });
  const listed = new Map(reply.result.tools.map((t) => [t.name, t.title]));
  for (const tool of TOOLS) assert.equal(listed.get(tool.name), tool.title, tool.name);
});
