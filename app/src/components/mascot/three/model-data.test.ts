import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeArray, decodeFloats, isModelData, loadModelData, shapeData, type ModelData, type PackedArray } from './model-data';

const b64 = (bytes: ArrayBufferLike): string => Buffer.from(new Uint8Array(bytes)).toString('base64');

test('quantised arrays come back to their range, component by component', () => {
  const q = new Uint16Array([0, 65535, 32768, 65535, 0, 0]);
  const out = decodeArray({ k: 'q16', n: 2, lo: [-1, 10], hi: [1, 20], d: b64(q.buffer) });
  assert.ok(out instanceof Float32Array);
  const expect = [-1, 20, 0, 20, -1, 10];
  expect.forEach((v, i) => assert.ok(Math.abs((out[i] ?? NaN) - v) < 1e-4, `item ${i}: ${out[i]} vs ${v}`));

  const q8 = decodeArray({ k: 'q8', n: 1, lo: [0], hi: [2], d: b64(new Uint8Array([0, 255, 51]).buffer) });
  assert.deepEqual([...q8].map((v) => +v.toFixed(3)), [0, 2, 0.4]);
});

test('raw arrays keep their integers: indices stay 16-bit, bone ids become floats', () => {
  const idx = decodeArray({ k: 'u16', d: b64(new Uint16Array([0, 1, 65535]).buffer) });
  assert.ok(idx instanceof Uint16Array);
  assert.deepEqual([...idx], [0, 1, 65535]);
  const bones = decodeArray({ k: 'u8', d: b64(new Uint8Array([0, 5, 255]).buffer) });
  assert.ok(bones instanceof Float32Array);
  assert.deepEqual([...bones], [0, 5, 255]);
  assert.ok(decodeFloats({ k: 'u16', d: b64(new Uint16Array([7]).buffer) }) instanceof Float32Array);
});

test('the structural check refuses what is not model data', () => {
  assert.equal(isModelData(null), false);
  assert.equal(isModelData({ shapes: {} , accessories: {} }), false);
  assert.equal(isModelData({ shapes: { squircle: { height: 1, anim: {}, body: {} } }, accessories: {} }), true);
});

let cached: ModelData | null = null;
async function data(): Promise<ModelData> {
  cached ??= await loadModelData();
  return cached;
}

const count = (a: PackedArray, per: number): number => decodeArray(a).length / per;

test('every skull decodes into consistent meshes, rig poses and visor', async () => {
  const D = await data();
  assert.deepEqual(Object.keys(D.shapes).sort(), ['bean', 'cloud', 'gem', 'hex', 'round', 'squircle', 'tri']);
  for (const [name, s] of Object.entries(D.shapes)) {
    for (const body of [s.body, s.bodyLo]) {
      const n = count(body.pos, 3);
      assert.ok(Number.isInteger(n) && n > 100, `${name}: ${n} vertices`);
      assert.equal(count(body.nrm, 3), n, `${name}: normals`);
      assert.equal(count(body.fur, 1), n, `${name}: fur`);
      assert.equal(count(body.ear, 1), n, `${name}: ears`);
      assert.equal(count(body.j, 2), n, `${name}: bones`);
      assert.equal(count(body.w, 2), n, `${name}: weights`);
      const idx = decodeArray(body.idx);
      assert.equal(idx.length % 3, 0, `${name}: triangles`);
      assert.ok(Math.max(...idx) < n, `${name}: indices in range`);
      // Ears are tagged +1 / -1, the rest 0.
      assert.ok([...decodeFloats(body.ear)].every((e) => [-1, 0, 1].includes(Math.round(e))), `${name}: ear sides`);
    }
    const vn = count(s.visor.pos, 3);
    assert.equal(count(s.visor.uv, 2), vn, `${name}: visor uv`);
    assert.ok(Math.max(...decodeArray(s.visor.idx)) < vn, `${name}: visor indices`);
    // Half floats: 2 bytes each, 4 RGBA texels per bone and row.
    assert.equal(Buffer.from(s.anim.data, 'base64').length, s.anim.bones * 4 * 4 * s.anim.rows * 2, `${name}: pose rows`);
    assert.ok(s.height > 0 && s.headPivot > 0 && s.headPivot < s.height, `${name}: head pivot inside the skull`);
  }
});

test('an unknown skull (a pack\'s) draws the classic one', async () => {
  const D = await data();
  assert.equal(shapeData(D, 'some-pack:blob'), D.shapes.squircle);
  assert.equal(shapeData(D, 'toString'), D.shapes.squircle);
  assert.equal(shapeData(D, 'gem'), D.shapes.gem);
});
