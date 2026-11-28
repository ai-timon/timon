'use client';

/**
 * The modal frame a detail popup sits in: the task form today, the TO DO idea
 * next (`docs/PLUGINS.md`, "Cartes et popups du Kanban"; french-ok: the
 * heading of the French maintainers' note).
 *
 * It keeps what an occupant painted inside must not be able to break: the veil,
 * the focus held inside the frame and given back on close, Escape, a click on
 * the veil, and the page behind that does not scroll. The occupant only names
 * its title (`labelledBy`) and lays out its content.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NativeViewCover } from '@/lib/native-view-cover';

export type DetailFrameProps = {
  /** Id of the element that titles the dialog (`aria-labelledby`). */
  labelledBy: string;
  /** Escape, or a click on the veil. Kept stable by the caller. */
  onClose: () => void;
  children?: ReactNode;
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DetailFrame({ labelledBy, onClose, children }: DetailFrameProps): ReactElement {
  const frame = useRef<HTMLDivElement>(null);
  const pressedOnBackdrop = useRef(false);
  const close = onClose;

  // Read while rendering, before the title's `autoFocus` moves the focus on commit.
  const [opener] = useState(() => (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null));

  // The focus goes back where it was when the form opened; the page behind does not scroll.
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // An occupant without an autofocused field (or still loading) leaves the focus outside.
    if (frame.current && !frame.current.contains(document.activeElement)) frame.current.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // A key pressed in a popover the form opened (the model picker, portaled to
    // the body) still bubbles here through React: that popover handles it.
    const inFrame = !!frame.current?.contains(e.target as Node);
    const popoverOpen = !!document.querySelector('[data-popover-area]');
    if (e.key === 'Escape') {
      if (e.defaultPrevented || popoverOpen) return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab' || !inFrame || !frame.current) return;
    const items = Array.from(frame.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => !el.closest('[hidden]') && el.getClientRects().length > 0);
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === frame.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Portaled to the body: opened from a widget, the frame would otherwise stay
  // inside that widget's stacking context, and the chat column painted later
  // would show through it.
  return createPortal(
    <div
      className="timon-below-window-band timon-window-layer fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm md:p-6"
      onPointerDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (pressedOnBackdrop.current && e.target === e.currentTarget) close(); }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={frame}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        // The chrome fill is near black in dark and the veil darkens the page
        // to the same value: a border-token contour keeps the frame visible.
        // Light has contrast already and keeps its look; full screen (below md)
        // shows no veil.
        className="timon-island-backdrop flex h-full w-full flex-col overflow-hidden text-foreground shadow-elev-3 outline-none md:dark:ring-1 md:dark:ring-border md:h-[min(860px,calc(100vh-48px))] md:w-[min(1080px,100%)] md:rounded-[var(--timon-island-radius)]"
      >
        <NativeViewCover />
        {children}
      </div>
    </div>,
    document.body,
  );
}
