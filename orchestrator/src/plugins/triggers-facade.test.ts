/**
 * `ctx.triggers` — a plugin retires the hand-made triggers it supersedes, and
 * can do nothing else with them. Refusals come first: permission, anonymous
 * jobs, other accounts.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-triggers-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { insertTrigger, getTriggerRow } = await import('../triggers/store.js');

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });

const request = (user: { id: string; email: string; name: string }, isSuperadmin = false) => ({
  viewer: { id: user.id, isSuperadmin, permissions: dbApi.listPermissionsForUser(user.id) },
  user: { id: user.id, email: user.email, name: user.name, is_superadmin: isSuperadmin },
  ownerUserId: user.id,
});
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(request(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob), fn);
const asAdmin = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob, true), fn);

async function pluginWith(permissions: string[]) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id: 'acme-bridge', apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

function makeTrigger(owner: string | null, over: { name: string; source?: 'event' | 'webhook' | 'schedule' }) {
  const source = over.source ?? 'event';
  return insertTrigger({
    name: over.name,
    slug: source === 'webhook' ? `hook-${over.name.replace(/\W+/g, '-').toLowerCase()}` : null,
    source,
    enabled: true,
    config: source === 'event' ? { event: 'todo_done' } : source === 'webhook' ? { auth: 'standard' } : { cron: '0 * * * *' },
    filter: null,
    actions: [{ type: 'webhook', url: 'https://worker.example.test/timon/events/SECRETTOKEN?k=1' }],
    secret: null, ownerUserId: owner, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: ['*'], nextRunAt: null,
  });
}

const enabled = (id: string) => getTriggerRow(id)?.enabled === 1;

test('without `triggers:disable` the facade refuses', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read']);
  await assert.rejects(asAda(() => plugin.triggers.list()), PluginPermissionError);
  await assert.rejects(asAda(() => plugin.triggers.disable('x')), PluginPermissionError);
  await dispose();
});

test('a job sees no trigger and disables none', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:disable']);
  const row = makeTrigger(ada.id, { name: 'job probe' });
  assert.deepEqual(await plugin.triggers.list(), []);
  assert.equal(await plugin.triggers.disable(row.id), false);
  assert.equal(enabled(row.id), true);
  await dispose();
});

test('a user disables his own triggers only; another account looks like a missing id', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:disable']);
  const mine = makeTrigger(ada.id, { name: 'ada rule' });
  const theirs = makeTrigger(bob.id, { name: 'bob rule' });
  const system = makeTrigger(null, { name: 'system rule' });

  const seen = (await asAda(() => plugin.triggers.list())).map((t) => t.id);
  assert.ok(seen.includes(mine.id));
  assert.ok(!seen.includes(theirs.id) && !seen.includes(system.id));

  assert.equal(await asAda(() => plugin.triggers.disable(theirs.id)), false);
  assert.equal(await asAda(() => plugin.triggers.disable(system.id)), false);
  assert.equal(await asAda(() => plugin.triggers.disable('missing')), false);
  assert.equal(enabled(theirs.id) && enabled(system.id), true);

  assert.equal(await asAda(() => plugin.triggers.disable(mine.id)), true);
  assert.equal(enabled(mine.id), false);
  assert.equal(await asAda(() => plugin.triggers.disable(mine.id)), false, 'already off: nothing to do');
  assert.equal(await asBob(() => plugin.triggers.disable(mine.id)), false, 'not his');
  await dispose();
});

test('a superadmin sees every trigger; the summary carries no secret, path or body', async () => {
  const { plugin, dispose } = await pluginWith(['triggers:disable']);
  const hook = makeTrigger(ada.id, { name: 'Hook A', source: 'webhook' });
  const all = await asAdmin(() => plugin.triggers.list());
  const info = all.find((t) => t.id === hook.id);
  assert.deepEqual(info, {
    id: hook.id, name: 'Hook A', source: 'webhook', enabled: true,
    slug: 'hook-hook-a', event: null, actionHosts: ['worker.example.test'], mine: false,
  });
  assert.ok(!JSON.stringify(all).includes('SECRETTOKEN'));
  assert.equal(await asAdmin(() => plugin.triggers.disable(hook.id)), true);
  assert.equal(getTriggerRow(hook.id)?.name, 'Hook A', 'disabled, never deleted nor edited');
  await dispose();
});
