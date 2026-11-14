/**
 * `ctx.mcp` — a plugin issues remote MCP tokens only with `mcp:issue`, only
 * for a mission it may act for, only with scopes that name real tools, and
 * revokes only its own.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-mcp-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('../plugins/manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('../plugins/context.js');
const { runPluginRequest } = await import('../plugins/als.js');
const { dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { registerProfile } = await import('../backends/registry.js');
const { verifyRemoteMcpToken } = await import('./tokens.js');

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });

const request = (user: { id: string; email: string; name: string }) => ({
  viewer: { id: user.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(user.id) },
  user: { id: user.id, email: user.email, name: user.name, is_superadmin: false },
  ownerUserId: user.id,
});
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(request(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(request(bob), fn);

async function pluginWith(id: string, permissions: string[]) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

function missionOf(owner: string, agent = 'ada.agent', backend?: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'remote work', undefined, owner);
  if (backend) dbApi.setMissionLlmOverrides(id, backend, null);
  return id;
}

test('ctx.mcp belongs to contract 7, which this daemon implements', () => {
  assert.ok(PLUGIN_API_VERSION >= 7);
});

test('without `mcp:issue` the facade refuses', async () => {
  const { plugin, dispose } = await pluginWith('acme-bridge', ['missions:read']);
  const missionId = missionOf(ada.id);
  await assert.rejects(asAda(() => plugin.mcp.issueToken({ missionId, scopes: ['kanban_list'] })), PluginPermissionError);
  await assert.rejects(asAda(() => plugin.mcp.revokeToken('x')), PluginPermissionError);
  await dispose();
});

test("a request issues for the caller's own mission, never another account's", async () => {
  const { plugin, dispose } = await pluginWith('acme-bridge', ['mcp:issue']);
  const mine = missionOf(ada.id);
  const issued = await asAda(() => plugin.mcp.issueToken({ missionId: mine, scopes: ['kanban_*'], ttl: 5 * 60_000 }));
  assert.equal(issued.path, '/api/remote-mcp');
  assert.deepEqual(issued.scopes, ['kanban_*']);
  assert.ok(issued.expiresAt <= Date.now() + 5 * 60_000);
  assert.equal(verifyRemoteMcpToken(issued.token)?.missionId, mine);
  await assert.rejects(asBob(() => plugin.mcp.issueToken({ missionId: mine, scopes: ['kanban_list'] })), /not running/);
  await assert.rejects(asAda(() => plugin.mcp.issueToken({ missionId: 'missing', scopes: ['kanban_list'] })), /not running/);
  await dispose();
});

test('a job issues only for a mission on a backend this plugin registered', async (t) => {
  const { plugin, dispose } = await pluginWith('acme-bridge', ['mcp:issue']);
  t.after(registerProfile('acme-bridge', { id: 'acme-remote', dialect: 'claude', label: 'Acme', models: [], defaultModel: null }));
  t.after(registerProfile('other-plugin', { id: 'other-remote', dialect: 'claude', label: 'Other', models: [], defaultModel: null }));
  const ours = missionOf(ada.id, 'ada.remote', 'acme-remote');
  const theirs = missionOf(ada.id, 'ada.other', 'other-remote');
  const plain = missionOf(ada.id);
  const issued = await plugin.mcp.issueToken({ missionId: ours, scopes: ['agent_send_message'] });
  assert.equal(verifyRemoteMcpToken(issued.token)?.agentName, 'ada.remote');
  await assert.rejects(plugin.mcp.issueToken({ missionId: theirs, scopes: ['agent_send_message'] }), /not running/);
  await assert.rejects(plugin.mcp.issueToken({ missionId: plain, scopes: ['agent_send_message'] }), /not running/);
  await dispose();
});

test('a scope must name a real tool or family', async () => {
  const { plugin, dispose } = await pluginWith('acme-bridge', ['mcp:issue']);
  const missionId = missionOf(ada.id);
  await assert.rejects(asAda(() => plugin.mcp.issueToken({ missionId, scopes: ['kanbn_*'] })), /matches no Timon MCP tool/);
  await assert.rejects(asAda(() => plugin.mcp.issueToken({ missionId, scopes: ['*'] })), /invalid scope/);
  await assert.rejects(asAda(() => plugin.mcp.issueToken({ missionId, scopes: [] })), /between 1 and/);
  await dispose();
});

test('a plugin revokes its own tokens only', async () => {
  const acme = await pluginWith('acme-bridge', ['mcp:issue']);
  const other = await pluginWith('other-plugin', ['mcp:issue']);
  const missionId = missionOf(ada.id);
  const issued = await asAda(() => acme.plugin.mcp.issueToken({ missionId, scopes: ['kanban_list'] }));
  assert.equal(await other.plugin.mcp.revokeToken(issued.id), false);
  assert.ok(verifyRemoteMcpToken(issued.token));
  assert.equal(await acme.plugin.mcp.revokeToken(issued.id), true);
  assert.equal(verifyRemoteMcpToken(issued.token), undefined);
  assert.equal(await acme.plugin.mcp.revokeToken(issued.id), false);
  await acme.dispose();
  await other.dispose();
});
