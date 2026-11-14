/**
 * The egress proxy reaches the missions (TODO #590, T2): every launch gets
 * `HTTP(S)_PROXY` under its own egress credential and `NO_PROXY` for the
 * daemon's loopback; that credential opens the proxy and no API route — on a
 * machine with no account as after setup —, never speaks for another mission,
 * and appears in no log, event or mission row. Mode `off`, a proxy that does
 * not listen and an upstream proxy already set leave the environment alone.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { createServer as createNetServer, connect as netConnect, type AddressInfo } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import express from 'express';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
// The runner's own proxy, if any, would be an upstream proxy: the injection steps aside for it.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[name];

await import('../../tests/helpers/paid-license.js');
await import('../../tests/helpers/claude-provider.js');
const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent, missionEnv } = await import('../agent.js');
const { db, dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { issueMissionApiToken } = await import('../users/api-tokens.js');
const { createDaemonAuthMiddleware, ensureDaemonToken } = await import('../plugins-bundled/http/auth.js');
const { config, setConfig } = await import('../config/load.js');
const { authenticateMissionToken, egressProxyAddress, missionEgressEnv, startEgressProxy } = await import('./service.js');
const { listMissionEgress } = await import('./journal.js');

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];

/** Everything the daemon writes, to prove no credential reaches it. */
const output: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error, stderr: process.stderr.write.bind(process.stderr) };
const capture = (...args: unknown[]): void => { output.push(args.map(String).join(' ')); };
console.log = capture;
console.warn = capture;
console.error = capture;
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  output.push(String(chunk));
  return (original.stderr as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stderr.write;
after(() => {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
  process.stderr.write = original.stderr as typeof process.stderr.write;
});

// `off` is the default: everything below is about an install that wrote `log` in its config.
const defaults = config();
setConfig({ ...defaults, host: { ...defaults.host, isolation: { ...defaults.host.isolation, egress: { ...defaults.host.isolation.egress, mode: 'log' } } } });

const stopProxy = startEgressProxy({ mode: 'log', host: '127.0.0.1', port: 0 });
after(stopProxy);
for (let i = 0; i < 300 && !egressProxyAddress(); i += 1) await new Promise((r) => setTimeout(r, 10));
const proxyAddress = egressProxyAddress();
assert.ok(proxyAddress, 'the egress proxy did not start');

/** A REST surface behind the daemon's real auth middleware. */
const api = express();
api.use(createDaemonAuthMiddleware({ token: ensureDaemonToken(), required: false }));
api.get('/api/anything', (_req, res) => { res.json({ ok: true }); });
const apiServer = api.listen(0, '127.0.0.1');
await once(apiServer, 'listening');
after(() => apiServer.close());
const apiPort = (apiServer.address() as AddressInfo).port;
const apiStatus = async (bearer?: string): Promise<number> =>
  (await fetch(`http://127.0.0.1:${apiPort}/api/anything`, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {})).status;

/** An upstream that answers both a tunnel and a plain HTTP request. */
const upstream = createHttpServer((_req, res) => { res.end('hello'); });
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
after(() => upstream.close());
const upstreamPort = (upstream.address() as AddressInfo).port;

function credentialsOf(proxyUrl: string | undefined): { missionId: string; token: string; basic: string } {
  assert.ok(proxyUrl, 'no proxy variable');
  const url = new URL(proxyUrl);
  const missionId = decodeURIComponent(url.username);
  const token = decodeURIComponent(url.password);
  return { missionId, token, basic: `Basic ${Buffer.from(`${missionId}:${token}`).toString('base64')}` };
}

const basic = (missionId: string, token: string): string => `Basic ${Buffer.from(`${missionId}:${token}`).toString('base64')}`;

async function connectStatus(authorization: string): Promise<string> {
  const socket = netConnect({ host: '127.0.0.1', port: proxyAddress!.port });
  await once(socket, 'connect');
  socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nProxy-Authorization: ${authorization}\r\n\r\n`);
  const [chunk] = await once(socket, 'data') as [Buffer];
  socket.destroy();
  return chunk.toString().split('\r\n')[0]!;
}

/** The proxy journals a connection when it ends: wait for its row. */
async function waitForJournal(missionId: string, method: string, port: number): Promise<void> {
  const found = (): boolean => listMissionEgress(missionId, { limit: 50 }).connections
    .some((row) => row.method === method && row.host === '127.0.0.1' && row.port === port && row.status === 200);
  for (let i = 0; i < 300 && !found(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(found(), `no journal row for ${method} 127.0.0.1:${port}`);
}

const issued: string[] = [];

test('no account yet: the proxy URL carries a dedicated credential, never the daemon-token, and that credential opens no route', async () => {
  assert.equal(dbApi.countUsers(), 0);
  const id = 'first-run-mission';
  dbApi.createMission(id, 'egress.agent', 'first run');
  const env = missionEnv({ missionId: id, agentName: 'egress.agent', cwd: tmpdir() });
  const { missionId, token } = credentialsOf(env.HTTPS_PROXY);
  issued.push(token);
  assert.equal(missionId, id);
  // Its API credential is its own mission token, not the operator's, and not the proxy's.
  assert.notEqual(env.TIMON_API_TOKEN, ensureDaemonToken());
  assert.notEqual(env.TIMON_API_TOKEN, token);
  assert.notEqual(token, ensureDaemonToken());
  for (const name of PROXY_VARS) assert.equal(env[name], env.HTTPS_PROXY, name);
  assert.equal(new URL(env.HTTPS_PROXY!).host, `127.0.0.1:${proxyAddress!.port}`);

  // The loopback is open to anyone before setup — and still closed to this credential.
  assert.equal(await apiStatus(), 200);
  assert.equal(await apiStatus(token), 401);
  assert.match(await connectStatus(basic(id, ensureDaemonToken())), / 407 /);
  assert.match(await connectStatus(basic(id, token)), / 200 /);
});

/** Created by the first test after the no-account one: `test()` bodies run after the module body. */
let adaId = '';

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4343;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

test('a spawned mission reaches the web through the proxy, journaled under its own id', async () => {
  adaId = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false }).id;
  upsertAgent({
    name: 'egress-witness',
    system_prompt: 'egress witness — does nothing.',
    config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const host = getHost();
  const realSpawn = host.spawn;
  const calls: NodeJS.ProcessEnv[] = [];
  const children: FakeChild[] = [];
  host.spawn = ((_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    children.push(child);
    calls.push((opts?.env ?? {}) as NodeJS.ProcessEnv);
    return child;
  }) as typeof host.spawn;
  try {
    const missionId = await spawnAgent('egress-witness', 'ping', undefined, { ownerUserId: adaId });
    assert.equal(calls.length, 1);
    const env = calls[0]!;
    const proxy = credentialsOf(env.HTTP_PROXY);
    issued.push(proxy.token, env.TIMON_API_TOKEN!);
    assert.equal(proxy.missionId, missionId);
    assert.notEqual(proxy.token, env.TIMON_API_TOKEN, 'the API token must not be the proxy credential');
    for (const entry of ['127.0.0.1', '::1', 'localhost']) {
      assert.ok(env.NO_PROXY!.split(',').includes(entry), entry);
      assert.ok(env.no_proxy!.split(',').includes(entry), entry);
    }

    // A tunnel, as a CLI does for https.
    const socket = netConnect({ host: '127.0.0.1', port: proxyAddress!.port });
    await once(socket, 'connect');
    socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nProxy-Authorization: ${proxy.basic}\r\n\r\n`);
    const [established] = await once(socket, 'data') as [Buffer];
    assert.match(established.toString(), /^HTTP\/1\.1 200 /);
    socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    let answer = '';
    socket.on('data', (chunk: Buffer) => { answer += chunk.toString(); });
    await once(socket, 'close');
    assert.match(answer, /hello/);
    await waitForJournal(missionId, 'CONNECT', upstreamPort);

    // A plain-HTTP request in absolute form.
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: proxyAddress!.port,
        method: 'GET',
        path: `http://127.0.0.1:${upstreamPort}/page`,
        headers: { 'Proxy-Authorization': proxy.basic },
      }, (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => { text += chunk.toString(); });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, 'hello');
    await waitForJournal(missionId, 'GET', upstreamPort);

    // The proxy credential is no API identity; the mission's API token is no proxy credential.
    assert.equal(await apiStatus(proxy.token), 401);
    assert.equal(await apiStatus(env.TIMON_API_TOKEN), 200);
    assert.match(await connectStatus(basic(missionId, env.TIMON_API_TOKEN!)), / 407 /);

    // Nothing the mission left behind holds the credential.
    const rows = JSON.stringify([
      db.prepare('SELECT * FROM events WHERE mission_id = ?').all(missionId),
      dbApi.getMission(missionId),
      db.prepare('SELECT * FROM egress_log WHERE mission_id = ?').all(missionId),
    ]);
    assert.equal(rows.includes(proxy.token), false, 'the proxy credential reached an event, the mission row or the journal');
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM egress_log').all()).includes('/page'), false, 'a path reached the journal');

    // It dies with the mission.
    dbApi.finishMission(missionId, 'completed', 0);
    assert.equal(authenticateMissionToken(missionId, proxy.token), false);
    assert.match(await connectStatus(proxy.basic), / 407 /);
  } finally {
    host.spawn = realSpawn;
    for (const child of children) if (!child.killed) child.kill();
  }
});

function runningMission(): string {
  const id = `mission-${Math.random().toString(36).slice(2)}`;
  dbApi.createMission(id, 'ada.agent', 'egress work', undefined, adaId);
  return id;
}

test("one mission's proxy credential is refused under another mission's id", async () => {
  const a = runningMission();
  const b = runningMission();
  const tokenA = credentialsOf(missionEgressEnv(a, {}).HTTPS_PROXY).token;
  const tokenB = credentialsOf(missionEgressEnv(b, {}).HTTPS_PROXY).token;
  issued.push(tokenA, tokenB);
  assert.equal(authenticateMissionToken(a, tokenA), true);
  assert.equal(authenticateMissionToken(a, tokenB), false);
  assert.match(await connectStatus(basic(a, tokenB)), / 407 /);
  assert.match(await connectStatus(basic(b, tokenB)), / 200 /);
});

test('issuing the API token keeps the proxy credential, re-issuing the proxy credential replaces it', () => {
  const id = runningMission();
  const first = credentialsOf(missionEgressEnv(id, {}).HTTPS_PROXY).token;
  issued.push(first, issueMissionApiToken(id));
  assert.equal(authenticateMissionToken(id, first), true);
  const second = credentialsOf(missionEgressEnv(id, {}).HTTPS_PROXY).token;
  issued.push(second);
  assert.equal(authenticateMissionToken(id, first), false);
  assert.equal(authenticateMissionToken(id, second), true);
});

test('a third-party CLI gets the proxy under its own credential and still no API token', () => {
  const id = runningMission();
  const env = missionEnv({ missionId: id, agentName: 'a', cwd: tmpdir(), untrusted: true });
  const proxy = credentialsOf(env.HTTPS_PROXY);
  issued.push(proxy.token);
  assert.equal(proxy.missionId, id);
  assert.equal(env.TIMON_API_TOKEN, undefined);
  assert.equal(authenticateMissionToken(id, proxy.token), true);
});

test('an upstream proxy already set is left in place, the egress proxy steps aside', () => {
  const id = runningMission();
  const env = missionEnv({ missionId: id, agentName: 'a', cwd: tmpdir(), specEnv: { https_proxy: 'http://corp.example:3128', NO_PROXY: 'intranet' } });
  assert.equal(env.https_proxy, 'http://corp.example:3128');
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NO_PROXY, 'intranet');
  assert.ok(output.some((line) => line.includes('upstream proxy is set')));
});

test('an existing NO_PROXY is kept alongside the loopback', () => {
  const id = runningMission();
  const env = missionEgressEnv(id, { no_proxy: 'intranet, .corp.example' });
  issued.push(credentialsOf(env.HTTPS_PROXY).token);
  const entries = env.NO_PROXY!.split(',');
  for (const entry of ['intranet', '.corp.example', '127.0.0.1', '::1', 'localhost']) assert.ok(entries.includes(entry), entry);
});

test('mode off, or a proxy that does not listen: no proxy variable at all', () => {
  const id = runningMission();
  const saved = config();
  setConfig({ ...saved, host: { ...saved.host, isolation: { ...saved.host.isolation, egress: { ...saved.host.isolation.egress, mode: 'off' } } } });
  try {
    const env = missionEnv({ missionId: id, agentName: 'a', cwd: tmpdir() });
    for (const name of [...PROXY_VARS, 'NO_PROXY', 'no_proxy']) assert.equal(env[name], undefined, name);
  } finally {
    setConfig(saved);
  }
  stopProxy();
  assert.equal(egressProxyAddress(), null);
  const env = missionEnv({ missionId: id, agentName: 'a', cwd: tmpdir() });
  for (const name of [...PROXY_VARS, 'NO_PROXY', 'no_proxy']) assert.equal(env[name], undefined, name);
});

test('no credential reached the daemon output', () => {
  assert.ok(issued.length >= 8);
  const text = output.join('\n');
  for (const token of issued) {
    assert.equal(text.includes(token), false, 'a credential reached the daemon output');
    assert.equal(text.includes(encodeURIComponent(token)), false);
  }
  assert.equal(/http:\/\/[^\s/]+:[^\s/]+@/.test(text), false, 'a proxy URL with credentials reached the daemon output');
});
