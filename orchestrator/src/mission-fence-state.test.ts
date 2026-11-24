import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  accountCredentialHold, forgetMissionFence, missionFenced, prepareMissionLaunch, recordMissionFence, recordOneShotProcess, resetMissionFenceState,
} from './mission-fence-state.js';

test('a mission reads as fenced only while the process launched in the fence is its current one', () => {
  const first = {};
  const second = {};
  assert.equal(missionFenced('m-1'), false, 'unknown: not fenced');
  recordMissionFence('m-1', first, true);
  assert.equal(missionFenced('m-1'), true);
  assert.equal(missionFenced('m-2'), false, 'another mission is not concerned');

  // A new turn's process replaces the record; the previous one's exit does not erase it.
  recordMissionFence('m-1', second, false);
  forgetMissionFence('m-1', first);
  assert.equal(missionFenced('m-1'), false);
  recordMissionFence('m-1', second, true);
  forgetMissionFence('m-1', first);
  assert.equal(missionFenced('m-1'), true);
  forgetMissionFence('m-1', second);
  assert.equal(missionFenced('m-1'), false);
});

test('an account\'s keychain entry may move only for a fenced launch being prepared on that account', () => {
  resetMissionFenceState();
  assert.equal(accountCredentialHold('acc1', 'm-1'), 'unfenced', 'no launch being prepared: nothing to move');
  const release = prepareMissionLaunch('m-1', { account: 'acc1', fenced: false });
  assert.equal(accountCredentialHold('acc1', 'm-1'), 'unfenced', 'a launch outside the fence: its CLI updates the keychain itself');
  release();
  const fenced = prepareMissionLaunch('m-1', { account: 'acc1', fenced: true });
  assert.equal(accountCredentialHold('acc1', 'm-1'), null);
  assert.equal(accountCredentialHold('acc2', 'm-1'), 'unfenced', 'another account is not that launch\'s');
  assert.equal(accountCredentialHold('acc1', 'm-2'), 'unfenced', 'another mission is not that launch');
  // A launch that failed (its `buildSpawn` threw) lets go: nothing stale stays behind.
  fenced();
  assert.equal(accountCredentialHold('acc1', 'm-1'), 'unfenced');
  // The release of an older launch leaves a newer one of the same mission alone.
  const older = prepareMissionLaunch('m-1', { account: 'acc1', fenced: true });
  const newer = prepareMissionLaunch('m-1', { account: 'acc1', fenced: true });
  older();
  older();
  assert.equal(accountCredentialHold('acc1', 'm-1'), null);
  newer();
  assert.equal(accountCredentialHold('acc1', 'm-1'), 'unfenced');
});

test('a live process on the account outside the fence, or in a fence that opens the keychain, holds the entry', () => {
  resetMissionFenceState();
  const release = prepareMissionLaunch('m-1', { account: 'acc1', fenced: true });
  const unfenced = {};
  recordMissionFence('m-2', unfenced, false, { account: 'acc1' });
  assert.equal(accountCredentialHold('acc1', 'm-1'), 'in-use');
  forgetMissionFence('m-2', unfenced);
  assert.equal(accountCredentialHold('acc1', 'm-1'), null, 'gone once it closed');

  const opened = {};
  recordMissionFence('m-3', opened, true, { account: 'acc1', credentialStoreWritable: true });
  assert.equal(accountCredentialHold('acc1', 'm-1'), 'in-use', 'a `writable` exception lets it renew the entry in place');
  forgetMissionFence('m-3', opened);

  // A fenced process cannot write the keychain; a process on another account or on none is not concerned.
  recordMissionFence('m-4', {}, true, { account: 'acc1' });
  recordMissionFence('m-5', {}, false, { account: 'acc2' });
  recordMissionFence('m-6', {}, false);
  assert.equal(accountCredentialHold('acc1', 'm-1'), null);

  // The previous turn's process of the same mission, still alive outside the fence, is a writer too.
  const previous = {};
  recordMissionFence('m-1', previous, false, { account: 'acc1' });
  recordMissionFence('m-1', {}, true, { account: 'acc1' });
  assert.equal(accountCredentialHold('acc1', 'm-1'), 'in-use');
  forgetMissionFence('m-1', previous);
  assert.equal(accountCredentialHold('acc1', 'm-1'), null);
  release();
});

test('a one-shot on an account is a writer from its spawn until it closes, and leaves the missions\' records alone', () => {
  resetMissionFenceState();
  const release = prepareMissionLaunch('m-1', { account: 'acc1', fenced: true });
  recordMissionFence('m-1', {}, true, { account: 'acc1' });
  const proc = new EventEmitter();
  recordOneShotProcess('summary-1234abcd', 'claude@acc1', proc);
  assert.equal(accountCredentialHold('acc1', 'm-1'), 'in-use');
  assert.equal(missionFenced('m-1'), true);
  proc.emit('close');
  assert.equal(accountCredentialHold('acc1', 'm-1'), null);
  recordOneShotProcess('summary-5678abcd', 'claude', new EventEmitter());
  assert.equal(accountCredentialHold('acc1', 'm-1'), null, 'on the host\'s own sign-in: no account entry');
  release();
});
