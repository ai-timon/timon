/**
 * Installing a plugin from the gallery (TODO #332), through the real routes:
 * only a superadmin signed in to the app gets in; the preview reads the
 * manifest and the signature without running anything and never hands back a
 * path; the confirmation is what installs, through `addPlugin`; an altered
 * package or an archive escaping its folder never reaches npm. A `.zip`
 * (TODO #345) takes the same road as a picked folder, under the same rules.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign as signCrypto } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, sep } from 'node:path';
import express from 'express';
import type { RequestAuth } from '../../users/identity.js';
import type { NpmRunner } from '../../plugins/install.js';

const { dbApi } = await import('../../db.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBodyParser } = await import('../../kernel/body-parser.js');
const { registerRoutes } = await import('./routes.js');
const { attachPluginInstallSources } = await import('./install-routes.js');
const { PluginInstallSources, PluginSourceError } = await import('../../plugins/install-sources.js');
const { hashPluginDirectory } = await import('../../plugins/signature.js');
const { buildTarGz, extractTarGz } = await import('../../plugins/tar-reader.js');
const { buildZip } = await import('../../providers/acp-registry/archive-fixtures.js');
const { TIMON_HOME } = await import('../../paths.js');

const DAEMON = 'daemon-install-token';
function user(name: string, superadmin: boolean) {
  const id = randomUUID();
  return createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'x', isSuperadmin: superadmin });
}
const admin = user('admin', true);
const bob = user('bob', false);
const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  bob: { kind: 'session', user: bob, isSuperadmin: false, permissions: ['plugins:manage'] },
  mission: { kind: 'api-token', user: admin, isSuperadmin: true, missionId: 'm-1' },
};

// ── Ed25519 test key ──────────────────────────────────────────────────────
const pair = generateKeyPairSync('ed25519');
const KEYS = [{ keyId: 'test-install', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
function sign(dir: string): void {
  const hash = hashPluginDirectory(dir);
  writeFileSync(join(dir, 'SIGNATURE'), JSON.stringify({
    alg: 'ed25519', keyId: 'test-install', hash, sig: signCrypto(null, Buffer.from(hash, 'hex'), pair.privateKey).toString('base64'),
  }));
}

// ── Packages on the "PC" (outside the Timon home) ─────────────────────────
const PC = mkdtempSync(join(tmpdir(), 'timon-pc-'));
let serial = 0;
function pluginFolder(opts: { signed?: boolean; name?: string; id?: string; timon?: Record<string, unknown> } = {}): string {
  const n = ++serial;
  const dir = join(PC, `plugin-${n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: opts.name ?? `@acme/demo-${n}`,
    version: '1.2.3',
    main: 'index.js',
    timon: {
      id: opts.id ?? `acme-demo-${n}`, apiVersion: 1, kind: 'behavior', label: `Demo ${n}`,
      description: 'A demo plugin', author: 'Acme', icon: 'icon.svg', permissions: ['usage:read'],
      ...opts.timon,
    },
  }));
  writeFileSync(join(dir, 'index.js'), 'throw new Error("must never run during a preview");\n');
  writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
  if (opts.signed !== false) sign(dir);
  return dir;
}
function tgzOf(dir: string): Buffer {
  const files: Array<{ path: string; data: Buffer }> = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push({ path: `package/${relative(dir, p).split(sep).join('/')}`, data: readFileSync(p) });
    }
  };
  walk(dir);
  return buildTarGz(files);
}
/** As GitHub or the Finder zip a folder: one top folder; `finder` adds its metadata. */
function zipOf(dir: string, opts: { top?: string; finder?: boolean } = {}): Buffer {
  const top = opts.top ?? 'my-plugin';
  const files: Array<{ path: string; data?: Buffer }> = [{ path: `${top}/` }];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push({ path: `${top}/${relative(dir, p).split(sep).join('/')}`, data: readFileSync(p) });
    }
  };
  walk(dir);
  if (opts.finder) {
    files.push({ path: `${top}/.DS_Store`, data: Buffer.from('finder') }, { path: '__MACOSX/' }, { path: `__MACOSX/${top}/._index.js`, data: Buffer.from('fork') });
  }
  return buildZip(files);
}

// ── Fake npm: does what npm does to the tree, records what it was asked ───
const PLUGINS = join(mkdtempSync(join(tmpdir(), 'timon-plugins-root-')), 'plugins');
const STAGING = mkdtempSync(join(tmpdir(), 'timon-staging-'));
const CONFIG = join(mkdtempSync(join(tmpdir(), 'timon-cfg-')), 'timon.config.json');
const npmCalls: string[][] = [];
const npm: NpmRunner = async (args, cwd) => {
  npmCalls.push(args);
  const root = args[args.indexOf('--prefix') + 1] ?? cwd;
  const spec = args[args.length - 1] as string;
  const pkgFile = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { dependencies?: Record<string, string> };
  const tmp = mkdtempSync(join(tmpdir(), 'npm-x-'));
  const source = spec.endsWith('.tgz') ? (extractTarGz(readFileSync(spec), tmp), tmp) : spec;
  const name = (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string }).name;
  const dest = join(root, 'node_modules', name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, '..'), { recursive: true });
  cpSync(source, dest, { recursive: true });
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: `file:${spec}` };
  writeFileSync(pkgFile, JSON.stringify(pkg));
};

const sources = new PluginInstallSources({
  pluginsRoot: PLUGINS, stagingRoot: STAGING, forbiddenRoots: [TIMON_HOME, PLUGINS],
  publicKeys: KEYS, unsignedLoads: () => false, install: { npm, config: CONFIG, publicKeys: KEYS },
  configFile: CONFIG,
});

const app = express();
attachPluginInstallSources(app, sources);
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, res, next);
});
app.use(createBodyParser());
registerRoutes(app);
const server: Server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

type Caller = 'admin' | 'bob' | 'mission' | 'daemon' | null;
async function call(method: string, path: string, body?: unknown, as: Caller = 'admin') {
  const headers: Record<string, string> = {};
  if (as === 'daemon') headers.authorization = `Bearer ${DAEMON}`;
  else if (as) headers['x-test-as'] = as;
  let payload: BodyInit | undefined;
  if (Buffer.isBuffer(body)) { headers['content-type'] = 'application/octet-stream'; payload = new Uint8Array(body); }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${base}/api/plugins/-/install${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* 204 */ }
  return { status: res.status, json, text };
}

const ROUTES: Array<[string, string, unknown]> = [
  ['GET', '/candidates', undefined],
  ['POST', '/stage', { source: 'detected', name: 'x' }],
  ['POST', '/upload', Buffer.from('x')],
  ['POST', '/confirm', { token: 'a'.repeat(48), confirm: true }],
  ['DELETE', `/staged/${'a'.repeat(48)}`, undefined],
];

test('anonymous is refused on every route (401)', async () => {
  for (const [method, path, body] of ROUTES) {
    const res = await call(method, path, body, null);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('a non-superadmin session is refused on every route (403), even with plugins:manage', async () => {
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(method, path, body, 'bob')).status, 403, `${method} ${path}`);
  }
});

test('neither the daemon token nor a superadmin mission token may install from the gallery (403)', async () => {
  for (const as of ['daemon', 'mission'] as const) {
    for (const [method, path, body] of ROUTES) {
      assert.equal((await call(method, path, body, as)).status, 403, `${as} ${method} ${path}`);
    }
  }
});

test('the install routes are not swallowed by `/api/plugins/:id`', async () => {
  const res = await call('GET', '/candidates');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.candidates));
});

test('confirm: a layout held back for White Label is installed but said not to load', async () => {
  const { setLicenseState, licenseState } = await import('../../license/runtime.js');
  const before = licenseState();
  try {
    for (const [features, ok] of [[[], false], [['whitelabel'], true]] as const) {
      setLicenseState({ ...before, features });
      const dir = pluginFolder({ timon: { kind: 'layout', client: { slots: ['root'] } } });
      const preview = await call('POST', '/upload', tgzOf(dir));
      assert.equal(preview.status, 201, preview.text);
      const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
      assert.equal(done.status, 200, done.text);
      assert.equal(done.json.ok, ok, JSON.stringify(features));
      assert.equal(done.json.refused, ok ? null : 'skipped:unlicensed');
    }
  } finally {
    setLicenseState(before);
  }
});

test('upload: a signed archive is previewed, then installed only on confirmation', async () => {
  const dir = pluginFolder();
  const before = npmCalls.length;
  const preview = await call('POST', '/upload', tgzOf(dir));
  assert.equal(preview.status, 201, preview.text);
  assert.equal(preview.json.label, `Demo ${serial}`);
  assert.equal(preview.json.author, 'Acme');
  assert.deepEqual(preview.json.permissions, ['usage:read']);
  assert.deepEqual(preview.json.signature, { state: 'signed', keyId: 'test-install' });
  assert.equal(preview.json.installable, true);
  assert.match(String(preview.json.icon), /^data:image\/svg\+xml,/);
  assert.equal(npmCalls.length, before, 'nothing is installed by a preview');
  for (const secret of [PC, PLUGINS, STAGING, TIMON_HOME]) {
    assert.ok(!preview.text.includes(secret), `the preview leaks ${secret}`);
  }

  const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.ok, true);
  assert.equal(done.json.id, `acme-demo-${serial}`);
  assert.equal(npmCalls.length, before + 1);
  const spec = npmCalls.at(-1)?.at(-1) ?? '';
  assert.ok(spec.startsWith(PLUGINS + sep) && spec.endsWith('.tgz'), 'the archive is kept in the plugins folder');
  assert.ok(npmCalls.at(-1)?.includes('--ignore-scripts'), 'the same npm flags as `timon plugin add`');

  const again = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(again.status, 404, 'a token installs once');
});

test('confirmation must say so: `confirm: true` is required', async () => {
  const preview = await call('POST', '/upload', tgzOf(pluginFolder()));
  assert.equal((await call('POST', '/confirm', { token: preview.json.token })).status, 400);
  assert.equal((await call('POST', '/confirm', { token: preview.json.token, confirm: 'yes' })).status, 400);
  assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
  assert.equal((await call('POST', '/confirm', { token: preview.json.token, confirm: true })).status, 404, 'a discarded preview is gone');
});

test('an unsigned archive is previewed as such and says it would not load', async () => {
  const preview = await call('POST', '/upload', tgzOf(pluginFolder({ signed: false })));
  assert.equal(preview.status, 201);
  assert.deepEqual(preview.json.signature, { state: 'unsigned', loads: false });
  assert.equal(preview.json.installable, true, 'installed and reported, like `timon plugin add`');
});

test('a tampered archive is blocked and never reaches npm', async () => {
  const dir = pluginFolder();
  writeFileSync(join(dir, 'index.js'), 'console.log("changed after signing")\n');
  const before = npmCalls.length;
  const preview = await call('POST', '/upload', tgzOf(dir));
  assert.equal(preview.status, 201);
  assert.deepEqual(preview.json.signature, { state: 'tampered' });
  assert.equal(preview.json.installable, false);
  assert.equal(preview.json.blocked, 'tampered');
  const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(done.status, 422);
  assert.equal(npmCalls.length, before);
});

test('a signature made with an unknown key is not "signed"', async () => {
  const dir = pluginFolder({ signed: false });
  const other = generateKeyPairSync('ed25519');
  const hash = hashPluginDirectory(dir);
  writeFileSync(join(dir, 'SIGNATURE'), JSON.stringify({ alg: 'ed25519', keyId: 'stranger', hash, sig: signCrypto(null, Buffer.from(hash, 'hex'), other.privateKey).toString('base64') }));
  const preview = await call('POST', '/upload', tgzOf(dir));
  assert.equal((preview.json.signature as { state: string }).state, 'unsigned');
});

test('zip-slip: an archive escaping its folder is refused, nothing written outside staging', async () => {
  const archive = buildTarGz([
    { path: 'package/package.json', data: JSON.stringify({ name: 'evil', version: '1.0.0', timon: { id: 'evil-one', apiVersion: 1 } }) },
    { path: 'package/../../../escaped.txt', data: 'pwned' },
  ]);
  const res = await call('POST', '/upload', archive);
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'unsafe-path');
  assert.equal(existsSync(join(STAGING, '..', 'escaped.txt')), false);
  assert.equal(readdirSync(STAGING).length, readdirSync(STAGING).filter((n) => /^[a-f0-9]{48}$/.test(n)).length);
});

test('upload: not an archive, empty, or over the size limit', async () => {
  assert.equal((await call('POST', '/upload', Buffer.from('hello, not an archive'))).json.error, 'not-archive');
  assert.equal((await call('POST', '/upload', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(40)]))).json.error, 'corrupt', 'sniffed as a zip, then read as one');
  assert.equal((await call('POST', '/upload', Buffer.alloc(0))).status, 400);
  const big = await call('POST', '/upload', Buffer.alloc(26 * 1024 * 1024, 1));
  assert.equal(big.status, 413);
});

test('stage a path: absolute, existing, outside the Timon home', async () => {
  assert.equal((await call('POST', '/stage', { source: 'path', path: 'relative/dir' })).json.error, 'invalid-path');
  assert.equal((await call('POST', '/stage', { source: 'path', path: join(PC, 'nope') })).status, 404);
  const inHome = join(TIMON_HOME, 'agents');
  mkdirSync(inHome, { recursive: true });
  writeFileSync(join(inHome, 'package.json'), '{"name":"x","timon":{"id":"xxx","apiVersion":1}}');
  const refused = await call('POST', '/stage', { source: 'path', path: inHome });
  assert.equal(refused.json.error, 'forbidden-path');
  assert.ok(!refused.text.includes(TIMON_HOME));
  assert.equal((await call('POST', '/stage', { source: 'path', path: join(PC) })).json.error, 'not-a-plugin');
  assert.equal((await call('POST', '/stage', { source: 'nope', path: '/' })).status, 400);
});

test('stage a picked folder: copied into the plugins folder on confirmation, then installed', async () => {
  const dir = pluginFolder();
  const preview = await call('POST', '/stage', { source: 'path', path: dir });
  assert.equal(preview.status, 201, preview.text);
  assert.equal(preview.json.origin, 'path');
  assert.equal(preview.json.format, 'folder');
  // Edited after the preview: what was previewed is what gets installed.
  writeFileSync(join(dir, 'index.js'), 'console.log("edited after preview")\n');
  const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(done.status, 200, done.text);
  const spec = npmCalls.at(-1)?.at(-1) ?? '';
  assert.ok(spec.startsWith(PLUGINS + sep), 'npm links a folder: it must live in the plugins folder, not in Downloads');
  assert.match(readFileSync(join(spec, 'index.js'), 'utf8'), /must never run/);
  assert.equal(done.json.signature && (done.json.signature as { state: string }).state, 'signed');
});

/** A bundle laid out as `examples/` does: the bundle and its children side by side. */
function bundleSet(): { bundle: string; n: number } {
  const n = ++serial;
  const set = join(PC, `set-${n}`);
  const child = (folder: string, name: string, id: string): void => {
    const dir = join(set, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name, version: '0.1.0', main: 'index.js',
      timon: { id, apiVersion: 1, kind: 'behavior', label: id, permissions: [] },
    }));
    writeFileSync(join(dir, 'index.js'), 'export default {};\n');
    sign(dir);
  };
  child(`page-${n}`, `@acme/page-${n}`, `acme-page-${n}`);
  child(`widget-${n}`, `@acme/widget-${n}`, `acme-widget-${n}`);
  child(`far-${n}`, `@acme/far-${n}`, `acme-far-${n}`);
  const bundle = join(set, 'plugin-bundle');
  mkdirSync(join(set, 'plugin-bundle'), { recursive: true });
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: `@acme/bundle-${n}`, version: '0.1.0', main: 'index.js',
    // npm specs, not paths: written with `/` on every OS.
    dependencies: {
      [`@acme/page-${n}`]: `file:../page-${n}`,
      [`@acme/widget-${n}`]: `../widget-${n}`,
      // Two levels up from the plugins folder: not a place this install writes to.
      [`@acme/far-${n}`]: `file:../../set-${n}/far-${n}`,
    },
    timon: {
      id: `acme-bundle-${n}`, apiVersion: 1, kind: 'bundle', label: 'Bundle', permissions: [],
      contains: [`acme-page-${n}`, `acme-widget-${n}`, `acme-far-${n}`],
    },
  }));
  writeFileSync(join(bundle, 'index.js'), 'export default {};\n');
  sign(bundle);
  return { bundle, n };
}

test('stage a picked bundle folder: its `file:../sibling` children are copied too and installed', async () => {
  const { bundle, n } = bundleSet();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  assert.equal(preview.status, 201, preview.text);
  const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(done.status, 200, done.text);
  const children = new Map((done.json.children as Array<{ id: string; state: string }>).map((c) => [c.id, c.state]));
  assert.equal(children.get(`acme-page-${n}`), 'installed');
  assert.equal(children.get(`acme-widget-${n}`), 'installed');
  assert.equal(children.get(`acme-far-${n}`), 'unresolved', 'a path out of the plugins folder is not laid back');
  for (const folder of [`page-${n}`, `widget-${n}`]) {
    assert.ok(existsSync(join(PLUGINS, folder, 'package.json')), `${folder} lives in the plugins folder`);
    assert.ok(npmCalls.some((c) => c.at(-1) === join(PLUGINS, folder)), `${folder} is installed from the plugins folder, never from the PC`);
  }
  assert.ok(!npmCalls.some((c) => (c.at(-1) ?? '').startsWith(PC + sep)), 'nothing is installed from the picked location');
  assert.ok(!existsSync(join(PLUGINS, '..', `set-${n}`)), 'nothing is written above the plugins folder');
});

test('stage a picked bundle folder: a sibling never overwrites another package of the plugins folder', async () => {
  const { bundle, n } = bundleSet();
  mkdirSync(join(PLUGINS, `page-${n}`), { recursive: true });
  writeFileSync(join(PLUGINS, `page-${n}`, 'package.json'), '{"name":"someone-else","version":"9.9.9"}');
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(done.status, 200, done.text);
  assert.equal(JSON.parse(readFileSync(join(PLUGINS, `page-${n}`, 'package.json'), 'utf8')).name, 'someone-else');
  const children = new Map((done.json.children as Array<{ id: string; state: string }>).map((c) => [c.id, c.state]));
  assert.equal(children.get(`acme-page-${n}`), 'unresolved');
  assert.equal(children.get(`acme-widget-${n}`), 'installed');
});

test('stage a picked folder holding a link: refused', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async () => {
  const dir = pluginFolder({ signed: false });
  symlinkSync(join(TIMON_HOME), join(dir, 'home'));
  const res = await call('POST', '/stage', { source: 'path', path: dir });
  assert.equal(res.json.error, 'link');
});

test('detected: packages dropped in the plugins folder are listed until installed', async () => {
  mkdirSync(PLUGINS, { recursive: true });
  const folder = pluginFolder();
  cpSync(folder, join(PLUGINS, 'dropped-folder'), { recursive: true });
  writeFileSync(join(PLUGINS, 'dropped.tgz'), tgzOf(pluginFolder()));
  writeFileSync(join(PLUGINS, 'not-a-plugin.txt'), 'hello');
  mkdirSync(join(PLUGINS, 'plain-npm'), { recursive: true });
  writeFileSync(join(PLUGINS, 'plain-npm', 'package.json'), '{"name":"left-pad","version":"1.0.0"}');

  const list = await call('GET', '/candidates');
  const names = (list.json.candidates as Array<{ name: string }>).map((c) => c.name).sort();
  assert.ok(names.includes('dropped-folder') && names.includes('dropped.tgz'));
  assert.ok(!names.includes('plain-npm'), 'a package without a Timon manifest is not ours to list');
  assert.ok(!names.includes('not-a-plugin.txt'));
  assert.ok(!list.text.includes(PLUGINS), 'names, never paths');

  assert.equal((await call('POST', '/stage', { source: 'detected', name: '../etc' })).status, 400);
  assert.equal((await call('POST', '/stage', { source: 'detected', name: 'node_modules' })).status, 404);

  const preview = await call('POST', '/stage', { source: 'detected', name: 'dropped-folder' });
  assert.equal(preview.status, 201, preview.text);
  const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(done.status, 200, done.text);
  assert.equal(npmCalls.at(-1)?.at(-1), join(PLUGINS, 'dropped-folder'), 'installed in place');

  const after = await call('GET', '/candidates');
  const left = (after.json.candidates as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!left.includes('dropped-folder'), 'an installed package leaves the list');
  assert.ok(left.includes('dropped.tgz'));
});

test('detected folder whose icon is a link out of the package: the image is dropped, not read', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async () => {
  const dir = join(PLUGINS, 'sneaky');
  cpSync(pluginFolder({ signed: false }), dir, { recursive: true });
  rmSync(join(dir, 'icon.svg'));
  const secret = join(PC, 'secret.svg');
  writeFileSync(secret, '<svg>top-secret</svg>');
  symlinkSync(secret, join(dir, 'icon.svg'));
  const preview = await call('POST', '/stage', { source: 'detected', name: 'sneaky' });
  assert.equal(preview.status, 201, preview.text);
  assert.equal(preview.json.icon, null);
  assert.ok(!preview.text.includes('top-secret'));
});

/** A dictation plugin dropped in the plugins folder (detected source), unsigned. */
function dictationFolder(name: string, models?: string): string {
  const dir = join(PLUGINS, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@acme/${name}`,
    version: '1.0.0',
    timon: {
      id: `acme-${name}`, apiVersion: 14, kind: 'dictation', label: 'Acme dictation',
      permissions: ['dictation:engine', 'http:outbound'],
      client: { slots: ['dictation.engine'] },
      dictation: {
        engines: [
          { id: 'in-page', runtime: 'page', egress: 'none' },
          { id: 'cloud', runtime: 'page', egress: ['api.acme.com'] },
        ],
        ...(models ? { models } : {}),
      },
    },
  }));
  return dir;
}

test('dictation: a `models` pack that a link takes out of the package blocks the install', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async () => {
  const dir = dictationFolder('dictation-link', 'dictation-models.json');
  const outside = join(PC, 'outside-models.json');
  writeFileSync(outside, '{"top":"secret"}');
  symlinkSync(outside, join(dir, 'dictation-models.json'));
  const preview = await call('POST', '/stage', { source: 'detected', name: 'dictation-link' });
  assert.equal(preview.status, 201, preview.text);
  assert.equal(preview.json.blocked, 'manifest');
  assert.equal(preview.json.installable, false);
  assert.match(String(preview.json.manifestError), /dictation\.models/);
  assert.ok(!preview.text.includes('secret') && !preview.text.includes(PC), 'nothing of the target, no path');
  assert.equal((await call('POST', '/confirm', { token: preview.json.token, confirm: true })).status >= 400, true);
});

test('dictation: a `models` pack missing from the package blocks the install', async () => {
  dictationFolder('dictation-missing', 'dictation-models.json');
  const preview = await call('POST', '/stage', { source: 'detected', name: 'dictation-missing' });
  assert.equal(preview.status, 201, preview.text);
  assert.equal(preview.json.blocked, 'manifest');
  assert.match(String(preview.json.manifestError), /not a file of the package/);
});

test('dictation: the preview says where each engine sends the voice', async () => {
  const dir = dictationFolder('dictation-ok', 'packs/dictation-models.json');
  mkdirSync(join(dir, 'packs'), { recursive: true });
  writeFileSync(join(dir, 'packs', 'dictation-models.json'), '{"models":[]}');
  const preview = await call('POST', '/stage', { source: 'detected', name: 'dictation-ok' });
  assert.equal(preview.status, 201, preview.text);
  assert.equal(preview.json.blocked, null);
  assert.deepEqual(preview.json.kind, ['dictation']);
  assert.deepEqual(preview.json.dictation, {
    engines: [
      { id: 'in-page', runtime: 'page', egress: 'none' },
      { id: 'cloud', runtime: 'page', egress: ['api.acme.com'] },
    ],
    models: 'packs/dictation-models.json',
    lines: [
      'in-page: your voice stays in this window',
      'cloud: your voice is sent to api.acme.com',
      'models: brings models for the built-in engine; your voice stays on this machine',
    ],
  });
  const other = await call('POST', '/stage', { source: 'path', path: pluginFolder() });
  assert.equal(other.json.dictation, null, 'nothing to say for any other kind');
});

test('the perimeter holds when the Timon home is reached through a link (macOS /var → /private/var)', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const inHome = join(TIMON_HOME, 'agents');
  mkdirSync(inHome, { recursive: true });
  writeFileSync(join(inHome, 'package.json'), '{"name":"x","timon":{"id":"xxx","apiVersion":1}}');
  const link = join(mkdtempSync(join(tmpdir(), 'timon-link-')), 'home');
  symlinkSync(TIMON_HOME, link, 'dir');
  const viaLink = new PluginInstallSources({ pluginsRoot: PLUGINS, stagingRoot: STAGING, forbiddenRoots: [link], publicKeys: KEYS, unsignedLoads: () => false });
  for (const path of [inHome, join(link, 'agents')]) {
    assert.throws(() => viaLink.stagePath(path), (err) => err instanceof PluginSourceError && err.code === 'forbidden-path', path);
  }
});

// ── A provider: the superadmin accepts the RESOLVED binary at install ─────
const posix = process.platform !== 'win32';
const BIN_DIR = mkdtempSync(join(tmpdir(), 'timon-provider-bin-'));
const AGENT = join(BIN_DIR, 'acme-prov-agent');
if (posix) {
  writeFileSync(AGENT, '#!/bin/sh\nexit 0\n');
  chmodSync(AGENT, 0o755);
}
const PATH_BEFORE = process.env.PATH;
process.env.PATH = `${BIN_DIR}${delimiter}${PATH_BEFORE ?? ''}`;
test.after(() => { process.env.PATH = PATH_BEFORE; });

function providerFolder(binary: { name?: string; identity?: { pattern: string; expected?: string } } = {}): string {
  const n = ++serial;
  const dir = join(PC, `provider-${n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@acme/provider-${n}`,
    version: '1.0.0',
    main: 'index.js',
    timon: {
      id: `acme-provider-${n}`, apiVersion: 10, kind: 'provider', label: 'Acme', permissions: ['backends:register'],
      provider: { binaries: [{ name: 'acme-prov-agent', ...binary }], osCredentials: [{ service: 'Acme CLI-credentials' }, { service: 'Acme CLI', account: 'work' }], credentialDirs: ['.acme', '.config/acme'] },
    },
  }));
  writeFileSync(join(dir, 'index.js'), 'throw new Error("must never run during a preview");\n');
  sign(dir);
  return dir;
}
const allowInConfig = (): string[] => {
  try {
    return (JSON.parse(readFileSync(CONFIG, 'utf8')) as { pluginPolicy?: { exec?: { allow?: string[] } } }).pluginPolicy?.exec?.allow ?? [];
  } catch { return []; }
};

test('provider: the preview shows the resolved binary, and only the exact path accepted is allowlisted', { skip: !posix }, async () => {
  const preview = await call('POST', '/stage', { source: 'path', path: providerFolder() });
  assert.equal(preview.status, 201, preview.text);
  const provider = preview.json.provider as {
    binaries: Array<{ name: string; resolved: string | null; allowed: boolean }>;
    osCredentials: Array<{ service: string; account?: string }>;
    credentialDirs: string[];
  };
  assert.equal(provider.binaries[0]?.name, 'acme-prov-agent');
  // The sheet can say which entries of the OS credential store the provider reads.
  assert.deepEqual(provider.osCredentials, [{ service: 'Acme CLI-credentials' }, { service: 'Acme CLI', account: 'work' }]);
  // …and which folders of the home it reads its sign-in from.
  assert.deepEqual(provider.credentialDirs, ['.acme', '.config/acme']);
  assert.equal(provider.binaries[0]?.resolved, AGENT);
  assert.equal(provider.binaries[0]?.allowed, false);

  const calls = npmCalls.length;
  const wrong = await call('POST', '/confirm', { token: preview.json.token, confirm: true, authorizeExec: ['/usr/bin/ls'] });
  assert.equal(wrong.status, 409, wrong.text);
  assert.equal(npmCalls.length, calls, 'nothing is installed on a mismatch');
  assert.deepEqual(allowInConfig(), []);

  const none = await call('POST', '/confirm', { token: preview.json.token, confirm: true, authorizeExec: [] });
  assert.equal(none.status, 409, 'accepting nothing is not accepting the shown path');

  const ok = await call('POST', '/confirm', { token: preview.json.token, confirm: true, authorizeExec: [AGENT] });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(allowInConfig(), [AGENT]);
});

test('provider: installing without accepting authorizes nothing', { skip: !posix }, async () => {
  const before = allowInConfig();
  const preview = await call('POST', '/stage', { source: 'path', path: providerFolder() });
  const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(allowInConfig(), before);
});

test('provider: a program without the declared identity refuses the click, installs nothing, and the preview stays', { skip: !posix }, async () => {
  const file = join(BIN_DIR, 'acme-prov-stranger');
  const witness = `${file}.runs`;
  writeFileSync(witness, '');
  writeFileSync(file, `#!/bin/sh\necho x >> "${witness}"\necho "grok-cli 0.9.1"\n`);
  chmodSync(file, 0o755);
  const before = allowInConfig();
  const calls = npmCalls.length;
  const preview = await call('POST', '/stage', { source: 'path', path: providerFolder({ name: 'acme-prov-stranger', identity: { pattern: '^acme \\d+' } }) });
  assert.equal(preview.status, 201, preview.text);
  assert.equal(readFileSync(witness, 'utf8'), '', 'the preview starts nothing');

  const refused = await call('POST', '/confirm', { token: preview.json.token, confirm: true, authorizeExec: [file] });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.error, 'binary-identity');
  assert.match(String(refused.json.message), /grok-cli 0\.9\.1/);
  assert.equal(npmCalls.length, calls, 'nothing is installed');
  assert.deepEqual(allowInConfig(), before);

  // The person replaces the program and clicks again: the same preview is still good.
  writeFileSync(file, '#!/bin/sh\necho "acme 1.0 and a size of its own"\n');
  const accepted = await call('POST', '/confirm', { token: preview.json.token, confirm: true, authorizeExec: [file] });
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual(allowInConfig(), [...before, file]);
});

test('provider: a double click during the check installs once, and grants once', { skip: !posix }, async () => {
  const file = join(BIN_DIR, 'acme-prov-slow');
  writeFileSync(file, '#!/bin/sh\nsleep 0.3\necho "acme 1.0"\n');
  chmodSync(file, 0o755);
  const before = allowInConfig();
  const calls = npmCalls.length;
  const preview = await call('POST', '/stage', { source: 'path', path: providerFolder({ name: 'acme-prov-slow', identity: { pattern: '^acme \\d+' } }) });
  const body = { token: preview.json.token, confirm: true, authorizeExec: [file] };
  const statuses = (await Promise.all([call('POST', '/confirm', body), call('POST', '/confirm', body)])).map((res) => res.status).sort();
  assert.deepEqual(statuses, [200, 404], 'the second click finds the preview consumed');
  assert.equal(npmCalls.length, calls + 1);
  assert.deepEqual(allowInConfig(), [...before, file]);
});

test('an authorization for a plugin that is not a provider is refused (400), never written', async () => {
  const preview = await call('POST', '/stage', { source: 'path', path: pluginFolder() });
  const res = await call('POST', '/confirm', { token: preview.json.token, confirm: true, authorizeExec: ['/bin/sh'] });
  assert.equal(res.status, 400, res.text);
  assert.ok(!allowInConfig().includes('/bin/sh'));
});

// ── .zip (TODO #345) ──────────────────────────────────────────────────────

test('zip: anonymous and non-superadmin uploads are refused before the body is read', async () => {
  const zip = zipOf(pluginFolder());
  assert.equal((await call('POST', '/upload', zip, null)).status, 401);
  assert.equal((await call('POST', '/upload', zip, 'bob')).status, 403);
  assert.equal((await call('POST', '/upload', zip, 'daemon')).status, 403);
});

test('zip: a signed plugin zipped by the Finder is previewed, then installed as a folder in the plugins folder', async () => {
  const dir = pluginFolder();
  const before = npmCalls.length;
  const preview = await call('POST', '/upload', zipOf(dir, { finder: true }));
  assert.equal(preview.status, 201, preview.text);
  assert.equal(preview.json.format, 'archive');
  assert.equal(preview.json.label, `Demo ${serial}`);
  assert.deepEqual(preview.json.signature, { state: 'signed', keyId: 'test-install' }, 'Finder metadata is not part of the package');
  assert.equal(npmCalls.length, before, 'nothing is installed by a preview');
  for (const secret of [PC, PLUGINS, STAGING, TIMON_HOME]) {
    assert.ok(!preview.text.includes(secret), `the preview leaks ${secret}`);
  }
  const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.ok, true);
  assert.equal((done.json.signature as { state: string }).state, 'signed');
  const spec = npmCalls.at(-1)?.at(-1) ?? '';
  assert.ok(spec.startsWith(PLUGINS + sep) && !spec.endsWith('.zip'), 'npm gets the extracted folder, never the zip');
  assert.equal(existsSync(join(spec, '__MACOSX')) || existsSync(join(spec, '.DS_Store')), false);
  assert.match(readFileSync(join(spec, 'index.js'), 'utf8'), /must never run/);
});

test('zip: unsigned follows the same rule as a .tgz, tampered never reaches npm', async () => {
  const unsigned = await call('POST', '/upload', zipOf(pluginFolder({ signed: false })));
  assert.equal(unsigned.status, 201);
  assert.deepEqual(unsigned.json.signature, { state: 'unsigned', loads: false });

  const dir = pluginFolder();
  writeFileSync(join(dir, 'index.js'), 'console.log("changed after signing")\n');
  const before = npmCalls.length;
  const tampered = await call('POST', '/upload', zipOf(dir));
  assert.equal(tampered.json.blocked, 'tampered');
  assert.equal((await call('POST', '/confirm', { token: tampered.json.token, confirm: true })).status, 422);
  assert.equal(npmCalls.length, before);
});

test('zip: zip-slip, links, missing package.json and encrypted entries are refused with their code', async () => {
  const pkg = JSON.stringify({ name: 'evil', version: '1.0.0', timon: { id: 'evil-one', apiVersion: 1 } });
  const slip = await call('POST', '/upload', buildZip([{ path: 'p/package.json', data: pkg }, { path: 'p\\..\\..\\..\\escaped.txt', data: 'pwned' }]));
  assert.equal(slip.status, 400);
  assert.equal(slip.json.error, 'unsafe-path');
  assert.equal(existsSync(join(STAGING, '..', 'escaped.txt')), false);
  const link = await call('POST', '/upload', buildZip([{ path: 'p/package.json', data: pkg }, { path: 'p/home', data: '/', symlink: true }]));
  assert.equal(link.json.error, 'link');
  assert.equal((await call('POST', '/upload', buildZip([{ path: 'p/index.js', data: 'x' }]))).json.error, 'layout');
  assert.equal((await call('POST', '/upload', buildZip([{ path: 'p/package.json', data: pkg, encrypted: true }]))).json.error, 'encrypted');
  assert.equal(readdirSync(STAGING).length, readdirSync(STAGING).filter((n) => /^[a-f0-9]{48}$/.test(n)).length);
});

test('zip: a picked .zip path is staged; a .zip dropped in the plugins folder is not listed but can be picked', async () => {
  const file = join(PC, `picked-${++serial}.zip`);
  writeFileSync(file, zipOf(pluginFolder(), { top: 'plugin-main' }));
  const preview = await call('POST', '/stage', { source: 'path', path: file });
  assert.equal(preview.status, 201, preview.text);
  assert.equal(preview.json.origin, 'path');
  assert.equal(preview.json.format, 'archive');
  assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);

  mkdirSync(PLUGINS, { recursive: true });
  const dropped = join(PLUGINS, 'dropped.zip');
  writeFileSync(dropped, zipOf(pluginFolder()));
  const names = ((await call('GET', '/candidates')).json.candidates as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!names.includes('dropped.zip'), 'npm cannot install a zip in place');
  const fromDrop = await call('POST', '/stage', { source: 'path', path: dropped });
  assert.equal(fromDrop.status, 201, fromDrop.text);
  assert.equal((await call('DELETE', `/staged/${String(fromDrop.json.token)}`)).status, 204);
  rmSync(dropped);
});

test('zip: `timon plugin add <file.zip>` lays the folder in the plugins folder and runs the same addPlugin', async () => {
  const dir = pluginFolder();
  const file = join(PC, `cli-${serial}.zip`);
  writeFileSync(file, zipOf(dir));
  const { result, folder } = await sources.addZipFile(file);
  assert.equal(result.refused, null);
  assert.equal(result.id, `acme-demo-${serial}`);
  assert.ok(result.signature.ok);
  assert.ok(folder.startsWith(PLUGINS + sep));
  assert.equal(npmCalls.at(-1)?.at(-1), folder);
  await assert.rejects(sources.addZipFile(join(PC, 'missing.zip')), (err: unknown) => err instanceof PluginSourceError && err.code === 'not-found');
  const bad = join(PC, `bad-${serial}.zip`);
  writeFileSync(bad, buildZip([{ path: 'p/index.js', data: 'x' }]));
  await assert.rejects(sources.addZipFile(bad), (err: unknown) => err instanceof PluginSourceError && err.code === 'layout');
});

// ── Named secrets and hosts (TODO #599, step 3): shown, then granted in one gesture ──
const { createSecret, deleteSecret, getSecret, grantSecret } = await import('../../secrets/store.js');
const { config, loadConfig, setConfig } = await import('../../config/load.js');
const { assertFetchAllowed } = await import('../../plugins/policy.js');
const { PLUGIN_API_VERSION } = await import('../../plugins/manifest.js');

const BROKER = { type: 'http', hosts: ['api.example.com'], inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' } };

type VaultLine = { name: string; mode: 'read' | 'broker'; why: string | null; present: boolean; otherMode: boolean; state: string };
type HostLine = { host: string; why: string | null; allowedBy: 'global' | 'plugin' | null };
type VaultPreview = { scope: string; secrets: VaultLine[]; hosts: HostLine[] };

/** A plugin naming four secrets (missing, grantable, already granted, wrong mode) and three hosts. */
function vaultFolder(): { dir: string; id: string; n: number; secretIds: { token: string; broker: string; granted: string } } {
  const n = ++serial;
  const id = `acme-vault-${n}`;
  const dir = join(PC, `vault-${n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@acme/vault-${n}`,
    version: '1.0.0',
    main: 'index.js',
    timon: {
      id, apiVersion: PLUGIN_API_VERSION, kind: 'behavior', label: 'Vault demo',
      permissions: ['secrets:read', 'secrets:broker', 'http:outbound'],
      secrets: [
        { name: `MISSING_${n}`, mode: 'read', why: 'Reads your Acme token' },
        { name: `TOKEN_${n}`, mode: 'read' },
        { name: `BROKER_${n}`, mode: 'broker' },
        { name: `GRANTED_${n}`, mode: 'read' },
        { name: `WRONGMODE_${n}`, mode: 'broker' },
      ],
      http: { hosts: [{ host: `api.acme-${n}.test`, why: 'The Acme API' }, { host: `*.cdn.acme-${n}.test` }, { host: `shared-${n}.test` }] },
    },
  }));
  writeFileSync(join(dir, 'index.js'), 'throw new Error("must never run during a preview");\n');
  sign(dir);
  const token = createSecret({ name: `TOKEN_${n}`, value: 'tok-aaaaaaaaaaaaaaaa' }).id;
  const broker = createSecret({ name: `BROKER_${n}`, value: 'tok-bbbbbbbbbbbbbbbb', mode: 'broker', broker_spec: BROKER }).id;
  const granted = createSecret({ name: `GRANTED_${n}`, value: 'tok-cccccccccccccccc', grants: [`agent:plugin:${id}`] }).id;
  createSecret({ name: `WRONGMODE_${n}`, value: 'tok-dddddddddddddddd' });
  return { dir, id, n, secretIds: { token, broker, granted } };
}

/** The consent the sheet sends: every line as shown, `tick` names what was checked. */
function consentOf(vault: VaultPreview, tick: readonly string[]) {
  return {
    secrets: vault.secrets.map((s) => ({ name: s.name, mode: s.mode, state: s.state, grant: tick.includes(s.name) })),
    hosts: vault.hosts.map((h) => ({ host: h.host, allowedBy: h.allowedBy, grant: tick.includes(h.host) })),
  };
}

const byPluginInConfig = (): Record<string, string[]> => {
  try {
    return (JSON.parse(readFileSync(CONFIG, 'utf8')) as { pluginPolicy?: { http?: { byPlugin?: Record<string, string[]> } } }).pluginPolicy?.http?.byPlugin ?? {};
  } catch { return {}; }
};
const httpAllowInConfig = (): string[] => {
  try {
    return (JSON.parse(readFileSync(CONFIG, 'utf8')) as { pluginPolicy?: { http?: { allow?: string[] } } }).pluginPolicy?.http?.allow ?? [];
  } catch { return []; }
};
const grantsOf = (secretId: string): string[] =>
  (getSecret(secretId)?.grants ?? []).map((g) => (g.scope_kind === 'global' ? 'global' : `${g.scope_kind}:${g.scope_ref}`));

/** The live config with `shared-<n>.test` open to every plugin, and `api.acme-<n>.test` already to this one. */
function withLiveHosts<T>(n: number, id: string, run: () => Promise<T>): Promise<T> {
  const saved = config();
  setConfig({
    ...saved,
    pluginPolicy: {
      ...saved.pluginPolicy,
      http: { ...saved.pluginPolicy.http, allow: [`shared-${n}.test`], byPlugin: { [id]: [`api.acme-${n}.test`] } },
    },
  });
  return run().finally(() => setConfig(saved));
}

test('vault: the preview says where each declared secret and host stands, without a value', async () => {
  const { dir, id, n } = vaultFolder();
  await withLiveHosts(n, id, async () => {
    const preview = await call('POST', '/stage', { source: 'path', path: dir });
    assert.equal(preview.status, 201, preview.text);
    const vault = preview.json.vault as VaultPreview;
    assert.equal(vault.scope, `agent:plugin:${id}`);
    assert.deepEqual(vault.secrets.map((s) => [s.name, s.state, s.present, s.otherMode]), [
      [`MISSING_${n}`, 'missing', false, false],
      [`TOKEN_${n}`, 'grantable', true, false],
      [`BROKER_${n}`, 'grantable', true, false],
      [`GRANTED_${n}`, 'granted', true, false],
      [`WRONGMODE_${n}`, 'missing', false, true],
    ]);
    assert.equal(vault.secrets[0]?.why, 'Reads your Acme token');
    assert.deepEqual(vault.hosts, [
      { host: `api.acme-${n}.test`, why: 'The Acme API', allowedBy: 'plugin' },
      { host: `*.cdn.acme-${n}.test`, why: null, allowedBy: null },
      { host: `shared-${n}.test`, why: null, allowedBy: 'global' },
    ]);
    for (const value of ['tok-aaaaaaaaaaaaaaaa', 'tok-bbbbbbbbbbbbbbbb', 'tok-cccccccccccccccc']) {
      assert.ok(!preview.text.includes(value), 'the preview never carries a secret value');
    }
    assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
  });
});

test('vault: a plugin naming neither has `vault: null`', async () => {
  const preview = await call('POST', '/stage', { source: 'path', path: pluginFolder() });
  assert.equal(preview.json.vault, null);
  assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
});

test('vault: what the client saw must be what the daemon computes now — any difference is a 409, nothing written', async () => {
  const { dir, id, n, secretIds } = vaultFolder();
  const preview = await call('POST', '/stage', { source: 'path', path: dir });
  const vault = preview.json.vault as VaultPreview;
  const good = consentOf(vault, [`TOKEN_${n}`, `api.acme-${n}.test`]);
  const calls = npmCalls.length;
  const attempts = [
    // A line dropped, a line added, a state forged, a host said already open.
    { ...good, secrets: good.secrets.slice(1) },
    { ...good, hosts: [...good.hosts, { host: `evil-${n}.test`, allowedBy: null, grant: true }] },
    { ...good, secrets: good.secrets.map((s) => (s.name === `MISSING_${n}` ? { ...s, state: 'grantable' as const } : s)) },
    { ...good, hosts: good.hosts.map((h) => (h.host === `api.acme-${n}.test` ? { ...h, allowedBy: 'global' as const } : h)) },
    { secrets: [], hosts: [] },
  ];
  for (const forged of attempts) {
    const res = await call('POST', '/confirm', { token: preview.json.token, confirm: true, vault: forged });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error, 'mismatch');
  }
  // The vault moved between the preview and the click: the line shown is stale.
  createSecret({ name: `MISSING_${n}`, value: 'tok-eeeeeeeeeeeeeeee' });
  const stale = await call('POST', '/confirm', { token: preview.json.token, confirm: true, vault: good });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(npmCalls.length, calls, 'nothing is installed on a mismatch');
  assert.deepEqual(grantsOf(secretIds.token), [], 'nothing is granted on a mismatch');
  assert.equal(byPluginInConfig()[id], undefined, 'no host is opened on a mismatch');
});

test('vault: a declared secret missing from the vault is never granted — ticking it is a 409', async () => {
  const { dir, n, id } = vaultFolder();
  const preview = await call('POST', '/stage', { source: 'path', path: dir });
  const vault = preview.json.vault as VaultPreview;
  const calls = npmCalls.length;
  for (const name of [`MISSING_${n}`, `WRONGMODE_${n}`]) {
    const res = await call('POST', '/confirm', { token: preview.json.token, confirm: true, vault: consentOf(vault, [name, `TOKEN_${n}`]) });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error, 'not-grantable');
  }
  assert.equal(npmCalls.length, calls);
  // The other-mode row of the same name was not granted either.
  for (const s of dbApi.getSecretsByName(`WRONGMODE_${n}`)) assert.deepEqual(s.grants, []);
  assert.equal(byPluginInConfig()[id], undefined);
});

test('vault: ticked secrets are granted to this plugin alone, ticked hosts opened to it alone — never in `allow`', async () => {
  const { dir, id, n, secretIds } = vaultFolder();
  const allowBefore = httpAllowInConfig();
  const preview = await call('POST', '/stage', { source: 'path', path: dir });
  const vault = preview.json.vault as VaultPreview;
  const ok = await call('POST', '/confirm', {
    token: preview.json.token, confirm: true,
    vault: consentOf(vault, [`TOKEN_${n}`, `GRANTED_${n}`, `api.acme-${n}.test`, `*.cdn.acme-${n}.test`]),
  });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.vault, { secrets: [`TOKEN_${n}`], hosts: [`api.acme-${n}.test`, `*.cdn.acme-${n}.test`] });
  assert.deepEqual(grantsOf(secretIds.token), [`agent:plugin:${id}`]);
  assert.deepEqual(grantsOf(secretIds.broker), [], 'an unticked secret is not granted');
  assert.deepEqual(grantsOf(secretIds.granted), [`agent:plugin:${id}`], 'an existing grant is left as it was');
  assert.deepEqual(byPluginInConfig()[id], [`api.acme-${n}.test`, `*.cdn.acme-${n}.test`]);
  assert.deepEqual(httpAllowInConfig(), allowBefore, 'the shared allowlist is never touched');

  const saved = config();
  try {
    setConfig(loadConfig(CONFIG, { readonly: true }));
    assert.doesNotThrow(() => assertFetchAllowed(id, `https://api.acme-${n}.test/v1`));
    assert.doesNotThrow(() => assertFetchAllowed(id, `https://img.cdn.acme-${n}.test/a.png`));
    assert.throws(() => assertFetchAllowed('another-plugin', `https://api.acme-${n}.test/v1`), /pluginPolicy/);
    assert.throws(() => assertFetchAllowed(id, `https://shared-${n}.test/`), /pluginPolicy/, 'an unticked host stays closed');
  } finally { setConfig(saved); }
});

test('vault: the consent REPLACES what an earlier package of the same id held', async () => {
  const { dir, id, n } = vaultFolder();
  const cfg = JSON.parse(existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '{}') as Record<string, Record<string, Record<string, unknown>>>;
  cfg.pluginPolicy = { ...(cfg.pluginPolicy ?? {}), http: { ...(cfg.pluginPolicy?.http ?? {}), byPlugin: { ...byPluginInConfig(), [id]: [`stale-${n}.test`] } } };
  writeFileSync(CONFIG, JSON.stringify(cfg));
  const preview = await call('POST', '/stage', { source: 'path', path: dir });
  const res = await call('POST', '/confirm', { token: preview.json.token, confirm: true, vault: consentOf(preview.json.vault as VaultPreview, [`shared-${n}.test`]) });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(byPluginInConfig()[id], [`shared-${n}.test`]);
});

test('vault: installing without sending the consent grants nothing', async () => {
  const { dir, id, secretIds } = vaultFolder();
  const preview = await call('POST', '/stage', { source: 'path', path: dir });
  const res = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.vault, null);
  assert.deepEqual(grantsOf(secretIds.token), []);
  assert.equal(byPluginInConfig()[id], undefined);
});

test('vault: anonymous (401), a non-superadmin, the daemon token and a mission (403) grant nothing', async () => {
  const { dir, id, n, secretIds } = vaultFolder();
  const preview = await call('POST', '/stage', { source: 'path', path: dir });
  const body = { token: preview.json.token, confirm: true, vault: consentOf(preview.json.vault as VaultPreview, [`TOKEN_${n}`, `api.acme-${n}.test`]) };
  assert.equal((await call('POST', '/confirm', body, null)).status, 401);
  for (const as of ['bob', 'daemon', 'mission'] as const) {
    assert.equal((await call('POST', '/confirm', body, as)).status, 403, as);
  }
  assert.deepEqual(grantsOf(secretIds.token), []);
  assert.equal(byPluginInConfig()[id], undefined);
  assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
});

test('vault: a failed install takes back the grants and the hosts it wrote', async () => {
  const failing = new PluginInstallSources({
    pluginsRoot: PLUGINS, stagingRoot: STAGING, forbiddenRoots: [TIMON_HOME, PLUGINS],
    publicKeys: KEYS, unsignedLoads: () => false,
    install: { npm: async () => { throw new Error('npm exploded'); }, config: CONFIG, publicKeys: KEYS },
    configFile: CONFIG,
  });
  const { dir, id, n, secretIds } = vaultFolder();
  const cfg = JSON.parse(existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '{}') as Record<string, Record<string, Record<string, unknown>>>;
  cfg.pluginPolicy = { ...(cfg.pluginPolicy ?? {}), http: { ...(cfg.pluginPolicy?.http ?? {}), byPlugin: { ...byPluginInConfig(), [id]: [`before-${n}.test`] } } };
  writeFileSync(CONFIG, JSON.stringify(cfg));
  const preview = failing.stagePath(dir);
  assert.ok(preview.vault);
  await assert.rejects(failing.installStaged(preview.token, { vault: consentOf(preview.vault, [`TOKEN_${n}`, `BROKER_${n}`, `api.acme-${n}.test`]) }), /npm exploded/);
  assert.deepEqual(grantsOf(secretIds.token), []);
  assert.deepEqual(grantsOf(secretIds.broker), []);
  assert.deepEqual(grantsOf(secretIds.granted), [`agent:plugin:${id}`], 'a grant that predates the click stays');
  assert.deepEqual(byPluginInConfig()[id], [`before-${n}.test`], 'the hosts are put back as they were');
});

// ── A bundle's children (TODO #660): their secrets and hosts shown by id, consented child by child ──
type ChildPreview = {
  id: string; pkg: string | null; version: string | null; label: string | null;
  state: 'install' | 'kept' | 'unreadable' | 'unresolved';
  permissions: string[];
  signature: { state: string } | null;
  vault: VaultPreview | null;
};

/** Writes a child package: it names one read secret and one host, unless told otherwise. */
function childPackage(dir: string, opts: { name: string; id: string; version?: string; secrets?: string[]; hosts?: string[]; signed?: boolean }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: opts.name, version: opts.version ?? '1.0.0', main: 'index.js',
    timon: {
      id: opts.id, apiVersion: PLUGIN_API_VERSION, kind: 'behavior', label: opts.id,
      permissions: ['secrets:read', 'http:outbound'],
      ...(opts.secrets?.length ? { secrets: opts.secrets.map((name) => ({ name, mode: 'read', why: 'For the demo' })) } : {}),
      ...(opts.hosts?.length ? { http: { hosts: opts.hosts.map((host) => ({ host })) } } : {}),
    },
  }));
  writeFileSync(join(dir, 'index.js'), 'throw new Error("must never run during a preview");\n');
  if (opts.signed !== false) sign(dir);
}

/** A bundle beside its children `a` and `b`, which name a secret and a host each. */
function namingBundle(): {
  bundle: string; n: number; bundleId: string; a: string; b: string;
  secrets: { a: string; b: string };
} {
  const n = ++serial;
  const set = join(PC, `naming-${n}`);
  const a = `acme-child-a-${n}`;
  const b = `acme-child-b-${n}`;
  childPackage(join(set, `child-a-${n}`), { name: `@acme/child-a-${n}`, id: a, secrets: [`CHILD_A_${n}`], hosts: [`a-${n}.test`] });
  childPackage(join(set, `child-b-${n}`), { name: `@acme/child-b-${n}`, id: b, secrets: [`CHILD_B_${n}`], hosts: [`b-${n}.test`] });
  const bundle = join(set, 'bundle');
  const bundleId = `acme-naming-${n}`;
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: `@acme/naming-${n}`, version: '0.1.0', main: 'index.js',
    dependencies: { [`@acme/child-a-${n}`]: `file:../child-a-${n}`, [`@acme/child-b-${n}`]: `file:../child-b-${n}` },
    timon: { id: bundleId, apiVersion: PLUGIN_API_VERSION, kind: 'bundle', label: 'Naming', permissions: [], contains: [a, b] },
  }));
  writeFileSync(join(bundle, 'index.js'), 'export default {};\n');
  sign(bundle);
  return {
    bundle, n, bundleId, a, b,
    secrets: {
      a: createSecret({ name: `CHILD_A_${n}`, value: 'tok-child-aaaaaaaaaa' }).id,
      b: createSecret({ name: `CHILD_B_${n}`, value: 'tok-child-bbbbbbbbbb' }).id,
    },
  };
}

/** The consent the sheet sends for each child that names something. */
function childrenConsent(children: readonly ChildPreview[], tick: readonly string[]) {
  return children.flatMap((c) => (c.state === 'install' && c.vault && c.pkg && c.version
    ? [{ id: c.id, pkg: c.pkg, version: c.version, ...consentOf(c.vault, tick) }]
    : []));
}

test('bundle: the preview shows what each child names, by id, without a value and without npm', async () => {
  const { bundle, n, a, b } = namingBundle();
  const calls = npmCalls.length;
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  assert.equal(preview.status, 201, preview.text);
  assert.equal(npmCalls.length, calls, 'nothing is installed by a preview');
  assert.equal(preview.json.vault, null, 'the bundle itself names nothing');
  const children = preview.json.children as ChildPreview[];
  assert.deepEqual(children.map((c) => [c.id, c.pkg, c.version, c.state, c.signature?.state]), [
    [a, `@acme/child-a-${n}`, '1.0.0', 'install', 'signed'],
    [b, `@acme/child-b-${n}`, '1.0.0', 'install', 'signed'],
  ]);
  assert.equal(children[0]?.vault?.scope, `agent:plugin:${a}`, 'a child is granted under its own id');
  assert.deepEqual(children[0]?.vault?.secrets.map((s) => [s.name, s.state, s.why]), [[`CHILD_A_${n}`, 'grantable', 'For the demo']]);
  assert.deepEqual(children[1]?.vault?.hosts, [{ host: `b-${n}.test`, why: null, allowedBy: null }]);
  assert.deepEqual(children[0]?.permissions, ['secrets:read', 'http:outbound']);
  assert.ok(!preview.text.includes('tok-child-'), 'the preview never carries a secret value');
  assert.ok(!preview.text.includes(PC), 'the preview never carries a path');
  assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
});

test('bundle: a plugin that is no bundle has no children', async () => {
  const preview = await call('POST', '/stage', { source: 'path', path: pluginFolder() });
  assert.deepEqual(preview.json.children, []);
  const forged = await call('POST', '/confirm', {
    token: preview.json.token, confirm: true,
    vaultChildren: [{ id: 'acme-other', pkg: '@acme/other', version: '1.0.0', secrets: [], hosts: [] }],
  });
  assert.equal(forged.status, 409, forged.text);
  assert.equal(forged.json.error, 'mismatch');
  assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
});

test('bundle: a child already installed is kept, one no dependency declares is unresolved, one only the registry knows is unreadable', async () => {
  const kept = await call('POST', '/stage', { source: 'path', path: pluginFolder() });
  const keptDone = await call('POST', '/confirm', { token: kept.json.token, confirm: true });
  assert.equal(keptDone.status, 200, keptDone.text);
  const keptId = String(keptDone.json.id);

  const n = ++serial;
  const write = (name: string, dependencies: Record<string, string>, contains: string[]): string => {
    const dir = join(PC, `states-${n}`, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@acme/${name}-${n}`, version: '0.1.0', main: 'index.js', dependencies,
      timon: { id: `acme-${name}-${n}`, apiVersion: PLUGIN_API_VERSION, kind: 'bundle', label: name, permissions: [], contains },
    }));
    writeFileSync(join(dir, 'index.js'), 'export default {};\n');
    sign(dir);
    return dir;
  };
  const unresolved = await call('POST', '/stage', { source: 'path', path: write('nobody', {}, [keptId, `acme-ghost-${n}`, `acme-nobody-${n}`]) });
  assert.deepEqual((unresolved.json.children as ChildPreview[]).map((c) => [c.id, c.state, c.vault]), [
    [keptId, 'kept', null],
    [`acme-ghost-${n}`, 'unresolved', null],
    [`acme-nobody-${n}`, 'unresolved', null],
  ]);
  const unreadable = await call('POST', '/stage', { source: 'path', path: write('registry', { [`@acme/far-${n}`]: '^1.0.0' }, [`acme-far-${n}`]) });
  assert.deepEqual((unreadable.json.children as ChildPreview[]).map((c) => [c.id, c.pkg, c.state, c.vault]), [[`acme-far-${n}`, null, 'unreadable', null]]);
  for (const res of [unresolved, unreadable]) assert.equal((await call('DELETE', `/staged/${String(res.json.token)}`)).status, 204);
});

test('bundle: a child path or link leading out of the package and of the plugins folder is never read', async () => {
  const n = ++serial;
  const outside = join(PC, `outside-${n}`);
  childPackage(outside, { name: `@acme/outside-${n}`, id: `acme-outside-${n}`, secrets: [`OUTSIDE_${n}`] });
  const dropped = join(PLUGINS, `dropped-${n}`);
  mkdirSync(join(dropped, 'node_modules', '@acme'), { recursive: true });
  symlinkSync(outside, join(dropped, 'node_modules', '@acme', `link-${n}`), 'junction');
  const sibling = join(PLUGINS, `sibling-${n}`);
  childPackage(sibling, { name: `@acme/sibling-${n}`, id: `acme-sibling-${n}`, secrets: [`SIBLING_${n}`] });
  writeFileSync(join(dropped, 'package.json'), JSON.stringify({
    name: `@acme/dropped-${n}`, version: '0.1.0', main: 'index.js',
    dependencies: {
      [`@acme/link-${n}`]: '^1.0.0',
      [`@acme/up-${n}`]: `file:../../${relative(join(PLUGINS, '..'), outside).split(sep).join('/')}`,
      '../../../../escape': '^1.0.0',
      [`@acme/sibling-${n}`]: `file:../sibling-${n}`,
    },
    timon: {
      id: `acme-dropped-${n}`, apiVersion: PLUGIN_API_VERSION, kind: 'bundle', label: 'Dropped', permissions: [],
      contains: [`acme-outside-${n}`, `acme-sibling-${n}`],
    },
  }));
  writeFileSync(join(dropped, 'index.js'), 'export default {};\n');
  try {
    const preview = await call('POST', '/stage', { source: 'detected', name: `dropped-${n}` });
    assert.equal(preview.status, 201, preview.text);
    const children = preview.json.children as ChildPreview[];
    assert.deepEqual(children.map((c) => [c.id, c.state]), [[`acme-outside-${n}`, 'unreadable'], [`acme-sibling-${n}`, 'install']], 'a neighbour in the plugins folder is read, nothing else');
    assert.ok(!preview.text.includes(`OUTSIDE_${n}`));
    assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
  } finally {
    rmSync(dropped, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('bundle: a child shipped in an archive is shown; a tampered one has nothing to consent to', async () => {
  const n = ++serial;
  const dir = join(PC, `archived-${n}`);
  mkdirSync(dir, { recursive: true });
  const shipped = join(dir, 'node_modules', '@acme', `shipped-${n}`);
  childPackage(shipped, { name: `@acme/shipped-${n}`, id: `acme-shipped-${n}`, secrets: [`SHIPPED_${n}`], hosts: [`shipped-${n}.test`] });
  const altered = join(dir, 'node_modules', '@acme', `altered-${n}`);
  childPackage(altered, { name: `@acme/altered-${n}`, id: `acme-altered-${n}`, secrets: [`ALTERED_${n}`] });
  writeFileSync(join(altered, 'index.js'), 'export default {};\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@acme/archived-${n}`, version: '0.1.0', main: 'index.js',
    dependencies: { [`@acme/shipped-${n}`]: '1.0.0', [`@acme/altered-${n}`]: '1.0.0' },
    timon: {
      id: `acme-archived-${n}`, apiVersion: PLUGIN_API_VERSION, kind: 'bundle', label: 'Archived', permissions: [],
      contains: [`acme-shipped-${n}`, `acme-altered-${n}`],
    },
  }));
  writeFileSync(join(dir, 'index.js'), 'export default {};\n');
  sign(dir);
  const preview = sources.stageUpload(tgzOf(dir));
  const [good, bad] = preview.children as ChildPreview[];
  assert.equal(good?.state, 'install');
  assert.deepEqual(good?.vault?.secrets.map((s) => s.name), [`SHIPPED_${n}`]);
  assert.equal(bad?.signature?.state, 'tampered');
  assert.equal(bad?.vault, null, 'a child that will not load asks nothing of this sheet');
  const consent = [
    ...childrenConsent([good as ChildPreview], []),
    { id: `acme-altered-${n}`, pkg: `@acme/altered-${n}`, version: '1.0.0', secrets: [{ name: `ALTERED_${n}`, mode: 'read' as const, state: 'missing' as const, grant: false }], hosts: [] },
  ];
  await assert.rejects(sources.installStaged(preview.token, { vaultChildren: consent }), (err: unknown) => err instanceof PluginSourceError && err.code === 'mismatch');
  sources.discard(preview.token);
});

test('bundle: ticked lines are granted to that child alone, never to the bundle or another child', async () => {
  const { bundle, n, bundleId, a, b, secrets } = namingBundle();
  const allowBefore = httpAllowInConfig();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  const children = preview.json.children as ChildPreview[];
  const ok = await call('POST', '/confirm', {
    token: preview.json.token, confirm: true,
    vaultChildren: childrenConsent(children, [`CHILD_A_${n}`, `a-${n}.test`, `b-${n}.test`]),
  });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.vaultChildren, [
    { id: a, granted: { secrets: [`CHILD_A_${n}`], hosts: [`a-${n}.test`] }, refused: null },
    { id: b, granted: { secrets: [], hosts: [`b-${n}.test`] }, refused: null },
  ]);
  assert.equal(ok.json.vault, null);
  assert.deepEqual(grantsOf(secrets.a), [`agent:plugin:${a}`]);
  assert.deepEqual(grantsOf(secrets.b), [], 'an unticked secret is not granted');
  assert.deepEqual(byPluginInConfig()[a], [`a-${n}.test`]);
  assert.deepEqual(byPluginInConfig()[b], [`b-${n}.test`]);
  assert.equal(byPluginInConfig()[bundleId], undefined, 'the bundle itself gets nothing');
  assert.deepEqual(httpAllowInConfig(), allowBefore, 'the shared allowlist is never touched');
  const saved = config();
  try {
    setConfig(loadConfig(CONFIG, { readonly: true }));
    assert.doesNotThrow(() => assertFetchAllowed(a, `https://a-${n}.test/`));
    assert.throws(() => assertFetchAllowed(b, `https://a-${n}.test/`), /pluginPolicy/, "another child does not reach it");
    assert.throws(() => assertFetchAllowed(bundleId, `https://a-${n}.test/`), /pluginPolicy/, 'the bundle does not reach it');
  } finally { setConfig(saved); }
});

test('bundle: what the client saw must be what the staged children say — any difference is a 409, nothing written', async () => {
  const { bundle, n, a, b, secrets } = namingBundle();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  const children = preview.json.children as ChildPreview[];
  const good = childrenConsent(children, [`CHILD_A_${n}`, `a-${n}.test`]);
  const first = good[0]!;
  const calls = npmCalls.length;
  const attempts = [
    // A child dropped, a child added, the same child twice, another package or version, a line forged.
    good.slice(1),
    [],
    [...good, { ...first, id: `acme-evil-${n}` }],
    [first, first],
    [{ ...first, pkg: `@acme/evil-${n}` }, good[1]],
    [{ ...first, version: '9.9.9' }, good[1]],
    [{ ...first, id: b }, { ...good[1]!, id: a }],
    [{ ...first, secrets: first.secrets.map((s) => ({ ...s, state: 'granted' as const })) }, good[1]],
    [{ ...first, hosts: [...first.hosts, { host: `evil-${n}.test`, allowedBy: null, grant: true }] }, good[1]],
    [{ ...first, secrets: [...first.secrets, { name: `CHILD_B_${n}`, mode: 'read' as const, state: 'grantable' as const, grant: true }] }, good[1]],
  ];
  for (const forged of attempts) {
    const res = await call('POST', '/confirm', { token: preview.json.token, confirm: true, vaultChildren: forged });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error, 'mismatch', JSON.stringify(forged));
  }
  // The vault moved between the preview and the click: the line shown is stale.
  grantSecret(secrets.b, `agent:plugin:${b}`);
  const stale = await call('POST', '/confirm', { token: preview.json.token, confirm: true, vaultChildren: good });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(npmCalls.length, calls, 'nothing is installed on a mismatch');
  assert.deepEqual(grantsOf(secrets.a), [], 'nothing is granted on a mismatch');
  assert.equal(byPluginInConfig()[a], undefined, 'no host is opened on a mismatch');
  assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
});

test('bundle: a child secret missing from the vault cannot be ticked', async () => {
  const { bundle, n, a, secrets } = namingBundle();
  deleteSecret(secrets.b);
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  const children = preview.json.children as ChildPreview[];
  const calls = npmCalls.length;
  const res = await call('POST', '/confirm', {
    token: preview.json.token, confirm: true,
    vaultChildren: childrenConsent(children, [`CHILD_A_${n}`, `CHILD_B_${n}`]),
  });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, 'not-grantable');
  assert.equal(npmCalls.length, calls);
  assert.deepEqual(grantsOf(secrets.a), []);
  assert.equal(byPluginInConfig()[a], undefined);
  assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
});

test('bundle: installing without the children\'s consent grants them nothing', async () => {
  const { bundle, n, a, secrets } = namingBundle();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  // The bundle's own lines say nothing of its children.
  const res = await call('POST', '/confirm', { token: preview.json.token, confirm: true, vault: { secrets: [], hosts: [] } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.vaultChildren, null);
  assert.deepEqual(grantsOf(secrets.a), []);
  assert.equal(byPluginInConfig()[a], undefined);
  assert.ok(existsSync(join(PLUGINS, `child-a-${n}`)), 'the child is installed all the same');
});

test('bundle: anonymous (401), a non-superadmin, the daemon token and a mission (403) grant no child anything', async () => {
  const { bundle, n, a, secrets } = namingBundle();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  const body = { token: preview.json.token, confirm: true, vaultChildren: childrenConsent(preview.json.children as ChildPreview[], [`CHILD_A_${n}`, `a-${n}.test`]) };
  assert.equal((await call('POST', '/confirm', body, null)).status, 401);
  for (const as of ['bob', 'daemon', 'mission'] as const) {
    assert.equal((await call('POST', '/confirm', body, as)).status, 403, as);
  }
  assert.deepEqual(grantsOf(secrets.a), []);
  assert.equal(byPluginInConfig()[a], undefined);
  assert.equal((await call('DELETE', `/staged/${String(preview.json.token)}`)).status, 204);
});

test('bundle: a failed install grants no child anything', async () => {
  const failing = new PluginInstallSources({
    pluginsRoot: PLUGINS, stagingRoot: STAGING, forbiddenRoots: [TIMON_HOME, PLUGINS],
    publicKeys: KEYS, unsignedLoads: () => false,
    install: { npm: async () => { throw new Error('npm exploded'); }, config: CONFIG, publicKeys: KEYS },
    configFile: CONFIG,
  });
  const { bundle, n, a, secrets } = namingBundle();
  const preview = failing.stagePath(bundle);
  await assert.rejects(failing.installStaged(preview.token, { vaultChildren: childrenConsent(preview.children as ChildPreview[], [`CHILD_A_${n}`, `a-${n}.test`]) }), /npm exploded/);
  assert.deepEqual(grantsOf(secrets.a), []);
  assert.equal(byPluginInConfig()[a], undefined);
});

test('bundle: a child that does not land as it was shown receives nothing — the consent was for that package', async () => {
  const landed = async (differ: { version?: string; secrets?: string[]; hosts?: string[]; signed?: boolean; name?: (n: number) => string }) => {
    const n = ++serial;
    const dir = join(PC, `swapped-${n}`);
    mkdirSync(dir, { recursive: true });
    const pkg = `@acme/swapped-child-${n}`;
    const id = `acme-swapped-child-${n}`;
    const shown = { name: pkg, id, secrets: [`SWAPPED_${n}`], hosts: [`swapped-${n}.test`] };
    // The copy the package ships: all a preview can read of `name@range`.
    childPackage(join(dir, 'node_modules', '@acme', `swapped-child-${n}`), shown);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@acme/swapped-${n}`, version: '0.1.0', main: 'index.js',
      dependencies: { [pkg]: '^1.0.0' },
      timon: { id: `acme-swapped-${n}`, apiVersion: PLUGIN_API_VERSION, kind: 'bundle', label: 'Swapped', permissions: [], contains: [id] },
    }));
    writeFileSync(join(dir, 'index.js'), 'export default {};\n');
    sign(dir);
    // What the registry actually hands npm for that range.
    const registry = join(PC, `registry-${n}`);
    childPackage(registry, {
      ...shown,
      version: differ.version ?? '1.0.0',
      secrets: differ.secrets ? [...shown.secrets, ...differ.secrets.map((s) => `${s}_${n}`)] : shown.secrets,
      hosts: differ.hosts ? [...shown.hosts, ...differ.hosts] : shown.hosts,
      signed: differ.signed ?? true,
    });
    const swapping = new PluginInstallSources({
      pluginsRoot: PLUGINS, stagingRoot: STAGING, forbiddenRoots: [TIMON_HOME, PLUGINS],
      publicKeys: KEYS, unsignedLoads: () => false,
      install: {
        npm: async (args, cwd) => {
          if (args.at(-1) === `${pkg}@^1.0.0`) return npm([...args.slice(0, -1), registry], cwd);
          return npm(args, cwd);
        },
        config: CONFIG, publicKeys: KEYS,
      },
      configFile: CONFIG,
    });
    const secret = createSecret({ name: `SWAPPED_${n}`, value: 'tok-swapped-aaaaaaaa' }).id;
    const preview = swapping.stagePath(dir);
    const children = preview.children as ChildPreview[];
    assert.deepEqual(children[0]?.vault?.secrets.map((s) => [s.name, s.state]), [[`SWAPPED_${n}`, 'grantable']]);
    const done = await swapping.installStaged(preview.token, { vaultChildren: childrenConsent(children, [`SWAPPED_${n}`, `swapped-${n}.test`]) });
    return { done, secret, id, n };
  };
  for (const differ of [{ secrets: ['EXTRA'] }, { hosts: ['evil.test'] }, { version: '1.0.1' }, { signed: false }]) {
    const { done, secret, id } = await landed(differ);
    assert.equal(done.refused, null, 'the bundle itself is installed');
    assert.deepEqual(done.vaultChildren, [{ id, granted: null, refused: 'changed' }], JSON.stringify(differ));
    assert.deepEqual(grantsOf(secret), [], `no grant for ${JSON.stringify(differ)}`);
    assert.equal(byPluginInConfig()[id], undefined, `no host for ${JSON.stringify(differ)}`);
  }
  // The same package landing: the consent holds, for a child read from the shipped copy too.
  const { done, secret, id, n } = await landed({});
  assert.deepEqual(done.vaultChildren, [{ id, granted: { secrets: [`SWAPPED_${n}`], hosts: [`swapped-${n}.test`] }, refused: null }]);
  assert.deepEqual(grantsOf(secret), [`agent:plugin:${id}`]);
  assert.deepEqual(byPluginInConfig()[id], [`swapped-${n}.test`]);
});

test('bundle: a child that did not land receives nothing, and the bundle stays installed', async () => {
  const { bundle, n, a, b, secrets } = namingBundle();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  // Laid in the plugins folder after the preview: its folder name is taken, so the sibling is not.
  mkdirSync(join(PLUGINS, `child-a-${n}`), { recursive: true });
  writeFileSync(join(PLUGINS, `child-a-${n}`, 'package.json'), '{"name":"someone-else","version":"9.9.9"}');
  const res = await call('POST', '/confirm', {
    token: preview.json.token, confirm: true,
    vaultChildren: childrenConsent(preview.json.children as ChildPreview[], [`CHILD_A_${n}`, `CHILD_B_${n}`, `a-${n}.test`, `b-${n}.test`]),
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.vaultChildren, [
    { id: a, granted: null, refused: 'not-installed' },
    { id: b, granted: { secrets: [`CHILD_B_${n}`], hosts: [`b-${n}.test`] }, refused: null },
  ]);
  assert.deepEqual(grantsOf(secrets.a), []);
  assert.equal(byPluginInConfig()[a], undefined);
  assert.deepEqual(grantsOf(secrets.b), [`agent:plugin:${b}`]);
});

// ── A bundle's providers and dictation engines (TODO #673) ────────────────

/** A program of its own per test: the allowlist is shared by the whole file. */
function binaryNamed(name: string): string {
  const file = join(BIN_DIR, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}

function providerChildPackage(dir: string, opts: { name: string; id: string; binaries: string[]; version?: string; signed?: boolean; credentialDirs?: string[] }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: opts.name, version: opts.version ?? '1.0.0', main: 'index.js',
    timon: {
      id: opts.id, apiVersion: PLUGIN_API_VERSION, kind: 'provider', label: opts.id, permissions: ['backends:register'],
      provider: { binaries: opts.binaries.map((name) => ({ name })), osCredentials: [{ service: 'Acme CLI' }], credentialDirs: opts.credentialDirs ?? ['.acme'] },
    },
  }));
  writeFileSync(join(dir, 'index.js'), 'throw new Error("must never run during a preview");\n');
  if (opts.signed !== false) sign(dir);
}

function dictationChildPackage(dir: string, opts: { name: string; id: string; models?: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: opts.name, version: '1.0.0',
    timon: {
      id: opts.id, apiVersion: PLUGIN_API_VERSION, kind: 'dictation', label: opts.id,
      permissions: ['dictation:engine', 'http:outbound'], client: { slots: ['dictation.engine'] },
      dictation: { engines: [{ id: 'cloud', runtime: 'page', egress: ['voice.acme.test'] }], ...(opts.models ? { models: opts.models } : {}) },
    },
  }));
}

function bundleOf(dir: string, n: number, deps: Record<string, string>, contains: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@acme/host-bundle-${n}`, version: '0.1.0', main: 'index.js', dependencies: deps,
    timon: { id: `acme-host-bundle-${n}`, apiVersion: PLUGIN_API_VERSION, kind: 'bundle', label: 'Host', permissions: [], contains },
  }));
  writeFileSync(join(dir, 'index.js'), 'export default {};\n');
  sign(dir);
}

/** A bundle beside a provider, a dictation engine and a child that is neither. */
function hostBundle(): { bundle: string; n: number; provider: string; voice: string; plain: string; pkg: string; binary: string } {
  const n = ++serial;
  const set = join(PC, `host-${n}`);
  const [provider, voice, plain] = [`acme-prov-${n}`, `acme-voice-${n}`, `acme-plain-${n}`];
  const name = `acme-child-agent-${n}`;
  const binary = binaryNamed(name);
  providerChildPackage(join(set, `prov-${n}`), { name: `@acme/prov-${n}`, id: provider, binaries: [name] });
  dictationChildPackage(join(set, `voice-${n}`), { name: `@acme/voice-${n}`, id: voice });
  childPackage(join(set, `plain-${n}`), { name: `@acme/plain-${n}`, id: plain });
  const bundle = join(set, 'bundle');
  bundleOf(bundle, n, {
    [`@acme/prov-${n}`]: `file:../prov-${n}`,
    [`@acme/voice-${n}`]: `file:../voice-${n}`,
    [`@acme/plain-${n}`]: `file:../plain-${n}`,
  }, [provider, voice, plain]);
  return { bundle, n, provider, voice, plain, pkg: `@acme/prov-${n}`, binary };
}

type HostChild = {
  id: string; state: string; pkg: string | null; version: string | null;
  provider: { binaries: Array<{ name: string; resolved: string | null; allowed: boolean; refused: string | null }>; osCredentials: unknown[]; credentialDirs: string[] } | null;
  dictation: { engines: Array<{ id: string; egress: unknown }>; lines: string[] } | null;
};

test('bundle: the preview shows the programs of a provider child and where a dictation child sends the voice, without npm', { skip: !posix }, async () => {
  const { bundle, provider, voice, plain, binary, n } = hostBundle();
  const calls = npmCalls.length;
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  assert.equal(preview.status, 201, preview.text);
  assert.equal(npmCalls.length, calls, 'nothing is installed by a preview');
  const children = preview.json.children as HostChild[];
  const of = (id: string): HostChild => children.find((c) => c.id === id)!;
  assert.deepEqual(of(provider).provider, {
    binaries: [{ name: `acme-child-agent-${n}`, found: `acme-child-agent-${n}`, resolved: binary, allowed: false, refused: null }],
    osCredentials: [{ service: 'Acme CLI' }],
    credentialDirs: ['.acme'],
  });
  assert.equal(of(provider).dictation, null);
  assert.deepEqual(of(voice).dictation?.engines.map((e) => [e.id, e.egress]), [['cloud', ['voice.acme.test']]]);
  assert.match(of(voice).dictation?.lines[0] ?? '', /voice\.acme\.test/);
  assert.equal(of(voice).provider, null);
  assert.equal(of(plain).provider, null);
  assert.equal(of(plain).dictation, null);
  assert.equal(preview.json.provider, null, 'the bundle itself launches nothing');
  sources.discard(preview.json.token as string);
});

test('bundle: installing without accepting allowlists no program of a child', { skip: !posix }, async () => {
  const { bundle, binary } = hostBundle();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  const done = await call('POST', '/confirm', { token: preview.json.token, confirm: true });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.authorizeExecChildren, null);
  assert.ok(!allowInConfig().includes(binary));
});

test('bundle: the accepted programs of a child are allowlisted, once it has landed', { skip: !posix }, async () => {
  const { bundle, provider, pkg, binary } = hostBundle();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  const done = await call('POST', '/confirm', {
    token: preview.json.token, confirm: true,
    authorizeExecChildren: [{ id: provider, pkg, version: '1.0.0', paths: [binary] }],
  });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json.authorizeExecChildren, [{ id: provider, granted: [binary], refused: null }]);
  assert.ok(allowInConfig().includes(binary));
});

test('bundle: anonymous (401), a non-superadmin, the daemon token and a mission (403) allowlist no program of a child', { skip: !posix }, async () => {
  const { bundle, provider, pkg, binary } = hostBundle();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  const body = { token: preview.json.token, confirm: true, authorizeExecChildren: [{ id: provider, pkg, version: '1.0.0', paths: [binary] }] };
  const calls = npmCalls.length;
  assert.equal((await call('POST', '/confirm', body, null)).status, 401);
  for (const as of ['bob', 'daemon', 'mission'] as const) {
    assert.equal((await call('POST', '/confirm', body, as)).status, 403, as);
  }
  assert.equal(npmCalls.length, calls);
  assert.ok(!allowInConfig().includes(binary));
  sources.discard(preview.json.token as string);
});

test('bundle: a forged acceptance is refused before anything is installed or allowlisted, and the preview stays', { skip: !posix }, async () => {
  const { bundle, provider, voice, plain, pkg, binary, n } = hostBundle();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  const line = { id: provider, pkg, version: '1.0.0', paths: [binary] };
  const allowBefore = allowInConfig();
  const calls = npmCalls.length;
  const forged = [
    [{ ...line, paths: ['/usr/bin/ls'] }],
    [{ ...line, paths: [] }],
    [{ ...line, paths: [binary, '/usr/bin/ls'] }],
    [{ ...line, pkg: '@acme/other' }],
    [{ ...line, version: '9.9.9' }],
    [line, line],
    [{ ...line, id: voice, pkg: `@acme/voice-${n}` }],
    [{ ...line, id: plain, pkg: `@acme/plain-${n}` }],
    [{ ...line, id: 'acme-nobody' }],
  ];
  for (const authorizeExecChildren of forged) {
    const res = await call('POST', '/confirm', { token: preview.json.token, confirm: true, authorizeExecChildren });
    assert.equal(res.status, 409, `${JSON.stringify(authorizeExecChildren)}: ${res.text}`);
    assert.equal(res.json.error, 'mismatch');
  }
  const unknownField = await call('POST', '/confirm', { token: preview.json.token, confirm: true, authorizeExecChildren: [{ ...line, extra: true }] });
  assert.equal(unknownField.status, 400, 'strict schema');
  assert.equal(npmCalls.length, calls, 'nothing is installed');
  assert.deepEqual(allowInConfig(), allowBefore);
  const ok = await call('POST', '/confirm', { token: preview.json.token, confirm: true, authorizeExecChildren: [line] });
  assert.equal(ok.status, 200, 'the same preview is still good for what was shown');
});

test('bundle: a child launching a program that can never be allowed is refused (400), never written', { skip: !posix }, async () => {
  const n = ++serial;
  const set = join(PC, `denied-${n}`);
  const id = `acme-denied-${n}`;
  const sh = binaryNamed('sh');
  try {
    providerChildPackage(join(set, `child-${n}`), { name: `@acme/denied-${n}`, id, binaries: ['sh'] });
    bundleOf(join(set, 'bundle'), n, { [`@acme/denied-${n}`]: `file:../child-${n}` }, [id]);
    const preview = await call('POST', '/stage', { source: 'path', path: join(set, 'bundle') });
    const child = (preview.json.children as HostChild[])[0]!;
    assert.ok(child.provider?.binaries[0]?.refused, 'the sheet says it');
    const calls = npmCalls.length;
    const res = await call('POST', '/confirm', {
      token: preview.json.token, confirm: true,
      authorizeExecChildren: [{ id, pkg: `@acme/denied-${n}`, version: '1.0.0', paths: [sh] }],
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.error, 'refused');
    assert.equal(npmCalls.length, calls);
    assert.ok(!allowInConfig().includes(sh));
    sources.discard(preview.json.token as string);
  } finally { rmSync(sh, { force: true }); }
});

test('bundle: a broken signature, a copy npm alone could read and a child already installed have nothing to accept', { skip: !posix }, async () => {
  const n = ++serial;
  const set = join(PC, `nothing-${n}`);
  const name = `acme-nothing-agent-${n}`;
  const binary = binaryNamed(name);
  const [broken, remote, kept] = [`acme-broken-${n}`, `acme-remote-${n}`, `acme-kept-${n}`];
  providerChildPackage(join(set, `broken-${n}`), { name: `@acme/broken-${n}`, id: broken, binaries: [name] });
  writeFileSync(join(set, `broken-${n}`, 'index.js'), 'export default {}; // altered after signing\n');
  providerChildPackage(join(set, `kept-${n}`), { name: `@acme/kept-${n}`, id: kept, binaries: [name] });
  // Already in the plugins folder before the bundle is shown.
  const first = await call('POST', '/stage', { source: 'path', path: join(set, `kept-${n}`) });
  assert.equal((await call('POST', '/confirm', { token: first.json.token, confirm: true })).status, 200);
  bundleOf(join(set, 'bundle'), n, {
    [`@acme/broken-${n}`]: `file:../broken-${n}`,
    [`@acme/remote-${n}`]: '^1.0.0',
    [`@acme/kept-${n}`]: `file:../kept-${n}`,
  }, [broken, remote, kept]);
  const preview = await call('POST', '/stage', { source: 'path', path: join(set, 'bundle') });
  const children = preview.json.children as HostChild[];
  assert.deepEqual(children.map((c) => [c.id, c.state, c.provider]), [[broken, 'install', null], [remote, 'unreadable', null], [kept, 'kept', null]]);
  const calls = npmCalls.length;
  for (const [id, pkg] of [[broken, `@acme/broken-${n}`], [remote, `@acme/remote-${n}`], [kept, `@acme/kept-${n}`]] as const) {
    const res = await call('POST', '/confirm', {
      token: preview.json.token, confirm: true,
      authorizeExecChildren: [{ id, pkg, version: '1.0.0', paths: [binary] }],
    });
    assert.equal(res.status, 409, `${id}: ${res.text}`);
  }
  assert.equal(npmCalls.length, calls);
  assert.ok(!allowInConfig().includes(binary));
  sources.discard(preview.json.token as string);
});

test('bundle: a dictation child whose `models` link leads out of its package is read like a bad manifest', { skip: !posix }, async () => {
  const n = ++serial;
  const id = `acme-voice-link-${n}`;
  const outside = join(PC, `outside-${n}.json`);
  writeFileSync(outside, '{"top":"secret"}');
  // Side by side in the plugins folder, read in place: a picked folder's copy refuses links.
  const dir = join(PLUGINS, `shipped-link-${n}`);
  const beside = join(PLUGINS, `voice-link-${n}`);
  dictationChildPackage(beside, { name: `@acme/voice-link-${n}`, id, models: 'models.json' });
  symlinkSync(outside, join(beside, 'models.json'));
  bundleOf(dir, n, { [`@acme/voice-link-${n}`]: `file:../voice-link-${n}` }, [id]);
  const preview = await call('POST', '/stage', { source: 'detected', name: `shipped-link-${n}` });
  assert.equal(preview.status, 201, preview.text);
  const [child] = preview.json.children as HostChild[];
  assert.equal(child?.id, id);
  assert.equal(child?.state, 'unresolved');
  assert.equal(child?.dictation, null);
  assert.ok(!preview.text.includes('"top"'));
  sources.discard(preview.json.token as string);
  rmSync(dir, { recursive: true, force: true });
  rmSync(beside, { recursive: true, force: true });
});

test('bundle: a provider child that does not land as it was shown has no program allowlisted', { skip: !posix }, async () => {
  const landed = async (differ: { version?: string; extra?: boolean; dirs?: string[]; signed?: boolean; moved?: boolean }) => {
    const n = ++serial;
    const dir = join(PC, `swapped-prov-${n}`);
    const pkg = `@acme/swapped-prov-${n}`;
    const id = `acme-swapped-prov-${n}`;
    const name = `acme-swapped-agent-${n}`;
    const binary = binaryNamed(name);
    const extra = binaryNamed(`acme-swapped-extra-${n}`);
    // The copy the package ships: all a preview can read of `name@range`.
    providerChildPackage(join(dir, 'node_modules', '@acme', `swapped-prov-${n}`), { name: pkg, id, binaries: [name] });
    bundleOf(dir, n, { [pkg]: '^1.0.0' }, [id]);
    // What the registry actually hands npm for that range.
    const registry = join(PC, `registry-prov-${n}`);
    providerChildPackage(registry, {
      name: pkg, id,
      binaries: differ.extra ? [name, `acme-swapped-extra-${n}`] : [name],
      version: differ.version ?? '1.0.0',
      signed: differ.signed ?? true,
      credentialDirs: differ.dirs ?? ['.acme'],
    });
    const swapping = new PluginInstallSources({
      pluginsRoot: PLUGINS, stagingRoot: STAGING, forbiddenRoots: [TIMON_HOME, PLUGINS],
      publicKeys: KEYS, unsignedLoads: () => false,
      install: {
        npm: async (args, cwd) => {
          if (args.at(-1) !== `${pkg}@^1.0.0`) return npm(args, cwd);
          if (differ.moved) rmSync(binary, { force: true });
          return npm([...args.slice(0, -1), registry], cwd);
        },
        config: CONFIG, publicKeys: KEYS,
      },
      configFile: CONFIG,
    });
    const preview = swapping.stagePath(dir);
    const done = await swapping.installStaged(preview.token, { authorizeExecChildren: [{ id, pkg, version: '1.0.0', paths: [binary] }] });
    return { done, id, binary, extra };
  };
  for (const differ of [{ extra: true }, { dirs: ['.other'] }, { version: '1.0.1' }, { signed: false }, { moved: true }]) {
    const { done, id, binary, extra } = await landed(differ);
    assert.equal(done.refused, null, 'the bundle itself is installed');
    assert.deepEqual(done.authorizeExecChildren, [{ id, granted: null, refused: 'changed' }], JSON.stringify(differ));
    assert.ok(!allowInConfig().includes(binary), `no path for ${JSON.stringify(differ)}`);
    assert.ok(!allowInConfig().includes(extra), `no extra path for ${JSON.stringify(differ)}`);
  }
  // The same package landing: the acceptance holds, for a child read from the shipped copy too.
  const { done, id, binary } = await landed({});
  assert.deepEqual(done.authorizeExecChildren, [{ id, granted: [binary], refused: null }]);
  assert.ok(allowInConfig().includes(binary));
});

test('bundle: a provider child that did not land has no program allowlisted, and the bundle stays installed', { skip: !posix }, async () => {
  const { bundle, provider, pkg, binary, n } = hostBundle();
  const preview = await call('POST', '/stage', { source: 'path', path: bundle });
  // Laid in the plugins folder after the preview: its folder name is taken, so the sibling is not.
  mkdirSync(join(PLUGINS, `prov-${n}`), { recursive: true });
  writeFileSync(join(PLUGINS, `prov-${n}`, 'package.json'), '{"name":"someone-else","version":"9.9.9"}');
  const res = await call('POST', '/confirm', {
    token: preview.json.token, confirm: true,
    authorizeExecChildren: [{ id: provider, pkg, version: '1.0.0', paths: [binary] }],
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.authorizeExecChildren, [{ id: provider, granted: null, refused: 'not-installed' }]);
  assert.ok(!allowInConfig().includes(binary));
});

test('bundle: a failed install allowlists no program of a child', { skip: !posix }, async () => {
  const { bundle, provider, pkg, binary } = hostBundle();
  const failing = new PluginInstallSources({
    pluginsRoot: PLUGINS, stagingRoot: STAGING, forbiddenRoots: [TIMON_HOME, PLUGINS],
    publicKeys: KEYS, unsignedLoads: () => false,
    install: { npm: async () => { throw new Error('npm exploded'); }, config: CONFIG, publicKeys: KEYS },
    configFile: CONFIG,
  });
  const preview = failing.stagePath(bundle);
  await assert.rejects(failing.installStaged(preview.token, { authorizeExecChildren: [{ id: provider, pkg, version: '1.0.0', paths: [binary] }] }), /npm exploded/);
  assert.ok(!allowInConfig().includes(binary));
});
