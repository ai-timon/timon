import assert from 'node:assert/strict';
import test from 'node:test';
import { readOsCredential, readOsCredentialNow, removeOsCredentialIf, resetOsCredentialMisses } from './os-credentials.js';
const entry = { service: 'provider-entry' };
const readCredential = (host: Pick<Host, 'platform' | 'exec'>, now?: number) => readOsCredential(host, entry, now);
import type { ExecResult, Host } from './types.js';

function fakeHost(platform: Host['platform'], result: ExecResult, calls: string[][] = []): Pick<Host, 'platform' | 'exec'> {
  return { platform, exec: (name, args) => { calls.push([name, ...args]); return result; } };
}

test('reads the CLI entry on darwin only', () => {
  resetOsCredentialMisses();
  const calls: string[][] = [];
  assert.equal(readCredential(fakeHost('darwin', { code: 0, stdout: '{"a":1}\n', stderr: '' }, calls)), '{"a":1}');
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-s', 'provider-entry', '-w']);
  assert.equal(readCredential(fakeHost('linux', { code: 0, stdout: 'x', stderr: '' }, calls)), null);
  assert.equal(calls.length, 1, 'no command is run off macOS');
});

test('a miss is remembered for a minute, then asked again', () => {
  resetOsCredentialMisses();
  const calls: string[][] = [];
  const miss = fakeHost('darwin', { code: 44, stdout: '', stderr: 'could not be found' }, calls);
  assert.equal(readCredential(miss, 1_000), null);
  assert.equal(readCredential(miss, 30_000), null);
  assert.equal(calls.length, 1);
  assert.equal(readCredential(miss, 62_000), null);
  assert.equal(calls.length, 2);
  resetOsCredentialMisses();
  assert.equal(readCredential(miss, 62_500), null);
  assert.equal(calls.length, 3);
});

test('an account entry is read now, without the remembered miss of the gauges', () => {
  resetOsCredentialMisses();
  const calls: string[][] = [];
  const miss = fakeHost('darwin', { code: 44, stdout: '', stderr: '' }, calls);
  assert.equal(readCredential(miss, 1_000), null);
  assert.equal(readOsCredentialNow(fakeHost('darwin', { code: 0, stdout: 'secret\n', stderr: '' }, calls), entry), 'secret');
  assert.equal(readOsCredentialNow(fakeHost('linux', { code: 0, stdout: 'x', stderr: '' }, calls), entry), null);
  assert.equal(calls.length, 2, 'no command off macOS');
});

/**
 * A keychain played by `security`: `find` answers the first entry left, `delete` removes it.
 * A test writes `entries` between two commands, as another CLI would.
 */
function scriptedKeychain(entries: string[], opts: { deleteCode?: number } = {}) {
  const calls: string[][] = [];
  const host: Pick<Host, 'platform' | 'exec'> = {
    platform: 'darwin',
    exec: (name, args) => {
      calls.push([name, ...args]);
      if (args[0] === 'find-generic-password') {
        const value = entries[0];
        return value === undefined ? { code: 44, stdout: '', stderr: '' } : { code: 0, stdout: `${value}\n`, stderr: '' };
      }
      if (opts.deleteCode !== undefined) return { code: opts.deleteCode, stdout: '', stderr: 'UNIX[Operation not permitted]' };
      return entries.shift() === undefined ? { code: 44, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' };
    },
  };
  return { host, calls, entries };
}

test('removal deletes every copy that still holds the copied value, with names only on the command line', () => {
  const keychain = scriptedKeychain(['copied', 'copied']);
  assert.equal(removeOsCredentialIf(keychain.host, { service: 'svc-0123abcd' }, 'copied'), 'removed');
  assert.deepEqual(keychain.entries, []);
  assert.deepEqual(keychain.calls.map((call) => call[1]), [
    'find-generic-password', 'delete-generic-password', 'find-generic-password', 'delete-generic-password', 'find-generic-password',
  ]);
  assert.ok(keychain.calls.every((call) => !call.includes('copied') && !call.includes('-X')), 'never a secret in argv');
});

test('an entry replaced after it was read is never deleted', () => {
  // The provider read and copied `copied`; a CLI then wrote a fresh pair: nothing is deleted.
  const replaced = scriptedKeychain(['fresh']);
  assert.equal(removeOsCredentialIf(replaced.host, entry, 'copied'), 'changed');
  assert.deepEqual(replaced.entries, ['fresh']);
  assert.ok(!replaced.calls.some((call) => call[1] === 'delete-generic-password'));
  // Written right after the first copy went: the fresh one stays.
  const keychain = scriptedKeychain(['copied']);
  const host: Pick<Host, 'platform' | 'exec'> = {
    platform: 'darwin',
    exec: (name, args, opts) => {
      const result = keychain.host.exec(name, args, opts);
      if (args[0] === 'delete-generic-password') keychain.entries.push('fresh');
      return result;
    },
  };
  assert.equal(removeOsCredentialIf(host, entry, 'copied'), 'changed');
  assert.deepEqual(keychain.entries, ['fresh']);
});

test('a refused removal or read (locked keychain, Seatbelt) answers refused; off macOS there is nothing to remove', () => {
  assert.equal(removeOsCredentialIf(scriptedKeychain(['copied'], { deleteCode: 161 }).host, entry, 'copied'), 'refused');
  const locked: Pick<Host, 'platform' | 'exec'> = { platform: 'darwin', exec: () => ({ code: 36, stdout: '', stderr: 'locked' }) };
  assert.equal(removeOsCredentialIf(locked, entry, 'copied'), 'refused', 'an entry it cannot read is not taken for absent');
  const endless: Pick<Host, 'platform' | 'exec'> = { platform: 'darwin', exec: () => ({ code: 0, stdout: 'copied', stderr: '' }) };
  assert.equal(removeOsCredentialIf(endless, entry, 'copied'), 'refused', 'bounded, never an endless loop');
  const throwing: Pick<Host, 'platform' | 'exec'> = { platform: 'darwin', exec: () => { throw new Error('timeout'); } };
  assert.equal(removeOsCredentialIf(throwing, entry, 'copied'), 'refused');
  const calls: string[][] = [];
  assert.equal(removeOsCredentialIf(fakeHost('linux', { code: 0, stdout: '', stderr: '' }, calls), entry, 'copied'), 'removed');
  assert.equal(calls.length, 0);
});
