/**
 * `ctx.triggers.get / create / remove / test` (API 10): a plugin wires triggers
 * of its own and changes only those. Refusals come first: permission,
 * anonymous, an account without `triggers:manage`, another plugin's rows, the
 * manifest cap under a superadmin, the HTTP policy, an unauthenticated webhook.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-triggers-auto-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError } = await import('./context.js');
const { PluginAutomationError } = await import('./automation-scope.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { insertTrigger, getTriggerRow, parseTrigger, listTriggerRows } = await import('../triggers/store.js');
const { runActions } = await import('../triggers/actions.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { agentDir } = await import('../paths.js');
const { assertSpawnAllowed, resetPluginPolicyState } = await import('./policy.js');

test.after(() => resetConfig());

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });

type Who = { id: string; email: string; name: string };
const request = (user: Who, over: { superadmin?: boolean; permissions?: string[] } = {}) => ({
  viewer: { id: user.id, isSuperadmin: over.superadmin === true, permissions: over.permissions ?? [] },
  user: { id: user.id, email: user.email, name: user.name, is_superadmin: over.superadmin === true },
  ownerUserId: user.id,
});
/** Ada holds `triggers:manage` and the action rights; Bob holds nothing. */
const asAda = <T>(fn: () => Promise<T>) =>
  runPluginRequest(request(ada, { permissions: ['triggers:manage', 'notify', 'kanban:write'] }), fn);
const asAdaBare = <T>(fn: () => Promise<T>) => runPluginRequest(request(ada, { permissions: ['triggers:manage'] }), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob), fn);
const asBobManager = <T>(fn: () => Promise<T>) =>
  runPluginRequest(request(bob, { permissions: ['triggers:manage', 'notify'] }), fn);
const asAdmin = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob, { superadmin: true }), fn);
const anonymous = <T>(fn: () => Promise<T>) =>
  runPluginRequest({ viewer: null, user: undefined, ownerUserId: null }, fn);

async function pluginWith(permissions: string[], id = 'acme-bridge') {
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
const notifyHook = (slug = 'orders') => ({
  source: 'webhook' as const, name: 'Orders', slug, config: { auth: 'standard' as const },
  actions: [{ type: 'notify' as const, title: 'Order {order.id}' }],
});
const schedule = (name = 'Nightly') => ({
  source: 'schedule' as const, name, config: { cron: '0 3 * * *' },
  actions: [{ type: 'notify' as const, title: 'tick' }],
});
const handMade = (owner: string | null, name: string) => insertTrigger({
  name, slug: null, source: 'event', enabled: true, config: { event: 'todo_done' }, filter: null,
  actions: [{ type: 'notify', title: 'x' }], secret: null, ownerUserId: owner, createdBy: 'user',
  creatorAgent: null, actingAgent: null, grants: ['*'], nextRunAt: null,
});

test('each door needs its own permission: disable, read, write, execute', async () => {
  const disableOnly = await pluginWith(['triggers:disable']);
  await assert.rejects(asAda(() => disableOnly.plugin.triggers.get('x')), PluginPermissionError);
  await assert.rejects(asAda(() => disableOnly.plugin.triggers.create(schedule())), PluginPermissionError);
  await assert.rejects(asAda(() => disableOnly.plugin.triggers.remove('x')), PluginPermissionError);
  await assert.rejects(asAda(() => disableOnly.plugin.triggers.test('x')), PluginPermissionError);
  await disableOnly.dispose();

  const readOnly = await pluginWith(['triggers:read', 'notify']);
  await assert.rejects(asAda(() => readOnly.plugin.triggers.disable('x')), PluginPermissionError);
  await assert.rejects(asAda(() => readOnly.plugin.triggers.create(schedule())), PluginPermissionError);
  await assert.rejects(asAda(() => readOnly.plugin.triggers.remove('x')), PluginPermissionError);
  await assert.rejects(asAda(() => readOnly.plugin.triggers.test('x', { execute: true })), PluginPermissionError);
  await readOnly.dispose();

  const writeOnly = await pluginWith(['triggers:write', 'notify']);
  await assert.rejects(asAda(() => writeOnly.plugin.triggers.test('x', { execute: true })), PluginPermissionError);
  await writeOnly.dispose();

  const none = await pluginWith(['notify']);
  await assert.rejects(asAda(() => none.plugin.triggers.list()), PluginPermissionError);
  await none.dispose();
});

test('an anonymous request and an account without triggers:manage are refused', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'triggers:read', 'notify']);
  await assert.rejects(anonymous(() => plugin.triggers.create(schedule('anon'))), PluginCallerError);
  await assert.rejects(anonymous(() => plugin.triggers.get('x')), PluginCallerError);
  await assert.rejects(asBob(() => plugin.triggers.create(schedule('bob'))), PluginCallerError);
  await assert.rejects(asBob(() => plugin.triggers.get('x')), PluginCallerError);
  assert.equal(listTriggerRows().some((r) => r.name === 'anon' || r.name === 'bob'), false);
  await dispose();
});

test('create: the plugin owns the trigger; the secret comes once and is never read back', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'triggers:read', 'notify']);
  const created = await asAda(() => plugin.triggers.create(notifyHook('orders-a')));
  assert.equal(created.trigger.mine, true);
  assert.match(created.secret ?? '', /^whsec_/);
  assert.equal(created.outboundSecret, undefined, 'no webhook action, no outbound secret');
  const row = getTriggerRow(created.trigger.id)!;
  assert.equal(row.owner_user_id, 'plugin:acme-bridge');
  assert.equal(row.created_by, 'user');
  assert.deepEqual(JSON.parse(row.grants!), ['notify'], 'grants are the declared action permissions, never `*`');
  const again = await asAda(() => plugin.triggers.get(created.trigger.id));
  assert.equal(again && 'actions' in again, true);
  assert.ok(!JSON.stringify(again).includes(created.secret!));
  // Bob has no right on the account, Ada's grants cap the rest.
  const sched = await asAda(() => plugin.triggers.create(schedule()));
  assert.ok(sched.trigger.nextRunAt && sched.trigger.nextRunAt > Date.now());
  await dispose();
});

test('create in a job: owner plugin:<id>, and the rights are those of the manifest', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'triggers:read', 'notify'], 'acme-job');
  const created = await plugin.triggers.create(schedule('job schedule'));
  assert.equal(getTriggerRow(created.trigger.id)!.owner_user_id, 'plugin:acme-job');
  handMade(ada.id, 'invisible to a job');
  assert.deepEqual((await plugin.triggers.list()).map((t) => t.id), [created.trigger.id]);
  await assert.rejects(plugin.triggers.create({
    source: 'schedule', name: 'task without right', config: { cron: '0 * * * *' },
    actions: [{ type: 'task', agent: 'anyone', prompt: 'do it' }],
  }), code('forbidden'));
  await dispose();
});

test('an action the manifest did not declare is refused, even for a superadmin; grants never hold `*`', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'notify']);
  await assert.rejects(asAdmin(() => plugin.triggers.create({
    source: 'schedule', name: 'cap', config: { cron: '0 * * * *' },
    actions: [{ type: 'task', agent: '_main', prompt: 'x' }],
  })), code('forbidden'));
  const ok = await asAdmin(() => plugin.triggers.create(schedule('admin ok')));
  assert.deepEqual(JSON.parse(getTriggerRow(ok.trigger.id)!.grants!), ['notify']);
  await dispose();
});

test('in a request the caller must also hold the action right', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'notify', 'kanban:write']);
  // Ada: manage + notify only, no kanban:write -> a task action is refused.
  await assert.rejects(asAdaBare(() => plugin.triggers.create(schedule('bare'))), code('forbidden'));
  await assert.rejects(asAdaBare(() => plugin.triggers.create({
    source: 'schedule', name: 'bare task', config: { cron: '0 * * * *' },
    actions: [{ type: 'task', agent: '_main', prompt: 'x' }],
  })), code('forbidden'));
  const ok = await asBobManager(() => plugin.triggers.create(schedule('bob notify')));
  assert.deepEqual(JSON.parse(getTriggerRow(ok.trigger.id)!.grants!), ['notify']);
  await dispose();
});

test('a webhook action stays inside pluginPolicy.http, at creation and at every run', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'http:outbound'], 'acme-hooks');
  const input = (url: string) => ({
    source: 'schedule' as const, name: `out ${url}`, config: { cron: '0 * * * *' },
    actions: [{ type: 'webhook' as const, url }],
  });
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { allow: [] } } }));
  await assert.rejects(plugin.triggers.create(input('https://worker.example.test/in')), code('forbidden'));
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { allow: ['worker.example.test'] } } }));
  const created = await plugin.triggers.create(input('https://worker.example.test/in'));
  assert.match(created.outboundSecret ?? '', /^whsec_/);
  await assert.rejects(plugin.triggers.create(input('https://evil.example.org/in')), code('forbidden'));
  // An operator allow-list naming a private or metadata address does not open it (TODO #687).
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { allow: ['169.254.169.254', '10.0.0.5', 'localhost'] } } }));
  for (const url of ['https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/in', 'https://localhost/in']) {
    await assert.rejects(plugin.triggers.create(input(url)), (e: unknown) => code('invalid')(e) && /cannot target/.test((e as Error).message), url);
  }
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { allow: ['worker.example.test'] } } }));
  // The operator tightens the policy later: the stored trigger stops sending.
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { allow: [] } } }));
  const stored = parseTrigger(getTriggerRow(created.trigger.id)!)!;
  const outcomes = runActions(stored, { body: {}, headers: {} }, { dryRun: true });
  assert.equal(outcomes[0]?.ok, false);
  resetConfig();
  await dispose();
});

test('an unauthenticated webhook, a bad definition, a taken slug, an unknown agent are refused', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'notify', 'kanban:write']);
  await assert.rejects(plugin.triggers.create({ ...notifyHook('open-door'), config: { auth: 'none' } }), code('forbidden'));
  await assert.rejects(plugin.triggers.create({ source: 'schedule', name: 'bad' } as never), code('invalid'));
  await assert.rejects(plugin.triggers.create({ ...schedule(), config: { cron: 'not a cron' } }), code('invalid'));
  await assert.rejects(plugin.triggers.create({ ...schedule(), config: { cron: '*/10 * * * * *' } }),
    (e: unknown) => code('invalid')(e) && /at most once a minute/.test((e as Error).message));
  await assert.rejects(plugin.triggers.create({ ...schedule(), secret: 'x'.repeat(20) }), code('invalid'));
  await assert.rejects(plugin.triggers.create({
    source: 'schedule', name: 'ghost', config: { cron: '0 * * * *' },
    actions: [{ type: 'task', agent: 'no-such-agent-anywhere', prompt: 'x' }],
  }), code('invalid'));
  await plugin.triggers.create(notifyHook('taken'));
  await assert.rejects(plugin.triggers.create(notifyHook('taken')), code('conflict'));
  await dispose();
});

test('a plugin owns a bounded number of triggers', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'notify'], 'acme-flood');
  const { MAX_PLUGIN_TRIGGERS } = await import('./triggers-facade.js');
  for (let i = 0; i < MAX_PLUGIN_TRIGGERS; i++) await plugin.triggers.create(schedule(`flood ${i}`));
  await assert.rejects(plugin.triggers.create(schedule('one more')), code('quota'));
  await dispose();
});

test('remove: only the plugin\'s own; another account\'s, a system row and a routine are not its to delete', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'triggers:read', 'notify'], 'acme-rm');
  const other = await pluginWith(['triggers:write', 'triggers:read', 'notify'], 'acme-other');
  const mine = await plugin.triggers.create(schedule('mine'));
  const theirs = await other.plugin.triggers.create(schedule('theirs'));
  const adas = handMade(ada.id, 'ada hand-made');
  const bobs = handMade(bob.id, 'bob hand-made');
  const system = handMade(null, 'system row');

  await assert.rejects(asAda(() => plugin.triggers.remove(adas.id)), code('forbidden'));
  assert.equal(await asAda(() => plugin.triggers.remove(bobs.id)), false, 'another account\'s looks missing');
  assert.equal(await asAda(() => plugin.triggers.remove(theirs.trigger.id)), false, 'another plugin\'s looks missing');
  assert.equal(await asAda(() => plugin.triggers.remove(system.id)), false);
  await assert.rejects(asAdmin(() => plugin.triggers.remove(system.id)), code('forbidden'));
  await assert.rejects(asAdmin(() => plugin.triggers.remove(bobs.id)), code('forbidden'));
  assert.equal(await plugin.triggers.remove(theirs.trigger.id), false, 'a job does not see another plugin\'s');
  for (const id of [adas.id, bobs.id, system.id, theirs.trigger.id]) assert.ok(getTriggerRow(id), id);

  assert.equal(await asAda(() => plugin.triggers.remove(mine.trigger.id)), true);
  assert.equal(getTriggerRow(mine.trigger.id), undefined);
  assert.equal(await plugin.triggers.remove(mine.trigger.id), false);
  await dispose();
  await other.dispose();
});

test('get: a hand-made trigger shows its identity only; another plugin\'s is invisible', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:read', 'notify'], 'acme-get');
  const other = await pluginWith(['triggers:write', 'notify'], 'acme-get-other');
  const theirs = await other.plugin.triggers.create(schedule('theirs hidden'));
  const adas = handMade(ada.id, 'ada visible');
  const seen = await asAda(() => plugin.triggers.get(adas.id));
  assert.equal(seen?.mine, false);
  assert.ok(seen && !('actions' in seen), 'no action body on a trigger the plugin does not own');
  assert.equal(await asAda(() => plugin.triggers.get(theirs.trigger.id)), undefined);
  assert.equal(await asAda(() => plugin.triggers.get(handMade(bob.id, 'bob hidden').id)), undefined);
  assert.equal((await asAda(() => plugin.triggers.list())).some((t) => t.id === theirs.trigger.id), false);
  await dispose();
  await other.dispose();
});

test('test: a dry run needs read; running it needs triggers:execute and the caller\'s own rights', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:write', 'triggers:execute', 'notify'], 'acme-test');
  const hook = await plugin.triggers.create(notifyHook('probe'));
  const dry = await asAda(() => plugin.triggers.test(hook.trigger.id, { payload: { order: { id: 7 } } }));
  assert.equal(dry.status, 'dry_run');
  assert.equal(dry.status === 'dry_run' && dry.outcomes[0]?.ok, true);
  // Bob holds `triggers:manage` but not `notify`: he cannot make the trigger do what he could not.
  await assert.rejects(runPluginRequest(request(bob, { permissions: ['triggers:manage'] }),
    () => plugin.triggers.test(hook.trigger.id, { execute: true })), code('forbidden'));
  // Another account's trigger is not testable by this plugin.
  const adas = handMade(ada.id, 'ada hand-made test');
  await assert.rejects(asAda(() => plugin.triggers.test(adas.id)), code('forbidden'));
  await assert.rejects(asAda(() => plugin.triggers.test('missing')), code('not_found'));
  await assert.rejects(asAda(() => plugin.triggers.test(hook.trigger.id, { payload: 'x'.repeat(2_000_000) })), code('invalid'));

  const readerOnly = await pluginWith(['triggers:read'], 'acme-test-r');
  await assert.rejects(asAda(() => readerOnly.plugin.triggers.test(hook.trigger.id, { execute: true })), PluginPermissionError);
  await readerOnly.dispose();
  await dispose();
});

test('the API 6 door is unchanged: list and disable', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:disable'], 'acme-legacy');
  const mine = handMade(ada.id, 'legacy mine');
  assert.ok((await asAda(() => plugin.triggers.list())).some((t) => t.id === mine.id));
  assert.equal(await asAda(() => plugin.triggers.disable(mine.id)), true);
  await dispose();
});

test('a task action of a plugin\'s trigger is a spawn: approval at creation, approval and quota at every run (TODO #591)', async () => {
  const id = 'acme-spawn-t';
  mkdirSync(agentDir('worker'), { recursive: true });
  const { plugin, dispose } = await pluginWith(['triggers:write', 'triggers:read', 'kanban:write'], id);
  const taskTrigger = (name: string, enabled = true) => ({
    source: 'schedule' as const, name, enabled, config: { cron: '0 3 * * *' },
    actions: [{ type: 'task' as const, agent: 'worker', prompt: `run ${name}` }],
  });
  const stored = (owner: string, name: string) => parseTrigger(insertTrigger({
    name, slug: null, source: 'schedule', enabled: true, config: { cron: '0 3 * * *' }, filter: null,
    actions: [{ type: 'task', agent: 'worker', prompt: `run ${name}` }], secret: null, ownerUserId: owner,
    createdBy: 'user', creatorAgent: null, actingAgent: null, grants: owner.startsWith('plugin:') ? ['kanban:write'] : ['*'], nextRunAt: null,
  }))!;
  const fire = (t: NonNullable<ReturnType<typeof stored>>, dryRun = false) => runActions(t, { body: {}, headers: {} }, { dryRun })[0]!;
  const opened = (name: string) => dbApi.listTasks().filter((t) => t.description?.includes(`run ${name}`)).length;
  const policy = (spawn: { approved: string[]; max?: number; windowMs?: number }) => {
    setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn } }));
    resetPluginPolicyState();
  };
  try {
    // Not approved: an enabled trigger that opens tasks is not stored, by a job or for a user.
    policy({ approved: [] });
    const refused = (e: unknown) => code('forbidden')(e) && /pluginPolicy\.spawn\.approved/.test((e as Error).message);
    await assert.rejects(plugin.triggers.create(taskTrigger('job 591')), refused);
    await assert.rejects(asAda(() => plugin.triggers.create(taskTrigger('ada 591'))), refused);
    assert.equal(listTriggerRows().some((r) => r.name.endsWith(' 591')), false);
    await plugin.triggers.create(taskTrigger('parked 591', false));
    // Stored past the facade, it fires but opens nothing.
    const legacy = stored(`plugin:${id}`, 'legacy 591');
    const outcome = fire(legacy);
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.error, /pluginPolicy\.spawn\.approved/);
    assert.equal(opened('legacy 591'), 0);
    // An account's own trigger is not a plugin's spawn.
    assert.equal(fire(stored(ada.id, 'ada own 591')).ok, true);
    assert.equal(opened('ada own 591'), 1);

    // Approved: each task opened takes the quota shared with missions.spawn; a dry run takes none.
    policy({ approved: [id], max: 2, windowMs: 60_000 });
    assert.equal(fire(legacy, true).ok, true);
    assert.equal(fire(legacy, true).ok, true);
    assert.equal(fire(legacy).ok, true);
    assert.equal(opened('legacy 591'), 1);
    assertSpawnAllowed(id);
    assert.equal(fire(legacy).ok, false, 'over the quota');
    assert.equal(opened('legacy 591'), 1);
    assert.ok((await plugin.triggers.create(taskTrigger('approved 591'))).trigger.id);
  } finally {
    resetConfig();
    resetPluginPolicyState();
    await dispose();
  }
});
