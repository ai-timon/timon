/**
 * The mission isolation card's reading of the daemon: only the daemon's
 * verdict may say "active", an altered launcher and a refusing `enforce` are
 * said apart from a plain absence, and the exceptions dialog writes back
 * exactly what the daemon's strict schema accepts.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { setLocale } from './i18n';
import './i18n-test-locales';
import {
  draftsProblem, exceptionsSummary, fromDrafts, isFenceRefusal, isolationSummary, isolationTone, toDrafts,
  type MissionIsolationStatus,
} from './mission-isolation';

function status(over: Partial<MissionIsolationStatus>): MissionIsolationStatus {
  return {
    configured: 'auto', mechanism: 'none', abi: 0, enforced: false, state: 'unsupported', launch: 'unfenced',
    reason: 'kernel without Landlock', message: 'NOT enforced', gaps: [], unixSockets: 'deny',
    exceptions: { agents: [], projects: [] }, ...over,
  };
}

test('the tone follows the verdict, never the configured mode', () => {
  assert.equal(isolationTone(status({ enforced: true, state: 'ready', launch: 'fenced', mechanism: 'landlock', abi: 6 })), 'active');
  // `auto` without the mechanism is not protection.
  assert.equal(isolationTone(status({})), 'inactive');
  assert.equal(isolationTone(status({ state: 'tampered' })), 'altered');
  assert.equal(isolationTone(status({ configured: 'enforce', launch: 'refused', state: 'tampered' })), 'refusing');
  assert.equal(isolationTone(status({ configured: 'off', state: 'off' })), 'off');
});

test('the summary names the mechanism, or the reason there is none', () => {
  setLocale('en');
  try {
    assert.equal(isolationSummary(status({ enforced: true, mechanism: 'landlock', abi: 6 })), 'Missions run in a Landlock fence (kernel ABI 6).');
    assert.equal(isolationSummary(status({ enforced: true, mechanism: 'seatbelt' })), 'Missions run in a Seatbelt fence.');
    assert.equal(isolationSummary(status({})), 'No fence on this machine: kernel without Landlock.');
    assert.equal(isolationSummary(status({ state: 'off' })), 'Turned off.');
    setLocale('fr');
    assert.equal(isolationSummary(status({})), 'Aucune clôture sur cette machine : kernel without Landlock.');
  } finally {
    setLocale('en');
  }
});

test('the exceptions row counts agents and projects', () => {
  setLocale('en');
  assert.equal(exceptionsSummary({ agents: {}, projects: {} }), 'None');
  assert.equal(exceptionsSummary({ agents: { a: { writable: [] } }, projects: { p: { writable: [] }, q: { writable: [] } } }), '1 agent, 2 projects');
});

test('drafts round-trip to the shape the daemon accepts', () => {
  const exceptions = {
    agents: { deployer: { unixSockets: 'allow' as const, writable: [] } },
    projects: { site: { writable: ['~/.npm', '/opt/cache'] } },
  };
  const drafts = toDrafts(exceptions);
  assert.deepEqual(drafts, [
    { kind: 'agent', name: 'deployer', unixSockets: true, writable: '' },
    { kind: 'project', name: 'site', unixSockets: false, writable: '~/.npm\n/opt/cache' },
  ]);
  assert.deepEqual(fromDrafts(drafts), exceptions);
  // Blank lines and surrounding spaces are not paths; sockets off writes no key.
  assert.deepEqual(fromDrafts([{ kind: 'agent', name: ' x ', unixSockets: false, writable: '\n  ~/.cargo  \r\n\n' }]),
    { agents: { x: { writable: ['~/.cargo'] } }, projects: {} });
});

test('a name the fence would ignore, or the same one twice, is refused before saving', () => {
  setLocale('en');
  assert.equal(draftsProblem([{ kind: 'agent', name: 'timon.coder', unixSockets: false, writable: '' }]), null);
  for (const name of ['', '../up', '.hidden', 'a b', 'x'.repeat(129)]) {
    assert.notEqual(draftsProblem([{ kind: 'agent', name, unixSockets: false, writable: '' }]), null, name);
  }
  const twice = draftsProblem([
    { kind: 'project', name: 'site', unixSockets: false, writable: '' },
    { kind: 'project', name: 'site', unixSockets: true, writable: '' },
  ]);
  assert.match(twice ?? '', /two exceptions/);
  // The same name as an agent and as a project is two different exceptions.
  assert.equal(draftsProblem([
    { kind: 'agent', name: 'site', unixSockets: false, writable: '' },
    { kind: 'project', name: 'site', unixSockets: false, writable: '' },
  ]), null);
});

test('a launch refused by the fence is recognised by its code, nothing else', () => {
  assert.equal(isFenceRefusal({ error: 'Mission refused: …', code: 'mission_fence_refused' }), true);
  assert.equal(isFenceRefusal({ error: 'Mission refused: host.isolation.filesystem is "enforce"' }), false);
  assert.equal(isFenceRefusal({ error: 'backend claude is out of quota', code: 'backend_exhausted' }), false);
  assert.equal(isFenceRefusal(null), false);
});
