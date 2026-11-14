/**
 * `ctx.routines` (API 10): a plugin schedules recurring work and changes only
 * the routines it created. Refusals come first: permission, kanban:write,
 * anonymous, another plugin's or account's routines, the system routine, the
 * rhythm and the quota.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-routines-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError } = await import('./context.js');
const { PluginAutomationError } = await import('./automation-scope.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { agentDir } = await import('../paths.js');
const { hashPassword } = await import('../users/password.js');
const { createRoutine, enableBackupRoutine, BACKUP_ROUTINE_ID, tickRoutines } = await import('../routines.js');
const { MAX_PLUGIN_ROUTINES } = await import('./routines-facade.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig } = await import('../config/load.js');
const { assertSpawnAllowed, resetPluginPolicyState, spawnCardsSettled } = await import('./policy.js');

// A plugin's routine ticks as the plugin: the operator approved these (TODO #591).
const APPROVED = ['acme-cron', 'acme-own', 'acme-mut', 'acme-mut-other', 'acme-job-r', 'acme-flood-r'];
const policy = (spawn: { approved: string[]; max?: number; windowMs?: number } = { approved: APPROVED }) => {
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn } }));
  resetPluginPolicyState();
};
policy();

mkdirSync(agentDir('worker'), { recursive: true });

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });

type Who = { id: string; email: string; name: string };
const request = (user: Who, over: { superadmin?: boolean; permissions?: string[] } = {}) => ({
  viewer: { id: user.id, isSuperadmin: over.superadmin === true, permissions: over.permissions ?? [] },
  user: { id: user.id, email: user.email, name: user.name, is_superadmin: over.superadmin === true },
  ownerUserId: user.id,
});
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(request(ada, { permissions: ['kanban:write'] }), fn);
const asAdaNoKanban = <T>(fn: () => Promise<T>) => runPluginRequest(request(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob, { permissions: ['kanban:write'] }), fn);
const asAdmin = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob, { superadmin: true }), fn);
const anonymous = <T>(fn: () => Promise<T>) => runPluginRequest({ viewer: null, user: undefined, ownerUserId: null }, fn);

async function pluginWith(permissions: string[], id = 'acme-cron') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: `holder-${id}`, apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const code = (c: string) => (e: unknown) => e instanceof PluginAutomationError && e.code === c;
const input = (name = 'Digest') => ({ name, agent: 'worker', prompt: 'summarise', cron: '0 8 * * *' });

test('each door needs its permission, and writing also needs kanban:write', async () => {
  const none = await pluginWith(['notify']);
  await assert.rejects(asAda(() => none.plugin.routines.list()), PluginPermissionError);
  await none.dispose();

  const reader = await pluginWith(['routines:read', 'kanban:write']);
  await assert.rejects(asAda(() => reader.plugin.routines.create(input())), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.routines.update('x', {})), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.routines.delete('x')), PluginPermissionError);
  assert.deepEqual(await asAda(() => reader.plugin.routines.list()), []);
  await reader.dispose();

  const noKanban = await pluginWith(['routines:write']);
  await assert.rejects(asAda(() => noKanban.plugin.routines.create(input())), (e) => e instanceof PluginPermissionError);
  await assert.rejects(asAda(() => noKanban.plugin.routines.update('x', {})), (e) => e instanceof PluginPermissionError);
  await noKanban.dispose();
});

test('an anonymous request and an account without kanban:write cannot write', async () => {
  const { plugin, dispose } = await pluginWith(['routines:write', 'routines:read', 'kanban:write']);
  await assert.rejects(anonymous(() => plugin.routines.create(input('anon'))), PluginCallerError);
  await assert.rejects(anonymous(() => plugin.routines.list()), PluginCallerError);
  await assert.rejects(asAdaNoKanban(() => plugin.routines.create(input('no right'))), PluginCallerError);
  assert.equal(dbApi.listRoutines().some((r) => r.name === 'anon' || r.name === 'no right'), false);
  await dispose();
});

test('create: owner plugin:<id>, validated input, the tick opens a task owned by the plugin', async () => {
  const { plugin, dispose } = await pluginWith(['routines:write', 'routines:read', 'kanban:write'], 'acme-own');
  const routine = await asAda(() => plugin.routines.create(input()));
  assert.equal(routine.mine, true);
  assert.equal(dbApi.getRoutine(routine.id)!.owner_user_id, 'plugin:acme-own');
  assert.ok(routine.nextRunAt && routine.nextRunAt > Date.now());

  await assert.rejects(plugin.routines.create({ ...input(), agent: 'ghost-agent' }), code('invalid'));
  await assert.rejects(plugin.routines.create({ ...input(), cron: 'nope' }), code('invalid'));
  await assert.rejects(plugin.routines.create({ ...input(), cron: '* * * * *' }), code('invalid'));
  await assert.rejects(plugin.routines.create({ ...input(), prompt: '' }), code('invalid'));
  await assert.rejects(plugin.routines.create({ ...input(), taskType: 'bogus' as never }), code('invalid'));
  await assert.rejects(plugin.routines.create({ ...input(), project: 'no-such-project' }), code('invalid'));
  await assert.rejects(plugin.routines.create({ ...input(), enabled: 'yes' as never }), code('invalid'));

  // The tick: due now -> one task, owned by the plugin.
  dbApi.updateRoutine(routine.id, { next_run_at: Date.now() - 1000 });
  await tickRoutines();
  const task = dbApi.listTasks().find((t) => t.title === 'Digest');
  assert.equal(task?.owner_user_id, 'plugin:acme-own');
  await dispose();
});

test('update and delete reach only the routines the plugin created', async () => {
  const { plugin, dispose } = await pluginWith(['routines:write', 'routines:read', 'kanban:write'], 'acme-mut');
  const other = await pluginWith(['routines:write', 'routines:read', 'kanban:write'], 'acme-mut-other');
  const mine = await plugin.routines.create(input('mine'));
  const theirs = await other.plugin.routines.create(input('theirs'));
  const adas = createRoutine({ name: 'ada routine', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: ada.id });
  const bobs = createRoutine({ name: 'bob routine', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: bob.id });
  enableBackupRoutine();

  // Ada's own hand-made routine is visible but not the plugin's to change.
  assert.ok((await asAda(() => plugin.routines.list())).some((r) => r.id === adas.id && r.mine === false));
  await assert.rejects(asAda(() => plugin.routines.update(adas.id, { name: 'hijack' })), code('forbidden'));
  await assert.rejects(asAda(() => plugin.routines.delete(adas.id)), code('forbidden'));
  // Another account's, another plugin's, and the daemon's own look missing.
  for (const id of [bobs.id, theirs.id, BACKUP_ROUTINE_ID]) {
    assert.equal((await asAda(() => plugin.routines.list())).some((r) => r.id === id), false, id);
    await assert.rejects(asAda(() => plugin.routines.update(id, { name: 'x' })), code('not_found'));
    assert.equal(await asAda(() => plugin.routines.delete(id)), false);
  }
  // A superadmin sees more but changes no more than the plugin's own.
  assert.ok((await asAdmin(() => plugin.routines.list())).some((r) => r.id === BACKUP_ROUTINE_ID));
  await assert.rejects(asAdmin(() => plugin.routines.update(BACKUP_ROUTINE_ID, { enabled: false })), code('forbidden'));
  await assert.rejects(asAdmin(() => plugin.routines.delete(bobs.id)), code('forbidden'));
  for (const id of [adas.id, bobs.id, theirs.id, BACKUP_ROUTINE_ID]) assert.ok(dbApi.getRoutine(id), id);
  assert.equal(dbApi.getRoutine(adas.id)!.name, 'ada routine');

  const updated = await asBob(() => plugin.routines.update(mine.id, { prompt: 'changed', enabled: false }));
  assert.equal(updated.prompt, 'changed');
  assert.equal(updated.enabled, false);
  assert.equal(updated.nextRunAt, null);
  await assert.rejects(plugin.routines.update(mine.id, { cron: '* * * * *' }), code('invalid'));
  assert.equal(await asBob(() => plugin.routines.delete(mine.id)), true);
  assert.equal(dbApi.getRoutine(mine.id), undefined);
  await dispose();
  await other.dispose();
});

test('a job sees only its own routines', async () => {
  const { plugin, dispose } = await pluginWith(['routines:write', 'routines:read', 'kanban:write'], 'acme-job-r');
  createRoutine({ name: 'ada hidden', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: ada.id });
  const mine = await plugin.routines.create(input('job routine'));
  assert.deepEqual((await plugin.routines.list()).map((r) => r.id), [mine.id]);
  await dispose();
});

test('a plugin owns a bounded number of routines', async () => {
  const { plugin, dispose } = await pluginWith(['routines:write', 'kanban:write'], 'acme-flood-r');
  for (let i = 0; i < MAX_PLUGIN_ROUTINES; i++) await plugin.routines.create(input(`flood ${i}`));
  await assert.rejects(plugin.routines.create(input('one more')), code('quota'));
  await dispose();
});

test('a plugin routine is a spawn: refused unapproved at creation and at every tick, then held to the quota (TODO #591)', async () => {
  const id = 'acme-unapproved-r';
  const { plugin, dispose } = await pluginWith(['routines:write', 'routines:read', 'kanban:write'], id);
  const opened = (name: string) => dbApi.listTasks().filter((t) => t.title === name).length;
  const due = (routineId: string) => dbApi.updateRoutine(routineId, { next_run_at: Date.now() - 1000 });
  const spawnCard = () => dbApi.listActiveNotifications('action_required').find((n) => n.anchor === `plugin-spawn:${id}`);
  try {
    policy({ approved: APPROVED });
    // Not approved: neither a job nor a user's request stores a routine that would tick as the plugin.
    await assert.rejects(plugin.routines.create(input('job routine 591')), (e) => code('forbidden')(e) && /pluginPolicy\.spawn\.approved/.test((e as Error).message));
    await assert.rejects(asAda(() => plugin.routines.create(input('ada asks 591'))), code('forbidden'));
    assert.equal(dbApi.listRoutines().some((r) => r.name.endsWith('591')), false, 'nothing stored');
    await spawnCardsSettled();
    const card = spawnCard();
    assert.ok(card, 'the operator is asked');
    assert.match(card.body ?? '', /ctx\.routines\.create/);

    // A disabled one may be stored; enabling it is the same refusal.
    const parked = await plugin.routines.create({ ...input('parked 591'), enabled: false });
    await assert.rejects(plugin.routines.update(parked.id, { enabled: true }), code('forbidden'));
    assert.equal(dbApi.getRoutine(parked.id)!.enabled, 0);

    // A routine stored before the gate (or written past the facade) does not tick either.
    const legacy = createRoutine({ name: 'legacy 591', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: `plugin:${id}` });
    due(legacy.id);
    await tickRoutines();
    assert.equal(opened('legacy 591'), 0, 'the unapproved tick opens nothing');
    assert.ok(dbApi.getRoutine(legacy.id)!.next_run_at! > Date.now(), 'and moves on to the next occurrence');
    // An account's own routine is not a plugin's spawn.
    const adas = createRoutine({ name: 'ada own 591', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: ada.id });
    due(adas.id);
    await tickRoutines();
    assert.equal(opened('ada own 591'), 1);

    // Approved: each tick takes the quota shared with missions.spawn.
    policy({ approved: [...APPROVED, id], max: 2, windowMs: 60_000 });
    assert.equal((await plugin.routines.update(parked.id, { enabled: true })).enabled, true);
    await spawnCardsSettled();
    assert.equal(spawnCard(), undefined, 'going through answers the approval card, before the first tick');
    assertSpawnAllowed(id);
    due(legacy.id);
    await tickRoutines();
    assert.equal(opened('legacy 591'), 1, 'one tick, one task');
    due(legacy.id);
    await tickRoutines();
    assert.equal(opened('legacy 591'), 1, 'over the quota, the tick is skipped');
    assert.throws(() => assertSpawnAllowed(id), /quota reached/, 'and the tick counted against missions.spawn');
  } finally {
    policy();
    await dispose();
  }
});
