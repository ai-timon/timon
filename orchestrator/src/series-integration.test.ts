/**
 * A sequential job of a project that lands through pull requests gets its
 * integration branch from the daemon (`timon pr branch`), cut from the
 * remote's target like a Kanban job's, recorded for its series, and a worktree
 * for its pilot that leaves the branch checked out nowhere.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from './db.js';
import { ensureIntegrationBranch } from './git-integration.js';
import { agentDir } from './paths.js';
import { registerPrRoutes } from './plugins-bundled/kanban/pr-routes.js';
import { updateProjectIntegration } from './project-integration.js';
import { prepareSeriesBranch, SERIES_WORKTREES_ROOT } from './series-integration.js';

// The bare remote lives under the system temporary folder, which the fence
// lets missions write: the daemon's git refuses such a local remote unless no
// filesystem fence is configured (`host/git-neutral.ts`).
writeFileSync(join(process.env.TIMON_HOME!, 'timon.config.json'), JSON.stringify({ host: { isolation: { filesystem: 'off' } } }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const root = mkdtempSync(join(tmpdir(), 'timon-series-branch-'));
after(() => rmSync(root, { recursive: true, force: true }));
const remote = join(root, 'remote.git');
const repo = join(root, 'repo');
execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
execFileSync('git', ['clone', '-q', remote, repo], { stdio: 'ignore' });
git(repo, 'checkout', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), 'hello\n');
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'init');
git(repo, 'push', '-q', 'origin', 'main');
// Local work the user never published: a branch cut from the local main would carry it.
writeFileSync(join(repo, 'local.txt'), 'unpublished\n');
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'local only');
const remoteMain = git(repo, 'rev-parse', 'origin/main');

function mkAgent(name: string, project: string, cwd = repo): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd, role: 'orchestrator', project }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
}

dbApi.upsertProject('seq-pr', { cwd: repo });
updateProjectIntegration('seq-pr', { mode: 'pr', account: 'octocat' });
mkAgent('seq-pr.main', 'seq-pr');
dbApi.upsertProject('seq-local', { cwd: repo });
mkAgent('seq-local.main', 'seq-local');

test('the branch is cut from the remote target, recorded for the series, and the pilot gets a worktree on it', async () => {
  dbApi.createMission('seq-1', 'seq-pr.main', 'job');
  const out = await prepareSeriesBranch('seq-1', 'sequential-job');
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.branch, 'feat/sequential-job');
  assert.equal(out.base_ref, 'origin/main');
  assert.equal(out.created, true);
  assert.equal(out.project, 'seq-pr');
  assert.equal(git(repo, 'rev-parse', 'feat/sequential-job'), remoteMain, 'cut from origin/main, not the local main');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the shared checkout did not move');
  const row = dbApi.getIntegration(repo, 'feat/sequential-job');
  assert.equal(row?.series_id, 'seq-1');
  assert.equal(row?.mode, 'pr');
  assert.equal(row?.state, 'branch');

  assert.equal(out.worktree, join(SERIES_WORKTREES_ROOT, 'seq-1'));
  assert.equal(git(out.worktree, 'rev-parse', 'HEAD'), remoteMain);
  assert.equal(git(out.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached: the branch stays checked out nowhere');

  // The pilot commits and moves the branch by reference, as the plan says.
  writeFileSync(join(out.worktree, 'work.txt'), 'done\n');
  git(out.worktree, 'add', '.');
  git(out.worktree, 'commit', '-q', '-m', 'feat: add the work');
  git(out.worktree, 'push', '-q', '.', 'HEAD:refs/heads/feat/sequential-job');
  const tip = git(out.worktree, 'rev-parse', 'HEAD');
  assert.equal(git(repo, 'rev-parse', 'feat/sequential-job'), tip);

  // Asked again (a resumed job): same branch, same worktree, nothing reset.
  const again = await prepareSeriesBranch('seq-1', 'feat/sequential-job');
  assert.ok(again.ok);
  assert.equal(again.created, false);
  assert.equal(again.sha, tip);
  assert.equal(again.worktree, out.worktree);

  // The series holds its branch: another name is refused.
  const other = await prepareSeriesBranch('seq-1', 'another-name');
  assert.equal(other.ok, false);
  assert.equal(!other.ok && other.code, 'series_branch_refused');
  assert.match(!other.ok ? other.reason : '', /already starts from feat\/sequential-job/);

  // A worktree removed by hand is given back on the branch's tip.
  git(repo, 'worktree', 'remove', out.worktree);
  const back = await prepareSeriesBranch('seq-1', 'sequential-job');
  assert.ok(back.ok);
  assert.ok(existsSync(join(back.worktree, 'work.txt')));
});

test('a name another job holds is refused, never renumbered behind the plan', async () => {
  dbApi.createMission('seq-2', 'seq-pr.main', 'job');
  const out = await prepareSeriesBranch('seq-2', 'sequential-job');
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.code, 'series_branch_refused');
  assert.match(!out.ok ? out.reason : '', /feat\/sequential-job-2/);
  assert.equal(dbApi.listIntegrationsBySeries('seq-2').length, 0);
  for (const bad of ['timon/task/x', 'feat/0123abcd-fix', 'feat/a..b']) {
    const refused = await prepareSeriesBranch('seq-2', bad);
    assert.equal(!refused.ok && refused.code, 'series_branch_refused', bad);
  }
});

test('a remote that cannot be reached refuses; nothing is cut from the local base', async () => {
  dbApi.createMission('seq-3', 'seq-pr.main', 'job');
  const out = await prepareSeriesBranch('seq-3', 'offline-job', {
    ensureBranch: async () => ({ ok: false, code: 'remote_unreachable', reason: 'cannot fetch main from remote origin' }),
  });
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.code, 'series_branch_unavailable');
  assert.throws(() => git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/offline-job'));
  assert.equal(dbApi.listIntegrationsBySeries('seq-3').length, 0);
});

test('a project that lands locally, or an unknown series, gets no branch', async () => {
  dbApi.createMission('seq-local-1', 'seq-local.main', 'job');
  const local = await prepareSeriesBranch('seq-local-1', 'local-job');
  assert.equal(!local.ok && local.code, 'series_branch_not_pr');
  const unknown = await prepareSeriesBranch('no-such-series', 'x');
  assert.equal(!unknown.ok && unknown.code, 'series_not_found');
});

test('a project that lands locally, with a branch the plan chose: cut from the local main, worktree given', async () => {
  dbApi.createMission('seq-local-2', 'seq-local.main', 'job');
  dbApi.setSeriesPlanLanding('seq-local-2', {
    project: 'seq-local', repo, branch: 'feat/local-seq', branch_kind: 'new', mode: 'branch',
    base_ref: 'refs/heads/main', finish: 'merge',
  });
  const out = await prepareSeriesBranch('seq-local-2', 'local-seq');
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.branch, 'feat/local-seq');
  assert.equal(out.base_ref, 'refs/heads/main');
  assert.equal(git(repo, 'rev-parse', 'feat/local-seq'), git(repo, 'rev-parse', 'main'), 'cut from the local main, unpublished work included');
  const row = dbApi.getIntegration(repo, 'feat/local-seq');
  assert.deepEqual(row && { mode: row.mode, remote: row.remote, target: row.target }, { mode: 'branch', remote: '', target: 'main' });
  // Another name than the plan's: still no branch for a project that lands locally.
  dbApi.createMission('seq-local-3', 'seq-local.main', 'job');
  dbApi.setSeriesPlanLanding('seq-local-3', {
    project: 'seq-local', repo, branch: 'feat/planned', branch_kind: 'new', mode: 'branch',
    base_ref: 'refs/heads/main', finish: 'keep',
  });
  const other = await prepareSeriesBranch('seq-local-3', 'not-planned');
  assert.equal(!other.ok && other.code, 'series_branch_not_pr');
});

test('a branch the plan chose as existing is taken as it is, and refused when it is gone', async () => {
  git(repo, 'branch', 'feat/ongoing-seq', 'main');
  const tip = git(repo, 'rev-parse', 'feat/ongoing-seq');
  dbApi.createMission('seq-existing', 'seq-pr.main', 'job');
  dbApi.setSeriesPlanLanding('seq-existing', {
    project: 'seq-pr', repo, branch: 'feat/ongoing-seq', branch_kind: 'existing', mode: 'pr',
    base_ref: 'origin/main', finish: 'keep',
  });
  const out = await prepareSeriesBranch('seq-existing', 'feat/ongoing-seq', {
    // No network for a branch the repository has.
    ensureBranch: (at, opts) => (opts.mustExist ? ensureIntegrationBranch(at, opts) : Promise.reject(new Error('cut'))),
  });
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.created, false);
  assert.equal(out.sha, tip);

  dbApi.createMission('seq-gone', 'seq-local.main', 'job');
  dbApi.setSeriesPlanLanding('seq-gone', {
    project: 'seq-local', repo, branch: 'feat/gone', branch_kind: 'existing', mode: 'branch',
    base_ref: 'refs/heads/main', finish: 'merge',
  });
  const gone = await prepareSeriesBranch('seq-gone', 'feat/gone');
  assert.equal(!gone.ok && gone.code, 'series_branch_refused');
  assert.match(!gone.ok ? gone.reason : '', /feat\/gone does not exist in the repository/);
  assert.throws(() => git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/gone'));
});

test('the route: anonymous 401, no kanban:write 403, a series the caller cannot see 404', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.header('x-test-who');
    if (who === 'daemon') req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true };
    else if (who === 'manager') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:manage'] };
    else if (who === 'writer') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['kanban:write'] };
    next();
  });
  let reached = 0;
  registerPrRoutes(app, {
    ensureBranch: async (at, opts) => {
      reached += 1;
      return opts.branch === 'feat/route-job' ? { ok: false, code: 'remote_unreachable', reason: 'stub' } : ensureIntegrationBranch(at, opts);
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (who: string | null, body: unknown, id = 'seq-1') => fetch(`${base}/api/series/${id}/integration-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { 'x-test-who': who } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal((await post(null, { branch: 'x' })).status, 401);
    assert.equal((await post('manager', { branch: 'x' })).status, 403);
    assert.equal((await post('writer', { branch: 'x' })).status, 404, 'a series the caller does not see');
    for (const body of [{}, { branch: '' }, { branch: 'x', force: true }, { branch: 'x'.repeat(201) }]) {
      const res = await post('daemon', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(((await res.json()) as { code: string }).code, 'series_branch_invalid');
    }
    assert.equal(reached, 0);
    dbApi.createMission('seq-route', 'seq-pr.main', 'job');
    const refused = await post('daemon', { branch: 'route-job' }, 'seq-route');
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, 'series_branch_unavailable');
    assert.equal(reached, 1);
    const ok = await post('daemon', { branch: 'sequential-job' });
    assert.equal(ok.status, 200);
    assert.equal(reached, 2);
    assert.equal(((await ok.json()) as { branch: string }).branch, 'feat/sequential-job');
  } finally {
    server.close();
  }
});
