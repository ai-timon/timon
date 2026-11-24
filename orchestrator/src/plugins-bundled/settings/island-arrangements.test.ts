/**
 * The daemon's copy of the named arrangements' rules (`app/src/lib/island-arrangements.ts`):
 * the bounds the menu enforces must hold when an agent writes the same row.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  MAX_ARRANGEMENTS,
  MAX_ARRANGEMENTS_BYTES,
  arrangementHref,
  isEmptyStoredTree,
  readArrangements,
  saveArrangement,
  storedTreeFromLayout,
  summariseArrangement,
  writeArrangements,
} = await import('./island-arrangements.js');
const { LAYOUT_MAX_BYTES } = await import('./routes.js');

const leaf = (id: string, ...types: string[]) => ({
  id, kind: 'leaf', active: `${id}t0`, tabs: types.map((type, i) => ({ id: `${id}t${i}`, content: { type, params: {} } })),
});
const pageOnly = { v: 1, root: leaf('a', 'host:route'), focus: 'a' };
const split = { v: 1, focus: 'a', root: { id: 's', kind: 'split', dir: 'row', ratios: [0.5, 0.5], children: [leaf('a', 'host:route'), leaf('b', 'x:term')] } };
const opts = (id: string, replace = false) => ({ id, replace, now: 1000 });

test('the bounds are the app\'s, and the row is capped like any layout row', () => {
  assert.equal(MAX_ARRANGEMENTS, 12);
  assert.equal(MAX_ARRANGEMENTS_BYTES, LAYOUT_MAX_BYTES);
  assert.equal(arrangementHref('abc-1'), '/islands/abc-1');
});

test('reading drops what the app would drop, and keeps a tree as stored', () => {
  const raw = {
    v: 1,
    arrangements: [
      { id: 'ok-1', name: 'Code', createdAt: 5, tree: split, menu: true },
      { id: 'ok-1', name: 'Twice', tree: split },
      { id: 'bad id', name: 'Space', tree: split },
      { id: 'x'.repeat(65), name: 'Long', tree: split },
      { id: 'no-name', name: '  ', tree: split },
      { id: 'no-tree', name: 'T', tree: { v: 2 } },
      'garbage',
      { id: 'ok-2', name: 'Review', createdAt: 'yesterday', tree: pageOnly },
    ],
  };
  const list = readArrangements(raw);
  assert.deepEqual(list.map((a) => a.id), ['ok-1', 'ok-2']);
  assert.deepEqual(list[0], { id: 'ok-1', name: 'Code', createdAt: 5, tree: split, menu: true });
  assert.deepEqual([list[1]!.createdAt, list[1]!.menu], [0, false]);
  assert.deepEqual(readArrangements(JSON.parse(writeArrangements(list))), list);
  assert.deepEqual(readArrangements(null), []);
});

test('a tree showing the page alone, or nothing readable, is empty; a popup is not', () => {
  assert.equal(isEmptyStoredTree(pageOnly), true);
  assert.equal(isEmptyStoredTree(null), true);
  assert.equal(isEmptyStoredTree({ v: 1, root: 'nope' }), true);
  assert.equal(isEmptyStoredTree(split), false);
  assert.equal(isEmptyStoredTree({ v: 1, root: leaf('a', 'host:route', 'x:term'), focus: 'a' }), false);
  assert.equal(isEmptyStoredTree({ ...pageOnly, floats: [{ leaf: leaf('f', 'x:term'), rect: { x: 0, y: 0, width: 0.3, height: 0.3 } }] }), false);
});

test('saving: a name, a tree, no twin, twelve at most, under 64 KiB', () => {
  assert.deepEqual(saveArrangement([], '   ', split, opts('a')), { ok: false, error: 'empty-name' });
  assert.deepEqual(saveArrangement([], 'Code', pageOnly, opts('a')), { ok: false, error: 'empty-tree' });
  const first = saveArrangement([], '  Deep   work  ', split, opts('a'));
  assert.ok(first.ok);
  assert.deepEqual(first.arrangement, { id: 'a', name: 'Deep work', createdAt: 1000, tree: split, menu: false });
  assert.equal(first.replaced, false);
  // Case and accents fold, as in the menu.
  assert.deepEqual(saveArrangement(first.arrangements, 'DÉEP WORK', split, opts('b')), { ok: false, error: 'duplicate-name' }); // french-ok: an accented name the comparison folds
  const full = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, name: `n${i}`, createdAt: 0, tree: split, menu: false }));
  assert.deepEqual(saveArrangement(full, 'thirteenth', split, opts('c')), { ok: false, error: 'too-many' });
  const heavy = { ...split, pad: 'x'.repeat(40 * 1024) };
  const once = saveArrangement([], 'heavy', heavy, opts('h1'));
  assert.ok(once.ok);
  assert.deepEqual(saveArrangement(once.arrangements, 'heavier', heavy, opts('h2')), { ok: false, error: 'too-large' });
});

test('replace gives the existing arrangement a new tree and keeps its id, name, date and menu entry', () => {
  const list = [{ id: 'keep', name: 'Code', createdAt: 7, tree: split, menu: true }];
  const tree = { ...split, focus: 'b' };
  const out = saveArrangement(list, 'code', tree, opts('new', true));
  assert.ok(out.ok);
  assert.equal(out.replaced, true);
  assert.deepEqual(out.arrangement, { id: 'keep', name: 'Code', createdAt: 7, tree, menu: true });
  assert.equal(out.arrangements.length, 1);
  // A full list still takes a replacement: it adds nothing.
  const full = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, name: `n${i}`, createdAt: 0, tree: split, menu: false }));
  assert.ok(saveArrangement(full, 'n3', tree, opts('x', true)).ok);
});

test('a layout becomes a stored tree: fresh ids, ratios summing to 1, the focus where the path says', () => {
  const tree = storedTreeFromLayout({
    root: { dir: 'row', ratios: [2, 1], children: [{ tabs: [{ type: 'host:route' }] }, { tabs: [{ type: 'x:a' }, { type: 'x:b', params: { k: 1 } }], active: 1 }] },
    focus: [1],
  }) as { v: number; focus: string; root: { kind: string; ratios: number[]; children: Array<{ id: string; tabs: Array<{ id: string; content: unknown }>; active: string }> } };
  assert.equal(tree.v, 1);
  assert.equal(tree.root.kind, 'split');
  assert.deepEqual(tree.root.ratios.map((r) => Math.round(r * 300)), [200, 100]);
  const [page, side] = tree.root.children;
  assert.equal(tree.focus, side!.id);
  assert.equal(side!.active, side!.tabs[1]!.id);
  assert.deepEqual(side!.tabs[1]!.content, { type: 'x:b', params: { k: 1 } });
  assert.deepEqual(page!.tabs[0]!.content, { type: 'host:route', params: {} });
  const ids = [page!.id, side!.id, ...page!.tabs.map((t) => t.id), ...side!.tabs.map((t) => t.id)];
  for (const id of ids) assert.match(id, /^[a-z0-9]{8}$/);
  assert.equal(new Set(ids).size, ids.length);
  // No focus given: the page's island, as the card applying the same layout would.
  const plain = storedTreeFromLayout({ root: { dir: 'column', children: [{ tabs: [{ type: 'x:a' }] }, { tabs: [{ type: 'host:route' }] }] } }) as { focus: string; root: { children: Array<{ id: string }> } };
  assert.equal(plain.focus, plain.root.children[1]!.id);
  assert.equal(isEmptyStoredTree(plain), false);
});

test('a summary counts islands, popups and tabs, and names each content once', () => {
  const tree = {
    ...split,
    root: { ...split.root, children: [leaf('a', 'host:route', 'x:term'), leaf('b', 'x:term', 'x:doc')] },
    floats: [{ leaf: leaf('f', 'x:chat'), rect: { x: 0, y: 0, width: 0.3, height: 0.3 } }],
  };
  assert.deepEqual(summariseArrangement(tree, (t) => (t === 'x:term' ? 'Terminal' : null)), {
    islands: 2,
    popups: 1,
    tabs: 5,
    contents: [{ type: 'x:term', title: 'Terminal' }, { type: 'x:doc', title: null }, { type: 'x:chat', title: null }],
  });
});
