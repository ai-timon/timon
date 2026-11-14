'use client';

import { useEffect, useRef, type RefObject, type ReactNode } from 'react';
import { browserModifiers, browserPointer, browserRectOnSurface, type BrowserShot } from '@/lib/native-browser';
import { BrowserSurfaceSlot, type BrowserSurface } from '@/components/browser-chrome';
import { clipboardShortcut, mouseButton, type ClipboardKind, type RemoteInput } from '@/lib/native-browser-input';
import { t } from '@/lib/i18n';

export function BrowserRemoteSurface({ surface, video, overlay, controlled, blocked, running, viewport, screenshot, useScreenshot, dragTouch, sendInput, children, onClipboard }: {
  surface: RefObject<HTMLDivElement | null>; video: RefObject<HTMLVideoElement | null>; overlay: boolean; controlled: boolean; blocked: boolean; running: boolean;
  viewport: { width: number; height: number }; screenshot: BrowserShot | null; useScreenshot: boolean; dragTouch: boolean;
  sendInput: (input: RemoteInput) => void; children: ReactNode;
  /** Raised by the DOM copy/cut/paste events. A paste carries the clipboard text, read without any permission prompt. */
  onClipboard: (action: { kind: Exclude<ClipboardKind, 'paste'> } | { kind: 'paste'; text: string }) => void;
}) {
  const press = useRef<{ x: number; y: number; originalX: number; originalY: number; moved: boolean; pointerId: number; button: 'left' | 'right' | 'middle'; count: number; remoteDown: boolean } | null>(null);
  const cursor = useRef<SVGSVGElement>(null);
  const previousClick = useRef({ x: -100, y: -100, at: 0, count: 0 });
  // Frame dimensions determine letterboxing, never the CSS input coordinates.
  const frame = () => (useScreenshot ? screenshot ?? viewport : video.current?.videoWidth ? { width: video.current.videoWidth, height: video.current.videoHeight } : viewport);
  const point = (x: number, y: number, clamp = false) => {
    const bounds = surface.current?.getBoundingClientRect();
    if (!bounds) return null;
    const source = frame();
    const mapped = browserPointer(x, y, bounds, viewport, source);
    if (mapped || !clamp) return mapped;
    const scale = Math.min(bounds.width / source.width, bounds.height / source.height);
    const left = bounds.left + (bounds.width - source.width * scale) / 2;
    const top = bounds.top + (bounds.height - source.height * scale) / 2;
    return { x: Math.min(viewport.width - 1, Math.max(0, Math.floor((x - left) / (source.width * scale) * viewport.width))), y: Math.min(viewport.height - 1, Math.max(0, Math.floor((y - top) / (source.height * scale) * viewport.height))) };
  };
  const interactive = !overlay && controlled && !blocked && running;
  // Not gated on `controlled`: the panel answers a clipboard gesture from a non-controlling device instead of staying silent.
  const clipboardReady = !overlay && !blocked && running;
  const hideCursor = () => {
    if (cursor.current) cursor.current.style.visibility = 'hidden';
    if (surface.current) surface.current.style.cursor = '';
  };
  const updateCursor = (event: { clientX: number; clientY: number; pointerType: string }) => {
    if (!interactive || event.pointerType === 'touch' || !point(event.clientX, event.clientY)) { hideCursor(); return; }
    const bounds = surface.current!.getBoundingClientRect();
    // Chromium's macOS capture observes host drags in every window and can bake
    // an unrelated, offset OS cursor into the video. A transparent system cursor
    // plus this client-side pointer avoids both that ghost and round-trip latency.
    surface.current!.style.cursor = 'none';
    if (cursor.current) {
      cursor.current.style.transform = `translate(${event.clientX - bounds.left}px, ${event.clientY - bounds.top}px)`;
      cursor.current.style.visibility = 'visible';
    }
  };
  useEffect(() => { hideCursor(); }, [interactive, useScreenshot]);
  // Rebuilt each render: the picture's place is read when a layer asks, never cached.
  const layers: BrowserSurface = {
    native: overlay,
    blocked: blocked || !running,
    viewport,
    toPage: (x, y) => point(x, y),
    toSurface: (rect) => {
      const bounds = surface.current?.getBoundingClientRect();
      return bounds ? browserRectOnSurface(rect, bounds, viewport, frame()) : null;
    },
  };
  // A layer that took the event (`preventDefault`) keeps it from the page.
  const taken = (event: { defaultPrevented: boolean }) => { if (!event.defaultPrevented) return false; hideCursor(); return true; };
  // What is clicked in a `browser.surface` layer (the PWA's annotation bubble, its pins) is Timon's,
  // never the page's. Keys are stricter: only the focused surface itself types into the page.
  const inLayer = (event: { target: EventTarget; currentTarget: EventTarget }) =>
    event.target !== event.currentTarget && !!(event.target as Partial<Element>).closest?.('[data-browser-surface]');
  const notTheSurface = (event: { target: EventTarget; currentTarget: EventTarget }) => event.target !== event.currentTarget;
  return <div ref={surface} tabIndex={interactive ? 0 : -1} aria-label={t('browserPanel.native.page')} className="relative min-h-0 flex-1 touch-none overflow-hidden bg-black outline-none"
    onPointerEnter={updateCursor}
    onPointerLeave={hideCursor}
    onBlur={hideCursor}
    onContextMenu={(event) => event.preventDefault()}
    onPointerDown={(event) => {
      if (taken(event)) return;
      if (inLayer(event)) { hideCursor(); return; }
      updateCursor(event);
      if (!interactive) return;
      const mapped = point(event.clientX, event.clientY); if (!mapped) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture?.(event.pointerId);
      const last = previousClick.current;
      const count = event.button === 0 && Date.now() - last.at < 500 && Math.hypot(mapped.x - last.x, mapped.y - last.y) < 6 ? Math.min(2, last.count + 1) : 1;
      const button = mouseButton(event.button);
      const remoteDown = event.pointerType !== 'touch' || dragTouch;
      press.current = { x: event.clientX, y: event.clientY, originalX: event.clientX, originalY: event.clientY, moved: false, pointerId: event.pointerId, button, count, remoteDown };
      if (remoteDown) sendInput({ type: 'down', ...mapped, button, buttons: event.buttons, clickCount: count, modifiers: browserModifiers(event) });
    }}
    onPointerMove={(event) => {
      if (taken(event)) return;
      // A captured press keeps its target on the surface: a move over a layer is not the page's.
      if (inLayer(event)) { hideCursor(); return; }
      updateCursor(event);
      if (!interactive) return;
      const down = press.current;
      const mapped = point(event.clientX, event.clientY, !!down); if (!mapped) return;
      if (down && Math.hypot(event.clientX - down.originalX, event.clientY - down.originalY) > 5) down.moved = true;
      if (event.pointerType === 'touch' && down && !down.remoteDown) {
        if (Math.hypot(event.clientX - down.originalX, event.clientY - down.originalY) > 5 || down.moved) {
          down.moved = true; sendInput({ type: 'wheel', ...mapped, deltaX: down.x - event.clientX, deltaY: down.y - event.clientY });
          down.x = event.clientX; down.y = event.clientY;
        }
      } else {
        // The captured pointer owns its pressed button until up/cancel. Some
        // desktop event sources report buttons=0 on a move during that capture.
        const buttons = event.buttons | (down?.remoteDown ? { left: 1, right: 2, middle: 4 }[down.button] : 0);
        sendInput({ type: 'move', ...mapped, buttons, button: down?.button ?? (buttons ? mouseButton(buttons & 2 ? 2 : buttons & 4 ? 1 : 0) : 'none'), modifiers: browserModifiers(event) });
      }
    }}
    onPointerUp={(event) => {
      if (taken(event)) return;
      if (inLayer(event) && !press.current) return;
      const down = press.current; press.current = null;
      if (!interactive || !down || down.pointerId !== event.pointerId) return;
      const mapped = point(event.clientX, event.clientY, down.remoteDown); if (!mapped) return;
      if (down.remoteDown) sendInput({ type: 'up', ...mapped, button: down.button, buttons: 0, clickCount: down.count, modifiers: browserModifiers(event) });
      else if (!down.moved) sendInput({ type: 'click', ...mapped, button: down.button, clickCount: down.count });
      if (!down.moved) previousClick.current = { ...mapped, at: Date.now(), count: down.count };
    }}
    onPointerCancel={(event) => { const down = press.current; press.current = null; if (interactive && down?.remoteDown) { const mapped = point(event.clientX, event.clientY, true); if (mapped) sendInput({ type: 'up', ...mapped, button: down.button, buttons: 0 }); } }}
    onWheel={(event) => { if (!interactive) return; const mapped = point(event.clientX, event.clientY); if (mapped) sendInput({ type: 'wheel', ...mapped, deltaX: event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1), deltaY: event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1) }); }}
    onKeyDown={(event) => {
      if (!interactive || notTheSurface(event) || event.nativeEvent.isComposing) return;
      // Clipboard gestures stay native: cancelling the key would cancel the paste/copy/cut event below.
      if (clipboardShortcut(event)) return;
      event.preventDefault();
      sendInput(event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? { type: 'text', text: event.key } : { type: 'key', key: event.key, modifiers: browserModifiers(event) });
    }}
    onPaste={(event) => {
      if (!clipboardReady || event.target !== event.currentTarget) return;
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (text) onClipboard({ kind: 'paste', text });
    }}
    onCopy={(event) => { if (!clipboardReady || event.target !== event.currentTarget) return; event.preventDefault(); onClipboard({ kind: 'copy' }); }}
    onCut={(event) => { if (!clipboardReady || event.target !== event.currentTarget) return; event.preventDefault(); onClipboard({ kind: 'cut' }); }}>
    <video ref={video} playsInline autoPlay disablePictureInPicture disableRemotePlayback className={`pointer-events-none absolute inset-0 h-full w-full object-contain ${overlay || useScreenshot || !running ? 'hidden' : ''}`} />
    {!overlay && useScreenshot && screenshot && running && <img alt={t('browserPanel.native.page')} draggable={false} src={`data:${screenshot.mimeType};base64,${screenshot.data}`} className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain" />}
    <svg ref={cursor} data-browser-cursor aria-hidden="true" width="18" height="24" viewBox="0 0 18 24" className="pointer-events-none absolute left-0 top-0 z-10" style={{ visibility: 'hidden' }}>
      <path d="M1 1L1 19L5.5 14.5L9 22L12.5 20.5L9 13L16 13Z" fill="white" stroke="black" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
    <BrowserSurfaceSlot value={layers} />
    {children}
  </div>;
}
