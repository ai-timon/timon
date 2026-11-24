/**
 * Hot switching of a bundled module: what the gallery promises since
 * it lists the catalogue.
 *
 * The gap these tests close: `POST /api/plugins/vault/enabled` wrote
 * `modules.vault` and stopped there. The Cordis tree, mounted once at boot,
 * kept the module alive and the card showed "at the next start":
 * a restart nobody triggers, since it would kill the missions in
 * flight. Third-party plugins, for their part, have been hot since P.3.
 *
 * The tree is composed here the way `boot.ts` composes it, but with two entries:
 * booting the whole catalogue in a test suite would mount thirty modules,
 * their timers and their loops to watch one route switch off.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../test-home.js';
import { paidTestLicense } from '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Timer from '@deepseek-ai/cordis-plugin-timer';

const { createHttpPlugin } = await import('./http-service.js');
const { planEntries, toLoaderEntries } = await import('./registry.js');
const { createBundledReconciler, attachBundledReconciler } = await import('./bundled-reload.js');
const { capabilitiesPayload, setLiveDecisions } = await import('./capabilities.js');
const { setModuleEnabled } = await import('./module-config.js');
const { registerRoutes } = await import('../plugins-bundled/plugins/routes.js');
const { CONFIG_FILE, resetConfig } = await import('../config/load.js');
const { setLicenseState } = await import('../license/runtime.js');
import type { ModuleDescriptor } from './registry.js';
import type { PluginPublic } from '../plugins/public.js';

/** The minimal kernel, a free guinea pig, and a sold guinea pig (licence lic-6). */
const CATALOG: readonly ModuleDescriptor[] = [
  { id: '@timon/db', name: './plugins-bundled/db/index.js', tier: 'core' },
  { id: '@timon/vault', name: './plugins-bundled/vault/index.js', tier: 'opt' },
  { id: '@timon/dreams', name: './plugins-bundled/gpt-live/index.js', tier: 'opt', inject: ['http'], licensed: true },
];

type Kernel = {
  url: (path: string) => string;
  reconcile: () => Promise<string[]>;
  changes: string[][];
  close: () => Promise<void>;
};

const RESTRICTED_PAID = { ...paidTestLicense(), modules: [], plugins: [] };

async function kernel(): Promise<Kernel> {
  writeFileSync(CONFIG_FILE, '{}\n');
  resetConfig();
  // `licenseState()` is a module-wide singleton (kernel/bundled-reload.ts now
  // reads it live) — reset it so a test that installs a licence never leaks
  // into the next one sharing this process.
  setLicenseState(RESTRICTED_PAID);

  const app = express();
  app.use(express.json());
  const ctx = new Context();
  // Entry names are relative to `src/`, as they are to `dist/`
  // from `boot.js`. Under `tsx`, `./x/index.js` resolves `index.ts`.
  ctx.baseUrl = new URL('../', import.meta.url).href;
  await ctx.plugin(Timer);
  await ctx.plugin(createHttpPlugin(app));
  await ctx.plugin(Loader);

  const decisions = planEntries(CATALOG, { config: (await import('../config/load.js')).config(), capabilities: [], licensed: [] });
  setLiveDecisions(decisions, [], 'expert');
  for (const entry of toLoaderEntries(decisions)) await ctx.loader.create(entry);

  registerRoutes(ctx.http.router());

  const changes: string[][] = [];
  const reconciler = createBundledReconciler(ctx, {
    catalog: CATALOG,
    capabilities: [],
    decisions,
    onChange: (ids) => void changes.push(ids),
  });
  attachBundledReconciler(app, reconciler);
  const stopWatch = reconciler.watch(50);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    reconcile: () => reconciler.reconcile(),
    changes,
    close: async () => {
      stopWatch();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      await ctx.fiber.dispose();
    },
  };
}

/** The server and the tree go away whatever happens: an open handle freezes `node --test`. */
async function withKernel(body: (k: Kernel) => Promise<void>): Promise<void> {
  const k = await kernel();
  try { await body(k); } finally { await k.close(); }
}

function toggle(k: Kernel, id: string, enabled: boolean): Promise<Response> {
  // The id carries a `/`: without encoding, Express sees two segments in it and the
  // route returns 404 instead of switching the module.
  return fetch(k.url(`/api/plugins/${encodeURIComponent(id)}/enabled`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

function moduleActive(id: string): boolean | undefined {
  return capabilitiesPayload().modules.find((m) => m.id === id)?.active;
}

/** 400 = the route answers (invalid parameter), 404 = the module is gone. */
function vaultProbe(k: Kernel): Promise<Response> {
  return fetch(k.url('/api/vault/note'));
}

test('turning a bundled module off removes its routes WITHOUT restarting the daemon', async () => {
  await withKernel(async (k) => {
    assert.equal((await vaultProbe(k)).status, 400, 'vault answers before the switch');

    const off = await toggle(k, '@timon/vault', false);
    assert.equal(off.status, 200);

    // Same process, no boot reread: the tree was recomposed during
    // the request, so the reread that follows already tells the truth.
    assert.equal(moduleActive('@timon/vault'), false, '/api/capabilities suit l\'arbre');
    assert.equal((await vaultProbe(k)).status, 404, 'the router shell has gone inert');

    const { plugins } = await (await fetch(k.url('/api/plugins'))).json() as { plugins: PluginPublic[] };
    const vault = plugins.find((p) => p.id === '@timon/vault');
    assert.equal(vault?.state, 'disabled');
    assert.equal(vault?.wanted, false, 'the config and the tree say the same thing');

    const on = await toggle(k, '@timon/vault', true);
    assert.equal(on.status, 200);
    assert.equal(moduleActive('@timon/vault'), true);
    assert.equal((await vaultProbe(k)).status, 400, 'turning it back on remounts the routes');
  });
});

test('a core module stays irrevocable, and nothing is recomposed', async () => {
  await withKernel(async (k) => {
    const refused = await toggle(k, '@timon/db', false);
    assert.equal(refused.status, 403);
    assert.equal(moduleActive('@timon/db'), true);
    assert.deepEqual(k.changes, [], 'a refusal does not publish a recomposition');
    const written = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { modules?: Record<string, unknown> };
    assert.equal(written.modules?.['@timon/db'], undefined);
  });
});

test('a write that does not touch `modules` recomposes nothing', async () => {
  await withKernel(async (k) => {
    // The bus event counter would prove nothing: the third-party plugin loader
    // watches the SAME file and publishes on the same write. So we
    // query the reconciler itself.
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    cfg.ui = { hidden: ['nav.brain'], home: 'chat' };
    writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);

    assert.deepEqual(await k.reconcile(), [], 'no module switched sides');
    assert.deepEqual(k.changes, []);
    assert.equal((await vaultProbe(k)).status, 400);
  });
});

test('an unreadable configuration leaves the last valid tree in place', async () => {
  await withKernel(async (k) => {
    writeFileSync(CONFIG_FILE, '{ "modules": { "@timon/vault": ');

    assert.deepEqual(await k.reconcile(), [], 'a half-written file unmounts nothing');
    assert.equal((await vaultProbe(k)).status, 400, 'vault still runs');
    assert.equal(moduleActive('@timon/vault'), true);
  });
});

test('`timon module disable` is hot too: the watcher is enough, without a request', async () => {
  await withKernel(async (k) => {
    // Exactly what the CLI does: write the config, and nothing else.
    // `watchFile` takes its baseline stat asynchronously, on the libuv
    // threadpool: under load, a single write can land BEFORE that baseline,
    // which then already holds the new config — no change is ever seen. A
    // real CLI write always comes later, so we keep rewriting until the
    // watcher reacts; it is still the watcher alone that recomposes (no
    // request is made).
    const deadline = Date.now() + 10_000;
    let rewriteAt = 0;
    while (Date.now() < deadline && (await vaultProbe(k)).status !== 404) {
      if (Date.now() >= rewriteAt) {
        setModuleEnabled('@timon/vault', false);
        rewriteAt = Date.now() + 1_000;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await vaultProbe(k)).status, 404, 'the config watcher recomposes without going through HTTP');
    assert.deepEqual(k.changes.at(-1), ['@timon/vault']);
  });
});

test('installing a licence that covers a sold module turns it back on without a restart (lic-6)', async () => {
  await withKernel(async (k) => {
    assert.equal(moduleActive('@timon/dreams'), false, 'not covered at boot: no licence installed');

    setLicenseState({
      status: 'valid', reason: null, edition: 'expert',
      modules: ['@timon/dreams'], plugins: [],
      expiresAt: null, subscriptionExpiresAt: null, paymentStatus: 'active',
    });
    assert.deepEqual(await k.reconcile(), ['@timon/dreams'], 'the reconciler rereads licenseState(), not a value frozen at boot');
    assert.equal(moduleActive('@timon/dreams'), true, 'the installed licence turns the module back on without a restart');

    setLicenseState(RESTRICTED_PAID);
    assert.deepEqual(await k.reconcile(), ['@timon/dreams'], 'a licence that no longer covers it removes the module just as fast');
    assert.equal(moduleActive('@timon/dreams'), false);

    // An expired licence falls back to Free, which grants every module.
    setLicenseState((await import('../license/license.js')).unlicensed('expired'));
    assert.deepEqual(await k.reconcile(), ['@timon/dreams']);
    assert.equal(moduleActive('@timon/dreams'), true);
  });
});

// A queued reload must not mutate global decisions after its owner is gone.
test('disposing a reconciler cancels queued changes before loader effects', async () => {
  writeFileSync(CONFIG_FILE, '{}\n');
  resetConfig();
  setLicenseState(RESTRICTED_PAID);
  let updates = 0;
  const ctx = { loader: { update: async () => { updates++; } } } as unknown as Context;
  const decisions = planEntries(CATALOG, { config: (await import('../config/load.js')).config(), capabilities: [], licensed: [] });
  const reconciler = createBundledReconciler(ctx, { catalog: CATALOG, capabilities: [], decisions });
  setModuleEnabled('@timon/vault', false);
  const queued = reconciler.reconcile();
  reconciler.dispose();
  assert.deepEqual(await queued, []);
  assert.deepEqual(await reconciler.reconcile(), []);
  assert.equal(updates, 0);
});

/**
 * TIM-0147: after a reboot read the licence as off, the licence came back but
 * kanban and every module that depends on it stayed off. The reconciler had
 * recorded the new tree BEFORE asking the loader for it, so an update that
 * failed once was never tried again.
 */
const CHAIN: readonly ModuleDescriptor[] = [
  { id: '@timon/db', name: './plugins-bundled/db/index.js', tier: 'core' },
  { id: '@timon/kanban', name: './kanban.js', tier: 'std', licensed: true },
  { id: '@timon/triggers', name: './triggers.js', tier: 'std', dependsOn: ['@timon/kanban'] },
  { id: '@timon/routines', name: './routines.js', tier: 'std', dependsOn: ['@timon/kanban'] },
];
const KANBAN_LICENCE = {
  ...paidTestLicense(), modules: ['@timon/kanban'], plugins: [],
};

function flakyChain(failures: Record<string, number>, retryMs?: number) {
  writeFileSync(CONFIG_FILE, '{}\n');
  resetConfig();
  setLicenseState(RESTRICTED_PAID);
  const calls: string[] = [];
  const left = { ...failures };
  const ctx = {
    loader: {
      update: async (id: string, patch: { disabled: boolean }) => {
        if ((left[id] ?? 0) > 0) {
          left[id]! -= 1;
          calls.push(`${id}:failed`);
          throw new Error('fiber refused to start');
        }
        calls.push(`${id}=${patch.disabled ? 'off' : 'on'}`);
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

test('a module whose recomposition failed is tried again, with the modules depending on it', async () => {
  const { ctx, calls } = flakyChain({ '@timon/kanban': 1 });
  const { config } = await import('../config/load.js');
  const decisions = planEntries(CHAIN, { config: config(), capabilities: [], licensed: [] });
  assert.equal(decisions.find((d) => d.id === '@timon/triggers')?.disabled, true, 'off by cascade at boot');
  const reconciler = createBundledReconciler(ctx, { catalog: CHAIN, capabilities: [], decisions, retryMs: 60_000 });
  try {
    setLicenseState(KANBAN_LICENCE);
    assert.deepEqual(await reconciler.reconcile(), [], 'nothing came back: kanban failed, its dependents waited');
    assert.deepEqual(calls, ['@timon/kanban:failed'], 'dependents are not switched on over a missing kanban');

    // Same licence, same configuration: only the failure makes it a change.
    assert.deepEqual(await reconciler.reconcile(), ['@timon/kanban', '@timon/triggers', '@timon/routines']);
    assert.deepEqual(calls.slice(1), ['@timon/kanban=on', '@timon/triggers=on', '@timon/routines=on']);
    assert.deepEqual(await reconciler.reconcile(), [], 'once applied, nothing is redone');
  } finally {
    reconciler.dispose();
  }
});

test('a failed recomposition retries on its own, without a new licence or config event', async () => {
  const { ctx, calls } = flakyChain({ '@timon/kanban': 2 });
  const { config } = await import('../config/load.js');
  const decisions = planEntries(CHAIN, { config: config(), capabilities: [], licensed: [] });
  const reconciler = createBundledReconciler(ctx, { catalog: CHAIN, capabilities: [], decisions, retryMs: 10 });
  try {
    setLicenseState(KANBAN_LICENCE);
    await reconciler.reconcile();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !calls.includes('@timon/routines=on')) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(calls, [
      '@timon/kanban:failed', '@timon/kanban:failed',
      '@timon/kanban=on', '@timon/triggers=on', '@timon/routines=on',
    ]);
  } finally {
    reconciler.dispose();
  }
});

test('a module that keeps failing does not hold back the switch-off of another', async () => {
  const { ctx, calls } = flakyChain({ '@timon/kanban': 1 });
  const { config } = await import('../config/load.js');
  setLicenseState(KANBAN_LICENCE);
  const decisions = planEntries(CHAIN, { config: config(), capabilities: [], licensed: ['@timon/kanban'] });
  const reconciler = createBundledReconciler(ctx, { catalog: CHAIN, capabilities: [], decisions, retryMs: 60_000 });
  try {
    setLicenseState(RESTRICTED_PAID);
    assert.deepEqual(await reconciler.reconcile(), ['@timon/triggers', '@timon/routines']);
    assert.deepEqual(calls, ['@timon/kanban:failed', '@timon/triggers=off', '@timon/routines=off']);
    assert.deepEqual(await reconciler.reconcile(), ['@timon/kanban']);
  } finally {
    reconciler.dispose();
  }
});
