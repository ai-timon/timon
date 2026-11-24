/**
 * What the local gallery promises, and that nothing else checks: a card
 * is drawn for an UNPLUGGED plugin as for an active one, and the
 * toggle does not lie about a plugin the daemon refuses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_PROVENANCES,
  GALLERY_TYPES,
  containedEntries, countByProvenance, coverProxyUrl, filterGallery, groupBySource, iconProxyUrl, kindLabel,
  mediaSlides, stillProxyUrl,
  provenanceOf, sortForGallery, toCardData, type PluginPublic,
} from './plugin-gallery';
import { pictoSrc } from './picto';
import { getLocale, setLocale } from './i18n';
import './i18n-test-locales';

function plugin(patch: Partial<PluginPublic>): PluginPublic {
  return {
    id: 'acme', pkg: '@acme/plugin', version: '1.0.0', source: 'third-party', tier: null, wanted: null,
    state: 'active', reason: null, error: null,
    kind: ['widget'], label: 'Acme', description: null, author: 'Acme Corp', signed: true, screenshots: [],
    cover: null, slots: ['cockpit.widget'],
    route: null, declares: {}, modifies: [], contains: [], client: null, settings: [],
    ...patch,
  };
}

test('island plugins have a translated kind and can be filtered in the gallery', () => {
  const locale = getLocale();
  try {
    setLocale('en');
    assert.equal(kindLabel('island'), 'Island');
    setLocale('fr');
    assert.equal(kindLabel('island'), 'Îlot'); // french-ok: the French locale under test
    const island = plugin({ id: 'example-island', kind: ['island'], slots: ['island.content'] });
    assert.ok(GALLERY_TYPES.includes('island'));
    assert.deepEqual(filterGallery([plugin({}), island], { provenance: 'all', type: 'island', query: '' }), [island]);
  } finally {
    setLocale(locale);
  }
});

test('an unplugged plugin keeps its card: cover, slots and title come from the manifest', () => {
  const card = toCardData(plugin({
    state: 'disabled',
    reason: 'disabled in timon.config.json',
    cover: '/plugins/acme/cover?rev=abc',
  }));
  assert.equal(card.enabled, false);
  assert.equal(card.blockedReason, null, 'unplugging is not a refusal: the toggle stays usable');
  assert.equal(card.coverUrl, '/api/ui/plugin-covers/acme?rev=abc');
  assert.deepEqual(card.slots, ['cockpit.widget']);
});

test('a daemon refusal greys out the toggle and shows its reason', () => {
  for (const state of ['skipped', 'failed'] as const) {
    const card = toCardData(plugin({ state, reason: `skipped:unsigned`, error: 'SIGNATURE absent' }));
    assert.equal(card.blockedReason, 'SIGNATURE absent', state);
    // And the switch is OFF. It is greyed out by `blockedReason`, so
    // nobody can flip it: on, it simply claimed that the
    // plugin runs while the daemon refused it.
    assert.equal(card.enabled, false, state);
  }
  assert.equal(toCardData(plugin({ state: 'skipped', reason: 'skipped:unlicensed', error: null })).blockedReason, 'skipped:unlicensed');
});

test('the label falls back to the id, never to nothing', () => {
  assert.equal(toCardData(plugin({ label: null })).label, 'acme');
});

test('the route of a page is shown next to its slots', () => {
  const card = toCardData(plugin({ kind: ['page'], slots: ['page'], route: '/acme' }));
  assert.equal(card.route, '/acme');
  assert.deepEqual(card.kinds, ['page']);
});

test('coverProxyUrl goes through the Next proxy and keeps the revision', () => {
  assert.equal(coverProxyUrl('acme', null), null);
  assert.equal(coverProxyUrl('acme', '/plugins/acme/cover'), '/api/ui/plugin-covers/acme');
  assert.equal(coverProxyUrl('a b', '/plugins/x/cover?rev=1'), '/api/ui/plugin-covers/a%20b?rev=1');
  assert.equal(stillProxyUrl('acme', '/plugins/acme/still/0?rev=ab'), '/api/ui/plugin-stills/acme/0?rev=ab');
});

test('the gallery order: plugged in, refused, unplugged', () => {
  const order = sortForGallery([
    plugin({ id: 'off', label: 'Off', state: 'disabled' }),
    plugin({ id: 'ko', label: 'Ko', state: 'failed' }),
    plugin({ id: 'on', label: 'On', state: 'active' }),
  ]).map((p) => p.id);
  assert.deepEqual(order, ['on', 'ko', 'off']);
});

function bundled(patch: Partial<PluginPublic>): PluginPublic {
  return plugin({
    id: '@timon/vault', pkg: '@timon/vault', version: '', source: 'bundled', tier: 'opt', wanted: 'auto',
    kind: ['widget'], label: null, slots: ['cockpit.widget'], author: 'Timon', signed: null,
    ...patch,
  });
}

/**
 * The bug that opened this part: `/plugins` said "no plugin" on an
 * install that embeds some thirty modules.
 */
test('the product modules form their own half of the gallery', () => {
  const { bundled: mine, thirdParty } = groupBySource([bundled({}), plugin({})]);
  assert.deepEqual(mine.map((p) => p.id), ['@timon/vault']);
  assert.deepEqual(thirdParty.map((p) => p.id), ['acme']);
  const card = toCardData(bundled({}));
  assert.equal(card.label, 'Vault');
  assert.match(card.description ?? '', /cockpit/);
  assert.equal(card.author, 'Timon');
  assert.deepEqual(card.kinds, ['widget']);
  assert.equal(card.version, null);
});

test('behavior shows as Backend, the other kinds keep a readable label', () => {
  assert.equal(kindLabel('behavior'), 'Backend');
  assert.equal(kindLabel('widget'), 'Widget');
  assert.equal(kindLabel('page'), 'Page');
  assert.equal(kindLabel('bundle'), 'Bundle');
  assert.equal(kindLabel('layout'), 'Layout');
});

test('a bundled module turned off never talks about a restart', () => {
  // The nominal state after a switch: the daemon recomposed the tree during
  // the request, so the config and the tree say the same thing.
  const off = toCardData(bundled({ wanted: false, state: 'disabled' }));
  assert.equal(off.enabled, false);
  assert.equal(off.note, null, 'nothing left to wait for: the switch already happened');
  assert.equal(off.blockedReason, null);

  // The window from before, where the config said no and the module still ran.
  // It must no longer exist; if it opens again, we send nobody towards
  // a restart only the user can do.
  const stale = toCardData(bundled({ wanted: false, state: 'active' }));
  assert.equal(stale.enabled, false);
  assert.equal(stale.note, null);

  // `auto`: the switch shows what the kernel decided.
  assert.equal(toCardData(bundled({ wanted: 'auto', state: 'active' })).enabled, true);
  assert.equal(toCardData(bundled({ wanted: 'auto', state: 'disabled' })).enabled, false);
});

test('a missing host capability explains without taking the toggle away', () => {
  const card = toCardData(bundled({
    id: 'grepai', tier: 'dev', wanted: 'auto', state: 'skipped',
    reason: 'missing host capability: grepai',
  }));
  assert.equal(card.blockedReason, null, 'std/opt/dev restent basculables');
  assert.equal(card.locked, false);
  assert.equal(card.note, 'missing host capability: grepai');
});

test('a bundled module the licence leaves out reads as refused, not as turned on', () => {
  // Machines enabled in the config, skipped by the daemon: the switch lit on
  // the wish told the user it ran, and nothing on screen said otherwise.
  for (const reason of ['non couvert par la licence', 'not included in this licence']) {
    const card = toCardData(bundled({ id: '@timon/machines', tier: 'opt', wanted: true, state: 'skipped', reason }));
    assert.equal(card.enabled, false);
    assert.equal(card.blockedReason, 'Not included in your licence');
    assert.equal(card.note, null, 'the raw sentence of the daemon is not repeated under it');
    assert.equal(card.locked, false);
  }
  // Off by default and not licensed: same card.
  const auto = toCardData(bundled({ id: '@timon/dreams', tier: 'std', wanted: 'auto', state: 'skipped', reason: 'non couvert par la licence' }));
  assert.equal(auto.blockedReason, 'Not included in your licence');
  // A licensed module that runs is untouched.
  assert.equal(toCardData(bundled({ id: '@timon/dreams', tier: 'std', wanted: true, state: 'active' })).blockedReason, null);
});

test('a core module is visible, but its toggle is taken away', () => {
  const card = toCardData(bundled({ id: '@timon/db', tier: 'core', state: 'active' }));
  assert.equal(card.locked, true);
  assert.equal(card.enabled, true);
  assert.equal(card.note, 'Core module — the daemon does not run without it.');
  // A `false` written by hand in the file cannot turn the kernel off:
  // the switch shows what runs, not a wish that `planEntries` ignores.
  assert.equal(toCardData(bundled({ id: '@timon/db', tier: 'core', state: 'active', wanted: false })).enabled, true);
});

test('the product theme is locked without being core: it carries the palette', () => {
  // `std`: the daemon does not need it, the browser does. Turning it off would empty
  // the `theme` slot — 125 undefined tokens, gallery included. The daemon refuses
  // (403), so the switch must not even be offered.
  const card = toCardData(bundled({ id: '@timon/ui-theme', tier: 'std', state: 'active' }));
  assert.equal(card.locked, true);
  assert.equal(card.note, 'Carries every colour token — switching it off would leave the app with no palette. Change theme in Appearance.');
  assert.equal(toCardData(bundled({ id: '@timon/vault', tier: 'std', state: 'active' })).locked, false);
});

test('two families: @timon (by the id scope) and Marketplace', () => {
  // The tier no longer makes a family: a `core` module is an @timon like
  // the others, it only differs by its switch taken away.
  assert.equal(provenanceOf(bundled({ id: '@timon/db', tier: 'core' })), 'timon');
  assert.equal(provenanceOf(bundled({ id: '@timon/vault', tier: 'opt' })), 'timon');
  // The signature no longer sorts: an approved third-party package stays in the Marketplace,
  // with a "Verified" badge on its card.
  assert.equal(provenanceOf(plugin({ signed: true })), 'marketplace');
  assert.equal(provenanceOf(plugin({ signed: false, state: 'skipped', reason: 'skipped:unsigned' })), 'marketplace');
  assert.deepEqual([...GALLERY_PROVENANCES], ['timon', 'marketplace']);
});

test('the card badge follows the signature, and only a third party carries one', () => {
  assert.equal(toCardData(plugin({ signed: true })).signed, true);
  assert.equal(toCardData(plugin({ signed: false })).signed, false);
  assert.equal(toCardData(bundled({ id: '@timon/db', tier: 'core' })).signed, null);
});

test('gallery filter: provenance, type and search combine', () => {
  const catalog = [
    bundled({ id: '@timon/db', tier: 'core', kind: ['behavior'], label: null }),
    bundled({ id: '@timon/vault', tier: 'opt', kind: ['widget'] }),
    plugin({ id: 'acme', signed: true, kind: ['widget'], label: 'Acme' }),
    plugin({ id: 'example-bundle', signed: false, kind: ['bundle'], label: 'Tableau exemple' }),
  ];
  const all = { provenance: 'all' as const, type: 'all' as const, query: '' };
  assert.equal(filterGallery(catalog, all).length, 4);
  assert.deepEqual(
    filterGallery(catalog, { ...all, provenance: 'timon' }).map((p) => p.id).sort(),
    ['@timon/db', '@timon/vault'],
  );
  assert.deepEqual(
    filterGallery(catalog, { ...all, provenance: 'marketplace' }).map((p) => p.id).sort(),
    ['acme', 'example-bundle'],
  );
  assert.deepEqual(
    filterGallery(catalog, { ...all, type: 'widget' }).map((p) => p.id).sort(),
    ['@timon/vault', 'acme'],
  );
  assert.deepEqual(
    filterGallery(catalog, { ...all, query: 'tableau' }).map((p) => p.id),
    ['example-bundle'],
  );
  const counts = countByProvenance(catalog, { type: 'all', query: '' });
  assert.equal(counts.all, 4);
  assert.equal(counts.timon, 2);
  assert.equal(counts.marketplace, 2);
});

test('a bundle resolves its children in the catalogue, and names the missing ones', () => {
  const page = plugin({ id: 'example-page', kind: ['page'], label: 'Page d\'exemple' });
  const pack = plugin({ id: 'example-bundle', kind: ['bundle'], contains: ['example-page', 'example-widget'] });
  const entries = containedEntries(pack.contains, [pack, page]);
  assert.equal(entries[0]?.plugin?.id, 'example-page');
  assert.equal(entries[1]?.plugin, null);
  assert.equal(entries[1]?.id, 'example-widget');
});

test('mediaSlides puts the cover first and deduplicates the stills', () => {
  assert.deepEqual(mediaSlides({ coverUrl: null, screenshots: [] }), []);
  assert.deepEqual(mediaSlides({ coverUrl: '/a.png', screenshots: ['/a.png', '/b.png'] }), ['/a.png', '/b.png']);
});

test('a built-in reads as ours: flagged on the card, filed under Timon, toggle kept', () => {
  const builtin = plugin({ id: 'quota-monitor', pkg: '@timon-ai/plugin-quota-monitor', signed: false, builtin: true, state: 'disabled' });
  const card = toCardData(builtin);
  assert.equal(card.builtin, true);
  assert.equal(card.enabled, false);
  assert.equal(card.blockedReason, null, 'disabling a built-in is the user\'s gesture, not a refusal');
  assert.equal(provenanceOf(builtin), 'timon');
  assert.equal(toCardData(plugin({})).builtin, false);
  assert.equal(provenanceOf(plugin({})), 'marketplace');
});

test('iconProxyUrl: a bundled data URL passes, a package picto goes through the proxy, anything else is dropped', () => {
  const data = 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E';
  assert.equal(iconProxyUrl('@timon/vault', data), data);
  assert.equal(iconProxyUrl('acme', '/plugins/acme/icon?rev=abc'), '/api/ui/plugin-icons/acme?rev=abc');
  assert.equal(iconProxyUrl('acme', 'https://tracker.test/icon.svg'), null);
  assert.equal(iconProxyUrl('acme', 'data:text/html,<script>'), null);
  assert.equal(iconProxyUrl('acme', null), null);
  assert.equal(iconProxyUrl('acme', undefined), null);
});

test('pictoSrc: markup becomes a data URL, a URL stays one', () => {
  assert.equal(pictoSrc(' <svg/> '), `data:image/svg+xml,${encodeURIComponent('<svg/>')}`);
  assert.equal(pictoSrc('/x/icon.svg'), '/x/icon.svg');
});

test('a running module that lost part of itself to the host says so, switch untouched (TODO #275)', () => {
  const card = toCardData(bundled({
    id: '@timon/kanban', tier: 'std', wanted: 'auto', state: 'active',
    warning: 'git not found on this host: code, review and merge tasks of a git project are refused',
  }));
  assert.equal(card.enabled, true);
  assert.equal(card.blockedReason, null);
  assert.equal(card.note, 'git not found on this host: code, review and merge tasks of a git project are refused');
  assert.equal(toCardData(bundled({ id: '@timon/kanban', tier: 'std', wanted: 'auto', state: 'active' })).note, null);
});

test('the Files card plugin carries the widget badge in the gallery (TODO #356)', async () => {
  const { KIND_TONE } = await import('../components/plugin-kind-badge');
  const card = toCardData(plugin({
    id: '@timon/files-widget', pkg: '@timon/files-widget', source: 'bundled', tier: 'std', signed: null,
    kind: ['widget'], slots: ['chat.left.widget'], label: null, author: 'Timon',
  }));
  assert.deepEqual(card.kinds, ['widget']);
  assert.ok(KIND_TONE.widget, 'the widget badge has its tone');
  assert.equal(kindLabel('widget'), kindLabel(card.kinds[0]!));
});

test('the Skills and MCP card plugins carry the widget badge in the gallery (TODO #357)', () => {
  for (const id of ['@timon/skills-widget', '@timon/mcp-widget']) {
    const card = toCardData(plugin({
      id, pkg: id, source: 'bundled', tier: 'std', signed: null,
      kind: ['widget'], slots: ['chat.right.widget'], label: null, author: 'Timon',
    }));
    assert.deepEqual(card.kinds, ['widget'], id);
  }
});

test('a dictation plugin\'s card says where its voice goes, from the manifest the daemon read', () => {
  const locale = getLocale();
  try {
    setLocale('en');
    // Another kind carrying a dictation block (impossible after admission) says nothing.
    assert.deepEqual(toCardData(plugin({ dictation: { engines: [{ id: 'x1', runtime: 'page', egress: 'none' }] } })).voice, []);
    // An egress out of shape is not rendered as a destination.
    const forged = plugin({ kind: ['dictation'], dictation: { engines: [{ id: 'acme', runtime: 'page', egress: ['https://evil'] }], models: null } });
    assert.deepEqual(toCardData(forged).voice, []);
    const cloud = plugin({ kind: ['dictation'], dictation: { engines: [{ id: 'acme', runtime: 'page', egress: ['api.acme.com'] }], models: null } });
    assert.deepEqual(toCardData(cloud).voice, ['Your voice is sent to api.acme.com.']);
    assert.equal(kindLabel('dictation'), 'Dictation');
    assert.ok(GALLERY_TYPES.includes('dictation'));
    setLocale('fr');
    const daemon = plugin({ kind: ['dictation'], dictation: { engines: [{ id: 'acme', runtime: 'daemon', egress: 'daemon' }], models: null } });
    assert.deepEqual(toCardData(daemon).voice, ['Votre voix est envoyée au daemon Timon de la machine active.']); // french-ok: the French locale under test
  } finally {
    setLocale(locale);
  }
});
