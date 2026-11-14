/**
 * The sentence a mission on a registry agent shows when the agent wants a
 * sign-in, and the list the settings screen receives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAuthMethods } from '../../backends/acp/auth.js';
import { authMethodViews, signInAdviceFor } from './sign-in.js';

const antigravity = readAuthMethods([
  { id: 'oauth-personal', name: 'Log in with Google' },
  { id: 'gemini-api-key', name: 'Gemini API key' },
  { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform' },
]);

test('no terminal command: the sentence names the subscription step and lists the billed methods as unused', () => {
  const advice = signInAdviceFor('Google Antigravity', '/x/agent', antigravity);
  assert.match(advice, /“Log in with Google”/);
  assert.match(advice, /Billed per token, so never used by Timon: “Gemini API key”, “Gemini Enterprise Agent Platform”/);
  assert.doesNotMatch(advice, /`/, 'no command to run');
});

test('a terminal method becomes the command to run, with a quoted program when its path has a space', () => {
  const methods = readAuthMethods([{ id: 'login', name: 'Terminal login', type: 'terminal', args: ['--login'] }]);
  assert.match(signInAdviceFor('Acme', '/x/agent', methods), /`\/x\/agent --login`/);
  assert.match(signInAdviceFor('Acme', 'C:\\Users\\John Doe\\agent.exe', methods), /`"C:\\Users\\John Doe\\agent\.exe" --login`/);
});

test('only billed methods: says so; never read: says where to look', () => {
  assert.match(signInAdviceFor('Acme', '/x', readAuthMethods([{ id: 'acme-api-key', name: 'API key' }])), /billed per token .* use another provider/);
  assert.match(signInAdviceFor('Acme', '/x', null), /Sign-in methods/);
});

test('the view marks billed methods and recommends one subscription method only', () => {
  const views = authMethodViews(antigravity, '/x/agent');
  assert.deepEqual(views.map((v) => [v.id, v.billedPerToken, v.recommended, v.command]), [
    ['oauth-personal', false, true, null],
    ['gemini-api-key', true, false, null],
    ['agent-platform', true, false, null],
  ]);
});
