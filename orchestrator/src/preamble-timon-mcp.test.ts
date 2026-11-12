/**
 * The preamble describes the tools the agent really has. A backend that
 * declares `capabilities.timonMcp: false` is handed neither `timon` nor
 * `timon_ask`, so no section may promise them (the agent would call tools that
 * do not exist); a backend that declares nothing keeps the whole preamble.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildPromptSegments, upsertAgent, loadConfig } = await import('./agent.js');
await import('../tests/helpers/claude-provider.js');

const { getBackend } = await import('./backends/index.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
type Dialect = import('./backends/types.js').Dialect;

const OWNER = 'preamble-timon-mcp-test';
const noTools: Dialect = {
  defaultCmd: 'echo',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: true,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  capabilities: { worktree: false, timonMcp: false, attachments: false },
  async buildSpawn(_opts, profile) { return { cmd: profile.cmd, args: [], initialStdin: null }; },
  writeUserInput() { /* one-shot */ },
  parseLine() { return []; },
  extractSessionId() { return null; },
};
registerDialect(OWNER, 'preamble-no-tools', noTools);
registerDialect(OWNER, 'preamble-own-identity', { ...noTools, capabilities: { ...noTools.capabilities, timonPreamble: false } });
registerProfile(OWNER, {
  id: 'preamble-own-identity', dialect: 'preamble-own-identity', label: 'Own identity', custom: true,
  defaultModel: null, models: [],
});
registerProfile(OWNER, {
  id: 'preamble-no-tools', dialect: 'preamble-no-tools', label: 'No tools', custom: true,
  defaultModel: null, models: [],
});

/** Names of tools of the `timon` / `timon_ask` MCPs, and the gestures that need them. */
const TIMON_TOOLS = [
  'kanban_add', 'kanban_plan', 'kanban_mark_as_done', 'mission_spawn', 'agent_list', 'agent_send_message',
  'terminal_propose', 'chat_show_media', 'chat_post_message', 'timon_ask', 'memory_rule_add', 'docs_search', 'project_todo_add',
  'browser_status', 'timon notify', 'timon memory rule',
];

function preambleFor(backend: string, orchestrator = true): string {
  const name = `preamble-${backend}`;
  upsertAgent({
    name,
    system_prompt: 'Witness.',
    config: { backend, orchestrator, skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const segments = buildPromptSegments(name, loadConfig(name), getBackend(backend));
  const segment = segments.find((s) => s.id === 'preamble');
  assert.ok(segment, 'the preamble segment exists');
  return segment.body;
}

test('a backend without Timon MCP servers is not promised their tools', () => {
  const text = preambleFor('preamble-no-tools');
  for (const tool of TIMON_TOOLS) assert.ok(!text.includes(tool), `${tool} must not appear: it does not exist for this agent`);
  // What does not depend on the tools stays.
  assert.match(text, /Runtime context — Timon/);
  assert.match(text, /Where things live/);
  assert.match(text, /NEVER start a process that does not end/);
  assert.match(text, /Scheduling/);
  // And the agent is told how to ask for a decision without a question tool.
  assert.match(text, /no question tool/);
});

test('a backend that declares nothing keeps the whole preamble', () => {
  const text = preambleFor('claude');
  for (const tool of ['kanban_add', 'kanban_plan', 'mission_spawn', 'agent_list', 'terminal_propose', 'chat_show_media', 'chat_post_message', 'timon_ask']) {
    assert.ok(text.includes(tool), `${tool} stays in the preamble of a backend that has it`);
  }
  assert.doesNotMatch(text, /no question tool/);
});

test('a backend that brings its own identity gets the agent\'s own prompt, with nothing of Timon\'s preamble', () => {
  const name = 'preamble-own-identity-agent';
  upsertAgent({
    name,
    system_prompt: '# my own prompt marker\n',
    config: { backend: 'preamble-own-identity', skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const ids = buildPromptSegments(name, loadConfig(name), getBackend('preamble-own-identity')).map((s) => s.id);
  assert.ok(!ids.includes('preamble'), 'no Timon preamble');
  assert.ok(!ids.includes('backend'), 'no "your backend" block');
  assert.ok(ids.includes('system-prompt'), 'the agent\'s own prompt is still sent');
});

test('TODO #551: ui_render is promised only while the ui-documents module runs', async () => {
  const { setActiveModules, resetActiveModules } = await import('./kernel/module-state.js');
  try {
    assert.match(preambleFor('claude'), /ui_render/, 'every module on (no kernel has spoken)');
    setActiveModules(['@timon/memory', '@timon/kanban']);
    const text = preambleFor('claude');
    assert.doesNotMatch(text, /ui_render|ui_document_get/);
    assert.match(text, /chat_show_media/, 'the other bullets stay');
    assert.match(text, /terminal_propose/);
    setActiveModules(['@timon/ui-documents']);
    assert.match(preambleFor('claude'), /ui_render/);
  } finally { resetActiveModules(); }
});
