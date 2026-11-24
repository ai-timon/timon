import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReloadKeyInput } from './reload-shortcuts.js';

/**
 * The size of Timon's interface in the desktop app: a zoom factor applied to
 * every page of every window, never to a native browser panel (the site keeps
 * its own size). Fixed stops, so a key press always lands on a round size and
 * 120 % and 125 %, the usual answers to a 1× screen that reads too small, are
 * one choice each.
 */
export const UI_ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.33, 1.5, 1.75, 2] as const;
export type UiZoomFactor = (typeof UI_ZOOM_STEPS)[number];
export type UiZoomDirection = 'in' | 'out' | 'reset';
export const DEFAULT_UI_ZOOM: UiZoomFactor = 1;

export const UI_ZOOM_CHANNELS = {
  get: 'timon:ui-zoom-get',
  set: 'timon:ui-zoom-set',
  step: 'timon:ui-zoom-step',
  /** Main to page: the factor every page now shows. */
  changed: 'timon:ui-zoom-changed',
} as const;

/** A display preference of this computer's screen, next to `dock-icon.json`: the daemon has no say in it. */
const UI_ZOOM_FILE = 'ui-zoom.json';

/** Anything a page could send outside this range is a mistake, not a size. */
const REQUEST_MIN = 0.5;
const REQUEST_MAX = 3;

/** The stop closest to `value`; the ends past the range, the default for anything not a number. */
export function nearestUiZoom(value: number): UiZoomFactor {
  if (!Number.isFinite(value)) return DEFAULT_UI_ZOOM;
  let best: UiZoomFactor = UI_ZOOM_STEPS[0];
  for (const step of UI_ZOOM_STEPS) {
    if (Math.abs(step - value) < Math.abs(best - value)) best = step;
  }
  return best;
}

/** The next stop up or down, held at the ends; `reset` is 100 %. */
export function stepUiZoom(current: UiZoomFactor, direction: UiZoomDirection): UiZoomFactor {
  if (direction === 'reset') return DEFAULT_UI_ZOOM;
  const index = UI_ZOOM_STEPS.indexOf(nearestUiZoom(current));
  const next = direction === 'in' ? Math.min(UI_ZOOM_STEPS.length - 1, index + 1) : Math.max(0, index - 1);
  return UI_ZOOM_STEPS[next] ?? DEFAULT_UI_ZOOM;
}

/** The saved size; a missing or damaged file is 100 %. */
export function readUiZoom(home: string): UiZoomFactor {
  try {
    const factor = (JSON.parse(readFileSync(join(home, UI_ZOOM_FILE), 'utf8')) as { factor?: unknown }).factor;
    if (typeof factor === 'number' && Number.isFinite(factor)) return nearestUiZoom(factor);
  } catch { /* never chosen, or a damaged file: 100 % */ }
  return DEFAULT_UI_ZOOM;
}

/** Saves the size; `false` when the file could not be written, and the size holds until the app quits. */
export function writeUiZoom(home: string, factor: UiZoomFactor): boolean {
  try {
    writeFileSync(join(home, UI_ZOOM_FILE), `${JSON.stringify({ factor })}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** A page's request for a size, checked: a number in range, snapped to a stop. */
export function parseUiZoomSetRequest(input: unknown): UiZoomFactor | null {
  if (!input || typeof input !== 'object') return null;
  const { factor } = input as { factor?: unknown };
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < REQUEST_MIN || factor > REQUEST_MAX) return null;
  return nearestUiZoom(factor);
}

/** A page's request for a step: one of the three directions, nothing else. */
export function parseUiZoomStepRequest(input: unknown): UiZoomDirection | null {
  if (!input || typeof input !== 'object') return null;
  const { direction } = input as { direction?: unknown };
  return direction === 'in' || direction === 'out' || direction === 'reset' ? direction : null;
}

/** The fields of Electron's `Input` the zoom keys read: `code` is the physical key. */
export type ZoomKeyInput = ReloadKeyInput & { code?: string };

/**
 * Ctrl (Cmd on macOS) with plus, minus or zero, on any keyboard layout. The
 * window hides its menu bar on Windows and Linux, so these are handled on
 * `before-input-event`, like the reload keys.
 *
 * Plus and minus are read from the character the key types (`+` on QWERTZ,
 * `=` and `+` on QWERTY and AZERTY), or from the numeric keypad; never from
 * the physical `Equal` or `Minus` key. On the macOS French AZERTY, the
 * `Equal` key types `-` (`_` with Shift): read by its place, Cmd+Shift+-
 * would zoom in. On QWERTZ, Spanish and Italian that key is something else
 * again. On AZERTY the physical `Minus` key types `)`, and Ctrl+) belongs to
 * the page. Zero also takes the physical `Digit0` key, where AZERTY types
 * `à` without Shift.
 *
 * The other command modifier refuses the chord: Ctrl+Cmd on macOS and Ctrl
 * with the Windows key are not zoom keys. So does Alt, which also turns away
 * AltGr on Windows, sent as Ctrl+Alt (`@` on the zero key of AZERTY).
 */
export function zoomShortcut(input: ZoomKeyInput, platform: NodeJS.Platform): UiZoomDirection | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const command = platform === 'darwin' ? input.meta : input.control;
  const other = platform === 'darwin' ? input.control : input.meta;
  if (!command || other) return null;
  if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') return 'reset';
  return null;
}
