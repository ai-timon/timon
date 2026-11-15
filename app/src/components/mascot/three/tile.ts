/**
 * The light half of the 3D mascot: what a tile is, whether the browser can
 * draw one, the flat head drawn otherwise, and the on-demand loading of the
 * engine. three.js and the model data stay out of the page's first bundle:
 * they arrive, each in its own chunk, the first time a 3D head mounts.
 */
import type { MascotExpression } from '../mascot-geometry';
import type { MascotState } from '../mascot-states';
import type { Mascot3DEngine } from './engine';
import { fpsFor, type Sim } from './sim';

/** Larger than this, a tile is drawn at this size and scaled by the browser: past it nobody sees more fur. */
export const MAX_PX = 512;

/** One mascot on the page, as the React component hands it to the engine. */
export type Tile = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  sim: Sim;
  /** Fur colour, `#rrggbb`. */
  hex: string;
  /** Edge in CSS pixels, from the props; the engine prefers the measured on-screen size. */
  cssSize: number;
  fps: number;
  shape: string;
  acc: string;
  shadow: boolean;
  baseExpr: MascotExpression;
  state: MascotState;
  live: boolean;
  dirty: boolean;
  drawnAt: number;
  rect: DOMRect | null;
  rectAt: number;
  /** Called once, when the engine has drawn the modelled head on the canvas for the first time. */
  onDrawn: (() => void) | null;
};

export function createTile(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, sim: Sim): Tile {
  return {
    canvas, ctx, sim, hex: '#7a4f35', cssSize: 96, fps: fpsFor(96), shape: 'squircle', acc: 'none', shadow: false,
    baseExpr: 'pill', state: 'idle', live: false, dirty: true, drawnAt: 0, rect: null, rectAt: 0, onDrawn: null,
  };
}

/** Bitmap edge for a tile of `size` CSS pixels on this screen. */
export function tilePixels(size: number, devicePixelRatio: number): number {
  return Math.min(MAX_PX, Math.max(8, Math.round(size * Math.min(devicePixelRatio || 1, 2))));
}

/**
 * The head without WebGL2 (old GPU, disabled acceleration) or while the
 * engine loads: the fur colour, the black visor and two light eyes. Drawn
 * once; it costs nothing per frame.
 */
export function drawFlat(ctx: CanvasRenderingContext2D, px: number, hex: string, sleeping: boolean): void {
  ctx.clearRect(0, 0, px, px);
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.ellipse(px / 2, px * 0.55, px * 0.42, px * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0b0b0c';
  ctx.beginPath();
  ctx.roundRect(px * 0.22, px * 0.4, px * 0.56, px * 0.3, px * 0.1);
  ctx.fill();
  ctx.fillStyle = '#ffb36b';
  for (const x of [0.38, 0.62]) {
    ctx.beginPath();
    if (sleeping) ctx.rect(px * (x - 0.05), px * 0.54, px * 0.1, px * 0.025);
    else ctx.ellipse(px * x, px * 0.55, px * 0.035, px * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

let webgl2: boolean | null = null;

/** Whether this browser can run the engine: WebGL2. Probed once per page. */
export function hasWebGL2(): boolean {
  if (webgl2 !== null) return webgl2;
  // No WebGL2 API at all (an old engine, a test DOM): nothing to probe, and no context to create.
  if (typeof WebGL2RenderingContext === 'undefined') {
    webgl2 = false;
    return webgl2;
  }
  try {
    const probe = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('webgl2');
    webgl2 = !!probe;
    // The probe would hold one of the page's few contexts: give it back at once.
    probe?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

/** Forgets the probe's answer, so that a test can draw with and without WebGL2. */
export function resetWebGL2ProbeForTests(): void {
  webgl2 = null;
}

let engine: Promise<Mascot3DEngine | null> | null = null;
let ready: Mascot3DEngine | null = null;

/**
 * The page's one engine, created on first use from two chunks loaded in
 * parallel (three.js with the engine, and the model data). `null` without
 * WebGL2 or when the engine could not start: the tile keeps its flat head.
 */
export function mascot3DEngine(): Promise<Mascot3DEngine | null> {
  if (!engine) {
    engine = !hasWebGL2()
      ? Promise.resolve(null)
      : Promise.all([import('./engine'), import('./model-data').then((m) => m.loadModelData())])
        .then(([mod, data]) => { ready = mod.createEngine(data); return ready; })
        .catch(() => null);
  }
  return engine;
}

/** The engine if it is already up, without loading anything: a mascot mounted after the first skips the flat head. */
export function mascot3DEngineNow(): Mascot3DEngine | null {
  return ready;
}
