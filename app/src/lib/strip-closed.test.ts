import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';
import type { ActiveAgent } from '@/lib/agent-state';
import { CLOSED_TABS_LS, closeTab, isTabClosed, parseClosedTabs, reopenedTabs, withoutTabs } from '@/lib/strip-closed';

/**
 * TODO #338 (the maintainer): closing an agent tab in the top bar did not remove it. The
 * feed shows one mission per agent, and an agent with several (a coder that
 * pilots a series while running a task) alternates between them: the close,
 * keyed on the mission shown, came undone at the next poll.
 */

const CLOSED_AT = 1_000_000;

function tab(mission_id: string, started_at: number | undefined, state: ActiveAgent['state'] = 'thinking'): ActiveAgent {
  return { name: 'timon.coder', state, mission_id, at: started_at ?? 0, started_at, pending_count: 0, project: null };
}

const patched = (a: ActiveAgent, patch: Partial<ActiveAgent>): ActiveAgent => ({ ...a, ...patch });

const closed = closeTab({}, tab('task', CLOSED_AT - 5_000), CLOSED_AT);

test('a closed tab stays closed when its own mission ends', () => {
  assert.equal(isTabClosed(closed, patched(tab('task', CLOSED_AT - 5_000, 'done'), { at: CLOSED_AT + 60_000 })), true);
});

test('a closed tab stays closed when the feed shows another mission already running before the close', () => {
  assert.equal(isTabClosed(closed, tab('pilot', CLOSED_AT - 3_600_000)), true);
});

test('a long mission woken again after the close does not bring the tab back', () => {
  // Each wake is a new turn: `at` moves, the mission start does not.
  assert.equal(isTabClosed(closed, patched(tab('pilot', CLOSED_AT - 3_600_000), { at: CLOSED_AT + 120_000 })), true);
});

test('a mission started after the close brings the tab back, and it stays back once that mission is done', () => {
  const fresh = tab('next-task', CLOSED_AT + 10_000);
  assert.equal(isTabClosed(closed, fresh), false);
  assert.deepEqual(reopenedTabs(closed, [fresh]), ['timon.coder']);
  const after = withoutTabs(closed, reopenedTabs(closed, [fresh]));
  assert.equal(isTabClosed(after, patched(fresh, { state: 'done' })), false);
  assert.equal(isTabClosed(after, tab('pilot', CLOSED_AT - 3_600_000)), false, 'the close is forgotten');
});

test('a close never predates the start of the mission it closes, whatever the clocks say', () => {
  const skewed = closeTab({}, tab('task', CLOSED_AT), CLOSED_AT - 60_000);
  assert.equal(isTabClosed(skewed, tab('task', CLOSED_AT)), true);
});

test('without a mission start (older daemon) the close holds for every mission it saw', () => {
  let tabs = closeTab({}, tab('a', undefined), CLOSED_AT);
  tabs = closeTab(tabs, tab('b', undefined), CLOSED_AT + 1);
  assert.equal(isTabClosed(tabs, tab('a', undefined)), true);
  assert.equal(isTabClosed(tabs, tab('b', undefined)), true);
  assert.equal(isTabClosed(tabs, tab('c', undefined)), false);
});

test('stored closes survive a round trip and garbage reads as none', () => {
  assert.deepEqual(parseClosedTabs(JSON.stringify(closed)), closed);
  assert.deepEqual(parseClosedTabs('not json'), {});
  assert.deepEqual(parseClosedTabs('["timon.coder:task"]'), {}, 'the old list format is ignored');
  assert.deepEqual(parseClosedTabs('{"x":{"at":"soon"},"__proto__":{"at":1}}'), {});
  assert.equal(isTabClosed(parseClosedTabs('{}'), patched(tab('t', 1), { name: 'constructor' })), false);
});

// ── In the strip ──────────────────────────────────────────────────────────

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'CustomEvent', 'EventTarget']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

test('a closed tab stays gone in both strips, when the feed switches missions, and after a reload', async () => {
  await withDom(async (_dom, React) => {
    const NOW = Date.now();
    let feed: ActiveAgent[] = [tab('task', NOW - 60_000)];
    const savedFetch = globalThis.fetch;
    // Feed reads so far: each mount waits for its own before looking.
    let reads = 0;
    globalThis.fetch = (async (input: string) => {
      const active = String(input).includes('/agents/active');
      if (active) reads += 1;
      return new Response(JSON.stringify(active ? { agents: feed, computed_at: Date.now() } : {}), { status: 200 });
    }) as unknown as typeof fetch;
    const { createRoot } = await import('react-dom/client');
    const { WorkingAgentsWidget } = await import('@/plugins-client/working-agents/working-agents-widget');
    const strip = () => React.createElement(WorkingAgentsWidget, { orientation: 'horizontal', compact: true, handle: null });
    const host = document.getElementById('root')!;
    // Two mounts of the widget (a second window's, a zone remounting) must agree.
    const mount = async () => {
      const root = createRoot(host);
      const before = reads;
      await React.act(async () => {
        root.render(React.createElement(React.Fragment, null,
          React.createElement('div', { 'data-strip': 'desktop' }, strip()),
          React.createElement('div', { 'data-strip': 'phone' }, strip())));
      });
      await waitUntil(React.act, () => reads > before, 'the strips to read the feed');
      // One more turn: the strips paint what they read.
      await waitUntil(React.act, () => true, 'the feed to be painted');
      return root;
    };
    const tabs = () => host.querySelectorAll('a[href^="/chat?agent=timon.coder"]').length;
    try {
      let root = await mount();
      assert.equal(tabs(), 2, 'the tab is in both strips');

      const close = host.querySelector<HTMLButtonElement>('[data-strip="desktop"] [data-chip-close]')!;
      await React.act(async () => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      assert.equal(tabs(), 0, 'closed in both strips');
      assert.ok(localStorage.getItem(CLOSED_TABS_LS), 'the close is persisted');

      // Reload, with the feed now showing the series it pilots, older than the close.
      await React.act(async () => { root.unmount(); });
      feed = [{ ...tab('pilot', NOW - 3_600_000), at: Date.now() }];
      root = await mount();
      assert.equal(tabs(), 0, 'another mission of the same agent does not bring the tab back');

      // New work after the close: the tab returns, and stays once it is done.
      await React.act(async () => { root.unmount(); });
      feed = [tab('next-task', Date.now() + 1_000)];
      root = await mount();
      assert.equal(tabs(), 2, 'a mission started after the close brings the tab back');
      await React.act(async () => { root.unmount(); });
      feed = [{ ...tab('pilot', NOW - 3_600_000), at: Date.now() }];
      root = await mount();
      assert.equal(tabs(), 2, 'once back, the tab stays back');
      await React.act(async () => { root.unmount(); });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
