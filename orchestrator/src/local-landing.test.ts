/**
 * The task that merges a job's branch into its local target
 * (`landing = 'local'`): its brief merges on a detached copy of the target,
 * it only starts in a job on a branch of its own in a project that merges
 * locally, its DONE is proven by git, and that DONE lands the job (ideas
 * closed, integration 'merged').
 *
 * `npm test -- src/local-landing.test.ts`
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { dbApi } = await import('./db.js');
type TaskRow = import('./db.js').TaskRow;
const { agentDir } = await import('./paths.js');
const { blockIfBaseUnavailable, worktreeDirective } = await import('./dispatcher.js');
const { mergeCloseRefusal } = await import('./code-gate.js');
const { landLocalLanding, landPendingLocalLandings } = await import('./local-landing.js');
const { decodeDaemonMessage } = await import('./daemon-message.js');
const { applyTodoClosure } = await import('./todo-closure.js');

const PROJECT = 'locland';
let AGENT = 'locland.merger';
let repos = 0;

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** `main`, and `feat/job` one commit ahead of it. */
function mkRepo(): { repo: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-local-landing-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'checkout', '-q', '-b', 'feat/job');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', 'b.txt');
  git(repo, 'commit', '-q', '-m', 'the job');
  git(repo, 'checkout', '-q', 'main');
  // One agent per repository: a task is read in its agent's folder.
  AGENT = `locland-${++repos}.merger`;
  mkdirSync(agentDir(AGENT), { recursive: true });
  writeFileSync(join(agentDir(AGENT), 'config.json'), JSON.stringify({ cwd: repo, role: 'merger', project: PROJECT }));
  writeFileSync(join(agentDir(AGENT), 'system-prompt.md'), 'Test');
  return { repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mkTask(type: TaskRow['type'], opts: {
  deps?: string[]; base?: string; landing?: string; mode?: string; baseRef?: string; todoId?: number; pipeline?: string;
} = {}): TaskRow {
  const id = randomUUID();
  dbApi.createTask(id, `${type} fixture`, AGENT, {
    type, deps: opts.deps ?? [], baseBranch: opts.base, landing: opts.landing, project: PROJECT,
    integrationMode: opts.mode, baseRef: opts.baseRef, pipeline: opts.pipeline ?? null,
  });
  if (opts.todoId) dbApi.setTaskTodoId(id, opts.todoId);
  return dbApi.getTask(id)!;
}

/** What a person (or the merger) does: merge the branch into main with a merge commit. */
function mergeIntoMain(repo: string): string {
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge: integrate feat/job into main', 'feat/job');
  return git(repo, 'rev-parse', 'main');
}

const WT = { taskId: 't', path: '/wt/land', branch: 'timon/merge/t', base: 'feat/job', sourceRepo: '/repo' };

test('the brief merges the branch on a detached copy of the target, then moves the target', () => {
  const task = mkTask('merge', { landing: 'local', base: 'feat/job', mode: 'branch', baseRef: 'refs/heads/main' });
  const brief = worktreeDirective(task, WT, 'feat/other');
  assert.match(brief, /## Your task: merge the job's branch into main/);
  assert.match(brief, /git checkout --detach main\ngit merge --no-ff -m "merge: integrate feat\/job into main" feat\/job/);
  // The user is not on main: by reference.
  assert.match(brief, /git -C \/repo push \. \$\(git rev-parse HEAD\):refs\/heads\/main/);
  assert.match(brief, /--merged-sha "\$\(git -C \/repo rev-parse main\)"/);
  assert.doesNotMatch(brief, /pr open/);
  // The user stands on main: the fast-forward goes through their checkout.
  assert.match(worktreeDirective(task, WT, 'main'), /git -C \/repo merge --ff-only \$\(git rev-parse HEAD\)/);
});

test('a local landing task only starts in a job on a branch of its own in a project that merges locally', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    for (const opts of [
      { base: 'feat/job' },
      { base: 'feat/job', mode: 'pr', baseRef: 'origin/main' },
      { base: 'sec/fix', mode: 'branch', baseRef: 'origin/main' },
    ]) {
      const task = mkTask('merge', { landing: 'local', ...opts });
      assert.equal(await blockIfBaseUnavailable(task), true, JSON.stringify(opts));
      const row = dbApi.getTask(task.id)!;
      assert.equal(decodeDaemonMessage(row.blocked_reason_code)?.code, 'integration_branch_unavailable');
      assert.match(row.blocked_reason ?? '', /merges the job's branch into its local target/);
    }
    const ok = mkTask('merge', { landing: 'local', base: 'feat/job', mode: 'branch', baseRef: 'refs/heads/main' });
    assert.equal(await blockIfBaseUnavailable(ok), false);
    assert.equal(git(repo, 'rev-parse', 'feat/job'), git(repo, 'rev-parse', 'feat/job'));
  } finally {
    cleanup();
  }
});

test('the close is proven by git: in the target, carrying the branch', () => {
  const { repo, cleanup } = mkRepo();
  try {
    const task = mkTask('merge', { landing: 'local', base: 'feat/job', mode: 'branch', baseRef: 'refs/heads/main' });
    const before = git(repo, 'rev-parse', 'main');
    const branchTip = git(repo, 'rev-parse', 'feat/job');
    assert.match(mergeCloseRefusal(task, null) ?? '', /close it with the sha of the merge/);
    // main as it was: in the target, without the branch.
    assert.match(mergeCloseRefusal(task, before) ?? '', /does not contain feat\/job/);
    // The branch's tip alone: not in main yet.
    assert.match(mergeCloseRefusal(task, branchTip) ?? '', /is not in main/);
    assert.match(mergeCloseRefusal(task, 'f'.repeat(40)) ?? '', /does not exist in this repository/);
    const merged = mergeIntoMain(repo);
    assert.equal(mergeCloseRefusal(task, merged), null);
  } finally {
    cleanup();
  }
});

test('its DONE lands the job: the integration is merged and the ideas close', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    const todo = dbApi.insertProjectTodo({ text: `local landing ${randomUUID()}`, project: PROJECT });
    const row = dbApi.recordIntegration({ repo, branch: 'feat/job', remote: '', target: 'main', mode: 'branch', project: PROJECT });
    const code = mkTask('code', { base: 'feat/job', mode: 'branch', baseRef: 'refs/heads/main', todoId: todo.id, pipeline: 'code-self' });
    dbApi.setTaskMergedSha(code.id, git(repo, 'rev-parse', 'feat/job'));
    dbApi.updateTaskStatus(code.id, 'DONE', { doneComment: 'merged into feat/job' });
    // Integrated into the branch only: the idea waits.
    applyTodoClosure(dbApi.getTask(code.id)!);
    assert.equal(dbApi.getProjectTodo(todo.id)?.progress, 'partial');
    const land = mkTask('merge', {
      deps: [code.id], landing: 'local', base: 'feat/job', mode: 'branch', baseRef: 'refs/heads/main',
    });
    // Not DONE yet: nothing lands.
    assert.equal(await landLocalLanding(land.id, () => true), false);
    assert.equal(dbApi.getIntegrationById(row.id)?.state, 'branch');

    const merged = mergeIntoMain(repo);
    dbApi.setTaskMergedSha(land.id, merged);
    dbApi.updateTaskStatus(land.id, 'DONE', { doneComment: 'feat/job merged into main' });
    const told: string[] = [];
    assert.equal(await landPendingLocalLandings((id, outcome) => { told.push(`${id}:${outcome}`); return true; }), 1);
    const landed = dbApi.getIntegrationById(row.id)!;
    assert.equal(landed.state, 'merged');
    assert.equal(landed.merge_sha, merged);
    assert.deepEqual(told, [`${row.id}:merged`]);
    assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'done');
    // Once: a second pass finds nothing to land.
    assert.equal(await landLocalLanding(land.id, () => true), false);
    assert.equal(await landPendingLocalLandings(() => true), 0);
  } finally {
    cleanup();
  }
});

test('a job kept on its branch never lands by itself: its ideas stay partial', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    const row = dbApi.recordIntegration({ repo, branch: 'feat/job', remote: '', target: 'main', mode: 'branch', project: PROJECT });
    const code = mkTask('code', { base: 'feat/job', mode: 'branch', baseRef: 'refs/heads/main' });
    dbApi.updateTaskStatus(code.id, 'DONE', { doneComment: 'merged into feat/job' });
    assert.equal(await landPendingLocalLandings(() => true), 0);
    assert.equal(dbApi.getIntegrationById(row.id)?.state, 'branch');
  } finally {
    cleanup();
  }
});
