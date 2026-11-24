/**
 * Removing a task worktree must never empty what its links point to. On
 * Windows the shared `node_modules` are junctions, and deleting the worktree
 * traversed them, emptying the main clone's dependencies. The links are now
 * removed first, one by one, and one that stays blocks the removal.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, disposeWorktree, releaseWorktreeFolder, type WorktreeInfo } from './worktree.js';
import { linkDirectory } from './host/directory-link.js';

const WITNESSES = [
  join('node_modules', 'dep', 'index.js'),
  join('app', 'node_modules', 'dep', 'index.js'),
  join('docs', 'PROGRESS.md'),
  join('.claude', 'skills', 'skill', 'SKILL.md'),
];

/** A main clone with installed packages and declared folders, and a task worktree linked to them. */
async function setup(): Promise<{ repo: string; info: WorktreeInfo; cleanup: () => void }> {
  const repo = mkdtempSync(join(tmpdir(), 'timon-wt-unlink-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n/docs\n/.claude/\n/cache\n');
  writeFileSync(join(repo, '.worktreelinks'), 'docs\n.claude/skills\n');
  writeFileSync(join(repo, 'package.json'), '{}');
  mkdirSync(join(repo, 'app'));
  writeFileSync(join(repo, 'app', 'package.json'), '{}');
  git('add', '.');
  git('commit', '-m', 'Initial');
  for (const witness of WITNESSES) {
    mkdirSync(join(repo, witness, '..'), { recursive: true });
    writeFileSync(join(repo, witness), 'witness');
  }
  const info = await createWorktree(randomUUID(), repo, 'main');
  for (const link of ['node_modules', join('app', 'node_modules'), 'docs', join('.claude', 'skills')]) {
    assert.ok(lstatSync(join(info.path, link)).isSymbolicLink(), `${link} is linked`);
  }
  // A dangling ignored link must not stop the removal either.
  linkDirectory(join(repo, 'gone'), join(info.path, 'cache'));
  return { repo, info, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

function assertWitnessesIntact(repo: string): void {
  for (const witness of WITNESSES) assert.ok(existsSync(join(repo, witness)), `${witness} survives`);
}

const removals: Array<[string, (info: WorktreeInfo) => Promise<void>]> = [
  ['disposeWorktree', (info) => disposeWorktree(info)],
  ['disposeWorktree with force', (info) => disposeWorktree(info, true)],
  ['releaseWorktreeFolder', (info) => releaseWorktreeFolder(info.path)],
];

for (const [name, remove] of removals) {
  test(`${name} removes the worktree and its links, never their targets`, async () => {
    const { repo, info, cleanup } = await setup();
    try {
      await remove(info);
      assert.equal(lstatSync(info.path, { throwIfNoEntry: false }), undefined);
      assertWitnessesIntact(repo);
    } finally {
      cleanup();
    }
  });
}

const unremovable = process.platform !== 'win32' && process.getuid?.() !== 0;

for (const [name, remove] of removals) {
  test(`${name} keeps the worktree when a link cannot be removed`, { skip: !unremovable && 'needs POSIX permissions and a non-root user' }, async () => {
    const { repo, info, cleanup } = await setup();
    const locked = join(info.path, 'app');
    chmodSync(locked, 0o555);
    try {
      await assert.rejects(remove(info), /refusing to remove the worktree/);
      assert.ok(existsSync(join(info.path, '.git')), 'the worktree is still registered');
      assert.ok(lstatSync(join(locked, 'node_modules')).isSymbolicLink());
      assert.ok(execFileSync('git', ['-C', repo, 'branch', '--list', info.branch], { encoding: 'utf8' }).includes(info.branch));
      assertWitnessesIntact(repo);
    } finally {
      chmodSync(locked, 0o755);
      await disposeWorktree(info, true);
      cleanup();
    }
  });
}

test('a dirty worktree git refuses to remove gets its links back', async () => {
  const { repo, info, cleanup } = await setup();
  try {
    writeFileSync(join(info.path, 'package.json'), '{"dirty":true}');
    await assert.rejects(disposeWorktree(info));
    for (const link of ['node_modules', join('app', 'node_modules'), 'docs', join('.claude', 'skills')]) {
      assert.ok(lstatSync(join(info.path, link)).isSymbolicLink(), `${link} is linked again`);
    }
    assertWitnessesIntact(repo);
  } finally {
    await disposeWorktree(info, true);
    cleanup();
  }
});

test('a link git tracks is left to git, so a clean worktree still goes without --force', { skip: process.platform === 'win32' && 'tracked symlinks need core.symlinks' }, async () => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-wt-tracked-link-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    mkdirSync(join(repo, 'real'));
    writeFileSync(join(repo, 'real', 'file.txt'), 'in git');
    symlinkSync('real', join(repo, 'alias'), 'dir');
    git('add', '.');
    git('commit', '-m', 'Initial');
    const info = await createWorktree(randomUUID(), repo, 'main');
    assert.ok(lstatSync(join(info.path, 'alias')).isSymbolicLink());
    await disposeWorktree(info);
    assert.equal(lstatSync(info.path, { throwIfNoEntry: false }), undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
