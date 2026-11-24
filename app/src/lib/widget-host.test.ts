import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancelDrag,
  crossZoneTarget,
  isZoneDropId,
  resolveDrop,
  zoneAcceptsWidget,
  zoneDropId,
  zoneOfDragId,
  DEFAULT_WIDGET_SLOTS,
} from '../components/widget-host/widget-dnd';
import {
  moveWidget,
  mergeLayout,
  reorderZone,
  removeWidget,
  widgetsAllowedByConfig,
  widgetsOfZone,
  removedWidgets,
  availableWidgets,
  orphanPlacements,
  inheritedPlacement,
  type WidgetConstraints,
  type ZoneId,
  type WidgetLayout,
} from '../components/widget-host/widget-layout';
import {
  buildWidgetCatalog,
  currentWidgetId,
  widgetOrigin,
  PLUGIN_DEFAULT_HEIGHT,
  PLUGIN_MIN_HEIGHT,
  type CatalogEntry,
  type WidgetSlotEntry,
} from '../components/widget-host/widget-catalog';
import { defaultZoneForSlot } from '../components/cockpit/cockpit-zones';
import { loadLayout, saveLayout } from './ui-layout-store';
import { isZoneVisible, type Capabilities } from './capabilities';

const ZONES: readonly ZoneId[] = ['gauche', 'droite'];

const CONSTRAINTS: WidgetConstraints[] = [
  { id: 'a', defaultHeight: 200, minHeight: 100, defaultZone: 'gauche', defaultRank: 0 },
  { id: 'b', defaultHeight: 200, minHeight: 100, defaultZone: 'gauche', defaultRank: 1 },
  { id: 'c', defaultHeight: 200, minHeight: 100, defaultZone: 'gauche', defaultRank: 2 },
  { id: 'd', defaultHeight: 200, minHeight: 100, defaultZone: 'droite', defaultRank: 0 },
];

function base(): WidgetLayout[] {
  return mergeLayout(null, CONSTRAINTS);
}

/** `zone:id` pairs, in reading order — the shape a board actually shows. */
function placement(layout: WidgetLayout[]): string[] {
  return ZONES.flatMap((zone) => widgetsOfZone(layout, zone).map((w) => `${zone}:${w.id}`));
}

test('defaults place every widget at its declared rank', () => {
  assert.deepEqual(placement(base()), [
    'gauche:a', 'gauche:b', 'gauche:c', 'droite:d',
  ]);
});

test('a zone drop id designates its zone, a widget id designates the zone holding it', () => {
  const layout = base();
  assert.ok(isZoneDropId(zoneDropId('droite')));
  assert.equal(zoneOfDragId(layout, zoneDropId('droite'), ZONES), 'droite');
  assert.equal(zoneOfDragId(layout, 'b', ZONES), 'gauche');
  assert.equal(zoneOfDragId(layout, 'inconnu', ZONES), null);
  assert.equal(zoneOfDragId(layout, zoneDropId('nulle-part'), ZONES), null);
});

test('hovering inside its own zone moves nothing: the reorder waits for the drop', () => {
  const layout = base();
  assert.equal(crossZoneTarget(layout, 'a', 'c', ZONES), null);
  assert.equal(crossZoneTarget(layout, 'a', zoneDropId('gauche'), ZONES), null);
});

test('hovering another zone targets it, before the hovered widget or at the end', () => {
  const layout = base();
  assert.deepEqual(crossZoneTarget(layout, 'a', 'd', ZONES), { zone: 'droite', before: 'd' });
  assert.deepEqual(
    crossZoneTarget(layout, 'a', zoneDropId('droite'), ZONES),
    { zone: 'droite', before: null },
  );
});

test('the hovered move inserts before the hovered widget and renumbers both zones', () => {
  const target = crossZoneTarget(base(), 'a', 'd', ZONES);
  assert.ok(target);
  const moved = moveWidget(base(), 'a', target.zone, target.before);
  assert.deepEqual(placement(moved), ['gauche:b', 'gauche:c', 'droite:a', 'droite:d']);
});

test('a drop reorders inside the zone the widget now sits in', () => {
  assert.deepEqual(
    placement(resolveDrop(base(), 'a', 'c', ZONES)),
    ['gauche:b', 'gauche:c', 'gauche:a', 'droite:d'],
  );
  assert.deepEqual(
    placement(resolveDrop(base(), 'c', 'a', ZONES)),
    ['gauche:c', 'gauche:a', 'gauche:b', 'droite:d'],
  );
});

test('a drop on a zone target, on itself, or nowhere leaves the layout untouched', () => {
  const layout = base();
  for (const over of [zoneDropId('gauche'), 'a', null, 'inconnu']) {
    assert.deepEqual(placement(resolveDrop(layout, 'a', over, ZONES)), placement(layout));
  }
});

test('a widget dragged across zones then dropped keeps the place the hover gave it', () => {
  // The full gesture, in the order the host applies it: `dragOver` commits the
  // change of zone, `dragEnd` only settles the order inside the new zone.
  const target = crossZoneTarget(base(), 'b', zoneDropId('droite'), ZONES);
  assert.ok(target);
  const hovered = moveWidget(base(), 'b', target.zone, target.before);
  assert.deepEqual(placement(resolveDrop(hovered, 'b', 'd', ZONES)), [
    'gauche:a', 'gauche:c', 'droite:b', 'droite:d',
  ]);
});

test('a stored placement survives a widget leaving and a widget joining the registry', () => {
  const stored = [
    { id: 'a', rail: 'droite', rang: 1, hauteur: 260 },
    { id: 'disparu', rail: 'gauche', rang: 0, hauteur: 100 },
  ];
  const merged = mergeLayout(stored, CONSTRAINTS);
  // `a` kept its zone but not its stored rank: ranks are renumbered densely,
  // and `d` (default rank 0) sorts ahead of it.
  assert.deepEqual(placement(merged), ['gauche:b', 'gauche:c', 'droite:d', 'droite:a']);
  assert.equal(merged.find((w) => w.id === 'a')?.hauteur, 260);
});

// ── Generalisation: free zones and admission ────────────────────────────────

const COCKPIT_LEFT = { id: 'gauche', slot: 'cockpit.widget' };
const SIDEBAR = { id: 'sidebar.left.widget', slot: 'sidebar.left.widget' };
const SETTINGS = { id: 'reglages', slot: 'settings.section' };

test('a widget declaring a widget slot is admitted into every widget zone', () => {
  assert.equal(zoneAcceptsWidget(DEFAULT_WIDGET_SLOTS, COCKPIT_LEFT), true);
  assert.equal(zoneAcceptsWidget(DEFAULT_WIDGET_SLOTS, SIDEBAR), true);
});

test('a zone of another nature refuses it, whatever the widget declares', () => {
  assert.equal(zoneAcceptsWidget(DEFAULT_WIDGET_SLOTS, SETTINGS), false);
  assert.equal(zoneAcceptsWidget(['settings.section'], SETTINGS), true);
  assert.equal(zoneAcceptsWidget(['settings.section'], SIDEBAR), false);
});

test('a refused zone is never reached, even if collision detection points at it', () => {
  // Belt and braces: the droppable is disabled up front, and the model refuses
  // the move a second time — a placement admission rejected must not exist.
  const zones = ['gauche', 'droite', 'reglages'];
  const accepts = (_id: string, zone: string) => zone !== 'reglages';
  assert.equal(
    crossZoneTarget(base(), 'a', zoneDropId('reglages'), zones, accepts),
    null,
  );
  assert.deepEqual(
    crossZoneTarget(base(), 'a', zoneDropId('droite'), zones, accepts),
    { zone: 'droite', before: null },
  );
});

test('a widget moves into a zone that held nothing yet, and comes back', () => {
  const gone = moveWidget(base(), 'a', 'sidebar.left.widget', null);
  assert.deepEqual(placement(gone), ['gauche:b', 'gauche:c', 'droite:d']);
  assert.deepEqual(widgetsOfZone(gone, 'sidebar.left.widget').map((w) => w.id), ['a']);

  const back = moveWidget(gone, 'a', 'gauche', 'c');
  assert.deepEqual(placement(back), ['gauche:b', 'gauche:a', 'gauche:c', 'droite:d']);
  assert.deepEqual(widgetsOfZone(back, 'sidebar.left.widget'), []);
});

test('a placement in an unmounted zone is kept, not relocated', () => {
  // A sidebar exists only on the pages that render it; a widget parked there
  // must survive a page that never mounts the zone.
  const stored = [{ id: 'a', rail: 'sidebar.left.widget', rang: 0, hauteur: 200 }];
  const merged = mergeLayout(stored, CONSTRAINTS);
  assert.equal(merged.find((w) => w.id === 'a')?.rail, 'sidebar.left.widget');
  assert.deepEqual(placement(merged), ['gauche:b', 'gauche:c', 'droite:d']);
});

test('reordering a zone leaves every other zone exactly where it was', () => {
  const spread = moveWidget(base(), 'a', 'sidebar.left.widget', null);
  const reordered = reorderZone(spread, 'gauche', ['c', 'b']);
  assert.deepEqual(widgetsOfZone(reordered, 'gauche').map((w) => w.id), ['c', 'b']);
  assert.deepEqual(widgetsOfZone(reordered, 'droite').map((w) => w.id), ['d']);
  assert.deepEqual(
    widgetsOfZone(reordered, 'sidebar.left.widget').map((w) => w.id),
    ['a'],
  );
});

test('a widget moved to a sidebar is still there after a reload', () => {
  // The exit criterion, end to end at the level that decides it: the move, what
  // the daemon is handed, and what the next page load rebuilds from it.
  let stored: unknown = null;
  const daemon = async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      stored = (JSON.parse(String(init.body)) as { layout: unknown }).layout;
      return new Response(null, { status: 204 });
    }
    return Response.json({ layout: stored });
  };

  const moved = moveWidget(base(), 'a', 'sidebar.left.widget', null);
  return saveLayout(moved, { fetchImpl: daemon, storage: null })
    .then((ok) => {
      assert.equal(ok, true);
      return loadLayout({ fetchImpl: daemon, storage: null });
    })
    .then((out) => {
      assert.equal(out.ok, true);
      const reloaded = mergeLayout(out.raw, CONSTRAINTS);
      assert.deepEqual(
        widgetsOfZone(reloaded, 'sidebar.left.widget').map((w) => w.id),
        ['a'],
      );
      assert.deepEqual(placement(reloaded), ['gauche:b', 'gauche:c', 'droite:d']);
    });
});


// ── Removing from the interface, then putting back ──────────────────────────

/** A layout round-tripped through the daemon: what actually survives a reload. */
function reload(layout: WidgetLayout[]): WidgetLayout[] {
  return mergeLayout(JSON.parse(JSON.stringify(layout)), CONSTRAINTS);
}

test('a removed widget leaves its zone and shows up in the palette', () => {
  const after = removeWidget(base(), 'b');
  assert.deepEqual(placement(after), ['gauche:a', 'gauche:c', 'droite:d']);
  assert.deepEqual(removedWidgets(after).map((w) => w.id), ['b']);
});

test('a removal survives a reload instead of undoing itself', () => {
  // The whole point of keeping the entry: dropping it would let the merge with
  // the registry treat the widget as new and put it back at its defaults.
  const after = reload(removeWidget(base(), 'b'));
  assert.deepEqual(placement(after), ['gauche:a', 'gauche:c', 'droite:d']);
  assert.deepEqual(removedWidgets(after).map((w) => w.id), ['b']);
});

test('a removed widget is inert: neither a reorder nor a move of others loses it', () => {
  // `b` keeps the stale zone `gauche`, so any regrouping that forgets to set it
  // aside would drop it — and a dropped entry comes back placed on next load.
  const removed = removeWidget(base(), 'b');

  const reordered = reorderZone(removed, 'gauche', ['c', 'a']);
  assert.deepEqual(placement(reordered), ['gauche:c', 'gauche:a', 'droite:d']);
  assert.deepEqual(removedWidgets(reordered).map((w) => w.id), ['b']);

  const moved = moveWidget(removed, 'a', 'droite', null);
  assert.deepEqual(placement(moved), ['gauche:c', 'droite:d', 'droite:a']);
  assert.deepEqual(removedWidgets(moved).map((w) => w.id), ['b']);
});

test('a widget dragged out of the palette lands where it is dropped, and stays', () => {
  const removed = removeWidget(base(), 'b');
  // No zone of its own, so any admitting zone it hovers is a target.
  const target = crossZoneTarget(removed, 'b', 'd', ZONES);
  assert.deepEqual(target, { zone: 'droite', before: 'd' });

  const restored = reload(moveWidget(removed, 'b', 'droite', 'd'));
  assert.deepEqual(placement(restored), ['gauche:a', 'gauche:c', 'droite:b', 'droite:d']);
  assert.deepEqual(removedWidgets(restored), []);
});

test('a palette drop released before any hover still places the widget', () => {
  // The flick out of the palette: `dragEnd` fires without a single `dragOver`
  // having moved anything, so the drop has to do the placing itself.
  const removed = removeWidget(base(), 'b');
  assert.deepEqual(
    placement(resolveDrop(removed, 'b', zoneDropId('droite'), ZONES)),
    ['gauche:a', 'gauche:c', 'droite:d', 'droite:b'],
  );
  assert.deepEqual(
    placement(resolveDrop(removed, 'b', 'a', ZONES)),
    ['gauche:b', 'gauche:a', 'gauche:c', 'droite:d'],
  );
});

test('a palette drag cancelled before the drop leaves the widget removed', () => {
  // Escape mid-gesture. `dragOver` has already committed the preview — the very
  // move the drop test above releases on — so cancelling has to undo it, or the
  // widget stays out of the palette and the next write persists it as placed.
  const before = removeWidget(base(), 'b');
  const target = crossZoneTarget(before, 'b', 'd', ZONES);
  assert.deepEqual(target, { zone: 'droite', before: 'd' });
  const preview = moveWidget(before, 'b', 'droite', 'd');
  assert.deepEqual(removedWidgets(preview), []);

  const cancelled = cancelDrag(before, preview);
  assert.deepEqual(removedWidgets(cancelled).map((w) => w.id), ['b']);
  assert.deepEqual(placement(cancelled), ['gauche:a', 'gauche:c', 'droite:d']);
  assert.deepEqual(cancelled, before);
  // And it is still removed on the next load: the cancellation is the state the
  // following write will hand to the daemon.
  assert.deepEqual(removedWidgets(reload(cancelled)).map((w) => w.id), ['b']);
  assert.deepEqual(placement(reload(cancelled)), ['gauche:a', 'gauche:c', 'droite:d']);
});

test('a cancelled cross-zone drag puts the neighbours back too, not just the widget', () => {
  // Why the snapshot is the whole layout: the preview renumbered both zones, so
  // restoring the dragged entry alone would leave `c` and `d` in an order the
  // user never released.
  const before = base();
  const preview = moveWidget(before, 'a', 'droite', 'd');
  assert.deepEqual(placement(preview), ['gauche:b', 'gauche:c', 'droite:a', 'droite:d']);

  const cancelled = cancelDrag(before, preview);
  assert.deepEqual(placement(cancelled), ['gauche:a', 'gauche:b', 'gauche:c', 'droite:d']);
  assert.deepEqual(cancelled, before);
});

test('no gesture in flight: cancelling keeps the current layout', () => {
  const layout = removeWidget(base(), 'b');
  assert.equal(cancelDrag(null, layout), layout);
});

test('a palette drop into a zone that refuses the widget places nothing', () => {
  const removed = removeWidget(base(), 'b');
  const zones = [...ZONES, 'reglages'];
  const refuse = (_id: string, zone: ZoneId) => zone !== 'reglages';
  const after = resolveDrop(removed, 'b', zoneDropId('reglages'), zones, refuse);
  assert.deepEqual(removedWidgets(after).map((w) => w.id), ['b']);
  assert.deepEqual(placement(after), ['gauche:a', 'gauche:c', 'droite:d']);
});


// ── What the config removes is not "put away" ────────────────────────────────

/** Minimal capabilities: only `ui.hidden` and the module state count here. */
function caps(ui: string[], modules: { id: string; active: boolean }[] = []): Capabilities {
  return {
    edition: 'expert',
    profile: 'linux-desktop',
    capabilities: [],
    modules: modules.map((m) => ({ ...m, tier: 'std', reason: null, missing: [] })),
    ui: { hidden: ui, home: '/' },
    kernel: true,
    developer: { unsignedPlugins: false },
  };
}

/** The host's own derivation, predicate included — not a stand-in for it. */
function displayable(layout: WidgetLayout[], c: Capabilities | null): WidgetLayout[] {
  return widgetsAllowedByConfig(layout, (id) => isZoneVisible(c, `cockpit.${id}`));
}

// `dreams` is carried by the `dreams` module (`ZONE_MODULE`), `vault-graph` by
// `vault`: two real widgets, to exercise the real table and not made-up ids
// that are not in it.
const REAL_CONSTRAINTS: WidgetConstraints[] = [
  { id: 'dreams', defaultHeight: 220, minHeight: 120, defaultZone: 'gauche', defaultRank: 0 },
  { id: 'vault-graph', defaultHeight: 300, minHeight: 140, defaultZone: 'gauche', defaultRank: 1 },
];

test('a widget masked by ui.hidden shows up neither in its zone nor in the palette', () => {
  // Removed AND hidden: even then, the palette does not offer it. Putting it
  // away is the user's decision, hiding it a config
  // decision — and the config filters first.
  const layout = removeWidget(mergeLayout(null, REAL_CONSTRAINTS), 'dreams');
  const visible = displayable(layout, caps(['cockpit.dreams']));

  assert.deepEqual(removedWidgets(visible), []);
  assert.deepEqual(widgetsOfZone(visible, 'gauche').map((w) => w.id), ['vault-graph']);
  // Nothing is lost for all that: the placement keeps the entry, and removing
  // `cockpit.dreams` from the config brings it back as it was.
  assert.deepEqual(removedWidgets(displayable(layout, caps([]))).map((w) => w.id), ['dreams']);
});

test('a widget whose module is off is not offered either', () => {
  const layout = removeWidget(mergeLayout(null, REAL_CONSTRAINTS), 'dreams');
  const switchedOff = caps([], [{ id: '@timon/dreams', active: false }]);
  assert.deepEqual(removedWidgets(displayable(layout, switchedOff)), []);
  assert.deepEqual(
    removedWidgets(displayable(layout, caps([], [{ id: '@timon/dreams', active: true }]))).map((w) => w.id),
    ['dreams'],
  );
});

test('capabilities not loaded yet: everything shows, palette included', () => {
  // Fallback policy of the front end — when in doubt, show it.
  const layout = removeWidget(mergeLayout(null, REAL_CONSTRAINTS), 'dreams');
  assert.deepEqual(removedWidgets(displayable(layout, null)).map((w) => w.id), ['dreams']);
});

// ── Catalogue: natives + slot entries, a single placement source ────────────

const NATIVE: CatalogEntry[] = CONSTRAINTS.map((c) => ({
  ...c,
  title: c.id.toUpperCase(),
  slots: DEFAULT_WIDGET_SLOTS,
  registrationId: null,
}));

function registration(
  pluginId: string,
  slot = 'cockpit.widget',
  key?: string,
  n = 1,
): WidgetSlotEntry {
  return { registrationId: `${pluginId}:${n}`, pluginId, key, slot };
}

test('a slot entry becomes a catalogue entry, placed after the native ones', () => {
  const catalog = buildWidgetCatalog(NATIVE, [registration('example-widget')], defaultZoneForSlot);
  const added = catalog.at(-1);

  assert.equal(catalog.length, NATIVE.length + 1);
  assert.deepEqual(added, {
    id: 'plugin:example-widget',
    title: 'example-widget',
    pluginId: 'example-widget',
    slots: ['cockpit.widget'],
    registrationId: 'example-widget:1',
    defaultHeight: PLUGIN_DEFAULT_HEIGHT,
    minHeight: PLUGIN_MIN_HEIGHT,
    // The two cockpit rails share a slot: it is the only zone whose
    // name is not derived from the slot.
    defaultZone: 'gauche',
    defaultRank: NATIVE.length,
  });
});

test('the palette can tell two homonymous widgets apart by their surface', () => {
  // The two "Missions" of the product: same title, same plugin, two surfaces.
  const [cockpit, chat] = buildWidgetCatalog([], [
    { ...registration('@timon/missions', 'cockpit.widget', 'recent'), options: { title: 'Missions' } },
    { ...registration('@timon/missions', 'chat.left.widget', 'Missions', 2), options: { title: 'Missions' } },
  ], defaultZoneForSlot);

  assert.ok(cockpit && chat);
  assert.equal(cockpit.title, chat.title);
  assert.deepEqual(widgetOrigin(cockpit), {
    surfaceKey: 'widgets.surface.cockpit',
    surface: 'cockpit.widget',
    plugin: 'missions',
  });
  assert.deepEqual(widgetOrigin(chat), {
    surfaceKey: 'widgets.surface.chatLeft',
    surface: 'chat.left.widget',
    plugin: 'missions',
  });
});

test('an unknown slot shows itself, a native widget shows no plugin', () => {
  const [thirdParty] = buildWidgetCatalog([], [registration('acme', 'acme.board.widget')]);
  assert.ok(thirdParty);
  assert.deepEqual(widgetOrigin(thirdParty), {
    surfaceKey: null,
    surface: 'acme.board.widget',
    plugin: 'acme',
  });
  assert.equal(widgetOrigin(NATIVE[0]!).plugin, null);
});

test('a widget slot other than the cockpit names its own zone', () => {
  const [entry] = buildWidgetCatalog([], [registration('p', 'sidebar.right.widget')], defaultZoneForSlot);
  assert.equal(entry?.defaultZone, 'sidebar.right.widget');
});

test('the placement id is stable across reloads, and a key separates two widgets', () => {
  const first = buildWidgetCatalog([], [registration('acme', 'cockpit.widget', undefined, 1)]);
  // Same plugin, another session: the registration counter changed, not the id.
  const second = buildWidgetCatalog([], [registration('acme', 'cockpit.widget', undefined, 7)]);
  assert.equal(first[0]?.id, second[0]?.id);

  const two = buildWidgetCatalog([], [
    registration('acme', 'cockpit.widget', 'gauche'),
    registration('acme', 'cockpit.widget', 'droite', 2),
  ]);
  assert.deepEqual(two.map((e) => e.id), ['plugin:acme:gauche', 'plugin:acme:droite']);
});

test('two keyless registrations of one plugin: the second falls back on its registration id', () => {
  const two = buildWidgetCatalog([], [
    registration('acme', 'cockpit.widget', undefined, 1),
    registration('acme', 'cockpit.widget', undefined, 2),
  ]);
  assert.deepEqual(two.map((e) => e.id), ['plugin:acme', 'acme:2']);
});

test('a plugin widget is admitted into every widget zone, and refused elsewhere', () => {
  const [entry] = buildWidgetCatalog([], [registration('acme', 'cockpit.widget')]);
  assert.ok(entry);
  assert.equal(zoneAcceptsWidget(entry.slots, SIDEBAR), true);
  assert.equal(zoneAcceptsWidget(entry.slots, COCKPIT_LEFT), true);
  assert.equal(zoneAcceptsWidget(entry.slots, SETTINGS), false);
});

test('a registration declares its title, its heights and its first zone', () => {
  // Without these four fields, every plugin card is called by the name of its
  // plugin, is 260 px and lands in the left rail: the product tiles
  // could not become plugins without losing their layout.
  const [entry] = buildWidgetCatalog([], [{
    ...registration('vault', 'cockpit.widget', 'vault-graph'),
    options: { title: 'Vault', zone: 'droite', height: 420, minHeight: 200 },
  }], defaultZoneForSlot);

  assert.equal(entry?.title, 'Vault');
  assert.equal(entry?.defaultZone, 'droite');
  assert.equal(entry?.defaultHeight, 420);
  assert.equal(entry?.minHeight, 200);
});

test('a plugin widget places, moves and is taken out like a native one', () => {
  const catalog = buildWidgetCatalog(NATIVE, [registration('acme')], defaultZoneForSlot);
  const id = 'plugin:acme';
  const placed = mergeLayout(null, catalog);
  assert.deepEqual(placement(placed), ['gauche:a', 'gauche:b', 'gauche:c', `gauche:${id}`, 'droite:d']);

  const moved = moveWidget(placed, id, 'droite', 'd');
  assert.deepEqual(placement(moved), ['gauche:a', 'gauche:b', 'gauche:c', `droite:${id}`, 'droite:d']);

  const removed = removeWidget(moved, id);
  assert.deepEqual(removedWidgets(removed).map((w) => w.id), [id]);
  assert.deepEqual(placement(removed), ['gauche:a', 'gauche:b', 'gauche:c', 'droite:d']);
});

// ── Orphans: the catalogue is alive, the placement must not be erased ────────

test('a stored placement waits for a plugin that has not registered yet', () => {
  // The real case: the layout comes back from the daemon before the plugin loader
  // has finished. Without orphans, a simple drag in that interval would erase
  // the plugin's place for good.
  const stored = [
    { id: 'a', rail: 'droite', rang: 0, hauteur: 200 },
    { id: 'plugin:acme', rail: 'droite', rang: 1, hauteur: 300 },
  ];
  const withoutPlugin = buildWidgetCatalog(NATIVE, [], defaultZoneForSlot);

  assert.equal(mergeLayout(stored, withoutPlugin).some((w) => w.id === 'plugin:acme'), false);
  assert.deepEqual(orphanPlacements(stored, withoutPlugin).map((w) => w.id), ['plugin:acme']);

  // What the host rewrites after a gesture: the placed layout, plus the orphans.
  const written = [
    ...removeWidget(mergeLayout(stored, withoutPlugin), 'a'),
    ...orphanPlacements(stored, withoutPlugin),
  ];

  // The plugin finally registers: its place and its height are intact.
  const withPlugin = buildWidgetCatalog(NATIVE, [registration('acme')], defaultZoneForSlot);
  const back = mergeLayout(written, withPlugin).find((w) => w.id === 'plugin:acme');
  assert.equal(back?.rail, 'droite');
  assert.equal(back?.hauteur, 300);
  assert.deepEqual(orphanPlacements(written, withPlugin), []);
});

test('an entry the catalogue claims is never an orphan, and a corrupt one is dropped', () => {
  const catalog = buildWidgetCatalog(NATIVE, [], defaultZoneForSlot);
  const stored = [
    { id: 'a', rail: 'gauche', rang: 0, hauteur: 200 },
    { id: 'plugin:x', rail: 'gauche', rang: 1 },
    'pas un objet',
    { id: 'plugin:y', rail: 'gauche', rang: 2, hauteur: 200, removed: true },
    { id: 'plugin:y', rail: 'droite', rang: 3, hauteur: 200 },
  ];
  const remaining = orphanPlacements(stored, catalog);
  assert.deepEqual(remaining.map((w) => w.id), ['plugin:y']);
  assert.equal(remaining[0]?.removed, true);
  assert.deepEqual(orphanPlacements(null, catalog), []);
});

test('the catalog offers cockpit widgets on a chat without stealing visible placements', () => {
  const layout = base();
  assert.deepEqual(availableWidgets(layout, ['chat.left.widget', 'chat.right.widget']), layout);
  const added = moveWidget(layout, 'a', 'chat.right.widget', null);
  assert.deepEqual(availableWidgets(added, ['chat.left.widget', 'chat.right.widget']).map(w => w.id).sort(), ['b', 'c', 'd']);
  assert.equal(widgetsOfZone(layout, 'gauche').length, 3, 'the original cockpit layout is not mutated');
  assert.ok(availableWidgets(removeWidget(added, 'a'), ['chat.right.widget']).some(w => w.id === 'a'));
});

test('a horizontal zone only admits widgets that have a flat form', () => {
  const bar = { id: 'topbar.widget', slot: 'topbar.widget', orientation: 'horizontal' as const };
  const column = { id: 'sidebar.left.widget', slot: 'sidebar.left.widget' };
  assert.equal(zoneAcceptsWidget(['cockpit.widget'], bar), false, 'a card without `bar` never lands in the bar');
  assert.equal(zoneAcceptsWidget(['cockpit.widget'], bar, true), true);
  assert.equal(zoneAcceptsWidget(['cockpit.widget'], column, true), true, 'a bar widget still goes to any column');
  assert.equal(zoneAcceptsWidget(['topbar.item'], bar, true), false, 'the flat form does not open a non-widget slot');
});

test('the catalogue carries the flat form, the default placement and the former ids', () => {
  const [entry] = buildWidgetCatalog([], [{
    registrationId: 'n:0', pluginId: '@timon/notifications', key: 'bell', slot: 'cockpit.widget',
    options: { zone: 'topbar.widget', bar: true, placedByDefault: true, formerKeys: ['inbox'] },
  }]);
  assert.equal(entry?.bar, true);
  assert.equal(entry?.placedByDefault, true);
  assert.deepEqual(entry?.formerIds, ['plugin:@timon/notifications:inbox']);
  assert.equal(entry?.defaultZone, 'topbar.widget');
  assert.equal(widgetOrigin(entry!).surfaceKey, 'widgets.surface.topbar');
  // `''` names the keyless registration a plugin had before giving it a key.
  const [renamed] = buildWidgetCatalog([], [{
    registrationId: 'q:0', pluginId: 'quota-monitor', key: 'quota', slot: 'cockpit.widget', options: { formerKeys: [''] },
  }]);
  assert.deepEqual(renamed?.formerIds, ['plugin:quota-monitor']);
});

test('a former id leads to the widget that carries it now; a current id always wins (TODO #540)', () => {
  const entries = buildWidgetCatalog([], [
    { registrationId: 'g:0', pluginId: '@timon/git', key: 'repository', slot: 'chat.right.widget', options: { formerIds: ['plugin:@timon/git:Git', 'plugin:@timon/kanban-code:Git'] } },
    { registrationId: 'o:0', pluginId: '@timon/other', key: 'x', slot: 'chat.right.widget', options: { formerIds: ['plugin:@timon/git:Git', 'plugin:@timon/git:repository'] } },
  ]);
  assert.equal(currentWidgetId(entries, 'plugin:@timon/kanban-code:Git'), 'plugin:@timon/git:repository');
  assert.equal(currentWidgetId(entries, 'plugin:@timon/git:Git'), 'plugin:@timon/git:repository', 'the first claimant keeps it');
  assert.equal(currentWidgetId(entries, 'plugin:@timon/git:repository'), 'plugin:@timon/git:repository', 'a live id is never redirected');
  assert.equal(currentWidgetId(entries, 'plugin:@timon/git:gone'), null);
});

test('a product card moved to another module keeps its place; a third party cannot claim one', () => {
  const [moved] = buildWidgetCatalog([], [{
    registrationId: 'g:0', pluginId: '@timon/git', key: 'Git', slot: 'chat.left.widget',
    options: { formerIds: ['plugin:@timon/kanban-code:Git'] },
  }]);
  assert.deepEqual(moved?.formerIds, ['plugin:@timon/kanban-code:Git']);
  const stored = [{ id: 'plugin:@timon/kanban-code:Git', rail: 'chat.right.widget', rang: 4, hauteur: 260 }];
  assert.deepEqual(inheritedPlacement(stored, moved!.formerIds!, moved!.id), { ...stored[0], id: 'plugin:@timon/git:Git' });

  const [thief] = buildWidgetCatalog([], [{
    registrationId: 't:0', pluginId: 'acme-git', key: 'Git', slot: 'chat.left.widget',
    options: { formerIds: ['plugin:@timon/kanban-code:Git'] },
  }]);
  assert.equal(thief?.formerIds, undefined);
});
