/**
 * The macOS adapter's fence: the probe, the profile it writes, the launch it
 * returns. With fakes everywhere; and, on a Mac where Seatbelt answers, the
 * measured scenario for real — the Timon home refused, the worktree usable,
 * Unix sockets refused, the pid kept.
 */
import '../test-home.js';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TimonConfigSchema } from '../config/schema.js';
import { createDarwinHost, createSeatbeltFence } from './darwin.js';
import { resolveFence, type FencePolicy } from './isolation.js';
import { SANDBOX_EXEC, SEATBELT_PROBE_PROFILE } from './seatbelt.js';

const cfg = (isolation: Record<string, unknown> = {}) =>
  TimonConfigSchema.parse({ host: { docker: 'disabled', isolation } });

function fencePolicy(home: string, unixSockets: 'deny' | 'allow' = 'deny'): FencePolicy {
  const timonHome = join(home, '.timon');
  return resolveFence(cfg({ unixSockets }), {
    timonHome, cwd: join(timonHome, 'worktrees', 'm1'), home, platform: 'darwin', missionId: 'm1', realpath: (path) => path,
  });
}

test('the probe applies the empty profile to /usr/bin/true, once per daemon', () => {
  const calls: Array<[string, string[]]> = [];
  const fence = createSeatbeltFence({ run: (file, args) => { calls.push([file, args]); return { status: 0, stderr: '' }; } });
  assert.equal(fence.mechanism, 'seatbelt');
  assert.deepEqual(fence.probe(), { available: true });
  assert.deepEqual(fence.probe(), { available: true });
  assert.deepEqual(calls, [[SANDBOX_EXEC, ['-p', SEATBELT_PROBE_PROFILE, '/usr/bin/true']]]);
});

test('a daemon that already runs sandboxed reports that it cannot fence', () => {
  const fence = createSeatbeltFence({ run: () => ({ status: 71, stderr: 'sandbox-exec: sandbox_apply: Operation not permitted' }) });
  assert.equal(fence.probe().available, false);
  assert.match(fence.probe().reason ?? '', /already runs inside a sandbox/);
});

test('wrap writes the profile, then launches the command through sandbox-exec', () => {
  const written: Array<[string, string]> = [];
  const fence = createSeatbeltFence({
    realpath: (path) => path,
    writeProfile: (file, text) => { written.push([file, text]); },
  });
  const launch = fence.wrap(fencePolicy('/Users/tester'), '/opt/bin/claude', ['-p', 'hi'], '/Users/tester/.timon/tmp/fence/m1.sb');
  assert.deepEqual(launch, { cmd: SANDBOX_EXEC, args: ['-f', '/Users/tester/.timon/tmp/fence/m1.sb', '--', '/opt/bin/claude', '-p', 'hi'] });
  assert.equal(written.length, 1);
  assert.equal(written[0]?.[0], '/Users/tester/.timon/tmp/fence/m1.sb');
  assert.ok(written[0]?.[1].includes('(deny file-read-data file-write* (subpath "/Users/tester/.timon"))'));
});

test('wrap renders the resolved spelling of each path, which is what Seatbelt matches', () => {
  let text = '';
  const fence = createSeatbeltFence({
    realpath: (path) => {
      if (path === '/Users/tester/.timon') return '/Volumes/Data/timon';
      if (path.startsWith('/Users/tester/.timon/')) throw new Error('ENOENT');
      return path;
    },
    writeProfile: (_file, profile) => { text = profile; },
  });
  fence.wrap(fencePolicy('/Users/tester'), '/bin/sh', [], '/p.sb');
  assert.ok(text.includes('(deny file-read-data file-write* (subpath "/Volumes/Data/timon"))'));
  assert.ok(text.includes('(allow file-read-data file-write* (subpath "/Volumes/Data/timon/worktrees/m1"))'));
  assert.ok(text.includes('(deny file-read-data file-write* (subpath "/Volumes/Data/timon/daemon-token"))'));
});

test('a dropped grant is reported, and the profile is still written without it', () => {
  const warnings: string[] = [];
  const timonHome = '/Users/tester/.timon';
  const policy = resolveFence(cfg(), {
    timonHome, cwd: '/Users/tester/project', home: '/Users/tester', platform: 'darwin', realpath: (path) => path,
  });
  let text = '';
  const fence = createSeatbeltFence({
    realpath: (path) => (path === '/Users/tester/project' ? `${timonHome}/secrets.env` : path),
    writeProfile: (_file, profile) => { text = profile; },
    warn: (line) => warnings.push(line),
  });
  fence.wrap(policy, '/bin/sh', [], '/p.sb');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /grant on \/Users\/tester\/\.timon\/secrets\.env dropped/);
  assert.doesNotMatch(text, /allow file-read-data file-write\* \(subpath "\/Users\/tester\/\.timon\/secrets\.env"\)/);
});

test('the default writer keeps the profile owner-only', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-fence-'));
  const file = join(dir, 'fence', 'm1.sb');
  createSeatbeltFence({ realpath: (path) => path }).wrap(fencePolicy('/Users/tester'), '/bin/sh', [], file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'fence')).mode & 0o777, 0o700);
  assert.match(readFileSync(file, 'utf8'), /^;; Timon mission fence/);
});

test('the macOS adapter carries the Seatbelt fence', () => {
  const host = createDarwinHost(cfg());
  assert.equal(host.platform, 'darwin');
  assert.equal(host.fence?.mechanism, 'seatbelt');
});

// ---------------------------------------------------------------------------
// The real fence, on a Mac.

const realFence = process.platform === 'darwin' ? createSeatbeltFence() : null;
const skip = !realFence ? 'Seatbelt exists on macOS only'
  : !realFence.probe().available ? `no Seatbelt here: ${realFence.probe().reason}` : false;

const PROBE_SCRIPT = String.raw`
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const [TH, WT, SOCK] = process.argv.slice(2);
const out = { pid: process.pid };
const t = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = e.code || String(e.message); } };
t('readToken', () => fs.readFileSync(path.join(TH, 'daemon-token')));
t('readDb', () => fs.readFileSync(path.join(TH, 'timon.db')));
t('listTimonHome', () => fs.readdirSync(TH));
t('writeConfig', () => fs.appendFileSync(path.join(TH, 'timon.config.json'), 'x'));
t('readOtherWorktree', () => fs.readFileSync(path.join(TH, 'worktrees', 'm2', 'notes')));
t('readThroughLink', () => fs.readFileSync(path.join(WT, 'link-to-token')));
t('writeWorktree', () => { fs.writeFileSync(path.join(WT, 'file'), 'work'); fs.readFileSync(path.join(WT, 'file')); });
const c = net.connect(SOCK);
c.on('connect', () => { out.unixSocket = 'ok'; c.destroy(); done(); });
c.on('error', (e) => { out.unixSocket = e.code; done(); });
function done() { process.stdout.write(JSON.stringify(out)); }
`;

async function scenario(unixSockets: 'deny' | 'allow') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'darwin-fence-scenario-')));
  const home = join(root, 'home');
  const timonHome = join(home, '.timon');
  const worktree = join(timonHome, 'worktrees', 'm1');
  for (const dir of [worktree, join(timonHome, 'worktrees', 'm2')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(timonHome, 'daemon-token'), 'FAKE-TOKEN');
  writeFileSync(join(timonHome, 'timon.db'), 'FAKE-DB');
  writeFileSync(join(timonHome, 'timon.config.json'), '{}');
  writeFileSync(join(timonHome, 'worktrees', 'm2', 'notes'), 'other mission');
  symlinkSync(join(timonHome, 'daemon-token'), join(worktree, 'link-to-token'));
  const script = join(root, 'probe.cjs');
  writeFileSync(script, PROBE_SCRIPT);
  const socket = join(root, 's.sock');
  const server = createServer((s) => s.end());
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const launch = (realFence as NonNullable<typeof realFence>)
      .wrap(fencePolicy(home, unixSockets), process.execPath, [script, timonHome, worktree, socket], join(root, 'fence.sb'));
    return await new Promise<{ pid: number | undefined; report: Record<string, string | number> }>((resolve, reject) => {
      const child = spawn(launch.cmd, launch.args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (status) => {
        clearTimeout(timer);
        if (status !== 0) reject(new Error(`fenced run exited ${status}: ${stderr}`));
        else resolve({ pid: child.pid, report: JSON.parse(stdout) as Record<string, string | number> });
      });
    });
  } finally {
    server.close();
  }
}

test('fenced on macOS: the Timon home is out of reach, the worktree is not, the pid is kept', { skip }, async () => {
  const { pid, report } = await scenario('deny');
  for (const gesture of ['readToken', 'readDb', 'listTimonHome', 'writeConfig', 'readOtherWorktree', 'readThroughLink', 'unixSocket']) {
    assert.notEqual(report[gesture], 'ok', `${gesture} must be refused`);
  }
  assert.equal(report.writeWorktree, 'ok');
  assert.equal(report.pid, pid);
});

test('fenced on macOS: unix-sockets allow reaches a socket, and still not the token', { skip }, async () => {
  const { report } = await scenario('allow');
  assert.equal(report.unixSocket, 'ok');
  assert.notEqual(report.readToken, 'ok');
});
