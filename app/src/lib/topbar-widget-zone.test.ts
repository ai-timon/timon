import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The top bar's widget zone, mounted in the real host.
 *
 * What the pure tests cannot see: that a horizontal zone paints its cards on a
 * line and hands the widget `orientation: 'horizontal'`, that the same widget
 * dropped into a rail gets its column form back, and that in Edit Layout the
 * bar is a drop target whose cards drag but never dock.
 */
async function mountZones(stored: unknown[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  // The widget window (opened to arm the drop targets) moves focus, which
  // dnd-kit hands back on the next frame.
  install('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16));
  install('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  install('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url.startsWith('/api/ui/layout?scope=')) return Response.json({ layout: stored });
    return new Response(null, { status: 404 });
  });

  const { declareSlot, register, resetSlotsForTests } = await import('./plugin-host/slots');
  const { useDndContext } = await import('@dnd-kit/core');
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../components/workspace-layout-provider');
  const { WidgetHost, useWidgetHost } = await import('../components/widget-host/widget-host');
  const { WidgetZone } = await import('../components/widget-host/widget-zone');
  type Props = { orientation?: string; compact?: boolean; handle?: unknown };

  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  // A widget with a compact form, which says which form it was asked for:
  // its icons on a line, its icons stacked, or its card.
  const Bell = ({ orientation, compact, handle }: Props) => React.createElement('span', {
    'data-form': compact ? orientation : 'card', 'data-orientation-prop': orientation,
  }, 'bell', handle as never);
  register({ slot: 'cockpit.widget', pluginId: 'fixture', key: 'bell', widget: { title: 'Bell', frame: 'none', bar: true, zone: 'topbar.widget' } }, Bell as never);
  // An ordinary card: no flat form, so the bar must refuse it.
  register({ slot: 'cockpit.widget', pluginId: 'fixture', key: 'card', widget: { title: 'Card' } }, () => React.createElement('p', null, 'card'));

  const seen: { droppables: string[]; dragging: string | null; setPaletteOpen: (v: boolean) => void } = {
    droppables: [], dragging: null, setPaletteOpen: () => {},
  };
  function Probe() {
    const { droppableContainers } = useDndContext();
    const host = useWidgetHost();
    seen.droppables = [...droppableContainers.values()].filter((c) => !c.disabled).map((c) => String(c.id));
    seen.dragging = host.dragging;
    seen.setPaletteOpen = host.setPaletteOpen;
    return null;
  }

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => {
    root.render(React.createElement(PathnameContext.Provider, { value: '/' },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(WidgetHost, null,
            React.createElement(WidgetZone, { zone: 'topbar.widget', slot: 'topbar.widget', orientation: 'horizontal', label: 'Top bar' }),
            React.createElement(WidgetZone, { zone: 'sidebar.left.widget', slot: 'sidebar.left.widget', compact: true, label: 'Rail' }),
            React.createElement(WidgetZone, { zone: 'droite', slot: 'cockpit.widget', label: 'Cockpit' }),
            React.createElement(Probe))))));
  });
  // The stored layout arrives after two chained reads (identity, then layout):
  // under a loaded machine a fixed delay is not enough, so wait for the cards.
  await until(() => document.querySelectorAll('[data-widget-id]').length >= stored.length, 'the stored cards to be painted');
  const cleanup = async () => {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  };
  return { React, dom, seen, until, cleanup };
}

test('the top bar zone paints its widget flat, and lets it be dragged but not docked', async () => {
  const { React, dom, seen, until, cleanup } = await mountZones([
    { id: 'plugin:fixture:bell', rail: 'topbar.widget', rang: 0, hauteur: 320 },
    { id: 'plugin:fixture:card', rail: 'sidebar.left.widget', rang: 0, hauteur: 200 },
  ]);
  try {
    const bar = document.querySelector('[data-widget-zone="topbar.widget"]')!;
    assert.equal(bar.getAttribute('data-orientation'), 'horizontal');
    const card = bar.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:bell"]')!;
    assert.ok(card, 'the bell is in the bar');
    assert.equal(card.querySelector('[data-form]')?.getAttribute('data-form'), 'horizontal');
    // No height on a line: the band's height is the controls', never a card's.
    assert.equal(card.style.height, '');

    await React.act(async () => { seen.setPaletteOpen(true); });
    await until(() => seen.droppables.includes('zone:topbar.widget'), 'the widget window to mount its drop targets');
    assert.ok(seen.droppables.includes('zone:topbar.widget'), 'the bar is a drop target');
    assert.ok(seen.droppables.includes('rail:topbar.widget'), 'with an append gap');
    assert.ok(seen.droppables.includes('insert:plugin:fixture:bell'));
    assert.ok(!seen.droppables.includes('dock:plugin:fixture:bell'), 'no stack of tabs on a 36px line');
    assert.ok(seen.droppables.includes('dock:plugin:fixture:card'), 'a rail card still docks');
    // No resize handle and no style menu in the bar: grip and cross only.
    assert.ok(!card.querySelector('[role="separator"]'));
    const grip = card.querySelector<HTMLElement>('[aria-roledescription="draggable"]');
    assert.ok(grip, 'the bell has its grip while the widget window is open');
    assert.equal(grip.getAttribute('tabindex'), '0');

    // Lifting the rail card (no flat form) greys the bar out before the drop.
    const cardGrip = document.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:card"] [aria-roledescription="draggable"]')!;
    await React.act(async () => {
      cardGrip.focus();
      cardGrip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    });
    await until(() => seen.dragging !== null, 'the keyboard to lift the rail card');
    assert.equal(seen.dragging, 'plugin:fixture:card');
    assert.equal(bar.getAttribute('aria-disabled'), 'true', 'the bar refuses a card without a flat form');
    assert.ok(!seen.droppables.includes('zone:topbar.widget'));
    await React.act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    });
    await until(() => seen.dragging === null, 'Escape to put the card back');

    // Lifting the bell leaves the rail open to it.
    await React.act(async () => {
      grip.focus();
      grip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    });
    await until(() => seen.dragging !== null, 'the keyboard to lift the bell');
    assert.equal(seen.dragging, 'plugin:fixture:bell');
    const rail = document.querySelector('[data-widget-zone="sidebar.left.widget"]')!;
    assert.equal(rail.getAttribute('aria-disabled'), null, 'the rail takes the bell');
    assert.ok(seen.droppables.includes('zone:sidebar.left.widget'));
  } finally {
    await cleanup();
  }
});

test('a compact rail stacks the widget\'s icons, a wide column gives it its card', async () => {
  const { React, seen, until, cleanup } = await mountZones([
    { id: 'plugin:fixture:bell', rail: 'sidebar.left.widget', rang: 0, hauteur: 320 },
    { id: 'plugin:fixture:card', rail: 'sidebar.left.widget', rang: 1, hauteur: 200 },
  ]);
  try {
    const rail = document.querySelector('[data-widget-zone="sidebar.left.widget"]')!;
    assert.equal(rail.getAttribute('data-orientation'), 'vertical');
    assert.equal(rail.getAttribute('data-compact'), 'true');
    const bell = rail.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:bell"]')!;
    assert.ok(bell);
    // The zone, not a width, says the form: vertical and compact.
    assert.equal(bell.querySelector('[data-form]')?.getAttribute('data-form'), 'vertical');
    assert.equal(bell.style.height, '', 'the compact form takes its natural height');
    // A widget without a compact form keeps its card, and the column's height
    // left by the icons: a share, never a height of its own.
    const card = rail.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:card"]')!;
    assert.equal(card.style.height, '');
    assert.equal(card.getAttribute('data-height-mode'), 'fill');
    assert.equal(card.getAttribute('data-compact'), null);

    await React.act(async () => { seen.setPaletteOpen(true); });
    await until(() => seen.droppables.includes('dock:plugin:fixture:card'), 'the widget window to arm the drop targets');
    assert.ok(!bell.querySelector('[role="separator"]'), 'no resize handle on the compact form');
    assert.ok(!seen.droppables.includes('dock:plugin:fixture:bell'), 'no docking onto two stacked icons');
    assert.ok(!rail.querySelector('[data-widget-edge]'), 'a single shared card has no edge to drag');
    // A zone's shape is data, never a label in the way: no "Vertical" or
    // "Horizontal" caption, whatever the mode.
    assert.equal(document.querySelectorAll('[data-zone-shape]').length, 0);
    const shapes = Array.from(document.querySelectorAll('[data-widget-zone]')).map((el) => `${el.getAttribute('data-orientation')}${el.getAttribute('data-compact') ? '+compact' : ''}`);
    assert.deepEqual(shapes.sort(), ['horizontal+compact', 'vertical', 'vertical+compact']);
  } finally {
    await cleanup();
  }
});

test('the same widget in a wide column takes its card', async () => {
  const { cleanup } = await mountZones([
    { id: 'plugin:fixture:bell', rail: 'droite', rang: 0, hauteur: 320 },
  ]);
  try {
    const card = document.querySelector<HTMLElement>('[data-widget-zone="droite"] [data-widget-id="plugin:fixture:bell"]')!;
    assert.ok(card);
    const form = card.querySelector('[data-form]')!;
    assert.equal(form.getAttribute('data-form'), 'card');
    assert.equal(form.getAttribute('data-orientation-prop'), 'vertical', 'the widget knows it stands in a column');
    assert.equal(card.style.height, '');
    assert.equal(card.getAttribute('data-height-mode'), 'fill', 'a card alone in a column fills it');
    // An emptied bar, with no layout gesture under way, still answers as a zone but
    // paints nothing in the band.
    assert.ok(!document.querySelector('[data-widget-zone="topbar.widget"] [data-widget-id]'));
  } finally {
    await cleanup();
  }
});
