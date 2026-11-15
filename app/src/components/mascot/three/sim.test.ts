import assert from 'node:assert/strict';
import test from 'node:test';
import { MASCOT_STATES, STATES, type MascotState } from '../mascot-states';
import { exprIndex } from './eyes';
import { loadModelData } from './model-data';
import { CLIP_FPS, CLIPS, createSim, fpsFor, MOTION, settle, shellsFor, stepSim, supersampleFor, type Sim } from './sim';

/** A seeded generator, so a run replays. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DT = 1 / 60;
function run(s: Sim, state: MascotState, seconds: number, each?: (s: Sim) => void): void {
  for (let i = 0; i < Math.round(seconds / DT); i += 1) { stepSim(s, DT, state, 'pill', null); each?.(s); }
}
const poolOf = (state: MascotState, base = 'pill'): string[] => STATES[state].pool.map((e) => (e === 'base' ? base : e));

test('every state of the 2D mascot has a 3D motion', () => {
  for (const state of MASCOT_STATES) assert.ok(MOTION[state], state);
  assert.equal(Object.keys(MOTION).length, MASCOT_STATES.length);
});

test('a still head shows the state\'s first expression and posture', () => {
  const s = createSim(seeded(1));
  settle(s, 'sleeping', 'heart');
  assert.equal(s.expr, 'sleepy');
  assert.equal(s.from, exprIndex('sleepy'));
  assert.equal(s.to, s.from);
  assert.equal(s.glow, 0.6);
  assert.deepEqual(s.ear, [-0.35, -0.35]);
  assert.equal(s.clip, null);
  assert.equal(s.row, 0);
  // The state looks down: pitch follows its gaze.
  assert.ok(s.head[1] > 0);

  settle(s, 'idle', 'heart');
  assert.equal(s.expr, 'heart', 'idle starts on the look\'s own eyes');
  assert.equal(s.glow, 1);
});

test('entering a state plays its clip once, then the rig rests', () => {
  const s = createSim(seeded(2));
  settle(s, 'idle', 'pill');
  stepSim(s, DT, 'done', 'pill', null);
  assert.equal(s.clip, 'happy');
  const c = CLIPS.happy;
  let maxRow = 0;
  run(s, 'done', (c.frames / CLIP_FPS) * 0.9, (x) => { maxRow = Math.max(maxRow, x.row); });
  assert.ok(maxRow > c.row && maxRow < c.row + c.frames, `row ${maxRow} within the happy clip`);
  run(s, 'done', 1);
  assert.equal(s.clip, null);
  assert.equal(s.row, 0);
});

test('waiting keeps hopping: the root leaves the ground again and again', () => {
  const s = createSim(seeded(3));
  settle(s, 'waiting', 'pill');
  let hops = 0;
  let air = false;
  run(s, 'waiting', 8, (x) => {
    if (x.y > 0.01 && !air) { hops += 1; air = true; }
    if (x.y === 0) air = false;
  });
  assert.ok(hops >= 3, `${hops} hops in eight seconds`);
  // A state without a loop never leaves the ground.
  const still = createSim(seeded(4));
  let maxY = 0;
  run(still, 'thinking', 8, (x) => { maxY = Math.max(maxY, x.y); });
  assert.equal(maxY, 0);
});

test('expressions are drawn from the state\'s pool, and morph from one to the next', () => {
  for (const state of ['thinking', 'searching', 'celebrate', 'idle'] as const) {
    const s = createSim(seeded(5));
    const pool = poolOf(state);
    const seen = new Set<string>();
    run(s, state, 30, (x) => { seen.add(x.expr); assert.ok(pool.includes(x.expr), `${state}: ${x.expr}`); assert.ok(x.mix >= 0 && x.mix <= 1); });
    assert.ok(seen.size >= Math.min(2, new Set(pool).size), `${state} changes expression`);
  }
});

test('states that never blink keep their eyes open; others blink', () => {
  for (const state of MASCOT_STATES.filter((st) => STATES[st].blink === null)) {
    const s = createSim(seeded(6));
    run(s, state, 12, (x) => assert.equal(x.blink, 1, state));
  }
  const s = createSim(seeded(7));
  let closed = 1;
  run(s, 'listening', 12, (x) => { closed = Math.min(closed, x.blink); });
  assert.ok(closed < 0.3, `listening blinks (${closed})`);
});

test('sleeping breathes and pulses its visor, and never twitches its ears up', () => {
  const s = createSim(seeded(8));
  settle(s, 'sleeping', 'pill');
  let lo = 1;
  let hi = 0;
  run(s, 'sleeping', 10, (x) => { lo = Math.min(lo, x.glow); hi = Math.max(hi, x.glow); assert.ok(x.ear[0] < 0.2); });
  assert.ok(lo < 0.4 && hi > 0.7, `glow ${lo}..${hi}`);
});

test('the head follows the pointer, within bounds', () => {
  const s = createSim(seeded(9));
  settle(s, 'idle', 'pill');
  for (let i = 0; i < 240; i += 1) stepSim(s, DT, 'idle', 'pill', [5, -5]);
  assert.ok(s.head[0] > 0.4 && s.head[0] <= 0.65 * 0.75 + 0.02, `yaw ${s.head[0]}`);
  assert.ok(s.head[1] < -0.2 && s.head[1] >= -0.35 * 0.8 - 0.02, `pitch ${s.head[1]}`);
});

test('the same seed replays the same run', () => {
  const a = createSim(seeded(10));
  const b = createSim(seeded(10));
  run(a, 'celebrate', 5);
  run(b, 'celebrate', 5);
  assert.deepEqual({ ...a, random: null }, { ...b, random: null });
});

test('cost follows the size: shells, mesh, frame rate, supersampling', () => {
  assert.deepEqual(shellsFor(24), { lo: true, n: 6, dens: 34, len: 0.75 });
  assert.equal(shellsFor(40).lo, true);
  assert.equal(shellsFor(96).lo, false);
  assert.equal(shellsFor(200).n, 22);
  assert.ok(shellsFor(200).n <= 22, 'never more shells than instances');
  assert.equal(fpsFor(24), 15);
  assert.equal(fpsFor(96), 24);
  assert.equal(fpsFor(160), 30);
  assert.equal(supersampleFor(24), 3);
  assert.equal(supersampleFor(96), 2);
});

test('the simulation clip table is the one every skull was rigged with', async () => {
  const D = await loadModelData();
  for (const [name, s] of Object.entries(D.shapes)) {
    assert.deepEqual(s.anim.clips, CLIPS, `${name}: clips`);
    assert.equal(s.anim.fps, CLIP_FPS, `${name}: fps`);
    for (const c of Object.values(CLIPS)) assert.ok(c.row + c.frames <= s.anim.rows, `${name}: clip inside the pose rows`);
  }
});

