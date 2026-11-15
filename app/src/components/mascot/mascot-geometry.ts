/**
 * The mascot's geometry, pure: skull outlines (taken from the 3D models,
 * `mascot-2d-data.ts`), fur colours and the eye glyphs. Every glyph is a closed outline resampled to the same number of
 * points, so any expression can morph into any other point by point.
 */

import { DEFAULT_LOOK, type MascotShape } from './agent-look';
import { SKULLS_2D, type Skull2D } from './mascot-2d-data';
import { mascotPartOf } from './mascot-parts';
import type { MascotPartId } from '@/lib/mascot/parts-contract';

export type Point = [number, number];
export type Outline = Point[];

/* ---------- Skulls ---------- */

/**
 * The head of a skull in the 100×100 box, framed like a 3D tile: the body's
 * outline, the ears, the visor and the measures the accessories hang on.
 * The product's seven come from the 3D models (`mascot-2d-data.ts`); a pack's
 * skull is built from its four numbers.
 */
export type HeadLayout = Skull2D & {
  /** Where the eyes sit on the visor. */
  geo: ScreenGeometry;
};

/** Where the eyes sit on the screen: scale, the two eye centres, the middle, the vertical centre. */
export type ScreenGeometry = { k: number; c1: number; c2: number; cm: number; cy: number };

// The 3D visor's eye layout (`three/eyes.ts`): eyes 0.30 visor heights either side of the middle, the eye line
// 0.02 above it, and a glyph's 13.6 units from the middle landing on that spot. Same numbers, same face.
const EYE_X = 0.3;
const EYE_Y = 0.02;
const GLYPH_TO_EYE = 13.6;

function screenGeometry(v: Skull2D['visor']): ScreenGeometry {
  const cx = v.x + v.w / 2;
  return { k: (v.h * EYE_X) / GLYPH_TO_EYE, c1: cx - v.h * EYE_X, c2: cx + v.h * EYE_X, cm: cx, cy: v.y + v.h / 2 - v.h * EYE_Y };
}

/** Shifts every coordinate pair of an absolute path made of `M`, `C` and `Z` (what the generator writes). */
function shiftPath(d: string, dx: number, dy: number): string {
  let i = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, (n) => f1(Number(n) + (i++ % 2 === 0 ? dx : dy)));
}
const f1 = (v: number): string => String(Math.round(v * 10) / 10);

/**
 * A pack's skull: its four numbers were set in the older drawing's box (head
 * on y = 92, the classic skull 66 high), so they are scaled onto the classic
 * skull of this frame and set on its foot. Ears and visor are the classic
 * skull's, moved to the pack's sides and top: the visor keeps its one size.
 */
function packSkull(sk: { top: number; bottom: number; height: number; radius: number }): Skull2D {
  const C = SKULLS_2D.squircle;
  const s = (C.bottom - C.top) / 66;
  const h = sk.height * s;
  const tw = sk.top * s;
  const bw = sk.bottom * s;
  const top = C.bottom - h;
  const body = roundedPoly([[50 - tw / 2, top], [50 + tw / 2, top], [50 + bw / 2, C.bottom], [50 - bw / 2, C.bottom]], sk.radius * s);
  // Ears ride at the same share of the height as on the classic skull, against the pack's flank there.
  const share = (C.ears.R[1] - C.top) / (C.bottom - C.top);
  const flank = (tw + (bw - tw) * share) / 2;
  const classicFlank = (C.topWidth + (C.bottomWidth - C.topWidth) * share) / 2;
  const dx = flank - classicFlank;
  const dy = top + share * h - C.ears.R[1];
  const visorShare = (C.visor.y - C.top) / (C.bottom - C.top);
  const visorY = Math.min(C.bottom - C.visor.h - 4, top + visorShare * h);
  return {
    body,
    earL: shiftPath(C.earL, -dx, dy),
    earR: shiftPath(C.earR, dx, dy),
    ears: { L: [C.ears.L[0] - dx, C.ears.L[1] + dy], R: [C.ears.R[0] + dx, C.ears.R[1] + dy] },
    visor: { ...C.visor, y: visorY },
    top,
    bottom: C.bottom,
    earsTop: Math.min(top, C.earsTop + dy),
    halfWidth: Math.max(tw, bw) / 2 + (C.halfWidth - Math.max(C.topWidth, C.bottomWidth) / 2),
    topWidth: tw,
    bottomWidth: bw,
    belly: (tw + (bw - tw) * 0.7) / 2,
  };
}

/**
 * The skull of a shape: the product's, or a pack's (four numbers checked
 * against `SKULL_BOUNDS` when it registered — a pack cannot draw a free
 * outline, so ears, visor and accessory still land on it). Unknown, or its
 * pack gone: the classic skull.
 */
const packSkulls = new WeakMap<object, Skull2D>();
function skullOf(shape: string): Skull2D {
  const own = (SKULLS_2D as Readonly<Record<string, Skull2D>>)[shape];
  if (own) return own;
  const pack = mascotPartOf('shape', shape);
  if (!pack) return SKULLS_2D.squircle;
  let skull = packSkulls.get(pack);
  if (!skull) { skull = packSkull(pack.skull); packSkulls.set(pack, skull); }
  return skull;
}

export function headLayout(shape: MascotShape | MascotPartId): HeadLayout {
  const S = skullOf(shape);
  return { ...S, geo: screenGeometry(S.visor) };
}

/**
 * The head's extent in the 100×100 box: what a scene that stacks heads (the
 * onboarding's avalanche) collides. `bottom` is where it stands: the skulls
 * are centred in their tile like the 3D ones, so each stands a little apart.
 */
export function skullSize(shape: MascotShape | MascotPartId): { tw: number; bw: number; h: number; bottom: number } {
  const S = skullOf(shape);
  return { tw: S.topWidth, bw: S.bottomWidth, h: S.bottom - S.top, bottom: S.bottom };
}

/* ---------- Colours ---------- */

const channels = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: readonly number[]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Lightens toward white (`amt` > 0) or darkens toward black (`amt` < 0). */
export function shade(hex: string, amt: number): string {
  return toHex(channels(hex).map((v) => (amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
}
export function mix(a: string, b: string, k: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return toHex(ca.map((v, i) => v * (1 - k) + (cb[i] ?? 0) * k));
}
export function luma(hex: string): number {
  const [r, g, b] = channels(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
/**
 * The fur a look paints: its colour exactly, like the 3D head (a preset, a
 * natural pelt or any `#rrggbb`); anything else, the default pelt.
 */
export function furOf(color: string): string {
  const c = color.toLowerCase();
  return /^#[0-9a-f]{6}$/.test(c) ? c : DEFAULT_LOOK.color;
}

/** A closed polygon with quadratic rounded corners, as an SVG path. */
export function roundedPoly(pts: readonly Point[], r: number): string {
  let d = '';
  pts.forEach((p, i) => {
    const prev = pts[(i + pts.length - 1) % pts.length]!;
    const next = pts[(i + 1) % pts.length]!;
    const toward = (q: Point, len: number): Point => {
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const l = Math.hypot(dx, dy);
      const k = Math.min(len, l / 2) / l;
      return [p[0] + dx * k, p[1] + dy * k];
    };
    const a = toward(prev, r);
    const b = toward(next, r);
    d += `${i ? 'L' : 'M'}${f2(a[0])} ${f2(a[1])}Q${f2(p[0])} ${f2(p[1])} ${f2(b[0])} ${f2(b[1])}`;
  });
  return `${d}Z`;
}
const f2 = (v: number): string => v.toFixed(2);

/* ---------- Eye glyphs ---------- */

/** Points per eye outline: every glyph is resampled to it, so any morphs into any. */
export const EYE_POINTS = 72;

function rrect(w: number, h: number, radius: number): Outline {
  const pts: Outline = [];
  const x0 = -w / 2;
  const y0 = -h / 2;
  const x1 = w / 2;
  const y1 = h / 2;
  const r = Math.min(radius, w / 2, h / 2);
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 10; i += 1) {
      const a = a0 + (i / 10) * Math.PI / 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x1 - r, y0 + r, -Math.PI / 2);
  corner(x1 - r, y1 - r, 0);
  corner(x0 + r, y1 - r, Math.PI / 2);
  corner(x0 + r, y0 + r, Math.PI);
  return pts;
}
const ellipse = (rx: number, ry = rx): Outline => Array.from({ length: 48 }, (_, i): Point => {
  const a = -Math.PI / 2 + (i / 48) * Math.PI * 2;
  return [rx * Math.cos(a), ry * Math.sin(a)];
});
/** A thick stroke along a centreline, with round caps, as one closed outline. */
function stroke(line: readonly Point[], hw: number): Outline {
  const n = line.length;
  const left: Outline = [];
  const right: Outline = [];
  const dir = (i: number): Point => {
    const a = line[Math.max(0, i - 1)]!;
    const b = line[Math.min(n - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    return [dx / d, dy / d];
  };
  for (let i = 0; i < n; i += 1) {
    const [dx, dy] = dir(i);
    const p = line[i]!;
    left.push([p[0] - dy * hw, p[1] + dx * hw]);
    right.push([p[0] + dy * hw, p[1] - dx * hw]);
  }
  const cap = (p: Point, [dx, dy]: Point): Outline => {
    const out: Outline = [];
    const a0 = Math.atan2(dx, -dy);
    for (let i = 1; i < 10; i += 1) {
      const a = a0 - (i / 10) * Math.PI;
      out.push([p[0] + hw * Math.cos(a), p[1] + hw * Math.sin(a)]);
    }
    return out;
  };
  const end = dir(n - 1);
  const start = dir(0);
  return [...left, ...cap(line[n - 1]!, end), ...right.reverse(), ...cap(line[0]!, [-start[0], -start[1]])];
}
const seg = (a: Point, b: Point, k = 12): Outline => Array.from({ length: k }, (_, i): Point => [
  a[0] + (b[0] - a[0]) * i / (k - 1), a[1] + (b[1] - a[1]) * i / (k - 1),
]);
const quad = (a: Point, c: Point, b: Point, k = 24): Outline => Array.from({ length: k }, (_, i): Point => {
  const t = i / (k - 1);
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
});
const chevron = (flip: number): Outline => stroke([...seg([3 * flip, -5.6], [-2.6 * flip, 0]), ...seg([-2.6 * flip, 0], [3 * flip, 5.6]).slice(1)], 1.55);

const GLYPHS = {
  pill: () => rrect(5.4, 12.4, 2.7),
  big: () => rrect(9.4, 13.4, 4.4),
  happy: () => stroke(quad([-5.4, 2.4], [0, -5.2], [5.4, 2.4]), 1.6),
  sad: () => stroke(quad([-5.4, -1.6], [0, 5.6], [5.4, -1.6]), 1.6),
  sleepy: () => rrect(10.4, 3, 1.5),
  round: () => ellipse(4.7),
  dot: () => ellipse(2.5),
  none: () => ellipse(0.01),
  heart: () => Array.from({ length: 60 }, (_, i): Point => {
    const t = (i / 60) * Math.PI * 2;
    return [0.4 * 16 * Math.sin(t) ** 3, -0.4 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) - 0.6];
  }),
  star: () => Array.from({ length: 10 }, (_, i): Point => {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const r = i % 2 ? 2.9 : 7;
    return [r * Math.cos(a), r * Math.sin(a) + 0.6];
  }),
  cross: () => {
    const w = 1.6;
    const l = 5.4;
    const c = Math.SQRT1_2;
    const pts: Outline = [[-w, -l], [w, -l], [w, -w], [l, -w], [l, w], [w, w], [w, l], [-w, l], [-w, w], [-l, w], [-l, -w], [-w, -w]];
    return pts.map(([x, y]): Point => [c * (x - y), c * (x + y)]);
  },
  lt: () => chevron(1),
  gt: () => chevron(-1),
  slash: () => stroke(seg([2.6, -6.2], [-2.6, 6.2], 16), 1.5),
  squint: () => rrect(7.4, 5.2, 2.6),
  angryL: () => rrect(5.4, 12.4, 2.7).map(([x, y]): Point => [x, y + (y < 0 ? x * 0.55 : 0)]),
  angryR: () => rrect(5.4, 12.4, 2.7).map(([x, y]): Point => [x, y - (y < 0 ? x * 0.55 : 0)]),
} satisfies Record<string, () => Outline>;
type Glyph = keyof typeof GLYPHS;

/** An expression: what each slot shows (left eye, right eye, a middle glyph) and where, in screen units (screen height 29). */
type Expression = { L: Glyph; R: Glyph; M?: Glyph; lx?: number; rx?: number };
const EXPR = {
  pill: { L: 'pill', R: 'pill' },
  happy: { L: 'happy', R: 'happy' },
  wink: { L: 'pill', R: 'happy' },
  big: { L: 'big', R: 'big' },
  sleepy: { L: 'sleepy', R: 'sleepy' },
  sad: { L: 'sad', R: 'sad' },
  angry: { L: 'angryL', R: 'angryR' },
  surprised: { L: 'round', R: 'round' },
  heart: { L: 'heart', R: 'heart' },
  star: { L: 'star', R: 'star' },
  x: { L: 'cross', R: 'cross' },
  dots: { L: 'dot', R: 'dot', M: 'dot', lx: -8, rx: 8 },
  code: { L: 'lt', R: 'gt', M: 'slash', lx: -9, rx: 9 },
  squint: { L: 'squint', R: 'squint' },
  quizzical: { L: 'round', R: 'sleepy' },
  skeptic: { L: 'sleepy', R: 'pill' },
} as const satisfies Record<string, Expression>;
export type MascotExpression = keyof typeof EXPR;
export const EXPRESSIONS = Object.keys(EXPR) as MascotExpression[];

/** What the eyes may show: one of the product's expressions, or a pack's eyes (`<pluginId>:<slug>`). */
export type MascotEyesKey = MascotExpression | MascotPartId;

export function isMascotExpression(value: unknown): value is MascotExpression {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EXPR, value);
}

/** An expression of the product, or a pack's eyes registered now. */
export function isDrawableEyes(value: unknown): value is MascotEyesKey {
  return isMascotExpression(value) || mascotPartOf('eyes', value) !== null;
}

/** Resamples a closed outline to `n` points evenly spaced, counter-clockwise, starting at the top. */
export function resample(poly: readonly Point[], n = EYE_POINTS): Outline {
  let area = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const P = area < 0 ? poly.slice().reverse() : poly;
  const len = [0];
  for (let i = 1; i <= P.length; i += 1) {
    const a = P[i - 1]!;
    const b = P[i % P.length]!;
    len.push(len[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = len[len.length - 1]!;
  const out: Outline = [];
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (i / n) * total;
    while (len[j + 1]! < d) j += 1;
    const a = P[j]!;
    const b = P[(j + 1) % P.length]!;
    const t = (d - len[j]!) / ((len[j + 1]! - len[j]!) || 1);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  const cx = out.reduce((s, p) => s + p[0], 0) / n;
  const cy = out.reduce((s, p) => s + p[1], 0) / n;
  // Every outline starts at its topmost direction: two glyphs then pair their
  // points the same way round, and a morph never twists.
  let best = 0;
  let bd = Infinity;
  out.forEach(([x, y], i) => {
    const d = Math.abs(Math.atan2(y - cy, x - cx) + Math.PI / 2);
    if (d < bd) { bd = d; best = i; }
  });
  return [...out.slice(best), ...out.slice(0, best)];
}

const glyphCache = new Map<Glyph, Outline>();
function glyphPoints(name: Glyph): Outline {
  let pts = glyphCache.get(name);
  if (!pts) { pts = resample(GLYPHS[name]()); glyphCache.set(name, pts); }
  return pts;
}

export type EyeSlots = { L: Outline; R: Outline; M: Outline };

type PackEyes = { L: Outline; R: Outline; M: Outline };
/** Keyed by the part object: a pack registered again brings new outlines, the old ones are dropped with it. */
const packEyesCache = new WeakMap<object, PackEyes>();

/** A pack's eyes, resampled like a glyph; the right eye mirrors the left when the pack draws one only. */
function packEyes(id: string): PackEyes | null {
  const part = mascotPartOf('eyes', id);
  if (!part) return null;
  let eyes = packEyesCache.get(part);
  if (!eyes) {
    const left = part.left.map(([x, y]): Point => [x, y]);
    const right = part.right ? part.right.map(([x, y]): Point => [x, y]) : left.map(([x, y]): Point => [-x, y]);
    eyes = {
      L: resample(left),
      R: resample(right),
      M: part.middle ? resample(part.middle.map(([x, y]): Point => [x, y])) : glyphPoints('none'),
    };
    packEyesCache.set(part, eyes);
  }
  return eyes;
}

/** Whether these eyes blink: a product expression per `NO_BLINK`, a pack's unless it says `blink: false`. */
export function packEyesBlink(id: string): boolean | null {
  const part = mascotPartOf('eyes', id);
  return part ? part.blink !== false : null;
}

/**
 * Absolute points of the three slots of an expression on a given screen. A
 * pack's eyes whose plugin left show the plain pill, like an unknown name.
 */
export function exprPoints(name: MascotEyesKey, geo: ScreenGeometry): EyeSlots {
  const place = (pts: Outline, x: number): Outline => pts.map(([px, py]): Point => [x + px * geo.k, geo.cy + py * geo.k]);
  const pack = isMascotExpression(name) ? null : packEyes(name);
  if (pack) return { L: place(pack.L, geo.c1), R: place(pack.R, geo.c2), M: place(pack.M, geo.cm) };
  const e: Expression = (EXPR as Readonly<Record<string, Expression>>)[name] ?? EXPR.pill;
  const lx = e.lx !== undefined ? geo.cm + e.lx * geo.k : geo.c1;
  const rx = e.rx !== undefined ? geo.cm + e.rx * geo.k : geo.c2;
  return { L: place(glyphPoints(e.L), lx), R: place(glyphPoints(e.R), rx), M: place(glyphPoints(e.M ?? 'none'), geo.cm) };
}

export function ptsPath(pts: readonly Point[]): string {
  return `M${pts.map((p) => `${f2(p[0])} ${f2(p[1])}`).join('L')}Z`;
}
