/**
 * The `PluginContext` contract: what these tests protect.
 *
 * They are written from the point of view of a THIRD-PARTY plugin, not of the
 * daemon: what matters is not that a facade works, it is that what is not in the
 * contract stays out of reach. Hence three families:
 *
 *  - the surface itself (what a plugin receives, and what it NEVER
 *    receives: `dbApi`, `bus.publish`, `process.env`, §6 amended by §10.10);
 *  - the permissions: a facade called without its permission throws, it does
 *    not return an empty result, otherwise an unauthorised plugin would think the
 *    Kanban was simply empty;
 *  - the partitioning of `plugin_kv`: two plugins writing the same key
 *    do not see each other.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const {
  createPluginContext, daemonHost, isolateForPlugin, signToken, verifyToken,
  PluginPermissionError, PLUGIN_EVENT_KINDS, PLUGIN_ROUTE_PREFIX,
} = await import('./context.js');
const { dbApi } = await import('../db.js');
const { bus } = await import('../bus.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { PluginPolicyError, resetPluginPolicyState } = await import('./policy.js');

/**
 * secu-5 — spawn, exec and outbound HTTP are refused by default even to a
 * plugin that declared them. A test that exercises those façades therefore
 * states the policy it runs under, exactly as an operator would.
 */
function withPolicy(pluginPolicy: Record<string, unknown>): void {
  setConfig(TimonConfigSchema.parse({ pluginPolicy }));
  resetPluginPolicyState();
}

test.after(() => { resetConfig(); resetPluginPolicyState(); });

type PluginHost = ReturnType<typeof daemonHost>;

/** A valid manifest, built by the real reader of P.1: the tests must
 *  not be able to make a manifest the loader would refuse. */
function manifestOf(id: string, permissions: string[], extra: Record<string, unknown> = {}) {
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions, ...extra } });
  assert.equal(res.ok, true, `invalid test manifest for ${id}`);
  if (!res.ok) throw new Error('unreachable');
  return res.manifest;
}

/** Fake host: no facade touches the real machine, except where the test
 *  asks for it explicitly (kv on the real database). */
function fakeHost(overrides: Partial<PluginHost> = {}): PluginHost {
  const store = new Map<string, string>();
  return {
    mountRouter: () => () => { /* nothing mounted */ },
    kv: {
      get: (p, k) => store.get(`${p} ${k}`),
      set: (p, k, v) => void store.set(`${p} ${k}`, v),
      del: (p, k) => void store.delete(`${p} ${k}`),
      list: (p, prefix) => [...store.entries()]
        .filter(([k]) => k.startsWith(`${p} ${prefix}`))
        .map(([k, value]) => ({ key: k.slice(p.length + 1), value })),
    },
    missions: {
      spawn: async () => 'mission-1',
      get: () => undefined,
      list: () => [],
    },
    kanban: { create: () => ({}), update: () => ({}), list: () => [] },
    notify: () => { /* silencieux */ },
    subscribe: () => () => { /* nothing */ },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: (async () => new Response('ok')) as unknown as typeof globalThis.fetch,
    dataDir: (id) => `/tmp/timon-test-plugins/${id}`,
    tokenKey: () => Buffer.alloc(32, 7),
    secrets: { get: () => undefined },
    usage: {
      list: async () => [],
      get: async () => null,
      registerCollector: () => () => { /* nothing registered */ },
    },
    backends: {
      registerProfile: () => () => { /* nothing registered */ },
      registerDialect: () => () => { /* nothing registered */ },
    },
    ...overrides,
  };
}

/** Cordis context carrying a plugin's fiber, the way the loader does it (P.3). */
async function pluginFiber(root: Context) {
  let inner!: Context;
  const fiber = await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  return { ctx: inner, dispose: () => fiber.dispose() };
}

test('a plugin receives its facade, and nothing of the daemon', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('demo-plugin', ['storage', 'kanban:read']),
    version: '1.0.0',
  }, fakeHost());

  assert.equal(plugin.id, 'demo-plugin');
  assert.equal(plugin.version, '1.0.0');
  assert.equal(typeof plugin.router, 'function');
  assert.equal(typeof plugin.effect, 'function');

  // The hard ban of the plan: these names must appear NOWHERE in the
  // surface; they are how a plugin would reach the database or the bus.
  const surface = new Set(Object.keys(plugin));
  for (const forbidden of ['db', 'dbApi', 'bus', 'env', 'process', 'loader', 'dispatcher']) {
    assert.equal(surface.has(forbidden), false, `${forbidden} must not be exposed`);
  }
  assert.equal('publish' in plugin.events, false, 'the bus is read-only: no publish');
  assert.deepEqual(plugin.config, {}, 'the plugin config is its own, not process.env');
  await root.fiber.dispose();
});

test('a facade called without its permission throws, it does not return an empty result', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('no-perm', []),
    version: '1.0.0',
  }, fakeHost());

  await assert.rejects(() => plugin.storage.kv.get('x'), PluginPermissionError);
  await assert.rejects(() => plugin.kanban.list(), PluginPermissionError);
  await assert.rejects(() => plugin.missions.spawn({ agent: 'a', mission: 'm' }), PluginPermissionError);
  await assert.rejects(() => plugin.host.exec('ls'), PluginPermissionError);
  await assert.rejects(() => plugin.secrets.get('ANY_TOKEN'), PluginPermissionError);
  await assert.rejects(() => plugin.usage.list(), PluginPermissionError);
  assert.throws(() => plugin.backends.registerProfile({
    id: 'x', dialect: 'codex', label: 'x', defaultModel: null, models: [],
  }), PluginPermissionError);
  await assert.rejects(() => plugin.usage.get('claude'), PluginPermissionError);
  assert.throws(() => plugin.usage.registerCollector('acme', async () => null), PluginPermissionError);
  assert.throws(() => plugin.notify.report('t'), PluginPermissionError);
  assert.throws(() => plugin.events.on('task_done', () => { /* never called */ }), PluginPermissionError);
  assert.throws(() => plugin.storage.dir, PluginPermissionError);
  assert.throws(() => plugin.assertPermission('users:read'), PluginPermissionError);
  assert.equal(plugin.user(), undefined, 'outside a request, no caller');

  // `fetch` is ABSENT without `http:outbound` (§10.4): its absence IS the refusal.
  assert.equal(plugin.fetch, undefined);
  await root.fiber.dispose();
});

test('ctx.secrets returns the value with secrets:read, and the scope stays with the daemon', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const asked: { plugin: string; name: string }[] = [];
  const host = fakeHost({
    secrets: {
      get: (pluginId, name) => {
        asked.push({ plugin: pluginId, name });
        return name === 'ACME_TOKEN' ? 'v-acme' : undefined;
      },
    },
  });
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('acme-plugin', ['secrets:read']),
    version: '1.0.0',
  }, host);

  assert.equal(await plugin.secrets.get('ACME_TOKEN'), 'v-acme');
  assert.equal(await plugin.secrets.get('AUTRE_TOKEN'), undefined);
  // The plugin id is imposed by the facade: a plugin cannot ask for another
  // one's scope, it has no argument to say so.
  assert.deepEqual(asked, [
    { plugin: 'acme-plugin', name: 'ACME_TOKEN' },
    { plugin: 'acme-plugin', name: 'AUTRE_TOKEN' },
  ]);
  await root.fiber.dispose();
});

test('fetch only appears with http:outbound', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('net-plugin', ['http:outbound']),
    version: '1.0.0',
  }, fakeHost());
  assert.equal(typeof plugin.fetch, 'function');
  await root.fiber.dispose();
});

test('a plugin never sees the keys of another one in plugin_kv', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const host = daemonHost(root);
  const a = createPluginContext(ctx, { manifest: manifestOf('plugin-aaa', ['storage']), version: '1.0.0' }, host);
  const b = createPluginContext(ctx, { manifest: manifestOf('plugin-bbb', ['storage']), version: '1.0.0' }, host);

  await a.storage.kv.set('secret', { token: 'de-a' });
  await b.storage.kv.set('secret', { token: 'de-b' });

  assert.deepEqual(await a.storage.kv.get('secret'), { token: 'de-a' });
  assert.deepEqual(await b.storage.kv.get('secret'), { token: 'de-b' });
  assert.deepEqual(await a.storage.kv.list(), [{ key: 'secret', value: { token: 'de-a' } }]);

  await a.storage.kv.del('secret');
  assert.equal(await a.storage.kv.get('secret'), undefined);
  assert.deepEqual(await b.storage.kv.get('secret'), { token: 'de-b' }, 'the neighbour key must survive');

  // And the table itself: nothing but what this plugin wrote.
  assert.equal(dbApi.pluginKvList('plugin-bbb').length, 1);
  dbApi.pluginKvClear('plugin-bbb');
  assert.equal(dbApi.pluginKvList('plugin-bbb').length, 0);
  await root.fiber.dispose();
});

test('the manifest settings cannot be rewritten through free storage', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const host = fakeHost();
  const manifest = manifestOf('settings-plugin', ['storage', 'settings'], {
    settings: [{ key: 'apiUrl', type: 'string', label: 'URL', default: 'https://exemple.test' }],
  });
  const plugin = createPluginContext(ctx, { manifest, version: '1.0.0' }, host);

  assert.equal(plugin.settings.get('apiUrl'), 'https://exemple.test');
  // A value set by the user from /settings (P.7 will write through this path).
  host.kv.set('settings-plugin', '@settings/apiUrl', JSON.stringify('https://reel.test'));
  assert.equal(plugin.settings.get('apiUrl'), 'https://reel.test');

  // An undeclared setting is the plugin's fault, not a missing value.
  assert.throws(() => plugin.settings.get('inconnu'), /not declared/);
  // And free storage cannot encroach on the settings space.
  await assert.rejects(() => plugin.storage.kv.set('@settings/apiUrl', 'pirate'), /reserved/);
  assert.deepEqual(await plugin.storage.kv.list(), [], 'the settings do not leak into the kv');
  await root.fiber.dispose();
});

test('settings.get reseals a plaintext secret and returns the value', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const host = fakeHost();
  const manifest = manifestOf('settings-plugin', ['settings'], {
    settings: [{ key: 'apiToken', type: 'secret', label: 'Token' }],
  });
  host.kv.set('settings-plugin', '@settings/apiToken', JSON.stringify('plain-secret-12'));
  const plugin = createPluginContext(ctx, { manifest, version: '1.0.0' }, host);

  assert.equal(plugin.settings.get('apiToken'), 'plain-secret-12');
  const stored = host.kv.get('settings-plugin', '@settings/apiToken')!;
  assert.ok(stored.startsWith('enc:1:'));
  assert.ok(!stored.includes('plain-secret-12'));
  assert.equal(plugin.settings.get('apiToken'), 'plain-secret-12');
  await root.fiber.dispose();
});

test('a mission spawned by a plugin always carries its channel', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const seen: { agent: string; channel: string }[] = [];
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('spawner', ['missions:spawn']),
    version: '1.0.0',
  }, fakeHost({
    missions: {
      spawn: async (input) => { seen.push({ agent: input.agent, channel: input.channel }); return 'm-1'; },
      get: () => undefined,
      list: () => [],
    },
  }));

  withPolicy({ spawn: { approved: ['spawner'] } });
  // The plugin TRIES to pass itself off as the human chat: the channel imposed
  // by the facade must win, otherwise traceability is worth nothing.
  await plugin.missions.spawn({ agent: 'demo', mission: 'test', meta: { channel: 'chat' } });
  assert.deepEqual(seen, [{ agent: 'demo', channel: 'plugin:spawner' }]);
  await root.fiber.dispose();
});

test('events are filtered, and unsubscribing follows the fiber', async () => {
  const root = new Context();
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('listener', ['events:subscribe']),
    version: '1.0.0',
  }, daemonHost(root));

  // Transcripts (`event`, `event_delta`) are not generic kinds:
  // without `missions:transcript` (API 10), asking for them is a named error,
  // not a silently dead subscription. An unknown kind stays "not exposed".
  assert.equal(PLUGIN_EVENT_KINDS.includes('task_done'), true);
  assert.throws(() => plugin.events.on('event' as never, () => { /* never */ }), PluginPermissionError);
  assert.throws(() => plugin.events.on('nope' as never, () => { /* never */ }), /not exposed/);

  const seen: string[] = [];
  plugin.events.on('task_done', (ev) => void seen.push((ev as { taskId: string }).taskId));
  bus.publish({ kind: 'task_done', taskId: 't1' });
  bus.publish({ kind: 'notifications_changed' });
  assert.deepEqual(seen, ['t1'], 'only the requested kind arrives');

  await dispose();
  bus.publish({ kind: 'task_done', taskId: 't2' });
  assert.deepEqual(seen, ['t1'], 'the unloaded plugin must receive nothing more');
  await root.fiber.dispose();
});

test('the routes of a plugin live under /api/plugins/<id> and fall with it', async () => {
  const app = express();
  const root = new Context();
  await root.plugin(createHttpPlugin(app));
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('routed', []),
    version: '1.0.0',
  }, daemonHost(root));

  plugin.router().get('/ping', (_req, res) => void res.json({ ok: true }));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}${PLUGIN_ROUTE_PREFIX}/routed/ping`;

  assert.equal((await fetch(url)).status, 200);
  await dispose();
  assert.equal((await fetch(url)).status, 404, 'the route must fall with the plugin');
  server.close();
  await root.fiber.dispose();
});

/**
 * T.5 — `layout:<short>` paints the chrome, it does not open an API.
 *
 * A `kind: layout` third-party package may also carry a host half (`behavior`)
 * with its own `ctx.router`. Wearing someone's chrome must not hand over their
 * routes: the asset curtain (`thirdPartyAssetVisible`, bundles/covers) accepts
 * `layout:<short>`, this one only ever accepts `plugin:<id>`.
 */
test('the layout surface does not open the plugin API, only plugin:<id> does', async () => {
  const app = express();
  let permissions: string[] = [];
  // A non-superadmin viewer carrying exactly these grants (`users/identity.ts`:
  // `api-token` with an explicit list needs neither session nor users table).
  app.use((req, _res, next) => {
    (req as unknown as { auth: unknown }).auth = {
      kind: 'api-token', actorId: 'ada', isSuperadmin: false, permissions,
    };
    next();
  });
  const root = new Context();
  await root.plugin(createHttpPlugin(app));
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('hybrid-behavior', [], {
      kind: ['layout', 'behavior'],
      client: { slots: ['root'] },
    }),
    version: '1.0.0',
  }, daemonHost(root));
  plugin.router().get('/ping', (_req, res) => void res.json({ ok: true }));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}${PLUGIN_ROUTE_PREFIX}/hybrid-behavior/ping`;

  permissions = ['layout:hybrid-behavior'];
  assert.equal((await fetch(url)).status, 404, 'the chrome does not give the API');
  permissions = ['widget:hybrid-behavior'];
  assert.equal((await fetch(url)).status, 404, 'nor another surface');
  permissions = ['plugin:hybrid-behavior'];
  assert.equal((await fetch(url)).status, 200, 'plugin:<id> ouvre le paquet');

  await dispose();
  server.close();
  await root.fiber.dispose();
});

test('the isolated context resolves no internal service', async () => {
  const root = new Context();
  await root.plugin({ name: 'core-db-ish', apply(ctx: Context) { ctx.provide('db', dbApi); } });
  assert.notEqual(root.get('db'), undefined, 'the daemon, for its part, sees its database');

  const isolated = isolateForPlugin(root);
  assert.equal(isolated.get('db'), undefined, 'a plugin must not reach db');

  // Even through the back door: a plugin declaring `inject: ['db']`
  // would stay PENDING rather than receive the database.
  let applied = false;
  await isolated.plugin({ name: 'sournois', inject: ['db'], apply() { applied = true; } });
  assert.equal(applied, false, 'inject: [db] must never activate a plugin under the isolate');
  await root.fiber.dispose();
});

test('a UI token is signed, dated and bound to its plugin', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const host = fakeHost();
  const plugin = createPluginContext(ctx, { manifest: manifestOf('ui-plugin', []), version: '1.0.0' }, host);

  const claims = verifyToken(plugin.ui.token(), host.tokenKey());
  assert.equal(claims?.aud, 'plugin:ui-plugin');
  assert.ok(typeof claims?.exp === 'number' && claims.exp * 1000 > Date.now());
  assert.ok((claims.exp as number) - (claims.iat as number) <= 600, 'short token: 10 min at most');

  // Signed by another key, expired, or malformed: refused without throwing.
  assert.equal(verifyToken(plugin.ui.token(), Buffer.alloc(32, 9)), null);
  assert.equal(verifyToken(signToken({ exp: 1 }, host.tokenKey()), host.tokenKey()), null);
  assert.equal(verifyToken('pas-un-jeton', host.tokenKey()), null);
  await root.fiber.dispose();
});

test('a plugin Kanban applies the same guards as POST /api/tasks', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('kanban-plugin', ['kanban:write', 'kanban:read']),
    version: '1.0.0',
  }, daemonHost(root));
  // A job's task that runs is a spawn (TODO #562): the operator approved this one.
  withPolicy({ spawn: { approved: ['kanban-plugin'] } });

  // A `scheduled_at` as an ISO string was stored as is then compared
  // numerically: the task never started, without the slightest error.
  await assert.rejects(
    () => plugin.kanban.add({ title: 't', agent: 'a', scheduledAt: '2026-01-01' as unknown as number }),
    /scheduled_at/i,
  );
  await assert.rejects(() => plugin.kanban.add({ title: 't', agent: 'a', type: 'invente' }), /invalid task type/);
  await assert.rejects(() => plugin.kanban.add({ title: '', agent: 'a' }), /are required/);

  const created = await plugin.kanban.add({ title: 'depuis un plugin', agent: 'demo-agent' }) as { id: string };
  assert.ok(created.id);
  const listed = await plugin.kanban.list({ status: 'PENDING' }) as { id: string }[];
  assert.ok(listed.some((t) => t.id === created.id));
  const several = await plugin.kanban.list({ status: ['BLOCKED', 'PENDING'] }) as { id: string }[];
  assert.ok(several.some((t) => t.id === created.id), 'a list of statuses reaches the facade');
  await assert.rejects(() => plugin.kanban.list({ status: [] }), /at least one/);
  await root.fiber.dispose();
});

test('a plugin notification carries its provenance', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const seen: { title: string; source: string }[] = [];
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('notifier', ['notify']),
    version: '1.0.0',
  }, fakeHost({ notify: (input) => void seen.push({ title: input.title, source: input.source }) }));

  plugin.notify.report('fini');
  plugin.notify.alert('casse');
  assert.deepEqual(seen, [
    { title: 'fini', source: 'plugin:notifier' },
    { title: 'casse', source: 'plugin:notifier' },
  ]);
  await root.fiber.dispose();
});

/* ── Effects ────────────────────────────────────────────────────────────
   §10.4 promises an effect "identical to the kernel". These tests take it at its word:
   they exercise the shapes Cordis accepts (disposer, promise, iterable,
   async disposer) THROUGH the facade, and check that unloading WAITS for
   what must be waited for. Without that, a plugin closing a socket or a process
   would think it had done so while the daemon had already moved on. */

test('an async disposer is awaited on unload', async () => {
  const root = new Context();
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('async-effect', []),
    version: '1.0.0',
  }, fakeHost());

  const trace: string[] = [];
  plugin.effect(() => async () => {
    // The resource does not close in the current tick: that is the whole point.
    await new Promise((resolve) => setTimeout(resolve, 20));
    trace.push('ferme');
  });

  assert.deepEqual(trace, [], 'the effect frees nothing while the plugin lives');
  await dispose();
  assert.deepEqual(trace, ['ferme'], 'unloading must HAVE WAITED for the async disposer');
  await root.fiber.dispose();
});

test('an asynchronous effect body returns its disposer', async () => {
  const root = new Context();
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('promise-effect', []),
    version: '1.0.0',
  }, fakeHost());

  const trace: string[] = [];
  // Async body: the plugin opens its resource before knowing how to close it.
  const handle = plugin.effect(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    trace.push('ouvert');
    return async () => { trace.push('ferme'); };
  });

  // The handle is awaitable: it delivers the disposer once the body is set up.
  await handle;
  assert.deepEqual(trace, ['ouvert']);
  await dispose();
  assert.deepEqual(trace, ['ouvert', 'ferme']);
  await root.fiber.dispose();
});

test('an iterable effect registers each disposer, torn down in reverse order', async () => {
  const root = new Context();
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('iter-effect', []),
    version: '1.0.0',
  }, fakeHost());

  const trace: string[] = [];
  plugin.effect(function* () {
    yield () => void trace.push('un');
    yield async () => { trace.push('deux'); };
  });

  await dispose();
  assert.deepEqual(trace, ['deux', 'un'], 'reverse order of registration');
  await root.fiber.dispose();
});

test('the handle returned by effect tears the effect down and settles when done', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('handle-effect', []),
    version: '1.0.0',
  }, fakeHost());

  const trace: string[] = [];
  const handle = plugin.effect(() => async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    trace.push('ferme');
  });

  await handle();
  assert.deepEqual(trace, ['ferme'], 'le handle attend le disposer async');
  await handle();
  assert.deepEqual(trace, ['ferme'], 'calling twice does not free twice');
  await root.fiber.dispose();
});

test('an effect that returns nothing stays legitimate', async () => {
  const root = new Context();
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('void-effect', []),
    version: '1.0.0',
  }, fakeHost());

  let couru = false;
  plugin.effect(() => { couru = true; });
  assert.equal(couru, true);
  await dispose();
  await root.fiber.dispose();
});

/* ── secu-5: the policy applies INSIDE the facade ─────────────────────── */

test('spawn: an unapproved plugin is refused, then rate-limited once approved', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('looper', ['missions:spawn']),
    version: '1.0.0',
  }, fakeHost());

  withPolicy({ spawn: { approved: [] } });
  await assert.rejects(() => plugin.missions.spawn({ agent: 'a', mission: 'm' }), PluginPolicyError);

  withPolicy({ spawn: { approved: ['looper'], max: 1, windowMs: 60_000 } });
  assert.equal(await plugin.missions.spawn({ agent: 'a', mission: 'm' }), 'mission-1');
  await assert.rejects(() => plugin.missions.spawn({ agent: 'a', mission: 'm' }), PluginPolicyError);
  await root.fiber.dispose();
});

test('host:exec: outside the allowlist refused, and never the subscriptions', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const ran: string[] = [];
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('runner', ['host:exec']),
    version: '1.0.0',
  }, fakeHost({
    exec: async (bin) => { ran.push(bin); return { code: 0, stdout: '', stderr: '' }; },
  }));

  withPolicy({ exec: { allow: ['ls'] } });
  await plugin.host.exec('ls', ['-l']);
  await assert.rejects(() => plugin.host.exec('curl'), PluginPolicyError);
  await assert.rejects(() => plugin.host.exec('claude', ['-p', 'x']), PluginPolicyError);
  // Nothing but what is allowed ever reached the host.
  assert.deepEqual(ran, ['ls']);
  await root.fiber.dispose();
});

test('http:outbound: only allowlisted hosts go out', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const seen: string[] = [];
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('caller', ['http:outbound']),
    version: '1.0.0',
  }, fakeHost({
    fetch: (async (input: string) => { seen.push(String(input)); return new Response('ok'); }) as unknown as typeof globalThis.fetch,
  }));

  withPolicy({ http: { allow: ['api.example.com'] } });
  await plugin.fetch!('https://api.example.com/v1');
  await assert.rejects(() => plugin.fetch!('https://exfil.tld/leak'), PluginPolicyError);
  assert.deepEqual(seen, ['https://api.example.com/v1']);
  await root.fiber.dispose();
});

test('usage:read returns the quotas, usage:collect stays a separate permission', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const entry = {
    backend: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic',
    available: true, usage: { windows: {}, extra: null },
  };
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('reader', ['usage:read']),
    version: '1.0.0',
  }, fakeHost({
    usage: {
      list: async () => [entry],
      get: async (backend) => (backend === 'claude' ? entry : null),
      registerCollector: () => () => { /* never reached */ },
    },
  }));

  assert.deepEqual(await plugin.usage.list(), [entry]);
  assert.equal(await plugin.usage.get('inconnu'), null);
  // Reading is not providing: a plugin that only declares `usage:read` cannot
  // stand in for the product's probe.
  assert.throws(() => plugin.usage.registerCollector('claude', async () => null), PluginPermissionError);
  await root.fiber.dispose();
});

test('a usage probe provided by a plugin is removed when it unloads', async () => {
  const root = new Context();
  const { ctx, dispose } = await pluginFiber(root);
  const registered: string[] = [];
  let removed = 0;
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('collector', ['usage:collect']),
    version: '1.0.0',
  }, fakeHost({
    usage: {
      list: async () => [],
      get: async () => null,
      registerCollector: (pluginId, backend) => {
        registered.push(`${pluginId}:${backend}`);
        return () => { removed += 1; };
      },
    },
  }));

  plugin.usage.registerCollector('acme-llm', async () => ({ windows: {}, extra: null }));
  assert.deepEqual(registered, ['collector:acme-llm']);
  await dispose();
  assert.equal(removed, 1, 'unloading the plugin removes its probe');
  await root.fiber.dispose();
});

test('backends:register: the daemon keeps the spawn, the allowlist and the removal', async () => {
  const root = new Context();
  const { ctx, dispose } = await pluginFiber(root);
  const calls: string[] = [];
  let removed = 0;
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf('provider', ['backends:register']),
    version: '1.0.0',
  }, fakeHost({
    backends: {
      registerProfile: (pluginId, profile) => {
        calls.push(`profile:${pluginId}:${profile.id}`);
        return () => { removed += 1; };
      },
      registerDialect: (pluginId, dialectId) => {
        calls.push(`dialect:${pluginId}:${dialectId}`);
        return () => { removed += 1; };
      },
    },
  }));

  // A profile set on a product dialect does NOT bring its binary:
  // it is the one the daemon already launches for its own profiles.
  withPolicy({ exec: { allow: [] } });
  plugin.backends.registerProfile({
    id: 'acme-llm', dialect: 'codex', label: 'ACME', defaultModel: 'acme-1',
    models: [{ slug: 'acme-1', label: 'acme-1' }], env: {},
  });

  // A binary the PLUGIN chooses goes, for its part, through the operator's allowlist.
  assert.throws(() => plugin.backends.registerProfile({
    id: 'acme-cli', dialect: 'codex', label: 'ACME CLI', cmd: 'acme',
    defaultModel: 'acme-1', models: [], env: {},
  }), PluginPolicyError);

  withPolicy({ exec: { allow: ['acme'] } });
  plugin.backends.registerDialect('acme-proto', {
    defaultCmd: 'acme',
    persistentProcess: false, finishMissionOnExit: false, sessionResumable: true,
    sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none',
    hostedConnectors: false,
    buildSpawn: async () => ({ cmd: 'acme', args: [], env: {}, cwd: '/tmp', initialStdin: null }),
    writeUserInput: () => { /* one-shot */ },
    parseLine: () => [],
    extractSessionId: () => null,
  });

  assert.deepEqual(calls, ['profile:provider:acme-llm', 'dialect:provider:acme-proto']);
  await dispose();
  assert.equal(removed, 2, 'unloading removes profile and dialect');
  await root.fiber.dispose();
});

test('backends:register — a remote dialect spawns nothing, so it needs no exec allowlist (API 7)', async () => {
  const { registerDialect, getDialect } = await import('../backends/registry.js');
  const remote: import('../backends/types.js').RemoteDialect = {
    id: 'acme-remote',
    transport: 'remote',
    sessionResumable: true, sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none',
    hostedConnectors: false,
    openSession: () => { throw new Error('never opened here'); },
    extractSessionId: () => null,
  };
  const root = new Context();
  try {
    // Without the permission: refused, like every other backend registration.
    const denied = await pluginFiber(root);
    const anonymous = createPluginContext(denied.ctx, {
      manifest: manifestOf('remote-denied', []), version: '1.0.0',
    }, fakeHost({ backends: { registerProfile: () => () => {}, registerDialect } }));
    assert.throws(() => anonymous.backends.registerDialect('acme-remote', remote), PluginPermissionError);
    assert.equal(getDialect('acme-remote'), undefined);
    await denied.dispose();

    // With it, and an EMPTY allowlist: there is no binary to allow.
    withPolicy({ exec: { allow: [] } });
    const { ctx, dispose } = await pluginFiber(root);
    const plugin = createPluginContext(ctx, {
      manifest: manifestOf('remote-provider', ['backends:register']), version: '1.0.0',
    }, fakeHost({ backends: { registerProfile: () => () => {}, registerDialect } }));
    plugin.backends.registerDialect('acme-remote', remote);
    assert.equal(getDialect('acme-remote'), remote);
    await dispose();
    assert.equal(getDialect('acme-remote'), undefined, 'withdrawn on unload');
  } finally {
    await root.fiber.dispose();
  }
});

test('a remote dialect is checked for its own shape, and an unknown transport is refused', async () => {
  const { registerDialect } = await import('../backends/registry.js');
  const base = {
    sessionResumable: true, sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none',
    hostedConnectors: false, extractSessionId: () => null,
  } as const;
  assert.throws(
    () => registerDialect('t', 'no-open', { ...base, transport: 'remote' } as unknown as import('../backends/types.js').RemoteDialect),
    /missing openSession/,
  );
  assert.throws(
    () => registerDialect('t', 'pigeon', { ...base, transport: 'pigeon', openSession: () => { throw new Error('x'); } } as unknown as import('../backends/types.js').RemoteDialect),
    /unknown `transport`/,
  );
});

for (const identity of [undefined, 'different-id', 'compat-dialect']) {
  test(`dialect registration preserves compatibility for id=${identity}`, async (t) => {
    const { registerDialect, getDialect } = await import('../backends/registry.js');
    const root = new Context();
    const warnings = t.mock.method(console, 'warn', () => {});
    const dialect = {
      ...(identity === undefined ? {} : { id: identity }),
      defaultCmd: 'acme',
      persistentProcess: false, finishMissionOnExit: false, sessionResumable: true,
      sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none',
      hostedConnectors: false,
      buildSpawn: async () => ({ cmd: 'acme', args: [], initialStdin: null }),
      writeUserInput: () => {}, parseLine: () => [], extractSessionId: () => null,
    } as import('../backends/types.js').Dialect;
    try {
      const { ctx, dispose } = await pluginFiber(root);
      withPolicy({ exec: { allow: ['acme'] } });
      const plugin = createPluginContext(ctx, {
        manifest: manifestOf('compat-provider', ['backends:register']), version: '1.0.0',
      }, fakeHost({ backends: {
        registerProfile: () => () => {},
        registerDialect,
      } }));
      plugin.backends.registerDialect('compat-dialect', dialect);
      assert.equal(getDialect('compat-dialect'), dialect);
      assert.equal(dialect.id, identity, 'registration must not rewrite legacy objects');
      assert.equal(warnings.mock.callCount(), identity === 'compat-dialect' ? 0 : 1);
      if (identity !== 'compat-dialect') {
        const [prefix, message] = warnings.mock.calls[0].arguments;
        assert.equal(prefix, '[plugin:compat-provider]');
        assert.match(String(message), identity === undefined ? /without dialect.id is deprecated/ : /dialect.id differs/);
      }
      await dispose();
      assert.equal(getDialect('compat-dialect'), undefined);
    } finally {
      await root.fiber.dispose();
      warnings.mock.restore();
      resetConfig();
      resetPluginPolicyState();
    }
  });
}

test('realtime refuses missing permission before reaching the host', async () => {
  const root = new Context();
  try {
    const { ctx } = await pluginFiber(root);
    const plugin = createPluginContext(ctx, {
      manifest: manifestOf('no-realtime', []), version: '1.0.0',
    }, fakeHost({ realtime: { publish() { assert.fail('host must not be called'); } } }));
    assert.throws(() => plugin.realtime.publish('changed', {}, { ownerUserId: 'owner' }), PluginPermissionError);
  } finally { await root.fiber.dispose(); }
});

/** Only what these tests publish: the bus is the process's, and on a loaded
 *  machine a notification an earlier test posted lands in their window (TODO #657). */
function realtimeEvents() {
  const events: import('../bus.js').BusEvent[] = [];
  const collect = (event: import('../bus.js').BusEvent) => { if (event.kind === 'plugin_realtime') events.push(event); };
  return { events, collect };
}

test('realtime validates inputs and fixes the publishing plugin identity', async () => {
  const root = new Context();
  const { events, collect } = realtimeEvents();
  bus.on('event', collect);
  try {
    const { ctx } = await pluginFiber(root);
    const plugin = createPluginContext(ctx, {
      manifest: manifestOf('realtime-demo', ['realtime:publish', 'events:subscribe']), version: '1.0.0',
    }, daemonHost(ctx));
    const owner = { ownerUserId: 'owner' };
    for (const topic of ['', 'Changed', 'other:changed', 'changed\nevent: task_done', 'a'.repeat(65)]) {
      assert.throws(() => plugin.realtime.publish(topic, {}, owner));
    }
    for (const options of [undefined, null, {}, { ownerUserId: null }, { ownerUserId: '' }, { ownerUserId: '  ' }]) {
      assert.throws(() => plugin.realtime.publish('changed', {}, options as never));
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const payload of [undefined, () => {}, Symbol('x'), 1n, cycle, { bad: undefined }, NaN]) {
      assert.throws(() => plugin.realtime.publish('changed', payload, owner), /JSON-serializable/);
    }
    assert.throws(() => plugin.realtime.publish('changed', 'a'.repeat(16383), owner), /16 KiB/);
    assert.throws(() => plugin.realtime.publish('changed', 'é'.repeat(8192), owner), /16 KiB/); // french-ok: a two-byte letter that doubles the UTF-8 size
    assert.throws(() => plugin.events.on('plugin_realtime' as never, () => {}));
    assert.deepEqual(events, []);
    plugin.realtime.publish('task_done', { pluginId: 'other-plugin' }, owner);
    assert.deepEqual(events, [{
      kind: 'plugin_realtime', pluginId: 'realtime-demo', topic: 'task_done',
      ownerUserId: 'owner', payload: { pluginId: 'other-plugin' },
    }]);
    plugin.realtime.publish('a'.repeat(64), 'a'.repeat(16382), owner);
    assert.equal(events.length, 2);
  } finally {
    bus.off('event', collect);
    await root.fiber.dispose();
  }
});

test('realtime normalizes toJSON before redacting nested payloads', async () => {
  const { setRedactionSource } = await import('../secrets/redact.js');
  const secret = 'realtime-secret-value';
  const previous = setRedactionSource(() => [secret]);
  const root = new Context();
  const { events, collect } = realtimeEvents();
  bus.on('event', collect);
  try {
    const { ctx } = await pluginFiber(root);
    const plugin = createPluginContext(ctx, {
      manifest: manifestOf('realtime-demo', ['realtime:publish']), version: '1.0.0',
    }, daemonHost(ctx));
    plugin.realtime.publish('changed', { toJSON: () => ({ nested: [secret] }) }, { ownerUserId: 'owner' });
    assert.deepEqual(events, [{ kind: 'plugin_realtime', pluginId: 'realtime-demo',
      topic: 'changed', ownerUserId: 'owner', payload: { nested: ['***'] } }]);
  } finally {
    setRedactionSource(previous);
    bus.off('event', collect);
    await root.fiber.dispose();
  }
});
