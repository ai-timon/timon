/** Shared client contract. The daemon authorizes the selected profile on every call. */
import { apiErrorMessage } from '@/lib/api-error';

export type BrowserProfile = { id: string; name: string; scope_kind: string; scope_ref: string | null };
export type NativeBrowserStatus = {
  running: boolean; profileId: string; tabs: { id: string; url: string; title: string }[];
  activeTabId: string | null; width: number; height: number; mobile?: boolean;
  control?: { holder: 'you' | 'other' | null; kind: 'human' | 'agent' | null };
  dialog?: { id: string; tabId: string; type: string; message: string; defaultPrompt?: string; url: string } | null;
  permissions?: Array<{ id: string; tabId: string; permission: string; origin: string; mediaTypes?: string[]; hostDevices?: boolean }>;
  fileChooser?: { id: string; tabId: string; multiple: boolean } | null;
  downloads?: Array<{ id: string; name: string; mimeType: string; size: number; receivedBytes: number; state: string; url: string; createdAt: string }>;
  contextMenu?: { id: string; tabId: string; x: number; y: number; selectionText: string; linkURL: string; isEditable: boolean } | null;
  audioMuted?: boolean;
};
export type BrowserShot = { data: string; mimeType: string; width: number; height: number };

/**
 * Integer DIP bounds must remain inside both the CSS surface and the Electron
 * content window. `rect` and `windowSize` are CSS pixels; under the desktop's
 * interface size (`zoom`) a CSS pixel is `zoom` DIPs, so both are scaled to
 * DIPs and then rounded inward: the start of the rectangle up, its end and the
 * window's size down. The bounds thus stay within the layout box measured and
 * within the window as the page measures it (`innerWidth`, `innerHeight`).
 */
export function browserPanelBounds(
  rect: { left: number; top: number; width: number; height: number },
  windowSize: { width: number; height: number },
  zoom = 1,
) {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const maxW = Math.floor(windowSize.width * scale);
  const maxH = Math.floor(windowSize.height * scale);
  const x = Math.max(0, Math.min(maxW, Math.ceil(rect.left * scale)));
  const y = Math.max(0, Math.min(maxH, Math.ceil(rect.top * scale)));
  const right = Math.max(x, Math.min(maxW, Math.floor((rect.left + rect.width) * scale)));
  const bottom = Math.max(y, Math.min(maxH, Math.floor((rect.top + rect.height) * scale)));
  return { x, y, width: right - x, height: bottom - y };
}
export type BrowserCommand = <T = unknown>(action: string, data?: Record<string, unknown>) => Promise<T>;

export async function nativeBrowserRequest<T>(path: string, body?: unknown, signal?: AbortSignal, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api/ui/native-browser/${path}`, {
    method, credentials: 'same-origin', cache: 'no-store', signal,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(value, { status: response.status }));
  return value as T;
}

export async function nativeBrowserCommand<T>(profileId: string, action: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await nativeBrowserRequest<{ result: T }>(`${encodeURIComponent(profileId)}/command`, { ...input, action }, signal);
  return response.result;
}

/** Map a pointer into a contained screenshot, rejecting the black letterbox bars. */
export function browserPointer(
  clientX: number, clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
  frame: { width: number; height: number } = viewport,
): { x: number; y: number } | null {
  if (bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  // Encoders/HiDPI may change frame resolution. Fit that image, then convert
  // normalized positions to the page's CSS viewport, which CDP expects.
  const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);
  const x = (clientX - bounds.left - (bounds.width - frame.width * scale) / 2) / (frame.width * scale) * viewport.width;
  const y = (clientY - bounds.top - (bounds.height - frame.height * scale) / 2) / (frame.height * scale) * viewport.height;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return null;
  return { x: Math.floor(x), y: Math.floor(y) };
}

/**
 * The inverse of `browserPointer`: a rectangle of the page (CSS viewport pixels) in pixels of the
 * surface box that shows it letterboxed, for a layer painted over the picture. `null` when nothing
 * of it is on the picture.
 */
export function browserRectOnSurface(
  rect: { x: number; y: number; width: number; height: number },
  box: { width: number; height: number },
  viewport: { width: number; height: number },
  frame: { width: number; height: number } = viewport,
): { left: number; top: number; width: number; height: number } | null {
  if (box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const pictureWidth = frame.width * scale;
  const pictureHeight = frame.height * scale;
  const offsetX = (box.width - pictureWidth) / 2;
  const offsetY = (box.height - pictureHeight) / 2;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(viewport.width, rect.x + rect.width);
  const y1 = Math.min(viewport.height, rect.y + rect.height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  const sx = pictureWidth / viewport.width;
  const sy = pictureHeight / viewport.height;
  return { left: offsetX + x0 * sx, top: offsetY + y0 * sy, width: (x1 - x0) * sx, height: (y1 - y0) * sy };
}

export function browserModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): string[] {
  return [event.altKey && 'Alt', event.ctrlKey && 'Control', event.metaKey && 'Meta', event.shiftKey && 'Shift'].filter((value): value is string => !!value);
}

/** What the address bar sends: a bare host gets `https://`, free text becomes a
 *  search. Any explicit scheme is left untouched — the host still refuses
 *  everything but HTTP(S), and that refusal must stay visible. */
export function addressBarTarget(input: string): string {
  const text = input.trim();
  // `localhost:3000` reads as a scheme to a naive test; a digit after the colon means a port.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return text;
  if (/\s/.test(text)) return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  const host = text.replace(/^\/\//, '').split(/[/?#]/)[0]!.replace(/:\d+$/, '');
  const hostLike = host.includes('.') || host.toLowerCase() === 'localhost' || /^\[[0-9a-f:]+\]$/i.test(host);
  return hostLike ? `https://${text.replace(/^\/\//, '')}` : `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** An open panel on a running browser that nobody holds takes the control lease by itself: there
 *  is no "take control" button. A browser held by another device is taken over by a click instead,
 *  and the agent never holds the lease. */
export function shouldAutoClaim(input: { holder: 'you' | 'other' | null; visible: boolean; hasProfile: boolean; running: boolean }): boolean {
  return input.holder === null && input.visible && input.hasProfile && input.running;
}
