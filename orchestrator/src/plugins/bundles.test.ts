/**
 * Bundle server: path confinement and caching by `rev`.
 *
 * What these tests protect: a URL never designates a file. The id goes
 * through the registry, and the registry only knows paths declared by
 * `exports['./client']` and confined to the package. A traversal attempt,
 * a missing plugin, a stale revision: 404, never another
 * file.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const { BundleRegistry, bundleRouter, codeDigest, resolveClientEntry, BUNDLE_ROUTE_PREFIX } = await import('./bundles.js');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const OK_DIR = join(FIXTURES, 'ok');
const CLIENT = join(OK_DIR, 'lib', 'client.js');
const CLIENT_BODY = readFileSync(CLIENT);
const CLIENT_REV = createHash('sha256').update(CLIENT_BODY).digest('hex');

function pkg(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: '@fixtures/plugin-ok',
    exports: { './client': './lib/client.js' },
    ...overrides,
  };
}

async function serve(
  registry: BundleRegistry,
  opts: { permissions?: string[]; kinds?: readonly string[] } = {},
): Promise<{
  url: (p: string) => string;
  close: () => Promise<void>;
}> {
  const app = express();
  if (opts.permissions) {
    // A non-superadmin viewer carrying exactly these grants. `api-token` with
    // an explicit permission list is the one `req.auth` shape that needs no
    // session and no users table (`users/identity.ts`).
    const permissions = opts.permissions;
    app.use((req, _res, next) => {
      (req as unknown as { auth: unknown }).auth = {
        kind: 'api-token',
        actorId: 'ada',
        isSuperadmin: false,
        permissions,
      };
      next();
    });
  }
  app.use(bundleRouter(() => registry, () => opts.kinds ?? []));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: (p) => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test('resolveClientEntry refuses a path that leaves the package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-bundle-'));
  const res = resolveClientEntry(dir, { exports: { './client': '../secret.js' } });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.message, /escapes the package/);
  rmSync(dir, { recursive: true, force: true });
});

test('resolveClientEntry refuses an absolute path and a missing exports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-bundle-'));
  assert.equal(resolveClientEntry(dir, { exports: { './client': '/etc/passwd' } }).ok, false);
  assert.equal(resolveClientEntry(dir, { name: 'x' }).ok, false);
  assert.equal(resolveClientEntry(dir, { exports: { './other': './x.js' } }).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test('GET /plugins/<id>/client.js serves the declared file, not a neighbour', async () => {
  const registry = new BundleRegistry();
  const registered = registry.register('fixture-ok', OK_DIR, pkg());
  assert.equal(registered.ok, true);
  if (registered.ok) assert.equal(registered.bundle.rev, CLIENT_REV);

  const s = await serve(registry);
  const res = await fetch(s.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js?rev=${CLIENT_REV}`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await res.text(), CLIENT_BODY.toString('utf8'));
  await s.close();
});

test('without rev: no-cache; unknown revision: 404; identical: cacheable', async () => {
  const registry = new BundleRegistry();
  registry.register('fixture-ok', OK_DIR, pkg());
  const s = await serve(registry);

  const fresh = await fetch(s.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js`));
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('cache-control'), 'no-cache');

  const stale = await fetch(s.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js?rev=deadbeef`));
  assert.equal(stale.status, 404);
  const body = await stale.json() as { error: string; rev: string };
  assert.equal(body.rev, CLIENT_REV);

  const cached = await fetch(s.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js?rev=${CLIENT_REV}`));
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  await cached.arrayBuffer();

  const notModified = await fetch(s.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js?rev=${CLIENT_REV}`), {
    headers: { 'If-None-Match': `"${CLIENT_REV}"` },
  });
  assert.equal(notModified.status, 304);
  await s.close();
});

test('plugin absent → 404', async () => {
  const s = await serve(new BundleRegistry());
  const res = await fetch(s.url(`${BUNDLE_ROUTE_PREFIX}/absent-plugin/client.js`));
  assert.equal(res.status, 404);
  await s.close();
});

test('a traversal attempt is refused: the URL does not build a path', async () => {
  const registry = new BundleRegistry();
  registry.register('fixture-ok', OK_DIR, pkg());
  const s = await serve(registry);

  const attempts = [
    `${BUNDLE_ROUTE_PREFIX}/../loader/client.js`,
    `${BUNDLE_ROUTE_PREFIX}/%2e%2e/client.js`,
    `${BUNDLE_ROUTE_PREFIX}/fixture-ok%2f..%2f..%2fpackage.json`,
    `${BUNDLE_ROUTE_PREFIX}/fixture-ok/../loader/client.js`,
    `${BUNDLE_ROUTE_PREFIX}/fixture-ok/lib/index.js`,
  ];
  for (const path of attempts) {
    const res = await fetch(s.url(path));
    assert.equal(res.status, 404, `${path} must serve nothing (got ${res.status})`);
    await res.arrayBuffer();
  }
  await s.close();
});

test('an exports entry pointing outside the package is never registered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-bundle-'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'client.js'), 'export default 1\n');
  const registry = new BundleRegistry();
  const res = registry.register('sneaky', dir, { exports: { './client': '../../../etc/passwd' } });
  assert.equal(res.ok, false);
  assert.equal(registry.get('sneaky'), null);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * T.5 — `layout:<short>` opens the browser half of a THIRD-PARTY LAYOUT, and
 * only of a layout. The route reads the kind resolved by the loader, never the
 * permission: a role can carry a `layout:<id>` string the catalogue never
 * minted for that package.
 */
test('layout:<short> serves the browser half of a third-party layout', async () => {
  const registry = new BundleRegistry();
  registry.register('fixture-ok', OK_DIR, pkg());
  const s = await serve(registry, {
    permissions: ['layout:fixture-ok'],
    kinds: ['layout'],
  });
  const res = await fetch(s.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js`));
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), CLIENT_BODY.toString());
  await s.close();
});

test('theme:<short> serves only the browser half of a resolved third-party theme', async () => {
  const registry = new BundleRegistry();
  registry.register('fixture-ok', OK_DIR, pkg());

  const theme = await serve(registry, {
    permissions: ['theme:fixture-ok'],
    kinds: ['theme'],
  });
  const served = await fetch(theme.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js`));
  assert.equal(served.status, 200);
  await served.arrayBuffer();
  await theme.close();

  for (const kinds of [['widget'], ['behavior'], ['page', 'widget'], []]) {
    const denied = await serve(registry, { permissions: ['theme:fixture-ok'], kinds });
    const hidden = await fetch(denied.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js`));
    assert.equal(hidden.status, 404, `kind ${JSON.stringify(kinds)} must stay hidden`);
    await hidden.arrayBuffer();
    await denied.close();
  }
});

test('layout:<short> on a package that is not a layout: 404', async () => {
  for (const kinds of [['widget'], ['behavior'], ['page', 'widget'], []]) {
    const registry = new BundleRegistry();
    registry.register('fixture-ok', OK_DIR, pkg());
    const s = await serve(registry, { permissions: ['layout:fixture-ok'], kinds });
    const res = await fetch(s.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js`));
    assert.equal(res.status, 404, `kind ${JSON.stringify(kinds)} must serve nothing`);
    await res.arrayBuffer();
    await s.close();
  }
});

test('a layout+behavior package serves its browser half, plugin:<id> stays required for the rest', async () => {
  const registry = new BundleRegistry();
  registry.register('fixture-ok', OK_DIR, pkg());
  const chrome = await serve(registry, {
    permissions: ['layout:fixture-ok'],
    kinds: ['layout', 'behavior'],
  });
  const res = await fetch(chrome.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js`));
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  await chrome.close();

  // With neither key, nothing, even for a layout.
  const denied = await serve(registry, { permissions: ['widget:fixture-ok'], kinds: ['layout'] });
  const shut = await fetch(denied.url(`${BUNDLE_ROUTE_PREFIX}/fixture-ok/client.js`));
  assert.equal(shut.status, 404);
  await shut.arrayBuffer();
  await denied.close();
});

// TIM-0135 — one release built on Windows (CRLF checkout) and on Linux (LF):
// two byte revisions, one code identity; any other edit changes it.
test('digest ignores CRLF line endings, rev does not, a code change moves both', () => {
  const lf = Buffer.from('export function apply() {\n  return 1;\n}\n');
  const crlf = Buffer.from('export function apply() {\r\n  return 1;\r\n}\r\n');
  const edited = Buffer.from('export function apply() {\n  return 2;\n}\n');
  const loneCr = Buffer.from('export function apply() {\r  return 1;\r}\r');
  assert.equal(codeDigest(crlf), codeDigest(lf));
  assert.notEqual(codeDigest(edited), codeDigest(lf));
  assert.notEqual(codeDigest(loneCr), codeDigest(lf));

  const dirs = [lf, crlf].map((body) => {
    const dir = mkdtempSync(join(tmpdir(), 'timon-bundle-eol-'));
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'client.js'), body);
    return dir;
  });
  try {
    const [a, b] = dirs.map((dir) => {
      const res = new BundleRegistry().register('fixture-ok', dir, pkg());
      assert.equal(res.ok, true);
      return res.ok ? res.bundle : null;
    });
    assert.notEqual(a?.rev, b?.rev);
    assert.equal(a?.digest, b?.digest);
    assert.equal(a?.digest, codeDigest(lf));
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
