/**
 * What the fence of a mission is told beyond its identity: the git
 * directories of a linked worktree, only when the repository names the
 * worktree back, and the plugin packages its MCP servers run from.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonRuntimePaths, integratesProject, leadFenceGrants, pluginPackageDirs, purgeMissionTmpDirs, purgeOrphanAgentPackageCaches, removeAgentPackageCache, worktreeGitDirs,
} from './mission-fence-target.js';

/** A home holding a main checkout, a linked worktree of it, and a folder a mission could aim at. */
function layout() {
  // Native: the module resolves the repository with it, and only it turns a
  // Windows short name (`RUNNER~1`) into the long one.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fence-git-')));
  const home = join(root, 'home');
  const main = join(home, 'code', 'app');
  const common = join(main, '.git');
  const wt = join(root, 'timon', 'worktrees', 'task-1');
  const wtGit = join(common, 'worktrees', 'task-1');
  mkdirSync(wtGit, { recursive: true });
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  writeFileSync(join(wtGit, 'gitdir'), `${join(wt, '.git')}\n`);
  writeFileSync(join(wtGit, 'commondir'), '../..\n');
  return { root, home, main, common, wt, wtGit };
}

test('a linked worktree opens its repository\'s git directory and main checkout', () => {
  const { home, main, common, wt } = layout();
  assert.deepEqual(worktreeGitDirs(wt, home), { dirs: [common, main], refused: null });
  // From a sub-folder of the worktree, the same repository.
  mkdirSync(join(wt, 'src'));
  assert.deepEqual(worktreeGitDirs(join(wt, 'src'), home).dirs, [common, main]);
});

test('a .git file the mission rewrote opens nothing the repository does not confirm', () => {
  const { home, wt } = layout();
  // Aimed at a folder that is no git directory.
  writeFileSync(join(wt, '.git'), `gitdir: ${join(home, '.ssh')}\n`);
  const ssh = worktreeGitDirs(wt, home);
  assert.deepEqual(ssh.dirs, []);
  assert.match(ssh.refused ?? '', /does not name this worktree back/);
  // Aimed at another repository's worktree, which names another checkout.
  const other = join(home, 'code', 'other', '.git', 'worktrees', 'w');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'gitdir'), `${join(home, 'elsewhere', '.git')}\n`);
  writeFileSync(join(other, 'commondir'), '../..\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${other}\n`);
  assert.deepEqual(worktreeGitDirs(wt, home).dirs, []);
  // Not a worktree link at all.
  writeFileSync(join(wt, '.git'), 'nonsense\n');
  assert.match(worktreeGitDirs(wt, home).refused ?? '', /not a worktree link/);
});

test('a back-link inside a folder the mission writes cannot reach out of it', () => {
  const { home, wt } = layout();
  // The mission crafts a git directory in its own worktree, with a back-link,
  // and a commondir naming the folder it wants opened.
  const crafted = join(wt, 'fake', 'worktrees', 'x');
  mkdirSync(crafted, { recursive: true });
  writeFileSync(join(crafted, 'gitdir'), `${join(wt, '.git')}\n`);
  writeFileSync(join(crafted, 'commondir'), `${join(home, '.ssh')}\n`);
  writeFileSync(join(wt, '.git'), `gitdir: ${crafted}\n`);
  assert.deepEqual(worktreeGitDirs(wt, home).dirs, []);
});

test('a repository that holds the home folder is never opened', () => {
  const { home, wt } = layout();
  // A dotfiles repository at the home folder, with the worktree linked to it.
  const wtGit = join(home, '.git', 'worktrees', 'task-1');
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(wtGit, 'gitdir'), `${join(wt, '.git')}\n`);
  writeFileSync(join(wtGit, 'commondir'), '../..\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.match(worktreeGitDirs(wt, home).refused ?? '', /holds the home folder/);
  // A plain folder of the home, inside that dotfiles checkout.
  mkdirSync(join(home, 'notes'));
  const notes = worktreeGitDirs(join(home, 'notes'), home);
  assert.deepEqual(notes.dirs, []);
  assert.match(notes.refused ?? '', /holds the home folder/);
});

test('a home reached through a link is recognised as the folder a repository holds', () => {
  const { root, home, main, common, wt } = layout();
  // A junction on Windows needs no privilege; elsewhere the type is ignored.
  const linked = join(root, 'linked-home');
  symlinkSync(home, linked, 'junction');
  // The project checkout under the home still opens, the home given through its link.
  assert.deepEqual(worktreeGitDirs(wt, linked), { dirs: [common, main], refused: null });
  // A dotfiles repository at the home: refused, whether the worktree links to it…
  const wtGit = join(home, '.git', 'worktrees', 'task-1');
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(wtGit, 'gitdir'), `${join(wt, '.git')}\n`);
  writeFileSync(join(wtGit, 'commondir'), '../..\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.match(worktreeGitDirs(wt, linked).refused ?? '', /holds the home folder/);
  // …or the mission works in a folder of the home, named through the link too.
  mkdirSync(join(home, 'notes'));
  const notes = worktreeGitDirs(join(linked, 'notes'), linked);
  assert.deepEqual(notes.dirs, []);
  assert.match(notes.refused ?? '', /holds the home folder/);
  assert.match(worktreeGitDirs(join(home, 'notes'), linked).refused ?? '', /holds the home folder/);
  assert.match(worktreeGitDirs(join(linked, 'notes'), home).refused ?? '', /holds the home folder/);
});

test('a checkout\'s own .git folder adds nothing; from a sub-folder it is opened', () => {
  const { home, main, common } = layout();
  assert.deepEqual(worktreeGitDirs(main, home), { dirs: [], refused: null });
  mkdirSync(join(main, 'packages', 'x'), { recursive: true });
  assert.deepEqual(worktreeGitDirs(join(main, 'packages', 'x'), home), { dirs: [common], refused: null });
});

test('outside any repository there is nothing to open', () => {
  // Described rather than built: a `.git` left in a shared temporary folder would make it a repository.
  const nothing = { kind: () => null, read: () => null, realpath: () => null };
  assert.deepEqual(worktreeGitDirs('/srv/data/project', '/home/u', nothing), { dirs: [], refused: null });
});

test('an MCP command line opens its plugin package, and only that', () => {
  const th = join(tmpdir(), 'fence-plugins', '.timon');
  const modules = join(th, 'plugins', 'node_modules');
  assert.deepEqual(pluginPackageDirs([
    'node',
    join(modules, 'acme-mcp', 'dist', 'server.js'),
    join(modules, '@acme', 'tools', 'bin', 'serve.mjs'),
    join(modules, 'acme-mcp', 'other.js'),
    '--flag',
    join(th, 'plugins', 'registry.json'),
    join(modules, '@acme'),
    join(th, 'daemon-token'),
    '/usr/bin/python3',
  ], th), [join(modules, 'acme-mcp'), join(modules, '@acme', 'tools')]);
});

test('a finished mission\'s temporary folder goes; a running one, and a recent orphan, stay', () => {
  const th = realpathSync(mkdtempSync(join(tmpdir(), 'fence-tmp-')));
  const root = join(th, 'tmp', 'missions');
  for (const id of ['running', 'finished', 'orphan', 'old-orphan']) mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, 'finished', 'scratch.txt'), 'x');
  const lifetimes: Record<string, { live: boolean }> = { running: { live: true }, finished: { live: false } };
  const now = Date.now();
  const old = new Date(now - 2 * 24 * 60 * 60 * 1000);
  utimesSync(join(root, 'old-orphan'), old, old);
  const removed = purgeMissionTmpDirs(th, (id) => lifetimes[id] ?? null, now);
  assert.deepEqual(removed.sort(), ['finished', 'old-orphan']);
  assert.ok(existsSync(join(root, 'running')) && existsSync(join(root, 'orphan')));
  assert.deepEqual(purgeMissionTmpDirs(join(th, 'absent'), () => null), []);
});

test('an agent\'s package cache goes with it, and only its own', () => {
  const th = realpathSync(mkdtempSync(join(tmpdir(), 'fence-cache-')));
  const caches = join(th, 'provider-cache', '.agents');
  for (const agent of ['leaving', 'staying']) mkdirSync(join(caches, agent, 'npm', '_npx'), { recursive: true });
  mkdirSync(join(th, 'provider-cache', 'provider-codex', 'cache'), { recursive: true });
  removeAgentPackageCache(th, 'leaving');
  assert.equal(existsSync(join(caches, 'leaving')), false);
  assert.ok(existsSync(join(caches, 'staying', 'npm', '_npx')));
  // A name that is not a plain folder name removes nothing above it.
  removeAgentPackageCache(th, '..');
  removeAgentPackageCache(th, '');
  assert.ok(existsSync(caches) && existsSync(join(th, 'provider-cache', 'provider-codex', 'cache')));
});

test('the package caches of agents that no longer exist are swept, the others kept', () => {
  const th = realpathSync(mkdtempSync(join(tmpdir(), 'fence-cache-')));
  const caches = join(th, 'provider-cache', '.agents');
  for (const agent of ['alive', 'gone']) mkdirSync(join(caches, agent, 'npm'), { recursive: true });
  const removed = purgeOrphanAgentPackageCaches(th, (agent) => agent === 'alive');
  assert.deepEqual(removed, ['gone']);
  assert.ok(existsSync(join(caches, 'alive', 'npm')));
  assert.deepEqual(purgeOrphanAgentPackageCaches(join(th, 'absent'), () => false), []);
});

test('the daemon\'s runtime: its executable, its orchestrator folder and the Node of its MCP servers', () => {
  const release = '/home/u/.timon/desktop-runtime/releases/9.9.9/resources';
  // The shipped Node runs the daemon and its MCP servers: named once.
  assert.deepEqual(
    daemonRuntimePaths({ command: `${release}/node/node`, env: {} }, `${release}/node/node`, `${release}/orchestrator`),
    [`${release}/node/node`, `${release}/orchestrator`],
  );
  // A Node the configuration names is where the MCP servers start: it is named too.
  assert.deepEqual(
    daemonRuntimePaths({ command: '/opt/node/bin/node', env: {} }, `${release}/node/node`, `${release}/orchestrator`),
    [`${release}/node/node`, `${release}/orchestrator`, '/opt/node/bin/node'],
  );
  // A bare command is looked up on PATH: no folder to infer.
  assert.deepEqual(daemonRuntimePaths({ command: 'node', env: {} }, '/usr/bin/node', '/src/timon/orchestrator'), ['/usr/bin/node', '/src/timon/orchestrator']);
  // By default, the orchestrator folder is the one this code runs from, which holds the MCP scripts.
  const [, root] = daemonRuntimePaths({ command: 'node', env: {} });
  assert.ok(root && existsSync(join(root, 'bin', 'timon-mcp.mjs')) && existsSync(join(root, 'bin', 'permission-mcp.mjs')));
});

/** A project repository with its common git directory, and the Timon home holding task worktrees. */
function leadLayout() {
  const l = layout();
  const timonHome = join(l.root, 'timon');
  const other = join(timonHome, 'worktrees', 'task-other-project');
  mkdirSync(other, { recursive: true });
  return { ...l, timonHome, other };
}

test('a lead, a merger and a merge task get the project worktrees and common git directory', () => {
  const { home, main, common, wt, timonHome, other } = leadLayout();
  const input = { project: 'app', timonHome, home, repoCwd: main, taskWorktrees: [wt] };
  for (const [role, taskType] of [['orchestrator', undefined], ['merger', undefined], ['coder', 'merge']] as const) {
    const grants = leadFenceGrants({ ...input, role, taskType });
    assert.deepEqual(grants.worktrees, [wt], `${role}/${taskType}`);
    assert.deepEqual(grants.gitDirs, [common], 'the common .git only, not the checkout around it');
    assert.equal(grants.worktrees.includes(other), false, 'a worktree no task of the project records is never listed');
  }
});

test('a coder, or an agent whose name only says merge, gets nothing', () => {
  const { home, main, wt, timonHome } = leadLayout();
  const input = { project: 'app', timonHome, home, repoCwd: main, taskWorktrees: [wt] };
  assert.equal(integratesProject('coder', 'code'), false);
  assert.equal(integratesProject(null, undefined), false);
  assert.deepEqual(leadFenceGrants({ ...input, role: 'coder', taskType: 'code' }), { worktrees: [], gitDirs: [], refused: [] });
  // The name is not an input at all: only the role field and the task type count.
  assert.deepEqual(leadFenceGrants({ ...input, role: 'reviewer', taskType: 'review' }).worktrees, []);
  assert.deepEqual(leadFenceGrants({ ...input, role: 'orchestrator', taskType: 'review', project: '' }).worktrees, [], 'no project, no grant');
});

test('only existing folders directly below the worktrees folder are listed', () => {
  const { home, main, wt, timonHome } = leadLayout();
  const grants = leadFenceGrants({
    role: 'merger', taskType: undefined, project: 'app', timonHome, home, repoCwd: main,
    taskWorktrees: [wt, join(timonHome, 'worktrees', 'gone'), join(wt, 'src'), join(home, 'code', 'app'), join(timonHome, 'worktrees', '..', 'agents')],
  });
  assert.deepEqual(grants.worktrees, [wt]);
});

test('a project repository holding the home folder opens no git directory', () => {
  const { home, wt, timonHome, root } = leadLayout();
  mkdirSync(join(root, '.git'), { recursive: true });
  const grants = leadFenceGrants({ role: 'merger', taskType: undefined, project: 'app', timonHome, home, repoCwd: root, taskWorktrees: [wt] });
  assert.deepEqual(grants.gitDirs, []);
  assert.equal(grants.refused.length, 1);
});
