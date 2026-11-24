import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dbApi } from './db.js';
import { bus, type BusEvent } from './bus.js';
import { createBrowserProfile } from './browser-profiles.js';
import {
  deleteBrowserRecording, dropStepsOfLearnMission, findBrowserRecordingByLearnMission, findBrowserRecordingByRef,
  getBrowserRecording, learnRefusal, listBrowserRecordings, markBrowserRecordingLearning, patchBrowserRecording,
  purgeBrowserRecordings, readBrowserRecordingSteps, recordBrowserRecordingSkill, revertBrowserRecordingLearning, saveBrowserRecording,
  setBrowserRecordingExternalRef,
} from './browser-recordings.js';
import { resolveMasterKey } from './secrets/key.js';

resolveMasterKey({ keyring: null });
const user = { kind: 'user' as const, id: 'u-test' };
const newProfile = () => createBrowserProfile({ name: 'Recorder', owner_user_id: randomUUID() });
const raw = (steps: unknown[]) => ({
  version: 1, startedAt: new Date().toISOString(), url: 'https://shop.example/', steps, truncated: false, stoppedReason: 'user',
});
const SEARCH = 'blue-suede-shoes-recording-marker';
const KEY = 'sk-proj-abcdefghijklmnop1234';
const steps = [
  { t: 0, type: 'navigate', tabId: 't1', url: 'https://shop.example/' },
  { t: 1, type: 'input', tabId: 't1', selector: '#q', inputType: 'text', name: 'Search', value: SEARCH },
  { t: 2, type: 'input', tabId: 't1', selector: '#note', inputType: 'text', name: 'Note', value: KEY },
  { t: 3, type: 'click', tabId: 't1', selector: '#go', text: 'Go' },
];
const events: Extract<BusEvent, { kind: 'browser_recording' }>[] = [];
bus.on('event', (ev: BusEvent) => { if (ev.kind === 'browser_recording') events.push(ev); });

test('the clear text of the steps is not in plugin_kv: only sealed envelopes and metadata', () => {
  const profile = newProfile();
  const meta = saveBrowserRecording(profile, raw(steps), user);
  assert.equal(meta.status, 'draft');
  assert.equal(meta.steps, 4);
  assert.equal(meta.flagged, 1);
  assert.equal(meta.ownerUserId, profile.owner_user_id);
  const rows = dbApi.pluginKvList('@timon/browser-embedded').filter(({ key }) => key.endsWith(meta.id));
  assert.equal(rows.length, 2);
  assert.ok(rows.some(({ key, value }) => key.startsWith('@settings/browser-recordings/') && value.startsWith('enc:1:')));
  const everything = JSON.stringify(dbApi.pluginKvList('@timon/browser-embedded'));
  assert.ok(!everything.includes(SEARCH), 'a typed value is never stored in clear');
  assert.ok(!everything.includes(KEY));
  assert.equal(readBrowserRecordingSteps(meta)![1]!.value, SEARCH);
  assert.equal(events.at(-1)?.event, 'stopped');
  assert.equal(JSON.stringify(events.at(-1)).includes(SEARCH), false, 'events carry metadata only');
  assert.deepEqual(listBrowserRecordings({ ownerUserId: profile.owner_user_id! }).map((row) => row.id), [meta.id]);
  assert.deepEqual(listBrowserRecordings({ ownerUserId: 'someone-else' }), []);
});

test('review operations are destructive and decide whether a recording may be learned', () => {
  const meta = saveBrowserRecording(newProfile(), raw(steps), user);
  assert.equal(learnRefusal(meta)?.code, 'browser_recording_flagged');
  assert.throws(() => patchBrowserRecording(meta, [{ op: 'drop', step: 99 }], user), /Step 99/);
  assert.equal(getBrowserRecording(meta.id)!.steps, 4, 'a failed batch changes nothing');
  const masked = patchBrowserRecording(meta, [{ op: 'mask', step: 3 }, { op: 'param', step: 2, name: 'query' },
    { op: 'rename', step: 4, name: 'Search button' }, { op: 'rename', title: 'Find shoes' }], user);
  assert.equal(masked.recording.status, 'reviewed');
  assert.equal(masked.recording.title, 'Find shoes');
  assert.equal(masked.recording.flagged, 0);
  assert.equal(events.at(-1)?.event, 'reviewed');
  const stored = readBrowserRecordingSteps(masked.recording)!;
  assert.equal(stored[2]!.value, '{SECRET:Note}');
  assert.ok(!JSON.stringify(stored).includes(KEY), 'the masked value is overwritten, not kept aside');
  assert.deepEqual([stored[1]!.param, stored[1]!.value], ['query', SEARCH]);
  assert.equal(stored[3]!.name, 'Search button');
  assert.throws(() => patchBrowserRecording(masked.recording, [{ op: 'unmask', step: 3 }], user), /cannot be restored/);
  const dropped = patchBrowserRecording(masked.recording, [{ op: 'drop', step: 1 }], user);
  assert.deepEqual(readBrowserRecordingSteps(dropped.recording)!.map((step) => step.n), [2, 3, 4], 'numbers survive a drop');
  assert.equal(learnRefusal(dropped.recording), null);
});

test('a flagged parameter loses its example; unmask only settles the flag', () => {
  const meta = saveBrowserRecording(newProfile(), raw(steps), user);
  const param = patchBrowserRecording(meta, [{ op: 'param', step: 3, name: 'apiKey' }], user);
  assert.equal(readBrowserRecordingSteps(param.recording)![2]!.value, '{PARAM:apiKey}');
  const other = saveBrowserRecording(newProfile(), raw(steps), user);
  const kept = patchBrowserRecording(other, [{ op: 'unmask', step: 3 }], user);
  assert.equal(readBrowserRecordingSteps(kept.recording)![2]!.value, KEY);
  assert.equal(kept.recording.flagged, 0);
});

test('learning names its mission once; the steps go when it ends', () => {
  const meta = saveBrowserRecording(newProfile(), raw(steps.filter((step) => step.name !== 'Note')), user);
  const mission = randomUUID();
  const learned = markBrowserRecordingLearning(meta, mission);
  assert.deepEqual([learned.status, learned.learnMissionId], ['learned', mission]);
  assert.throws(() => markBrowserRecordingLearning(learned, randomUUID()), /already learned/);
  assert.throws(() => patchBrowserRecording(learned, [{ op: 'rename', title: 'x' }], user), /already learned/);
  dropStepsOfLearnMission(mission);
  const after = getBrowserRecording(meta.id)!;
  assert.equal(after.stepsAvailable, false);
  assert.equal(readBrowserRecordingSteps(after), null);
  assert.equal(dbApi.pluginKvGet('@timon/browser-embedded', `@settings/browser-recordings/${meta.id}`), undefined);
});

test('the skill a conversion created is kept on its recording; a recording stored before it reads as none', () => {
  const meta = saveBrowserRecording(newProfile(), raw(steps.slice(0, 2)), user);
  assert.equal(meta.learnedSkillId, null);
  const mission = randomUUID();
  markBrowserRecordingLearning(meta, mission);
  assert.equal(findBrowserRecordingByLearnMission(mission)?.id, meta.id);
  assert.equal(findBrowserRecordingByLearnMission(randomUUID()), undefined);
  const recorded = recordBrowserRecordingSkill(mission, 'browser-find-shoes', { kind: 'agent', id: 'a' });
  assert.equal(recorded?.learnedSkillId, 'browser-find-shoes');
  assert.equal(getBrowserRecording(meta.id)?.learnedSkillId, 'browser-find-shoes');
  assert.deepEqual([events.at(-1)?.event, events.at(-1)?.recording?.learnedSkillId], ['learned', 'browser-find-shoes']);
  assert.equal(recordBrowserRecordingSkill(randomUUID(), 'browser-x', { kind: 'agent', id: 'a' }), undefined);

  const legacy = { ...getBrowserRecording(meta.id)!, id: `br-${randomUUID()}` } as Record<string, unknown>;
  delete legacy.learnedSkillId;
  dbApi.pluginKvSet('@timon/browser-embedded', `browser-recordings/${String(legacy.id)}`, JSON.stringify(legacy));
  assert.equal(getBrowserRecording(legacy.id)?.learnedSkillId, null);
});

test('the conversion mission is found by an index, not a scan; the index goes with the learning', () => {
  const store = '@timon/browser-embedded';
  const meta = saveBrowserRecording(newProfile(), raw(steps.slice(0, 2)), user);
  const mission = randomUUID();
  markBrowserRecordingLearning(meta, mission);
  assert.equal(dbApi.pluginKvGet(store, `browser-recording-learn-missions/${mission}`), meta.id);
  assert.equal(findBrowserRecordingByLearnMission(mission)?.id, meta.id);
  // A key that names a recording of another mission finds nothing.
  const stranger = randomUUID();
  dbApi.pluginKvSet(store, `browser-recording-learn-missions/${stranger}`, meta.id);
  assert.equal(findBrowserRecordingByLearnMission(stranger), undefined);
  assert.equal(findBrowserRecordingByLearnMission(stranger, meta.id), undefined, 'the hint must name the mission back too');
  // A recording learned before the index is found through the id its mission names.
  dbApi.pluginKvDelete(store, `browser-recording-learn-missions/${mission}`);
  assert.equal(findBrowserRecordingByLearnMission(mission), undefined);
  assert.equal(findBrowserRecordingByLearnMission(mission, meta.id)?.id, meta.id);
  assert.equal(findBrowserRecordingByLearnMission(mission, 'not-a-recording-id'), undefined);

  // A failed spawn reverts the recording and drops its index; a deletion drops it too.
  const other = saveBrowserRecording(newProfile(), raw(steps.slice(0, 2)), user);
  const failed = randomUUID();
  markBrowserRecordingLearning(other, failed);
  revertBrowserRecordingLearning(other);
  assert.equal(dbApi.pluginKvGet(store, `browser-recording-learn-missions/${failed}`), undefined);
  assert.equal(getBrowserRecording(other.id)?.status, other.status);
  const gone = randomUUID();
  deleteBrowserRecording(markBrowserRecordingLearning(other, gone), user);
  assert.equal(dbApi.pluginKvGet(store, `browser-recording-learn-missions/${gone}`), undefined);
});

test('the purge removes expired drafts and the steps of finished conversions, keeps the rest', () => {
  const now = Date.now();
  const day = 86_400_000;
  const old = saveBrowserRecording(newProfile(), raw(steps), user, now - 8 * day);
  const fresh = saveBrowserRecording(newProfile(), raw(steps), user, now - day);
  const running = randomUUID();
  dbApi.createMission(running, 'learner', 'learn', undefined, null);
  const learning = markBrowserRecordingLearning(saveBrowserRecording(newProfile(), raw(steps.slice(0, 2)), user, now - day), running, now - day);
  const finished = randomUUID();
  dbApi.createMission(finished, 'learner', 'learn', undefined, null);
  dbApi.finishMission(finished, 'completed', 0);
  const done = markBrowserRecordingLearning(saveBrowserRecording(newProfile(), raw(steps.slice(0, 2)), user, now - day), finished, now - day);
  const before = events.length;
  purgeBrowserRecordings(7, now);
  assert.equal(getBrowserRecording(old.id), undefined);
  assert.equal(dbApi.pluginKvGet('@timon/browser-embedded', `@settings/browser-recordings/${old.id}`), undefined);
  assert.ok(events.slice(before).some((ev) => ev.event === 'purged' && ev.recordingId === old.id && ev.reason === 'retention' && ev.origin.kind === 'system'));
  assert.equal(getBrowserRecording(fresh.id)?.stepsAvailable, true);
  assert.equal(getBrowserRecording(learning.id)?.stepsAvailable, true, 'a running conversion keeps its steps');
  assert.equal(getBrowserRecording(done.id)?.stepsAvailable, false);
  purgeBrowserRecordings(0, now + 365 * day);
  assert.ok(getBrowserRecording(fresh.id), 'a retention of 0 keeps drafts');
});

test('an external reference is unique and found again', () => {
  const meta = saveBrowserRecording(newProfile(), raw(steps), user);
  const linked = setBrowserRecordingExternalRef(meta, { provider: 'github', ref: 'acme/app#12', url: 'https://github.com/acme/app/issues/12' });
  assert.equal(findBrowserRecordingByRef('github', 'acme/app#12')?.id, meta.id);
  const other = saveBrowserRecording(newProfile(), raw(steps), user);
  assert.throws(() => setBrowserRecordingExternalRef(other, { provider: 'github', ref: 'acme/app#12', url: null }), /already linked/);
  assert.throws(() => setBrowserRecordingExternalRef(other, { provider: 'GitHub!', ref: 'x', url: null }), /invalid/);
  assert.throws(() => setBrowserRecordingExternalRef(other, { provider: 'github', ref: 'x', url: 'javascript:alert(1)' }), /invalid/);
  assert.equal(setBrowserRecordingExternalRef(linked, null).externalRef, null);
  deleteBrowserRecording(other, user);
  assert.equal(getBrowserRecording(other.id), undefined);
});
