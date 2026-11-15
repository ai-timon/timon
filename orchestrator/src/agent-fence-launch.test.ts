/**
 * A mission launch through the fence, end to end on the daemon side: the
 * process spawned is the host's fence launcher wrapping the CLI, the policy
 * it is handed is built from the mission's identity and repository, and the
 * CLI gets its own temporary folder. The fence itself is a stand-in: what it
 * does to a real process is `host/landlock.test.ts`'s business.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { FencePolicy } from './host/isolation.js';
import type { HostFence } from './host/types.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const AUTH = mkdtempSync(join(tmpdir(), 'timon-fence-auth-'));
writeFileSync(join(AUTH, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.CODEX_AUTH_DIR = AUTH;
const BIN = mkdtempSync(join(tmpdir(), 'timon-fence-bin-'));
writeFileSync(join(BIN, 'codex'), '', { mode: 0o755 });
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;
process.on('exit', () => {
  rmSync(AUTH, { recursive: true, force: true });
  rmSync(BIN, { recursive: true, force: true });
});

const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
const { getHost } = await import('./host/index.js');
const { deleteAgent, renameAgent, spawnAgent, upsertAgent } = await import('./agent.js');
const { config, setConfig } = await import('./config/load.js');
const { TIMON_HOME } = await import('./paths.js');
const { missionFenced } = await import('./mission-fence-state.js');

assert.ok((await mountOfficialProviders()).includes('provider-codex'));
setConfig({ ...config(), host: { ...config().host, isolation: { ...config().host.isolation, filesystem: 'auto' } } });

// A main checkout, and a linked worktree of it under the Timon home, as the dispatcher makes them.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'timon-fence-repo-')));
const MAIN = join(ROOT, 'app');
const WT = join(TIMON_HOME, 'worktrees', 'task-1');
const WT_GIT = join(MAIN, '.git', 'worktrees', 'task-1');
mkdirSync(WT_GIT, { recursive: true });
mkdirSync(WT, { recursive: true });
writeFileSync(join(WT, '.git'), `gitdir: ${WT_GIT}\n`);
writeFileSync(join(WT_GIT, 'gitdir'), `${join(WT, '.git')}\n`);
writeFileSync(join(WT_GIT, 'commondir'), '../..\n');

upsertAgent({
  name: 'fence.witness',
  system_prompt: 'witness — does nothing.',
  config: { backend: 'codex', cwd: WT, skills: [], memory_scope: 'NONE' },
});
upsertAgent({
  name: 'fence.reader',
  system_prompt: 'reader — plans, writes nothing.',
  config: { backend: 'codex', cwd: WT, skills: [], memory_scope: 'NONE', permission_mode: 'plan' },
});

const LAUNCHER = '/opt/timon/timon-fence';

async function launch(agent = 'fence.witness'): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; policy: FencePolicy; missionId: string }> {
  const host = getHost();
  const original = { spawn: host.spawn, fence: host.fence };
  const policies: FencePolicy[] = [];
  const fence: HostFence = {
    mechanism: 'landlock',
    probe: () => ({ available: true, abi: 6 }),
    wrap: (policy, cmd, args, policyFile) => {
      policies.push(policy);
      return { cmd: LAUNCHER, args: ['--policy', policyFile, '--', cmd, ...args] };
    },
    witness: async () => ({ ran: true, status: 0, stderr: '' }),
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 4247, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { this.killed = true; return true; },
  });
  const seen = { cmd: '', args: [] as string[], env: {} as NodeJS.ProcessEnv };
  host.fence = fence;
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen.cmd = cmd; seen.args = args; seen.env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof host.spawn;
  let missionId = '';
  try {
    missionId = await spawnAgent(agent, 'ping');
  } finally {
    host.spawn = original.spawn;
    host.fence = original.fence;
  }
  const policy = policies[0];
  assert.ok(policy, 'the fence was asked to wrap the launch');
  return { ...seen, policy, missionId };
}

test('the CLI is spawned through the fence launcher, its own temporary folder as TMPDIR', async () => {
  const run = await launch();
  const at = run.args.indexOf('--');
  assert.equal(run.cmd, LAUNCHER);
  assert.match(run.args[1] ?? '', /run[\\/]fence[\\/].+\.policy$/);
  assert.match(run.args[at + 1] ?? '', /codex$/, 'the CLI right after the launcher');
  const tmp = join(TIMON_HOME, 'tmp', 'missions', run.missionId);
  assert.equal(run.env.TMPDIR, tmp);
  assert.equal(run.env.DISABLE_AUTOUPDATER, '1');
  assert.ok(run.policy.rw.includes(tmp));
  assert.equal(missionFenced(run.missionId), true, 'the session driver learns the process is fenced');
});

test('the CLI\'s package managers download into its agent\'s cache, which the policy opens', async () => {
  const run = await launch();
  const cache = join(TIMON_HOME, 'provider-cache', '.agents', 'fence.witness');
  assert.equal(run.env.npm_config_cache, join(cache, 'npm'));
  assert.equal(run.env.npm_config_cache_dir, join(cache, 'pnpm', 'cache'));
  assert.equal(run.env.npm_config_store_dir, join(cache, 'pnpm', 'store'));
  assert.equal(run.env.UV_CACHE_DIR, join(cache, 'uv'));
  assert.ok(run.policy.rw.includes(cache));
});

test('the policy opens the mission\'s worktree, repository and provider folders, and nothing else of the Timon home', async () => {
  const run = await launch();
  const { policy } = run;
  assert.ok(policy.rw.includes(WT));
  assert.ok(policy.rw.includes(join(MAIN, '.git')), 'the repository the worktree names back');
  assert.ok(policy.rw.includes(MAIN), 'the main checkout, which a merge fast-forwards');
  assert.ok(policy.rw.includes(join(TIMON_HOME, 'provider-runs', 'provider-codex', run.missionId)), 'the CLI\'s per-mission home');
  assert.ok(policy.deny.includes(TIMON_HOME));
  for (const path of policy.rw) {
    if (!path.startsWith(`${TIMON_HOME}/`)) continue;
    assert.ok(
      [WT, join(TIMON_HOME, 'tmp', 'missions'), join(TIMON_HOME, 'provider-runs', 'provider-codex'), join(TIMON_HOME, 'provider-cache', 'provider-codex'), join(TIMON_HOME, 'provider-cache', '.agents', 'fence.witness'), join(TIMON_HOME, 'agents', 'fence.witness')]
        .some((own) => path === own || path.startsWith(`${own}/`)),
      `${path} is one of the mission's own folders`,
    );
  }
});

/** The value codex is handed for `--sandbox`. */
const sandboxLevel = (args: readonly string[]): string | undefined => args[args.indexOf('--sandbox') + 1];

test('fenced, codex runs without its own sandbox and the fence applies the agent\'s level', async () => {
  const writing = await launch();
  assert.equal(sandboxLevel(writing.args), 'danger-full-access', 'bwrap and Seatbelt cannot start inside the fence');
  assert.equal(writing.args.filter((arg) => arg === '--sandbox').length, 1);
  assert.ok(writing.policy.rw.includes(WT), 'workspace-write: the worktree stays writable');
  const reading = await launch('fence.reader');
  assert.equal(sandboxLevel(reading.args), 'danger-full-access');
  assert.ok(reading.policy.ro.includes(WT) && !reading.policy.rw.includes(WT), 'plan: the worktree is read-only');
  assert.ok(reading.policy.ro.includes(join(MAIN, '.git')) && !reading.policy.rw.includes(join(MAIN, '.git')), 'and its repository too');
  assert.ok(reading.policy.rw.includes(join(TIMON_HOME, 'provider-runs', 'provider-codex', reading.missionId)), 'the CLI\'s own home stays writable');
});

test('without a fence on the machine, auto launches the bare CLI with the plain TMPDIR', async () => {
  const host = getHost();
  const original = { spawn: host.spawn, fence: host.fence };
  const seen = { cmd: '', args: [] as string[], env: {} as NodeJS.ProcessEnv };
  const child = Object.assign(new EventEmitter(), {
    pid: 4248, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { this.killed = true; return true; },
  });
  host.fence = { mechanism: 'landlock', probe: () => ({ available: false, reason: 'kernel without Landlock', abi: 0 }), wrap: () => { throw new Error('never'); }, witness: async () => ({ ran: true, status: 0, stderr: '' }) };
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen.cmd = cmd; seen.args = args; seen.env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof host.spawn;
  let missionId = '';
  try {
    missionId = await spawnAgent('fence.witness', 'ping');
  } finally {
    host.spawn = original.spawn;
    host.fence = original.fence;
  }
  assert.equal(missionFenced(missionId), false);
  assert.match(seen.cmd, /codex$/);
  assert.equal(sandboxLevel(seen.args), 'workspace-write', 'unfenced, codex keeps its own sandbox');
  assert.equal(seen.env.DISABLE_AUTOUPDATER, undefined);
  assert.notEqual(seen.env.TMPDIR?.includes(join('tmp', 'missions')), true);
  // Unfenced, the package managers keep the user's own caches.
  for (const name of ['npm_config_cache', 'npm_config_cache_dir', 'npm_config_store_dir', 'UV_CACHE_DIR']) {
    assert.notEqual(seen.env[name]?.includes('.agents'), true, name);
  }
});

test('enforce refuses a mission it cannot fence, before any process starts', async () => {
  const host = getHost();
  const original = { spawn: host.spawn, fence: host.fence };
  let spawned = false;
  const previous = config();
  setConfig({ ...previous, host: { ...previous.host, isolation: { ...previous.host.isolation, filesystem: 'enforce' } } });
  host.fence = undefined;
  host.spawn = (() => { spawned = true; throw new Error('never'); }) as typeof host.spawn;
  try {
    await assert.rejects(spawnAgent('fence.witness', 'ping'), /Mission refused: host\.isolation\.filesystem is "enforce"/);
  } finally {
    host.spawn = original.spawn;
    host.fence = original.fence;
    setConfig(previous);
  }
  assert.equal(spawned, false);
});

test('deleting or renaming an agent removes its package cache', () => {
  const cache = (agent: string) => join(TIMON_HOME, 'provider-cache', '.agents', agent);
  for (const name of ['fence.leaving', 'fence.old']) {
    upsertAgent({ name, system_prompt: 'witness', config: { backend: 'codex', cwd: WT, skills: [], memory_scope: 'NONE' } });
    mkdirSync(join(cache(name), 'npm', '_npx'), { recursive: true });
  }
  // A stale cache under the new name is not the renamed agent's to inherit.
  mkdirSync(join(cache('fence.new'), 'npm'), { recursive: true });
  mkdirSync(cache('fence.witness'), { recursive: true });
  assert.equal(deleteAgent('fence.leaving'), true);
  assert.equal(existsSync(cache('fence.leaving')), false);
  assert.equal(renameAgent('fence.old', 'fence.new').ok, true);
  assert.equal(existsSync(cache('fence.old')), false);
  assert.equal(existsSync(cache('fence.new')), false);
  assert.ok(existsSync(cache('fence.witness')), 'the other agents keep theirs');
});
