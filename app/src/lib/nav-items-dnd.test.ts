import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';
import type { LucideIcon } from 'lucide-react';

/**
 * "Customize the menu" reorders the side menu by drag and drop (it had
 * up/down arrows, which crushed the labels). The keyboard keeps what the
 * arrows gave: Space on a page's grip picks it up, the arrow keys move it,
 * Space drops it — and Enter on the eye beside it still only hides the page.
 *
 * Since TODO #456 the host owns the row: a third-party entry, which paints its
 * own link, moves and hides like the product's; separators and the boundary
 * of the foot of the menu are rows of the same list.
 */

type Dom = { window: Window & typeof globalThis };

class NoopResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }

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
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('ResizeObserver', NoopResizeObserver);
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

const ROW_H = 32;

/** jsdom lays nothing out: each row gets a 32px band in DOM order, so the keyboard sensor has somewhere to go. */
function layOutRows(dom: Dom): void {
  const proto = dom.window.HTMLElement.prototype;
  proto.getBoundingClientRect = function rect(this: HTMLElement): DOMRect {
    const row = this.closest('[data-nav-row]');
    const rows = Array.from(document.querySelectorAll('[data-nav-row]'));
    const at = row ? rows.indexOf(row) : -1;
    const top = at < 0 ? 0 : at * ROW_H;
    const height = at < 0 ? 0 : ROW_H;
    return { x: 0, y: top, top, left: 0, width: at < 0 ? 0 : 200, height, right: at < 0 ? 0 : 200, bottom: top + height, toJSON() { return {}; } } as DOMRect;
  };
}

type Layout = { order: string[]; footer: string[] };

async function mountMenu(run: (ctx: {
  dom: Dom;
  React: typeof import('react');
  orders: Layout[];
  hidden: string[];
  grip: (label: string) => HTMLElement;
  until: (condition: () => boolean, what: string) => Promise<void>;
}) => Promise<void>, options: { editing?: boolean; hidden?: string[]; stored?: { order: string[]; footer: string[] | null } } = {}): Promise<void> {
  await withDom(async (dom, React) => {
    layOutRows(dom);
    const { resetSlotsForTests, declareSlot, register } = await import('@/lib/plugin-host/slots');
    const { createRoot } = await import('react-dom/client');
    const { NavItems } = await import('@/components/nav-items');
    const { NavChromeProvider, NavDivider, NavLink } = await import('@/components/nav-link');
    const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
    resetSlotsForTests();
    declareSlot('nav.item', 'list');
    const Icon = (() => null) as unknown as LucideIcon;
    const page = (href: string, label: string, order: number) =>
      register({ slot: 'nav.item', pluginId: 'fixture', key: href, order }, function Item() {
        return React.createElement(NavLink, { href, labelKey: label, icon: Icon });
      });
    page('/a', 'Alpha', 1);
    page('/b', 'Bravo', 2);
    register({ slot: 'nav.item', pluginId: 'fixture', key: '---', order: 3 }, NavDivider);
    page('/c', 'Charlie', 4);
    // A third-party entry: its own link, no `NavLink`, no knowledge of the editor.
    register({ slot: 'nav.item', pluginId: 'growth', key: '/growth', order: 5 }, function Growth() {
      return React.createElement('a', { href: '/growth' }, 'Growth Studio');
    });
    const orders: Layout[] = [];
    const hidden: string[] = [...(options.hidden ?? [])];
    const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace() {} };
    const host = document.getElementById('root')!;
    const root = createRoot(host);
    const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
    const grip = (label: string) => host.querySelector<HTMLElement>(`button[aria-label^="Move ${label}"]`)!;
    try {
      await React.act(async () => {
        root.render(React.createElement(AppRouterContext.Provider, { value: router },
          React.createElement(NavChromeProvider, { value: { expanded: true, forceLabel: true, editing: options.editing ?? true, hidden, onToggleHidden: (href: string) => { hidden.push(href); } } },
            React.createElement(NavItems, { stored: options.stored ?? { order: [], footer: null }, onLayoutChange: (layout: Layout) => { orders.push(layout); } }))));
      });
      if (options.editing ?? true) await until(() => !!host.querySelector('[data-nav-row="/growth"]'), 'the menu rows to be painted');
      await run({ dom, React, orders, hidden, grip, until });
    } finally {
      await React.act(async () => { root.unmount(); });
      resetSlotsForTests();
    }
  });
}

function key(dom: Dom, target: EventTarget, code: string): void {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: code === 'Space' ? ' ' : code, code, bubbles: true }));
}

test('the arrows are gone: each page has a grip and its eye, nothing else', async () => {
  await mountMenu(async ({ dom }) => {
    const row = dom.window.document.querySelector<HTMLElement>('[data-nav-row="/a"]')!;
    assert.ok(row, 'the page is a sortable row');
    const labels = Array.from(row.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    assert.deepEqual(labels, ['Move Alpha: drag it, or press space and use the arrow keys', 'Hide Alpha from the menu']);
    assert.ok(!dom.window.document.querySelector('[aria-label*=" up in the menu"], [aria-label*=" down in the menu"]'));
  });
});

async function moveDown(ctx: { dom: Dom; React: typeof import('react'); grip: (label: string) => HTMLElement; until: (c: () => boolean, w: string) => Promise<void> }, label: string, steps = 1, direction = 'ArrowDown'): Promise<void> {
  const handle = ctx.grip(label);
  await ctx.React.act(async () => { handle.focus(); key(ctx.dom, handle, 'Space'); });
  await ctx.until(() => handle.getAttribute('aria-pressed') === 'true', 'Space to lift the row');
  for (let i = 0; i < steps; i += 1) await ctx.React.act(async () => { key(ctx.dom, handle, direction); });
  await ctx.React.act(async () => { key(ctx.dom, handle, 'Space'); });
}

test('Space, arrow down, Space moves a page one place down, past the separator', async () => {
  await mountMenu(async ({ dom, React, orders, grip, until }) => {
    const handle = grip('Bravo');
    // dnd-kit listens to the arrows from a timer after the lift: the wait on
    // the lift covers it.
    await React.act(async () => { handle.focus(); key(dom, handle, 'Space'); });
    await until(() => handle.getAttribute('aria-pressed') === 'true', 'Space to lift the page');
    await React.act(async () => { key(dom, handle, 'ArrowDown'); });
    await React.act(async () => { key(dom, handle, 'Space'); });
    await until(() => orders.length > 0, 'Space to drop the page');
    assert.deepEqual(orders, [{ order: ['/a', '---', '/b', '/c', '/growth'], footer: [] }]);
  });
});

test('Escape puts the page back and stores nothing', async () => {
  await mountMenu(async ({ dom, React, orders, grip, until }) => {
    const handle = grip('Alpha');
    await React.act(async () => { handle.focus(); key(dom, handle, 'Space'); });
    await until(() => handle.getAttribute('aria-pressed') === 'true', 'Space to lift the page');
    await React.act(async () => { key(dom, handle, 'ArrowDown'); });
    await React.act(async () => { key(dom, handle, 'Escape'); });
    await until(() => handle.getAttribute('aria-pressed') !== 'true', 'Escape to put the page back');
    assert.deepEqual(orders, []);
  });
});

test('Enter on the eye hides the page and never picks the row up', async () => {
  await mountMenu(async ({ dom, React, orders, hidden, until }) => {
    const eye = dom.window.document.querySelector<HTMLElement>('button[aria-label="Hide Charlie from the menu"]')!;
    await React.act(async () => { eye.focus(); key(dom, eye, 'Enter'); eye.click(); });
    await until(() => hidden.length > 0, 'the eye to hide the page');
    // A row lifted by that Enter would move and drop here, under act().
    await React.act(async () => { key(dom, eye, 'ArrowUp'); key(dom, eye, 'Enter'); });
    assert.deepEqual(hidden, ['/c']);
    assert.deepEqual(orders, []);
  });
});

test('a third-party entry is a row like the others: its grip, its eye, its label read from its own content', async () => {
  await mountMenu(async ({ dom, React, orders, hidden, grip, until }) => {
    const row = dom.window.document.querySelector<HTMLElement>('[data-nav-row="/growth"]')!;
    const labels = Array.from(row.querySelectorAll(':scope > button')).map((b) => b.getAttribute('aria-label'));
    assert.deepEqual(labels, ['Move Growth Studio: drag it, or press space and use the arrow keys', 'Hide Growth Studio from the menu']);
    assert.ok(row.querySelector('[inert] a[href="/growth"]'), 'its own link is inert while editing');
    await moveDown({ dom, React, grip, until }, 'Growth Studio', 1, 'ArrowUp');
    await until(() => orders.length > 0, 'the plugin page to be dropped');
    assert.deepEqual(orders[0], { order: ['/a', '/b', '---', '/growth', '/c'], footer: [] });
    const eye = dom.window.document.querySelector<HTMLElement>('button[aria-label="Hide Growth Studio from the menu"]')!;
    await React.act(async () => { eye.click(); });
    assert.deepEqual(hidden, ['/growth']);
  });
});

test('outside the editor a hidden plugin page is not painted, and a separator is a gap, not a rule', async () => {
  await mountMenu(async ({ dom }) => {
    const doc = dom.window.document;
    assert.ok(!doc.querySelector('a[href="/growth"]'));
    assert.ok(doc.querySelector('a[href="/a"]'));
    const gap = doc.querySelector<HTMLElement>('[data-nav-separator]')!;
    assert.ok(gap, 'the separator shows');
    assert.doesNotMatch(gap.className, /border|bg-/);
    assert.ok(!doc.querySelector('hr'));
  }, { editing: false, hidden: ['/growth'] });
});

test('a separator is added at the end of the main list, and removed by its own button', async () => {
  await mountMenu(async ({ dom, React, orders, until }) => {
    const doc = dom.window.document;
    const add = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === 'Add a separator')!;
    await React.act(async () => { add.click(); });
    await until(() => orders.length > 0, 'the separator to be added');
    assert.deepEqual(orders[0], { order: ['/a', '/b', '---', '/c', '/growth', '---'], footer: [] });
    const remove = doc.querySelector<HTMLElement>('[data-nav-row="---0"] button[aria-label="Remove the separator"]')!;
    await React.act(async () => { remove.click(); });
    assert.deepEqual(orders[1], { order: ['/a', '/b', '/c', '/growth'], footer: [] });
  });
});

test('moving the bottom boundary up sends the pages under it to the foot of the menu', async () => {
  await mountMenu(async ({ dom, React, orders, grip, until }) => {
    await moveDown({ dom, React, grip, until }, 'Bottom of the menu', 2, 'ArrowUp');
    await until(() => orders.length > 0, 'the boundary to be dropped');
    assert.deepEqual(orders[0], { order: ['/a', '/b', '---'], footer: ['/c', '/growth'] });
  });
});

test('a page of a plugin switched off keeps its stored place through a change', async () => {
  await mountMenu(async ({ dom, React, orders, until }) => {
    const add = Array.from(dom.window.document.querySelectorAll('button')).find((b) => b.textContent === 'Add a separator')!;
    await React.act(async () => { add.click(); });
    await until(() => orders.length > 0, 'the change to be stored');
    assert.deepEqual(orders[0], { order: ['/a', '/off', '/b', '/c', '/growth', '---'], footer: ['/d'] });
  }, { stored: { order: ['/a', '/off', '/b', '/c', '/growth'], footer: ['/d'] } });
});

test('the foot paints the pages sent there, before the controls of nav.footer, and none while editing', async () => {
  await withDom(async (dom, React) => {
    const { resetSlotsForTests, declareSlot, register } = await import('@/lib/plugin-host/slots');
    const { createRoot } = await import('react-dom/client');
    const { NavFooter } = await import('@/components/nav-footer');
    resetSlotsForTests();
    declareSlot('nav.item', 'list');
    declareSlot('nav.footer', 'list');
    register({ slot: 'nav.item', pluginId: 'growth', key: '/growth' }, () => React.createElement('a', { href: '/growth' }, 'Growth'));
    register({ slot: 'nav.item', pluginId: 'x', key: '/x' }, () => React.createElement('a', { href: '/x' }, 'X'));
    register({ slot: 'nav.footer', pluginId: 'switcher' }, () => React.createElement('span', null, 'switcher'));
    const host = dom.window.document.getElementById('root')!;
    const root = createRoot(host);
    const stored = { order: ['/x'], footer: ['/growth'] };
    try {
      await React.act(async () => { root.render(React.createElement(NavFooter, { expanded: false, forceLabel: false, stored })); });
      assert.equal(host.textContent, 'Growthswitcher');
      await React.act(async () => { root.render(React.createElement(NavFooter, { expanded: false, forceLabel: false, stored, hidden: ['/growth'] })); });
      assert.equal(host.textContent, 'switcher');
      await React.act(async () => { root.render(React.createElement(NavFooter, { expanded: true, forceLabel: false, editing: true, stored })); });
      assert.equal(host.textContent, 'switcher', 'edited in the main list instead');
    } finally {
      await React.act(async () => { root.unmount(); });
      resetSlotsForTests();
    }
  });
});
