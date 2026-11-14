/**
 * `ctx.kanban.todos` — the TO DO notebook and its external references as a
 * THIRD-PARTY plugin reaches them. The facade is bounded by the caller: a
 * plugin serving Bob never reads, ties, unties nor returns Ada's idea, and the
 * owner of an idea and the plugin of a link come from the context, never from
 * the arguments.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-todos-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { TodoLinkError } = await import('../plugins-bundled/kanban/todo-api.js');

const PLUGIN_ID = 'acme-tickets';

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });

function identityOf(user: { id: string; email: string; name: string }) {
  return {
    viewer: { id: user.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(user.id) },
    user: { id: user.id, email: user.email, name: user.name, is_superadmin: false },
    ownerUserId: user.id,
  };
}
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(bob), fn);

async function pluginWith(permissions: string[]) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id: PLUGIN_ID, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

async function codeOf(fn: () => Promise<unknown>): Promise<{ code: string; message: string } | undefined> {
  try { await fn(); } catch (err) {
    return err instanceof TodoLinkError ? { code: err.code, message: err.message } : { code: 'other', message: String(err) };
  }
  return undefined;
}

const countIdeas = () => dbApi.listProjectTodo({}).length;

test('an authorised caller creates its idea with its links, and a replay finds it', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write']);
  const ticket = { provider: 'github', ref: 'acme/app#1', url: 'https://github.com/acme/app/issues/1', label: 'Issue #1' };

  const first = await asAda(() => plugin.kanban.todos.create({ text: 'Crash on save' }, [ticket]));
  assert.equal(first.created, true);
  assert.equal(first.item.owner_user_id, ada.id);
  assert.deepEqual(first.item.links.map((l) => [l.provider, l.ref, l.plugin_id]), [['github', 'acme/app#1', PLUGIN_ID]]);

  const before = countIdeas();
  const replay = await asAda(() => plugin.kanban.todos.create({ text: 'Crash on save (again)' }, [ticket]));
  assert.equal(replay.created, false);
  assert.equal(replay.item.id, first.item.id);
  assert.equal(countIdeas(), before, 'a replayed ticket writes nothing');

  assert.equal((await asAda(() => plugin.kanban.todos.links.findByRef('github', 'acme/app#1')))?.id, first.item.id);
  assert.equal((await asAda(() => plugin.kanban.todos.get(first.item.id)))?.text, 'Crash on save');
  await asAda(() => plugin.kanban.todos.links.set(first.item.id, { provider: 'discord', ref: 'thread-9' }));
  assert.deepEqual((await asAda(() => plugin.kanban.todos.links.list(first.item.id))).map((l) => l.provider), ['github', 'discord']);
  assert.equal(await asAda(() => plugin.kanban.todos.links.remove(first.item.id, 'discord', 'thread-9')), true);
  await dispose();
});

test('a missing permission is refused before anything is read or written', async () => {
  const reader = await pluginWith(['todos:read']);
  const before = countIdeas();
  await assert.rejects(asAda(() => reader.plugin.kanban.todos.create({ text: 'nope' }, [{ provider: 'gh', ref: 'p-1' }])), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.kanban.todos.links.set(1, { provider: 'gh', ref: 'p-2' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.kanban.todos.links.remove(1, 'gh', 'p-2')), PluginPermissionError);
  assert.equal(countIdeas(), before);
  await reader.dispose();

  // The task permissions are not the notebook's: an idea is not a task.
  const tasksOnly = await pluginWith(['kanban:read', 'kanban:write']);
  await assert.rejects(asAda(() => tasksOnly.plugin.kanban.todos.get(1)), PluginPermissionError);
  await assert.rejects(asAda(() => tasksOnly.plugin.kanban.todos.links.findByRef('gh', 'p-1')), PluginPermissionError);
  await assert.rejects(asAda(() => tasksOnly.plugin.kanban.todos.links.list(1)), PluginPermissionError);
  await tasksOnly.dispose();
});

test('another account\'s idea and its references are invisible and untouchable', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write']);
  const { item } = await asAda(() => plugin.kanban.todos.create({ text: 'Ada private' }, [{ provider: 'jira', ref: 'ADA-1' }]));

  assert.equal(await asBob(() => plugin.kanban.todos.get(item.id)), undefined);
  assert.equal(await asBob(() => plugin.kanban.todos.links.findByRef('jira', 'ADA-1')), undefined);
  assert.equal((await codeOf(() => asBob(() => plugin.kanban.todos.links.list(item.id))))?.code, 'not_found');
  assert.equal((await codeOf(() => asBob(() => plugin.kanban.todos.links.set(item.id, { provider: 'jira', ref: 'BOB-1' }))))?.code, 'not_found');
  assert.equal((await codeOf(() => asBob(() => plugin.kanban.todos.links.remove(item.id, 'jira', 'ADA-1'))))?.code, 'not_found');

  // Bob's own idea cannot steal Ada's ticket, and the refusal names nothing.
  const bobs = await asBob(() => plugin.kanban.todos.create({ text: 'Bob idea' }));
  const stolen = await codeOf(() => asBob(() => plugin.kanban.todos.links.set(bobs.item.id, { provider: 'jira', ref: 'ADA-1' })));
  assert.equal(stolen?.code, 'conflict');
  assert.ok(!stolen?.message.includes(String(item.id)), stolen?.message);

  // A replay of Ada's ticket under Bob neither hands her idea over nor duplicates it.
  const before = countIdeas();
  const replay = await codeOf(() => asBob(() => plugin.kanban.todos.create({ text: 'same ticket' }, [{ provider: 'jira', ref: 'ADA-1' }])));
  assert.equal(replay?.code, 'conflict');
  assert.ok(!replay?.message.includes(String(item.id)), replay?.message);
  assert.equal(countIdeas(), before);

  assert.deepEqual(dbApi.listTodoExternalRefs([item.id]).map((r) => r.ref), ['ADA-1'], 'Ada\'s link is intact');
  await dispose();
});

test('owner and plugin come from the context, not from the arguments', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write']);
  // Plain JS ignores the types: a forged owner or plugin id must not be obeyed.
  const forgedInput = Object.assign({ text: 'forged' }, { ownerUserId: ada.id });
  const forgedLink = Object.assign({ provider: 'gh', ref: 'forged-1' }, { pluginId: 'someone-else' });
  const { item } = await asBob(() => plugin.kanban.todos.create(forgedInput, [forgedLink]));
  assert.equal(item.owner_user_id, bob.id);
  assert.equal(item.links[0]?.plugin_id, PLUGIN_ID);

  const set = await asBob(() => plugin.kanban.todos.links.set(item.id, Object.assign({ provider: 'gh', ref: 'forged-2' }, { pluginId: 'someone-else' })));
  assert.equal(set.plugin_id, PLUGIN_ID);

  // A job is the plugin itself: it owns what it creates and sees nothing else.
  const job = await plugin.kanban.todos.create({ text: 'from a poller' }, [{ provider: 'gh', ref: 'job-1' }]);
  assert.equal(job.item.owner_user_id, `plugin:${PLUGIN_ID}`);
  assert.equal((await plugin.kanban.todos.links.findByRef('gh', 'job-1'))?.id, job.item.id);
  assert.equal(await plugin.kanban.todos.get(item.id), undefined);
  assert.equal(await plugin.kanban.todos.links.findByRef('gh', 'forged-1'), undefined);
  await dispose();
});

test('creation is atomic: a refused link leaves no idea behind', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write']);
  const before = countIdeas();
  const bad = await codeOf(() => asAda(() => plugin.kanban.todos.create({ text: 'half' }, [
    { provider: 'gh', ref: 'ok-1' },
    { provider: 'gh', ref: 'bad-1', url: 'javascript:alert(1)' },
  ])));
  assert.equal(bad?.code, 'invalid');
  assert.equal(countIdeas(), before);
  assert.equal(dbApi.getTodoExternalRef('gh', 'ok-1'), undefined);

  // Two links already tied to two different ideas: refused, nothing written.
  const a = await asAda(() => plugin.kanban.todos.create({ text: 'a' }, [{ provider: 'gh', ref: 'a-1' }]));
  const b = await asAda(() => plugin.kanban.todos.create({ text: 'b' }, [{ provider: 'gh', ref: 'b-1' }]));
  const split = await codeOf(() => asAda(() => plugin.kanban.todos.create({ text: 'both' }, [
    { provider: 'gh', ref: 'a-1' }, { provider: 'gh', ref: 'b-1' }, { provider: 'gh', ref: 'c-1' },
  ])));
  assert.equal(split?.code, 'conflict');
  assert.equal(dbApi.getTodoExternalRef('gh', 'c-1'), undefined);
  assert.equal(dbApi.getTodoExternalRef('gh', 'a-1')?.todo_id, a.item.id);
  assert.equal(dbApi.getTodoExternalRef('gh', 'b-1')?.todo_id, b.item.id);
  await dispose();
});

test('a task created with `todoId` works on that idea; another account\'s idea answers like a missing one', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write', 'kanban:write']);
  const adas = await asAda(() => plugin.kanban.todos.create({ text: 'Ada idea for a task' }));
  const bobs = await asBob(() => plugin.kanban.todos.create({ text: 'Bob idea' }));

  const task = await asAda(() => plugin.kanban.add({ title: 'Study it', agent: 'a.researcher', type: 'research', todoId: adas.item.id })) as { id: string; todo_id: number | null };
  assert.equal(dbApi.getTask(task.id)?.todo_id, adas.item.id);

  const tasksBefore = dbApi.listTasks().length;
  for (const todoId of [bobs.item.id, 999_999, -1, 1.5]) {
    await assert.rejects(asAda(() => plugin.kanban.add({ title: 'Nope', agent: 'a.researcher', todoId })), /idea not found/, String(todoId));
  }
  assert.equal(dbApi.listTasks().length, tasksBefore, 'nothing was created');

  const plain = await asAda(() => plugin.kanban.add({ title: 'No idea', agent: 'a.researcher' })) as { id: string };
  assert.equal(dbApi.getTask(plain.id)?.todo_id, null);
  await dispose();
});

test('list shows a user only the ideas of that user; a job only the plugin\'s own', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write']);
  const mine = await asAda(() => plugin.kanban.todos.create({ text: 'list: Ada open', project: 'list-proj' }, [{ provider: 'gh', ref: 'list-1' }]));
  await asAda(() => plugin.kanban.todos.create({ text: 'list: Ada urgent', urgency: 'bug' }));
  const theirs = await asBob(() => plugin.kanban.todos.create({ text: 'list: Bob private' }));
  const job = await plugin.kanban.todos.create({ text: 'list: from a poller' });

  const adas = await asAda(() => plugin.kanban.todos.list());
  assert.ok(adas.some((i) => i.id === mine.item.id));
  assert.ok(adas.every((i) => i.owner_user_id === ada.id), 'only Ada\'s ideas');
  assert.ok(!adas.some((i) => i.id === theirs.item.id || i.id === job.item.id));
  assert.deepEqual(adas.find((i) => i.id === mine.item.id)?.links.map((l) => l.ref), ['list-1'], 'links ride along');

  assert.deepEqual((await asAda(() => plugin.kanban.todos.list({ project: 'list-proj' }))).map((i) => i.id), [mine.item.id]);
  assert.deepEqual((await asAda(() => plugin.kanban.todos.list({ urgency: 'bug' }))).map((i) => i.text), ['list: Ada urgent']);
  assert.equal((await asAda(() => plugin.kanban.todos.list({ limit: 1 }))).length, 1);
  const bobs = await asBob(() => plugin.kanban.todos.list());
  assert.ok(bobs.some((i) => i.id === theirs.item.id) && bobs.every((i) => i.owner_user_id === bob.id), 'only Bob\'s ideas');

  // A job is the plugin itself: it lists what it created and nothing else.
  assert.ok((await plugin.kanban.todos.list()).every((i) => i.owner_user_id === `plugin:${PLUGIN_ID}`));
  assert.ok((await plugin.kanban.todos.list()).some((i) => i.id === job.item.id));

  for (const bad of [{ limit: 0 }, { limit: 500 }, { status: 'all' }, { owner: ada.id }, { project: '' }]) {
    assert.equal((await codeOf(() => asAda(() => plugin.kanban.todos.list(bad as never))))?.code, 'invalid', JSON.stringify(bad));
  }
  await dispose();
});

test('list, promote and delete are refused without their permission, and promote needs both', async () => {
  const idea = dbApi.insertProjectTodo({ text: 'perm: untouched', ownerUserId: ada.id });
  const tasksBefore = dbApi.listTasks().length;

  const writer = await pluginWith(['todos:write']);
  await assert.rejects(asAda(() => writer.plugin.kanban.todos.list()), PluginPermissionError);
  await writer.dispose();

  const reader = await pluginWith(['todos:read', 'kanban:write']);
  await assert.rejects(asAda(() => reader.plugin.kanban.todos.promote(idea.id, { agent: 'a.coder' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.kanban.todos.delete(idea.id)), PluginPermissionError);
  await reader.dispose();

  // `todos:write` alone must not open a way to create a task: that is `kanban:write`.
  const noTasks = await pluginWith(['todos:read', 'todos:write']);
  await assert.rejects(asAda(() => noTasks.plugin.kanban.todos.promote(idea.id, { agent: 'a.coder' })), PluginPermissionError);
  await noTasks.dispose();

  const tasksOnly = await pluginWith(['kanban:write', 'kanban:read']);
  await assert.rejects(asAda(() => tasksOnly.plugin.kanban.todos.promote(idea.id, { agent: 'a.coder' })), PluginPermissionError);
  await tasksOnly.dispose();

  assert.equal(dbApi.getProjectTodo(idea.id)?.status, 'open');
  assert.equal(dbApi.listTasks().length, tasksBefore, 'no task was created');
});

test('promote makes the task, marks the idea and carries it; a second promotion conflicts', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write', 'kanban:write']);
  const { item } = await asAda(() => plugin.kanban.todos.create({ text: 'Ship the thing', notes: 'details' }));

  const done = await asAda(() => plugin.kanban.todos.promote(item.id, { agent: 'a.researcher', type: 'research', priority: 4, pipeline: 'code-self' }));
  const task = dbApi.getTask((done.task as { id: string }).id);
  assert.equal(task?.title, 'Ship the thing');
  assert.equal(task?.agent_name, 'a.researcher');
  assert.equal(task?.type, 'research');
  assert.equal(task?.priority, 4);
  assert.equal(task?.pipeline, 'code-self');
  assert.equal(task?.todo_id, item.id, 'the task carries its idea: that is what closes it');
  assert.equal(task?.owner_user_id, ada.id);
  assert.match(task?.description ?? '', new RegExp(`idea #${item.id}`));
  assert.equal(done.item.status, 'promoted');
  assert.equal(done.item.promoted_task_id, task?.id);

  const tasksBefore = dbApi.listTasks().length;
  const again = await codeOf(() => asAda(() => plugin.kanban.todos.promote(item.id, { agent: 'a.researcher' })));
  assert.equal(again?.code, 'conflict');
  assert.equal(dbApi.listTasks().length, tasksBefore, 'a second promotion creates nothing');
  await dispose();
});

test('promote of an idea the caller cannot see or own answers like a missing one, and creates nothing', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write', 'kanban:write']);
  const adas = await asAda(() => plugin.kanban.todos.create({ text: 'Ada, not for Bob' }));
  const tasksBefore = dbApi.listTasks().length;

  const stranger = await codeOf(() => asBob(() => plugin.kanban.todos.promote(adas.item.id, { agent: 'a.researcher' })));
  const missing = await codeOf(() => asBob(() => plugin.kanban.todos.promote(999_999, { agent: 'a.researcher' })));
  assert.equal(stranger?.code, 'not_found');
  assert.equal(stranger?.message.replace(String(adas.item.id), '#'), missing?.message.replace('999999', '#'), 'same answer');
  // The input is not judged for an idea the caller does not see.
  assert.equal((await codeOf(() => asBob(() => plugin.kanban.todos.promote(adas.item.id, { agent: '' }))))?.code, 'not_found');

  // A job does not see Ada's ideas either.
  assert.equal((await codeOf(() => plugin.kanban.todos.promote(adas.item.id, { agent: 'a.researcher' })))?.code, 'not_found');

  assert.equal(dbApi.getProjectTodo(adas.item.id)?.status, 'open');
  assert.equal(dbApi.listTasks().length, tasksBefore);
  await dispose();
});

test('promote refuses a bad input without creating a task or marking the idea', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write', 'kanban:write']);
  const { item } = await asAda(() => plugin.kanban.todos.create({ text: 'Strict input' }));
  const orphan = dbApi.insertProjectTodo({ text: 'Project gone', project: 'no-such-project', ownerUserId: ada.id });
  const tasksBefore = dbApi.listTasks().length;

  const bad: Array<[number, Record<string, unknown>]> = [
    [item.id, {}],
    [item.id, { agent: '  ' }],
    [item.id, { agent: 'a.coder', pipeline: 'chaos' }],
    [item.id, { agent: 'a.coder', base: '--upload-pack=x' }],
    [item.id, { agent: 'a.coder', base: '../escape' }],
    [item.id, { agent: 'a.coder', type: 'wizardry' }],
    [item.id, { agent: 'a.coder', priority: Number.NaN }],
    [item.id, { agent: 'a.coder', backend_override: 'codex' }],
    [orphan.id, { agent: 'a.coder' }],
  ];
  for (const [id, input] of bad) {
    assert.equal((await codeOf(() => asAda(() => plugin.kanban.todos.promote(id, input as never))))?.code, 'invalid', JSON.stringify(input));
  }
  assert.equal(dbApi.listTasks().length, tasksBefore);
  assert.equal(dbApi.getProjectTodo(item.id)?.promoted_task_id, null);
  assert.equal(dbApi.getProjectTodo(orphan.id)?.promoted_task_id, null);

  const ok = await asAda(() => plugin.kanban.todos.promote(item.id, { agent: 'a.researcher', type: 'research', base: 'release/1.2', pipeline: 'full' }));
  assert.equal(dbApi.getTask((ok.task as { id: string }).id)?.base_branch, 'release/1.2');
  await dispose();
});

test('delete removes the idea and its links; another account\'s idea answers not_found and stays', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write']);
  const adas = await asAda(() => plugin.kanban.todos.create({ text: 'Ada, to delete' }, [{ provider: 'gh', ref: 'del-1' }]));

  assert.equal((await codeOf(() => asBob(() => plugin.kanban.todos.delete(adas.item.id))))?.code, 'not_found');
  assert.equal((await codeOf(() => plugin.kanban.todos.delete(adas.item.id)))?.code, 'not_found', 'a job does not see it either');
  assert.ok(dbApi.getProjectTodo(adas.item.id), 'the row is still there');
  assert.equal(dbApi.getTodoExternalRef('gh', 'del-1')?.todo_id, adas.item.id);

  await asAda(() => plugin.kanban.todos.delete(adas.item.id));
  assert.equal(dbApi.getProjectTodo(adas.item.id), undefined);
  assert.equal(dbApi.getTodoExternalRef('gh', 'del-1'), undefined, 'the cascade took the links');
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.todos.delete(adas.item.id))))?.code, 'not_found', 'deleting twice');
  assert.equal((await codeOf(() => asAda(() => plugin.kanban.todos.delete(999_999))))?.code, 'not_found');
  await dispose();
});
