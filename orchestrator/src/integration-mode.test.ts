/**
 * Project integration mode: `local` (default) keeps today's briefs, and
 * `pull-request` replaces the coder and merger briefs. The daemon never calls
 * the forge; the brief names the one command.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbApi, type TaskRow } from './db.js';
import { agentDir } from './paths.js';
import { readMeta, writeMeta, writeRoles } from './projects.js';
import { parseProjectMetaBody } from './project-service.js';
import { pipelineDirective, worktreeDirective } from './dispatcher.js';
import { runVerificationChain } from './verification-loop.js';
import { integrationSettings } from './integration-mode.js';
import type { WorktreeInfo } from './worktree.js';
await import('../tests/helpers/claude-provider.js');
{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

function mkAgent(name: string, cwd: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd, role: 'merger' }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
}

function mkTask(
  type: TaskRow['type'],
  project: string | null,
  opts: { base?: string | null; pipeline?: 'code-self' | 'code-group'; agent?: string } = {},
): TaskRow {
  const id = randomUUID();
  dbApi.createTask(id, `${type} fixture`, opts.agent ?? 'integration.coder', {
    type,
    project,
    baseBranch: opts.base,
    pipeline: opts.pipeline,
  });
  return dbApi.getTask(id)!;
}

function wt(task: TaskRow, branch: string, base: string): WorktreeInfo {
  return { taskId: task.id, path: `/wt/${task.id}`, branch, base, sourceRepo: '/repo' };
}

test('an invalid integration setting is refused, and a valid one round-trips', () => {
  const badMode = parseProjectMetaBody({ integration: 'git' });
  const badStrategy = parseProjectMetaBody({ merge_strategy: 'ff' });
  assert.ok('error' in badMode);
  assert.ok('error' in badStrategy);

  const set = parseProjectMetaBody({ integration: 'pull-request', merge_strategy: 'rebase' });
  assert.ok(!('error' in set));
  if ('error' in set) return;
  writeMeta('intpr', set.meta);
  assert.equal(readMeta('intpr').integration, 'pull-request');
  assert.equal(readMeta('intpr').merge_strategy, 'rebase');
  assert.deepEqual(integrationSettings('intpr'), { mode: 'pull-request', strategy: 'rebase' });

  const local = parseProjectMetaBody({ integration: 'local' });
  assert.ok(!('error' in local));
  if ('error' in local) return;
  writeMeta('intlocal', local.meta);
  assert.equal(readMeta('intlocal').integration, 'local');
  assert.deepEqual(integrationSettings('intlocal'), { mode: 'local', strategy: 'squash' });

  const cleared = parseProjectMetaBody({ integration: '', merge_strategy: '' });
  assert.ok(!('error' in cleared));
  if ('error' in cleared) return;
  writeMeta('intpr', cleared.meta);
  assert.equal(readMeta('intpr').integration, null);
  assert.equal(readMeta('intpr').merge_strategy, null);
  assert.deepEqual(integrationSettings('intpr'), { mode: 'local', strategy: 'squash' });

  assert.deepEqual(integrationSettings(null), { mode: 'local', strategy: 'squash' });
  assert.deepEqual(integrationSettings(undefined), { mode: 'local', strategy: 'squash' });
  assert.deepEqual(integrationSettings('missing-project'), { mode: 'local', strategy: 'squash' });
  assert.deepEqual(integrationSettings('../not a slug'), { mode: 'local', strategy: 'squash' });
});

test('local mode is the default and keeps the historical briefs', () => {
  const code = { id: 'bare-code', type: 'code', project: null, agent_name: '' } as TaskRow;
  const codeBrief = worktreeDirective(code, wt(code, 'timon/task/bare-code', 'main'));
  assert.doesNotMatch(codeBrief, /pull-request/);
  assert.doesNotMatch(codeBrief, /gh pr/);

  const merge = { id: 'bare-merge', type: 'merge', project: null, agent_name: '' } as TaskRow;
  const mergeBrief = worktreeDirective(merge, wt(merge, 'timon/merge/bare-merge', 'main'), 'main');
  assert.match(mergeBrief, /git -C \/repo merge --ff-only timon\/merge\/bare-merge/);
  assert.doesNotMatch(mergeBrief, /gh pr merge/);

  const self = {
    id: 'bare-self', type: 'code', pipeline: 'code-self', project: null, agent_name: '',
    base_branch: 'main', branch_name: 'timon/task/x',
  } as TaskRow;
  const selfBrief = pipelineDirective(self);
  assert.match(selfBrief, /the user chose the fast mode/);
  assert.match(selfBrief, /git merge --no-ff -m "merge: integrate the task branch into main" timon\/task\/x/);
});

async function passingMerge(slug: string, strategyFlag: 'squash' | 'rebase'): Promise<string> {
  writeMeta(slug, { integration: 'pull-request', merge_strategy: strategyFlag === 'squash' ? null : 'rebase' });
  const agent = `${slug}.merger`;
  mkAgent(agent, tmpdir());
  writeRoles(slug, { merge: { agent, backend: 'claude', model: 'sonnet' } });
  const root = mkTask('code', slug, { base: 'main', agent: `${slug}.coder` });
  dbApi.setTaskWorktree(root.id, `/wt/${root.id}`, `timon/task/${root.id}`, 'main');
  const review = mkTask('review', slug, { agent });
  dbApi.setTaskVerificationMeta(review.id, 1, root.id);
  dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: pass' });
  await runVerificationChain(dbApi.getTask(review.id)!);
  const merge = dbApi.listTasks().find((t) => t.type === 'merge' && t.deps.includes(review.id));
  assert.ok(merge, 'merge task created');
  return merge.description ?? '';
}

test('the merge brief follows the mode and the forge strategy', async () => {
  const squash = await passingMerge('intmerge', 'squash');
  assert.match(squash, /gh pr merge <n> --squash --delete-branch/);
  assert.equal(squash.split('gh pr merge <n> --squash --delete-branch').length - 1, 1);
  assert.doesNotMatch(squash, /merge --ff-only/);
  assert.doesNotMatch(squash, /git merge --no-ff/);
  assert.match(squash, /timon task block/);

  const rebase = await passingMerge('intrebase', 'rebase');
  assert.match(rebase, /gh pr merge <n> --rebase --delete-branch/);
  assert.doesNotMatch(rebase, /--squash/);
  assert.doesNotMatch(rebase, /git merge --no-ff/);

  writeMeta('intwt', { integration: 'pull-request' });
  const task = mkTask('merge', 'intwt', { base: 'main' });
  const brief = worktreeDirective(task, wt(task, `timon/merge/${task.id}`, 'main'), 'feature');
  assert.match(brief, /gh pr merge <n> --squash --delete-branch/);
  assert.doesNotMatch(brief, /merge --ff-only/);
  assert.doesNotMatch(brief, /push \./);
  assert.doesNotMatch(brief, /git merge --no-ff/);
  assert.match(brief, /Do not integrate into `main`/);
});

test('a coding brief in pull-request mode pushes and opens one pull request', () => {
  writeMeta('intcode', { integration: 'pull-request' });
  const task = mkTask('code', 'intcode', { base: 'main' });
  const brief = worktreeDirective(task, wt(task, 'timon/task/feature', 'main'));
  assert.match(brief, /explicit push authorisation/);
  assert.match(brief, /git push -u origin timon\/task\/feature/);
  assert.match(brief, /gh pr create --base main --head timon\/task\/feature/);
  assert.match(brief, /gh pr list --head main --state open/);
  assert.match(brief, /git push origin HEAD:main/);
  assert.match(brief, /Do not open a second pull request/);
  assert.doesNotMatch(brief, /git merge --no-ff/);
  assert.doesNotMatch(brief, /merge --ff-only/);

  const self = mkTask('code', 'intcode', { base: 'main', pipeline: 'code-self' });
  dbApi.setTaskWorktree(self.id, `/wt/${self.id}`, `timon/task/${self.id}`, 'main');
  const stored = dbApi.getTask(self.id)!;
  const selfBrief = pipelineDirective(stored);
  assert.match(selfBrief, /the user chose the fast mode/);
  assert.match(selfBrief, /gh pr merge <n> --squash --delete-branch/);
  assert.doesNotMatch(selfBrief, /git merge --no-ff/);

  const group = pipelineDirective(mkTask('code', 'intcode', { pipeline: 'code-group' }));
  assert.match(group, /the user chose the fast mode/);
  assert.match(group, /pull-request/);
  assert.match(group, /Do not integrate locally/);
  assert.doesNotMatch(group, /git merge --no-ff/);
});

test('a chained fix keeps the pull-request branch as its base and does not fast-forward it', async () => {
  const slug = 'intfix';
  writeMeta(slug, { integration: 'pull-request' });
  const agent = `${slug}.merger`;
  mkAgent(agent, tmpdir());
  writeRoles(slug, { merge: { agent, backend: 'claude', model: 'sonnet' } });

  const root = mkTask('code', slug, { base: 'timon/task/open-pr', agent: `${slug}.coder` });
  dbApi.setTaskWorktree(root.id, `/wt/${root.id}`, 'timon/task/fix-1', 'timon/task/open-pr');
  const review = mkTask('review', slug, { agent });
  dbApi.setTaskVerificationMeta(review.id, 1, root.id);
  dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: changes_requested\n\nRename the helper.' });
  await runVerificationChain(dbApi.getTask(review.id)!);

  const fix = dbApi.listTasks().find((t) => t.type === 'code' && t.id !== root.id && t.deps.includes(review.id));
  assert.ok(fix, 'repair iteration created');
  assert.equal(fix.base_branch, 'timon/task/open-pr');
  assert.equal(fix.branch_name, 'timon/task/fix-1');
  const coderBrief = worktreeDirective(fix, wt(fix, 'timon/task/fix-1', 'timon/task/open-pr'));
  assert.match(coderBrief, /git push origin HEAD:timon\/task\/open-pr/);
  assert.match(coderBrief, /Do not open a second pull request/);
  assert.doesNotMatch(coderBrief, /merge --ff-only/);
  assert.doesNotMatch(coderBrief, /git merge --no-ff/);

  const pass = mkTask('review', slug, { agent });
  dbApi.setTaskVerificationMeta(pass.id, 1, root.id);
  dbApi.updateTaskStatus(pass.id, 'DONE', { doneComment: 'verdict: pass' });
  await runVerificationChain(dbApi.getTask(pass.id)!);
  const merge = dbApi.listTasks().find((t) => t.type === 'merge' && t.deps.includes(pass.id));
  assert.ok(merge, 'merge task created');
  assert.equal(merge.base_branch, 'timon/task/open-pr');
  const text = merge.description ?? '';
  assert.match(text, /gh pr list --head timon\/task\/fix-1 --state open/);
  assert.match(text, /gh pr list --head timon\/task\/open-pr --state open/);
  assert.match(text, /gh pr merge <n> --squash --delete-branch/);
  assert.match(text, new RegExp(`timon worktree dispose ${root.id}`));
  assert.doesNotMatch(text, /merge --ff-only/);
  assert.doesNotMatch(text, /git merge --no-ff/);
  assert.doesNotMatch(text, /git push /);
});
