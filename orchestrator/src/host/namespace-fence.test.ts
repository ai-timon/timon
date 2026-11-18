/**
 * The Linux fence on a kernel without Landlock: the fence policy rendered as
 * namespace steps, checked against the reference semantics (`fenceAccess`) on
 * a described tree; the Linux host fence choosing that rendering when the
 * probe says so; and, where this machine lets an unprivileged process build
 * the namespaces, a real mission run by the launcher in that mode.
 */
import '../test-home.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TimonConfigSchema } from '../config/schema.js';
import { FENCE_EXIT, FENCE_POLICY_HEADER, findFenceBinary, type FenceStatus } from './fence.js';
import { fenceAccess, resolveFence, type FencePolicy } from './isolation.js';
import { createLandlockFence, LANDLOCK_FS } from './landlock.js';
import { encodeNamespacePolicy, NamespaceRenderError, renderNamespacePolicy, type NamespaceStep } from './namespace-fence.js';

const cfg = (isolation: Record<string, unknown> = {}) =>
  TimonConfigSchema.parse({ host: { docker: 'disabled', isolation } });

/** Linux fixtures, resolved with the host's path rules: meaningless on Windows. */
const LINUX_FIXTURES = process.platform === 'win32' && 'Linux fixtures, resolved with Windows path rules';

const HOME = '/home/u';
const TH = `${HOME}/.timon`;
const MISSION = 'bbbbbbbb-0000-4000-8000-000000000002';

/** Every path below exists; `${HOME}/to-ssh` is a link to `~/.ssh`. */
const PATHS = [
  '/', '/usr', '/usr/bin', '/etc', '/tmp', '/dev', '/dev/null', '/home', HOME, `${HOME}/.ssh`, `${HOME}/.ssh/id_ed25519`,
  `${HOME}/.codex`, `${HOME}/.claude`, `${HOME}/.gitconfig`, `${HOME}/.local`, `${HOME}/.local/bin`, `${HOME}/code`,
  `${HOME}/code/app`, `${HOME}/code/app/.git`, TH, `${TH}/daemon-token`, `${TH}/secret-key`, `${TH}/timon.db`,
  `${TH}/timon.config.json`, `${TH}/worktrees`, `${TH}/worktrees/task-1`, `${TH}/worktrees/task-2`, `${TH}/skills`,
  `${TH}/agents`, `${TH}/agents/timon.coder`, `${TH}/agents/timon.coder/SOUL.md`, `${TH}/agents/timon.coder/memory`,
  `${TH}/agents/other`, `${TH}/tmp`, `${TH}/tmp/missions`, `${TH}/tmp/missions/${MISSION}`, `${TH}/tmp/missions/other`,
  `${TH}/backend-accounts`, `${TH}/backend-accounts/accmine`, `${TH}/backend-accounts/accother`, `${TH}/plugins`,
];
const LINKS: Record<string, string> = { [`${HOME}/to-ssh`]: `${HOME}/.ssh` };

function realpath(path: string): string {
  let current = '/';
  for (const part of path.split('/').filter(Boolean)) {
    current = posix.join(current, part);
    const target = LINKS[current];
    if (target) current = realpath(target);
    else if (!PATHS.includes(current)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
  }
  return current;
}

function fakePolicy(isolation: Record<string, unknown> = {}): FencePolicy {
  return resolveFence(cfg(isolation), {
    timonHome: TH, home: HOME, platform: 'linux', backend: 'claude',
    cwd: `${TH}/worktrees/task-1`, gitDirs: [`${HOME}/code/app/.git`],
    missionId: MISSION, agent: 'timon.coder', account: 'accmine', realpath, timonHomeEntries: ['daemon-token', 'secret-key', 'timon.db'],
  });
}

type Level = 'none' | 'ro' | 'rw';

/** What a path shows once the launcher took every step: a read-only root, then each step on top. */
function namespaceLevel(steps: readonly NamespaceStep[], path: string): Level {
  let level: Level = 'ro';
  for (const step of steps) {
    if (path === step.path || path.startsWith(`${step.path}/`)) level = step.kind === 'hide' ? 'none' : step.kind;
  }
  return level;
}

function referenceLevel(policy: FencePolicy, path: string): Level {
  const { read, write } = fenceAccess(policy, path);
  return write ? 'rw' : read ? 'ro' : 'none';
}

test('the steps give every path of the tree exactly the level the fence policy gives it', { skip: LINUX_FIXTURES }, () => {
  for (const isolation of [{}, { writable: ['~/.local/share'], readOnly: ['~/code'] }, { deny: ['~/code/app'] }]) {
    const policy = fakePolicy(isolation);
    const { steps } = renderNamespacePolicy(policy, realpath);
    for (const path of PATHS) assert.equal(namespaceLevel(steps, path), referenceLevel(policy, path), `${path} under ${JSON.stringify(isolation)}`);
  }
});

test('the Timon home is hidden whole: the operator token and the vault key are out of reach', { skip: LINUX_FIXTURES }, () => {
  const { steps } = renderNamespacePolicy(fakePolicy(), realpath);
  assert.deepEqual(steps.find((step) => step.path === TH), { kind: 'hide', path: TH });
  for (const secret of ['daemon-token', 'secret-key', 'timon.db', 'timon.config.json']) {
    assert.equal(namespaceLevel(steps, `${TH}/${secret}`), 'none', secret);
  }
  // Nothing is said of what is already hidden: no step under the home but the mission's own folders.
  const underHome = steps.filter((step) => step.path.startsWith(`${TH}/`));
  assert.ok(underHome.every((step) => step.kind !== 'hide'), JSON.stringify(underHome));
  assert.ok(underHome.some((step) => step.kind === 'rw' && step.path === `${TH}/worktrees/task-1`));
  for (const other of [`${TH}/worktrees/task-2`, `${TH}/tmp/missions/other`, `${TH}/backend-accounts/accother`]) {
    assert.equal(namespaceLevel(steps, other), 'none', other);
  }
});

test('steps are listed shallow first, each changing what its parent left, in their resolved spelling', { skip: LINUX_FIXTURES }, () => {
  const policy = fakePolicy({ deny: ['~/to-ssh'] });
  const { steps } = renderNamespacePolicy(policy, realpath);
  const paths = steps.map((step) => step.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(new Set(paths).size, paths.length, 'one step per path');
  assert.ok(!paths.includes(`${HOME}/to-ssh`), 'a link is never a step: the mount would land where it points');
  assert.ok(steps.some((step) => step.kind === 'hide' && step.path === `${HOME}/.ssh`));
  assert.ok(!paths.includes('/'), 'the root is read-only already');
  assert.ok(!steps.some((step) => step.kind === 'ro' && namespaceLevel(steps.slice(0, steps.indexOf(step)), step.path) === 'ro'));
});

test('a policy the namespaces cannot render is refused, never approximated', () => {
  const base = fakePolicy();
  assert.throws(() => renderNamespacePolicy({ ...base, enabled: false }, realpath), NamespaceRenderError);
  // On the same path read-only wins, so a writable root needs the read-only one gone.
  assert.throws(() => renderNamespacePolicy({ ...base, ro: base.ro.filter((p) => p !== '/'), rw: [...base.rw, '/'] }, realpath), /root cannot be writable/);
  assert.throws(() => renderNamespacePolicy({ ...base, deny: [...base.deny, '/'] }, realpath), /root cannot be refused/);
  assert.throws(() => renderNamespacePolicy({ ...base, deny: [...base.deny, 'relative'] }, realpath), /not absolute/);
});

test('the policy file names the mechanism, then one pair per step', () => {
  const bytes = encodeNamespacePolicy({ steps: [{ kind: 'hide', path: '/h/.timon' }, { kind: 'rw', path: '/h/.timon/worktrees/t' }], unixSockets: 'deny' });
  assert.deepEqual(bytes.toString('utf8').split('\0'),
    [FENCE_POLICY_HEADER, 'mechanism', 'namespaces', 'unix-sockets', 'deny', 'hide', '/h/.timon', 'rw', '/h/.timon/worktrees/t', '']);
  assert.throws(() => encodeNamespacePolicy({ steps: [{ kind: 'ro', path: 'x' }], unixSockets: 'deny' }), /absolute/);
});

test('the Linux fence renders namespace steps when the probe chose that mechanism, Landlock rules otherwise', { skip: LINUX_FIXTURES }, () => {
  let status: FenceStatus = { state: 'ready', binary: '/opt/timon/native/timon-fence', abi: 0, seccomp: true, fallback: 'namespaces' };
  const written: Buffer[] = [];
  const fs = { realpath, list: () => [] };
  const fence = createLandlockFence({ status: () => status, fs, writePolicy: (_file, data) => { written.push(data); } });
  assert.deepEqual(fence.probe(), { available: true, abi: 0, fallback: 'namespaces' });
  const launch = fence.wrap(fakePolicy(), '/usr/bin/claude', ['-p'], `${TH}/run/fence/u.policy`);
  assert.deepEqual(launch, { cmd: '/opt/timon/native/timon-fence', args: ['--policy', `${TH}/run/fence/u.policy`, '--', '/usr/bin/claude', '-p'] });
  assert.deepEqual(written[0]?.toString('utf8').split('\0').slice(0, 3), [FENCE_POLICY_HEADER, 'mechanism', 'namespaces']);
  status = { state: 'ready', binary: '/opt/timon/native/timon-fence', abi: 6, seccomp: true };
  fence.probe();
  fence.wrap(fakePolicy(), '/usr/bin/claude', [], `${TH}/run/fence/u.policy`);
  assert.deepEqual(written[1]?.toString('utf8').split('\0').slice(0, 2), [FENCE_POLICY_HEADER, 'unix-sockets'], 'Landlock policy unchanged');
  status = { state: 'unsupported', reason: 'kernel without Landlock, and without unprivileged user namespaces', abi: 0, noMechanism: true };
  assert.deepEqual(fence.probe(), { available: false, reason: 'kernel without Landlock, and without unprivileged user namespaces', abi: 0, noMechanism: true });
  assert.throws(() => fence.wrap(fakePolicy(), 'x', [], `${TH}/run/fence/u.policy`), /probe the fence/);
});

// ---------------------------------------------------------------------------
// The real launcher, in its namespace mode.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function launcher(): string | null {
  if (process.platform !== 'linux') return null;
  const found = findFenceBinary();
  if (found) return found;
  const out = join(mkdtempSync(join(tmpdir(), 'ns-fence-bin-')), 'timon-fence');
  try {
    execFileSync(process.execPath, [join(REPO, 'native', 'timon-fence', 'build.mjs'), '--out', out, '--optional'], { stdio: 'ignore', timeout: 120_000 });
  } catch { return null; }
  return existsSync(out) ? out : null;
}

const FENCE = launcher();
/** Whatever Landlock says: this checks the namespace mode alone. */
const USERNS = FENCE ? spawnSync(FENCE, ['--probe-namespaces'], { encoding: 'utf8', timeout: 10_000 }) : null;
const skip = !FENCE ? 'no timon-fence for this machine (Linux with a C compiler only)'
  : USERNS?.status !== 0 ? `no unprivileged user namespaces here (${(USERNS?.stdout ?? '').trim() || 'no answer'})` : false;

const MISSION_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), net = require('node:net');
const [TH, H, WT, TMP, GIT, OUTER, SOCK] = process.argv.slice(1);
const out = { pid: process.pid };
const t = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = e.code || String(e.message); } };
t('readToken', () => fs.readFileSync(path.join(TH, 'daemon-token')));
t('readVaultKey', () => fs.readFileSync(path.join(TH, 'secret-key')));
t('readDb', () => fs.readFileSync(path.join(TH, 'timon.db')));
t('writeConfig', () => fs.appendFileSync(path.join(TH, 'timon.config.json'), 'x'));
t('readTokenThroughOuterProc', () => fs.readFileSync('/proc/' + OUTER + '/root' + path.join(TH, 'daemon-token')));
t('readTokenThroughInitProc', () => fs.readFileSync('/proc/1/root' + path.join(TH, 'daemon-token')));
t('unmountHome', () => cp.execFileSync('umount', ['-l', TH], { stdio: 'ignore' }));
t('readOtherWorktree', () => fs.readFileSync(path.join(TH, 'worktrees', 'm2', 'notes')));
t('readOwnSoul', () => fs.readFileSync(path.join(TH, 'agents', 'coder', 'SOUL.md')));
t('writeOwnMemory', () => fs.appendFileSync(path.join(TH, 'agents', 'coder', 'memory', 'learnings.jsonl'), '{}\n'));
t('writeSoul', () => fs.appendFileSync(path.join(TH, 'agents', 'coder', 'SOUL.md'), 'x'));
t('readSsh', () => fs.readFileSync(path.join(H, '.ssh', 'id_ed25519')));
t('readThroughLink', () => fs.readFileSync(path.join(H, 'to-ssh', 'id_ed25519')));
t('writeGitconfig', () => fs.appendFileSync(path.join(H, '.gitconfig'), 'x'));
t('plantBinary', () => fs.writeFileSync(path.join(H, '.local', 'bin', 'git'), 'x'));
t('readHomeFile', () => fs.readFileSync(path.join(H, '.gitconfig')));
t('writeWorktree', () => fs.writeFileSync(path.join(WT, 'out.txt'), 'x'));
t('writeRelative', () => fs.writeFileSync('relative.txt', 'x'));
t('writeTmp', () => fs.writeFileSync(path.join(TMP, 'scratch'), 'x'));
t('writeGitDir', () => fs.writeFileSync(path.join(GIT, 'objects', 'probe'), 'x'));
t('runSystemBinary', () => cp.execFileSync('/bin/sh', ['-c', 'true']));
t('grandchildToken', () => {
  const r = cp.spawnSync(process.execPath, ['-e', 'require("fs").readFileSync(process.argv[1])', path.join(TH, 'daemon-token')], { stdio: 'ignore' });
  if (r.status !== 0) throw Object.assign(new Error('refused'), { code: 'REFUSED' });
});
out.timonHomeEntries = (() => { try { return fs.readdirSync(TH).sort().join(','); } catch (e) { return e.code; } })();
out.cwd = process.cwd();
const c = net.connect(SOCK);
c.on('connect', () => { out.unixSocket = 'ok'; c.destroy(); done(); });
c.on('error', (e) => { out.unixSocket = e.code; done(); });
function done() { process.stdout.write(JSON.stringify(out)); }
`;

interface Scenario { root: string; home: string; th: string; worktree: string; missionTmp: string; gitDir: string; socket: string }

function scenario(): Scenario {
  // Not under /tmp when avoidable, as for the Landlock scenario.
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? runtime : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'ns-fence-scenario-')));
  after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const th = join(home, '.timon');
  const worktree = join(th, 'worktrees', 'm1');
  const missionTmp = join(th, 'tmp', 'missions', MISSION);
  const gitDir = join(home, 'code', 'app', '.git');
  for (const dir of [worktree, missionTmp, join(th, 'worktrees', 'm2'), join(th, 'agents', 'coder', 'memory'), join(home, '.ssh'), join(home, '.local', 'bin'), join(gitDir, 'objects')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(th, 'daemon-token'), 'FAKE-TOKEN');
  writeFileSync(join(th, 'secret-key'), 'FAKE-VAULT-KEY');
  writeFileSync(join(th, 'timon.db'), 'FAKE-DB');
  writeFileSync(join(th, 'timon.config.json'), '{}');
  writeFileSync(join(th, 'worktrees', 'm2', 'notes'), 'other mission');
  writeFileSync(join(th, 'agents', 'coder', 'SOUL.md'), '# soul');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'FAKE-SSH-KEY');
  writeFileSync(join(home, '.gitconfig'), '[user]\n');
  symlinkSync(join(home, '.ssh'), join(home, 'to-ssh'));
  return { root, home, th, worktree, missionTmp, gitDir, socket: join(root, 'unix.sock') };
}

function namespaceFence(where: Scenario, unixSockets: 'deny' | 'allow' = 'deny') {
  const policy = resolveFence(cfg({ readOnly: [where.home], unixSockets }), {
    timonHome: where.th, home: where.home, platform: 'linux', cwd: where.worktree, gitDirs: [where.gitDir], missionId: MISSION, agent: 'coder',
  });
  const fence = createLandlockFence({
    status: () => ({ state: 'ready', binary: FENCE as string, abi: 0, seccomp: true, fallback: 'namespaces' }), fs: LANDLOCK_FS,
  });
  assert.equal(fence.probe().available, true);
  return { policy, fence, policyFile: join(where.root, 'run', 'scenario.policy') };
}

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function run(cmd: string, args: string[], cwd: string, onSpawn?: (child: ReturnType<typeof spawn>) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    onSpawn?.(child);
  });
}

async function mission(unixSockets: 'deny' | 'allow') {
  const where = scenario();
  const { policy, fence, policyFile } = namespaceFence(where, unixSockets);
  const { createServer } = await import('node:net');
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(where.socket, resolve));
  try {
    const launch = fence.wrap(policy, process.execPath,
      ['-e', MISSION_SCRIPT, where.th, where.home, where.worktree, where.missionTmp, where.gitDir, String(process.pid), where.socket], policyFile);
    const result = await run(launch.cmd, launch.args, where.worktree);
    assert.equal(result.code, 0, result.stderr);
    return { where, out: JSON.parse(result.stdout) as Record<string, string | number> };
  } finally {
    server.close();
  }
}

test('namespaces: the operator token, the vault key and the other missions are out of reach', { skip }, async () => {
  const { out } = await mission('deny');
  for (const refused of ['readToken', 'readVaultKey', 'readDb', 'writeConfig', 'readTokenThroughOuterProc', 'readTokenThroughInitProc',
    'unmountHome', 'readOtherWorktree', 'writeSoul', 'readSsh', 'readThroughLink', 'writeGitconfig', 'plantBinary', 'grandchildToken']) {
    assert.notEqual(out[refused], 'ok', refused);
  }
  // The home shows only the mount points of the mission's own folders.
  for (const entry of String(out.timonHomeEntries).split(',')) assert.ok(['agents', 'tmp', 'worktrees', 'skills'].includes(entry), `listed: ${entry}`);
});

test('namespaces: the mission works in its own folders, from its working directory', { skip }, async () => {
  const { where, out } = await mission('deny');
  for (const allowed of ['readOwnSoul', 'writeOwnMemory', 'readHomeFile', 'writeWorktree', 'writeRelative', 'writeTmp', 'writeGitDir', 'runSystemBinary']) {
    assert.equal(out[allowed], 'ok', `${allowed}: ${out[allowed]}`);
  }
  assert.equal(out.cwd, where.worktree);
  assert.ok(existsSync(join(where.worktree, 'relative.txt')), 'a relative write lands in the real worktree');
  assert.ok(readdirSync(where.th).includes('daemon-token'), 'nothing outside the namespace changed');
});

test('namespaces: Unix sockets are refused by default and reachable with the allow exception', { skip }, async () => {
  assert.equal((await mission('deny')).out.unixSocket, 'EACCES');
  const allowed = await mission('allow');
  assert.equal(allowed.out.unixSocket, 'ok');
  assert.notEqual(allowed.out.readToken, 'ok');
});

test('namespaces: the command\'s exit status and a forwarded SIGTERM reach the daemon as the command\'s own', { skip }, async () => {
  const where = scenario();
  const { policy, fence, policyFile } = namespaceFence(where);
  const exited = fence.wrap(policy, '/bin/sh', ['-c', 'exit 7'], policyFile);
  assert.equal((await run(exited.cmd, exited.args, where.worktree)).code, 7);
  const missing = fence.wrap(policy, join(where.root, 'no-such-command'), [], policyFile);
  assert.equal((await run(missing.cmd, missing.args, where.worktree)).code, FENCE_EXIT.execFailed);
  // A CLI without a SIGTERM handler ends on SIGTERM: it is not pid 1 of its namespace.
  const waiting = fence.wrap(policy, process.execPath, ['-e', 'process.stdout.write("up"); setInterval(() => {}, 1000)'], policyFile);
  const ended = await run(waiting.cmd, waiting.args, where.worktree, (child) => {
    child.stdout?.once('data', () => child.kill('SIGTERM'));
  });
  assert.equal(ended.signal, 'SIGTERM');
});

test('namespaces: a launcher killed outright takes every process of the mission with it', { skip }, async () => {
  const where = scenario();
  const { policy, fence, policyFile } = namespaceFence(where);
  // Durations no other process is likely to sleep: they are how the test finds them.
  const first = 40_000 + (process.pid % 9_973);
  const names = [`sleep ${first}`, `sleep ${first + 1}`];
  const launch = fence.wrap(policy, '/bin/sh', ['-c', `${names[0]} & ${names[1]} & echo up; wait`], policyFile);
  const alive = () => spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout.split('\n').filter((line) => names.includes(line.trim())).length;
  let before = -1;
  await run(launch.cmd, launch.args, where.worktree, (child) => {
    child.stdout?.once('data', () => {
      setTimeout(() => { before = alive(); child.kill('SIGKILL'); }, 200);
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(before, 2, 'both processes ran');
  assert.equal(alive(), 0);
});
