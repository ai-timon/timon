/**
 * The daemon's common stop: a stop signal runs the steps, releases the module
 * tree, then exits 0, on every system and whether `resources-guard` runs or
 * not. Without the exit, the next start reads the previous run as `unknown`.
 *
 * Every test listens on a fake process and records `exit`: nothing here
 * signals or ends the test runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  daemonShutdownState, installDaemonShutdown, onDaemonShutdown, requestDaemonShutdown, type ShutdownStep,
} from './daemon-shutdown.js';
import { stopSignalsFor } from './host/stop-signals.js';

type Run = { proc: EventEmitter; order: string[]; exits: number[]; exited: Promise<void>; uninstall: () => void };

function run(opts: {
  steps?: readonly ShutdownStep[];
  release?: () => void | Promise<void>;
  graceMs?: number;
  signals?: readonly NodeJS.Signals[];
} = {}): Run {
  const proc = new EventEmitter();
  const order: string[] = [];
  const exits: number[] = [];
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const uninstall = installDaemonShutdown({
    proc,
    signals: opts.signals ?? ['SIGTERM', 'SIGINT'],
    steps: () => opts.steps ?? [],
    release: opts.release ?? (() => { order.push('release'); }),
    exit: (code) => { order.push(`exit ${code}`); exits.push(code); resolveExit(); },
    graceMs: opts.graceMs ?? 1_000,
    log: () => {},
  });
  return { proc, order, exits, exited, uninstall };
}

test('a stop signal runs the steps, then releases the modules, then exits 0', async () => {
  const order: string[] = [];
  const r = run({
    steps: [() => { order.push('scopes'); }, async () => { order.push('async step'); }],
    release: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); order.push('release'); },
  });
  r.proc.emit('SIGTERM', 'SIGTERM');
  await r.exited;
  assert.deepEqual([...order, ...r.order], ['scopes', 'async step', 'release', 'exit 0']);
  r.uninstall();
});

test('SIGINT stops the same way', async () => {
  const r = run();
  r.proc.emit('SIGINT', 'SIGINT');
  await r.exited;
  assert.deepEqual(r.order, ['release', 'exit 0']);
  r.uninstall();
});

test('a release that never settles does not hold the stop: the daemon exits after the grace', async () => {
  const r = run({ release: () => new Promise<void>(() => {}), graceMs: 20 });
  const started = Date.now();
  r.proc.emit('SIGTERM', 'SIGTERM');
  await r.exited;
  assert.deepEqual(r.exits, [0]);
  assert.ok(Date.now() - started >= 15, 'it waited for the grace');
  r.uninstall();
});

test('a step or a release that throws is no reason to exit otherwise than 0', async () => {
  const order: string[] = [];
  const r = run({
    steps: [() => { throw new Error('scope sweep failed'); }, () => { order.push('next step'); }],
    release: () => Promise.reject(new Error('dispose failed')),
  });
  r.proc.emit('SIGTERM', 'SIGTERM');
  await r.exited;
  assert.deepEqual(order, ['next step'], 'a failing step does not skip the next one');
  assert.deepEqual(r.exits, [0]);
  r.uninstall();
});

test('a second signal while stopping exits at once, and only once', async () => {
  const r = run({ release: () => new Promise<void>(() => {}), graceMs: 50 });
  r.proc.emit('SIGTERM', 'SIGTERM');
  r.proc.emit('SIGINT', 'SIGINT');
  assert.deepEqual(r.exits, [0], 'exited on the second signal, before the grace');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(r.exits, [0], 'the grace ending later exits no second time');
  r.uninstall();
});

test('installed once per process: a second install adds no listener', () => {
  const r = run();
  const again = installDaemonShutdown({ proc: r.proc, signals: ['SIGTERM'], release: () => {}, exit: () => {} });
  assert.equal(r.proc.listenerCount('SIGTERM'), 1);
  again();
  assert.equal(r.proc.listenerCount('SIGTERM'), 1, 'the ignored install removes nothing');
  r.uninstall();
  assert.equal(r.proc.listenerCount('SIGTERM'), 0);
  assert.equal(r.proc.listenerCount('SIGINT'), 0);
});

test('a registered step runs at the stop, and no longer once taken back', async () => {
  const order: string[] = [];
  const takeBack = onDaemonShutdown(() => { order.push('registered'); });
  const proc = new EventEmitter();
  let exited!: () => void;
  const done = new Promise<void>((resolve) => { exited = resolve; });
  const uninstall = installDaemonShutdown({ proc, signals: ['SIGTERM'], release: () => {}, exit: () => exited(), log: () => {} });
  takeBack();
  const kept = onDaemonShutdown(() => { order.push('kept'); });
  proc.emit('SIGTERM', 'SIGTERM');
  await done;
  assert.deepEqual(order, ['kept']);
  kept();
  uninstall();
});

test('a request runs the same stop as a signal: steps, release, exit 0', async () => {
  const order: string[] = [];
  const r = run({ steps: [() => { order.push('scopes'); }] });
  assert.equal(daemonShutdownState(), 'stopping', 'a request would start the stop');
  assert.equal(requestDaemonShutdown('test'), 'stopping');
  await r.exited;
  assert.deepEqual([...order, ...r.order], ['scopes', 'release', 'exit 0']);
  r.uninstall();
});

test('asking again while stopping never hurries the exit, unlike a second signal', async () => {
  const r = run({ release: () => new Promise<void>(() => {}), graceMs: 30 });
  assert.equal(requestDaemonShutdown('first'), 'stopping');
  assert.equal(requestDaemonShutdown('again'), 'already-stopping');
  assert.equal(daemonShutdownState(), 'already-stopping');
  assert.deepEqual(r.exits, [], 'still within the grace');
  await r.exited;
  assert.deepEqual(r.exits, [0]);
  r.uninstall();
});

test('a signal after a request exits at once, as a second signal does', () => {
  const r = run({ release: () => new Promise<void>(() => {}), graceMs: 1_000 });
  requestDaemonShutdown('first');
  r.proc.emit('SIGINT', 'SIGINT');
  assert.deepEqual(r.exits, [0]);
  r.uninstall();
});

test('nothing installed: a request is unavailable and starts nothing', () => {
  const r = run();
  r.uninstall();
  assert.equal(daemonShutdownState(), 'unavailable');
  assert.equal(requestDaemonShutdown('test'), 'unavailable');
  assert.deepEqual(r.exits, []);
});

test('each system listens for what it actually delivers, never SIGHUP where nohup relies on it', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    assert.deepEqual(stopSignalsFor(platform), ['SIGTERM', 'SIGINT'], platform);
  }
  // Windows never fires SIGTERM; Ctrl+C, Ctrl+Break and closing the console do reach it.
  assert.deepEqual(stopSignalsFor('win32'), ['SIGINT', 'SIGBREAK', 'SIGHUP']);
});

test('the daemon installs its stop before the boot, and resources-guard no longer exits on its own', () => {
  const boot = readFileSync(new URL('./kernel-boot.ts', import.meta.url), 'utf8');
  const install = boot.indexOf('installDaemonShutdown({');
  assert.ok(install > 0 && install < boot.indexOf('root = await boot()'));
  assert.match(boot, /signals: stopSignalsFor\(process\.platform\)/);
  const guard = readFileSync(new URL('./plugins-bundled/resources-guard/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(guard, /process\.(on|exit)\(/);
  assert.match(guard, /onDaemonShutdown\(/);
});
