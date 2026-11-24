/**
 * `project.settings`: the rows plugins add to a project's window. Nothing is
 * painted while no plugin holds one; a plugin that names the slot paints its
 * row under "Integrations" and reads the project from `useProjectSettings()`;
 * a plugin that does not name it is refused, a widget included.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resetSlotsForTests, slotKind } from '../lib/plugin-host/slots';
import { clientContext } from '../lib/plugin-host/loader';
import { setLocale } from '../lib/i18n';
import { ProjectSettingsSlot, useProjectSettings } from './project-settings-slot';

function Row() {
  const settings = useProjectSettings();
  return React.createElement('div', { 'data-row': settings?.project ?? 'none' });
}

const paint = (project: string) => renderToStaticMarkup(React.createElement(ProjectSettingsSlot, { project }));

test('a list slot declared at boot, empty: the window keeps its exact markup', () => {
  resetSlotsForTests();
  assert.equal(slotKind('project.settings'), 'list');
  assert.equal(paint('acme'), '');
});

test('a plugin naming the slot paints its row for the project, under one label', () => {
  resetSlotsForTests();
  setLocale('en');
  const plugin = clientContext('acme-row', ['project.settings']);
  const dispose = plugin.slots.register({ slot: 'project.settings' }, Row);
  const html = paint('acme');
  assert.match(html, /data-project-settings/);
  assert.match(html, />Integrations</);
  assert.match(html, /data-row="acme"/);
  dispose();
  assert.equal(paint('acme'), '');
});

test('a plugin that does not name the slot is refused, a widget included', () => {
  resetSlotsForTests();
  for (const declared of [[], ['cockpit.widget'], ['settings.section']]) {
    const plugin = clientContext('intruder', declared);
    assert.throws(() => plugin.slots.register({ slot: 'project.settings' }, Row), /project\.settings/, declared.join(','));
  }
  assert.equal(paint('acme'), '');
});
