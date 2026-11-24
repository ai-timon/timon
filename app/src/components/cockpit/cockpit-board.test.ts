/**
 * On a phone the widget card sets no height of its own, so the cockpit's centre
 * column must bound its "fill" cards itself — otherwise the chat grows to its
 * whole thread and nothing inside it scrolls (TODO #423).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(__dirname, 'cockpit-board.tsx'), 'utf8');

test('the centre zone gives its fill cards a bounded share of the column', () => {
  const frame = '[&>.widget-frame[data-height-mode=fill]]';
  for (const utility of ['min-h-0', 'flex-1', 'basis-0']) {
    assert.ok(source.includes(`${frame}:${utility}`), `centre zone lacks ${utility} on fill cards`);
  }
  assert.ok(source.includes('className={CENTRE_CLASSES}'), 'the centre zone must use CENTRE_CLASSES');
});

test('the rails and the centre end at the same height: same padding, no extra bottom', () => {
  const rail = /const RAIL_BASE =\s*'([^']+)'/.exec(source)?.[1] ?? '';
  const centre = /const CENTRE_CLASSES = \[\s*'([^']+)'/.exec(source)?.[1] ?? '';
  assert.ok(rail.includes('p-0.5') && centre.includes('p-0.5'));
  for (const extra of ['pb-', 'py-']) {
    assert.ok(!rail.split(' ').some((c) => c.startsWith(extra)), `no ${extra} on the rails`);
    assert.ok(!centre.split(' ').some((c) => c.startsWith(extra)), `no ${extra} on the centre`);
  }
});
