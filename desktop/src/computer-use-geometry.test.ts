import assert from 'node:assert/strict';
import test from 'node:test';
import { clipToDisplay, frameTransform, imageToPoints, pointsToImage, screenshotSize } from './computer-use-geometry.js';

// A 32:9 display as reported for a Samsung G9: the case a window capture is for.
const wide = { width: 5120, height: 1440, scaleFactor: 1 };

test('a window region is sized on its own width, not the display\'s', () => {
  assert.deepEqual(screenshotSize(wide, 1024), { width: 1024, height: 288 });
  assert.deepEqual(screenshotSize(wide, 1024, { x: 1280, y: 0, width: 1280, height: 1440 }), { width: 1024, height: 1152 });
  // Never upscaled beyond the physical pixels of the region.
  assert.deepEqual(screenshotSize(wide, 4096, { x: 0, y: 0, width: 800, height: 600 }), { width: 800, height: 600 });
  assert.deepEqual(screenshotSize({ ...wide, scaleFactor: 2 }, 4096, { x: 0, y: 0, width: 800, height: 600 }), { width: 1600, height: 1200 });
});

test('a window is cut to the display, in whole points relative to it', () => {
  const display = { width: 1920, height: 1080, scaleFactor: 1.5, originX: 100, originY: 0 };
  assert.deepEqual(clipToDisplay(display, { x: 150.4, y: 10.6, width: 400, height: 300 }), { x: 50, y: 10, width: 401, height: 301 });
  assert.deepEqual(clipToDisplay(display, { x: 0, y: -40, width: 400, height: 300 }), { x: 0, y: 0, width: 300, height: 260 }, 'the part off the display is dropped');
  assert.equal(clipToDisplay(display, { x: 3000, y: 0, width: 400, height: 300 }), null, 'a window on another display');
  assert.equal(clipToDisplay(display, { x: 200, y: 200, width: 4, height: 300 }), null, 'a sliver is not a window to look at');
});

test('image pixels and points round-trip through a window frame', () => {
  const display = { width: 1920, height: 1080, scaleFactor: 1, originX: 0, originY: 0 };
  const frame = { width: 640, height: 480, region: { x: 600, y: 300, width: 320, height: 240 } };
  assert.deepEqual(imageToPoints(display, frame, 320, 240), { x: 760, y: 420 });
  assert.deepEqual(pointsToImage(display, frame, 760, 420), { x: 320, y: 240 });
  assert.deepEqual(imageToPoints(display, frame, -10, 9999), { x: 600, y: 539 }, 'clamped on the window');
  assert.deepEqual(frameTransform(display, frame), { x: 600, y: 300, sx: 2, sy: 2 });
  // Without a region the frame is the whole display, as before.
  assert.deepEqual(imageToPoints(display, { width: 960, height: 540 }, 480, 270), { x: 960, y: 540 });
});
