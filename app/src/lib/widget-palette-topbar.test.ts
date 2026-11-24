import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The widget window, mounted in the real host, with the top bar's compact
 * widgets taken out (TODO #479, regression of 28/10/2026): Working agents, the
 * bell and the quota ring must be listed, found by a search, grouped under a
 * Top bar tab, and droppable into the top bar and into a sidebar.
 */
const WORKING = 'plugin:@timon/agents:working';
const BELL = 'plugin:@timon/notifications:bell';
const QUOTA = 'plugin:quota-monitor:quota';
const GIT = 'plugin:@timon/git:repository';
const CLOCK = 'plugin:@timon/ui-layout:clock';

async function mountPalette(stored: unknown[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
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
  const { TOPBAR_CENTER_ZONE } = await import('../components/widget-host/widget-catalog');

  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  const flat = (name: string) => () => React.createElement('span', null, name);
  // The registrations the product makes, reduced to what placement reads.
  register({ slot: 'cockpit.widget', pluginId: '@timon/agents', key: 'working', widget: { title: 'Working agents', description: 'Agents at work', frame: 'none', bar: true, placedByDefault: true, zone: TOPBAR_CENTER_ZONE } }, flat('working') as never);
  register({ slot: 'cockpit.widget', pluginId: '@timon/notifications', key: 'bell', widget: { title: 'Notification bell', frame: 'none', bar: true, placedByDefault: true, zone: 'topbar.widget' } }, flat('bell') as never);
  register({ slot: 'cockpit.widget', pluginId: 'quota-monitor', key: 'quota', widget: { title: 'LLM quotas', frame: 'none', bar: true, placedByDefault: true, zone: 'topbar.widget' } }, flat('quota') as never);
  register({ slot: 'cockpit.widget', pluginId: '@timon/ui-layout', key: 'clock', widget: { title: 'Clock', zone: 'gauche' } }, flat('clock') as never);
  register({ slot: 'cockpit.widget', pluginId: '@timon/git', key: 'repository', widget: { title: 'Git', zone: 'chat.right.widget' } }, flat('git') as never);

  const seen: { droppables: string[]; dragging: string | null; host: ReturnType<typeof useWidgetHost> | null } = { droppables: [], dragging: null, host: null };
  function Probe() {
    const { droppableContainers } = useDndContext();
    const host = useWidgetHost();
    seen.droppables = [...droppableContainers.values()].filter((c) => !c.disabled).map((c) => String(c.id));
    seen.dragging = host.dragging;
    seen.host = host;
    return null;
  }

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => {
    root.render(React.createElement(PathnameContext.Provider, { value: '/chat' },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(WidgetHost, null,
            React.createElement(WidgetZone, { zone: TOPBAR_CENTER_ZONE, slot: 'topbar.widget', orientation: 'horizontal', hideWhenEmpty: true, label: 'Top bar, middle' }),
            React.createElement(WidgetZone, { zone: 'topbar.widget', slot: 'topbar.widget', orientation: 'horizontal', hideWhenEmpty: true, label: 'Top bar' }),
            React.createElement(WidgetZone, { zone: 'sidebar.left.widget', slot: 'sidebar.left.widget', compact: true, hideWhenEmpty: true, label: 'Rail' }),
            React.createElement(WidgetZone, { zone: 'chat.right.widget', slot: 'chat.right.widget', label: 'Chat' }),
            React.createElement(Probe))))));
  });
  await until(() => !!document.querySelector(`[data-widget-id="${GIT}"]`), 'the stored layout to be painted');
  const cleanup = async () => {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  };
  return { React, dom, seen, until, cleanup };
}

const removedAll = [
  { id: GIT, rail: 'chat.right.widget', rang: 0, hauteur: 300 },
  { id: WORKING, rail: 'topbar.center.widget', rang: 0, hauteur: 300, removed: true },
  { id: BELL, rail: 'topbar.widget', rang: 0, hauteur: 320, removed: true },
  { id: QUOTA, rail: 'topbar.widget', rang: 1, hauteur: 260, removed: true },
];

// The host mounts the window itself (loaded on demand) once it opens.
const cards = () => Array.from(document.querySelectorAll('[role="dialog"] li')).map((li) => li.querySelector('.font-medium')?.textContent);

test('the widget window lists the removed top bar widgets, under a Top bar tab and by search', async () => {
  const { React, dom, seen, until, cleanup } = await mountPalette(removedAll);
  try {
    assert.ok(!document.querySelector('[data-widget-zone="topbar.center.widget"] [data-widget-id]'), 'removed: not in the bar');
    await React.act(async () => { seen.host?.setPaletteOpen(true); });
    await until(() => cards().length > 0, 'the widget window to open');
    assert.deepEqual(cards().sort(), ['Clock', 'LLM quotas', 'Notification bell', 'Working agents']);

    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((b) => b.textContent);
    assert.ok(tabs.includes('Top bar'), `a Top bar tab (${tabs.join(', ')})`);
    const topbarTab = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) => b.textContent === 'Top bar')!;
    await React.act(async () => { topbarTab.click(); });
    assert.deepEqual(cards().sort(), ['LLM quotas', 'Notification bell', 'Working agents']);

    const search = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await React.act(async () => {
      setValue.call(search, 'working');
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(cards(), ['Working agents']);

    // Lifted from the window, it may land in the middle of the bar and in a sidebar.
    const grip = document.querySelector<HTMLElement>('[role="dialog"] li button')!;
    await React.act(async () => {
      grip.focus();
      grip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    });
    await until(() => seen.dragging !== null, 'the keyboard to lift Working agents');
    assert.equal(seen.dragging, WORKING);
    assert.ok(seen.droppables.includes('zone:topbar.center.widget'), 'the middle of the top bar takes it');
    assert.ok(seen.droppables.includes('zone:sidebar.left.widget'), 'a sidebar takes it');
    await React.act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    });
    await until(() => seen.dragging === null, 'Escape to cancel the drag');
  } finally {
    await cleanup();
  }
});

test('a view stored before the widget existed shows it in the middle of the top bar', async () => {
  // The /chat row of the regression: the former "Agents list" card in a chat
  // column tab, the bell and quotas on the right of the bar, no Working agents.
  const { cleanup } = await mountPalette([
    { id: GIT, rail: 'chat.right.widget', rang: 0, hauteur: 300 },
    { id: 'plugin:@timon/agents:team', rail: 'chat.right.widget#muvis5up', rang: 1, hauteur: 300 },
    { id: BELL, rail: 'topbar.widget', rang: 0, hauteur: 320 },
  ]);
  try {
    assert.ok(document.querySelector(`[data-widget-zone="topbar.center.widget"] [data-widget-id="${WORKING}"]`), 'in the middle of the bar');
    assert.ok(document.querySelector(`[data-widget-zone="topbar.widget"] [data-widget-id="${QUOTA}"]`), 'the quota ring too, never named by the row');
  } finally {
    await cleanup();
  }
});
