import assert from 'node:assert/strict';
import test from 'node:test';
import {
  moveWidget, dockWidget, mergeLayout, orphanPlacements, selectWidgetTab,
  setWidgetHeightMode, type WidgetConstraints,
} from '../components/widget-host/widget-layout';
import { buildWidgetCatalog } from '../components/widget-host/widget-catalog';

const constraints: WidgetConstraints[] = [
  { id: 'chat', defaultZone: 'centre', defaultRank: 0, defaultHeight: 520, minHeight: 280, heightMode: 'fill' },
  { id: 'clock', defaultZone: 'left', defaultRank: 0, defaultHeight: 140, minHeight: 110 },
  { id: 'tasks', defaultZone: 'right', defaultRank: 0, defaultHeight: 400, minHeight: 180 },
];
const base = () => mergeLayout(null, constraints);

test('legacy chat layouts adopt fill while explicit fixed choices and their pixel height survive reload', () => {
  const legacy = [{ id: 'chat', rail: 'left', rang: 2, hauteur: 637 }];
  const migrated = mergeLayout(legacy, constraints);
  assert.equal(migrated.find(w => w.id === 'chat')?.heightMode, 'fill');
  assert.equal(migrated.find(w => w.id === 'chat')?.rail, 'left');
  const fixed = setWidgetHeightMode(migrated, 'chat', 'fixed');
  const loaded = mergeLayout(JSON.parse(JSON.stringify(fixed)), constraints);
  assert.equal(loaded.find(w => w.id === 'chat')?.heightMode, 'fixed');
  assert.equal(loaded.find(w => w.id === 'chat')?.hauteur, 637);
  assert.equal(loaded.find(w => w.id === 'clock')?.heightMode, undefined);
});

test('docking adopts the destination sizing and changing it affects the entire stack across tab switches', () => {
  const docked = dockWidget(base(), 'chat', 'tasks');
  assert.equal(docked.find(w => w.id === 'chat')?.heightMode, 'fixed');
  const filled = setWidgetHeightMode(docked, 'tasks', 'fill');
  const loaded = mergeLayout(JSON.parse(JSON.stringify(selectWidgetTab(filled, 'tasks'))), constraints);
  for (const id of ['chat', 'tasks']) assert.equal(loaded.find(w => w.id === id)?.heightMode, 'fill');
  const detached = moveWidget(loaded, 'chat', 'left', null);
  assert.equal(detached.find(w => w.id === 'chat')?.heightMode, 'fill');
  assert.equal(detached.find(w => w.id === 'tasks')?.heightMode, 'fill');
  assert.equal(detached.find(w => w.id === 'clock')?.heightMode, undefined);
});

test('legacy groups with different widget defaults keep one sizing mode when changing tabs', () => {
  const legacy = base().map(w => w.id === 'clock' ? w : { ...w, rail: 'right', group: 'old', heightMode: undefined, activeTab: w.id === 'tasks' });
  const loaded = mergeLayout(legacy, constraints);
  const switched = mergeLayout(selectWidgetTab(loaded, 'chat'), constraints);
  assert.equal(switched.find(w => w.id === 'chat')?.heightMode, loaded.find(w => w.id === 'tasks')?.heightMode);
  assert.equal(switched.find(w => w.id === 'chat')?.heightMode, switched.find(w => w.id === 'tasks')?.heightMode);
});

test('temporarily missing plugins retain sizing and malformed values are ignored', () => {
  const raw = [{ id: 'missing', rail: 'left', rang: 0, hauteur: 280, heightMode: 'fill' }];
  assert.equal(orphanPlacements(raw, constraints)[0]?.heightMode, 'fill');
  const bad = base().map(w => ({ ...w, heightMode: 'bogus' }));
  const loaded = mergeLayout(bad, constraints);
  assert.equal(loaded.find(w => w.id === 'chat')?.heightMode, 'fill');
  assert.equal(loaded.find(w => w.id === 'clock')?.heightMode, undefined);
});

test('third-party widget sizing preferences reach the placement defaults', () => {
  const catalog = buildWidgetCatalog([], [{
    registrationId: 'test:1', pluginId: 'test', slot: 'cockpit.widget',
    options: { heightMode: 'fill', height: 500, minHeight: 200 },
  }]);
  assert.equal(mergeLayout(null, catalog)[0]?.heightMode, 'fill');
});

test('a fill share travels with the stack, survives a reload and never persists its default', () => {
  const half = setWidgetHeightMode(base(), 'chat', 'fill', 50);
  assert.equal(half.find(w => w.id === 'chat')?.fillPercent, 50);
  const loaded = mergeLayout(JSON.parse(JSON.stringify(half)), constraints);
  assert.equal(loaded.find(w => w.id === 'chat')?.fillPercent, 50);
  // The default is not written: 100 % leaves the field missing.
  assert.equal(setWidgetHeightMode(loaded, 'chat', 'fill', 100).find(w => w.id === 'chat')?.fillPercent, undefined);
  // Going back to a fixed height forgets the share rather than keeping it dormant.
  assert.equal(setWidgetHeightMode(half, 'chat', 'fixed').find(w => w.id === 'chat')?.fillPercent, undefined);
  // A stack has a single share: docking adopts the target's.
  const stack = dockWidget(half, 'tasks', 'chat');
  for (const id of ['chat', 'tasks']) assert.equal(stack.find(w => w.id === id)?.fillPercent, 50);
});

test('an absurd fill share is ignored rather than shrinking a widget to nothing', () => {
  const raw = [{ id: 'chat', rail: 'left', rang: 0, hauteur: 300, heightMode: 'fill', fillPercent: 0 }];
  assert.equal(mergeLayout(raw, constraints).find(w => w.id === 'chat')?.fillPercent, undefined);
  const huge = [{ id: 'chat', rail: 'left', rang: 0, hauteur: 300, heightMode: 'fill', fillPercent: 900 }];
  assert.equal(mergeLayout(huge, constraints).find(w => w.id === 'chat')?.fillPercent, undefined);
});
