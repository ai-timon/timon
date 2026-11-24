import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatTroubleSignal, DISCONNECTED_AFTER, SILENT_AFTER_MS, setupTrouble, type SetupTroubleInput } from './setup-trouble';

const calm: SetupTroubleInput = { signal: null, mission: { status: 'running', liveness: 'working' }, pollFailures: 0, spoke: true, elapsedMs: 0 };

test('a conversation that goes well keeps "Skip" quiet', () => {
  assert.deepEqual(setupTrouble(calm), { level: 'quiet' });
  // Not polled yet, not spoken yet, but early: nothing to say.
  assert.deepEqual(setupTrouble({ ...calm, mission: null, spoke: false, elapsedMs: SILENT_AFTER_MS - 1 }), { level: 'quiet' });
  assert.deepEqual(setupTrouble({ ...calm, pollFailures: DISCONNECTED_AFTER - 1 }), { level: 'quiet' });
});

test('a refused tool puts "Skip" forward, without a restart that would hit the same refusal', () => {
  assert.deepEqual(setupTrouble({ ...calm, signal: 'tool_error' }), { level: 'prominent', reason: 'tool_error', canRestart: false });
  assert.deepEqual(setupTrouble({ ...calm, signal: 'interrupted' }), { level: 'prominent', reason: 'interrupted', canRestart: false });
});

test('a dead mission offers to start over, whatever else was said', () => {
  for (const status of ['completed', 'failed', 'terminated', 'missing']) {
    assert.deepEqual(setupTrouble({ ...calm, mission: { status }, signal: 'tool_error' }), { level: 'prominent', reason: 'ended', canRestart: true }, status);
  }
  assert.deepEqual(setupTrouble({ ...calm, mission: { status: 'running', liveness: 'interrupted' } }), { level: 'prominent', reason: 'ended', canRestart: true });
  assert.deepEqual(setupTrouble({ ...calm, signal: 'ended' }), { level: 'prominent', reason: 'ended', canRestart: true });
  assert.deepEqual(setupTrouble({ ...calm, signal: 'spawn_failed' }), { level: 'prominent', reason: 'interrupted', canRestart: true });
});

test('silence after the delay, and a daemon that stopped answering, are trouble too', () => {
  assert.deepEqual(setupTrouble({ ...calm, spoke: false, elapsedMs: SILENT_AFTER_MS }), { level: 'prominent', reason: 'silent', canRestart: false });
  // Once it spoke, a long conversation is just a long conversation.
  assert.deepEqual(setupTrouble({ ...calm, spoke: true, elapsedMs: SILENT_AFTER_MS * 10 }), { level: 'quiet' });
  assert.deepEqual(setupTrouble({ ...calm, pollFailures: DISCONNECTED_AFTER }), { level: 'prominent', reason: 'disconnected', canRestart: false });
});

test('the conversation reads a 401 from a Timon tool as a tool error, flagged or not', () => {
  const tool = (text: string, isError: boolean) => ({ role: 'agent', tools: [{ result: { text, isError } }] });
  assert.equal(chatTroubleSignal([{ role: 'user' }, tool('ok', false)]), null);
  assert.equal(chatTroubleSignal([tool('HTTP 401 unauthorized', true)]), 'tool_error');
  // An MCP server that answered the refusal as plain text.
  assert.equal(chatTroubleSignal([tool('{"error":"unauthorized","status":401}', false)]), 'tool_error');
  assert.equal(chatTroubleSignal([tool('403 Forbidden', false)]), 'tool_error');
  assert.equal(chatTroubleSignal([tool('something broke', true)]), 'tool_error');
  // A notice (interrupted turn, CLI that never started): interrupted, unless a tool failed too.
  assert.equal(chatTroubleSignal([{ role: 'notice' }]), 'interrupted');
  assert.equal(chatTroubleSignal([{ role: 'notice' }, tool('401', true)]), 'tool_error');
  // A tool still running has no result yet.
  assert.equal(chatTroubleSignal([{ role: 'agent', tools: [{}] }]), null);
});
