/**
 * `ctx.kanban.todos.attachments`, as a THIRD-PARTY plugin uses it through
 * `createPluginContext`: each method needs its permission, an idea the caller
 * cannot see answers `not_found`, a refused file says why (`reason`), and the
 * bytes read back are the bytes written.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-todo-attachments-facade-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { TodoLinkError } = await import('../plugins-bundled/kanban/todo-api.js');
const { listTodoAttachments } = await import('../attachments.js');

const PLUGIN_ID = 'acme-files';

function member(name: string) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused' });
  grantTestPermissions(dbApi, id, [`plugin:${PLUGIN_ID}`]);
  return user;
}
const ada = member('ada');
const bob = member('bob');
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest({
  viewer: { id: ada.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(ada.id) },
  user: { id: ada.id, email: ada.email, name: ada.name, is_superadmin: false },
  ownerUserId: ada.id,
}, fn);

async function pluginWith(permissions: string[]) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id: PLUGIN_ID, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  return createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const idea = (owner: string) => dbApi.insertProjectTodo({ text: 'With files', ownerUserId: owner }).id;

async function refusal(promise: Promise<unknown>): Promise<InstanceType<typeof TodoLinkError>> {
  const err = await promise.then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof TodoLinkError, `expected a TodoLinkError, got ${String(err)}`);
  return err;
}

test('each method is refused without its permission', async () => {
  const todo = idea(ada.id);
  const none = await pluginWith([]);
  await assert.rejects(asAda(() => none.kanban.todos.attachments.list(todo)), PluginPermissionError);
  await assert.rejects(asAda(() => none.kanban.todos.attachments.read(todo, randomUUID())), PluginPermissionError);
  const reader = await pluginWith(['todos:read']);
  await assert.rejects(asAda(() => reader.kanban.todos.attachments.add(todo, { name: 'a.png', data: PNG })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.kanban.todos.attachments.remove(todo, randomUUID())), PluginPermissionError);
  assert.deepEqual(await asAda(() => reader.kanban.todos.attachments.list(todo)), []);
  assert.equal(listTodoAttachments(todo).length, 0);
});

test('an idea the caller cannot see is not_found, never touched', async () => {
  const theirs = idea(bob.id);
  const plugin = await pluginWith(['todos:read', 'todos:write']);
  const files = plugin.kanban.todos.attachments;
  assert.equal((await refusal(asAda(() => files.add(theirs, { name: 'a.png', data: PNG })))).code, 'not_found');
  assert.equal((await refusal(asAda(() => files.list(theirs)))).code, 'not_found');
  assert.equal((await refusal(asAda(() => files.remove(theirs, randomUUID())))).code, 'not_found');
  assert.equal((await refusal(asAda(() => files.read(theirs, randomUUID())))).code, 'not_found');
  // In a job, the plugin sees only the ideas it created.
  assert.equal((await refusal(files.add(idea(ada.id), { name: 'a.png', data: PNG }))).code, 'not_found');
  assert.equal(listTodoAttachments(theirs).length, 0);
});

test('a refused file says why, and nothing is written', async () => {
  const todo = idea(ada.id);
  const files = (await pluginWith(['todos:read', 'todos:write'])).kanban.todos.attachments;
  const cases: Array<[{ name: string; data: Uint8Array | string }, string]> = [
    [{ name: 'run.sh', data: Buffer.from('echo hi').toString('base64') }, 'attachment_type_refused'],
    [{ name: 'page.html', data: PNG }, 'attachment_type_refused'],
    [{ name: 'shot.png', data: Buffer.from('<script>') }, 'attachment_content_mismatch'],
    [{ name: 'trace.log', data: 'not base64 !' }, 'attachment_invalid'],
    [{ name: 'huge.txt', data: new Uint8Array(15 * 1024 * 1024 + 1).fill(0x41) }, 'attachment_too_large'],
  ];
  for (const [file, reason] of cases) {
    const err = await refusal(asAda(() => files.add(todo, file)));
    assert.equal(err.code, 'invalid', file.name);
    assert.equal(err.reason, reason, file.name);
  }
  // A plain-JS caller that passes something else than a file.
  const odd = await refusal(asAda(() => files.add(todo, { name: 'a.png', data: 42 } as unknown as { name: string; data: string })));
  assert.equal(odd.reason, 'attachment_invalid');
  assert.equal(listTodoAttachments(todo).length, 0);
});

test('a file added after another lists after it, even when the clock has not moved past the first', async () => {
  // Windows dates a file with a clock that moves in ticks of up to 16 ms: two
  // files added together got the same date, and the list their random order.
  // A first file dated ahead stands for that tie on every system.
  const todo = idea(ada.id);
  const files = (await pluginWith(['todos:read', 'todos:write'])).kanban.todos.attachments;
  await asAda(() => files.add(todo, { name: 'first.png', data: PNG }));
  const ahead = new Date(Date.now() + 60_000);
  utimesSync(listTodoAttachments(todo)[0]!.path, ahead, ahead);
  await asAda(() => files.add(todo, { name: 'second.py', data: Buffer.from('print(2)\n').toString('base64') }));
  await asAda(() => files.add(todo, { name: 'third.py', data: Buffer.from('print(3)\n').toString('base64') }));
  assert.deepEqual((await asAda(() => files.list(todo))).map((f) => f.name), ['first.png', 'second.py', 'third.py']);
});

test('add, list, read and remove: bytes or base64, the same bytes come back', async () => {
  const todo = idea(ada.id);
  const plugin = await pluginWith(['todos:read', 'todos:write']);
  const files = plugin.kanban.todos.attachments;
  const shot = await asAda(() => files.add(todo, { name: '../shot.png', data: PNG }));
  assert.deepEqual(Object.keys(shot).sort(), ['created_at', 'id', 'kind', 'mime', 'name', 'size', 'todo_id']);
  assert.equal(shot.name, 'shot.png');
  assert.equal(shot.mime, 'image/png');
  const log = await asAda(() => files.add(todo, { name: 'repro.py', data: Buffer.from('print(1)\n').toString('base64') }));
  assert.equal(log.mime, 'text/plain');
  assert.deepEqual((await asAda(() => files.list(todo))).map((f) => f.name), ['shot.png', 'repro.py']);
  assert.deepEqual(Buffer.from(await asAda(() => files.read(todo, shot.id))), Buffer.from(PNG));
  assert.equal((await asAda(() => plugin.kanban.todos.get(todo)))?.attachment_count, 2);
  assert.equal((await refusal(asAda(() => files.read(todo, randomUUID())))).code, 'not_found');
  assert.equal(await asAda(() => files.remove(todo, shot.id)), true);
  assert.equal(await asAda(() => files.remove(todo, shot.id)), false);
  assert.deepEqual((await asAda(() => files.list(todo))).map((f) => f.name), ['repro.py']);
});

test('a plugin job attaches files to the ideas it created', async () => {
  const plugin = await pluginWith(['todos:read', 'todos:write']);
  const { item } = await plugin.kanban.todos.create({ text: 'job idea' });
  const saved = await plugin.kanban.todos.attachments.add(item.id, { name: 'shot.png', data: PNG });
  assert.equal(saved.todo_id, item.id);
  assert.equal((await plugin.kanban.todos.get(item.id))?.attachment_count, 1);
});
