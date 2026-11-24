/**
 * A chain merged into an integration branch is integrated, not landed: the GC
 * keeps its worktree and branch until the integration is 'merged'
 * (`docs/KANBAN-PR-PIPELINE.md` §2.7). A local chain is unchanged.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { db, dbApi } from './db.js';
import { agentConfig, agentDir } from './paths.js';
import { createWorktree } from './worktree.js';
import { reconcileStaleWorktrees } from './worktree-gc.js';

const repo = join(process.env.TIMON_HOME!, `repo-${randomUUID()}`);
mkdirSync(repo, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 't@example.com');
git(repo, 'config', 'user.name', 'T');
writeFileSync(join(repo, 'a'), '1');
git(repo, 'add', 'a');
git(repo, 'commit', '-q', '-m', 'one');

const agent = `gc-landing-${randomUUID().slice(0, 8)}`;
mkdirSync(agentDir(agent), { recursive: true });
writeFileSync(agentConfig(agent), JSON.stringify({ cwd: repo }));

const LONG_AGO = Date.now() - 24 * 3600_000;

const branchExists = (branch: string): boolean => {
  try { git(repo, 'rev-parse', '--verify', branch); return true; } catch { return false; }
};

/** A DONE task whose branch was merged into `base`, as a merger leaves it. */
async function mergedTask(base: string, mode: string | null): Promise<{ id: string; branch: string; path: string }> {
  const id = randomUUID();
  dbApi.createTask(id, 'feature', agent, { type: 'code', baseBranch: base, integrationMode: mode, baseRef: mode ? 'origin/main' : null });
  const info = await createWorktree(id, repo, base);
  dbApi.setTaskWorktree(id, info.path, info.branch, info.base);
  writeFileSync(join(info.path, `f-${id}`), '2');
  git(info.path, 'add', '.');
  git(info.path, 'commit', '-q', '-m', 'work');
  const tip = git(repo, 'rev-parse', info.branch);
  // Advance the base by reference: it is checked out nowhere.
  git(repo, 'update-ref', `refs/heads/${base}`, tip);
  db.prepare(`UPDATE tasks SET status = 'DONE', merged_commit_sha = ?, updated_at = ? WHERE id = ?`)
    .run(tip, LONG_AGO, id);
  return { id, branch: info.branch, path: info.path };
}

test('a task integrated into a branch that has not landed keeps its worktree and branch, until it lands', async () => {
  git(repo, 'branch', 'feat/landing-guard', 'main');
  const row = dbApi.recordIntegration({ repo, branch: 'feat/landing-guard', remote: 'origin', target: 'main', mode: 'pr' });
  const t = await mergedTask('feat/landing-guard', 'pr');

  await reconcileStaleWorktrees();
  assert.ok(existsSync(t.path), 'worktree kept');
  assert.ok(branchExists(t.branch), 'branch kept');
  assert.equal(dbApi.getTask(t.id)?.worktree_path, t.path);

  db.prepare(`UPDATE integrations SET state = 'closed' WHERE id = ?`).run(row.id);
  await reconcileStaleWorktrees();
  assert.ok(branchExists(t.branch), 'a closed pull request keeps everything');

  dbApi.markIntegrationMerged(row.id, null);
  await reconcileStaleWorktrees();
  assert.equal(existsSync(t.path), false, 'disposed once landed');
  assert.equal(branchExists(t.branch), false);
  assert.ok(branchExists('feat/landing-guard'), 'the integration branch itself is never touched');
});

test('a detached branch integrated into a branch that has not landed is kept too', async () => {
  git(repo, 'branch', 'feat/landing-detached', 'main');
  const row = dbApi.recordIntegration({ repo, branch: 'feat/landing-detached', remote: 'origin', target: 'main', mode: 'pr' });
  const t = await mergedTask('feat/landing-detached', 'pr');
  git(repo, 'worktree', 'remove', '--force', t.path);
  dbApi.detachTaskWorktree(t.id);
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(LONG_AGO, t.id);

  await reconcileStaleWorktrees();
  assert.ok(branchExists(t.branch));

  dbApi.markIntegrationMerged(row.id, null);
  await reconcileStaleWorktrees();
  assert.equal(branchExists(t.branch), false);
});

test('a local chain is unchanged: disposed as soon as it is merged', async () => {
  git(repo, 'branch', 'dev', 'main');
  const t = await mergedTask('dev', null);
  await reconcileStaleWorktrees();
  assert.equal(existsSync(t.path), false);
  assert.equal(branchExists(t.branch), false);
});
