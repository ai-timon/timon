/**
 * The onboarding screen shows what an agent will actually be called. The
 * conversion must match the daemon's (`onboarding-main-agent.ts`): a
 * preview that lies is worse than no preview.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAgentName } from './agent-name';

test('a typed display name becomes a valid agent name', () => {
  assert.equal(toAgentName('Nova'), 'Nova');
  assert.equal(toAgentName('Nova, mon assistante'), 'Nova-mon-assistante');
  assert.equal(toAgentName('  Éléa  '), 'Éléa', 'accents stay'); // french-ok: an accented name, kept as is
  assert.equal(toAgentName('马斯克'), '马斯克', 'every script stays');
  assert.equal(toAgentName('a'.repeat(100)).length, 80, 'cut at 80 bytes');
  assert.equal(toAgentName('马'.repeat(40)), '马'.repeat(26), 'a Chinese character is 3 bytes');
  assert.equal(toAgentName('***'), 'agent', 'never an empty name');
  assert.equal(toAgentName('😀'), 'agent');
});

test('the onboarding name field never takes more than an agent name holds', async () => {
  const { AGENT_NAME_MAX } = await import('@/components/onboarding/agent/identity-card');
  const { AGENT_NAME_MAX_BYTES } = await import('./agent-name-rule');
  // `maxLength` counts UTF-16 units; one unit is at most 3 bytes of UTF-8.
  assert.ok(AGENT_NAME_MAX * 3 <= AGENT_NAME_MAX_BYTES);
  assert.equal(toAgentName('马'.repeat(AGENT_NAME_MAX)), '马'.repeat(AGENT_NAME_MAX), 'a full field of Chinese is kept whole');
});
