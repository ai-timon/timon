/**
 * Automatic mission titles (TODO #358): the rank of the sources is a cliquet
 * — a title the user or the launcher set is never overwritten by the one the
 * daemon generates — and the one-shot runs once per mission, only for a
 * conversation the user opened by hand.
 *
 * `npm test -- src/mission-titles.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { BusEvent } from './bus.js';

// french-ok-file: French sample prompts and titles the test feeds in

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-titles-test-'));

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { generateMissionTitle, startMissionTitles, sanitizeTitle, missionTitleEligible, missionOnFirstTurn } = await import('./mission-titles.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');

type TitleEvent = Extract<BusEvent, { kind: 'mission_title_changed' }>;

function titleEvents(fn: () => void | Promise<void>): Promise<TitleEvent[]> {
  const seen: TitleEvent[] = [];
  const on = (ev: BusEvent) => { if (ev.kind === 'mission_title_changed') seen.push(ev); };
  bus.on('event', on);
  return Promise.resolve(fn()).then(() => { bus.off('event', on); return seen; });
}

function conversation(text = 'Peux-tu relire le README du projet et corriger les fautes ?'): string {
  const id = randomUUID();
  dbApi.createMission(id, 'timon.main', text);
  return id;
}

/** The witness home mounts no provider: the resolver is given a local backend by hand (its own rules are tested in mission-title-model.test.ts). */
const LOCAL = () => ({ backend: 'claude', model: 'haiku' });
const oneShotCalls: string[] = [];
const answering = (answer: string) => async (_agent: string, _cfg: unknown, message: string) => { oneShotCalls.push(message); return answer; };

test('sanitizeTitle keeps one clean line, bounded', () => {
  assert.equal(sanitizeTitle('"Relecture du README."\n\nVoilà.'), 'Relecture du README');
  assert.equal(sanitizeTitle('Title: Fix login bug'), 'Fix login bug');
  assert.equal(sanitizeTitle('   \n  '), '');
  assert.equal(sanitizeTitle('a'.repeat(200)).length, 80);
});

test('a manual or preset title is never overwritten by a generated or native one', () => {
  const manual = conversation();
  dbApi.setMissionTitle(manual, 'Mon titre');
  assert.equal(dbApi.setMissionTitleIfUnclaimed(manual, 'Généré', 'generated'), false);
  assert.equal(dbApi.setMissionTitleIfUnclaimed(manual, 'Natif', 'native'), false);
  assert.deepEqual([dbApi.getMission(manual)?.title, dbApi.getMission(manual)?.title_source], ['Mon titre', 'manual']);

  const preset = conversation();
  dbApi.setMissionPresetTitle(preset, 'review: feat X');
  assert.equal(dbApi.setMissionTitleIfUnclaimed(preset, 'Généré', 'generated'), false);
  assert.deepEqual([dbApi.getMission(preset)?.title, dbApi.getMission(preset)?.title_source], ['review: feat X', 'preset']);

  // The rank below manual/preset is open: native replaces generated, and vice versa.
  const open = conversation();
  assert.equal(dbApi.setMissionTitleIfUnclaimed(open, 'Généré', 'generated'), true);
  assert.equal(dbApi.setMissionTitleIfUnclaimed(open, 'Natif', 'native'), true);
  assert.equal(dbApi.setMissionTitleIfUnclaimed(open, 'Natif', 'native'), false, 'an identical title is not rewritten');
  assert.equal(dbApi.getMission(open)?.title_source, 'native');
});

test('clearing a manual title clears its source too, but never re-arms the one-shot', async () => {
  oneShotCalls.length = 0;
  const id = conversation();
  assert.equal(await generateMissionTitle(id, { resolveLlm: LOCAL, oneShot: answering('Généré') }), 'written');
  dbApi.setMissionTitle(id, 'Nommée');
  const events = await titleEvents(() => dbApi.setMissionTitle(id, '  '));
  assert.deepEqual([dbApi.getMission(id)?.title, dbApi.getMission(id)?.title_source], [null, null]);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0]?.title, events[0]?.source, events[0]?.origin.kind], [null, null, 'user']);
  // The claim stays: the list shows the first message, no second quota hit.
  assert.equal(dbApi.getMission(id)?.title_generation, 1);
  assert.equal(await generateMissionTitle(id, { resolveLlm: LOCAL, oneShot: answering('Encore') }), 'skipped');
  assert.equal(oneShotCalls.length, 1);
});

test('a mission past its first turn never generates: an older conversation resumed pays nothing', async () => {
  oneShotCalls.length = 0;
  const id = conversation();
  // Two user messages already stored: the kickoff and a follow-up.
  dbApi.insertEvent(id, 'user', { type: 'user', message: { role: 'user', content: 'relis le README' } });
  dbApi.insertEvent(id, 'user', { type: 'user', message: { role: 'user', content: 'et le CHANGELOG' } });
  assert.equal(missionOnFirstTurn(id), false);
  const titles = startMissionTitles({ resolveLlm: LOCAL, oneShot: answering('Tard') });
  try {
    bus.publish({ kind: 'turn_complete', missionId: id });
    await titles.idle();
  } finally {
    titles.stop();
  }
  assert.equal(await generateMissionTitle(id, { resolveLlm: LOCAL, oneShot: answering('Tard') }), 'skipped');
  assert.equal(oneShotCalls.length, 0, 'no one-shot');
  // Not claimed either: the count only grows, and a later rule may still name it.
  assert.deepEqual([dbApi.getMission(id)?.title, dbApi.getMission(id)?.title_generation], [null, 0]);

  // The kickoff alone is the first turn.
  const fresh = conversation();
  dbApi.insertEvent(fresh, 'user', { type: 'user', message: { role: 'user', content: 'relis le README' } });
  assert.equal(missionOnFirstTurn(fresh), true);
  assert.equal(await generateMissionTitle(fresh, { resolveLlm: LOCAL, oneShot: answering('Relecture') }), 'written');
});

test('an automated mission never triggers a one-shot', async () => {
  oneShotCalls.length = 0;
  const task = conversation('TASK_ID: x\n\nbrief');
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'feat X', 'timon.coder', { description: 'd', type: 'code', priority: 3 });
  dbApi.setMissionLineage(task, { taskId });
  const routine = conversation();
  dbApi.setMissionLineage(routine, { routineId: 'r1' });
  const child = conversation();
  dbApi.setMissionLineage(child, { parentMissionId: task, parentAgent: 'timon.main' });
  const workflow = randomUUID();
  dbApi.createMission(workflow, 'timon.main', 'node', { channel: 'workflow' }, null, null, { runId: 'run1', nodeId: 'n1' });
  const dispatched = randomUUID();
  dbApi.createMission(dispatched, 'timon.coder', 'brief', { channel: 'dispatcher' });
  const woken = randomUUID();
  dbApi.createMission(woken, 'timon.main', 'digest', { channel: 'wake' });
  for (const id of [task, routine, child, workflow, dispatched, woken]) {
    assert.equal(missionTitleEligible(dbApi.getMission(id)!), false, id);
    assert.equal(await generateMissionTitle(id, { resolveLlm: LOCAL, oneShot: answering('Titre') }), 'skipped');
    assert.equal(dbApi.getMission(id)?.title, null);
    // Never claimed either: a later rule (#383 / #384) may still name it.
    assert.equal(dbApi.getMission(id)?.title_generation, 0);
  }
  assert.equal(oneShotCalls.length, 0);
});

test('a conversation from a plugin channel (Telegram, Discord) is the human typing: titled', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'timon.main', 'Quel temps fait-il demain à Lyon ?', { channel: 'plugin:telegram' });
  assert.equal(await generateMissionTitle(id, { resolveLlm: LOCAL, oneShot: answering('Météo de demain à Lyon') }), 'written');
  assert.deepEqual([dbApi.getMission(id)?.title, dbApi.getMission(id)?.title_source], ['Météo de demain à Lyon', 'generated']);
});

test('the one-shot runs once per mission, even on a replayed turn_complete', async () => {
  oneShotCalls.length = 0;
  const id = conversation();
  const titles = startMissionTitles({ resolveLlm: LOCAL, oneShot: answering('"Relecture du README"') });
  try {
    const events = await titleEvents(async () => {
      bus.publish({ kind: 'turn_complete', missionId: id });
      bus.publish({ kind: 'turn_complete', missionId: id, outcome: 'completed' });
      await titles.idle();
      bus.publish({ kind: 'turn_complete', missionId: id });
      await titles.idle();
    });
    assert.equal(oneShotCalls.length, 1, 'one generation');
    assert.ok(oneShotCalls[0]?.includes('relire le README'), 'the first message is the prompt');
    assert.deepEqual([dbApi.getMission(id)?.title, dbApi.getMission(id)?.title_source, dbApi.getMission(id)?.title_generation],
      ['Relecture du README', 'generated', 1]);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0]?.missionId, events[0]?.title, events[0]?.source, events[0]?.origin.kind], [id, 'Relecture du README', 'generated', 'system']);
  } finally {
    titles.stop();
  }
});

test('a failed turn does not generate; a failed one-shot is logged and never retried', async () => {
  oneShotCalls.length = 0;
  const id = conversation();
  const titles = startMissionTitles({ resolveLlm: LOCAL, oneShot: async () => { throw new Error('quota'); } });
  try {
    bus.publish({ kind: 'turn_complete', missionId: id, outcome: 'failed' });
    await titles.idle();
    assert.equal(dbApi.getMission(id)?.title_generation, 0, 'a failed turn claims nothing');
    bus.publish({ kind: 'turn_complete', missionId: id });
    await titles.idle();
    assert.equal(dbApi.getMission(id)?.title, null);
    assert.equal(dbApi.getMission(id)?.title_generation, 1, 'claimed: no second quota hit');
    assert.equal(await generateMissionTitle(id, { resolveLlm: LOCAL, oneShot: answering('Tard') }), 'skipped');
  } finally {
    titles.stop();
  }
});

test('race: a manual rename during an in-flight generation wins', async () => {
  const id = conversation();
  let release: (v: string) => void = () => {};
  const gate = new Promise<string>((resolve) => { release = resolve; });
  const running = generateMissionTitle(id, { resolveLlm: LOCAL, oneShot: () => gate });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(dbApi.getMission(id)?.title_generation, 1, 'claimed before the model answers');
  dbApi.setMissionTitle(id, 'Le mien');
  release('Celui du modèle');
  assert.equal(await running, 'kept');
  assert.deepEqual([dbApi.getMission(id)?.title, dbApi.getMission(id)?.title_source], ['Le mien', 'manual']);
});

test('generation off, empty answer, or an already titled mission: nothing written', async () => {
  const off = conversation();
  assert.equal(await generateMissionTitle(off, { oneShot: answering('x'), resolveLlm: () => 'off' }), 'skipped');
  assert.equal(dbApi.getMission(off)?.title_generation, 0, 'off claims nothing: switching it on later still titles');
  const empty = conversation();
  assert.equal(await generateMissionTitle(empty, { resolveLlm: LOCAL, oneShot: answering('   ') }), 'kept');
  assert.equal(dbApi.getMission(empty)?.title, null);
  const titled = conversation();
  dbApi.setMissionPresetTitle(titled, 'Preset');
  assert.equal(await generateMissionTitle(titled, { resolveLlm: LOCAL, oneShot: answering('x') }), 'skipped');
});

test('POST /api/missions/:id/title writes manual; empty clears; a non-string is 400', async () => {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const post = async (id: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/missions/${id}/title`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() as { title?: string | null; title_source?: string | null } };
  };
  try {
    const id = conversation();
    dbApi.setMissionTitleIfUnclaimed(id, 'Généré', 'generated');
    const renamed = await post(id, { title: '  Mon   titre  ' });
    assert.equal(renamed.status, 200);
    assert.deepEqual([renamed.json.title, renamed.json.title_source], ['Mon titre', 'manual']);
    assert.equal(dbApi.setMissionTitleIfUnclaimed(id, 'Encore', 'generated'), false);

    const cleared = await post(id, { title: '' });
    assert.deepEqual([cleared.json.title, cleared.json.title_source], [null, null]);
    assert.deepEqual([dbApi.getMission(id)?.title, dbApi.getMission(id)?.title_source], [null, null]);

    assert.equal((await post(id, { title: 42 })).status, 400);
    assert.equal((await post(id, { title: 'x'.repeat(201) })).status, 400);
    assert.equal((await post(randomUUID(), { title: 'x' })).status, 404);
  } finally {
    server.close();
  }
});
