import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { declareSlot, register, resetSlotsForTests, slotEntries, slotEntry, slotKind } from './plugin-host/slots';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderSlotEntries, SlotKeyed, SlotRegion, SlotSingle } from './plugin-host/render';
import { NEXT_ROUTER_KEY } from './plugin-host/page-slot';
import { OVERLAY_LAYER_CLASS, UI_LAYOUT_CHILD_SLOTS } from './plugin-host/ui-layout';
import { PluginBoundary } from './plugin-host/plugin-boundary';
import { clientContext } from './plugin-host/loader';
import { SETTINGS_GRAFT_SLOTS } from './plugin-host/settings-slots';
import { ClientPluginHost, declareLayoutSlots } from './plugin-host/client-plugin-host';
import { PluginRoutePageView } from '../app/(main)/[...route]/route-view';
import { mountBundledClients } from '@/plugins-client/mount';
import type { Capabilities } from './capabilities';

const Empty = () => React.createElement('div');

test('register refuses an undeclared slot', () => {
  resetSlotsForTests();
  assert.throws(() => register({ slot: 'absent', pluginId: 'fixture' }, Empty), /not declared/);
});

test('disposing root recursively collapses its child slots', () => {
  resetSlotsForTests();
  const dispose = register({ slot: 'root', pluginId: 'layout', children: { page: 'single', 'nav.item': 'list' } }, Empty);
  register({ slot: 'nav.item', pluginId: 'child', children: { nested: 'keyed' } }, Empty);
  assert.equal(slotKind('nested'), 'keyed');
  dispose();
  assert.equal(slotKind('page'), null);
  assert.equal(slotKind('nav.item'), null);
  assert.equal(slotKind('nested'), null);
});

test('blank layout only declares page and accepts the Next page', () => {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: 'blank-layout', children: { page: 'keyed' } }, Empty);
  register({ slot: 'page', pluginId: 'next-router', key: NEXT_ROUTER_KEY }, Empty);
  assert.equal(slotEntries('page').length, 1);
  assert.equal(slotKind('nav.item'), null);
  assert.equal(slotKind('cockpit.widget'), null);
});

test('each entry has its own boundary: an error does not replace its neighbours', () => {
  resetSlotsForTests();
  declareSlot('items', 'list');
  register({ slot: 'items', pluginId: 'throws' }, () => { throw new Error('boum'); });
  register({ slot: 'items', pluginId: 'healthy' }, Empty);
  const rendered = renderSlotEntries(slotEntries('items'));
  assert.equal(rendered.length, 2);
  assert.ok(rendered.every((entry) => entry.type === PluginBoundary));
  assert.deepEqual(PluginBoundary.getDerivedStateFromError(), { failed: true });
});

test('the layout declares both sidebar widget zones as lists', () => {
  assert.equal(UI_LAYOUT_CHILD_SLOTS['sidebar.left.widget'], 'list');
  assert.equal(UI_LAYOUT_CHILD_SLOTS['sidebar.right.widget'], 'list');
});

test('a widget registered in sidebar.left.widget is rendered', () => {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, Empty);
  register(
    { slot: 'sidebar.left.widget', pluginId: 'fixture' },
    () => React.createElement('p', null, 'left widget'),
  );
  const html = renderToStaticMarkup(
    React.createElement(SlotRegion, { name: 'sidebar.left.widget', className: 'border-t' }),
  );
  assert.match(html, /left widget/);
});

test('an empty widget zone renders no container at all', () => {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, Empty);
  const html = renderToStaticMarkup(
    React.createElement(SlotRegion, { name: 'sidebar.right.widget', className: 'border-l p-3' }),
  );
  assert.equal(html, '');
});

/**
 * Mounts the Timon layout so every slot named below genuinely exists. Without
 * it a refusal test would pass on "slot not declared" and prove nothing about
 * admission.
 */
function mountLayout(): void {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, Empty);
}

test('a widget declared for the cockpit can be placed in a sidebar widget zone', () => {
  mountLayout();
  const context = clientContext('fixture', ['cockpit.widget']);
  context.slots.register({ slot: 'sidebar.left.widget' }, Empty);
  context.slots.register({ slot: 'sidebar.right.widget' }, Empty);
  assert.equal(slotEntries('sidebar.left.widget').length, 1);
  assert.equal(slotEntries('sidebar.right.widget').length, 1);
});

test('a widget stays out of slots of another nature, declared or not', () => {
  mountLayout();
  const context = clientContext('fixture', ['cockpit.widget']);
  for (const slot of ['root', 'page', 'settings.section', 'settings.missions', 'nav.item', 'nav.footer']) {
    const before = slotEntries(slot).length;
    assert.throws(
      () => context.slots.register({ slot }, Empty),
      /is not allowed in slot .*: its manifest declares cockpit\.widget/,
      `${slot} should refuse a widget`,
    );
    assert.equal(slotEntries(slot).length, before, `${slot} must be left untouched`);
  }
});

test('nav.footer is a list declared at boot, open only to a plugin that declares it', () => {
  assert.equal(UI_LAYOUT_CHILD_SLOTS['nav.footer'], 'list');
  mountLayout();
  const navOnly = clientContext('nav-only', ['nav.item']);
  assert.throws(() => navOnly.slots.register({ slot: 'nav.footer' }, Empty), /is not allowed in slot nav\.footer/);
  assert.equal(slotEntries('nav.footer').length, 0, 'declaring nav.item does not open the foot of the nav');
  const footer = clientContext('switcher', ['nav.footer']);
  footer.slots.register({ slot: 'nav.footer', order: 20 }, Empty);
  footer.slots.register({ slot: 'nav.footer', key: 'first', order: 10 }, Empty);
  assert.deepEqual(slotEntries('nav.footer').map((e) => e.order), [10, 20]);
  assert.throws(() => footer.slots.register({ slot: 'nav.item' }, Empty), /is not allowed in slot nav\.item/);
});

test('settings graft slots are lists declared at boot, distinct from settings.section', () => {
  assert.equal(UI_LAYOUT_CHILD_SLOTS['settings.section'], 'keyed');
  assert.equal(UI_LAYOUT_CHILD_SLOTS['settings.llm-fallback'], undefined, 'hyphen is an illegal slot name');
  for (const [name, kind] of Object.entries(SETTINGS_GRAFT_SLOTS)) {
    assert.equal(kind, 'list', name);
    assert.equal(UI_LAYOUT_CHILD_SLOTS[name], 'list', name);
    assert.match(name, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/, name);
  }
});

test('a theme plugin that declares settings.section occupies its own category', () => {
  mountLayout();
  const context = clientContext('@timon/ui-theme', ['theme', 'settings.section']);
  context.slots.register({ slot: 'theme' }, Empty);
  context.slots.register({ slot: 'settings.section' }, Empty);
  assert.equal(slotEntries('theme').length, 1);
  assert.equal(slotEntries('settings.section').length, 1);
  assert.equal(slotEntries('settings.section')[0]?.pluginId, '@timon/ui-theme');
});

test('settings graft admission is exact: one native group does not open another', () => {
  mountLayout();
  const widget = clientContext('widget-only', ['cockpit.widget']);
  assert.throws(() => widget.slots.register({ slot: 'settings.section' }, Empty), /is not allowed in slot settings\.section/);
  assert.throws(() => widget.slots.register({ slot: 'settings.missions' }, Empty), /is not allowed in slot settings\.missions/);

  const graft = clientContext('missions-graft', ['settings.missions']);
  graft.slots.register({ slot: 'settings.missions' }, Empty);
  assert.equal(slotEntries('settings.missions').length, 1);
  assert.throws(() => graft.slots.register({ slot: 'settings.resources' }, Empty), /is not allowed in slot settings\.resources/);
  assert.throws(() => graft.slots.register({ slot: 'settings.section' }, Empty), /is not allowed in slot settings\.section/);
  assert.equal(slotEntries('settings.resources').length, 0);
  assert.equal(slotEntries('settings.section').length, 0);
});

test('a non-widget plugin keeps exactly the slots of its manifest', () => {
  mountLayout();
  const context = clientContext('fixture', ['nav.item']);
  context.slots.register({ slot: 'nav.item' }, Empty);
  assert.throws(() => context.slots.register({ slot: 'topbar.item' }, Empty), /is not allowed in slot/);
  assert.throws(() => context.slots.register({ slot: 'sidebar.left.widget' }, Empty), /is not allowed in slot/);
  assert.equal(slotEntries('nav.item').length, 1);
});

test('disposing the plugin context removes what it placed in the widget zones', () => {
  mountLayout();
  const context = clientContext('fixture', ['cockpit.widget']);
  context.slots.register({ slot: 'sidebar.right.widget' }, Empty);
  context.dispose();
  assert.equal(slotEntries('sidebar.right.widget').length, 0);
});

test('the layout declares the overlay layer as a list', () => {
  assert.equal(UI_LAYOUT_CHILD_SLOTS['overlay'], 'list');
});

test('an overlay is rendered above the chrome, and nothing paints while empty', () => {
  mountLayout();
  const empty = renderToStaticMarkup(React.createElement(SlotRegion, { name: 'overlay', className: 'fixed' }));
  assert.equal(empty, '', 'a stock install must not reserve a full-screen layer');
  register({ slot: 'overlay', pluginId: 'fixture' }, () => React.createElement('p', null, 'mascot'));
  const html = renderToStaticMarkup(React.createElement(SlotRegion, { name: 'overlay', className: 'fixed' }));
  assert.match(html, /mascot/);
});

test('overlay admission is exact: a widget never lands there, an overlay never lands in a rail', () => {
  mountLayout();
  const widget = clientContext('widget-only', ['cockpit.widget']);
  assert.throws(() => widget.slots.register({ slot: 'overlay' }, Empty), /is not allowed in slot overlay/);
  assert.equal(slotEntries('overlay').length, 0);

  const overlay = clientContext('overlay-only', ['overlay']);
  overlay.slots.register({ slot: 'overlay' }, Empty);
  assert.throws(() => overlay.slots.register({ slot: 'sidebar.right.widget' }, Empty), /is not allowed in slot/);
  assert.equal(slotEntries('overlay').length, 1);
});

test('one plugin can be both a widget and an overlay — two registrations, one identity', () => {
  mountLayout();
  const context = clientContext('mascot', ['cockpit.widget', 'overlay']);
  context.slots.register({ slot: 'cockpit.widget' }, Empty);
  context.slots.register({ slot: 'overlay' }, Empty);
  assert.equal(slotEntries('cockpit.widget').length, 1);
  assert.equal(slotEntries('overlay').length, 1);
  context.dispose();
  assert.equal(slotEntries('overlay').length, 0, 'disposing the plugin takes both insertions away');
});

test('the page slot is keyed by route, and the Next tree keeps a reserved key', () => {
  mountLayout();
  assert.equal(slotKind('page'), 'keyed');
  register({ slot: 'page', pluginId: 'next-router', key: NEXT_ROUTER_KEY }, Empty);
  register({ slot: 'page', pluginId: 'example-page', key: '/example' }, Empty);
  assert.equal(slotEntry('page', NEXT_ROUTER_KEY)?.pluginId, 'next-router');
  assert.equal(slotEntry('page', '/example')?.pluginId, 'example-page');
});

test('a page plugin cannot take a route the product already serves', () => {
  mountLayout();
  register({ slot: 'page', pluginId: 'example-page', key: '/settings' }, Empty);
  assert.throws(
    () => register({ slot: 'page', pluginId: 'other-page', key: '/settings' }, Empty),
    /Key already taken/,
  );
  assert.equal(slotEntry('page', '/settings')?.pluginId, 'example-page');
});

test('the layout paints the reserved key, never every page at once', () => {
  mountLayout();
  register({ slot: 'page', pluginId: 'next-router', key: NEXT_ROUTER_KEY }, () => React.createElement('p', null, 'next tree'));
  register({ slot: 'page', pluginId: 'example-page', key: '/example' }, () => React.createElement('p', null, 'plugin page'));
  const html = renderToStaticMarkup(React.createElement(SlotKeyed, { name: 'page', entryKey: NEXT_ROUTER_KEY }));
  assert.match(html, /next tree/);
  assert.doesNotMatch(html, /plugin page/);
});

test('a free key renders its fallback, so an unrouted path can say so', () => {
  mountLayout();
  const html = renderToStaticMarkup(
    React.createElement(SlotKeyed, { name: 'page', entryKey: '/nowhere', fallback: React.createElement('p', null, 'unknown route') }),
  );
  assert.match(html, /unknown route/);
});

test('a list slot paints its entries in declared order, and the unranked last', () => {
  resetSlotsForTests();
  declareSlot('rail', 'list');
  register({ slot: 'rail', pluginId: 'third-party' }, Empty);
  register({ slot: 'rail', pluginId: 'more', order: 200 }, Empty);
  register({ slot: 'rail', pluginId: 'main', order: 10 }, Empty);
  assert.deepEqual(slotEntries('rail').map((e) => e.pluginId), ['main', 'more', 'third-party']);
});

test('two entries of the same rank keep their registration order', () => {
  resetSlotsForTests();
  declareSlot('rail', 'list');
  register({ slot: 'rail', pluginId: 'first', order: 10 }, Empty);
  register({ slot: 'rail', pluginId: 'second', order: 10 }, Empty);
  register({ slot: 'rail', pluginId: 'unranked-first' }, Empty);
  register({ slot: 'rail', pluginId: 'unranked-second' }, Empty);
  assert.deepEqual(
    slotEntries('rail').map((e) => e.pluginId),
    ['first', 'second', 'unranked-first', 'unranked-second'],
  );
});


test('a single slot paints its default occupant until a plugin claims it', () => {
  resetSlotsForTests();
  declareSlot('surface', 'single');
  register({ slot: 'surface', pluginId: 'product', fallback: true }, () => React.createElement('p', null, 'native'));
  assert.match(renderToStaticMarkup(React.createElement(SlotSingle, { name: 'surface' })), /native/);

  const dispose = register({ slot: 'surface', pluginId: 'third-party' }, () => React.createElement('p', null, 'plugin'));
  const claimed = renderToStaticMarkup(React.createElement(SlotSingle, { name: 'surface' }));
  assert.match(claimed, /plugin/);
  assert.doesNotMatch(claimed, /native/, 'the default steps aside, it does not stack');

  dispose();
  assert.match(
    renderToStaticMarkup(React.createElement(SlotSingle, { name: 'surface' })),
    /native/,
    'removing the plugin gives the product surface back',
  );
});

test('a chosen layout may redeclare children the host already holds', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  register({ slot: 'root', pluginId: '@timon/ui-layout', fallback: true }, Empty);
  register({ slot: 'root', pluginId: 'blank-layout', children: { page: 'keyed' } }, Empty);
  assert.equal(slotEntries('root')[0]?.pluginId, 'blank-layout');
  assert.equal(slotKind('page'), 'keyed');
  assert.equal(slotKind('nav.item'), 'list', 'the host still owns the chrome slots');
});

test('a single slot still holds one claimant and one default, no more', () => {
  resetSlotsForTests();
  declareSlot('surface', 'single');
  register({ slot: 'surface', pluginId: 'product', fallback: true }, Empty);
  register({ slot: 'surface', pluginId: 'first' }, Empty);
  assert.throws(() => register({ slot: 'surface', pluginId: 'second' }, Empty), /already taken/);
  assert.throws(() => register({ slot: 'surface', pluginId: 'other', fallback: true }, Empty), /Default occupant/);
  assert.equal(slotEntries('surface').length, 2);
});

test('an empty single slot paints nothing', () => {
  resetSlotsForTests();
  declareSlot('surface', 'single');
  assert.equal(renderToStaticMarkup(React.createElement(SlotSingle, { name: 'surface' })), '');
});


test('the overlay layer lets clicks through, except on what a plugin paints', () => {
  // The contract of the `examples/plugin-overlay` template: it positions
  // itself as `fixed` and expects the layer to steal neither its clicks nor
  // its place. A full-screen layer that caught the pointer would make the whole
  // application inert from the first installed plugin.
  assert.match(OVERLAY_LAYER_CLASS, /\bfixed\b/);
  assert.match(OVERLAY_LAYER_CLASS, /\binset-0\b/);
  assert.match(OVERLAY_LAYER_CLASS, /pointer-events-none/);
  assert.match(OVERLAY_LAYER_CLASS, /\[&>\*\]:pointer-events-auto/);
  // Above the chrome, under the modals: a mascot does not cover a
  // dialog.
  const z = Number(/z-\[(\d+)\]/.exec(OVERLAY_LAYER_CLASS)?.[1]);
  assert.ok(z > 20 && z < 50, `z-index outside the expected window: ${z}`);

  mountLayout();
  register({ slot: 'overlay', pluginId: 'mascot' }, () =>
    React.createElement('div', { style: { position: 'fixed', right: 16, bottom: 16 } }, 'suricate'));
  const html = renderToStaticMarkup(
    React.createElement(SlotRegion, { name: 'overlay', className: OVERLAY_LAYER_CLASS }),
  );
  assert.match(html, /suricate/);
  // The plugin keeps ITS positioning: the layer is not a placement
  // host, it sets neither frame nor coordinates (§10.12 — not WidgetHost).
  assert.match(html, /position:fixed/);
  assert.doesNotMatch(html, /data-widget|cursor-grab/);
});

/**
 * Gallery toggle used to refresh only its own list. The slot registry that
 * drives SlotKeyed on the catch-all waited for the async plugins_changed SSE
 * echo — navigating to a just-disabled page flashed the old content. The
 * toggle must await syncClientPlugins on this tab (SSE still covers others).
 */
test('gallery toggle awaits syncClientPlugins after a successful enable POST', () => {
  const src = readFileSync(new URL('../app/(main)/plugins/plugins-client.tsx', import.meta.url), 'utf8');
  assert.match(src, /import \{ syncClientPlugins \} from '@\/lib\/plugin-host\/loader'/);
  // `load` now takes a `strict` flag so a failed gallery GET cannot pass for a
  // successful refresh; the sync itself is still awaited on this tab.
  assert.match(src, /await Promise\.all\(\[load\(\{ strict: true \}\), syncClientPlugins\(\)\]\)/);
  // The early `if (!response.ok) return;` this test used to pin WAS the bug:
  // it dropped 401/403/404 on the floor, which is what made a refused switch
  // look like a dead one. A refusal is now shown to the user.
  assert.doesNotMatch(src, /if \(!response\.ok\) return;/);
  assert.match(src, /toggleFailureMessage\(response\.status, body\)/);
});

function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    edition: 'expert',
    profile: 'host',
    capabilities: [],
    modules: [],
    ui: { hidden: [], home: '/' },
    kernel: true,
    developer: { unsignedPlugins: false },
    ...overrides,
  };
}

/**
 * Distinct from the gallery-toggle flash (same tab, SSE lag). A cold
 * reload of a disabled product page used to paint its content for ~0.5s:
 * caps start null, isModuleOn fail-opens, the host's first effect registers
 * the page, SlotKeyed paints it, then fetchCapabilities resolves and the
 * entry is disposed. The catch-all must keep the loading fallback until
 * capabilities have loaded once — even if an entry is already registered.
 *
 * renderToStaticMarkup does not run effects, so we replay what
 * ClientPluginHost's first effect does with caps=null (declare slots +
 * mountBundledClients). The host itself is still mounted in the tree.
 */
test('catch-all holds loading while caps are null even if a bundled page is already registered', () => {
  // `/triggers` rather than `/dreams`: Dreams withholds its surfaces for the
  // beta unless its `ui` option is true, so it registers nothing with null caps.
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);
  assert.equal(slotEntry('page', '/triggers')?.pluginId, '@timon/triggers', 'fail-open registers the page before caps load');

  const html = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ClientPluginHost),
      React.createElement(PluginRoutePageView, { pathname: '/triggers', synced: true, caps: null }),
    ),
  );
  assert.match(html, /Loading plugins/);
  assert.doesNotMatch(html, /Triggers<\/h1>/);

  const off = capabilities({
    modules: [
      { id: '@timon/routines', tier: 'std', active: false, reason: null, missing: [] },
      { id: '@timon/triggers', tier: 'std', active: false, reason: null, missing: [] },
    ],
  });
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(off);
  assert.equal(slotEntry('page', '/triggers'), null);

  const htmlOff = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ClientPluginHost),
      React.createElement(PluginRoutePageView, { pathname: '/triggers', synced: true, caps: off }),
    ),
  );
  assert.match(htmlOff, /No page is registered for \/triggers/);
  assert.doesNotMatch(htmlOff, /Triggers<\/h1>/);
  assert.doesNotMatch(htmlOff, /Loading plugins/);
});

test('catch-all paints a registered page once capabilities have loaded', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  register(
    { slot: 'page', pluginId: '@timon/dreams', key: '/dreams' },
    () => React.createElement('h1', null, '🌙 Dreams — fixture'),
  );
  const html = renderToStaticMarkup(
    React.createElement(PluginRoutePageView, {
      pathname: '/dreams',
      synced: true,
      caps: capabilities(),
    }),
  );
  assert.match(html, /🌙 Dreams — fixture/);
  assert.doesNotMatch(html, /Loading plugins/);
});
