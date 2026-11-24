import assert from 'node:assert/strict';
import test from 'node:test';
import { KANBAN_NATIVE_COLUMNS, kanbanGridClass } from './kanban-grid';

test('without a plugin, the Kanban keeps its four status columns', () => {
  assert.equal(KANBAN_NATIVE_COLUMNS, 4);
  assert.equal(kanbanGridClass(0), 'md:grid-cols-4');
});

test('a plugin column widens the grid instead of overflowing', () => {
  assert.equal(kanbanGridClass(1), 'md:grid-cols-5');
  assert.equal(kanbanGridClass(3), 'md:grid-cols-7');
});

test('the grid stops widening beyond eight columns', () => {
  // One plugin too many must not make a column disappear: they
  // all shrink together.
  assert.equal(kanbanGridClass(12), 'md:grid-cols-8');
});

test('a negative value falls back to the native grid', () => {
  assert.equal(kanbanGridClass(-1), 'md:grid-cols-4');
});
