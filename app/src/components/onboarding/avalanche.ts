/**
 * The welcome screen's avalanche, pure: mascots pour in from both sides and
 * pile up into two heaps, one against each edge (docs/ONBOARDING.md).
 *
 * Every resting spot is worked out up front — each heap is built bottom
 * first, a head sliding downhill until it rests in a hollow — then each mascot
 * flies one ballistic arc straight onto its spot. Landings are scheduled
 * bottom-up, so whatever a mascot lands on is already there: the heaps never
 * collapse, and the scene comes to rest exactly as computed.
 *
 * No DOM, no clock: the canvas (`mascot-avalanche.tsx`) owns the frame loop
 * and the drawing, the tests drive `stepAvalanche` with a seeded random.
 */

import { ACC, EYES, SHAPES, type AgentLook, type MascotColor } from '../mascot/agent-look';

export type Rng = () => number;

/**
 * A head's extent in its 100×100 box (`skullSize`): top and bottom widths,
 * height, and the line it stands on (92 when absent).
 */
export type HeadSize = { tw: number; bw: number; h: number; bottom?: number };

export type BodyState = 'wait' | 'fly' | 'placed' | 'held' | 'fall';

type Flight = { x0: number; y0: number; vx: number; vy0: number; T: number; t: number };

export type AvalancheBody = {
  /** Its place in `bodies`: the drawing keeps per-mascot state (where the head faces) in arrays. */
  index: number;
  /** Index of the look (and of its bitmap) this mascot wears. */
  look: number;
  side: -1 | 1;
  /** Edge of the drawn square, in CSS pixels. */
  size: number;
  /** Half-width and half-height of the drawn head. */
  va: number;
  vb: number;
  /** Half-axes of the contact ellipse: smaller than the drawing, plush heads squash into each other. */
  a: number;
  b: number;
  /** The head's centre, below the image's centre. */
  oy: number;
  tilt: number;
  /** Depth jitter for the drawing order. */
  z: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: BodyState;
  delay: number;
  slot: { x: number; y: number };
  /** The bodies it rests on. */
  sup: AvalancheBody[];
  fly: Flight | null;
  mode: 'fall' | 'jump';
  spin: number;
  /** Squash (1 = round) and its speed. */
  sq: number;
  sqv: number;
  lean: number;
  /** Drawn-only rebound after a hard landing: offset, clock (-1 = none), height. */
  boff: number;
  bt: number;
  bh: number;
};

type Drag = { body: AvalancheBody; ox: number; oy: number; px: number; py: number; vx: number; vy: number; t: number };

export type Avalanche = {
  width: number;
  height: number;
  floorY: number;
  scale: number;
  bodies: AvalancheBody[];
  /** `false` once scattered: nothing holds the mascots in any more. */
  floor: boolean;
  drag: Drag | null;
  rng: Rng;
};

export const GRAVITY = 2300;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Bright furs first: a crowd of brown heads reads as one blur. */
const CROWD_COLORS: readonly MascotColor[] = [
  '#ff5fbf', '#3fa9ff', '#7ed957', '#ffc233', '#ff8a2a', '#a35bff', '#d4a373', '#8a5a3b', '#e6c9a2', '#b8743d', '#c98e5a', '#7a4f35',
];

/**
 * The avalanche's cast: a few dozen distinct looks, each rasterised once and
 * reused at any size. Every skull, every pair of eyes, two heads in three
 * holding a tool — `fit`, so the tool stays inside the bitmap.
 */
export function avalancheLooks(count = 24): AgentLook[] {
  return Array.from({ length: count }, (_, i) => ({
    shape: SHAPES[(i * 3) % SHAPES.length] ?? 'squircle',
    color: CROWD_COLORS[i % CROWD_COLORS.length] ?? '#7a4f35',
    eyes: EYES[(i * 5) % EYES.length] ?? 'pill',
    acc: i % 3 === 2 ? 'none' : ACC[1 + ((i * 7) % (ACC.length - 1))] ?? 'none',
  }));
}

/** A small deterministic generator (mulberry32), for tests and reproducible scenes. */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance from an ellipse's centre to its outline along a unit direction. */
function radius(o: AvalancheBody, ux: number, uy: number): number {
  return 1 / Math.sqrt((ux * ux) / (o.a * o.a) + (uy * uy) / (o.b * o.b));
}

/** Where `b`'s centre rests at `x` on top of `list` (or on the floor), and what it touches. */
function restAt(b: AvalancheBody, x: number, list: readonly AvalancheBody[], floorY: number): { y: number; sup: AvalancheBody[] } {
  let y = floorY - b.vb;
  let sup: AvalancheBody[] = [];
  for (const o of list) {
    const dx = x - o.x;
    if (o === b || Math.abs(dx) >= o.a + b.a) continue;
    // Bisection on the vertical gap at which the two ellipses just touch.
    let lo = 0;
    let hi = o.a + o.b + b.a + b.b;
    for (let it = 0; it < 18; it += 1) {
      const d = (lo + hi) / 2;
      const L = Math.hypot(dx, d);
      const ux = dx / L;
      const uy = d / L;
      if (L < radius(o, ux, uy) + radius(b, ux, uy)) lo = d;
      else hi = d;
    }
    const yc = o.y - hi;
    if (yc < y - 1.5) { y = yc; sup = [o]; } else if (yc < y + 1.5) sup.push(o);
  }
  return { y, sup };
}

export type AvalancheOptions = {
  width: number;
  height: number;
  /** One entry per look; a body wears one of them at random. */
  looks: readonly HeadSize[];
  rng?: Rng;
  /** Reduced motion: every mascot starts on its spot, nothing flies. */
  still?: boolean;
};

export function buildAvalanche({ width: W, height: H, looks, rng = Math.random, still = false }: AvalancheOptions): Avalanche {
  const rnd = (a: number, b: number): number => a + rng() * (b - a);
  const gauss = (): number => (rng() + rng() + rng() - 1.5) / 1.5;
  const floorY = H - 4;
  const scale = clamp(H / 768, 0.75, 1.3);
  const G = GRAVITY;

  const make = (side: -1 | 1, k: number): AvalancheBody => {
    const look = Math.floor(rng() * looks.length);
    const head = looks[look] ?? { tw: 82, bw: 82, h: 66 };
    const size = rnd(34, 92) * scale * (k < 5 ? 1.35 : 1);
    const va = (Math.max(head.tw, head.bw) / 200) * size * 0.96;
    const vb = (head.h / 200) * size;
    const squish = rnd(0.68, 0.9);
    return {
      index: 0, look, side, size, va, vb, a: va * squish, b: vb * squish, oy: (((head.bottom ?? 92) - 50 - head.h / 2) / 100) * size,
      // A messy pile: every mascot ends up tilted its own way.
      tilt: clamp(gauss() * 0.42, -0.6, 0.6), z: rng(),
      x: 0, y: 0, vx: 0, vy: 0, state: 'wait', delay: 0, slot: { x: 0, y: 0 }, sup: [], fly: null,
      mode: 'jump', spin: 0, sq: 1, sqv: 0, lean: 0, boff: 0, bt: -1, bh: 0,
    };
  };

  // Each side fills its own lumpy mountain profile: tallest against the edge, sloping toward the middle.
  const peakH = H * 0.34;
  const ext = W * 0.27;
  const profile = (): ((d: number) => number) => {
    const ph = peakH * rnd(0.8, 1.15);
    const ex = ext * rnd(0.85, 1.15);
    const curve = rnd(1, 1.3);
    const b0 = rnd(0, 6.3);
    const b1 = rnd(0, 6.3);
    return (d) => ph * Math.pow(Math.max(0, 1 - d / ex), curve) * (1 + 0.18 * Math.sin((d / ex) * 9 + b0) + 0.1 * Math.sin((d / ex) * 17 + b1));
  };
  const avgA = 0.45 * 58 * scale * 0.8;
  const avgB = 0.35 * 58 * scale * 0.8;
  const perSide = clamp(Math.round((0.42 * ext * peakH) / (Math.PI * avgA * avgB)), 16, 80);

  const bodies: AvalancheBody[] = [];
  // Slide downhill until resting in a hollow, on the floor or against the edge.
  const settle = (b: AvalancheBody, x0: number, slide: number): { x: number; r: { y: number; sup: AvalancheBody[] } } => {
    let x = x0;
    let r = restAt(b, x, bodies, floorY);
    const stepX = b.a * 0.3;
    for (let k = 0; k < slide; k += 1) {
      let best: { x: number; r: { y: number; sup: AvalancheBody[] } } | null = null;
      for (const nx of [x - stepX, x + stepX]) {
        if (nx < b.a || nx > W - b.a) continue;
        const o = restAt(b, nx, bodies, floorY);
        if (o.y > r.y + 0.3 && (!best || o.y > best.r.y)) best = { x: nx, r: o };
      }
      if (!best) break;
      x = best.x;
      r = best.r;
    }
    return { x, r };
  };

  for (const side of [-1, 1] as const) {
    const edge = side < 0 ? 0 : W;
    const inward = -side;
    const target = profile();
    // Big heads first, loosely: they make the base of the heap.
    const team = Array.from({ length: perSide }, (_, k) => make(side, k))
      .map((body) => ({ body, key: body.size + rnd(-6, 6) }))
      .sort((p, q) => q.key - p.key)
      .map(({ body }) => body);
    for (const b of team) {
      let best: { x: number; r: { y: number; sup: AvalancheBody[] }; score: number } | null = null;
      // Some slide all the way into a hollow, some stay perched, a few roll out to the foot.
      const slide = rng() < 0.3 ? Math.floor(rnd(0, 3)) : 60;
      const stray = rng() < 0.07;
      for (let c = 0; c < (stray ? 1 : 3); c += 1) {
        const d = stray ? rnd(ext * 0.95, ext * 1.45) : b.a + rng() * Math.max(1, ext - b.a);
        const at = settle(b, edge + inward * d, slide);
        const score = stray ? 0 : target(Math.abs(at.x - edge)) - (floorY - (at.r.y - b.vb)) + rnd(-0.12, 0.12) * peakH;
        if (!best || score > best.score) best = { ...at, score };
      }
      if (!best) continue;
      b.slot = { x: best.x, y: best.r.y };
      b.sup = best.r.sup;
      b.x = best.x;
      b.y = best.r.y;
      b.index = bodies.length;
      bodies.push(b);
    }
  }

  // The arcs. About half are flung from above the corner and tumble down, the
  // others leap in from the side; each lands after everything it rests on.
  const arrival = new Map<AvalancheBody, number>();
  for (const b of bodies) {
    const edge = b.side < 0 ? 0 : W;
    const inward = -b.side;
    const { x: sx, y: sy } = b.slot;
    let x0: number;
    let y0: number;
    let vy0: number;
    let T: number;
    if (rng() < 0.55) {
      x0 = edge - inward * rnd(b.va * 1.5 + 40, 380);
      y0 = rnd(-H * 0.15, H * 0.45);
      T = rnd(0.75, 1.1);
      vy0 = (sy - y0 - 0.5 * G * T * T) / T;
      b.mode = 'fall';
      b.spin = rnd(-0.35, 0.35);
    } else {
      x0 = edge - inward * (b.va * 1.4 + rnd(0, 70));
      y0 = floorY - b.vb - rnd(0, H * 0.2);
      const apex = Math.min(y0, sy) - rnd(50, 150) * scale;
      vy0 = -Math.sqrt(2 * G * (y0 - apex));
      T = -vy0 / G + Math.sqrt((2 * (sy - apex)) / G);
      b.mode = 'jump';
      b.spin = 0;
    }
    const after = b.sup.reduce((m, s) => Math.max(m, arrival.get(s) ?? 0), 0);
    const base = b.sup.length ? after + rnd(0.07, 0.17) : rnd(0.15, 0.8) + (Math.abs(sx - edge) / ext) * 0.5;
    const t1 = Math.max(base, T + 0.05 + rnd(0, 0.1));
    arrival.set(b, t1);
    b.fly = { x0, y0, vx: (sx - x0) / T, vy0, T, t: 0 };
    b.state = 'wait';
    b.delay = t1 - T;
    b.x = x0;
    b.y = y0;
  }
  if (still) {
    for (const b of bodies) {
      b.x = b.slot.x;
      b.y = b.slot.y;
      b.lean = b.tilt;
      b.state = 'placed';
      b.fly = null;
    }
  }
  return { width: W, height: H, floorY, scale, bodies, floor: true, drag: null, rng };
}

/**
 * The window changed size. The heaps were computed for the old frame — moved
 * as they are, the right heap and the floor would leave a narrower screen —
 * so the scene is computed again for the new one, every mascot already on its
 * spot (`still`): an avalanche replayed at each resize would never end. A
 * scattered scene is left alone, its mascots are on their way out anyway.
 */
export function resizeAvalanche(world: Avalanche, width: number, height: number, looks: readonly HeadSize[]): Avalanche {
  if (!world.floor || (width === world.width && height === world.height)) return world;
  return buildAvalanche({ width, height, looks, rng: world.rng, still: true });
}

function land(world: Avalanche, b: AvalancheBody, y: number, hard: number): void {
  b.y = y;
  b.sqv -= 4 + Math.min(9, hard / 160);
  b.lean = b.tilt;
  if (hard > 600 && world.rng() < 0.6) {
    b.bt = 0;
    b.bh = Math.min(22, hard / 90) * world.scale;
  }
}

function startFalling(b: AvalancheBody): void {
  b.state = 'fall';
  b.vx = 0;
  b.vy = 0;
  b.bt = -1;
  b.boff = 0;
}

const placedBodies = (world: Avalanche): AvalancheBody[] => world.bodies.filter((o) => o.state === 'placed');

/** Advances the scene by `dt` seconds. Call it with small steps (≤ 8 ms) for stable landings. */
export function stepAvalanche(world: Avalanche, dt: number): void {
  const G = GRAVITY;
  const W = world.width;
  for (const b of world.bodies) {
    b.sqv += (1 - b.sq) * 520 * dt - b.sqv * 16 * dt;
    b.sq += b.sqv * dt;
    if (b.bt >= 0) {
      b.bt += dt;
      const T = 2 * Math.sqrt((2 * b.bh) / G);
      const t = b.bt;
      if (t >= T) { b.bt = -1; b.boff = 0; b.sqv -= 2.5; } else b.boff = -(Math.sqrt(2 * G * b.bh) * t - (G * t * t) / 2);
    }
    if (b.state === 'wait') {
      b.delay -= dt;
      if (b.delay <= 0 && b.fly) { b.state = 'fly'; b.fly.t = -b.delay; }
      continue;
    }
    if (b.state === 'held') {
      const drag = world.drag;
      if (!drag || drag.body !== b) { startFalling(b); continue; }
      const k = Math.min(1, dt * 28);
      b.x += (drag.px + drag.ox - b.x) * k;
      b.y += (drag.py + drag.oy - b.y) * k;
      b.lean += (clamp(drag.vx * 0.0004, -0.25, 0.25) - b.lean) * Math.min(1, dt * 10);
      continue;
    }
    if (b.state === 'placed') {
      b.lean += (b.tilt - b.lean) * Math.min(1, dt * 14);
      // Something it rested on was taken away: it falls.
      if (world.floor && b.sup.some((s) => s.state !== 'placed')) startFalling(b);
      continue;
    }
    if (b.state === 'fly' && b.fly) {
      const f = b.fly;
      f.t += dt;
      if (f.t >= f.T) {
        b.fly = null;
        b.x = b.slot.x;
        b.state = 'placed';
        land(world, b, b.slot.y, f.vy0 + G * f.T);
        if (b.sup.some((s) => s.state !== 'placed')) startFalling(b);
        continue;
      }
      const vy = f.vy0 + G * f.t;
      b.x = f.x0 + f.vx * f.t;
      b.y = f.y0 + f.vy0 * f.t + (G * f.t * f.t) / 2;
      // Tumblers wobble as they fall, leapers lean into the jump; both come down upright.
      const k = Math.min(1, (f.T - f.t) / 0.25);
      const airLean = b.mode === 'fall'
        ? b.spin * Math.sin(f.t * 9)
        : clamp(f.vx * 0.00022, -0.16, 0.16) - clamp(vy * 0.00005, -0.08, 0.08) * Math.sign(f.vx);
      b.lean = airLean * k + b.tilt * (1 - k);
      continue;
    }
    if (b.state === 'fall') {
      const prevY = b.y;
      b.vy += G * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.lean *= Math.max(0, 1 - dt * 4);
      if (world.floor) {
        if (b.x < b.va) { b.x = b.va; b.vx = Math.abs(b.vx) * 0.3; }
        if (b.x > W - b.va) { b.x = W - b.va; b.vx = -Math.abs(b.vx) * 0.3; }
        if (b.vy > 0) {
          const r = restAt(b, b.x, placedBodies(world), world.floorY);
          if (b.y >= r.y && prevY <= r.y + b.vb) {
            land(world, b, r.y, b.vy);
            b.state = 'placed';
            b.sup = r.sup;
            b.vx = 0;
            b.vy = 0;
          }
        }
      }
    }
  }
}

/** Every mascot has landed and stopped wobbling. */
export function isSettled(world: Avalanche, tolerance = 1e-3): boolean {
  return world.bodies.every((b) => b.state === 'placed' && b.bt < 0 && Math.abs(b.sq - 1) < tolerance
    && Math.abs(b.sqv) < tolerance * 10 && Math.abs(b.lean - b.tilt) < tolerance);
}

/** Back to front: resting heads (bottom of the heap first), then those in the air, then the one in hand. */
export function drawOrder(world: Avalanche): AvalancheBody[] {
  const rank = (s: BodyState): number => (s === 'held' ? 3 : s === 'fly' || s === 'fall' ? 2 : 1);
  const depth = (b: AvalancheBody): number => b.y + (b.z - 0.5) * b.vb * 1.8;
  return world.bodies.filter((b) => b.state !== 'wait').sort((p, q) => rank(p.state) - rank(q.state) || depth(q) - depth(p));
}

/** The front-most mascot under a point, if any. */
export function bodyAt(world: Avalanche, x: number, y: number): AvalancheBody | null {
  const order = drawOrder(world);
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const b = order[i];
    if (b && ((x - b.x) / b.va) ** 2 + ((y - b.y) / b.vb) ** 2 < 1) return b;
  }
  return null;
}

/** Picks up the mascot under the pointer. `t` in milliseconds. */
export function grab(world: Avalanche, x: number, y: number, t: number): boolean {
  const b = bodyAt(world, x, y);
  if (!b) return false;
  world.drag = { body: b, ox: b.x - x, oy: b.y - y, px: x, py: y, vx: 0, vy: 0, t };
  b.state = 'held';
  b.fly = null;
  b.boff = 0;
  b.bt = -1;
  return true;
}

export function dragTo(world: Avalanche, x: number, y: number, t: number): void {
  const d = world.drag;
  if (!d) return;
  const dt = Math.max(0.008, (t - d.t) / 1000);
  d.vx = d.vx * 0.5 + ((x - d.px) / dt) * 0.5;
  d.vy = d.vy * 0.5 + ((y - d.py) / dt) * 0.5;
  d.px = x;
  d.py = y;
  d.t = t;
}

/** Lets go: the mascot is thrown with the pointer's speed and lands wherever it falls. */
export function release(world: Avalanche): void {
  const d = world.drag;
  if (!d) return;
  const b = d.body;
  b.state = 'fall';
  b.vx = clamp(d.vx, -1300, 1300);
  b.vy = clamp(d.vy, -1300, 1300);
  world.drag = null;
}

/** "Continue": the floor gives way and every mascot is flung out of the screen. */
export function scatter(world: Avalanche): void {
  const rnd = (a: number, b: number): number => a + world.rng() * (b - a);
  world.floor = false;
  world.drag = null;
  for (const b of world.bodies) {
    // Those still waiting for their turn never come in.
    if (b.state === 'wait') { b.delay = Number.POSITIVE_INFINITY; continue; }
    const dir = b.x < world.width / 2 ? -1 : 1;
    b.state = 'fall';
    b.fly = null;
    b.bt = -1;
    b.boff = 0;
    b.vx = dir * rnd(380, 760);
    b.vy = -rnd(500, 980);
    b.sqv += 6;
  }
}
