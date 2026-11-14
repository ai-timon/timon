'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The row under a widget's tabs (or title): context on the left — a filter, a
 * select, a path — actions on the right. Every widget draws it with these
 * pieces so heights, margins and buttons match from one card to the next.
 *
 * Buttons are ghost: no outline, a muted fill on hover. Only the widget's main
 * action (`primary`) keeps a fill of its own, so it stands out from the icons
 * without the outline every other control has lost.
 */
export const WIDGET_TOOLBAR = 'flex h-9 shrink-0 items-center gap-1.5 px-3';

export function widgetButtonClass({ primary = false, iconOnly = false }: { primary?: boolean; iconOnly?: boolean } = {}): string {
  return cn(
    'inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md text-[11px] font-medium outline-none transition-colors',
    'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40',
    iconOnly ? 'w-7' : 'px-2',
    primary
      ? 'bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  );
}

// A ref, so a menu trigger (`asChild`) can anchor on it.
export const WidgetButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  /** Shown next to the icon. Without it the button is a square icon, and
   *  `title` (required then) names it. */
  label?: ReactNode;
  primary?: boolean;
}>(function WidgetButton({ icon, label, primary, className, ...props }, ref) {
  return <button ref={ref} type="button" {...props} className={cn(widgetButtonClass({ primary, iconOnly: !label }), className)}>
    {icon}
    {label}
  </button>;
});

/** A select in the toolbar: filled like a pressed ghost button, same height. */
export const WIDGET_SELECT = 'h-7 min-w-0 rounded-md border-0 bg-muted/60 px-2 text-[11px] text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring';

/** One option of a segmented filter: ghost, the pressed one filled. */
export function widgetSegmentClass(active: boolean): string {
  return cn(
    'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium outline-none transition-colors',
    'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40',
    active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
  );
}

/** The left-hand label of a toolbar (a path, a branch): muted mono, truncated. */
// code-font: a path or a branch name
export const WIDGET_TOOLBAR_LABEL = 'min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground';
