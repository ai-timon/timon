// french-ok-file: idea texts as a French user types them
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientRealtime } from './plugin-host/realtime';

type Idea = { id: number; status: string; urgency: string | null; project?: string | null };

/**
 * The daemon's answer, as `GET /api/project-todo` writes it: rows of the
 * requested status and types, capped at `limit` (200 by default), with counts
 * that are not. A fake that sent every row would hide the very bug of a tile
 * counting what it received.
 */
function daemon(url: string, items: readonly Idea[]): Response {
  const q = new URL(url, 'http://localhost').searchParams;
  const status = q.get('status');
  const types = q.get('urgency')?.split(',') ?? null;
  const limit = Number(q.get('limit') ?? 200);
  const key = (i: Idea) => i.urgency ?? 'none';
  const keys = ['critical', 'bug', 'minor', 'idea', 'none'];
  const zero = () => Object.fromEntries(keys.map((k) => [k, 0])) as Record<string, number>;
  const counts = {
    byStatus: { open: 0, done: 0, promoted: 0 } as Record<string, number>,
    byUrgency: { open: zero(), done: zero(), promoted: zero() } as Record<string, Record<string, number>>,
  };
  for (const i of items) {
    counts.byUrgency[i.status]![key(i)]! += 1;
    if (!types || types.includes(key(i))) counts.byStatus[i.status]! += 1;
  }
  const matching = items.filter((i) => (!status || status === 'all' || i.status === status) && (!types || types.includes(key(i))));
  return Response.json({ items: matching.slice(0, limit), counts, truncated: matching.length > limit });
}

/**
 * The hard rule of "Project TO DO": with no resolved project, it lists NOTHING.
 *
 * It is the only behavioural invariant of part 4/4, and it hangs on a
 * boolean. A tile that fell back to the whole notebook would show the ideas
 * of all the OTHER projects under a header that promises one — nothing at build
 * time would say so, hence this test.
 */
async function mountTile(scope: unknown, calls: string[], realtime: ClientRealtime = {
  subscribe: () => () => {},
}, items: Idea[] = [], opts: { layout?: unknown; editing?: boolean } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  install('fetch', async (input: string) => {
    // The display options live in a layout scope, not in the notebook.
    if (String(input).startsWith('/api/ui/layout')) return Response.json({ layout: opts.layout ?? null });
    calls.push(String(input));
    return daemon(String(input), items);
  });
  const { ProjectTodoTile } = await import('../plugins-client/kanban/project-todo-tile');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(ProjectTodoTile, {
      scope, titre: 'Project TO DO', handle: null, realtime, editing: opts.editing ?? false,
    } as never));
  });
  return { React, root, dom };
}

test('with no resolved project, "Project TO DO" calls nothing and says so', async () => {
  const calls: string[] = [];
  const { React, root } = await mountTile({ kind: 'project', slug: null }, calls);
  assert.deepEqual(calls, [], 'no call: not even the whole notebook');
  assert.match(document.body.textContent!, /Choose a project/);
  // The input gesture waits for the project: an idea created there would have no project,
  // hence be invisible from the tile that created it.
  const addButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add');
  assert.equal(addButton?.disabled, true, 'the popup button waits for the project');
  assert.ok(!document.querySelector('input'), 'no more inline input: everything goes through the popup');
  await React.act(async () => { root.unmount(); });
});

test('with a project, the list is filtered on it', async () => {
  const calls: string[] = [];
  const { React, root } = await mountTile({ kind: 'project', slug: 'timon' }, calls);
  assert.deepEqual(calls, ['/api/ui/project-todo?status=open&project=timon&limit=500']);
  const addButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add');
  assert.equal(addButton?.disabled, false);
  await React.act(async () => { root.unmount(); });
});

test('the general tile lists the whole notebook', async () => {
  const calls: string[] = [];
  const { React, root } = await mountTile({ kind: 'all' }, calls);
  assert.deepEqual(calls, ['/api/ui/project-todo?status=open&limit=500']);
  await React.act(async () => { root.unmount(); });
});


test('realtime reloads the scoped tile and unsubscribes on unmount', async (t) => {
  let handler: ((payload: unknown) => void) | undefined;
  let unsubscribed = false;
  const calls: string[] = [];
  const { React, root } = await mountTile({ kind: 'project', slug: 'timon' }, calls, {
    subscribe(topic, listener) {
      assert.equal(topic, 'project-todo.changed');
      handler = listener;
      return () => { unsubscribed = true; };
    },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await React.act(async () => {
    handler?.({ id: 1 });
    handler?.({ id: 2 });
    t.mock.timers.tick(150);
  });
  assert.deepEqual(calls, Array(2).fill('/api/ui/project-todo?status=open&project=timon&limit=500'));
  handler?.({ id: 3 });
  await React.act(async () => { root.unmount(); });
  assert.equal(unsubscribed, true);
  t.mock.timers.tick(150);
  assert.equal(calls.length, 2);
});

test('type chips narrow the list, Open/Done count the selected types', async () => {
  const idea = (id: number, text: string, urgency: string | null, status = 'open') => ({
    id, text, urgency, status, project: 'timon', author: null, notes: null, progress: null,
  });
  const { React, root } = await mountTile({ kind: 'project', slug: 'timon' }, [], undefined, [
    idea(1, 'crash au démarrage', 'bug'),
    idea(2, 'mode sombre', 'idea'),
    idea(3, 'sans étiquette', null),
    idea(4, 'vieux bug', 'bug', 'done'),
  ]);
  const rows = () => Array.from(document.querySelectorAll('li')).map((li) => li.textContent);
  // A type chip shows icon + count: its label lives in `aria-label` / `title`.
  const chip = (label: string) => Array.from(document.querySelectorAll('[role=group] button'))
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent)?.startsWith(label)) as HTMLButtonElement;
  assert.equal(rows().length, 3, 'no chip pressed: every open idea');
  // The id is how agents name an idea in their reports ("#209"): each line shows it.
  assert.deepEqual(rows().map((l) => l!.match(/#\d+/)?.[0]), ['#1', '#2', '#3']);
  assert.ok(!chip('Critical'), 'a type absent from the view gets no chip');
  assert.equal(chip('Bug').getAttribute('aria-label'), 'Bug — 1');
  assert.equal(chip('Bug').title, 'Bug');
  assert.equal(chip('No type').getAttribute('aria-label'), 'No type — 1');
  const typeRow = document.querySelector('[role=group][aria-label="Filter by type"]')!;
  assert.doesNotMatch(typeRow.textContent!, /Bug|Idea|No type/, 'no label text in the type row');

  await React.act(async () => { chip('Bug').click(); });
  assert.equal(chip('Bug').getAttribute('aria-pressed'), 'true');
  assert.equal(rows().length, 1);
  assert.match(rows()[0]!, /crash au démarrage/);
  assert.match(chip('Open').textContent!, /1$/);
  assert.match(chip('Done').textContent!, /1$/);

  await React.act(async () => { chip('No type').click(); });
  assert.equal(rows().length, 2, 'chips add up');

  await React.act(async () => { chip('Bug').click(); chip('No type').click(); chip('Idea').click(); });
  await React.act(async () => { chip('Done').click(); });
  assert.match(document.body.textContent!, /No idea of this type/);
  const showAll = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Show all types')!;
  await React.act(async () => { showAll.click(); });
  assert.equal(rows().length, 1);
  assert.match(rows()[0]!, /vieux bug/);
  await React.act(async () => { root.unmount(); });
});

test('number and author are grey badges, each one can be hidden per widget', async () => {
  const idea = { id: 203, text: 'skill plugin', urgency: 'idea', status: 'open', project: 'timon', author: 'user', notes: null, progress: null };
  const row = () => document.querySelector('li')!.textContent!;
  const options = () => document.querySelector('button[aria-label="Display options"]');

  let tile = await mountTile({ kind: 'project', slug: 'timon' }, [], undefined, [idea]);
  await tile.React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.match(row(), /#203/);
  // The cockpit signs an idea `user`, shown as "You" (todoAuthorLabel).
  assert.match(row(), /You/);
  assert.equal(options(), null, 'the options only show while the layout is edited');
  await tile.React.act(async () => { tile.root.unmount(); });

  tile = await mountTile({ kind: 'project', slug: 'timon' }, [], undefined, [idea], {
    editing: true,
    // Hidden for "Project TO DO" only: the other widget's setting does not apply here.
    layout: { v: 1, project: { showId: false, showAuthor: false }, all: { showId: true, showAuthor: true } },
  });
  await tile.React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.doesNotMatch(row(), /#203/);
  assert.doesNotMatch(row(), /You/);
  assert.ok(options(), 'edit mode offers the display options');
  await tile.React.act(async () => { tile.root.unmount(); });
});

test('past one page of open ideas, Done still counts and opens the done ones', async () => {
  // The bug seen on a real notebook: 221 open ideas and 737 done showed
  // "Open 200 · Done 0", the button greyed out.
  const ideas: Idea[] = [
    ...Array.from({ length: 221 }, (_, n) => ({ id: n + 1, status: 'open', urgency: n < 21 ? 'bug' : null, project: 'timon' })),
    ...Array.from({ length: 737 }, (_, n) => ({ id: 1000 + n, status: 'done', urgency: null, project: 'timon' })),
  ].map((i) => ({ ...i, text: `idée ${i.id}`, author: null, notes: null, progress: null }));
  const calls: string[] = [];
  const { React, root } = await mountTile({ kind: 'project', slug: 'timon' }, calls, undefined, ideas);
  const button = (label: string) => Array.from(document.querySelectorAll('[role=group] button'))
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent)?.startsWith(label)) as HTMLButtonElement;
  assert.match(button('Open').textContent!, /221$/);
  assert.match(button('Done').textContent!, /737$/);
  assert.equal(button('Done').disabled, false);
  assert.equal(document.querySelectorAll('li').length, 221);

  await React.act(async () => { button('Done').click(); });
  assert.equal(calls.at(-1), '/api/ui/project-todo?status=done&project=timon&limit=500');
  assert.equal(document.querySelectorAll('li').length, 500);
  assert.match(document.body.textContent!, /Showing the latest 500 of 737/);

  // A chip narrows on the daemon's side, and the segments follow it.
  await React.act(async () => { button('Open').click(); });
  await React.act(async () => { button('Bug').click(); });
  assert.equal(calls.at(-1), '/api/ui/project-todo?status=open&project=timon&urgency=bug&limit=500');
  assert.equal(document.querySelectorAll('li').length, 21);
  assert.match(button('Open').textContent!, /21$/);
  assert.match(button('Done').textContent!, /0$/);
  await React.act(async () => { root.unmount(); });
});
