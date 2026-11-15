/**
 * The 3D mascot's model data and how to read it back. No three.js here: the
 * decoding is plain typed arrays, so it runs (and is tested) without WebGL.
 *
 * `agent-data.json` is generated, never edited by hand: the seven skulls were
 * built, furred and rigged in Blender, exported, then quantised into base64
 * arrays (positions on 16 bits, normals and weights on 8) to keep the file
 * near 2 MB. It is loaded on demand (`loadModelData`), in a chunk of its own:
 * a page that never shows a 3D head never downloads it.
 */

/** A dequantised array: `n` components per item, each mapped back from `[0, max]` to `[lo[c], hi[c]]`. */
export type QuantizedArray = { k: 'q16' | 'q8'; n: number; lo: readonly number[]; hi: readonly number[]; d: string };
/** A raw integer array: `u16` stays integer (triangle indices), `u8` is read as floats (bone ids). */
export type RawArray = { k: 'u16' | 'u8'; d: string };
export type PackedArray = QuantizedArray | RawArray;

/** A skull's furred mesh: per vertex its fur length, its ear side (+1 left, -1 right, 0 none), two bones and their weights. */
export type BodyData = {
  pos: PackedArray; nrm: PackedArray; fur: PackedArray; ear: PackedArray; j: PackedArray; w: PackedArray; idx: PackedArray;
};
export type VisorData = { pos: PackedArray; nrm: PackedArray; uv: PackedArray; idx: PackedArray };
export type ClipName = 'hop' | 'hop_big' | 'startle' | 'grab' | 'happy';
/** Rig poses baked in Blender: `rows` poses of `bones` mat4, as half floats, row 0 the rest pose. */
export type AnimData = { bones: number; rows: number; fps: number; data: string; clips: Record<ClipName, { row: number; frames: number }> };
export type Vec3 = readonly [number, number, number];

export type ShapeData = {
  /** The full mesh, and a lighter one for small tiles. */
  body: BodyData;
  bodyLo: BodyData;
  anim: AnimData;
  visor: VisorData;
  earPivot: { L: Vec3; R: Vec3 };
  furLength: number;
  height: number;
  halfWidth: number;
  /** Height of the root of the rig's top bone: where the head turns. */
  headPivot: number;
  visorAspect: number;
};

/** An accessory piece: four bytes of colour per vertex (the alpha byte tells animated parts apart). */
export type AccessoryData = { tilt: number; pos: PackedArray; nrm: PackedArray; col: string; idx: PackedArray };

export type ModelData = {
  shapes: Readonly<Record<string, ShapeData>>;
  accessories: Readonly<Record<string, AccessoryData>>;
};

export function base64Bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

const isQuantized = (a: PackedArray): a is QuantizedArray => a.k === 'q16' || a.k === 'q8';

/** A packed array back to what a geometry attribute takes: indices as `Uint16Array`, everything else as floats. */
export function decodeArray(a: PackedArray): Float32Array | Uint16Array {
  const buf = base64Bytes(a.d).buffer;
  if (!isQuantized(a)) return a.k === 'u16' ? new Uint16Array(buf) : Float32Array.from(new Uint8Array(buf));
  const q = a.k === 'q16' ? new Uint16Array(buf) : new Uint8Array(buf);
  const max = a.k === 'q16' ? 65535 : 255;
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i += 1) {
    const c = i % a.n;
    const lo = a.lo[c] ?? 0;
    const hi = a.hi[c] ?? 0;
    out[i] = lo + ((q[i] ?? 0) / max) * (hi - lo);
  }
  return out;
}

/** A float array, whatever the packing (an index array read as floats). */
export function decodeFloats(a: PackedArray): Float32Array {
  const v = decodeArray(a);
  return v instanceof Float32Array ? v : Float32Array.from(v);
}

/** The model of a skull; a pack's skull, or any unknown name, gets the classic one. */
export function shapeData(data: ModelData, shape: string): ShapeData {
  const own = Object.prototype.hasOwnProperty.call(data.shapes, shape) ? data.shapes[shape] : undefined;
  const classic = data.shapes.squircle;
  if (own) return own;
  if (!classic) throw new Error('mascot model data has no classic skull');
  return classic;
}

/** A light structural check of what the chunk holds, so a truncated file fails here rather than in a shader. */
export function isModelData(value: unknown): value is ModelData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { shapes?: unknown; accessories?: unknown };
  if (typeof v.shapes !== 'object' || v.shapes === null || typeof v.accessories !== 'object' || v.accessories === null) return false;
  const classic = (v.shapes as Record<string, unknown>).squircle as Partial<ShapeData> | undefined;
  return !!classic && typeof classic.height === 'number' && typeof classic.anim === 'object' && typeof classic.body === 'object';
}

let pending: Promise<ModelData> | null = null;

/** The model data, imported once per page in its own chunk. A failed load can be tried again. */
export function loadModelData(): Promise<ModelData> {
  if (!pending) {
    pending = import('./agent-data.json').then((mod: unknown) => {
      const raw = typeof mod === 'object' && mod !== null && 'default' in mod ? (mod as { default: unknown }).default : mod;
      if (!isModelData(raw)) throw new Error('mascot model data is malformed');
      return raw;
    });
    pending.catch(() => { pending = null; });
  }
  return pending;
}
