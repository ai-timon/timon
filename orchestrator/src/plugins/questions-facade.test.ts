/**
 * `ctx.questions` and the question events as a THIRD-PARTY plugin reaches them
 * (API 10). The refusals come first: no permission, another account, a job on
 * someone else's mission, a tool-use card dressed as a question, an answer that
 * does not fit the form. Then the answer itself: the agent gets what a click
 * would have given it, and the events carry who closed the card.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-questions-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { PluginQuestionError } = await import('./questions-facade.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { requestPermission, resolvePermission, listPending, expirePendingForMission, DENY_REASONS } = await import('../permissions.js');
const { setRedactionSource } = await import('../secrets/redact.js');
import type { PermissionDecision } from '../permissions.js';
import type { PluginQuestionEvent } from './question-events.js';

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
dbApi.createMission('m-ada-2', 'timon.coder', 'work', undefined, ada.id);
dbApi.createMission('m-bob', 'timon.coder', 'work', undefined, bob.id);
dbApi.createMission('m-job-a', 'timon.coder', 'work', undefined, `plugin:${A}`);

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
    return err instanceof PluginQuestionError ? err.code : `other: ${String(err)}`;
  }
  return undefined;
}

const FORM = {
  questions: [
    { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: 'relational', actor: 'agent' }, { label: 'SQLite', actor: 'Agent' }] },
    { question: 'Which checks?', multiSelect: true, options: [{ label: 'lint' }, { label: 'types' }] },
    { question: 'Anything else?' },
  ],
};
const PLAN = { form: { kind: 'series_plan', chantier: 'Ship it', volets: [{ title: 'Back', description: 'api', group: 'hard' }, { title: 'Front' }] } };

/** An agent asking: the card is pending as soon as this returns; `decision` settles with the answer. */
function ask(missionId: string, input: unknown, tool = 'ask_user') {
  const decision = requestPermission({ mission_id: missionId, agent: 'timon.coder', tool_name: tool, input, tool_use_id: randomUUID() });
  const card = listPending(missionId).find((p) => p.input !== undefined && p.tool_name === tool && !seen.has(p.id));
  assert.ok(card, 'the card is pending');
  seen.add(card.id);
  return { id: card.id, decision };
}
const seen = new Set<string>();

const READ = ['questions:read', 'events:subscribe'];
const ALL = ['questions:read', 'questions:answer', 'events:subscribe'];

test('a missing permission is refused before anything is read or resolved', async () => {
  const { id } = ask('m-ada', FORM);
  const reader = await pluginWith(A, READ);
  await assert.rejects(asAda(() => reader.plugin.questions.resolve(id, { cancel: true })), PluginPermissionError);
  const answerer = await pluginWith(A, ['questions:answer', 'events:subscribe']);
  await assert.rejects(asAda(() => answerer.plugin.questions.list()), PluginPermissionError);
  await assert.rejects(asAda(() => answerer.plugin.questions.get(id)), PluginPermissionError);
  assert.throws(() => answerer.plugin.events.on('question_pending', () => undefined), PluginPermissionError);
  const nothing = await pluginWith(A, []);
  await assert.rejects(asAda(() => nothing.plugin.questions.list()), PluginPermissionError);
  assert.equal(listPending('m-ada').some((p) => p.id === id), true, 'the card is still waiting');
  await reader.dispose(); await answerer.dispose(); await nothing.dispose();
  expirePendingForMission('m-ada');
});

test('a request sees its account only; a job sees the missions of its plugin only', async () => {
  const mine = ask('m-ada', FORM);
  const bobs = ask('m-bob', FORM);
  const jobs = ask('m-job-a', FORM);
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.deepEqual((await asAda(() => plugin.questions.list())).map((q) => q.id), [mine.id]);
  assert.deepEqual((await asBob(() => plugin.questions.list())).map((q) => q.id), [bobs.id]);
  assert.deepEqual((await plugin.questions.list()).map((q) => q.id), [jobs.id], 'a job: the missions of its plugin');
  assert.equal(await asBob(() => plugin.questions.get(mine.id)), undefined, 'Bob does not see Ada\'s question');
  assert.equal(await plugin.questions.get(mine.id), undefined, 'nor does a job');
  assert.equal(await codeOf(() => asBob(() => plugin.questions.resolve(mine.id, { cancel: true }))), 'not_found');
  assert.equal(await codeOf(() => plugin.questions.resolve(mine.id, { cancel: true })), 'not_found');
  assert.equal(await codeOf(() => asAda(() => plugin.questions.resolve(randomUUID(), { cancel: true }))), 'not_found');
  assert.equal(listPending('m-ada').length, 1, 'Ada\'s card was never touched');
  for (const m of ['m-ada', 'm-bob', 'm-job-a']) expirePendingForMission(m);
  await dispose();
});

test('a tool-use approval is not a question: not listed, not resolvable', async () => {
  const tool = ask('m-ada', { command: 'rm -rf build' }, 'Bash');
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.deepEqual(await asAda(() => plugin.questions.list()), []);
  assert.equal(await asAda(() => plugin.questions.get(tool.id)), undefined);
  assert.equal(await codeOf(() => asAda(() => plugin.questions.resolve(tool.id, { answers: {} }))), 'not_found');
  assert.equal(listPending('m-ada').some((p) => p.id === tool.id), true, 'the Bash card still waits for the user');
  expirePendingForMission('m-ada');
  await dispose();
});

test('a question is projected: what the form shows, filtered by kind and project', async () => {
  const q = ask('m-ada', { ...FORM, secret_context: 'not for plugins' });
  const plan = ask('m-ada-2', PLAN);
  const { plugin, dispose } = await pluginWith(A, ALL);
  const got = await asAda(() => plugin.questions.get(q.id));
  assert.ok(got);
  assert.equal(got.kind, 'question');
  assert.equal(got.agent, 'timon.coder');
  assert.equal(got.missionId, 'm-ada');
  assert.equal(got.questions.length, 3);
  assert.deepEqual(got.questions[0], { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: 'relational', actor: 'agent' }, { label: 'SQLite', description: null, actor: null }], multiSelect: false, placeholder: null });
  assert.equal(got.questions[1]!.multiSelect, true);
  assert.equal(got.plan, null);
  assert.ok(!JSON.stringify(got).includes('not for plugins'), 'nothing of the agent\'s wider payload');
  const planned = await asAda(() => plugin.questions.get(plan.id));
  assert.equal(planned?.kind, 'series_plan');
  assert.deepEqual(planned?.plan, { title: 'Ship it', volets: [{ title: 'Back', description: 'api', group: 'hard' }, { title: 'Front', description: null, group: null }] });
  assert.deepEqual((await asAda(() => plugin.questions.list({ kinds: ['series_plan'] }))).map((x) => x.id), [plan.id]);
  assert.deepEqual((await asAda(() => plugin.questions.list({ kinds: ['question'] }))).map((x) => x.id), [q.id]);
  assert.deepEqual(await asAda(() => plugin.questions.list({ project: 'no-such-project' })), []);
  assert.equal(await codeOf(() => asAda(() => plugin.questions.list({ kinds: ['permission'] as never }))), 'invalid');
  expirePendingForMission('m-ada'); expirePendingForMission('m-ada-2');
  await dispose();
});

test('an answer that does not fit the form is refused and the card keeps waiting', async () => {
  const q = ask('m-ada', FORM);
  const plan = ask('m-ada-2', PLAN);
  const { plugin, dispose } = await pluginWith(A, ALL);
  const full = { 'Which database?': 'Postgres', 'Which checks?': ['lint'], 'Anything else?': 'no' };
  const bad: unknown[] = [
    { answers: { ...full, 'Invented question': 'x' } },
    { answers: { 'Which database?': 'Postgres' } },
    { answers: { ...full, 'Which database?': ['Postgres'] } },
    { answers: { ...full, 'Anything else?': '   ' } },
    { answers: { ...full, 'Which checks?': 42 } },
    { answers: full, note: 42 },
    { answers: { ...full, 'Which database?': { choice: 'Postgres' } } },
    { answers: { ...full, 'Which database?': { choice: 'Postgres', text: '  ' } } },
    { answers: { ...full, 'Which database?': { choices: ['Postgres'], text: 'why' } } },
    { answers: { ...full, 'Which database?': { choice: 'Postgres', text: 'why', note: 'x' } } },
    { answers: { ...full, 'Which checks?': { choice: 'lint', choices: ['lint'], text: 'why' } } },
    { answers: { ...full, 'Which checks?': { choices: ['lint', ''], text: 'why' } } },
    { answers: full, plan: { mode: 'kanban-full' } },
    { plan: { mode: 'kanban-full' } },
    {},
    'yes',
  ];
  for (const answer of bad) assert.equal(await codeOf(() => asAda(() => plugin.questions.resolve(q.id, answer as never))), 'invalid', JSON.stringify(answer));
  const badPlans: unknown[] = [
    { plan: { mode: 'no-such-mode', roles: {} } },
    { answers: full },
    { plan: { mode: 'kanban-full', roles: { nope: {} } } },
    // A group the form never showed, a role no group may set, a role outside the mode.
    { plan: { mode: 'kanban-full', roles: {}, groups: { easy: { code: { model: 'haiku' } } } } },
    { plan: { mode: 'kanban-full', roles: {}, groups: { hard: { orchestrator: { model: 'opus' } } } } },
    { plan: { mode: 'kanban-code-self', roles: {}, groups: { hard: { review: { model: 'opus' } } } } },
  ];
  for (const answer of badPlans) {
    assert.equal(await codeOf(() => asAda(() => plugin.questions.resolve(plan.id, answer as never))), 'invalid', JSON.stringify(answer));
  }
  assert.equal(listPending().filter((p) => p.id === q.id || p.id === plan.id).length, 2, 'both cards still wait');
  expirePendingForMission('m-ada'); expirePendingForMission('m-ada-2');
  await dispose();
});

test('the free text of a question rides inside its own answer, beside the pick or alone', async () => {
  const q = ask('m-ada', FORM);
  const { plugin, dispose } = await pluginWith(A, ALL);
  const answers = {
    'Which database?': { text: 'neither, keep the files' },
    'Which checks?': { choices: ['lint'], text: 'types later' },
    'Anything else?': 'no',
  };
  assert.deepEqual(await asAda(() => plugin.questions.resolve(q.id, { answers })), { id: q.id, status: 'answered' });
  const decision = await q.decision as PermissionDecision;
  assert.deepEqual(decision.behavior === 'allow' && decision.updatedInput, { answers, note: undefined });
  expirePendingForMission('m-ada');
  await dispose();
});

test('the answer reaches the agent as a click would, once, with the plugin as origin', async () => {
  const q = ask('m-ada', FORM);
  const { plugin, dispose } = await pluginWith(A, ALL);
  const answer = { answers: { 'Which database?': 'Postgres', 'Which checks?': ['lint', 'types'], 'Anything else?': 'a custom answer' }, note: ' ship it ' };
  const out = await asAda(() => plugin.questions.resolve(q.id, answer));
  assert.deepEqual(out, { id: q.id, status: 'answered' });
  const decision = await q.decision as PermissionDecision;
  assert.equal(decision.behavior, 'allow');
  assert.deepEqual(decision.behavior === 'allow' && decision.updatedInput, { answers: answer.answers, note: 'ship it' });
  assert.equal(await codeOf(() => asAda(() => plugin.questions.resolve(q.id, answer))), 'not_found', 'a second answer finds nothing');
  assert.equal(await asAda(() => plugin.questions.get(q.id)), undefined);
  const persisted = dbApi.listEvents('m-ada').filter((e) => e.type === 'permission_resolved').map((e) => JSON.parse(e.payload) as {
    id: string; origin: string; resolved_by?: unknown; decided_by?: unknown; relayed_via?: unknown;
  }).find((p) => p.id === q.id);
  assert.equal(persisted?.origin, 'plugin');
  assert.deepEqual(persisted?.resolved_by, { kind: 'plugin', id: A });
  assert.deepEqual(persisted?.decided_by, { kind: 'user', id: ada.id }, 'the account of the request is recorded even without a channel');
  assert.equal(persisted?.relayed_via, undefined);

  const cancelled = ask('m-ada', FORM);
  assert.deepEqual(await asAda(() => plugin.questions.resolve(cancelled.id, { cancel: true })), { id: cancelled.id, status: 'cancelled' });
  const refusal = await cancelled.decision as PermissionDecision;
  assert.equal(refusal.behavior, 'deny');
  assert.equal(refusal.behavior === 'deny' && refusal.message, DENY_REASONS.formCancelled, 'a cancel is not a refusal of the request');

  const planned = ask('m-ada-2', PLAN);
  await asAda(() => plugin.questions.resolve(planned.id, { plan: { mode: 'kanban-full', roles: {}, note: 'go' } }));
  const planDecision = await planned.decision as PermissionDecision;
  assert.equal(planDecision.behavior, 'allow');
  const updated = planDecision.behavior === 'allow' ? planDecision.updatedInput as { plan?: { mode: string }; commands?: string[] } : {};
  assert.equal(updated.plan?.mode, 'kanban-full');
  assert.ok(Array.isArray(updated.commands) && updated.commands.length > 0, 'the plan comes back with its commands');

  // Settings per group of volets: accepted for a group the form holds, turned into `--group` commands.
  const grouped = ask('m-ada-2', PLAN);
  await asAda(() => plugin.questions.resolve(grouped.id, { plan: { mode: 'kanban-full', roles: {}, groups: { hard: { code: { backend: 'claude', model: 'opus' } } } } }));
  const groupedDecision = await grouped.decision as PermissionDecision;
  assert.equal(groupedDecision.behavior, 'allow');
  const groupedInput = groupedDecision.behavior === 'allow' ? groupedDecision.updatedInput as { commands?: string[] } : {};
  assert.ok(groupedInput.commands?.includes('timon series role set --scope code --group hard --backend claude --model opus'));
  assert.ok(groupedInput.commands?.some((c) => c.includes('--plan-group hard --title Back')));
  await dispose();
});

test('the events go to the owner\'s plugins, with the origin of the write', async () => {
  const a = await pluginWith(A, ALL);
  const jobPlugin = await pluginWith(B, ALL);
  const seenA: PluginQuestionEvent[] = [];
  const seenJob: PluginQuestionEvent[] = [];
  for (const kind of ['question_pending', 'question_resolved'] as const) {
    a.plugin.events.on(kind, (ev) => { seenA.push(ev); });
    jobPlugin.plugin.events.on(kind, (ev) => { seenJob.push(ev); });
  }
  const q = ask('m-ada', FORM);
  const other = ask('m-bob', FORM);
  const expiring = ask('m-ada-2', FORM);
  await asAda(() => a.plugin.questions.resolve(q.id, { cancel: true }));
  expirePendingForMission('m-ada-2');
  expirePendingForMission('m-bob');
  await new Promise((r) => setTimeout(r, 50));
  void expiring; void other;

  const mine = seenA.filter((e) => e.questionId === q.id);
  assert.deepEqual(mine.map((e) => e.kind), ['question_pending', 'question_resolved']);
  assert.deepEqual(mine[0]!.origin, { kind: 'agent', id: 'timon.coder' });
  const resolved = mine[1]!;
  assert.equal(resolved.kind === 'question_resolved' && resolved.status, 'cancelled');
  assert.deepEqual(resolved.origin, { kind: 'plugin', id: A });
  assert.equal(resolved.kind === 'question_resolved' && resolved.decisionOrigin, 'plugin');
  assert.deepEqual(resolved.kind === 'question_resolved' && resolved.decidedBy, { kind: 'user', id: ada.id });
  assert.equal(resolved.kind === 'question_resolved' && resolved.relayedVia, null);
  assert.equal(resolved.question.questions.length, 3, 'the resolved event still carries the question');

  const expired = seenA.find((e) => e.questionId === expiring.id && e.kind === 'question_resolved');
  assert.equal(expired?.kind === 'question_resolved' && expired.status, 'expired');
  assert.deepEqual(expired?.origin, { kind: 'system', id: null });
  assert.equal(expired?.kind === 'question_resolved' && expired.decisionOrigin, 'mission_end');
  assert.equal(expired?.kind === 'question_resolved' && expired.decidedBy, null);
  assert.equal(expired?.kind === 'question_resolved' && expired.relayedVia, null);
  assert.ok(seenA.some((e) => e.questionId === other.id), 'Bob\'s plugin instance gets Bob\'s events in Bob\'s identity');
  assert.equal(seenJob.some((e) => e.questionId === q.id), true, 'the same plugin of another id hears a user who may use it');
  await a.dispose(); await jobPlugin.dispose();
});

test('a click names the account behind it in the event', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const seen: PluginQuestionEvent[] = [];
  plugin.events.on('question_resolved', (ev) => { seen.push(ev); });
  const q = ask('m-ada', FORM);
  assert.equal(resolvePermission(q.id, { behavior: 'allow', updatedInput: { answers: {} } }, 'ui_form_submit', { kind: 'user', id: ada.id }), true);
  await new Promise((r) => setTimeout(r, 50));
  const ev = seen.find((e) => e.questionId === q.id);
  assert.deepEqual(ev?.origin, { kind: 'user', id: ada.id });
  assert.equal(ev?.kind === 'question_resolved' && ev.status, 'answered');
  assert.equal(ev?.kind === 'question_resolved' && ev.decidedBy, null, 'a click is the user, not a relay');
  assert.equal(ev?.kind === 'question_resolved' && ev.relayedVia, null);
  const click = dbApi.listEvents('m-ada').filter((e) => e.type === 'permission_resolved')
    .map((e) => JSON.parse(e.payload) as { id: string; decided_by?: unknown; relayed_via?: unknown; resolved_by?: unknown })
    .find((p) => p.id === q.id);
  assert.deepEqual(click?.resolved_by, { kind: 'user', id: ada.id });
  assert.equal(click?.decided_by, undefined);
  assert.equal(click?.relayed_via, undefined);
  await dispose();
});

test('a plugin no account may use hears no question', async () => {
  const stranger = member('eve', []);
  dbApi.createMission('m-eve', 'timon.coder', 'work', undefined, stranger.id);
  // `plugin-c` is on no role: nobody may use it, so nobody's question is its to hear.
  const { plugin, dispose } = await pluginWith('plugin-c', ALL);
  const seen: PluginQuestionEvent[] = [];
  plugin.events.on('question_pending', (ev) => { seen.push(ev); });
  const evesQuestion = ask('m-eve', FORM);
  const adas = ask('m-ada', FORM);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, []);
  void evesQuestion; void adas;
  expirePendingForMission('m-eve'); expirePendingForMission('m-ada');
  await dispose();
});

test('relayedVia is journaled beside the account and never reaches the agent', async () => {
  const answers = { 'Which database?': 'Postgres', 'Which checks?': ['lint'], 'Anything else?': 'no' };
  const q = ask('m-ada', FORM);
  const { plugin, dispose } = await pluginWith(A, ALL);
  const seen: PluginQuestionEvent[] = [];
  plugin.events.on('question_resolved', (ev) => { seen.push(ev); });
  const secret = 'sk-live-secret-value';
  const previous = setRedactionSource(() => [secret]);
  try {
    for (const label of ['x'.repeat(81), 'line\nbreak', secret, 12]) {
      assert.equal(await codeOf(() => asAda(() => plugin.questions.resolve(q.id, { answers, relayedVia: label as never }))), 'invalid', String(label));
    }
  } finally {
    setRedactionSource(previous);
  }
  assert.equal(listPending('m-ada').some((p) => p.id === q.id), true, 'a refused label leaves the card waiting');
  assert.equal(dbApi.listEvents('m-ada').some((e) => e.type === 'permission_resolved' && e.payload.includes(secret)), false);

  await asAda(() => plugin.questions.resolve(q.id, { answers, relayedVia: '  telegram  ' }));
  const decision = await q.decision as PermissionDecision;
  assert.deepEqual(decision.behavior === 'allow' && decision.updatedInput, { answers, note: undefined });
  const persisted = dbApi.listEvents('m-ada').filter((e) => e.type === 'permission_resolved')
    .map((e) => JSON.parse(e.payload) as { id: string; resolved_by?: unknown; decided_by?: unknown; relayed_via?: unknown; decision?: { updatedInput?: unknown } })
    .find((p) => p.id === q.id);
  assert.deepEqual(persisted?.resolved_by, { kind: 'plugin', id: A });
  assert.deepEqual(persisted?.decided_by, { kind: 'user', id: ada.id });
  assert.equal(persisted?.relayed_via, 'telegram');
  assert.equal(JSON.stringify(persisted?.decision?.updatedInput).includes('telegram'), false);
  await new Promise((r) => setTimeout(r, 50));
  const ev = seen.find((e) => e.questionId === q.id && e.kind === 'question_resolved');
  assert.deepEqual(ev?.kind === 'question_resolved' && ev.decidedBy, { kind: 'user', id: ada.id });
  assert.equal(ev?.kind === 'question_resolved' && ev.relayedVia, 'telegram');

  const job = ask('m-job-a', FORM);
  await plugin.questions.resolve(job.id, { answers, relayedVia: 'hermes' });
  const jobRow = dbApi.listEvents('m-job-a').filter((e) => e.type === 'permission_resolved')
    .map((e) => JSON.parse(e.payload) as { id: string; resolved_by?: unknown; decided_by?: unknown; relayed_via?: unknown })
    .find((p) => p.id === job.id);
  assert.deepEqual(jobRow?.resolved_by, { kind: 'plugin', id: A });
  assert.equal(jobRow?.decided_by, undefined, 'a job has no account in front of it');
  assert.equal(jobRow?.relayed_via, 'hermes');
  await dispose();
});
