/**
 * Terminal host protocol: the handshake proves the token both ways, a
 * session's output and scrollback travel to an attached connection, owners
 * stay apart, the frozen base (stats, shutdown) works across versions, and
 * the host leaves once it has had no session for a while. A fake PTY stands
 * in for node-pty; the server runs in this process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostConnectError, HostLink, HostRequestError } from './client.js';
import { chunksOf, hostFiles, MAX_LINE_BYTES, negotiate, newToken, readFrames, sendFrame } from './protocol.js';
import { createHostServer, type HostServer } from './server.js';
import type { Pty, PtySpawnOptions } from './sessions.js';

/** A fresh endpoint, its folder created as the host's `main.ts` would. */
function freshEndpoint(): string {
  const files = hostFiles(mkdtempSync(join(tmpdir(), 'th-')));
  if (files.endpointDir) mkdirSync(files.endpointDir, { recursive: true, mode: 0o700 });
  return files.endpoint;
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });
}

type FakePty = Pty & { written: string[]; killed: boolean; emit(data: string): void; exit(code: number): void; opts: PtySpawnOptions };

function fakeSpawner(): { spawn: (opts: PtySpawnOptions) => Pty; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  return {
    ptys,
    spawn: (opts) => {
      let onData: (d: string) => void = () => {};
      let onExit: (e: { exitCode: number }) => void = () => {};
      const pty: FakePty = {
        pid: 4000 + ptys.length, opts, written: [], killed: false,
        onData: (l) => { onData = l; },
        onExit: (l) => { onExit = l; },
        write: (d) => { pty.written.push(d); },
        resize: () => {},
        kill: () => { pty.killed = true; onExit({ exitCode: 0 }); },
        emit: (d) => onData(d),
        exit: (code) => onExit({ exitCode: code }),
      };
      ptys.push(pty);
      return pty;
    },
  };
}

async function startHost(opts: { exitAfterMs?: number; onIdleExit?: () => void } = {}): Promise<{ host: HostServer; endpoint: string; token: string; ptys: FakePty[] }> {
  const { spawn, ptys } = fakeSpawner();
  const token = newToken();
  const endpoint = freshEndpoint();
  const host = createHostServer({
    token, spawn, build: '9.9.9', entry: '/x/main.js',
    exitAfterMs: opts.exitAfterMs ?? 60_000,
    onIdleExit: opts.onIdleExit ?? (() => {}),
  });
  await listen(host.server, endpoint);
  return { host, endpoint, token, ptys };
}

const createReq = { ownerId: 'alice', shell: 'sh', args: [], cwd: '/', env: {} };

function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) resolve();
      else if (Date.now() > deadline) reject(new Error('condition not met in time'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

test('a wrong token is refused, and the host never learns the right one', async () => {
  const { host, endpoint } = await startHost();
  try {
    await assert.rejects(HostLink.open(endpoint, newToken()), (err: unknown) => err instanceof HostConnectError && err.code === 'untrusted');
  } finally {
    host.close();
  }
});

test('a listener that cannot prove the token is not trusted', async () => {
  // An impostor on the endpoint: it answers the handshake with a made-up proof.
  const endpoint = freshEndpoint();
  const impostor = createServer((socket) => {
    sendFrame(socket, { t: 'hello', protocol: 1, min: 1, nonce: 'n'.repeat(32) });
    readFrames(socket, () => sendFrame(socket, { t: 'welcome', protocol: 1, proof: 'f'.repeat(64), build: 'x', entry: 'x', pid: 1, sessions: 0 }));
  });
  await listen(impostor, endpoint);
  try {
    await assert.rejects(HostLink.open(endpoint, newToken()), (err: unknown) => err instanceof HostConnectError && err.code === 'untrusted');
  } finally {
    impostor.close();
  }
});

test('nothing listening reads as absent', async () => {
  await assert.rejects(HostLink.open(freshEndpoint(), newToken()), (err: unknown) => err instanceof HostConnectError && err.code === 'absent');
});

test('create, attach, stream, replay the scrollback on a new attachment', async () => {
  const { host, endpoint, token, ptys } = await startHost();
  try {
    const control = await HostLink.open(endpoint, token);
    assert.equal(control.welcome.build, '9.9.9');
    assert.equal(control.welcome.sessions, 0);
    const info = await control.request<{ id: string; cols: number }>('create', { ...createReq, cols: 100, rows: 30 });
    assert.equal(info.cols, 100);
    ptys[0]!.emit('hello ');

    const view = await HostLink.open(endpoint, token);
    let out = '';
    view.onFrame = (f) => { if (f.t === 'out') out += String(f.data); };
    assert.equal(await view.request('attach', { ownerId: 'alice', sessionId: info.id }), true);
    ptys[0]!.emit('world');
    await until(() => out === 'hello world');
    view.send({ t: 'in', data: 'ls\r' });
    await until(() => ptys[0]!.written.join('') === 'ls\r');
    view.close();

    const again = await HostLink.open(endpoint, token);
    let replay = '';
    again.onFrame = (f) => { if (f.t === 'out') replay += String(f.data); };
    await again.request('attach', { ownerId: 'alice', sessionId: info.id });
    await until(() => replay === 'hello world');

    let exit: unknown = null;
    again.onFrame = (f) => { if (f.t === 'exit') exit = f.code; };
    ptys[0]!.exit(3);
    await until(() => exit === 3);
    again.close();
    control.close();
  } finally {
    host.close();
  }
});

test('one owner never reaches the session of another', async () => {
  const { host, endpoint, token, ptys } = await startHost();
  try {
    const link = await HostLink.open(endpoint, token);
    const info = await link.request<{ id: string }>('create', createReq);
    assert.deepEqual(await link.request('list', { ownerId: 'bob' }), []);
    assert.equal(await link.request('get', { ownerId: 'bob', sessionId: info.id }), null);
    assert.equal(await link.request('attach', { ownerId: 'bob', sessionId: info.id }), false);
    assert.equal(await link.request('kill', { ownerId: 'bob', sessionId: info.id }), false);
    assert.equal(ptys[0]!.killed, false);
    assert.equal(await link.request('kill', { ownerId: 'alice', sessionId: info.id }), true);
    assert.equal(ptys[0]!.killed, true);
    link.close();
  } finally {
    host.close();
  }
});

test('a failed spawn and a malformed request come back as typed errors', async () => {
  const token = newToken();
  const endpoint = freshEndpoint();
  const host = createHostServer({
    token, build: 'b', entry: 'e', exitAfterMs: 60_000, onIdleExit: () => {},
    spawn: () => { throw new Error('posix_spawnp failed'); },
  });
  await listen(host.server, endpoint);
  try {
    const link = await HostLink.open(endpoint, token);
    await assert.rejects(link.request('create', createReq), (err: unknown) => err instanceof HostRequestError && err.code === 'spawn');
    await assert.rejects(link.request('create', { ownerId: 'x' }), (err: unknown) => err instanceof HostRequestError && err.code === 'bad_request');
    link.close();
  } finally {
    host.close();
  }
});

test('versions: the ranges meet on the highest common one, else on the frozen base', () => {
  assert.equal(negotiate({ protocol: 1, min: 1 }, { protocol: 1, min: 1 }), 1);
  assert.equal(negotiate({ protocol: 3, min: 1 }, { protocol: 2, min: 1 }), 2);
  assert.equal(negotiate({ protocol: 5, min: 4 }, { protocol: 2, min: 1 }), 0);
  assert.equal(negotiate({ protocol: 1, min: 1 }, { protocol: 3, min: 2 }), 0);
});

/** A daemon speaking a version this host does not: only the frozen base answers. */
async function openAs(endpoint: string, token: string, protocol: number): Promise<{ socket: Socket; frames: Record<string, unknown>[] }> {
  const { proofOf, newNonce } = await import('./protocol.js');
  const socket = connect(endpoint);
  const frames: Record<string, unknown>[] = [];
  readFrames(socket, (f) => {
    frames.push(f);
    if (f.t === 'hello') sendFrame(socket, { t: 'auth', protocol, nonce: newNonce(), proof: proofOf(token, 'daemon', String(f.nonce)) });
  });
  await until(() => frames.some((f) => f.t === 'welcome' || f.t === 'denied'));
  return { socket, frames };
}

test('on the frozen base, only stats and shutdown answer; an idle host leaves on request, a busy one does not', async () => {
  let left = 0;
  const { host, endpoint, token } = await startHost({ onIdleExit: () => { left++; } });
  try {
    const { socket, frames } = await openAs(endpoint, token, 0);
    assert.equal(frames.at(-1)!.t, 'welcome');
    sendFrame(socket, { t: 'req', id: 1, op: 'list', ownerId: 'alice' });
    sendFrame(socket, { t: 'req', id: 2, op: 'stats' });
    await until(() => frames.filter((f) => f.t === 'res').length === 2);
    const [list, stats] = frames.filter((f) => f.t === 'res');
    assert.equal(list!.ok, false);
    assert.equal(list!.error, 'unsupported');
    assert.equal((stats!.result as { sessions: number }).sessions, 0);

    const busy = await HostLink.open(endpoint, token);
    await busy.request('create', createReq);
    await assert.rejects(busy.request('shutdown', { ifIdle: true }), (err: unknown) => err instanceof HostRequestError && err.code === 'busy');
    await busy.request('killAll');
    assert.deepEqual(await busy.request('shutdown', { ifIdle: true }), { stopping: true });
    await until(() => left === 1);
    socket.destroy();
  } finally {
    host.close();
  }
});

test('a version outside the host range is denied', async () => {
  const { host, endpoint, token } = await startHost();
  try {
    const { frames } = await openAs(endpoint, token, 99);
    assert.deepEqual(frames.at(-1), { t: 'denied', reason: 'protocol' });
  } finally {
    host.close();
  }
});

test('the host leaves on its own once it has had no session for the delay', async () => {
  let left = 0;
  const { host, endpoint, token } = await startHost({ exitAfterMs: 300, onIdleExit: () => { left++; } });
  try {
    const link = await HostLink.open(endpoint, token);
    const info = await link.request<{ id: string }>('create', createReq);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(left, 0, 'a session is running: the host stays');
    await link.request('kill', { ownerId: 'alice', sessionId: info.id });
    await until(() => left > 0, 2_000);
    link.close();
  } finally {
    host.close();
  }
});

test('an oversized line ends the connection', async () => {
  const { host, endpoint } = await startHost();
  try {
    const socket = connect(endpoint);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('error', () => {});
    // Read what the host sends, or the end of the stream is never seen.
    socket.resume();
    socket.write('x'.repeat(MAX_LINE_BYTES + 10));
    await closed;
  } finally {
    host.close();
  }
});

test('output chunks never split a surrogate pair', () => {
  const text = `${'a'.repeat(3)}😀${'b'.repeat(3)}`;
  const parts = chunksOf(text, 4);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.doesNotMatch(p, /[\uD800-\uDBFF]$/);
});

test('endpoints: a pipe per instance on Windows, a short private folder when the socket path is too long', () => {
  const win = hostFiles('C:\\Users\\a\\.timon', 'win32');
  assert.match(win.endpoint, /^\\\\\.\\pipe\\timon-terminal-host-[0-9a-f]{24}$/);
  assert.notEqual(hostFiles('C:\\Users\\b\\.timon', 'win32').endpoint, win.endpoint);
  const short = hostFiles('/home/u/.timon', 'linux');
  assert.equal(short.endpoint, join('/home/u/.timon', 'run', 'terminal-host.sock'));
  // Measured against the machine's temporary folder, as a daemon sees it: the
  // test runner's own is nested deeper, which on macOS (`/var/folders/…/T/`)
  // already leaves no room for a socket name.
  const scratch = process.env.TMPDIR;
  process.env.TMPDIR = process.env.TIMON_TEST_REAL_TMPDIR || tmpdir();
  let long: ReturnType<typeof hostFiles>;
  try {
    long = hostFiles(`/home/u/${'deep/'.repeat(30)}.timon`, 'linux');
  } finally {
    if (scratch === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = scratch;
  }
  assert.ok(Buffer.byteLength(long.endpoint) <= 100, long.endpoint);
  assert.equal(long.token, join(`/home/u/${'deep/'.repeat(30)}.timon`, 'run', 'terminal-host.token'));
});
