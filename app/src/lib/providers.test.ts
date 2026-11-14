import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acpAction, binaryAction, orderAuthMethods, pathsToAuthorize, providerErrorMessage, type AcpAgent, type AcpAuthMethod, type ProviderBinary,
} from './providers';

const binary = (over: Partial<ProviderBinary> = {}): ProviderBinary => ({
  name: 'agent', found: 'agent', resolved: '/usr/bin/agent', allowed: false, refused: null, ...over,
});
const agent = (over: Partial<AcpAgent> = {}): AcpAgent => ({
  id: 'a', name: 'A', version: '2', description: null, website: null, license: null,
  supported: true, reason: null, integrity: 'sha256', installed: null, ...over,
});

test('a binary asks for authorization only when it resolved, is allowed to be, and is not yet', () => {
  assert.equal(binaryAction(binary()), 'authorize');
  assert.equal(binaryAction(binary({ allowed: true })), 'ready');
  assert.equal(binaryAction(binary({ resolved: null })), 'install');
  assert.equal(binaryAction(binary({ refused: 'launcher' })), 'refused');
});

test('only resolved, non-refused, distinct paths are sent back for authorization', () => {
  assert.deepEqual(pathsToAuthorize([
    binary(), binary({ name: 'twin' }), binary({ name: 'gone', resolved: null }),
    binary({ name: 'sh', resolved: '/bin/sh', refused: 'launcher' }),
  ]), ['/usr/bin/agent']);
});

test('ACP row action: install, update, repair a tampered one, nothing when unsupported or current', () => {
  assert.equal(acpAction(agent()), 'install');
  assert.equal(acpAction(agent({ supported: false })), 'none');
  const installed = (state: 'ok' | 'tampered' | 'missing' | 'pending', updateAvailable: boolean) =>
    ({ version: '1', integrity: 'sha256' as const, updateAvailable, state, profileId: 'acp-a' });
  assert.equal(acpAction(agent({ installed: installed('ok', false) })), 'none');
  assert.equal(acpAction(agent({ installed: installed('ok', true) })), 'update');
  assert.equal(acpAction(agent({ installed: installed('tampered', false) })), 'repair');
  assert.equal(acpAction(agent({ installed: installed('missing', true), supported: false })), 'none');
});

test('ACP row action: an unverified install the registry now hashes is offered the verified build, before a plain update', () => {
  const installed = { version: '1.4.1', integrity: 'unverified' as const, updateAvailable: true, verifiedUpdate: true, state: 'ok' as const, profileId: 'acp-a' };
  assert.equal(acpAction(agent({ installed })), 'verify');
  assert.equal(acpAction(agent({ installed: { ...installed, verifiedUpdate: false } })), 'update');
  assert.equal(acpAction(agent({ installed: { ...installed, state: 'tampered' } })), 'repair', 'a repair comes first');
  assert.equal(acpAction(agent({ installed, supported: false })), 'none');
});

test('sign-in methods: the suggested one first, billed per token last', () => {
  const method = (id: string, over: Partial<AcpAuthMethod> = {}): AcpAuthMethod => ({
    id, name: id, description: null, kind: 'agent', billedPerToken: false, recommended: false, command: null, ...over,
  });
  const ordered = orderAuthMethods([method('key', { billedPerToken: true }), method('business'), method('google', { recommended: true })]);
  assert.deepEqual(ordered.map((m) => m.id), ['google', 'business', 'key']);
});

test('daemon codes map to sentences; an unknown one keeps the daemon message', () => {
  assert.match(providerErrorMessage(403, '', ''), /superadmin/);
  assert.match(providerErrorMessage(409, 'mismatch', 'x'), /changed/);
  assert.match(providerErrorMessage(502, 'inspect-failed', 'x'), /signs in/);
  // Only the daemon's words quote what the program printed (TODO #588).
  assert.equal(providerErrorMessage(409, 'binary-identity', 'printed "other 1.0"'), 'printed "other 1.0"');
  assert.equal(providerErrorMessage(500, 'weird', 'from the daemon'), 'from the daemon');
  assert.match(providerErrorMessage(500, '', ''), /HTTP 500/);
});
