/**
 * `ctx.missions` control, `ctx.traces` and the mission events as a THIRD-PARTY
 * plugin reaches them (API 10). The refusals carry the weight: a permission
 * that is not declared, an anonymous caller, another account's mission, a job
 * outside its own missions, an operator who never approved the plugin — each
 * answers before anything is read, sent or killed.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-missions-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PLUGIN_EVENT_KINDS } = await import('./context.js');
const { PluginMissionError } = await import('./missions-facade.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { bus } = await import('../bus.js');
const { agentDir } = await import('../paths.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { PluginPolicyError, resetPluginPolicyState } = await import('./policy.js');
const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

import type { PluginMissionEvent } from './mission-events.js';

const A = 'plugin-a';
const B = 'plugin-b';

function withPolicy(pluginPolicy: Record<string, unknown>): void {
  setConfig(TimonConfigSchema.parse({ pluginPolicy }));
  resetPluginPolicyState();
}
test.after(() => { resetConfig(); resetPluginPolicyState(); });

function member(name: string, plugins: string[], rights: string[] = []) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused' });
  grantTestPermissions(dbApi, id, [...plugins.map((p) => `plugin:${p}`), ...rights]);
  return user;
}
const ada = member('ada', [A, B], ['missions:spawn']);
const bob = member('bob', [A, B], ['missions:spawn']);
// Reads and acts on missions but holds neither `missions:spawn` nor `missions:stop`.
const cat = member('cat', [A, B]);

dbApi.createMission('m-ada', 'timon.coder', 'work', undefined, ada.id);
dbApi.createMission('m-ada-2', 'timon.coder', 'work', undefined, ada.id);
dbApi.createMission('m-bob', 'timon.coder', 'work', undefined, bob.id);
dbApi.createMission('m-cat', 'timon.coder', 'work', undefined, cat.id);
dbApi.createMission('m-job-a', 'timon.coder', 'work', undefined, `plugin:${A}`);
dbApi.createMission('m-job-a-2', 'timon.coder', 'work', undefined, `plugin:${A}`);

function identityOf(user: { id: string; email: string; name: string }) {
  return {
    viewer: { id: user.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(user.id) },
    user: { id: user.id, email: user.email, name: user.name, is_superadmin: false },
    ownerUserId: user.id,
  };
}
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(bob), fn);
const asCat = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(cat), fn);
const asAnonymous = <T>(fn: () => Promise<T>) => runPluginRequest({ viewer: null, user: undefined, ownerUserId: null }, fn);

async function pluginWith(id: string, permissions: string[], host?: (base: ReturnType<typeof daemonHost>) => ReturnType<typeof daemonHost>) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const base = daemonHost(root);
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, host ? host(base) : base);
  return { plugin, dispose: () => root.fiber.dispose() };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try { await fn(); } catch (err) {
    return err instanceof PluginMissionError ? err.code : `other: ${err instanceof Error ? err.name : String(err)}`;
  }
  return undefined;
}

const CONTROL = ['missions:control', 'missions:read', 'events:subscribe'];
const ALL = [...CONTROL, 'missions:transcript'];

test('every method refuses a permission the manifest does not declare', async () => {
  withPolicy({ spawn: { approved: [A] } });
  const readOnly = await pluginWith(A, ['missions:read']);
  const m = readOnly.plugin.missions;
  await assert.rejects(asAda(() => m.send('m-ada', 'hi')), PluginPermissionError);
  await assert.rejects(asAda(() => m.kill('m-ada')), PluginPermissionError);
  await assert.rejects(asAda(() => m.fork('m-ada', { to: 'timon.coder' })), PluginPermissionError);
  await assert.rejects(asAda(() => m.stopScope({ agent: 'timon.coder' })), PluginPermissionError);
  await assert.rejects(asAda(() => m.search('x')), PluginPermissionError);
  await assert.rejects(asAda(() => m.summarize('m-ada')), PluginPermissionError);
  const control = await pluginWith(A, ['missions:control']);
  await assert.rejects(asAda(() => control.plugin.traces.get('m-ada')), PluginPermissionError);
  await assert.rejects(asAda(() => control.plugin.missions.search('x')), PluginPermissionError, 'control does not read the transcript');
  await assert.rejects(asAda(() => control.plugin.missions.summarize('m-ada')), PluginPermissionError);
  const transcript = await pluginWith(A, ['missions:transcript', 'missions:read']);
  await assert.rejects(asAda(() => transcript.plugin.missions.kill('m-ada')), PluginPermissionError, 'reading does not act');
  await readOnly.dispose(); await control.dispose(); await transcript.dispose();
});

test('an anonymous caller never acts, and another account\'s mission answers not_found', async () => {
  withPolicy({ spawn: { approved: [A] } });
  const { plugin, dispose } = await pluginWith(A, ALL);
  for (const act of [
    () => plugin.missions.send('m-ada', 'hi'),
    () => plugin.missions.kill('m-ada'),
    () => plugin.missions.fork('m-ada', { to: 'timon.coder' }),
    () => plugin.missions.stopScope({ agent: 'timon.coder' }),
  ]) assert.equal(await codeOf(() => asAnonymous(act)), 'forbidden');
  for (const act of [
    () => plugin.missions.send('m-bob', 'hi'),
    () => plugin.missions.kill('m-bob'),
    () => plugin.missions.fork('m-bob', { to: 'timon.coder' }),
    () => plugin.missions.summarize('m-bob'),
  ]) assert.equal(await codeOf(() => asAda(act)), 'not_found');
  // A job acts on the missions of its plugin only.
  assert.equal(await codeOf(() => plugin.missions.kill('m-ada')), 'not_found');
  assert.equal(await codeOf(() => plugin.missions.send('m-bob', 'hi')), 'not_found');
  assert.equal(dbApi.getMission('m-ada')?.status, 'running', 'nothing was killed');
  assert.equal(dbApi.getMission('m-bob')?.status, 'running');
  await dispose();
});

test('send: validated, approved by the operator, and a process-less mission is refused', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  withPolicy({ spawn: { approved: [] } });
  await assert.rejects(asAda(() => plugin.missions.send('m-ada', 'hi')), PluginPolicyError, 'not approved');
  await assert.rejects(asAda(() => plugin.missions.summarize('m-ada')), PluginPolicyError);
  await assert.rejects(asAda(() => plugin.missions.fork('m-ada', { to: 'timon.coder' })), PluginPolicyError);
  withPolicy({ spawn: { approved: [A], max: 2, windowMs: 60_000 } });
  assert.equal(await codeOf(() => asAda(() => plugin.missions.send('m-ada', '   '))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.send('m-ada', 'x'.repeat(20_001)))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.send('m-ada', 'hello'))), 'not_running', 'no process and no session to resume');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.send('m-ada', 'hello'))), 'not_running');
  await assert.rejects(asAda(() => plugin.missions.send('m-ada', 'hello')), PluginPolicyError, 'the quota is shared with spawn');
  await dispose();
});

test('fork needs the right on the calling account, a target and an existing source', async () => {
  withPolicy({ spawn: { approved: [A] } });
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.equal(await codeOf(() => asCat(() => plugin.missions.fork('m-cat', { to: 'timon.coder' }))), 'forbidden', 'cat lacks missions:spawn');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.fork('m-ada', { to: '' }))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.fork('m-ada', { to: 'nobody.here' }))), 'failed');
  await dispose();
});

test('kill closes a mission of the caller only', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.deepEqual(await asAda(() => plugin.missions.kill('m-ada-2')), { outcome: 'closed' });
  assert.notEqual(dbApi.getMission('m-ada-2')?.status, 'running');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.kill('m-ada-2'))), 'not_running', 'already over');
  assert.deepEqual(await plugin.missions.kill('m-job-a-2'), { outcome: 'closed' }, 'a job closes its own mission');
  assert.equal(dbApi.getMission('m-bob')?.status, 'running');
  await dispose();
});

test('stopScope stops the caller\'s rows only, and needs a right on the account', async () => {
  const agent = `scope-${randomUUID().slice(0, 8)}`;
  mkdirSync(agentDir(agent), { recursive: true });
  writeFileSync(join(agentDir(agent), 'config.json'), '{}');
  dbApi.createMission('s-ada', agent, 'work', undefined, ada.id);
  dbApi.createMission('s-bob', agent, 'work', undefined, bob.id);
  dbApi.createMission('s-job', agent, 'work', undefined, `plugin:${A}`);
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.equal(await codeOf(() => asCat(() => plugin.missions.stopScope({ agent }))), 'forbidden');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.stopScope({ agent, project: 'x' } as never))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.stopScope({ agent: '../etc' }))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.stopScope({ agent: 'does-not-exist' }))), 'not_found');
  const report = await asAda(() => plugin.missions.stopScope({ agent }));
  assert.deepEqual((report.missions as { id: string }[]).map((x) => x.id), ['s-ada']);
  assert.notEqual(dbApi.getMission('s-ada')?.status, 'running');
  assert.equal(dbApi.getMission('s-bob')?.status, 'running', 'Bob\'s mission on the same agent is untouched');
  assert.equal(dbApi.getMission('s-job')?.status, 'running', 'so is the plugin\'s own');
  const jobReport = await plugin.missions.stopScope({ agent });
  assert.deepEqual((jobReport.missions as { id: string }[]).map((x) => x.id), ['s-job'], 'a job stops its own missions only');
  assert.equal(dbApi.getMission('s-bob')?.status, 'running');
  await dispose();
});

test('search finds what the caller said and nothing of another account', async () => {
  const token = `needle${randomUUID().replace(/-/g, '')}`;
  dbApi.insertEvent('m-ada', 'user', { message: { content: `please find ${token}` } });
  const { plugin, dispose } = await pluginWith(A, ALL);
  const mine = await asAda(() => plugin.missions.search(token));
  assert.ok(mine.hits.length > 0, 'the owner finds it');
  const theirs = await asBob(() => plugin.missions.search(token));
  assert.equal(theirs.count, 0, 'another account does not');
  assert.equal((await plugin.missions.search(token)).count, 0, 'nor a job of the plugin');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.search('x'.repeat(501)))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.search('x', { since: 'garbage' }))), 'invalid');
  assert.equal((await asAda(() => plugin.missions.search('  '))).count, 0);
  await dispose();
});

test('traces.get is bounded by the caller and keeps span payloads behind the transcript permission', async () => {
  const trace = randomUUID();
  dbApi.createMission('t-ada', 'timon.coder', 'work', undefined, ada.id, trace);
  const reader = await pluginWith(A, ['missions:read']);
  const full = await pluginWith(A, ALL);
  const view = await asAda(() => reader.plugin.traces.get('t-ada')) as { trace_id: string; missions: { id: string }[] } | undefined;
  assert.equal(view?.trace_id, trace);
  assert.deepEqual(view?.missions.map((x) => x.id), ['t-ada']);
  assert.equal(await asBob(() => reader.plugin.traces.get('t-ada')), undefined, 'another account');
  assert.equal(await asBob(() => reader.plugin.traces.get(trace)), undefined, 'by trace id too');
  assert.equal(await reader.plugin.traces.get(trace), undefined, 'a job');
  assert.equal(await codeOf(() => asAda(() => reader.plugin.traces.get(''))), 'invalid');
  assert.ok(await asAda(() => full.plugin.traces.get(trace, { payload: true })));
  await reader.dispose(); await full.dispose();
});

test('traces.get hides what was said (prompt, channel metadata, message bodies, task text) without missions:transcript', async () => {
  const trace = randomUUID();
  dbApi.createMission('t-said', 'timon.coder', 'SECRET-PROMPT', { channel: 'telegram', meta: { chat: 'SECRET-META' } }, ada.id, trace);
  dbApi.enqueueMessage({ id: `msg-${trace}`, fromMission: 't-said', fromAgent: 'timon.coder', toAgent: 'timon.reviewer', kind: 'request', payload: 'SECRET-BODY' });
  dbApi.createTask(`task-${trace}`, 'visible title', 'timon.coder', { description: 'SECRET-DESCRIPTION', ownerUserId: ada.id, traceId: trace });
  dbApi.updateTaskStatus(`task-${trace}`, 'BLOCKED', { blockedReason: 'SECRET-REASON' });
  const reader = await pluginWith(A, ['missions:read']);
  const full = await pluginWith(A, ALL);
  type View = {
    missions: { id: string; agent_name: string; status: string; mission: string; source_channel: string | null; source_meta: string | null }[];
    agent_messages: { id: string; from_agent: string; to_agent: string; kind: string; created_at: number; payload: string }[];
    tasks: { id: string; title: string; description: string | null; blocked_reason: string | null }[];
  };
  const blind = await asAda(() => reader.plugin.traces.get(trace, { payload: true })) as View;
  assert.equal(blind.agent_messages.length, 1);
  const [message] = blind.agent_messages;
  assert.deepEqual([message.id, message.from_agent, message.to_agent, message.kind], [`msg-${trace}`, 'timon.coder', 'timon.reviewer', 'request']);
  assert.ok(message.created_at > 0, 'the timestamp stays');
  assert.equal(message.payload, '', 'no body without missions:transcript');
  assert.equal(blind.tasks[0]?.title, 'visible title');
  assert.equal(blind.tasks[0]?.description, null);
  assert.equal(blind.tasks[0]?.blocked_reason, null, 'the block reason is said text too');
  assert.equal(blind.missions[0]?.mission, '', 'the prompt is blanked');
  assert.equal(blind.missions[0]?.source_meta, null, 'so is the channel metadata');
  assert.deepEqual([blind.missions[0]?.id, blind.missions[0]?.agent_name, blind.missions[0]?.source_channel], ['t-said', 'timon.coder', 'telegram'], 'the skeleton stays');
  assert.ok(!JSON.stringify(blind).includes('SECRET'), 'the secret appears nowhere, spans included');
  const seen = await asAda(() => full.plugin.traces.get(trace)) as View;
  assert.equal(seen.agent_messages[0]?.payload, 'SECRET-BODY');
  assert.equal(seen.tasks[0]?.description, 'SECRET-DESCRIPTION');
  assert.equal(seen.tasks[0]?.blocked_reason, 'SECRET-REASON');
  assert.equal(seen.missions[0]?.mission, 'SECRET-PROMPT');
  assert.ok(seen.missions[0]?.source_meta?.includes('SECRET-META'));
  await reader.dispose(); await full.dispose();
});

test('spawn overrides: a job or an unprivileged account may only restate the agent', async () => {
  withPolicy({ spawn: { approved: [A], max: 50 } });
  const seen: Array<Record<string, unknown>> = [];
  const { plugin, dispose } = await pluginWith(A, ['missions:spawn', 'missions:read'], (base) => ({
    ...base,
    missions: { ...base.missions, spawn: async (input) => { seen.push(input as unknown as Record<string, unknown>); return 'm-new'; } },
  }));
  const base = { agent: 'timon.coder', mission: 'go' };
  assert.equal(await plugin.missions.spawn(base), 'm-new');
  assert.equal(await codeOf(() => plugin.missions.spawn({ ...base, allow: ['Bash'] })), 'override_denied', 'a job cannot widen the tools');
  assert.equal(await codeOf(() => plugin.missions.spawn({ ...base, extraMcp: ['browser'] })), 'override_denied');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.spawn({ ...base, allow: ['Bash'] }))), 'override_denied', 'nor an account without agents:privileged-config');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.spawn({ ...base, model: 'no-such-model' }))), 'override_denied');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.spawn({ ...base, backend: 'no-such-backend' }))), 'override_denied');
  assert.equal(await codeOf(() => asAda(() => plugin.missions.spawn({ ...base, allow: 'Bash' as never }))), 'invalid');
  assert.equal(await codeOf(() => asAnonymous(() => plugin.missions.spawn({ ...base, allow: ['Bash'] }))), 'override_denied', 'anonymous is restricted too');
  assert.equal(seen.length, 1, 'a refused spawn never reaches the host');
  assert.equal(seen[0]?.channel, `plugin:${A}`);
  const root = member('root', [A], ['agents:privileged-config']);
  const privileged = await runPluginRequest(identityOf(root), () => plugin.missions.spawn({ ...base, allow: ['Bash'], extraSkills: ['s'] }));
  assert.equal(privileged, 'm-new');
  assert.deepEqual(seen[1]?.allow, ['Bash']);
  assert.deepEqual(seen[1]?.extraSkills, ['s']);
  await dispose();
});

const MISSION_EVENTS = ['mission_started', 'turn_complete', 'event', 'event_delta'] as const;

async function settle(): Promise<void> { await new Promise((r) => setTimeout(r, 40)); }

test('mission events need their permission; the transcript kinds need their own', async () => {
  const kinds = PLUGIN_EVENT_KINDS as readonly string[];
  assert.ok(kinds.includes('mission_started') && kinds.includes('turn_complete'));
  assert.ok(!kinds.includes('event') && !kinds.includes('event_delta'), 'the transcript is never a generic kind');
  const noEvents = await pluginWith(A, ['missions:read']);
  const noRead = await pluginWith(A, ['events:subscribe']);
  const noTranscript = await pluginWith(A, ['events:subscribe', 'missions:read']);
  for (const kind of MISSION_EVENTS) {
    assert.throws(() => noEvents.plugin.events.on(kind, () => undefined), PluginPermissionError, `${kind} without events:subscribe`);
  }
  assert.throws(() => noRead.plugin.events.on('mission_started', () => undefined), PluginPermissionError);
  assert.throws(() => noRead.plugin.events.on('turn_complete', () => undefined), PluginPermissionError);
  noTranscript.plugin.events.on('turn_complete', () => undefined);
  assert.throws(() => noTranscript.plugin.events.on('event', () => undefined), PluginPermissionError, 'event needs missions:transcript');
  assert.throws(() => noTranscript.plugin.events.on('event_delta', () => undefined), PluginPermissionError);
  await noEvents.dispose(); await noRead.dispose(); await noTranscript.dispose();
});

test('mission events reach the plugin for the missions it may see, with their origin', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const seen: PluginMissionEvent[] = [];
  for (const kind of MISSION_EVENTS) plugin.events.on(kind, (ev) => { seen.push(ev as PluginMissionEvent); });
  const SECRET = `secret-${randomUUID()}`;
  const publish = (missionId: string, owner: string | null) => {
    bus.publish({ kind: 'mission_started', missionId, agent: 'timon.coder', channel: `plugin:${B}`, ownerUserId: owner, at: 1 });
    bus.publish({ kind: 'turn_complete', missionId, outcome: 'failed' });
    bus.publish({ kind: 'event', missionId, type: 'assistant', timestamp: 2, payload: { text: SECRET } });
    bus.publish({ kind: 'event_delta', missionId, type: 'assistant', payload: { text: SECRET } });
  };
  publish('m-ada', ada.id);
  publish('m-job-a', `plugin:${A}`);
  publish('m-bob-unknown', null);
  await settle();
  const mine = seen.filter((e) => e.missionId === 'm-ada');
  assert.deepEqual(mine.map((e) => e.kind), ['mission_started', 'turn_complete', 'event', 'event_delta']);
  const started = mine[0] as Extract<PluginMissionEvent, { kind: 'mission_started' }>;
  assert.deepEqual(started.origin, { kind: 'plugin', id: B }, 'origin comes from the spawn channel');
  assert.equal((mine[1] as { outcome: string }).outcome, 'failed');
  assert.equal(seen.filter((e) => e.missionId === 'm-job-a').length, 4, 'a job hears its own missions');
  assert.equal(seen.filter((e) => e.missionId === 'm-bob-unknown').length, 0, 'a mission of nobody never leaves');
  await dispose();
});

test('archive events reach the plugin under missions:read, for the missions it may see', async () => {
  dbApi.createMission('m-arch', 'timon.coder', 'work', undefined, ada.id);
  const { plugin, dispose } = await pluginWith(A, ALL);
  const seen: PluginMissionEvent[] = [];
  for (const kind of ['mission_archived', 'mission_unarchived'] as const) plugin.events.on(kind, (ev) => { seen.push(ev as PluginMissionEvent); });
  bus.publish({ kind: 'mission_archived', missionId: 'm-arch', by: 'user' });
  bus.publish({ kind: 'mission_unarchived', missionId: 'm-arch' });
  bus.publish({ kind: 'mission_archived', missionId: 'm-nobody', by: 'user' });
  await settle();
  assert.deepEqual(seen.map((e) => e.kind), ['mission_archived', 'mission_unarchived']);
  assert.equal((seen[0] as { by: string }).by, 'user');
  assert.equal((seen[0] as { agent: string }).agent, 'timon.coder');
  const noRead = await pluginWith(A, ['events:subscribe']);
  assert.throws(() => noRead.plugin.events.on('mission_archived', () => undefined), PluginPermissionError);
  await noRead.dispose(); await dispose();
});

test('another plugin account\'s transcript never reaches a plugin that may not serve it', async () => {
  const dan = createTestAccount(dbApi, { id: randomUUID(), email: `dan-${randomUUID()}@example.test`, name: 'dan', passwordHash: 'unused' });
  dbApi.createMission('m-dan', 'timon.coder', 'work', undefined, dan.id);
  const { plugin, dispose } = await pluginWith(A, ALL);
  const seen: PluginMissionEvent[] = [];
  for (const kind of MISSION_EVENTS) plugin.events.on(kind, (ev) => { seen.push(ev as PluginMissionEvent); });
  bus.publish({ kind: 'event', missionId: 'm-dan', type: 'assistant', timestamp: 3, payload: { text: 'private' } });
  bus.publish({ kind: 'mission_started', missionId: 'm-dan', agent: 'timon.coder', channel: null, ownerUserId: dan.id, at: 3 });
  await settle();
  assert.equal(seen.length, 0, 'dan holds no plugin:<id> grant');
  await dispose();
});

test('the unsubscribe handle stops delivery', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const seen: PluginMissionEvent[] = [];
  const off = plugin.events.on('turn_complete', (ev) => { seen.push(ev); });
  bus.publish({ kind: 'turn_complete', missionId: 'm-job-a', outcome: 'completed' });
  await settle();
  off();
  bus.publish({ kind: 'turn_complete', missionId: 'm-job-a', outcome: 'completed' });
  await settle();
  assert.equal(seen.length, 1);
  await dispose();
});
