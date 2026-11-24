/**
 * The `/api/plugins/*` routes, the bundle server wired to the loader, the
 * `plugins_changed` SSE event.
 *
 * What these tests protect: the UI reads the REAL state of the loader (installed,
 * active, disabled, failed, and the reason), loads the browser half
 * from a URL whose `rev` changes with the file, and recomposes without
 * reloading because the daemon emits `plugins_changed` on each
 * recomposition. The four operations (add / remove / enable / disable)
 * go through `loader.update()`: that is already the path of `timon plugin`.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { Request, Response } from 'express';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { PluginLoader } = await import('./loader.js');
const { daemonHost } = await import('./context.js');
const { PLUGIN_API_VERSION } = await import('./manifest.js');
const { registerRoutes } = await import('../plugins-bundled/plugins/routes.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { attachPluginLoader, galleryPlugins, publicPlugins } = await import('./runtime.js');
const { CATALOG } = await import('../kernel/catalog.js');
const { CONFIG_FILE } = await import('../config/load.js');
const { bus } = await import('../bus.js');
const { dbApi } = await import('../db.js');
const { isSealed } = await import('../secrets/box.js');
const { openPluginKvValue } = await import('../secrets/plugins.js');
const { sseHandler } = await import('../sse.js');
const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

import type { BusEvent } from '../bus.js';
import type { ModuleSetting } from '../config/schema.js';
import type { PluginPublic } from './public.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PKG = {
  ok: '@fixtures/plugin-ok',
  'throws-in-apply': '@fixtures/plugin-throws',
  'api-version-future': '@fixtures/plugin-api-future',
  'forbidden-inject': '@fixtures/plugin-forbidden-inject',
  'usage-reader': '@fixtures/plugin-usage',
  'dictation-pack': '@fixtures/plugin-dictation-pack',
} as const;

function install(root: string, fixtures: (keyof typeof PKG)[]): void {
  const dependencies: Record<string, string> = {};
  for (const f of fixtures) {
    const pkg = PKG[f];
    const dest = join(root, 'node_modules', pkg);
    mkdirSync(dirname(dest), { recursive: true });
    try { symlinkSync(join(FIXTURES, f), dest, 'dir'); } catch { /* already linked */ }
    dependencies[pkg] = 'file:fixture';
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'timon-plugins', private: true, dependencies }, null, 2),
  );
}

async function daemon(authToken?: string): Promise<{
  ctx: Context;
  app: express.Express;
  url: (p: string) => string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  // The daemon's real gate, for the tests that prove an anonymous caller stops there.
  if (authToken) app.use(createDaemonAuthMiddleware({ token: authToken, required: true }));
  // A restricted viewer, for the curtains: `x-test-permissions` stands for a
  // token's grant snapshot (the real auth middleware is not mounted by default).
  app.use((req, _res, next) => {
    const granted = req.header('x-test-permissions');
    if (granted !== undefined) {
      req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'viewer', permissions: granted ? granted.split(',') : [] };
    }
    next();
  });
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  // The routes directly: `ctx.plugin({ inject: ['http'] })` would stay
  // PENDING if the service is not seen as injectable in this mini tree.
  registerRoutes(ctx.http.router());
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return {
    ctx,
    app,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      await ctx.fiber.dispose();
    },
  };
}

function collectChanged(): { events: Extract<BusEvent, { kind: 'plugins_changed' }>[]; stop: () => void } {
  const events: Extract<BusEvent, { kind: 'plugins_changed' }>[] = [];
  const on = (ev: BusEvent) => { if (ev.kind === 'plugins_changed') events.push(ev); };
  bus.on('event', on);
  return { events, stop: () => void bus.off('event', on) };
}

function makeLoader(
  d: Awaited<ReturnType<typeof daemon>>,
  dir: string,
  plugins: () => Record<string, ModuleSetting>,
): InstanceType<typeof PluginLoader> {
  const loader = new PluginLoader(d.ctx, {
    dir,
    host: daemonHost(d.ctx),
    plugins,
    // Fixtures are unsigned: without developer mode every plugin is refused
    // as `skipped:unsigned`, and these tests would measure the signature
    // gate instead of the routes.
    allowUnsigned: () => true,
    onChange: () => bus.publish({ kind: 'plugins_changed', plugins: publicPlugins(loader) }),
  });
  attachPluginLoader(d.app, loader);
  return loader;
}

/**
 * Daemon + plugin directory + loader, torn down unconditionally.
 *
 * A failing assertion must never leave the HTTP server or the loader behind:
 * an open handle keeps `node --test` alive after the last test, so the run
 * hangs and never prints its summary — the failure is then invisible.
 */
async function withDaemon(
  fixtures: (keyof typeof PKG)[],
  plugins: () => Record<string, ModuleSetting>,
  body: (env: {
    d: Awaited<ReturnType<typeof daemon>>;
    dir: string;
    loader: InstanceType<typeof PluginLoader>;
  }) => Promise<void>,
  authToken?: string,
): Promise<void> {
  const d = await daemon(authToken);
  const dir = mkdtempSync(join(tmpdir(), 'timon-plugins-'));
  install(dir, fixtures);
  const loader = makeLoader(d, dir, plugins);
  try {
    await body({ d, dir, loader });
  } finally {
    await loader.dispose();
    await d.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeStream(missionId: string): { chunks: string[]; close: () => void } {
  const chunks: string[] = [];
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: () => res,
    flushHeaders: () => {},
    write: (s: string) => { chunks.push(s); return true; },
  });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, { params: { id: missionId } });
  sseHandler(req, res);
  return { chunks, close: () => { (req as unknown as EventEmitter).emit('close'); } };
}

test('GET /api/plugins returns the real state: active, failed, skipped, disabled', async () => {
  const plugins: Record<string, ModuleSetting> = { 'fixture-ok': false };
  await withDaemon(['ok', 'throws-in-apply', 'api-version-future', 'forbidden-inject'], () => plugins, async ({ d, loader }) => {
    await loader.update();

    const list = await (await fetch(d.url('/api/plugins'))).json() as { plugins: PluginPublic[] };
    const byId = new Map(list.plugins.map((p) => [p.id, p]));

    const disabled = byId.get('fixture-ok');
    assert.equal(disabled?.state, 'disabled');
    assert.match(disabled?.reason ?? '', /disabled in timon\.config\.json/);
    assert.equal(disabled?.client, null, 'a disabled plugin is not served');

    const failed = byId.get('fixture-throws');
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.reason, 'failed');
    assert.match(failed?.error ?? '', /boum/);

    // apiVersion is refused BEFORE having a reliable manifest id: the
    // loader then indexes on the npm name. The `skipped:api-version` reason is
    // the contract; the message names both versions.
    const future = list.plugins.find((p) => p.reason === 'skipped:api-version');
    assert.ok(future, 'a plugin with a too-recent apiVersion must appear in the list');
    assert.match(future?.error ?? '', /apiVersion 99/);
    assert.match(future?.error ?? '', new RegExp(`contract ${PLUGIN_API_VERSION}`));

    const forbidden = byId.get('fixture-forbidden');
    assert.equal(forbidden?.reason, 'skipped:forbidden-inject');
    assert.match(forbidden?.error ?? '', /db/);

    const one = await fetch(d.url('/api/plugins/fixture-ok'));
    assert.equal(one.status, 200);
    assert.equal(((await one.json()) as PluginPublic).state, 'disabled');

    const missing = await fetch(d.url('/api/plugins/absent-plugin'));
    assert.equal(missing.status, 404);
  });
});

test('GET /plugins/<id>/client.js follows the loader: present on activation, 404 otherwise', async () => {
  let plugins: Record<string, ModuleSetting> = {};
  await withDaemon(['ok'], () => plugins, async ({ d, loader }) => {
    await loader.update();

    const listed = await (await fetch(d.url('/api/plugins/fixture-ok'))).json() as PluginPublic;
    assert.equal(listed.state, 'active');
    assert.ok(listed.client, 'the browser half must be announced');
    assert.ok(listed.client?.url.includes('rev='));
    assert.deepEqual(listed.client?.slots, ['nav.item']);
    assert.deepEqual(listed.client?.permissions, ['storage', 'notify'], 'the browser half gates transcript kinds on the manifest');

    const body = await fetch(d.url(listed.client!.url));
    assert.equal(body.status, 200);
    assert.match(await body.text(), /fixture-ok-client/);

    plugins = { 'fixture-ok': false };
    await loader.update();
    assert.equal((await fetch(d.url(listed.client!.url))).status, 404, 'disable retire le bundle');
    assert.equal((await fetch(d.url('/plugins/absent-plugin/client.js'))).status, 404);
  });
});

test('the gallery reads the manifest: kind, label, cover and slots survive unplugging', async () => {
  // The heart of the local gallery (§10.12): it lists the PRESENT plugins,
  // plugged AND unplugged. Everything the card shows must therefore come from the
  // manifest, never from the mount: `client` is `null` as soon as a plugin is
  // disabled, and that is precisely the plugin the toggle targets.
  let plugins: Record<string, ModuleSetting> = {};
  await withDaemon(['ok'], () => plugins, async ({ d, loader }) => {
    await loader.update();
    const active = await (await fetch(d.url('/api/plugins/fixture-ok'))).json() as PluginPublic;
    assert.deepEqual(active.kind, ['behavior']);
    assert.equal(active.label, 'Fixture OK');
    assert.match(active.description ?? '', /cover/);
    assert.deepEqual(active.slots, ['nav.item']);
    assert.ok(active.cover?.startsWith('/plugins/fixture-ok/cover?rev='), active.cover ?? 'cover absente');

    const image = await fetch(d.url(active.cover!));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');

    // The picto is plugin-supplied SVG served same-origin: a `<script>` in it
    // must stay inert, opened in a tab as much as painted as a mask.
    assert.ok(active.icon?.startsWith('/plugins/fixture-ok/icon?rev='), active.icon ?? 'icon absente');
    const icon = await fetch(d.url(active.icon!));
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
    assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
    assert.match(icon.headers.get('content-security-policy') ?? '', /default-src 'none'.*sandbox/);
    assert.equal((await fetch(d.url('/plugins/fixture-ok/icon?rev=deadbeef'))).status, 404);

    plugins = { 'fixture-ok': false };
    await loader.update();
    const off = await (await fetch(d.url('/api/plugins/fixture-ok'))).json() as PluginPublic;
    assert.equal(off.state, 'disabled');
    assert.equal(off.client, null, 'a disabled plugin is not mounted');
    assert.equal(off.cover, active.cover, 'its cover stays served: the gallery must draw its card');
    assert.equal(off.icon, active.icon, 'its icon too');
    assert.deepEqual(off.slots, ['nav.item'], 'where it would slot in stays readable');
    assert.equal((await fetch(d.url(off.cover!))).status, 200);

    // A stale revision is never served under another key: it would
    // stay stuck for a year in the browser's immutable cache.
    assert.equal((await fetch(d.url('/plugins/fixture-ok/cover?rev=deadbeef'))).status, 404);
    assert.equal((await fetch(d.url('/plugins/absent-plugin/cover'))).status, 404);
  });
});

test('POST /api/plugins/:id/enabled writes the wanted config, not the daemon state', async () => {
  await withDaemon(['ok'], () => ({}), async ({ d, loader }) => {
    await loader.update();

    const off = await fetch(d.url('/api/plugins/fixture-ok/enabled'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    const cfg = JSON.parse(readFileSync(join(process.env.TIMON_HOME!, 'timon.config.json'), 'utf8')) as {
      plugins?: Record<string, unknown>;
    };
    assert.equal(cfg.plugins?.['fixture-ok'], false, 'the toggle sets the WANTED state in timon.config.json');

    assert.equal((await fetch(d.url('/api/plugins/absent-plugin/enabled'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    })).status, 404);
    assert.equal((await fetch(d.url('/api/plugins/fixture-ok/enabled'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'oui' }),
    })).status, 400);
  });
});

test('plugins_changed is emitted on add, disable, enable, remove, and only then', async () => {
  let plugins: Record<string, ModuleSetting> = {};
  await withDaemon([], () => plugins, async ({ dir, loader }) => {
    const cap = collectChanged();
    try {
      await loader.update();
      cap.events.length = 0;

      // add
      install(dir, ['ok']);
      await loader.update();
      assert.equal(cap.events.length, 1, 'add must emit');
      assert.equal(cap.events[0]?.plugins[0]?.id, 'fixture-ok');
      assert.equal(cap.events[0]?.plugins[0]?.state, 'active');
      assert.ok(cap.events[0]?.plugins[0]?.client);

      // idempotent: no event
      await loader.update();
      assert.equal(cap.events.length, 1, 'without a change, no recomposition');

      // disable
      plugins = { 'fixture-ok': false };
      await loader.update();
      assert.equal(cap.events.length, 2, 'disable must emit');
      assert.equal(cap.events[1]?.plugins[0]?.state, 'disabled');
      assert.equal(cap.events[1]?.plugins[0]?.client, null);

      // enable
      plugins = {};
      await loader.update();
      assert.equal(cap.events.length, 3, 'enable must emit');
      assert.equal(cap.events[2]?.plugins[0]?.state, 'active');

      // remove
      install(dir, []);
      await loader.update();
      assert.equal(cap.events.length, 4, 'remove must emit');
      assert.deepEqual(cap.events[3]?.plugins, []);
    } finally {
      cap.stop();
    }
  });
});

test('the global SSE stream carries plugins_changed; the stream of a mission does not', () => {
  const globalStream = fakeStream('');
  const mission = fakeStream('mission-plugins-changed');
  try {
    bus.publish({ kind: 'plugins_changed', plugins: [] });
    const globalWire = globalStream.chunks.join('');
    assert.ok(globalWire.includes('event: plugins_changed\n'), 'absent du flux global');
    assert.ok(globalWire.includes('"kind":"plugins_changed"'));
    assert.ok(
      !mission.chunks.join('').includes('plugins_changed'),
      'le chat d\'une mission ne doit pas recevoir la recomposition des plugins',
    );
  } finally {
    globalStream.close();
    mission.close();
  }
});

test('settingStatus never returns a secret value, and a cleartext row is resealed on GET', async () => {
  await withDaemon(['ok'], () => ({}), async ({ d, loader }) => {
    await loader.update();
    const pluginId = 'fixture-ok';
    const kvKey = '@settings/apiToken';
    const plaintext = 'super-secret-token';
    dbApi.pluginKvSet(pluginId, kvKey, JSON.stringify(plaintext));

    const res = await fetch(d.url('/api/plugins/fixture-ok/settings'));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(plaintext), 'the plaintext leaked in the settings payload');
    const body = JSON.parse(text) as { settings: { key: string; type: string; value: unknown; configured: boolean }[] };
    const secret = body.settings.find((s) => s.key === 'apiToken');
    assert.ok(secret);
    assert.equal(secret.value, '');
    assert.equal(secret.configured, true);
    const stored = dbApi.pluginKvGet(pluginId, kvKey)!;
    assert.equal(isSealed(stored), true);
    assert.equal(JSON.parse(openPluginKvValue(pluginId, kvKey, stored)), plaintext);

    const greeting = body.settings.find((s) => s.key === 'greeting');
    assert.equal(greeting?.value, 'bonjour');
  });
});

test('PUT of a secret setting stores a sealed envelope and GET still returns empty', async () => {
  await withDaemon(['ok'], () => ({}), async ({ d, loader }) => {
    await loader.update();
    const put = await fetch(d.url('/api/plugins/fixture-ok/settings'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'apiToken', value: 'fresh-secret-token' }),
    });
    assert.equal(put.status, 200);
    const stored = dbApi.pluginKvGet('fixture-ok', '@settings/apiToken')!;
    assert.equal(isSealed(stored), true);
    assert.ok(!stored.includes('fresh-secret-token'));
    assert.equal(JSON.parse(openPluginKvValue('fixture-ok', '@settings/apiToken', stored)), 'fresh-secret-token');

    const get = await fetch(d.url('/api/plugins/fixture-ok/settings'));
    const text = await get.text();
    assert.ok(!text.includes('fresh-secret-token'));
    const body = JSON.parse(text) as { settings: { key: string; value: unknown; configured: boolean }[] };
    const secret = body.settings.find((s) => s.key === 'apiToken');
    assert.equal(secret?.value, '');
    assert.equal(secret?.configured, true);
  });
});

test('traversal on the bundle route wired to the loader: 404', async () => {
  await withDaemon(['ok'], () => ({}), async ({ d, loader }) => {
    await loader.update();

    const attempts = [
      '/plugins/../loader/client.js',
      '/plugins/%2e%2e/client.js',
      '/plugins/fixture-ok/../ok/lib/index.js',
    ];
    for (const path of attempts) {
      const res = await fetch(d.url(path));
      assert.equal(res.status, 404, `${path} → ${res.status}`);
      await res.arrayBuffer();
    }
  });
});

/**
 * What the gallery promises since the "bundled" part (§10.12): a product
 * install NEVER shows "no plugin", because the ~30 embedded
 * modules are plugins like the others. Before, `/api/plugins`
 * only read the third-party loader and an empty `~/.timon/plugins` returned `[]`.
 */
test('GET /api/plugins unites the bundled modules and the third-party packages', async () => {
  await withDaemon(['ok'], () => ({}), async ({ d, loader }) => {
    await loader.update();
    const { plugins } = await (await fetch(d.url('/api/plugins'))).json() as { plugins: PluginPublic[] };
    const byId = new Map(plugins.map((p) => [p.id, p]));

    for (const id of ['@timon/agent-chat', '@timon/dreams', '@timon/vault', '@timon/kanban']) {
      const row = byId.get(id);
      assert.equal(row?.source, 'bundled', `${id} must be listed as a product module`);
    }
    assert.deepEqual(byId.get('@timon/agent-chat')?.kind, ['widget']);
    assert.deepEqual(byId.get('@timon/kanban')?.kind, ['page', 'widget']);
    assert.deepEqual(byId.get('@timon/db')?.kind, ['behavior']);
    assert.equal(byId.get('@timon/agent-chat')?.author, 'Timon');
    assert.equal(byId.get('@timon/agent-chat')?.signed, null);
    assert.equal(byId.get('fixture-ok')?.signed, false, 'unsigned even if developer mode loads it');
    assert.equal(byId.get('@timon/agent-chat')?.signature, null);
    assert.equal(byId.get('fixture-ok')?.signature, null);
    // No catalogue module disappears, including those the licence or the
    // host capabilities refuse: a greyed card says why, a missing card
    // says nothing.
    assert.equal(plugins.filter((p) => p.source === 'bundled').length, CATALOG.length);
    assert.equal(byId.get('@timon/db')?.tier, 'core');
    assert.equal(byId.get('fixture-ok')?.source, 'third-party');
    assert.equal(byId.get('fixture-ok')?.tier, null);
    assert.equal(new Set(plugins.map((p) => p.id)).size, plugins.length, 'an id appears only once');

    // The id carries a `/`: it only crosses the URL encoded, otherwise Express sees
    // two segments and the route no longer matches.
    const one = await fetch(d.url(`/api/plugins/${encodeURIComponent('@timon/vault')}`));
    assert.equal(one.status, 200);
    assert.equal(((await one.json()) as PluginPublic).source, 'bundled');
  });
});

test('a third-party package cannot hide a bundled module by claiming its id', () => {
  const shadow = {
    list: () => [{ id: '@timon/db', pkg: '@evil/core-db', version: '9.9.9', state: 'active' as const, reason: null, error: null, manifest: null, signed: false }],
    bundles: { get: () => null },
    covers: { get: () => null },
  };
  const plugins = galleryPlugins(shadow as unknown as InstanceType<typeof PluginLoader>);
  const coreDb = plugins.filter((p) => p.id === '@timon/db');
  assert.equal(coreDb.length, 1);
  assert.equal(coreDb[0]?.source, 'bundled');
});

/**
 * The original bug: toggling `vault` answered 404, because the loader only
 * knows `~/.timon/plugins`. A bundled module is set in
 * `modules[<id>]`, as the lite preset does.
 */
test('POST /api/plugins/:id/enabled writes modules[] for a bundled module, and refuses the kernel', async () => {
  await withDaemon([], () => ({}), async ({ d }) => {
    const off = await fetch(d.url(`/api/plugins/${encodeURIComponent('@timon/vault')}/enabled`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    const written = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { modules: Record<string, unknown>; plugins?: Record<string, unknown> };
    assert.equal(written.modules['@timon/vault'], false, 'a bundled module is disabled in modules[], not in plugins[]');
    assert.equal(written.plugins?.['@timon/vault'], undefined);

    // `wanted` follows the write at once; `state` does not, on purpose:
    // a bundled module is mounted at boot, it only switches sides at the next one.
    const { plugins } = await (await fetch(d.url('/api/plugins'))).json() as { plugins: PluginPublic[] };
    assert.equal(plugins.find((p) => p.id === '@timon/vault')?.wanted, false);

    const core = await fetch(d.url(`/api/plugins/${encodeURIComponent('@timon/db')}/enabled`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(core.status, 403, 'turning the kernel off from the gallery would brick the daemon');
    const after = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { modules: Record<string, unknown> };
    assert.equal(after.modules['@timon/db'], undefined);
  });
});

/**
 * "End of the core tier" (30/08) namespaces the ids of our modules: `@timon/…`
 * holds a `/`, and the gallery toggle makes them cross a single-segment Express
 * `:id`. This test locks the full round trip (encoding on the caller
 * side, decoding on the route side, writing under the exact id) and the
 * expected consequence: the module is no longer part of the kernel, so it turns off.
 */
test('a module with a namespaced name (`@timon/projects`) toggles and really turns off', async () => {
  await withDaemon([], () => ({}), async ({ d }) => {
    const id = '@timon/projects';
    const off = await fetch(d.url(`/api/plugins/${encodeURIComponent(id)}/enabled`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200, 'the `/` of the id must not break the routing');
    assert.deepEqual(await off.json(), { ok: true, id, enabled: false });

    const written = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { modules: Record<string, unknown> };
    assert.equal(written.modules[id], false, 'the config key is the namespaced id, as is');

    const { planEntries } = await import('../kernel/registry.js');
    const { loadConfig } = await import('../config/load.js');
    const decision = planEntries(CATALOG, { config: loadConfig(CONFIG_FILE), capabilities: [] })
      .find((e) => e.id === id);
    assert.equal(decision?.tier, 'std');
    assert.equal(decision?.disabled, true, 'outside the kernel, the config has the last word');
  });
});

test('the platform segment `-/usage` serves the quotas only to the plugin that declared them', async () => {
  await withDaemon(['ok', 'usage-reader'], () => ({}), async ({ d, loader }) => {
    await loader.update();

    // A plugin that declares `usage:read` reads the aggregated view, without having a
    // host half: that is what makes a quota widget writable by a third party.
    const granted = await fetch(d.url('/api/plugins/fixture-usage/-/usage'));
    assert.equal(granted.status, 200);
    const body = await granted.json() as { entries: { backend: string; available: boolean; usage: unknown }[] };
    assert.ok(Array.isArray(body.entries) && body.entries.length > 0, 'at least one active backend');
    for (const entry of body.entries) {
      assert.equal(typeof entry.backend, 'string');
      // Nothing used to obtain the measure goes out: no token, no path.
      const keys = Object.keys(entry);
      for (const leaked of ['token', 'auth', 'path', 'file', 'home', 'env']) {
        assert.ok(!keys.includes(leaked), `\`${leaked}\` must never go out`);
      }
    }

    // Declaring the permission is the condition: the neighbour plugin is refused.
    assert.equal((await fetch(d.url('/api/plugins/fixture-ok/-/usage'))).status, 403);
    // An unknown plugin does not confirm its absence with a 403 (curtain M.4).
    assert.equal((await fetch(d.url('/api/plugins/absent-plugin/-/usage'))).status, 404);

    // The ↻ (`?refresh=1`, TODO #632) opens neither lock: both are checked before any probe.
    const refreshed = await fetch(d.url('/api/plugins/fixture-usage/-/usage?refresh=1'));
    assert.equal(refreshed.status, 200);
    assert.deepEqual(
      ((await refreshed.json()) as { entries: { backend: string }[] }).entries.map((entry) => entry.backend),
      body.entries.map((entry) => entry.backend),
    );
    assert.equal((await fetch(d.url('/api/plugins/fixture-ok/-/usage?refresh=1'))).status, 403);
    assert.equal((await fetch(d.url('/api/plugins/absent-plugin/-/usage?refresh=1'))).status, 404);
  });
});

test('`-/dictation-models` serves an active dictation plugin\'s own pack, and nothing to anyone else', async () => {
  const plugins: Record<string, ModuleSetting> = {};
  await withDaemon(['ok', 'dictation-pack'], () => plugins, async ({ d, loader }) => {
    await loader.update();

    const served = await fetch(d.url('/api/plugins/fixture-dictation/-/dictation-models'));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('cache-control'), 'no-store');
    // The id is the route's, attested by the loader: the file says nothing of it.
    assert.deepEqual(await served.json(), {
      pluginId: 'fixture-dictation',
      version: '1.2.0',
      models: [{ id: 'fixture-dictation.tiny', label: 'Fixture tiny model' }],
    });

    // Refusals first: a viewer the plugin is hidden from does not learn it exists.
    const hidden = await fetch(d.url('/api/plugins/fixture-dictation/-/dictation-models'), { headers: { 'x-test-permissions': 'plugin:fixture-ok' } });
    assert.equal(hidden.status, 404);
    const shown = await fetch(d.url('/api/plugins/fixture-dictation/-/dictation-models'), { headers: { 'x-test-permissions': 'plugin:fixture-dictation' } });
    assert.equal(shown.status, 200);
    // A plugin without a pack, an unknown id: 404.
    assert.equal((await fetch(d.url('/api/plugins/fixture-ok/-/dictation-models'))).status, 404);
    assert.equal((await fetch(d.url('/api/plugins/absent-plugin/-/dictation-models'))).status, 404);

    // Disabled, it proposes nothing any more.
    plugins['fixture-dictation'] = false;
    await loader.update();
    assert.equal((await fetch(d.url('/api/plugins/fixture-dictation/-/dictation-models'))).status, 404);
  });
});

test('`-/dictation-models` stops an anonymous caller at the daemon\'s auth, whether the plugin exists or not', async () => {
  const token = 'dictation-pack-test-daemon-token';
  await withDaemon(['dictation-pack'], () => ({}), async ({ d, loader }) => {
    await loader.update();
    const pack = d.url('/api/plugins/fixture-dictation/-/dictation-models');

    const anonymous = await fetch(pack);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: 'unauthorized' }, 'nothing of the pack, nothing of the plugin');
    assert.equal((await fetch(d.url('/api/plugins/absent-plugin/-/dictation-models'))).status, 401, 'same answer for an unknown id');
    assert.equal((await fetch(pack, { headers: { authorization: 'Bearer not-the-token' } })).status, 401);
    assert.equal((await fetch(pack, { headers: { cookie: 'timon_session=not-a-session' } })).status, 401);

    assert.equal((await fetch(pack, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  }, token);
});
