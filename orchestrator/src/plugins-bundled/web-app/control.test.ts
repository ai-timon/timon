/**
 * `timon app status|restart`: the diagnosis of the Next app served by the daemon.
 *
 * What these tests protect, in the order of risk:
 *   1. `status` NEVER THROWS. `app.enabled` is `false` by default: if a
 *      "not running" state surfaced as an exception, the most
 *      ordinary command of the work would crash on a fresh install.
 *   2. A STALE pidfile does not pass for a live child. The pid
 *      of a dead process is reassigned by the kernel: taking it at its word
 *      means sending a SIGTERM to a stranger.
 *   3. `restart` only signals when there is something to signal, and never
 *      launches the app itself (it belongs to the daemon's supervisor).
 *
 * No process is killed: the only live pid used is the test process's own, and
 * the signal is caught by a fake `process.kill`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'timon-app-control-test-'));
process.env.TIMON_HOME = HOME;

const { appStatus, restartApp, readAppPid, APP_PID_FILE } = await import('./control.js');
const { TimonConfigSchema } = await import('../../config/schema.js');

/** A fake install folder: `<installDir>/../app` is what the
 *  status inspects, built or not depending on the test. */
function installDir(built: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'timon-app-tree-'));
  mkdirSync(join(root, 'app'), { recursive: true });
  if (built) {
    mkdirSync(join(root, 'app', '.next'), { recursive: true });
    writeFileSync(join(root, 'app', '.next', 'prerender-manifest.json'), '{"version":4}\n');
  }
  return join(root, 'orchestrator');
}

function cfg(over: Record<string, unknown> = {}) {
  return TimonConfigSchema.parse({ daemon: { installDir: installDir(true) }, ...over });
}

let n = 0;
function pidFile(content: string): string {
  const file = join(HOME, `pid-${n++}`);
  writeFileSync(file, content);
  return file;
}

test('le pidfile vit sous TIMON_HOME, en zone cache', () => {
  assert.equal(APP_PID_FILE, join(HOME, 'run', 'web-app.pid'));
});

test('app.enabled = false → disabled, without a throw or a pid', () => {
  const st = appStatus(cfg(), join(HOME, 'absent.pid'));
  assert.equal(st.state, 'disabled');
  assert.equal(st.pid, null);
  assert.match(st.message, /app\.enabled/);
});

test('module @timon/web-app disabled → disabled, even with app.enabled = true', () => {
  const st = appStatus(
    cfg({ app: { enabled: true }, modules: { '@timon/web-app': false } }),
    join(HOME, 'absent.pid'),
  );
  assert.equal(st.state, 'disabled');
  assert.match(st.message, /module @timon\/web-app disabled/);
});

test('app not built → actionable message, not an exception', () => {
  const st = appStatus(
    TimonConfigSchema.parse({ app: { enabled: true }, daemon: { installDir: installDir(false) } }),
    join(HOME, 'absent.pid'),
  );
  assert.equal(st.state, 'not-built');
  assert.match(st.message, /npm run build/);
});

test('.next without prerender-manifest → not-built (incomplete build)', () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-app-incomplete-'));
  mkdirSync(join(root, 'app', '.next'), { recursive: true });
  const st = appStatus(
    TimonConfigSchema.parse({
      app: { enabled: true },
      daemon: { installDir: join(root, 'orchestrator') },
    }),
    join(HOME, 'absent.pid'),
  );
  assert.equal(st.state, 'not-built');
  assert.match(st.message, /prerender-manifest/);
});

test('no pidfile → stopped, and restart signals nothing', () => {
  const c = cfg({ app: { enabled: true } });
  const file = join(HOME, 'jamais-ecrit.pid');
  assert.equal(appStatus(c, file).state, 'stopped');

  const r = restartApp(c, file);
  assert.equal(r.ok, false);
  assert.equal(r.pid, null);
});

test('a dead or unreadable pid does not pass for a live child', () => {
  // 2^31-1: beyond any realistic `pid_max`, hence never assigned.
  assert.equal(readAppPid(pidFile('2147483647\n')), null);
  assert.equal(readAppPid(pidFile('nawak')), null);
  assert.equal(readAppPid(pidFile('')), null);
  assert.equal(readAppPid(pidFile('0')), null);
  assert.equal(readAppPid(pidFile('-1')), null);
});

test('live pidfile → running, and restart signals THAT pid', () => {
  const c = cfg({ app: { enabled: true } });
  // The test process itself: a live pid we are sure of, and which will
  // receive nothing since `process.kill` is intercepted below.
  const file = pidFile(`${process.pid}\n`);

  const st = appStatus(c, file);
  assert.equal(st.state, 'running');
  assert.equal(st.pid, process.pid);

  const sent: { pid: number; signal: string | number }[] = [];
  const real = process.kill;
  // `pidAlive` uses signal 0: we let it through, and only intercept
  // the SIGTERM of the restart.
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal === 0) return real.call(process, pid, 0);
    sent.push({ pid, signal: signal ?? 'SIGTERM' });
    return true;
  }) as typeof process.kill;
  try {
    const r = restartApp(c, file);
    assert.equal(r.ok, true);
    assert.deepEqual(sent, [{ pid: process.pid, signal: 'SIGTERM' }]);
  } finally {
    process.kill = real;
  }
});
