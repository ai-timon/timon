/**
 * The mascot look schema: every value the mascot draws is accepted, anything
 * else is refused with a message that names the field and the accepted values,
 * never cut down to what fits. Same for the avatar mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_AVATAR_MODES, AGENT_LOOK_ACCESSORIES, AGENT_LOOK_COLORS, AGENT_LOOK_EYES, AGENT_LOOK_SHAPES,
  catalogKeeping, mascotCatalogOf, mascotPartCatalog, parseAgentAvatar, parseAgentLook, readAgentAvatar, readAgentLook, setMascotPartSource,
} from './agent-look.js';
import { mascotPartsOf } from './plugins/mascot-packs.js';
import type { PluginManifest } from './plugins/manifest.js';

const BASE = { shape: 'round', color: '#d4a373', eyes: 'happy', acc: 'coffee' };

test('every listed value is accepted', () => {
  for (const shape of AGENT_LOOK_SHAPES) assert.equal(parseAgentLook({ ...BASE, shape })?.shape, shape);
  for (const color of AGENT_LOOK_COLORS) assert.equal(parseAgentLook({ ...BASE, color })?.color, color);
  for (const eyes of AGENT_LOOK_EYES) assert.equal(parseAgentLook({ ...BASE, eyes })?.eyes, eyes);
  for (const acc of AGENT_LOOK_ACCESSORIES) assert.equal(parseAgentLook({ ...BASE, acc })?.acc, acc);
});

test('the mockup lists are all there', () => {
  assert.equal(AGENT_LOOK_SHAPES.length, 7);
  assert.equal(AGENT_LOOK_COLORS.length, 15);
  assert.equal(AGENT_LOOK_EYES.length, 10);
  assert.equal(AGENT_LOOK_ACCESSORIES.length, 31);
});

test('the accessories once drawn by the 3D mascot plugin are product ids, bare', () => {
  const former = ['whip', 'wizard', 'chef', 'crown', 'idea', 'rocket', 'chemist', 'gamer', 'photographer', 'gardener', 'musician'];
  assert.deepEqual(AGENT_LOOK_ACCESSORIES.slice(-former.length), former);
  // No pack needed: an empty catalogue still accepts them.
  for (const acc of former) assert.equal(parseAgentLook({ ...BASE, acc }, mascotCatalogOf([]))?.acc, acc);
});

test('a colour in upper case is the same fur; a missing accessory is none', () => {
  assert.deepEqual(parseAgentLook({ shape: 'hex', color: '#D4A373', eyes: 'pill' }), {
    shape: 'hex', color: '#d4a373', eyes: 'pill', acc: 'none',
  });
});

test('a fur off the palette is any #rrggbb, stored lower case', () => {
  assert.equal(parseAgentLook({ ...BASE, color: '#123456' })?.color, '#123456');
  assert.equal(parseAgentLook({ ...BASE, color: '#A1B2C3' })?.color, '#a1b2c3');
  assert.equal(readAgentLook({ ...BASE, color: '#0f0f0f' })?.color, '#0f0f0f');
  for (const color of ['#fff', '#1234567', '123456', '#gggggg', 'red']) {
    assert.throws(() => parseAgentLook({ ...BASE, color }), /look\.color: unknown value/, color);
  }
});

test('null clears', () => {
  assert.equal(parseAgentLook(null), null);
});

test('an unknown value is refused with the field and the accepted values', () => {
  assert.throws(() => parseAgentLook({ ...BASE, shape: 'star' }),
    /^Error: look\.shape: unknown value "star" \(expected one of squircle, tri, gem, round, bean, cloud, hex\)$/);
  assert.throws(() => parseAgentLook({ ...BASE, color: '#12345' }), /look\.color: unknown value "#12345" \(expected one of #d4a373.*, or any #rrggbb colour\)/);
  assert.throws(() => parseAgentLook({ ...BASE, eyes: 'glossy' }), /look\.eyes: unknown value "glossy"/);
  assert.throws(() => parseAgentLook({ ...BASE, acc: 'sword' }), /look\.acc: unknown value "sword" \(expected one of none, loupe/);
  assert.throws(() => parseAgentLook({ ...BASE, shape: 3 }), /look\.shape: unknown value number/);
  assert.throws(() => parseAgentLook({ color: '#d4a373', eyes: 'pill' }), /look\.shape: unknown value nothing/);
});

test('an extra field or a non-object is refused, not dropped', () => {
  assert.throws(() => parseAgentLook({ ...BASE, hat: 'top' }), /look has unknown field\(s\): hat/);
  assert.throws(() => parseAgentLook('round'), /look must be an object/);
  assert.throws(() => parseAgentLook([]), /look must be an object/);
  assert.throws(() => parseAgentLook(undefined), /look must be an object/);
});

test('reading back from disk never throws: a hand-edited bad look reads as none', () => {
  assert.equal(readAgentLook(undefined), null);
  assert.equal(readAgentLook({ ...BASE, shape: 'star' }), null);
  assert.deepEqual(readAgentLook(BASE), BASE);
});

test('the avatar mode takes emoji, image or mascot; null clears it', () => {
  assert.deepEqual([...AGENT_AVATAR_MODES], ['emoji', 'image', 'mascot']);
  for (const mode of AGENT_AVATAR_MODES) assert.equal(parseAgentAvatar(mode), mode);
  assert.equal(parseAgentAvatar(null), null);
});

test('an unknown avatar mode is refused with the accepted ones', () => {
  assert.throws(() => parseAgentAvatar('photo'),
    /^Error: avatar: unknown value "photo" \(expected one of emoji, image, mascot, or null to clear it\)$/);
  assert.throws(() => parseAgentAvatar('Mascot'), /avatar: unknown value "Mascot"/);
  assert.throws(() => parseAgentAvatar(1), /avatar: unknown value number/);
  assert.throws(() => parseAgentAvatar(undefined), /avatar: unknown value nothing/);
});

test('an avatar mode read back from disk never throws', () => {
  assert.equal(readAgentAvatar(undefined), null);
  assert.equal(readAgentAvatar('photo'), null);
  assert.equal(readAgentAvatar('mascot'), 'mascot');
});

// --- Mascot packs: `<pluginId>:<part>` ids declared by a plugin installed and enabled.

const PACK = mascotCatalogOf([['acme-pack', { acc: ['cap', 'scarf'], color: ['midnight'], eyes: ['sparkle'], shape: ['blob'] }]]);

test('a part a pack declares is accepted in its own field', () => {
  assert.deepEqual(parseAgentLook({ shape: 'acme-pack:blob', color: 'acme-pack:midnight', eyes: 'acme-pack:sparkle', acc: 'acme-pack:cap' }, PACK), {
    shape: 'acme-pack:blob', color: 'acme-pack:midnight', eyes: 'acme-pack:sparkle', acc: 'acme-pack:cap',
  });
  // Product ids still pass beside a pack.
  assert.deepEqual(parseAgentLook({ ...BASE, acc: 'acme-pack:scarf' }, PACK), { ...BASE, acc: 'acme-pack:scarf' });
});

test('a part no enabled pack declares is refused, named, with the parts that are', () => {
  assert.throws(() => parseAgentLook({ ...BASE, acc: 'acme-pack:sword' }, PACK),
    /^Error: look\.acc: "acme-pack:sword" is not declared for this field by an installed and enabled mascot pack \(expected one of none, .*musician, or a part an enabled mascot pack declares: acme-pack:cap, acme-pack:scarf\)$/);
  // Declared, but for another field: a fur is not an accessory.
  assert.throws(() => parseAgentLook({ ...BASE, acc: 'acme-pack:midnight' }, PACK), /look\.acc: "acme-pack:midnight" is not declared for this field/);
  // Another plugin cannot borrow a namespace it does not own.
  assert.throws(() => parseAgentLook({ ...BASE, acc: 'other-pack:cap' }, PACK), /look\.acc: "other-pack:cap" is not declared for this field/);
  // Without any pack, the refusal says nothing of packs.
  assert.throws(() => parseAgentLook({ ...BASE, acc: 'acme-pack:cap' }, mascotCatalogOf([])),
    /^Error: look\.acc: "acme-pack:cap" is not declared for this field by an installed and enabled mascot pack \(expected one of none, [^)]*musician\)$/);
  // A badly formed id is just an unknown value.
  assert.throws(() => parseAgentLook({ ...BASE, acc: 'Acme:Cap' }, PACK), /look\.acc: unknown value "Acme:Cap"/);
});

test('the live catalog is read at every write: a pack switched off is refused at once', () => {
  let packs = PACK;
  setMascotPartSource(() => packs);
  try {
    assert.equal(parseAgentLook({ ...BASE, acc: 'acme-pack:cap' })?.acc, 'acme-pack:cap');
    packs = mascotCatalogOf([]);
    assert.throws(() => parseAgentLook({ ...BASE, acc: 'acme-pack:cap' }), /not declared for this field/);
    // A broken source means no pack, never a crash of the write path.
    setMascotPartSource(() => { throw new Error('loader gone'); });
    assert.equal(mascotPartCatalog().acc.size, 0);
  } finally {
    setMascotPartSource(null);
  }
});

test('a look whose pack was removed reads back as stored, never as an error nor as no look', () => {
  setMascotPartSource(() => mascotCatalogOf([]));
  try {
    const stored = { ...BASE, acc: 'acme-pack:cap', color: 'acme-pack:midnight' };
    // The app draws the job's default for these parts; reinstalling the pack brings them back.
    assert.deepEqual(readAgentLook(stored), stored);
    assert.equal(readAgentLook({ ...BASE, acc: 'Not An Id' }), null);
  } finally {
    setMascotPartSource(null);
  }
});

test('only an active plugin adds its parts, under its manifest id', () => {
  const manifest = (id: string, mascot: PluginManifest['mascot']) => ({ id, mascot } as PluginManifest);
  const catalog = mascotPartsOf([
    { id: 'acme-pack', state: 'active', manifest: manifest('acme-pack', { acc: ['cap'] }) },
    { id: 'off-pack', state: 'disabled', manifest: manifest('off-pack', { acc: ['hat'] }) },
    { id: 'bad-pack', state: 'skipped', manifest: manifest('bad-pack', { acc: ['hat'] }) },
    { id: 'plain', state: 'active', manifest: manifest('plain', undefined) },
    { id: '@acme/broken', state: 'failed', manifest: null },
  ]);
  assert.deepEqual([...catalog.acc], ['acme-pack:cap']);
  assert.equal(catalog.color.size + catalog.eyes.size + catalog.shape.size, 0);
});

test('a part the agent already wears stays accepted in its own field while its pack is off', () => {
  const none = mascotCatalogOf([]);
  const stored = { ...BASE, acc: 'acme-pack:cap', color: 'acme-pack:midnight' };
  const keeping = catalogKeeping(none, stored);
  assert.deepEqual(parseAgentLook(stored, keeping), stored);
  assert.throws(() => parseAgentLook({ ...BASE, acc: 'acme-pack:scarf' }, keeping), /not declared for this field/, 'a new part needs a running pack');
  assert.throws(() => parseAgentLook({ ...BASE, eyes: 'acme-pack:cap' }, keeping), /look\.eyes/, 'only in the field it was worn in');
  assert.equal(catalogKeeping(none, null), none);
  assert.equal(catalogKeeping(PACK, { ...BASE, acc: 'acme-pack:cap' }), PACK, 'nothing to add: the same catalog');
});
