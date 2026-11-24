/**
 * The welcome screen's avalanche: the heaps are computed up front, every
 * mascot flies onto its own spot and the whole scene comes to rest; reduced
 * motion starts at rest; "Continue" sends everyone off screen.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SHAPES } from '../mascot/agent-look';
import { skullSize } from '../mascot/mascot-geometry';
import {
  buildAvalanche, dragTo, grab, isSettled, release, resizeAvalanche, scatter, seededRng, stepAvalanche, type Avalanche,
} from './avalanche';

const looks = SHAPES.map(skullSize);
const STEP = 1 / 125;

function run(world: Avalanche, seconds: number, until?: (w: Avalanche) => boolean): number {
  let t = 0;
  while (t < seconds) {
    stepAvalanche(world, STEP);
    t += STEP;
    if (until?.(world)) break;
  }
  return t;
}

for (const [width, height, seed] of [[1280, 800, 1], [1920, 1080, 7], [900, 640, 42]] as const) {
  test(`${width}×${height}: every mascot lands on its own spot and the scene comes to rest`, () => {
    const world = buildAvalanche({ width, height, looks, rng: seededRng(seed) });
    assert.ok(world.bodies.length >= 32, 'at least sixteen per heap');
    assert.ok(world.bodies.every((b) => b.state === 'wait'), 'nobody on screen before the first frame');
    const slots = world.bodies.map((b) => ({ ...b.slot }));
    const elapsed = run(world, 20, (w) => isSettled(w));
    assert.ok(isSettled(world), `settled after ${elapsed.toFixed(1)} s`);
    assert.ok(elapsed < 12, `the avalanche is over in ${elapsed.toFixed(1)} s`);
    world.bodies.forEach((b, i) => {
      assert.equal(b.x, slots[i]?.x, `body ${i} x`);
      assert.equal(b.y, slots[i]?.y, `body ${i} y`);
    });
    // Two heaps, one against each edge, the middle left clear for the title.
    for (const b of world.bodies) {
      assert.ok(b.x >= 0 && b.x <= width, 'inside the screen');
      assert.ok(b.y + b.vb <= world.floorY + 1e-6, 'nobody sinks through the floor');
      assert.equal(b.side < 0 ? b.x < width / 2 : b.x > width / 2, true, 'each heap stays on its side');
    }
    const ys = world.bodies.map((b) => b.y);
    assert.ok(Math.min(...ys) < height * 0.85, 'the heaps rise above the floor');
  });
}

test('every mascot rests on what was computed beneath it, never on a later arrival', () => {
  const world = buildAvalanche({ width: 1280, height: 800, looks, rng: seededRng(3) });
  const index = new Map(world.bodies.map((b, i) => [b, i]));
  for (const b of world.bodies) {
    for (const s of b.sup) assert.ok((index.get(s) ?? Infinity) < (index.get(b) ?? -1), 'support built first');
  }
});

test('reduced motion: everything starts on its spot, already still', () => {
  const world = buildAvalanche({ width: 1280, height: 800, looks, rng: seededRng(5), still: true });
  assert.ok(isSettled(world));
  run(world, 1);
  assert.ok(isSettled(world));
});

test('a mascot can be picked up and thrown, and lands somewhere again', () => {
  const world = buildAvalanche({ width: 1280, height: 800, looks, rng: seededRng(9), still: true });
  const top = world.bodies.reduce((m, b) => (b.y < m.y ? b : m));
  assert.equal(grab(world, top.x, top.y, 0), true);
  assert.equal(top.state, 'held');
  dragTo(world, top.x + 200, top.y - 100, 50);
  run(world, 0.2);
  release(world);
  run(world, 10, (w) => isSettled(w, 1e-2));
  assert.equal(top.state, 'placed');
  assert.ok(isSettled(world, 1e-2), 'the heap settles again');
  assert.equal(grab(world, 640, 20, 0), false, 'nothing to catch in the empty sky');
});

test('a resize lays the heaps out again inside the new frame, already at rest', () => {
  const world = buildAvalanche({ width: 1920, height: 1080, looks, rng: seededRng(13) });
  run(world, 2);
  assert.equal(resizeAvalanche(world, 1920, 1080, looks), world, 'same size: the scene goes on');
  for (const [width, height] of [[900, 640], [640, 900], [1280, 720]] as const) {
    const resized = resizeAvalanche(world, width, height, looks);
    assert.equal(resized.width, width);
    assert.equal(resized.height, height);
    assert.ok(isSettled(resized), `${width}×${height}: already still`);
    for (const b of resized.bodies) {
      assert.ok(b.x - b.a >= -1e-6 && b.x + b.a <= width + 1e-6, `${width}×${height}: x ${b.x.toFixed(0)} inside the frame`);
      assert.ok(b.y + b.vb <= resized.floorY + 1e-6 && resized.floorY <= height, `${width}×${height}: on the floor`);
    }
  }
  scatter(world);
  assert.equal(resizeAvalanche(world, 900, 640, looks), world, 'a scattered scene is left to fly out');
});

test('"Continue" flings every mascot off screen', () => {
  const world = buildAvalanche({ width: 1280, height: 800, looks, rng: seededRng(11) });
  run(world, 1.2);
  scatter(world);
  run(world, 3);
  for (const b of world.bodies) {
    const gone = b.state === 'wait' || b.y - b.vb > world.height || b.x + b.va < 0 || b.x - b.va > world.width;
    assert.ok(gone, `body at ${b.x.toFixed(0)},${b.y.toFixed(0)} in state ${b.state} left the screen`);
  }
});
