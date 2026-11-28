import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_POINTER_MOTION_MS, MAX_POINTER_LABEL, MAX_POINTER_MOTION_MS, easeOut, pointerLabel, pointerPath, resolvePointerSettings } from './computer-use-pointer.js';

test('ease-out starts fast and settles on the target', () => {
  assert.equal(easeOut(0), 0);
  assert.equal(easeOut(1), 1);
  assert.equal(easeOut(-1), 0);
  assert.equal(easeOut(2), 1);
  // More than half of the way in the first quarter of the time, then smaller and smaller steps.
  assert.ok(easeOut(0.25) > 0.5);
  const steps = [0.2, 0.4, 0.6, 0.8, 1].map((t, i, all) => easeOut(t) - easeOut(i === 0 ? 0 : all[i - 1]!));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i]! < steps[i - 1]!, `step ${i} is shorter than the one before`);
});

test('the default glide is about a dozen steps of a screen frame, start and target excluded', () => {
  const path = pointerPath(0, 0, 1000, 500, DEFAULT_POINTER_MOTION_MS);
  assert.equal(path.points.length, 12);
  assert.equal(path.stepMs, 15);
  // Monotonic towards the target, never past it, on the straight line.
  let last = 0;
  for (const point of path.points) {
    assert.ok(point.x > last && point.x < 1000);
    assert.ok(Math.abs(point.y - point.x / 2) < 1e-9);
    last = point.x;
  }
  // The whole glide lasts about the asked duration.
  assert.ok(Math.abs((path.points.length + 1) * path.stepMs - DEFAULT_POINTER_MOTION_MS) <= 8);
});

test('no glide without a duration, next to the target, or on a coordinate that is not a number', () => {
  for (const path of [pointerPath(0, 0, 500, 500, 0), pointerPath(0, 0, 500, 500, -5), pointerPath(10, 10, 11, 12, 200), pointerPath(Number.NaN, 0, 5, 5, 200)]) {
    assert.deepEqual(path, { points: [], stepMs: 0 });
  }
  // A very short duration still glides in two steps; a long one is capped in steps, not in time.
  assert.equal(pointerPath(0, 0, 100, 0, 5).points.length, 1);
  const long = pointerPath(0, 0, 100, 0, MAX_POINTER_MOTION_MS);
  assert.equal(long.points.length, 59);
  assert.ok(Math.abs(60 * long.stepMs - MAX_POINTER_MOTION_MS) <= 30);
});

test('settings: environment, then the file, then the default; a bad value is ignored', () => {
  assert.deepEqual(resolvePointerSettings({}, null), { motionMs: DEFAULT_POINTER_MOTION_MS, ghost: true });
  assert.deepEqual(resolvePointerSettings({}, '{"motionMs":0}'), { motionMs: 0, ghost: true });
  assert.deepEqual(resolvePointerSettings({}, '{"motionMs":350.4}'), { motionMs: 350, ghost: true });
  assert.deepEqual(resolvePointerSettings({ TIMON_COMPUTER_POINTER_MS: '80' }, '{"motionMs":0}'), { motionMs: 80, ghost: true });
  assert.deepEqual(resolvePointerSettings({ TIMON_COMPUTER_POINTER_MS: 'fast' }, '{"motionMs":120}'), { motionMs: 120, ghost: true });
  assert.deepEqual(resolvePointerSettings({}, '{"motionMs":99999}'), { motionMs: MAX_POINTER_MOTION_MS, ghost: true });
  for (const text of ['{"motionMs":-1}', '{"motionMs":"slow"}', 'not json', '[1]', 'null']) {
    assert.deepEqual(resolvePointerSettings({}, text), { motionMs: DEFAULT_POINTER_MOTION_MS, ghost: true }, text);
  }
});

test('the ghost pointer is on unless the environment or the file turns it off', () => {
  assert.equal(resolvePointerSettings({}, '{"ghost":false}').ghost, false);
  assert.equal(resolvePointerSettings({ TIMON_COMPUTER_GHOST_POINTER: '1' }, '{"ghost":false}').ghost, true);
  assert.equal(resolvePointerSettings({ TIMON_COMPUTER_GHOST_POINTER: '0' }, null).ghost, false);
  assert.equal(resolvePointerSettings({ TIMON_COMPUTER_GHOST_POINTER: 'maybe' }, '{"ghost":"no"}').ghost, true);
});

test('the pointer label is one short line of the agent\'s name, or nothing', () => {
  assert.equal(pointerLabel('designer'), 'designer');
  assert.equal(pointerLabel('  two\nlines\u202e\u0000 '), 'two lines');
  assert.equal([...pointerLabel('é'.repeat(200))!].length, MAX_POINTER_LABEL); // french-ok: a non-ASCII name is cut by code point
  for (const nothing of [undefined, null, 42, '', ' \t ', '\u200e']) assert.equal(pointerLabel(nothing), undefined, String(nothing));
});
