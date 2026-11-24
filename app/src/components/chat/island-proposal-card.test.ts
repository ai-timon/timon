/**
 * The shared proposal card, for an island layout: the schematic shows the
 * workspace the proposal makes, and Apply claims first, then writes the view's
 * `.islands` row and announces a recall — the mounted workspace re-reads it,
 * no reload.
 */
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import test, { type TestContext } from 'node:test';
import { toast } from 'sonner';
import { defaultIslandTree, insertAt, type IslandParams, type IslandTree } from '@/lib/island-tree';
import type { LayoutProposalView } from '@/lib/layout-proposals';
import { killTerminalOfTab } from '@/lib/terminal-island-params';

const TERMINAL = '@timon/terminal-web:session';
const proposal = (over: Partial<LayoutProposalView> = {}): LayoutProposalView => ({
  id: 'i1', kind: 'islands', missionId: 'm1', agent: 'timon.coder',
  payload: { view: '/kanban', project: null, open: { content: { type: TERMINAL, params: { sessionId: 's1' } }, edge: 'right' } },
  note: 'A shell beside the board', project: null, missionTitle: 'Arrange', taskId: null,
  status: 'pending', createdAt: 1, resolvedAt: null, ...over,
});

type Call = { method: string; url: string; body?: unknown };

type Screen = { view: string; project?: string | null; tree: IslandTree };
type MountOptions = {
  /** Stored rows, by view. */
  rows?: readonly Screen[];
  /** The workspace on screen, its `viewKey` the one the card computes for that view. */
  screen?: Screen;
  failWrites?: boolean;
  /** The account's named arrangements row. */
  arrangements?: unknown[];
  /** The daemon refuses the claim: what it checks again changed since the proposal. */
  staleClaim?: { code: string; message: string };
};

const keyOf = async (screen: Screen) => (await import('@/lib/workspace-scope')).workspaceScope('user-1', screen.view, screen.project ?? null);

async function mount(ctx: TestContext, options: MountOptions = {}) {
  const stored = new Map<string, unknown>();
  for (const row of options.rows ?? []) stored.set(`${await keyOf(row)}.islands`, row.tree);
  const arrangementsScope = await (await import('@/lib/workspace-scope')).sharedArrangementsScope('user-1');
  if (options.arrangements) stored.set(arrangementsScope, { v: 1, arrangements: options.arrangements });
  let rendered: LayoutProposalView | null = null;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'MutationObserver']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 1200, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => 800, configurable: true });
  const calls: Call[] = [];
  install('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url === '/api/ui/auth/me') return new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 200 });
    if (url.includes('/resolve')) {
      const { decision } = JSON.parse(String(init!.body)) as { decision: 'applied' | 'dismissed' };
      if (options.staleClaim && decision === 'applied') {
        return new Response(JSON.stringify({ error: 'stale', problems: [options.staleClaim] }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true, proposal: { ...(rendered ?? proposal()), status: decision, resolvedAt: 2 } }), { status: 200 });
    }
    if (url.startsWith('/api/ui/layout/proposals')) return new Response(JSON.stringify({ proposals: [] }), { status: 200 });
    if (options.failWrites && method === 'PUT') return new Response(JSON.stringify({ error: 'no' }), { status: 500 });
    if (method === 'PUT' || method === 'DELETE') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    const scope = new URL(url, 'http://localhost').searchParams.get('scope') ?? '';
    return new Response(JSON.stringify({ layout: stored.get(scope) ?? null }), { status: 200 });
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  slots.declareSlot('island.content', 'list');
  slots.register({
    slot: 'island.content', pluginId: '@timon/terminal-web', key: 'session',
    island: {
      title: 'Terminal',
      // Stricter than any declaration the daemon could check: the browser has the last word.
      parseParams: (raw) => {
        const id = (raw as { sessionId?: unknown })?.sessionId;
        return typeof id === 'string' && /^[A-Za-z0-9]+$/.test(id) ? { scope: null, sessionId: id } : null;
      },
      singletonBy: 'sessionId',
      onClose: killTerminalOfTab,
    },
  }, () => null);
  // A document with unsaved changes: it asks before leaving.
  const guard = { keep: false, asked: 0 };
  slots.register({
    slot: 'island.content', pluginId: 'fixture', key: 'doc',
    island: {
      title: 'Document',
      parseParams: (raw) => raw as IslandParams,
      beforeClose: () => { guard.asked += 1; return !guard.keep; },
    },
  }, () => null);
  const { createRoot } = await import('react-dom/client');
  const { LayoutProposalCard } = await import('./layout-proposal-card');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('@/components/workspace-layout-provider');
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  let recalls = 0;
  dom.window.addEventListener('timon:layout-recalled', () => { recalls += 1; });
  // A pending card reads the mission's proposals once: wait for that read.
  const render = async (view: LayoutProposalView) => {
    rendered = view;
    // The schematic reads the row of the account the provider resolves.
    await act(() => {
      root.render(React.createElement(PathnameContext.Provider, { value: '/chat' },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() as never },
          React.createElement(WorkspaceLayoutProvider, null,
            React.createElement(LayoutProposalCard, { proposal: view, time: '12:00', owner: 'user-1' })))));
    });
    await until(() => calls.some((c) => c.url.startsWith('/api/ui/layout/proposals')), 'the card to read the mission\'s proposals');
    await until(() => true, 'the card to apply what it read');
  };
  // The real workspace, whose release the card goes through: only its tree is given.
  let screenRoot: ReturnType<typeof createRoot> | null = null;
  if (options.screen) {
    const { IslandWorkspaceView } = await import('@/components/islands/island-workspace');
    const viewKey = await keyOf(options.screen);
    const host = document.createElement('div');
    document.body.appendChild(host);
    screenRoot = createRoot(host);
    await act(() => {
      screenRoot!.render(React.createElement(IslandWorkspaceView, {
        tree: options.screen!.tree, onTree: () => {}, route: React.createElement('div'), announce: true, viewKey,
      }));
    });
  }
  const toasts = ctx.mock.method(toast, 'error', () => '');
  ctx.after(async () => {
    await act(() => root.unmount());
    if (screenRoot) await act(() => screenRoot!.unmount());
    slots.resetSlotsForTests();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-decision]')).map((b) => b.dataset.decision);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  // A click that must change nothing (a refused content) only lets one turn pass.
  const click = async (decision: string, done: () => boolean = () => true, what = `"${decision}" to take effect`) => {
    await act(() => { document.querySelector<HTMLButtonElement>(`button[data-decision="${decision}"]`)!.click(); });
    await until(done, what);
  };
  const kills = () => calls.flatMap((c, i) => (c.method === 'DELETE' && c.url.includes('/terminal/') ? [{ session: c.url.split('/').at(-1)!, at: i }] : []));
  const writes = () => calls.filter((c) => (c.method === 'PUT' || c.method === 'DELETE') && c.url.includes('.islands'));
  const claims = () => calls.filter((c) => c.url.includes('/resolve'));
  const toastsShown = () => toasts.mock.calls.map((call) => String(call.arguments[0]));
  const forgetArrangements = () => { stored.set(arrangementsScope, { v: 1, arrangements: [] }); };
  return { render, buttons, click, until, calls, recalls: () => recalls, guard, kills, writes, claims, toastsShown, forgetArrangements };
}

test('the schematic shows the page and the new island beside it', async (t) => {
  const w = await mount(t);
  await w.render(proposal());
  assert.deepEqual(w.buttons(), ['applied', 'dismissed']);
  assert.match(document.body.textContent ?? '', /A shell beside the board/);
  assert.match(document.body.textContent ?? '', /Terminal opens in a new island on the right/);
  const islands = Array.from(document.querySelectorAll<HTMLElement>('[data-island-preview]')).map((el) => el.dataset.islandPreview);
  assert.deepEqual(islands, ['kept', 'new']);
});

test('Apply claims first, then writes the view\'s islands row and announces a recall', async (t) => {
  const w = await mount(t);
  await w.render(proposal());
  await w.click('applied', () => w.recalls() > 0 && w.buttons().length === 0, 'Apply to write and announce a recall');
  const resolveAt = w.calls.findIndex((c) => c.url.includes('/resolve'));
  const put = w.calls.findIndex((c) => c.method === 'PUT' && c.url.includes('.islands'));
  assert.ok(resolveAt >= 0 && put > resolveAt, 'the claim precedes the write');
  const tree = (w.calls[put]!.body as { layout: { v: number; root: { kind: string; dir: string; children: Array<{ tabs: Array<{ content: { type: string } }> }> } } }).layout;
  assert.equal(tree.v, 1);
  assert.equal(tree.root.kind, 'split');
  assert.equal(tree.root.dir, 'row');
  assert.deepEqual(tree.root.children.map((c) => c.tabs[0]!.content.type), ['host:route', TERMINAL]);
  assert.equal(w.recalls(), 1);
  assert.deepEqual(w.buttons(), []);
});

test('Ignore writes nothing', async (t) => {
  const w = await mount(t);
  await w.render(proposal({ id: 'i2' }));
  await w.click('dismissed', () => w.calls.some((c) => c.url.includes('/resolve')), 'Ignore to be recorded');
  await w.until(() => true, 'the dismissal to settle');
  assert.equal(w.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('a content its type refuses is caught before the claim: nothing is sent, the card stays pending', async (t) => {
  const w = await mount(t);
  await w.render(proposal({
    id: 'i3',
    payload: { view: '/kanban', project: null, open: { content: { type: TERMINAL, params: { sessionId: 'a b' } }, edge: 'right' } },
  }));
  await w.click('applied');
  assert.equal(w.calls.filter((c) => c.url.includes('/resolve')).length, 0, 'no claim');
  assert.equal(w.calls.filter((c) => c.method === 'PUT').length, 0, 'no write');
  assert.deepEqual(w.buttons(), ['applied', 'dismissed']);
});

test('the card names the view, the chat included, even without its nav entry', async () => {
  const { routeTitle } = await import('./island-proposal-kind');
  assert.equal(routeTitle('/chat'), 'Chat');
  assert.equal(routeTitle('/chat/timon.coder'), 'Chat');
  assert.equal(routeTitle('/'), 'Cockpit');
  assert.equal(routeTitle('/kanban'), 'Kanban');
  assert.equal(routeTitle('/terminal'), 'Terminal');
  assert.equal(routeTitle('/somewhere'), 'Page');
});

const ROUTE = { type: 'host:route' };
const shell = (sessionId: string) => ({ type: TERMINAL, params: { scope: null, sessionId } });
const DOC = { type: 'fixture:doc', params: { id: 'd1' } };

/** The page with one island beside it for each content. */
function treeWith(...contents: { type: string; params: IslandParams }[]): IslandTree {
  let tree = defaultIslandTree();
  for (const content of contents) tree = insertAt(tree, tree.focus!, 'right', content).tree;
  return tree;
}

const layoutOf = (...contents: { type: string; params?: IslandParams }[]) => ({
  root: { dir: 'row', children: [ROUTE, ...contents].map((content) => ({ tabs: [content] })) },
});
const replacing = (id: string, over: Record<string, unknown>) => proposal({ id, payload: { view: '/kanban', project: null, layout: layoutOf(shell('s2')), ...over } });

test('the terminal a proposal replaces ends its shell, once the row is written', async (t) => {
  const screen = { view: '/kanban', tree: treeWith(shell('s1')) };
  const w = await mount(t, { rows: [screen], screen });
  await w.render(replacing('r1', {}));
  await w.until(() => /Applying closes: Terminal/.test(document.body.textContent ?? ''), 'the card to say what it closes');
  assert.deepEqual(w.kills(), [], 'the card alone ends nothing');
  await w.click('applied', () => w.recalls() > 0, 'Apply to write and announce a recall');
  const put = w.calls.findIndex((c) => c.method === 'PUT' && c.url.includes('.islands'));
  assert.deepEqual(w.kills().map((k) => k.session), ['s1'], 'the replaced session, not the one it brings');
  assert.ok(put >= 0 && w.kills()[0]!.at > put, 'the shell ends after the write');
});

test('a session the proposal lays back keeps its shell, under the page or elsewhere', async (t) => {
  const screen = { view: '/kanban', tree: treeWith(shell('s1')) };
  const w = await mount(t, { rows: [screen], screen });
  await w.render(replacing('r2', { layout: { root: { tabs: [ROUTE, shell('s1')] } } }));
  await w.until(() => document.querySelector('[data-island-preview="kept"]') !== null, 'the schematic to read the row');
  assert.ok(!document.querySelector('[data-proposal-closes]'), 'nothing announced');
  await w.click('applied', () => w.recalls() > 0, 'Apply to write');
  assert.equal(w.writes().length, 1);
  assert.deepEqual(w.kills(), []);
});

test('a tab that asks to stay refuses the card: no claim, no write, no shell ended, and Apply stays offered', async (t) => {
  const screen = { view: '/kanban', tree: treeWith(shell('s1'), DOC) };
  const w = await mount(t, { rows: [screen], screen });
  await w.render(replacing('r3', {}));
  w.guard.keep = true;
  await w.click('applied', () => w.toastsShown().length > 0, 'the refusal to be told');
  assert.match(w.toastsShown()[0]!, /a tab it would close stayed open/);
  assert.equal(w.guard.asked, 1);
  assert.deepEqual(w.claims(), [], 'the agent is not told "applied"');
  assert.deepEqual(w.writes(), []);
  assert.deepEqual(w.kills(), []);
  assert.equal(w.recalls(), 0);
  assert.deepEqual(w.buttons(), ['applied', 'dismissed'], 'still pending: save the document, Apply again');

  w.guard.keep = false;
  await w.click('applied', () => w.recalls() > 0, 'the second Apply to go through');
  assert.equal(w.guard.asked, 2, 'asked once per click: the write does not ask again');
  assert.equal(w.claims().length, 1);
  assert.deepEqual(w.kills().map((k) => k.session), ['s1']);
});

test('a write that fails ends no shell: the tab is still in the row', async (t) => {
  const screen = { view: '/kanban', tree: treeWith(shell('s1')) };
  const w = await mount(t, { rows: [screen], screen, failWrites: true });
  await w.render(replacing('r4', {}));
  await w.click('applied', () => w.recalls() > 0, 'Apply to try and announce');
  assert.equal(w.writes().length > 0, true, 'the write was attempted');
  assert.deepEqual(w.kills(), []);
});

test('back to the page alone: the row is erased, and the shell ended as well', async (t) => {
  const screen = { view: '/kanban', tree: treeWith(shell('s1')) };
  const w = await mount(t, { rows: [screen], screen });
  await w.render(replacing('r5', { layout: { root: { tabs: [ROUTE] } } }));
  await w.click('applied', () => w.recalls() > 0, 'Apply to erase');
  assert.deepEqual(w.writes().map((c) => c.method), ['DELETE'], 'the default tree is never stored');
  assert.deepEqual(w.kills().map((k) => k.session), ['s1']);
});

test('a view not on screen ends what it replaces too: told, asked first, ended once its row is written', async (t) => {
  const screen = { view: '/kanban', tree: treeWith(shell('s1')) };
  const elsewhere = { view: '/', tree: treeWith(shell('s9'), DOC) };
  const w = await mount(t, { rows: [screen, elsewhere], screen });
  await w.render(replacing('r6', { view: '/' }));
  await w.until(() => /Applying closes: Terminal, Document/.test(document.body.textContent ?? ''), 'the card to say what it closes there');
  w.guard.keep = true;
  await w.click('applied', () => w.toastsShown().length > 0, 'the refusal to be told');
  assert.equal(w.guard.asked, 1, 'the document of that view is asked, though not mounted');
  assert.deepEqual(w.claims(), [], 'no claim');
  assert.deepEqual(w.writes(), [], 'no write');
  assert.deepEqual(w.kills(), [], 'no shell ended');

  w.guard.keep = false;
  await w.click('applied', () => w.recalls() > 0, 'Apply to write the other view');
  assert.equal(w.writes().length, 1);
  const row = `${await keyOf(elsewhere)}.islands`;
  const put = w.calls.findIndex((c) => c.method === 'PUT' && c.url.includes(row));
  assert.deepEqual(w.kills().map((k) => k.session), ['s9'], 'its own shell, never the one on screen');
  assert.ok(put >= 0 && w.kills()[0]!.at > put, 'after the write of its row');
});

test('a session the screen still shows is never ended from another view, and the card does not say it would be', async (t) => {
  const screen = { view: '/kanban', tree: treeWith(shell('s1')) };
  const elsewhere = { view: '/', tree: treeWith(shell('s1')) };
  const w = await mount(t, { rows: [screen, elsewhere], screen });
  await w.render(replacing('r8', { view: '/' }));
  await w.until(() => document.querySelector('[data-island-preview="new"]') !== null, 'the schematic to read the row');
  assert.ok(!document.querySelector('[data-proposal-closes]'), 'nothing announced');
  await w.click('applied', () => w.recalls() > 0, 'Apply to write the other view');
  assert.equal(w.writes().length, 1);
  assert.deepEqual(w.kills(), []);
});

test('no workspace on screen: a view\'s stored row still tells what closes, and that is what ends', async (t) => {
  const elsewhere = { view: '/kanban', tree: treeWith(shell('s4')) };
  const w = await mount(t, { rows: [elsewhere] });
  await w.render(replacing('r9', {}));
  await w.until(() => /Applying closes: Terminal/.test(document.body.textContent ?? ''), 'the card to say what it closes');
  await w.click('applied', () => w.recalls() > 0, 'Apply to write');
  assert.deepEqual(w.kills().map((k) => k.session), ['s4']);
});

test('every project of the card says what it closes there, and ends it after its own row', async (t) => {
  const own = { view: '/kanban', tree: treeWith(shell('s0')) };
  const onScreen = { view: '/kanban', project: 'p2', tree: treeWith(shell('s1')) };
  const other = { view: '/kanban', project: 'p3', tree: treeWith(shell('s3')) };
  const w = await mount(t, { rows: [own, onScreen, other], screen: onScreen });
  await w.render(replacing('r10', { also_projects: ['p2', 'p3'] }));
  await w.until(() => document.querySelectorAll('[data-proposal-closes]').length === 3, 'each project to say what it closes');
  const text = document.body.textContent ?? '';
  assert.match(text, /Applying in p2 closes: Terminal/);
  assert.match(text, /Applying in p3 closes: Terminal/);
  await w.click('applied', () => w.recalls() > 2, 'Apply to write the three projects');
  assert.equal(w.writes().length, 3);
  assert.deepEqual(w.kills().map((k) => k.session).sort(), ['s0', 's1', 's3']);
  for (const [row, session] of [[own, 's0'], [onScreen, 's1'], [other, 's3']] as const) {
    const scope = `${await keyOf(row)}.islands`;
    const put = w.calls.findIndex((c) => c.method === 'PUT' && c.url.includes(scope));
    const kill = w.kills().find((k) => k.session === session)!;
    assert.ok(put >= 0 && kill.at > put, `${session} ends after the write of its own row`);
  }
});

test('with other projects, the shell ends with the write of the row on screen', async (t) => {
  const onScreen = { view: '/kanban', project: 'p2', tree: treeWith(shell('s1')) };
  const w = await mount(t, { rows: [onScreen], screen: onScreen });
  await w.render(replacing('r7', { also_projects: ['p2'] }));
  await w.click('applied', () => w.recalls() > 1, 'Apply to write both projects');
  assert.equal(w.writes().length, 2);
  assert.deepEqual(w.kills().map((k) => k.session), ['s1']);
  const row = `${await keyOf(onScreen)}.islands`;
  const put = w.calls.findIndex((c) => c.method === 'PUT' && c.url.includes(row));
  assert.ok(put >= 0 && w.kills()[0]!.at > put, 'after the write of its own row');
});

/* A named arrangement recalled by the card (`islands_propose { arrangement }`). */

const codeScreen = (): IslandTree => treeWith(shell('s2'));
const arrangement = (tree: IslandTree = codeScreen()) => ({ id: 'arr-1', name: 'Code', createdAt: 1, tree, menu: false });
const recall = (id: string, over: Record<string, unknown> = {}) => proposal({
  id, kind: 'island-arrangement', payload: { arrangement: 'arr-1', name: 'Code', view: '/kanban', project: null, ...over },
});

test('a recall card names the arrangement and draws it; Apply claims, then lays it on the view', async (t) => {
  const w = await mount(t, { arrangements: [arrangement()] });
  await w.render(recall('a1'));
  await w.until(() => document.querySelectorAll('[data-island-preview]').length === 2, 'the schematic of the arrangement');
  assert.match(document.body.textContent ?? '', /timon\.coder proposes one of your island arrangements/);
  assert.match(document.body.textContent ?? '', /Arrangement: Code/);
  assert.match(document.body.textContent ?? '', /View: Kanban/);
  await w.click('applied', () => w.recalls() > 0 && w.buttons().length === 0, 'Apply to lay the arrangement');
  const claim = w.calls.findIndex((c) => c.url.includes('/resolve'));
  const put = w.calls.findIndex((c) => c.method === 'PUT' && c.url.includes('.islands'));
  assert.ok(claim >= 0 && put > claim, 'the claim precedes the write');
  const row = `${await keyOf({ view: '/kanban', tree: defaultIslandTree() })}.islands`;
  assert.ok(w.calls[put]!.url.includes(encodeURIComponent(row)) || w.calls[put]!.url.includes(row), 'the view the card names');
  const laid = JSON.stringify(w.calls[put]!.body);
  assert.ok(laid.includes(TERMINAL) && laid.includes('host:route'));
});

test('a recall closes the tabs it replaces once written, asking once', async (t) => {
  const screen = { view: '/kanban', tree: treeWith(shell('s1'), DOC) };
  const w = await mount(t, { rows: [screen], screen, arrangements: [arrangement()] });
  await w.render(recall('a2'));
  await w.until(() => /Applying closes:/.test(document.body.textContent ?? ''), 'the card to say what it closes');
  await w.click('applied', () => w.recalls() > 0, 'Apply to lay it');
  assert.equal(w.guard.asked, 1, 'the question is not put twice');
  const put = w.calls.findIndex((c) => c.method === 'PUT' && c.url.includes('.islands'));
  assert.deepEqual(w.kills().map((k) => k.session), ['s1']);
  assert.ok(w.kills()[0]!.at > put, 'after the write');
});

test('a recall the user cancels (a tab kept) is a refusal: no claim, no write, the card stays pending', async (t) => {
  const screen = { view: '/kanban', tree: treeWith(DOC) };
  const w = await mount(t, { rows: [screen], screen, arrangements: [arrangement()] });
  await w.render(recall('a3'));
  w.guard.keep = true;
  await w.click('applied', () => w.toastsShown().length > 0, 'the refusal to be told');
  assert.match(w.toastsShown()[0]!, /a tab it would close stayed open/);
  assert.deepEqual(w.claims(), []);
  assert.deepEqual(w.writes(), []);
  assert.equal(w.recalls(), 0);
  assert.deepEqual(w.buttons(), ['applied', 'dismissed']);
});

test('an arrangement deleted before the click: a readable refusal, nothing claimed nor written', async (t) => {
  const w = await mount(t, { arrangements: [arrangement()] });
  await w.render(recall('a4'));
  await w.until(() => document.querySelectorAll('[data-island-preview]').length === 2, 'the schematic');
  w.forgetArrangements();
  await w.click('applied', () => w.toastsShown().length > 0, 'the refusal to be told');
  assert.match(w.toastsShown()[0]!, /the arrangement "Code" was deleted, nothing was changed/);
  assert.deepEqual(w.claims(), []);
  assert.deepEqual(w.writes(), []);
  assert.deepEqual(w.buttons(), ['applied', 'dismissed']);
});

test('an arrangement the card cannot find says so in place of its schematic', async (t) => {
  const w = await mount(t, { arrangements: [] });
  await w.render(recall('a5'));
  await w.until(() => document.querySelector('[data-arrangement-gone]') !== null, 'the card to say it is gone');
  assert.match(document.body.textContent ?? '', /Arrangement: Code/);
});

test('deleted between the check and the claim: the daemon refuses, nothing is written', async (t) => {
  const w = await mount(t, {
    arrangements: [arrangement()],
    staleClaim: { code: 'arrangement_deleted', message: 'the arrangement "Code" was deleted since the proposal' },
  });
  await w.render(recall('a6'));
  await w.click('applied', () => w.toastsShown().length > 0, 'the refusal to be told');
  assert.match(w.toastsShown()[0]!, /This arrangement was deleted since the proposal: nothing was changed/);
  assert.equal(w.claims().length, 1);
  assert.deepEqual(w.writes(), []);
  assert.equal(w.recalls(), 0);
});
