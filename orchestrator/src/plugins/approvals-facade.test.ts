/**
 * `ctx.approvals` and the approval events as a third-party plugin reaches them
 * (API 18). A missing permission, another account, a job on someone else's
 * mission and an `ask_user` form never become a card the plugin can close.
 * Allow and deny go through the same path as a click. What the plugin reads
 * is a projection; `relayedVia` is journaled and never becomes the tool input.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-approvals-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { PluginApprovalError } = await import('./approvals-facade.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { agentConfig, agentDir, agentSystemPrompt } = await import('../paths.js');
const { requestPermission, resolvePermission, listPending, expirePendingForMission, DENY_REASONS } = await import('../permissions.js');
const { setRedactionSource } = await import('../secrets/redact.js');
import type { PermissionDecision } from '../permissions.js';
import type { PluginApprovalEvent } from './approval-events.js';

const A = 'plugin-a';
const B = 'plugin-b';

function member(name: string, plugins: string[]) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused' });
  grantTestPermissions(dbApi, id, plugins.map((p) => `plugin:${p}`));
  return user;
}
const ada = member('ada', [A, B]);
const bob = member('bob', [A, B]);
dbApi.createMission('m-ada', 'timon.coder', 'work', undefined, ada.id);
dbApi.createMission('m-bob', 'timon.coder', 'work', undefined, bob.id);
dbApi.createMission('m-job-a', 'timon.coder', 'work', undefined, `plugin:${A}`);
// A folder, not upsertAgent: that reads the active backend, which a plugin test does not start.
mkdirSync(agentDir('acme.worker'), { recursive: true });
writeFileSync(agentSystemPrompt('acme.worker'), 'Work.\n');
writeFileSync(agentConfig('acme.worker'), JSON.stringify({ role: 'coder', project: 'acme', backend: 'claude' }));
dbApi.createMission('m-acme', 'acme.worker', 'work', undefined, ada.id);

function identityOf(user: { id: string; email: string; name: string }) {
  return {
    viewer: { id: user.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(user.id) },
    user: { id: user.id, email: user.email, name: user.name, is_superadmin: false },
    ownerUserId: user.id,
  };
}
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(bob), fn);

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

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try { await fn(); } catch (err) {
    return err instanceof PluginApprovalError ? err.code : `other: ${String(err)}`;
  }
  return undefined;
}

/** An agent asking: the card is pending as soon as this returns; `decision` settles with the answer. */
function ask(missionId: string, input: unknown, tool = 'Read', agent = 'timon.coder') {
  const decision = requestPermission({ mission_id: missionId, agent, tool_name: tool, input, tool_use_id: randomUUID() });
  const card = listPending(missionId).find((p) => p.tool_name === tool && !seen.has(p.id));
  assert.ok(card, 'the card is pending');
  seen.add(card.id);
  return { id: card.id, decision, input };
}
const seen = new Set<string>();

const READ = ['approvals:read', 'events:subscribe'];
const ALL = ['approvals:read', 'approvals:resolve', 'events:subscribe'];
const sleep = () => new Promise((r) => setTimeout(r, 50));

function resolvedPayload(missionId: string, id: string) {
  return dbApi.listEvents(missionId).filter((e) => e.type === 'permission_resolved')
    .map((e) => JSON.parse(e.payload) as {
      id: string; origin?: string; resolved_by?: unknown; decided_by?: unknown; relayed_via?: unknown;
      decision?: PermissionDecision;
    })
    .find((p) => p.id === id);
}

test('a missing permission is refused before anything is read or resolved', async () => {
  const { id } = ask('m-ada', { file_path: 'src/a.ts' });
  const reader = await pluginWith(A, READ);
  await assert.rejects(asAda(() => reader.plugin.approvals.resolve(id, { behavior: 'deny' })), PluginPermissionError);
  const resolver = await pluginWith(A, ['approvals:resolve', 'events:subscribe']);
  await assert.rejects(asAda(() => resolver.plugin.approvals.list()), PluginPermissionError);
  await assert.rejects(asAda(() => resolver.plugin.approvals.get(id)), PluginPermissionError);
  assert.throws(() => resolver.plugin.events.on('approval_pending', () => undefined), PluginPermissionError);
  const subscribed = await pluginWith(A, ['events:subscribe']);
  assert.throws(() => subscribed.plugin.events.on('approval_pending', () => undefined), PluginPermissionError);
  assert.equal(listPending('m-ada').some((p) => p.id === id), true, 'the card is still waiting');
  await reader.dispose(); await resolver.dispose(); await subscribed.dispose();
  expirePendingForMission('m-ada');
});

test('a request sees its account only; a job sees the missions of its plugin only', async () => {
  const mine = ask('m-ada', { file_path: 'src/a.ts' });
  const bobs = ask('m-bob', { file_path: 'src/b.ts' });
  const jobs = ask('m-job-a', { file_path: 'src/job.ts' });
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.deepEqual((await asAda(() => plugin.approvals.list())).map((q) => q.id).sort(), [mine.id].sort());
  assert.deepEqual((await asBob(() => plugin.approvals.list())).map((q) => q.id), [bobs.id]);
  assert.deepEqual((await plugin.approvals.list()).map((q) => q.id), [jobs.id], 'a job: the missions of its plugin');
  assert.equal(await asBob(() => plugin.approvals.get(mine.id)), undefined);
  assert.equal(await plugin.approvals.get(mine.id), undefined);
  assert.equal(await codeOf(() => asBob(() => plugin.approvals.resolve(mine.id, { behavior: 'deny' }))), 'not_found');
  assert.equal(await codeOf(() => plugin.approvals.resolve(mine.id, { behavior: 'deny' })), 'not_found');
  assert.equal(await codeOf(() => asAda(() => plugin.approvals.resolve(randomUUID(), { behavior: 'deny' }))), 'not_found');
  assert.equal(listPending('m-ada').some((p) => p.id === mine.id), true);
  for (const m of ['m-ada', 'm-bob', 'm-job-a']) expirePendingForMission(m);
  await dispose();
});

test('an ask_user form is not an approval', async () => {
  const form = ask('m-ada', { questions: [{ question: 'Which database?' }] }, 'ask_user');
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.deepEqual(await asAda(() => plugin.approvals.list()), []);
  assert.equal(await asAda(() => plugin.approvals.get(form.id)), undefined);
  assert.equal(await codeOf(() => asAda(() => plugin.approvals.resolve(form.id, { behavior: 'allow' }))), 'not_found');
  assert.equal(listPending('m-ada').some((p) => p.id === form.id), true);
  expirePendingForMission('m-ada');
  await dispose();
});

test('a card is a projection: bounded, redacted, filtered by tool and project', async () => {
  const secret = 'vault-secret-value-12';
  const previous = setRedactionSource(() => [secret]);
  const huge = 'h'.repeat(500);
  const input = {
    file_path: `src/${secret}/note.ts`,
    password: 'hunter2',
    api_key: 'short',
    access_key: 'AKIAIOSFODNN7EXAMPLE',
    accessKey: 'ASIAIOSFODNN7EXAMPLE',
    'access-key': 'aws-dash-key',
    AWS_ACCESS_KEY_ID: 'AKIA-not-in-the-vault',
    passphrase: 'correct horse',
    cookie: 'sid=abc',
    bearer: 'eyJhbGci',
    region: 'eu-west-1',
    note: huge,
    n: Number.POSITIVE_INFINITY,
    flag: true,
    when: new Date(0),
    items: Array.from({ length: 21 }, (_, i) => i),
    nested: { a: { b: { c: { d: { e: 'too deep' } } } } },
  };
  try {
    const card = ask('m-ada', input);
    const other = ask('m-ada', { file_path: 'README.md' }, 'Grep');
    const acme = ask('m-acme', { file_path: 'acme.ts' }, 'Read', 'acme.worker');
    const { plugin, dispose } = await pluginWith(A, ALL);
    const got = await asAda(() => plugin.approvals.get(card.id));
    assert.ok(got);
    assert.deepEqual(Object.keys(got).sort(), ['agent', 'createdAt', 'expiresAt', 'id', 'input', 'missionId', 'tool']);
    assert.equal(got.tool, 'Read');
    assert.equal(got.agent, 'timon.coder');
    assert.equal(got.missionId, 'm-ada');
    assert.equal(typeof got.createdAt, 'number');
    const shown = got.input as Record<string, unknown>;
    assert.equal(shown.password, '***');
    assert.equal(shown.api_key, '***');
    assert.equal(shown.access_key, '***');
    assert.equal(shown.accessKey, '***');
    assert.equal(shown['access-key'], '***');
    assert.equal(shown.AWS_ACCESS_KEY_ID, '***');
    assert.equal(shown.passphrase, '***');
    assert.equal(shown.cookie, '***');
    assert.equal(shown.bearer, '***');
    assert.equal(shown.region, 'eu-west-1');
    assert.equal(shown.note, `${'h'.repeat(400)}...`);
    assert.equal(shown.n, null);
    assert.equal(shown.flag, true);
    assert.equal(shown.when, '...');
    assert.equal((shown.file_path as string).includes(secret), false);
    assert.match(shown.file_path as string, /\*\*\*/);
    const items = shown.items as unknown[];
    assert.equal(items.length, 21);
    assert.equal(items[20], '... 1 more');
    assert.equal(((shown.nested as { a: { b: { c: string } } }).a.b.c), '...');
    assert.equal(JSON.stringify(got).includes(secret), false);
    assert.equal(JSON.stringify(got).includes('hunter2'), false);
    assert.equal(JSON.stringify(got).includes('AKIAIOSFODNN7EXAMPLE'), false);
    assert.equal(JSON.stringify(got).includes('ASIAIOSFODNN7EXAMPLE'), false);
    assert.equal(JSON.stringify(got).includes('aws-dash-key'), false);
    assert.equal(JSON.stringify(got).includes('AKIA-not-in-the-vault'), false);
    assert.equal(JSON.stringify(got).includes('correct horse'), false);
    assert.equal(JSON.stringify(got).includes('sid=abc'), false);
    assert.equal(JSON.stringify(got).includes('eyJhbGci'), false);

    const wide = ask('m-ada', Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'z'.repeat(400)])));
    const capped = await asAda(() => plugin.approvals.get(wide.id));
    assert.deepEqual(capped?.input, { truncated: true });

    assert.deepEqual((await asAda(() => plugin.approvals.list({ tool: 'Grep' }))).map((x) => x.id), [other.id]);
    assert.deepEqual((await asAda(() => plugin.approvals.list({ project: 'acme' }))).map((x) => x.id), [acme.id]);
    assert.deepEqual(await asAda(() => plugin.approvals.list({ project: 'no-such-project' })), []);
    assert.equal((await asAda(() => plugin.approvals.list({ limit: 1 }))).length, 1);
    assert.equal(await codeOf(() => asAda(() => plugin.approvals.list({ tool: 1 as never }))), 'invalid');
    await dispose();
  } finally {
    setRedactionSource(previous);
  }
  expirePendingForMission('m-ada');
  expirePendingForMission('m-acme');
});

test('a decision that is not allow or deny is refused and the card keeps waiting', async () => {
  const card = ask('m-ada', { file_path: 'src/a.ts' });
  const { plugin, dispose } = await pluginWith(A, ALL);
  const bad: unknown[] = [
    { behavior: 'allow', message: 'no' },
    { behavior: 'allow', updatedInput: { file_path: 'rm' } },
    { behavior: 'allow', scope: 'always' },
    { behavior: 'paste' },
    { behavior: 'deny', message: 12 },
    { behavior: 'yes' },
    {},
    'allow',
    { behavior: 'deny', relayedVia: 4 },
  ];
  for (const decision of bad) {
    assert.equal(await codeOf(() => asAda(() => plugin.approvals.resolve(card.id, decision as never))), 'invalid', JSON.stringify(decision));
  }
  assert.equal(listPending('m-ada').some((p) => p.id === card.id), true);
  expirePendingForMission('m-ada');
  await dispose();
});

test('an allow becomes a deny when the script the card showed was rewritten', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'timon-approval-script-')));
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho original\n');
  const missionId = `m-script-${randomUUID()}`;
  dbApi.createMission(missionId, 'timon.coder', 'work', undefined, ada.id);
  dbApi.setMissionCwdOverride(missionId, dir);
  const decision = requestPermission({
    mission_id: missionId, agent: 'timon.coder', tool_name: 'Bash', input: { command: './run.sh' }, tool_use_id: randomUUID(),
  });
  const card = listPending(missionId).find((p) => p.tool_name === 'Bash');
  assert.ok(card, 'the Bash card is pending');
  assert.equal(card.script_previews?.[0]?.path, 'run.sh');
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho swapped\n');
  const { plugin, dispose } = await pluginWith(A, ALL);
  const events: PluginApprovalEvent[] = [];
  plugin.events.on('approval_resolved', (ev) => { events.push(ev); });
  assert.deepEqual(
    await asAda(() => plugin.approvals.resolve(card.id, { behavior: 'allow' })),
    { id: card.id, status: 'denied' },
  );
  const got = await decision as PermissionDecision;
  assert.equal(got.behavior, 'deny');
  assert.match(got.behavior === 'deny' ? got.message : '', /run\.sh/);
  assert.equal(resolvedPayload(missionId, card.id)?.decision?.behavior, 'deny');
  await sleep();
  const ev = events.find((e) => e.approvalId === card.id);
  assert.equal(ev?.kind === 'approval_resolved' && ev.status, 'denied');
  await dispose();
});

test('allow resumes the agent once with the original input and no wider scope', async () => {
  const input = { file_path: 'src/a.ts', password: 'hunter2' };
  const card = ask('m-ada', input);
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.deepEqual(await asAda(() => plugin.approvals.resolve(card.id, { behavior: 'allow' })), { id: card.id, status: 'allowed' });
  const decision = await card.decision as PermissionDecision;
  assert.equal(decision.behavior, 'allow');
  assert.deepEqual(decision.behavior === 'allow' && decision.updatedInput, input);
  assert.equal(decision.behavior === 'allow' && 'scope' in decision, false);
  assert.equal(await codeOf(() => asAda(() => plugin.approvals.resolve(card.id, { behavior: 'allow' }))), 'not_found');
  assert.equal(await asAda(() => plugin.approvals.get(card.id)), undefined);
  const persisted = resolvedPayload('m-ada', card.id);
  assert.equal(persisted?.origin, 'plugin');
  assert.deepEqual(persisted?.resolved_by, { kind: 'plugin', id: A });
  assert.deepEqual(persisted?.decided_by, { kind: 'user', id: ada.id });
  assert.equal(persisted?.relayed_via, undefined);
  assert.deepEqual(persisted?.decision?.behavior === 'allow' && persisted.decision.updatedInput, input);
  await dispose();
});

test('deny uses the Deny button text, or the caller message once it is redacted', async () => {
  const secret = 'vault-secret-value-12';
  const previous = setRedactionSource(() => [secret]);
  const plain = ask('m-ada', { file_path: 'src/a.ts' });
  const custom = ask('m-ada', { file_path: 'src/b.ts' });
  const { plugin, dispose } = await pluginWith(A, ALL);
  try {
    assert.deepEqual(await asAda(() => plugin.approvals.resolve(plain.id, { behavior: 'deny', message: '   ' })), { id: plain.id, status: 'denied' });
    const refused = await plain.decision as PermissionDecision;
    assert.equal(refused.behavior, 'deny');
    assert.equal(refused.behavior === 'deny' && refused.message, DENY_REASONS.userDenied);
    await asAda(() => plugin.approvals.resolve(custom.id, { behavior: 'deny', message: `stop ${secret}` }));
    const detailed = await custom.decision as PermissionDecision;
    assert.equal(detailed.behavior === 'deny' && detailed.message, 'stop ***');
    assert.equal(JSON.stringify(resolvedPayload('m-ada', custom.id)).includes(secret), false);
  } finally {
    setRedactionSource(previous);
  }
  await dispose();
});

test('relayedVia is journaled beside the account and never becomes the tool input', async () => {
  const input = { file_path: 'src/a.ts' };
  const card = ask('m-ada', input);
  const { plugin, dispose } = await pluginWith(A, ALL);
  const seen: PluginApprovalEvent[] = [];
  plugin.events.on('approval_resolved', (ev) => { seen.push(ev); });
  const secret = 'sk-live-secret-value';
  const previous = setRedactionSource(() => [secret]);
  try {
    for (const label of ['y'.repeat(81), 'line\nbreak', secret]) {
      assert.equal(await codeOf(() => asAda(() => plugin.approvals.resolve(card.id, { behavior: 'allow', relayedVia: label }))), 'invalid', label);
    }
  } finally {
    setRedactionSource(previous);
  }
  assert.equal(listPending('m-ada').some((p) => p.id === card.id), true);
  assert.equal(dbApi.listEvents('m-ada').some((e) => e.payload.includes(secret)), false);

  assert.deepEqual(
    await asAda(() => plugin.approvals.resolve(card.id, { behavior: 'allow', relayedVia: '  telegram  ' })),
    { id: card.id, status: 'allowed' },
  );
  const decision = await card.decision as PermissionDecision;
  assert.deepEqual(decision.behavior === 'allow' && decision.updatedInput, input);
  const persisted = resolvedPayload('m-ada', card.id);
  assert.deepEqual(persisted?.resolved_by, { kind: 'plugin', id: A });
  assert.deepEqual(persisted?.decided_by, { kind: 'user', id: ada.id });
  assert.equal(persisted?.relayed_via, 'telegram');
  assert.equal(JSON.stringify(persisted?.decision).includes('telegram'), false);
  await sleep();
  const ev = seen.find((e) => e.approvalId === card.id && e.kind === 'approval_resolved');
  assert.deepEqual(ev?.kind === 'approval_resolved' && ev.decidedBy, { kind: 'user', id: ada.id });
  assert.equal(ev?.kind === 'approval_resolved' && ev.relayedVia, 'telegram');
  assert.equal(ev?.kind === 'approval_resolved' && ev.status, 'allowed');

  const job = ask('m-job-a', { file_path: 'src/job.ts' });
  await plugin.approvals.resolve(job.id, { behavior: 'deny', relayedVia: 'hermes' });
  const jobRow = resolvedPayload('m-job-a', job.id);
  assert.deepEqual(jobRow?.resolved_by, { kind: 'plugin', id: A });
  assert.equal(jobRow?.decided_by, undefined);
  assert.equal(jobRow?.relayed_via, 'hermes');
  await dispose();
});

test('the events go to the owner\'s plugins, with the origin of the write', async () => {
  const a = await pluginWith(A, ALL);
  const jobPlugin = await pluginWith(B, ALL);
  const seenA: PluginApprovalEvent[] = [];
  const seenJob: PluginApprovalEvent[] = [];
  for (const kind of ['approval_pending', 'approval_resolved'] as const) {
    a.plugin.events.on(kind, (ev) => { seenA.push(ev); });
    jobPlugin.plugin.events.on(kind, (ev) => { seenJob.push(ev); });
  }
  const card = ask('m-ada', { file_path: 'src/a.ts' });
  const other = ask('m-bob', { file_path: 'src/b.ts' });
  const expiring = ask('m-ada', { file_path: 'src/c.ts' }, 'Grep');
  await asAda(() => a.plugin.approvals.resolve(card.id, { behavior: 'deny' }));
  expirePendingForMission('m-bob');
  resolvePermission(expiring.id, { behavior: 'allow' }, 'ui_card_allow', { kind: 'user', id: ada.id });
  await sleep();

  const mine = seenA.filter((e) => e.approvalId === card.id);
  assert.deepEqual(mine.map((e) => e.kind), ['approval_pending', 'approval_resolved']);
  assert.deepEqual(mine[0]!.origin, { kind: 'agent', id: 'timon.coder' });
  assert.equal(mine[0]!.kind === 'approval_pending' && mine[0]!.approval.tool, 'Read');
  const resolved = mine[1]!;
  assert.equal(resolved.kind === 'approval_resolved' && resolved.status, 'denied');
  assert.deepEqual(resolved.origin, { kind: 'plugin', id: A });
  assert.equal(resolved.kind === 'approval_resolved' && resolved.decisionOrigin, 'plugin');
  assert.deepEqual(resolved.kind === 'approval_resolved' && resolved.decidedBy, { kind: 'user', id: ada.id });
  assert.equal(resolved.kind === 'approval_resolved' && resolved.relayedVia, null);
  assert.equal(JSON.stringify(resolved.kind === 'approval_resolved' && resolved.approval.input).includes('hunter2'), false);

  const click = seenA.find((e) => e.approvalId === expiring.id && e.kind === 'approval_resolved');
  assert.deepEqual(click?.origin, { kind: 'user', id: ada.id });
  assert.equal(click?.kind === 'approval_resolved' && click.status, 'allowed');
  assert.equal(click?.kind === 'approval_resolved' && click.decidedBy, null);
  assert.equal(click?.kind === 'approval_resolved' && click.relayedVia, null);
  assert.ok(seenA.some((e) => e.approvalId === other.id), 'Bob\'s plugin instance gets Bob\'s events');
  assert.equal(seenJob.some((e) => e.approvalId === card.id), true);
  const expired = seenA.find((e) => e.approvalId === other.id && e.kind === 'approval_resolved');
  assert.equal(expired?.kind === 'approval_resolved' && expired.status, 'expired');
  assert.deepEqual(expired?.origin, { kind: 'system', id: null });
  assert.equal(expired?.kind === 'approval_resolved' && expired.decisionOrigin, 'mission_end');
  await a.dispose(); await jobPlugin.dispose();
});

test('a plugin no account may use hears no approval', async () => {
  const stranger = member('eve', []);
  dbApi.createMission('m-eve', 'timon.coder', 'work', undefined, stranger.id);
  const { plugin, dispose } = await pluginWith('plugin-c', ALL);
  const heard: PluginApprovalEvent[] = [];
  plugin.events.on('approval_pending', (ev) => { heard.push(ev); });
  const eves = ask('m-eve', { file_path: 'src/eve.ts' });
  const adas = ask('m-ada', { file_path: 'src/ada.ts' });
  await sleep();
  assert.deepEqual(heard, []);
  void eves; void adas;
  expirePendingForMission('m-eve');
  expirePendingForMission('m-ada');
  await dispose();
});
