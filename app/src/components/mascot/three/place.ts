/**
 * Where each accessory sits on the 3D character, which has no hands, and the
 * maths that fits a piece to a skull. Plain numbers, no three.js: the engine
 * turns a `PiecePose` into a matrix, and the tests check the maths without
 * WebGL.
 */
import { isMascotAccessory } from '../agent-look';

/**
 * Anchors:
 *   hat     worn on the skull, scaled to its width and depth at the height `f` of the brim
 *   mortar  the mortarboard, on top of the fur
 *   face    on the visor (glasses);  neck  under the visor (bow tie)
 *   band, cupL, cupR  headphones: the band from ear to ear, a cup on each ear
 *   ear     tucked between the ear and the skull, sticking up;  eye  held before one eye
 *   top     perched on the head
 *   flank   held against the belly, turned outwards (follows the body)
 *   hand    gripped at the side, head up (follows the body)
 *   ground  standing at the character's foot and carried along by it
 */
export type Anchor = 'hat' | 'mortar' | 'face' | 'neck' | 'band' | 'cupL' | 'cupR' | 'ear' | 'eye' | 'top' | 'flank' | 'hand' | 'ground';

export type Piece = {
  /** Mesh name in the model data. */
  m: string;
  at: Anchor;
  /** (pitch, yaw, roll) in radians. */
  rot?: readonly [number, number, number];
  /** Size of a drawing unit against `UNIT`. */
  u?: number;
  /** Height of a hat's brim, as a share of the skull's height. */
  f?: number;
  /** A piece's own nudge from its anchor, in model units. */
  off?: readonly [number, number, number];
};

const HALF_TURN_AND_A_BIT = 2.641592653589793;

/**
 * Pieces of each job accessory, keyed by the look's accessory id. Up to
 * `MAX_PIECES` each (the headphones: a band, two cups, and the mug). Tuned by
 * eye on renders of every skull.
 */
export const PLACES: Readonly<Record<string, readonly Piece[]>> = {
  coffee: [{ m: 'band', at: 'band' }, { m: 'cup', at: 'cupL', u: 1.7 }, { m: 'cup', at: 'cupR', u: 1.7 }, { m: 'coffee', at: 'ground', rot: [0, -0.6, 0], u: 1.6 }],
  pen: [{ m: 'glasses', at: 'face', u: 1.1 }, { m: 'pen', at: 'ear', rot: [-0.2, 0, HALF_TURN_AND_A_BIT], u: 1.5 }],
  baton: [{ m: 'bowtie', at: 'neck', u: 1.25 }, { m: 'baton', at: 'ear', rot: [-0.15, 0, 0.2], u: 1.5 }],
  hammer: [{ m: 'hardhat', at: 'hat', f: 0.8 }, { m: 'hammer', at: 'hand', rot: [0.2, -0.45, -0.5], u: 1.6 }],
  wrench: [{ m: 'cap_mech', at: 'hat', f: 0.84, rot: [0, 0.5, 0.1] }, { m: 'wrench', at: 'hand', rot: [0.2, -0.45, -0.5], u: 1.6 }],
  envelope: [{ m: 'cap_post', at: 'hat', f: 0.84 }, { m: 'envelope', at: 'flank', u: 1.5 }],
  quill: [{ m: 'quill', at: 'ear', rot: [-0.2, 0.5, -0.5], u: 1.8 }, { m: 'inkpot', at: 'ground', rot: [0, -0.3, 0], u: 2.1 }],
  brush: [{ m: 'beret', at: 'hat', f: 0.86, rot: [0, 0, -0.16] }, { m: 'brush', at: 'ear', rot: [-0.2, 0, -0.5], u: 1.5 }],
  calculator: [{ m: 'calculator', at: 'flank', u: 1.65 }],
  clipboard: [{ m: 'clipboard', at: 'flank', u: 1.5 }, { m: 'pen', at: 'ear', rot: [-0.2, 0, HALF_TURN_AND_A_BIT], u: 1.5 }],
  loupe: [{ m: 'loupe', at: 'eye', rot: [0, 0.25, 0], u: 1.3 }],
  telescope: [{ m: 'telescope', at: 'top', rot: [0, -0.6, 0.25], u: 2 }],
  teacher: [{ m: 'cap', at: 'mortar', u: 1.9 }, { m: 'teacher', at: 'flank', u: 1.45 }],
  calendar: [{ m: 'calendar', at: 'flank', u: 1.6 }],
  hourglass: [{ m: 'hourglass', at: 'ground', rot: [0, -0.4, 0], u: 1.6 }],
  chart: [{ m: 'chart', at: 'flank', u: 1.55 }],
  globe: [{ m: 'globe', at: 'ground', rot: [0.1, -0.4, 0], u: 1.6 }],
  megaphone: [{ m: 'megaphone', at: 'ground', rot: [0, -0.7, 0.3], u: 1.55 }],
  shield: [{ m: 'shield', at: 'flank', u: 1.6 }],
  // The jobs added next to the first nineteen.
  whip: [{ m: 'whip', at: 'hand', rot: [0.1, -0.3, -0.1], u: 1.5, off: [-0.09, 0.02, 0.02] }],
  wizard: [{ m: 'wizard_hat', at: 'hat', f: 0.8 }, { m: 'wand', at: 'hand', rot: [0.2, -0.45, -0.5], u: 1.5 }],
  chef: [{ m: 'toque', at: 'hat', f: 0.8 }, { m: 'whisk', at: 'hand', rot: [0.2, -0.45, -0.5], u: 1.5 }],
  crown: [{ m: 'crown', at: 'hat', f: 0.88 }],
  idea: [{ m: 'bulb', at: 'top', rot: [0, 0, -0.35], u: 1.75 }],
  rocket: [{ m: 'rocket', at: 'ground', rot: [0, -0.4, 0], u: 1.9 }],
  chemist: [{ m: 'glasses', at: 'face', u: 1.1 }, { m: 'flask', at: 'ground', rot: [0, -0.3, 0], u: 1.75 }],
  gamer: [{ m: 'band', at: 'band' }, { m: 'cup', at: 'cupL', u: 1.7 }, { m: 'cup', at: 'cupR', u: 1.7 }, { m: 'gamepad', at: 'flank', u: 1.45 }],
  photographer: [{ m: 'camera', at: 'flank', u: 1.45 }],
  gardener: [{ m: 'straw_hat', at: 'hat', f: 0.8 }, { m: 'plant', at: 'ground', rot: [0, -0.4, 0], u: 2.1 }],
  musician: [{ m: 'guitar', at: 'ground', rot: [0, -0.5, 0.18], u: 1.35 }],
};

export const MAX_PIECES = 5;

const NONE: readonly Piece[] = [];

/**
 * The pieces a look's accessory draws. Only an accessory the product's lists
 * know is drawn: a pack's accessory, or an id whose 2D drawing has not landed
 * yet, shows the bare head rather than a 3D object the configurator cannot
 * offer.
 */
export function piecesFor(acc: string): readonly Piece[] {
  if (!isMascotAccessory(acc)) return NONE;
  return Object.prototype.hasOwnProperty.call(PLACES, acc) ? PLACES[acc] ?? NONE : NONE;
}

/** Anchors that stand above the head: the camera steps back and up so the piece stays in the tile. */
const UP: ReadonlySet<Anchor> = new Set<Anchor>(['hat', 'mortar', 'band', 'ear', 'top']);
export const standsUp = (pieces: readonly Piece[]): boolean => pieces.some((p) => UP.has(p.at));

/** One drawing unit on the skull: the 2D head is 82 units wide, the 3D one 1.04. */
export const UNIT = 1.04 / 82;
/** Where the classic skull's head turns: other skulls scale the anchors that follow the face by their own pivot. */
const CLASSIC_HEAD_Y = 0.44;

/** What a placement needs to know of a skull, measured once from its mesh (`skullMetrics`). */
export type SkullMetrics = {
  height: number;
  headY: number;
  /** The left ear's pivot (x > 0, y). */
  earX: number;
  earY: number;
  /** Scale of the skull in the tile (wide or tall skulls are drawn smaller). */
  k: number;
  frontZ: number;
  /** Half width at the belly and at the ground. */
  midHW: number;
  botHW: number;
  /** Half width and front depth at a share `f` of the height (0 ground, 1 top). */
  hwAt: (f: number) => number;
  fzAt: (f: number) => number;
};

/** What a piece follows once placed. */
export type Follow = 'head' | 'neck' | 'body' | 'ground';

/** A piece placed in skull space: translation, Euler angles (order YXZ), scale, and what carries it. */
export type PiecePose = {
  x: number; y: number; z: number;
  pitch: number; yaw: number; roll: number;
  sx: number; sy: number; sz: number;
  follow: Follow;
};

/**
 * Fits a piece to a skull. `accTiltDeg` is the 2D drawing's tilt of the
 * piece's mesh (a flank piece without its own rotation leans like the
 * drawing); `minY` is the bottom of the mesh, so a ground piece stands on the
 * ground.
 */
export function placePiece(pl: Piece, sk: SkullMetrics, accTiltDeg: number, minY: number): PiecePose {
  const u = UNIT * (pl.u ?? 1);
  const sh = sk.headY / CLASSIC_HEAD_Y;
  const rot = pl.rot ?? [0, 0, 0];
  const at = pl.at;
  const tilt = at === 'flank' && !pl.rot ? -(accTiltDeg * Math.PI) / 180 : 0;
  let x = 0;
  let y = 0;
  let z = 0;
  let yaw = rot[1];
  let pitch = rot[0];
  let sx = u;
  let sy = u;
  let sz = u;
  const ey = sk.earY + 0.06;
  let follow: Follow = 'head';
  switch (at) {
    case 'hat': {
      const f = pl.f ?? 0.75;
      const r = sk.hwAt(f) + 0.085;
      y = f * sk.height;
      sx = sy = r / 10;
      sz = (sk.fzAt(f) + 0.085) / 10;
      break;
    }
    case 'mortar': y = sk.height + 0.07; break;
    case 'face':
      // The visor has the same size on every skull (the skull's scale `k` is undone), so the glasses fit it everywhere.
      y = 0.528 * sh; z = sk.frontZ + 0.075; sx = sy = sz = u / sk.k;
      break;
    case 'neck':
      y = 0.2 * sh; z = sk.fzAt((0.2 * sh) / sk.height) + 0.1; pitch = -0.2; follow = 'neck';
      break;
    case 'band': y = ey; sx = sz = (sk.earX + 0.24) / 10; sy = (sk.height + 0.13 - ey) / 10; break;
    case 'cupL':
    case 'cupR': {
      // Over the ear, turned towards the viewer.
      const sgn = at === 'cupL' ? 1 : -1;
      x = sgn * (sk.earX + 0.13); y = ey; z = 0.1; yaw = sgn * 1.05;
      break;
    }
    case 'ear': x = sk.earX + 0.1; y = sk.earY + 0.33; z = 0.03; break;
    // Before the right eye of the visor, which is one size on every skull like the glasses.
    case 'eye': x = (0.3 * 0.42) / sk.k + 0.012; y = 0.54 * sh; z = sk.frontZ + 0.13; break;
    case 'top': x = 0.12; y = sk.height + 0.1; z = 0.12; break;
    // Gripped by the handle at the character's side, head up and tipped outwards: the fur hides the hand it lacks.
    case 'hand': x = sk.midHW + 0.1; y = 0.3 * sh; z = sk.frontZ * 0.65; follow = 'body'; break;
    case 'flank': {
      // Held out in front of the belly, round to the right, turned outwards and tipped back so its thickness shows.
      const a = 0.75;
      x = sk.midHW * Math.sin(a) + 0.12; z = sk.frontZ * Math.cos(a) + 0.2; y = 0.2 * sh + 0.02; yaw = 0.6; pitch = -0.15;
      follow = 'body';
      break;
    }
    case 'ground':
      x = sk.botHW + 0.1; z = 0.42; y = -minY * u; follow = 'ground';
      break;
  }
  if (pl.off) { x += pl.off[0]; y += pl.off[1]; z += pl.off[2]; }
  return { x, y, z, pitch, yaw, roll: rot[2] + tilt, sx, sy, sz, follow };
}

/** Linear lookup in a table of `n + 1` samples over [0, 1]. */
function sampleAt(tab: Float32Array, f: number): number {
  const n = tab.length - 1;
  const x = Math.max(0, Math.min(n, f * n));
  const i = Math.min(n - 1, Math.floor(x));
  const a = tab[i] ?? 0;
  const b = tab[i + 1] ?? a;
  return a + (b - a) * (x - i);
}

/**
 * Measures a skull's surface for the accessories: its front, its width at
 * the belly and at the ground, and its half width and front depth at each
 * twentieth of its height. Ear vertices are left out: a hat fits the skull,
 * not the ears.
 */
export function skullMetrics(input: {
  positions: Float32Array; ears: Float32Array; height: number; headY: number; earPivot: readonly [number, number, number]; k: number;
}): SkullMetrics {
  const { positions: pp, ears, height } = input;
  let frontZ = 0;
  let midHW = 0;
  let botHW = 0;
  const hw = new Float32Array(21);
  const fz = new Float32Array(21);
  const n = pp.length / 3;
  for (let i = 0; i < n; i += 1) {
    if (Math.round(ears[i] ?? 0) !== 0) continue;
    const ax = Math.abs(pp[i * 3] ?? 0);
    const py = pp[i * 3 + 1] ?? 0;
    const pz = pp[i * 3 + 2] ?? 0;
    const f = py / height;
    if (pz > frontZ) frontZ = pz;
    if (f > 0.15 && f < 0.4 && ax > midHW) midHW = ax;
    if (f < 0.2 && ax > botHW) botHW = ax;
    const b = Math.max(0, Math.min(20, Math.round(f * 20)));
    hw[b] = Math.max(hw[b] ?? 0, ax);
    fz[b] = Math.max(fz[b] ?? 0, pz);
  }
  return {
    height, headY: input.headY, earX: input.earPivot[0], earY: input.earPivot[1], k: input.k,
    frontZ, midHW, botHW, hwAt: (f) => sampleAt(hw, f), fzAt: (f) => sampleAt(fz, f),
  };
}

/** Square frame around the head and ears, in model units (the classic skull spans y 0..0.905, x ±0.695 with the ears). */
export const FRAME = 1.66;
export const CENTER_Y = 0.47;

/** Scale that keeps a wide or tall skull inside the tile. */
export function skullScale(halfWidth: number, height: number): number {
  return Math.min(1, (0.84 * FRAME) / (2 * halfWidth), (0.8 * FRAME) / height);
}

/** Root height that centres a skull of this scale in the tile. */
export function skullLift(k: number, height: number): number {
  return CENTER_Y - k * height * 0.52;
}
