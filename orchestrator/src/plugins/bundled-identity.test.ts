/**
 * The gallery identity of every bundled module — kinds, slots, routes.
 *
 * What this locks: a module added to the catalog without an identity would
 * show up as `behavior` again, which is exactly the lie the gallery used to
 * tell about Agent chat (a widget) and Settings (a page).
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CATALOG } = await import('../kernel/catalog.js');
const { BUNDLED_AUTHOR, BUNDLED_IDENTITY, bundledIdentity } = await import('./bundled-identity.js');
const { toPublicBundled } = await import('./public.js');
const { PLUGIN_KINDS } = await import('./manifest.js');
const { BUNDLED_ICONS, bundledIconUrl } = await import('./bundled-icons.js');

test('every catalogue module has a gallery identity', () => {
  const catalogIds = CATALOG.map((m) => m.id).sort();
  const identityIds = Object.keys(BUNDLED_IDENTITY).sort();
  assert.deepEqual(identityIds, catalogIds);
});

test('Agent chat is a widget, Settings a page, the kernel a backend', () => {
  assert.deepEqual(bundledIdentity('@timon/agent-chat').kind, ['widget']);
  assert.deepEqual(bundledIdentity('@timon/agent-chat').slots, ['cockpit.widget']);
  assert.equal(bundledIdentity('@timon/settings').route, '/settings');
  assert.deepEqual(bundledIdentity('@timon/settings').kind, ['page']);
  assert.deepEqual(bundledIdentity('@timon/db').kind, ['behavior']);
  // The layout also paints the cockpit clock: the Widget filter must list it.
  assert.deepEqual(bundledIdentity('@timon/ui-layout').kind, ['layout', 'widget']);
  assert.deepEqual(bundledIdentity('@timon/grepai').kind, ['widget']);
  assert.equal(bundledIdentity('@timon/ui-layout').slots[0], 'root');
  assert.deepEqual(bundledIdentity('@timon/ui-theme').kind, ['theme']);
  assert.deepEqual(bundledIdentity('@timon/ui-theme').slots, ['theme', 'settings.section']);
  // The /dreams page follows `@timon/dreams`, the "TO DO" notebook follows
  // `@timon/kanban`.
  assert.deepEqual(bundledIdentity('@timon/dreams').kind, ['widget', 'page']);
  assert.equal(bundledIdentity('@timon/dreams').route, '/dreams');
  // Part 4/4: the notebook took over a tile, so the Kanban is ALSO a
  // widget: two `kind`s, like dreams.
  assert.deepEqual(bundledIdentity('@timon/kanban').kind, ['page', 'widget']);
  assert.deepEqual(bundledIdentity('@timon/kanban').slots, ['nav.item', 'kanban.column', 'cockpit.widget', 'task.form', 'kanban.card', 'todo.form', 'kanban.todo.landing', 'kanban.job.dialog', 'forge.publish.dialog', 'project.settings']);
  // TODO #311: the code pipeline paints nothing any more. TODO #356, #357:
  // the chat's Files, Skills and MCP cards are widgets of their own, so the
  // agents module leaves both chat rails.
  assert.deepEqual(bundledIdentity('@timon/kanban-code').kind, ['behavior']);
  assert.deepEqual(bundledIdentity('@timon/files-widget').kind, ['widget']);
  assert.deepEqual(bundledIdentity('@timon/files-widget').slots, ['chat.left.widget']);
  assert.equal(bundledIdentity('@timon/files-widget').route, null);
  for (const id of ['@timon/skills-widget', '@timon/mcp-widget']) {
    assert.deepEqual(bundledIdentity(id).kind, ['widget'], id);
    assert.deepEqual(bundledIdentity(id).slots, ['chat.right.widget'], id);
    assert.equal(bundledIdentity(id).route, null, id);
  }
  assert.deepEqual(bundledIdentity('@timon/agents').slots, ['nav.item', 'cockpit.widget', 'settings.agenttrash', 'agent.mascot', 'agent.lookstyler']);
  // A host module that also occupies the browser's chrome (TODO #461): still `behavior`, its slots named.
  assert.deepEqual(bundledIdentity('@timon/browser-recording').kind, ['behavior']);
  assert.deepEqual(bundledIdentity('@timon/browser-recording').slots, ['browser.toolbar', 'browser.drawer']);
});

test('toPublicBundled sets the real kind, plus Timon as the author', () => {
  const agentChat = toPublicBundled({
    id: '@timon/agent-chat', tier: 'std', active: true, reason: null, missing: [], wanted: 'auto',
  });
  assert.deepEqual(agentChat.kind, ['widget']);
  assert.deepEqual(agentChat.slots, ['cockpit.widget']);
  assert.equal(agentChat.author, BUNDLED_AUTHOR);
  assert.equal(agentChat.signed, null, 'a bundled module has no signature: the catalogue is the trust');
  assert.equal(agentChat.label, null, 'the translated label lives in the front end, not here');
  assert.deepEqual(agentChat.screenshots, []);

  const core = toPublicBundled({
    id: '@timon/db', tier: 'core', active: true, reason: null, missing: [], wanted: 'auto',
  });
  assert.deepEqual(core.kind, ['behavior']);
  assert.equal(core.author, 'Timon');
});

test('the Files card plugin reaches the gallery as a widget, under its -widget name (TODO #356)', () => {
  // The gallery paints one badge per kind (PluginKindBadge, KIND_TONE.widget):
  // this is the kind it receives, not a guess from the slots.
  const files = toPublicBundled({ id: '@timon/files-widget', tier: 'std', active: true, reason: null, missing: [], wanted: 'auto' });
  assert.deepEqual(files.kind, ['widget']);
  assert.deepEqual(files.slots, ['chat.left.widget']);
  assert.equal(BUNDLED_IDENTITY['@timon/files'], undefined, 'the short-lived name is gone');
});

test('an unknown id falls back to behavior, without inventing a surface', () => {
  const ghost = bundledIdentity('not-in-the-catalog');
  assert.deepEqual(ghost.kind, ['behavior']);
  assert.deepEqual(ghost.slots, []);
  assert.equal(ghost.route, null);
});

test('ui-layout declares the settings grafting sockets, without a dash', () => {
  const declares = bundledIdentity('@timon/ui-layout').declares;
  assert.equal(declares['settings.section'], 'keyed');
  assert.equal(declares['settings.missions'], 'list');
  assert.equal(declares['settings.llmfallback'], 'list');
  assert.equal(declares['settings.notifications'], 'list');
  assert.equal(declares['settings.memoryinjection'], 'list');
  assert.equal(declares['settings.llm-fallback'], undefined);
});

test('aucun kind hors contrat', () => {
  const allowed = new Set<string>(PLUGIN_KINDS);
  for (const [id, identity] of Object.entries(BUNDLED_IDENTITY)) {
    for (const kind of identity.kind) {
      assert.equal(allowed.has(kind), true, `${id} declares an unknown kind: ${kind}`);
    }
  }
});

test('every catalogue module has a gallery picto, served as an SVG data URL', () => {
  assert.deepEqual(Object.keys(BUNDLED_ICONS).sort(), CATALOG.map((m) => m.id).sort());
  for (const [id, body] of Object.entries(BUNDLED_ICONS)) {
    // A mask loads nothing external and runs nothing: a body is plain shapes.
    assert.doesNotMatch(body, /<script|href|url\(|<text|on\w+=/i, id);
    assert.equal(toPublicBundled({ id, tier: 'std', active: true, reason: null, missing: [], wanted: 'auto' }).icon, bundledIconUrl(id));
  }
  assert.match(bundledIconUrl('@timon/agent-chat') ?? '', /^data:image\/svg\+xml,%3Csvg/);
  assert.equal(bundledIconUrl('@timon/absent'), null);
});

test('ui-layout declares on the daemon side exactly the sockets the app opens at startup', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const appHost = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'app', 'src', 'lib', 'plugin-host');
  const block = (file: string, start: string): string => {
    const source = readFileSync(join(appHost, file), 'utf8');
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `${start} not found in ${file}`);
    return source.slice(from, source.indexOf('\n};', from));
  };
  const expected: Record<string, string> = {};
  for (const m of block('ui-layout.tsx', 'export const UI_LAYOUT_CHILD_SLOTS').matchAll(/^\s*'?([a-z][\w.]*)'?:\s*'(single|list|keyed)'/gm)) {
    expected[m[1]!] = m[2]!;
  }
  for (const m of block('settings-slots.ts', 'SETTINGS_GROUP_TO_SLOT').matchAll(/:\s*'(settings\.[a-z]+)'/g)) {
    expected[m[1]!] = 'list';
  }
  assert.equal(expected['nav.footer'], 'list');
  assert.equal(expected['dictation.engine'], 'keyed');
  assert.deepEqual(
    Object.fromEntries(Object.entries(bundledIdentity('@timon/ui-layout').declares).sort(([a], [b]) => a.localeCompare(b))),
    Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))),
  );
});
