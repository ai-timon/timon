import assert from 'node:assert/strict';
import test from 'node:test';
import { atlasDistance, baseExpression, buildEyeAtlas, COLS, EXPRESSIONS, exprIndex, polyDistance, ROWS } from './eyes';

const atlas = buildEyeAtlas();

/** Signed distance at a point of an expression's cell, in visor units: x in [-aspect/2, aspect/2], y down in [-0.5, 0.5]. */
function distanceAt(name: string, x: number, y: number): number {
  const i = exprIndex(name);
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const aspect = atlas.cellW / atlas.cellH;
  const px = Math.min(atlas.cellW - 1, Math.max(0, Math.floor((x / aspect + 0.5) * atlas.cellW)));
  const py = Math.min(atlas.cellH - 1, Math.max(0, Math.floor((y + 0.5) * atlas.cellH)));
  const Y = row * atlas.cellH + py;
  return atlasDistance(atlas.data[(atlas.h - 1 - Y) * atlas.w + col * atlas.cellW + px] ?? 255);
}

// Eye centres in visor heights: ±0.30 from the middle, a little above it.
const LEFT = [-0.3, -0.02] as const;
const MIDDLE = [0, -0.02] as const;

test('one cell per expression, in the visor\'s aspect', () => {
  assert.equal(EXPRESSIONS.length, COLS * ROWS);
  assert.equal(atlas.w, atlas.cellW * COLS);
  assert.equal(atlas.h, atlas.cellH * ROWS);
  assert.equal(atlas.data.length, atlas.w * atlas.h);
  assert.ok(Math.abs(atlas.cellW / atlas.cellH - 0.74 / 0.42) < 0.02);
});

test('every expression lights something, and the pill lights its two eyes only', () => {
  for (const name of EXPRESSIONS) {
    let inside = 0;
    for (let y = -0.4; y <= 0.4; y += 0.02) for (let x = -0.8; x <= 0.8; x += 0.02) if (distanceAt(name, x, y) < 0) inside += 1;
    assert.ok(inside > 4, `${name} lights ${inside} samples`);
  }
  assert.ok(distanceAt('pill', ...LEFT) < 0, 'inside the left eye');
  assert.ok(distanceAt('pill', 0.3, -0.02) < 0, 'inside the right eye');
  assert.ok(distanceAt('pill', ...MIDDLE) > 0.1, 'nothing between them');
});

test('a middle glyph is drawn only by the expressions that have one', () => {
  // `dots` and `code` carry a third glyph; the others leave the middle dark (no glowing dot from the empty slot).
  assert.ok(distanceAt('dots', ...MIDDLE) < 0);
  assert.ok(distanceAt('code', ...MIDDLE) < 0);
  for (const name of ['pill', 'big', 'happy', 'heart', 'sleepy']) assert.ok(distanceAt(name, ...MIDDLE) > 0.1, `${name} middle`);
});

test('distances outside a glyph grow with the distance', () => {
  const near = distanceAt('pill', -0.3 + 0.08, -0.02);
  const far = distanceAt('pill', -0.3 + 0.16, -0.02);
  assert.ok(near > 0 && far > near, `${near} then ${far}`);
});

test('an unknown expression or a pack\'s eyes show the pill', () => {
  assert.equal(exprIndex('pill'), 0);
  assert.equal(exprIndex('nope'), 0);
  assert.equal(exprIndex('some-pack:eyes'), 0);
  assert.equal(exprIndex('code'), EXPRESSIONS.indexOf('code'));
  assert.equal(baseExpression('some-pack:eyes'), 'pill');
  assert.equal(baseExpression(42), 'pill');
  assert.equal(baseExpression('heart'), 'heart');
});

test('signed distance to a polygon: negative inside, edge distance outside', () => {
  const square = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  assert.ok(Math.abs(polyDistance(square, 0, 0) + 1) < 1e-9);
  assert.ok(Math.abs(polyDistance(square, 3, 0) - 2) < 1e-9);
  assert.ok(Math.abs(polyDistance(square, 2, 2) - Math.SQRT2) < 1e-9);
});
