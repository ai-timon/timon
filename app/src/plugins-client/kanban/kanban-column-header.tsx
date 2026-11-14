'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Head of a Kanban column: colour dot, label, real count. Shared by the status
 * columns and the TO DO column (an occupant of `kanban.column`), so a plugin
 * column and a status column read the same way.
 */
export function KanbanColumnHeader({ label, count, dotClass, pulse }: {
  label: string;
  count: ReactNode;
  /** A theme token class (`bg-primary`, `bg-warning`…), never a literal colour. */
  dotClass: string;
  pulse?: boolean;
}) {
  return (
    <header className="flex items-center gap-2 px-3 pb-1.5 pt-3">
      <span aria-hidden className={cn('size-2 flex-none rounded-full', dotClass, pulse && 'animate-pulse')} />
      <h2 className="m-0 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</h2>
      <span className="ml-auto text-[12px] tabular-nums text-muted-foreground">{count}</span>
    </header>
  );
}

/** Message of a column with nothing to show; a plain surface, no dashed frame. */
export function KanbanColumnEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 px-2 py-5 text-center text-[12.5px] text-muted-foreground">
      {children}
    </p>
  );
}
