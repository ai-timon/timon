/**
 * Which way the avalanche's 3D heads face: along their flight, into the drag,
 * nodding on a landing, facing front once in the heap; always the
 * front under reduced motion.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SHAPES } from '../mascot/agent-look';
import { skullSize } from '../mascot/mascot-geometry';
import { buildAvalanche, dragTo, grab, isSettled, scatter, seededRng, stepAvalanche, type Avalanche, type AvalancheBody } from './avalanche';
import { aimOf, createHeadAims, HEAD_VIEWS, MAX_PITCH, MAX_YAW, pickView, updateHeadAims } from './avalanche-view';

const looks = SHAPES.map(skullSize);
const STEP = 1 / 125;

function settled(seed = 3): Avalanche {
  const world = buildAvalanche({ width: 1280, height: 800, looks, rng: seededRng(seed), still: true });
  for (const b of world.bodies) { b.sq = 1; b.sqv = 0; }
  return world;
}

function aim(world: Avalanche, b: AvalancheBody): { yaw: number; pitch: number } {
  const out = { yaw: 0, pitch: 0 };
  aimOf(world, b, out);
  return out;
}

const first = (world: Avalanche): AvalancheBody => {
  const b = world.bodies[0];
  assert.ok(b);
  return b;
};

test('view 0 is the front, and the views stay within the turn limits', () => {
  assert.deepEqual(HEAD_VIEWS[0], { yaw: 0, pitch: 0 });
  for (const v of HEAD_VIEWS) {
    assert.ok(Math.abs(v.yaw) <= MAX_YAW && Math.abs(v.pitch) <= MAX_PITCH);
  }
});

test('pickView takes the closest view, and keeps the current one near a boundary', () => {
  assert.equal(pickView(0, 0, 0), 0);
  const right = pickView(MAX_YAW, 0, 0);
  assert.equal(HEAD_VIEWS[right]?.yaw, MAX_YAW);
  const down = pickView(0, MAX_PITCH, 0);
  assert.equal(HEAD_VIEWS[down]?.pitch, MAX_PITCH);
  // Halfway between the front and the first turn: whichever was shown stays.
  const mid = (HEAD_VIEWS[2]?.yaw ?? 0) / 2;
  assert.equal(pickView(mid, 0, 0), 0);
  assert.equal(pickView(mid, 0, 2), 2);
});

test('a falling head faces where it goes', () => {
  const world = settled();
  const b = first(world);
  b.state = 'fall';
  b.vx = 800;
  b.vy = 900;
  const a = aim(world, b);
  assert.ok(a.yaw > 0.5, 'turned to the right');
  assert.ok(a.pitch > 0.1, 'looking down');
  b.vx = -800;
  b.vy = -900;
  const up = aim(world, b);
  assert.ok(up.yaw < -0.5 && up.pitch < -0.1, 'up and to the left');
});

test('a flying head faces along its arc', () => {
  const world = buildAvalanche({ width: 1280, height: 800, looks, rng: seededRng(5) });
  const b = world.bodies.find((o) => o.mode === 'jump' && o.fly);
  assert.ok(b?.fly);
  b.state = 'fly';
  b.fly.t = 0;
  const start = aim(world, b);
  assert.ok(start.pitch < 0, 'leaps upwards first');
  assert.equal(Math.sign(start.yaw), Math.sign(b.fly.vx), 'towards the heap');
  b.fly.t = b.fly.T;
  assert.ok(aim(world, b).pitch > 0, 'comes down looking down');
});

test('a dragged head turns into the drag', () => {
  const world = settled();
  // Pick the topmost head, so nothing it holds up matters.
  const b = world.bodies.reduce((m, o) => (o.y < m.y ? o : m));
  assert.ok(grab(world, b.x, b.y, 0));
  dragTo(world, b.x - 30, b.y, 16);
  dragTo(world, b.x - 60, b.y, 32);
  const held = world.drag?.body;
  assert.ok(held);
  assert.ok(aim(world, held).yaw < 0, 'turned left with the pointer');
});

test('a landing nods the head into the heap', () => {
  const world = settled();
  const b = first(world);
  b.sq = 0.8;
  assert.ok(aim(world, b).pitch > 0);
});

test('reduced motion: every head shows the front', () => {
  const world = settled();
  const aims = createHeadAims(world.bodies.length);
  scatter(world);
  for (let k = 0; k < 30; k += 1) {
    stepAvalanche(world, STEP);
    updateHeadAims(world, aims, STEP, true);
  }
  assert.ok(aims.view.every((v) => v === 0));
});

test('during the avalanche heads turn, at rest they face front, and the run replays exactly', () => {
  const play = (): { turned: number; views: number[] } => {
    const world = buildAvalanche({ width: 1280, height: 800, looks, rng: seededRng(11) });
    const aims = createHeadAims(world.bodies.length);
    let turned = 0;
    for (let t = 0; t < 20 && !isSettled(world); t += STEP) {
      stepAvalanche(world, STEP);
      updateHeadAims(world, aims, STEP, false);
      for (const v of aims.view) if (v !== 0) turned += 1;
    }
    assert.ok(isSettled(world));
    // A second of rest: every head comes back to the front.
    for (let k = 0; k < 125; k += 1) updateHeadAims(world, aims, STEP, false);
    return { turned, views: Array.from(aims.view) };
  };
  const a = play();
  assert.ok(a.turned > 0, 'some heads turned in flight');
  assert.ok(a.views.every((v) => v === 0), 'all face front at rest');
  assert.deepEqual(play(), a);
});
