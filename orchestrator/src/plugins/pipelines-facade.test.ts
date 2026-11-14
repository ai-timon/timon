/**
 * `ctx.pipelines` (API 10): a plugin defines multi-agent templates and runs
 * them. Refusals come first: permission, kanban:write, anonymous, another
 * plugin's or account's pipelines and runs, privileged step fields.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-pipelines-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError } = await import('./context.js');
const { PluginAutomationError } = await import('./automation-scope.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { agentDir } = await import('../paths.js');
const { hashPassword } = await import('../users/password.js');
const { createPipeline, runPipeline } = await import('../pipelines.js');
const { MAX_PLUGIN_OPEN_RUNS, MAX_PLUGIN_PIPELINES } = await import('./pipelines-facade.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { assertSpawnAllowed, resetPluginPolicyState } = await import('./policy.js');
const policy = (spawn: { approved: string[]; max?: number; windowMs?: number }) => {
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn } }));
  resetPluginPolicyState();
};

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
const asAdmin = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob, { superadmin: true, permissions: ['kanban:write'] }), fn);
const anonymous = <T>(fn: () => Promise<T>) => runPluginRequest({ viewer: null, user: undefined, ownerUserId: null }, fn);

async function pluginWith(permissions: string[], id = 'acme-flow') {
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
const flow = (name = 'Release') => ({
  name,
  steps: [
    { id: 'plan', agent: 'worker', prompt: 'Plan {{input.feature}}', type: 'research' as const },
    { id: 'build', agent: 'worker', prompt: 'Build {{input.feature}} for {{input.team}}', type: 'code' as const, deps_on: ['plan'] },
  ],
});
const ALL = ['pipelines:read', 'pipelines:write', 'pipelines:run', 'kanban:write'];

test('each door needs its permission; a run also needs kanban:write', async () => {
  const none = await pluginWith(['notify']);
  await assert.rejects(asAda(() => none.plugin.pipelines.list()), PluginPermissionError);
  await none.dispose();

  const reader = await pluginWith(['pipelines:read', 'kanban:write']);
  await assert.rejects(asAda(() => reader.plugin.pipelines.create(flow())), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.pipelines.delete('x')), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.pipelines.run('x')), PluginPermissionError);
  assert.deepEqual(await asAda(() => reader.plugin.pipelines.list()), []);
  await reader.dispose();

  const noKanban = await pluginWith(['pipelines:run', 'pipelines:write']);
  await assert.rejects(asAda(() => noKanban.plugin.pipelines.run('x')), PluginPermissionError);
  await noKanban.dispose();
});

test('an anonymous request is refused; so is a run by an account without kanban:write', async () => {
  const { plugin, dispose } = await pluginWith(ALL, 'acme-anon');
  await assert.rejects(anonymous(() => plugin.pipelines.list()), PluginCallerError);
  await assert.rejects(anonymous(() => plugin.pipelines.create(flow('anon'))), PluginCallerError);
  const pipeline = await plugin.pipelines.create(flow('mine anon'));
  await assert.rejects(asAdaNoKanban(() => plugin.pipelines.run(pipeline.id, { feature: 'x' })), PluginCallerError);
  assert.equal(dbApi.listTasks().some((t) => t.title.startsWith('mine anon')), false);
  await dispose();
});

test('create validates the definition and refuses the fields that choose what an agent may do', async () => {
  const { plugin, dispose } = await pluginWith(ALL, 'acme-def');
  for (const key of ['extra_skills', 'extra_mcp_servers', 'extra_allowed_tools', 'model_override', 'permission_mode_override']) {
    await assert.rejects(plugin.pipelines.create({
      name: 'sneaky', steps: [{ id: 'a', agent: 'worker', prompt: 'x', [key]: key === 'model_override' || key === 'permission_mode_override' ? 'bypassPermissions' : ['x'] }],
    } as never), code('forbidden'), key);
  }
  await assert.rejects(plugin.pipelines.create({ name: 'ghost', steps: [{ id: 'a', agent: 'ghost-agent', prompt: 'x' }] }), code('invalid'));
  await assert.rejects(plugin.pipelines.create({ name: 'empty', steps: [] }), code('invalid'));
  await assert.rejects(plugin.pipelines.create({ name: 'x', steps: [{ id: 'A B', agent: 'worker', prompt: 'x' }] }), code('invalid'));
  await assert.rejects(plugin.pipelines.create({
    name: 'cycle', steps: [
      { id: 'a', agent: 'worker', prompt: 'x', deps_on: ['b'] }, { id: 'b', agent: 'worker', prompt: 'x', deps_on: ['a'] },
    ],
  }), code('invalid'));
  await assert.rejects(plugin.pipelines.create({ name: 'unknown key', steps: [{ id: 'a', agent: 'worker', prompt: 'x', nope: 1 }] } as never), code('invalid'));
  assert.equal(dbApi.listPipelines().some((p) => ['sneaky', 'ghost', 'empty', 'cycle'].includes(p.name)), false);
  await dispose();
});

test('a run in a job opens tasks owned by the plugin; in a request, by the caller', async () => {
  const { plugin, dispose } = await pluginWith(ALL, 'acme-run');
  // A job's run is a spawn: the operator approved this plugin (TODO #591).
  policy({ approved: ['acme-run'] });
  const pipeline = await plugin.pipelines.create(flow('Run flow'));
  assert.equal(dbApi.getPipeline(pipeline.id)!.owner_user_id, 'plugin:acme-run');
  assert.deepEqual(pipeline.inputs, ['feature', 'team']);

  const job = await plugin.pipelines.run(pipeline.id, { feature: 'search', team: 'core' });
  assert.equal(job.steps.length, 2);
  for (const step of job.steps) assert.equal(dbApi.getTask(step.taskId)!.owner_user_id, 'plugin:acme-run');
  assert.equal(dbApi.getPipelineRun(job.runId)!.owner_user_id, 'plugin:acme-run');
  const status = await plugin.pipelines.runStatus(job.runId);
  assert.deepEqual(status?.steps.map((s) => s.stepId).sort(), ['build', 'plan']);
  assert.equal(dbApi.getTask(job.steps[0]!.taskId)!.description?.includes('search'), true);

  const mine = await asAda(() => plugin.pipelines.run(pipeline.id, { feature: 'billing' }));
  for (const step of mine.steps) assert.equal(dbApi.getTask(step.taskId)!.owner_user_id, ada.id);
  assert.ok(await asAda(() => plugin.pipelines.runStatus(mine.runId)));
  // Bob did not start it, a job did not either; a superadmin reads anything.
  assert.equal(await asBob(() => plugin.pipelines.runStatus(mine.runId)), undefined);
  assert.equal(await plugin.pipelines.runStatus(mine.runId), undefined);
  assert.ok(await asAda(() => plugin.pipelines.runStatus(job.runId)), 'what the plugin ran itself stays readable by the plugin');
  assert.ok(await asAdmin(() => plugin.pipelines.runStatus(mine.runId)));
  assert.equal(await asAda(() => plugin.pipelines.runStatus('missing')), undefined);

  await assert.rejects(plugin.pipelines.run('missing'), code('not_found'));
  await assert.rejects(plugin.pipelines.run(pipeline.id, 'x' as never), code('invalid'));
  await assert.rejects(plugin.pipelines.run(pipeline.id, { blob: 'x'.repeat(70_000) }), code('invalid'));
  resetConfig();
  resetPluginPolicyState();
  await dispose();
});

test('another plugin\'s or account\'s pipeline is invisible; a hand-made one shows a summary without prompts', async () => {
  const { plugin, dispose } = await pluginWith(ALL, 'acme-view');
  const other = await pluginWith(ALL, 'acme-view-other');
  const theirs = await other.plugin.pipelines.create(flow('theirs'));
  const adas = createPipeline({ name: 'ada flow', definition: { steps: [{ id: 'a', agent: 'worker', prompt: 'SECRET PROMPT {{input.k}}' }] }, ownerUserId: ada.id });
  const bobs = createPipeline({ name: 'bob flow', definition: { steps: [{ id: 'a', agent: 'worker', prompt: 'x' }] }, ownerUserId: bob.id });
  const system = createPipeline({ name: 'system flow', definition: { steps: [{ id: 'a', agent: 'worker', prompt: 'x' }] } });

  const listed = (await asAda(() => plugin.pipelines.list())).map((p) => p.id);
  assert.ok(listed.includes(adas.id));
  for (const hidden of [theirs.id, bobs.id, system.id]) assert.ok(!listed.includes(hidden), hidden);
  const summary = await asAda(() => plugin.pipelines.get(adas.id));
  assert.equal(summary?.mine, false);
  assert.ok(summary && !('steps' in summary));
  assert.ok(!JSON.stringify(summary).includes('SECRET PROMPT'));
  assert.deepEqual(summary?.inputs, ['k']);
  assert.equal(await asAda(() => plugin.pipelines.get(theirs.id)), undefined);
  assert.ok((await asAdmin(() => plugin.pipelines.list())).some((p) => p.id === system.id), 'a superadmin sees system rows');
  await assert.rejects(asAda(() => plugin.pipelines.run(bobs.id)), code('not_found'));
  await assert.rejects(plugin.pipelines.run(adas.id), code('not_found'), 'a job does not see a user\'s pipeline');
  await dispose();
  await other.dispose();
});

test('delete reaches only the plugin\'s own pipelines', async () => {
  const { plugin, dispose } = await pluginWith(ALL, 'acme-del');
  const other = await pluginWith(ALL, 'acme-del-other');
  const mine = await plugin.pipelines.create(flow('del mine'));
  const theirs = await other.plugin.pipelines.create(flow('del theirs'));
  const adas = createPipeline({ name: 'ada del', definition: { steps: [{ id: 'a', agent: 'worker', prompt: 'x' }] }, ownerUserId: ada.id });
  await assert.rejects(asAda(() => plugin.pipelines.delete(adas.id)), code('forbidden'));
  await assert.rejects(asAdmin(() => plugin.pipelines.delete(adas.id)), code('forbidden'));
  assert.equal(await asAda(() => plugin.pipelines.delete(theirs.id)), false);
  assert.equal(await plugin.pipelines.delete('missing'), false);
  assert.ok(dbApi.getPipeline(adas.id) && dbApi.getPipeline(theirs.id));
  assert.equal(await asBob(() => plugin.pipelines.delete(mine.id)), true);
  assert.equal(dbApi.getPipeline(mine.id), undefined);
  await dispose();
  await other.dispose();
});

test('a plugin owns a bounded number of pipelines', async () => {
  const { plugin, dispose } = await pluginWith(['pipelines:write'], 'acme-flood-p');
  for (let i = 0; i < MAX_PLUGIN_PIPELINES; i++) await plugin.pipelines.create(flow(`flood ${i}`));
  await assert.rejects(plugin.pipelines.create(flow('one more')), code('quota'));
  await dispose();
});

test('a run with nobody in front is a spawn per step: approval, then a quota shared with missions.spawn, all or nothing (TODO #591)', async () => {
  const id = 'acme-spawn-p';
  const { plugin, dispose } = await pluginWith(ALL, id);
  const pipeline = await plugin.pipelines.create(flow('Gated flow'));
  const opened = () => dbApi.listTasks().filter((t) => t.title.startsWith('Gated flow')).length;
  const forbidden = (re: RegExp) => (e: unknown) => code('forbidden')(e) && re.test((e as Error).message);
  const unattendedAda = <T>(fn: () => Promise<T>) => runPluginRequest({ ...request(ada, { permissions: ['kanban:write'] }), unattended: true as const }, fn);
  try {
    // Not approved: a job runs nothing, nor does a webhook delivery acting for Ada.
    policy({ approved: [] });
    await assert.rejects(plugin.pipelines.run(pipeline.id, { feature: 'x' }), forbidden(/pluginPolicy\.spawn\.approved/));
    await assert.rejects(unattendedAda(() => plugin.pipelines.run(pipeline.id, { feature: 'x' })), forbidden(/pluginPolicy\.spawn\.approved/));
    assert.equal(opened(), 0, 'no step task');
    assert.equal(dbApi.listPipelineRuns(pipeline.id).length, 0, 'no run record');
    // A request answers for its own account.
    const byAda = await asAda(() => plugin.pipelines.run(pipeline.id, { feature: 'x' }));
    assert.equal(byAda.steps.length, 2);
    assert.equal(opened(), 2);

    // Approved, each step counts: 2 steps under a quota of 3 -> one run, never a half one.
    policy({ approved: [id], max: 3, windowMs: 60_000 });
    const job = await plugin.pipelines.run(pipeline.id, { feature: 'y' });
    assert.equal(job.steps.length, 2);
    assert.equal(opened(), 4);
    await assert.rejects(plugin.pipelines.run(pipeline.id, { feature: 'z' }), forbidden(/quota reached/));
    assert.equal(opened(), 4, 'the refused run opened no step');
    assertSpawnAllowed(id);
    assert.throws(() => assertSpawnAllowed(id), /quota reached/, 'the steps counted against missions.spawn');
  } finally {
    resetConfig();
    resetPluginPolicyState();
    await dispose();
  }
});

test('a plugin has a bounded number of runs open at once, whoever answers for them, before the spawn quota (TODO #571)', async () => {
  const id = 'acme-cap-p';
  const { plugin, dispose } = await pluginWith(ALL, id);
  const other = await pluginWith(ALL, 'acme-cap-other');
  const tooMany = (e: unknown) => code('quota')(e)
    && new RegExp(`at most ${MAX_PLUGIN_OPEN_RUNS} pipelines at once \\(${MAX_PLUGIN_OPEN_RUNS} still have pending or running tasks\\)`).test((e as Error).message);
  try {
    // Room for the job runs' steps, plus one: a refused run must not spend it.
    policy({ approved: [id, 'acme-cap-other'], max: (MAX_PLUGIN_OPEN_RUNS - 1) * 2 + 1, windowMs: 60_000 });
    const pipeline = await plugin.pipelines.create(flow('Capped flow'));
    const spare = await plugin.pipelines.create(flow('Spare flow'));
    const runs = [await asAda(() => plugin.pipelines.run(pipeline.id, { feature: 'request' }))];
    runs.push(await plugin.pipelines.run(spare.id, { feature: 'spare' }));
    while (runs.length < MAX_PLUGIN_OPEN_RUNS) runs.push(await plugin.pipelines.run(pipeline.id, { feature: `job ${runs.length}` }));
    assert.equal(dbApi.getPipelineRun(runs[0]!.runId)!.plugin_id, id, 'a run in a request is the plugin\'s too');
    // The app's own runs and another plugin's are not this plugin's.
    runPipeline(pipeline.id, { feature: 'from the app' });
    const elsewhere = await other.plugin.pipelines.create(flow('Other flow'));
    await other.plugin.pipelines.run(elsewhere.id, { feature: 'theirs' });

    const before = dbApi.listPipelineRuns(pipeline.id).length;
    await assert.rejects(plugin.pipelines.run(pipeline.id, { feature: 'one more' }), tooMany);
    await assert.rejects(asAda(() => plugin.pipelines.run(pipeline.id, { feature: 'one more' })), tooMany);
    assert.equal(dbApi.listPipelineRuns(pipeline.id).length, before, 'a refused run writes nothing');
    assertSpawnAllowed(id);
    assert.throws(() => assertSpawnAllowed(id), /quota reached/, 'the refused runs spent no spawn');

    // A run whose tasks are all done frees its place, so does a deleted pipeline's; a blocked step keeps it.
    for (const step of runs[2]!.steps) dbApi.setTaskStatusOnly(step.taskId, 'DONE');
    await plugin.pipelines.delete(spare.id);
    dbApi.setTaskStatusOnly(runs[3]!.steps[0]!.taskId, 'BLOCKED');
    policy({ approved: [id], max: 100, windowMs: 60_000 });
    await plugin.pipelines.run(pipeline.id, { feature: 'after one finished' });
    await plugin.pipelines.run(pipeline.id, { feature: 'after one was deleted' });
    await assert.rejects(plugin.pipelines.run(pipeline.id, { feature: 'still full' }), tooMany);
  } finally {
    resetConfig();
    resetPluginPolicyState();
    await other.dispose();
    await dispose();
  }
});
