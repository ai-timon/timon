/**
 * The eyes of the 3D visor: the 2D mascot's own glyphs (`mascot-geometry.ts`),
 * baked into one atlas of signed distance fields. Taking the outlines from the
 * 2D module, rather than a copy, keeps a state showing the same eyes in 2D and
 * in 3D.
 *
 * The visor samples the atlas in the convention of the Blender model: one
 * cell per expression, cell aspect = visor aspect, eyes at ±0.30 visor heights
 * from the centre.
 */
import { EXPRESSIONS, exprPoints, isMascotExpression, type MascotExpression, type Outline, type ScreenGeometry } from '../mascot-geometry';

export { EXPRESSIONS };

export const COLS = 4;
export const ROWS = 4;
// Visor aspect of the classic skull (0.74 x 0.42) and where the eyes sit, in visor heights.
const ASPECT = 0.74 / 0.42;
const EYE_X = 0.3;
const EYE_Y = 0.02;
// The 2D screen puts an eye 13.6 units from the middle (screen height 29): that distance maps to EYE_X.
const UNIT = EYE_X / 13.6;
/** Distances are stored on one byte, from -D_IN inside a glyph to D_RANGE - D_IN outside, in visor heights. */
export const D_IN = 0.1;
export const D_RANGE = 0.36;

/** Screen geometry in raw glyph units, centred on 0: the atlas does its own scaling. */
const RAW: ScreenGeometry = { k: 1, c1: -13.6, c2: 13.6, cm: 0, cy: 0 };

const INDEX = new Map<string, number>(EXPRESSIONS.map((e, i) => [e, i]));
/** Atlas cell of an expression; anything else (a pack's eyes) shows the pill, as the plugin did. */
export const exprIndex = (name: string): number => INDEX.get(name) ?? 0;
/** The look's eyes as an atlas expression: a pack's eyes, which have no cell, show the pill. */
export const baseExpression = (eyes: unknown): MascotExpression => (isMascotExpression(eyes) ? eyes : 'pill');

/** Signed distance from (x, y) to a closed outline: negative inside. */
export function polyDistance(pts: readonly (readonly [number, number])[], x: number, y: number): number {
  let d2 = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [ax, ay] = pts[j]!;
    const [bx, by] = pts[i]!;
    const ex = bx - ax;
    const ey = by - ay;
    const wx = x - ax;
    const wy = y - ay;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
    const dx = wx - ex * t;
    const dy = wy - ey * t;
    const q = dx * dx + dy * dy;
    if (q < d2) d2 = q;
    if ((ay > y) !== (by > y) && x < ax + ((y - ay) / (by - ay)) * ex) inside = !inside;
  }
  return inside ? -Math.sqrt(d2) : Math.sqrt(d2);
}

/** An outline too small to see: the 2D module's empty slot is a dot of 0.01 units, which would still glow here. */
function isEmpty(pts: Outline): boolean {
  let r = 0;
  for (const [x, y] of pts) r = Math.max(r, Math.abs(x), Math.abs(y));
  return r < 0.1;
}

type Slot = { p: Outline; x0: number; x1: number; y0: number; y1: number };

export type EyeAtlas = { data: Uint8Array; w: number; h: number; cellW: number; cellH: number };

/**
 * Every expression as a signed distance field, one cell each, one byte per
 * texel, rows bottom-up (what a data texture takes). The visor reads the light
 * from the distance: the core where it is negative, the halo fading out past
 * it. Mixing the distances of two cells morphs one expression into the other,
 * where mixing their pictures would only fade.
 */
export function buildEyeAtlas(cellH = 88): EyeAtlas {
  const cellW = Math.round(cellH * ASPECT);
  const w = cellW * COLS;
  const h = cellH * ROWS;
  const data = new Uint8Array(w * h).fill(255);
  const reach = D_RANGE - D_IN;
  EXPRESSIONS.forEach((name, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const eyes = exprPoints(name, RAW);
    const slots: Slot[] = [];
    for (const outline of [eyes.L, eyes.R, eyes.M]) {
      if (isEmpty(outline)) continue;
      // In visor heights, centred on the cell, y down; the eye line sits a little above the middle.
      const p = outline.map(([px, py]): [number, number] => [px * UNIT, py * UNIT - EYE_Y]);
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const [a, b] of p) { x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b); }
      slots.push({ p, x0: x0 - reach, x1: x1 + reach, y0: y0 - reach, y1: y1 + reach });
    }
    for (let py = 0; py < cellH; py += 1) {
      const y = (py + 0.5) / cellH - 0.5;
      for (let px = 0; px < cellW; px += 1) {
        const x = ((px + 0.5) / cellW - 0.5) * ASPECT;
        let d = reach;
        for (const s of slots) if (x > s.x0 && x < s.x1 && y > s.y0 && y < s.y1) d = Math.min(d, polyDistance(s.p, x, y));
        const Y = row * cellH + py;
        data[(h - 1 - Y) * w + col * cellW + px] = Math.round(Math.max(0, Math.min(1, (d + D_IN) / D_RANGE)) * 255);
      }
    }
  });
  return { data, w, h, cellW, cellH };
}

/** The signed distance an atlas byte stands for, in visor heights (what the visor shader computes). */
export const atlasDistance = (byte: number): number => (byte / 255) * D_RANGE - D_IN;
