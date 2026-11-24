/**
 * What this file protects: the rail stays filled OUTSIDE `(main)`.
 *
 * The tiles and the nav are tested in `bundled-clients.test.ts` from
 * an `AppFrame` that declared its child slots itself. That is precisely what
 * `/agents`, `/multichat`, `/chat`, `/notifications` and `/events` never
 * mount: they paint their own TopBar. Here, we declare the slots
 * WITHOUT a `root` occupant — the case of these pages — and check that the
 * client halves register in them anyway.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { declareLayoutSlots } from './plugin-host/client-plugin-host';
import { register, resetSlotsForTests, slotEntries, slotKind } from './plugin-host/slots';
import { UI_LAYOUT_CHILD_SLOTS } from './plugin-host/ui-layout';
import { mountBundledClients } from '@/plugins-client/mount';
import { NAV_SECONDARY_ORDER } from '@/plugins-client/nav';

const Empty = () => React.createElement('div');

test('without AppFrame, the host fills the rail anyway — the /agents case', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);

  const entries = slotEntries('nav.item');
  assert.ok(entries.length >= 14, `expected every product entry, got ${entries.length}`);
  assert.equal(entries[0]?.pluginId, '@timon/ui-layout', 'the cockpit stays the first entry');
  const orders = entries.map((e) => e.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  const divider = orders.indexOf(NAV_SECONDARY_ORDER - 1);
  assert.notEqual(divider, -1, 'the rule is a nav entry, not chrome painted by the rail');
});

test('disposing the host empties the rail', () => {
  resetSlotsForTests();
  const dispose = declareLayoutSlots();
  mountBundledClients(null);
  assert.ok(slotEntries('nav.item').length > 0);
  dispose();
  assert.equal(slotKind('nav.item'), null, 'turning ui-layout off removes the slots, not only their occupants');
  assert.equal(slotEntries('nav.item').length, 0);
});

/**
 * The ownership trap of this fix: `AppFrame` no longer declares the child
 * slots. If it still declared them, leaving `(main)` would dispose it and
 * collapse `nav.item` with it, while the host effect — mounted at the
 * root — would not replay. The rail would be empty again on /agents.
 */
test('AppFrame does not redeclare the slots the host already holds', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);
  const before = slotEntries('nav.item').length;

  const leaveMain = register({ slot: 'root', pluginId: '@timon/ui-layout' }, Empty);
  assert.equal(slotEntries('nav.item').length, before, 'pas de double inscription');
  leaveMain();
  assert.equal(slotKind('nav.item'), 'list', 'leaving (main) must not collapse the rail');
  assert.equal(slotEntries('nav.item').length, before);
});

test('a slot already declared elsewhere is neither redeclared nor taken away', () => {
  resetSlotsForTests();
  // A third-party layout took `page` before the host: `declareSlot` would throw.
  const other = register({ slot: 'root', pluginId: 'blank-layout', children: { page: 'keyed' } }, Empty);
  const dispose = declareLayoutSlots();
  assert.equal(slotKind('page'), 'keyed');
  dispose();
  assert.equal(slotKind('page'), 'keyed', 'the host only collapses what it declared');
  assert.equal(slotKind('nav.item'), null);
  other();
  assert.equal(slotKind('page'), null);
});

test('the host declares exactly the layout slots', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  for (const name of Object.keys(UI_LAYOUT_CHILD_SLOTS)) {
    assert.equal(slotKind(name), UI_LAYOUT_CHILD_SLOTS[name], name);
  }
});

/**
 * T.4: installing a third-party layout without choosing it must not take
 * the chrome down. The host still declares the product slots; the loader
 * is what refuses to import the spare layout (see plugin-host-loader.test).
 */
test('an installed blank-layout does not collapse the rail on its own', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);
  const before = slotEntries('nav.item').length;
  assert.ok(before > 0);
  register({ slot: 'root', pluginId: 'blank-layout', children: { page: 'keyed' } }, Empty);
  assert.equal(slotKind('nav.item'), 'list', 'the host keeps the product slots');
  assert.equal(slotEntries('nav.item').length, before);
});
