/**
 * The `web-app` module: what decides to launch (or not) the Next app.
 *
 * What these tests protect, in the order of risk:
 *   1. `app.enabled` at `false` (the default) spawns NOTHING. That is what keeps
 *      a daemon restart from putting a second Next on the :3100 already served
 *      by the Compose container.
 *   2. An app that is not built produces an actionable message and a no-op, never
 *      a throw, which would take the daemon down with the UI.
 *   3. The child goes through `host.spawn` (not `child_process`), and `dispose`
 *      kills it: it alone, and only if it has a pid.
 *
 * No test opens a port: the host is fake and returns a fake child.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { loadConfig, setConfig } = await import('../../config/load.js');
const { createHostPlugin } = await import('../../kernel/host-service.js');
const webApp = await import('./index.js');
const { TimonConfigSchema } = await import('../../config/schema.js');

type FakeChild = EventEmitter & { pid?: number; kill: () => boolean; killed: boolean };

function fakeChild(pid: number | undefined): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

/** Fake host: runs nothing, records the calls to `spawn`. */
function fakeHost(child: FakeChild) {
  const calls: { name: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const host = {
    platform: 'linux' as const,
    capabilities: () => [],
    bin: (n: string) => n,
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
    execAsync: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawn: (name: string, args: string[], opts: Record<string, unknown> = {}) => {
      calls.push({ name, args, opts });
      return child as never;
    },
    confine: (cmd: string, args: string[]) => ({ cmd, args }),
    services: {
      start: () => {}, stop: () => {}, status: () => 'stopped' as const,
      self: () => ({ status: 'running' }), selfRestart: () => {},
    },
  };
  return { host, calls };
}

/** The default schema config, with a throwaway `installDir`: the module
 *  derives `<installDir>/../app` from it. */
function configFor(root: string, app: Record<string, unknown>) {
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  const cfg = TimonConfigSchema.parse({ daemon: { installDir: join(root, 'orchestrator') }, app });
  setConfig(cfg);
  return cfg;
}

async function applyWith(host: unknown) {
  const root = new Context();
  await root.plugin(createHostPlugin(host as never));
  const fork = await root.plugin({
    name: webApp.name,
    inject: webApp.inject,
    apply: webApp.apply,
  });
  return fork;
}

test('the schema default leaves `app.enabled` false: no spawn at boot', async () => {
  const fresh = loadConfig(join(mkdtempSync(join(tmpdir(), 'timon-web-app-')), 'absent.json'));
  assert.equal(fresh.app.enabled, false, 'a missing config file must change nothing in the current behaviour');

  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  configFor(root, { enabled: false });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  await applyWith(host);
  assert.deepEqual(calls, []);
});

test('app enabled but not built: actionable message and no-op, no throw', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  mkdirSync(join(root, 'app'), { recursive: true }); // no `.next`
  configFor(root, { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);

  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    await applyWith(host); // must not reject
  } finally {
    console.error = realError;
  }

  assert.deepEqual(calls, [], 'no child while `.next` is missing');
  assert.ok(errors.some((e) => e.includes('app not built: cd app && npm run build')), errors.join('\n'));
});

test('app enabled but .next incomplete (no prerender-manifest): no-op, no crash loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  mkdirSync(join(root, 'app', '.next'), { recursive: true });
  configFor(root, { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    await applyWith(host);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(calls, []);
  assert.ok(errors.some((e) => e.includes('prerender-manifest.json')), errors.join('\n'));
});

test('app enabled and built: spawn through the host, the disposer kills the child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, '.next'), { recursive: true });
  writeFileSync(join(appDir, '.next', 'prerender-manifest.json'), '{"version":4}\n');
  const cfg = configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 31_998 } });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);

  const fork = await applyWith(host);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'node', 'the child goes through the host, never through child_process');
  assert.deepEqual(calls[0].args, [join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/server.ts']);
  assert.equal(calls[0].opts.cwd, appDir);
  const env = calls[0].opts.env as Record<string, string>;
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.PORT, '31998');
  assert.equal(env.HOSTNAME_BIND, '127.0.0.1');
  assert.equal(env.ORCHESTRATOR_URL, `http://127.0.0.1:${cfg.daemon.listen.port}`);
  assert.equal(env.TIMON_HOME, process.env.TIMON_HOME);
  const { ensureDaemonToken } = await import('../http/auth.js');
  assert.equal(env.TIMON_DAEMON_TOKEN, ensureDaemonToken());

  await fork.dispose();
  assert.equal(child.killed, true);
});

test('app built with its compiled server: node launches it without tsx (desktop package)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, '.next', 'timon'), { recursive: true });
  writeFileSync(join(appDir, '.next', 'prerender-manifest.json'), '{"version":4}\n');
  writeFileSync(join(appDir, '.next', 'timon', 'server.cjs'), '');
  configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 31_997 } });
  const child = fakeChild(4243);
  const { host, calls } = fakeHost(child);

  const fork = await applyWith(host);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [join(appDir, '.next', 'timon', 'server.cjs')], 'the compiled JS wins: tsx is missing from the package');
  assert.equal(calls[0].opts.cwd, appDir, 'Next resolves `.next` from the cwd, not from the launched file');
  await fork.dispose();
});

/** An app directory with the compiled server and `tsx`, and optionally the sources. */
function builtApp(withSources: boolean): string {
  const appDir = join(mkdtempSync(join(tmpdir(), 'timon-web-app-')), 'app');
  mkdirSync(join(appDir, '.next', 'timon'), { recursive: true });
  writeFileSync(join(appDir, '.next', 'timon', 'server.cjs'), '');
  mkdirSync(join(appDir, 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  if (withSources) {
    mkdirSync(join(appDir, 'src'), { recursive: true });
    writeFileSync(join(appDir, 'src', 'server.ts'), '');
  }
  return appDir;
}

test('checkout: the TypeScript source stays launched by tsx, even after a build', () => {
  const appDir = builtApp(true);
  assert.deepEqual(webApp.appEntryArgs(appDir, 'server'), [join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/server.ts']);
});

test('package: the compiled JS goes through tsx, the only one able to require() an ESM module under Node 20', () => {
  const appDir = builtApp(false);
  assert.deepEqual(webApp.appEntryArgs(appDir, 'server'), [
    join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(appDir, '.next', 'timon', 'server.cjs'),
  ]);
});

test('appEntryRunnable: neither compiled JS nor tsx, nothing can start', () => {
  const appDir = join(mkdtempSync(join(tmpdir(), 'timon-web-app-')), 'app');
  mkdirSync(appDir, { recursive: true });
  assert.equal(webApp.appEntryRunnable(appDir, 'server'), false);
  mkdirSync(join(appDir, 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  assert.equal(webApp.appEntryRunnable(appDir, 'server'), true, 'source mode: tsx is enough');
});

test('envOf sets TIMON_DAEMON_TOKEN = the daemon token, never an inherited value', async () => {
  const { ensureDaemonToken } = await import('../http/auth.js');
  const token = ensureDaemonToken();
  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  const cfg = configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 31_997 } });
  const env = webApp.envOf(cfg);
  assert.equal(env.TIMON_DAEMON_TOKEN, token);
  assert.equal(env.TIMON_HOME, process.env.TIMON_HOME);
});

test('TIMON_ALLOW_HTTP set in Settings reaches the app, which reads only its own env (TODO #540)', async () => {
  const { setSetting } = await import('../../settings.js');
  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  const cfg = configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 31_996 } });
  const inherited = process.env.TIMON_ALLOW_HTTP;
  delete process.env.TIMON_ALLOW_HTTP;
  try {
    assert.equal(webApp.envOf(cfg).TIMON_ALLOW_HTTP, '0', 'default: HTTPS required');
    assert.deepEqual(setSetting('TIMON_ALLOW_HTTP', 'true'), { ok: true });
    assert.equal(webApp.envOf(cfg).TIMON_ALLOW_HTTP, '1', 'the value the app compares against');
    assert.deepEqual(setSetting('TIMON_ALLOW_HTTP', null), { ok: true });
    assert.equal(webApp.envOf(cfg).TIMON_ALLOW_HTTP, '0', 'back to the default');
  } finally {
    setSetting('TIMON_ALLOW_HTTP', null);
    if (inherited === undefined) delete process.env.TIMON_ALLOW_HTTP; else process.env.TIMON_ALLOW_HTTP = inherited;
  }
});

test('the Compose app takes TIMON_ALLOW_HTTP from .env: the registry cannot reach it, and every place says so (TODO #604)', async () => {
  const { SETTINGS } = await import('../../settings.js');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const read = (...path: string[]) => readFileSync(join(repo, ...path), 'utf8');

  const compose = read('docker-compose.yml');
  const service = compose.slice(compose.indexOf('\n  app:\n'), compose.indexOf('\n  app-dev:\n'));
  assert.match(service, /env_file:\s+- \.env\n/, 'the service reads .env');
  assert.doesNotMatch(service, /^\s*-\s*TIMON_ALLOW_HTTP\b/m, 'a value set here would overrule what the docs tell people to edit');

  const example = read('.env.example');
  assert.match(example, /^# TIMON_ALLOW_HTTP=1\b/m, 'still documented, for whoever needs it');
  assert.doesNotMatch(example, /^\s*TIMON_ALLOW_HTTP=/m, 'a copied example must not accept tokens over plain HTTP (TODO #658)');
  const docker = read('public-docs', 'docs', 'installation', 'docker.md');
  assert.match(docker, /`TIMON_ALLOW_HTTP`/);
  assert.match(docker, /`426 Upgrade Required`/, 'the refusal a fresh install gets is explained');
  const setting = SETTINGS.find((s) => s.key === 'TIMON_ALLOW_HTTP');
  assert.match(setting?.description ?? '', /Docker Compose ignores this setting/);
});

test('a copied .env.example gets the product, not the development instance (TODO #745)', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const example = readFileSync(join(repo, '.env.example'), 'utf8');
  assert.match(example, /^# TIMON_INSTANCE=dev\b/m, 'still documented, for a development instance');
  assert.doesNotMatch(example, /^\s*TIMON_INSTANCE=/m, 'a fresh Docker install must not be titled "Timon DEV"');
});

test('a child without a pid is not killed: `kill` on a missing pid signals the whole group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  mkdirSync(join(root, 'app', '.next'), { recursive: true });
  writeFileSync(join(root, 'app', '.next', 'prerender-manifest.json'), '{"version":4}\n');
  const cfg = configFor(root, { enabled: true });
  const child = fakeChild(undefined);
  const { host } = fakeHost(child);

  const dispose = webApp.superviseApp(host as never, cfg, join(root, 'app'));
  dispose();
  assert.equal(child.killed, false);
});

test('restarts: backoff 2 s → 30 s, then give up and alert at the 6th quick fall', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  mkdirSync(join(root, 'app', '.next'), { recursive: true });
  const cfg = configFor(root, { enabled: true });

  const children: FakeChild[] = [];
  const calls: unknown[] = [];
  const host = {
    ...fakeHost(fakeChild(1)).host,
    spawn: () => {
      const child = fakeChild(1000 + children.length);
      children.push(child);
      calls.push(child);
      return child as never;
    },
  };

  const realWarn = console.warn;
  const realError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const dispose = webApp.superviseApp(host as never, cfg, join(root, 'app'));
    assert.equal(children.length, 1);

    // Five restarts: 2 s, 4 s, 8 s, 16 s, 30 s (cap).
    for (const [i, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
      children[i].emit('exit', 1, null);
      t.mock.timers.tick(delay - 1);
      assert.equal(children.length, i + 1, `restart #${i + 1} too early`);
      t.mock.timers.tick(1);
      assert.equal(children.length, i + 2, `restart #${i + 1} missing after ${delay} ms`);
    }

    // 6th fall without the app ever holding for a minute: no more restarts,
    // an alert instead.
    children[5].emit('exit', 1, null);
    t.mock.timers.tick(120_000);
    assert.equal(children.length, 6, 'beyond the cap, we give up');

    dispose();
  } finally {
    console.warn = realWarn;
    console.error = realError;
    t.mock.timers.reset();
  }

  const { dbApi } = await import('../../db.js');
  const alert = dbApi.listNotifications({ limit: 10 }).find((n) => n.title.includes('The web app'));
  assert.ok(alert, 'an alert must be created when giving up');
  assert.equal(alert.type, 'alert');
  assert.ok(alert.body?.includes('code 1'));
  assert.ok(!alert.body?.includes('npm run build'));
});

/**
 * The daemon's own `PORT` (moved by the packaged shell, step 5.6.3) must not
 * follow the child: Next reads `PORT` to choose ITS socket, and inheriting the
 * daemon's would put both on the same port. `envOf` is spread AFTER
 * `process.env` in `superviseApp` for that reason — this test holds the order.
 */
test("the daemon's PORT does not contaminate the Next app", () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-web-app-'));
  const cfg = configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 3110 } });
  const childEnv = { ...process.env, PORT: '3010', ...webApp.envOf(cfg) };
  assert.equal(childEnv['PORT'], '3110', 'the app listens on its own port, not the daemon one');
  assert.equal(childEnv['ORCHESTRATOR_URL'], 'http://127.0.0.1:3000');
});

/**
 * `node` on the PATH is an assumption a package cannot make (step 5.6.5).
 *
 * The daemon inside an installer runs on Electron's Node; if the machine has
 * no `node`, the host adapter refuses the spawn and the UI simply never comes
 * up. The binary it is already running on is the one to hand down.
 */
test('without node on the machine, the packaged daemon lends its own', () => {
  const cfg = TimonConfigSchema.parse({});
  const packaged = webApp.nodeRuntime(cfg, { execPath: '/opt/Timon/timon', electron: '33.4.11' });
  assert.equal(packaged.command, '/opt/Timon/timon');
  assert.equal(packaged.env['ELECTRON_RUN_AS_NODE'], '1');

  // Daemon on a host: `node` is still the right answer, and nothing is added.
  const hosted = webApp.nodeRuntime(cfg, { execPath: '/usr/bin/node', electron: undefined });
  assert.equal(hosted.command, 'node');
  assert.deepEqual(hosted.env, {});
});

test('host.binaries.node settles it, even in a package', () => {
  // A GUI process inherits a minimal PATH; naming the binary is the operator's
  // way out, and it must win over the runtime we guessed.
  const cfg = TimonConfigSchema.parse({ host: { binaries: { node: '/usr/local/bin/node' } } });
  const rt = webApp.nodeRuntime(cfg, { execPath: '/opt/Timon/timon', electron: '33.4.11' });
  assert.equal(rt.command, '/usr/local/bin/node');
  assert.deepEqual(rt.env, {});
});

test('TIM-0011: one clean exit retries after backoff and remains supervised', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  const { dbApi } = await import('../../db.js');
  const before = dbApi.listNotifications({ limit: 100 }).length;
  const dispose = webApp.superviseApp(host, cfg, tmpdir());
  try {
    child.emit('exit', 0, null);
    t.mock.timers.tick(1999);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 2);
    t.mock.timers.tick(120_000);
    assert.equal(dbApi.listNotifications({ limit: 100 }).length, before);
    child.emit('exit', 1, null);
    t.mock.timers.tick(2000);
    assert.equal(calls.length, 3, 'supervision remains active');
  } finally { dispose(); }
});

test('TIM-0011: repeated clean exits stop after two retries with a dedicated alert', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  const { dbApi } = await import('../../db.js');
  const before = dbApi.listNotifications({ limit: 100 }).length;
  const dispose = webApp.superviseApp(host, cfg, tmpdir());
  try {
    for (const [i, delay] of [2000, 4000].entries()) {
      child.emit('exit', 0, null);
      t.mock.timers.tick(delay - 1);
      assert.equal(calls.length, i + 1);
      t.mock.timers.tick(1);
      assert.equal(calls.length, i + 2);
      assert.equal(dbApi.listNotifications({ limit: 100 }).length, before);
    }
    // A longer uptime must not turn recurring clean exits into an endless loop.
    t.mock.timers.tick(120_000);
    child.emit('exit', 0, null);
    t.mock.timers.tick(120_000);
    assert.equal(calls.length, 3);
    const alerts = dbApi.listNotifications({ limit: 100 });
    assert.equal(alerts.length, before + 1);
    const alert = alerts.find(n => n.body?.includes('clean exit'));
    assert.ok(alert?.body?.includes('no longer supervised'));
    assert.ok(!alert?.body?.includes('npm run build'));
  } finally { dispose(); }
});

for (const pendingRetry of [false, true]) {
  test(`TIM-0011: disposal prevents restart (pending retry: ${pendingRetry})`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
    const child = fakeChild(4242);
    const { host, calls } = fakeHost(child);
    const dispose = webApp.superviseApp(host, cfg, tmpdir());
    if (pendingRetry) child.emit('exit', 0, null);
    dispose();
    child.emit('exit', 143, null);
    t.mock.timers.tick(120_000);
    assert.equal(calls.length, 1);
    assert.equal(child.killed, !pendingRetry);
  });
}

test('TIM-0011: occupied port waits for release without spawning a competing app', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let occupied = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: !occupied, detail: occupied ? 'port occupied; listener PID(s) 99 (application identity unverified)' : 'port available' }) }, cfg, tmpdir());
  try {
    assert.equal(calls.length, 0);
    t.mock.timers.tick(2000);
    assert.equal(calls.length, 0);
    occupied = false;
    t.mock.timers.tick(4000);
    assert.equal(calls.length, 1);
  } finally { dispose(); }
});

test('TIM-0011: persistent port conflict has its own alert and no child', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: false, detail: 'port occupied; listener PID(s) 99 (application identity unverified)' }) }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000, 30000]) t.mock.timers.tick(delay);
    assert.equal(calls.length, 0);
    const { dbApi } = await import('../../db.js');
    const alert = dbApi.listNotifications({ limit: 20 }).find(n => n.body?.includes('listener PID(s) 99'));
    assert.ok(alert?.body?.includes('app.listen.port'));
    assert.ok(!alert?.body?.includes('npm run build'));
  } finally { dispose(); }
});

test('TIM-0011: disposal during an asynchronous port check prevents late spawn', async () => {
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let release!: (state: { available: boolean; detail: string }) => void;
  const checking = new Promise<{ available: boolean; detail: string }>(resolve => { release = resolve; });
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => checking }, cfg, tmpdir());
  dispose();
  release({ available: true, detail: 'port available' });
  await checking;
  await Promise.resolve();
  assert.equal(calls.length, 0);
});

test('TIM-0011: signalled stop still restarts for timon app restart', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  const dispose = webApp.superviseApp(host, cfg, tmpdir());
  try {
    child.emit('exit', 143, null);
    t.mock.timers.tick(2000);
    assert.equal(calls.length, 2);
  } finally { dispose(); }
});


test('TIM-0011: waiting supervisor does not erase the previous app PID', () => {
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const { host } = fakeHost(fakeChild(4242));
  mkdirSync(dirname(webApp.APP_PID_FILE), { recursive: true });
  writeFileSync(webApp.APP_PID_FILE, '99\n');
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: false, detail: 'port occupied' }) }, cfg, tmpdir());
  dispose();
  assert.equal(readFileSync(webApp.APP_PID_FILE, 'utf8'), '99\n');
});

// macOS tester report, 26/10/2026: the Next of a crashed embedded daemon held
// :3110 for about a minute; the service daemon gave up after five checks and
// never started the UI again, though the port was free soon after.
test('a port held past the backoff ladder is still polled, and the app starts once it is free', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let checks = 0;
  let occupied = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => {
    checks += 1;
    return { available: !occupied, detail: occupied ? 'port occupied; listener PID(s) 23254' : 'port available' };
  } }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]) t.mock.timers.tick(delay);
    assert.equal(checks, 10);
    assert.equal(calls.length, 0);
    occupied = false;
    t.mock.timers.tick(30000);
    assert.equal(calls.length, 1);
  } finally { dispose(); }
});

test('a long port wait raises exactly one alert', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: false, detail: 'port occupied; listener PID(s) 31337' }) }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000]) t.mock.timers.tick(delay);
    for (let i = 0; i < 25; i += 1) t.mock.timers.tick(30000);
    assert.equal(calls.length, 0);
    const { dbApi } = await import('../../db.js');
    const alerts = dbApi.listNotifications({ limit: 50 }).filter(n => n.body?.includes('listener PID(s) 31337'));
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0]?.body?.includes('keeps checking'));
  } finally { dispose(); }
});

test('disposal during the long port poll prevents any later spawn', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let occupied = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: !occupied, detail: occupied ? 'port occupied' : 'port available' }) }, cfg, tmpdir());
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) t.mock.timers.tick(delay);
  dispose();
  occupied = false;
  t.mock.timers.tick(120_000);
  assert.equal(calls.length, 0);
});

test('a failing port check keeps waiting instead of giving up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let broken = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => {
    if (broken) throw new Error('lsof missing');
    return { available: true, detail: 'port available' };
  } }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000, 30000]) t.mock.timers.tick(delay);
    assert.equal(calls.length, 0);
    broken = false;
    t.mock.timers.tick(30000);
    assert.equal(calls.length, 1);
  } finally { dispose(); }
});

test('a port wait does not use up the crash budget of the child that follows', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'timon-web-app-')), { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  let occupied = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: !occupied, detail: occupied ? 'port occupied' : 'port available' }) }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) t.mock.timers.tick(delay);
    occupied = false;
    t.mock.timers.tick(30000);
    assert.equal(calls.length, 1);
    // A crash right after the wait restarts at the first delay, as any first fall.
    child.emit('exit', 1, null);
    t.mock.timers.tick(2000);
    assert.equal(calls.length, 2);
  } finally { dispose(); }
});
