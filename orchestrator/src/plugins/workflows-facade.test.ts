/**
 * `ctx.workflows.list / get / run / status / cancel` (API 10): a plugin runs the
 * published workflows its caller can see, and nothing else. Refusals come
 * first: permission, anonymous, an account without `workflows:run`, another
 * account's workflow and run, an unpublished workflow, a job, a run with nobody
 * in front from a plugin the operator did not approve.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-workflows-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError } = await import('./context.js');
const { PluginAutomationError } = await import('./automation-scope.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { createRun } = await import('../workflows/engine.js');
const { workflowsFor } = await import('./workflows-facade.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { assertSpawnAllowed, resetPluginPolicyState } = await import('./policy.js');

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });

type Who = { id: string; email: string; name: string };
const request = (user: Who, over: { superadmin?: boolean; permissions?: string[] } = {}) => ({
  viewer: { id: user.id, isSuperadmin: over.superadmin === true, permissions: over.permissions ?? [] },
  user: { id: user.id, email: user.email, name: user.name, is_superadmin: over.superadmin === true },
  ownerUserId: user.id,
});
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(request(ada, { permissions: ['workflows:run'] }), fn);
const asAdaReadOnly = <T>(fn: () => Promise<T>) => runPluginRequest(request(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob, { permissions: ['workflows:run'] }), fn);
const asAdmin = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob, { superadmin: true }), fn);
const anonymous = <T>(fn: () => Promise<T>) => runPluginRequest({ viewer: null, user: undefined, ownerUserId: null }, fn);

async function pluginWith(permissions: string[], id = 'acme-wf') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: `holder-${id}`, apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  // The engine's plain entry point: `startWorkflowRun` would launch the run's pilot, a real mission.
  const host = { ...daemonHost(root), workflowRuns: { open: (scope: Parameters<typeof workflowsFor>[0]) => workflowsFor(scope, { start: createRun }) } };
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, host);
  return { plugin, dispose: () => root.fiber.dispose() };
}

const code = (c: string) => (e: unknown) => e instanceof PluginAutomationError && e.code === c;
const definition = {
  schemaVersion: 1 as const,
  nodes: [{ id: 'start', type: 'trigger.manual', config: {} }, { id: 'result', type: 'output', config: { template: '{{input.name}}' } }],
  edges: [{ id: 'a', from: 'start', fromPort: 'out', to: 'result', toPort: 'in' }],
  variables: [], settings: { maxParallel: 3, onError: 'fail' as const },
};
function seed(owner: string | null, name: string, published = true): string {
  const id = randomUUID();
  const now = Date.now();
  dbApi.insertWorkflow({
    id, slug: `wf-${id.slice(0, 8)}`, name, description: null, project: null, owner_user_id: owner,
    draft: JSON.stringify(definition), published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: null,
  });
  if (published) dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
  return id;
}

test('each door needs its permission; run and cancel need workflows:run', async () => {
  const none = await pluginWith(['notify']);
  await assert.rejects(asAda(() => none.plugin.workflows.list()), PluginPermissionError);
  await assert.rejects(asAda(() => none.plugin.workflows.status('x')), PluginPermissionError);
  await none.dispose();

  const reader = await pluginWith(['workflows:read']);
  assert.deepEqual(await asAda(() => reader.plugin.workflows.list()), []);
  await assert.rejects(asAda(() => reader.plugin.workflows.run('x')), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.workflows.cancel('x')), PluginPermissionError);
  await reader.dispose();

  const runner = await pluginWith(['workflows:run']);
  assert.deepEqual(await asAda(() => runner.plugin.workflows.list()), [], 'running implies being able to look');
  await runner.dispose();
});

test('an anonymous request is refused; an account without workflows:run cannot run or cancel', async () => {
  const { plugin, dispose } = await pluginWith(['workflows:read', 'workflows:run'], 'acme-wf-anon');
  const mine = seed(ada.id, 'Ada flow');
  await assert.rejects(anonymous(() => plugin.workflows.list()), PluginCallerError);
  await assert.rejects(anonymous(() => plugin.workflows.run(mine)), PluginCallerError);
  await assert.rejects(asAdaReadOnly(() => plugin.workflows.run(mine)), PluginCallerError);
  await assert.rejects(asAdaReadOnly(() => plugin.workflows.cancel('x')), PluginCallerError);
  assert.equal(dbApi.listWorkflowRuns(mine).length, 0);
  assert.equal((await asAdaReadOnly(() => plugin.workflows.list())).length > 0, true, 'reading needs no account right');
  await dispose();
});

test('a user sees and runs his own workflows; another account\'s look missing', async () => {
  const { plugin, dispose } = await pluginWith(['workflows:read', 'workflows:run'], 'acme-wf-own');
  const adas = seed(ada.id, 'Ada visible');
  const bobs = seed(bob.id, 'Bob hidden');
  const system = seed(null, 'System hidden');

  const listed = (await asAda(() => plugin.workflows.list())).map((w) => w.id);
  assert.ok(listed.includes(adas));
  assert.ok(!listed.includes(bobs) && !listed.includes(system));
  const detail = await asAda(() => plugin.workflows.get(adas));
  assert.equal(detail?.publishedVersion, 1);
  assert.deepEqual(detail?.entryNodes.map((n) => n.id), ['start']);
  assert.equal(await asAda(() => plugin.workflows.get(bobs)), undefined);
  await assert.rejects(asAda(() => plugin.workflows.run(bobs)), code('not_found'));
  await assert.rejects(asAda(() => plugin.workflows.run(system)), code('not_found'));

  const run = await asAda(() => plugin.workflows.run(adas, { name: 'Ada' }));
  assert.equal(run.workflowId, adas);
  assert.equal(dbApi.getWorkflowRun(run.id)!.owner_user_id, ada.id, 'the run belongs to the caller');
  assert.deepEqual(JSON.parse(dbApi.getWorkflowRun(run.id)!.trigger), { kind: 'api', plugin: 'acme-wf-own' });
  const status = await asAda(() => plugin.workflows.status(run.id));
  assert.equal(status?.id, run.id);
  assert.deepEqual(status?.input, { name: 'Ada' });
  assert.ok(status && status.nodes.length === 2);

  // Bob cannot read or cancel Ada's run; a superadmin can read any.
  assert.equal(await asBob(() => plugin.workflows.status(run.id)), undefined);
  assert.equal(await asBob(() => plugin.workflows.cancel(run.id)), false);
  assert.ok(await asAdmin(() => plugin.workflows.status(run.id)));
  assert.equal(await asAda(() => plugin.workflows.status('missing')), undefined);
  await dispose();
});

test('an unpublished workflow, an oversized input and a job', async () => {
  const { plugin, dispose } = await pluginWith(['workflows:read', 'workflows:run'], 'acme-wf-edge');
  const draft = seed(ada.id, 'Draft only', false);
  const live = seed(ada.id, 'Live');
  await assert.rejects(asAda(() => plugin.workflows.run(draft)), code('invalid'));
  await assert.rejects(asAda(() => plugin.workflows.run(live, { blob: 'x'.repeat(70_000) })), code('invalid'));
  assert.equal(dbApi.listWorkflowRuns(draft).length + dbApi.listWorkflowRuns(live).length, 0);
  // A job acts as plugin:<id>: it owns no workflow, so it sees none and runs none.
  assert.deepEqual(await plugin.workflows.list(), []);
  assert.equal(await plugin.workflows.get(live), undefined);
  await assert.rejects(plugin.workflows.run(live), code('not_found'));
  assert.equal(await plugin.workflows.cancel('missing'), false);
  await dispose();
});

test('cancel stops a live run of the caller', async () => {
  const { plugin, dispose } = await pluginWith(['workflows:read', 'workflows:run'], 'acme-wf-cancel');
  const id = seed(ada.id, 'Cancellable');
  const run = dbApi.getWorkflowRun((await asAda(() => plugin.workflows.run(id, {}))).id)!;
  dbApi.updateWorkflowRun(run.id, { status: 'running' });
  assert.equal(await asAda(() => plugin.workflows.cancel(run.id)), true);
  assert.equal(dbApi.getWorkflowRun(run.id)!.status, 'cancelled');
  assert.equal(await asAda(() => plugin.workflows.cancel(run.id)), false, 'already over');
  await dispose();
});

test('a run with nobody in front is a spawn: approval, then the quota shared with missions.spawn (TODO #591)', async () => {
  const id = 'acme-wf-spawn';
  const { plugin, dispose } = await pluginWith(['workflows:read', 'workflows:run'], id);
  const workflow = seed(ada.id, 'Gated');
  const runs = () => dbApi.listWorkflowRuns(workflow).length;
  const policy = (spawn: { approved: string[]; max?: number; windowMs?: number }) => {
    setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn } }));
    resetPluginPolicyState();
  };
  // An event handler or a webhook delivery acts for Ada, without Ada.
  const unattendedAda = <T>(fn: () => Promise<T>) => runPluginRequest({ ...request(ada, { permissions: ['workflows:run'] }), unattended: true as const }, fn);
  const forbidden = (re: RegExp) => (e: unknown) => code('forbidden')(e) && re.test((e as Error).message);
  try {
    policy({ approved: [] });
    await assert.rejects(unattendedAda(() => plugin.workflows.run(workflow)), forbidden(/pluginPolicy\.spawn\.approved/));
    assert.equal(runs(), 0, 'no run started');
    // A request answers for its own account.
    await asAda(() => plugin.workflows.run(workflow));
    assert.equal(runs(), 1);

    policy({ approved: [id], max: 2, windowMs: 60_000 });
    await unattendedAda(() => plugin.workflows.run(workflow));
    assert.equal(runs(), 2);
    assertSpawnAllowed(id);
    await assert.rejects(unattendedAda(() => plugin.workflows.run(workflow)), forbidden(/quota reached/));
    assert.equal(runs(), 2, 'over the quota, no run');
  } finally {
    resetConfig();
    resetPluginPolicyState();
    await dispose();
  }
});
