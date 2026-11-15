import assert from 'node:assert/strict';
import test from 'node:test';
import { ACC, isMascotAccessory } from '../agent-look';
import { decodeArray, decodeFloats, loadModelData } from './model-data';
import { CENTER_Y, FRAME, MAX_PIECES, PLACES, piecesFor, placePiece, skullLift, skullMetrics, skullScale, standsUp, UNIT, type Piece, type SkullMetrics } from './place';

const EXTRA = ['whip', 'wizard', 'chef', 'crown', 'idea', 'rocket', 'chemist', 'gamer', 'photographer', 'gardener', 'musician'];

test('every product accessory and the eleven new jobs have a placement, within the piece budget', () => {
  for (const acc of ACC) if (acc !== 'none') assert.ok(PLACES[acc]?.length, acc);
  for (const acc of EXTRA) assert.ok(PLACES[acc]?.length, acc);
  for (const [acc, list] of Object.entries(PLACES)) assert.ok(list.length <= MAX_PIECES, `${acc}: ${list.length} pieces`);
  // Ids are the look's bare ids, never a plugin's prefixed ones.
  for (const acc of Object.keys(PLACES)) assert.ok(!acc.includes(':'), acc);
});

test('only an accessory the product lists know is drawn', () => {
  assert.equal(piecesFor('coffee').length, 4);
  assert.equal(piecesFor('none').length, 0);
  assert.equal(piecesFor('some-pack:anvil').length, 0);
  assert.equal(piecesFor('toString').length, 0);
  // A new job draws once its 2D drawing joins the lists, not before.
  for (const acc of EXTRA) assert.equal(piecesFor(acc).length > 0, isMascotAccessory(acc), acc);
});

test('the camera steps back for a piece above the head only', () => {
  assert.equal(standsUp(piecesFor('hammer')), true);
  assert.equal(standsUp(piecesFor('calculator')), false);
  assert.equal(standsUp([]), false);
});

/** A box skull: half width `hw`, height `h`, front at `fz`. */
function boxSkull(hw: number, h: number, fz: number): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i <= 20; i += 1) {
    const y = (i / 20) * h;
    pts.push(hw, y, 0, -hw, y, 0, 0, y, fz);
  }
  return new Float32Array(pts);
}
function metrics(over: Partial<SkullMetrics> = {}): SkullMetrics {
  const positions = boxSkull(0.6, 0.9, 0.5);
  const sk = skullMetrics({ positions, ears: new Float32Array(positions.length / 3), height: 0.9, headY: 0.44, earPivot: [0.47, 0.55, -0.04], k: 1 });
  return { ...sk, ...over };
}

test('skull metrics read the surface and leave the ears out', () => {
  const positions = boxSkull(0.6, 0.9, 0.5);
  // An ear vertex sticking far out must not widen the hat.
  const withEar = new Float32Array([...positions, 2, 0.6, 3]);
  const ears = new Float32Array(withEar.length / 3);
  ears[ears.length - 1] = 1;
  const sk = skullMetrics({ positions: withEar, ears, height: 0.9, headY: 0.44, earPivot: [0.47, 0.55, -0.04], k: 1 });
  assert.ok(Math.abs(sk.frontZ - 0.5) < 1e-6);
  assert.ok(Math.abs(sk.midHW - 0.6) < 1e-6);
  assert.ok(Math.abs(sk.botHW - 0.6) < 1e-6);
  assert.ok(Math.abs(sk.hwAt(0.5) - 0.6) < 1e-6);
  assert.ok(Math.abs(sk.fzAt(0.75) - 0.5) < 1e-6);
  assert.ok(Math.abs(sk.hwAt(-1) - 0.6) < 1e-6 && Math.abs(sk.hwAt(2) - 0.6) < 1e-6, 'clamped');
});

test('a hat fits the skull at its brim height', () => {
  const sk = metrics();
  const p = placePiece({ m: 'hardhat', at: 'hat', f: 0.8 }, sk, 0, 0);
  assert.ok(Math.abs(p.y - 0.8 * 0.9) < 1e-9);
  assert.ok(Math.abs(p.sx - (0.6 + 0.085) / 10) < 1e-6);
  assert.ok(Math.abs(p.sz - (0.5 + 0.085) / 10) < 1e-6);
  assert.equal(p.follow, 'head');
});

test('glasses and the loupe keep the visor\'s size on every skull', () => {
  // The visor is one size on every skull: the skull scale `k` is undone, so the piece's on-screen size (scale x k) is constant.
  const glasses: Piece = { m: 'glasses', at: 'face', u: 1.1 };
  const big = placePiece(glasses, metrics({ k: 1 }), 0, 0);
  const small = placePiece(glasses, metrics({ k: 0.8 }), 0, 0);
  assert.ok(Math.abs(big.sx * 1 - small.sx * 0.8) < 1e-12);
  assert.ok(Math.abs(big.sx - UNIT * 1.1) < 1e-12);
  const loupe: Piece = { m: 'loupe', at: 'eye', u: 1.3 };
  const a = placePiece(loupe, metrics({ k: 1 }), 0, 0);
  const b = placePiece(loupe, metrics({ k: 0.8 }), 0, 0);
  assert.ok(Math.abs((a.x - 0.012) * 1 - (b.x - 0.012) * 0.8) < 1e-12, 'held before the same visor eye');
});

test('a ground piece stands on the ground, a flank piece leans like its drawing unless rotated', () => {
  const sk = metrics();
  const g = placePiece({ m: 'coffee', at: 'ground', u: 1.6 }, sk, 0, -12);
  assert.ok(Math.abs(g.y - 12 * UNIT * 1.6) < 1e-12);
  assert.equal(g.follow, 'ground');
  const flank = placePiece({ m: 'calendar', at: 'flank', u: 1.6 }, sk, -8, 0);
  assert.ok(Math.abs(flank.roll - (8 * Math.PI) / 180) < 1e-12);
  assert.equal(flank.follow, 'body');
  const rotated = placePiece({ m: 'calendar', at: 'flank', rot: [0, 0, 0.3] }, sk, -8, 0);
  assert.equal(rotated.roll, 0.3);
});

test('cups sit on both ears, mirrored; a nudge moves a piece', () => {
  const sk = metrics();
  const l = placePiece({ m: 'cup', at: 'cupL' }, sk, 0, 0);
  const r = placePiece({ m: 'cup', at: 'cupR' }, sk, 0, 0);
  assert.equal(l.x, -r.x);
  assert.equal(l.yaw, -r.yaw);
  const base = placePiece({ m: 'whip', at: 'hand' }, sk, 0, 0);
  const nudged = placePiece({ m: 'whip', at: 'hand', off: [-0.09, 0.02, 0.02] }, sk, 0, 0);
  assert.ok(Math.abs(nudged.x - (base.x - 0.09)) < 1e-12);
});

test('every real skull fits the tile and is centred in it', async () => {
  const D = await loadModelData();
  for (const [name, s] of Object.entries(D.shapes)) {
    const k = skullScale(s.halfWidth, s.height);
    assert.ok(k > 0 && k <= 1, `${name}: k ${k}`);
    assert.ok(2 * s.halfWidth * k <= 0.84 * FRAME + 1e-9 && s.height * k <= 0.8 * FRAME + 1e-9, `${name} inside the frame`);
    const lift = skullLift(k, s.height);
    assert.ok(Math.abs(lift + k * s.height * 0.52 - CENTER_Y) < 1e-9);
    const sk = skullMetrics({ positions: decodeFloats(s.body.pos), ears: decodeFloats(s.body.ear), height: s.height, headY: s.headPivot, earPivot: s.earPivot.L, k });
    assert.ok(sk.frontZ > 0.2 && sk.midHW > 0.2 && sk.botHW > 0.1, `${name}: surface measured`);
    assert.ok(sk.hwAt(0.5) <= s.halfWidth + 1e-6, `${name}: no wider than the skull`);
  }
});

test('every accessory piece a placement names exists, with a colour per vertex', async () => {
  const D = await loadModelData();
  const meshes = new Set(Object.values(PLACES).flatMap((list) => list.map((p) => p.m)));
  for (const m of meshes) {
    const a = D.accessories[m];
    assert.ok(a, `mesh ${m} is in the data`);
    const n = decodeArray(a.pos).length / 3;
    assert.equal(Buffer.from(a.col, 'base64').length, n * 4, `${m}: RGBA per vertex`);
    assert.ok(Math.max(...decodeArray(a.idx)) < n, `${m}: indices`);
  }
});

