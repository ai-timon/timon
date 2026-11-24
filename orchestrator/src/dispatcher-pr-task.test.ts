/**
 * The task that opens a job's pull request (`landing = 'pr'`): its brief sends
 * it to `timon pr open` instead of merging a task branch, it never starts in a
 * job that does not land through a pull request, and it closes on the tip it
 * published even when the job's last merge carries the same sha.
 *
 * `npm test -- src/dispatcher-pr-task.test.ts`
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
const { decodeDaemonMessage } = await import('./daemon-message.js');

const AGENT = 'prtask.merger';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function mkRepo(): { repo: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-prtask-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(agentDir(AGENT), { recursive: true });
  writeFileSync(join(agentDir(AGENT), 'config.json'), JSON.stringify({ cwd: repo, role: 'merger' }));
  writeFileSync(join(agentDir(AGENT), 'system-prompt.md'), 'Test');
  return { repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mkTask(type: TaskRow['type'], opts: {
  deps?: string[]; base?: string; landing?: string; mode?: string; baseRef?: string;
} = {}): TaskRow {
  const id = randomUUID();
  dbApi.createTask(id, `${type} fixture`, AGENT, {
    type, deps: opts.deps ?? [], baseBranch: opts.base, landing: opts.landing,
    integrationMode: opts.mode, baseRef: opts.baseRef,
  });
  return dbApi.getTask(id)!;
}

const WT = {
  taskId: 't', path: '/wt/pr', branch: 'timon/merge/t', base: 'feat/topic', sourceRepo: '/repo',
};

test('the pull request brief: bring the target in, move the branch by reference, then pr open', () => {
  const task = mkTask('merge', { landing: 'pr', base: 'feat/topic', mode: 'pr', baseRef: 'origin/main' });
  const brief = worktreeDirective(task, { ...WT, taskId: task.id }, 'main');
  assert.match(brief, /open the job's pull request/);
  assert.match(brief, /git fetch --no-tags origin main/);
  assert.match(brief, /git merge --no-edit -m "merge: bring origin\/main into the task branch" origin\/main/);
  assert.match(brief, /git -C \/repo push \. timon\/merge\/t:feat\/topic/);
  assert.match(brief, /timon pr open <TASK_ID> --title "<title>" --body-file <file>/);
  assert.match(brief, /--merged-sha "\$\(git -C \/repo rev-parse feat\/topic\)"/);
  assert.match(brief, /refuses DONE \(`pr_not_opened`\) until step 4 opened the pull request/);
  assert.match(brief, /Fixes #n/);
  assert.doesNotMatch(brief, /git merge --no-ff/, 'it merges no task branch');
  assert.doesNotMatch(brief, /Integrate each source branch/);
});

test('non-regression: an ordinary merge keeps the merger brief', () => {
  const task = mkTask('merge', { base: 'main' });
  const brief = worktreeDirective(task, { ...WT, taskId: task.id, base: 'main' }, 'feat/other');
  assert.match(brief, /Integrate each source branch/);
  assert.match(brief, /git merge --no-ff -m "merge: integrate the task branch into main"/);
  assert.doesNotMatch(brief, /timon pr open/);
});

test('a pull request task in a job that merges locally is blocked, never started', async () => {
  const { cleanup } = mkRepo();
  try {
    const task = mkTask('merge', { landing: 'pr', base: 'main' });
    assert.equal(await blockIfBaseUnavailable(task), true);
    const row = dbApi.getTask(task.id)!;
    assert.equal(row.status, 'BLOCKED');
    assert.equal(decodeDaemonMessage(row.blocked_reason_code)?.code, 'integration_branch_unavailable');
    assert.match(row.blocked_reason ?? '', /does not land through one \(integration mode "local"\)/);
  } finally {
    cleanup();
  }
});

test('close guard: the pull request task may carry the sha of the job\'s last merge', () => {
  const { repo, cleanup } = mkRepo();
  try {
    git(repo, 'branch', 'feat/topic');
    git(repo, 'checkout', '-q', '-b', 'timon/task/c1');
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    git(repo, 'add', 'c.txt');
    git(repo, 'commit', '-q', '-m', 'the work');
    git(repo, 'checkout', '-q', 'feat/topic');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge: integrate the task branch into feat/topic', 'timon/task/c1');
    git(repo, 'checkout', '-q', 'main');
    const tip = git(repo, 'rev-parse', 'feat/topic');

    const code = mkTask('code', { base: 'feat/topic' });
    dbApi.setTaskWorktree(code.id, join(repo, 'gone'), 'timon/task/c1', 'feat/topic');
    const chainMerge = mkTask('merge', { deps: [code.id], base: 'feat/topic' });
    dbApi.updateTaskStatus(chainMerge.id, 'DONE', { doneComment: 'merged' });
    dbApi.setTaskMergedSha(chainMerge.id, tip);

    const pr = mkTask('merge', { deps: [code.id], base: 'feat/topic', landing: 'pr', mode: 'pr', baseRef: 'origin/main' });
    assert.equal(mergeCloseRefusal(dbApi.getTask(pr.id)!, tip), null);
    // An ordinary merge with the same sha proves nothing of its own: refused as before.
    const twin = mkTask('merge', { deps: [code.id], base: 'feat/topic' });
    assert.match(mergeCloseRefusal(dbApi.getTask(twin.id)!, tip) ?? '', /already the merge of/);
  } finally {
    cleanup();
  }
});
