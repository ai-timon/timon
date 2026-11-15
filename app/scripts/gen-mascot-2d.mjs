#!/usr/bin/env node
/**
 * Generates `src/components/mascot/mascot-2d-data.ts`: the flat outlines the
 * 2D mascot draws, taken from the 3D model data (`three/agent-data.json`).
 *
 * The 2D style is the same character as the 3D one, drawn flat for light
 * machines and browsers without WebGL2. Rather than redraw seven skulls by
 * hand (and drift from the models at every change), each skull is seen
 * through the 3D engine's own camera: its triangles are projected into the
 * 100×100 box of the SVG, filled into a fine grid, and the edge of that
 * silhouette is traced and smoothed into a closed path. Same for the two ears
 * and the visor. Re-run after the model data changes:
 *
 *   node scripts/gen-mascot-2d.mjs
 *
 * The visor is one size on every skull (the art direction: the mask never
 * changes whatever the skull). The models already agree within a pixel; the
 * script makes it exact by giving every visor the mean size, centred where
 * the skull's own visor sits.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, '..', 'src', 'components', 'mascot', 'three', 'agent-data.json');
const TARGET = join(here, '..', 'src', 'components', 'mascot', 'mascot-2d-data.ts');
const SHAPES = ['squircle', 'tri', 'gem', 'round', 'bean', 'cloud', 'hex'];

// The 3D engine's framing (`three/place.ts`, `three/engine.ts`): a camera with an 18° field of view frames a
// square of FRAME model units around CENTER_Y, and each skull is scaled (`skullScale`) and lifted (`skullLift`)
// into it. Copied rather than imported: this script runs on plain Node, without the app's TypeScript.
const FRAME = 1.66;
const CENTER_Y = 0.47;
const FOV = 18;
const DIST = FRAME / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
const skullScale = (halfWidth, height) => Math.min(1, (0.84 * FRAME) / (2 * halfWidth), (0.8 * FRAME) / height);
const skullLift = (k, height) => CENTER_Y - k * height * 0.52;

/** How much of the fur's length the flat outline keeps: the SVG's frayed edge draws the tips. */
const FUR_SHOWN = 0.55;
/** Grid step of the silhouettes, in box units. */
const STEP = 0.2;
const GRID = Math.round(120 / STEP);
const ORIGIN = -10;
/** Points of a traced outline before it is smoothed into Bezier curves. */
const BODY_POINTS = 44;
const EAR_POINTS = 20;

function decode(a) {
  const bytes = Buffer.from(a.d, 'base64');
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (a.k === 'u16') return new Uint16Array(buf);
  if (a.k === 'u8') return Float32Array.from(new Uint8Array(buf));
  const q = a.k === 'q16' ? new Uint16Array(buf) : new Uint8Array(buf);
  const max = a.k === 'q16' ? 65535 : 255;
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i += 1) {
    const c = i % a.n;
    out[i] = a.lo[c] + (q[i] / max) * (a.hi[c] - a.lo[c]);
  }
  return out;
}

/** A model point as the camera sees it, in the SVG's box (y down). */
function projector(k, lift) {
  return (x, y, z) => {
    const s = DIST / (DIST - z * k);
    return [50 + ((x * k * s) / FRAME) * 100, 50 - (((y * k + lift - CENTER_Y) * s) / FRAME) * 100];
  };
}

function newGrid() { return new Uint8Array(GRID * GRID); }

/** Fills the cells whose centre falls inside a projected triangle, whatever its winding. */
function fillTriangle(grid, a, b, c) {
  const toCell = (v) => (v - ORIGIN) / STEP;
  const ax = toCell(a[0]); const ay = toCell(a[1]);
  const bx = toCell(b[0]); const by = toCell(b[1]);
  const cx = toCell(c[0]); const cy = toCell(c[1]);
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(GRID - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(GRID - 1, Math.ceil(Math.max(ay, by, cy)));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
      const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) grid[y * GRID + x] = 1;
    }
  }
}

const filled = (grid, x, y) => {
  const gx = Math.floor((x - ORIGIN) / STEP);
  const gy = Math.floor((y - ORIGIN) / STEP);
  return gx >= 0 && gy >= 0 && gx < GRID && gy < GRID && grid[gy * GRID + gx] === 1;
};

function stats(grid) {
  let n = 0; let sx = 0; let sy = 0;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      if (!grid[y * GRID + x]) continue;
      const px = ORIGIN + (x + 0.5) * STEP;
      const py = ORIGIN + (y + 0.5) * STEP;
      n += 1; sx += px; sy += py;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
  }
  const h = STEP / 2;
  return { area: n * STEP * STEP, cx: sx / n, cy: sy / n, minX: minX - h, maxX: maxX + h, minY: minY - h, maxY: maxY + h };
}

/**
 * The silhouette's outer edge, seen from its centre: in each direction, the
 * farthest filled cell. The skulls and ears are star-shaped around their
 * centre, so this keeps every bump of the cloud while ignoring the holes a
 * coarse mesh leaves inside.
 */
function trace(grid, cx, cy, points) {
  const DIRS = 720;
  const raw = [];
  for (let i = 0; i < DIRS; i += 1) {
    const a = (i / DIRS) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let far = 0;
    for (let r = 0; r < 80; r += STEP / 2) if (filled(grid, cx + dx * r, cy + dy * r)) far = r;
    raw.push(far);
  }
  // A light circular smoothing: the grid's stairs are not part of the shape.
  const W = 4;
  const smooth = raw.map((_, i) => {
    let s = 0;
    for (let j = -W; j <= W; j += 1) s += raw[(i + j + DIRS) % DIRS];
    return s / (2 * W + 1);
  });
  const dense = smooth.map((r, i) => {
    const a = (i / DIRS) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  return resample(dense, points);
}

/** A closed outline resampled to `n` points evenly spaced along its length, starting at the top. */
function resample(poly, n) {
  const len = [0];
  for (let i = 1; i <= poly.length; i += 1) {
    const a = poly[i - 1];
    const b = poly[i % poly.length];
    len.push(len[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = len[len.length - 1];
  let top = 0;
  poly.forEach((p, i) => { if (p[1] < poly[top][1]) top = i; });
  const start = len[top];
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (start + (i / n) * total) % total;
    j = 0;
    while (len[j + 1] < d) j += 1;
    const a = poly[j];
    const b = poly[(j + 1) % poly.length];
    const t = (d - len[j]) / ((len[j + 1] - len[j]) || 1);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

const f = (v) => (Math.round(v * 10) / 10).toString();

/** A closed cardinal spline of tension 0 through the points, as cubic Bezier segments: a smooth path from a few points. */
function smoothPath(pts) {
  const n = pts.length;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** Half width of a silhouette at height `y`: the widest filled run of that row, from the centre line. */
function halfWidthAt(grid, y) {
  let w = 0;
  for (let x = ORIGIN; x < ORIGIN + 120; x += STEP) if (filled(grid, x, y)) w = Math.max(w, Math.abs(x - 50));
  return w;
}

const data = JSON.parse(readFileSync(SOURCE, 'utf8'));
const skulls = {};
const visors = {};
for (const name of SHAPES) {
  const s = data.shapes[name];
  if (!s) throw new Error(`model data has no ${name} skull`);
  const k = skullScale(s.halfWidth, s.height);
  const lift = skullLift(k, s.height);
  const project = projector(k, lift);
  const pos = decode(s.body.pos);
  const nrm = decode(s.body.nrm);
  const ear = decode(s.body.ear);
  const idx = decode(s.body.idx);
  const fur = s.furLength * FUR_SHOWN;
  // Each vertex pushed out along its normal by the fur kept in the flat outline.
  const at = (i) => project(pos[i * 3] + nrm[i * 3] * fur, pos[i * 3 + 1] + nrm[i * 3 + 1] * fur, pos[i * 3 + 2] + nrm[i * 3 + 2] * fur);
  const side = (i) => Math.round(ear[i]);
  const body = newGrid();
  const earL = newGrid();
  const earR = newGrid();
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const sides = side(a) + side(b) + side(c);
    // A triangle touching an ear belongs to it: the seam goes with the ear, which is drawn behind the skull.
    const target = side(a) || side(b) || side(c) ? (sides > 0 ? earL : earR) : body;
    fillTriangle(target, at(a), at(b), at(c));
  }
  const visor = newGrid();
  const vp = decode(s.visor.pos);
  const vi = decode(s.visor.idx);
  const vat = (i) => project(vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2]);
  for (let t = 0; t < vi.length; t += 3) fillTriangle(visor, vat(vi[t]), vat(vi[t + 1]), vat(vi[t + 2]));

  const B = stats(body);
  const EL = stats(earL);
  const ER = stats(earR);
  const V = stats(visor);
  const h = B.maxY - B.minY;
  const vw = V.maxX - V.minX;
  const vh = V.maxY - V.minY;
  // A rounded rectangle of this box and this area has corners of this radius.
  const vr = Math.sqrt(Math.max(0, (vw * vh - V.area) / (4 - Math.PI)));
  visors[name] = { cx: (V.minX + V.maxX) / 2, cy: (V.minY + V.maxY) / 2, w: vw, h: vh, r: vr };
  const pivL = project(...s.earPivot.L);
  const pivR = project(...s.earPivot.R);
  skulls[name] = {
    body: smoothPath(trace(body, B.cx, B.cy, BODY_POINTS)),
    // Ears: the model's left (+x) is the viewer's right.
    earL: smoothPath(trace(earR, ER.cx, ER.cy, EAR_POINTS)),
    earR: smoothPath(trace(earL, EL.cx, EL.cy, EAR_POINTS)),
    ears: { L: [ER.cx, ER.cy], R: [EL.cx, EL.cy], pivotL: pivR, pivotR: pivL },
    top: B.minY,
    bottom: B.maxY,
    halfWidth: Math.max(50 - B.minX, B.maxX - 50),
    topWidth: 2 * halfWidthAt(body, B.minY + h * 0.18),
    bottomWidth: 2 * halfWidthAt(body, B.maxY - h * 0.12),
    belly: halfWidthAt(body, B.maxY - h * 0.3),
    earsTop: Math.min(EL.minY, ER.minY),
  };
}

// One visor size for every skull: the mean of the models', which agree within a pixel.
const mean = (key) => SHAPES.reduce((sum, n) => sum + visors[n][key], 0) / SHAPES.length;
const VW = mean('w');
const VH = mean('h');
const VR = mean('r');
const spread = Math.max(...SHAPES.map((n) => Math.abs(visors[n].w - VW)), ...SHAPES.map((n) => Math.abs(visors[n].h - VH)));
if (spread > 1.5) throw new Error(`the models' visors differ by ${spread.toFixed(2)} units: the 3D data broke the one-size rule`);

const r1 = (v) => Math.round(v * 10) / 10;
const lines = SHAPES.map((name) => {
  const S = skulls[name];
  const v = visors[name];
  const visor = { x: r1(v.cx - VW / 2), y: r1(v.cy - VH / 2), w: r1(VW), h: r1(VH), r: r1(VR) };
  return `  ${name}: {
    body: '${S.body}',
    earL: '${S.earL}',
    earR: '${S.earR}',
    ears: { L: [${r1(S.ears.L[0])}, ${r1(S.ears.L[1])}], R: [${r1(S.ears.R[0])}, ${r1(S.ears.R[1])}] },
    visor: { x: ${visor.x}, y: ${visor.y}, w: ${visor.w}, h: ${visor.h}, r: ${visor.r} },
    top: ${r1(S.top)}, bottom: ${r1(S.bottom)}, earsTop: ${r1(S.earsTop)}, halfWidth: ${r1(S.halfWidth)},
    topWidth: ${r1(S.topWidth)}, bottomWidth: ${r1(S.bottomWidth)}, belly: ${r1(S.belly)},
  },`;
});

const out = `/**
 * The 2D mascot's skulls, seen through the 3D engine's camera: the body's
 * silhouette with part of its fur, the two ears, the visor, and a few
 * measures for the accessories. Generated by \`scripts/gen-mascot-2d.mjs\`
 * from \`three/agent-data.json\`; do not edit by hand, re-run the script.
 *
 * Units: the SVG's 100×100 box, y down, framed like a 3D tile without an
 * accessory. "L" and "R" are the viewer's left and right.
 */
import type { MascotShape } from './agent-look';

export type Skull2D = {
  /** The body's outline, a closed path of cubic Beziers. */
  body: string;
  earL: string;
  earR: string;
  /** The centre of each ear's silhouette. */
  ears: { L: readonly [number, number]; R: readonly [number, number] };
  /** The black visor: one size on every skull, where the model's sits. */
  visor: { x: number; y: number; w: number; h: number; r: number };
  top: number;
  bottom: number;
  /** The highest point of the ears. */
  earsTop: number;
  /** Half the width, ears included, from the box's centre line. */
  halfWidth: number;
  /** The body's width near its top and near its foot. */
  topWidth: number;
  bottomWidth: number;
  /** Half the body's width at the belly, where a held tool sits. */
  belly: number;
};

export const SKULLS_2D: Readonly<Record<MascotShape, Skull2D>> = {
${lines.join('\n')}
};
`;
writeFileSync(TARGET, out);
console.log(`wrote ${TARGET} (visor ${r1(VW)}×${r1(VH)}, spread ${spread.toFixed(2)})`);
