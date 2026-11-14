import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticFileName, listenLabel, serviceState, sessionModeView, versionGap, type ServiceReport } from './system-info';

const SERVICE: ServiceReport = {
  supervisor: 'windows', name: 'TimonOrchestrator', installed: true, running: true, reason: null,
  windows: null, stale: false, action: null, actionHere: false, command: 'timon service install',
};

test('serviceState: stale wins over running, no supervisor is its own state', () => {
  assert.equal(serviceState(SERVICE), 'running');
  assert.equal(serviceState({ ...SERVICE, running: false }), 'stopped');
  assert.equal(serviceState({ ...SERVICE, stale: true }), 'stale');
  assert.equal(serviceState({ ...SERVICE, installed: false }), 'absent');
  assert.equal(serviceState({ ...SERVICE, supervisor: null, installed: false }), 'unsupported');
});

test('versionGap: only an app that reports a different version', () => {
  assert.equal(versionGap('0.1.5', '0.1.5'), false);
  assert.equal(versionGap('0.1.3', '0.1.5'), true);
  assert.equal(versionGap('0.1.5', null), false);
});

test('listenLabel: every interface is said, IPv6 is bracketed', () => {
  assert.deepEqual(listenLabel('::', 3010), { address: '[::]:3010', everywhere: true });
  assert.deepEqual(listenLabel('127.0.0.1', 3001), { address: '127.0.0.1:3001', everywhere: false });
  assert.deepEqual(listenLabel(null, 3001), { address: ':3001', everywhere: false });
});

test('diagnosticFileName: the desktop\'s saved-report name, local time', () => {
  assert.equal(diagnosticFileName(new Date(2026, 9, 13, 19, 6, 11)), 'timon-diagnostic-20261013-190611.txt');
});

test('sessionModeView: the machine first, the recorded answer when it cannot tell, the same on the three systems', () => {
  const linux = { installed: true, supervisor: 'systemd-user' as const, sessionModeSupported: true };
  assert.deepEqual(sessionModeView({ ...linux, offSession: false, sessionMode: 'session' }), { kind: 'choice', keeps: false, pending: false, next: 'always' });
  assert.deepEqual(sessionModeView({ ...linux, offSession: true, sessionMode: 'always' }), { kind: 'choice', keeps: true, pending: false, next: 'session' });
  // Lingering switched on by hand while the answer says "session": shown as it is, flagged, and the button turns it off.
  assert.deepEqual(sessionModeView({ ...linux, offSession: true, sessionMode: 'session' }), { kind: 'choice', keeps: true, pending: true, next: 'session' });
  assert.deepEqual(sessionModeView({ ...linux, offSession: null, sessionMode: 'always' }), { kind: 'choice', keeps: true, pending: false, next: 'session' });
  assert.deepEqual(sessionModeView({ ...linux, offSession: null, sessionMode: null }), { kind: 'choice', keeps: false, pending: false, next: 'always' });
  // Windows chooses like the others: a boot task (S4U) or a logon task.
  assert.deepEqual(sessionModeView({ installed: true, supervisor: 'windows', sessionModeSupported: true, offSession: false, sessionMode: 'session' }), { kind: 'choice', keeps: false, pending: false, next: 'always' });
  assert.deepEqual(sessionModeView({ installed: true, supervisor: 'windows', sessionModeSupported: true, offSession: true, sessionMode: 'session' }), { kind: 'choice', keeps: true, pending: true, next: 'session' });
  assert.deepEqual(sessionModeView({ installed: true, supervisor: null, sessionModeSupported: false, offSession: null, sessionMode: null }), { kind: 'hidden' });
  assert.deepEqual(sessionModeView({ ...linux, installed: false, offSession: null, sessionMode: null }), { kind: 'hidden' }, 'nothing registered');
  assert.deepEqual(sessionModeView({ installed: true, supervisor: 'launchd' }), { kind: 'hidden' }, 'an older daemon says nothing');
});
