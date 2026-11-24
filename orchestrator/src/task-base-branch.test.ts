/**
 * Worktree base chosen at the CREATION of the task.
 *
 * Without it, `createWorktree` falls back on the current branch of the repository, and the
 * repository is shared by all the agents of the project. A worktree could therefore
 * start on another agent's branch, and the merge of a `code-self`
 * pipeline land on its work. That is what cost the evening of
 * 2026-09-05.
 *
 * `node --test --import tsx src/task-base-branch.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-task-base-test-'));

const { dbApi } = await import('./db.js');
const { createWorktree } = await import('./worktree.js');
const { registerRoutes } = await import('./plugins-bundled/kanban/routes.js');

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** A repository with `main` and another agent's branch, ON WHICH it
 *  stayed checked out: the real state of a shared repository in the middle of a series. */
function sharedRepo(): { dir: string; mainSha: string; otherSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-base-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@timon.local');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'a.txt'), 'un\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const mainSha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'timon/task/autre-agent');
  writeFileSync(join(dir, 'b.txt'), 'deux\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'travail en cours d\'un autre agent');
  return { dir, mainSha, otherSha: git(dir, 'rev-parse', 'HEAD') };
}

async function withApi<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  // The operator: writing a task needs an identity holding kanban:write (TODO #752).
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try { return await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

function create(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'volet', agent_name: 'p.coder', type: 'code', ...body }),
  });
}

test('the requested base is persisted in base_branch at creation', async () => {
  await withApi(async (api) => {
    const r = await create(api, { base: 'main' });
    assert.equal(r.status, 201);
    const { task } = await r.json() as { task: { id: string } };
    assert.equal(dbApi.getTask(task.id)?.base_branch, 'main');
  });
});

test('without a base, nothing is set: the former behaviour is intact', async () => {
  await withApi(async (api) => {
    const { task } = await (await create(api, {})).json() as { task: { id: string } };
    assert.equal(dbApi.getTask(task.id)?.base_branch, null);
  });
});

test('a dubious base is refused: it would become a git argument', async () => {
  await withApi(async (api) => {
    for (const base of ['--force', 'main branch', '../evil', 'main.lock', 'main/']) {
      const r = await create(api, { base });
      assert.equal(r.status, 400, `base "${base}" should have been refused`);
    }
  });
});

test("the worktree starts from the requested base, not from another agent's branch", async () => {
  const repo = sharedRepo();
  // The repository stayed on the other agent's branch: that is the exact
  // situation where the "current branch" default turns against us.
  assert.equal(git(repo.dir, 'rev-parse', 'HEAD'), repo.otherSha);

  const wanted = await createWorktree(randomUUID(), repo.dir, 'main');
  assert.equal(wanted.base, 'main');
  assert.equal(git(wanted.path, 'rev-parse', 'HEAD'), repo.mainSha);

  // And without a base: the current branch is indeed inherited, the documented default,
  // the one an explicit `base` is precisely there to avoid.
  const inherited = await createWorktree(randomUUID(), repo.dir);
  assert.equal(git(inherited.path, 'rev-parse', 'HEAD'), repo.otherSha);
});
