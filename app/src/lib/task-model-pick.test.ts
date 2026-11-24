/**
 * A task's `backend_override` + `model_override` read and written through the
 * ModelPicker (`task-model-pick.ts`): "inherit" clears both halves, a pick
 * sets both, a half-pair saved by an older form still shows what it runs on,
 * and only a queued or blocked task can change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackendCatalog } from '@/lib/backends';
import {
  canEditTaskModel,
  taskModelPick,
  taskOverrides,
  withTaskModel,
} from './task-model-pick';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude', defaultModel: 'opus', models: [{ slug: 'opus', label: 'Opus' }, { slug: 'haiku', label: 'Haiku' }] },
    { id: 'claude@krz', label: 'Claude', defaultModel: 'opus', instanceOf: 'claude', models: [{ slug: 'gpt-5.5', label: 'odd' }] },
    { id: 'codex', label: 'Codex', defaultModel: 'gpt-5.5', models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }] },
  ],
};

test('no override is the inherit entry; a full pair is itself', () => {
  assert.equal(taskModelPick(CATALOG, null, null), null);
  assert.equal(taskModelPick(CATALOG, '', '  '), null);
  assert.deepEqual(taskModelPick(CATALOG, 'codex', 'gpt-5.5'), { backend: 'codex', model: 'gpt-5.5' });
  assert.deepEqual(taskModelPick(CATALOG, 'claude@krz', 'opus'), { backend: 'claude@krz', model: 'opus' });
});

test('a half-pair from an older form shows what it runs on', () => {
  assert.deepEqual(taskModelPick(CATALOG, 'codex', null), { backend: 'codex', model: 'gpt-5.5' }, 'backend alone: its default model');
  assert.deepEqual(taskModelPick(CATALOG, null, 'gpt-5.5'), { backend: 'codex', model: 'gpt-5.5' }, 'model alone: the provider listing it, never an account instance');
  assert.deepEqual(taskModelPick(CATALOG, null, 'claude-opus-4-6'), { backend: 'claude', model: 'claude-opus-4-6' }, 'unknown slug: the default backend');
});

test('a pick writes both halves, inherit clears both', () => {
  assert.deepEqual(taskOverrides({ backend: 'codex', model: 'gpt-5.5' }), { backend_override: 'codex', model_override: 'gpt-5.5' });
  assert.deepEqual(taskOverrides(null), { backend_override: null, model_override: null });
});

test('only a PENDING or BLOCKED task can change model', () => {
  assert.equal(canEditTaskModel('PENDING'), true);
  assert.equal(canEditTaskModel('BLOCKED'), true);
  assert.equal(canEditTaskModel('IN_PROGRESS'), false);
  assert.equal(canEditTaskModel('DONE'), false);
  assert.equal(canEditTaskModel(undefined), false);
});

test('the optimistic card shows the pick', () => {
  const task = { id: 't', title: 'x', backend_override: null, model_override: null, effective_backend: 'claude', effective_model: 'opus' };
  const picked = withTaskModel(task, { backend: 'codex', model: 'gpt-5.5' });
  assert.deepEqual(picked, { ...task, backend_override: 'codex', model_override: 'gpt-5.5', effective_backend: 'codex', effective_model: 'gpt-5.5' });
  const inherited = withTaskModel({ ...task, backend_override: 'codex', model_override: 'gpt-5.5' }, null);
  assert.equal(inherited.backend_override, null);
  assert.equal(inherited.effective_backend, 'claude', 'the effective pair waits for the server to resolve the role');
});
