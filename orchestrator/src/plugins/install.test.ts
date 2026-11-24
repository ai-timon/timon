/**
 * `timon plugin add|remove` of a **bundle** (plan §10.12, step U.8).
 *
 * What these tests protect fits in two sentences. Installing a bundle
 * installs and enables the ids of its `contains` that are missing, and each stays
 * a plugin in its own right: installed at the top level, can be turned off, mounted by
 * the loader for itself. Uninstalling the bundle takes away ONLY what it
 * brought: a child already there before, or reinstalled by hand, survives.
 *
 * npm is injected (`opts.npm`) rather than faked behind a facade: the
 * double below does what npm does: copy the package into
 * `node_modules/`, its dependencies along, and record the top level in
 * `package.json`. All the rest of the path (discovery, manifest, provenance,
 * loader) is the real code, without a registry or network.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomUUID, sign as signCrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';

const { addPlugin, removePlugin, inventory, isLocalSpec, pluginProvenance, registryPackageName } = await import('./install.js');
import type { NpmRunner } from './install.js';
const { PluginLoader } = await import('./loader.js');
const { hashPluginDirectory } = await import('./signature.js');
const { daemonHost } = await import('./context.js');
const { dbApi } = await import('../db.js');
const { INTEGRATIONS_DB_PATH } = await import('../paths.js');
const { IntegrationStore } = await import('./integration-store.js');
const { UserConnectionService, UserConnectionStore } = await import('./user-connections.js');
import type { StoredUserConnection } from './user-connections.js';
const { daemonUserConnectionHost, withdrawPluginUserConnections } = await import('./user-connections-host.js');
const { DestinationRefusedError } = await import('./net-guard.js');

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '../../../examples');

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, 'utf8')) as Json;
}

/**
 * The npm double. `install <spec>` copies the package and, recursively, its
 * dependencies (npm hoists them to the root of the tree); only the package named
 * by the command enters the top-level `dependencies`.
 */
function fakeNpm(): { run: NpmRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: NpmRunner = async (args, cwd) => {
    calls.push(args);
    const root = args[args.indexOf('--prefix') + 1] ?? cwd;
    const spec = args[args.length - 1] as string;
    const pkgFile = join(root, 'package.json');
    const pkg = existsSync(pkgFile) ? readJson(pkgFile) : {};
    const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};

    if (args[0] === 'install') {
      const name = copyTree(root, spec);
      deps[name] = `file:${spec}`;
    } else {
      delete deps[spec];
      rmSync(join(root, 'node_modules', spec), { recursive: true, force: true });
    }
    pkg.dependencies = deps;
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  };
  return { run, calls };
}

/** Copies a package folder into `node_modules/`, its local dependencies along. */
function copyTree(root: string, spec: string): string {
  const source = isAbsolute(spec) ? spec : resolve(spec);
  const json = readJson(join(source, 'package.json'));
  const name = json.name as string;
  const dest = join(root, 'node_modules', name);
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(source, dest, { recursive: true });
  for (const range of Object.values((json.dependencies as Record<string, string> | undefined) ?? {})) {
    if (range.startsWith('file:')) copyTree(root, resolve(source, range.slice('file:'.length)));
  }
  return name;
}

type Fixture = { root: string; config: string; npm: NpmRunner; calls: string[][] };

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'timon-bundle-'));
  const config = join(home, 'timon.config.json');
  writeFileSync(config, JSON.stringify({}, null, 2));
  const { run, calls } = fakeNpm();
  return { root: join(home, 'plugins'), config, npm: run, calls };
}

function cleanup(f: Fixture): void {
  rmSync(dirname(f.config), { recursive: true, force: true });
}

const BUNDLE = join(EXAMPLES, 'plugin-bundle');
const WIDGET = join(EXAMPLES, 'plugin-widget');

test('adding a bundle installs and enables the missing children', async () => {
  const f = fixture();
  const res = await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });

  assert.equal(res.id, 'example-bundle');
  assert.deepEqual(
    res.children.map((c) => [c.id, c.state]).sort(),
    [['example-page', 'installed'], ['example-widget', 'installed']],
  );

  // Top level of the npm tree: a child is not a hidden dependency
  // of the bundle, it is a plugin the loader discovers for itself.
  const deps = Object.keys((readJson(join(f.root, 'package.json')).dependencies as Json) ?? {});
  assert.ok(deps.includes('@timon-ai/plugin-page'), deps.join(', '));
  assert.ok(deps.includes('@timon-ai/plugin-widget'), deps.join(', '));

  const ids = inventory(f.root, f.config, []);
  for (const id of ['example-bundle', 'example-page', 'example-widget']) {
    const entry = ids.find((p) => p.id === id);
    assert.equal(entry?.refused ?? null, null, `${id}: ${entry?.message}`);
    assert.equal(entry?.enabled, true, `${id} should be enabled`);
  }

  assert.equal(pluginProvenance('example-page', f.config), 'example-bundle');
  assert.equal(pluginProvenance('example-widget', f.config), 'example-bundle');
  assert.equal(pluginProvenance('example-bundle', f.config), null);
  cleanup(f);
});

test('the loader mounts each child of the bundle as a plugin of its own', async () => {
  const f = fixture();
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });

  const ctx = new Context();
  const loader = new PluginLoader(ctx, {
    dir: f.root,
    host: daemonHost(ctx),
    plugins: () => ({}),
    allowUnsigned: () => true,
  });
  const records = await loader.update();
  const state = Object.fromEntries(records.map((r) => [r.id, r.state]));
  assert.deepEqual(state, { 'example-bundle': 'active', 'example-page': 'active', 'example-widget': 'active' });

  // Each child has its browser half served under ITS id: that is what makes it
  // movable independently of the bundle that brought it.
  assert.ok(loader.bundles.get('example-widget'), 'the widget must be servable alone');

  // Turning a child off does not unmount the rest (§10.12).
  const off = new PluginLoader(ctx, {
    dir: f.root,
    host: daemonHost(ctx),
    plugins: () => ({ 'example-widget': false }),
    allowUnsigned: () => true,
  });
  const after = Object.fromEntries((await off.update()).map((r) => [r.id, r.state]));
  assert.equal(after['example-widget'], 'disabled');
  assert.equal(after['example-page'], 'active');

  await loader.dispose();
  await off.dispose();
  await ctx.fiber.dispose();
  cleanup(f);
});

test('removing the bundle only removes the children it brought', async () => {
  const f = fixture();
  // The widget is there BEFORE the bundle: it belongs to nobody.
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });

  const res = await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  assert.equal(res.children.find((c) => c.id === 'example-widget')?.state, 'kept');
  assert.equal(pluginProvenance('example-widget', f.config), null, 'a pre-existing child is marked by nobody');

  const removed = await removePlugin('example-bundle', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.children, ['example-page']);

  const left = inventory(f.root, f.config, []).map((p) => p.id);
  assert.deepEqual(left, ['example-widget']);
  assert.ok(!existsSync(join(f.root, 'node_modules/@timon-ai/plugin-page')), 'the page it brought is gone');
  cleanup(f);
});

test('remove forgets the webhook secrets of the plugin and of the children it takes away, never those of another', async () => {
  const { resolveMasterKey } = await import('../secrets/key.js');
  const { pluginWebhookStatus, rotatePluginWebhookSecret } = await import('./webhooks.js');
  resolveMasterKey({ keyring: null });
  const f = fixture();
  // The widget is there before the bundle: it stays, its secrets with it.
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  for (const id of ['example-bundle', 'example-page', 'example-widget']) rotatePluginWebhookSecret(id, 'events', null, { pkg: id, trust: 'unsigned' });

  const removed = await removePlugin('example-bundle', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.webhooks.sort(), ['example-bundle/events', 'example-page/events']);
  assert.equal(pluginWebhookStatus('example-bundle', 'events').configured, false);
  assert.equal(pluginWebhookStatus('example-page', 'events').configured, false);
  assert.equal(pluginWebhookStatus('example-widget', 'events').configured, true, 'a pre-existing child keeps its own');

  const alone = await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(alone.webhooks, ['example-widget/events']);
  assert.equal(pluginWebhookStatus('example-widget', 'events').configured, false);
  cleanup(f);
});

/**
 * TODO #659: a vault grant `agent:plugin:<id>` names the id, not the package.
 * Removing the plugin withdraws it — for the children it takes too — so that a
 * package republished under the same id, by anyone, reads nothing it was not
 * granted. A pre-existing child and a stranger keep theirs.
 */
test('remove withdraws the vault grants of the plugin and the children it takes, never anyone else\'s', async () => {
  const { resolveMasterKey } = await import('../secrets/key.js');
  const { createSecret } = await import('../secrets/store.js');
  const { readPluginSecret } = await import('../secrets/plugins.js');
  resolveMasterKey({ keyring: null });
  const f = fixture();
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  createSecret({ name: 'BUNDLE_TOKEN', value: 'v-bundle', grants: ['agent:plugin:example-bundle', 'agent:plugin:someone-else'] });
  createSecret({ name: 'PAGE_TOKEN', value: 'v-page', grants: ['agent:plugin:example-page'] });
  createSecret({ name: 'WIDGET_TOKEN', value: 'v-widget', grants: ['agent:plugin:example-widget'] });

  const removed = await removePlugin('example-bundle', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.secretGrants.sort(), ['example-bundle/BUNDLE_TOKEN', 'example-page/PAGE_TOKEN']);
  // The same id installed again — any package, any author — gets nothing back.
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  assert.equal(readPluginSecret('example-bundle', 'BUNDLE_TOKEN'), undefined);
  assert.equal(readPluginSecret('example-page', 'PAGE_TOKEN'), undefined);
  assert.equal(readPluginSecret('someone-else', 'BUNDLE_TOKEN'), 'v-bundle', 'a stranger keeps its grant');
  assert.equal(readPluginSecret('example-widget', 'WIDGET_TOKEN'), 'v-widget', 'a pre-existing child keeps its grant');

  const alone = await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(alone.secretGrants, ['example-widget/WIDGET_TOKEN']);
  assert.equal(readPluginSecret('example-widget', 'WIDGET_TOKEN'), undefined);
  cleanup(f);
});

/**
 * TODO #661: a consent card "secret shared global only" left open after the
 * removal would grant the secret to the id, so to the next package published
 * under it. Removal closes the plugin's cards and those of the children it
 * takes; a child that was there before keeps its own, as does any other plugin.
 */
test('remove closes the secret consent cards of the plugin and the children it takes, never anyone else\'s', async () => {
  const { createNotification } = await import('../notifications.js');
  const { dbApi } = await import('../db.js');
  const f = fixture();
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  const anchors = ['example-bundle', 'example-page', 'example-widget', 'example-page-2']
    .map((id) => `plugin-secret:${id}:REMOVE_CARD_TOKEN`);
  for (const anchor of anchors) createNotification({ type: 'action_required', title: anchor, anchor, source: 'plugin:x' });
  const open = () => dbApi.listActiveNotifications('action_required').map((n) => n.anchor).filter((a) => anchors.includes(a ?? ''));

  await removePlugin('example-bundle', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(open().sort(), ['plugin-secret:example-page-2:REMOVE_CARD_TOKEN', 'plugin-secret:example-widget:REMOVE_CARD_TOKEN']);

  await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(open(), ['plugin-secret:example-page-2:REMOVE_CARD_TOKEN'], 'an id sharing the prefix is someone else');
  cleanup(f);
});

/**
 * TODO #599: a host opened to one plugin (`pluginPolicy.http.byPlugin`) was
 * consented to for that package. Removing it closes the host — for the
 * children it takes too — and leaves every other entry, the shared allowlist
 * and the rest of the file as they were.
 */
test('remove closes the hosts opened to the plugin and the children it takes, never anyone else\'s', async () => {
  const f = fixture();
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  const before = readJson(f.config);
  writeFileSync(f.config, JSON.stringify({
    ...before,
    daemon: { port: 4242 },
    pluginPolicy: {
      exec: { allow: ['rsync'] },
      http: {
        allow: ['shared.example'],
        connectionApproval: 'owner',
        byPlugin: {
          'example-bundle': ['api.bundle.example'],
          'example-page': ['api.page.example'],
          'example-widget': ['api.widget.example'],
          'someone-else': ['api.else.example'],
        },
      },
    },
  }, null, 2));

  const removed = await removePlugin('example-bundle', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.httpHosts.sort(), ['example-bundle/api.bundle.example', 'example-page/api.page.example']);
  const after = readJson(f.config);
  const policy = after.pluginPolicy as { exec: Json; http: Json };
  assert.deepEqual(policy.http.byPlugin, {
    'example-widget': ['api.widget.example'],
    'someone-else': ['api.else.example'],
  }, 'a pre-existing child and a stranger keep theirs');
  assert.deepEqual(policy.http.allow, ['shared.example'], 'the shared allowlist is not touched');
  assert.equal(policy.http.connectionApproval, 'owner');
  assert.deepEqual(policy.exec, { allow: ['rsync'] });
  assert.deepEqual(after.daemon, { port: 4242 });

  const alone = await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(alone.httpHosts, ['example-widget/api.widget.example']);
  assert.deepEqual((readJson(f.config).pluginPolicy as { http: Json }).http.byPlugin, { 'someone-else': ['api.else.example'] });
  cleanup(f);
});

test('remove with no byPlugin entry leaves the configuration file byte for byte', async () => {
  const f = fixture();
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  const before = readFileSync(f.config, 'utf8');
  const removed = await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.httpHosts, []);
  assert.equal(readFileSync(f.config, 'utf8'), before);
  cleanup(f);
});

/** On the operator's own file, this process stops honouring the entry at once (no restart). */
test('remove on the live configuration file closes the host in this process too', async () => {
  const { CONFIG_FILE, config, setConfig, resetConfig } = await import('../config/load.js');
  const { TimonConfigSchema } = await import('../config/schema.js');
  const { assertFetchAllowed, PluginPolicyError } = await import('./policy.js');
  const f = fixture();
  const saved = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  try {
    await addPlugin(WIDGET, f.root, { npm: f.npm, config: CONFIG_FILE });
    const onDisk = existsSync(CONFIG_FILE) ? readJson(CONFIG_FILE) : {};
    const policy = { http: { byPlugin: { 'example-widget': ['api.widget.example'], other: ['api.other.example'] } } };
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...onDisk, pluginPolicy: policy }, null, 2));
    setConfig(TimonConfigSchema.parse({ pluginPolicy: policy }));
    assertFetchAllowed('example-widget', 'https://api.widget.example/');

    await removePlugin('example-widget', f.root, { npm: f.npm, config: CONFIG_FILE });
    assert.throws(() => assertFetchAllowed('example-widget', 'https://api.widget.example/'), PluginPolicyError);
    assertFetchAllowed('other', 'https://api.other.example/');
    assert.deepEqual(config().pluginPolicy.http.byPlugin, { other: ['api.other.example'] });
  } finally {
    if (saved === null) rmSync(CONFIG_FILE, { force: true }); else writeFileSync(CONFIG_FILE, saved);
    resetConfig();
    cleanup(f);
  }
});

/**
 * TODO #664: `user_connections` is indexed by the plugin id, and `ctx.fetch` opens
 * an approved origin to whoever holds it, private network included. These tests
 * keep a handle open on the real file, as the daemon does while the CLI removes.
 */
const connectionOwner = (pluginIds: string[]): string => {
  const id = randomUUID();
  createTestAccount(dbApi, { id, email: `${id}@example.test`, name: id, passwordHash: 'unused', status: 'active' });
  grantTestPermissions(dbApi, id, pluginIds.map((pluginId) => `plugin:${pluginId}`));
  return id;
};

/**
 * Closed by `t.after`, not at the end of the test: a test that fails before
 * its last line would leave the real `integrations.db` open, and Windows then
 * refuses every later test that renames or deletes it (EBUSY).
 */
function daemonConnections(t: TestContext) {
  const store = new IntegrationStore(INTEGRATIONS_DB_PATH);
  t.after(() => store.close());
  const connections = new UserConnectionStore(store.db);
  const service = new UserConnectionService(connections, daemonUserConnectionHost());
  const admin = { userId: 'test-admin', isAdmin: true };
  const seed = (pluginId: string, ownerUserId: string, origin: string, approval: 'approved' | 'pending' | 'rejected' = 'approved') => {
    const id = randomUUID();
    connections.insert({
      id, pluginId, type: `${pluginId}:gateway@1`, identity: { ownerUserId } as StoredUserConnection['identity'], label: 'Gateway',
      url: `${origin}/v1`, origin, allowPrivateNetwork: true, config: {}, secrets: ['apiKey'], approval, enabled: true, revision: 1,
      approvedBy: approval === 'approved' ? 'test-admin' : null, approvedAt: approval === 'approved' ? 1 : null, createdAt: 1, updatedAt: 1,
    });
    daemonUserConnectionHost().writeSecret(pluginId, `@connections/${id}/apiKey`, `key-of-${id}`);
    return id;
  };
  return { service, connections, seed, admin };
}

test('remove sends the connections of the plugin and the children it takes back to approval, keys deleted', async (t) => {
  const f = fixture();
  const daemon = daemonConnections(t);
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  const owner = connectionOwner(['example-bundle', 'example-page', 'example-widget', 'someone-else']);
  const bundle = daemon.seed('example-bundle', owner, 'https://bundle.example');
  const page = daemon.seed('example-page', owner, 'https://page.example');
  const waiting = daemon.seed('example-page', owner, 'https://waiting.example', 'pending');
  const refused = daemon.seed('example-page', owner, 'https://refused.example', 'rejected');
  const widget = daemon.seed('example-widget', owner, 'https://widget.example');
  const stranger = daemon.seed('someone-else', owner, 'https://page.example');
  assert.deepEqual(daemon.service.destination('example-page', new URL('https://page.example/x')), { allowPrivateNetwork: true });
  assert.equal(daemon.service.secret('example-page', owner, page, 'apiKey'), `key-of-${page}`);

  const removed = await removePlugin('example-bundle', f.root, { npm: f.npm, config: f.config });

  assert.deepEqual(removed.connectionsFailed, []);
  assert.deepEqual(removed.connections.sort(), [
    `example-bundle/${bundle}`, `example-page/${page}`, `example-page/${waiting}`, `example-page/${refused}`,
  ].sort());
  for (const [plugin, id, origin] of [['example-bundle', bundle, 'https://bundle.example'], ['example-page', page, 'https://page.example']] as const) {
    const row = daemon.connections.get(id);
    assert.equal(row?.approval, 'pending', `${plugin} waits for a new approval`);
    assert.equal(row?.approvedBy, null);
    assert.equal(row?.approvedAt, null);
    assert.deepEqual(row?.secrets, []);
    assert.equal(row?.revision, 2, 'an edit in flight fails instead of restoring the row');
    assert.equal(row?.url, `${origin}/v1`, 'the connection itself stays, it is its owner\'s');
    assert.equal(row?.enabled, true);
    assert.equal(daemon.service.destination(plugin, new URL(`${origin}/x`)), undefined);
  }
  assert.equal(daemon.connections.get(refused)?.approval, 'rejected', 'a refusal stays a refusal');
  assert.deepEqual(dbApi.pluginKvList('example-page', '@connections/'), [], 'no sealed key is left behind');
  assert.deepEqual(dbApi.pluginKvList('example-bundle', '@connections/'), []);

  // A pre-existing child and a stranger on the same origin keep theirs.
  assert.equal(daemon.connections.get(widget)?.approval, 'approved');
  assert.equal(daemon.service.secret('example-widget', owner, widget, 'apiKey'), `key-of-${widget}`);
  assert.deepEqual(daemon.service.destination('someone-else', new URL('https://page.example/x')), { allowPrivateNetwork: true });
  assert.equal(daemon.service.secret('someone-else', owner, stranger, 'apiKey'), `key-of-${stranger}`);

  cleanup(f);
});

test('the same id reinstalled is refused towards the old origin and reads no key, until someone approves it', async (t) => {
  const f = fixture();
  const daemon = daemonConnections(t);
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  const owner = connectionOwner(['example-widget']);
  const id = daemon.seed('example-widget', owner, 'https://reinstall.example');
  await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });

  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });

  assert.equal(daemon.service.destination('example-widget', new URL('https://reinstall.example/x')), undefined);
  await assert.rejects(daemon.service.fetch('example-widget', 'https://reinstall.example/x'), DestinationRefusedError);
  assert.equal(daemon.service.secret('example-widget', owner, id, 'apiKey'), undefined);
  assert.deepEqual(daemon.service.forUser('example-widget', owner).map((c) => [c.id, c.approval, c.secrets]), [[id, 'pending', []]]);
  await assert.rejects(daemon.service.test({ userId: owner, isAdmin: false }, id), /not approved/);

  // Approving is a person looking at it again; the old key does not come back with it.
  daemon.service.decide(daemon.admin, id, 'approved');
  assert.deepEqual(daemon.service.destination('example-widget', new URL('https://reinstall.example/x')), { allowPrivateNetwork: true });
  assert.equal(daemon.service.secret('example-widget', owner, id, 'apiKey'), undefined);

  await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
  cleanup(f);
});

test('remove of a user copy of a built-in leaves the connections the built-in still serves', async (t) => {
  const f = fixture();
  const daemon = daemonConnections(t);
  await addPlugin(QUOTA, f.root, { npm: f.npm, config: f.config });
  const owner = connectionOwner(['quota-monitor']);
  const id = daemon.seed('quota-monitor', owner, 'https://builtin.example');
  const removed = await removePlugin('quota-monitor', f.root, { npm: f.npm, config: f.config, builtins });
  assert.deepEqual(removed.connections, []);
  assert.equal(daemon.connections.get(id)?.approval, 'approved');
  assert.equal(daemon.service.secret('quota-monitor', owner, id, 'apiKey'), `key-of-${id}`);
  cleanup(f);
});

test('withdrawing never creates the connection file, and an unreadable one still loses its keys and reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-withdraw-'));
  const file = join(dir, 'integrations.db');
  const sealed = '@connections/orphan/apiKey';
  dbApi.pluginKvSet('withdraw-witness', sealed, 'sealed');
  assert.deepEqual(withdrawPluginUserConnections('withdraw-witness', file), []);
  assert.equal(existsSync(file), false);
  assert.equal(dbApi.pluginKvGet('withdraw-witness', sealed), undefined, 'a key no row lists goes too');

  // Not a connection key: the plugin's own storage and settings stay, as promised.
  dbApi.pluginKvSet('withdraw-witness', 'own-data', '1');
  dbApi.pluginKvSet('withdraw-witness', sealed, 'sealed');
  writeFileSync(file, 'this is not a sqlite database, not even close'.repeat(100));
  assert.throws(() => withdrawPluginUserConnections('withdraw-witness', file));
  assert.equal(dbApi.pluginKvGet('withdraw-witness', sealed), undefined);
  assert.equal(dbApi.pluginKvGet('withdraw-witness', 'own-data'), '1');
  dbApi.pluginKvClear('withdraw-witness');
  rmSync(dir, { recursive: true, force: true });
});

test('remove says when it could not reach the connections, and still finishes', async () => {
  const f = fixture();
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  dbApi.pluginKvSet('example-widget', '@connections/unreachable/apiKey', 'sealed');
  const aside = `${INTEGRATIONS_DB_PATH}.aside`;
  renameSync(INTEGRATIONS_DB_PATH, aside);
  try {
    writeFileSync(INTEGRATIONS_DB_PATH, 'this is not a sqlite database, not even close'.repeat(100));
    const removed = await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
    assert.equal(removed.connectionsFailed.length, 1);
    assert.match(removed.connectionsFailed[0]!, /^example-widget: /);
    assert.deepEqual(removed.connections, []);
    assert.deepEqual(inventory(f.root, f.config, []).map((p) => p.id), [], 'the package still left');
    assert.equal(dbApi.pluginKvGet('example-widget', '@connections/unreachable/apiKey'), undefined);
  } finally {
    renameSync(aside, INTEGRATIONS_DB_PATH);
  }
  cleanup(f);
});

/**
 * TODO #663: `pluginPolicy.spawn.approved` lets an id spend the machine's AI
 * subscriptions, `pluginPolicy.kanban.projects[<id>]` lets its jobs read tasks.
 * Both name the id, not the package. Removing it withdraws them — for the
 * children it takes too — and touches nobody else's.
 */
test('remove withdraws the mission approval and Kanban grants of the plugin and the children it takes, never anyone else\'s', async () => {
  const f = fixture();
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  const before = readJson(f.config);
  writeFileSync(f.config, JSON.stringify({
    ...before,
    daemon: { port: 4242 },
    pluginPolicy: {
      spawn: { max: 3, windowMs: 1000, approved: ['example-bundle', 'someone-else', 'example-page', 'example-widget'] },
      exec: { allow: ['rsync'] },
      kanban: {
        projects: {
          'example-bundle': ['alpha', 'beta'],
          'example-page': ['gamma'],
          'example-widget': ['delta'],
          'someone-else': ['epsilon'],
        },
      },
      http: { allow: ['shared.example'] },
    },
  }, null, 2));

  const removed = await removePlugin('example-bundle', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.spawnApprovals.sort(), ['example-bundle', 'example-page']);
  assert.deepEqual(removed.kanbanProjects.sort(), ['example-bundle/alpha', 'example-bundle/beta', 'example-page/gamma']);
  const after = readJson(f.config);
  const policy = after.pluginPolicy as { spawn: Json; exec: Json; kanban: Json; http: Json };
  assert.deepEqual(policy.spawn, { max: 3, windowMs: 1000, approved: ['someone-else', 'example-widget'] }, 'a pre-existing child and a stranger stay approved, the quota is not touched');
  assert.deepEqual(policy.kanban.projects, { 'example-widget': ['delta'], 'someone-else': ['epsilon'] });
  assert.deepEqual(policy.exec, { allow: ['rsync'] });
  assert.deepEqual(policy.http, { allow: ['shared.example'] });
  assert.deepEqual(after.daemon, { port: 4242 });

  const alone = await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(alone.spawnApprovals, ['example-widget']);
  assert.deepEqual(alone.kanbanProjects, ['example-widget/delta']);
  const last = readJson(f.config).pluginPolicy as { spawn: Json; kanban: Json };
  assert.deepEqual(last.spawn.approved, ['someone-else']);
  assert.deepEqual(last.kanban.projects, { 'someone-else': ['epsilon'] });
  cleanup(f);
});

test('remove of a plugin the policy does not name leaves the configuration file byte for byte', async () => {
  const f = fixture();
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  const cfg = readJson(f.config);
  // An id that only starts like the removed one is another plugin.
  cfg.pluginPolicy = { spawn: { approved: ['example-widget-2'] }, kanban: { projects: { 'example-widget-2': ['alpha'] } } };
  writeFileSync(f.config, JSON.stringify(cfg));
  const before = readFileSync(f.config, 'utf8');
  const removed = await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.spawnApprovals, []);
  assert.deepEqual(removed.kanbanProjects, []);
  assert.equal(readFileSync(f.config, 'utf8'), before);
  cleanup(f);
});

/**
 * The refusal itself, in the process that removed it — the case a test of the
 * file alone would not see: the package reinstalled under the same id is refused
 * and raises a card of its own, as a plugin nobody approved must.
 */
test('the same id installed again is refused missions and Kanban until someone approves it', async () => {
  const { CONFIG_FILE, setConfig, resetConfig } = await import('../config/load.js');
  const { TimonConfigSchema } = await import('../config/schema.js');
  const { assertSpawnAllowed, grantedKanbanProjects, PluginPolicyError, resetPluginPolicyState, spawnCardsSettled } = await import('./policy.js');
  const { dbApi } = await import('../db.js');
  const f = fixture();
  const saved = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  resetPluginPolicyState();
  try {
    await addPlugin(WIDGET, f.root, { npm: f.npm, config: CONFIG_FILE });
    const onDisk = existsSync(CONFIG_FILE) ? readJson(CONFIG_FILE) : {};
    const policy = { spawn: { approved: ['example-widget', 'other'] }, kanban: { projects: { 'example-widget': ['alpha'], other: ['beta'] } } };
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...onDisk, pluginPolicy: policy }, null, 2));
    setConfig(TimonConfigSchema.parse({ pluginPolicy: policy }));
    assertSpawnAllowed('example-widget');
    assert.deepEqual(grantedKanbanProjects('example-widget'), ['alpha']);

    await removePlugin('example-widget', f.root, { npm: f.npm, config: CONFIG_FILE });
    await addPlugin(WIDGET, f.root, { npm: f.npm, config: CONFIG_FILE });

    assert.throws(() => assertSpawnAllowed('example-widget'), PluginPolicyError);
    assert.deepEqual(grantedKanbanProjects('example-widget'), []);
    assertSpawnAllowed('other');
    assert.deepEqual(grantedKanbanProjects('other'), ['beta']);
    await spawnCardsSettled();
    assert.ok(dbApi.listActiveNotifications('action_required').some((n) => n.anchor === 'plugin-spawn:example-widget'), 'a card of its own, naming the approval it lacks');
  } finally {
    if (saved === null) rmSync(CONFIG_FILE, { force: true }); else writeFileSync(CONFIG_FILE, saved);
    resetConfig();
    resetPluginPolicyState();
    cleanup(f);
  }
});

/**
 * Both cards offer the operator a way to re-arm the id: approve it to spawn,
 * authorize its program. Left open, a click grants the next package under that id.
 */
test('remove closes the spawn and launch cards of the plugin and the children it takes, never anyone else\'s', async () => {
  const { assertSpawnApproved, resetPluginPolicyState, spawnCardsSettled, PluginPolicyError } = await import('./policy.js');
  const { launchCardAnchor, launchCardsSettled, raiseLaunchCard, resetLaunchCards } = await import('../backends/launch-card.js');
  const { setConfig, config, resetConfig } = await import('../config/load.js');
  const { TimonConfigSchema } = await import('../config/schema.js');
  const { dbApi } = await import('../db.js');
  const active = () => dbApi.listActiveNotifications('action_required').map((n) => n.anchor);
  const f = fixture();
  const previous = config();
  resetPluginPolicyState();
  resetLaunchCards();
  try {
    setConfig(TimonConfigSchema.parse({}));
    await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
    await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
    for (const id of ['example-bundle', 'example-page', 'example-widget', 'example-page-2']) {
      assert.throws(() => assertSpawnApproved(id), PluginPolicyError);
      raiseLaunchCard(id, `backend-${id}`, 'Its program moved.');
    }
    await spawnCardsSettled();
    await launchCardsSettled();

    await removePlugin('example-bundle', f.root, { npm: f.npm, config: f.config });
    const open = active();
    for (const id of ['example-bundle', 'example-page']) {
      assert.ok(!open.includes(`plugin-spawn:${id}`), `${id}: spawn card closed`);
      assert.ok(!open.includes(launchCardAnchor(id)), `${id}: launch card closed`);
    }
    for (const id of ['example-widget', 'example-page-2']) {
      assert.ok(open.includes(`plugin-spawn:${id}`), `${id}: spawn card stays`);
      assert.ok(open.includes(launchCardAnchor(id)), `${id}: launch card stays`);
    }

    // A reinstall's first refusal is a new request, not one already carded.
    assert.throws(() => assertSpawnApproved('example-bundle'), PluginPolicyError);
    raiseLaunchCard('example-bundle', 'backend-example-bundle', 'Its program moved.');
    await spawnCardsSettled();
    await launchCardsSettled();
    const again = active();
    assert.ok(again.includes('plugin-spawn:example-bundle'), 'the spawn card is raised again');
    assert.ok(again.includes(launchCardAnchor('example-bundle')), 'the launch card is raised again');
  } finally {
    for (const n of dbApi.listActiveNotifications('action_required')) dbApi.dismissNotification(n.id);
    resetConfig();
    setConfig(previous);
    resetPluginPolicyState();
    resetLaunchCards();
    cleanup(f);
  }
});

/**
 * The real shape of the hole: the CLI edits the file, the DAEMON holds the copy
 * it read at boot, and its watcher runs a pass on that change. A package mounted
 * by that pass under the same id must already be refused.
 */
test('a daemon in another process follows the file: the pass that sees the removal withdraws the grants', async () => {
  const { CONFIG_FILE, setConfig, resetConfig } = await import('../config/load.js');
  const { TimonConfigSchema } = await import('../config/schema.js');
  const { assertFetchAllowed, assertSpawnApproved, grantedKanbanProjects, narrowLivePluginGrants, PluginPolicyError, resetPluginPolicyState } = await import('./policy.js');
  const f = fixture();
  const saved = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const policy = {
    spawn: { approved: ['example-widget', 'other'] },
    kanban: { projects: { 'example-widget': ['alpha'], other: ['beta'] } },
    http: { byPlugin: { 'example-widget': ['api.widget.example'], other: ['api.other.example'] } },
  };
  const ctx = new Context();
  resetPluginPolicyState();
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify({ pluginPolicy: policy }, null, 2));
    await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
    // Removing against a copy of the file is what keeps THIS process out of it:
    // its live config stands for the daemon's.
    writeFileSync(f.config, readFileSync(CONFIG_FILE, 'utf8'));
    await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
    setConfig(TimonConfigSchema.parse({ pluginPolicy: policy }));
    assert.doesNotThrow(() => assertSpawnApproved('example-widget'), 'the daemon still holds its boot copy');

    writeFileSync(CONFIG_FILE, readFileSync(f.config, 'utf8'));
    const loader = new PluginLoader(ctx, {
      dir: f.root,
      host: daemonHost(ctx),
      plugins: () => ({}),
      allowUnsigned: () => true,
      beforePass: () => narrowLivePluginGrants(),
    });
    await loader.update();

    assert.throws(() => assertSpawnApproved('example-widget'), PluginPolicyError);
    assert.deepEqual(grantedKanbanProjects('example-widget'), []);
    assert.throws(() => assertFetchAllowed('example-widget', 'https://api.widget.example/'), PluginPolicyError);
    assert.doesNotThrow(() => assertSpawnApproved('other'));
    assert.deepEqual(grantedKanbanProjects('other'), ['beta']);
    assert.doesNotThrow(() => assertFetchAllowed('other', 'https://api.other.example/'));
    await loader.dispose();
  } finally {
    await ctx.fiber.dispose();
    if (saved === null) rmSync(CONFIG_FILE, { force: true }); else writeFileSync(CONFIG_FILE, saved);
    resetConfig();
    resetPluginPolicyState();
    cleanup(f);
  }
});

/** No test boots the real daemon: without this wiring, every test above passes and the hole stays open. */
test('the daemon narrows its live grants on every pass and closes the cards of a package gone from disk', () => {
  const boot = readFileSync(new URL('../kernel-boot.ts', import.meta.url), 'utf8');
  assert.match(boot, /beforePass: \(\) => \{ narrowLivePluginGrants\(\); narrowLiveDeveloperMode\(\); \}/);
  const onRemoved = /onRemoved: \(id\) => \{([^}]*)\}/.exec(boot)?.[1] ?? '';
  for (const close of ['closePluginSecretCards(id)', 'closePluginSpawnCards(id)', 'closePluginLaunchCard(id)']) {
    assert.ok(onRemoved.includes(close), `${close} is not called by onRemoved`);
  }
});

test('a child reinstalled by hand survives the removal of the bundle', async () => {
  const f = fixture();
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  assert.equal(pluginProvenance('example-widget', f.config), 'example-bundle');

  // `timon plugin add` of the widget: it becomes its own owner.
  await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  assert.equal(pluginProvenance('example-widget', f.config), null);

  const removed = await removePlugin('example-bundle', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.children, ['example-page']);
  assert.deepEqual(inventory(f.root, f.config, []).map((p) => p.id), ['example-widget']);
  cleanup(f);
});

test('a local bundle unfolds its children even if npm did not hoist the file: entries', async () => {
  // What `npm install ./examples/plugin-bundle` really does: the bundle
  // package is linked, its `file:../plugin-page` do NOT rise to the top
  // level. The old fakeNpm copied them, and the gap only existed
  // against a real npm.
  const f = fixture();
  const shallow: NpmRunner = async (args, cwd) => {
    const root = args[args.indexOf('--prefix') + 1] ?? cwd;
    const spec = args[args.length - 1] as string;
    const pkgFile = join(root, 'package.json');
    const pkg = existsSync(pkgFile) ? readJson(pkgFile) : {};
    const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};
    if (args[0] === 'install') {
      const source = isAbsolute(spec) ? spec : resolve(spec);
      const json = readJson(join(source, 'package.json'));
      const name = json.name as string;
      const dest = join(root, 'node_modules', name);
      mkdirSync(dirname(dest), { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      cpSync(source, dest, { recursive: true });
      deps[name] = `file:${spec}`;
    } else {
      delete deps[spec];
      rmSync(join(root, 'node_modules', spec), { recursive: true, force: true });
    }
    pkg.dependencies = deps;
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  };

  const res = await addPlugin(BUNDLE, f.root, { npm: shallow, config: f.config });
  assert.deepEqual(
    res.children.map((c) => [c.id, c.state]).sort(),
    [['example-page', 'installed'], ['example-widget', 'installed']],
  );
  const deps = Object.keys((readJson(join(f.root, 'package.json')).dependencies as Json) ?? {});
  assert.ok(deps.includes('@timon-ai/plugin-page'), deps.join(', '));
  assert.ok(deps.includes('@timon-ai/plugin-widget'), deps.join(', '));
  assert.equal(pluginProvenance('example-page', f.config), 'example-bundle');
  cleanup(f);
});

test('an ordinary plugin unfolds nothing', async () => {
  const f = fixture();
  const res = await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(res.children, []);
  const removed = await removePlugin('example-widget', f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.children, []);
  cleanup(f);
});

/**
 * The "cancel" path of the CLI: `timon plugin add` installs first (the
 * requested permissions live in the package), asks next, and calls
 * `removePlugin(result.pkg)` again on a refusal. The removal therefore goes through the NPM
 * NAME, and must take the children away as if it had been asked by id.
 */
test('cancelling a bundle add also removes what it had just brought', async () => {
  const f = fixture();
  const res = await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  const removed = await removePlugin(res.pkg, f.root, { npm: f.npm, config: f.config });
  assert.deepEqual(removed.children.sort(), ['example-page', 'example-widget']);
  assert.deepEqual(inventory(f.root, f.config, []), []);
  assert.equal(pluginProvenance('example-widget', f.config), null);
  cleanup(f);
});

/* ── Admission at install time (audit finding #5) ────────────────────────── */

/**
 * `--ignore-scripts` on EVERY npm call, the bundle's children included.
 *
 * A lifecycle script runs as the operator, at install time — before anything
 * has verified the package's signature. Without the flag, the signature
 * protected only the load path, which a hostile package never has to take.
 */
test('npm is called with --ignore-scripts, the children included', async () => {
  const f = fixture();
  await addPlugin(BUNDLE, f.root, { npm: f.npm, config: f.config });
  const installs = f.calls.filter((args) => args[0] === 'install');
  assert.ok(installs.length >= 3, `expected bundle + 2 children, got ${installs.length}`);
  for (const args of installs) {
    assert.ok(args.includes('--ignore-scripts'), `without --ignore-scripts: ${args.join(' ')}`);
  }
  cleanup(f);
});

function ephemeralKey() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    accepted: [{ keyId: 'test-ephemeral', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  };
}

/**
 * A signable copy of an example package, outside the repository tree.
 *
 * The whole `examples/` folder is copied, not just the package: the
 * `file:` dependencies of a bundle are relative to its neighbours, and cutting them
 * would make the install fail before the check under test.
 */
function signedCopy(source: string, privateKey: ReturnType<typeof ephemeralKey>['privateKey']): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-signed-'));
  cpSync(EXAMPLES, join(home, 'examples'), { recursive: true });
  const dir = join(home, 'examples', source.slice(EXAMPLES.length + 1));
  const hash = hashPluginDirectory(dir);
  writeFileSync(join(dir, 'SIGNATURE'), JSON.stringify({
    alg: 'ed25519', keyId: 'test-ephemeral', hash,
    sig: signCrypto(null, Buffer.from(hash, 'hex'), privateKey).toString('base64'),
  }));
  return dir;
}

test('a signed package is installed and its signature reported', async () => {
  const f = fixture();
  const key = ephemeralKey();
  const dir = signedCopy(WIDGET, key.privateKey);
  const res = await addPlugin(dir, f.root, { npm: f.npm, config: f.config, publicKeys: key.accepted });
  assert.equal(res.refused, null);
  assert.deepEqual(res.signature, { ok: true, keyId: 'test-ephemeral' });
  rmSync(dirname(dirname(dir)), { recursive: true, force: true });
  cleanup(f);
});

/** A signature that no longer covers the files: never a work in
 *  progress, always a package that lies. Refused, and not unfolded. */
test('a tampered package is refused at install', async () => {
  const f = fixture();
  const key = ephemeralKey();
  const dir = signedCopy(BUNDLE, key.privateKey);
  writeFileSync(join(dir, 'index.js'), '// injecté après signature\n'); // french-ok: sample file content
  const res = await addPlugin(dir, f.root, { npm: f.npm, config: f.config, publicKeys: key.accepted });
  assert.equal(res.refused, 'skipped:tampered');
  assert.deepEqual(res.children, []);
  assert.equal(pluginProvenance('example-widget', f.config), null);
  rmSync(dirname(dirname(dir)), { recursive: true, force: true });
  cleanup(f);
});

/** Without a SIGNATURE, the install reports the gap without refusing it: the
 *  loader decides whether to mount it or not (developer mode). */
test('an unsigned package is installed but reported as such', async () => {
  const f = fixture();
  const res = await addPlugin(WIDGET, f.root, { npm: f.npm, config: f.config });
  assert.equal(res.refused, null);
  assert.deepEqual(res.signature, { ok: false, code: 'unsigned', message: 'SIGNATURE absent' });
  cleanup(f);
});

// ── Built-in plugins: disable-only ──────────────────────────────────────────

const QUOTA = join(EXAMPLES, 'plugin-quota-monitor');
const QUOTA_PKG = '@timon-ai/plugin-quota-monitor';
const builtins = [{ pkg: QUOTA_PKG, dir: QUOTA, trust: { ok: true as const } }];

test('remove refuses a built-in, by id or npm name, and names `disable`', async () => {
  const f = fixture();
  for (const name of ['quota-monitor', QUOTA_PKG]) {
    await assert.rejects(
      removePlugin(name, f.root, { npm: f.npm, config: f.config, builtins }),
      /built into Timon and cannot be removed — disable it instead: timon plugin disable quota-monitor/,
    );
  }
  assert.deepEqual(f.calls, [], 'npm is never called');
  cleanup(f);
});

test('remove takes out a user copy of a built-in, never the built-in', async () => {
  const f = fixture();
  await addPlugin(QUOTA, f.root, { npm: f.npm, config: f.config });
  const removed = await removePlugin('quota-monitor', f.root, { npm: f.npm, config: f.config, builtins });
  assert.equal(removed.pkg, QUOTA_PKG);
  assert.ok(existsSync(join(QUOTA, 'package.json')), 'the built-in files are untouched');
  await assert.rejects(removePlugin('quota-monitor', f.root, { npm: f.npm, config: f.config, builtins }), /built into Timon/);
  cleanup(f);
});

test('`timon plugin list` shows the built-in, flagged, next to a user copy it shadows', async () => {
  const f = fixture();
  await addPlugin(QUOTA, f.root, { npm: f.npm, config: f.config });
  const items = inventory(f.root, f.config, builtins);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.id, 'quota-monitor');
  assert.equal(items[0]?.builtin, true);
  assert.equal(items[1]?.refused, 'skipped:duplicate-id');
  assert.equal(items[1]?.builtin, undefined);
  cleanup(f);
});

test('a relative local spec reaches npm as an absolute path (npm runs from the plugins root)', async () => {
  const f = fixture();
  const relativeSpec = `./${relative(process.cwd(), WIDGET)}`;
  assert.ok(!isAbsolute(relativeSpec));
  await addPlugin(relativeSpec, f.root, { npm: f.npm, config: f.config });
  const installed = f.calls.find((c) => c[0] === 'install')!;
  assert.equal(installed[installed.length - 1], WIDGET, 'resolved against the caller\'s directory, not the plugins root');
});

/**
 * A folder picked on Windows arrives as `C:\…`, `\\server\share\…` or `..\…`.
 * Read as a registry name, it lost its source folder: a bundle's `file:`
 * children were resolved against the `node_modules` copy and stayed
 * unresolved, and a local plugin installed again found "no new package".
 * Both grammars are recognised on every system, so these cases run here too.
 */
test('a local spec is recognised in the Windows and POSIX forms, and an npm spec never is', () => {
  const local = [
    'C:\\Users\\someone\\plugins\\plugin-bundle', 'C:/Users/someone/plugins/plugin-bundle', 'd:\\plugins\\x',
    '\\\\server\\share\\plugins\\x', '\\\\?\\C:\\plugins\\x', '\\plugins\\x',
    '.\\plugin-bundle', '..\\plugin-page', '.', '..',
    './plugin-bundle', '../plugin-page', '/opt/plugins/x',
    'file:C:\\plugins\\x', 'file:../plugin-page', 'file:/opt/plugins/x',
  ];
  for (const spec of local) {
    assert.equal(isLocalSpec(spec), true, spec);
    assert.equal(registryPackageName(spec), null, spec);
  }
  // npm's own grammars, and the drive-relative forms Windows does not read as a folder.
  const notLocal = [
    'plugin-hello', '@timon-ai/plugin-widget', 'plugin-hello@1.2.3', '@timon-ai/plugin-widget@^1',
    'plugin-hello@latest', 'github:acme/plugin', 'acme/plugin', 'acme/plugin#main',
    'git+https://github.com/acme/plugin.git', 'https://example.com/plugin-1.0.0.tgz', 'npm:plugin-hello@1',
    'C:', 'C:plugins', '.plugin', '..plugin',
  ];
  for (const spec of notLocal) assert.equal(isLocalSpec(spec), false, spec);
});
