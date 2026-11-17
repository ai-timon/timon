import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderContext, dialectConformance, defineConformanceTests } from '../../../packages/sdk/src/testing/index.js';
import { createClaudeProvider } from '../../official-providers/provider-claude/lib/claude.js';
import { createClaudeToken } from '../../official-providers/provider-claude/lib/token.js';
import { createClaudeUsage } from '../../official-providers/provider-claude/lib/usage.js';
const ctx = createProviderContext();
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

test('a rewind resumes the session at the last message the CLI wrote before the cut', async () => {
  const rewind = definition.session.rewind!;
  const row = (id: number, type: string, payload: object) => ({ id, type, payload: JSON.stringify(payload) });
  const sessionId = 'session-a';
  const thread = [
    row(1, 'user', { type: 'user', message: { role: 'user', content: 'Timon logs this one, no uuid' } }),
    row(2, 'system', { type: 'system', subtype: 'init', uuid: 'init-uuid', session_id: sessionId }),
    row(3, 'assistant', { type: 'assistant', uuid: 'tool-call', session_id: sessionId }),
    row(4, 'user', { type: 'user', uuid: 'tool-result', session_id: sessionId }),
    row(5, 'assistant', { type: 'assistant', uuid: 'answer', session_id: sessionId }),
    row(6, 'result', { type: 'result', uuid: 'result-uuid', session_id: sessionId }),
    row(7, 'rewind', { type: 'rewind', from_event_id: 8 }),
  ];
  assert.deepEqual(await rewind({ missionId: 'm', sessionId, events: thread }), { resume: sessionId, resumeAt: 'answer' });
  // Rewound to the first message: nothing left to resume, a fresh session.
  assert.deepEqual(await rewind({ missionId: 'm', sessionId, events: [thread[6]!] }), { resume: null });
  // A message of an older session lacks what came after it: summary mode.
  await assert.rejects(rewind({ missionId: 'm', sessionId: 'session-b', events: thread }), /another session/);
  // The user spoke, the CLI wrote nothing that can be resumed at: summary mode, not a blank session.
  await assert.rejects(rewind({ missionId: 'm', sessionId, events: [thread[0]!, thread[1]!] }), /no message/);
});

test('an unknown resume point reads as a session not found, which the daemon turns into summary mode', () => {
  assert.equal(definition.session.notFound!('No message found with message.uuid of: 00000000-0000-0000-0000-000000000000\n'), true);
  assert.equal(definition.session.notFound!('No conversation found with session ID: x\n'), true);
  assert.equal(definition.session.notFound!('some other failure\n'), false);
});
