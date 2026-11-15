/**
 * The mascot pack registry (`mascot.parts`): a part is admitted only if its
 * plugin's manifest declares it, keyed `<pluginId>:<slug>`; it is read by the
 * look schema, the geometry and the drawing while its plugin is here, and every
 * look that wears it falls back to the default once the plugin leaves.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MASCOT_PARTS_SLOT, register, resetSlotsForTests } from '@/lib/plugin-host/slots';
import { recordMascotDeclarations, resetMascotDeclarationsForTests } from '@/lib/mascot/parts-declarations';
import { DEFAULT_LOOK, defaultLookFor, lookFurHex, normalizeAgentLook } from './agent-look';
import { exprPoints, headLayout, EYE_POINTS } from './mascot-geometry';
import { mascotPacks, mascotPartOf } from './mascot-parts';
import { lookChoices, randomLook } from './random-look';
import { AgentMascot } from './agent-mascot';

const CAP = { type: 'acc', label: 'Cap', svg: '<rect x="-8" y="-4" width="16" height="8" rx="3" fill="#3fa9ff"/>' } as const;
const DIAMOND: readonly (readonly [number, number])[] = [[0, -6], [5, 0], [0, 6], [-5, 0]];

function setup(t: test.TestContext): void {
  // The test runner compiles JSX to `React.createElement`.
  Object.assign(globalThis, { React });
  resetSlotsForTests();
  resetMascotDeclarationsForTests();
  recordMascotDeclarations([
    { id: 'acme-pack', label: 'Acme pack', mascot: { acc: ['cap'], color: ['midnight'], eyes: ['gem'], shape: ['blob'] } },
    { id: 'other-pack', label: null, mascot: { acc: ['cap'] } },
    { id: 'plain', label: 'Plain plugin' },
  ]);
  t.after(() => { resetSlotsForTests(); resetMascotDeclarationsForTests(); });
}

test('a declared part is admitted under <pluginId>:<slug>; two packs may use the same slug', (t) => {
  setup(t);
  register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'cap', mascotPart: CAP });
  register({ slot: MASCOT_PARTS_SLOT, pluginId: 'other-pack', key: 'cap', mascotPart: { ...CAP, label: 'Other cap' } });
  assert.equal(mascotPartOf('acc', 'acme-pack:cap')?.label, 'Cap');
  assert.equal(mascotPartOf('acc', 'other-pack:cap')?.label, 'Other cap');
  assert.equal(mascotPartOf('color', 'acme-pack:cap'), null, 'a part is of one type only');
  assert.deepEqual(mascotPacks().map((p) => [p.pluginId, p.label, p.parts.map((x) => x.id)]), [
    ['acme-pack', 'Acme pack', ['acme-pack:cap']],
    ['other-pack', 'other-pack', ['other-pack:cap']],
  ]);
});

test('an undeclared, malformed or misplaced part is refused with its reason', (t) => {
  setup(t);
  assert.throws(() => register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'hat', mascotPart: CAP }),
    /mascot part `hat` is not declared as `acc` in its manifest/);
  assert.throws(() => register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'midnight', mascotPart: CAP }),
    /not declared as `acc`/, 'declared, but as a fur');
  assert.throws(() => register({ slot: MASCOT_PARTS_SLOT, pluginId: 'plain', key: 'cap', mascotPart: CAP }), /not declared/);
  assert.throws(() => register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', mascotPart: CAP }), /needs a `key`/);
  assert.throws(() => register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'cap' }), /mascot part `cap` refused — a mascot part must be an object/);
  assert.throws(() => register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'cap', mascotPart: { ...CAP, svg: '<g onclick="alert(1)"/>' } }),
    /svg refused: attribute onclick is not allowed/);
  assert.throws(() => register({ slot: 'agent.mascot', pluginId: 'acme-pack', mascotPart: CAP }, () => null), /read for `mascot\.parts` only/);
  register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'cap', mascotPart: CAP });
  assert.throws(() => register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'cap', mascotPart: CAP }), /acme-pack:cap/, 'one part per id');
});

test('a look wears a registered part, and the job\'s default once its plugin leaves', (t) => {
  setup(t);
  const disposers = [
    register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'cap', mascotPart: CAP }),
    register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'midnight', mascotPart: { type: 'color', label: 'Midnight', hex: '#1D2B53' } }),
    register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'gem', mascotPart: { type: 'eyes', label: 'Gem', left: DIAMOND, blink: false } }),
    register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'blob', mascotPart: { type: 'shape', label: 'Blob', skull: { top: 66, bottom: 92, height: 76, radius: 34 } } }),
  ];
  const packed = { shape: 'acme-pack:blob', color: 'acme-pack:midnight', eyes: 'acme-pack:gem', acc: 'acme-pack:cap' };
  const base = defaultLookFor('code');
  assert.deepEqual(normalizeAgentLook(packed, base), packed);
  assert.equal(lookFurHex('acme-pack:midnight'), '#1d2b53');
  const blob = headLayout('acme-pack:blob');
  const classic = headLayout('squircle');
  // Set in the older box (classic skull 66 high), scaled onto this frame's classic skull and standing on its foot.
  const k = (classic.bottom - classic.top) / 66;
  assert.ok(Math.abs(blob.bottomWidth - 92 * k) < 1e-9 && Math.abs(blob.bottom - blob.top - 76 * k) < 1e-9, 'the pack\'s skull');
  assert.equal(blob.bottom, classic.bottom);
  assert.deepEqual([blob.visor.w, blob.visor.h], [classic.visor.w, classic.visor.h], 'the visor keeps its one size');
  assert.doesNotMatch(blob.body + blob.earL + blob.earR, /NaN/);
  const geo = headLayout('round').geo;
  const eyes = exprPoints('acme-pack:gem', geo);
  assert.equal(eyes.L.length, EYE_POINTS, 'resampled like a glyph, so it morphs');
  assert.ok(Math.abs(eyes.L[0]![0] - geo.c1) < 0.5, 'the left eye sits on the left eye\'s place');
  assert.ok(eyes.R.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])), 'the right eye mirrors the left');
  const choices = lookChoices();
  assert.ok(choices.accessories.includes('acme-pack:cap') && choices.shapes.includes('acme-pack:blob'));
  assert.equal(randomLook(() => 0.999).acc, 'acme-pack:cap', 'a random draw reaches the packs too');

  const drawn = renderToStaticMarkup(React.createElement(AgentMascot, packed as never));
  assert.match(drawn, /data-mascot-acc="acme-pack:cap"/);
  assert.match(drawn, /<rect x="-8" y="-4" width="16" height="8" rx="3" fill="#3fa9ff"><\/rect>/);
  assert.doesNotMatch(drawn, /NaN/);

  for (const dispose of disposers) dispose();
  assert.deepEqual(normalizeAgentLook(packed, base), base, 'each part falls back to the job\'s default');
  assert.equal(lookFurHex('acme-pack:midnight'), DEFAULT_LOOK.color);
  assert.equal(headLayout('acme-pack:blob').bottomWidth, headLayout('squircle').bottomWidth, 'the classic skull');
  const gone = renderToStaticMarkup(React.createElement(AgentMascot, packed as never));
  assert.doesNotMatch(gone, /<rect x="-8"/, 'a tool whose pack left draws nothing');
  assert.doesNotMatch(gone, /NaN/);
});

test('the examples/plugin-mascot-pack template registers its declared parts with the SDK alone', async (t) => {
  const { readFileSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  setup(t);
  const root = resolve(process.cwd(), '..', 'examples', 'plugin-mascot-pack');
  const manifest = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { timon: { id: string; label: string; mascot: unknown } }).timon;
  recordMascotDeclarations([{ id: manifest.id, label: manifest.label, mascot: manifest.mascot }]);
  const dir = mkdtempSync(join(tmpdir(), 'mascot-pack-example-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, readFileSync(join(root, 'lib', 'client.js'), 'utf8'));
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => () => void };
  const dispose = mod.apply({ slots: { register: (options: { slot: string }) => register({ ...options, pluginId: manifest.id }) } });
  const [pack] = mascotPacks();
  assert.equal(pack?.label, 'Winter mascot pack');
  assert.deepEqual(pack?.parts.map((p) => [p.id, p.type]), [
    ['example-mascot-pack:beanie', 'acc'],
    ['example-mascot-pack:scarf', 'acc'],
    ['example-mascot-pack:midnight', 'color'],
    ['example-mascot-pack:snowflake', 'eyes'],
  ]);
  const look = { shape: 'round', color: 'example-mascot-pack:midnight', eyes: 'example-mascot-pack:snowflake', acc: 'example-mascot-pack:scarf' };
  assert.deepEqual(normalizeAgentLook(look), look);
  const drawn = renderToStaticMarkup(React.createElement(AgentMascot, look as never));
  assert.match(drawn, /data-mascot-acc="example-mascot-pack:scarf"/);
  assert.doesNotMatch(drawn, /NaN/);
  dispose();
  assert.equal(mascotPacks().length, 0, 'dispose takes every part away');
});

test('an agent row keeps its pack part before the pack loads; the head draws the role\'s default until it is there', async (t) => {
  setup(t);
  const { agentIdentity, AgentAvatar } = await import('@/components/agent-avatar');
  const row = { name: 'nova', role: 'code', avatar: 'mascot', look: { shape: 'round', color: '#d4a373', eyes: 'happy', acc: 'acme-pack:cap' } };
  const identity = agentIdentity(row, null);
  assert.equal(identity.look?.acc, 'acme-pack:cap', 'read before the plugins load: the part is kept, a save sends it back');
  assert.equal(identity.lookBase?.acc, defaultLookFor('code').acc);
  const before = renderToStaticMarkup(React.createElement(AgentAvatar, { identity, size: 'xl' }));
  assert.match(before, new RegExp(`data-acc="${defaultLookFor('code').acc}"`), 'the role\'s tool meanwhile');
  register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'cap', mascotPart: CAP });
  const after = renderToStaticMarkup(React.createElement(AgentAvatar, { identity, size: 'xl' }));
  assert.match(after, /data-acc="acme-pack:cap"/, 'the pack\'s cap once it registered');
});
