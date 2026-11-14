/**
 * What the fence of a mission is told beyond its identity: the git
 * directories of a linked worktree, only when the repository names the
 * worktree back, and the plugin packages its MCP servers run from.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pluginPackageDirs, purgeMissionTmpDirs, purgeOrphanAgentPackageCaches, removeAgentPackageCache, worktreeGitDirs,
} from './mission-fence-target.js';

/** A home holding a main checkout, a linked worktree of it, and a folder a mission could aim at. */
function layout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fence-git-')));
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
