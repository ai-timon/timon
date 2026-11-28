import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  register,
  resetSlotsForTests,
  slotEntries,
  slotKind,
} from './plugin-host/slots';
import { SlotSingle } from './plugin-host/render';
import { clientContext } from './plugin-host/loader';
import {
  CHAT_COMPOSER_ACTION_SLOT,
  CHAT_COMPOSER_SLOT,
  mountComposerSlot,
} from '@/components/chat/composer';

const Plugin = () => React.createElement('p', null, 'composer du plugin');

function paint(): string {
  return renderToStaticMarkup(React.createElement(SlotSingle, { name: CHAT_COMPOSER_SLOT }));
}

test('the chat declares the input as a single slot, and its actions as a list', () => {
  resetSlotsForTests();
  const unmount = mountComposerSlot();
  assert.equal(slotKind(CHAT_COMPOSER_SLOT), 'single');
  assert.equal(slotKind(CHAT_COMPOSER_ACTION_SLOT), 'list');
  unmount();
  assert.equal(slotKind(CHAT_COMPOSER_SLOT), null, 'quitter le chat rend ses slots');
});

test('the product composer occupies the slot by default, without closing it', () => {
  resetSlotsForTests();
  const unmount = mountComposerSlot();
  const fallback = slotEntries(CHAT_COMPOSER_SLOT);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0]?.fallback, true, 'the product gives way, it does not keep the place');
  assert.equal(fallback[0]?.pluginId, '@timon/missions');
  unmount();
});

test('a plugin that declares chat.composer replaces the input, and gives it back when it leaves', () => {
  resetSlotsForTests();
  const unmount = mountComposerSlot();
  const context = clientContext('acme-composer', [CHAT_COMPOSER_SLOT]);
  const dispose = context.slots.register({ slot: CHAT_COMPOSER_SLOT }, Plugin);

  assert.match(paint(), /composer du plugin/);
  dispose();
  // Outside the chat, the product composer paints nothing (no context): what
  // the takeover proves is that it BECAME the occupant again, not its drawing.
  assert.equal(slotEntries(CHAT_COMPOSER_SLOT)[0]?.pluginId, '@timon/missions');
  unmount();
});

test('a widget does not take the input: the slot is not of widget kind', () => {
  resetSlotsForTests();
  const unmount = mountComposerSlot();
  const widget = clientContext('widget-only', ['cockpit.widget']);
  assert.throws(
    () => widget.slots.register({ slot: CHAT_COMPOSER_SLOT }, Plugin),
    /is not allowed in slot chat\.composer/,
  );
  unmount();
});

test('two chats side by side share a registration, and the last one to leave gives it back', () => {
  resetSlotsForTests();
  const first = mountComposerSlot();
  const second = mountComposerSlot();
  assert.equal(slotEntries(CHAT_COMPOSER_SLOT).length, 1, 'one description, not one per cell');
  assert.deepEqual(slotEntries(CHAT_COMPOSER_ACTION_SLOT).map((entry) => entry.pluginId), ['@timon/missions']);

  first();
  assert.equal(slotKind(CHAT_COMPOSER_SLOT), 'single', 'closing a cell does not deprive the others');
  assert.equal(slotEntries(CHAT_COMPOSER_SLOT).length, 1);

  assert.equal(slotEntries(CHAT_COMPOSER_ACTION_SLOT).length, 1);
  second();
  assert.equal(slotKind(CHAT_COMPOSER_SLOT), null);
  assert.deepEqual(slotEntries(CHAT_COMPOSER_ACTION_SLOT), []);
});

test('the chat mounted in a layout that already declares the slots does not redeclare them', () => {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: { [CHAT_COMPOSER_ACTION_SLOT]: 'list' } }, Plugin);
  const unmount = mountComposerSlot();
  assert.equal(slotKind(CHAT_COMPOSER_ACTION_SLOT), 'list');
  unmount();
  assert.equal(slotKind(CHAT_COMPOSER_ACTION_SLOT), 'list', 'the chat does not give back a slot it did not declare');
});
