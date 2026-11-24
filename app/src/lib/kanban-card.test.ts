import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCatalog } from './backends';
import {
  formatRunningFor,
  parseDeps,
  priorityTone,
  taskModelMark,
  unblocksCount,
  waitingOnCount,
} from './kanban-card';

const board = new Map([
  ['pending', { status: 'PENDING' }],
  ['running', { status: 'IN_PROGRESS' }],
  ['blocked', { status: 'BLOCKED' }],
  ['done', { status: 'DONE' }],
]);

test('"waits on" counts only the dependencies still to finish', () => {
  assert.equal(waitingOnCount(['pending', 'running', 'blocked'], board), 3);
  assert.equal(waitingOnCount(['done'], board), 0, 'a finished dependency holds nothing back');
  // Only DONE tasks are windowed out of the board: a missing one is finished.
  assert.equal(waitingOnCount(['done', 'off-the-board'], board), 0);
  assert.equal(waitingOnCount([], board), 0);
});

test('"unblocks" counts the unfinished tasks waiting on this one, chain included', () => {
  assert.equal(unblocksCount([{ id: 'pending' }, { id: 'done' }, { id: 'blocked' }], board), 2);
  assert.equal(unblocksCount([{ id: 'off-the-board' }], board), 0);
  assert.equal(unblocksCount(undefined, board), 0);
});

test('a malformed deps column reads as no dependency', () => {
  assert.deepEqual(parseDeps('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseDeps('[1,"b",null]'), ['b']);
  assert.deepEqual(parseDeps('{oops'), []);
  assert.deepEqual(parseDeps('"a"'), []);
  assert.deepEqual(parseDeps(null), []);
});

test('the running time reads in minutes, then hours', () => {
  const start = 1_000_000;
  assert.equal(formatRunningFor(start, start + 20_000), 'just started');
  assert.equal(formatRunningFor(start, start + 26 * 60_000), '26 min');
  assert.equal(formatRunningFor(start, start + 65 * 60_000), '1 h 05');
  assert.equal(formatRunningFor(start, start - 5_000), 'just started', 'a clock skew never shows a negative time');
});

test('P4 stands out, P5 alarms, below P3 fades', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(priorityTone), ['low', 'low', 'normal', 'high', 'urgent']);
});

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      models: [{ slug: 'opus', label: 'Opus', brand: 'claude' }, { slug: 'haiku', label: 'Haiku' }],
    },
    {
      id: 'claude@perso', label: 'Claude · Perso', instanceOf: 'claude', models: [],
      account: { id: 'perso', name: 'Perso', state: 'active' },
    },
    { id: 'custom', label: 'Custom', icon: '🦊', models: [{ slug: 'fox-1', label: 'Fox', icon: '/api/uploads/fox.png' }] },
  ],
} as BackendCatalog;

test('the model mark: the model\'s own brand, its backend\'s as the fallback', () => {
  const opus = taskModelMark(CATALOG, { effective_backend: 'claude', effective_model: 'opus' });
  assert.equal(opus.empty, false);
  assert.equal(opus.brand, 'claude');
  assert.equal(opus.fallbackBrand, 'anthropic');
  assert.equal(opus.inherited, true, 'no override: the role or the agent decides');

  const haiku = taskModelMark(CATALOG, { backend_override: 'claude', model_override: 'haiku', effective_backend: 'claude', effective_model: 'haiku' });
  assert.equal(haiku.brand, undefined, 'no brand of its own: BrandMark falls back on the backend');
  assert.equal(haiku.fallbackBrand, 'anthropic');
  assert.equal(haiku.inherited, false);

  const fox = taskModelMark(CATALOG, { effective_backend: 'custom', effective_model: 'fox-1' });
  assert.equal(fox.icon, '/api/uploads/fox.png', 'a picture a human chose wins');
  assert.equal(fox.fallbackIcon, '🦊');
});

test('an account instance carries its provider\'s logo; nothing known draws nothing', () => {
  const onAccount = taskModelMark(CATALOG, { effective_backend: 'claude@perso', effective_model: 'opus' });
  assert.equal(onAccount.fallbackBrand, 'anthropic');
  assert.equal(onAccount.brand, 'claude');
  const unlisted = taskModelMark(CATALOG, { effective_backend: 'claude@gone', effective_model: null });
  assert.equal(unlisted.fallbackBrand, 'anthropic', 'an account the catalogue no longer lists keeps its provider');
  assert.equal(taskModelMark(CATALOG, {}).empty, true);
});
