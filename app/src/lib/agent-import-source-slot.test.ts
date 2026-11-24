/**
 * Admission of a third-party source adapter into the agent import's socket
 * (plugins/agent-import). The socket is not a `*.widget` zone: it opens only
 * to a plugin that names it exactly, exists only while the import's settings
 * section is registered, and holds as many adapters as plugins bring.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { register, resetSlotsForTests, slotEntries, slotKind } from './plugin-host/slots';
import { clientContext } from './plugin-host/loader';
import { UI_LAYOUT_CHILD_SLOTS } from './plugin-host/ui-layout';

type Manifest = { timon: { id: string; client: { slots: string[] }; declares: Record<string, 'single' | 'list' | 'keyed'> } };
const manifest = JSON.parse(readFileSync(new URL('../../../plugins/agent-import/package.json', import.meta.url), 'utf8')) as Manifest;
const [SOCKET, KIND] = Object.entries(manifest.timon.declares)[0] ?? [];

const Empty = () => React.createElement('div');

/** The product layout, then the import's own section opening its socket, as `lib/client.js` does. */
function mountImport(): () => void {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, Empty);
  const host = clientContext(manifest.timon.id, manifest.timon.client.slots);
  return host.slots.register({ slot: 'settings.section', children: { [SOCKET!]: KIND! } }, Empty);
}

test('the import declares one list socket, named outside the widget zones', () => {
  assert.equal(SOCKET, 'agentimport.source');
  assert.equal(KIND, 'list');
  assert.doesNotMatch(SOCKET!, /\.widget$/);
});

test('a third-party adapter naming the socket is admitted, as many as there are', () => {
  mountImport();
  assert.equal(slotKind(SOCKET!), 'list');
  const acme = clientContext('acme-import-source', [SOCKET!]);
  const other = clientContext('other-import-source', [SOCKET!]);
  acme.slots.register({ slot: SOCKET! }, Empty);
  other.slots.register({ slot: SOCKET! }, Empty);
  assert.deepEqual(slotEntries(SOCKET!).map((e) => e.pluginId), ['acme-import-source', 'other-import-source']);
});

test('a plugin that does not name the socket is refused, a widget included', () => {
  mountImport();
  for (const declared of [[], ['cockpit.widget'], ['settings.section'], ['agentimport.other']]) {
    const plugin = clientContext('intruder', declared);
    assert.throws(() => plugin.slots.register({ slot: SOCKET! }, Empty), /is not allowed in slot agentimport\.source/, declared.join(','));
  }
  assert.equal(slotEntries(SOCKET!).length, 0);
});

test('the socket lives with the import: switched off, its adapters go with it', () => {
  const dispose = mountImport();
  clientContext('acme-import-source', [SOCKET!]).slots.register({ slot: SOCKET! }, Empty);
  dispose();
  assert.equal(slotKind(SOCKET!), null);
  assert.throws(() => clientContext('acme-import-source', [SOCKET!]).slots.register({ slot: SOCKET! }, Empty), /non déclaré|not declared/); // french-ok: the French locale under test
});

test("the import's own source for other agent tools occupies the socket the way a third party does", () => {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, Empty);
  assert.ok(manifest.timon.client.slots.includes(SOCKET!), 'the import names its own socket in client.slots');
  const host = clientContext(manifest.timon.id, manifest.timon.client.slots);
  const section = host.slots.register({ slot: 'settings.section', children: { [SOCKET!]: KIND! } }, Empty);
  host.slots.register({ slot: SOCKET! }, Empty);
  assert.deepEqual(slotEntries(SOCKET!).map((e) => e.pluginId), [manifest.timon.id]);
  section();
  assert.equal(slotKind(SOCKET!), null);
});

test('the entries of the import land in the slots declared at boot, exact admission', () => {
  mountImport();
  for (const slot of ['agents.toolbar', 'onboarding.agent']) {
    assert.equal(UI_LAYOUT_CHILD_SLOTS[slot], 'list', slot);
    assert.ok(manifest.timon.client.slots.includes(slot), `the manifest names ${slot}`);
    clientContext(manifest.timon.id, manifest.timon.client.slots).slots.register({ slot }, Empty);
    assert.deepEqual(slotEntries(slot).map((e) => e.pluginId), [manifest.timon.id]);
    for (const declared of [['cockpit.widget'], ['settings.section'], [SOCKET!]]) {
      assert.throws(() => clientContext('intruder', declared).slots.register({ slot }, Empty), /is not allowed in slot/, `${slot} ← ${declared.join(',')}`);
    }
  }
});
