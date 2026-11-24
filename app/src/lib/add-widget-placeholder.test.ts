import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * "Your widget here" (`add-widget.ts`), mounted in the real host: alone in
 * its column it keeps its own height at the foot of the column; beside other
 * cards it takes its share; its + opens the widget window, which never lists
 * the placeholder itself.
 */
async function mount(stored: unknown[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
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
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../components/workspace-layout-provider');
  const { WidgetHost, useWidgetHost } = await import('../components/widget-host/widget-host');
  const { WidgetZone } = await import('../components/widget-host/widget-zone');
  const { AddWidgetCard } = await import('../components/widget-host/add-widget-card');
  const { ADD_WIDGET_KEYS, ADD_WIDGET_MODULE } = await import('../components/widget-host/add-widget');

  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  for (const key of ADD_WIDGET_KEYS) {
    register({ slot: 'cockpit.widget', pluginId: ADD_WIDGET_MODULE, key, widget: { title: 'Your widget here', frame: 'none', height: 160 } }, AddWidgetCard as never);
  }
  register({ slot: 'cockpit.widget', pluginId: 'fixture', key: 'card', widget: { title: 'Card' } }, () => React.createElement('p', null, 'card'));

  const seen = { paletteOpen: false };
  function Probe() {
    seen.paletteOpen = useWidgetHost().paletteOpen;
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => {
    root.render(React.createElement(PathnameContext.Provider, { value: '/' },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(WidgetHost, null,
            React.createElement(WidgetZone, { zone: 'gauche', slot: 'cockpit.widget', label: 'Left' }),
            React.createElement(WidgetZone, { zone: 'droite', slot: 'cockpit.widget', label: 'Right' }),
            React.createElement(Probe))))));
  });
  await until(() => document.querySelectorAll('[data-widget-id]').length >= stored.length, 'the stored cards to be painted');
  const cleanup = async () => {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
    dom.window.close();
  };
  return { React, seen, until, cleanup };
}

const ADD = 'plugin:@timon/ui-layout:add-widget';
const ADD_2 = 'plugin:@timon/ui-layout:add-widget-2';

test('alone in its column, "Your widget here" keeps its height at the foot; beside a card it takes its share', async () => {
  const { cleanup } = await mount([
    { id: ADD, rail: 'gauche', rang: 0, hauteur: 160 },
    { id: 'plugin:fixture:card', rail: 'droite', rang: 0, hauteur: 300, heightMode: 'fill', fillPercent: 66 },
    { id: ADD_2, rail: 'droite', rang: 1, hauteur: 160, heightMode: 'fill', fillPercent: 34 },
  ]);
  try {
    const left = document.querySelector('[data-widget-zone="gauche"]')!;
    const alone = left.querySelector<HTMLElement>(`[data-widget-id="${ADD}"]`)!;
    assert.equal(alone.getAttribute('data-height-mode'), 'fixed', 'no share: its own height');
    const spacer = left.querySelector('[data-add-widget-spacer]');
    assert.ok(spacer, 'a spacer pushes it down');
    assert.ok(spacer.compareDocumentPosition(alone) & 4, 'the spacer comes first: the card sits at the foot');

    const right = document.querySelector('[data-widget-zone="droite"]')!;
    assert.ok(!right.querySelector('[data-add-widget-spacer]'), 'beside a card, no spacer');
    const shared = right.querySelector<HTMLElement>(`[data-widget-id="${ADD_2}"]`)!;
    assert.equal(shared.getAttribute('data-height-mode'), 'fill', 'it takes its share of the column');
  } finally {
    await cleanup();
  }
});

test('its + opens the widget window, which does not offer the placeholder', async () => {
  const { React, seen, until, cleanup } = await mount([{ id: ADD, rail: 'gauche', rang: 0, hauteur: 160 }]);
  try {
    assert.equal(seen.paletteOpen, false);
    const button = document.querySelector<HTMLButtonElement>('[data-add-widget]')!;
    assert.ok(button, 'the dashed card shows its +');
    await React.act(async () => { button.click(); });
    await until(() => seen.paletteOpen, 'the widget window to open');
    const dialog = () => document.querySelector('[role="dialog"]');
    await until(() => dialog()?.textContent?.includes('Card') ?? false, 'the window to list the card taken out');
    assert.ok(!dialog()!.textContent!.includes('Your widget here'), 'the placeholder taken out is not a widget to pick');
  } finally {
    await cleanup();
  }
});
