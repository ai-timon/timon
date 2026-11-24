import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  daemonEntryOf,
  embeddedEnv,
  embeddedExecutablePath,
  daemonInstallDirOf,
  superviseEmbeddedDaemon,
  terminateProcessTree,
  endInstallationOrphans,
  endFallenDaemonLeftovers,
  endEmbeddedLeftovers,
  endRecordedMissionProcesses,
  missionSweepRunnerOf,
  orphanNeedles,
  orphanSweepScript,
  requestDaemonStop,
  stopRequestFor,
  stopWaitMs,
  MAX_RESTARTS,
  STOP_WAIT_MS,
} from './embedded.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  exitOnKill = true;
  kill(): boolean {
    this.killed = true;
    if (this.exitOnKill) this.emit('exit', 0, 'SIGTERM');
    return true;
  }
}

function harness() {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; detached: boolean }> = [];
  const spawn = (command: string, args: string[], o: { env: NodeJS.ProcessEnv; detached: boolean }) => {
    calls.push({ command, args, env: o.env, detached: o.detached });
    const c = new FakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  };
  const gaveUp: string[] = [];
  const silent = { warn: () => {}, error: () => {} };
  return { children, calls, spawn, gaveUp, silent };
}

test('the daemon runs on the Electron binary, as plain Node', () => {
  const h = harness();
  const stop = superviseEmbeddedDaemon({
    entry: '/res/orchestrator/dist/boot.js',
    installDir: '/res/orchestrator',
    home: '/tmp/timon-home',
    heapMb: 2048,
    execPath: '/opt/timon/timon',
    spawn: h.spawn,
    onGiveUp: (w) => h.gaveUp.push(w),
    log: h.silent,
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.command, '/opt/timon/timon');
  assert.deepEqual(h.calls[0]?.args, ['--max-old-space-size=2048', '/res/orchestrator/dist/boot.js']);
  assert.equal(h.calls[0]?.env['ELECTRON_RUN_AS_NODE'], '1');
  assert.equal(h.calls[0]?.env['TIMON_HOME'], '/tmp/timon-home');
  assert.equal(h.calls[0]?.env['NODE_OPTIONS'], undefined);
  assert.equal(h.calls[0]?.detached, process.platform !== 'win32');
  stop();
  assert.equal(h.children[0]?.killed, true, 'stopping the shell kills the daemon');
});

test('macOS ends the whole process group of the daemon, not only its parent process', () => {
  const child = new FakeChild() as unknown as ChildProcess;
  const signals: Array<[number, NodeJS.Signals]> = [];
  assert.equal(terminateProcessTree(child, 'darwin', (pid, signal) => { signals.push([pid, signal]); }), true);
  assert.deepEqual(signals, [[-4242, 'SIGTERM']]);
  assert.equal((child as unknown as FakeChild).killed, false);
});

test('TIM-0115: Windows ends the daemon with its whole tree, and falls back to killing the daemon alone', () => {
  const child = new FakeChild() as unknown as ChildProcess;
  const ended: number[] = [];
  assert.equal(terminateProcessTree(child, 'win32', () => { throw new Error('no POSIX signal'); }, (pid, done) => { ended.push(pid); done(null); }), true);
  assert.deepEqual(ended, [4242]);
  assert.equal((child as unknown as FakeChild).killed, false, 'taskkill /T took the daemon too');
  assert.equal(terminateProcessTree(child, 'win32', process.kill, (_pid, done) => done(new Error('taskkill missing')), ), true);
  assert.equal((child as unknown as FakeChild).killed, true, 'a failed taskkill still stops the daemon');
});

test('the environment is inherited, not replaced — the daemon needs PATH', () => {
  const env = embeddedEnv({ home: '/tmp/h', heapMb: 4096, installDir: '/res/orchestrator' });
  assert.ok(env['PATH']?.includes(process.env.HOME ? `${process.env.HOME}/.local/bin` : '/usr/bin'));
  assert.equal(env['TIMON_HOME'], '/tmp/h');
});

/**
 * A packaged client is the product, whatever shell it was launched from.
 * `TIMON_INSTANCE=dev` renames the window, the manifest and the installed
 * PWA's icon (`app/src/lib/instance.ts`); inherited from a developer's
 * terminal it would rename a release. The daemon hands its environment to the
 * web app it spawns, so stripping it here covers the whole chain.
 */
test('the DEV instance marker never survives into a packaged client', () => {
  const previous = process.env.TIMON_INSTANCE;
  process.env.TIMON_INSTANCE = 'dev';
  try {
    const env = embeddedEnv({ home: '/tmp/h', heapMb: 4096, installDir: '/res/orchestrator' });
    assert.equal(env['TIMON_INSTANCE'], undefined);
    assert.ok(!('TIMON_INSTANCE' in env), 'the key must be absent, not just empty');
    // Even a caller that insists: overrides are applied before the strip.
    const forced = embeddedEnv({
      home: '/tmp/h',
      heapMb: 4096,
      installDir: '/res/orchestrator',
      overrides: { TIMON_INSTANCE: 'dev' },
    });
    assert.ok(!('TIMON_INSTANCE' in forced));
    // The strip is surgical: the rest of the inherited environment stays.
    assert.equal(env['TIMON_HOME'], '/tmp/h');
    assert.ok(env['PATH']);
  } finally {
    if (previous === undefined) delete process.env.TIMON_INSTANCE;
    else process.env.TIMON_INSTANCE = previous;
  }
});

test('Finder PATH is completed with user-local and standard macOS locations', () => {
  assert.equal(
    embeddedExecutablePath({ HOME: '/Users/sam', PATH: '/usr/bin:/bin' }, 'darwin'),
    '/Users/sam/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
  );
});

/**
 * The daemon serves the UI from `<installDir>/../app`. Nothing used to set
 * `installDir`, so a package fell back on the schema default — a developer
 * path that does not exist on a user's machine — and served nothing. It cannot
 * be written to the config file either: an AppImage mounts on a different
 * `/tmp/.mount_XXXX` at every launch.
 */
test('the daemon is told where it was installed THIS launch', () => {
  assert.equal(daemonInstallDirOf('/tmp/.mount_abc/resources'), '/tmp/.mount_abc/resources/orchestrator');
  assert.equal(
    daemonEntryOf('/tmp/.mount_abc/resources'),
    '/tmp/.mount_abc/resources/orchestrator/dist/boot.js',
  );
  const env = embeddedEnv({
    home: '/tmp/h',
    heapMb: 4096,
    installDir: daemonInstallDirOf('/tmp/.mount_abc/resources'),
  });
  assert.equal(env['TIMON_INSTALL_DIR'], '/tmp/.mount_abc/resources/orchestrator');
});

test('restarts back off 2s → 30s, then give up on the 6th rapid fall', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  try {
    const stop = superviseEmbeddedDaemon({
      entry: '/res/boot.js',
      installDir: '/res/orchestrator',
      home: '/tmp/h',
      heapMb: 4096,
      execPath: '/opt/timon',
      spawn: h.spawn,
      onGiveUp: (w) => h.gaveUp.push(w),
      log: h.silent,
    });

    for (const [i, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
      h.children[i]?.emit('exit', 1, null);
      t.mock.timers.tick(delay - 1);
      assert.equal(h.children.length, i + 1, `restart #${i + 1} came too early`);
      t.mock.timers.tick(1);
      assert.equal(h.children.length, i + 2, `restart #${i + 1} missing after ${delay}ms`);
    }

    h.children[MAX_RESTARTS]?.emit('exit', 1, null);
    t.mock.timers.tick(120_000);
    assert.equal(h.children.length, MAX_RESTARTS + 1, 'past the ceiling, no more restarts');
    assert.equal(h.gaveUp.length, 1, 'the shell is told, once');
    stop();
  } finally {
    t.mock.timers.reset();
  }
});

test('a daemon that held a minute resets the counter and the backoff', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  try {
    const stop = superviseEmbeddedDaemon({
      entry: '/res/boot.js',
      installDir: '/res/orchestrator',
      home: '/tmp/h',
      heapMb: 4096,
      execPath: '/opt/timon',
      spawn: h.spawn,
      onGiveUp: (w) => h.gaveUp.push(w),
      log: h.silent,
    });
    // Two rapid falls, then a child that stays up for two minutes.
    h.children[0]?.emit('exit', 1, null);
    t.mock.timers.tick(2_000);
    h.children[1]?.emit('exit', 1, null);
    t.mock.timers.tick(4_000);
    t.mock.timers.tick(120_000);
    h.children[2]?.emit('exit', 1, null);
    // Back to the first delay, not to 8 s.
    t.mock.timers.tick(1_999);
    assert.equal(h.children.length, 3);
    t.mock.timers.tick(1);
    assert.equal(h.children.length, 4);
    assert.equal(h.gaveUp.length, 0);
    stop();
  } finally {
    t.mock.timers.reset();
  }
});

test('an ENOENT emitting both error and exit schedules a single restart', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  try {
    const stop = superviseEmbeddedDaemon({
      entry: '/res/boot.js',
      installDir: '/res/orchestrator',
      home: '/tmp/h',
      heapMb: 4096,
      execPath: '/nowhere',
      spawn: h.spawn,
      onGiveUp: (w) => h.gaveUp.push(w),
      log: h.silent,
    });
    h.children[0]?.emit('error', new Error('ENOENT'));
    h.children[0]?.emit('exit', null, 'SIGTERM');
    t.mock.timers.tick(2_000);
    assert.equal(h.children.length, 2, 'one fall, one restart');
    stop();
  } finally {
    t.mock.timers.reset();
  }
});

test('the packaged daemon entry sits under the resources directory', () => {
  assert.equal(daemonEntryOf('/opt/app/resources'), '/opt/app/resources/orchestrator/dist/boot.js');
});

test('stopping waits for child exit and never respawns during handover', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const stop = superviseEmbeddedDaemon({
    entry: '/res/boot.js', installDir: '/res/orchestrator', home: '/tmp/h',
    heapMb: 4096, execPath: '/opt/timon', spawn: h.spawn,
    onGiveUp: () => {}, log: h.silent,
  });
  h.children[0]!.exitOnKill = false;
  let finished = false;
  const pending = stop().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(h.children[0]!.killed, true);
  h.children[0]!.emit('exit', 0, 'SIGTERM');
  await pending;
  t.mock.timers.tick(60_000);
  assert.equal(h.children.length, 1);
  assert.equal(finished, true);
});

test('a stuck child refuses handover, without a forced kill, and can be retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const stop = superviseEmbeddedDaemon({
    entry: '/res/boot.js', installDir: '/res/orchestrator', home: '/tmp/h',
    heapMb: 4096, execPath: '/opt/timon', spawn: h.spawn,
    onGiveUp: () => {}, log: h.silent,
  });
  h.children[0]!.exitOnKill = false;
  const rejected = assert.rejects(stop(), /did not stop in time/);
  t.mock.timers.tick(15_000);
  await rejected;
  h.children[0]!.exitOnKill = true;
  await stop();
  assert.equal(h.children.length, 1);
});


test('Windows quit: the daemon is asked to stop, waited on, and never killed when it leaves', async () => {
  const h = harness();
  const order: string[] = [];
  const stop = superviseEmbeddedDaemon({
    entry: '/res/boot.js', installDir: '/res/orchestrator', home: '/tmp/h',
    heapMb: 4096, execPath: '/opt/timon', spawn: h.spawn,
    terminate: () => { order.push('forced kill'); return true; },
    askToStop: async () => {
      order.push('stop request');
      setTimeout(() => { order.push('daemon exits'); h.children[0]!.emit('exit', 0, null); }, 5);
      return true;
    },
    stopWaitMs: 1_000,
    afterStop: async () => { order.push('leftovers swept'); },
    onGiveUp: () => {}, log: h.silent,
  });
  await stop();
  assert.deepEqual(order, ['stop request', 'daemon exits', 'leftovers swept']);
  assert.equal(h.children.length, 1, 'no respawn after the requested stop');
});

test('Windows quit: a daemon still there after the wait is killed, as before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const order: string[] = [];
  const stop = superviseEmbeddedDaemon({
    entry: '/res/boot.js', installDir: '/res/orchestrator', home: '/tmp/h',
    heapMb: 4096, execPath: '/opt/timon', spawn: h.spawn,
    terminate: (child) => { order.push('forced kill'); child.emit('exit', 1, null); return true; },
    askToStop: async () => { order.push('stop request'); return true; },
    stopWaitMs: 2_000,
    onGiveUp: () => {}, log: h.silent,
  });
  const done = stop();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(order, ['stop request'], 'waiting, not killing yet');
  t.mock.timers.tick(2_000);
  await done;
  assert.deepEqual(order, ['stop request', 'forced kill']);
});

test('Windows quit: a refused or failed request kills at once, without waiting', async () => {
  for (const askToStop of [async () => false, async () => { throw new Error('ECONNREFUSED'); }]) {
    const h = harness();
    const order: string[] = [];
    const stop = superviseEmbeddedDaemon({
      entry: '/res/boot.js', installDir: '/res/orchestrator', home: '/tmp/h',
      heapMb: 4096, execPath: '/opt/timon', spawn: h.spawn,
      terminate: (child) => { order.push('forced kill'); child.emit('exit', 1, null); return true; },
      askToStop: async () => { order.push('stop request'); return askToStop(); },
      stopWaitMs: 60_000,
      onGiveUp: () => {}, log: h.silent,
    });
    await stop();
    assert.deepEqual(order, ['stop request', 'forced kill']);
  }
});

test('the stop request goes to Windows only, with the daemon token, to the loopback only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-embedded-stop-'));
  const sent: Array<{ url: string; auth: string | null }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    return new Response('{}', { status: 202 });
  }) as typeof fetch;
  assert.equal(stopRequestFor('linux', 'http://127.0.0.1:3100', home, {}, fetcher), undefined);
  assert.equal(stopRequestFor('darwin', 'http://127.0.0.1:3100', home, {}, fetcher), undefined);
  assert.equal(stopRequestFor('win32', 'http://127.0.0.1:3100', home, { TIMON_COOPERATIVE_STOP_MS: '0' }, fetcher), undefined);
  const win = stopRequestFor('win32', 'http://127.0.0.1:3100', home, {}, fetcher);
  assert.equal(win?.stopWaitMs, STOP_WAIT_MS);
  assert.equal(await win!.askToStop(), false, 'no token yet: nothing is sent');
  assert.deepEqual(sent, []);
  writeFileSync(join(home, 'daemon-token'), 'witness-token\n');
  assert.equal(await win!.askToStop(), true);
  assert.deepEqual(sent, [{ url: 'http://127.0.0.1:3100/api/daemon/shutdown', auth: 'Bearer witness-token' }]);
  for (const origin of ['http://example.com:3100', 'https://127.0.0.1:3100', 'http://u:p@127.0.0.1:3100']) {
    assert.equal(await requestDaemonStop(origin, home, fetcher), false, origin);
  }
  assert.equal(sent.length, 1, 'the token never left for anything else');
  const refusing = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  assert.equal(await requestDaemonStop('http://127.0.0.1:3100', home, refusing), false);
  assert.equal(stopWaitMs({ TIMON_COOPERATIVE_STOP_MS: '2500' }), 2_500);
  assert.equal(stopWaitMs({ TIMON_COOPERATIVE_STOP_MS: 'soon' }), STOP_WAIT_MS);
});

test('embedded runtime drops NODE_OPTIONS even from explicit overrides', () => {
  const env = embeddedEnv({ home: '/tmp/h', heapMb: 512, installDir: '/res/orchestrator',
    overrides: { NODE_OPTIONS: '--require untrusted.cjs', node_options: '--inspect' } });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.node_options, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});

test('DEV identity and injection overrides are both stripped with Windows casing', () => {
  const env = embeddedEnv({ home: '/tmp/h', heapMb: 512, installDir: '/res/orchestrator',
    overrides: { TIMON_INSTANCE: 'dev', timon_instance: 'dev', Node_Options: '--inspect' } });
  assert.equal(env.TIMON_INSTANCE, undefined);
  assert.equal(env.timon_instance, undefined);
  assert.equal(env.Node_Options, undefined);
});

// After `taskkill /T` on the daemon, the terminal host (started by an
// intermediate that exits at once) and a mission's browser helper whose CLI
// went first were still there, and the next installer looped on "Timon
// cannot be closed" (tester report, 22/10/2026).
test('Windows portable: quitting also ends the daemon\'s orphans — never the window nor Electron\'s helpers', async () => {
  const installDir = 'C:\\Users\\Robin\\AppData\\Local\\Programs\\Timon\\resources\\orchestrator';
  const needles = orphanNeedles(installDir);
  assert.deepEqual(needles, [
    `${installDir}\\dist\\boot.js`,
    `${installDir}\\dist\\terminal-host\\main.js`,
    `${installDir}\\bin\\browser-mcp.mjs`,
    'C:\\Users\\Robin\\AppData\\Local\\Programs\\Timon\\resources\\app\\',
  ]);
  const renderer = 'c:\\users\\robin\\appdata\\local\\programs\\timon\\timon.exe --type=renderer --app-path=c:\\users\\robin\\appdata\\local\\programs\\timon\\resources\\app.asar';
  assert.equal(needles.some((needle) => renderer.includes(needle.toLowerCase())), false, 'app.asar is not the app directory');
  const script = orphanSweepScript(installDir, 'Timon.exe', 777);
  assert.match(script, /\$names = @\('Timon\.exe'\); /);
  assert.match(script, /\$names -notcontains \$_\.Name/);
  // The shipped Node is swept too, by name AND by this installation's command line.
  assert.match(orphanSweepScript(installDir, ['Timon.exe', 'node.exe'], 777), /\$names = @\('Timon\.exe', 'node\.exe'\); /);
  assert.match(script, /\$_\.ProcessId -eq 777/, 'never this shell');
  assert.match(script, /Contains\('--type='\)/);
  assert.ok(script.includes("'c:\\users\\robin\\appdata\\local\\programs\\timon\\resources\\app\\'"), 'lower-cased needles against a lower-cased command line');
  assert.match(script, /taskkill\.exe \/F \/T \/PID/);
  assert.doesNotMatch(script, /"/, 'single quotes only: it travels as one -Command argument');
  const ran: string[] = [];
  await endInstallationOrphans(installDir, async (s) => { ran.push(s); }, 'Timon.exe', 777);
  assert.deepEqual(ran, [script]);
});

test('the orphan sweep runs once the daemon has exited, and its failure does not fail the stop', async () => {
  const h = harness();
  const order: string[] = [];
  const stop = superviseEmbeddedDaemon({
    entry: 'boot.js', installDir: 'i', home: 'h', heapMb: 1, execPath: 'x', spawn: h.spawn,
    onGiveUp: (why) => h.gaveUp.push(why), log: h.silent,
    afterStop: async () => { order.push('sweep'); throw new Error('no powershell'); },
  });
  h.children[0]!.on('exit', () => order.push('exit'));
  await stop();
  assert.deepEqual(order, ['exit', 'sweep']);
});

// macOS tester report, 26/10/2026: a crashed embedded daemon left its Next on
// the app port, and the service installed next waited on that port forever.
test('a daemon that dies on its own has its leftovers ended before the next attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  const ended: number[] = [];
  let release!: () => void;
  const stop = superviseEmbeddedDaemon({
    entry: '/e', installDir: '/i', home: '/h', heapMb: 1, execPath: '/x',
    spawn: h.spawn, onGiveUp: (w) => h.gaveUp.push(w), log: h.silent,
    endLeftovers: (pid) => { ended.push(pid); return new Promise<void>((resolve) => { release = resolve; }); },
  });
  try {
    h.children[0]?.emit('exit', 1, null);
    await Promise.resolve();
    assert.deepEqual(ended, [4242]);
    t.mock.timers.tick(120_000);
    assert.equal(h.calls.length, 1, 'no restart while the leftovers are being ended');
    release();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    t.mock.timers.tick(2_000);
    assert.equal(h.calls.length, 2);
  } finally {
    t.mock.timers.reset();
    await stop();
  }
});

test('giving up still ends the last leftovers, and quitting afterwards runs afterStop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  const ended: number[] = [];
  let afterStop = 0;
  const stop = superviseEmbeddedDaemon({
    entry: '/e', installDir: '/i', home: '/h', heapMb: 1, execPath: '/x',
    spawn: h.spawn, onGiveUp: (w) => h.gaveUp.push(w), log: h.silent,
    endLeftovers: async (pid) => { ended.push(pid); },
    afterStop: async () => { afterStop += 1; },
  });
  try {
    for (let i = 0; i <= MAX_RESTARTS; i += 1) {
      h.children[i]?.emit('exit', 1, null);
      for (let j = 0; j < 5; j += 1) await Promise.resolve();
      t.mock.timers.tick(30_000);
    }
    assert.equal(h.gaveUp.length, 1);
    assert.equal(ended.length, MAX_RESTARTS + 1);
  } finally { t.mock.timers.reset(); }
  await stop();
  assert.equal(afterStop, 1, 'no live child, but the shell still sweeps on quit');
});

test('a stop does not count as a fall: no leftover sweep, the stop path owns it', async () => {
  const h = harness();
  const ended: number[] = [];
  const stop = superviseEmbeddedDaemon({
    entry: '/e', installDir: '/i', home: '/h', heapMb: 1, execPath: '/x',
    spawn: h.spawn, onGiveUp: (w) => h.gaveUp.push(w), log: h.silent,
    endLeftovers: async (pid) => { ended.push(pid); },
  });
  await stop();
  assert.deepEqual(ended, []);
  assert.equal(h.children[0]?.killed, true);
});

test('POSIX signals the dead daemon\'s group; Windows sweeps the installation', async () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  await endFallenDaemonLeftovers(4242, '/res/orchestrator', 'darwin', (pid, signal) => { signals.push([pid, signal]); }, async () => { throw new Error('no sweep on POSIX'); });
  assert.deepEqual(signals, [[-4242, 'SIGTERM']]);
  await endFallenDaemonLeftovers(4242, '/res/orchestrator', 'linux', () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
  const swept: string[] = [];
  await endFallenDaemonLeftovers(4242, 'C:\\Timon\\resources\\orchestrator', 'win32', () => { throw new Error('no POSIX signal'); }, async (dir) => { swept.push(dir); });
  assert.deepEqual(swept, ['C:\\Timon\\resources\\orchestrator']);
});

test('the recorded mission sweep runs the orchestrator runner with the daemon\'s own environment (TODO #565)', async () => {
  const opts = { home: '/h', heapMb: 1, installDir: '/res/orchestrator', execPath: '/x/Timon', overrides: { TIMON_PORT: '9' } };
  const runner = missionSweepRunnerOf('/res/orchestrator');
  assert.match(runner, /dist[\\/]host[\\/]mission-process-sweep-runner\.js$/);
  const ran: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  await endRecordedMissionProcesses(opts, async (file, args, env) => { ran.push({ file, args, env }); }, () => true);
  assert.equal(ran.length, 1);
  assert.equal(ran[0]!.file, '/x/Timon');
  assert.deepEqual(ran[0]!.args, [runner]);
  assert.equal(ran[0]!.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(ran[0]!.env.TIMON_HOME, '/h', 'the same home as the daemon, never guessed');
  assert.equal(ran[0]!.env.TIMON_PORT, '9');
  // A build without the runner: nothing to run, nothing fails.
  await endRecordedMissionProcesses(opts, async () => { throw new Error('must not run'); }, () => false);
});

test('after the embedded daemon: missions on every OS, the installation sweep on Windows only, neither skipped by the other', async () => {
  const opts = { home: '/h', heapMb: 1, installDir: '/i', execPath: '/x' };
  for (const platform of ['linux', 'darwin'] as const) {
    const order: string[] = [];
    await endEmbeddedLeftovers(opts, platform, {
      missions: async () => { order.push('missions'); },
      installation: async () => { order.push('installation'); },
    });
    assert.deepEqual(order, ['missions'], platform);
  }
  const order: string[] = [];
  await assert.rejects(endEmbeddedLeftovers(opts, 'win32', {
    missions: async () => { order.push('missions'); throw new Error('runner died'); },
    installation: async () => { order.push('installation'); },
  }), /mission processes: runner died/);
  assert.deepEqual(order, ['missions', 'installation']);
});
