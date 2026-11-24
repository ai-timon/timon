import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderContext, dialectConformance, defineConformanceTests } from '../../../packages/sdk/src/testing/index.js';
import { createClaudeProvider } from '../../official-providers/provider-claude/lib/claude.js';
import { createClaudeToken } from '../../official-providers/provider-claude/lib/token.js';
import { createClaudeUsage } from '../../official-providers/provider-claude/lib/usage.js';
// The contract the plugin's manifest declares, which `scratch.profile` needs.
const { timon: { apiVersion } } = JSON.parse((await import('node:fs')).readFileSync(new URL('../../official-providers/provider-claude/package.json', import.meta.url), 'utf8')) as { timon: { apiVersion: number } };
const ctx = createProviderContext({ apiVersion });
const token = createClaudeToken(ctx.provider);
const usage = createClaudeUsage(ctx.provider, token);
const definition = createClaudeProvider(ctx.provider, token, usage);
ctx.provider.registerProvider(definition);
const dialect = ctx.registered.dialect('claude');
const { readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const scratch = await ctx.provider.scratch.mission({ missionId: 'mission-contract-0001' } as never);
process.on('exit', () => ctx.cleanup());
defineConformanceTests(test, dialectConformance(dialect, { id: 'claude', env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } }, {
 transcript: readFileSync(join(import.meta.dirname, '../backends/__fixtures__/claude.jsonl'), 'utf8'),
 sessionId: '3f9a1c52-7e64-4d0b-9a11-0b2c8de41f77', cmd: 'claude', model: 'sonnet',
}, { cwd: scratch.path, scratchDirs: [scratch.path] }), '[Claude plugin]');
test('Claude keeps its persistent process, session controls, login and model controls', () => {
  assert.equal(definition.transport.kind, 'stdio-persistent');
  assert.equal(definition.session.store, 'global');
  assert.equal(definition.session.resumable, true);
  assert.equal(definition.permission.model, 'mcp-bridge');
  assert.deepEqual(definition.reasoning.controls, ['levels', 'budget', 'toggle']);
  assert.deepEqual(ctx.provider.runtime.check.definitionProblems(definition), []);
});
test('fenced, Claude Code\'s own sandbox is kept off by command-line settings, which outrank the user\'s and the project\'s', () => {
  const declaration = { offArgs: ['--settings', '{"sandbox":{"enabled":false}}'] };
  assert.deepEqual(definition.permission.nestedSandbox, declaration);
  assert.deepEqual(dialect.nestedSandbox, declaration);
  assert.deepEqual(JSON.parse(declaration.offArgs[1]), { sandbox: { enabled: false } });
});

test('a persistent model change is acknowledged on the control channel without leaking into chat events', async () => {
  const { PassThrough } = await import('node:stream');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let written = '';
  stdin.on('data', (chunk) => { written += String(chunk); });
  const changed = definition.session.setModel({ stdin, stdout }, 'opus');
  const request = JSON.parse(written);
  assert.equal(request.request.subtype, 'set_model');
  assert.equal(request.request.model, 'opus');
  assert.deepEqual(definition.codec.parseLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } })), []);
  assert.equal(await changed, true);
  assert.equal(definition.codec.parseLine(JSON.stringify({ type: 'control_response', request_id: 'someone-else' })).length, 1);
  stdin.destroy(); stdout.destroy();
});

test('C4: a Claude sign-in is read where the CLI keeps it, and its absence says how to sign in', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const configDir = mkdtempSync(join(tmpdir(), 'timon-claude-auth-'));
  const env = { CLAUDE_CONFIG_DIR: configDir };
  const missing = await definition.declares.authStatus!(env);
  assert.equal(missing.ok, false);
  assert.equal(missing.signInCommand, 'claude');
  writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'expired', expiresAt: 1, refreshToken: 'r' } }));
  assert.equal((await definition.declares.authStatus!(env)).ok, true, 'a refresh token renews an expired access token');
  assert.equal((await definition.declares.authStatus!({ ...env, ANTHROPIC_API_KEY: 'sk-test' })).source, 'environment');
});

test('a claude api_retry is a provider retry with its attempt, ceiling, delay and kind', () => {
  const events = definition.codec.parseLine(JSON.stringify({
    type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 1200,
    error_status: 529, error: 'overloaded_error', session_id: 's', uuid: 'u',
  }));
  assert.deepEqual(events, [{ type: 'provider_retry', payload: {
    type: 'provider_retry', attempt: 2, max: 10, delay_ms: 1200, kind: 'overloaded', cause: 'HTTP 529 overloaded_error',
  } }]);
  const [network] = definition.codec.parseLine(JSON.stringify({
    type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown',
  }));
  assert.equal((network!.payload as { kind: string }).kind, 'transport');
});

test('#1104: the `claude` subscription profile keeps the CLI\'s own config folder', async () => {
  const spec = await dialect.buildSpawn({
    agentName: 'claude.contract', systemPrompt: 'contract', message: 'ping', resumeSession: null, missionId: 'mission-claude-config-1',
    cfg: { cwd: scratch.path, permission_mode: 'auto', mcp_servers: [] },
  } as never, { id: 'claude', cmd: 'claude', env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } } as never);
  assert.equal(spec.env?.CLAUDE_CONFIG_DIR, undefined);
});
