/**
 * The agent node's model, picked through the ModelPicker (ModelPicker 6/6):
 * a pick writes both halves, "inherit" clears them, and the thinking setting
 * follows the model. The stored half-pairs of the old two selects read as what
 * they run (`taskModelPick`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCatalog } from '@/lib/backends';
import { taskModelPick } from '@/lib/task-model-pick';
import { nodeModelPatch } from './node-settings';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude', label: 'Claude', defaultModel: 'opus',
      models: [
        { slug: 'opus', label: 'Opus', supportedReasoningLevels: ['low', 'high', 'xhigh'] },
        { slug: 'haiku', label: 'Haiku', supportedReasoningLevels: ['low', 'high'] },
      ],
    },
    { id: 'codex', label: 'Codex', defaultModel: 'gpt-5.5', models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }] },
  ],
};

test('a pick writes both halves and keeps a thinking level the new model knows', () => {
  assert.deepEqual(nodeModelPatch(CATALOG, 'high', { backend: 'claude', model: 'haiku' }), { backend: 'claude', model: 'haiku', reasoningEffort: 'high' });
  assert.deepEqual(nodeModelPatch(CATALOG, 'xhigh', { backend: 'claude', model: 'haiku' }), { backend: 'claude', model: 'haiku', reasoningEffort: undefined });
  assert.deepEqual(nodeModelPatch(CATALOG, 'high', { backend: 'codex', model: 'gpt-5.5' }), { backend: 'codex', model: 'gpt-5.5', reasoningEffort: undefined });
});

test('inherit clears the pair and the thinking setting', () => {
  assert.deepEqual(nodeModelPatch(CATALOG, 'high', null), { backend: undefined, model: undefined, reasoningEffort: undefined });
});

test('the node value: inherit, a full pair, and the half-pairs of the old selects', () => {
  assert.equal(taskModelPick(CATALOG, '', ''), null);
  assert.deepEqual(taskModelPick(CATALOG, 'codex', 'gpt-5.5'), { backend: 'codex', model: 'gpt-5.5' });
  assert.deepEqual(taskModelPick(CATALOG, 'codex', ''), { backend: 'codex', model: 'gpt-5.5' });
  assert.deepEqual(taskModelPick(CATALOG, '', 'haiku'), { backend: 'claude', model: 'haiku' });
});
