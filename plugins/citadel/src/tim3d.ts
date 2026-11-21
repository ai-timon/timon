// 3D Tims: Timon's plush mascot, ported from the Timon 0.1.9 client engine (createEngine) so it can live
// inside a Three.js scene instead of a thumbnail. Same data (assets/mascot3d.json), same shaders (shell fur,
// expression-atlas visor, accessories), same simulation (breathing, jumps, gaze, ears, blinks, per-state
// expressions). Differences: each Tim is a Group placed in the scene; no thumbnail camera; level of detail by
// on-screen size; no mouse-following gaze.
import * as THREE from 'three';
import { bindUniforms } from './uniforms.js';

type Pt = [number, number];
type V2 = [number, number];
type V3 = [number, number, number];

/** Element `i` of an array that is known to hold it (replaces a non-null assertion). */
function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

/* ---------- Data decoding ---------- */
/** A packed numeric array of assets/mascot3d.json: base64 payload, optionally quantised per component. */
export interface PackedArray { k: string; d: string; n: number; lo: number[]; hi: number[] }
interface BodyData { pos: PackedArray; nrm: PackedArray; fur: PackedArray; ear: PackedArray; j: PackedArray; w: PackedArray; idx: PackedArray }
interface ShapeData {
  body: BodyData; bodyLo: BodyData;
  anim: { data: string; bones: number; rows: number };
  visor: { pos: PackedArray; nrm: PackedArray; uv: PackedArray; idx: PackedArray };
  earPivot: { L: V3; R: V3 };
  furLength: number; height: number; halfWidth: number; headPivot: number; visorAspect: number;
}
interface AccessoryData { tilt?: number; pos: PackedArray; nrm: PackedArray; col: string; idx: PackedArray }
/** Content of assets/mascot3d.json (generated from the Blender exports of the mascot). */
export interface Tim3DData { shapes: Record<string, ShapeData>; accessories: Record<string, AccessoryData> }
/** Look of a Tim, as set on the agent in Timon. */
export interface TimLook { shape?: string; color?: string; eyes?: string; acc?: string }

const bytes = (b64: string): Uint8Array => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
function decodeArray(e: PackedArray): Uint16Array | Float32Array {
  const buf = bytes(e.d).buffer as ArrayBuffer;
  if (e.k !== 'q16' && e.k !== 'q8') return e.k === 'u16' ? new Uint16Array(buf) : Float32Array.from(new Uint8Array(buf));
  const q = e.k === 'q16' ? new Uint16Array(buf) : new Uint8Array(buf), max = e.k === 'q16' ? 65535 : 255, out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) { const c = i % e.n, lo = e.lo[c] ?? 0, hi = e.hi[c] ?? 0; out[i] = lo + (q[i] ?? 0) / max * (hi - lo); }
  return out;
}
const decodeFloats = (e: PackedArray): Float32Array => { const a = decodeArray(e); return a instanceof Float32Array ? a : Float32Array.from(a); };
const shapeData = (data: Tim3DData, shape: string): ShapeData => {
  const d = Object.prototype.hasOwnProperty.call(data.shapes, shape) ? data.shapes[shape] : data.shapes.squircle;
  if (!d) throw new Error('3D Tims: missing squircle shape');
  return d;
};

/** Model data, served by the plugin host (route /assets/mascot3d.json). */
export async function loadTim3D(api: (path: string) => Promise<Response>): Promise<Tim3DData> {
  const r = await api('assets/mascot3d.json');
  if (!r.ok) throw new Error(`3D Tims unavailable (${r.status})`);
  const d = await r.json() as Partial<Tim3DData> | null;
  if (!d?.shapes?.squircle?.anim || !d.accessories) throw new Error('3D Tims: invalid data');
  return d as Tim3DData;
}

/* ---------- Eyes: shapes and distance-field atlas ---------- */
const rrect = (w: number, h: number, r: number): Pt[] => {
  const out: Pt[] = [], l = -w / 2, t = -h / 2, R = w / 2, B = h / 2, c = Math.min(r, w / 2, h / 2);
  const arc = (x: number, y: number, a0: number): void => { for (let i = 0; i <= 10; i++) { const a = a0 + i / 10 * Math.PI / 2; out.push([x + c * Math.cos(a), y + c * Math.sin(a)]); } };
  arc(R - c, t + c, -Math.PI / 2); arc(R - c, B - c, 0); arc(l + c, B - c, Math.PI / 2); arc(l + c, t + c, Math.PI);
  return out;
};
const ellipse = (rx: number, ry = rx): Pt[] => Array.from({ length: 48 }, (_, i): Pt => { const a = -Math.PI / 2 + i / 48 * Math.PI * 2; return [rx * Math.cos(a), ry * Math.sin(a)]; });
function stroke(pts: Pt[], w: number): Pt[] {
  const n = pts.length, A: Pt[] = [], Bk: Pt[] = [];
  const tan = (i: number): Pt => { const p = at(pts, Math.max(0, i - 1)), q = at(pts, Math.min(n - 1, i + 1)), dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };
  for (let i = 0; i < n; i++) { const [tx, ty] = tan(i), c = at(pts, i); A.push([c[0] - ty * w, c[1] + tx * w]); Bk.push([c[0] + ty * w, c[1] - tx * w]); }
  const cap = (e: Pt, [tx, ty]: Pt): Pt[] => { const out: Pt[] = [], a0 = Math.atan2(tx, -ty); for (let i = 1; i < 10; i++) { const a = a0 - i / 10 * Math.PI; out.push([e[0] + w * Math.cos(a), e[1] + w * Math.sin(a)]); } return out; };
  const te = tan(n - 1), ts = tan(0);
  return [...A, ...cap(at(pts, n - 1), te), ...Bk.reverse(), ...cap(at(pts, 0), [-ts[0], -ts[1]])];
}
const line = (a: Pt, b: Pt, n = 12): Pt[] => Array.from({ length: n }, (_, i): Pt => [a[0] + (b[0] - a[0]) * i / (n - 1), a[1] + (b[1] - a[1]) * i / (n - 1)]);
const quad = (a: Pt, c: Pt, b: Pt, n = 24): Pt[] => Array.from({ length: n }, (_, i): Pt => { const t = i / (n - 1), u = 1 - t; return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]; });
const chevron = (s: number): Pt[] => stroke([...line([3 * s, -5.6], [-2.6 * s, 0]), ...line([-2.6 * s, 0], [3 * s, 5.6]).slice(1)], 1.55);
type ShapeName = 'pill' | 'big' | 'happy' | 'sad' | 'sleepy' | 'round' | 'dot' | 'none' | 'heart' | 'star' | 'cross' | 'lt' | 'gt' | 'slash' | 'squint' | 'angryL' | 'angryR';
const SHAPE: Record<ShapeName, () => Pt[]> = {
  pill: () => rrect(5.4, 12.4, 2.7), big: () => rrect(9.4, 13.4, 4.4),
  happy: () => stroke(quad([-5.4, 2.4], [0, -5.2], [5.4, 2.4]), 1.6), sad: () => stroke(quad([-5.4, -1.6], [0, 5.6], [5.4, -1.6]), 1.6),
  sleepy: () => rrect(10.4, 3, 1.5), round: () => ellipse(4.7), dot: () => ellipse(2.5), none: () => ellipse(0.01),
  heart: () => Array.from({ length: 60 }, (_, i): Pt => { const r = i / 60 * Math.PI * 2; return [6.4 * Math.sin(r) ** 3, -0.4 * (13 * Math.cos(r) - 5 * Math.cos(2 * r) - 2 * Math.cos(3 * r) - Math.cos(4 * r)) - 0.6]; }),
  star: () => Array.from({ length: 10 }, (_, i): Pt => { const r = -Math.PI / 2 + i * Math.PI / 5, n = i % 2 ? 2.9 : 7; return [n * Math.cos(r), n * Math.sin(r) + 0.6]; }),
  cross: () => { const e = Math.SQRT1_2; const pts: Pt[] = [[-1.6, -5.4], [1.6, -5.4], [1.6, -1.6], [5.4, -1.6], [5.4, 1.6], [1.6, 1.6], [1.6, 5.4], [-1.6, 5.4], [-1.6, 1.6], [-5.4, 1.6], [-5.4, -1.6], [-1.6, -1.6]]; return pts.map(([r, n]): Pt => [e * (r - n), e * (r + n)]); },
  lt: () => chevron(1), gt: () => chevron(-1), slash: () => stroke(line([2.6, -6.2], [-2.6, 6.2], 16), 1.5), squint: () => rrect(7.4, 5.2, 2.6),
  angryL: () => rrect(5.4, 12.4, 2.7).map(([x, y]): Pt => [x, y + (y < 0 ? 0.55 * x : 0)]), angryR: () => rrect(5.4, 12.4, 2.7).map(([x, y]): Pt => [x, y - (y < 0 ? 0.55 * x : 0)]),
};
interface ExprDef { L: ShapeName; R: ShapeName; M?: ShapeName; lx?: number; rx?: number }
const PILL: ExprDef = { L: 'pill', R: 'pill' };
// The order of this table is the atlas order (4 × 4 cells): do not change it
const EXPR: Record<string, ExprDef> = { pill: PILL, happy: { L: 'happy', R: 'happy' }, wink: { L: 'pill', R: 'happy' }, big: { L: 'big', R: 'big' }, sleepy: { L: 'sleepy', R: 'sleepy' },
  sad: { L: 'sad', R: 'sad' }, angry: { L: 'angryL', R: 'angryR' }, surprised: { L: 'round', R: 'round' }, heart: { L: 'heart', R: 'heart' }, star: { L: 'star', R: 'star' },
  x: { L: 'cross', R: 'cross' }, dots: { L: 'dot', R: 'dot', M: 'dot', lx: -8, rx: 8 }, code: { L: 'lt', R: 'gt', M: 'slash', lx: -9, rx: 9 }, squint: { L: 'squint', R: 'squint' },
  quizzical: { L: 'round', R: 'sleepy' }, skeptic: { L: 'sleepy', R: 'pill' } };
const EXPR_KEYS = Object.keys(EXPR);
const exprIndex = (e: string): number => Math.max(0, EXPR_KEYS.indexOf(e));
export const baseEyes = (e: string | undefined): string => e !== undefined && Object.prototype.hasOwnProperty.call(EXPR, e) ? e : 'pill';
function resample(pts: Pt[], n = 72): Pt[] {
  let area = 0; for (let i = 0; i < pts.length; i++) { const a = at(pts, i), b = at(pts, (i + 1) % pts.length); area += a[0] * b[1] - b[0] * a[1]; }
  const p = area < 0 ? pts.slice().reverse() : pts, acc = [0];
  for (let i = 1; i <= p.length; i++) { const a = at(p, i - 1), b = at(p, i % p.length); acc.push(at(acc, i - 1) + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const L = at(acc, acc.length - 1), out: Pt[] = []; let j = 0;
  for (let i = 0; i < n; i++) { const d = i / n * L; while (at(acc, j + 1) < d) j++; const a = at(p, j), b = at(p, (j + 1) % p.length), f = (d - at(acc, j)) / (at(acc, j + 1) - at(acc, j) || 1); out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
  const cx = out.reduce((s, q) => s + q[0], 0) / n, cy = out.reduce((s, q) => s + q[1], 0) / n; let k = 0, best = Infinity;
  out.forEach(([x, y], i) => { const a = Math.abs(Math.atan2(y - cy, x - cx) + Math.PI / 2); if (a < best) { best = a; k = i; } });
  return [...out.slice(k), ...out.slice(0, k)];
}
const shapeCache = new Map<ShapeName, Pt[]>();
const eyeShape = (n: ShapeName): Pt[] => { let s = shapeCache.get(n); if (!s) { s = resample(SHAPE[n]()); shapeCache.set(n, s); } return s; };
interface EyeGeometry { k: number; c1: number; c2: number; cm: number; cy: number }
function eyes(expr: string, g: EyeGeometry): { L: Pt[]; R: Pt[]; M: Pt[] } {
  const place = (pts: Pt[], cx: number): Pt[] => pts.map(([x, y]): Pt => [cx + x * g.k, g.cy + y * g.k]);
  const e = EXPR[expr] ?? PILL, l = e.lx !== undefined ? g.cm + e.lx * g.k : g.c1, r = e.rx !== undefined ? g.cm + e.rx * g.k : g.c2;
  return { L: place(eyeShape(e.L), l), R: place(eyeShape(e.R), r), M: place(eyeShape(e.M ?? 'none'), g.cm) };
}
const ATLAS_COLS = 4, ATLAS_ROWS = 4, SDF_LO = 0.1, SDF_HI = 0.36;
function buildAtlas(cellH = 88) {
  const aspect = 0.74 / 0.42, unit = 0.3 / 13.6, cellW = Math.round(cellH * aspect), W = cellW * ATLAS_COLS, H = cellH * ATLAS_ROWS;
  const data = new Uint8Array(W * H).fill(255), span = SDF_HI - SDF_LO, geo: EyeGeometry = { k: 1, c1: -13.6, c2: 13.6, cm: 0, cy: 0 };
  // Signed distance to a polygon (negative inside)
  const sd = (poly: Pt[], x: number, y: number): number => {
    let d2 = Infinity, inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) {
      const [x0, y0] = at(poly, j), [x1, y1] = at(poly, i), dx = x1 - x0, dy = y1 - y0, ux = x - x0, uy = y - y0, t = Math.max(0, Math.min(1, (ux * dx + uy * dy) / (dx * dx + dy * dy || 1))), ex = ux - dx * t, ey = uy - dy * t, q = ex * ex + ey * ey;
      if (q < d2) d2 = q;
      if ((y0 > y) !== (y1 > y) && x < x0 + (y - y0) / (y1 - y0) * dx) inside = !inside;
    }
    return inside ? -Math.sqrt(d2) : Math.sqrt(d2);
  };
  EXPR_KEYS.forEach((expr, idx) => {
    const col = idx % ATLAS_COLS, row = Math.floor(idx / ATLAS_COLS), g = eyes(expr, geo), polys: { p: Pt[]; x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const p of [g.L, g.R, g.M]) {
      if (Math.max(...p.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) < 0.1) continue;
      const q = p.map(([x, y]): Pt => [x * unit, y * unit - 0.02]);
      polys.push({ p: q, x0: Math.min(...q.map(v => v[0])) - span, x1: Math.max(...q.map(v => v[0])) + span, y0: Math.min(...q.map(v => v[1])) - span, y1: Math.max(...q.map(v => v[1])) + span });
    }
    for (let yy = 0; yy < cellH; yy++) {
      const y = (yy + 0.5) / cellH - 0.5;
      for (let xx = 0; xx < cellW; xx++) {
        const x = ((xx + 0.5) / cellW - 0.5) * aspect; let d = span;
        for (const P of polys) if (x > P.x0 && x < P.x1 && y > P.y0 && y < P.y1) d = Math.min(d, sd(P.p, x, y));
        data[(H - 1 - (row * cellH + yy)) * W + col * cellW + xx] = Math.round(255 * Math.max(0, Math.min(1, (d + SDF_LO) / SDF_HI)));
      }
    }
  });
  return { data, w: W, h: H };
}

/* ---------- States and simulation ---------- */
type ClipName = 'hop' | 'hop_big' | 'startle' | 'grab' | 'happy';
type TimState = 'idle' | 'listening' | 'thinking' | 'working' | 'searching' | 'waiting' | 'done' | 'error' | 'sleeping' | 'celebrate' | 'coding';
interface StateDef {
  pool: readonly string[]; every: readonly [number, number]; blink: boolean; gaze: 'pointer' | 'glance' | 'scan' | V3;
  loop?: { clip: ClipName; every: readonly [number, number]; lift: number }; enter?: ClipName; breathe?: boolean; ears?: number;
}
const STATES: Record<TimState, StateDef> = {
  idle: { pool: ['base', 'base', 'base', 'big', 'happy'], every: [7, 13], blink: true, gaze: 'pointer' },
  listening: { pool: ['big', 'pill'], every: [2.8, 5], blink: true, gaze: [0, -0.28, 0] },
  thinking: { pool: ['dots', 'quizzical', 'skeptic', 'dots'], every: [1.8, 3.2], blink: true, gaze: 'glance' },
  working: { pool: ['squint', 'pill', 'squint'], every: [1.8, 3], blink: true, gaze: [0, 0.32, 0] },
  searching: { pool: ['pill', 'big', 'surprised'], every: [1, 1.8], blink: true, gaze: 'scan' },
  waiting: { pool: ['big', 'pill', 'big'], every: [3, 5.5], blink: true, gaze: [0, -0.05, 0], loop: { clip: 'hop', every: [1.4, 2.2], lift: 0.07 } },
  done: { pool: ['happy', 'star', 'happy'], every: [2.2, 4], blink: false, gaze: 'pointer', enter: 'happy' },
  error: { pool: ['x', 'sad', 'x'], every: [2.6, 4.2], blink: false, gaze: [0, 0.3, 0.12], enter: 'startle' },
  sleeping: { pool: ['sleepy'], every: [6, 10], blink: false, gaze: [0, 0.28, 0.08], breathe: true, ears: -0.35 },
  celebrate: { pool: ['star', 'heart', 'happy'], every: [1.1, 2], blink: false, gaze: 'pointer', loop: { clip: 'hop_big', every: [0.9, 1.3], lift: 0.12 } },
  coding: { pool: ['code', 'squint', 'code'], every: [2.6, 4.4], blink: false, gaze: [0, 0.3, 0] },
};
const CLIPS: Record<ClipName, { row: number; frames: number }> = { hop: { row: 1, frames: 21 }, hop_big: { row: 22, frames: 21 }, startle: { row: 43, frames: 15 }, grab: { row: 58, frames: 25 }, happy: { row: 83, frames: 25 } };
const NO_BLINK = new Set(['sleepy', 'happy', 'x', 'heart', 'star', 'code', 'dots', 'sad', 'squint']);
const between = (sim: { random: () => number }, [a, b]: readonly [number, number]): number => a + sim.random() * (b - a);
interface Sim {
  random: () => number; state: TimState | undefined; expr: string; exprAt: number; blinkAt: number; blinkStart: number;
  from: number; to: number; mix: number; blink: number; head: V3; headV: V3; ear: V2; earV: V2; twitchAt: number;
  yaw: number; pitch: number; roll: number; squash: number; squashV: number; breath: number; y: number; vel: V2;
  clip: ClipName | null; clipT: number; row: number; loopAt: number; glanceSide: number; glanceAt: number;
  t: number; phase: number; breathP: number; glow: number;
}
function newSim(random: () => number = Math.random): Sim {
  const r = (a: number, b: number): number => a + random() * (b - a);
  return { random, state: undefined, expr: 'pill', exprAt: 0, blinkAt: r(1, 4), blinkStart: -1, from: 0, to: 0, mix: 0, blink: 1, head: [0, 0, 0], headV: [0, 0, 0], ear: [0, 0], earV: [0, 0],
    twitchAt: r(2, 7), yaw: 0, pitch: 0, roll: 0, squash: 0, squashV: 0, breath: 0, y: 0, vel: [0, 0], clip: null, clipT: 0, row: 0, loopAt: 0, glanceSide: 1, glanceAt: 0,
    t: r(0, 50), phase: r(0, 6.3), breathP: r(1.8, 2.6), glow: 1 };
}
const pick = (sim: Sim, state: TimState, base: string): string => { const p = STATES[state].pool, e = p[Math.floor(sim.random() * p.length)] ?? 'base'; return e === 'base' ? base : e; };
function stepSim(s: Sim, dt: number, state: TimState, base: string): void {
  const b = STATES[state];
  s.t += dt;
  if (state !== s.state) {
    s.state = state; s.expr = pick(s, state, base); s.exprAt = s.t + between(s, b.every);
    if (b.enter) { s.clip = b.enter; s.clipT = 0; }
    s.loopAt = s.t + (b.loop ? between(s, [0.2, 0.6]) : 1e9); s.earV[0] += 4; s.earV[1] += 4;
  }
  if (s.t > s.exprAt) { s.expr = pick(s, state, base); s.exprAt = s.t + between(s, b.every); }
  if (b.loop && !s.clip && s.t > s.loopAt) { s.clip = b.loop.clip; s.clipT = 0; s.loopAt = s.t + between(s, b.loop.every); }
  let lift = 0;
  if (s.clip) {
    const c = CLIPS[s.clip], last = c.frames - 1; s.clipT += dt; const f = 30 * s.clipT;
    if (f >= last) { s.clip = null; s.row = 0; s.squashV -= 1.2; }
    else { s.row = c.row + Math.min(f, c.frames - 1.001); if ((s.clip === 'hop' || s.clip === 'hop_big') && f > 4 && f < 16) { const k = (f - 4) / 12; lift = 4 * (b.loop?.lift ?? 0.08) * k * (1 - k); } }
  }
  const y0 = s.y; s.y = lift; s.vel[1] = (s.y - y0) / Math.max(dt, 1e-3);
  s.squashV += (-260 * s.squash - 10 * s.squashV) * dt; s.squash += s.squashV * dt;
  s.breath = (b.breathe ? 0.03 : 0.016) * Math.sin(6.283 * s.t / (b.breathe ? 1.8 * s.breathP : s.breathP) + s.phase);
  const ix = exprIndex(s.expr);
  if (ix !== s.to) { s.from = s.mix > 0.5 ? s.to : s.from; s.to = ix; s.mix = 0; }
  s.mix = Math.min(1, s.mix + dt / 0.26); if (s.mix >= 1) s.from = s.to;
  s.blink = 1;
  if (b.blink && !NO_BLINK.has(s.expr)) {
    if (s.blinkStart < 0 && s.t > s.blinkAt) s.blinkStart = s.t;
    if (s.blinkStart >= 0) { const k = (s.t - s.blinkStart) / 0.16; s.blink = k < 0.5 ? 1 - 1.9 * k : 0.05 + (k - 0.5) * 1.9; if (k >= 1) { s.blinkStart = -1; s.blink = 1; s.blinkAt = s.t + (s.random() < 0.15 ? 0.18 : between(s, [2.5, 6])); } }
  }
  s.glow = b.breathe ? 0.55 + 0.25 * Math.sin(1.7 * s.t + s.phase) : 1;
  let g: V3;
  if (b.gaze === 'pointer') g = [0, 0, 0];
  else if (b.gaze === 'glance') { if (s.t > s.glanceAt) { s.glanceSide = -s.glanceSide; s.glanceAt = s.t + between(s, [1.4, 2.6]); } g = [0.5 * s.glanceSide, -0.08, 0.12 * s.glanceSide]; }
  else if (b.gaze === 'scan') g = [0.6 * Math.sin(2.2 * s.t), 0.05, 0];
  else g = b.gaze;
  const w: V3 = [0.75 * g[0], 0.8 * g[1], g[2]];
  for (const i of [0, 1, 2] as const) { s.headV[i] += ((w[i] - s.head[i]) * 150 - 16 * s.headV[i]) * dt; s.head[i] += s.headV[i] * dt; }
  const k = 1 - Math.exp(-6 * dt);
  s.yaw += (0.32 * g[0] - s.yaw) * k; s.pitch += (0.25 * g[1] - s.pitch) * k; s.roll += (0.04 * Math.sin(0.7 * s.t + s.phase) - s.roll) * k;
  const ears = b.ears ?? 0;
  if (!b.breathe && s.t > s.twitchAt) { s.earV[s.random() < 0.5 ? 0 : 1] += between(s, [5, 9]); s.twitchAt = s.t + between(s, [2.5, 8]); }
  s.earV[0] -= s.headV[0] * dt * 30; s.earV[1] += s.headV[0] * dt * 30;
  for (const i of [0, 1] as const) { s.earV[i] += (-120 * (s.ear[i] - ears) - 7 * s.earV[i]) * dt; s.ear[i] += s.earV[i] * dt; s.ear[i] = Math.max(-0.5, Math.min(0.7, s.ear[i])); }
}
// Fur quality by on-screen size (pixels)
const quality = (px: number): { lo: boolean; n: number; dens: number; len: number } => px < 36 ? { lo: true, n: 6, dens: 34, len: 0.75 } : px < 80 ? { lo: true, n: 10, dens: 44, len: 0.85 } : px < 160 ? { lo: false, n: 16, dens: 56, len: 0.95 } : { lo: false, n: 22, dens: 70, len: 1 };

/* ---------- Accessories: parts and attachment points per job ---------- */
const PI_ROT = 2.641592653589793;
type AttachPoint = 'hat' | 'mortar' | 'face' | 'neck' | 'band' | 'cupL' | 'cupR' | 'ear' | 'eye' | 'top' | 'hand' | 'flank' | 'ground';
interface KitPart { m: string; at: AttachPoint; u?: number; f?: number; rot?: V3; off?: V3 }
const KIT: Record<string, readonly KitPart[]> = {
coffee: [{ m: 'band', at: 'band' }, { m: 'cup', at: 'cupL', u: 1.7 }, { m: 'cup', at: 'cupR', u: 1.7 }, { m: 'coffee', at: 'ground', rot: [0, -0.6, 0], u: 1.6 }],
  pen: [{ m: 'glasses', at: 'face', u: 1.1 }, { m: 'pen', at: 'ear', rot: [-0.2, 0, PI_ROT], u: 1.5 }], baton: [{ m: 'bowtie', at: 'neck', u: 1.25 }, { m: 'baton', at: 'ear', rot: [-0.15, 0, 0.2], u: 1.5 }],
  hammer: [{ m: 'hardhat', at: 'hat', f: 0.8 }, { m: 'hammer', at: 'hand', rot: [0.2, -0.45, -0.5], u: 1.6 }], wrench: [{ m: 'cap_mech', at: 'hat', f: 0.84, rot: [0, 0.5, 0.1] }, { m: 'wrench', at: 'hand', rot: [0.2, -0.45, -0.5], u: 1.6 }],
  envelope: [{ m: 'cap_post', at: 'hat', f: 0.84 }, { m: 'envelope', at: 'flank', u: 1.5 }], quill: [{ m: 'quill', at: 'ear', rot: [-0.2, 0.5, -0.5], u: 1.8 }, { m: 'inkpot', at: 'ground', rot: [0, -0.3, 0], u: 2.1 }],
  brush: [{ m: 'beret', at: 'hat', f: 0.86, rot: [0, 0, -0.16] }, { m: 'brush', at: 'ear', rot: [-0.2, 0, -0.5], u: 1.5 }], calculator: [{ m: 'calculator', at: 'flank', u: 1.65 }],
  clipboard: [{ m: 'clipboard', at: 'flank', u: 1.5 }, { m: 'pen', at: 'ear', rot: [-0.2, 0, PI_ROT], u: 1.5 }], loupe: [{ m: 'loupe', at: 'eye', rot: [0, 0.25, 0], u: 1.3 }],
  telescope: [{ m: 'telescope', at: 'top', rot: [0, -0.6, 0.25], u: 2 }], teacher: [{ m: 'cap', at: 'mortar', u: 1.9 }, { m: 'teacher', at: 'flank', u: 1.45 }],
  calendar: [{ m: 'calendar', at: 'flank', u: 1.6 }], hourglass: [{ m: 'hourglass', at: 'ground', rot: [0, -0.4, 0], u: 1.6 }], chart: [{ m: 'chart', at: 'flank', u: 1.55 }],
  globe: [{ m: 'globe', at: 'ground', rot: [0.1, -0.4, 0], u: 1.6 }], megaphone: [{ m: 'megaphone', at: 'ground', rot: [0, -0.7, 0.3], u: 1.55 }], shield: [{ m: 'shield', at: 'flank', u: 1.6 }],
  whip: [{ m: 'whip', at: 'hand', rot: [0.1, -0.3, -0.1], u: 1.5, off: [-0.09, 0.02, 0.02] }], wizard: [{ m: 'wizard_hat', at: 'hat', f: 0.8 }, { m: 'wand', at: 'hand', rot: [0.2, -0.45, -0.5], u: 1.5 }],
  chef: [{ m: 'toque', at: 'hat', f: 0.8 }, { m: 'whisk', at: 'hand', rot: [0.2, -0.45, -0.5], u: 1.5 }], crown: [{ m: 'crown', at: 'hat', f: 0.88 }], idea: [{ m: 'bulb', at: 'top', rot: [0, 0, -0.35], u: 1.75 }],
  rocket: [{ m: 'rocket', at: 'ground', rot: [0, -0.4, 0], u: 1.9 }], chemist: [{ m: 'glasses', at: 'face', u: 1.1 }, { m: 'flask', at: 'ground', rot: [0, -0.3, 0], u: 1.75 }],
  gamer: [{ m: 'band', at: 'band' }, { m: 'cup', at: 'cupL', u: 1.7 }, { m: 'cup', at: 'cupR', u: 1.7 }, { m: 'gamepad', at: 'flank', u: 1.45 }], photographer: [{ m: 'camera', at: 'flank', u: 1.45 }],
  gardener: [{ m: 'straw_hat', at: 'hat', f: 0.8 }, { m: 'plant', at: 'ground', rot: [0, -0.4, 0], u: 2.1 }], musician: [{ m: 'guitar', at: 'ground', rot: [0, -0.5, 0.18], u: 1.35 }] };
const GLASS: Record<string, number> = { loupe: 0, hourglass: 2, coffee: 3, flask: 8 }, ANIMATED: Record<string, number> = { globe: 1, whip: 4, wand: 5, bulb: 6, rocket: 7, plant: 9 };
const ACC_UNIT = 1.04 / 82;
const interp = (arr: Float32Array, t: number): number => { const n = arr.length - 1, x = Math.max(0, Math.min(n, t * n)), i = Math.min(n - 1, Math.floor(x)), a = arr[i] ?? 0, b = arr[i + 1] ?? a; return a + (b - a) * (x - i); };
/** Measurements of a skull (ears excluded), used to place accessories. */
interface SkullMeasure { height: number; headY: number; earX: number; earY: number; k: number; frontZ: number; midHW: number; botHW: number; hwAt: (t: number) => number; fzAt: (t: number) => number }
interface Attachment { x: number; y: number; z: number; pitch: number; yaw: number; roll: number; sx: number; sy: number; sz: number; follow: 'head' | 'neck' | 'body' | 'ground' }
// Attaching a part to the skull (shape measured from its vertices)
function attach(p: KitPart, sk: SkullMeasure, tilt: number, minY: number): Attachment {
  const u = ACC_UNIT * (p.u ?? 1), hs = sk.headY / 0.44, rot = p.rot ?? [0, 0, 0], roll0 = p.at === 'flank' && !p.rot ? -(tilt * Math.PI) / 180 : 0;
  let x = 0, y = 0, z = 0, yaw = rot[1], pitch = rot[0], sx = u, sy = u, sz = u;
  const earY = sk.earY + 0.06;
  let follow: Attachment['follow'] = 'head';
  switch (p.at) {
    case 'hat': { const f = p.f ?? 0.75, hw = sk.hwAt(f) + 0.085; y = f * sk.height; sx = sy = hw / 10; sz = (sk.fzAt(f) + 0.085) / 10; break; }
    case 'mortar': y = sk.height + 0.07; break;
    case 'face': y = 0.528 * hs; z = sk.frontZ + 0.075; sx = sy = sz = u / sk.k; break;
    case 'neck': y = 0.2 * hs; z = sk.fzAt(0.2 * hs / sk.height) + 0.1; pitch = -0.2; follow = 'neck'; break;
    case 'band': y = earY; sx = sz = (sk.earX + 0.24) / 10; sy = (sk.height + 0.13 - earY) / 10; break;
    case 'cupL': case 'cupR': { const s = p.at === 'cupL' ? 1 : -1; x = s * (sk.earX + 0.13); y = earY; z = 0.1; yaw = 1.05 * s; break; }
    case 'ear': x = sk.earX + 0.1; y = sk.earY + 0.33; z = 0.03; break;
    case 'eye': x = 0.126 / sk.k + 0.012; y = 0.54 * hs; z = sk.frontZ + 0.13; break;
    case 'top': x = 0.12; y = sk.height + 0.1; z = 0.12; break;
    case 'hand': x = sk.midHW + 0.1; y = 0.3 * hs; z = 0.65 * sk.frontZ; follow = 'body'; break;
    case 'flank': x = 0.6816387600233341 * sk.midHW + 0.12; z = 0.7316888688738209 * sk.frontZ + 0.2; y = 0.2 * hs + 0.02; yaw = 0.6; pitch = -0.15; follow = 'body'; break;
    case 'ground': x = sk.botHW + 0.1; z = 0.42; y = -minY * u; follow = 'ground'; break;
  }
  if (p.off) { x += p.off[0]; y += p.off[1]; z += p.off[2]; }
  return { x, y, z, pitch, yaw, roll: rot[2] + roll0, sx, sy, sz, follow };
}

/* ---------- Shaders (copied from the Timon engine) ---------- */
const POSE_GLSL = `uniform highp sampler2D uPose;
  mat4 boneRow(int b,int r){return mat4(texelFetch(uPose,ivec2(b*4,r),0),texelFetch(uPose,ivec2(b*4+1,r),0),texelFetch(uPose,ivec2(b*4+2,r),0),texelFetch(uPose,ivec2(b*4+3,r),0));}
  mat4 bone(int b,float f){int r=int(f);float t=f-float(r);return t<.001?boneRow(b,r):boneRow(b,r)*(1.-t)+boneRow(b,r+1)*t;}
  uniform float uHeadY;
  #define HEAD_PIV vec3(0.,uHeadY,0.)
  mat3 lookMat(vec3 l){float cy=cos(l.x),sy=sin(l.x),cp=cos(l.y),sp=sin(l.y),ct=cos(l.z),st=sin(l.z);
    return mat3(cy,0.,-sy,0.,1.,0.,sy,0.,cy)*mat3(1.,0.,0.,0.,cp,sp,0.,-sp,cp)*mat3(ct,st,0.,-st,ct,0.,0.,0.,1.);}`;
const FUR_VS = `attribute vec2 aFE;attribute vec4 aSkin;attribute float iShell;
  ${POSE_GLSL}
  uniform float uFurLen;uniform vec3 uPivL;uniform vec3 uPivR;uniform vec3 uColor;uniform vec3 uVel;
  uniform float uFrame;uniform vec2 uEar;uniform vec3 uLook;uniform float uShells;
  varying vec3 vRest;varying vec3 vN;varying float vH;varying float vFur;varying vec3 vWP;varying float vEdge;
  mat3 rotZ(float a){float c=cos(a),s=sin(a);return mat3(c,s,0.,-s,c,0.,0.,0.,1.);}
  void main(){
    vec3 p=position,n=normal;float aEar=aFE.y;vec2 aJ=aSkin.xy,aW=aSkin.zw;
    if(aEar!=0.){vec3 piv=aEar>0.?uPivL:uPivR;mat3 R=rotZ(aEar>0.?-uEar.x:uEar.y);p=R*(p-piv)+piv;n=R*n;}
    float hw=(aJ.x>.5?aW.x:0.)+(aJ.y>.5?aW.y:0.);
    if(hw>0.&&dot(uLook,uLook)>0.){mat3 L=lookMat(uLook);p=mix(p,L*(p-HEAD_PIV)+HEAD_PIV,hw);n=mix(n,L*n,hw);}
    if(uFrame>0.){mat4 S=bone(int(aJ.x),uFrame)*aW.x+bone(int(aJ.y),uFrame)*aW.y;p=(S*vec4(p,1.)).xyz;n=mat3(S)*n;}
    vec4 wp=modelMatrix*vec4(p,1.);
    vec3 wn=normalize(mat3(modelMatrix)*n);float sc=length(modelMatrix[0].xyz);
    float edge=1.-abs(dot(wn,normalize(cameraPosition-wp.xyz)));
    float h=uShells>1.?iShell/(uShells-1.):0.;
    float L=uFurLen*aFE.x*sc*mix(1.,.55,edge*edge);vEdge=edge;
    vec3 droop=vec3(0.,-.55,0.)-clamp(uVel*.03,vec3(-.9),vec3(.9));
    wp.xyz+=wn*L*h+droop*L*h*h;
    vRest=position;vN=wn;vH=h;vFur=aFE.x;vWP=wp.xyz;
    gl_Position=projectionMatrix*viewMatrix*wp;}`;
const FUR_FS = `uniform float uDens;uniform vec3 uLight;uniform vec3 uRim;uniform vec3 uColor;
  varying vec3 vRest;varying vec3 vN;varying float vH;varying float vFur;varying vec3 vWP;varying float vEdge;
  float h13(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
  vec3 h33(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
  void main(){
    float h=vH,a=1.;
    if(h>0.){
      if(vFur<.04)discard;
      vec3 q=vRest*uDens,c=floor(q),f=fract(q);
      float r=h13(c+7.),len=.5+.5*r;
      if(h>len)discard;
      float d=length(f-(h33(c)*.6+.2)),rad=.5*(1.-h/len)+.08,w=fwidth(d)+.06;
      a=(1.-smoothstep(rad-w,rad+w,d))*(1.-smoothstep(.35,1.,h)*smoothstep(.3,.9,vEdge)*.85);
      if(a<.03)discard;
    }
    vec3 N=normalize(vN),V=normalize(cameraPosition-vWP);
    float wrap=clamp(dot(N,uLight)*.5+.5,0.,1.);
    float rim=pow(1.-clamp(dot(N,V),0.,1.),2.4);
    vec3 base=uColor*mix(.32,1.12,h);
    gl_FragColor=vec4(base*(.22+.9*wrap)+uRim*rim*(.2+.9*h)*(.55+.45*uColor),a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const VISOR_VS = `uniform float uFrame;uniform vec3 uLook;varying vec2 vUv;varying vec3 vN;varying vec3 vWP;
  ${POSE_GLSL}
  void main(){mat4 B=uFrame>0.?bone(1,uFrame):mat4(1.);
    mat3 L=lookMat(uLook);vec3 p=L*(position-HEAD_PIV)+HEAD_PIV;
    mat4 M=modelMatrix*B;vec4 wp=M*vec4(p,1.);vUv=uv;
    vN=normalize(mat3(M)*(L*normal));vWP=wp.xyz;gl_Position=projectionMatrix*viewMatrix*wp;}`;
const VISOR_FS = `uniform sampler2D uAtlas;uniform float uExpr;uniform float uExpr2;uniform float uMix;uniform float uBlink;uniform float uGlow;uniform float uAspect;varying vec2 vUv;varying vec3 vN;varying vec3 vWP;
  float cell(float e,vec2 uv){e=floor(e+.5);float col=mod(e,${ATLAS_COLS}.),row=floor(e/${ATLAS_COLS}.);
    return texture2D(uAtlas,vec2((clamp(uv.x,.004,.996)+col)/${ATLAS_COLS}.,(clamp(uv.y,.006,.994)+${ATLAS_ROWS - 1}.-row)/${ATLAS_ROWS}.)).r*${SDF_HI.toFixed(3)}-${SDF_LO.toFixed(3)};}
  void main(){
    vec2 uv=vec2(.5+(vUv.x-.5)*uAspect,.52+(vUv.y-.52)/max(uBlink,.06));
    float d=mix(cell(uExpr,uv),cell(uExpr2,uv),smoothstep(0.,1.,uMix));
    float aa=max(fwidth(d),.003);
    vec3 a=vec3(1.-smoothstep(-aa,aa,d),exp(-max(d,0.)/.035),0.);
    vec3 N=normalize(vN),V=normalize(cameraPosition-vWP),R=reflect(-V,N);
    float fr=pow(1.-clamp(dot(N,V),0.,1.),3.);
    float spec=pow(clamp(dot(R,normalize(vec3(-.45,.75,.5))),0.,1.),80.)*2.+smoothstep(.35,.95,R.y)*.05;
    vec3 base=vec3(.003)+vec3(.55,.5,.48)*fr*.3+vec3(1.,.95,.9)*spec;
    gl_FragColor=vec4(base+vec3(1.,.58,.24)*(a.r*4.5+pow(a.g,1.6)*.9)*uGlow,1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const ACC_VS = `attribute vec4 color;uniform float uMode;uniform float uT;uniform float uPhase;uniform float uGlass;
  varying float vA;varying float vE;varying vec3 vC;varying vec3 vN;varying vec3 vWP;
  bool is(vec3 c){return distance(color.rgb*255.,c)<.6;}
  float glassR(float y){return 1.3+5.2*pow(abs(y)/9.5,.75);}
  void main(){
    vec3 p=position,n=normal;vA=1.;vE=0.;
    if(distance(color.rgb,vec3(.812,.914,1.))<.03)vA=uGlass;
    if(uMode==1.&&color.g>.5){float c=cos(uT*.7),s=sin(uT*.7);mat3 T=mat3(.9205,.3907,0.,-.3907,.9205,0.,0.,0.,1.);mat3 R=T*mat3(c,0.,-s,0.,1.,0.,s,0.,c)*transpose(T);p=R*p;n=R*n;}
    if(uMode==2.){
      float b=floor(color.b*255.+.5);
      if(b==51.){float y1=.9+(p.y-.9)*(1.-uPhase);float k=glassR(y1)/glassR(p.y);p=vec3(p.x*k,y1,p.z*k);}
      else if(b==52.){float s=mix(.2,1.,uPhase);p=vec3(p.x*s,-9.3+(p.y+9.3)*s,p.z*s);}
      else if(b==53.){p.xz*=step(uPhase,.95)*step(.001,uPhase);}
    }
    if(abs(color.b-.9961)<.002&&color.r<.999){
      float h=clamp((p.y-9.)/10.,0.,1.);
      p.x+=sin(p.y*.7-uT*2.5)*1.1*h*step(.5,uMode);
      vA=.6*(1.-h)*(.65+.35*sin(p.y*1.3-uT*3.));
    }
    if(uMode==4.&&color.a>0.){
      float s=color.a,c=fract(uT/3.6),e=smoothstep(0.,.07,c)*(1.-smoothstep(.1,.5,c));
      p.x+=sin(uT*2.3-s*5.)*1.*s*s+e*(-3.*s*s+sin(s*7.-c*46.)*1.6*s);
      p.z+=cos(uT*1.8-s*4.)*1.2*s*s+e*5.*s*s;
      p.y+=e*(10.*s*s+cos(s*7.-c*46.)*2.2*s);
    }
    if(uMode==5.&&is(vec3(255.,216.,75.))){float c=cos(uT*2.2),s=sin(uT*2.2);p.xz=mat2(c,-s,s,c)*p.xz;n.xz=mat2(c,-s,s,c)*n.xz;}
    if(is(vec3(255.,230.,128.)))vE=.5+(uMode==6.?.3*sin(uT*2.6):0.);
    if(uMode==7.&&(is(vec3(255.,122.,26.))||is(vec3(255.,210.,62.)))){
      float k=1.+.22*sin(uT*23.)+.12*sin(uT*37.+1.);p.y=-10.4+(p.y+10.4)*k;p.xz*=1.+.1*sin(uT*29.);vE=.6;}
    if(is(vec3(255.,122.,26.))||is(vec3(255.,210.,62.)))vE=max(vE,.45);
    if(uMode==8.&&is(vec3(200.,255.,224.))){float f=fract(uT*.32+color.a);p.y+=-2.+f*17.;p.x+=sin(uT*3.+color.a*9.)*.6*f;vA=1.-smoothstep(.75,1.,f);}
    if(uMode==9.&&color.a>0.){float s=color.a;p.x+=sin(uT*1.5)*1.1*s*s;p.z+=cos(uT*1.2+.6)*.7*s*s;p.y-=abs(sin(uT*1.5))*.25*s;}
    vec4 wp=modelMatrix*vec4(p,1.);vC=pow(color.rgb,vec3(2.2));vN=normalize(mat3(modelMatrix)*n);vWP=wp.xyz;gl_Position=projectionMatrix*viewMatrix*wp;}`;
const ACC_FS = `uniform vec3 uLight;varying float vA;varying float vE;varying vec3 vC;varying vec3 vN;varying vec3 vWP;
  void main(){
    vec3 N=normalize(vN),V=normalize(cameraPosition-vWP);
    float wrap=clamp(dot(N,uLight)*.5+.5,0.,1.);
    float spec=pow(clamp(dot(reflect(-V,N),uLight),0.,1.),24.)*.18;
    float rim=pow(1.-clamp(dot(N,V),0.,1.),3.)*.12;
    gl_FragColor=vec4(mix(vC*(.3+.85*wrap),vC*1.35,vE)+vec3(spec+rim),vA);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
// The fur is opaque (alpha-to-coverage) but must not be darkened by the skin below
function furBlending(m: THREE.ShaderMaterial): void {
  m.alphaToCoverage = true; m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.ZeroFactor;
  m.blendEquationAlpha = THREE.MaxEquation; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneFactor;
}

/* ---------- Factory ---------- */
/** A Tim placed in a scene. */
export interface Tim {
  /** Group to place: the Tim's base is at its origin, facing +z. */
  object: THREE.Group;
  look: TimLook;
  /** Changes the behaviour: idle, working, coding, waiting, done, error, sleeping…; unknown states are ignored. */
  setState(s: string): void;
  /** Attaches an object in front of the visor (space: visor width and height); it follows the head. */
  onVisor(mesh: THREE.Mesh): { width: number; height: number };
  readonly state: string;
  update(dt: number, camera?: THREE.PerspectiveCamera, viewH?: number): void;
  dispose(): void;
}
export interface Tims { make(look: TimLook, opts?: { height?: number; seed?: number; eyes?: boolean }): Tim; dispose(): void }
interface Skull {
  sk: SkullMeasure; poses: Float32Array; bones: number; rows: number; hi: THREE.BufferGeometry; lo: THREE.BufferGeometry;
  visorGeo: THREE.BufferGeometry; poseTex: THREE.DataTexture; k: number; pivL: THREE.Vector3; pivR: THREE.Vector3;
  headY: number; aspect: number; furLength: number; visorBox: THREE.Box3 | null;
}
const FUR_UNIFORMS = ['uDens', 'uFurLen', 'uShells', 'uPose', 'uHeadY', 'uPivL', 'uPivR', 'uColor', 'uVel', 'uFrame', 'uEar', 'uLook', 'uLight'] as const;
const VISOR_UNIFORMS = ['uPose', 'uHeadY', 'uAspect', 'uExpr', 'uExpr2', 'uMix', 'uBlink', 'uFrame', 'uLook', 'uGlow', 'uAtlas'] as const;
const ACC_UNIFORMS = ['uMode', 'uT', 'uPhase', 'uLight'] as const;
const isTimState = (s: string): s is TimState => Object.prototype.hasOwnProperty.call(STATES, s);

/** Builds the shared materials and geometries; `make(look, { height })` creates one Tim, `dispose()` frees everything. */
export function createTims(data: Tim3DData): Tims {
  const light = new THREE.Vector3(-0.45, 0.8, 0.55).normalize();
  const own: { dispose(): void }[] = [];
  const atlasData = buildAtlas();
  const atlas = new THREE.DataTexture(atlasData.data, atlasData.w, atlasData.h, THREE.RedFormat, THREE.UnsignedByteType);
  atlas.minFilter = atlas.magFilter = THREE.LinearFilter; atlas.needsUpdate = true; own.push(atlas);
  const furBase = new THREE.ShaderMaterial({ vertexShader: FUR_VS, fragmentShader: FUR_FS, uniforms: {
    uPose: { value: null }, uHeadY: { value: 0.44 }, uFurLen: { value: 0.095 }, uDens: { value: 70 }, uPivL: { value: new THREE.Vector3() }, uPivR: { value: new THREE.Vector3() },
    uLight: { value: light }, uRim: { value: new THREE.Color(1, 0.62, 0.34).multiplyScalar(1.5) }, uColor: { value: new THREE.Color() }, uVel: { value: new THREE.Vector3() },
    uFrame: { value: 0 }, uEar: { value: new THREE.Vector2() }, uLook: { value: new THREE.Vector3() }, uShells: { value: 22 } } });
  furBlending(furBase);
  const visorBase = new THREE.ShaderMaterial({ vertexShader: VISOR_VS, fragmentShader: VISOR_FS, uniforms: {
    uHeadY: { value: 0.44 }, uPose: { value: null }, uAspect: { value: 1 }, uAtlas: { value: atlas }, uExpr: { value: 0 }, uExpr2: { value: 0 }, uMix: { value: 0 },
    uBlink: { value: 1 }, uFrame: { value: 0 }, uLook: { value: new THREE.Vector3() }, uGlow: { value: 1 } } });
  const accBase = (glass: boolean): THREE.ShaderMaterial => {
    const m = new THREE.ShaderMaterial({ vertexShader: ACC_VS, fragmentShader: ACC_FS, uniforms: {
      uLight: { value: light }, uGlass: { value: glass ? 0.25 : 1 }, uMode: { value: 0 }, uT: { value: 0 }, uPhase: { value: 0.35 } } });
    if (glass) { m.transparent = true; m.depthWrite = false; }
    return m;
  };
  const accSolid = accBase(false), accGlass = accBase(true);
  own.push(furBase, visorBase, accSolid, accGlass);

  // Per skull shape: geometries, poses (half-float texture) and measurements for accessories
  const bodyGeo = (b: BodyData): { geo: THREE.BufferGeometry; positions: Float32Array; ears: Float32Array } => {
    const g = new THREE.BufferGeometry(), pos = decodeFloats(b.pos);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(decodeFloats(b.nrm), 3));
    const fur = decodeFloats(b.fur), ear = decodeFloats(b.ear), j = decodeFloats(b.j), w = decodeFloats(b.w), n = fur.length, fe = new Float32Array(2 * n), sk = new Float32Array(4 * n);
    for (let i = 0; i < n; i++) { fe[2 * i] = fur[i] ?? 0; fe[2 * i + 1] = Math.round(ear[i] ?? 0); sk[4 * i] = j[2 * i] ?? 0; sk[4 * i + 1] = j[2 * i + 1] ?? 0; sk[4 * i + 2] = w[2 * i] ?? 0; sk[4 * i + 3] = w[2 * i + 1] ?? 0; }
    g.setAttribute('aFE', new THREE.BufferAttribute(fe, 2)); g.setAttribute('aSkin', new THREE.BufferAttribute(sk, 4));
    g.setIndex(new THREE.BufferAttribute(decodeArray(b.idx), 1));
    g.setAttribute('iShell', new THREE.InstancedBufferAttribute(Float32Array.from({ length: 22 }, (_, i) => i), 1));
    own.push(g);
    return { geo: g, positions: pos, ears: ear };
  };
  const skulls = new Map<ShapeData, Skull>();
  function skull(shape: string): Skull {
    const d = shapeData(data, shape), cached = skulls.get(d);
    if (cached) return cached;
    const an = d.anim, half = new Uint16Array(bytes(an.data).buffer as ArrayBuffer), poses = Float32Array.from(half, v => THREE.DataUtils.fromHalfFloat(v));
    const poseTex = new THREE.DataTexture(half, 4 * an.bones, an.rows, THREE.RGBAFormat, THREE.HalfFloatType);
    poseTex.minFilter = poseTex.magFilter = THREE.NearestFilter; poseTex.needsUpdate = true; own.push(poseTex);
    const visorGeo = new THREE.BufferGeometry();
    visorGeo.setAttribute('position', new THREE.BufferAttribute(decodeFloats(d.visor.pos), 3)); visorGeo.setAttribute('normal', new THREE.BufferAttribute(decodeFloats(d.visor.nrm), 3));
    visorGeo.setAttribute('uv', new THREE.BufferAttribute(decodeFloats(d.visor.uv), 2)); visorGeo.setIndex(new THREE.BufferAttribute(decodeArray(d.visor.idx), 1)); own.push(visorGeo);
    const k = Math.min(1, 1.3944 / (2 * d.halfWidth), 1.328 / d.height), hi = bodyGeo(d.body), lo = bodyGeo(d.bodyLo);
    // Skull measurements (ears excluded): face advance, half-widths, profile by height
    const P = hi.positions, E = hi.ears, prof = new Float32Array(21), front = new Float32Array(21);
    let frontZ = 0, midHW = 0, botHW = 0;
    for (let i = 0; i < P.length / 3; i++) {
      if (Math.round(E[i] ?? 0) !== 0) continue;
      const x = Math.abs(P[3 * i] ?? 0), y = P[3 * i + 1] ?? 0, z = P[3 * i + 2] ?? 0, t = y / d.height;
      if (z > frontZ) frontZ = z;
      if (t > 0.15 && t < 0.4 && x > midHW) midHW = x;
      if (t < 0.2 && x > botHW) botHW = x;
      const b = Math.max(0, Math.min(20, Math.round(20 * t))); prof[b] = Math.max(prof[b] ?? 0, x); front[b] = Math.max(front[b] ?? 0, z);
    }
    const sk: SkullMeasure = { height: d.height, headY: d.headPivot, earX: d.earPivot.L[0], earY: d.earPivot.L[1], k, frontZ, midHW, botHW, hwAt: t => interp(prof, t), fzAt: t => interp(front, t) };
    const s: Skull = { sk, poses, bones: an.bones, rows: an.rows, hi: hi.geo, lo: lo.geo, visorGeo, poseTex, k, pivL: new THREE.Vector3(...d.earPivot.L), pivR: new THREE.Vector3(...d.earPivot.R),
      headY: d.headPivot, aspect: d.visorAspect, furLength: d.furLength, visorBox: null };
    skulls.set(d, s);
    return s;
  }
  const accGeos = new Map<string, THREE.BufferGeometry>();
  function accGeo(name: string): THREE.BufferGeometry | null {
    const known = accGeos.get(name);
    if (known) return known;
    const a = data.accessories[name]; if (!a) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(decodeFloats(a.pos), 3)); g.setAttribute('normal', new THREE.BufferAttribute(decodeFloats(a.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(bytes(a.col), 4, true)); g.setIndex(new THREE.BufferAttribute(decodeArray(a.idx), 1)); g.computeBoundingBox();
    accGeos.set(name, g); own.push(g);
    return g;
  }

  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _b = new THREE.Matrix4(), _w = new THREE.Vector3();
  function boneMatrix(S: Skull, bone: number, row: number, out: THREE.Matrix4): THREE.Matrix4 {
    if (!(row > 0)) return out.identity();
    const r = Math.min(S.rows - 1, Math.floor(row)), t = r + 1 < S.rows ? row - r : 0, el = out.elements, i0 = (r * S.bones + bone) * 16, i1 = i0 + 16 * S.bones;
    for (let i = 0; i < 16; i++) { const a = S.poses[i0 + i] ?? 0; el[i] = t < 1e-3 ? a : a * (1 - t) + (S.poses[i1 + i] ?? a) * t; }
    return out;
  }
  function headMatrix(S: Skull, sim: Sim, U: THREE.Matrix4, out: THREE.Matrix4, amount = 1, bone = 1): THREE.Matrix4 {
    _e.set(sim.head[1] * amount, sim.head[0] * amount, sim.head[2] * amount, 'YXZ'); _q2.setFromEuler(_e);
    return out.copy(U).multiply(boneMatrix(S, bone, sim.row, _b)).multiply(_m.makeTranslation(0, S.headY, 0)).multiply(_m.makeRotationFromQuaternion(_q2)).multiply(_m.makeTranslation(0, -S.headY, 0));
  }

  // Centre and size of a skull's visor (model space), to attach an element to it (onVisor)
  const visorBox = (S: Skull): THREE.Box3 => {
    if (!S.visorBox) { S.visorGeo.computeBoundingBox(); S.visorBox = S.visorGeo.boundingBox ?? new THREE.Box3(); }
    return S.visorBox;
  };
  function make(look: TimLook, { height = 1, seed, eyes = true }: { height?: number; seed?: number; eyes?: boolean } = {}): Tim {
    const S = skull(look.shape || 'squircle'), sim = newSim(seed !== undefined ? mulberry(seed) : Math.random), base = baseEyes(look.eyes);
    let state: TimState = 'idle'; stepSim(sim, 0, state, base);
    const object = new THREE.Group(), body = new THREE.Group(); object.add(body);
    const furMat = furBase.clone(), visorMat = visorBase.clone(); furBlending(furMat);
    const fu = bindUniforms(furMat, FUR_UNIFORMS), vu = bindUniforms(visorMat, VISOR_UNIFORMS);
    fu.uLight.value = light; vu.uAtlas.value = atlas;
    const fur = new THREE.InstancedMesh(S.hi, furMat, 22); for (let i = 0; i < 22; i++) fur.setMatrixAt(i, new THREE.Matrix4());
    const visor = new THREE.Mesh(S.visorGeo, visorMat);
    for (const m of [fur, visor]) { m.frustumCulled = false; m.matrixAutoUpdate = false; body.add(m); }
    const color = new THREE.Color(look.color || '#7a4f35');
    const parts: { p: KitPart; mesh: THREE.Mesh; mat: THREE.ShaderMaterial; u: Record<typeof ACC_UNIFORMS[number], THREE.IUniform>; glass: boolean; mode: number; tilt: number }[] = [];
    for (const p of KIT[look.acc ?? ''] ?? []) {
      const geo = accGeo(p.m); if (!geo) continue;
      const glass = Object.prototype.hasOwnProperty.call(GLASS, p.m), mat = (glass ? accGlass : accSolid).clone();
      const u = bindUniforms(mat, ACC_UNIFORMS);
      u.uLight.value = light;
      const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; body.add(mesh);
      parts.push({ p, mesh, mat, u, glass, mode: ANIMATED[p.m] ?? GLASS[p.m] ?? 0, tilt: data.accessories[p.m]?.tilt ?? 0 });
    }
    const U = new THREE.Matrix4(), overlays: { matrix: THREE.Matrix4; at: THREE.Vector3 }[] = [];
    function update(dt: number, camera?: THREE.PerspectiveCamera, viewH = 800): void {
      stepSim(sim, Math.min(dt, 0.05), state, base);
      // Level of detail: on-screen height of the Tim
      object.getWorldPosition(_w);
      const dist = camera ? Math.max(0.01, camera.position.distanceTo(_w)) : 5, fov = camera?.fov ?? 30;
      const px = height / (2 * dist * Math.tan(fov * Math.PI / 360)) * viewH, Q = quality(px);
      fur.geometry = Q.lo ? S.lo : S.hi; fur.count = Q.n;
      fu.uDens.value = Q.dens; fu.uFurLen.value = S.furLength * Q.len; fu.uShells.value = Q.n; fu.uPose.value = S.poseTex; fu.uHeadY.value = S.headY;
      fu.uPivL.value.copy(S.pivL); fu.uPivR.value.copy(S.pivR); fu.uColor.value.copy(color); fu.uVel.value.set(sim.vel[0], sim.vel[1], 0);
      fu.uFrame.value = sim.row; fu.uEar.value.set(sim.ear[0], sim.ear[1]); fu.uLook.value.set(sim.head[0], sim.head[1], sim.head[2]);
      vu.uPose.value = S.poseTex; vu.uHeadY.value = S.headY; vu.uAspect.value = S.aspect; vu.uExpr.value = sim.from; vu.uExpr2.value = sim.to; vu.uMix.value = sim.mix;
      vu.uBlink.value = sim.blink; vu.uFrame.value = sim.row; vu.uLook.value.copy(fu.uLook.value); vu.uGlow.value = eyes ? sim.glow : 0;
      // Body: bounce, squash, breathing; size scaled to `height`
      const kk = S.k * height, sq = 1 + sim.squash + sim.breath, st = 1 - 0.55 * sim.squash - 0.4 * sim.breath;
      _e.set(sim.pitch, sim.yaw, sim.roll, 'YXZ'); _q.setFromEuler(_e);
      _p.set(0, sim.y * kk, 0); _s.set(st * kk, sq * kk, st * kk); U.compose(_p, _q, _s);
      fur.matrix.copy(U); visor.matrix.copy(U);
      const cycle = sim.t % 9 / 9, flip = cycle > 0.9 ? Math.PI * (0.5 - 0.5 * Math.cos(Math.PI * (cycle - 0.9) / 0.1)) : 0;
      for (const a of parts) {
        if (a.mode || a.glass) { a.u.uMode.value = a.mode; a.u.uT.value = sim.t; a.u.uPhase.value = Math.min(1, cycle / 0.88); }
        const T = attach(a.p, S.sk, a.tilt, a.mesh.geometry.boundingBox?.min.y ?? 0);
        _e.set(T.pitch, T.yaw, T.roll, 'YXZ'); _q2.setFromEuler(_e); _p.set(T.x, T.y, T.z); _s.set(T.sx, T.sy, T.sz);
        const local = new THREE.Matrix4().compose(_p, _q2, _s); if (flip && a.p.m === 'hourglass') local.multiply(_m.makeRotationZ(flip));
        const M = a.mesh.matrix;
        if (T.follow === 'ground') { _e.set(0, 0, 1.6 * sim.squash, 'YXZ'); const gq = new THREE.Quaternion().setFromEuler(_e); M.compose(_p.set(0, sim.y * kk, 0), _q, _s.set(kk, kk, kk)).multiply(_m.makeRotationFromQuaternion(gq)).multiply(local); }
        else if (T.follow === 'neck') headMatrix(S, sim, U, M, 0.7, 0).multiply(local);
        else if (T.follow === 'body') M.copy(U).multiply(boneMatrix(S, 0, sim.row, _b)).multiply(local);
        else headMatrix(S, sim, U, M).multiply(local);
      }
      for (const o of overlays) headMatrix(S, sim, U, o.matrix).multiply(_m.makeTranslation(o.at.x, o.at.y, o.at.z));
    }
    return {
      object, look,
      setState(s: string): void { if (isTimState(s)) state = s; },
      onVisor(mesh: THREE.Mesh): { width: number; height: number } {
        const b = visorBox(S), c = b.getCenter(new THREE.Vector3()); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; body.add(mesh);
        overlays.push({ matrix: mesh.matrix, at: new THREE.Vector3(c.x, c.y, b.max.z + 0.004) });
        return { width: b.max.x - b.min.x, height: b.max.y - b.min.y };
      },
      get state(): string { return state; },
      update,
      dispose(): void { furMat.dispose(); visorMat.dispose(); for (const a of parts) a.mat.dispose(); object.removeFromParent(); },
    };
  }
  return { make, dispose(): void { for (const o of own) o.dispose(); } };
}
// Reproducible randomness per Tim (same gestures on every mount)
function mulberry(a: number): () => number { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
