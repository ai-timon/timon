/**
 * `ctx.kanban` — the board's tasks as a THIRD-PARTY plugin reaches them. The
 * facade is bounded by the caller: a plugin serving Bob never reads, edits,
 * closes, deletes nor links Ada's task; a job writes only what it created and
 * reads beyond that only the projects the operator granted; overrides never
 * widen what the assigned agent holds; and a mirror task is data, not work.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-tasks-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { PluginTaskError } = await import('./tasks-facade.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { agentDir } = await import('../paths.js');
const { assertSpawnAllowed, resetPluginPolicyState, spawnCardsSettled } = await import('./policy.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const PLUGIN_ID = 'acme-sync';

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });
const root = createTestAccount(dbApi, { email: 'root@example.com', name: 'Root', passwordHash: await hashPassword('root-secret'), isSuperadmin: true });

function identityOf(user: { id: string; email: string; name: string }, superadmin = false) {
  return {
    viewer: { id: user.id, isSuperadmin: superadmin, permissions: dbApi.listPermissionsForUser(user.id) },
    user: { id: user.id, email: user.email, name: user.name, is_superadmin: superadmin },
    ownerUserId: user.id,
  };
}
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(bob), fn);
const asRoot = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(root, true), fn);
const asAnonymous = <T>(fn: () => Promise<T>) => runPluginRequest({ viewer: null, user: undefined, ownerUserId: null }, fn);

function agent(name: string, config: Record<string, unknown>): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify(config));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test agent.');
}
agent('worker', { cwd: process.env.TIMON_HOME, permission_mode: 'auto', allowed_tools: ['Read'], mcp_servers: [] });
agent('proj-worker', { cwd: process.env.TIMON_HOME, project: 'secret-proj' });
agent('locked', { cwd: process.env.TIMON_HOME, permission_mode: 'plan', allowed_tools: [], mcp_servers: [] });

const ALL = ['kanban:read', 'kanban:write', 'kanban:delete', 'kanban:read:project', 'events:subscribe'];

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

async function codeOf(fn: () => Promise<unknown>): Promise<{ code: string; message: string; reason?: string } | undefined> {
  try { await fn(); } catch (err) {
    return err instanceof PluginTaskError ? { code: err.code, message: err.message, reason: err.reason } : { code: 'other', message: String(err) };
  }
  return undefined;
}

const taskCount = () => dbApi.listTasks().length;
let n = 0;
const ref = () => `acme/app#${++n}`;

test.after(() => resetConfig());

test('an authorised caller creates, reads, edits and lists its task', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const created = await asAda(() => plugin.kanban.add({ title: 'Write the report', agent: 'worker', priority: 4 }));
  assert.equal(created.owner_user_id, ada.id);
  assert.equal(created.mirror, false);
  assert.deepEqual(created.links, []);
  assert.equal((await asAda(() => plugin.kanban.get(created.id)))?.title, 'Write the report');

  const edited = await asAda(() => plugin.kanban.update(created.id, { title: 'Write the report v2', priority: 2 }));
  assert.equal(edited.title, 'Write the report v2');
  assert.equal(edited.priority, 2);
  const listed = await asAda(() => plugin.kanban.list({ status: 'PENDING' }));
  assert.ok(listed.some((t) => t.id === created.id));
  await dispose();
});

test('list takes one status or several: a task comes back once, an empty or unknown list is invalid', async () => {
  const { plugin, dispose } = await pluginWith(['kanban:read', 'kanban:write']);
  const pending = await asAda(() => plugin.kanban.add({ title: 'multi-a', agent: 'worker' }));
  const blocked = await asAda(() => plugin.kanban.add({ title: 'multi-b', agent: 'worker', mirror: true } as never));
  await asAda(() => plugin.kanban.block(blocked.id, 'waiting'));
  const ids = (await asAda(() => plugin.kanban.list({ status: ['PENDING', 'BLOCKED', 'PENDING'] }))).map((t) => t.id);
  assert.ok(ids.includes(pending.id) && ids.includes(blocked.id));
  assert.equal(new Set(ids).size, ids.length, 'no task twice');
  const only = (await asAda(() => plugin.kanban.list({ status: ['BLOCKED'] }))).map((t) => t.id);
  assert.ok(only.includes(blocked.id) && !only.includes(pending.id));
  await assert.rejects(asAda(() => plugin.kanban.list({ status: [] })), { code: 'invalid' });
  await assert.rejects(asAda(() => plugin.kanban.list({ status: ['PENDING', 'NOPE'] })), { code: 'invalid' });
  await dispose();
});

test('a missing permission is refused before anything is read or written', async () => {
  const reader = await pluginWith(['kanban:read']);
  const before = taskCount();
  await assert.rejects(asAda(() => reader.plugin.kanban.add({ title: 't', agent: 'worker' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.kanban.done('x', { comment: 'c' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.kanban.block('x', 'r')), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.kanban.refs.set('x', { provider: 'gh', ref: '1' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.kanban.ensure({ title: 't', agent: 'worker' }, [{ provider: 'gh', ref: '1' }])), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.kanban.delete('x')), PluginPermissionError);
  assert.equal(taskCount(), before);
  await reader.dispose();

  // Deleting is its own, sensitive permission: writing does not carry it.
  const writer = await pluginWith(['kanban:read', 'kanban:write']);
  const mine = await asAda(() => writer.plugin.kanban.add({ title: 'keep', agent: 'worker' }));
  await assert.rejects(asAda(() => writer.plugin.kanban.delete(mine.id)), PluginPermissionError);
  assert.ok(dbApi.getTask(mine.id));
  await writer.dispose();

  const blind = await pluginWith(['kanban:write']);
  await assert.rejects(asAda(() => blind.plugin.kanban.get('x')), PluginPermissionError);
  await assert.rejects(asAda(() => blind.plugin.kanban.refs.findByRef('gh', '1')), PluginPermissionError);
  await blind.dispose();
});

test('another account\'s task and its references are invisible and untouchable', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const r = ref();
  const { task } = await asAda(() => plugin.kanban.ensure({ title: 'Ada private', agent: 'worker' }, [{ provider: 'jira', ref: r }]));

  assert.equal(await asBob(() => plugin.kanban.get(task.id)), undefined);
  assert.equal(await asBob(() => plugin.kanban.refs.findByRef('jira', r)), undefined);
  assert.equal((await asBob(() => plugin.kanban.list())).some((t) => t.id === task.id), false);
  for (const attempt of [
    () => plugin.kanban.update(task.id, { title: 'hijack' }),
    () => plugin.kanban.done(task.id, { comment: 'done' }),
    () => plugin.kanban.block(task.id, 'blocked'),
    () => plugin.kanban.delete(task.id),
    () => plugin.kanban.refs.list(task.id),
    () => plugin.kanban.refs.set(task.id, { provider: 'jira', ref: 'BOB-1' }),
    () => plugin.kanban.refs.remove(task.id, 'jira', r),
  ]) {
    assert.equal((await codeOf(() => asBob(attempt)))?.code, 'not_found');
  }

  // Bob's own task cannot steal Ada's ticket, and the refusal names nothing.
  const bobs = await asBob(() => plugin.kanban.add({ title: 'Bob task', agent: 'worker' }));
  const stolen = await codeOf(() => asBob(() => plugin.kanban.refs.set(bobs.id, { provider: 'jira', ref: r })));
  assert.equal(stolen?.code, 'conflict');
  assert.ok(!stolen?.message.includes(task.id), stolen?.message);
  const replay = await codeOf(() => asBob(() => plugin.kanban.ensure({ title: 'same ticket', agent: 'worker' }, [{ provider: 'jira', ref: r }])));
  assert.equal(replay?.code, 'conflict');
  assert.ok(!replay?.message.includes(task.id), replay?.message);

  assert.equal(dbApi.getTask(task.id)?.title, 'Ada private');
  assert.deepEqual(dbApi.listTaskExternalRefs([task.id]).map((l) => l.ref), [r]);
  await dispose();
});

test('an anonymous request may not delete, close or link, and ensure writes nothing', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const mine = await asAda(() => plugin.kanban.add({ title: 'Ada', agent: 'worker' }));
  const before = taskCount();
  for (const attempt of [
    () => plugin.kanban.delete(mine.id),
    () => plugin.kanban.done(mine.id, { comment: 'c' }),
    () => plugin.kanban.block(mine.id, 'r'),
    () => plugin.kanban.refs.set(mine.id, { provider: 'gh', ref: ref() }),
    () => plugin.kanban.refs.remove(mine.id, 'gh', 'x'),
    () => plugin.kanban.ensure({ title: 't', agent: 'worker' }, [{ provider: 'gh', ref: ref() }]),
  ]) {
    assert.equal((await codeOf(() => asAnonymous(attempt)))?.code, 'forbidden');
  }
  assert.equal(taskCount(), before);
  assert.ok(dbApi.getTask(mine.id));
  await dispose();
});

test('owner and plugin come from the context, not from the arguments', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const forged = Object.assign({ title: 'forged', agent: 'worker' }, { ownerUserId: ada.id, owner_user_id: ada.id });
  const task = await asBob(() => plugin.kanban.add(forged));
  assert.equal(task.owner_user_id, bob.id);
  const link = await asBob(() => plugin.kanban.refs.set(task.id, Object.assign({ provider: 'gh', ref: ref() }, { pluginId: 'someone-else' })));
  assert.equal(link.plugin_id, PLUGIN_ID);
  await dispose();
});

test('ensure is idempotent on the ticket and atomic with its links', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const r = ref();
  const first = await asAda(() => plugin.kanban.ensure({ title: 'Ticket', agent: 'worker', mirror: true }, [{ provider: 'github', ref: r, url: 'https://x.test/1' }]));
  assert.equal(first.created, true);
  assert.deepEqual(first.task.links.map((l) => [l.provider, l.ref, l.plugin_id]), [['github', r, PLUGIN_ID]]);
  const before = taskCount();
  const again = await asAda(() => plugin.kanban.ensure({ title: 'Ticket (again)', agent: 'worker', mirror: true }, [{ provider: 'github', ref: r }]));
  assert.equal(again.created, false);
  assert.equal(again.task.id, first.task.id);
  assert.equal(taskCount(), before);
  assert.equal((await asAda(() => plugin.kanban.refs.findByRef('github', r)))?.id, first.task.id);

  // A refused link leaves no task behind.
  const bad = await codeOf(() => asAda(() => plugin.kanban.ensure({ title: 'Orphan', agent: 'worker' }, [{ provider: 'Not A Slug', ref: 'x' }])));
  assert.equal(bad?.code, 'invalid');
  assert.equal(taskCount(), before);
  const badUrl = await codeOf(() => asAda(() => plugin.kanban.refs.set(first.task.id, { provider: 'github', ref: 'u', url: 'javascript:alert(1)' })));
  assert.equal(badUrl?.code, 'invalid');
  await dispose();
});

test('overrides never widen the agent: refused, then repeated is fine', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const before = taskCount();
  for (const widening of [
    { permissionMode: 'bypassPermissions' },
    { extraAllowedTools: ['Bash'] },
    { extraMcp: ['some-server'] },
    // A backend that cannot arbitrate each tool use, through the task's fallback (TODO #561).
    { fallbackBackend: 'codex' },
  ]) {
    const refused = await codeOf(() => asAda(() => plugin.kanban.add({ title: 'escalate', agent: 'worker', ...widening })));
    assert.equal(refused?.code, 'forbidden', JSON.stringify(widening));
  }
  // Same rule on an unknown backend: a typo must not be dropped silently at dispatch.
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.add({ title: 't', agent: 'worker', backend: 'no-such-backend' }))))?.code, 'invalid');
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.add({ title: 't', agent: 'worker', pipeline: 'sideways' }))))?.code, 'invalid');
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.add({ title: 't', agent: 'worker', base: '--upload-pack=x' }))))?.code, 'invalid');
  assert.equal(taskCount(), before);

  const ok = await asAda(() => plugin.kanban.add({ title: 'within', agent: 'worker', extraAllowedTools: ['Read'], permissionMode: 'auto', pipeline: 'code-self' }));
  assert.equal(dbApi.getTask(ok.id)?.permission_mode_override, 'auto');
  assert.equal(dbApi.getTask(ok.id)?.pipeline, 'code-self');
  const noFallback = await asAda(() => plugin.kanban.add({ title: 'no fallback', agent: 'worker', fallbackBackend: 'none' }));
  assert.equal(dbApi.getTask(noFallback.id)?.fallback_backend_override, 'none');
  // A superadmin's own request lifts the rule, as for ctx.agents.
  const lifted = await asRoot(() => plugin.kanban.add({ title: 'root', agent: 'worker', extraAllowedTools: ['Bash'], fallbackBackend: 'codex' }));
  assert.ok(lifted.id);
  await dispose();
});

test('the legacy refusals keep their wording', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await assert.rejects(asAda(() => plugin.kanban.add({ title: 't', agent: 'a', scheduledAt: '2026-01-01' as unknown as number })), /scheduled_at/i);
  await assert.rejects(asAda(() => plugin.kanban.add({ title: 't', agent: 'a', type: 'invente' })), /invalid task type/);
  await assert.rejects(asAda(() => plugin.kanban.add({ title: '', agent: 'a' })), /are required/);
  await dispose();
});

test('a mirror task is inert, needs no agent, and is closed without a chain', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const mirror = await asAda(() => plugin.kanban.add({ title: 'Card #1', mirror: true }));
  assert.equal(mirror.mirror, true);
  assert.equal(mirror.agent_name, `plugin:${PLUGIN_ID}`);
  assert.equal(dbApi.listPendingReady().some((t) => t.id === mirror.id), false);
  const before = taskCount();

  for (const status of ['IN_PROGRESS', 'BLOCKED', 'PENDING', 'DONE']) {
    const moved = await asAda(() => plugin.kanban.update(mirror.id, { status }));
    assert.equal(moved.status, status);
  }
  assert.equal(taskCount(), before, 'moving a mirror through every status creates nothing');

  // The flag is fixed at creation; a runnable task cannot be turned into a mirror, nor back.
  await asAda(() => plugin.kanban.update(mirror.id, Object.assign({ title: 'Card #1 renamed' }, { mirror: false })));
  assert.equal(dbApi.getTask(mirror.id)?.mirror, 1);
  const real = await asAda(() => plugin.kanban.add({ title: 'real', agent: 'worker' }));
  await asAda(() => plugin.kanban.update(real.id, Object.assign({ title: 'real 2' }, { mirror: true })));
  assert.equal(dbApi.getTask(real.id)?.mirror, 0);

  for (const forbidden of [{ groupId: 'g' }, { todoId: 1 }, { pipeline: 'full' }, { base: 'main' }, { model: 'm' }, { type: 'merge' }]) {
    assert.equal((await codeOf(() => asAda(() => plugin.kanban.add({ title: 'x', mirror: true, ...forbidden }))))?.code, 'invalid', JSON.stringify(forbidden));
  }
  await dispose();
});

test('a task that runs is re-queued by status, closed by done/block, never set IN_PROGRESS', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const task = await asAda(() => plugin.kanban.add({ title: 'work', agent: 'worker' }));
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.update(task.id, { status: 'IN_PROGRESS' }))))?.code, 'invalid');
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.update(task.id, { status: 'DONE' }))))?.code, 'invalid');
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.done(task.id, { comment: '  ' }))))?.code, 'invalid');
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.block(task.id, ''))))?.code, 'invalid');

  const blocked = await asAda(() => plugin.kanban.block(task.id, 'waiting for the ticket'));
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.blocked_reason, 'waiting for the ticket');
  const requeued = await asAda(() => plugin.kanban.update(task.id, { status: 'PENDING', agent: 'proj-worker' }));
  assert.equal(requeued.status, 'PENDING');
  assert.equal(requeued.agent_name, 'proj-worker');
  const done = await asAda(() => plugin.kanban.done(task.id, { comment: 'shipped', summary: 'Shipped it' }));
  assert.equal(done.status, 'DONE');
  assert.equal(done.done_comment, 'shipped');
  assert.equal(done.done_summary, 'Shipped it');

  const merge = await asAda(() => plugin.kanban.add({ title: 'merge it', agent: 'worker', type: 'merge' }));
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.done(merge.id, { comment: 'c', mergedSha: 'xyz' }))))?.code, 'invalid');
  await dispose();
});

test('delete follows the board\'s guards and reports why it refused', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const parent = await asAda(() => plugin.kanban.add({ title: 'parent', agent: 'worker' }));
  const child = await asAda(() => plugin.kanban.add({ title: 'child', agent: 'worker', deps: [parent.id] }));
  const refused = await codeOf(() => asAda(() => plugin.kanban.delete(parent.id)));
  assert.equal(refused?.code, 'conflict');
  assert.equal(refused?.reason, 'task_dependents');
  assert.ok(dbApi.getTask(parent.id));
  assert.deepEqual(await asAda(() => plugin.kanban.delete(child.id)), { deleted: [child.id] });
  assert.deepEqual(await asAda(() => plugin.kanban.delete(parent.id)), { deleted: [parent.id] });
  assert.equal(dbApi.getTask(child.id), undefined);
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.delete(child.id))))?.code, 'not_found');
  await dispose();
});

test('a job writes only its own tasks and reads a granted project, never writes it', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  // A task of the user in a project, and one of another project.
  const inProject = (await asAda(() => plugin.kanban.add({ title: 'in secret-proj', agent: 'proj-worker' }))).id;
  const elsewhere = (await asAda(() => plugin.kanban.add({ title: 'elsewhere', agent: 'worker' }))).id;
  // A job's task that runs is a spawn: the operator approved this plugin.
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn: { approved: [PLUGIN_ID] } } }));
  resetPluginPolicyState();
  const jobTask = await plugin.kanban.add({ title: 'job task', agent: 'worker' });
  assert.equal(jobTask.owner_user_id, `plugin:${PLUGIN_ID}`);

  // No grant: a job sees only what it created.
  setConfig(TimonConfigSchema.parse({}));
  assert.deepEqual((await plugin.kanban.list()).map((t) => t.title), ['job task']);
  assert.equal(await plugin.kanban.get(inProject), undefined);

  // The operator grants the project (and the manifest asked for `kanban:read:project`).
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { kanban: { projects: { [PLUGIN_ID]: ['secret-proj'] } } } }));
  const seen = (await plugin.kanban.list()).map((t) => t.id);
  assert.ok(seen.includes(inProject) && seen.includes(jobTask.id));
  assert.ok(!seen.includes(elsewhere), 'a project nobody granted stays out');
  assert.equal((await plugin.kanban.get(inProject))?.title, 'in secret-proj');
  assert.equal(await plugin.kanban.get(elsewhere), undefined);
  const byProject = (await plugin.kanban.list({ project: 'secret-proj' })).map((t) => t.id);
  assert.ok(byProject.includes(inProject) && !byProject.includes(jobTask.id) && !byProject.includes(elsewhere));

  // Read, never write.
  for (const attempt of [
    () => plugin.kanban.update(inProject, { title: 'hijack' }),
    () => plugin.kanban.done(inProject, { comment: 'c' }),
    () => plugin.kanban.block(inProject, 'r'),
    () => plugin.kanban.delete(inProject),
    () => plugin.kanban.refs.set(inProject, { provider: 'gh', ref: ref() }),
  ]) {
    assert.equal((await codeOf(attempt))?.code, 'forbidden');
  }
  assert.equal((await codeOf(() => plugin.kanban.update(elsewhere, { title: 'x' })))?.code, 'not_found');
  assert.equal(dbApi.getTask(inProject)?.title, 'in secret-proj');

  // Without the manifest permission the grant opens nothing.
  const timid = await pluginWith(['kanban:read']);
  assert.equal(await timid.plugin.kanban.get(inProject), undefined);
  // And a REQUEST is never widened by the grant: it sees what its user sees.
  assert.equal(await asBob(() => plugin.kanban.get(inProject)), undefined);
  await timid.dispose();
  resetConfig();
  await dispose();
});

test('refs: one ticket points at one task; remove is exact', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const a = await asAda(() => plugin.kanban.add({ title: 'a', agent: 'worker' }));
  const b = await asAda(() => plugin.kanban.add({ title: 'b', agent: 'worker' }));
  const r = ref();
  await asAda(() => plugin.kanban.refs.set(a.id, { provider: 'linear', ref: r, label: 'LIN-1' }));
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.refs.set(b.id, { provider: 'linear', ref: r }))))?.code, 'conflict');
  assert.equal(await asAda(() => plugin.kanban.refs.remove(b.id, 'linear', r)), false);
  assert.equal(await asAda(() => plugin.kanban.refs.remove(a.id, 'linear', r)), true);
  assert.equal(await asAda(() => plugin.kanban.refs.findByRef('linear', r)), undefined);
  await dispose();
});

test('a running task is not re-queued, and a new agent must be able to hold the overrides the task carries', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  const running = await asAda(() => plugin.kanban.add({ title: 'running', agent: 'worker' }));
  dbApi.updateTaskStatus(running.id, 'IN_PROGRESS');
  const refused = await codeOf(() => asAda(() => plugin.kanban.update(running.id, { status: 'PENDING' })));
  assert.equal(refused?.code, 'conflict');
  assert.equal(refused?.reason, 'task_state');
  assert.equal(dbApi.getTask(running.id)?.status, 'IN_PROGRESS');

  const carrying = await asAda(() => plugin.kanban.add({
    title: 'carries overrides', agent: 'worker', permissionMode: 'auto', extraAllowedTools: ['Read'],
  }));
  const moved = await codeOf(() => asAda(() => plugin.kanban.update(carrying.id, { agent: 'locked' })));
  assert.equal(moved?.code, 'forbidden');
  assert.equal(dbApi.getTask(carrying.id)?.agent_name, 'worker', 'the row is unchanged');
  // An agent that can hold them takes the task; a superadmin lifts the rule.
  assert.equal((await asAda(() => plugin.kanban.update(carrying.id, { agent: 'worker' }))).agent_name, 'worker');
  assert.equal((await asRoot(() => plugin.kanban.update(carrying.id, { agent: 'locked' }))).agent_name, 'locked');
  await dispose();
});

test('a task that runs, opened with nobody in front, takes the spawn approval and the quota shared with missions.spawn (TODO #562)', async () => {
  const { plugin, dispose } = await pluginWith([...ALL, 'todos:read', 'todos:write']);
  const policy = (spawn: { approved: string[]; max?: number; windowMs?: number }) => {
    setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn } }));
    resetPluginPolicyState();
  };
  const refusal = async (fn: () => Promise<unknown>) => {
    const err = await codeOf(fn);
    assert.equal(err?.code, 'forbidden', JSON.stringify(err));
    assert.equal(err?.reason, 'spawn_policy');
    return err!;
  };
  const unattendedAda = <T>(fn: () => Promise<T>) => runPluginRequest({ ...identityOf(ada), unattended: true as const }, fn);
  try {
    // Not approved: the job opens nothing that runs, and the operator gets the card.
    policy({ approved: [] });
    const before = taskCount();
    const refused = await refusal(() => plugin.kanban.add({ title: 'unapproved job task', agent: 'worker' }));
    assert.match(refused.message, /pluginPolicy\.spawn\.approved/);
    const gh = ref();
    await refusal(() => plugin.kanban.ensure({ title: 'unapproved ensure', agent: 'worker' }, [{ provider: 'gh', ref: gh }]));
    assert.equal(dbApi.getTaskExternalRef('gh', gh), undefined, 'a refused ensure leaves no link behind');
    // A webhook delivery acts for Ada but nobody is in front of it: held like a job.
    await refusal(() => unattendedAda(() => plugin.kanban.add({ title: 'unapproved delivery', agent: 'worker' })));
    assert.equal(taskCount(), before, 'nothing was written');
    await spawnCardsSettled();
    const card = dbApi.listActiveNotifications('action_required').find((n) => n.anchor === `plugin-spawn:${PLUGIN_ID}`);
    assert.ok(card, 'the refusal raised the approval card');
    assert.match(card.body ?? '', /ctx\.kanban\.add/);

    // Promoting an idea opens a task that runs: same gate, the idea stays unpromoted.
    const idea = await plugin.kanban.todos.create({ text: 'job idea' });
    const promoted = await plugin.kanban.todos.promote(idea.item.id, { agent: 'worker' }).then(() => undefined, (err: Error) => err);
    assert.ok(promoted, 'the promotion is refused');
    assert.match(promoted.message, /pluginPolicy\.spawn\.approved/);
    const { code, reason } = promoted as Error & { code?: string; reason?: string };
    assert.deepEqual({ code, reason }, { code: 'forbidden', reason: 'spawn_policy' });
    assert.equal(dbApi.getProjectTodo(idea.item.id, null)?.promoted_task_id ?? null, null);
    assert.equal(taskCount(), before);

    // Not concerned: a mirror never runs, a request answers for its own account.
    const mirror = await plugin.kanban.add({ title: 'mirror of a ticket', mirror: true });
    assert.equal(mirror.mirror, true);
    const byAda = await asAda(() => plugin.kanban.add({ title: 'Ada asks for it', agent: 'worker' }));
    assert.equal(byAda.owner_user_id, ada.id);

    // Approved, the quota is the one of missions.spawn: one window for both.
    policy({ approved: [PLUGIN_ID], max: 2, windowMs: 60_000 });
    assertSpawnAllowed(PLUGIN_ID);
    const job = await plugin.kanban.add({ title: 'approved job task', agent: 'worker' });
    assert.equal(job.owner_user_id, `plugin:${PLUGIN_ID}`);
    const quota = await refusal(() => plugin.kanban.add({ title: 'over the quota', agent: 'worker' }));
    assert.match(quota.message, /quota reached/);
    assert.throws(() => assertSpawnAllowed(PLUGIN_ID), /quota reached/, 'and the tasks count against missions.spawn');

    // Re-queuing runs the task again: a block/re-queue loop does not escape the quota.
    policy({ approved: [PLUGIN_ID], max: 1, windowMs: 60_000 });
    await plugin.kanban.block(job.id, 'waiting');
    assertSpawnAllowed(PLUGIN_ID);
    await refusal(() => plugin.kanban.update(job.id, { status: 'PENDING' }));
    assert.equal(dbApi.getTask(job.id)?.status, 'BLOCKED');
    policy({ approved: [PLUGIN_ID], max: 1, windowMs: 60_000 });
    assert.equal((await plugin.kanban.update(job.id, { status: 'PENDING' })).status, 'PENDING');
  } finally {
    resetConfig();
    resetPluginPolicyState();
    await dispose();
  }
});
