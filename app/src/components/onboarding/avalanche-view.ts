/**
 * Which way each falling 3D head faces, pure. The avalanche draws bitmaps;
 * in 3D each look is also rendered under a few head orientations
 * (`HEAD_VIEWS`), and every frame each mascot shows the one closest to where
 * it should face: towards where it flies or rolls, the way it is dragged,
 * nodding into a landing. A resting head faces front: with a handful of
 * views, following the pointer would jump from one to the next.
 *
 * Nothing here touches the physics (`avalanche.ts` stays deterministic) nor
 * allocates per frame: the state is a few typed arrays indexed by body.
 */
import { GRAVITY, type Avalanche, type AvalancheBody } from './avalanche';

/** A head orientation, in radians: positive yaw faces the viewer's right, positive pitch faces down. */
export type HeadView = { readonly yaw: number; readonly pitch: number };

export const MAX_YAW = 0.75;
export const MAX_PITCH = 0.36;

/**
 * The views pre-rendered per look. View 0 is the front: the head's own
 * bitmap, always there. Side turns come first after it: they are what a
 * mascot rolling across the screen shows most, so they are rendered first.
 */
export const HEAD_VIEWS: readonly HeadView[] = [
  { yaw: 0, pitch: 0 },
  { yaw: -0.38, pitch: 0 }, { yaw: 0.38, pitch: 0 },
  { yaw: -MAX_YAW, pitch: 0 }, { yaw: MAX_YAW, pitch: 0 },
  { yaw: 0, pitch: MAX_PITCH }, { yaw: -0.5, pitch: 0.32 }, { yaw: 0.5, pitch: 0.32 },
  { yaw: 0, pitch: -MAX_PITCH }, { yaw: -0.5, pitch: -0.32 }, { yaw: 0.5, pitch: -0.32 },
];

/** Speeds (CSS pixels a second) at which a head is turned as far as it goes. */
const FULL_YAW_SPEED = 900;
const FULL_PITCH_SPEED = 1400;
/** How fast a head turns to its aim, per second: quick, but a view never flickers from one frame to the next. */
const TURN_RATE = 10;
/** A view is kept until another is this much closer (in squared, normalised angle): no flicker at a boundary. */
const HYSTERESIS = 0.06;


/** Per body: the smoothed orientation it faces and the view it shows. */
export type HeadAims = { yaw: Float32Array; pitch: Float32Array; view: Uint8Array };

export function createHeadAims(count: number): HeadAims {
  return { yaw: new Float32Array(count), pitch: new Float32Array(count), view: new Uint8Array(count) };
}

type Aim = { yaw: number; pitch: number };

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

function aimAlong(vx: number, vy: number, out: Aim): void {
  out.yaw = clamp1(vx / FULL_YAW_SPEED) * MAX_YAW;
  out.pitch = clamp1(vy / FULL_PITCH_SPEED) * MAX_PITCH;
}

/** Where `b`'s face should point now, written into `out`. */
export function aimOf(world: Avalanche, b: AvalancheBody, out: Aim): void {
  out.yaw = 0;
  out.pitch = 0;
  if (b.state === 'fly' && b.fly) {
    aimAlong(b.fly.vx, b.fly.vy0 + GRAVITY * b.fly.t, out);
    return;
  }
  if (b.state === 'fall') {
    aimAlong(b.vx, b.vy, out);
    return;
  }
  if (b.state === 'held') {
    // Swung around: the head turns into the drag.
    if (world.drag?.body === b) aimAlong(world.drag.vx, world.drag.vy, out);
    return;
  }
  if (b.state !== 'placed') return;
  // A landing squashes the head: it nods into the heap.
  if (b.sq < 1) out.pitch = Math.min(MAX_PITCH, out.pitch + Math.min(1, (1 - b.sq) * 3) * MAX_PITCH);
}

/** The view closest to (yaw, pitch); `current` is kept unless another is clearly closer. */
export function pickView(yaw: number, pitch: number, current: number): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  let currentD = Number.POSITIVE_INFINITY;
  for (let v = 0; v < HEAD_VIEWS.length; v += 1) {
    const view = HEAD_VIEWS[v];
    if (!view) continue;
    const dy = (yaw - view.yaw) / MAX_YAW;
    const dp = (pitch - view.pitch) / MAX_PITCH;
    const d = dy * dy + dp * dp;
    if (d < bestD) { bestD = d; best = v; }
    if (v === current) currentD = d;
  }
  return currentD - bestD < HYSTERESIS ? current : best;
}

const scratch: Aim = { yaw: 0, pitch: 0 };

/**
 * Turns every head towards its aim by `dt` seconds and picks its view.
 * `still` (reduced motion): every head faces the front, nothing turns.
 */
export function updateHeadAims(world: Avalanche, aims: HeadAims, dt: number, still: boolean): void {
  const k = 1 - Math.exp(-dt * TURN_RATE);
  for (const b of world.bodies) {
    const i = b.index;
    if (i >= aims.view.length) continue;
    if (still || b.state === 'wait') {
      aims.yaw[i] = 0;
      aims.pitch[i] = 0;
      aims.view[i] = 0;
      continue;
    }
    aimOf(world, b, scratch);
    const yaw = (aims.yaw[i] ?? 0) + (scratch.yaw - (aims.yaw[i] ?? 0)) * k;
    const pitch = (aims.pitch[i] ?? 0) + (scratch.pitch - (aims.pitch[i] ?? 0)) * k;
    aims.yaw[i] = yaw;
    aims.pitch[i] = pitch;
    aims.view[i] = pickView(yaw, pitch, aims.view[i] ?? 0);
  }
}
