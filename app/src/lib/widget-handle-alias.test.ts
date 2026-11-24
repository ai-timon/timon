import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * A widget with its own frame receives the host's layout controls under
 * `handle`, the SDK's name since API 17, and still under `poignee`, the name
 * a plugin written for an earlier API reads: such a plugin keeps its grip and
 * gear without being rebuilt.
 */
test('a frame-less widget gets the layout controls under handle and under poignee', async () => {
  // The host's .tsx compiles to the classic runtime under the test runner.
  Object.assign(globalThis, { React });
  const { declareSlot, register, resetSlotsForTests } = await import('./plugin-host/slots');
  const { useWidgetCatalog } = await import('../components/widget-host/use-widget-catalog');
  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  try {
    type Props = { handle?: unknown; poignee?: unknown };
    const ReadsHandle = ({ handle }: Props) => React.createElement('div', { 'data-reads': 'handle' }, handle as never);
    const ReadsPoignee = ({ poignee }: Props) => React.createElement('div', { 'data-reads': 'poignee' }, poignee as never);
    register({ slot: 'cockpit.widget', pluginId: 'fresh', key: 'w', widget: { title: 'Fresh', frame: 'none' } }, ReadsHandle as never);
    register({ slot: 'cockpit.widget', pluginId: 'older', key: 'w', widget: { title: 'Older', frame: 'none' } }, ReadsPoignee as never);

    const controls = React.createElement('button', { type: 'button' }, 'grip');
    function Paint() {
      const catalog = useWidgetCatalog();
      return React.createElement(React.Fragment, null,
        [...catalog.byId.values()].map((entry) => React.createElement(React.Fragment, { key: entry.id },
          entry.render({ handle: controls, className: 'h-full' }))));
    }
    const html = renderToStaticMarkup(React.createElement(Paint));
    assert.match(html, /<div data-reads="handle"><button type="button">grip<\/button><\/div>/);
    assert.match(html, /<div data-reads="poignee"><button type="button">grip<\/button><\/div>/);
  } finally {
    resetSlotsForTests();
  }
});
