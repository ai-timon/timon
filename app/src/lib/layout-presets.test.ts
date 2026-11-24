// french-ok-file: accented preset names, the folding under test
/**
 * Named arrangements — the pure half.
 *
 * What breaks silently here: a preset that carries the presets row itself
 * (each save would then embed every earlier one, and the 64 KiB cap would be
 * hit after a handful), and a recall that only adds (the same click would give
 * a different screen depending on what was on it beforehand).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PRESETS,
  MAX_PRESETS_BYTES,
  MAX_NAME_LENGTH,
  addPreset,
  fitsPresets,
  mergePresets,
  presetsBytes,
  previousPresetsSource,
  captureScopes,
  normaliseName,
  readPresets,
  recallWrites,
  removePreset,
  renamePreset,
  replacePreset,
  writePresets,
  type LayoutPreset,
} from './layout-presets';

const scopes = { widgets: [{ id: 'agenda' }], columns: { left: 240 } };
const seed = (n: number): LayoutPreset[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id${i}`, name: `Preset ${i}`, createdAt: i, scopes: {} }));

test('an unreadable row is no preset rather than a crash', () => {
  for (const raw of [null, undefined, 42, 'presets', [], { presets: 'nope' }]) {
    assert.deepEqual(readPresets(raw), []);
  }
});

test('one corrupted entry is dropped without taking its neighbours', () => {
  const raw = { v: 1, presets: [
    { id: 'a', name: 'Kept', createdAt: 1, scopes: {} },
    { id: '', name: 'No id', createdAt: 1, scopes: {} },
    { id: 'c', name: '   ', createdAt: 1, scopes: {} },
    { id: 'd', name: 'No scopes', createdAt: 1 },
    { id: 'e', name: 'Also kept', createdAt: 2, scopes: { widgets: 1 } },
  ] };
  assert.deepEqual(readPresets(raw).map((p) => p.id), ['a', 'e']);
});

test('a duplicate id keeps the first, so a later write is never ambiguous', () => {
  const raw = { v: 1, presets: [
    { id: 'a', name: 'First', createdAt: 1, scopes: {} },
    { id: 'a', name: 'Second', createdAt: 2, scopes: {} },
  ] };
  assert.deepEqual(readPresets(raw).map((p) => p.name), ['First']);
});

test('what is written reads back identical', () => {
  const presets = seed(3);
  assert.deepEqual(readPresets(writePresets(presets)), presets);
});

test('a name is trimmed, collapsed and capped', () => {
  assert.equal(normaliseName('  Deux   mots  '), 'Deux mots');
  assert.equal(normaliseName('x'.repeat(MAX_NAME_LENGTH + 10)).length, MAX_NAME_LENGTH);
});

test('a blank name is refused rather than painting an empty row in the menu', () => {
  const out = addPreset([], '   ', scopes);
  assert.deepEqual(out, { ok: false, error: 'empty-name' });
});

test('two names a user reads as the same one cannot coexist', () => {
  const first = addPreset([], 'Revue', scopes);
  assert.ok(first.ok);
  for (const name of ['revue', 'REVUE', 'Revué', '  Revue  ']) {
    assert.deepEqual(addPreset(first.presets, name, scopes), { ok: false, error: 'duplicate-name' });
  }
});

test('the count is bounded before the daemon would answer 400', () => {
  const full = seed(MAX_PRESETS);
  assert.deepEqual(addPreset(full, 'One more', scopes), { ok: false, error: 'too-many' });
});

test('a saved preset carries the arrangement it was given, under a fresh id', () => {
  const out = addPreset([], 'Revue', scopes, 1700);
  assert.ok(out.ok);
  assert.equal(out.preset.name, 'Revue');
  assert.equal(out.preset.createdAt, 1700);
  assert.deepEqual(out.preset.scopes, scopes);
  assert.notEqual(out.preset.id, '');
  assert.equal(out.presets.length, 1);
});

test('renaming keeps the id and the position; fixing one own case is allowed', () => {
  const presets = seed(3);
  const out = renamePreset(presets, 'id1', 'preset 1');
  assert.ok(out.ok);
  assert.equal(out.presets[1]!.id, 'id1');
  assert.equal(out.presets[1]!.name, 'preset 1');
  assert.deepEqual(renamePreset(presets, 'id1', 'Preset 2'), { ok: false, error: 'duplicate-name' });
  assert.deepEqual(renamePreset(presets, 'nope', 'x'), { ok: false, error: 'unknown' });
});

test('overwriting changes the arrangement and nothing else', () => {
  const presets = seed(2);
  const out = replacePreset(presets, 'id0', scopes);
  assert.ok(out.ok);
  assert.equal(out.presets[0]!.id, 'id0');
  assert.equal(out.presets[0]!.name, 'Preset 0');
  assert.equal(out.presets[0]!.createdAt, 0);
  assert.deepEqual(out.presets[0]!.scopes, scopes);
  assert.deepEqual(replacePreset(presets, 'nope', scopes), { ok: false, error: 'unknown' });
});

test('removing an absent id changes nothing', () => {
  const presets = seed(2);
  assert.deepEqual(removePreset(presets, 'id0').map((p) => p.id), ['id1']);
  assert.deepEqual(removePreset(presets, 'nope'), presets);
});

test('a capture strips the prefix and never photographs the presets row nor the rail\'s leftover', () => {
  const out = captureScopes('v2.abc.', [
    { scope: 'v2.abc.widgets', layout: [1] },
    { scope: 'v2.abc.columns', layout: { left: 2 } },
    { scope: 'v2.abc.presets', layout: { v: 1, presets: [] } },
    { scope: 'v2.abc.nav', layout: { pinned: true } },
    { scope: 'v2.abc.', layout: 'no suffix' },
    { scope: 'v2.abd.widgets', layout: 'another view' },
  ]);
  assert.deepEqual(out, { widgets: [1], columns: { left: 2 } });
});

test('a recall erases the rows the preset does not hold, so it is not additive', () => {
  const preset: LayoutPreset = { id: 'a', name: 'Revue', createdAt: 0, scopes: { widgets: [1] } };
  assert.deepEqual(recallWrites(preset, { widgets: [9], columns: { left: 2 }, nav: 3 }), [
    { suffix: 'columns', layout: null },
    { suffix: 'nav', layout: null },
    { suffix: 'widgets', layout: [1] },
  ]);
});

test('a recall onto an empty view writes only what the preset holds', () => {
  const preset: LayoutPreset = { id: 'a', name: 'Revue', createdAt: 0, scopes: { widgets: [1] } };
  assert.deepEqual(recallWrites(preset, {}), [{ suffix: 'widgets', layout: [1] }]);
});

/**
 * The cap the daemon enforces, counted on the client side.
 *
 * What breaks silently without this: twelve presets are only a limit on the
 * *number* of rows, and a view whose arrangement weighs a few kilobytes hits
 * the byte cap first. The write would then leave, come back a 400, and the
 * form would already have closed on a success nobody got.
 *
 * The value is pinned here on purpose: it is a copy of `LAYOUT_MAX_BYTES`
 * (`orchestrator/src/plugins-bundled/settings/routes.ts`), whose own test
 * pins the same number. Moving one side alone turns one of the two red.
 */
test('the mirrored cap is the daemon 64 KiB, counted on the row itself', () => {
  assert.equal(MAX_PRESETS_BYTES, 64 * 1024);
  const presets = seed(1);
  // The unit is UTF-8 bytes, not characters: a name full of accents weighs
  // more than its length.
  const accented = [{ ...presets[0]!, name: 'éééé' }];
  assert.equal(presetsBytes(accented) - presetsBytes([{ ...presets[0]!, name: 'aaaa' }]), 4);
});

test('a row at the cap passes, one byte over is refused before any write', () => {
  // Padding sized so the serialised row lands exactly on the cap.
  const pad = (bytes: number): LayoutPreset[] => {
    const base: LayoutPreset = { id: 'a', name: 'Heavy', createdAt: 0, scopes: { widgets: '' } };
    const overhead = presetsBytes([base]);
    return [{ ...base, scopes: { widgets: 'x'.repeat(bytes - overhead) } }];
  };
  assert.equal(presetsBytes(pad(MAX_PRESETS_BYTES)), MAX_PRESETS_BYTES);
  assert.equal(fitsPresets(pad(MAX_PRESETS_BYTES)), true);
  assert.equal(fitsPresets(pad(MAX_PRESETS_BYTES + 1)), false);
});

/**
 * Folding an old per-project list into the shared one.
 *
 * Runs unattended, the first time the shared row is read empty, so every
 * failure mode has to be a truncation rather than a refusal: the user never
 * asked for this write and cannot be told anything useful about it.
 */
test('a migration keeps the shared list first and adds only what it lacks', () => {
  const shared = seed(2);
  const legacy: LayoutPreset[] = [
    shared[1]!,
    { id: 'other', name: 'PRESET 0', createdAt: 9, scopes: {} },
    { id: 'kept', name: 'Revue', createdAt: 9, scopes: {} },
  ];
  assert.deepEqual(mergePresets(shared, legacy), [...shared, legacy[2]!]);
  // The same fold run twice adds nothing: a preset the user deleted after a
  // migration must not come back on the next read.
  assert.deepEqual(mergePresets(mergePresets(shared, legacy), legacy), [...shared, legacy[2]!]);
});

test('a migration truncates at both caps instead of refusing', () => {
  const many = mergePresets(seed(MAX_PRESETS), seed(MAX_PRESETS + 5).map((p, i) => ({ ...p, id: `x${i}`, name: `X ${i}` })));
  assert.equal(many.length, MAX_PRESETS);

  const heavy = (id: string, bytes: number): LayoutPreset =>
    ({ id, name: id, createdAt: 0, scopes: { widgets: 'x'.repeat(bytes) } });
  const out = mergePresets([heavy('a', MAX_PRESETS_BYTES - 200)], [heavy('b', MAX_PRESETS_BYTES - 200)]);
  assert.deepEqual(out.map((p) => p.id), ['a'], 'the tail goes, never the row the user already had');
  assert.equal(fitsPresets(out), true);
});

// TIM-0137: on a remote machine the list written before 0.1.6 sits under the
// local id's hash. It is folded in once, even over a list saved since.
test('a remote\'s pre-0.1.6 list is folded once, over a list saved since the update', () => {
  assert.equal(previousPresetsSource('v2.now.shared-presets', 'v2.before.shared-presets', true, new Set()), 'v2.before.shared-presets');
  const savedSince: LayoutPreset[] = [{ id: 'new', name: 'Agent default', createdAt: 9, scopes: {} }];
  const before = seed(3);
  assert.deepEqual(mergePresets(savedSince, before), [...savedSince, ...before]);
});

test('nothing to fold on this computer, before the list is read, twice, or on the same row', () => {
  assert.equal(previousPresetsSource('v2.now.shared-presets', null, true, new Set()), null);
  assert.equal(previousPresetsSource('v2.now.shared-presets', undefined, true, new Set()), null);
  assert.equal(previousPresetsSource('v2.now.shared-presets', 'v2.before.shared-presets', false, new Set()), null);
  assert.equal(previousPresetsSource(null, 'v2.before.shared-presets', true, new Set()), null);
  assert.equal(previousPresetsSource('v2.now.shared-presets', 'v2.before.shared-presets', true, new Set(['v2.before.shared-presets'])), null);
  assert.equal(previousPresetsSource('v2.same.shared-presets', 'v2.same.shared-presets', true, new Set()), null);
});
