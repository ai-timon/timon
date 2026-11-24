import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';

/**
 * The Working agents widget (TODO #479, SUG-0080), mounted for real: its
 * three shapes by orientation, what its options show, and the pinned tabs
 * reordered by a drag or from the tab's menu, the new order written to the
 * account's row.
 */

type Row = { pinned?: string[]; pinnedProjects?: string[]; options?: Record<string, unknown> };

const NOW = Date.now();
const FEED = [
  { name: 'shop.coder', state: 'thinking', mission_id: 'm1', at: NOW - 30_000, pending_count: 0, project: 'shop' },
  { name: 'shop.orchestrator', state: 'needs_action', mission_id: 'm2', at: NOW - 60_000, pending_count: 1, project: 'shop' },
  { name: 'blog.coder', state: 'done', mission_id: 'm3', at: NOW - 90_000, pending_count: 0, project: 'blog' },
];
const CONFIGURED = [
  { name: 'nova', main: true, project: null },
  { name: 'shop.orchestrator', role: 'orchestrator', project: 'shop' },
  { name: 'shop.coder', role: 'coder', project: 'shop' },
  { name: 'blog.coder', role: 'coder', project: 'blog' },
];
const PROJECTS = [{ slug: 'shop', name: 'Shop', color: '#f97316' }, { slug: 'blog', name: 'Blog', color: '#3b82f6' }];

type Mounted = {
  host: HTMLElement;
  writes: Row[];
  React: typeof import('react');
  window: Window & typeof globalThis;
  until: (condition: () => boolean, what: string) => Promise<void>;
};

async function mount(props: Record<string, unknown>, stored: Row | null, run: (m: Mounted) => Promise<void>, feed: readonly unknown[] = FEED) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'getComputedStyle', 'localStorage', 'CustomEvent', 'EventTarget']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const writes: Row[] = [];
  let row: Row | null = stored;
  let version = 1;
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url.startsWith('/api/ui/layout?scope=')) {
      if (init?.method === 'PUT') {
        row = (JSON.parse(String(init.body)) as { layout: Row }).layout;
        writes.push(row);
        return Response.json({ ok: true, updatedAt: ++version });
      }
      return Response.json({ layout: row, updatedAt: version });
    }
    if (url === '/api/ui/agents/active') return Response.json({ agents: feed, computed_at: Date.now() });
    if (url === '/api/ui/agents') return Response.json({ agents: CONFIGURED });
    if (url === '/api/ui/projects') return Response.json({ projects: PROJECTS });
    return new Response(null, { status: 404 });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('@/components/workspace-layout-provider');
  const { forgetStoredLayouts } = await import('@/hooks/use-stored-layout');
  const { WorkingAgentsWidget } = await import('./working-agents-widget');
  forgetStoredLayouts();
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  try {
    await React.act(async () => {
      root.render(React.createElement(PathnameContext.Provider, { value: '/' },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
          React.createElement(WorkspaceLayoutProvider, null,
            React.createElement(WorkingAgentsWidget, { handle: null, ...props })))));
    });
    // The feed, then the stored row (its pins come first once read).
    await until(() => host.querySelectorAll('[data-agent-tab], [data-project-tab]').length > 0, 'the tabs to be painted');
    if (stored?.pinned?.length) await until(() => !!host.querySelector('[data-pinned]'), 'the stored pins to be read');
    await run({ host, writes, React, window: dom.window as unknown as Window & typeof globalThis, until });
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

const tabNames = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>('[data-agent-tab]')).map((el) => el.dataset.agentTab);

test('on a line (the top bar) the tabs sit side by side, pinned first, options only in Edit Layout', async () => {
  await mount({ orientation: 'horizontal', compact: true }, { pinned: ['blog.coder'] }, async ({ host }) => {
    assert.ok(host.querySelector('[data-working-agents="chip"]'));
    assert.ok(!host.querySelector('section'), 'no card on a line');
    assert.deepEqual(tabNames(host), ['blog.coder', 'shop.coder', 'shop.orchestrator']);
    assert.ok(host.querySelector('[data-agent-tab="shop.coder"] [data-chip-pin]'), 'a tab has its pin button');
    assert.ok(!host.querySelector('[data-working-agents-options]'), 'no options outside Edit Layout');
  });
  await mount({ orientation: 'horizontal', compact: true, editing: true }, null, async ({ host }) => {
    assert.ok(host.querySelector('[data-working-agents-options]'), 'the options in Edit Layout');
  });
});

test('in a narrow column (the nav rail) the faces are stacked, pin and close moved to the menu', async () => {
  await mount({ orientation: 'vertical', compact: true }, null, async ({ host }) => {
    assert.ok(host.querySelector('[data-working-agents="avatar"]'));
    assert.ok(host.querySelector('[data-agent-tab] [data-chip-avatar]'));
    assert.ok(!host.querySelector('[data-chip-actions]'), 'no button column beside a face');
  });
});

test('in a wide column (cockpit, chat, an island) it is a card of rows with its options', async () => {
  await mount({ orientation: 'vertical', compact: false }, null, async ({ host }) => {
    const card = host.querySelector('section')!;
    assert.ok(card, 'a card');
    assert.match(card.querySelector('header')!.textContent ?? '', /Working agents/);
    assert.ok(card.querySelector('[data-working-agents="row"] [data-agent-tab]'));
    assert.ok(card.querySelector('[data-working-agents-options]'), 'its options in the header');
  });
});

test('orchestrators only: the main agent at rest and the orchestrators at work, nobody else', async () => {
  await mount({ orientation: 'horizontal', compact: true }, { options: { orchestratorOnly: true } }, async ({ host, until }) => {
    await until(() => tabNames(host).includes('nova'), 'the main agent to show');
    assert.deepEqual(tabNames(host), ['nova', 'shop.orchestrator']);
  });
});

test('all agents: the ones at rest too, and none can be hidden', async () => {
  await mount({ orientation: 'vertical', compact: false }, { options: { show: 'all' } }, async ({ host, until }) => {
    await until(() => tabNames(host).includes('nova'), 'the agents at rest to show');
    assert.deepEqual(tabNames(host), ['shop.coder', 'shop.orchestrator', 'blog.coder', 'nova']);
    assert.ok(!host.querySelector('[data-chip-close]'));
  });
});

test('grouped by project: one tab per project, its agents listed on hover', async () => {
  await mount({ orientation: 'horizontal', compact: true }, { options: { groupByProject: true } }, async ({ host, until, React, window }) => {
    await until(() => host.querySelectorAll('[data-project-tab]').length === 2, 'the project tabs');
    const shop = host.querySelector<HTMLElement>('[data-project-tab="shop"]')!;
    assert.match(shop.textContent ?? '', /Shop/);
    assert.match(shop.textContent ?? '', /needs you/, 'the most pressing state of its agents');
    assert.equal(shop.querySelector('a')!.getAttribute('href'), '/chat?agent=shop.orchestrator&mission=m2', 'a click opens the project\'s orchestrator');
    assert.equal(tabNames(host).length, 0, 'no agent tab on the bar');
    await React.act(async () => { shop.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })); });
    const list = document.querySelector<HTMLElement>('[data-project-agents="shop"]');
    assert.ok(list, 'the list opens on hover');
    assert.deepEqual(Array.from(list.querySelectorAll<HTMLElement>('[data-agent-tab]')).map((el) => el.dataset.agentTab), ['shop.coder', 'shop.orchestrator']);
    // blog.coder is done: nothing at work, no list.
    const blog = host.querySelector<HTMLElement>('[data-project-tab="blog"]')!;
    await React.act(async () => { blog.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })); });
    assert.ok(!document.querySelector('[data-project-agents]'), 'no list when no agent of the project is at work');
  });
  await mount({ orientation: 'horizontal', compact: true }, { options: { groupByProject: true, projectHoverList: false } }, async ({ host, until, React, window }) => {
    await until(() => !!host.querySelector('[data-project-tab="shop"]'), 'the project tabs');
    const shop = host.querySelector<HTMLElement>('[data-project-tab="shop"]')!;
    await React.act(async () => { shop.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })); });
    assert.ok(!document.querySelector('[data-project-agents]'), 'no list when the option is off');
  });
});

test('grouped by project: the list names no project, its agents carry no pin, one list at a time', async () => {
  // blog.coder at work too, so that both projects have a list.
  const busy = FEED.map((a) => (a.name === 'blog.coder' ? { ...a, state: 'thinking' } : a));
  await mount({ orientation: 'horizontal', compact: true }, { options: { groupByProject: true } }, async ({ host, until, React, window }) => {
    await until(() => host.querySelectorAll('[data-project-tab]').length === 2, 'the project tabs');
    await until(() => /1\/1/.test(host.querySelector('[data-project-tab="blog"]')?.textContent ?? ''), 'blog.coder at work');
    const shop = host.querySelector<HTMLElement>('[data-project-tab="shop"]')!;
    const blog = host.querySelector<HTMLElement>('[data-project-tab="blog"]')!;
    await React.act(async () => { shop.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })); });
    const list = document.querySelector<HTMLElement>('[data-project-agents="shop"]')!;
    assert.doesNotMatch(list.textContent ?? '', /Shop/, 'the tab already says the project');
    assert.ok(!list.querySelector('[data-chip-pin]'), 'grouped, the pin is the project\'s, not its agents\'');
    // The pointer sweeps from one tab to the next before the first list's close delay.
    await React.act(async () => {
      shop.dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true }));
      blog.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
    });
    assert.deepEqual(Array.from(document.querySelectorAll<HTMLElement>('[data-project-agents]')).map((el) => el.dataset.projectAgents), ['blog']);
  }, busy);
});

test('grouped by project: an agent of no project keeps its own tab, a project is pinned', async () => {
  await mount({ orientation: 'horizontal', compact: true }, { options: { groupByProject: true, show: 'all' } }, async ({ host, writes, until, React }) => {
    await until(() => tabNames(host).includes('nova'), 'the agent of no project');
    assert.deepEqual(tabNames(host), ['nova'], 'on the bar, in no group');
    assert.ok(!/No project/.test(host.textContent ?? ''));
    const pin = host.querySelector<HTMLButtonElement>('[data-project-tab="blog"] [data-project-pin]')!;
    await React.act(async () => { pin.click(); });
    await until(() => writes.length > 0, 'the pin to be written');
    assert.deepEqual(writes.at(-1)!.pinnedProjects, ['blog']);
    await until(() => host.querySelector('[data-project-tab]')?.getAttribute('data-project-tab') === 'blog', 'the pinned project to come first');
    assert.equal(host.querySelector('[data-project-tab="blog"]')!.getAttribute('data-pinned'), 'true');
  });
});

/** A drag's data, as the browser hands it to each event of the gesture. */
function fakeTransfer() {
  const data = new Map<string, string>();
  return {
    types: [] as string[],
    effectAllowed: 'all',
    dropEffect: 'none',
    setData(type: string, value: string) { data.set(type, value); if (!this.types.includes(type)) this.types.push(type); },
    getData(type: string) { return data.get(type) ?? ''; },
    setDragImage() {},
  };
}

/** jsdom lays nothing out: each tab gets a box, side by side, 80 px wide every 100 px. */
function layOut(host: HTMLElement) {
  const box = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 30, width, height: 30, x: left, y: 0, toJSON() {} }) as DOMRect;
  const track = host.querySelector<HTMLElement>('[data-working-agents]')!;
  track.getBoundingClientRect = () => box(0, 1000);
  host.querySelectorAll<HTMLElement>('[data-working-agents] [data-strip-slot]').forEach((el, i) => { el.getBoundingClientRect = () => box(i * 100, 80); });
}

async function dragAlong(m: Mounted, from: Element, x: number) {
  const transfer = fakeTransfer();
  const fire = async (target: Element, type: string) => {
    const event = new m.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 15 });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    await m.React.act(async () => { target.dispatchEvent(event); });
    return event;
  };
  const track = m.host.querySelector('[data-working-agents]')!;
  await fire(from, 'dragstart');
  layOut(m.host);
  const over = await fire(track, 'dragover');
  const line = m.host.querySelector<HTMLElement>('[data-strip-drop-gap]');
  await fire(track, 'drop');
  await fire(from, 'dragend');
  return { transfer, accepted: over.defaultPrevented, line };
}

test('a tab dragged along the strip lands in the gap the line shows, and the order is written (SUG-0080)', async () => {
  await mount({ orientation: 'horizontal', compact: true }, { pinned: ['shop.coder', 'shop.orchestrator', 'blog.coder'], options: { groupByProject: false } }, async (m) => {
    const { host, writes, until } = m;
    assert.deepEqual(tabNames(host), ['shop.coder', 'shop.orchestrator', 'blog.coder']);
    layOut(host);
    const { transfer, accepted, line } = await dragAlong(m, host.querySelector('[data-agent-tab="shop.coder"] a')!, 290);
    assert.ok(transfer.types.includes('application/x-timon-strip-tab'));
    assert.ok(accepted, 'the strip accepts the drop');
    assert.equal(line?.dataset.stripDropGap, '2', 'the line stands after the last pinned tab');
    assert.equal(line?.style.left, '281px', 'right after blog.coder');
    await until(() => writes.length > 0, 'the new order to be written');
    assert.deepEqual(writes.at(-1)!.pinned, ['shop.orchestrator', 'blog.coder', 'shop.coder']);
    assert.deepEqual(writes.at(-1)!.options, { groupByProject: false }, 'the options are kept beside the pins');
    await until(() => tabNames(host)[0] === 'shop.orchestrator', 'the tabs to follow');
    assert.ok(!host.querySelector('[data-strip-drop-gap]'), 'the line goes with the drag');
  });
});

test('an unpinned tab dropped among the pinned ones is pinned there; past them it lands at their end', async () => {
  await mount({ orientation: 'horizontal', compact: true }, { pinned: ['blog.coder'], options: { groupByProject: false } }, async (m) => {
    const { host, writes, until } = m;
    assert.deepEqual(tabNames(host), ['blog.coder', 'shop.coder', 'shop.orchestrator']);
    layOut(host);
    await dragAlong(m, host.querySelector('[data-agent-tab="shop.orchestrator"] a')!, 10);
    await until(() => writes.length > 0, 'the pin to be written');
    assert.deepEqual(writes.at(-1)!.pinned, ['shop.orchestrator', 'blog.coder']);
  });
  await mount({ orientation: 'horizontal', compact: true }, { pinned: ['blog.coder'], options: { groupByProject: false } }, async (m) => {
    const { host, writes, until } = m;
    layOut(host);
    const { line } = await dragAlong(m, host.querySelector('[data-agent-tab="shop.orchestrator"] a')!, 900);
    assert.equal(line?.dataset.stripDropGap, '1', 'clamped to the end of the pinned block');
    await until(() => writes.length > 0, 'the pin to be written');
    assert.deepEqual(writes.at(-1)!.pinned, ['blog.coder', 'shop.orchestrator']);
  });
});

test('grouped by project: a project tab is dragged among the pinned projects', async () => {
  await mount({ orientation: 'horizontal', compact: true }, { pinnedProjects: ['shop', 'blog'], options: { groupByProject: true } }, async (m) => {
    const { host, writes, until } = m;
    await until(() => host.querySelector('[data-project-tab]')?.getAttribute('data-pinned') === 'true', 'the pinned projects');
    layOut(host);
    await dragAlong(m, host.querySelector('[data-project-tab="blog"] a')!, 10);
    await until(() => writes.length > 0, 'the new order to be written');
    assert.deepEqual(writes.at(-1)!.pinnedProjects, ['blog', 'shop']);
  });
});

test('dragged out of the strip, a tab opens its chat in an island: the layers rise only outside the strip', async () => {
  await mount({ orientation: 'horizontal', compact: true }, { options: { groupByProject: true } }, async (m) => {
    const { host, React, window, until } = m;
    const bus = await import('@/lib/island-bus');
    const drag = await import('@/lib/island-drag');
    const handle = { open: () => true, activate: () => {}, close: () => {} };
    const withdraw = bus.announceIslandWorkspace(handle);
    try {
      await React.act(async () => { bus.publishIslandTabs(handle, [], false); });
      await until(() => !!host.querySelector('[data-project-tab="shop"] a[draggable="true"]'), 'a draggable project tab');
      layOut(host);
      const transfer = fakeTransfer();
      const event = new window.MouseEvent('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      await React.act(async () => { host.querySelector('[data-project-tab="shop"] a')!.dispatchEvent(event); });
      assert.ok(transfer.types.includes('application/x-timon-strip-tab'), 'it can reorder');
      assert.ok(transfer.types.some((type) => type !== 'application/x-timon-strip-tab' && type !== 'application/x-timon-agent'), 'it carries the island drag');
      assert.equal(drag.raisedIslandDrag(), null, 'no layer while over the strip');
      const out = new window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 });
      await React.act(async () => { window.dispatchEvent(out); });
      const raised = drag.raisedIslandDrag();
      assert.ok(raised && raised.source.kind === 'content', 'the layers rise out of the strip');
      drag.endIslandDrag();
    } finally {
      withdraw();
    }
  });
});

test('the tab menu moves a pinned tab one step, the keyboard and touch form of the drag', async () => {
  await mount({ orientation: 'horizontal', compact: true }, { pinned: ['shop.coder', 'blog.coder'] }, async ({ host, writes, React, window, until }) => {
    const link = host.querySelector('[data-agent-tab="shop.coder"] a')!;
    await React.act(async () => { link.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).map((b) => b.textContent ?? '');
    assert.ok(items.some((label) => /Move shop\.coder right/.test(label)));
    assert.ok(!items.some((label) => /Move shop\.coder left/.test(label)), 'already first');
    const right = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => /Move shop\.coder right/.test(b.textContent ?? ''))!;
    await React.act(async () => { right.click(); });
    await until(() => writes.length > 0, 'the new order to be written');
    assert.deepEqual(writes.at(-1)!.pinned, ['blog.coder', 'shop.coder']);
  });
});
