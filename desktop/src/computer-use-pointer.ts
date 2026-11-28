/**
 * The agent's pointer, made visible: the glide of the real pointer before a click or a move.
 * Pure: no Electron, no system command.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** How long the real pointer glides to its target when nothing says otherwise. */
export const DEFAULT_POINTER_MOTION_MS = 200;
/** Longer than this, an agent's work would crawl: a value above is clamped. */
export const MAX_POINTER_MOTION_MS = 2000;
/** About one screen frame per step: smooth to the eye, and a dozen steps for the default glide. */
const STEP_MS = 16;
const MAX_STEPS = 60;
/** Closer than this (in points) the glide is not worth its time: the pointer jumps. */
const MIN_DISTANCE = 3;

export interface PointerSettings {
  /** Glide of the real pointer before click, double click and move; 0 = it jumps as before. */
  motionMs: number;
}

/** A shell preference of this computer, like `dock-icon.json`: the daemon has no say in how the pointer looks. */
export const POINTER_SETTINGS_FILE = 'computer-pointer.json';

function motionValue(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.round(number), MAX_POINTER_MOTION_MS);
}

/**
 * Environment first (`TIMON_COMPUTER_POINTER_MS`), then the file,
 * then the defaults. A value that cannot be read is ignored, never an error: the pointer is cosmetic.
 */
export function resolvePointerSettings(env: NodeJS.ProcessEnv, fileText: string | null): PointerSettings {
  let file: { motionMs?: unknown } = {};
  if (fileText) {
    try {
      const parsed: unknown = JSON.parse(fileText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) file = parsed as typeof file;
    } catch { /* a damaged file: the defaults */ }
  }
  return {
    motionMs: motionValue(env.TIMON_COMPUTER_POINTER_MS) ?? motionValue(file.motionMs) ?? DEFAULT_POINTER_MOTION_MS,
  };
}

/** Read at each action, so a change applies without restarting Timon. */
export function readPointerSettings(home: string, env: NodeJS.ProcessEnv = process.env): PointerSettings {
  let text: string | null = null;
  try { text = readFileSync(join(home, POINTER_SETTINGS_FILE), 'utf8'); } catch { /* never written */ }
  return resolvePointerSettings(env, text);
}

/** Fast first, slow at the end: the pointer settles on its target the way a hand does. */
export function easeOut(t: number): number {
  const clamped = Math.min(Math.max(t, 0), 1);
  return 1 - (1 - clamped) ** 3;
}

export interface PointerPath {
  /** The intermediate points, in the caller's unit, without the start and without the target. */
  points: Array<{ x: number; y: number }>;
  /** The pause after each intermediate point and before the target. */
  stepMs: number;
}

/**
 * The glide from one point to another in `durationMs`. Empty when there is nothing to animate (no
 * duration, or a target next to the start): the caller then moves straight to the target.
 */
export function pointerPath(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): PointerPath {
  const finite = [fromX, fromY, toX, toY, durationMs].every(Number.isFinite);
  if (!finite || durationMs <= 0 || Math.hypot(toX - fromX, toY - fromY) < MIN_DISTANCE) return { points: [], stepMs: 0 };
  const steps = Math.min(MAX_STEPS, Math.max(2, Math.round(durationMs / STEP_MS)));
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < steps; i++) {
    const k = easeOut(i / steps);
    points.push({ x: fromX + (toX - fromX) * k, y: fromY + (toY - fromY) * k });
  }
  return { points, stepMs: Math.round(durationMs / steps) };
}
