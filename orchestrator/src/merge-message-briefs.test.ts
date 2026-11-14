/**
 * Every `git merge` Timon tells an agent to run carries an explicit message
 * without a task id: git's default names the task branch, which a public
 * repository's `commit-msg` hook refuses. And a refresh refused that way
 * reaches the agent's brief instead of a log line only.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbApi, type TaskRow } from './db.js';
import { agentDir } from './paths.js';
import { writeRoles } from './projects.js';
import { pipelineDirective, resolveWorktree, worktreeDirective } from './dispatcher.js';
import { runVerificationChain } from './verification-loop.js';
import { disposeWorktree, type WorktreeInfo } from './worktree.js';
await import('../tests/helpers/claude-provider.js');
{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const PROJECT = 'msgs';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function mkAgent(name: string, cwd: string, role: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd, role, project: PROJECT }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
}

function mkTask(type: TaskRow['type'], agent: string, opts: { base?: string; pipeline?: 'code-self' } = {}): TaskRow {
  const id = randomUUID();
  dbApi.createTask(id, `${type} fixture`, agent, {
    type, project: PROJECT, baseBranch: opts.base, pipeline: opts.pipeline,
  });
  return dbApi.getTask(id)!;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** Each `git merge …` command the text gives, fast-forwards aside. */
function mergeCommands(text: string): string[] {
  return [...text.matchAll(/git (?:-C \S+ )?merge [^`\n]*/g)]
    .map((m) => m[0])
    .filter((cmd) => !cmd.includes('--ff-only') && !cmd.includes('merge-base'));
}

function assertExplicitMessages(text: string, label: string): void {
  const cmds = mergeCommands(text);
  assert.ok(cmds.length > 0, `${label}: no merge command found`);
  for (const cmd of cmds) {
    assert.match(cmd, / -m "merge: [^"]+"/, `${label}: ${cmd}`);
    const message = /-m "([^"]+)"/.exec(cmd)?.[1] ?? '';
    assert.doesNotMatch(message, UUID_RE, `${label}: ${cmd}`);
    assert.doesNotMatch(message, /timon\/(task|merge)\//, `${label}: ${cmd}`);
  }
}

const fakeWt = (base: string): WorktreeInfo => ({
  taskId: 't', path: '/wt/t', branch: `timon/merge/${randomUUID()}`, base, sourceRepo: '/repo',
});

test('merger brief: every merge it prescribes carries an explicit message, on and off the active branch', () => {
  const task = mkTask('merge', 'msgs.merger');
  for (const active of ['main', 'feat/elsewhere', null]) {
    const brief = worktreeDirective(task, fakeWt('main'), active);
    assertExplicitMessages(brief, `active=${active}`);
    assert.match(brief, /git merge --no-ff -m "merge: integrate the task branch into main" <source-branch>/);
    assert.match(brief, /git commit --no-edit/);
  }
});

test('code-self brief: the coder integrates with an explicit message', () => {
  const task = mkTask('code', 'msgs.coder', { base: 'feat/x', pipeline: 'code-self' });
  const brief = pipelineDirective(task);
  assertExplicitMessages(brief, 'code-self');
  assert.match(brief, /merge: integrate the task branch into feat\/x/);
});

test('automatic merge task: its description gives the merge command with an explicit message', async () => {
  writeRoles(PROJECT, { merge: { agent: 'msgs.merger', backend: 'claude', model: 'sonnet' } });
  mkAgent('msgs.merger', tmpdir(), 'merger');
  const root = mkTask('code', 'msgs.coder', { base: 'main' });
  dbApi.setTaskWorktree(root.id, '/wt/x', `timon/task/${root.id}`, 'main');
  const review = mkTask('review', 'msgs.reviewer');
  dbApi.setTaskVerificationMeta(review.id, 1, root.id);
  dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: pass' });
  await runVerificationChain(dbApi.getTask(review.id)!);
  const merge = dbApi.listTasks().find((t) => t.type === 'merge' && t.deps.includes(review.id));
  assert.ok(merge, 'merge task created');
  assertExplicitMessages(merge.description ?? '', 'merge description');
  assert.match(merge.description ?? '', /git merge --no-ff -m "merge: integrate the task branch into main"/);
});

test('a refresh refused by a hook reaches the brief with its reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-msg-brief-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  let wt: WorktreeInfo | null = null;
  try {
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    const agent = `msgs.coder-${randomUUID().slice(0, 8)}`;
    mkAgent(agent, repo, 'coder');
    const task = mkTask('code', agent, { base: 'main' });
    wt = await resolveWorktree(task);
    assert.ok(wt);
    writeFileSync(join(wt.path, 'b.txt'), 'b\n');
    git(wt.path, 'add', '.');
    git(wt.path, 'commit', '-m', 'task work');
    // Another task lands on the base, then a hook that refuses every message.
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'another task');
    const hook = join(repo, '.git', 'hooks', 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\necho "commit refused: test hook" >&2\nexit 1\n');
    chmodSync(hook, 0o755);

    const again = dbApi.getTask(task.id)!;
    const respawn = await resolveWorktree(again);
    assert.ok(respawn);
    const brief = worktreeDirective(again, respawn);
    assert.match(brief, /NOT brought up to date/);
    assert.match(brief, /commit refused: test hook/);
    assertExplicitMessages(brief, 'failed refresh');
  } finally {
    if (wt) await disposeWorktree(wt, true);
    rmSync(root, { recursive: true, force: true });
  }
});
