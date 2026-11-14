/**
 * Task lifecycle events as a THIRD-PARTY plugin receives them. The snapshot is
 * the task as the write left it, `origin` names the writer (so a sync drops its
 * own echo), and the audience follows the plugin's reads: its own tasks in its
 * job, a user's tasks inside that user, a granted project in its job — and
 * nobody else's.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-task-events-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { runPluginRequest, currentPluginUser } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { hashPasswordSync } = await import('../users/password.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { withTaskOrigin } = await import('../task-origin.js');
const { agentDir } = await import('../paths.js');
const { resetPluginPolicyState, spawnCardsSettled } = await import('./policy.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const PLUGIN_ID = 'acme-sync';
function member(name: string, withPlugin: boolean) {
  const user = createTestAccount(dbApi, { email: `${name}@example.com`, name, passwordHash: hashPasswordSync(`${name}-secret`), isSuperadmin: false });
  if (withPlugin) {
    grantTestPermissions(dbApi, user.id, [`plugin:${PLUGIN_ID}`]);
  }
  return user;
}
// Ada and Bob may use the plugin; Carol may not.
const ada = member('ada', true);
const bob = member('bob', true);
const carol = member('carol', false);
const asUser = <T>(user: { id: string; email: string; name: string }, fn: () => Promise<T>) => runPluginRequest({
  viewer: { id: user.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(user.id) },
  user: { id: user.id, email: user.email, name: user.name, is_superadmin: false },
  ownerUserId: user.id,
}, fn);

mkdirSync(agentDir('proj-worker'), { recursive: true });
writeFileSync(join(agentDir('proj-worker'), 'config.json'), JSON.stringify({ cwd: process.env.TIMON_HOME, project: 'granted-proj' }));
writeFileSync(join(agentDir('proj-worker'), 'system-prompt.md'), 'Test agent.');

async function pluginWith(permissions: string[]) {
  const holder = new Context();
  let inner!: Context;
  await holder.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id: PLUGIN_ID, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(holder));
  return { plugin, dispose: () => holder.fiber.dispose() };
}

type Seen = { kind: string; taskId: string; who: string; origin: unknown; ev: Record<string, unknown> };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function flush(): Promise<void> { for (let i = 0; i < 4; i += 1) await tick(); }

function listen(plugin: Awaited<ReturnType<typeof pluginWith>>['plugin']): Seen[] {
  const seen: Seen[] = [];
  for (const kind of ['task_created', 'task_updated', 'task_assigned', 'task_deleted', 'task_unblocked'] as const) {
    plugin.events.on(kind, (ev) => {
      seen.push({
        kind, taskId: ev.taskId, origin: ev.origin, ev: ev as unknown as Record<string, unknown>,
        who: currentPluginUser()?.id ?? 'job',
      });
    });
  }
  return seen;
}

test.after(() => resetConfig());

test('subscribing needs kanban:read, as the event carries the task', async () => {
  const blind = await pluginWith(['events:subscribe']);
  assert.throws(() => blind.plugin.events.on('task_created', () => undefined), PluginPermissionError);
  await blind.dispose();
  const noEvents = await pluginWith(['kanban:read']);
  assert.throws(() => noEvents.plugin.events.on('task_created', () => undefined), PluginPermissionError);
  await noEvents.dispose();
});

test('a write by the plugin carries its origin; a write by someone else does not', async () => {
  const { plugin, dispose } = await pluginWith(['kanban:read', 'kanban:write', 'events:subscribe']);
  const seen = listen(plugin);

  const own = await asUser(ada, () => plugin.kanban.add({ title: 'from the plugin', agent: 'worker' }));
  await flush();
  assert.deepEqual(seen.map((s) => s.kind), ['task_created']);
  assert.deepEqual(seen[0]!.origin, { kind: 'plugin', id: PLUGIN_ID });
  assert.equal(seen[0]!.who, ada.id, 'the handler runs as the task\'s owner');
  assert.equal((seen[0]!.ev.task as { title: string }).title, 'from the plugin');

  seen.length = 0;
  withTaskOrigin({ kind: 'user', id: ada.id }, () => dbApi.updateTask(own.id, { title: 'renamed on the board', priority: 5 }));
  await flush();
  assert.deepEqual(seen.map((s) => s.kind), ['task_updated']);
  assert.deepEqual(seen[0]!.origin, { kind: 'user', id: ada.id });
  assert.deepEqual([...(seen[0]!.ev.changed as string[])].sort(), ['priority', 'title']);
  assert.equal((seen[0]!.ev.previous as Record<string, unknown>).title, 'from the plugin');
  await dispose();
});

test('a status move, an assignment and an unblock arrive with the snapshot of the write', async () => {
  const { plugin, dispose } = await pluginWith(['kanban:read', 'kanban:write', 'events:subscribe']);
  const seen = listen(plugin);
  const task = await asUser(ada, () => plugin.kanban.add({ title: 'moves', agent: 'worker' }));
  await flush();
  seen.length = 0;

  dbApi.updateTaskStatus(task.id, 'BLOCKED', { blockedReason: 'why' });
  dbApi.updateTaskStatus(task.id, 'PENDING');
  dbApi.updateTask(task.id, { agentName: 'proj-worker' });
  await flush();
  assert.deepEqual(seen.map((s) => s.kind), ['task_updated', 'task_unblocked', 'task_updated', 'task_updated', 'task_assigned']);
  const statuses = seen.filter((s) => s.kind === 'task_updated').map((s) => (s.ev.task as { status: string }).status);
  assert.deepEqual(statuses, ['BLOCKED', 'PENDING', 'PENDING'], 'each snapshot is the task as ITS write left it');
  assert.equal((seen.at(-1)!.ev as { previousAgent: string }).previousAgent, 'worker');
  await dispose();
});

test('the deleted event holds the task and its links, taken before the cascade', async () => {
  const { plugin, dispose } = await pluginWith(['kanban:read', 'kanban:write', 'kanban:delete', 'events:subscribe']);
  const seen = listen(plugin);
  const { task } = await asUser(ada, () => plugin.kanban.ensure({ title: 'to delete', agent: 'worker', mirror: true }, [{ provider: 'github', ref: 'o/r#9' }]));
  await flush();
  seen.length = 0;
  await asUser(ada, () => plugin.kanban.delete(task.id));
  await flush();
  assert.deepEqual(seen.map((s) => s.kind), ['task_deleted']);
  const snap = seen[0]!.ev.task as { id: string; mirror: boolean; links: { provider: string; ref: string }[] };
  assert.equal(snap.id, task.id);
  assert.equal(snap.mirror, true);
  assert.deepEqual(snap.links.map((l) => [l.provider, l.ref]), [['github', 'o/r#9']]);
  assert.deepEqual(seen[0]!.origin, { kind: 'plugin', id: PLUGIN_ID });
  await dispose();
});

test('a task of an account that may not use the plugin, a system task and another plugin\'s task never arrive', async () => {
  const { plugin, dispose } = await pluginWith(['kanban:read', 'kanban:write', 'events:subscribe']);
  const seen = listen(plugin);
  const mk = (title: string, ownerUserId: string | null) => {
    const id = crypto.randomUUID();
    dbApi.createTask(id, title, 'worker', { ownerUserId });
    return id;
  };
  const carols = mk('carol task', carol.id);
  const system = mk('system task', null);
  const other = mk('other plugin task', 'plugin:someone-else');
  const mine = mk('job task', `plugin:${PLUGIN_ID}`);
  dbApi.updateTask(carols, { title: 'carol renamed' });
  dbApi.deleteTask(system);
  dbApi.updateTask(other, { title: 'other renamed' });
  await flush();
  const titles = seen.map((s) => (s.ev.task as { title: string }).title);
  assert.deepEqual(titles, ['job task'], 'only the plugin\'s own job task');
  void mine;
  await dispose();
});

test('an account that may use the plugin gets its tasks inside its own identity', async () => {
  const { plugin, dispose } = await pluginWith(['kanban:read', 'kanban:write', 'events:subscribe']);
  const seen = listen(plugin);
  const adas = crypto.randomUUID();
  const bobs = crypto.randomUUID();
  dbApi.createTask(adas, 'ada board task', 'worker', { ownerUserId: ada.id });
  dbApi.createTask(bobs, 'bob board task', 'worker', { ownerUserId: bob.id });
  await flush();
  assert.deepEqual(seen.map((s) => [s.taskId, s.who]), [[adas, ada.id], [bobs, bob.id]], 'each task is served as its own owner, never as another account');
  await dispose();
});

test('a granted project reaches the job, only with the manifest permission and the operator\'s grant', async () => {
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { kanban: { projects: { [PLUGIN_ID]: ['granted-proj'] } } } }));
  const asking = await pluginWith(['kanban:read', 'kanban:read:project', 'events:subscribe']);
  const quiet = await pluginWith(['kanban:read', 'events:subscribe']);
  const seenAsking = listen(asking.plugin);
  const seenQuiet = listen(quiet.plugin);

  const inGrant = crypto.randomUUID();
  const outside = crypto.randomUUID();
  dbApi.createTask(inGrant, 'in granted-proj', 'proj-worker', { ownerUserId: carol.id });
  dbApi.createTask(outside, 'outside', 'worker', { ownerUserId: carol.id });
  await flush();
  assert.deepEqual(seenAsking.map((s) => [s.taskId, s.who]), [[inGrant, 'job']]);
  assert.deepEqual(seenQuiet, []);
  resetConfig();
  await asking.dispose();
  await quiet.dispose();
});

test('a handler that throws does not stop the next event, and unloading stops delivery', async () => {
  const { plugin, dispose } = await pluginWith(['kanban:read', 'kanban:write', 'events:subscribe']);
  let calls = 0;
  plugin.events.on('task_created', () => { calls += 1; throw new Error('boom'); });
  // Tasks opened by a job run: the operator approved the plugin (TODO #562).
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn: { approved: [PLUGIN_ID] } } }));
  const quietLog = console.error; console.error = () => undefined;
  try {
    await plugin.kanban.add({ title: 'one', agent: 'worker' });
    await plugin.kanban.add({ title: 'two', agent: 'worker' });
    await flush();
    assert.equal(calls, 2);
    await dispose();
    await plugin.kanban.add({ title: 'three', agent: 'worker' }).catch(() => undefined);
    await flush();
    assert.equal(calls, 2, 'a disposed plugin is not called');
  } finally { console.error = quietLog; resetConfig(); }
});

test('a handler runs with nobody in front: an unapproved plugin opens no task that runs from it (TODO #562)', async () => {
  const { plugin, dispose } = await pluginWith(['kanban:read', 'kanban:write', 'events:subscribe', 'todos:read', 'todos:write']);
  const policy = (approved: string[]) => {
    setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn: { approved } } }));
    resetPluginPolicyState();
  };
  type Outcome = { who: string; created?: { id: string; owner_user_id: string | null }; code?: string; reason?: string };
  const outcomes: Outcome[] = [];
  const settle = async (fn: () => Promise<{ id: string; owner_user_id: string | null }>) => {
    const who = currentPluginUser()?.id ?? 'job';
    try { outcomes.push({ who, created: await fn() }); } catch (err) {
      const { code, reason } = err as { code?: string; reason?: string };
      outcomes.push({ who, code, reason });
    }
  };
  // Ada's board task triggers a follow-up and the promotion of Ada's idea;
  // the plugin's own follow-ups are not reacted to (no loop).
  let trigger = '';
  let idea = 0;
  plugin.events.on('task_created', async (ev) => {
    if (ev.taskId !== trigger) return;
    await settle(() => plugin.kanban.add({ title: `follow-up of ${ev.taskId}`, agent: 'worker' }));
    await settle(async () => (await plugin.kanban.todos.promote(idea, { agent: 'worker' })).task as { id: string; owner_user_id: string | null });
  });
  const tasks = () => dbApi.listTasks().length;
  try {
    policy([]);
    idea = dbApi.insertProjectTodo({ text: 'Ada idea', ownerUserId: ada.id }).id;
    const before = tasks();
    trigger = crypto.randomUUID();
    dbApi.createTask(trigger, 'ada board task', 'worker', { ownerUserId: ada.id });
    await flush();
    assert.deepEqual(outcomes, [
      { who: ada.id, code: 'forbidden', reason: 'spawn_policy' },
      { who: ada.id, code: 'forbidden', reason: 'spawn_policy' },
    ], 'the handler acts for Ada, yet nobody answers for it: refused like a job');
    assert.equal(tasks(), before + 1, 'only the board task: nothing was written by the handler');
    assert.equal(dbApi.getProjectTodo(idea, null)?.promoted_task_id ?? null, null, 'the idea stays unpromoted');
    const cardOf = () => dbApi.listActiveNotifications('action_required').find((n) => n.anchor === `plugin-spawn:${PLUGIN_ID}`);
    await spawnCardsSettled();
    assert.ok(cardOf(), 'the operator is asked on the approval card');

    // Approved by the operator: the same handler opens the task and promotes the idea.
    policy([PLUGIN_ID]);
    outcomes.length = 0;
    trigger = crypto.randomUUID();
    dbApi.createTask(trigger, 'ada second board task', 'worker', { ownerUserId: ada.id });
    await flush(); await flush();
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0]!.created?.owner_user_id, ada.id, 'the follow-up belongs to Ada');
    assert.ok(outcomes[1]!.created?.id, 'the idea is promoted');
    assert.equal(dbApi.getProjectTodo(idea, null)?.promoted_task_id, outcomes[1]!.created!.id);
  } finally {
    resetConfig();
    resetPluginPolicyState();
    await dispose();
  }
});
