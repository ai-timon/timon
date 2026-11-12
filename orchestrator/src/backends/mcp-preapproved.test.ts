/**
 * The pre-approved tool names live in one module, read by the claude dialect and
 * by `ctx.provider.mcp()`. This proves the dialect still passes exactly them (and
 * the ask-form tools) to the CLI: the move out of `claude.ts` changed nothing.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../tests/helpers/claude-provider.js');
const { buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
const { PRE_APPROVED_MCP_TOOLS, configuredPreApprovedMcpTools } = await import('./mcp-preapproved.js');
const { claudeAskToolNames } = await import('../ask-mcp.js');

test('claude passes the module’s list, plus the ask-form tools, to --allowedTools', async () => {
  const spawn = await buildUnderSeal('claude', {
    agentName: 'witness', systemPrompt: 'x', message: 'hi', resumeSession: null, missionId: 'm1',
    cfg: { cwd: process.cwd(), allowed_tools: ['Read'] },
  } as never);
  const flag = spawn.args.indexOf('--allowedTools');
  assert.ok(flag >= 0);
  const passed = spawn.args[flag + 1]!.split(',');
  assert.deepEqual(passed, ['Read', ...claudeAskToolNames(), ...PRE_APPROVED_MCP_TOOLS]);
  assert.equal(passed.length - 1, 47, 'the 47 names PROVIDERS-SDK S1 counts');
  // The setup conversation calls them: a card in front of them stalls the first minutes of a fresh install.
  for (const name of ['setup_set_soul', 'setup_recruit_team', 'setup_finish', 'onboarding_profile_get', 'onboarding_profile_set']) {
    assert.ok(PRE_APPROVED_MCP_TOOLS.includes(`mcp__timon__${name}`), name);
  }
  assert.equal(PRE_APPROVED_MCP_TOOLS.includes('mcp__timon__project_todo_attachments_add'), false, 'reading a host file stays behind a decision');
  assert.equal(PRE_APPROVED_MCP_TOOLS.some((name) => !name.startsWith('mcp__timon')), false, 'the product pre-approves only its own tools');
  assert.equal(PRE_APPROVED_MCP_TOOLS.includes('mcp__timon__mission_spawn'), false, 'spawning stays behind a decision');
});

test('the list is frozen', () => {
  assert.ok(Object.isFrozen(PRE_APPROVED_MCP_TOOLS));
});

test('the user\'s pre-approved MCP tools are exact names, deduplicated, never a wildcard', () => {
  assert.deepEqual(
    configuredPreApprovedMcpTools(' mcp__notes__read_note, mcp__notes__search ,mcp__notes__read_note,,mcp__notes__*,Bash,mcp__x__y; rm -rf /'),
    ['mcp__notes__read_note', 'mcp__notes__search'],
  );
  assert.deepEqual(configuredPreApprovedMcpTools(''), []);
});
