import { desktopBridge } from '@/lib/desktop';
import { formatPercent } from '@/lib/intl';

/**
 * The size of the interface, kept by the desktop shell of this computer for
 * every window. Nothing on the web or with an older desktop: the setting is
 * then not offered and the browser panel measures at 100 %.
 */
export const UI_ZOOM_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.33, 1.5, 1.75, 2];
export const DEFAULT_UI_ZOOM = 1;
export type UiZoomDirection = 'in' | 'out' | 'reset';
export type UiZoomState = { factor: number; steps: readonly number[] };

/**
 * The last factor the shell announced or answered, for a desktop whose
 * preload cannot read Blink's own (`zoom.current`, absent before it).
 */
let cachedFactor = DEFAULT_UI_ZOOM;
const listeners = new Set<(factor: number) => void>();
let stopListening: (() => void) | null = null;

const isFactor = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function zoomBridge() {
  return desktopBridge()?.zoom ?? null;
}

/** A factor heard from the shell: kept, and passed on to every subscriber when it is new. */
function remember(factor: number): void {
  if (!isFactor(factor) || factor === cachedFactor) return;
  cachedFactor = factor;
  for (const listener of [...listeners]) listener(factor);
}

/** Follows the shell's announcements, once for the page. */
function listen(): void {
  if (stopListening) return;
  const bridge = zoomBridge();
  if (typeof bridge?.onChange !== 'function') return;
  stopListening = bridge.onChange(remember);
}

/**
 * The factor the page is laid out at, synchronously; 1 on the web. Read from
 * Blink itself where the preload offers it: the shell announces a size just
 * before applying it, and a measure taken in between (or before the first
 * answer of the shell arrives) must use the factor the layout really has, or
 * the browser panel would overflow the window and be refused.
 */
export function cachedUiZoom(): number {
  const bridge = zoomBridge();
  if (typeof bridge?.current === 'function') {
    try {
      const live = bridge.current();
      if (isFactor(live)) return live;
    } catch { /* a preload that cannot answer: the announced factor below */ }
  }
  return cachedFactor;
}

/** The current size and the stops on offer, or `null` when this window cannot size its interface. */
export async function readUiZoom(): Promise<UiZoomState | null> {
  const bridge = zoomBridge();
  if (typeof bridge?.get !== 'function') return null;
  listen();
  try {
    const state = await bridge.get();
    if (!state || !isFactor(state.factor)) return null;
    const steps = Array.isArray(state.steps) && state.steps.length > 0 && state.steps.every(isFactor) ? [...state.steps] : UI_ZOOM_STEPS;
    remember(state.factor);
    return { factor: state.factor, steps };
  } catch {
    return null;
  }
}

/** The factor the shell settled on (snapped to a stop), or `null` when it could not be set. */
export async function setUiZoom(factor: number): Promise<number | null> {
  const bridge = zoomBridge();
  if (typeof bridge?.set !== 'function') return null;
  listen();
  try {
    const state = await bridge.set(factor);
    if (!state || !isFactor(state.factor)) return null;
    remember(state.factor);
    return state.factor;
  } catch {
    return null;
  }
}

/** One stop up or down, or back to 100 %; `null` when it could not be done. */
export async function stepUiZoom(direction: UiZoomDirection): Promise<number | null> {
  const bridge = zoomBridge();
  if (typeof bridge?.step !== 'function') return null;
  listen();
  try {
    const state = await bridge.step(direction);
    if (!state || !isFactor(state.factor)) return null;
    remember(state.factor);
    return state.factor;
  } catch {
    return null;
  }
}

/** Calls `listener` with each new factor, whichever window or key changed it. */
export function subscribeUiZoom(listener: (factor: number) => void): () => void {
  listen();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A factor as the percentage people read: 1.25 → "125%" ("125 %" in French). */
export function formatUiZoom(factor: number): string {
  return formatPercent(factor);
}

/** Forgets the cached factor and the shell's listener: each test starts from a fresh page. */
export function resetUiZoomForTests(): void {
  stopListening?.();
  stopListening = null;
  listeners.clear();
  cachedFactor = DEFAULT_UI_ZOOM;
}
