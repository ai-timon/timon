import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, disposeWorktree, parseWorktreeLinks, prepareWorktreeDependencies } from './worktree.js';
import { linkDirectory } from './host/directory-link.js';

for (const kind of ['code', 'merge'] as const) {
  test(`${kind} worktrees expose root and nested package dependencies on creation and retry`, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'timon-worktree-deps-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    const packages = ['', 'orchestrator', 'app', 'desktop', join('packages', 'with spaces')];
    const taskId = randomUUID();
    let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
      for (const pkg of [...packages, 'not-installed']) {
        mkdirSync(join(repo, pkg), { recursive: true });
        writeFileSync(join(repo, pkg, 'package.json'), '{}');
      }
      git('add', '.');
      git('commit', '-m', 'Initial packages');
      for (const pkg of packages) {
        const dependency = join(repo, pkg, 'node_modules', 'fixture-dependency');
        mkdirSync(dependency, { recursive: true });
        writeFileSync(join(dependency, 'index.js'), 'module.exports = 96;');
      }
      const branch = kind === 'merge' ? `timon/merge/${taskId}` : undefined;
      worktree = await createWorktree(taskId, repo, 'main', branch);
      for (const pkg of packages) {
        const destination = join(worktree.path, pkg, 'node_modules');
        assert.ok(lstatSync(destination).isSymbolicLink());
        assert.equal(realpathSync(destination), realpathSync(join(repo, pkg, 'node_modules')));
        assert.equal(execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('fixture-dependency')))"], {
          cwd: join(worktree.path, pkg), encoding: 'utf8',
        }), '96');
      }
      assert.equal(existsSync(join(worktree.path, 'not-installed', 'node_modules')), false);
      assert.equal(execFileSync('git', ['-C', worktree.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');

      rmSync(join(worktree.path, 'app', 'node_modules'));
      await createWorktree(taskId, repo, 'main', branch);
      assert.equal(realpathSync(join(worktree.path, 'app', 'node_modules')), realpathSync(join(repo, 'app', 'node_modules')));

      const local = join(worktree.path, 'desktop', 'node_modules');
      rmSync(local);
      mkdirSync(local);
      writeFileSync(join(local, 'keep'), 'local installation');
      const dangling = join(worktree.path, 'orchestrator', 'node_modules');
      rmSync(dangling);
      linkDirectory(join(repo, 'missing'), dangling);
      await prepareWorktreeDependencies(repo, worktree.path);
      assert.ok(existsSync(join(local, 'keep')));
      assert.ok(lstatSync(dangling).isSymbolicLink());
      assert.equal(existsSync(dangling), false);

      const outside = join(repo, 'outside-package');
      mkdirSync(outside);
      rmSync(join(worktree.path, 'app'), { recursive: true });
      linkDirectory(outside, join(worktree.path, 'app'));
      await prepareWorktreeDependencies(repo, worktree.path);
      assert.equal(existsSync(join(outside, 'node_modules')), false);
    } finally {
      if (worktree) await disposeWorktree(worktree, true);
      assert.ok(existsSync(join(repo, 'app', 'node_modules', 'fixture-dependency', 'index.js')));
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test('root-only ignore rules do not expose nested dependency links as untracked files', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-worktree-root-ignore-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, '.gitignore'), '/node_modules\n');
    for (const pkg of ['', 'app']) {
      mkdirSync(join(repo, pkg), { recursive: true });
      writeFileSync(join(repo, pkg, 'package.json'), '{}');
    }
    git('add', '.');
    git('commit', '-m', 'Initial packages');
    for (const pkg of ['', 'app']) mkdirSync(join(repo, pkg, 'node_modules'));

    worktree = await createWorktree(randomUUID(), repo, 'main');
    await prepareWorktreeDependencies(repo, worktree.path);
    assert.ok(lstatSync(join(worktree.path, 'node_modules')).isSymbolicLink());
    assert.equal(realpathSync(join(worktree.path, 'node_modules')), realpathSync(join(repo, 'node_modules')));
    assert.equal(lstatSync(join(worktree.path, 'app', 'node_modules'), { throwIfNoEntry: false }), undefined);
    assert.equal(execFileSync('git', ['-C', worktree.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');
    assert.ok(warnings.some(message => message.includes('dependencies not shared for app: node_modules is not git-ignored')));
  } finally {
    if (worktree) await disposeWorktree(worktree, true);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('repositories without Node packages remain usable', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-worktree-no-node-'));
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial'], { stdio: 'pipe' });
    worktree = await createWorktree(randomUUID(), repo, 'main');
    assert.equal(existsSync(join(worktree.path, 'node_modules')), false);
  } finally {
    if (worktree) await disposeWorktree(worktree, true);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('.worktreelinks keeps relative folders inside the repository only', () => {
  assert.deepEqual(
    parseWorktreeLinks('# notes\ndocs\n  fixtures/local/  # comment\n../outside\n/etc\nC:\\Windows\n./docs\na/../b\n\ndocs\n'),
    ['docs', join('fixtures', 'local')],
  );
});

test('a task worktree links the ignored folders its repository declares, never a tracked or missing one', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-worktree-links-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, '.gitignore'), '/docs\n/cache\n');
    writeFileSync(join(repo, '.worktreelinks'), 'docs\ntracked\ncache\n../escape\n');
    mkdirSync(join(repo, 'tracked'));
    writeFileSync(join(repo, 'tracked', 'file.txt'), 'in git');
    git('add', '.');
    git('commit', '-m', 'Initial');
    // An internal notes repository, ignored by the parent, as a real nested git repo.
    mkdirSync(join(repo, 'docs'));
    execFileSync('git', ['-C', join(repo, 'docs'), 'init', '-b', 'main'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'docs', 'PROGRESS.md'), '# progress\n');

    worktree = await createWorktree(randomUUID(), repo, 'main');
    const linked = join(worktree.path, 'docs');
    assert.ok(lstatSync(linked).isSymbolicLink());
    assert.equal(realpathSync(linked), realpathSync(join(repo, 'docs')));
    writeFileSync(join(linked, 'PROGRESS.md'), '# progress\n- written from the task\n');
    assert.match(readFileSync(join(repo, 'docs', 'PROGRESS.md'), 'utf8'), /written from the task/);
    // A tracked folder is the worktree's own copy; a folder absent from the main clone is skipped.
    assert.equal(lstatSync(join(worktree.path, 'tracked')).isSymbolicLink(), false);
    assert.equal(lstatSync(join(worktree.path, 'cache'), { throwIfNoEntry: false }), undefined);
    assert.equal(existsSync(join(repo, '..', 'escape')), false);
    assert.equal(execFileSync('git', ['-C', worktree.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');
    await disposeWorktree(worktree, true);
    worktree = undefined;
    // Removing the worktree unlinks the folder; the notes stay in the main clone.
    assert.match(readFileSync(join(repo, 'docs', 'PROGRESS.md'), 'utf8'), /written from the task/);
  } finally {
    if (worktree) await disposeWorktree(worktree, true);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a declared folder that git does not ignore, or ignores only as a directory, is not linked', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-worktree-links-tracked-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, '.worktreelinks'), 'notes\nlocal\n');
    // A directory-only rule does not cover the symlink the link would be.
    writeFileSync(join(repo, '.gitignore'), '/local/\n');
    git('add', '.');
    git('commit', '-m', 'Initial');
    mkdirSync(join(repo, 'notes'));
    writeFileSync(join(repo, 'notes', 'a.md'), 'x');
    mkdirSync(join(repo, 'local'));

    worktree = await createWorktree(randomUUID(), repo, 'main');
    assert.equal(lstatSync(join(worktree.path, 'notes'), { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(join(worktree.path, 'local'), { throwIfNoEntry: false }), undefined);
    assert.ok(warnings.some((message) => message.includes('notes not linked')));
    assert.ok(warnings.some((message) => message.includes('local not linked')));
    assert.equal(execFileSync('git', ['-C', worktree.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  } finally {
    if (worktree) await disposeWorktree(worktree, true);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a declared folder under an untracked ignored parent gets that parent, never one git would commit or one outside', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-worktree-links-parents-'));
  const outside = mkdtempSync(join(tmpdir(), 'timon-worktree-links-outside-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    // Every hidden folder is ignored, as directories only: `.claude/` is never tracked.
    writeFileSync(join(repo, '.gitignore'), '.*/\n/notes\n');
    writeFileSync(join(repo, '.worktreelinks'), '.claude/skills\nplain/skills\n');
    git('add', '.');
    git('commit', '-m', 'Initial');
    // As in a real checkout: `.claude/skills` is itself a link to skills kept in a notes folder.
    mkdirSync(join(repo, 'notes', 'skills', 'demo'), { recursive: true });
    writeFileSync(join(repo, 'notes', 'skills', 'demo', 'SKILL.md'), '# demo\n');
    mkdirSync(join(repo, '.claude'));
    linkDirectory(join(repo, 'notes', 'skills'), join(repo, '.claude', 'skills'));
    mkdirSync(join(repo, 'plain', 'skills'), { recursive: true });

    worktree = await createWorktree(randomUUID(), repo, 'main');
    const linked = join(worktree.path, '.claude', 'skills');
    assert.ok(lstatSync(linked).isSymbolicLink());
    assert.equal(realpathSync(linked), realpathSync(join(repo, 'notes', 'skills')));
    assert.equal(readFileSync(join(linked, 'demo', 'SKILL.md'), 'utf8'), '# demo\n');
    // `plain/` is not ignored: creating it would let `git add -A` commit the link.
    assert.equal(lstatSync(join(worktree.path, 'plain'), { throwIfNoEntry: false }), undefined);
    assert.ok(warnings.some((message) => message.includes('plain/ is missing from the worktree and git does not ignore it')));
    assert.equal(execFileSync('git', ['-C', worktree.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');

    // An existing ignored ancestor that leads outside the worktree must not receive the parents.
    linkDirectory(outside, join(worktree.path, '.escape'));
    mkdirSync(join(repo, '.escape', 'deep', 'skills'), { recursive: true });
    writeFileSync(join(worktree.path, '.worktreelinks'), '.escape/deep/skills\n');
    await prepareWorktreeDependencies(repo, worktree.path);
    assert.equal(existsSync(join(outside, 'deep')), false);
    assert.ok(warnings.some((message) => message.includes('its parent folder resolves outside the worktree')));

    await disposeWorktree(worktree, true);
    worktree = undefined;
    // Removing the worktree removes the link; the skills stay in the main clone.
    assert.equal(readFileSync(join(repo, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8'), '# demo\n');
    assert.equal(existsSync(outside), true);
  } finally {
    if (worktree) await disposeWorktree(worktree, true);
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
