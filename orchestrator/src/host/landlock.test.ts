/**
 * The Linux fence: the fence policy rendered as Landlock rules, checked
 * against the reference semantics (`fenceAccess`) on a described tree; the
 * host contract around the launcher; and, on a kernel with Landlock ABI 2 or
 * later, a real mission run under the rendered rules.
 */
import '../test-home.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TimonConfigSchema } from '../config/schema.js';
import { FENCE_EXIT, FENCE_POLICY_HEADER, findFenceBinary, probeFence, type FencePolicy as LauncherPolicy, type FenceStatus } from './fence.js';
import { fenceAccess, resolveFence, type FencePolicy } from './isolation.js';
import {
  createLandlockFence, LANDLOCK_FS, LandlockRenderError, landlockProbe, renderLandlockPolicy,
  type DirEntryKind, type LandlockRenderDeps,
} from './landlock.js';

const cfg = (isolation: Record<string, unknown> = {}) =>
  TimonConfigSchema.parse({ host: { docker: 'disabled', isolation } });

/**
 * A described tree: each folder lists its entries; `links` maps a link to its
 * target. Paths are Linux paths whatever the test host.
 */
function tree(dirs: Record<string, string[]>, links: Record<string, string> = {}): LandlockRenderDeps & { paths: string[] } {
  const kinds = new Map<string, DirEntryKind>();
  for (const [dir, names] of Object.entries(dirs)) {
    kinds.set(dir, 'dir');
    for (const name of names) {
      const child = posix.join(dir, name);
      if (!kinds.has(child)) kinds.set(child, Object.hasOwn(dirs, child) ? 'dir' : 'other');
    }
  }
  for (const link of Object.keys(links)) kinds.set(link, 'link');
  const realpath = (path: string): string => {
    const parts = path.split('/').filter(Boolean);
    let current = '/';
    for (const part of parts) {
      current = posix.join(current, part);
      const target = links[current];
      if (target) current = realpath(target);
      else if (!kinds.has(current)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    }
    return current;
  };
  return {
    realpath,
    list: (dir) => {
      const names = dirs[dir];
      return names ? names.map((name) => ({ name, kind: kinds.get(posix.join(dir, name)) ?? 'other' })) : null;
    },
    paths: [...kinds.keys()].filter((path) => kinds.get(path) !== 'link'),
  };
}

/** What Landlock grants with these rules: the union of every rule above a path. */
function landlockLevel(rules: LauncherPolicy, path: string): 'rw' | 'ro' | 'none' {
  const covers = (root: string) => root === path || path.startsWith(root === '/' ? '/' : `${root}/`);
  if (rules.readWrite.some(covers)) return 'rw';
  if (rules.readOnly.some(covers)) return 'ro';
  return 'none';
}

function referenceLevel(policy: FencePolicy, path: string): 'rw' | 'ro' | 'none' {
  const { read, write } = fenceAccess(policy, path);
  return write ? 'rw' : read ? 'ro' : 'none';
}

const RANK = { none: 0, ro: 1, rw: 2 } as const;

/**
 * Every path gets the level the policy gives it, with the one difference
 * Landlock imposes: a folder holding a lower level is not granted itself (its
 * entries are), so it can be crossed but neither listed nor added to.
 */
function assertFaithful(policy: FencePolicy, rules: LauncherPolicy, paths: readonly string[]): void {
  const listed = [...policy.deny, ...policy.denyUnderTimonHome, ...policy.ro, ...policy.rw];
  for (const path of paths) {
    const expected = referenceLevel(policy, path);
    const actual = landlockLevel(rules, path);
    if (actual === expected) continue;
    const holdsLower = listed.some((other) => other.startsWith(`${path === '/' ? '' : path}/`)
      && RANK[referenceLevel(policy, other)] < RANK[expected]);
    assert.ok(holdsLower && actual === 'none', `${path}: ${actual} instead of ${expected}`);
  }
}

/**
 * The fence policy comes from `resolveFence`, which resolves with the host's
 * path rules: on Windows `/home/u` becomes `D:\home\u`, which the Linux
 * renderer rightly refuses. Landlock never runs there.
 */
const LINUX_FIXTURES = process.platform === 'win32' && 'Linux fixtures, resolved with Windows path rules';

const HOME = '/home/u';
const TH = `${HOME}/.timon`;
const MISSION = 'aaaaaaaa-0000-4000-8000-000000000001';

const FAKE = tree({
  '/': ['usr', 'etc', 'tmp', 'dev', 'home', 'proc'],
  '/usr': ['bin', 'lib'],
  '/home': ['u', 'other'],
  [HOME]: ['.timon', '.ssh', '.codex', '.claude', '.claude.json', '.gitconfig', '.local', 'code', 'notes.txt', 'to-ssh'],
  [`${HOME}/.local`]: ['bin', 'share'],
  [`${HOME}/.local/share`]: ['opencode', 'fonts'],
  [`${HOME}/code`]: ['app'],
  [`${HOME}/code/app`]: ['.git', 'src'],
  [`${HOME}/.ssh`]: ['id_ed25519'],
  [TH]: ['daemon-token', 'timon.db', 'timon.config.json', 'worktrees', 'skills', 'agents', 'tmp', 'backend-accounts', 'plugins'],
  [`${TH}/worktrees`]: ['task-1', 'task-2'],
  [`${TH}/worktrees/task-1`]: ['.git', 'README.md'],
  [`${TH}/agents`]: ['timon.coder', 'other'],
  [`${TH}/agents/timon.coder`]: ['SOUL.md', 'memory', 'config.json'],
  [`${TH}/agents/timon.coder/memory`]: ['learnings.jsonl'],
  [`${TH}/tmp`]: ['missions', 'fence'],
  [`${TH}/tmp/missions`]: [MISSION, 'other-mission'],
  [`${TH}/backend-accounts`]: ['accmine', 'accother'],
  '/tmp': ['x'],
  '/dev': ['null'],
}, { [`${HOME}/to-ssh`]: `${HOME}/.ssh` });

function fakePolicy(isolation: Record<string, unknown> = {}): FencePolicy {
  return resolveFence(cfg(isolation), {
    timonHome: TH, home: HOME, platform: 'linux', backend: 'claude',
    cwd: `${TH}/worktrees/task-1`, gitDirs: [`${HOME}/code/app/.git`],
    missionId: MISSION, agent: 'timon.coder', account: 'accmine', realpath: FAKE.realpath,
  });
}

test('the rendered rules grant exactly what the fence policy says, on every path of the tree', { skip: LINUX_FIXTURES }, () => {
  const policy = fakePolicy();
  const rules = renderLandlockPolicy(policy, FAKE);
  assertFaithful(policy, rules, FAKE.paths);
  assert.equal(landlockLevel(rules, `${TH}/worktrees/task-1/README.md`), 'rw');
  assert.equal(landlockLevel(rules, `${HOME}/code/app/.git`), 'rw');
  assert.equal(landlockLevel(rules, `${HOME}/code/app/src`), 'ro');
  assert.equal(landlockLevel(rules, `${TH}/agents/timon.coder/SOUL.md`), 'ro');
  assert.equal(landlockLevel(rules, `${TH}/agents/timon.coder/memory/learnings.jsonl`), 'rw');
  assert.equal(landlockLevel(rules, `${HOME}/.gitconfig`), 'ro');
  assert.equal(rules.unixSockets, 'deny');
});

test('a mission\'s profile folder is granted alone, the other profiles stay out, the shared cache stays in', { skip: LINUX_FIXTURES }, () => {
  const cache = `${TH}/provider-cache/provider-claude`;
  const fs = tree({
    '/': ['usr', 'tmp', 'home'],
    '/home': ['u'],
    [HOME]: ['.timon', '.claude'],
    [`${HOME}/.claude`]: ['.credentials.json'],
    [TH]: ['daemon-token', 'provider-cache', 'tmp'],
    [`${TH}/provider-cache`]: ['provider-claude', 'provider-codex'],
    [`${TH}/provider-cache/provider-codex`]: ['cache'],
    [cache]: ['cache', 'profiles'],
    [`${cache}/cache`]: ['models.json'],
    [`${cache}/profiles`]: ['kimi', 'user-claude'],
    [`${cache}/profiles/kimi`]: ['settings.json'],
    [`${cache}/profiles/user-claude`]: ['settings.json'],
    [`${TH}/tmp`]: ['missions'],
    [`${TH}/tmp/missions`]: [MISSION],
  });
  const policy = resolveFence(cfg(), {
    timonHome: TH, home: HOME, platform: 'linux', backend: 'kimi', missionId: MISSION,
    providerPlugin: 'provider-claude', providerProfile: 'kimi', realpath: fs.realpath,
  });
  const rules = renderLandlockPolicy(policy, fs);
  assertFaithful(policy, rules, fs.paths);
  assert.equal(landlockLevel(rules, `${cache}/profiles/kimi/settings.json`), 'rw');
  assert.equal(landlockLevel(rules, `${cache}/cache/models.json`), 'rw');
  assert.equal(landlockLevel(rules, `${cache}/profiles/user-claude/settings.json`), 'none');
  // A profile folder made after the launch is under no rule: the kernel refuses it.
  assert.equal(landlockLevel(rules, `${cache}/profiles/made-later/settings.json`), 'none');
  assert.equal(landlockLevel(rules, `${TH}/provider-cache/provider-codex/cache`), 'none');
  assert.equal(landlockLevel(rules, `${TH}/daemon-token`), 'none');
});

test('a folder holding a refused path is listed instead of granted, along the way to it only', { skip: LINUX_FIXTURES }, () => {
  const rules = renderLandlockPolicy(fakePolicy(), FAKE);
  for (const level of ['/', '/home', HOME, TH]) {
    assert.ok(!rules.readOnly.includes(level) && !rules.readWrite.includes(level), `${level} is never granted whole`);
  }
  assert.ok(rules.readOnly.includes('/usr'), 'a folder with nothing refused inside is one rule');
  assert.ok(!rules.readOnly.includes('/usr/bin'), 'and is not listed');
  assert.ok(rules.readOnly.includes('/home/other'));
  assert.ok(rules.readOnly.includes(`${HOME}/notes.txt`), 'a file is granted on its own');
});

test('the private files and the other missions stay out of every rule', { skip: LINUX_FIXTURES }, () => {
  const rules = renderLandlockPolicy(fakePolicy(), FAKE);
  const all = [...rules.readOnly, ...rules.readWrite];
  for (const secret of ['daemon-token', 'timon.db', 'timon.config.json', 'worktrees/task-2', 'tmp/fence', 'tmp/missions/other-mission', 'backend-accounts/accother', 'agents/other']) {
    assert.ok(!all.some((path) => path === `${TH}/${secret}` || path.startsWith(`${TH}/${secret}/`)), secret);
  }
  assert.ok(!all.some((path) => path.startsWith(`${HOME}/.ssh`)));
  assert.ok(!all.includes(`${HOME}/.codex`), 'another backend\'s state is refused');
});

test('a link met while listing is never granted: it would reopen what it points to', { skip: LINUX_FIXTURES }, () => {
  const rules = renderLandlockPolicy(fakePolicy(), FAKE);
  assert.ok(![...rules.readOnly, ...rules.readWrite].includes(`${HOME}/to-ssh`));
});

test('a path is rendered in its resolved spelling, the only one the kernel matches', { skip: LINUX_FIXTURES }, () => {
  const linked = tree({
    '/': ['data', 'home'],
    '/data': ['ssh', 'work'],
    '/data/ssh': ['key'],
    '/home': ['u'],
    [HOME]: ['.ssh', 'code'],
  }, { [`${HOME}/.ssh`]: '/data/ssh' });
  const rules = renderLandlockPolicy(resolveFence(cfg(), { timonHome: TH, home: HOME, platform: 'linux', realpath: linked.realpath }), linked);
  assert.equal(landlockLevel(rules, '/data/ssh/key'), 'none', 'the refusal follows the link to its target');
  assert.equal(landlockLevel(rules, '/data/work'), 'ro');
});

test('the write list and the read-only list of the configuration are rendered too', { skip: LINUX_FIXTURES }, () => {
  const policy = fakePolicy({ writable: ['~/.local/share'], readOnly: ['~/.local/share/fonts'] });
  const rules = renderLandlockPolicy(policy, FAKE);
  assert.equal(landlockLevel(rules, `${HOME}/.local/share/fonts`), 'ro');
  assert.equal(landlockLevel(rules, `${HOME}/.local/share/opencode`), 'none', 'another backend\'s state inside it stays refused');
  assert.equal(landlockLevel(rules, `${HOME}/.local/bin`), 'ro');
  assertFaithful(policy, rules, FAKE.paths);
});

test('the release the daemon runs from becomes one read-only rule, the other releases none', { skip: LINUX_FIXTURES }, () => {
  const releases = `${TH}/desktop-runtime/releases`;
  const withRuntime = tree({
    '/': ['usr', 'tmp', 'dev', 'home'],
    '/home': ['u'],
    [HOME]: ['.timon'],
    [TH]: ['daemon-token', 'worktrees', 'desktop-runtime'],
    [`${TH}/worktrees`]: ['task-1'],
    [`${TH}/desktop-runtime`]: ['releases', 'active-release'],
    [releases]: ['9.9.9', '9.9.8'],
    [`${releases}/9.9.9`]: ['resources'],
    [`${releases}/9.9.9/resources`]: ['node', 'orchestrator'],
    [`${releases}/9.9.9/resources/node`]: ['node'],
    [`${releases}/9.9.8`]: ['resources'],
  });
  const policy = resolveFence(cfg(), {
    timonHome: TH, home: HOME, platform: 'linux', cwd: `${TH}/worktrees/task-1`, missionId: MISSION,
    realpath: withRuntime.realpath, runtime: [`${releases}/9.9.9/resources/node/node`, `${releases}/9.9.9/resources/orchestrator`],
  });
  const rules = renderLandlockPolicy(policy, withRuntime);
  assertFaithful(policy, rules, withRuntime.paths);
  // Read-only under Landlock carries execute.
  assert.ok(rules.readOnly.includes(`${releases}/9.9.9`));
  assert.ok(![...rules.readWrite].some((path) => path.startsWith(`${TH}/desktop-runtime`)));
  for (const path of [`${releases}/9.9.8/resources`, releases, `${TH}/desktop-runtime/active-release`, `${TH}/daemon-token`]) {
    assert.equal(landlockLevel(rules, path), 'none', path);
  }
});

test('a policy needing more rules than the ceiling is refused, not truncated', () => {
  assert.throws(() => renderLandlockPolicy(fakePolicy(), { ...FAKE, maxRules: 5 }), LandlockRenderError);
  assert.throws(() => renderLandlockPolicy(resolveFence(cfg({ filesystem: 'off' }), { timonHome: TH }), FAKE), /off/);
});

// ---------------------------------------------------------------------------
// The host contract.

const READY: FenceStatus = { state: 'ready', binary: '/opt/timon/native/timon-fence', abi: 6, seccomp: true };

test('the probe reports the launcher status, an alteration apart from a machine without Landlock', () => {
  assert.deepEqual(landlockProbe(READY), { available: true, abi: 6 });
  assert.deepEqual(landlockProbe({ state: 'unsupported', reason: 'kernel without Landlock', abi: 0 }),
    { available: false, reason: 'kernel without Landlock', abi: 0 });
  assert.equal(landlockProbe({ state: 'tampered', reason: 'missing', abi: 0 }).tampered, true);
});

test('the probe is asked again at every launch: an altered launcher shows at once', () => {
  let calls = 0;
  const fence = createLandlockFence({ status: () => { calls += 1; return READY; }, fs: FAKE, writePolicy: () => {} });
  fence.probe();
  fence.probe();
  assert.equal(calls, 2);
  assert.equal(fence.mechanism, 'landlock');
});

test('wrap writes the encoded policy, then launches the command through the checked launcher', { skip: LINUX_FIXTURES }, () => {
  const written: Array<[string, Buffer]> = [];
  const fence = createLandlockFence({ status: () => READY, fs: FAKE, writePolicy: (file, data) => { written.push([file, data]); } });
  assert.throws(() => fence.wrap(fakePolicy(), '/usr/bin/claude', [], `${TH}/run/fence/u.policy`), /probe the fence/);
  fence.probe();
  const launch = fence.wrap(fakePolicy(), '/usr/bin/claude', ['-p', 'hi'], `${TH}/run/fence/u.policy`);
  assert.deepEqual(launch, { cmd: READY.binary, args: ['--policy', `${TH}/run/fence/u.policy`, '--', '/usr/bin/claude', '-p', 'hi'] });
  assert.equal(written[0]?.[0], `${TH}/run/fence/u.policy`);
  assert.equal(written[0]?.[1].toString('utf8').split('\0')[0], FENCE_POLICY_HEADER);
  assert.throws(() => fence.wrap(fakePolicy(), 'x', [], 'relative.policy'), /absolute/);
});

test('a launcher that stopped being usable is not used by a later wrap', () => {
  let status: FenceStatus = READY;
  const fence = createLandlockFence({ status: () => status, fs: FAKE, writePolicy: () => {} });
  fence.probe();
  status = { state: 'tampered', reason: 'missing', abi: 0 };
  assert.equal(fence.probe().available, false);
  assert.throws(() => fence.wrap(fakePolicy(), 'x', [], `${TH}/run/fence/u.policy`), /probe the fence/);
});

test('the witness runs the checked launcher on the launch\'s policy, with a payload that prints nothing', async () => {
  const runs: Array<[string, readonly string[]]> = [];
  let status: FenceStatus = READY;
  const fence = createLandlockFence({
    status: () => status, fs: FAKE, writePolicy: () => {},
    runWitness: async (file, args) => { runs.push([file, args]); return { ran: true, status: 0, stderr: '' }; },
  });
  assert.deepEqual(await fence.witness(`${TH}/run/fence/u.policy`), { ran: false, reason: 'no checked fence launcher', timedOut: false });
  fence.probe();
  assert.deepEqual(await fence.witness(`${TH}/run/fence/u.policy`), { ran: true, status: 0, stderr: '' });
  assert.deepEqual(runs, [[READY.binary, ['--policy', `${TH}/run/fence/u.policy`, '--', '/bin/true']]]);
  status = { state: 'tampered', reason: 'missing', abi: 0 };
  fence.probe();
  assert.equal((await fence.witness(`${TH}/run/fence/u.policy`)).ran, false, 'never a launcher the last probe refused');
});

// ---------------------------------------------------------------------------
// The real fence, rendered from the daemon's own policy.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function launcher(): string | null {
  if (process.platform !== 'linux') return null;
  const found = findFenceBinary();
  if (found) return found;
  const out = join(mkdtempSync(join(tmpdir(), 'landlock-bin-')), 'timon-fence');
  try {
    execFileSync(process.execPath, [join(REPO, 'native', 'timon-fence', 'build.mjs'), '--out', out, '--optional'], { stdio: 'ignore', timeout: 120_000 });
  } catch { return null; }
  return existsSync(out) ? out : null;
}

const FENCE = launcher();
const PROBE = FENCE ? probeFence(FENCE) : null;
const skip = !FENCE ? 'no timon-fence for this machine (Linux with a C compiler only)'
  : !PROBE?.available ? `no fence on this kernel: ${PROBE?.reason}` : false;

const MISSION_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const [TH, H, WT, TMP, GIT] = process.argv.slice(1);
const out = { pid: process.pid };
const t = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = e.code || String(e.message); } };
t('readToken', () => fs.readFileSync(path.join(TH, 'daemon-token')));
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
t('writeTmp', () => fs.writeFileSync(path.join(TMP, 'scratch'), 'x'));
t('writeGitDir', () => fs.writeFileSync(path.join(GIT, 'objects', 'probe'), 'x'));
t('runSystemBinary', () => cp.execFileSync('/bin/sh', ['-c', 'true']));
process.stdout.write(JSON.stringify(out));
`;

test('a mission under the rendered policy reaches its own folders and nothing private', { skip }, async () => {
  // Not under /tmp when avoidable: every mission writes it, so a home inside it
  // makes the rendering list all of /tmp (tens of thousands of entries here).
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? runtime : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'landlock-scenario-')));
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
  writeFileSync(join(th, 'worktrees', 'm2', 'notes'), 'other mission');
  writeFileSync(join(th, 'agents', 'coder', 'SOUL.md'), '# soul');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'FAKE-SSH-KEY');
  writeFileSync(join(home, '.gitconfig'), '[user]\n');
  symlinkSync(join(home, '.ssh'), join(home, 'to-ssh'));

  // Should the scenario land under /tmp, which every mission writes, `readOnly`
  // keeps its home read-only like a real one.
  const policy = resolveFence(cfg({ readOnly: [home] }), {
    timonHome: th, home, platform: 'linux', cwd: worktree, gitDirs: [gitDir], missionId: MISSION, agent: 'coder',
  });
  const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: FENCE as string, abi: PROBE?.abi ?? 0, seccomp: true }), fs: LANDLOCK_FS });
  assert.equal(fence.probe().available, true);
  const policyFile = join(th, 'run', 'fence', 'scenario.policy');
  const launch = fence.wrap(policy, process.execPath, ['-e', MISSION_SCRIPT, th, home, worktree, missionTmp, gitDir], policyFile);
  assert.ok(readFileSync(policyFile).length > 0);

  const child = spawn(launch.cmd, launch.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout) as Record<string, string | number>;

  assert.equal(out.pid, child.pid, 'the pid the daemon spawned is the mission\'s');
  for (const refused of ['readToken', 'readOtherWorktree', 'writeSoul', 'readSsh', 'readThroughLink', 'writeGitconfig', 'plantBinary']) {
    assert.equal(out[refused], 'EACCES', refused);
  }
  for (const allowed of ['readOwnSoul', 'writeOwnMemory', 'readHomeFile', 'writeWorktree', 'writeTmp', 'writeGitDir', 'runSystemBinary']) {
    assert.equal(out[allowed], 'ok', allowed);
  }
});

const RELEASE_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path');
const [RELEASE, OTHER] = process.argv.slice(2);
const out = { node: process.execPath };
const t = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = e.code || String(e.message); } };
t('writeRelease', () => fs.writeFileSync(path.join(RELEASE, 'resources', 'orchestrator', 'bin', 'planted.mjs'), 'x'));
t('readOtherRelease', () => fs.readFileSync(path.join(OTHER, 'resources', 'orchestrator', 'bin', 'timon-mcp.mjs')));
process.stdout.write(JSON.stringify(out));
`;

test('a Node copied into the running release starts a script of that release inside the fence', { skip }, async () => {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? runtime : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'landlock-release-')));
  after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const th = join(home, '.timon');
  const worktree = join(th, 'worktrees', 'm1');
  const release = join(th, 'desktop-runtime', 'releases', '9.9.9');
  const other = join(th, 'desktop-runtime', 'releases', '9.9.8');
  const node = join(release, 'resources', 'node', 'node');
  const script = join(release, 'resources', 'orchestrator', 'bin', 'probe.cjs');
  for (const dir of [worktree, dirname(node), dirname(script), join(other, 'resources', 'orchestrator', 'bin')]) mkdirSync(dir, { recursive: true });
  // A hard link costs nothing when the test folder shares the disk of the Node running the tests.
  const source = realpathSync(process.execPath);
  try { linkSync(source, node); } catch { copyFileSync(source, node); }
  chmodSync(node, 0o755);
  writeFileSync(script, RELEASE_SCRIPT);
  writeFileSync(join(other, 'resources', 'orchestrator', 'bin', 'timon-mcp.mjs'), '// other release');

  const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: FENCE as string, abi: PROBE?.abi ?? 0, seccomp: true }), fs: LANDLOCK_FS });
  assert.equal(fence.probe().available, true);
  const run = async (runtimePaths: string[] | undefined) => {
    const policy = resolveFence(cfg({ readOnly: [home] }), {
      timonHome: th, home, platform: 'linux', cwd: worktree, missionId: MISSION, runtime: runtimePaths,
    });
    const launch = fence.wrap(policy, node, [script, release, other], join(th, 'run', 'fence', 'release.policy'));
    const child = spawn(launch.cmd, launch.args, { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    return { code, stdout, stderr };
  };

  // Without the grant, the launcher cannot even exec the release's Node: the 0.1.8 failure.
  const refused = await run(undefined);
  assert.equal(refused.code, FENCE_EXIT.execFailed);
  assert.match(refused.stderr, /cannot execute .*Permission denied/);
  assert.equal(refused.stdout, '');

  const granted = await run([node, join(release, 'resources', 'orchestrator')]);
  assert.equal(granted.code, 0, granted.stderr);
  assert.deepEqual(JSON.parse(granted.stdout), { node, writeRelease: 'EACCES', readOtherRelease: 'EACCES' });
});

const WORKSPACE_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path');
const [WS, TH] = process.argv.slice(1);
const out = {};
const t = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = e.code || String(e.message); } };
t('readCwd', () => fs.readdirSync(process.cwd()));
t('readFile', () => fs.readFileSync(path.join(WS, 'notes.md')));
t('writeFile', () => fs.writeFileSync(path.join(WS, 'out.txt'), 'x'));
t('readToken', () => fs.readFileSync(path.join(TH, 'daemon-token')));
t('readOtherWorktree', () => fs.readFileSync(path.join(TH, 'worktrees', 'm2', 'notes')));
process.stdout.write(JSON.stringify(out));
`;

test('an agent whose folder is the workspace folder itself reads and writes it under the fence, and nothing private', { skip }, async () => {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? runtime : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'landlock-workspace-')));
  after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const th = join(home, '.timon');
  const workspace = join(th, 'workspace');
  for (const dir of [workspace, join(th, 'worktrees', 'm2')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspace, 'notes.md'), '# notes');
  writeFileSync(join(th, 'daemon-token'), 'FAKE-TOKEN');
  writeFileSync(join(th, 'worktrees', 'm2', 'notes'), 'other mission');

  const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: FENCE as string, abi: PROBE?.abi ?? 0, seccomp: true }), fs: LANDLOCK_FS });
  assert.equal(fence.probe().available, true);
  const run = async (agentCwd: string | undefined) => {
    const policy = resolveFence(cfg({ readOnly: [home] }), {
      timonHome: th, home, platform: 'linux', cwd: workspace, agentCwd, missionId: MISSION, agent: 'woody',
    });
    const launch = fence.wrap(policy, process.execPath, ['-e', WORKSPACE_SCRIPT, workspace, th], join(th, 'run', 'fence', 'workspace.policy'));
    const child = spawn(launch.cmd, launch.args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    return { code, stdout, stderr };
  };

  // Without the agent's own folder named, the 0.1.8 failure: its working directory is refused.
  const refused = await run(undefined);
  assert.equal(refused.code, 0, refused.stderr);
  const before = JSON.parse(refused.stdout) as Record<string, string>;
  assert.equal(before.readFile, 'EACCES');
  assert.equal(before.writeFile, 'EACCES');

  const granted = await run(workspace);
  assert.equal(granted.code, 0, granted.stderr);
  assert.deepEqual(JSON.parse(granted.stdout), {
    readCwd: 'ok', readFile: 'ok', writeFile: 'ok', readToken: 'EACCES', readOtherWorktree: 'EACCES',
  });
  assert.equal(readFileSync(join(workspace, 'out.txt'), 'utf8'), 'x');
});
