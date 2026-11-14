/**
 * `ctx.worktrees` — the git worktree of a Kanban task, as a plugin reaches it.
 * Refusals come first: manifest, anonymous, a task outside the caller's view,
 * a dispose that would destroy unmerged work, a base that is an option for git.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-worktrees-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginWorktreeError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { upsertAgent } = await import('../agent.js');
const { hashPassword } = await import('../users/password.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });

type Identity = Parameters<typeof runPluginRequest>[0];
const identityOf = (user: { id: string; email: string; name: string }): Identity => ({
  viewer: { id: user.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(user.id) },
  user: { id: user.id, email: user.email, name: user.name, is_superadmin: false },
  ownerUserId: user.id,
});
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(bob), fn);
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };

async function pluginWith(permissions: string[], id = 'acme-worktrees') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const code = (c: string) => (err: unknown) => err instanceof PluginWorktreeError && err.code === c;

const repo = mkdtempSync(join(tmpdir(), 'timon-plugin-worktrees-repo-'));
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
git('init', '-b', 'main');
git('config', 'user.name', 'Test');
git('config', 'user.email', 'test@example.invalid');
writeFileSync(join(repo, 'README.md'), 'hello');
git('add', '.');
git('commit', '-m', 'init');

upsertAgent({ name: 'wt-coder', system_prompt: 'coder', config: { role: 'coder', cwd: repo } });
upsertAgent({ name: 'wt-nowhere', system_prompt: 'coder', config: { role: 'coder', cwd: mkdtempSync(join(tmpdir(), 'timon-plugin-worktrees-nogit-')) } });
const task = (id: string, owner: string, agent = 'wt-coder') => dbApi.createTask(id, `task ${id}`, agent, { ownerUserId: owner, type: 'code' });
task('wt-ada-1', ada.id);
task('wt-ada-2', ada.id);
task('wt-bob-1', bob.id);
task('wt-job-1', 'plugin:acme-worktrees');
task('wt-nogit', ada.id, 'wt-nowhere');

test('without `worktrees:*` in the manifest the facade refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  await assert.rejects(asAda(() => plugin.worktrees.info('wt-ada-1')), PluginPermissionError);
  await assert.rejects(asAda(() => plugin.worktrees.create('wt-ada-1')), PluginPermissionError);
  await assert.rejects(asAda(() => plugin.worktrees.dispose('wt-ada-1')), PluginPermissionError);
  await dispose();
});

test('`worktrees:read` reads but neither creates nor disposes', async () => {
  const { plugin, dispose } = await pluginWith(['worktrees:read']);
  assert.deepEqual(await asAda(() => plugin.worktrees.info('wt-ada-1')), {
    taskId: 'wt-ada-1', path: null, branch: null, base: null, mergedCommitSha: null,
  });
  await assert.rejects(asAda(() => plugin.worktrees.create('wt-ada-1')), PluginPermissionError);
  await assert.rejects(asAda(() => plugin.worktrees.dispose('wt-ada-1')), PluginPermissionError);
  assert.equal(dbApi.getTask('wt-ada-1')?.worktree_path, null);
  await dispose();
});

test('an anonymous request is refused', async () => {
  const { plugin, dispose } = await pluginWith(['worktrees:manage']);
  await assert.rejects(runPluginRequest(anonymous, () => plugin.worktrees.info('wt-ada-1')), PluginCallerError);
  await assert.rejects(runPluginRequest(anonymous, () => plugin.worktrees.create('wt-ada-1')), PluginCallerError);
  await assert.rejects(runPluginRequest(anonymous, () => plugin.worktrees.dispose('wt-ada-1')), PluginCallerError);
  await dispose();
});

test('another account’s task, and a task outside a job’s view, answer as one that does not exist', async () => {
  const { plugin, dispose } = await pluginWith(['worktrees:manage']);
  assert.equal(await asBob(() => plugin.worktrees.info('wt-ada-1')), undefined);
  await assert.rejects(asBob(() => plugin.worktrees.create('wt-ada-1')), code('not_found'));
  await assert.rejects(asBob(() => plugin.worktrees.dispose('wt-ada-1')), code('not_found'));
  await assert.rejects(asAda(() => plugin.worktrees.create('wt-no-such-task')), code('not_found'));
  assert.equal(await plugin.worktrees.info('wt-ada-1'), undefined, 'a job does not see an account’s task');
  await assert.rejects(plugin.worktrees.create('wt-ada-1'), code('not_found'));
  assert.equal(dbApi.getTask('wt-ada-1')?.worktree_path, null);
  await dispose();
});

test('create refuses a base that git would read as an option, and a task whose agent has no repository', async () => {
  const { plugin, dispose } = await pluginWith(['worktrees:manage']);
  await assert.rejects(asAda(() => plugin.worktrees.create('wt-ada-1', { base: '--upload-pack=evil' })), code('invalid'));
  await assert.rejects(asAda(() => plugin.worktrees.create('wt-ada-1', { base: 42 as never })), code('invalid'));
  await assert.rejects(asAda(() => plugin.worktrees.create('wt-nogit')), code('invalid'));
  assert.equal(dbApi.getTask('wt-ada-1')?.worktree_path, null);
  await dispose();
});

test('create → refuses a second worktree → dispose is refused until the task is DONE and merged', async () => {
  const { plugin, dispose } = await pluginWith(['worktrees:manage']);
  const made = await asAda(() => plugin.worktrees.create('wt-ada-2', { base: 'main' }));
  assert.equal(made.taskId, 'wt-ada-2');
  assert.equal(made.branch, 'timon/task/wt-ada-2');
  assert.equal(made.base, 'main');
  assert.ok(made.path && existsSync(made.path));
  assert.equal((await asAda(() => plugin.worktrees.info('wt-ada-2')))?.path, made.path);
  await assert.rejects(asAda(() => plugin.worktrees.create('wt-ada-2')), code('conflict'));

  // Live task: the coder's uncommitted work would go with it.
  await assert.rejects(asAda(() => plugin.worktrees.dispose('wt-ada-2')), code('conflict'));
  await assert.rejects(asAda(() => plugin.worktrees.dispose('wt-ada-2', { force: true })), code('conflict'));
  // DONE but never merged: the branch would be lost with it.
  dbApi.updateTaskStatus('wt-ada-2', 'DONE', { doneComment: 'finished' });
  await assert.rejects(asAda(() => plugin.worktrees.dispose('wt-ada-2')), code('conflict'));
  assert.ok(existsSync(made.path!), 'nothing was removed');

  dbApi.setTaskMergedSha('wt-ada-2', 'a'.repeat(40));
  assert.deepEqual(await asAda(() => plugin.worktrees.dispose('wt-ada-2', { force: true })), { disposed: true });
  assert.equal(existsSync(made.path!), false);
  assert.equal(dbApi.getTask('wt-ada-2')?.worktree_path, null);
  // Idempotent: nothing left to dispose.
  assert.deepEqual(await asAda(() => plugin.worktrees.dispose('wt-ada-2')), { disposed: false });
  await assert.rejects(asAda(() => plugin.worktrees.create('wt-ada-2')), code('conflict'), 'a DONE task takes no new worktree');
  await dispose();
});

test('a job creates the worktree of a task its plugin owns', async () => {
  const { plugin, dispose } = await pluginWith(['worktrees:manage']);
  const made = await plugin.worktrees.create('wt-job-1');
  assert.ok(made.path && existsSync(made.path));
  await assert.rejects(plugin.worktrees.dispose('wt-job-1'), code('conflict'));
  await dispose();
});
