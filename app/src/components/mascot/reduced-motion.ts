/**
 * The system's "reduce motion" request, followed live. Its own module so that
 * both mascot renderers (2D `agent-mascot.tsx`, 3D `three/agent-mascot-3d.tsx`)
 * read it without importing each other.
 */
import { useSyncExternalStore } from 'react';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(REDUCED_MOTION);
  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}
function readMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches;
}
/** The server paints a still mascot; the client wakes it once it knows the user's preference. */
const serverMotion = (): boolean => true;

/** `true` when the user asked the system for reduced motion; follows the setting live. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, readMotion, serverMotion);
}
