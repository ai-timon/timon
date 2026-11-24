/**
 * The kernel: four glue files on top of Cordis.
 *
 * What these tests protect: the event bridge (modules must see
 * the historical bus and unsubscribe on their own), the reversibility of routes
 * (an unloaded module must no longer answer), filtering by host capabilities,
 * and above all the activation audit: without it, an unsatisfied `inject` leaves
 * a module mute and nobody notices.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { bus } = await import('../bus.js');
const { apply: applyBusBridge } = await import('./bus-bridge.js');
const { installRejectionGuard } = await import('./rejection-guard.js');
const { createHttpPlugin } = await import('./http-service.js');
const { planEntries, toLoaderEntries, capabilitiesReport } = await import('./registry.js');
const { collectActivationFailures, formatActivationFailures } = await import('./activation-audit.js');
const { loadConfig } = await import('../config/load.js');
const { CATALOG } = await import('./catalog.js');

/** Default config: no file, hence the current install. */
const baseConfig = () => loadConfig('/nulle/part/timon.config.json');

test('the real browser module is available on macOS without Docker or Traefik', async () => {
  const descriptor = CATALOG.find((entry) => entry.id === '@timon/browser-embedded')!;
  const { manifest } = await import('../plugins-bundled/browser-embedded/index.js');
  assert.deepEqual(descriptor.requires, manifest.requires);
  const [decision] = planEntries([descriptor], { config: baseConfig(), capabilities: ['gui'] });
  assert.equal(decision?.disabled, false);
  assert.deepEqual(decision?.missing, []);
  const [unlicensed] = planEntries([descriptor], { config: baseConfig(), capabilities: ['gui'], licensed: [] });
  assert.equal(unlicensed?.disabled, false, 'the browser is included without a paid licence');
});

test('the bridge republishes the bus events on the context, and goes away with its fiber', async () => {
  const root = new Context();
  const seen: string[] = [];
  const fiber = await root.plugin({ name: 'bridge', apply: applyBusBridge });
  root.on('timon/mission_complete', (ev) => void seen.push(ev.missionId));

  bus.publish({ kind: 'mission_complete', missionId: 'm1', status: 'completed', exitCode: 0 });
  assert.deepEqual(seen, ['m1']);

  // Unloading the bridge must cut the republishing: otherwise each hot
  // reload would stack one more listener on a bus that never loses any.
  await fiber.dispose();
  bus.publish({ kind: 'mission_complete', missionId: 'm2', status: 'completed', exitCode: 0 });
  assert.deepEqual(seen, ['m1'], 'the unloaded bridge must no longer republish');
  await root.fiber.dispose();
});

test('a bundled module whose raw listener throws or rejects fails alone: the publisher and the other listeners carry on (#630)', async () => {
  const logs: string[] = [];
  const uninstall = installRejectionGuard({ log: (line) => void logs.push(line), notify: () => assert.fail('a module is not a plugin: no notification') });
  const root = new Context();
  const seen: string[] = [];
  try {
    await root.plugin({ name: 'bridge', apply: applyBusBridge });
    await root.plugin({
      name: '@timon/faulty',
      apply(ctx: Context) {
        ctx.on('timon/mission_complete', () => { throw new Error('faulty listener'); });
        ctx.on('timon/mission_complete', async () => { throw new Error('faulty async listener'); });
      },
    });
    root.on('timon/mission_complete', (ev) => void seen.push(`cordis:${ev.missionId}`));
    // A plain bus subscriber registered after the bridge: the emitter's own
    // loop must reach it too.
    const later = (ev: { kind: string }) => { if (ev.kind === 'mission_complete') seen.push('bus'); };
    bus.on('event', later);
    try {
      assert.doesNotThrow(() => bus.publish({ kind: 'mission_complete', missionId: 'm1', status: 'completed', exitCode: 0 }),
        'the publishing write must not inherit the module\'s throw');
    } finally {
      bus.off('event', later);
    }
    assert.deepEqual(seen, ['cordis:m1', 'bus'], 'the listeners after the faulty one still receive the event');

    await new Promise((r) => setImmediate(r));
    const sync = logs.find((l) => l.includes('faulty listener'));
    const rejected = logs.find((l) => l.includes('faulty async listener'));
    assert.ok(sync?.includes('module `@timon/faulty` in event timon/mission_complete'), `throw put on the module: ${sync}`);
    assert.ok(rejected?.includes('module `@timon/faulty` in event timon/mission_complete'), `rejection put on the module: ${rejected}`);
  } finally {
    uninstall();
    await root.fiber.dispose();
  }
});

test('the isolated bridge keeps Cordis semantics: order, the dispatch notice, and a listener that unsubscribes mid-event', async () => {
  const root = new Context();
  const order: string[] = [];
  try {
    await root.plugin({ name: 'bridge', apply: applyBusBridge });
    root.on('internal/dispatch', (mode, name) => { if (name === 'timon/mission_complete') order.push(`notice:${mode}`); });
    root.once('timon/mission_complete', () => void order.push('once'));
    root.on('timon/mission_complete', () => void order.push('second'));
    root.on('timon/mission_complete', () => void order.push('first'), true);

    bus.publish({ kind: 'mission_complete', missionId: 'm1', status: 'completed', exitCode: 0 });
    bus.publish({ kind: 'mission_complete', missionId: 'm2', status: 'completed', exitCode: 0 });
    assert.deepEqual(order, ['notice:emit', 'first', 'once', 'second', 'notice:emit', 'first', 'second']);
  } finally {
    await root.fiber.dispose();
  }
});

test('a route set by a module disappears when the module is unloaded', async () => {
  const app = express();
  const root = new Context();
  await root.plugin(createHttpPlugin(app));

  const mod = await root.plugin({
    name: 'demo',
    inject: ['http'],
    apply(ctx: Context) {
      ctx.http.router('/api/demo').get('/ping', (_req, res) => void res.json({ ok: true }));
    },
  });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/demo/ping`;

  assert.equal((await fetch(url)).status, 200);
  await mod.dispose();
  assert.equal((await fetch(url)).status, 404, 'the route must fall with its module');

  server.close();
  await root.fiber.dispose();
});

test('the registry disables what the machine cannot do, and never the kernel', () => {
  const cfg = baseConfig();
  cfg.modules['@timon/video-factory'] = false;
  cfg.modules['@timon/browser-embedded'] = { enabled: true, port: 4444 };

  const decisions = planEntries(
    [
      { id: '@timon/db', name: './plugins-bundled/db/index.js', tier: 'core' },
      { id: '@timon/grepai', name: './plugins-bundled/grepai/index.js', tier: 'dev', requires: ['grepai', 'systemd'] },
      { id: '@timon/docker-supervision', name: './plugins-bundled/docker-supervision/index.js', tier: 'dev', requires: ['containers'] },
      { id: '@timon/video-factory', name: './plugins-bundled/video-factory/index.js', tier: 'opt' },
      { id: '@timon/browser-embedded', name: './plugins-bundled/browser-embedded/index.js', tier: 'opt', requires: ['containers', 'traefik'] },
    ],
    { config: cfg, capabilities: ['systemd', 'grepai'] },
  );
  const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));

  assert.equal(byId['@timon/db'].disabled, false);
  assert.equal(byId['@timon/grepai'].disabled, false, 'all its capabilities are there');
  assert.match(byId['@timon/docker-supervision'].reason ?? '', /containers/);
  assert.equal(byId['@timon/video-factory'].reason, 'disabled in timon.config.json');
  // Forced to `true`: it runs despite the missing capabilities, but the gap
  // stays visible: it is a user choice, not an oversight of the system.
  assert.equal(byId['@timon/browser-embedded'].disabled, false);
  assert.deepEqual(byId['@timon/browser-embedded'].missing, ['containers', 'traefik']);
  assert.deepEqual(byId['@timon/browser-embedded'].config, { port: 4444 });

  const entries = toLoaderEntries(decisions);
  assert.deepEqual(entries.find((e) => e.id === '@timon/docker-supervision'), {
    id: '@timon/docker-supervision',
    name: './plugins-bundled/docker-supervision/index.js',
    disabled: true,
  });

  const report = capabilitiesReport(decisions, { config: cfg, capabilities: ['systemd', 'grepai'] });
  assert.equal(report.edition, 'expert');
  assert.equal(report.modules.find((m) => m.id === '@timon/docker-supervision')?.active, false);
});

test('the options of a module go up into the capability report', () => {
  // What they carry: an option that decides a SURFACE is readable neither
  // in the tier nor in `ui.hidden`. Without this pass-through, the front end would need a
  // route per module to read a key the config already has.
  const cfg = baseConfig();
  cfg.modules['@timon/vault'] = { enabled: true, surfaces: ['widget'] };
  const decisions = planEntries(
    [{ id: '@timon/vault', name: './x.js', tier: 'std' }],
    { config: cfg, capabilities: [] },
  );
  const report = capabilitiesReport(decisions, { config: cfg, capabilities: [] });
  // `enabled` stays with the kernel: it decides the mount, not the surface.
  assert.deepEqual(report.modules[0]?.options, { surfaces: ['widget'] });

  const nu = capabilitiesReport(
    planEntries([{ id: 'kanban', name: './x.js', tier: 'std' }], { config: cfg, capabilities: [] }),
    { config: cfg, capabilities: [] },
  );
  assert.deepEqual(nu.modules[0]?.options, {}, 'a module without options returns an empty object');
});

test('a restrictive licence wins over a sold module forced in the config', () => {
  const cfg = baseConfig();
  cfg.modules['@timon/dreams'] = true;
  const [decision] = planEntries(
    [{ id: '@timon/dreams', name: './x.js', tier: 'std', licensed: true }],
    { config: cfg, capabilities: [], licensed: ['@timon/kanban-code'] },
  );
  assert.equal(decision.reason, 'not included in this licence');
});

test('the licence does not touch the free modules', () => {
  // §10.7: only the modules marked `licensed` are sold. If the
  // allowlist governed the whole catalogue, a Lite licence (or no
  // licence) would turn the product off instead of restricting it.
  const cfg = baseConfig();
  const [decision] = planEntries(
    [{ id: '@timon/grepai', name: './x.js', tier: 'dev' }],
    { config: cfg, capabilities: ['grepai', 'systemd'], licensed: ['@timon/kanban-code'] },
  );
  assert.equal(decision.reason, null);
  assert.equal(decision.disabled, false);
});

test('the sold modules of §10.7 are marked in the catalogue', () => {
  // The marking lives in two files (the module manifest and the
  // catalogue); this test is what keeps them from drifting apart silently.
  const vendus = CATALOG.filter((m) => m.licensed).map((m) => m.id).sort();
  assert.deepEqual(vendus, ['@timon/dreams', '@timon/kanban-code', '@timon/machines']);
});

/**
 * The two tables of the rename (§10.14): the catalogue says what exists, the
 * aliases say what a module used to be called. An alias that no longer designates
 * anything would turn a valid config into a dead key, without a word.
 */
test('every catalogue module carries the @timon scope, and the aliases point into it', async () => {
  const { LEGACY_IDS } = await import('./legacy-ids.js');
  const ids = new Set(CATALOG.map((m) => m.id));

  for (const id of ids) assert.match(id, /^@timon\//, `${id} must carry the @timon scope`);
  assert.equal(ids.size, CATALOG.length, 'an id appears only once');

  for (const [legacy, current] of Object.entries(LEGACY_IDS)) {
    assert.ok(ids.has(current), `the alias ${legacy} points at ${current}, missing from the catalogue`);
    assert.equal(ids.has(legacy), false, `${legacy} is an old id, it must no longer be in the catalogue`);
  }
});

/**
 * What becomes of a removed module. `@timon/backlog` is no longer in the
 * catalogue and has no alias: the notebook merged into `@timon/kanban`, which
 * an alias translation would switch off by mistake.
 */
test('a removed id aliases to nothing and does not break an existing config', async () => {
  const { LEGACY_IDS, RETIRED_IDS, canonicalModuleId, isRetiredModuleId } =
    await import('./legacy-ids.js');
  const ids = new Set(CATALOG.map((m) => m.id));

  for (const retire of RETIRED_IDS) {
    assert.equal(ids.has(retire), false, `${retire} is removed, it must no longer be in the catalogue`);
    assert.equal(LEGACY_IDS[retire], undefined, `${retire} must not be aliased to a successor`);
    assert.equal(canonicalModuleId(retire), retire, 'a removed id is returned as is');
    assert.equal(isRetiredModuleId(retire), true);
  }
  assert.equal(isRetiredModuleId('@timon/dreams'), false, 'a living module is not removed');

  // A `timon.config.json` written before the removal keeps loading: the
  // key no longer designates anything, and the plan simply ignores it.
  const cfg = baseConfig();
  cfg.modules['@timon/backlog'] = false;
  const decisions = planEntries([{ id: '@timon/kanban', name: './kanban.js', tier: 'std' }], {
    config: cfg,
    capabilities: [],
  });
  assert.deepEqual(decisions.map((d) => d.id), ['@timon/kanban']);
  assert.equal(decisions[0]?.disabled, false);
});

// The Google agenda left the product on 06/11/2026 (tag `agenda-before-removal`).
// An installation that had it switched on carries `"@timon/agenda": true` in its
// `timon.config.json`: loading that file must neither throw nor change what the
// real catalogue mounts.
test('a config that still turns the removed agenda modules on loads, and the plan ignores them', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { isRetiredModuleId } = await import('./legacy-ids.js');
  const file = join(mkdtempSync(join(tmpdir(), 'timon-retired-agenda-')), 'timon.config.json');
  writeFileSync(file, JSON.stringify({
    modules: {
      agenda: true,
      'google-calendar': true,
      '@timon/agenda': true,
      '@timon/google-calendar': { enabled: true, account: 'work' },
    },
  }));
  const cfg = loadConfig(file, { readonly: true });
  for (const id of ['agenda', 'google-calendar', '@timon/agenda', '@timon/google-calendar']) {
    assert.equal(isRetiredModuleId(id), true, `${id} is a retired id`);
    assert.equal(CATALOG.some((m) => m.id === id), false, `${id} left the catalogue`);
  }
  const plan = (config: typeof cfg) => planEntries(CATALOG, { config, capabilities: [] })
    .map((d) => `${d.id}:${d.disabled ? 'off' : 'on'}`);
  assert.deepEqual(plan(cfg), plan(baseConfig()), 'the retired keys switch nothing on or off');
});

test('the audit names the missing service of a module left PENDING', async () => {
  const root = new Context();
  // Reproduces the trap directly, without a loader: an `inject` nobody provides.
  const fiber = await root.plugin({ name: 'orphelin', inject: ['dispatcher'], apply() { /* never called */ } });
  assert.notEqual(fiber.state, 2 /* ACTIVE */, 'an unsatisfied inject must not activate the module');

  // Without a mounted loader, the audit has nothing to inspect: that is the legacy case,
  // which must stay silent rather than fail.
  assert.deepEqual(await collectActivationFailures(root), []);

  const rendered = formatActivationFailures([
    { entry: '@timon/missions', state: 'pending', detail: 'missing services: dispatcher' },
  ]);
  assert.match(rendered, /@timon\/missions/);
  assert.match(rendered, /dispatcher/);
  await root.fiber.dispose();
});

test('a module turned off turns off those that depend on it, in cascade', () => {
  // The real case: `@timon/dreams` injects the `memory` service. Without a cascade,
  // turning `@timon/memory` off leaves the `@timon/dreams` fiber PENDING, and
  // `auditActivation` exits with code 2: the daemon refuses to start for an OPTIONAL module turned off
  // on purpose. The cascade turns that crash into a readable decision.
  const cfg = baseConfig();
  cfg.modules['@timon/memory'] = false;

  const decisions = planEntries(
    [
      { id: '@timon/db', name: './core-db.js', tier: 'core', dependsOn: ['@timon/memory'] },
      { id: '@timon/memory', name: './memory.js', tier: 'opt' },
      { id: '@timon/dreams', name: './dreams.js', tier: 'std', dependsOn: ['@timon/memory'] },
      { id: 'aval', name: './aval.js', tier: 'opt', dependsOn: ['@timon/dreams'] },
      { id: '@timon/kanban', name: './kanban.js', tier: 'std' },
    ],
    { config: cfg, capabilities: [] },
  );
  const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));

  assert.equal(byId['@timon/memory'].reason, 'disabled in timon.config.json');
  assert.equal(byId['@timon/dreams'].reason, 'depends on @timon/memory, which is disabled');
  // Fixed point: the chain switches off entirely, whatever the order of the
  // catalogue (`aval` is listed after `dreams`, but also after `memory`).
  assert.equal(byId['aval'].reason, 'depends on @timon/dreams, which is disabled');
  assert.equal(byId['@timon/kanban'].disabled, false, 'an unrelated module does not move');
  // The kernel never cascades: a wrong dependency in the catalogue must
  // not be able to turn the database off.
  assert.equal(byId['@timon/db'].disabled, false);
});
