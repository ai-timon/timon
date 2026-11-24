import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { register, resetSlotsForTests, slotEntries, slotEntry } from './plugin-host/slots';
import { UI_LAYOUT_CHILD_SLOTS } from './plugin-host/ui-layout';
import { registerProductLayout } from './plugin-host/slot-root';
import { mountBundledClients } from '@/plugins-client/mount';
import { UI_LAYOUT_MODULE } from '@/plugins-client/ui-layout';
import { buildWidgetCatalog, type WidgetSlotEntry } from '../components/widget-host/widget-catalog';
import { mergeLayout, orphanPlacements, widgetsOfZone, type WidgetLayout } from '../components/widget-host/widget-layout';
import { defaultZoneForSlot } from '../components/cockpit/cockpit-zones';
import { mergeWorkspaceWidgets } from '../components/widget-host/widget-defaults';
import { NAV_SECONDARY_ORDER } from '@/plugins-client/nav';
import {
  isNavSurfaceAllowed,
  isPageSurfaceAllowed,
  isProductPageOn,
  isWidgetSurfaceAllowed,
  PAGE_MODULE,
  type Capabilities,
} from './capabilities';
import {
  saveInstance,
  seedForAgent,
  resetInstancesForTests,
  deleteInstance,
  type AgentChatInstance,
} from '@/plugins-client/agent-chat/instances';

const instance = (over: Partial<AgentChatInstance> & Pick<AgentChatInstance, 'id' | 'agent'>): AgentChatInstance => ({
  title: '',
  avatar: '',
  zone: '',
  subAgents: [],
  ...over,
});

const Empty = () => React.createElement('div');

function mountLayout(): void {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, Empty);
}

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

test('the main nav entries come from the modules, ranked, not from a hard list', () => {
  mountLayout();
  mountBundledClients(null);
  const entries = slotEntries('nav.item');
  assert.ok(entries.length >= 14, `expected every product entry, got ${entries.length}`);
  assert.deepEqual(
    [...entries].map((e) => e.order),
    [...entries].map((e) => e.order).sort((a, b) => a - b),
    'a nav rail is painted in its declared order',
  );
  assert.equal(entries[0]?.pluginId, '@timon/ui-layout', 'the cockpit stays the first entry');
});

test('a module switched off takes its nav entry away', () => {
  mountLayout();
  mountBundledClients(capabilities({
    modules: [{ id: '@timon/kanban', tier: 'std', active: false, reason: null, missing: [] }],
  }));
  assert.equal(slotEntries('nav.item').some((e) => e.pluginId === '@timon/kanban'), false);
  assert.equal(slotEntries('nav.item').some((e) => e.pluginId === '@timon/vault'), true);
});

test('a zone hidden by config takes the entry away without touching the module', () => {
  mountLayout();
  mountBundledClients(capabilities({ ui: { hidden: ['nav.brain'], home: '/' } }));
  assert.equal(slotEntries('nav.item').some((e) => e.pluginId === '@timon/vault'), false);
});

test('unmounting the halves empties the rail', () => {
  mountLayout();
  const dispose = mountBundledClients(null);
  assert.ok(slotEntries('nav.item').length > 0);
  dispose();
  assert.equal(slotEntries('nav.item').length, 0);
});

test('the divider is an entry too, sitting between the two groups', () => {
  mountLayout();
  mountBundledClients(null);
  const orders = slotEntries('nav.item').map((e) => e.order);
  const divider = orders.indexOf(NAV_SECONDARY_ORDER - 1);
  assert.notEqual(divider, -1, 'the rule is a nav entry, not chrome painted by the rail');
  assert.ok(orders.slice(0, divider).every((o) => o < NAV_SECONDARY_ORDER));
  assert.ok(orders.slice(divider + 1).every((o) => o >= NAV_SECONDARY_ORDER));
});

test('a third-party nav entry lands after every product entry', () => {
  mountLayout();
  mountBundledClients(null);
  register({ slot: 'nav.item', pluginId: 'example-hello' }, Empty);
  const entries = slotEntries('nav.item');
  assert.equal(entries[entries.length - 1]?.pluginId, 'example-hello');
});


// ── The cockpit tiles, mounted the way the browser mounts them ──────────────

/** The host catalogue, computed on the registrations actually mounted. */
function tileCatalog() {
  const entries: WidgetSlotEntry[] = slotEntries('cockpit.widget').map((e) => ({
    registrationId: e.id,
    pluginId: e.pluginId,
    key: e.key,
    slot: 'cockpit.widget',
    options: e.widget,
  }));
  return buildWidgetCatalog([], entries, defaultZoneForSlot);
}

test('the cockpit cards keep their placement id, title, rail and heights', () => {
  // What these values protect: an extracted tile that lost its key
  // would change its placement id, hence its place, on the first reload — and
  // nothing at build time would say so.
  mountLayout();
  mountBundledClients(null);
  assert.deepEqual(
    tileCatalog().map((e) => [e.id, e.title, e.defaultZone, e.defaultHeight, e.minHeight]),
    [
      ['plugin:@timon/ui-layout:clock', 'Clock', 'gauche', 140, 110],
      // "Your widget here", placed by the fresh-install arrangements only.
      ['plugin:@timon/ui-layout:add-widget', 'Your widget here', 'gauche', 160, 120],
      ['plugin:@timon/ui-layout:add-widget-2', 'Your widget here', 'gauche', 160, 120],
      ['plugin:@timon/vault:vault-graph', 'Vault graph', 'droite', 420, 200],
      // The top bar's agent tabs and the former "Agents list" card, one
      // widget: first placed in the middle of the top bar (TODO #479).
      ['plugin:@timon/agents:working', 'Working agents', 'topbar.center.widget', 300, 120],
      ['plugin:@timon/agents:notifications', 'Notification center', 'agents.left.widget', 520, 200],
      ['plugin:@timon/agents:tasks', 'Task queue', 'agents.right.widget', 400, 180],
      ['plugin:@timon/agents:injections', 'Agent injections', 'droite', 420, 200],
      // The rail of `/bots`, shown there in an island of its own.
      ['plugin:@timon/bots:rail', 'TIMs', 'gauche', 420, 200],
      ['plugin:@timon/missions:recent', 'Recent missions', 'gauche', 300, 150],
      // Its default surface is the chat rail: the card only talks about an
      // open conversation. It stays movable everywhere else.
      ['plugin:@timon/missions:delegations', 'Delegated missions', 'chat.left.widget', 220, 120],
      // The open mission's outbound connections (TODO #590): a chat-rail card,
      // waiting in the palette; the alert opens its island content instead.
      ['plugin:@timon/missions:egress', 'Mission network', 'chat.right.widget', 320, 160],
      ['plugin:@timon/projects:overview', 'Projects overview', 'gauche', 300, 150],
      // The notebook has TWO surfaces since part 4/4: the "TO DO" column of the
      // board, and this tile — a widget in its own right, not the alternative
      // it was in the days of `@timon/backlog`.
      ['plugin:@timon/kanban:todo', 'All-projects TO DO', 'droite', 320, 160],
      ['plugin:@timon/kanban:project-todo', 'Project TO DO', 'droite', 300, 160],
      // A project's open pull requests and their read-only review, next to
      // its notebook.
      ['plugin:@timon/kanban:pull-requests', 'Pull requests', 'droite', 320, 160],
      // The jobs that land through a pull request, and their preview.
      ['plugin:@timon/kanban:landings', 'Jobs', 'droite', 320, 160],
      // No Dreams tile: the module holds back its surfaces for the beta
      // as long as its `ui` option is not true (see the dedicated test below).
      ['plugin:@timon/agent-chat:new', 'New agent chat', 'gauche', 520, 280],
      ['plugin:@timon/workflows:workflow-runs', 'Workflow runs', 'gauche', 240, 140],
      // The bell: one widget, first placed on the top bar's line; a button in
      // a sidebar, a card of the dropdown's list in a wide zone.
      ['plugin:@timon/notifications:bell', 'Notification bell', 'topbar.widget', 320, 160],
    ],
  );
});

// TODO #479: the agent strip was on screen on every view before it became a
// widget. A view stored before it, whatever it did with the former "Agents
// list" card, finds it in the middle of the top bar — never at that card's
// place (a hidden chat tab, on the view that showed the regression).
test('the Working agents widget is placed by default and inherits nothing from the list card', () => {
  mountLayout();
  mountBundledClients(null);
  const entries = tileCatalog();
  const working = entries.find((e) => e.id === 'plugin:@timon/agents:working');
  assert.equal(working?.placedByDefault, true);
  assert.equal(working?.bar, true);
  assert.equal(working?.formerIds, undefined);
  const team = 'plugin:@timon/agents:team';
  const views: unknown[][] = [
    [{ id: team, rail: 'chat.right.widget#muvis5up', rang: 1, hauteur: 300 }],
    [{ id: team, rail: 'centre', rang: 0, hauteur: 300 }],
    [{ id: team, rail: 'centre', rang: 0, hauteur: 300, removed: true }],
    [],
  ];
  for (const stored of views) {
    const placed: WidgetLayout | undefined = mergeWorkspaceWidgets(stored, entries, '/chat').find((w) => w.id === working?.id);
    assert.equal(placed?.rail, 'topbar.center.widget', JSON.stringify(stored));
    assert.equal(placed?.removed, undefined);
  }
});

test('a tile hidden by config, or whose module is off, never registers', () => {
  // Same filter as the former native table: the card leaves the rails AND the
  // palette, without its persisted placement being erased (it becomes orphaned).
  mountLayout();
  mountBundledClients(capabilities({ ui: { hidden: ['cockpit.vault-graph'], home: '/' } }));
  assert.equal(slotEntries('cockpit.widget').some((e) => e.key === 'vault-graph'), false);
  assert.equal(slotEntries('cockpit.widget').some((e) => e.pluginId === '@timon/agent-chat'), true);

  mountLayout();
  mountBundledClients(capabilities({
    modules: [{ id: '@timon/vault', tier: 'opt', active: false, reason: null, missing: [] }],
  }));
  // Turning a module off takes its tile away, and only it: the "TO DO" column
  // stays, it belongs to the Kanban.
  assert.deepEqual(slotEntries('cockpit.widget').filter((e) => e.pluginId === '@timon/vault'), []);
  assert.equal(slotEntries('kanban.column').some((e) => e.pluginId === '@timon/kanban'), true,
    'turning a module off only takes it away: the notebook is on the board');
});

// ── The notebook: the first column of the board ─────────────────────────────

test('the notebook is a Kanban column, with no setting to move it out', () => {
  // Part 2/4: `@timon/backlog` and its `surfaces` option are gone. The
  // column is no longer a surface to turn on — it is there, or the whole
  // board is not.
  mountLayout();
  mountBundledClients(null);
  assert.deepEqual(
    slotEntries('kanban.column').map((e) => [e.pluginId, e.key]),
    [['@timon/kanban', 'todo']],
  );
  // Part 4/4: the two notebook tiles are widgets, next to the
  // column and no longer in its place. They do not occupy `kanban.column`,
  // and neither do the two pull request widgets the module added since.
  assert.deepEqual(
    slotEntries('cockpit.widget').filter((e) => e.pluginId === '@timon/kanban').map((e) => e.key),
    ['todo', 'project-todo', 'pull-requests', 'landings'],
  );
});

test('a config that still carries @timon/backlog changes nothing', () => {
  // The id is removed on the daemon side, with no alias: nobody listens to it any more, and
  // above all it does not turn the Kanban off as a side effect.
  mountLayout();
  mountBundledClients(capabilities({
    modules: [{ id: '@timon/backlog', tier: 'std', active: false, reason: null, missing: [] }],
  }));
  assert.equal(slotEntries('kanban.column').length, 1);
});

test('@timon/kanban off: no board, no "TO DO" column', () => {
  mountLayout();
  mountBundledClients(capabilities({
    modules: [{ id: '@timon/kanban', tier: 'std', active: false, reason: null, missing: [] }],
  }));
  assert.equal(slotEntries('kanban.column').length, 0);
});

test('the column also hides through ui.hidden, without touching the module', () => {
  mountLayout();
  mountBundledClients(capabilities({ ui: { hidden: ['kanban.todo'], home: '/' } }));
  assert.equal(slotEntries('kanban.column').length, 0);
});

test('every tile registers with a key: without one, a card loses its place on reload', () => {
  mountLayout();
  mountBundledClients(null);
  for (const entry of slotEntries('cockpit.widget')) {
    assert.ok(entry.key, `${entry.pluginId} registers a widget without a key`);
  }
});

test('a disableable product page follows its module, a core page does not', () => {
  // `/notifications` stays a Next route on purpose (see its own page.tsx):
  // it must render outside `ui-layout`, so it cannot be a `page`-slot
  // occupant, which only exists as a child of the `root` it declares.
  assert.equal(PAGE_MODULE['/notifications'], '@timon/notifications');
  assert.equal(PAGE_MODULE['/settings'], undefined);
  assert.equal(PAGE_MODULE['/users'], undefined, 'account administration is a plugin page now');
  const off = capabilities({
    modules: [
      { id: '@timon/notifications', tier: 'std', active: false, reason: 'disabled in timon.config.json', missing: [] },
    ],
  });
  assert.equal(isProductPageOn(off, '/notifications'), false);
  assert.equal(isProductPageOn(off, '/settings'), true);
  assert.equal(isProductPageOn(null, '/notifications'), true, 'caps not loaded yet: show, do not flash empty');
});

function employeeCaps(): Capabilities {
  return capabilities({
    surfaces: {
      pages: ['/', '/chat'],
      widgets: [],
      nav: ['home', 'chat'],
      plugins: [],
      themes: [],
      layouts: ['ui-layout'],
    },
  });
}

/** Restricted viewer (M.4 / T.5): `surfaces` lists what this account may see. */
function restrictedLayoutCaps(
  layouts: string[],
  extra: { pages?: string[]; nav?: string[] } = {},
): Capabilities {
  return capabilities({
    surfaces: {
      pages: extra.pages ?? [],
      widgets: [],
      nav: extra.nav ?? [],
      plugins: [],
      themes: [],
      layouts,
    },
  });
}

test('a viewer without the layout surface gets no product chrome', () => {
  mountLayout();
  mountBundledClients(restrictedLayoutCaps([]));
  assert.equal(
    slotEntries('nav.item').some((e) => e.pluginId === UI_LAYOUT_MODULE),
    false,
    'without layout:ui-layout the chrome home entry is not mounted',
  );
});

test('the product chrome comes back once its surface is granted', () => {
  mountLayout();
  mountBundledClients(restrictedLayoutCaps(['ui-layout']));
  assert.equal(
    slotEntries('nav.item').some((e) => e.pluginId === UI_LAYOUT_MODULE),
    true,
    'layout:ui-layout mounts the chrome',
  );

  mountLayout();
  mountBundledClients({ ...restrictedLayoutCaps([]), surfaces: { all: true } });
  assert.equal(
    slotEntries('nav.item').some((e) => e.pluginId === UI_LAYOUT_MODULE),
    true,
    'an unrestricted viewer keeps the chrome',
  );

  mountLayout();
  mountBundledClients(null);
  assert.equal(
    slotEntries('nav.item').some((e) => e.pluginId === UI_LAYOUT_MODULE),
    true,
    'first run (caps null) keeps the chrome',
  );
});

test('SlotRoot leaves root empty when the layout surface is denied', () => {
  // Do not pre-register root: mountLayout() occupies it as @timon/ui-layout
  // and the assertion would not observe SlotRoot (T.5b false negative).
  resetSlotsForTests();
  registerProductLayout(restrictedLayoutCaps([]));
  assert.equal(
    slotEntries('root').some((e) => e.pluginId === UI_LAYOUT_MODULE),
    false,
    'without layout:ui-layout AppFrame must not occupy root',
  );
});

test('SlotRoot occupies root once the layout surface is granted', () => {
  resetSlotsForTests();
  registerProductLayout(restrictedLayoutCaps(['ui-layout']));
  assert.equal(slotEntries('root')[0]?.pluginId, UI_LAYOUT_MODULE);
  assert.equal(slotEntries('root')[0]?.fallback, true, 'a chosen layout can still claim root');

  resetSlotsForTests();
  registerProductLayout({ ...restrictedLayoutCaps([]), surfaces: { all: true } });
  assert.equal(
    slotEntries('root')[0]?.pluginId,
    UI_LAYOUT_MODULE,
    'an unrestricted viewer keeps AppFrame',
  );

  resetSlotsForTests();
  registerProductLayout(null);
  assert.equal(
    slotEntries('root')[0]?.pluginId,
    UI_LAYOUT_MODULE,
    'first run (caps null) keeps AppFrame',
  );
});

test('denying the layout surface does not filter other bundled halves', () => {
  mountLayout();
  mountBundledClients(restrictedLayoutCaps([], { pages: ['/kanban'], nav: ['kanban'] }));
  assert.equal(slotEntries('nav.item').some((e) => e.pluginId === UI_LAYOUT_MODULE), false);
  assert.equal(
    slotEntries('nav.item').some((e) => e.pluginId === '@timon/kanban'),
    true,
    'kanban is not a layout: the layout curtain must not skip it',
  );
});

test('a widget grant opens the card, not a nav entry to a forbidden page (TODO #645)', () => {
  const surfaces = { pages: ['/', '/chat'], nav: ['home', 'chat'], themes: [], layouts: ['ui-layout'] };
  const withCard = capabilities({ surfaces: { ...surfaces, widgets: ['missions'], plugins: ['@timon/missions'] } });
  assert.equal(isWidgetSurfaceAllowed(withCard, '@timon/missions', 'recent'), true);
  assert.equal(isPageSurfaceAllowed(withCard, '/multichat'), false);
  assert.equal(isNavSurfaceAllowed(withCard, '/multichat', '@timon/missions'), false);
  // `plugin:<id>` alone, the package's whole switch, keeps its entry.
  const wholePackage = capabilities({ surfaces: { ...surfaces, widgets: [], plugins: ['@timon/missions'] } });
  assert.equal(isNavSurfaceAllowed(wholePackage, '/multichat', '@timon/missions'), true);
});

test('an employee without the surface grant does not see kanban, settings, or the vault graph', () => {
  const caps = employeeCaps();
  assert.equal(isPageSurfaceAllowed(caps, '/'), true);
  assert.equal(isPageSurfaceAllowed(caps, '/chat'), true);
  assert.equal(isPageSurfaceAllowed(caps, '/kanban'), false);
  assert.equal(isPageSurfaceAllowed(caps, '/settings'), false);
  assert.equal(isProductPageOn(caps, '/settings'), false);
  assert.equal(isNavSurfaceAllowed(caps, '/kanban', '@timon/kanban'), false);
  assert.equal(isNavSurfaceAllowed(caps, '/', '@timon/ui-layout'), true);
  assert.equal(isWidgetSurfaceAllowed(caps, '@timon/vault', 'vault-graph'), false);

  mountLayout();
  mountBundledClients(caps);
  assert.equal(slotEntries('nav.item').some((e) => e.pluginId === '@timon/kanban'), false);
  assert.equal(slotEntries('nav.item').some((e) => e.pluginId === '@timon/ui-layout'), true);
  assert.equal(slotEntry('page', '/kanban'), null);
  assert.equal(slotEntries('cockpit.widget').some((e) => e.pluginId === '@timon/vault'), false);
});

test('superadmin-shaped capabilities (`surfaces.all`) keep every product surface', () => {
  const caps = capabilities({ surfaces: { all: true } });
  assert.equal(isPageSurfaceAllowed(caps, '/kanban'), true);
  assert.equal(isPageSurfaceAllowed(caps, '/settings'), true);
  mountLayout();
  mountBundledClients(caps);
  assert.equal(slotEntry('page', '/kanban')?.pluginId, '@timon/kanban');
  assert.equal(slotEntries('nav.item').some((e) => e.pluginId === '@timon/kanban'), true);
});

test('pages extracted into the `page` slot are not in PAGE_MODULE: they disappear on their own', () => {
  // These used to need this table too (module-page-gate.tsx). They no
  // longer do: each is a plugin now, registered by its module's client
  // half, and the catch-all is its off-switch.
  for (const route of ['/dreams', '/kanban', '/routines', '/memory', '/secrets', '/brain']) {
    assert.equal(PAGE_MODULE[route], undefined, route);
  }
});


// ── `/dreams`: a module page, no longer a static Next route ─────────────────

test('extracted product pages occupy the `page` slot at their own route, and only while on', () => {
  mountLayout();
  mountBundledClients(null);
  // Dreams is withheld for the beta: its surfaces need `ui: true` (same lever
  // as `@timon/company`), so nothing claims the key by default.
  assert.equal(slotEntry('page', '/dreams'), null);
  assert.equal(slotEntry('page', '/kanban')?.pluginId, '@timon/kanban');
  assert.equal(slotEntry('page', '/triggers')?.pluginId, '@timon/triggers');
  assert.equal(slotEntry('page', '/routines')?.pluginId, '@timon/triggers', 'the former address redirects');
  assert.equal(slotEntry('page', '/memory')?.pluginId, '@timon/memory');
  assert.equal(slotEntry('page', '/secrets')?.pluginId, '@timon/secrets-vault');
  assert.equal(slotEntry('page', '/brain')?.pluginId, '@timon/vault');
  assert.equal(slotEntry('page', '/memory')?.pluginId, '@timon/memory');

  mountLayout();
  mountBundledClients(capabilities({
    modules: [{ id: '@timon/dreams', tier: 'std', active: false, reason: null, missing: [] }],
  }));
  assert.equal(slotEntry('page', '/dreams'), null, 'off: nothing claims the key, the catch-all shows "unknown route"');

  // The option brings the page back without touching the composition, which a
  // licence freezes anyway.
  mountLayout();
  mountBundledClients(capabilities({
    modules: [{ id: '@timon/dreams', tier: 'std', active: true, reason: null, missing: [], options: { ui: true } }],
  }));
  assert.equal(slotEntry('page', '/dreams')?.pluginId, '@timon/dreams');
});

// ── Triggers: the Routines page renamed, held by `@timon/triggers` ──────────

test('the Triggers page belongs to triggers; routines stand in only when it is off', () => {
  const owner = (key: string) => slotEntry('page', key)?.pluginId ?? null;
  const navOf = (id: string) => slotEntries('nav.item').filter((e) => e.pluginId === id).length;
  const mod = (id: string, active: boolean) => ({ id, tier: 'std' as const, active, reason: null, missing: [] });

  mountLayout();
  mountBundledClients(capabilities({ modules: [mod('@timon/triggers', true), mod('@timon/routines', true)] }));
  assert.equal(owner('/triggers'), '@timon/triggers');
  assert.equal(owner('/routines'), '@timon/triggers');
  assert.equal(navOf('@timon/triggers'), 1);
  assert.equal(navOf('@timon/routines'), 0, 'one entry for the renamed page, not two');

  // A Free licence minted before the module existed: routines keep a page.
  mountLayout();
  mountBundledClients(capabilities({ modules: [mod('@timon/triggers', false), mod('@timon/routines', true)] }));
  assert.equal(owner('/triggers'), '@timon/routines');
  assert.equal(owner('/routines'), '@timon/routines');
  assert.equal(navOf('@timon/routines'), 1);

  mountLayout();
  mountBundledClients(capabilities({ modules: [mod('@timon/triggers', false), mod('@timon/routines', false)] }));
  assert.equal(owner('/triggers'), null);
  assert.equal(owner('/routines'), null);
});

test('a grant written for the former Routines page still opens the Triggers page', () => {
  const restricted = (pages: string[], nav: string[]) => capabilities({ surfaces: {
    pages, nav, widgets: [], plugins: [], themes: [], layouts: [],
  } });
  mountLayout();
  mountBundledClients(restricted(['/routines'], ['routines']));
  assert.equal(slotEntry('page', '/triggers')?.pluginId, '@timon/triggers');
  mountLayout();
  mountBundledClients(restricted([], []));
  assert.equal(slotEntry('page', '/triggers'), null);
});

// ── @timon/agent-chat: one card per instance ────────────────────────────────

test('the agent-chat half offers its creation card even with no instance', () => {
  resetInstancesForTests();
  mountLayout();
  mountBundledClients(null);
  const cards = slotEntries('cockpit.widget').filter((e) => e.pluginId === '@timon/agent-chat');
  assert.deepEqual(cards.map((e) => e.key), ['new']);
});

test('each instance gets its own registration, keyed by its id', async () => {
  resetInstancesForTests();
  mountLayout();
  mountBundledClients(null);

  await saveInstance(instance({
    id: 'alice', agent: 'alice.main', title: 'Alice',
    subAgents: [{ agent: 'Alice.helper' }],
  }));
  await saveInstance(instance({ id: 'coder', agent: 'initech.coder' }));

  const cards = slotEntries('cockpit.widget').filter((e) => e.pluginId === '@timon/agent-chat');
  assert.deepEqual(cards.map((e) => e.key), ['new', 'alice', 'coder']);
  // Placement is the couple (plugin, key): two cards of the same widget must
  // not share a spot, or the second would sit on the first at every reload.
  const catalog = tileCatalog().map((e) => e.id);
  assert.ok(catalog.includes('plugin:@timon/agent-chat:alice'));
  assert.ok(catalog.includes('plugin:@timon/agent-chat:coder'));
  // An untitled card is named after its agent, in the header AND the palette.
  assert.equal(cards.find((e) => e.key === 'coder')?.widget?.title, 'initech.coder');
});

test('renaming a card keeps its placement; removing it takes the card away', async () => {
  resetInstancesForTests();
  mountLayout();
  mountBundledClients(null);

  await saveInstance(instance({ id: 'alice', agent: 'alice.main', title: 'Alice' }));
  await saveInstance(instance({ id: 'alice', agent: 'alice.main', title: 'Pilote' }));

  const card = slotEntries('cockpit.widget').find((e) => e.key === 'alice');
  assert.equal(card?.widget?.title, 'Pilote');
  assert.equal(
    slotEntries('cockpit.widget').filter((e) => e.key === 'alice').length,
    1,
    'a re-registration replaces the card, it does not add a second one',
  );

  await deleteInstance('alice');
  assert.equal(slotEntries('cockpit.widget').some((e) => e.key === 'alice'), false);
});

test('unmounting the halves stops the instance store from putting cards back', async () => {
  resetInstancesForTests();
  mountLayout();
  const unmount = mountBundledClients(null);
  await saveInstance(instance({ id: 'alice', agent: 'alice.main' }));
  unmount();
  await saveInstance(instance({ id: 'autre', agent: 'other.main' }));
  assert.deepEqual(slotEntries('cockpit.widget'), []);
});

test('the seeded card opens in the cockpit centre, and removing it takes the card away', async () => {
  resetInstancesForTests();
  mountLayout();
  mountBundledClients(null);
  const seed = seedForAgent('Nova');
  await saveInstance(seed);
  const registered = slotEntries('cockpit.widget').find((e) => e.key === seed.id);
  assert.equal(registered?.widget?.zone, 'centre');
  const placedEntry = tileCatalog().find((e) => e.id === `plugin:@timon/agent-chat:${seed.id}`);
  assert.equal(placedEntry?.defaultZone, 'centre');
  await deleteInstance(seed.id);
  assert.equal(slotEntries('cockpit.widget').some((e) => e.key === seed.id), false);
});


test('the retired mail placement is ignored without a gap or a transfer to the third-party widget', () => {
  mountLayout();
  mountBundledClients(null);
  const retired = { id: 'plugin:@timon/old-mail:mails', rail: 'gauche', rang: 1, hauteur: 160 };
  const saved = [
    { id: 'plugin:@timon/ui-layout:clock', rail: 'gauche', rang: 0, hauteur: 140 },
    retired,
    { id: 'plugin:@timon/vault:vault-graph', rail: 'gauche', rang: 2, hauteur: 300 },
  ];
  const catalog = tileCatalog();
  const layout = mergeLayout(saved, catalog);
  assert.equal(layout.some((entry) => entry.id === retired.id), false);
  assert.deepEqual(orphanPlacements(saved, catalog), [retired]);
  const rail = widgetsOfZone(layout, 'gauche');
  assert.deepEqual(rail.map((entry) => entry.rang), rail.map((_, index) => index));
  assert.equal(catalog.some((entry) => entry.pluginId === 'old-mail'), false);

  register({ slot: 'cockpit.widget', pluginId: 'old-mail', key: 'old-mail' }, Empty);
  const installed = mergeLayout(saved, tileCatalog());
  const widget = installed.find((entry) => entry.id === 'plugin:old-mail:old-mail');
  assert.ok(widget);
  assert.notEqual(widget.hauteur, retired.hauteur, 'the new widget uses its own defaults');
});

// ---- Machines (TODO #329): a half anchored on this computer ----------------

const MACHINES = '@timon/machines';
const machinesModule = (active: boolean) => capabilities({
  modules: [{ id: MACHINES, tier: 'opt', active, reason: active ? null : 'off by default', missing: [] }],
});
const machinesSurfaces = () => ({
  footer: slotEntries('nav.footer').some((e) => e.pluginId === MACHINES),
  settings: slotEntries('settings.section').some((e) => e.pluginId === MACHINES),
});

/** The page as rendered for machine `id` (`<html data-timon-machine>`). */
function onMachine<T>(id: string, run: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { getAttribute: (name: string) => (name === 'data-timon-machine' ? id : null) } },
  });
  try {
    return run();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

test('Machines on this computer: its switcher and settings follow the local module', () => {
  mountLayout();
  const off = mountBundledClients(machinesModule(false));
  assert.deepEqual(machinesSurfaces(), { footer: false, settings: false });
  off();
  const on = mountBundledClients(machinesModule(true));
  assert.deepEqual(machinesSurfaces(), { footer: true, settings: true });
  on();
});

test('Machines is never shown on a guess: capabilities not loaded, or silent about it', () => {
  mountLayout();
  const unloaded = mountBundledClients(null);
  assert.deepEqual(machinesSurfaces(), { footer: false, settings: false });
  unloaded();
  const silent = mountBundledClients(capabilities());
  assert.deepEqual(machinesSurfaces(), { footer: false, settings: false });
  silent();
});

test('on a remote machine without the plugin, the switcher and the way back stay', () => {
  mountLayout();
  // The capabilities are the remote's: there, the module is off.
  const dispose = onMachine('vps', () => mountBundledClients(machinesModule(false)));
  assert.deepEqual(machinesSurfaces(), { footer: true, settings: true });
  // Other halves still follow the remote's capabilities.
  dispose();
  const kanbanOff = onMachine('vps', () => mountBundledClients(capabilities({
    modules: [{ id: '@timon/kanban', tier: 'std', active: false, reason: null, missing: [] }],
  })));
  assert.equal(slotEntries('nav.item').some((e) => e.pluginId === '@timon/kanban'), false);
  kanbanOff();
});
