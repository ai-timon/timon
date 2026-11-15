/**
 * Per-tile life of the 3D head: what it does for each mascot state. The eyes
 * follow the 2D mascot's state table (`mascot-states.ts`: expression pools,
 * cadence, whether it blinks), so the same state reads the same in 2D and in
 * 3D; this file only adds the body: where the head looks, the rig clips it
 * plays (baked in Blender: hop, hop_big, startle, grab, happy), its ears and
 * its breathing. No three.js: it runs, and is tested, without WebGL.
 */
import type { MascotExpression } from '../mascot-geometry';
import { blinks, STATES as STATES_2D, type MascotState } from '../mascot-states';
import { exprIndex } from './eyes';
import type { ClipName } from './model-data';

/**
 * Where the clips sit in the baked pose rows, at what rate. Every skull is
 * rigged with the same clips on the same rows; kept here, not read from the
 * data, so the simulation runs before the model chunk arrives (a test checks
 * the two agree).
 */
export const CLIPS: Readonly<Record<ClipName, { row: number; frames: number }>> = {
  hop: { row: 1, frames: 21 },
  hop_big: { row: 22, frames: 21 },
  startle: { row: 43, frames: 15 },
  grab: { row: 58, frames: 25 },
  happy: { row: 83, frames: 25 },
};
export const CLIP_FPS = 30;

/** `pointer` follows the pointer, `glance` looks aside then the other side, `scan` sweeps; a triple is a fixed (yaw, pitch, roll) in radians. */
export type Gaze3D = 'pointer' | 'glance' | 'scan' | readonly [number, number, number];

export type Motion3D = {
  gaze: Gaze3D;
  /** A clip played once when the state starts. */
  enter?: ClipName;
  /** A clip replayed every `every` seconds while the state lasts; `lift` is how high it carries the root. */
  loop?: { clip: 'hop' | 'hop_big'; every: readonly [number, number]; lift: number };
  /** Slow deep breathing and a dim pulsing visor (asleep). */
  breathe?: boolean;
  /** Rest angle of the ears: negative droops them. */
  ears?: number;
  /** Head roll while glancing. */
  tilt?: number;
};

/** The body for each state; the eyes come from the 2D table. */
export const MOTION: Readonly<Record<MascotState, Motion3D>> = {
  idle: { gaze: 'pointer' },
  listening: { gaze: [0, -0.28, 0] },
  thinking: { gaze: 'glance' },
  working: { gaze: [0, 0.32, 0] },
  searching: { gaze: 'scan' },
  waiting: { gaze: [0, -0.05, 0], loop: { clip: 'hop', every: [1.4, 2.2], lift: 0.07 } },
  done: { gaze: 'pointer', enter: 'happy' },
  error: { gaze: [0, 0.3, 0.12], enter: 'startle' },
  sleeping: { gaze: [0, 0.28, 0.08], breathe: true, ears: -0.35 },
  happy: { gaze: 'pointer', enter: 'happy' },
  celebrate: { gaze: 'pointer', loop: { clip: 'hop_big', every: [0.9, 1.3], lift: 0.12 } },
  confused: { gaze: 'glance', tilt: 0.22 },
  surprised: { gaze: [0, -0.2, 0], enter: 'startle' },
  sad: { gaze: [0, 0.38, 0], ears: -0.4 },
  angry: { gaze: [0, 0.1, 0] },
  love: { gaze: 'pointer', enter: 'happy' },
  shy: { gaze: [-0.6, 0.22, 0.1] },
  coding: { gaze: [0, 0.3, 0] },
};

/** Seconds of a blink (closing then opening) and of the crossfade between two expressions. */
const BLINK = 0.16;
const FADE = 0.26;

export type Sim = {
  random: () => number;
  state: MascotState | undefined;
  expr: MascotExpression;
  exprAt: number;
  blinkAt: number;
  blinkStart: number;
  /** Atlas cells crossfading, and how far along (0..1). */
  from: number;
  to: number;
  mix: number;
  /** Eye opening, 1 open, towards 0 closed. */
  blink: number;
  head: [number, number, number];
  headV: [number, number, number];
  ear: [number, number];
  earV: [number, number];
  twitchAt: number;
  yaw: number;
  pitch: number;
  roll: number;
  squash: number;
  squashV: number;
  breath: number;
  /** Root height above the ground, and its velocity (the fur droops behind it). */
  y: number;
  vel: [number, number];
  clip: ClipName | null;
  clipT: number;
  /** Fractional pose row the rig shows, 0 = rest. */
  row: number;
  loopAt: number;
  glanceSide: number;
  glanceAt: number;
  t: number;
  phase: number;
  breathP: number;
  glow: number;
};

/** A fresh head. `random` is injectable so a test can replay a run. */
export function createSim(random: () => number = Math.random): Sim {
  const rand = (a: number, b: number): number => a + random() * (b - a);
  return {
    random,
    state: undefined, expr: 'pill', exprAt: 0, blinkAt: rand(1, 4), blinkStart: -1,
    from: 0, to: 0, mix: 0, blink: 1,
    head: [0, 0, 0], headV: [0, 0, 0], ear: [0, 0], earV: [0, 0], twitchAt: rand(2, 7),
    yaw: 0, pitch: 0, roll: 0, squash: 0, squashV: 0, breath: 0, y: 0, vel: [0, 0],
    clip: null, clipT: 0, row: 0, loopAt: 0, glanceSide: 1, glanceAt: 0,
    // Heads side by side start at different points of their idle cycles.
    t: rand(0, 50), phase: rand(0, 6.3), breathP: rand(1.8, 2.6), glow: 1,
  };
}

const rangeOf = (s: Sim, [a, b]: readonly [number, number]): number => a + s.random() * (b - a);
/** The 2D table counts in milliseconds; the simulation in seconds. */
const everyOf = (state: MascotState): readonly [number, number] => {
  const [a, b] = STATES_2D[state].every;
  return [a / 1000, b / 1000];
};
function poolExpr(s: Sim, state: MascotState, base: MascotExpression): MascotExpression {
  const pool = STATES_2D[state].pool;
  const e = pool[Math.floor(s.random() * pool.length)] ?? 'base';
  return e === 'base' ? base : e;
}
function startClip(s: Sim, name: ClipName): void { s.clip = name; s.clipT = 0; }

/** A still head: the state's first expression and posture, settled, no clip running. */
export function settle(s: Sim, state: MascotState, base: MascotExpression): void {
  const m = MOTION[state];
  const first = STATES_2D[state].pool[0] ?? 'base';
  s.state = state;
  s.expr = first === 'base' ? base : first;
  s.from = s.to = exprIndex(s.expr);
  s.mix = 0;
  s.blink = 1;
  s.blinkStart = -1;
  const g: readonly [number, number, number] = Array.isArray(m.gaze) ? m.gaze as readonly [number, number, number] : [0, 0, m.tilt ?? 0];
  s.head = [g[0] * 0.75, g[1] * 0.8, g[2]];
  s.headV = [0, 0, 0];
  s.yaw = g[0] * 0.32;
  s.pitch = g[1] * 0.25;
  s.roll = 0;
  const ear = m.ears ?? 0;
  s.ear = [ear, ear];
  s.earV = [0, 0];
  s.clip = null;
  s.row = 0;
  s.y = 0;
  s.squash = 0;
  s.breath = 0;
  s.vel = [0, 0];
  s.glow = m.breathe ? 0.6 : 1;
}

/**
 * Advances a live head by `dt` seconds. `gaze` is the pointer offset from the
 * tile centre, roughly in [-1, 1], or null when there is no pointer.
 */
export function stepSim(s: Sim, dt: number, state: MascotState, base: MascotExpression, gaze: readonly [number, number] | null): void {
  const m = MOTION[state];
  s.t += dt;
  if (state !== s.state) {
    s.state = state;
    s.expr = poolExpr(s, state, base);
    s.exprAt = s.t + rangeOf(s, everyOf(state));
    if (m.enter) startClip(s, m.enter);
    s.loopAt = s.t + (m.loop ? rangeOf(s, [0.2, 0.6]) : 1e9);
    // A change of state perks the ears up.
    s.earV[0] += 4;
    s.earV[1] += 4;
  }
  if (s.t > s.exprAt) { s.expr = poolExpr(s, state, base); s.exprAt = s.t + rangeOf(s, everyOf(state)); }
  if (m.loop && !s.clip && s.t > s.loopAt) { startClip(s, m.loop.clip); s.loopAt = s.t + rangeOf(s, m.loop.every); }

  // Clip playback: the rig does the acting; the root only rises along the hop's air frames (4 to 16).
  let lift = 0;
  if (s.clip) {
    const c = CLIPS[s.clip];
    const len = c.frames - 1;
    s.clipT += dt;
    const f = s.clipT * CLIP_FPS;
    if (f >= len) { s.clip = null; s.row = 0; s.squashV -= 1.2; }
    else {
      s.row = c.row + Math.min(f, c.frames - 1.001);
      if ((s.clip === 'hop' || s.clip === 'hop_big') && f > 4 && f < 16) {
        const u = (f - 4) / 12;
        const h = m.loop?.lift ?? 0.08;
        lift = 4 * h * u * (1 - u);
      }
    }
  }
  const prevY = s.y;
  s.y = lift;
  s.vel[1] = (s.y - prevY) / Math.max(dt, 1e-3);

  // Squash spring, breathing (deeper and slower asleep).
  s.squashV += (-260 * s.squash - 10 * s.squashV) * dt;
  s.squash += s.squashV * dt;
  s.breath = (m.breathe ? 0.03 : 0.016) * Math.sin(s.t * 6.283 / (m.breathe ? s.breathP * 1.8 : s.breathP) + s.phase);

  // Eyes: a new expression crossfades from the one shown; blinks squash the eyes towards their line.
  const target = exprIndex(s.expr);
  if (target !== s.to) { s.from = s.mix > 0.5 ? s.to : s.from; s.to = target; s.mix = 0; }
  s.mix = Math.min(1, s.mix + dt / FADE);
  if (s.mix >= 1) s.from = s.to;
  s.blink = 1;
  if (STATES_2D[state].blink !== null && blinks(s.expr)) {
    if (s.blinkStart < 0 && s.t > s.blinkAt) s.blinkStart = s.t;
    if (s.blinkStart >= 0) {
      const p = (s.t - s.blinkStart) / BLINK;
      s.blink = p < 0.5 ? 1 - p * 1.9 : 0.05 + (p - 0.5) * 1.9;
      // Now and then a double blink, like the 2D mascot.
      if (p >= 1) { s.blinkStart = -1; s.blink = 1; s.blinkAt = s.t + (s.random() < 0.15 ? 0.18 : rangeOf(s, [2.5, 6])); }
    }
  }
  // Glow: a slow pulse asleep, steady otherwise.
  s.glow = m.breathe ? 0.55 + 0.25 * Math.sin(s.t * 1.7 + s.phase) : 1;

  // Where the head looks.
  let tg: readonly [number, number, number];
  if (m.gaze === 'pointer') {
    tg = gaze ? [clamp(gaze[0] * 1.2, 0.65), clamp(gaze[1] * 0.9, 0.35), 0] : [0, 0, 0];
  } else if (m.gaze === 'glance') {
    if (s.t > s.glanceAt) { s.glanceSide = -s.glanceSide; s.glanceAt = s.t + rangeOf(s, [1.4, 2.6]); }
    tg = [0.5 * s.glanceSide, -0.08, (m.tilt ?? 0.12) * s.glanceSide];
  } else if (m.gaze === 'scan') {
    tg = [0.6 * Math.sin(s.t * 2.2), 0.05, 0];
  } else tg = m.gaze;
  const hT = [tg[0] * 0.75, tg[1] * 0.8, tg[2]] as const;
  for (const j of [0, 1, 2] as const) {
    s.headV[j] += ((hT[j] - s.head[j]) * 150 - s.headV[j] * 16) * dt;
    s.head[j] += s.headV[j] * dt;
  }
  const kk = 1 - Math.exp(-dt * 6);
  s.yaw += (tg[0] * 0.32 - s.yaw) * kk;
  s.pitch += (tg[1] * 0.25 - s.pitch) * kk;
  s.roll += (0.04 * Math.sin(s.t * 0.7 + s.phase) - s.roll) * kk;

  // Ears: springy, twitch now and then, lag behind head turns, droop when sad or asleep.
  const rest = m.ears ?? 0;
  if (!m.breathe && s.t > s.twitchAt) { s.earV[s.random() < 0.5 ? 0 : 1] += rangeOf(s, [5, 9]); s.twitchAt = s.t + rangeOf(s, [2.5, 8]); }
  s.earV[0] -= s.headV[0] * dt * 30;
  s.earV[1] += s.headV[0] * dt * 30;
  for (const j of [0, 1] as const) {
    s.earV[j] += (-120 * (s.ear[j] - rest) - 7 * s.earV[j]) * dt;
    s.ear[j] += s.earV[j] * dt;
    s.ear[j] = Math.max(-0.5, Math.min(0.7, s.ear[j]));
  }
}

const clamp = (v: number, lim: number): number => Math.max(-lim, Math.min(lim, v));

export type ShellPlan = { lo: boolean; n: number; dens: number; len: number };

/** Fur shells and mesh for a tile of this many CSS pixels: a tiny avatar cannot show 22 shells anyway. */
export function shellsFor(css: number): ShellPlan {
  if (css < 36) return { lo: true, n: 6, dens: 34, len: 0.75 };
  if (css < 80) return { lo: true, n: 10, dens: 44, len: 0.85 };
  if (css < 160) return { lo: false, n: 16, dens: 56, len: 0.95 };
  return { lo: false, n: 22, dens: 70, len: 1 };
}

/** Redraws per second for a live tile of this size: small heads move less than the eye can follow anyway. */
export function fpsFor(css: number): number {
  return css < 48 ? 15 : css < 120 ? 24 : 30;
}

/** Supersampling factor: a head is rendered this many times larger, then scaled down, which smooths the fur. */
export function supersampleFor(css: number): number {
  return css < 48 ? 3 : 2;
}
