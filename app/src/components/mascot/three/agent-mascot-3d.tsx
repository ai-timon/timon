'use client';

/**
 * The 3D plush head: the same props as the 2D `AgentMascot`, so the
 * `agent.mascot` slot's default occupant swaps one for the other, but always
 * the whole head: a part drawn alone (`part`) stays the 2D drawing's job.
 * Each instance is a plain 2D canvas fed by one engine shared by the page
 * (`engine.ts`); the engine, three.js and the model data load on demand.
 * Until the modelled head is drawn, `fallback` (the 2D drawing of the same
 * character) stands in its place, so a slow first load never shows a blank
 * or a placeholder; without one, the canvas shows a flat head.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { DEFAULT_LOOK, lookFurHex } from '../agent-look';
import type { AgentMascotProps } from '../agent-mascot';
import { usePrefersReducedMotion } from '../reduced-motion';
import { isMascotState, STATES, type MascotState } from '../mascot-states';
import { baseExpression } from './eyes';
import type { Mascot3DEngine } from './engine';
import { createSim, fpsFor, settle } from './sim';
import { createTile, drawFlat, mascot3DEngine, mascot3DEngineNow, tilePixels, type Tile } from './tile';

/** The whole head only; `fit` is ignored too: the camera always frames the head with its accessory. */
export type AgentMascot3DProps = Omit<AgentMascotProps, 'part'> & {
  /** Painted over the canvas until the engine has drawn the modelled head (it may never: no engine). */
  fallback?: ReactNode;
};

export function AgentMascot3D({
  shape = DEFAULT_LOOK.shape, color = DEFAULT_LOOK.color, eyes = DEFAULT_LOOK.eyes, acc = 'none',
  size = 96, live = false, state = null, shadow = true, label = null, className, fallback = null,
}: AgentMascot3DProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const tileRef = useRef<Tile | null>(null);
  const engineRef = useRef<Mascot3DEngine | null>(null);
  const reduced = usePrefersReducedMotion();

  const cssSize = Math.max(8, Math.round(size));
  const hex = lookFurHex(color);
  const current: MascotState = isMascotState(state) ? state : 'idle';
  const animated = live && !reduced;
  const base = baseExpression(eyes);

  // Everything the engine reads from the props, applied to the tile. A ref so the mount effect, which may
  // finish after a prop change (the engine loads asynchronously), applies the latest ones.
  const apply = useRef<(t: Tile, first: boolean) => void>(() => {});
  apply.current = (t, first) => {
    t.cssSize = cssSize;
    t.fps = fpsFor(cssSize);
    t.hex = hex;
    t.shape = shape;
    t.acc = acc;
    t.shadow = shadow;
    // New eyes picked (the agent editor, the configurator): show them now, not at the state's next draw of its pool.
    const usesBase = (STATES[current].pool as readonly string[]).includes('base');
    if (!first && t.baseExpr !== base && animated && usesBase) {
      t.sim.expr = base;
      t.sim.exprAt = t.sim.t + 5;
      t.sim.blinkStart = -1;
    }
    t.baseExpr = base;
    t.state = current;
    // A still head shows the state's first expression and posture; a live one goes there by its own motion.
    if (!animated || first) settle(t.sim, current, base);
    t.live = animated;
  };

  function paintFlat(t: Tile): void {
    if (fallback) return;
    const px = tilePixels(cssSize, typeof window === 'undefined' ? 1 : window.devicePixelRatio);
    if (t.canvas.width !== px) { t.canvas.width = px; t.canvas.height = px; }
    drawFlat(t.ctx, px, hex, current === 'sleeping');
  }
  const flat = useRef(paintFlat);
  flat.current = paintFlat;

  // Mount: one tile per canvas, registered with the engine for its lifetime.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const t = createTile(canvas, ctx, createSim());
    t.onDrawn = () => { setDrawn(true); };
    tileRef.current = t;
    apply.current(t, true);
    let gone = false;
    const attach = (e: Mascot3DEngine | null): void => {
      if (gone || !e) return;
      engineRef.current = e;
      e.add(t);
    };
    const now = mascot3DEngineNow();
    if (now) attach(now);
    else {
      flat.current(t);
      void mascot3DEngine().then(attach);
    }
    return () => {
      gone = true;
      engineRef.current?.remove(t);
      engineRef.current = null;
      tileRef.current = null;
    };
  }, []);

  // Every prop change lands on the tile; the engine redraws it on its next frame.
  useEffect(() => {
    const t = tileRef.current;
    if (!t) return;
    apply.current(t, false);
    if (engineRef.current) engineRef.current.touch(t);
    else flat.current(t);
  }, [cssSize, hex, shape, acc, shadow, base, current, animated]);

  const head = (
    <canvas
      // No width / height attributes: the engine sizes the bitmap to what the tile really takes on screen.
      ref={canvasRef}
      className={className ? `timon-mascot ${className}` : 'timon-mascot'}
      style={{ width: cssSize, height: cssSize, display: 'block' }}
      data-mascot=""
      data-mascot-3d={state ?? 'still'}
      data-shape={shape}
      data-acc={acc}
      data-live={animated ? '' : undefined}
      data-motion={reduced ? 'reduced' : 'full'}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
  if (!fallback) return head;
  return (
    <span className="relative block" style={{ width: cssSize, height: cssSize }}>
      {head}
      {!drawn && <span aria-hidden className="pointer-events-none absolute inset-0" data-mascot-fallback="">{fallback}</span>}
    </span>
  );
}
