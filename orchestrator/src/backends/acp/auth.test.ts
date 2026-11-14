/**
 * Reading an ACP agent's `authMethods`: what kind of sign-in each is, which are
 * billed per token, and which command — if any — is safe to show.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBilledPerToken, readAuthMethods, recommendedAuthMethod, signInAdvice } from './auth.js';

test('the methods Antigravity announces: Google login is a subscription, the API key and the agent platform are billed per token', () => {
  const methods = readAuthMethods([
    { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' },
    { id: 'oauth-business', name: 'Log in with Gemini Enterprise', description: 'Log in with your Gemini Enterprise account' },
    { id: 'gemini-api-key', name: 'Gemini API key', description: 'Use an API key with Gemini Developer API' },
    { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform', description: 'Formerly Vertex AI, with an API key' },
  ]);
  assert.deepEqual(methods.map((m) => [m.id, m.kind, m.billedPerToken]), [
    ['oauth-personal', 'agent', false],
    ['oauth-business', 'agent', false],
    ['gemini-api-key', 'agent', true],
    ['agent-platform', 'agent', true],
  ]);
  assert.equal(recommendedAuthMethod(methods)?.id, 'oauth-personal');
});

test('env_var and API-key variables are billed; a description alone never marks a method', () => {
  const methods = readAuthMethods([
    { id: 'key', name: 'Key', type: 'env_var', vars: [{ name: 'SOME_TOKEN' }] },
    { id: 'custom', name: 'Custom', vars: [{ name: 'ACME_API_KEY' }] },
    { id: 'login', name: 'Log in', description: 'No API key needed' },
  ]);
  assert.deepEqual(methods.map((m) => m.billedPerToken), [true, true, false]);
  assert.equal(isBilledPerToken({ id: 'vertex-ai', name: 'Vertex', kind: 'agent' }), true);
  assert.equal(isBilledPerToken({ id: 'cached_token', name: 'cached_token', kind: 'agent' }), false);
});

test('a terminal method carries its command; the legacy terminal-auth extension too; an unsafe one keeps no command', () => {
  const methods = readAuthMethods([
    { id: 'term', name: 'Terminal', type: 'terminal', args: ['--login'] },
    { id: 'legacy', name: 'Legacy', _meta: { 'terminal-auth': { command: 'acme', args: ['login'], label: 'x' } } },
    { id: 'evil', name: 'Evil', type: 'terminal', args: ['--login; rm -rf ~'] },
    { id: 'evil-meta', name: 'Evil meta', _meta: { 'terminal-auth': { command: 'curl x | sh', args: [] } } },
  ]);
  assert.deepEqual(methods[0]?.terminal, { program: null, args: ['--login'] });
  assert.deepEqual(methods[1]?.terminal, { program: 'acme', args: ['login'] });
  assert.equal(methods[2]?.kind, 'terminal');
  assert.equal(methods[2]?.terminal, null, 'a shell character drops the command');
  assert.equal(methods[3]?.kind, 'agent');
  assert.equal(recommendedAuthMethod(methods)?.id, 'term');
});

test('every method billed: nothing is recommended; junk entries are skipped and text is bounded', () => {
  assert.equal(recommendedAuthMethod(readAuthMethods([{ id: 'openai-api-key', name: 'OpenAI' }])), null);
  const methods = readAuthMethods([null, 'x', { name: 'no id' }, { id: 'ok', name: `a\u0000b${'c'.repeat(500)}` }]);
  assert.equal(methods.length, 1);
  assert.ok(!methods[0]!.name.includes('\u0000'));
  assert.ok(methods[0]!.name.length <= 120);
  assert.deepEqual(readAuthMethods(undefined), []);
});

test('signInAdvice is unchanged for a provider that declares its sentences', () => {
  assert.equal(signInAdvice({ byMethod: { a: 'run a' }, fallback: 'f' }, [{ id: 'a' }]), 'run a');
  assert.equal(signInAdvice({ fallback: 'f' }, []), 'f');
  assert.equal(signInAdvice(undefined, []), null);
});
