import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The controls of a widget, with no layout mode: a card is lifted by its title
 * at any time, resting on the title shows a pill holding the grip and the gear,
 * the gear menu's last item deletes (red, undoable), a right click on the title
 * opens the same menu, and the body stays live.
 */
async function mountZones(stored: Array<{ id: string; removed?: boolean } & Record<string, unknown>>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('DOMRect', (dom.window as unknown as Record<string, unknown>).DOMRect);
  install('MouseEvent', dom.window.MouseEvent);
  for (const key of ['MutationObserver', 'HTMLInputElement', 'HTMLButtonElement', 'FocusEvent', 'CustomEvent', 'DocumentFragment']) install(key, (dom.window as unknown as Record<string, unknown>)[key]);
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
  register({ slot: 'cockpit.widget', pluginId: 'fixture', key: 'card', widget: { title: 'Card' } }, ({ handle }: Props) => React.createElement('div', { 'data-body': true }, React.createElement('p', null, 'card'), React.createElement('input', { 'data-field': true }), handle as never));

  const seen: { setPaletteOpen: (v: boolean) => void; editing: boolean; droppables: string[]; palette: string[]; dragging: string | null } = {
    setPaletteOpen: () => {}, editing: false, droppables: [], palette: [], dragging: null,
  };
  function Probe() {
    const { droppableContainers } = useDndContext();
    const host = useWidgetHost();
    seen.droppables = [...droppableContainers.values()].filter((c) => !c.disabled).map((c) => String(c.id));
    seen.setPaletteOpen = host.setPaletteOpen;
    seen.editing = host.editing;
    seen.palette = host.palette.map((w) => w.id);
    seen.dragging = host.dragging;
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
  // A stack paints one card for all its tabs.
  const shown = new Set(stored.filter((w) => !w.removed).map((w) => (typeof w.group === 'string' ? w.group : w.id))).size;
  await until(() => document.querySelectorAll('[data-widget-id]').length >= shown, 'the stored cards to be painted');
  const cleanup = async () => {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  };
  return { React, dom, seen, until, cleanup };
}

type Until = (condition: () => boolean, what: string) => Promise<void>;

const gearButton = () => document.querySelector<HTMLElement>('.widget-chrome button[aria-label^="Settings"]');
const menuEntries = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'));

const open = async (React: typeof import('react'), until: Until, trigger: HTMLElement) => {
  await React.act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await until(() => menuEntries().length > 0, 'the gear menu to open');
};

test('a lone card carries its grip and gear in a hidden pill, keeps a live body, and is lifted by its title', async () => {
  const { cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200 },
  ]);
  try {
    const { isOnTitleHandle } = await import('../components/widget-host/widget-card');
    const card = document.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:card"]')!;
    const strip = card.querySelector<HTMLElement>('.widget-chrome')!;
    assert.ok(strip, 'the pill is mounted, for the keyboard');
    assert.ok(strip.className.includes('opacity-0'), 'hidden until the title is rested on');
    const [grip, gear] = Array.from(strip.querySelectorAll('button'));
    assert.ok(grip!.hasAttribute('aria-roledescription'), 'the grip is the drag handle');
    assert.match(gear!.getAttribute('aria-label') ?? '', /Settings of Card/);
    assert.equal(card.querySelectorAll('button[aria-label^="Remove"]').length, 0, 'no cross');
    assert.ok(!card.querySelector('.widget-content')!.className.includes('pointer-events-none'), 'the body stays live');
    const header = card.querySelector<HTMLElement>('.widget-content > section > header')!;
    const shape = { bare: false, tabbed: false };
    assert.equal(isOnTitleHandle(card, header, 0, shape), true, 'the title bar lifts the card');
    assert.equal(isOnTitleHandle(card, card.querySelector('[data-body] p')!, 0, shape), false, 'the body does not');
    assert.equal(isOnTitleHandle(card, card.querySelector('[data-field]')!, 0, shape), false, 'nor a field');
    assert.equal(isOnTitleHandle(card, grip!, 0, shape), false, 'a control keeps its click');
  } finally {
    await cleanup();
  }
});

test('a card left alone in its column fills it, whatever share it kept from its former neighbour', async () => {
  // Stored as the survivor of a 50/50 pair whose other half moved away (TODO #786).
  const { cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200, heightMode: 'fill', fillPercent: 50 },
  ]);
  try {
    const card = document.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:card"]')!;
    assert.equal(card.dataset.heightMode, 'fill');
    assert.match(card.getAttribute('style') ?? '', /flex: 1 0 0px/, 'the whole column, not half of it');
  } finally {
    await cleanup();
  }
});

test('two cards whose shares no longer make 100 % still fill their column, with an edge between them', async () => {
  // A card at 50 % dropped under one left at 25 %: weights 2 to 1.
  const { cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200, heightMode: 'fill', fillPercent: 50 },
    { id: 'plugin:fixture:bell', rail: 'droite', rang: 1, hauteur: 200, heightMode: 'fill', fillPercent: 25 },
  ]);
  try {
    const zone = document.querySelector<HTMLElement>('[data-widget-zone="droite"]')!;
    const grow = (id: string) => Number(zone.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!.style.flexGrow);
    const card = grow('plugin:fixture:card');
    const bell = grow('plugin:fixture:bell');
    assert.ok(Math.abs(card + bell - 1) < 1e-9, `the shares sum to the whole column (${card} + ${bell})`);
    assert.ok(Math.abs(card - 2 / 3) < 1e-9, 'and keep their ratio');
    assert.equal(zone.querySelectorAll('[data-widget-edge]').length, 1, 'the edge between them is mounted');
  } finally {
    await cleanup();
  }
});

test('resting the pointer on the title shows the drag hint, leaving the card hides it', async () => {
  const { React, dom, until, cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200 },
  ]);
  try {
    const card = document.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:card"]')!;
    const header = card.querySelector<HTMLElement>('.widget-content > section > header')!;
    const pointer = (type: string, target: Element) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, clientY: 5 });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      target.dispatchEvent(event);
    };
    await React.act(async () => { pointer('pointermove', header); });
    assert.equal(card.getAttribute('data-drag-ready'), null, 'not at once');
    await until(() => card.getAttribute('data-drag-ready') === 'true', 'the hint after the delay');
    assert.ok(card.querySelector('.widget-chrome')!.className.includes('opacity-100'), 'the pill shows');
    await React.act(async () => { card.dispatchEvent(new dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })); });
    await until(() => card.getAttribute('data-drag-ready') === null, 'leaving the card to hide the hint');
  } finally {
    await cleanup();
  }
});

test('the gear menu ends with a red Delete that takes the widget out', async () => {
  const { React, seen, until, cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200 },
  ]);
  try {
    await open(React, until, gearButton()!);
    const items = menuEntries();
    const last = items[items.length - 1]!;
    assert.match(last.textContent ?? '', /Delete/);
    assert.ok(last.className.includes('text-destructive'));
    assert.ok(!document.querySelector('[role="separator"][data-radix-menu-content], [data-radix-popper-content-wrapper] hr'), 'no rule in the menu');
    await React.act(async () => { last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); last.click(); });
    await until(() => !document.querySelector('[data-widget-id="plugin:fixture:card"]') && seen.palette.includes('plugin:fixture:card'), 'Delete to take the widget out');
    assert.ok(!document.querySelector('[data-widget-id="plugin:fixture:card"]'), 'the widget left the zone');
    assert.ok(seen.palette.some((w) => w === 'plugin:fixture:card'), 'and went back to the catalog');
    // The toast's Undo puts it back where it was.
    const { createRequire } = await import('node:module');
    // The host loads sonner through `require` under the test runner: take the same instance.
    const { toast } = createRequire(`${process.cwd()}/package.json`)('sonner') as typeof import('sonner');
    const undo = toast.getToasts().map((entry) => (entry as { action?: { onClick?: () => void } }).action).find((action) => action?.onClick);
    assert.ok(undo, 'the removal offers an Undo');
    await React.act(async () => { undo!.onClick!(); });
    await until(() => !!document.querySelector('[data-widget-zone="droite"] [data-widget-id="plugin:fixture:card"]'), 'Undo to restore the card');
    assert.ok(document.querySelector('[data-widget-zone="droite"] [data-widget-id="plugin:fixture:card"]'), 'Undo restores the card in its zone');
  } finally {
    await cleanup();
  }
});

test('a right click on the title opens the menu; the body and a field keep the browser\'s', async () => {
  const { React, until, cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200 },
  ]);
  try {
    const card = document.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:card"]')!;
    const press = (target: Element) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    // The menu opens in the handler of the event, under act(): a menu wrongly
    // opened from a field would already be painted here.
    await React.act(async () => { assert.equal(press(card.querySelector('[data-field]')!), false, 'a field keeps its native menu'); });
    await React.act(async () => { assert.equal(press(card.querySelector('[data-body] p')!), false, 'the body keeps its native menu'); });
    assert.equal(document.querySelectorAll('[role="menu"]').length, 0);
    await React.act(async () => { assert.equal(press(card.querySelector('.widget-content > section > header')!), true); });
    await until(() => document.querySelectorAll('[role="menu"]').length > 0, 'the right click to open the menu');
    assert.equal(document.querySelectorAll('[role="menu"]').length, 1, 'the same menu as the gear');
  } finally {
    await cleanup();
  }
});

test('in a stack, resting on a tab shows the hint and a right click on a tab opens the menu', async () => {
  const { React, dom, until, cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200, group: 'stack:t:1', activeTab: true },
    { id: 'plugin:fixture:bell', rail: 'droite', rang: 1, hauteur: 200, group: 'stack:t:1' },
  ]);
  try {
    const { isOnTitleHandle } = await import('../components/widget-host/widget-card');
    const card = document.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:card"][data-tabbed]')!;
    assert.ok(card, 'the stack is painted');
    const tab = card.querySelector<HTMLElement>('[role="tab"]')!;
    const shape = { bare: false, tabbed: true };
    assert.equal(isOnTitleHandle(card, tab, 0, shape), false, 'a press on a tab is the tab\'s own drag');
    assert.equal(isOnTitleHandle(card, tab, 0, shape, true), true, 'but the tab is a title for the hint');
    const event = new dom.window.MouseEvent('pointermove', { bubbles: true, clientY: 5 });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    await React.act(async () => { tab.dispatchEvent(event); });
    await until(() => card.getAttribute('data-drag-ready') === 'true', 'resting on a tab to show the hint');
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    await React.act(async () => { tab.dispatchEvent(menu); });
    assert.equal(menu.defaultPrevented, true);
    await until(() => document.querySelectorAll('[role="menu"]').length > 0, 'the right click on a tab to open the menu');
  } finally {
    await cleanup();
  }
});

test('Done lives in the widget window, and closing the window ends the layout gesture', async () => {
  const { React, seen, until, cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200 },
  ]);
  const openWindow = async () => {
    await React.act(async () => { seen.setPaletteOpen(true); });
    await until(() => !!document.querySelector('[role="dialog"]'), 'the widget window to open');
  };
  try {
    assert.ok(!document.querySelector('[role="dialog"]'), 'no window until Add widget');
    await openWindow();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, 'Add widget opens the window');
    const labels = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === 'Done');
    assert.equal(labels.length, 1, 'a single Done');
    assert.ok(dialog.contains(labels[0]!), 'inside the window, not floating at the bottom left');
    assert.equal(dialog.querySelectorAll('select').length, 0, 'no zone menu on the cards');
    await React.act(async () => { dialog.querySelector<HTMLElement>('button[aria-label^="Close"]')!.click(); });
    await until(() => seen.editing === false && !document.querySelector('[role="dialog"]'), 'closing the window to put the zones away');
    assert.equal(seen.editing, false);
    assert.ok(!document.querySelector('[role="dialog"]'));
    for (const close of [(d: HTMLElement) => d.querySelectorAll<HTMLElement>('button')[d.querySelectorAll('button').length - 1]!.click(), (d: HTMLElement) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))]) {
      await openWindow();
      await React.act(async () => { close(document.querySelector<HTMLElement>('[role="dialog"]')!); });
      await until(() => seen.editing === false, 'closing the window to put the zones away');
      assert.equal(seen.editing, false);
    }
  } finally {
    await cleanup();
  }
});

test('a widget picked from the window is painted live in the hand, and the cards have no plus button', async () => {
  const { React, dom, seen, until, cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200, removed: true },
  ]);
  try {
    await React.act(async () => { seen.setPaletteOpen(true); });
    await until(() => !!document.querySelector('[role="dialog"] button[aria-label^="Drag"]'), 'the window to offer the card');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(dialog, 'the window is open');
    assert.ok(!dialog.querySelector('button[aria-label^="Add"]'), 'no plus button on the card');
    const item = dialog.querySelector<HTMLElement>('button[aria-label^="Drag"]')!;
    assert.ok(item, 'the card is the drag source');
    await React.act(async () => {
      item.focus();
      item.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    });
    await until(() => seen.dragging !== null, 'the keyboard to pick the card up');
    assert.equal(seen.dragging, 'plugin:fixture:card');
    const hand = Array.from(document.querySelectorAll<HTMLElement>('.shadow-elev-2')).find((el) => !dialog.contains(el) && el.textContent?.includes('card'));
    assert.ok(hand, 'the hand holds the widget itself, not a label');
  } finally {
    await cleanup();
  }
});

test('a widget follows the site style until it makes its own choice, and can go back', async () => {
  const { React, seen, until, cleanup } = await mountZones([
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 200 },
  ]);
  const root = document.documentElement;
  const card = () => document.querySelector<HTMLElement>('[data-widget-id="plugin:fixture:card"]')!;
  try {
    assert.equal(card().getAttribute('data-borderless'), null);
    // The site says: no borders. The widget made no choice, so it follows.
    await React.act(async () => { root.setAttribute('data-widgets-borderless', ''); window.dispatchEvent(new Event('timon:glass')); });
    await until(() => card().hasAttribute('data-borderless'), 'the card to follow the site');
    assert.equal(card().hasAttribute('data-borderless'), true, 'follows the site');
    // Its own choice wins: bordered, whatever the site does.
    await open(React, until, gearButton()!);
    const box = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')).find((el) => /No borders/.test(el.textContent ?? ''))!;
    assert.equal(box.getAttribute('aria-checked'), 'true', 'the menu shows what is in effect');
    assert.ok(!Array.from(document.querySelectorAll('[role="menuitem"]')).some((el) => /Follow the site style/.test(el.textContent ?? '')), 'nothing to go back to yet');
    await React.act(async () => { box.click(); });
    await until(() => !card().hasAttribute('data-borderless') && menuEntries().length === 0, 'the card\'s own choice and the menu to close');
    assert.equal(card().hasAttribute('data-borderless'), false, 'its own choice wins over the site');
    // Back to the site's style.
    await open(React, until, gearButton()!);
    const follow = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => /Follow the site style/.test(el.textContent ?? ''))!;
    assert.ok(follow, 'a widget with its own choice can follow the site again');
    await React.act(async () => { follow.click(); });
    await until(() => card().hasAttribute('data-borderless'), 'the card to follow the site again');
    assert.equal(card().hasAttribute('data-borderless'), true);
  } finally {
    document.documentElement.removeAttribute('data-widgets-borderless');
    await cleanup();
  }
});
