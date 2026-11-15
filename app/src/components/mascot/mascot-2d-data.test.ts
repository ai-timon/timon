/**
 * The 2D skulls generated from the 3D models (`scripts/gen-mascot-2d.mjs`):
 * all seven are there, their paths are well formed and inside the box, and
 * the visor has one size on every skull, sitting on the face.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SHAPES } from './agent-look';
import { SKULLS_2D } from './mascot-2d-data';
import { headLayout } from './mascot-geometry';

/** The coordinates of an absolute path made of one `M`, cubic `C` segments and a closing `Z`. */
function pathPoints(d: string): [number, number][] {
  assert.match(d, /^M-?[\d.]+ -?[\d.]+(C(-?[\d.]+ ){5}-?[\d.]+)+Z$/, 'M, then cubic segments, then Z');
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  assert.equal(n.length % 2, 0);
  const pts: [number, number][] = [];
  for (let i = 0; i < n.length; i += 2) pts.push([n[i]!, n[i + 1]!]);
  return pts;
}

test('the seven skulls are generated, and only them', () => {
  assert.deepEqual(Object.keys(SKULLS_2D).sort(), [...SHAPES].sort());
});

test('every outline is a closed, valid path inside the box', () => {
  for (const shape of SHAPES) {
    const S = SKULLS_2D[shape];
    for (const [part, d] of [['body', S.body], ['earL', S.earL], ['earR', S.earR]] as const) {
      const pts = pathPoints(d);
      assert.ok(pts.length > 20, `${shape}.${part}: enough points`);
      assert.ok(pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100), `${shape}.${part}: in the box`);
    }
    assert.ok(S.top < S.bottom && S.bottom <= 100 && S.top >= 0, `${shape}: a body with a height`);
    const body = pathPoints(S.body);
    const ys = body.map((p) => p[1]);
    assert.ok(Math.abs(Math.min(...ys) - S.top) < 2 && Math.abs(Math.max(...ys) - S.bottom) < 2, `${shape}: measures match the outline`);
    // The ears stand either side of the centre line, mirrored.
    assert.ok(S.ears.L[0] < 50 && S.ears.R[0] > 50, `${shape}: one ear each side`);
    assert.ok(Math.abs(50 - S.ears.L[0] - (S.ears.R[0] - 50)) < 0.3 && Math.abs(S.ears.L[1] - S.ears.R[1]) < 0.3, `${shape}: mirrored ears`);
  }
});

test('the visor has the same size on every skull, and sits on the face', () => {
  const first = SKULLS_2D.squircle.visor;
  for (const shape of SHAPES) {
    const S = SKULLS_2D[shape];
    const v = S.visor;
    assert.deepEqual([v.w, v.h, v.r], [first.w, first.h, first.r], `${shape}: one visor size`);
    assert.ok(Math.abs(v.x + v.w / 2 - 50) < 0.2, `${shape}: centred`);
    assert.ok(v.y > S.top && v.y + v.h < S.bottom, `${shape}: inside the head's height`);
    assert.ok(v.r <= v.h / 2, `${shape}: corners fit the visor`);
    // The eyes stay on the visor.
    const g = headLayout(shape).geo;
    assert.ok(g.c1 > v.x && g.c2 < v.x + v.w && g.cy > v.y && g.cy < v.y + v.h, `${shape}: eyes on the visor`);
  }
});
