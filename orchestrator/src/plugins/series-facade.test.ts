/**
 * `ctx.series` — the fallback plan and the per-role LLM choices of a series, as
 * a plugin reaches them. Refusals come first: manifest, anonymous, a series
 * outside the caller's view, a target the caller could not give an agent.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-series-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../../tests/helpers/official-providers.js');
await stubCliBinaries('grok');
await mountOfficialProviders();
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginSeriesError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });

type Identity = Parameters<typeof runPluginRequest>[0];
const identityOf = (user: { id: string; email: string; name: string }, isSuperadmin = false): Identity => ({
  viewer: { id: user.id, isSuperadmin, permissions: dbApi.listPermissionsForUser(user.id) },
  user: { id: user.id, email: user.email, name: user.name, is_superadmin: isSuperadmin },
  ownerUserId: user.id,
});
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(bob), fn);
const asAdmin = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(bob, true), fn);
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };

async function pluginWith(permissions: string[], id = 'acme-series') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const code = (c: string) => (err: unknown) => err instanceof PluginSeriesError && err.code === c;

// One series per owner: Ada's, Bob's and the plugin's own (a job).
dbApi.createTask('ada-t1', 'ada work', 'coder', { seriesId: 'series-ada', ownerUserId: ada.id });
dbApi.createTask('bob-t1', 'bob work', 'coder', { seriesId: 'series-bob', ownerUserId: bob.id });
dbApi.createTask('job-t1', 'plugin work', 'coder', { seriesId: 'series-job', ownerUserId: 'plugin:acme-series' });

test('without `series:*` in the manifest the facade refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  await assert.rejects(asAda(() => plugin.series.fallback.list('series-ada')), PluginPermissionError);
  await assert.rejects(asAda(() => plugin.series.fallback.set('series-ada', { scope: 'code', backend: 'claude' })), PluginPermissionError);
  await assert.rejects(asAda(() => plugin.series.role.list('series-ada')), PluginPermissionError);
  await assert.rejects(asAda(() => plugin.series.role.set('series-ada', { scope: 'code', backend: 'claude' })), PluginPermissionError);
  await dispose();
});

test('`series:read` reads but does not write', async () => {
  const { plugin, dispose } = await pluginWith(['series:read']);
  assert.deepEqual(await asAda(() => plugin.series.fallback.list('series-ada')), []);
  assert.deepEqual(await asAda(() => plugin.series.role.list('series-ada')), []);
  await assert.rejects(asAda(() => plugin.series.fallback.set('series-ada', { scope: 'code', backend: 'claude' })), PluginPermissionError);
  await assert.rejects(asAda(() => plugin.series.role.clear('series-ada', 'code')), PluginPermissionError);
  assert.deepEqual(dbApi.listSeriesFallbacks('series-ada'), []);
  await dispose();
});

test('an anonymous request is refused', async () => {
  const { plugin, dispose } = await pluginWith(['series:manage']);
  await assert.rejects(runPluginRequest(anonymous, () => plugin.series.fallback.list('series-ada')), PluginCallerError);
  await assert.rejects(runPluginRequest(anonymous, () => plugin.series.role.set('series-ada', { scope: 'code', backend: 'claude' })), PluginCallerError);
  assert.deepEqual(dbApi.listSeriesRoles('series-ada'), []);
  await dispose();
});

test('a series outside the caller’s view answers not_found, for reads and writes alike', async () => {
  const { plugin, dispose } = await pluginWith(['series:manage']);
  await assert.rejects(asBob(() => plugin.series.fallback.list('series-ada')), code('not_found'));
  await assert.rejects(asBob(() => plugin.series.fallback.set('series-ada', { scope: 'code', backend: 'claude', apply: false })), code('not_found'));
  await assert.rejects(asBob(() => plugin.series.fallback.clear('series-ada', 'code')), code('not_found'));
  await assert.rejects(asBob(() => plugin.series.role.list('series-ada')), code('not_found'));
  await assert.rejects(asBob(() => plugin.series.role.set('series-ada', { scope: 'code', backend: 'claude' })), code('not_found'));
  await assert.rejects(asBob(() => plugin.series.role.clear('series-ada', 'code')), code('not_found'));
  await assert.rejects(asAda(() => plugin.series.role.list('series-does-not-exist')), code('not_found'));
  // A job sees only what `plugin:<id>` owns.
  await assert.rejects(plugin.series.role.list('series-ada'), code('not_found'));
  assert.deepEqual(dbApi.listSeriesFallbacks('series-ada'), []);
  assert.deepEqual(dbApi.listSeriesRoles('series-ada'), []);
  await dispose();
});

test('`current` and malformed ids are refused', async () => {
  const { plugin, dispose } = await pluginWith(['series:manage']);
  await assert.rejects(asAda(() => plugin.series.fallback.list('current')), code('invalid'));
  await assert.rejects(asAda(() => plugin.series.fallback.list('../etc')), code('invalid'));
  await assert.rejects(asAda(() => plugin.series.fallback.list('')), code('invalid'));
  await dispose();
});

test('fallback rules: set without applying, read back, clear; bad input writes nothing', async () => {
  const { plugin, dispose } = await pluginWith(['series:manage']);
  const out = await asAda(() => plugin.series.fallback.set('series-ada', { scope: 'code', backend: 'claude', model: 'opus', apply: false }));
  assert.deepEqual(out.rules.map((r) => [r.scope, r.backend, r.model]), [['code', 'claude', 'opus']]);
  assert.equal(out.applied, null);
  assert.equal(out.applyError, null);
  // `backend: null` is "this scope never falls back", a rule of its own.
  await asAda(() => plugin.series.fallback.set('series-ada', { scope: 'orchestrator', backend: null, apply: false }));
  assert.deepEqual((await asAda(() => plugin.series.fallback.list('series-ada'))).map((r) => [r.scope, r.backend]), [['code', 'claude'], ['orchestrator', null]]);

  await assert.rejects(asAda(() => plugin.series.fallback.set('series-ada', { scope: 'wizard', backend: 'claude' })), code('invalid'));
  await assert.rejects(asAda(() => plugin.series.fallback.set('series-ada', { scope: 'doc', backend: 'no-such-backend' })), (e) => e instanceof PluginSeriesError && ['invalid', 'forbidden'].includes(e.code));
  await assert.rejects(asAda(() => plugin.series.fallback.clear('series-ada', 'wizard')), code('invalid'));
  assert.equal(dbApi.listSeriesFallbacks('series-ada').length, 2);

  const left = await asAda(() => plugin.series.fallback.clear('series-ada', 'code'));
  assert.deepEqual(left.map((r) => r.scope), ['orchestrator']);
  await dispose();
});

test('applying a rule on a series with nothing pending changes nothing and reports it', async () => {
  const { plugin, dispose } = await pluginWith(['series:manage']);
  const out = await asAda(() => plugin.series.fallback.set('series-ada', { scope: 'review', backend: 'claude' }));
  assert.equal(out.applied, null);
  assert.equal(out.rules.some((r) => r.scope === 'review'), true);
  await dispose();
});

test('role choices: set, read, clear; a target a non-superadmin agent could not run is forbidden', async () => {
  const { plugin, dispose } = await pluginWith(['series:manage']);
  const set = await asAda(() => plugin.series.role.set('series-ada', { scope: 'review', backend: 'claude', model: 'sonnet' }));
  assert.deepEqual(set.map((r) => [r.scope, r.backend, r.model]), [['review', 'claude', 'sonnet']]);
  await assert.rejects(asAda(() => plugin.series.role.set('series-ada', { scope: 'wizard', backend: 'claude' })), code('invalid'));
  await assert.rejects(asAda(() => plugin.series.role.set('series-ada', { scope: 'code' })), code('invalid'));
  // A model that is not in the catalogue of its backend is refused before anything is written.
  await assert.rejects(asAda(() => plugin.series.role.set('series-ada', { scope: 'code', backend: 'claude', model: 'definitely-not-a-model' })), code('forbidden'));
  await assert.rejects(asAda(() => plugin.series.role.set('series-ada', { scope: 'code', backend: 'grok', model: 'grok-4.6' })), code('forbidden'));
  // A sandboxed backend (codex), even as a fallback target, is a superadmin's to name.
  await assert.rejects(asAda(() => plugin.series.fallback.set('series-ada', { scope: 'doc', backend: 'codex', model: 'gpt-5.5', apply: false })), code('forbidden'));
  assert.equal(dbApi.listSeriesFallbacks('series-ada').some((r) => r.scope === 'doc'), false);
  assert.equal((await asAdmin(() => plugin.series.fallback.set('series-ada', { scope: 'doc', backend: 'codex', model: 'gpt-5.5', apply: false }))).rules.some((r) => r.backend === 'codex'), true);
  await asAdmin(() => plugin.series.fallback.clear('series-ada', 'doc'));
  assert.equal(dbApi.listSeriesRoles('series-ada').length, 1);
  // The same target is a superadmin's to give.
  assert.ok((await asAdmin(() => plugin.series.role.set('series-ada', { scope: 'code', backend: 'grok' }))).some((r) => r.scope === 'code'));
  assert.deepEqual((await asAda(() => plugin.series.role.clear('series-ada', 'code'))).map((r) => r.scope), ['review']);
  await assert.rejects(asAda(() => plugin.series.role.clear('series-ada', 'orchestrator')), code('invalid'));
  await dispose();
});

test('group rules: set with `group`, listed with `planGroup`, cleared by group', async () => {
  const { plugin, dispose } = await pluginWith(['series:manage']);
  const roles = await asAda(() => plugin.series.role.set('series-ada', { scope: 'doc', group: 'hard', backend: 'claude', model: 'sonnet' }));
  assert.deepEqual(roles.filter((r) => r.scope === 'doc').map((r) => [r.backend, r.planGroup]), [['claude', 'hard']]);
  const fallback = await asAda(() => plugin.series.fallback.set('series-ada', { scope: 'doc', group: 'hard', backend: 'claude', apply: false }));
  assert.deepEqual(fallback.rules.filter((r) => r.scope === 'doc').map((r) => [r.backend, r.planGroup]), [['claude', 'hard']]);
  // A label, bounded: too long, blank, or on the pilot's scope.
  await assert.rejects(asAda(() => plugin.series.role.set('series-ada', { scope: 'doc', group: 'x'.repeat(61), backend: 'claude' })), code('invalid'));
  await assert.rejects(asAda(() => plugin.series.fallback.set('series-ada', { scope: 'doc', group: '   ', backend: 'claude', apply: false })), code('invalid'));
  await assert.rejects(asAda(() => plugin.series.fallback.set('series-ada', { scope: 'doc', group: 'a\nb', backend: 'claude', apply: false })), code('invalid'));
  await assert.rejects(asAda(() => plugin.series.fallback.set('series-ada', { scope: 'orchestrator', group: 'hard', backend: 'claude', apply: false })), code('invalid'));
  // Clearing by group leaves the series-wide rules alone.
  assert.equal((await asAda(() => plugin.series.role.clear('series-ada', 'doc', 'hard'))).some((r) => r.planGroup === 'hard'), false);
  assert.equal((await asAda(() => plugin.series.fallback.clear('series-ada', 'doc', 'hard'))).some((r) => r.planGroup === 'hard'), false);
  assert.deepEqual(dbApi.listSeriesGroupRoles('series-ada'), []);
  assert.deepEqual(dbApi.listSeriesGroupFallbacks('series-ada'), []);
  await dispose();
});

test('a job reaches the series its plugin owns, and only that one', async () => {
  const { plugin, dispose } = await pluginWith(['series:manage']);
  const out = await plugin.series.role.set('series-job', { scope: 'doc', backend: 'claude' });
  assert.deepEqual(out.map((r) => r.scope), ['doc']);
  assert.deepEqual(await plugin.series.fallback.list('series-job'), []);
  await assert.rejects(plugin.series.role.set('series-bob', { scope: 'doc', backend: 'claude' }), code('not_found'));
  await dispose();
});
