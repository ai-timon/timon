/**
 * timon-fence: the policy wire format, where the daemon finds the launcher,
 * and — on a Linux kernel with Landlock ABI 2 or later — the scenario that
 * proved the fence: a mission reads none of Timon's private files, reaches no
 * Unix socket, and still works in its own worktree and on the network.
 *
 * The real run uses the launcher of this checkout, or builds one into the
 * test's scratch when a C compiler is present; otherwise it is skipped.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  encodeFencePolicy, fenceBinaryCandidates, fenceDeclaredByRelease, FENCE_EXIT, FENCE_POLICY_HEADER, FENCE_RELEASE_FILE,
  fenceLaunchDecision, fenceStatus, findFenceBinary, parseFenceProbe, probeFence, type FencePolicy, type FenceProbe,
} from './fence.js';

test('the policy is NUL-separated: header, socket option, then one pair per path', () => {
  const bytes = encodeFencePolicy({ readOnly: ['/usr', '/a b\nc'], readWrite: ['/work'], unixSockets: 'deny' });
  assert.deepEqual(bytes.toString('utf8').split('\0'),
    [FENCE_POLICY_HEADER, 'unix-sockets', 'deny', 'ro', '/usr', 'ro', '/a b\nc', 'rw', '/work', '']);
});

test('the policy refuses a relative path or a NUL, which the launcher would misread', () => {
  assert.throws(() => encodeFencePolicy({ readOnly: ['usr'], readWrite: [], unixSockets: 'deny' }), /absolute/);
  assert.throws(() => encodeFencePolicy({ readOnly: [], readWrite: ['/a\0/b'], unixSockets: 'allow' }), /NUL/);
});

test('the packaged launcher comes before the build folder of a checkout', () => {
  const root = join(tmpdir(), 'checkout', 'orchestrator');
  assert.deepEqual(fenceBinaryCandidates(root, 'arm64'), [
    join(root, 'native', 'timon-fence'),
    join(root, '..', 'native', 'timon-fence', 'build', 'linux-arm64', 'timon-fence'),
  ]);
});

test('no launcher is looked for off Linux, and a file without the exec bit is not one', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fence-root-'));
  assert.equal(findFenceBinary({ platform: 'darwin', orchestratorRoot: root }), null);
  mkdirSync(join(root, 'native'));
  writeFileSync(join(root, 'native', 'timon-fence'), '');
  chmodSync(join(root, 'native', 'timon-fence'), 0o644);
  assert.equal(findFenceBinary({ platform: 'linux', orchestratorRoot: root }), null);
  chmodSync(join(root, 'native', 'timon-fence'), 0o755);
  assert.equal(findFenceBinary({ platform: 'linux', orchestratorRoot: root }), join(root, 'native', 'timon-fence'));
});

test('the probe tells a missing Landlock from a missing seccomp', () => {
  assert.deepEqual(parseFenceProbe('landlock-abi=6 seccomp=yes\n', 0), { available: true, answered: true, abi: 6, seccomp: true });
  assert.equal(parseFenceProbe('landlock-abi=0 seccomp=yes\n', 69).answered, true);
  assert.equal(parseFenceProbe('landlock-abi=0 seccomp=yes\n', 69).reason, 'kernel without Landlock');
  assert.match(parseFenceProbe('landlock-abi=1 seccomp=yes\n', 69).reason ?? '', /ABI 1, 2 or later/);
  assert.equal(parseFenceProbe('landlock-abi=4 seccomp=no\n', 69).reason, 'kernel without seccomp filters');
  assert.equal(parseFenceProbe('', null).available, false);
});

// ---------------------------------------------------------------------------
// The status of the fence, and what a launch does with it.

const READY: FenceProbe = { available: true, answered: true, abi: 6, seccomp: true };
const NO_LANDLOCK: FenceProbe = { available: false, answered: true, abi: 0, seccomp: true, reason: 'kernel without Landlock' };
const SILENT: FenceProbe = { available: false, answered: false, abi: 0, seccomp: false, reason: 'the fence launcher did not answer its probe' };

/** An orchestrator folder whose release ships (or not) a launcher. */
function shippedRoot(content: string | null, mode = 0o755): { root: string; binary: string; digest: string } {
  const root = mkdtempSync(join(tmpdir(), 'fence-release-'));
  const binary = join(root, 'native', 'timon-fence');
  const bytes = content ?? '';
  if (content !== null) {
    mkdirSync(join(root, 'native'));
    writeFileSync(binary, bytes);
    chmodSync(binary, mode);
  }
  return { root, binary, digest: createHash('sha256').update(bytes).digest('hex') };
}

const signed = (digest: string) => ({ files: { 'dist/boot.js': 'x', [FENCE_RELEASE_FILE]: digest } });
const LINUX = { platform: 'linux' as const };

test('a launcher the release declares but that lost its execute bit is an alteration: warned in auto, refused in enforce', { skip: process.platform === 'win32' && 'Windows has no execute bit' }, () => {
  const { root, digest } = shippedRoot('launcher', 0o644);
  let probed = false;
  const status = fenceStatus({ ...LINUX, orchestratorRoot: root, release: signed(digest), probe: () => { probed = true; return READY; } });
  assert.equal(status.state, 'tampered');
  assert.match(status.state === 'tampered' ? status.reason : '', /ships .* is not executable/);
  assert.equal(probed, false, 'a launcher that fails the file checks is never run');

  const auto = fenceLaunchDecision('auto', status);
  assert.equal(auto.action, 'unfenced');
  assert.ok(auto.action === 'unfenced' && auto.tampered);
  assert.match(auto.action === 'unfenced' ? auto.warning ?? '' : '', /UNFENCED: .*not executable\. The Timon package may have been altered/);

  const enforce = fenceLaunchDecision('enforce', status);
  assert.equal(enforce.action, 'refuse');
  assert.match(enforce.action === 'refuse' ? enforce.error : '', /"enforce".*not executable.*altered/);
});

test('a declared launcher that is missing, replaced or does not run is an alteration too', { skip: process.platform === 'win32' && 'Windows has no execute bit' }, () => {
  const missing = shippedRoot(null);
  const gone = fenceStatus({ ...LINUX, orchestratorRoot: missing.root, release: signed(missing.digest), probe: () => READY });
  assert.ok(gone.state === 'tampered' && /is missing/.test(gone.reason));

  const replaced = shippedRoot('#!/bin/sh\nexec "$@"\n');
  const swapped = fenceStatus({ ...LINUX, orchestratorRoot: replaced.root, release: signed('0'.repeat(64)), probe: () => READY });
  assert.ok(swapped.state === 'tampered' && /no longer the file the release signed/.test(swapped.reason));

  const mute = shippedRoot('launcher');
  const silent = fenceStatus({ ...LINUX, orchestratorRoot: mute.root, release: signed(mute.digest), probe: () => SILENT });
  assert.ok(silent.state === 'tampered' && /does not run/.test(silent.reason));
});

test('a declared, intact launcher on a kernel without Landlock is the machine, not an alteration', () => {
  const { root, digest } = shippedRoot('launcher');
  const status = fenceStatus({ ...LINUX, orchestratorRoot: root, release: signed(digest), probe: () => NO_LANDLOCK });
  assert.deepEqual(status, { state: 'unsupported', reason: 'kernel without Landlock', abi: 0 });
  const auto = fenceLaunchDecision('auto', status);
  assert.deepEqual(auto, { action: 'unfenced', tampered: false, warning: 'Mission launched unfenced: kernel without Landlock.' });
  const ready = fenceStatus({ ...LINUX, orchestratorRoot: root, release: signed(digest), probe: () => READY });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(fenceLaunchDecision('enforce', ready), { action: 'fence', binary: join(root, 'native', 'timon-fence') });
});

test('the release manifest file declares the launcher even when no verified inventory was handed over', () => {
  const { root } = shippedRoot(null);
  writeFileSync(join(root, 'release-manifest.json'), JSON.stringify({ version: 2, files: { [FENCE_RELEASE_FILE]: 'abc' } }));
  assert.deepEqual(fenceDeclaredByRelease(root, null), { declared: true, digest: null });
  const status = fenceStatus({ ...LINUX, orchestratorRoot: root, release: null, probe: () => READY });
  assert.equal(status.state, 'tampered');
  // A verified inventory wins over the file: it does not list the launcher here.
  assert.deepEqual(fenceDeclaredByRelease(root, { files: { 'dist/boot.js': 'x' } }), { declared: false, digest: null });
});

test('a release that does not declare the launcher keeps the plain behaviour', { skip: process.platform === 'win32' && 'Windows has no execute bit' }, () => {
  // No launcher anywhere: unsupported, never an alteration.
  const empty = shippedRoot(null);
  const none = fenceStatus({ ...LINUX, orchestratorRoot: empty.root, release: { files: { 'dist/boot.js': 'x' } }, probe: () => READY });
  assert.deepEqual(none, { state: 'unsupported', reason: 'no fence launcher built for this machine', abi: 0 });
  assert.deepEqual(fenceLaunchDecision('auto', none),
    { action: 'unfenced', tampered: false, warning: 'Mission launched unfenced: no fence launcher built for this machine.' });
  const refused = fenceLaunchDecision('enforce', none);
  assert.ok(refused.action === 'refuse' && !refused.tampered && !/altered/.test(refused.error));

  // A launcher left without its execute bit in an undeclared tree is not used, and not called altered.
  const loose = shippedRoot('launcher', 0o644);
  const skipped = fenceStatus({ ...LINUX, orchestratorRoot: loose.root, release: null, probe: () => READY });
  assert.equal(skipped.state, 'unsupported');

  // An executable one is probed as before.
  const dev = shippedRoot('launcher');
  assert.equal(fenceStatus({ ...LINUX, orchestratorRoot: dev.root, release: null, probe: () => READY }).state, 'ready');
  assert.equal(fenceStatus({ ...LINUX, orchestratorRoot: dev.root, release: null, probe: () => SILENT }).state, 'unsupported');

  // Off Linux there is nothing to declare, and `off` never warns.
  const mac = fenceStatus({ platform: 'darwin', orchestratorRoot: dev.root, release: signed(dev.digest), probe: () => READY });
  assert.equal(mac.state, 'unsupported');
  assert.deepEqual(fenceLaunchDecision('off', mac), { action: 'unfenced', warning: null, tampered: false });
});

// ---------------------------------------------------------------------------
// The real fence.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** The launcher of this checkout, else one built into the scratch, else null. */
function launcher(): string | null {
  if (process.platform !== 'linux') return null;
  const found = findFenceBinary();
  if (found) return found;
  const out = join(mkdtempSync(join(tmpdir(), 'fence-bin-')), 'timon-fence');
  try {
    execFileSync(process.execPath, [join(REPO, 'native', 'timon-fence', 'build.mjs'), '--out', out, '--optional'], { stdio: 'ignore', timeout: 120_000 });
  } catch { return null; }
  return existsSync(out) ? out : null;
}

const FENCE = launcher();
const PROBE = FENCE ? probeFence(FENCE) : null;
const skip = !FENCE ? 'no timon-fence for this machine (Linux with a C compiler only)'
  : !PROBE?.available ? `no fence on this kernel: ${PROBE?.reason}` : false;

/**
 * "Everything except": each folder between `/` and a refused path is
 * enumerated, and its other entries are granted read-only. The isolation
 * policy of the daemon builds its projection the same way.
 */
function readOnlyExcept(denied: string[]): string[] {
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const levels = new Set<string>();
  for (const path of denied) {
    const parts = path.split('/').filter(Boolean);
    for (let depth = 0; depth < parts.length; depth++) levels.add(`/${parts.slice(0, depth).join('/')}`);
  }
  const granted: string[] = [];
  for (const level of levels) {
    for (const name of readdirSync(level)) {
      const child = level === '/' ? `/${name}` : `${level}/${name}`;
      if (levels.has(child) || denied.some((path) => under(child, path))) continue;
      granted.push(child);
    }
  }
  return granted;
}

interface Layout { root: string; home: string; timonHome: string; worktree: string; missionTmp: string; socket: string }

function layout(): Layout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fence-scenario-')));
  const home = join(root, 'home');
  const timonHome = join(home, '.timon');
  const worktree = join(timonHome, 'worktrees', 'm1');
  const missionTmp = join(timonHome, 'tmp', 'missions', 'm1');
  for (const dir of [worktree, missionTmp, join(timonHome, 'worktrees', 'm2'), join(timonHome, 'plugins'), join(timonHome, 'skills', 's1'), join(home, '.ssh')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(timonHome, 'daemon-token'), 'FAKE-TOKEN');
  writeFileSync(join(timonHome, 'secret-key'), 'FAKE-KEY');
  writeFileSync(join(timonHome, 'timon.db'), 'FAKE-DB');
  writeFileSync(join(timonHome, 'timon.config.json'), '{}');
  writeFileSync(join(timonHome, 'worktrees', 'm2', 'notes'), 'other mission');
  writeFileSync(join(timonHome, 'skills', 's1', 'SKILL.md'), '# skill');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'FAKE-SSH-KEY');
  return { root, home, timonHome, worktree, missionTmp, socket: join(root, 'unix.sock') };
}

function policyFor(where: Layout, unixSockets: 'deny' | 'allow'): FencePolicy {
  return {
    readOnly: [...readOnlyExcept([where.timonHome, join(where.home, '.ssh')]), join(where.timonHome, 'skills')],
    readWrite: ['/dev', where.worktree, where.missionTmp],
    unixSockets,
  };
}

/** Runs inside the fence: tries each gesture and prints what happened. */
const PROBE_SCRIPT = String.raw`
const fs = require('node:fs'), net = require('node:net'), path = require('node:path'), cp = require('node:child_process');
const [TH, H, WT, SOCK] = process.argv.slice(2);
const out = { pid: process.pid };
const t = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = e.code || String(e.message); } };
t('readToken', () => fs.readFileSync(path.join(TH, 'daemon-token')));
t('readSecretKey', () => fs.readFileSync(path.join(TH, 'secret-key')));
t('readDb', () => fs.readFileSync(path.join(TH, 'timon.db')));
t('listTimonHome', () => fs.readdirSync(TH));
t('writeConfig', () => fs.appendFileSync(path.join(TH, 'timon.config.json'), 'x'));
t('dropPlugin', () => fs.writeFileSync(path.join(TH, 'plugins', 'evil.js'), 'x'));
t('deleteDb', () => fs.unlinkSync(path.join(TH, 'timon.db')));
t('renameToken', () => fs.renameSync(path.join(TH, 'daemon-token'), path.join(WT, 'stolen')));
t('linkToken', () => fs.linkSync(path.join(TH, 'daemon-token'), path.join(WT, 'stolen2')));
t('readParentRoot', () => fs.readFileSync('/proc/' + process.ppid + '/root' + path.join(TH, 'daemon-token')));
t('readOtherWorktree', () => fs.readFileSync(path.join(TH, 'worktrees', 'm2', 'notes')));
t('readSsh', () => fs.readFileSync(path.join(H, '.ssh', 'id_ed25519')));
t('grandchildToken', () => {
  const r = cp.spawnSync(process.execPath, ['-e', 'require("fs").readFileSync(process.argv[1])', path.join(TH, 'daemon-token')], { stdio: 'ignore' });
  if (r.status !== 0) throw Object.assign(new Error('refused'), { code: 'REFUSED' });
});
t('writeWorktree', () => { fs.writeFileSync(path.join(WT, 'file'), 'work'); fs.readFileSync(path.join(WT, 'file')); });
t('readSkill', () => fs.readFileSync(path.join(TH, 'skills', 's1', 'SKILL.md')));
t('writeSkill', () => fs.appendFileSync(path.join(TH, 'skills', 's1', 'SKILL.md'), 'x'));
t('missionTmp', () => { const f = path.join(process.env.TMPDIR, 'x'); fs.writeFileSync(f, 'x'); fs.unlinkSync(f); });
t('stdioPipes', () => {
  const r = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write("hi")'], { encoding: 'utf8' });
  if (r.stdout !== 'hi') throw new Error('no output');
});
const git = cp.spawnSync('git', ['--version'], { stdio: 'ignore' });
if (git.status === 0) t('gitCommit', () => {
  for (const args of [['init', '-q'], ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '--allow-empty', '-m', 'x']]) {
    const r = cp.spawnSync('git', ['-C', WT, ...args], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed');
  }
});
// Never outside the fence: unconfined, it would really start a user unit.
const systemdRun = process.env.FENCE_CONTROL ? { status: 1 } : cp.spawnSync('systemd-run', ['--version'], { stdio: 'ignore' });
if (systemdRun.status === 0) t('systemdRunEscape', () => {
  const r = cp.spawnSync('systemd-run', ['--user', '--quiet', '--collect', '--pipe', '--wait', 'cat', path.join(TH, 'daemon-token')], { encoding: 'utf8', timeout: 10000 });
  if (!String(r.stdout).includes('FAKE-TOKEN')) throw Object.assign(new Error('refused'), { code: 'REFUSED' });
});
const tcp = net.createServer((c) => c.end()).listen(0, '127.0.0.1', () => {
  const c = net.connect(tcp.address().port, '127.0.0.1');
  c.on('connect', () => { out.tcpLoopback = 'ok'; c.destroy(); tcp.close(); unix(); });
  c.on('error', (e) => { out.tcpLoopback = e.code; tcp.close(); unix(); });
});
function unix() {
  const c = net.connect(SOCK);
  c.on('connect', () => { out.unixSocket = 'ok'; c.destroy(); done(); });
  c.on('error', (e) => { out.unixSocket = e.code; done(); });
}
function done() { process.stdout.write(JSON.stringify(out)); }
`;

interface FencedRun { status: number | null; pid: number | undefined; stdout: string; stderr: string }

function runFenced(policyFile: string, args: string[], env: NodeJS.ProcessEnv): Promise<FencedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(FENCE as string, ['--policy', policyFile, '--', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status) => { clearTimeout(timer); resolve({ status, pid: child.pid, stdout, stderr }); });
  });
}

async function scenario(unixSockets: 'deny' | 'allow') {
  const where = layout();
  const script = join(where.root, 'probe.cjs');
  writeFileSync(script, PROBE_SCRIPT);
  const policyFile = join(where.root, 'policy');
  writeFileSync(policyFile, encodeFencePolicy(policyFor(where, unixSockets)));
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(where.socket, resolve));
  try {
    const env = { PATH: process.env.PATH ?? '', HOME: where.home, TMPDIR: where.missionTmp, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '' };
    const run = await runFenced(policyFile, [process.execPath, script, where.timonHome, where.home, where.worktree, where.socket], env);
    assert.equal(run.status, 0, run.stderr);
    return { run, report: JSON.parse(run.stdout) as Record<string, string | number> };
  } finally {
    server.close();
  }
}

test('fenced: Timon\'s private files and the other missions are out of reach', { skip }, async () => {
  const { report } = await scenario('deny');
  // The control: the same gestures, unfenced, do reach the files.
  const where = layout();
  const script = join(where.root, 'probe.cjs');
  writeFileSync(script, PROBE_SCRIPT);
  const control = spawnSync(process.execPath, [script, where.timonHome, where.home, where.worktree, where.socket], {
    encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '', HOME: where.home, TMPDIR: where.missionTmp, FENCE_CONTROL: '1' },
  });
  const unfenced = JSON.parse(control.stdout) as Record<string, string>;
  for (const gesture of ['readToken', 'readSecretKey', 'readDb', 'listTimonHome', 'readOtherWorktree', 'readSsh']) {
    assert.equal(unfenced[gesture], 'ok', `control: ${gesture} works unfenced`);
  }
  for (const gesture of ['readToken', 'readSecretKey', 'readDb', 'listTimonHome', 'writeConfig', 'dropPlugin', 'deleteDb',
    'renameToken', 'linkToken', 'readParentRoot', 'readOtherWorktree', 'readSsh', 'grandchildToken', 'writeSkill']) {
    assert.notEqual(report[gesture], 'ok', `${gesture} must be refused`);
  }
});

test('fenced: the mission works in its worktree, its tmp, with child processes and TCP', { skip }, async () => {
  const { report } = await scenario('deny');
  for (const gesture of ['writeWorktree', 'readSkill', 'missionTmp', 'stdioPipes', 'tcpLoopback']) {
    assert.equal(report[gesture], 'ok', `${gesture} must work: ${report[gesture]}`);
  }
  if ('gitCommit' in report) assert.equal(report.gitCommit, 'ok');
});

test('fenced: the launcher exec()s the command, which keeps the pid the daemon spawned', { skip }, async () => {
  const { run, report } = await scenario('deny');
  assert.equal(report.pid, run.pid);
});

test('fenced: Unix sockets are refused by default, so systemd --user cannot run code outside', { skip }, async () => {
  const { report } = await scenario('deny');
  assert.equal(report.unixSocket, 'EACCES');
  if ('systemdRunEscape' in report) assert.notEqual(report.systemdRunEscape, 'ok');
});

test('fenced: unix-sockets allow lets a mission reach a socket (the docker or ssh-agent exception)', { skip }, async () => {
  const { report } = await scenario('allow');
  assert.equal(report.unixSocket, 'ok');
  assert.notEqual(report.readToken, 'ok');
});

test('fenced: usage, policy and exec failures have their own exit codes', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fence-codes-'));
  const policy = (name: string, bytes: string | Buffer) => { const file = join(dir, name); writeFileSync(file, bytes); return file; };
  const good = policy('good', encodeFencePolicy({ readOnly: ['/usr', '/etc'], readWrite: [], unixSockets: 'deny' }));
  const code = (args: string[]) => spawnSync(FENCE as string, args, { stdio: 'ignore', timeout: 10_000 }).status;
  assert.equal(code([]), FENCE_EXIT.usage);
  assert.equal(code(['--policy', good, 'true']), FENCE_EXIT.usage);
  assert.equal(code(['--policy', join(dir, 'missing'), '--', 'true']), FENCE_EXIT.invalidPolicy);
  assert.equal(code(['--policy', policy('header', 'nope\0'), '--', 'true']), FENCE_EXIT.invalidPolicy);
  assert.equal(code(['--policy', policy('directive', `${FENCE_POLICY_HEADER}\0exec\0/usr\0`), '--', 'true']), FENCE_EXIT.invalidPolicy);
  assert.equal(code(['--policy', policy('truncated', `${FENCE_POLICY_HEADER}\0ro\0/usr`), '--', 'true']), FENCE_EXIT.invalidPolicy);
  assert.equal(code(['--policy', policy('relative', `${FENCE_POLICY_HEADER}\0ro\0usr\0`), '--', 'true']), FENCE_EXIT.invalidPolicy);
  assert.equal(code(['--policy', good, '--', join(dirname(good), 'no-such-command')]), FENCE_EXIT.execFailed);
});
