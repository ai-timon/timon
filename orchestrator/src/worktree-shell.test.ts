/**
 * Worktree shell purge: a `~/.timon/worktrees/<id>/` folder left with only a
 * `.grepai/` once git let go of it. 146 of them (12 G) piled up on 18/09/2026.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHeldByGrepai, purgeShell, sweepShells } from './worktree-shell.js';

const GRACE = 30 * 60_000;

function makeRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'wt-shell-')), 'worktrees');
}

/** A shell as found on disk: only `.grepai/` (+ `.gitignore`), aged `ageMs`. */
function makeShell(root: string, name: string, ageMs: number): string {
  const path = join(root, name);
  mkdirSync(join(path, '.grepai'), { recursive: true });
  writeFileSync(join(path, '.grepai', 'index.gob'), 'x');
  writeFileSync(join(path, '.gitignore'), '.grepai/\n');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

test('a .grepai-only shell past its grace is purged', () => {
  const root = makeRoot();
  const path = makeShell(root, 'task-a', GRACE * 2);
  assert.equal(purgeShell(root, path, GRACE, Date.now(), []), 'purged');
  assert.equal(existsSync(path), false);
});

test('a shell within its grace is kept', () => {
  const root = makeRoot();
  const path = makeShell(root, 'task-b', 1000);
  assert.equal(purgeShell(root, path, GRACE, Date.now(), []), 'grace');
  assert.equal(existsSync(path), true);
});

test('a folder with a .git is a live worktree and is never touched', () => {
  const root = makeRoot();
  const path = makeShell(root, 'task-c', GRACE * 2);
  writeFileSync(join(path, '.git'), 'gitdir: /somewhere\n');
  const t = (Date.now() - GRACE * 2) / 1000;
  utimesSync(path, t, t);
  assert.equal(purgeShell(root, path, GRACE, Date.now(), []), 'not-shell');
  assert.equal(existsSync(join(path, '.grepai')), true);
});

test('a folder outside the root is never touched', () => {
  const root = makeRoot();
  const elsewhere = makeRoot();
  const path = makeShell(elsewhere, 'task-d', GRACE * 2);
  assert.equal(purgeShell(root, path, GRACE, Date.now(), []), 'not-shell');
  assert.equal(existsSync(path), true);
});

test('a nested folder under the root is not a shell (direct children only)', () => {
  const root = makeRoot();
  const path = makeShell(join(root, 'task-e'), 'nested', GRACE * 2);
  assert.equal(purgeShell(root, path, GRACE, Date.now(), []), 'not-shell');
  assert.equal(existsSync(path), true);
});

test('a symlink under the root is neither followed nor removed', () => {
  const root = makeRoot();
  const target = makeShell(makeRoot(), 'target', GRACE * 2);
  mkdirSync(root, { recursive: true });
  const link = join(root, 'task-f');
  symlinkSync(target, link, 'dir');
  assert.equal(purgeShell(root, link, 0, Date.now(), []), 'not-shell');
  assert.equal(existsSync(link), true);
  assert.equal(existsSync(join(target, '.grepai', 'index.gob')), true);
});

test('purging a shell unlinks inner symlinks without emptying their target', () => {
  // A worktree's node_modules is a link to the main clone's dependencies.
  const root = makeRoot();
  const deps = makeShell(makeRoot(), 'deps', 0);
  const path = makeShell(root, 'task-g', GRACE * 2);
  symlinkSync(deps, join(path, 'node_modules'), 'dir');
  const t = (Date.now() - GRACE * 2) / 1000;
  utimesSync(path, t, t);
  assert.equal(purgeShell(root, path, GRACE, Date.now(), []), 'purged');
  assert.equal(existsSync(join(deps, '.grepai', 'index.gob')), true);
});

test('purging a shell removes nested and dangling links first, never their targets', () => {
  const root = makeRoot();
  const deps = makeShell(makeRoot(), 'deps', 0);
  const path = makeShell(root, 'task-n', GRACE * 2);
  mkdirSync(join(path, 'app'));
  mkdirSync(join(path, '.claude'));
  symlinkSync(deps, join(path, 'app', 'node_modules'), 'dir');
  symlinkSync(deps, join(path, '.claude', 'skills'), 'dir');
  symlinkSync(join(deps, 'missing'), join(path, 'dangling'), 'dir');
  const t = (Date.now() - GRACE * 2) / 1000;
  utimesSync(path, t, t);
  assert.equal(purgeShell(root, path, GRACE, Date.now(), []), 'purged');
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(deps, '.grepai', 'index.gob')), true);
});

test('a shell whose link cannot be removed is kept whole', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions and a non-root user' }, (t) => {
  t.mock.method(console, 'warn', () => {});
  const root = makeRoot();
  const deps = makeShell(makeRoot(), 'deps', 0);
  const path = makeShell(root, 'task-l', GRACE * 2);
  const locked = join(path, 'app');
  mkdirSync(locked);
  symlinkSync(deps, join(locked, 'node_modules'), 'dir');
  chmodSync(locked, 0o555);
  const aged = (Date.now() - GRACE * 2) / 1000;
  utimesSync(path, aged, aged);
  try {
    assert.equal(purgeShell(root, path, GRACE, Date.now(), []), 'locked');
    assert.ok(lstatSync(join(locked, 'node_modules')).isSymbolicLink());
    assert.ok(existsSync(join(path, '.grepai', 'index.gob')));
    assert.ok(existsSync(join(deps, '.grepai', 'index.gob')));
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.equal(purgeShell(root, path, GRACE, Date.now(), []), 'purged');
});

test('a shell still held by a grepai process is kept', () => {
  const root = makeRoot();
  const path = makeShell(root, 'task-h', GRACE * 2);
  assert.equal(purgeShell(root, path, GRACE, Date.now(), [path]), 'held');
  assert.equal(existsSync(path), true);
  assert.equal(isHeldByGrepai(path, [join(path, 'sub')]), true);
  assert.equal(isHeldByGrepai(path, [`${path}-other`]), false);
});

test('the sweep purges old shells and spares live tasks, young shells and worktrees', () => {
  const root = makeRoot();
  const old = makeShell(root, 'done-task', GRACE * 2);
  const live = makeShell(root, 'live-task', GRACE * 2);
  const young = makeShell(root, 'young', 1000);
  const worktree = makeShell(root, 'worktree', GRACE * 2);
  writeFileSync(join(worktree, '.git'), 'gitdir: /x\n');
  const t = (Date.now() - GRACE * 2) / 1000;
  utimesSync(worktree, t, t);

  const out = sweepShells(root, GRACE, Date.now(), (name) => name === 'live-task');
  assert.equal(out.purged, 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(worktree), true);
});

test('the sweep of a missing root is a no-op', () => {
  assert.deepEqual(sweepShells(makeRoot(), GRACE, Date.now(), () => false), { purged: 0, held: 0 });
});
