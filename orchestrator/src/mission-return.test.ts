/**
 * The return of a mission leaves AT THE END OF THE TURN, never at the death of the process,
 * and never twice.
 *
 * Defect fixed (11/09/2026): a mission WITHOUT a task (`mission_spawn`
 * delegation) only reported from `notifyParentOnComplete`,
 * hooked to the death of the process. With a persistent backend, that process waits for
 * the idle reap (`TIMON_REAP_IDLE_MS`, 600,000 ms): turn ended at 12:34 →
 * return at 12:48, turn ended at 13:08 → return at 13:20. The pilot received its
 * return ten minutes after having already handled it, in the middle of another
 * conversation.
 *
 * Rule protected here: ONE return per turn. The death that follows a reported turn
 * stacks nothing; the death of a turn never finished (crash, SIGTERM, kill)
 * does stack, it is the only case where the pilot has everything to learn.
 *
 * `node --test --import tsx src/mission-return.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// french-ok-file: French sample titles and reports the test feeds in

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-return-test-'));

const { AGENTS_DIR } = await import('./paths.js');
const { dbApi } = await import('./db.js');
const { enqueueMissionReturn } = await import('./mission-return.js');
const { handleMissionTurnComplete, handleTaskDone } = await import('./wake.js');
const { sendAgentMessage } = await import('./agent-messages.js');

const PILOT = 'p.main';
const WORKER = 'p.coder';
for (const a of [PILOT, WORKER]) mkdirSync(join(AGENTS_DIR, a), { recursive: true });

type Payload = { kind?: string; mission_id?: string; status?: string; final_text?: string | null };

/** Returns dropped in the pilot's inbox by THIS mission. */
function returnsOf(missionId: string): Payload[] {
  return dbApi.listInbox(PILOT, { limit: 200 })
    .filter((m) => m.from_mission === missionId)
    .map((m) => JSON.parse(m.payload) as Payload)
    .filter((p) => p.kind === 'mission_complete' || p.kind === 'task_closed');
}

/** An autonomous mission delegated by the pilot, as `mission_spawn` creates it. */
function delegated(channel = 'agent'): string {
  const id = randomUUID();
  dbApi.createMission(id, WORKER, 'un volet délégué', { channel });
  dbApi.setMissionLineage(id, { parentAgent: PILOT });
  return id;
}

function report(missionId: string, text: string): void {
  dbApi.insertEvent(missionId, 'assistant', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

test('(a) end of turn: the return leaves at once, marker set', () => {
  const id = delegated();
  report(id, 'Commit `abc1234` — volet livré'); // french-ok: a free-text report

  handleMissionTurnComplete(id);

  const sent = returnsOf(id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.kind, 'mission_complete');
  // The final report travels the same path as at the death of the process: the
  // two producers are the same code (`enqueueMissionReturn`).
  assert.equal(sent[0]?.final_text, 'Commit `abc1234` — volet livré'); // french-ok: a free-text report
  assert.equal(dbApi.isMissionReturnNotified(id), true);
});

test('(b) the death following a reported turn stacks NOTHING', () => {
  const id = delegated();
  handleMissionTurnComplete(id);
  assert.equal(returnsOf(id).length, 1);

  // What `notifyParentOnComplete` does at the idle reap, ten minutes
  // later: the duplicate that arrived in the middle of a conversation.
  assert.equal(enqueueMissionReturn(id, 'terminated'), false);
  assert.equal(returnsOf(id).length, 1);
});

test('(c) mission killed mid-turn: the death does stack the return', () => {
  const id = delegated();
  // No `turn_complete`: the process died before the end of the turn.
  assert.equal(enqueueMissionReturn(id, 'failed'), true);
  const sent = returnsOf(id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.status, 'failed');
});

test('(d) mission with a task: a single task_closed, no mission_complete', () => {
  const taskId = randomUUID();
  const id = randomUUID();
  dbApi.createTask(taskId, 'volet dispatché', WORKER, { type: 'code' });
  dbApi.createMission(id, WORKER, 'volet dispatché', { channel: 'dispatcher' });
  dbApi.setMissionLineage(id, { parentAgent: PILOT, taskId });
  dbApi.assignTaskMission(taskId, id);
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'branche intégrée' }); // french-ok: a free-text comment

  handleTaskDone(taskId);
  handleMissionTurnComplete(id);
  enqueueMissionReturn(id, 'terminated');

  const sent = returnsOf(id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.kind, 'task_closed');
});

test('(e) second turn after `timon send`: a new return', () => {
  const id = delegated();
  handleMissionTurnComplete(id);
  assert.equal(returnsOf(id).length, 1);

  // What `sendToAgent` / the spawn does at the start of the next turn: the
  // marker is per TURN, otherwise a mission relaunched in place would stay mute.
  dbApi.markMissionReturnNotified(id, false);
  handleMissionTurnComplete(id);
  assert.equal(returnsOf(id).length, 2);
});

test('(f) the agent wrote to its pilot itself through a request: nothing more behind', () => {
  const id = delegated();
  sendAgentMessage({
    id: randomUUID(),
    fromMission: id,
    fromAgent: WORKER,
    toAgent: PILOT,
    kind: 'request',
    payload: JSON.stringify({ text: 'volet livré, sha abc1234' }),
  });
  assert.equal(dbApi.isMissionReturnNotified(id), true);

  handleMissionTurnComplete(id);
  assert.equal(enqueueMissionReturn(id, 'terminated'), false);
  assert.equal(returnsOf(id).length, 0);
});

// Mission of 11/11/2026: the reviewer posts its verdict as a free
// `msg`, without `to_mission`. That message does not wake the pilot and expires in
// the inbox after 2 h; it must therefore not cut the end-of-turn return.
for (const kind of ['msg', 'notification'] as const) {
  test(`(h) a free ${kind} to the pilot does not replace the end-of-turn return`, () => {
    const id = delegated();
    report(id, 'CHANGES_REQUESTED — bloquant dans loader.ts');
    sendAgentMessage({
      id: randomUUID(),
      fromMission: id,
      fromAgent: WORKER,
      toAgent: PILOT,
      kind,
      payload: JSON.stringify({ text: 'CHANGES_REQUESTED — bloquant dans loader.ts' }),
    });
    assert.equal(dbApi.isMissionReturnNotified(id), false);

    handleMissionTurnComplete(id);
    const sent = returnsOf(id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.kind, 'mission_complete');
    assert.equal(sent[0]?.final_text, 'CHANGES_REQUESTED — bloquant dans loader.ts');
    // The death that follows (the kill of 11/11) stays mute: one return per turn.
    assert.equal(enqueueMissionReturn(id, 'terminated'), false);
    assert.equal(returnsOf(id).length, 1);
  });
}

test('a message to a peer does not count as a report', () => {
  const id = delegated();
  mkdirSync(join(AGENTS_DIR, 'p.reviewer'), { recursive: true });
  sendAgentMessage({
    id: randomUUID(),
    fromMission: id,
    fromAgent: WORKER,
    toAgent: 'p.reviewer',
    kind: 'request',
    payload: JSON.stringify({ text: 'tu peux relire ?' }),
  });
  assert.equal(dbApi.isMissionReturnNotified(id), false);
});

test('a chat mission reports to nobody in the inbox', () => {
  const id = delegated('chat');
  handleMissionTurnComplete(id);
  assert.equal(returnsOf(id).length, 0);
});

test('no pilot, or pilot = itself: nothing leaves', () => {
  const orphan = randomUUID();
  dbApi.createMission(orphan, WORKER, 'sans lignée', { channel: 'agent' });
  assert.equal(enqueueMissionReturn(orphan, 'completed'), false);

  const self = randomUUID();
  dbApi.createMission(self, PILOT, 'le pilote lui-même', { channel: 'agent' });
  dbApi.setMissionLineage(self, { parentAgent: PILOT });
  assert.equal(enqueueMissionReturn(self, 'completed'), false);
});

test('(g) report too long: the pointer names the mission, not a missing task', () => {
  const id = delegated();
  report(id, 'Rapport\n' + 'x'.repeat(20_000));

  handleMissionTurnComplete(id);

  const text = returnsOf(id)[0]?.final_text ?? '';
  assert.match(text, new RegExp(`timon status ${id}`));
  assert.doesNotMatch(text, /sur la task/);
  assert.ok(text.length < 5_000, `a 20 kB report must not travel whole: ${text.length}`);
});
