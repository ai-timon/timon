/**
 * Lifecycle events of routines, triggers, pipelines and workflow runs
 * (`ctx.events.on`, API 10): permission to follow them, the `origin` they
 * carry, and who receives what.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-automation-events-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { emitAutomationEvent } = await import('./automation-events.js');
const { PLUGIN_AUTOMATION_EVENT_KINDS } = await import('./automation-event-hub.js');
const { dbApi } = await import('../db.js');
const { agentDir } = await import('../paths.js');
const { hashPassword } = await import('../users/password.js');
const { createRoutine } = await import('../routines.js');
const { createPipeline } = await import('../pipelines.js');
const { insertTrigger, getTriggerRow } = await import('../triggers/store.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');

// A routine and a job's pipeline run are spawns: the operator approved these (TODO #591).
setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn: { approved: ['ev-routine', 'ev-pipe'] } } }));
test.after(() => resetConfig());

mkdirSync(agentDir('worker'), { recursive: true });
const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });

async function pluginWith(permissions: string[], id: string) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: `holder-${id}`, apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const USER = { kind: 'user', id: 'someone' } as const;

test('following an entity\'s events needs events:subscribe and a read permission of that entity', async () => {
  const noSub = await pluginWith(['routines:read'], 'ev-nosub');
  assert.throws(() => noSub.plugin.events.on('routine_created', () => {}), PluginPermissionError);
  await noSub.dispose();
  const noRead = await pluginWith(['events:subscribe', 'pipelines:read'], 'ev-noread');
  assert.throws(() => noRead.plugin.events.on('routine_created', () => {}), PluginPermissionError);
  assert.throws(() => noRead.plugin.events.on('trigger_created', () => {}), PluginPermissionError);
  assert.throws(() => noRead.plugin.events.on('workflow_run_started', () => {}), PluginPermissionError);
  noRead.plugin.events.on('pipeline_created', () => {});
  await noRead.dispose();
  assert.equal(PLUGIN_AUTOMATION_EVENT_KINDS.length, 12);
});

test('a routine written through the facade comes back to the plugin\'s job, origin plugin', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'routines:read', 'routines:write', 'kanban:write'], 'ev-routine');
  const seen: Array<{ kind: string; origin: unknown; mine: boolean; id: string }> = [];
  for (const kind of ['routine_created', 'routine_updated', 'routine_deleted'] as const) {
    plugin.events.on(kind, (ev) => { seen.push({ kind: ev.kind, origin: ev.origin, mine: ev.routine.mine, id: ev.routineId }); });
  }
  const routine = await plugin.routines.create({ name: 'Digest', agent: 'worker', prompt: 'p', cron: '0 8 * * *' });
  await plugin.routines.update(routine.id, { prompt: 'q' });
  await plugin.routines.delete(routine.id);
  await tick();
  assert.deepEqual(seen.map((s) => s.kind), ['routine_created', 'routine_updated', 'routine_deleted']);
  for (const s of seen) {
    assert.deepEqual(s.origin, { kind: 'plugin', id: 'ev-routine' });
    assert.equal(s.mine, true);
    assert.equal(s.id, routine.id);
  }
  await dispose();
});

test('a change by someone else carries its own origin; other owners\' and system rows never leave', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'routines:read', 'triggers:read', 'pipelines:read'], 'ev-origin');
  const other = await pluginWith(['events:subscribe', 'routines:read'], 'ev-origin-other');
  const mine: string[] = [];
  const theirs: string[] = [];
  plugin.events.on('routine_created', (ev) => { mine.push(`${ev.routineId}:${(ev.origin as { kind: string }).kind}`); });
  other.plugin.events.on('routine_created', (ev) => { theirs.push(ev.routineId); });

  const owned = createRoutine({ name: 'plugin-owned', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: 'plugin:ev-origin' });
  const adas = createRoutine({ name: 'ada', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: ada.id });
  const system = createRoutine({ name: 'system', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *' });
  for (const row of [owned, adas, system]) emitAutomationEvent({ kind: 'routine_created', row, origin: USER });
  await tick();
  assert.deepEqual(mine, [`${owned.id}:user`], 'only its own object — Ada may not use this plugin, the system row is nobody\'s');
  assert.deepEqual(theirs, [], 'another plugin\'s object stays with its owner');
  await dispose();
  await other.dispose();
});

test('a trigger event shows the definition of a trigger the plugin owns, and the identity only of the others', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'triggers:read', 'triggers:write', 'notify'], 'ev-trigger');
  const seen: Array<{ kind: string; hasActions: boolean; mine: boolean }> = [];
  for (const kind of ['trigger_created', 'trigger_updated', 'trigger_removed'] as const) {
    plugin.events.on(kind, (ev) => { seen.push({ kind: ev.kind, hasActions: 'actions' in ev.trigger, mine: ev.trigger.mine }); });
  }
  const created = await plugin.triggers.create({
    source: 'schedule', name: 'tick', config: { cron: '0 * * * *' }, actions: [{ type: 'notify', title: 'x' }],
  });
  const row = getTriggerRow(created.trigger.id)!;
  emitAutomationEvent({ kind: 'trigger_updated', row, origin: USER });
  await plugin.triggers.remove(created.trigger.id);
  await tick();
  assert.deepEqual(seen, [
    { kind: 'trigger_created', hasActions: true, mine: true },
    { kind: 'trigger_updated', hasActions: true, mine: true },
    { kind: 'trigger_removed', hasActions: true, mine: true },
  ]);
  // A hand-made trigger of a user the plugin may not serve is never delivered.
  seen.length = 0;
  const handMade = insertTrigger({
    name: 'hand', slug: null, source: 'event', enabled: true, config: { event: 'todo_done' }, filter: null,
    actions: [{ type: 'notify', title: 'x' }], secret: null, ownerUserId: ada.id, createdBy: 'user',
    creatorAgent: null, actingAgent: null, grants: ['*'], nextRunAt: null,
  });
  emitAutomationEvent({ kind: 'trigger_created', row: handMade, origin: USER });
  await tick();
  assert.deepEqual(seen, []);
  await dispose();
});

test('a pipeline run started in a job is announced with its steps; a deleted pipeline arrives as it was', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'pipelines:read', 'pipelines:write', 'pipelines:run', 'kanban:write'], 'ev-pipe');
  const seen: string[] = [];
  plugin.events.on('pipeline_created', (ev) => { seen.push(`created:${ev.pipeline.mine}`); });
  plugin.events.on('pipeline_run_started', (ev) => { seen.push(`run:${ev.steps.length}:${(ev.origin as { id: string }).id}`); });
  plugin.events.on('pipeline_deleted', (ev) => { seen.push(`deleted:${ev.pipeline.name}`); });
  const pipeline = await plugin.pipelines.create({ name: 'P', steps: [{ id: 'a', agent: 'worker', prompt: 'x' }, { id: 'b', agent: 'worker', prompt: 'y', deps_on: ['a'] }] });
  await plugin.pipelines.run(pipeline.id);
  await plugin.pipelines.delete(pipeline.id);
  await tick();
  assert.deepEqual(seen, ['created:true', 'run:2:ev-pipe', 'deleted:P']);
  // A pipeline someone else made for another owner is not announced.
  const foreign = createPipeline({ name: 'F', definition: { steps: [{ id: 'a', agent: 'worker', prompt: 'x' }] }, ownerUserId: ada.id });
  seen.length = 0;
  emitAutomationEvent({ kind: 'pipeline_created', pipeline: foreign, origin: USER });
  await tick();
  assert.deepEqual(seen, []);
  await dispose();
});

test('after dispose a plugin receives nothing', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'routines:read'], 'ev-dispose');
  const seen: string[] = [];
  plugin.events.on('routine_created', (ev) => { seen.push(ev.routineId); });
  await dispose();
  const row = createRoutine({ name: 'late', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: 'plugin:ev-dispose' });
  emitAutomationEvent({ kind: 'routine_created', row, origin: USER });
  await tick();
  assert.deepEqual(seen, []);
});
