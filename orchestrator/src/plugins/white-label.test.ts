/**
 * The White Label lock (`docs/PLUGINS.md`): a plugin that replaces the whole
 * interface (slot `root`) runs only under a licence that carries the right.
 * Themes, pages, widgets and overlays stay open on Free; the product's own
 * layout is part of the release and never concerned.
 */
import '../test-home.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { PluginLoader } = await import('./loader.js');
const { daemonHost } = await import('./context.js');
const { setLicenseState, licenseState } = await import('../license/runtime.js');
const { unlicensed } = await import('../license/license.js');
const { whiteLabelAllowed } = await import('../license/capabilities.js');
import type { LicenseState } from '../license/license.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ok');
const PKG = '@fixtures/plugin-ok';
const LAYOUT = { kind: ['layout'], client: { slots: ['root'] } };

const paid = (features: string[]): LicenseState => ({
  status: 'valid', reason: null, plan: 'Pro', planId: 'pro', edition: 'expert', lifetime: true,
  modules: '*', plugins: '*', features, users: null, expiresAt: null,
  subscriptionExpiresAt: null, paymentStatus: 'active', offlineSince: null,
});

/** The `ok` fixture with its `timon` manifest patched, in a throwaway plugins root. */
function plugin(t: TestContext, patch: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'timon-white-label-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'node_modules', PKG);
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
  const file = join(dir, 'package.json');
  const json = JSON.parse(readFileSync(file, 'utf8')) as { timon: Record<string, unknown> };
  json.timon = { ...json.timon, ...patch };
  writeFileSync(file, JSON.stringify(json));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [PKG]: 'file:fixture' } }));
  return root;
}

/** A loader over `root` on a minimal daemon, torn down with the test. */
async function loaderFor(t: TestContext, root: string, opts: { whiteLabel?: () => boolean; allowUnsigned?: boolean; builtin?: boolean } = {}) {
  const app = express();
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const loader = new PluginLoader(ctx, {
    dir: opts.builtin ? mkdtempSync(join(tmpdir(), 'timon-white-label-empty-')) : root,
    host: daemonHost(ctx),
    allowUnsigned: () => opts.allowUnsigned ?? true,
    ...(opts.whiteLabel ? { whiteLabelAllowed: opts.whiteLabel } : {}),
    ...(opts.builtin ? { publicKeys: [], builtins: () => [{ pkg: PKG, dir: join(root, 'node_modules', PKG), trust: { ok: true } as const }] } : {}),
  });
  t.after(async () => { await loader.dispose(); server.close(); await ctx.fiber.dispose(); });
  const ping = async () => (await fetch(`http://127.0.0.1:${port}/api/plugins/fixture-ok/ping`)).status;
  return { loader, ping };
}

/** The daemon's own wiring: the right read from the licence in force. */
const live = () => whiteLabelAllowed(licenseState());

test('door A2: a `behavior` naming `root` is refused at the manifest, for everyone', async (t) => {
  // Reproduces the door before the fix: this plugin was admitted `active`
  // on Free, with no layout choice, and its `root` occupant replaced the shell.
  for (const license of [unlicensed('missing'), paid(['whitelabel'])]) {
    setLicenseState(license);
    const root = plugin(t, { kind: ['behavior'], client: { slots: ['root'] } });
    const { loader } = await loaderFor(t, root, { whiteLabel: live });
    const [record] = await loader.update();
    assert.equal(record?.state, 'skipped');
    assert.equal(record?.reason, 'skipped:manifest');
    assert.match(record?.error ?? '', /names `root` but `kind` is not `layout`/);
  }
});

test('Free: a third-party layout is installed but skipped as unlicensed, before its code runs', async (t) => {
  setLicenseState(unlicensed('missing'));
  const root = plugin(t, LAYOUT);
  const { loader, ping } = await loaderFor(t, root, { whiteLabel: live });
  const [record] = await loader.update();
  assert.equal(record?.state, 'skipped');
  assert.equal(record?.reason, 'skipped:unlicensed');
  assert.match(record?.error ?? '', /replaces the whole interface, which needs a licence that includes White Label/);
  assert.equal(await ping(), 404, 'its host half never ran');
  assert.ok(!loader.bundles.get('fixture-ok'), 'no browser half is served');
});

test('no option means no right: the loader never opens `root` by default', async (t) => {
  setLicenseState(paid(['whitelabel']));
  const root = plugin(t, LAYOUT);
  const { loader } = await loaderFor(t, root);
  const [record] = await loader.update();
  assert.equal(record?.reason, 'skipped:unlicensed');
});

test('a licence that includes White Label admits the layout', async (t) => {
  setLicenseState(paid(['code-pipeline', 'whitelabel']));
  const root = plugin(t, LAYOUT);
  const { loader, ping } = await loaderFor(t, root, { whiteLabel: live });
  const [record] = await loader.update();
  assert.equal(record?.state, 'active');
  assert.equal(await ping(), 200);
});

test('a paid licence without the right refuses the layout', async (t) => {
  setLicenseState(paid(['code-pipeline', 'browser']));
  const root = plugin(t, LAYOUT);
  const { loader } = await loaderFor(t, root, { whiteLabel: live });
  const [record] = await loader.update();
  assert.equal(record?.reason, 'skipped:unlicensed');
});

test('losing the right while running unmounts the layout; getting it back remounts it', async (t) => {
  setLicenseState(paid(['whitelabel']));
  const root = plugin(t, LAYOUT);
  const { loader, ping } = await loaderFor(t, root, { whiteLabel: live });
  assert.equal((await loader.update())[0]?.state, 'active');
  assert.equal(await ping(), 200);

  // Expiry, revocation and deactivation all land on `unlicensed(...)`.
  setLicenseState(unlicensed('expired'));
  const [lost] = await loader.update();
  assert.equal(lost?.reason, 'skipped:unlicensed');
  assert.equal(await ping(), 404, 'unmounted without a restart');
  assert.equal(loader.list().find((p) => p.id === 'fixture-ok')?.state, 'skipped', 'still installed and listed');

  setLicenseState(paid(['whitelabel']));
  assert.equal((await loader.update())[0]?.state, 'active');
  assert.equal(await ping(), 200);
});

test('developer mode does not open `root`: an unsigned layout is refused on Free', async (t) => {
  setLicenseState(unlicensed('missing'));
  const root = plugin(t, LAYOUT);
  const { loader } = await loaderFor(t, root, { whiteLabel: live, allowUnsigned: true });
  const [record] = await loader.update();
  assert.equal(record?.signed, false);
  assert.equal(record?.reason, 'skipped:unlicensed', 'refused before the signature admission developer mode relaxes');
});

test('a layout shipped with the product is part of the release, not concerned', async (t) => {
  setLicenseState(unlicensed('missing'));
  const root = plugin(t, { ...LAYOUT, kind: ['layout', 'widget'], client: { slots: ['root', 'cockpit.widget'] } });
  const { loader } = await loaderFor(t, root, { whiteLabel: live, builtin: true, allowUnsigned: false });
  const [record] = await loader.update();
  assert.equal(record?.builtin, true);
  assert.equal(record?.state, 'active');
});

test('a theme and a page stay open on Free, unsigned in developer mode included', async (t) => {
  setLicenseState(unlicensed('missing'));
  for (const patch of [
    { kind: ['theme'], client: { slots: ['theme'] } },
    { kind: ['page'], route: '/white-label-check', client: { slots: ['page', 'nav.item'] } },
    { kind: ['widget'], client: { slots: ['cockpit.widget'] } },
    { kind: ['overlay'], client: { slots: ['overlay'] } },
  ]) {
    const root = plugin(t, patch);
    const { loader } = await loaderFor(t, root, { whiteLabel: live });
    const [record] = await loader.update();
    assert.equal(record?.state, 'active', `${JSON.stringify(patch)}: ${record?.error}`);
    await loader.dispose();
  }
});

test('the browser learns the right as one boolean, never the plan nor the features', async () => {
  const { capabilitiesPayload } = await import('../kernel/capabilities.js');
  setLicenseState(unlicensed('missing'));
  assert.equal(capabilitiesPayload().whitelabel, false);
  setLicenseState(paid(['whitelabel', 'code-pipeline']));
  const payload = capabilitiesPayload();
  assert.equal(payload.whitelabel, true);
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /code-pipeline|"features"|"planId"/);
  setLicenseState(paid([]));
  assert.equal(capabilitiesPayload().whitelabel, false);
});

test('`timon plugin list` says the same: a layout without the right is `skipped:unlicensed`', async (t) => {
  const { inventory } = await import('./install.js');
  const config = join(mkdtempSync(join(tmpdir(), 'timon-white-label-config-')), 'timon.config.json');
  t.after(() => rmSync(dirname(config), { recursive: true, force: true }));
  const layout = plugin(t, LAYOUT);
  let read = 0;
  const denied = () => { read += 1; return false; };
  const [refused] = inventory(layout, config, [], undefined, denied);
  assert.equal(refused?.refused, 'skipped:unlicensed');
  assert.match(refused?.message ?? '', /needs a licence that includes White Label/);
  assert.equal(refused?.enabled, true, 'still installed and wanted: only the licence holds it back');
  assert.equal(inventory(layout, config, [], undefined, () => true)[0]?.refused, null);
  // A plain list never reads the licence.
  read = 0;
  assert.equal(inventory(plugin(t, { kind: ['theme'], client: { slots: ['theme'] } }), config, [], undefined, denied)[0]?.refused, null);
  assert.equal(read, 0);
  // Door A2 is a manifest refusal, listed as such.
  assert.equal(inventory(plugin(t, { kind: ['behavior'], client: { slots: ['root'] } }), config, [], undefined, () => true)[0]?.refused, 'skipped:manifest');
});

test('`timon plugin add` keeps the consent and says the layout is held back', async () => {
  const { heldForWhiteLabel } = await import('./install.js');
  assert.equal(heldForWhiteLabel({ kind: ['layout'], client: { slots: ['root'], external: [], mode: 'esm' } } as never, () => false), true);
  assert.equal(heldForWhiteLabel({ kind: ['layout'], client: { slots: ['root'], external: [], mode: 'esm' } } as never, () => true), false);
  assert.equal(heldForWhiteLabel({ kind: ['theme'], client: { slots: ['theme'], external: [], mode: 'esm' } } as never, () => false), false);
  const cli = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../bin/timon'), 'utf8');
  assert.match(cli, /mod\.heldForWhiteLabel\(result\.manifest\)/);
  assert.match(cli, /needs a licence\\n'\s*\+ 'that includes White Label/);
});
