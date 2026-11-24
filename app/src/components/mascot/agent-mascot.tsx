'use client';

/**
 * The agent's mascot: a plush head whose face is a black visor where the eyes
 * are light (docs/AGENT-MASCOT.md).
 *
 * - `AgentMascot` paints it from props — the product's 2D drawing: the 3D
 *   characters seen flat (outlines generated from the models,
 *   `mascot-2d-data.ts`), plain SVG and CSS, cheap enough for a page of heads.
 * - `ProductAgentMascot`, the default occupant of the `agent.mascot` slot,
 *   draws the 3D head (`three/agent-mascot-3d.tsx`) unless the user picked
 *   the 2D style or the browser has no WebGL2; then `AgentMascot`.
 * - `AgentMascotHost` is what a screen mounts: it normalises the request,
 *   hands it to the slot's occupant through `useAgentMascot()`, and paints
 *   `AgentMascot` itself while no occupant is registered (module off, a page
 *   before the plugins load). A screen never mounts `AgentMascot` directly,
 *   or a plugin could not replace it there.
 * - A mascot pack may draw a head of its own (a shape part with `head`): the
 *   host paints it, instead of the product, for the agents whose look wears
 *   that shape. A plugin that took `agent.mascot` still wins over it.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactElement } from 'react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { AGENT_MASCOT_SLOT } from '@/lib/plugin-host/slots';
import { DEFAULT_LOOK, lookFurHex, normalizeAgentLook, type AgentLook } from './agent-look';
import { mascotHeadOf, useMascotPartsVersion, type MascotPackHead } from './mascot-parts';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { AgentMascotProvider, useAgentMascot, type AgentMascotValue } from './agent-mascot-context';
import { MascotAccessoryArt, MascotAccessoryIcon } from './mascot-accessories';
import { exprPoints, furOf, headLayout, isDrawableEyes, luma, ptsPath, shade, type MascotEyesKey } from './mascot-geometry';
import { startMascotMotion, type MascotMotion } from './mascot-motion';
import { isMascotState, stateExpression, type MascotState } from './mascot-states';
import { usePrefersReducedMotion } from './reduced-motion';
import { useMascot3D } from './mascot-style-pref';
import { AgentMascot3D } from './three/agent-mascot-3d';

// Screens import it from here, beside the mascot it drives.
export { usePrefersReducedMotion };

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export type AgentMascotProps = {
  /** A product skull or a pack's (`<pluginId>:<slug>`); one whose pack is gone draws the classic skull. */
  shape?: AgentLook['shape'];
  /** `#rrggbb`, painted as is, or a pack's fur. */
  color?: string;
  /** The look's eyes — any expression, beyond the pickers' `EYES`, or a pack's eyes. */
  eyes?: MascotEyesKey;
  acc?: AgentLook['acc'];
  /** Edge of the square box, in CSS pixels. */
  size?: number;
  /** Moving eyes, blinks, states. Ignored under `prefers-reduced-motion`. */
  live?: boolean;
  /** What the agent is doing or how it reacts. Without `live`, its first expression, still. */
  state?: MascotState | null;
  /** Keeps the accessory inside the box instead of spilling past the bottom-right corner. */
  fit?: boolean;
  /** The soft shadow under the head. */
  shadow?: boolean;
  /** Accessible name; absent: decorative (`aria-hidden`). */
  label?: string | null;
  className?: string;
  /**
   * One part alone, for the configurator's cells: the screen with its eyes,
   * or the accessory centred and enlarged. Absent: the whole head.
   */
  part?: MascotDrawnPart | null;
};

/** A part drawn on its own (`AgentMascotProps.part`). */
export type MascotDrawnPart = 'screen' | 'acc';

/** The inner ear: the ear's own outline, shrunk about its centre and pushed outwards, where the 3D ear is hollow. */
function innerEar(c: readonly [number, number], out: number): string {
  const x = c[0] + out * 1.2;
  return `translate(${x.toFixed(2)} ${(c[1] + 0.6).toFixed(2)}) scale(.56) translate(${(-c[0]).toFixed(2)} ${(-c[1]).toFixed(2)})`;
}

/** A stable number from a React id: the fur's noise seed, so two mascots side by side are not the same plush. */
function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 9973;
  return h % 97;
}

export function AgentMascot({
  shape = DEFAULT_LOOK.shape, color = DEFAULT_LOOK.color, eyes = DEFAULT_LOOK.eyes, acc = 'none',
  size = 96, live = false, state = null, fit = false, shadow = true, label = null, className, part = null,
}: AgentMascotProps): ReactElement {
  // SVG ids are document-wide: React's `:r1:` would break `url(#…)`.
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const seed = seedOf(id);
  const reduced = usePrefersReducedMotion();
  const animated = live && !reduced;
  // A pack registering or leaving changes what the ids below draw.
  const partsVersion = useMascotPartsVersion();
  const base: MascotEyesKey = isDrawableEyes(eyes) ? eyes : DEFAULT_LOOK.eyes;
  const current: MascotState | null = isMascotState(state) ? state : null;
  // Keyed on the registry too: a pack's skull id draws differently once its pack is back.
  const L = useMemo(() => headLayout(shape), [shape, partsVersion]);
  const shown = current ? stateExpression(current, base) : base;
  const eyePts = useMemo(() => exprPoints(shown, L.geo), [shown, L, partsVersion]);

  // The look's colour exactly, as the 3D head paints it: shading comes from the gradients, not from the colour.
  const fur = furOf(lookFurHex(color));
  const light = luma(fur) > 0.6;
  const s = L.visor;
  const earInner = shade(fur, light ? -0.38 : -0.5);

  const svgRef = useRef<SVGSVGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const blinkRef = useRef<SVGGElement>(null);
  const lRef = useRef<SVGPathElement>(null);
  const rRef = useRef<SVGPathElement>(null);
  const mRef = useRef<SVGPathElement>(null);
  const motion = useRef<MascotMotion | null>(null);
  const latest = useRef({ base, current });
  latest.current = { base, current };

  // The engine is (re)built when motion turns on or the skull changes — the
  // eyes' screen moves with it. Layout effects: React has just written the
  // target outline, the engine puts the eyes back where they were before the
  // first paint, then springs them.
  useIsomorphicLayoutEffect(() => {
    if (!animated) return undefined;
    const svg = svgRef.current;
    const eyesG = eyesRef.current;
    const blink = blinkRef.current;
    const l = lRef.current;
    const r = rRef.current;
    const mid = mRef.current;
    if (!svg || !eyesG || !blink || !l || !r || !mid) return undefined;
    const engine = startMascotMotion({ svg, eyes: eyesG, blink, paths: { L: l, R: r, M: mid } }, L.geo, latest.current.base, latest.current.current);
    motion.current = engine;
    return () => {
      engine.dispose();
      motion.current = null;
      // Back to what React painted: a still mascot carries no leftover transform.
      blink.removeAttribute('transform');
      blink.style.opacity = '';
      eyesG.removeAttribute('transform');
    };
  }, [animated, L]);
  useIsomorphicLayoutEffect(() => { motion.current?.setBase(base); }, [base]);
  useIsomorphicLayoutEffect(() => { motion.current?.setState(current); }, [current]);

  const blinkDelay = { '--timon-mascot-blink-delay': `${((seed % 5) * 0.7).toFixed(1)}s` } as CSSProperties;

  const whole = part === null;
  // The screen alone is framed tight around it; the accessory is redrawn in the full box.
  const viewBox = part === 'screen' ? `${s.x - 2} ${s.y - 2} ${s.w + 4} ${s.h + 4}` : '0 0 100 100';

  return (
    <svg
      ref={svgRef}
      className={className ? `timon-mascot ${className}` : 'timon-mascot'}
      viewBox={viewBox}
      width={size}
      height={size}
      style={blinkDelay}
      data-mascot=""
      data-shape={shape}
      data-acc={acc}
      data-expr={shown}
      data-live={animated ? '' : undefined}
      data-motion={reduced ? 'reduced' : 'full'}
      data-mascot-part={part ?? undefined}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <defs>
        {/* The plush's volume: lit from the upper left like the 3D head, darker towards the foot and the flanks. */}
        <radialGradient id={`${id}g`} cx="38%" cy="26%" r="82%">
          <stop offset="0" stopColor={shade(fur, 0.26)} /><stop offset=".5" stopColor={fur} /><stop offset="1" stopColor={shade(fur, -0.34)} />
        </radialGradient>
        <radialGradient id={`${id}r`} cx="50%" cy="40%" r="70%">
          <stop offset="0" stopColor={shade(fur, 0.08)} /><stop offset="1" stopColor={shade(fur, -0.4)} />
        </radialGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset=".62" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".24" />
        </linearGradient>
        {/* Fur grain: a small tile of short strands, dark and light, repeated over the body. Cheaper than noise. */}
        <pattern id={`${id}p`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform={`rotate(${(seed % 7) * 9 - 27})`}>
          <path d="M.6 1.2q.9 1 .5 2.6M3.4 .4q.8 1.1.3 2.5M2 3.6q.9 1 .4 2.2M4.9 3q.8 1.1.3 2.4" fill="none" stroke="#000" strokeOpacity={light ? 0.13 : 0.2} strokeWidth=".55" strokeLinecap="round" />
          <path d="M1.7 .3q.8 1 .4 2.3M4.3 2.1q.8 1 .4 2.2M.9 4.2q.7.9.3 1.7" fill="none" stroke="#fff" strokeOpacity={light ? 0.22 : 0.13} strokeWidth=".5" strokeLinecap="round" />
        </pattern>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#202024" /><stop offset=".45" stopColor="#09090a" /><stop offset="1" stopColor="#030303" />
        </linearGradient>
        <linearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".34" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {/* The fur's edge: the outline frayed by one noise, so the plush has no hard contour. */}
        <filter id={`${id}f`} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves={1} seed={seed} />
          <feDisplacementMap in="SourceGraphic" scale="2.6" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {/* The eyes' glow: light on a screen, not paint. */}
        <filter id={`${id}e`} filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.3" result="b" />
          <feFlood floodColor="#ff9438" floodOpacity=".95" />
          <feComposite in2="b" operator="in" result="glow" />
          <feMerge><feMergeNode in="glow" /><feMergeNode in="glow" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id={`${id}a`} filterUnits="userSpaceOnUse" x="-10" y="-10" width="130" height="130">
          <feDropShadow dx="0" dy="1" stdDeviation=".7" floodColor="#000" floodOpacity=".38" />
        </filter>
        <clipPath id={`${id}c`}><rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r} /></clipPath>
      </defs>
      {whole && shadow && <ellipse cx="50" cy={L.bottom + 2} rx={L.bottomWidth * 0.46} ry="3" fill="#000" opacity=".3" />}
      {part === 'acc' && (
        <g filter={`url(#${id}a)`} data-mascot-acc={acc}>
          <MascotAccessoryIcon acc={acc} />
        </g>
      )}
      {part !== 'acc' && <g>
        {whole && <g filter={`url(#${id}f)`}>
          <path d={L.earL} fill={`url(#${id}r)`} />
          <path d={L.earR} fill={`url(#${id}r)`} />
          <path d={L.earL} fill={earInner} opacity=".75" transform={innerEar(L.ears.L, -1)} />
          <path d={L.earR} fill={earInner} opacity=".75" transform={innerEar(L.ears.R, 1)} />
          <path d={L.body} fill={`url(#${id}g)`} data-mascot-body="" />
          <path d={L.body} fill={`url(#${id}p)`} />
          <path d={L.body} fill={`url(#${id}b)`} />
        </g>}
        {/* The fur sinks a little around the visor. */}
        {whole && <rect x={s.x - 1.6} y={s.y - 1.6} width={s.w + 3.2} height={s.h + 3.2} rx={s.r + 1.6} fill={shade(fur, -0.45)} opacity=".45" />}
        <rect x={s.x - 0.7} y={s.y - 0.7} width={s.w + 1.4} height={s.h + 1.4} rx={s.r + 0.7} fill="#18181b" />
        <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r} fill={`url(#${id}s)`} />
        <g clipPath={`url(#${id}c)`}>
          <g ref={eyesRef} className="timon-mascot-eyes">
            <g ref={blinkRef} className="timon-mascot-blink" fill="#fff1df" filter={`url(#${id}e)`}>
              <path ref={lRef} d={ptsPath(eyePts.L)} />
              <path ref={rRef} d={ptsPath(eyePts.R)} />
              <path ref={mRef} d={ptsPath(eyePts.M)} />
            </g>
          </g>
          {/* The visor's gloss: the window's reflection along the top, and one sharp highlight. */}
          <ellipse cx={s.x + s.w * 0.4} cy={s.y + s.h * 0.17} rx={s.w * 0.36} ry={s.h * 0.15} fill={`url(#${id}h)`} />
          <circle cx={s.x + s.w * 0.83} cy={s.y + s.h * 0.26} r={s.h * 0.05} fill="#fff" opacity=".55" />
        </g>
        {whole && acc !== 'none' && (
          <g filter={`url(#${id}a)`} data-mascot-acc={acc}>
            <MascotAccessoryArt acc={acc} layout={L} fit={fit} />
          </g>
        )}
      </g>}
    </svg>
  );
}

/** The default occupant of `agent.mascot`: the product's drawing, from the host's request. */
export function ProductAgentMascot(): ReactElement | null {
  const v = useAgentMascot();
  if (!v) return null;
  return <AgentMascotFromValue value={v} />;
}

function AgentMascotFromValue({ value: v, part = null }: { value: AgentMascotValue; part?: MascotDrawnPart | null }): ReactElement {
  const threeD = useMascot3D();
  // The eyes' screen alone is a flat glyph on black: the 2D drawing frames it
  // tight. An accessory's cell shows the 3D head wearing it, the camera
  // stepping back so that the tool fits.
  if (threeD && part !== 'screen') {
    // The 2D drawing of the same character stands in while three.js and the models load.
    const flat = <AgentMascot {...v.look} color={v.fur} size={v.size} state={v.state} shadow={v.shadow} />;
    return (
      <AgentMascot3D
        fallback={flat}
        {...v.look}
        color={v.fur}
        size={v.size}
        live={v.live}
        state={v.state}
        shadow={v.shadow}
        label={v.label}
      />
    );
  }
  return (
    <AgentMascot
      part={part}
      {...v.look}
      color={v.fur}
      size={v.size}
      live={v.live}
      state={v.state}
      fit={v.fit}
      shadow={v.shadow}
      label={v.label}
    />
  );
}

export type AgentMascotHostProps = {
  /** Any value: what is not a valid `AgentLook` field falls back to `base`, field by field. */
  look?: Partial<AgentLook> | null;
  /** What a field falls back to — a pack's part whose plugin is not here included. Default: `DEFAULT_LOOK`. */
  base?: AgentLook;
  size?: number;
  live?: boolean;
  state?: MascotState | null;
  fit?: boolean;
  shadow?: boolean;
  label?: string | null;
  /**
   * One part alone (the configurator's cells). Drawn by the product's mascot
   * only: a plugin's replacement keeps drawing its whole head, outside the
   * slot's contract.
   */
  part?: MascotDrawnPart | null;
};

/**
 * One agent's mascot, painted by the `agent.mascot` occupant — a plugin's
 * replacement, or the product's drawing. The screens of the onboarding, the
 * agent creation and the chat mount this, never `AgentMascot`.
 */
export function AgentMascotHost({
  look, base = DEFAULT_LOOK, size = 96, live = false, state = null, fit = false, shadow = true, label = null, part = null,
}: AgentMascotHostProps): ReactElement {
  const occupant = useSlotEntries(AGENT_MASCOT_SLOT)[0];
  const claimed = occupant !== undefined;
  const product = !occupant || occupant.Component === ProductAgentMascot;
  const reducedMotion = usePrefersReducedMotion();
  const shape = look?.shape;
  const color = look?.color;
  const eyes = look?.eyes;
  const acc = look?.acc;
  // A pack coming or going changes what normalises.
  const parts = useMascotPartsVersion();
  const value = useMemo<AgentMascotValue>(() => {
    const normal = normalizeAgentLook({ shape, color, eyes, acc }, base);
    return {
      look: normal,
      fur: lookFurHex(normal.color),
      size,
      live: live && !reducedMotion,
      state: isMascotState(state) ? state : null,
      fit,
      shadow,
      label: label || null,
      reducedMotion,
    };
  }, [shape, color, eyes, acc, base, size, live, reducedMotion, state, fit, shadow, label, parts]);
  // A part alone (the configurator's eyes and accessory cells) stays the
  // product's drawing: a pack's head has no screen or tool to show apart.
  const pack = product && !part ? mascotHeadOf(value.look.shape) : null;
  return (
    <AgentMascotProvider value={value}>
      {part && product
        ? <AgentMascotFromValue value={value} part={part} />
        : pack ? <PackHead pack={pack} value={value} base={base} />
          : claimed ? <SlotSingle name={AGENT_MASCOT_SLOT} /> : <AgentMascotFromValue value={value} />}
    </AgentMascotProvider>
  );
}

/**
 * A head a pack draws itself. It ignores the user's 2D / 3D style: the pack
 * draws what it draws. If it throws, the agent gets the product's head on its
 * role's default skull (`base`), the rest of its look kept, and the page
 * goes on; another shape mounts a fresh boundary, so the next head is tried.
 */
function PackHead({ pack, value, base }: { pack: MascotPackHead; value: AgentMascotValue; base: AgentLook }): ReactElement {
  const { Head } = pack;
  const fallback = useMemo<AgentMascotValue>(() => {
    // A base that is itself a pack's head would fail the same way: the product's classic skull then.
    const shape = mascotHeadOf(base.shape) ? DEFAULT_LOOK.shape : base.shape;
    return { ...value, look: { ...value.look, shape } };
  }, [value, base.shape]);
  return (
    <PluginBoundary
      key={value.look.shape}
      pluginId={pack.pluginId}
      fallback={<AgentMascotProvider value={fallback}><AgentMascotFromValue value={fallback} /></AgentMascotProvider>}
    >
      <span data-mascot-head={value.look.shape} className="contents"><Head /></span>
    </PluginBoundary>
  );
}
