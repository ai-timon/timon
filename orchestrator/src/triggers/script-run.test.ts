/**
 * The `script` action (TODO #421): a trigger runs a program on the host with no
 * agent. Refusals first (anonymous, agent, folder outside a project), then the
 * run itself: journal, overlap, time limit, alert, secrets, switch-off.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestAuth } from '../users/identity.js';

const { db, dbApi } = await import('../db.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRoutes } = await import('../plugins-bundled/triggers/routes.js');
const { registerLayoutProposalRoutes } = await import('../plugins-bundled/settings/layout-proposals.js');
const { createBodyParser } = await import('../kernel/body-parser.js');
const { getTrigger } = await import('./store.js');
const { runActions } = await import('./actions.js');
const { SCRIPT_DISABLE_AFTER, runningScripts } = await import('./script-run.js');

const admin = createTestAccount(dbApi, { email: 'script-admin@example.com', name: 'Admin', passwordHash: 'x', isSuperadmin: true });
const bob = createTestAccount(dbApi, { email: 'script-bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });
const mission = randomUUID();
dbApi.createMission(mission, 'helper', 'test', undefined, admin.id);
const otherMission = randomUUID();
dbApi.createMission(otherMission, 'other', 'test', undefined, admin.id);

const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  bob: { kind: 'session', user: bob, isSuperadmin: false },
  // Holds `scripts:run` on purpose: an agent is refused whatever its token says.
  agent: { kind: 'api-token', user: admin, isSuperadmin: false, permissions: ['triggers:manage', 'notify', 'scripts:run'], missionId: mission },
  'agent-super': { kind: 'api-token', user: admin, isSuperadmin: true, missionId: mission },
  'agent-other': { kind: 'api-token', user: admin, isSuperadmin: false, permissions: ['triggers:manage', 'notify'], missionId: otherMission },
};

const app = express();
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: 'daemon-test-token', required: true })(req, res, next);
});
app.use(createBodyParser());
registerRoutes(app, { listensOnLoopback: () => true });
const delivered: string[] = [];
registerLayoutProposalRoutes(app, { deliver: (_mission, text) => { delivered.push(text); } });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

type Json = Record<string, unknown>;
async function api(method: string, path: string, body?: unknown, as: string | null = 'admin') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) headers['x-test-as'] = as;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Json };
}

// Canonical: a script path is checked lexically against the project's real
// folder, and macOS hands out `/var/...` for `/private/var/...`.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-script-')));
const projectDir = join(root, 'growth');
const outside = join(root, 'elsewhere');
mkdirSync(projectDir, { recursive: true });
mkdirSync(outside, { recursive: true });
// A junction on Windows: no privilege needed, and realpath follows it as well.
symlinkSync(outside, join(projectDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
dbApi.upsertProject('growth', { cwd: projectDir });

/** A script is node itself: no shell, no python, the same on every OS. */
const node = (code: string, extra: Json = {}) => ({ type: 'script', command: process.execPath, args: ['-e', code], cwd: projectDir, ...extra });

/** The CLI in a terminal: the daemon token, no account behind it. */
async function daemon(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: 'Bearer daemon-test-token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Json };
}

async function create(actions: unknown[], as = 'admin') {
  return api('POST', '/api/triggers', { source: 'schedule', name: `script ${randomUUID().slice(0, 8)}`, config: { cron: '*/5 7-22 * * *' }, actions }, as);
}

type Delivery = { status: string; reason: string | null; delivery_key: string | null; result: string | null };
const finished = (triggerId: string) => db.prepare(
  `SELECT status, reason, delivery_key, result FROM trigger_deliveries WHERE trigger_id = ? AND delivery_key LIKE 'script:%' ORDER BY id`,
).all(triggerId) as Delivery[];

async function waitFor<T>(read: () => T | null | undefined, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const alerts = (triggerId: string) => db.prepare(`SELECT type, title, body FROM notifications WHERE source = ? ORDER BY created_at`)
  .all(`trigger:${triggerId}`) as Array<{ type: string; title: string; body: string | null }>;

test('refused: anonymous, account without the right, a folder outside a project', async () => {
  assert.equal((await create([node('1')], null as unknown as string)).status, 401);
  assert.equal((await create([node('1')], 'bob')).status, 403);
  assert.match(String((await create([node('1', { cwd: outside })])).body.error), /not inside a registered project/);
  assert.match(String((await create([node('1', { cwd: join(projectDir, 'escape') })])).body.error), /not inside a registered project/);
  assert.equal((await create([node('1', { cwd: 'relative/dir' })])).status, 400);
  assert.equal((await create([{ ...node('1'), shell: true }])).status, 400);
});

test('an agent can neither edit nor fire a trigger that runs a script', async () => {
  const created = await create([node('1')]);
  assert.equal(created.status, 201);
  const id = String((created.body.trigger as Json).id);
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { name: 'renamed' }, 'agent')).status, 403);
  assert.equal((await api('POST', `/api/triggers/${id}/test`, { execute: true }, 'agent')).status, 403);
  const dry = await api('POST', `/api/triggers/${id}/test`, {}, 'agent');
  assert.equal(dry.body.status, 'dry_run');
});

test('a run creates no task nor mission and journals its exit code and output', async () => {
  const tasks = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  const missions = (db.prepare('SELECT COUNT(*) AS n FROM missions').get() as { n: number }).n;
  const created = await create([node('console.log("hello " + process.cwd())')]);
  const id = String((created.body.trigger as Json).id);
  const run = await api('POST', `/api/triggers/${id}/test`, { execute: true });
  assert.equal(run.body.status, 'received');
  const runId = String((run.body.outcomes as Json[])[0]!.id);
  const [row] = await waitFor(() => finished(id).length ? finished(id) : null);
  assert.equal(row!.status, 'received');
  assert.equal(row!.delivery_key, `script:${runId}`);
  const result = JSON.parse(row!.result!) as Json;
  assert.equal(result.code, 0);
  assert.match(String(result.stdout_tail), /hello .*growth/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, tasks);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM missions').get() as { n: number }).n, missions);
  assert.equal(alerts(id).length, 0);
});

test('a failed run raises an alert with the end of its output', async () => {
  const created = await create([node('console.error("boom: quota"); process.exit(3)')]);
  const id = String((created.body.trigger as Json).id);
  await api('POST', `/api/triggers/${id}/test`, { execute: true });
  const [row] = await waitFor(() => finished(id).length ? finished(id) : null);
  assert.equal(row!.status, 'error');
  assert.match(String(row!.reason), /exit code 3/);
  const [alert] = await waitFor(() => alerts(id).length ? alerts(id) : null);
  assert.equal(alert!.type, 'alert');
  assert.match(String(alert!.body), /boom: quota/);
});

test('no overlap: a tick finding the previous run still going is skipped', async () => {
  const created = await create([node('setTimeout(() => {}, 1500)')]);
  const trigger = getTrigger(String((created.body.trigger as Json).id))!;
  const first = runActions(trigger, { body: {}, headers: {} });
  const second = runActions(trigger, { body: {}, headers: {} });
  assert.equal(first[0]!.ok && typeof first[0]!.id, 'string');
  assert.ok(second[0]!.ok);
  assert.equal(second[0]!.ok && second[0]!.id, null);
  await waitFor(() => finished(trigger.id).length === 1 && runningScripts() === 0);
});

test('the time limit stops the run and says so', async () => {
  const created = await create([node('setTimeout(() => {}, 60000)', { timeout_s: 1 })]);
  const id = String((created.body.trigger as Json).id);
  await api('POST', `/api/triggers/${id}/test`, { execute: true });
  const [row] = await waitFor(() => finished(id).length ? finished(id) : null);
  assert.equal(row!.status, 'error');
  assert.match(String(row!.reason), /timed out after 1 s/);
  assert.equal((JSON.parse(row!.result!) as Json).timed_out, true);
});

test('secrets: injected by name, never in the journal nor the alert, refused when not granted', async () => {
  const value = 'growth-api-key-4f9c2e7a';
  const secret = dbApi.createSecret({ name: 'GROWTH_KEY', value_enc: value, mode: 'inject' });
  dbApi.addSecretGrant(secret.id, 'project', 'growth');
  const created = await create([node('console.log(process.env.GROWTH_KEY); console.error("key=" + process.env.GROWTH_KEY); process.exit(1)', { env: ['GROWTH_KEY'] })]);
  const id = String((created.body.trigger as Json).id);
  await api('POST', `/api/triggers/${id}/test`, { execute: true });
  const [row] = await waitFor(() => finished(id).length ? finished(id) : null);
  const [alert] = await waitFor(() => alerts(id).length ? alerts(id) : null);
  const result = JSON.parse(row!.result!) as Json;
  assert.match(String(result.stdout_tail), /\[secret GROWTH_KEY\]/);
  const everything = JSON.stringify(db.prepare('SELECT * FROM trigger_deliveries WHERE trigger_id = ?').all(id)) + JSON.stringify(alert);
  assert.equal(everything.includes(value), false);
  // Not reachable through the daemon's own environment either.
  assert.equal(JSON.stringify(result).includes('TIMON_DAEMON_TOKEN'), false);

  const missing = await create([node('1', { env: ['NOT_GRANTED'] })]);
  const missingId = String((missing.body.trigger as Json).id);
  await api('POST', `/api/triggers/${missingId}/test`, { execute: true });
  const [refused] = await waitFor(() => finished(missingId).length ? finished(missingId) : null);
  assert.match(String(refused!.reason), /secret not granted to project growth: NOT_GRANTED/);
});

test('a missing executable is a failed run, and repeated failures switch the trigger off', async () => {
  const created = await create([{ type: 'script', command: 'timon-no-such-binary-421', cwd: projectDir }]);
  const id = String((created.body.trigger as Json).id);
  for (let i = 1; i <= SCRIPT_DISABLE_AFTER; i += 1) {
    runActions(getTrigger(id)!, { body: {}, headers: {} });
    await waitFor(() => finished(id).length === i);
  }
  assert.ok(finished(id).every((row) => row.status === 'error'));
  assert.match(String(finished(id)[0]!.reason), /could not start/);
  assert.equal(getTrigger(id)!.enabled, false);
  assert.ok(alerts(id).some((a) => /switched off/.test(a.title)));
});

test('a kept script survives its folder going away; an unsigned webhook never runs one', async () => {
  const gone = join(root, 'gone');
  mkdirSync(gone);
  dbApi.upsertProject('gone', { cwd: gone });
  const created = await create([node('1', { cwd: gone })]);
  assert.equal(created.status, 201);
  const id = String((created.body.trigger as Json).id);
  rmSync(gone, { recursive: true, force: true });
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { enabled: false })).status, 200);
  const moved = await api('PATCH', `/api/triggers/${id}`, { actions: [node('2', { cwd: gone })] });
  assert.equal(moved.status, 400);

  const unsigned = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'open hook', slug: 'open-script', config: { auth: 'none' }, actions: [node('1')],
  });
  assert.equal(unsigned.status, 400);
  assert.match(String(unsigned.body.error), /authenticated webhook/);
});

const triggerCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM triggers`).get() as { n: number }).n;

test('an agent proposes, it never creates: a card, and nothing in the triggers', async () => {
  const before = triggerCount();
  for (const as of ['agent', 'agent-super']) {
    const proposed = await create([node('1')], as);
    assert.equal(proposed.status, 202, as);
    assert.match(String(proposed.body.message), /approval/);
    const row = dbApi.getLayoutProposal(String(proposed.body.proposal_id))!;
    assert.equal(row.kind, 'trigger');
    assert.equal(row.status, 'pending');
    assert.equal(row.owner_user_id, admin.id);
  }
  assert.equal(triggerCount(), before);
  // The card lifts the script restriction and nothing else.
  const task = await create([node('1'), { type: 'task', agent: 'helper', prompt: 'x' }], 'agent');
  assert.equal(task.status, 403);
  assert.match(String(task.body.error), /kanban:write/);
  const hook = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'h', slug: 'agent-hook', config: { auth: 'github' }, actions: [node('1')],
  }, 'agent');
  assert.equal(hook.status, 403);
  assert.match(String((await create([node('1', { cwd: outside })], 'agent')).body.error), /not inside a registered project/);
  // Proposals are the user's: an agent reads none of them either.
  assert.equal((await api('GET', '/api/triggers/proposals', undefined, 'agent')).status, 403);
});

test('approval: never by an agent, once only, and the trigger belongs to the proposal owner', async () => {
  const proposed = await create([node('1')], 'agent');
  const id = String(proposed.body.proposal_id);
  for (const as of ['agent', 'agent-super', 'agent-other']) {
    assert.equal((await api('POST', `/api/triggers/proposals/${id}/approve`, {}, as)).status, 403, as);
  }
  assert.equal((await api('POST', `/api/triggers/proposals/${id}/approve`, {}, 'bob')).status, 403);
  const listed = await daemon('GET', '/api/triggers/proposals');
  assert.ok((listed.body.proposals as Json[]).some((p) => p.id === id));
  const before = triggerCount();
  const approved = await daemon('POST', `/api/triggers/proposals/${id}/approve`);
  assert.equal(approved.status, 200);
  const trigger = approved.body.trigger as Json;
  assert.equal(trigger.owner_user_id, admin.id);
  assert.equal(trigger.created_by, 'user');
  assert.equal(trigger.creator_agent, 'helper');
  assert.equal(triggerCount(), before + 1);
  // The person approving the card vouches for what it runs as it is now.
  assert.equal((await runOnce(String(trigger.id))).status, 'received');
  assert.equal((await daemon('POST', `/api/triggers/proposals/${id}/approve`)).status, 409);
  assert.equal(triggerCount(), before + 1);

  const rejected = await create([node('1')], 'agent');
  const rid = String(rejected.body.proposal_id);
  assert.equal((await api('POST', `/api/triggers/proposals/${rid}/reject`, {})).status, 200);
  assert.equal(dbApi.getLayoutProposal(rid)!.status, 'dismissed');
  assert.equal(triggerCount(), before + 1);
});

test('a folder gone since the proposal: approval refused, the proposal stays pending', async () => {
  const later = join(root, 'later');
  mkdirSync(later);
  dbApi.upsertProject('later', { cwd: later });
  const proposed = await create([node('1', { cwd: later })], 'agent');
  const id = String(proposed.body.proposal_id);
  rmSync(later, { recursive: true, force: true });
  const before = triggerCount();
  const approved = await api('POST', `/api/triggers/proposals/${id}/approve`, {});
  assert.equal(approved.status, 409);
  assert.equal(dbApi.getLayoutProposal(id)!.status, 'pending');
  assert.equal(triggerCount(), before);
});

test('the card in the browser: Approve creates the trigger and tells the agent its id', async () => {
  const proposed = await create([node('1')], 'agent');
  const id = String(proposed.body.proposal_id);
  assert.equal((await api('POST', `/api/layout/proposals/${id}/resolve`, { decision: 'applied' }, 'agent')).status, 403);
  const before = triggerCount();
  const resolved = await api('POST', `/api/layout/proposals/${id}/resolve`, { decision: 'applied', origin: 'chat_card' });
  assert.equal(resolved.status, 200);
  assert.equal(triggerCount(), before + 1);
  const message = delivered.at(-1) ?? '';
  assert.match(message, /^\[trigger proposal\] The user approved your trigger: it is created \(trigger [0-9a-f-]{36}\)/);
  assert.equal((await api('POST', `/api/layout/proposals/${id}/resolve`, { decision: 'applied' })).status, 409);
  assert.equal(triggerCount(), before + 1);
});

// ── approval of what a script runs ───────────────────────────────────────────

/** A script file in the project, run by node: what a mission could rewrite. */
function scriptFile(name: string, code: string): string {
  const file = join(projectDir, name);
  writeFileSync(file, code);
  return file;
}

async function runOnce(id: string): Promise<Delivery> {
  const before = finished(id).length;
  runActions(getTrigger(id)!, { body: {}, headers: {} });
  const rows = await waitFor(() => finished(id).length > before ? finished(id) : null);
  return rows.at(-1)!;
}

test('a script file rewritten since it was approved is refused, once told, until a person re-approves it', async () => {
  const file = scriptFile('watch.js', 'console.log("approved")');
  const created = await create([{ type: 'script', command: process.execPath, args: [file], cwd: projectDir }]);
  assert.equal(created.status, 201);
  const id = String((created.body.trigger as Json).id);
  assert.equal((created.body.trigger as Json).script_approval, 'approved');
  const first = await runOnce(id);
  assert.equal(first.status, 'received');
  assert.match(String((JSON.parse(first.result!) as Json).stdout_tail), /approved/);

  writeFileSync(file, 'console.log("swapped")');
  // Read from the files at every answer: the page sees it before the next run.
  assert.equal(((await api('GET', `/api/triggers/${id}`)).body.trigger as Json).script_approval, 'changed');
  const listed = (await api('GET', '/api/triggers')).body.triggers as Json[];
  assert.equal(listed.find((row) => row.id === id)!.script_approval, 'changed');
  const refused = await runOnce(id);
  assert.equal(refused.status, 'error');
  assert.match(String(refused.reason), /^script changed since it was approved \(watch\.js\): .*timon trigger approve-script/);
  assert.equal((JSON.parse(refused.result!) as Json).stdout_tail, '');
  const [alert] = await waitFor(() => alerts(id).length ? alerts(id) : null);
  assert.equal(alert!.type, 'alert');
  assert.match(alert!.title, /Script not run/);
  // The same refusal again: journaled, not told twice.
  await runOnce(id);
  assert.equal(alerts(id).length, 1);

  // A mission cannot vouch for it, whatever its token holds.
  for (const as of ['agent', 'agent-super']) {
    assert.equal((await api('POST', `/api/triggers/${id}/approve-script`, {}, as)).status, 403, as);
  }
  assert.equal((await api('POST', `/api/triggers/${id}/approve-script`, {}, 'bob')).status, 403);
  assert.equal((await api('POST', `/api/triggers/${id}/approve-script`, {}, null)).status, 401);
  assert.equal((await runOnce(id)).status, 'error');

  const approved = await api('POST', `/api/triggers/${id}/approve-script`, {});
  assert.equal(approved.status, 200);
  assert.deepEqual((approved.body.approved as Json[])[0]!.files, ['watch.js']);
  assert.equal((approved.body.trigger as Json).script_approval, 'approved');
  const after = await runOnce(id);
  assert.equal(after.status, 'received');
  assert.match(String((JSON.parse(after.result!) as Json).stdout_tail), /swapped/);
});

test('the terminal re-approves too; flipping the switch or renaming does not, saving the actions does', async () => {
  const file = scriptFile('tick.js', 'console.log(1)');
  const action = { type: 'script', command: process.execPath, args: [file], cwd: projectDir };
  const created = await create([action]);
  const id = String((created.body.trigger as Json).id);
  writeFileSync(file, 'console.log(2)');
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { name: 'renamed tick' })).status, 200);
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { enabled: false })).status, 200);
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { enabled: true })).status, 200);
  assert.match(String((await runOnce(id)).reason), /changed since it was approved/);
  // The editor sends every action back: that save is the user's approval.
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { actions: [action] })).status, 200);
  assert.equal((await runOnce(id)).status, 'received');

  writeFileSync(file, 'console.log(3)');
  assert.match(String((await runOnce(id)).reason), /changed since it was approved/);
  assert.equal((await daemon('POST', `/api/triggers/${id}/approve-script`)).status, 200);
  assert.equal((await runOnce(id)).status, 'received');
});

test('a script trigger saved before the check runs nothing until approved', async () => {
  const file = scriptFile('legacy.js', 'console.log("legacy")');
  const created = await create([{ type: 'script', command: process.execPath, args: [file], cwd: projectDir }]);
  const id = String((created.body.trigger as Json).id);
  db.prepare('UPDATE triggers SET script_pins = NULL WHERE id = ?').run(id);
  assert.equal(((await api('GET', `/api/triggers/${id}`)).body.trigger as Json).script_approval, 'unapproved');
  const refused = await runOnce(id);
  assert.equal(refused.status, 'error');
  assert.match(String(refused.reason), /^script not approved: /);
  const [alert] = await waitFor(() => alerts(id).length ? alerts(id) : null);
  assert.match(String(alert!.body), new RegExp(`approve-script ${id}`));
  assert.equal((await api('POST', `/api/triggers/${id}/approve-script`, {})).status, 200);
  assert.equal((await runOnce(id)).status, 'received');
});

test('what cannot be fingerprinted is not approved: a file outside the project, a trigger without a script', async () => {
  writeFileSync(join(outside, 'out.js'), 'console.log(1)');
  const out = await create([{ type: 'script', command: process.execPath, args: ['../elsewhere/out.js'], cwd: projectDir }]);
  assert.equal(out.status, 400);
  assert.match(String(out.body.error), /cannot be fingerprinted: \.\.\/elsewhere\/out\.js \(outside cwd\)/);
  const plain = await create([{ type: 'notify', title: 'x' }]);
  const plainId = String((plain.body.trigger as Json).id);
  assert.equal((plain.body.trigger as Json).script_approval, null);
  assert.equal((await api('POST', `/api/triggers/${plainId}/approve-script`, {})).status, 400);
});
