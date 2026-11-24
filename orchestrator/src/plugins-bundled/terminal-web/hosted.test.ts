/**
 * The web terminal held by the terminal host: a daemon restart (one store
 * let go, a new one created) finds the shells running and replays their
 * scrollback; an idle host from another release is replaced; a host that
 * cannot start, or an impostor on the endpoint, leaves the shells in the
 * daemon and says so. The last test runs the real host entry as a separate
 * process with a real shell.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnInNewSession } from '../../host/detached.js';
import { hostFiles, readFrames, sendFrame, type HostFiles } from '../../terminal-host/protocol.js';
import { loadNodePty } from '../../terminal-host/pty.js';
import { createHostServer, type HostServer } from '../../terminal-host/server.js';
import { TerminalSessions, type Pty, type PtySpawnOptions, type ServerMessage } from '../../terminal-host/sessions.js';
import { HostedSessions, type HostedOptions } from './hosted.js';

type FakePty = Pty & { written: string[]; emit(data: string): void };

function fakeSpawner(): { spawn: (opts: PtySpawnOptions) => Pty; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  return {
    ptys,
    spawn: () => {
      let onData: (d: string) => void = () => {};
      let onExit: (e: { exitCode: number }) => void = () => {};
      const pty: FakePty = {
        pid: 7000 + ptys.length, written: [],
        onData: (l) => { onData = l; },
        onExit: (l) => { onExit = l; },
        write: (d) => { pty.written.push(d); },
        resize: () => {},
        kill: () => onExit({ exitCode: 0 }),
        emit: (d) => onData(d),
      };
      ptys.push(pty);
      return pty;
    },
  };
}

function freshFiles(): HostFiles {
  const files = hostFiles(mkdtempSync(join(tmpdir(), 'hosted-')));
  if (files.endpointDir) mkdirSync(files.endpointDir, { recursive: true, mode: 0o700 });
  return files;
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });
}

/** A launcher that starts an in-process host, reading the token the store just wrote. */
function inProcessLauncher(files: HostFiles, spawn: (opts: PtySpawnOptions) => Pty, build = '1.0.0'): { launch: HostedOptions['launch']; hosts: HostServer[] } {
  const hosts: HostServer[] = [];
  return {
    hosts,
    launch: async () => {
      const token = readFileSync(files.token, 'utf8').trim();
      const host = createHostServer({ token, spawn, build, entry: 'main', exitAfterMs: 60_000, onIdleExit: () => host.close() });
      await listen(host.server, files.endpoint);
      hosts.push(host);
      return { via: 'test' };
    },
  };
}

function store(files: HostFiles, launch: HostedOptions['launch'], extra: Partial<HostedOptions> = {}): HostedSessions {
  return new HostedSessions({
    endpoint: files.endpoint,
    tokenFile: files.token,
    build: '1.0.0',
    idleMs: () => 60_000,
    local: () => new TerminalSessions({ spawn: fakeSpawner().spawn, idleMs: () => 60_000 }),
    launch,
    launchWaitMs: 2_000,
    log: () => {},
    ...extra,
  });
}

function recorder(): { client: { send(m: ServerMessage): void; close(): void }; text: () => string; closed: () => boolean } {
  let out = '';
  let closed = false;
  return {
    client: { send: (m) => { if (m.type === 'output') out += m.data; }, close: () => { closed = true; } },
    text: () => out,
    closed: () => closed,
  };
}

function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) resolve();
      else if (Date.now() > deadline) reject(new Error('condition not met in time'));
      else setTimeout(tick, 20);
    };
    tick();
  });
}

const shell = { shell: 'sh', args: [], cwd: '/', env: {} };

test('a daemon restart finds the shell running and replays its scrollback', async () => {
  const files = freshFiles();
  const { spawn, ptys } = fakeSpawner();
  const { launch, hosts } = inProcessLauncher(files, spawn);
  try {
    const before = store(files, launch);
    assert.deepEqual(await before.persistence(), { mode: 'not-started' }, 'asking for the status starts nothing');
    assert.equal(hosts.length, 0);
    const info = await before.create('alice', shell);
    assert.deepEqual(await before.persistence(), { mode: 'host', via: 'test' });
    const view = recorder();
    const handle = (await before.attach('alice', info.id, view.client))!;
    handle.input('sleep 300; echo fini\r');
    await until(() => ptys[0]!.written.join('') === 'sleep 300; echo fini\r');
    ptys[0]!.emit('$ sleep 300; echo fini\r\n');
    await until(() => view.text().includes('sleep 300'));

    // The daemon goes away: its connections drop, the viewer with them.
    before.disconnect();
    await until(() => view.closed());
    ptys[0]!.emit('fini\r\n');

    const after = store(files, async () => { throw new Error('must not launch a second host'); });
    assert.equal(await after.reconnect(), true);
    const listed = await after.list('alice');
    assert.deepEqual(listed.map((s) => s.id), [info.id]);
    assert.equal(listed[0]!.exited, false, 'the shell is still running');
    const back = recorder();
    assert.ok(await after.attach('alice', info.id, back.client));
    await until(() => back.text() === '$ sleep 300; echo fini\r\nfini\r\n');
    assert.equal(hosts.length, 1, 'one host for both daemons');
    assert.deepEqual(await after.list('bob'), [], 'owners stay apart');
    await after.dispose();
    assert.equal(hosts[0]!.sessions.count(), 0, 'disabling the module kills the shells in the host');
  } finally {
    for (const h of hosts) h.close();
  }
});

test('an idle host from another release is retired and replaced; a busy one keeps serving', async () => {
  const files = freshFiles();
  const { spawn } = fakeSpawner();
  const old = inProcessLauncher(files, spawn, '0.9.0');
  const fresh = inProcessLauncher(files, spawn, '1.0.0');
  try {
    const first = store(files, old.launch, { build: '0.9.0' });
    const gone = await first.create('alice', shell);
    await first.kill('alice', gone.id);
    first.disconnect();
    const second = store(files, fresh.launch);
    await second.create('alice', shell);
    assert.equal(fresh.hosts.length, 1, 'the idle 0.9.0 host left, a 1.0.0 one took over');
    await until(() => !old.hosts[0]!.server.listening);
    second.disconnect();

    const busyFiles = freshFiles();
    const busyOld = inProcessLauncher(busyFiles, spawn, '0.9.0');
    const a = store(busyFiles, busyOld.launch, { build: '0.9.0' });
    const kept = await a.create('alice', shell);
    a.disconnect();
    const b = store(busyFiles, async () => { throw new Error('must not replace a host that has shells'); });
    assert.deepEqual((await b.list('alice')).map((s) => s.id), [kept.id]);
    assert.equal((await b.persistence()).mode, 'host');
    await b.dispose();
    for (const h of busyOld.hosts) h.close();
  } finally {
    for (const h of [...old.hosts, ...fresh.hosts]) h.close();
  }
});

test('a host that cannot start leaves the shells in the daemon, and the status says why', async () => {
  const files = freshFiles();
  let launches = 0;
  const s = store(files, async () => { launches++; throw new Error('no detached launch here'); });
  const info = await s.create('alice', shell);
  assert.deepEqual(await s.persistence(), { mode: 'in-process', reason: 'host_unavailable' });
  assert.equal((await s.get('alice', info.id))?.id, info.id);
  assert.equal(launches, 1, 'a failed launch is not retried at every request');
  await s.dispose();
});

test('an impostor on the endpoint is never trusted, never launched over, never sent a keystroke', async () => {
  const files = freshFiles();
  const received: Record<string, unknown>[] = [];
  const impostor = createServer((socket) => {
    sendFrame(socket, { t: 'hello', protocol: 1, min: 1, nonce: 'n'.repeat(32) });
    readFrames(socket, (f) => {
      received.push(f);
      sendFrame(socket, { t: 'welcome', protocol: 1, proof: '0'.repeat(64), build: '1.0.0', entry: 'x', pid: 1, sessions: 0 });
    });
  });
  await listen(impostor, files.endpoint);
  mkdirSync(join(files.token, '..'), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(files.token, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  let launches = 0;
  try {
    const s = store(files, async () => { launches++; return { via: 'test' }; });
    assert.deepEqual(await s.persistence(), { mode: 'in-process', reason: 'host_untrusted' });
    await s.create('alice', shell);
    assert.equal(launches, 0);
    assert.ok(received.length > 0 && received.every((f) => f.t === 'auth'), 'only handshakes reached it');
    assert.ok(received.every((f) => !JSON.stringify(f).includes('a'.repeat(64))), 'the token itself never travels');
    await s.dispose();
  } finally {
    impostor.close();
  }
});

test('the real host process keeps a running command across a daemon restart', { skip: loadNodePty() === null || process.platform === 'win32' }, async () => {
  // In the machine's temporary folder, like a real home a short path: the test
  // runner's own folder is nested deep enough on macOS that the host's socket
  // would outgrow its 104 bytes. Removed at the end, the runner does not.
  const home = mkdtempSync(join(process.env.TIMON_TEST_REAL_TMPDIR || tmpdir(), 'hosted-real-'));
  const files = hostFiles(home);
  const entry = fileURLToPath(new URL('../../terminal-host/main.ts', import.meta.url));
  let hostPid: number | null = null;
  const launch: HostedOptions['launch'] = async () => {
    const started = await spawnInNewSession({
      name: 'timon-terminal-host-test',
      cmd: process.execPath,
      args: ['--import', 'tsx', entry],
      env: { ...process.env, TIMON_HOME: home, TIMON_TERMINAL_HOST_EXIT_MS: '5000' },
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      logFile: files.log,
    });
    hostPid = started.pid;
    return { via: started.via };
  };
  const make = (): HostedSessions => new HostedSessions({
    endpoint: files.endpoint, tokenFile: files.token, build: '1.0.0', idleMs: () => 60_000,
    local: () => { throw new Error('the real host must serve this test'); },
    launch, launchWaitMs: 15_000, log: () => {},
  });
  const before = make();
  try {
    const info = await before.create('alice', { shell: '/bin/sh', args: [], cwd: home, env: { PATH: process.env.PATH ?? '', HOME: home } });
    assert.equal((await before.persistence()).mode, 'host', readLog(files.log));
    const view = recorder();
    const handle = (await before.attach('alice', info.id, view.client))!;
    handle.input('sleep 1 && echo "fini-$((6*7))"\r');
    await until(() => view.text().includes('sleep 1'), 5_000);
    before.disconnect();

    const after = make();
    assert.equal(await after.reconnect(), true);
    const back = recorder();
    assert.ok(await after.attach('alice', info.id, back.client));
    await until(() => back.text().includes('fini-42'), 8_000);
    assert.match(back.text(), /sleep 1/, 'the scrollback from before the restart is replayed');
    await after.dispose();
  } finally {
    before.disconnect();
    if (hostPid !== null && hostPid > 0) {
      try { process.kill(hostPid); } catch { /* left on its own */ }
    }
    rmSync(home, { recursive: true, force: true });
  }
});

function readLog(file: string): string {
  try { return readFileSync(file, 'utf8'); } catch { return '(no host log)'; }
}

test('the host runs on the daemon runtime, without the daemon secrets, and Electron runs it as Node', async () => {
  const { hostEnv, hostEntry } = await import('./index.js');
  const env = hostEnv({ PATH: '/usr/bin', TIMON_DAEMON_TOKEN: 'secret', TIMON_HOME: '/elsewhere', NODE_ENV: 'production' }, '38.0.0');
  assert.equal(env.TIMON_DAEMON_TOKEN, undefined);
  assert.equal(env.TIMON_HOME, process.env.TIMON_HOME, 'the home this daemon serves, not an inherited one');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(hostEnv({}, undefined).ELECTRON_RUN_AS_NODE, undefined);
  assert.match(hostEntry(), /terminal-host[\\/]main\.ts$/);
});
