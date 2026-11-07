'use client';

/**
 * Tag chips of the TO DO notebook: a read-only badge for the lists, and a
 * picker for the dialogs. The vocabulary is closed (`lib/project-todo-tags.ts`),
 * so the picker is a row of chips rather than a free-text field.
 */

import {
  Bug, Check, ChevronDown, Circle, CircleCheck, CircleDotDashed, FlaskConical, Flame,
  Lightbulb, Search, TriangleAlert, type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  PROGRESS_CLASS, TODO_PROGRESSES, TODO_URGENCIES, URGENCY_CLASS,
  type TodoProgress, type TodoUrgency,
} from '@/lib/project-todo-tags';
import type { ProjectTodoLink } from './project-todo-types';

const URGENCY_ICON: Record<TodoUrgency, LucideIcon> = {
  critical: Flame, bug: Bug, minor: TriangleAlert, idea: Lightbulb,
};
const PROGRESS_ICON: Record<TodoProgress, LucideIcon> = {
  todo: Circle, analyzed: Search, partial: CircleDotDashed, to_test: FlaskConical, done: CircleCheck,
};

const CHIP = 'inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10.5px] font-medium leading-4';
// Icon and count only, as tall as the filter bar's segments: the label moves to
// the caller's `title` / `aria-label`, so the type row fits beside Open/Done.
const CHIP_COMPACT = 'h-6 gap-0.5 px-1 py-0';

/** `children` trails the label — the type filter puts its count there. */
export function UrgencyBadge({ value, compact, children }: { value: TodoUrgency; compact?: boolean; children?: ReactNode }) {
  const Icon = URGENCY_ICON[value];
  return (
    <span className={cn(CHIP, compact && CHIP_COMPACT, URGENCY_CLASS[value])}>
      <Icon className="size-3" aria-hidden />
      {!compact && t(`projectTodo.urgency.${value}`)}
      {children}
    </span>
  );
}

/** A grey badge for the idea's number or author: same shape as the tags,
 *  no colour, so it reads as information rather than as a state. */
export function MetaBadge({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn(CHIP, 'border-transparent bg-foreground/[0.06] normal-case tracking-normal text-muted-foreground tabular-nums')}>
      {children}
    </span>
  );
}

/** The cockpit signs an idea `user`; ideas written before 0.1.6 carry the first
 *  name of the platform owner, which no tester should see. */
const LEGACY_COCKPIT_AUTHOR = 'Rom'; // public-name-ok: the signature ideas carry on installs from before 0.1.6
export function todoAuthorLabel(author: string): string {
  return author === 'user' || author === LEGACY_COCKPIT_AUTHOR ? t('projectTodo.authorUser') : author;
}

/** The idea's author, as text. A source-specific mark (a connector's logo)
 *  is a plugin's badge in `kanban.todo.badge`, not a case of the core. When the
 *  author is a provider the idea is linked to (`discord` + a `discord` link),
 *  that connector's badge already names it: a second chip would say it twice. */
export function AuthorBadge({ author, links }: { author: string; links?: ProjectTodoLink[] }) {
  if (links?.some((link) => link.provider === author)) return null;
  return <MetaBadge>{todoAuthorLabel(author)}</MetaBadge>;
}

/** The ideas without an urgency, as the type filter names them. */
export function UntypedBadge({ compact, children }: { compact?: boolean; children?: ReactNode }) {
  return (
    <span className={cn(CHIP, compact && CHIP_COMPACT, 'border-transparent bg-foreground/[0.06] text-muted-foreground')}>
      <Circle className="size-3" aria-hidden />
      {!compact && t('projectTodo.urgencyNone')}
      {children}
    </span>
  );
}

export function ProgressBadge({ value }: { value: TodoProgress }) {
  const Icon = PROGRESS_ICON[value];
  return (
    <span className={cn(CHIP, PROGRESS_CLASS[value])}>
      <Icon className="size-3" aria-hidden />
      {t(`projectTodo.progress.${value}`)}
    </span>
  );
}

export function Picker<T extends string>({
  values, selected, onSelect, classes, icons, labelKey, allowClear,
}: {
  values: readonly T[];
  selected: T | null;
  onSelect: (v: T | null) => void;
  classes: Record<T, string>;
  icons: Record<T, LucideIcon>;
  labelKey: string;
  allowClear: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((v) => {
        const Icon: LucideIcon = icons[v];
        const active = v === selected;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(active && allowClear ? null : v)}
            className={cn(
              CHIP, 'transition-opacity',
              active ? classes[v] : 'border-border bg-transparent text-muted-foreground/70 opacity-70 hover:opacity-100',
            )}
          >
            <Icon className="size-3" aria-hidden />
            {t(`${labelKey}.${v}`)}
          </button>
        );
      })}
    </div>
  );
}

/** Urgency is optional: clicking the active chip clears it. */
export function UrgencyPicker({ value, onChange }: { value: TodoUrgency | null; onChange: (v: TodoUrgency | null) => void }) {
  return (
    <Picker
      values={TODO_URGENCIES} selected={value} onSelect={onChange} classes={URGENCY_CLASS}
      icons={URGENCY_ICON} labelKey="projectTodo.urgency" allowClear
    />
  );
}

/** Progress always holds a value: clicking the active chip keeps it. */
export function ProgressPicker({ value, onChange }: { value: TodoProgress; onChange: (v: TodoProgress) => void }) {
  return (
    <Picker
      values={TODO_PROGRESSES} selected={value} onSelect={(v) => { if (v) onChange(v); }}
      classes={PROGRESS_CLASS} icons={PROGRESS_ICON} labelKey="projectTodo.progress" allowClear={false}
    />
  );
}

/** A tag as ONE chip that opens its vocabulary: the detail's header shows the
 *  value, not the five or six chips it is picked among. */
export function TagMenu<T extends string>({
  values, selected, onSelect, classes, icons, labelKey, allowClear, emptyLabel, ariaLabel,
}: {
  values: readonly T[];
  selected: T | null;
  onSelect: (v: T | null) => void;
  classes: Record<T, string>;
  icons: Record<T, LucideIcon>;
  labelKey: string;
  allowClear: boolean;
  emptyLabel: string;
  ariaLabel: string;
}) {
  const Active: LucideIcon | null = selected ? icons[selected] : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            CHIP, 'transition-colors hover:brightness-125',
            selected ? classes[selected] : 'border-dashed border-border text-muted-foreground',
          )}
        >
          {Active && <Active className="size-3" aria-hidden />}
          {selected ? t(`${labelKey}.${selected}`) : emptyLabel}
          <ChevronDown className="size-3 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[10rem]">
        {values.map((v) => {
          const Icon: LucideIcon = icons[v];
          return (
            <DropdownMenuItem key={v} onSelect={() => onSelect(v)} className="gap-2 text-[12.5px]">
              <Icon className="size-3.5" aria-hidden />
              {t(`${labelKey}.${v}`)}
              {v === selected && <Check className="ml-auto size-3.5" aria-hidden />}
            </DropdownMenuItem>
          );
        })}
        {allowClear && selected && (
          <DropdownMenuItem onSelect={() => onSelect(null)} className="text-[12.5px] text-muted-foreground">
            {t('projectTodo.detail.clearTag')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UrgencyMenu({ value, onChange }: { value: TodoUrgency | null; onChange: (v: TodoUrgency | null) => void }) {
  return (
    <TagMenu
      values={TODO_URGENCIES} selected={value} onSelect={onChange} classes={URGENCY_CLASS} icons={URGENCY_ICON}
      labelKey="projectTodo.urgency" allowClear emptyLabel={t('projectTodo.detail.untyped')}
      ariaLabel={t('projectTodo.fieldUrgency')}
    />
  );
}

export function ProgressMenu({ value, onChange }: { value: TodoProgress; onChange: (v: TodoProgress) => void }) {
  return (
    <TagMenu
      values={TODO_PROGRESSES} selected={value} onSelect={(v) => { if (v) onChange(v); }} classes={PROGRESS_CLASS}
      icons={PROGRESS_ICON} labelKey="projectTodo.progress" allowClear={false} emptyLabel=""
      ariaLabel={t('projectTodo.fieldProgress')}
    />
  );
}
