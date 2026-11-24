/**
 * Every arrangement an onboarding tour proposes passes the daemon's own checks,
 * as its route would run them: the schema, then the validator against a
 * catalog that mirrors the product's (the real widget ids, the real island
 * types and the params they declare). A recipe that drifts fails here, not on
 * a tester's screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESSENTIAL_NAV_PAGES, ONBOARDING_RECIPES, RECIPE_PLACEHOLDERS, fillRecipe, recipesFor, renderRecipes } from './onboarding-recipes.js';
import { IslandsProposal, readStoredTree, validateIslandsProposal, type StoredIslandSnapshot } from './plugins-bundled/settings/island-model.js';
import { mergeSnapshot, validateWidgetsProposal, WidgetsProposal, type SnapshotBody } from './plugins-bundled/settings/widget-model.js';
import { NAV_PAGES, NavProposal, validateNavProposal } from './plugins-bundled/settings/nav-model.js';
import { CORE_ROUTES } from './plugins-bundled/settings/navigate-model.js';

const VALUES: Record<string, string> = {
  '<project>': 'timon-demo',
  '<chat-agent>': 'timon-demo.coder',
  '<other-agent>': 'assistant.mails',
};

/** The island types as the browser declares them (`app/src/plugins-client/*`). */
const islandSnapshot: StoredIslandSnapshot = {
  at: 1,
  types: [
    { type: '@timon/terminal-web:session', title: 'Terminal', params: {
      sessionId: { type: 'string', maxLength: 128 },
      scope: { type: 'string', nullable: true, maxLength: 210 },
      fresh: { type: 'boolean' },
    } },
    { type: '@timon/browser-embedded:view', title: 'Embedded browser', params: {
      agent: { type: 'string', required: true, maxLength: 128 },
      mission: { type: 'string', nullable: true, maxLength: 64 },
      display: { type: 'string', enum: ['auto', 'mobile', 'desktop'] },
    } },
    { type: '@timon/missions:chat', title: 'Chat', params: {
      agent: { type: 'string', required: true, maxLength: 128 },
      missionId: { type: 'string', nullable: true, maxLength: 128 },
      fresh: { type: 'boolean' },
    } },
    { type: '@timon/ui-layout:widget-card', title: 'Widget', params: {
      widget: { type: 'string', required: true, maxLength: 200 },
    } },
    { type: '@timon/ui-layout:widget-zone', title: 'Widgets', params: {} },
  ],
};

const WIDGETS = [
  'plugin:@timon/agents:team', 'plugin:@timon/agents:notifications', 'plugin:@timon/agents:tasks',
  'plugin:@timon/missions:recent', 'plugin:@timon/missions:Missions',
  'plugin:@timon/projects:overview', 'plugin:@timon/kanban:todo', 'plugin:@timon/kanban:project-todo',
  'plugin:@timon/workflows:trace', 'plugin:@timon/files-widget:Files', 'plugin:@timon/git:branches',
  'plugin:@timon/grepai:grepai',
];
// Checked against a live `widgets_get` (15/10/2026): each of these exists, and
// like every non-compact widget of the product it admits every vertical zone —
// the cockpit's columns and the chat's alike. The slots below are that reality.
const catalog: SnapshotBody['catalog'] = WIDGETS.map((id) => ({
  id,
  title: id,
  pluginId: id.split(':')[1]!.replace(/^(@[^/]+\/[^:]+).*$/, '$1'),
  slots: ['cockpit.widget', 'chat.left.widget', 'chat.right.widget'],
}));
const withCockpit = mergeSnapshot(null, {
  catalog,
  view: { path: '/', zones: ['gauche', 'centre', 'droite'].map((id) => ({ id, slot: 'cockpit.widget' })) },
}, 1);
const widgetSnapshot = mergeSnapshot(withCockpit, {
  catalog,
  view: { path: '/chat', zones: [{ id: 'chat.left.widget', slot: 'chat.left.widget' }, { id: 'chat.right.widget', slot: 'chat.right.widget' }] },
}, 2);

/** What the routes do with `project: ""`: no project. */
function asRouteReads(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.project === '' ? { ...payload, project: null } : payload;
}

for (const recipe of ONBOARDING_RECIPES) {
  test(`${recipe.id} passes the ${recipe.tool} checks`, () => {
    const filled = asRouteReads(fillRecipe(recipe.payload, VALUES) as Record<string, unknown>);
    assert.ok(!JSON.stringify(filled).includes('<'), 'every placeholder is filled');
    if (recipe.tool === 'islands_propose') {
      const parsed = IslandsProposal.safeParse(filled);
      assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
      const v = validateIslandsProposal(parsed.data, { snapshot: islandSnapshot, current: readStoredTree(null), allowed: () => true });
      assert.deepEqual(v.problems, []);
      assert.deepEqual(v.warnings, []);
    } else if (recipe.tool === 'widgets_propose') {
      const parsed = WidgetsProposal.safeParse(filled);
      assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
      assert.deepEqual(validateWidgetsProposal(parsed.data, { snapshot: widgetSnapshot, columns: null, allowed: () => true }), []);
    } else {
      const parsed = NavProposal.safeParse(filled);
      assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
      assert.deepEqual(validateNavProposal(parsed.data), { problems: [], warnings: [] });
    }
  });
}

test('no menu recipe hides an essential page, and each names only real menu entries', () => {
  // `NAV_PAGES` is the app's registry as the daemon mirrors it; the app's own
  // test (`app/src/lib/onboarding-recipes.test.ts`) holds the mirror to the
  // `registerNavItem` calls.
  const menu = new Set(NAV_PAGES.map((p) => p.path));
  for (const page of ESSENTIAL_NAV_PAGES) {
    assert.ok(menu.has(page) || CORE_ROUTES.some((r) => r.path === page), `${page} is not a page of the product`);
  }
  const navRecipes = ONBOARDING_RECIPES.filter((r) => r.tool === 'nav_propose');
  for (const profile of ['developer', 'automation', 'beginner'] as const) {
    assert.ok(navRecipes.some((r) => r.profile === profile), `${profile} has a menu recipe`);
  }
  for (const recipe of navRecipes) {
    const { hidden = [], order = [], footer = [] } = recipe.payload as { hidden?: string[]; order?: string[]; footer?: string[] };
    for (const page of hidden) {
      assert.ok(!ESSENTIAL_NAV_PAGES.includes(page), `${recipe.id} hides ${page}`);
      assert.ok(menu.has(page), `${recipe.id} hides ${page}, which is not an entry of the product's menu`);
    }
    for (const page of [...order, ...footer]) assert.ok(page === '---' || menu.has(page), `${recipe.id} places ${page}`);
  }
});

test('the beginner menu keeps the essentials and hides only advanced pages', () => {
  const beginner = ONBOARDING_RECIPES.find((r) => r.id === 'beginner.nav');
  assert.ok(beginner);
  const hidden = beginner.payload.hidden as string[];
  assert.ok(hidden.length > 0, 'the simpler screen does hide something');
  const kept = NAV_PAGES.map((p) => p.path).filter((p) => !hidden.includes(p));
  for (const page of ['/', '/agents', '/bots', '/projects', '/kanban', '/brain']) assert.ok(kept.includes(page), page);
  for (const page of ['/terminal', '/workflows', '/triggers', '/plugins']) assert.ok(hidden.includes(page), page);
});

test('ids are unique, every profile has its list, every placeholder is documented', () => {
  assert.equal(new Set(ONBOARDING_RECIPES.map((r) => r.id)).size, ONBOARDING_RECIPES.length);
  for (const profile of ['developer', 'automation', 'beginner'] as const) assert.ok(recipesFor(profile).length >= 2, profile);
  for (const r of ONBOARDING_RECIPES) {
    for (const p of JSON.stringify(r.payload).match(/<[a-z-]+>/g) ?? []) assert.ok(p in RECIPE_PLACEHOLDERS, `${r.id}: ${p}`);
    assert.ok(r.id.startsWith(`${r.profile}.`), r.id);
  }
});

test('the rendered section carries each payload exactly as tested', () => {
  for (const profile of ['developer', 'automation', 'beginner'] as const) {
    const text = renderRecipes(profile);
    for (const r of recipesFor(profile)) assert.ok(text.includes(JSON.stringify(r.payload)), r.id);
  }
});

test('placeholders are replaced inside strings and keys alike', () => {
  assert.deepEqual(fillRecipe({ scope: 'project:<project>', list: ['<project>'] }, VALUES), { scope: 'project:timon-demo', list: ['timon-demo'] });
});

test('the harness does catch a broken arrangement', () => {
  const widgets = WidgetsProposal.safeParse({ view: '/', zones: { centre: ['plugin:@timon/nope:gone'] } });
  assert.ok(widgets.success);
  assert.notDeepEqual(validateWidgetsProposal(widgets.data, { snapshot: widgetSnapshot, columns: null, allowed: () => true }), []);
  const islands = IslandsProposal.safeParse({ view: '/chat', open: { content: { type: '@timon/terminal-web:session', params: { scope: 'project:x', fresh: 'yes' } }, edge: 'bottom' } });
  assert.ok(islands.success);
  assert.notDeepEqual(validateIslandsProposal(islands.data, { snapshot: islandSnapshot, current: readStoredTree(null), allowed: () => true }).problems, []);
});
