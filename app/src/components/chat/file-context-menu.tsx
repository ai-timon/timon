'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { DESTRUCTIVE_MENU_ITEM } from '@/components/ui/dropdown-menu';
import { NativeViewCover } from '@/lib/native-view-cover';

export type FileMenuItem = {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  /** Shown but inert; `title` says why. */
  disabled?: boolean;
  /** Secondary text after the label, muted and cut to fit (e.g. a shortened id). */
  detail?: string;
  /** Hover text of the row, for what `detail` had to shorten. */
  title?: string;
  /** Choosing the row shows these instead of selecting (`onSelect` is then ignored). */
  submenu?: FileMenuItem[];
};

const ITEM =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] outline-none transition-colors hover:bg-muted focus-visible:bg-muted';

/**
 * Right-click menu of a row of the Files widget. Hand-rolled, like the agent
 * avatar's menu: the product has no context-menu primitive, and a dependency
 * for four rows is not worth it. Portaled to the body so the widget's
 * `overflow` cannot clip it.
 */
export function FileContextMenu({
  x, y, label, items, onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: FileMenuItem[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // A row with a submenu swaps the list in place: one level, a handful of rows.
  const [sub, setSub] = useState<FileMenuItem[] | null>(null);
  const shown = sub ?? items;

  // Keep the menu inside the window, whichever corner was clicked.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [x, y, sub]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Capture phase: an element that stops the mousedown's propagation would
    // hide the click from a bubbling listener (TIM-0123).
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[80] min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-elev-3"
    >
      <NativeViewCover />
      {shown.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          aria-haspopup={it.submenu ? 'menu' : undefined}
          title={it.title}
          disabled={it.disabled}
          aria-disabled={it.disabled || undefined}
          className={cn(ITEM, it.danger && DESTRUCTIVE_MENU_ITEM, it.disabled && 'cursor-default opacity-50 hover:bg-transparent')}
          onClick={() => {
            if (it.submenu) { setSub(it.submenu); return; }
            onClose();
            it.onSelect();
          }}
        >
          {it.icon}
          {it.label}
          {it.detail && <span className="ml-auto min-w-0 truncate pl-3 text-[11px] text-muted-foreground">{it.detail}</span>}
          {it.submenu && <ChevronRight className="ml-auto size-3.5 text-muted-foreground" aria-hidden />}
        </button>
      ))}
    </div>,
    document.body,
  );
}
