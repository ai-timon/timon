/**
 * What becomes of a repair once asked: nothing is pushed while its chain runs,
 * the branch is pushed forward once the chain integrated new work (after the
 * same checks as the opening, never forced), a repair that changed nothing or
 * stopped on a blocked task says so, and a pull request no longer open ends it.
 * The forge and the remote are fakes: nothing leaves this machine.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { dbApi, type IntegrationRow } from './db.js';
import type { GitNetworkOutcome } from './host/forge.js';
import { pollOpenIntegrations } from './integration-poller.js';
import { advanceRepair, REPAIR_PUSH_ATTEMPTS, type RepairDeps } from './landing-repair.js';
import { updateProjectIntegration } from './project-integration.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-landing-repair-')));
after(() => rmSync(root, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

const repo = join(root, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
git('config', 'user.name', 'Acme Bot');
git('config', 'user.email', 'bot@acme.test');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'a.txt'), 'a\n');
git('add', '-A');
git('commit', '-q', '-m', 'chore: start');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
git('remote', 'add', 'origin', 'git@github.com:acme/app.git');

const SLUG = 'repair-push';
dbApi.upsertProject(SLUG, { cwd: repo });
updateProjectIntegration(SLUG, { mode: 'pr', account: 'ai-bot', remote_url: 'git@github.com:acme/app.git' });

/** Adds a commit on `branch` (created from main when new); returns its sha. */
function commitOn(branch: string, file: string, message: string): string {
  const exists = execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== '';
  git('checkout', '-q', exists ? branch : '-b', ...(exists ? [] : [branch, 'main']));
  writeFileSync(join(repo, file), `${randomUUID()}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', message);
  const sha = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return sha;
}

let jobs = 0;

/** A job whose pull request is open, and a repair asked on it. */
function job(): { row: IntegrationRow; taskId: string; repairId: string; branch: string } {
  jobs += 1;
  const branch = `feat/job-${jobs}`;
  const head = commitOn(branch, `job-${jobs}.txt`, 'feat: start the job');
  const row = dbApi.recordIntegration({ repo, branch, remote: 'origin', target: 'main', mode: 'pr', project: SLUG });
  dbApi.markIntegrationOpen(row.id, { number: 100 + jobs, url: `https://github.com/acme/app/pull/${100 + jobs}`, headSha: head });
  dbApi.setIntegrationChecks(row.id, '{"stale":true}');
  const taskId = randomUUID();
  dbApi.createTask(taskId, `Fix the failing checks: ${branch}`, 'acme.coder', {
    type: 'code', pipeline: 'full', project: SLUG, baseBranch: branch, integrationMode: 'pr', baseRef: 'origin/main',
  });
  dbApi.setTaskWorktree(taskId, join(root, 'wt', taskId), `timon/task/${taskId}`, branch);
  const repairId = randomUUID();
  dbApi.insertLandingRepair({ id: repairId, integrationId: row.id, kind: 'checks', taskId, headBefore: head, createdBy: 'person' });
  return { row: dbApi.getIntegrationById(row.id)!, taskId, repairId, branch };
}

/** The chain of `taskId` converged: review passed, merge done. */
function converge(taskId: string): void {
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'fixed' });
  const reviewId = randomUUID();
  dbApi.createTask(reviewId, 'review', 'acme.reviewer', { type: 'review', deps: [taskId], project: SLUG });
  dbApi.setTaskVerificationMeta(reviewId, 1, taskId);
  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: 'verdict: pass' });
  const mergeId = randomUUID();
  dbApi.createTask(mergeId, 'merge', 'acme.merger', { type: 'merge', deps: [reviewId], project: SLUG });
  dbApi.setTaskMergedSha(mergeId, 'e'.repeat(40));
  dbApi.updateTaskStatus(mergeId, 'DONE', { doneComment: 'merged' });
}

function repairRow(row: IntegrationRow, id: string) {
  return dbApi.listLandingRepairs(row.id).find((r) => r.id === id)!;
}

let pushes: Array<{ url: string; branch: string }> = [];
let pushAnswer: GitNetworkOutcome = { ok: true };
let remoteHead: (branch: string) => string | null = () => null;

const deps: RepairDeps = {
  forge: () => ({
    async login() { return { ok: true, login: 'ai-bot' }; },
    async createPullRequest() { throw new Error('a repair never opens a pull request'); },
    async pullRequestChecks() { throw new Error('pushing reads no checks'); },
    async pullRequestReviewThreads() { throw new Error('pushing reads no threads'); },
    async failedCheckLog() { throw new Error('pushing reads no log'); },
  }),
  transport: () => ({
    async remoteBranchSha(_url, branch) { return { ok: true, sha: remoteHead(branch) }; },
    async fetchBranch() { return { ok: true }; },
    async pushBranch(url, branch) { pushes.push({ url, branch }); return pushAnswer; },
  }),
  publicTree: async () => ({ ran: false }),
};

beforeEach(() => {
  pushes = [];
  pushAnswer = { ok: true };
  remoteHead = () => null;
});

test('while the chain runs, nothing is pushed', async () => {
  const { row, repairId } = job();
  commitOn(row.branch, 'wip.txt', 'fix: work in progress');
  assert.equal(await advanceRepair(repairRow(row, repairId), deps), 'running');
  assert.equal(pushes.length, 0);
});

test('once the chain integrated new work, the branch is pushed forward and the pull request ends on it', async () => {
  const { row, taskId, repairId } = job();
  remoteHead = () => row.head_sha;
  const fixed = commitOn(row.branch, 'fix.txt', 'fix: repair the failing test');
  converge(taskId);
  assert.equal(await advanceRepair(repairRow(row, repairId), deps), 'pushed');
  assert.deepEqual(pushes, [{ url: 'git@github.com:acme/app.git', branch: row.branch }]);
  const after = dbApi.getIntegrationById(row.id)!;
  assert.equal(after.head_sha, fixed);
  assert.equal(after.checks, null, 'the checks of the old head are forgotten');
  const repair = repairRow(row, repairId);
  assert.equal(repair.state, 'pushed');
  assert.equal(repair.head_after, fixed);
  assert.equal(await advanceRepair(repair, deps), 'pushed', 'a concluded repair is not pushed twice');
  assert.equal(pushes.length, 1);
});

test('a repair whose coder changed nothing ends unchanged, without a push', async () => {
  const { row, taskId, repairId } = job();
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'the failure comes from the CI, nothing to change' });
  assert.equal(await advanceRepair(repairRow(row, repairId), deps), 'running', 'its review may still be coming');
  const later: RepairDeps = { ...deps, now: () => Date.now() + 5 * 60_000 };
  assert.equal(await advanceRepair(repairRow(row, repairId), later), 'unchanged');
  assert.equal(pushes.length, 0);
  assert.equal(repairRow(row, repairId).state, 'unchanged');
});

test('a chain stopped on a blocked task ends the repair, for a person to take over', async () => {
  const { row, taskId, repairId } = job();
  dbApi.updateTaskStatus(taskId, 'BLOCKED', { blockedReason: 'cannot reproduce' });
  assert.equal(await advanceRepair(repairRow(row, repairId), deps), 'failed');
  assert.match(repairRow(row, repairId).error ?? '', /blocked/);
  assert.equal(pushes.length, 0);
});

test(`a push the remote refuses is tried again, ${REPAIR_PUSH_ATTEMPTS} times at most`, async () => {
  const { row, taskId, repairId } = job();
  remoteHead = () => row.head_sha;
  commitOn(row.branch, 'fix.txt', 'fix: repair the failing test');
  converge(taskId);
  pushAnswer = { ok: false, reason: 'the remote hung up' };
  for (let i = 1; i < REPAIR_PUSH_ATTEMPTS; i++) {
    assert.equal(await advanceRepair(repairRow(row, repairId), deps), 'running');
  }
  assert.equal(await advanceRepair(repairRow(row, repairId), deps), 'failed');
  assert.equal(pushes.length, REPAIR_PUSH_ATTEMPTS);
  assert.match(repairRow(row, repairId).error ?? '', /hung up/);
  assert.equal(dbApi.getIntegrationById(row.id)!.head_sha, row.head_sha, 'the head is unchanged');
});

test('a check that refuses the branch ends the repair without a push', async () => {
  const { row, taskId, repairId } = job();
  remoteHead = () => row.head_sha;
  commitOn(row.branch, 'fix.txt', `fix: repair ${randomUUID()}`);
  converge(taskId);
  assert.equal(await advanceRepair(repairRow(row, repairId), deps), 'failed');
  assert.match(repairRow(row, repairId).error ?? '', /commit_messages/);
  assert.equal(pushes.length, 0);
});

test('a remote branch that moved on its own is never overwritten', async () => {
  const { row, taskId, repairId } = job();
  remoteHead = () => 'f'.repeat(40);
  commitOn(row.branch, 'fix.txt', 'fix: repair the failing test');
  converge(taskId);
  assert.equal(await advanceRepair(repairRow(row, repairId), deps), 'failed');
  assert.match(repairRow(row, repairId).error ?? '', /remote_branch/);
  assert.equal(pushes.length, 0);
});

test('a pull request closed meanwhile ends the repair, read by the poller without any network', async () => {
  const { row, repairId } = job();
  dbApi.markIntegrationClosed(row.id);
  await pollOpenIntegrations({
    notify: () => true,
    forge: () => ({ async pullRequest() { return { ok: false, code: 'gh_failed', reason: 'offline' }; } }),
    transport: () => ({
      async remoteBranchSha() { return { ok: false, reason: 'offline' }; },
      async fetchBranch() { return { ok: false, reason: 'offline' }; },
      async pushBranch() { throw new Error('the poller pushes through the repair only'); },
    }),
    repairs: deps,
  });
  const repair = repairRow(row, repairId);
  assert.equal(repair.state, 'failed');
  assert.match(repair.error ?? '', /closed/);
  assert.equal(pushes.length, 0);
});
