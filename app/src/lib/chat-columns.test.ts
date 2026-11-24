import assert from 'node:assert/strict';
import test from 'node:test';

import { LEGACY_LAYOUT_KEY, loadLayout, saveLayout } from './ui-layout-store';
import {
  addTab,
  toggleCollapsed,
  setCollapsed,
  selectTab,
  activeTab,
  tabsOf,
  removeTab,
  columnZoneOf,
  defaultColumns,
  sideOf,
  isCollapsed,
  swapColumns,
  columnsIo,
  readColumns,
  zoneOfSide,
  CHAT_COLUMNS_SCOPE,
  addSecond,
  detachSecond,
  widthOf,
  planRails,
  setWidth,
  secondOf,
  THREAD_MIN,
  WIDTH_MAX,
  WIDTH_MIN,
  type ChatColumns,
} from '../components/chat/chat-columns';

const LEFT = 'chat.left.widget';
const RIGHT = 'chat.right.widget';
const KNOWN = [LEFT, RIGHT] as const;

test('nothing stored: the columns are in their declared order', () => {
  const c = readColumns(null, KNOWN);
  assert.deepEqual(c, { ordre: [LEFT, RIGHT], masquees: [] });
  assert.deepEqual(c, defaultColumns(KNOWN));
});

test('swapping changes the side of the two columns', () => {
  const c = swapColumns(defaultColumns(KNOWN));
  assert.equal(sideOf(c, LEFT), 'right');
  assert.equal(sideOf(c, RIGHT), 'left');
  assert.equal(zoneOfSide(c, 'left'), RIGHT);
  assert.equal(zoneOfSide(c, 'right'), LEFT);
});

test('swapping twice returns to the original order', () => {
  const c = defaultColumns(KNOWN);
  assert.deepEqual(swapColumns(swapColumns(c)), c);
});

test('collapsing follows the zone, not the side: swapping expands nothing', () => {
  const folded = toggleCollapsed(defaultColumns(KNOWN), LEFT);
  const inverse = swapColumns(folded);
  assert.equal(isCollapsed(inverse, LEFT), true);
  assert.equal(isCollapsed(inverse, RIGHT), false);
  // The collapsed column is now the right one.
  assert.equal(sideOf(inverse, LEFT), 'right');
});

test('hiding then showing gives back the original state', () => {
  const c = defaultColumns(KNOWN);
  assert.deepEqual(toggleCollapsed(toggleCollapsed(c, RIGHT), RIGHT), c);
});

test('a collapsed column keeps its place in the order', () => {
  const c = toggleCollapsed(defaultColumns(KNOWN), LEFT);
  assert.deepEqual(c.ordre, [LEFT, RIGHT]);
});

test('a swapped order reads back as is', () => {
  const stored = swapColumns(toggleCollapsed(defaultColumns(KNOWN), RIGHT));
  const reread = readColumns(JSON.parse(JSON.stringify(stored)), KNOWN);
  assert.deepEqual(reread, stored);
});

test('a zone unknown to the storage is ignored', () => {
  const c = readColumns({ ordre: ['chat.disparue', RIGHT], masquees: ['chat.disparue'] }, KNOWN);
  assert.deepEqual(c.ordre, [RIGHT, LEFT]);
  assert.deepEqual(c.masquees, []);
});

test('a known zone missing from the storage goes back to its declared place', () => {
  const c = readColumns({ ordre: [RIGHT] }, KNOWN);
  assert.deepEqual(c.ordre, [RIGHT, LEFT]);
});

test('a duplicate in the storage counts once', () => {
  const c = readColumns({ ordre: [RIGHT, RIGHT, LEFT], masquees: [LEFT, LEFT] }, KNOWN);
  assert.deepEqual(c.ordre, [RIGHT, LEFT]);
  assert.deepEqual(c.masquees, [LEFT]);
});

test('an unreadable value falls back to the defaults instead of breaking', () => {
  for (const raw of [undefined, 42, 'nope', [], { ordre: 'gauche', masquees: 7 }]) {
    assert.deepEqual(readColumns(raw, KNOWN), defaultColumns(KNOWN));
  }
});

test('a zone outside the columns has no side: the chrome reserves nothing', () => {
  assert.equal(sideOf(defaultColumns(KNOWN), 'cockpit.widget'), null);
});

test('the mutations do not change the value they receive', () => {
  const c: ChatColumns = defaultColumns(KNOWN);
  const copy = JSON.parse(JSON.stringify(c)) as ChatColumns;
  swapColumns(c);
  toggleCollapsed(c, LEFT);
  assert.deepEqual(c, copy);
});

test('a single declared column: it is on the left, nothing on the right', () => {
  const c = defaultColumns([LEFT]);
  assert.equal(sideOf(c, LEFT), 'left');
  assert.equal(zoneOfSide(c, 'right'), null);
});

// ── Tabs: a column switches between several widget zones.

test('without a tab, a column shows its own zone', () => {
  const c = defaultColumns(KNOWN);
  assert.deepEqual(tabsOf(c, RIGHT), [RIGHT]);
  assert.equal(activeTab(c, RIGHT), RIGHT);
});

test('opening a tab shows it, under the column that opened it', () => {
  const c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  assert.deepEqual(tabsOf(c, RIGHT), [RIGHT, `${RIGHT}#a`]);
  assert.equal(activeTab(c, RIGHT), `${RIGHT}#a`);
  assert.deepEqual(tabsOf(c, LEFT), [LEFT]);
  assert.equal(columnZoneOf(`${RIGHT}#a`), RIGHT);
  assert.equal(columnZoneOf(RIGHT), RIGHT);
});

test('a suffix already taken, an empty one or an unknown column create nothing', () => {
  const c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  assert.deepEqual(addTab(c, RIGHT, 'a'), c);
  assert.deepEqual(addTab(c, RIGHT, ''), c);
  assert.deepEqual(addTab(c, 'chat.ailleurs', 'b'), c);
});

test('choosing a tab shows it, going back to the first clears the choice', () => {
  const opened = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  const first = selectTab(opened, RIGHT, RIGHT);
  assert.equal(activeTab(first, RIGHT), RIGHT);
  assert.equal(first.actifs, undefined);
  assert.equal(activeTab(selectTab(first, RIGHT, `${RIGHT}#a`), RIGHT), `${RIGHT}#a`);
  // The tab of another column is not a possible choice here.
  assert.equal(activeTab(selectTab(first, RIGHT, `${LEFT}#a`), RIGHT), RIGHT);
});

test('closing the shown tab shows the one before it', () => {
  let c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  c = addTab(c, RIGHT, 'b');
  c = removeTab(c, RIGHT, `${RIGHT}#b`);
  assert.equal(activeTab(c, RIGHT), `${RIGHT}#a`);
  c = removeTab(c, RIGHT, `${RIGHT}#a`);
  assert.equal(activeTab(c, RIGHT), RIGHT);
  // Back to a single tab, the column gets back its shape from before the tabs.
  assert.deepEqual(c, defaultColumns(KNOWN));
});

test('the first tab does not close: it is the column', () => {
  const c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  assert.deepEqual(removeTab(c, RIGHT, RIGHT), c);
});

test('swapping and collapsing keep the tabs of each column', () => {
  let c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  c = addTab(c, LEFT, 'b');
  c = selectTab(c, LEFT, LEFT);
  const after = toggleCollapsed(swapColumns(c), RIGHT);
  assert.deepEqual(after.onglets, c.onglets);
  assert.deepEqual(after.actifs, c.actifs);
  assert.equal(activeTab(after, RIGHT), `${RIGHT}#a`);
});

test('tabs read back as is', () => {
  let c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  c = addTab(c, RIGHT, 'b');
  c = selectTab(c, RIGHT, `${RIGHT}#a`);
  assert.deepEqual(readColumns(JSON.parse(JSON.stringify(c)), KNOWN), c);
});

test('a tab stored under the wrong column or unreadable is ignored', () => {
  const c = readColumns({
    ordre: [LEFT, RIGHT],
    onglets: { [RIGHT]: [`${LEFT}#x`, `${RIGHT}#`, 7, `${RIGHT}#ok`, `${RIGHT}#ok`], 'chat.disparue': ['chat.disparue#a'] },
    actifs: { [RIGHT]: `${RIGHT}#inconnu`, [LEFT]: 3 },
  }, KNOWN);
  assert.deepEqual(tabsOf(c, RIGHT), [RIGHT, `${RIGHT}#ok`]);
  assert.equal(activeTab(c, RIGHT), RIGHT);
  assert.equal(c.actifs, undefined);
  assert.deepEqual(Object.keys(c.onglets ?? {}), [RIGHT]);
});

// ── Persistence: the columns travel through `ui_layout`, on their own scope.

/** An in-memory daemon, one value per scope. */
function fakeDaemon() {
  const store = new Map<string, unknown>();
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const scope = new URL(url, 'http://x').searchParams.get('scope') ?? 'cockpit';
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ scope, layout: store.get(scope) ?? null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    store.set(scope, JSON.parse(String(init?.body)).layout);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { fetchImpl, store };
}

test('a swapped order survives the round trip through the daemon', async () => {
  const daemon = fakeDaemon();
  const inverse = swapColumns(defaultColumns(KNOWN));

  assert.equal(await saveLayout(inverse, columnsIo({ fetchImpl: daemon.fetchImpl })), true);
  const out = await loadLayout(columnsIo({ fetchImpl: daemon.fetchImpl }));

  assert.equal(out.ok, true);
  assert.deepEqual(readColumns(out.raw, KNOWN), inverse);
  assert.deepEqual([...daemon.store.keys()], [CHAT_COLUMNS_SCOPE], 'the cockpit is not touched');
});

test('the layout left in the browser is never taken as a column order', async () => {
  const daemon = fakeDaemon();
  const cockpit = [{ id: 'agenda', rail: 'gauche', rang: 0, hauteur: 200 }];
  const storage = {
    getItem: (k: string) => (k === LEGACY_LAYOUT_KEY ? JSON.stringify(cockpit) : null),
    removeItem: () => { throw new Error('the cockpit migration must not run here'); },
  };

  const out = await loadLayout(columnsIo({ fetchImpl: daemon.fetchImpl, storage }));

  assert.deepEqual(out, { raw: null, ok: true, migrated: false });
  assert.equal(daemon.store.size, 0, 'nothing was written on the column scope');
});

test('daemon unreachable: the read says so, and nothing is written', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const out = await loadLayout(columnsIo({ fetchImpl }));
  assert.deepEqual(out, { raw: null, ok: false, migrated: false });
  // That `ok: false` is what the hook keeps: without it, the defaults would be
  // saved over an order we only failed to read.
  assert.deepEqual(readColumns(out.raw, KNOWN), defaultColumns(KNOWN));
});

test('width: missing = default, set = clamped, null = back to the default', () => {
  const c = readColumns(null, KNOWN);
  assert.equal(widthOf(c, RIGHT, 300), 300);
  const large = setWidth(c, RIGHT, 455.4);
  assert.equal(widthOf(large, RIGHT, 300), 455);
  assert.equal(widthOf(setWidth(c, RIGHT, 10), RIGHT, 300), WIDTH_MIN);
  assert.equal(widthOf(setWidth(c, RIGHT, 99999), RIGHT, 300), WIDTH_MAX);
  const reset = setWidth(large, RIGHT, null);
  assert.equal(reset.largeurs, undefined, 'back to the default, the stored value regains its old shape');
});

test('width: an unreadable stored value or one outside the columns is ignored', () => {
  const c = readColumns({ largeurs: { [RIGHT]: 'large', [LEFT]: 5000, 'chat.disparue': 400 } }, KNOWN);
  assert.deepEqual(c.largeurs, { [LEFT]: WIDTH_MAX });
});

test('second column: a tab shown alongside, without changing the shown tab', () => {
  const c = selectTab(addTab(readColumns(null, KNOWN), RIGHT, 'a'), RIGHT, RIGHT);
  const s = addSecond(c, RIGHT, 'b');
  assert.equal(secondOf(s, RIGHT), `${RIGHT}#b`);
  assert.deepEqual(tabsOf(s, RIGHT), [RIGHT, `${RIGHT}#a`, `${RIGHT}#b`], 'one tab entry per column');
  assert.equal(activeTab(s, RIGHT), RIGHT);
  assert.equal(secondOf(s, LEFT), null);
  assert.deepEqual(addSecond(s, RIGHT, 'c'), s, 'a single second column per side');
});

test('second column: detaching it leaves it as a tab, closing it forgets it with its width', () => {
  const s = setWidth(addSecond(readColumns(null, KNOWN), LEFT, 'b'), `${LEFT}#b`, 400);
  const detached = detachSecond(s, LEFT);
  assert.equal(secondOf(detached, LEFT), null);
  assert.deepEqual(tabsOf(detached, LEFT), [LEFT, `${LEFT}#b`]);
  const closed = removeTab(s, LEFT, `${LEFT}#b`);
  assert.equal(closed.secondes, undefined);
  assert.equal(closed.largeurs, undefined);
});

test('second column: read back as is, ignored if it does not name a tab', () => {
  const s = addSecond(readColumns(null, KNOWN), RIGHT, 'b');
  assert.deepEqual(readColumns(JSON.parse(JSON.stringify(s)), KNOWN), s);
  const forged = readColumns({ ...s, secondes: { [RIGHT]: `${LEFT}#b`, [LEFT]: 4 } }, KNOWN);
  assert.equal(forged.secondes, undefined);
});

test('swapping keeps the second column and the widths of each zone', () => {
  const s = setWidth(addSecond(readColumns(null, KNOWN), RIGHT, 'b'), RIGHT, 500);
  const inv = swapColumns(s);
  assert.deepEqual(inv.secondes, s.secondes);
  assert.deepEqual(inv.largeurs, s.largeurs);
});

test('plan: original gutter on the left, handle kept clear on the right, at the default widths', () => {
  const plan = planRails(1400, { width: 280, first: true, second: null }, { width: 300, first: true, second: null });
  assert.equal(plan.left?.gutter, 312);
  assert.equal(plan.right?.gutter, 328, 'clears the handle past the column edge');
  assert.equal(plan.slack, 1400 - THREAD_MIN - 640);
});

test('plan: enough room, both columns of each side are laid out', () => {
  const plan = planRails(3000, { width: 300, first: true, second: 300 }, { width: 300, first: true, second: 400 });
  assert.equal(plan.right?.second, 400);
  assert.equal(plan.right?.secondOffset, 312);
  assert.equal(plan.right?.gutter, 16 + 300 + 12 + 400 + 12);
  assert.equal(plan.left?.secondFolded, false);
});

test('plan: too narrow, the second column of the widest side collapses first', () => {
  const g = { width: 300, first: true, second: 300 };
  const d = { width: 300, first: true, second: 400 };
  // Room for one second column, not two.
  const plan = planRails(THREAD_MIN + 644 + 328, g, d);
  assert.equal(plan.right?.second, null);
  assert.equal(plan.right?.secondFolded, true);
  assert.equal(plan.left?.second, 300);
});

test('plan: a second column alone (the empty column) takes the edge, and collapses into the column', () => {
  const alone = planRails(3000, null, { width: 300, first: false, second: 350 });
  assert.equal(alone.right?.first, null);
  assert.equal(alone.right?.secondOffset, 0);
  assert.equal(alone.right?.gutter, 378);
  const foldedBack = planRails(THREAD_MIN + 330, null, { width: 300, first: false, second: 350 });
  assert.equal(foldedBack.right?.first, 300, 'its tab folds back into the column, which shows again');
  assert.equal(foldedBack.right?.second, null);
});

test('plan: narrower still, the widths shrink without going under the minimum', () => {
  const plan = planRails(THREAD_MIN + 700, { width: 500, first: true, second: null }, { width: 500, first: true, second: null });
  assert.ok((plan.left?.first ?? 0) < 500);
  assert.ok((plan.left?.first ?? 0) >= WIDTH_MIN);
  assert.ok((plan.left?.gutter ?? 0) + (plan.right?.gutter ?? 0) <= 700);
  const minuscule = planRails(THREAD_MIN + 100, { width: 500, first: true, second: null }, null);
  assert.equal(minuscule.left?.first, WIDTH_MIN);
  assert.equal(minuscule.slack, 0);
});

test('plan: width not measured yet, everything is laid out as asked', () => {
  const plan = planRails(0, { width: 300, first: true, second: 300 }, null);
  assert.equal(plan.left?.second, 300);
  assert.equal(plan.slack, Number.POSITIVE_INFINITY);
});

test('a tab name survives every mutation, leaves with its tab, and is bounded', async () => {
  const { addTab, readColumns, nameTab, removeTab, swapColumns, TAB_NAME_MAX } = await import('../components/chat/chat-columns');
  const zones = ['chat.left.widget', 'chat.right.widget'];
  let c = addTab(readColumns(null, zones), 'chat.right.widget', 'k1');
  c = nameTab(c, 'chat.right.widget#k1', '  Ops\n  board ');
  assert.equal(c.noms?.['chat.right.widget#k1'], 'Ops board');
  c = swapColumns(c);
  assert.equal(c.noms?.['chat.right.widget#k1'], 'Ops board', 'another mutation keeps the name');
  assert.deepEqual(readColumns(JSON.parse(JSON.stringify(c)), zones).noms, { 'chat.right.widget#k1': 'Ops board' });
  assert.equal(nameTab(c, 'chat.left.widget', 'x'.repeat(60)).noms?.['chat.left.widget']?.length, TAB_NAME_MAX);
  assert.equal(nameTab(c, 'chat.right.widget#k1', null).noms, undefined, 'an unnamed column writes no field');
  assert.equal(removeTab(c, 'chat.right.widget', 'chat.right.widget#k1').noms, undefined, 'a closed tab takes its name along');
  assert.equal(readColumns({ noms: { 'chat.left.widget#ghost': 'x' } }, zones).noms, undefined);
});

// TODO #647: a click replayed on another window's write keeps its meaning.
test('collapsing a column already collapsed elsewhere leaves it collapsed', () => {
  const c = defaultColumns(KNOWN);
  const folded = setCollapsed(c, LEFT, true);
  assert.equal(isCollapsed(folded, LEFT), true);
  assert.equal(setCollapsed(folded, LEFT, true), folded);
  assert.deepEqual(setCollapsed(folded, LEFT, false), c);
});

test('a column resized with its mirror: both move by the same amount, held by the first bound', async () => {
  const { pairedWidths, WIDTH_MIN } = await import('../components/chat/chat-columns');
  // Room for 200px more in all: two columns growing at once share it.
  assert.deepEqual(pairedWidths(300, 500, 500, { width: 300, max: 500 }), { width: 400, twin: 400 });
  assert.deepEqual(pairedWidths(300, 340, 500, { width: 280, max: 480 }), { width: 340, twin: 320 }, 'an asymmetry is kept, not erased');
  // Shrinking stops at the floor of whichever reaches it first.
  assert.deepEqual(pairedWidths(300, 100, 500, { width: WIDTH_MIN + 20, max: 500 }), { width: 280, twin: WIDTH_MIN });
});

test('the reading column width is stored clamped, and null gives it back to the room', async () => {
  const { setThreadWidth, readColumns, THREAD_READING_MIN, THREAD_READING_MAX } = await import('../components/chat/chat-columns');
  const zones = ['chat.left.widget', 'chat.right.widget'];
  const base = readColumns({}, zones);
  assert.equal(base.fil, undefined);
  assert.equal(setThreadWidth(base, 900).fil, 900);
  assert.equal(setThreadWidth(base, 10).fil, THREAD_READING_MIN);
  assert.equal(setThreadWidth(base, 99999).fil, THREAD_READING_MAX);
  assert.equal(setThreadWidth(setThreadWidth(base, 900), null).fil, undefined);
  // Read back from storage, and dropped when unreadable.
  assert.equal(readColumns({ fil: 1000 }, zones).fil, 1000);
  assert.equal(readColumns({ fil: 'wide' }, zones).fil, undefined);
});
