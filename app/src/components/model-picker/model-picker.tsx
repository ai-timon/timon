'use client';

/**
 * The one model selector of the UI (`docs/MODEL-PICKER.md`): a rail of
 * providers on the left (★ favourites, then one button per catalogue entry —
 * each subscription account is its own entry), the models of the opened view
 * on the right, the search at the bottom.
 *
 * Two shells share one list: `ModelPickerPanel` sits flat in a form or a
 * column, `ModelPickerPopover` opens from a chip (or a trigger the caller
 * renders). Both are HOSTS: they put their props in context
 * (`picker-context.ts`) and paint the occupant of the `model.picker` slot —
 * by default `ProductModelPicker`, registered as the slot's fallback by the
 * client half of `@timon/backends`; a plugin that takes the slot replaces it
 * on every surface at once. The popover keeps its anchoring, focus and closing
 * whoever paints its content, and every pick goes through `acceptsPick`. The
 * mock-up's rules between the rail, the list and the search are replaced by
 * surface contrast and spacing, and its fixed-width type by the product font
 * (AGENTS.md rule 16).
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Check, ChevronDown, Search, Star } from 'lucide-react';
import { AnchoredPopover, coarsePointer } from '@/components/anchored-popover';
import { AccountStateBadge } from '@/components/account-state-badge';
import { BackendLimitsBadge } from '@/components/backend-limits-badge';
import { BrandMark } from '@/components/brand-mark';
import { SelfPermissionsChip } from '@/components/self-permissions-badge';
import { UnverifiedBadge } from '@/components/unverified-badge';
import { useModelFavorites } from '@/hooks/use-model-favorites';
import {
  accountStateHint,
  CatalogTargetProvider,
  catalogPending,
  isPickable,
  refreshBackendCatalogIfStale,
  useBackendCatalog,
  vendorLabel,
  type BackendCatalog,
  type CatalogBackend,
} from '@/lib/backends';
import { catalogTargetQuery, type CatalogTarget } from '@/lib/catalog-target';
import { formatWindow } from '@/lib/llm-sort';
import { t } from '@/lib/i18n';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { MODEL_PICKER_SLOT } from '@/lib/plugin-host/slots';
import type { PopoverAlign, PopoverPlacement } from '@/lib/popover-placement';
import { cn } from '@/lib/utils';
import { ModelPickerContextProvider, useModelPicker, type ModelPickerContextValue } from './picker-context';
import {
  acceptsPick,
  initialView,
  orphanOf,
  pickLabel,
  providersOf,
  rowsFor,
  type ModelPick,
  type ModelPickerFilter,
  type PickerRow,
  type PickerView,
} from './picker-model';

/** Width of the panel, and the ceiling of the popover: compact, at the scale of the composer bar it opens from.
 *  The popover's height is its content's — the list's own rows, up to 292px, plus whatever the footer adds — so a
 *  short provider gives a short panel (never shorter than the rail) and a footer (thinking, a turn running, a
 *  confirmation) grows the panel instead of squeezing the list. */
const PANEL_WIDTH = 320;
const PANEL_MAX_HEIGHT = 520;

export type ModelPickerProps = {
  /** The pair held by the form; `null` = the inherit entry (or nothing chosen yet). */
  value: ModelPick | null;
  /** A row, a typed slug, or `null` from the inherit entry. */
  onChange: (pick: ModelPick | null) => void;
  /** Adds an "inherit / default" entry at the head of the list, which hands back `null`. */
  inherit?: { label: string; hint?: string };
  /** Offers a folded field to type a slug the catalogue does not list, for the opened provider. */
  allowCustomSlug?: boolean;
  /** Restricts the catalogue (rail, lists, favourites, search). */
  filter?: ModelPickerFilter;
  /**
   * The mission this choice is for: the catalogue is read for it, so a backend
   * whose reserved key it would not receive is not offered (TODO #531, 5-B).
   * Absent for a setting of the whole instance, which offers the inventory.
   */
  target?: CatalogTarget | null;
  /** Rendered under the list, above the search (the composer's thinking and context settings). */
  footer?: ReactNode;
  /** No pick possible (rows, inherit, typed slug); stars stay usable — they are the account's, not the form's. */
  disabled?: boolean;
};

type CoreProps = Omit<ModelPickerProps, 'target'> & {
  /** The catalogue this core reads was read for one mission. */
  targeted?: boolean;
  autoFocusSearch?: boolean;
  className?: string;
};

function rowDomId(base: string, key: string): string {
  return `${base}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function PickerCore({
  value,
  onChange,
  inherit,
  allowCustomSlug,
  filter,
  targeted,
  footer,
  disabled,
  autoFocusSearch,
  className,
}: CoreProps): React.ReactElement {
  const catalog = useBackendCatalog();
  const favs = useModelFavorites();
  const [query, setQuery] = useState('');
  /** `null` until the rail is touched: the view then follows the value, the favourites, the first provider. */
  const [chosenView, setChosenView] = useState<PickerView | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customSlug, setCustomSlug] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  useEffect(() => {
    if (autoFocusSearch) searchRef.current?.focus();
  }, [autoFocusSearch]);

  const providers = providersOf(catalog, filter);
  const view = chosenView ?? initialView(catalog, value, favs.favorites, filter);
  const searching = query.trim().length > 0;
  const rows = useMemo(
    () => rowsFor({ catalog, view, query, value, favorites: favs.favorites, filter }),
    [catalog, view, query, value, favs.favorites, filter],
  );
  const orphan = orphanOf(catalog, value, targeted);
  const opened = view.kind === 'provider' ? providers.find((b) => b.id === view.backend) ?? null : null;
  const pending = catalogPending(catalog);

  const head = searching
    ? t('modelPicker.results')
    : pending ? ''
    : view.kind === 'favorites'
      ? t('modelPicker.favorites')
      : opened ? vendorLabel(opened) : '';

  const pick = (next: ModelPick | null) => {
    if (disabled) return;
    onChange(next);
  };

  const open = (next: PickerView) => {
    setChosenView(next);
    setQuery('');
    setCustomOpen(false);
  };

  const enabledRows = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-picker-row]:not(:disabled)') ?? []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const inSearch = target === searchRef.current;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = enabledRows();
      const at = list.indexOf(target);
      if (at < 0 && !inSearch) return;
      e.preventDefault();
      if (list.length === 0) return;
      if (at < 0) { list[e.key === 'ArrowDown' ? 0 : list.length - 1]?.focus(); return; }
      if (e.key === 'ArrowUp' && at === 0) { searchRef.current?.focus(); return; }
      list[Math.min(list.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      return;
    }
    if (e.key === 'Enter' && inSearch) {
      e.preventDefault();
      enabledRows()[0]?.click();
      return;
    }
    // A first Escape empties the search; the next one is the popover's.
    if (e.key === 'Escape' && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    }
  };

  const showInherit = !!inherit && !searching;
  const showCustom = !!allowCustomSlug && !searching && !!opened;
  const empty = rows.length === 0;

  return (
    <div
      onKeyDown={onKeyDown}
      className={cn('flex min-h-0 overflow-hidden rounded-lg bg-popover text-popover-foreground', className)}
    >
      <nav
        aria-label={t('modelPicker.providers')}
        className="flex w-10 flex-none flex-col items-center gap-1 overflow-y-auto bg-muted/60 p-1.5"
      >
        <RailButton
          label={t('modelPicker.favorites')}
          active={!searching && !pending && view.kind === 'favorites'}
          onClick={() => open({ kind: 'favorites' })}
        >
          <Star className={cn('size-3.5', !searching && !pending && view.kind === 'favorites' && 'fill-current')} aria-hidden />
        </RailButton>
        {/* The mock-up's 1px rule becomes a gutter. */}
        <span aria-hidden className="h-1 flex-none" />
        {providers.map((backend) => (
          <RailButton
            key={backend.id}
            label={vendorLabel(backend)}
            title={railTitle(backend)}
            active={!searching && view.kind === 'provider' && view.backend === backend.id}
            dimmed={!isPickable(backend)}
            onClick={() => open({ kind: 'provider', backend: backend.id })}
          >
            <BrandMark icon={backend.icon} brand={backend.brand} className="size-3.5" />
            {!isPickable(backend) && (
              <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500" />
            )}
          </RailButton>
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span className="min-w-0 truncate">{head}</span>
          {!searching && opened && <AccountStateBadge backend={opened} className="normal-case tracking-normal" />}
          {/* What the provider cannot do (remote agent, no files), before the pick rather than after a refused turn. */}
          {!searching && opened && (
            <BackendLimitsBadge catalog={catalog} backend={opened.id} className="px-1 py-0 text-[9px] normal-case tracking-normal" />
          )}
          {/* A provider that settles its own tool uses, as the old grid said it (6/6). */}
          {!searching && opened?.selfManagedPermissions && (
            <SelfPermissionsChip className="px-1 py-0 text-[9px] normal-case tracking-normal" />
          )}
          {/* A provider written from its vendor's documentation says so before it is picked. */}
          {!searching && opened && <UnverifiedBadge entry={opened} className="px-1 py-0 text-[9px] normal-case tracking-normal" />}
          <span className="ml-auto tabular-nums">{rows.length}</span>
        </div>

        <div
          ref={listRef}
          role="group"
          aria-label={head || t('modelPicker.title')}
          className="flex max-h-[292px] min-h-0 flex-[1_1_auto] flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5"
        >
          {!searching && opened && !isPickable(opened) && (
            <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
              {accountStateHint(opened)}
            </p>
          )}
          {showInherit && (
            <PickerRowView
              id={rowDomId(baseId, 'inherit')}
              label={inherit.label}
              detail={inherit.hint}
              selected={value === null}
              disabled={!!disabled}
              onPick={() => pick(null)}
            />
          )}
          {orphan?.kind === 'gone' && !searching && (
            <PickerRowView
              id={rowDomId(baseId, 'orphan')}
              label={orphan.label}
              detail={orphan.hint}
              title={orphan.hint}
              selected
              disabled
              onPick={() => undefined}
            />
          )}
          {rows.map((row) => (
            <PickerRowView
              key={row.key}
              id={rowDomId(baseId, row.key)}
              label={row.label}
              account={row.account}
              detail={row.pending ? row.vendor : row.vendor ? `${row.vendor} · ${row.slug}` : row.slug}
              title={row.hint}
              contextWindow={row.contextWindow}
              isNew={row.isNew}
              selected={row.selected}
              disabled={!!disabled || !row.pickable}
              pending={row.pending}
              onPick={() => pick({ backend: row.backend, model: row.slug })}
              star={row.starrable ? { row, ready: favs.ready, onToggle: () => favs.toggle({ backend: row.backend, model: row.slug }) } : undefined}
            />
          ))}
          {pending && (
            <p role="status" className="px-2.5 py-4 text-[11px] leading-relaxed text-muted-foreground">{t('modelPicker.loading')}</p>
          )}
          {empty && !pending && (
            <p className="px-2.5 py-4 text-[11px] leading-relaxed text-muted-foreground">
              {searching
                ? t('modelPicker.noResults')
                : view.kind === 'favorites' ? t('modelPicker.favoritesEmpty') : t('modelPicker.noModels')}
            </p>
          )}
          {showCustom && opened && (
            <CustomSlug
              provider={vendorLabel(opened)}
              open={customOpen}
              onOpen={() => setCustomOpen(true)}
              value={customSlug}
              onValue={setCustomSlug}
              disabled={!!disabled || !isPickable(opened)}
              onSubmit={() => {
                const slug = customSlug.trim();
                if (slug) pick({ backend: opened.id, model: slug });
              }}
            />
          )}
        </div>

        {footer && <div className="flex-none px-2 pt-1">{footer}</div>}

        <div className="flex-none px-2 pb-2 pt-1.5">
          <label className="flex h-7 items-center gap-1.5 rounded-md bg-muted/60 px-2">
            <Search className="size-3 flex-none text-muted-foreground" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('modelPicker.searchLabel')}
              placeholder={t('modelPicker.search')}
              className="h-full min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>
      </div>
    </div>
  );
}

function railTitle(backend: CatalogBackend): string {
  const hint = accountStateHint(backend);
  return hint ? `${vendorLabel(backend)} — ${hint}` : vendorLabel(backend);
}

function RailButton({ label, title, active, dimmed, onClick, children }: {
  label: string;
  title?: string;
  active: boolean;
  dimmed?: boolean;
  onClick: () => void;
  children: ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={title ?? label}
      onClick={onClick}
      className={cn(
        'relative grid size-7 flex-none place-items-center rounded-md transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
        dimmed && !active && 'opacity-60',
      )}
    >
      {children}
    </button>
  );
}

function PickerRowView({ id, label, account, detail, title, contextWindow, isNew, selected, disabled, pending, onPick, star }: {
  id: string;
  label: string;
  /** The account serving the row, as a badge beside the name (favourites, search). */
  account?: string;
  detail?: string;
  title?: string;
  contextWindow?: number;
  isNew?: boolean;
  selected: boolean;
  disabled: boolean;
  /** Held while the catalogue loads: not offered yet, but drawn as the value, not greyed. */
  pending?: boolean;
  onPick: () => void;
  star?: { row: PickerRow; ready: boolean; onToggle: () => void };
}): React.ReactElement {
  return (
    <div
      className={cn(
        'flex flex-none items-center rounded-md transition-colors',
        selected ? 'bg-primary/10 ring-1 ring-inset ring-primary/50' : !disabled && 'hover:bg-muted/60',
      )}
    >
      <button
        id={id}
        type="button"
        data-picker-row=""
        aria-pressed={selected}
        disabled={disabled}
        title={title}
        onClick={onPick}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-2 pr-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
          disabled && !pending && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-xs font-medium leading-tight text-foreground">{label}</span>
            {account && (
              <span className="max-w-[45%] flex-none truncate rounded bg-muted px-1 py-px text-[9px] font-medium leading-tight text-muted-foreground">
                {account}
              </span>
            )}
          </span>
          {detail && <span className="truncate text-[10px] leading-tight text-muted-foreground">{detail}</span>}
        </span>
        {isNew && (
          <span className="flex-none rounded bg-primary/10 px-1 py-px text-[9px] font-medium text-foreground">
            {t('modelPicker.new')}
          </span>
        )}
        {/* Absent when not known from a safe source: better nothing than an invented figure. */}
        {contextWindow && (
          <span className="flex-none text-[10px] tabular-nums text-muted-foreground">{formatWindow(contextWindow)}</span>
        )}
      </button>
      {star ? (
        <button
          type="button"
          aria-label={t(star.row.isFavorite ? 'modelPicker.removeFavorite' : 'modelPicker.addFavorite', { name: label })}
          aria-pressed={star.row.isFavorite}
          disabled={!star.ready}
          onClick={star.onToggle}
          className={cn(
            'grid size-6 flex-none place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
            star.row.isFavorite ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground',
          )}
        >
          <Star className={cn('size-3', star.row.isFavorite && 'fill-current')} aria-hidden />
        </button>
      ) : (
        <span aria-hidden className="size-6 flex-none" />
      )}
      <span className="grid w-5 flex-none place-items-center">
        {selected && <Check role="img" aria-label={t('modelPicker.selected')} className="size-3 text-primary" />}
      </span>
    </div>
  );
}

function CustomSlug({ provider, open, onOpen, value, onValue, disabled, onSubmit }: {
  provider: string;
  open: boolean;
  onOpen: () => void;
  value: string;
  onValue: (next: string) => void;
  disabled: boolean;
  onSubmit: () => void;
}): React.ReactElement {
  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="mt-0.5 self-start px-2 text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground disabled:opacity-50"
      >
        {t('modelPicker.customAction')}
      </button>
    );
  }
  return (
    <form
      className="mt-1 flex flex-none items-center gap-2 px-1"
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
    >
      <input
        value={value}
        onChange={(e) => onValue(e.target.value)}
        // Enter submits the form; arrows must not jump to the list from here.
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.stopPropagation(); }}
        aria-label={t('modelPicker.customLabel', { provider })}
        placeholder={t('modelPicker.customPlaceholder')}
        disabled={disabled}
        autoFocus
        className="h-6 min-w-0 flex-1 rounded-md bg-muted/60 px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="h-6 flex-none rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-opacity disabled:opacity-50"
      >
        {t('modelPicker.customUse')}
      </button>
    </form>
  );
}

/**
 * The product's picker, as the default occupant of `model.picker`: what every
 * host paints while no plugin takes the slot. Takes no props, like any
 * occupant — it reads the host's `useModelPicker()`.
 */
export function ProductModelPicker(): React.ReactElement | null {
  const host = useModelPicker();
  if (!host) return null;
  return (
    <PickerCore
      value={host.value}
      onChange={host.onChange}
      inherit={host.inherit}
      allowCustomSlug={host.allowCustomSlug}
      filter={host.filter}
      targeted={!!host.target}
      footer={host.footer}
      disabled={host.disabled}
      autoFocusSearch={host.autoFocusSearch}
      className={host.className}
    />
  );
}

/**
 * Paints the slot's occupant for one picker. An empty slot — a page the
 * bundled halves do not reach, the instant they are remounted — still gets
 * the product's picker: a form never loses its model field.
 */
function PickerHost({ host }: { host: ModelPickerContextValue }): React.ReactElement {
  const claimed = useSlotEntries(MODEL_PICKER_SLOT).length > 0;
  return (
    <ModelPickerContextProvider value={host}>
      <CatalogTargetProvider value={host.target}>
        {claimed ? <SlotSingle name={MODEL_PICKER_SLOT} /> : <ProductModelPicker />}
      </CatalogTargetProvider>
    </ModelPickerContextProvider>
  );
}

/** The context a host gives its occupant, `onChange` guarded by `acceptsPick`. */
function hostValue(
  props: ModelPickerProps,
  catalog: BackendCatalog,
  shell: Pick<ModelPickerContextValue, 'mode' | 'autoFocusSearch' | 'className' | 'label' | 'popover'> & { afterPick?: () => void },
): ModelPickerContextValue {
  const { afterPick, ...rest } = shell;
  const disabled = !!props.disabled;
  const allowCustomSlug = !!props.allowCustomSlug;
  return {
    ...rest,
    // On a touch screen a focused field opens the soft keyboard: the search
    // waits for the user's touch. Decided here, so an occupant gets it too.
    autoFocusSearch: rest.autoFocusSearch && !coarsePointer(),
    value: props.value,
    inherit: props.inherit,
    allowCustomSlug,
    filter: props.filter,
    // An empty target reads the inventory: it is no mission to speak of.
    target: catalogTargetQuery(props.target) ? props.target ?? null : null,
    footer: props.footer,
    disabled,
    onChange: (pick) => {
      const ok = acceptsPick(catalog, pick, {
        value: props.value, inherit: !!props.inherit, allowCustomSlug, disabled, filter: props.filter,
      });
      if (!ok) return;
      props.onChange(pick);
      afterPick?.();
    },
  };
}

/** Flat picker, for a form or a column. Its height is the mock-up's unless `className` says otherwise. */
export function ModelPickerPanel({ className, autoFocusSearch, ...props }: ModelPickerProps & {
  className?: string;
  autoFocusSearch?: boolean;
}): React.ReactElement {
  const catalog = useBackendCatalog(props.target ?? null);
  return (
    <PickerHost
      host={hostValue(props, catalog, {
        mode: 'panel',
        autoFocusSearch: !!autoFocusSearch,
        className: cn('h-[360px] w-full', className),
        label: t('modelPicker.title'),
        popover: null,
      })}
    />
  );
}

/** What a caller's own trigger spreads on its button (`renderTrigger`). */
export type ModelPickerTriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  disabled: boolean;
  'aria-haspopup': 'dialog';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
};

export type ModelPickerPopoverProps = ModelPickerProps & {
  /** `end` (default) lines the panel's right edge up with the trigger's, `start` its left edge. */
  align?: PopoverAlign;
  /** `below` (default: under the trigger, above it when the room is there) or `beside` (a vertical rail). */
  side?: PopoverPlacement;
  /** Replaces the default chip. Spread the props on a `<button>` (or a component forwarding its ref). */
  renderTrigger?: (props: ModelPickerTriggerProps) => ReactNode;
  /** Controlled opening (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name of the panel; "Choose a model" by default. */
  label?: string;
  /** Extra classes for the default chip. */
  triggerClassName?: string;
  /** A pick leaves the popover open; the caller closes it through `open` / `onOpenChange`
   *  (the composer arms a confirmation in the `footer` first). */
  keepOpenOnPick?: boolean;
};

/** The picker in a popover, opened from a chip (BrandMark + short label) or the caller's trigger. */
export function ModelPickerPopover({
  align = 'end',
  side = 'below',
  renderTrigger,
  open: openProp,
  onOpenChange,
  label,
  triggerClassName,
  keepOpenOnPick,
  ...props
}: ModelPickerPopoverProps): React.ReactElement {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  // Read for its mission once open: a board mounts one closed chip per card, and
  // what a chip names is the value it holds, whoever may still run it.
  const catalog = useBackendCatalog(open ? props.target ?? null : null);
  const panelId = useId();
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };
  // A pick (or an occupant's own close) shuts the popover and gives the focus back to the trigger.
  const close = () => {
    setOpen(false);
    anchorRef.current?.focus();
  };
  // A long-mounted chip must not offer an account on a state read long ago.
  useEffect(() => { if (open) refreshBackendCatalogIfStale(); }, [open]);

  const triggerProps: ModelPickerTriggerProps = {
    ref: anchorRef,
    onClick: () => setOpen(!open),
    disabled: !!props.disabled,
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': open ? panelId : undefined,
  };

  return (
    <>
      {renderTrigger
        ? renderTrigger(triggerProps)
        : <DefaultChip trigger={triggerProps} catalog={catalog} value={props.value} inherit={props.inherit} className={triggerClassName} />}
      <AnchoredPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        placement={side}
        align={align}
        width={PANEL_WIDTH}
        maxHeight={PANEL_MAX_HEIGHT}
        sheet
        label={label ?? t('modelPicker.title')}
        id={panelId}
        className="overflow-hidden"
      >
        <PickerHost
          host={hostValue(props, catalog, {
            mode: 'popover',
            autoFocusSearch: true,
            className: 'min-h-0 flex-[0_1_auto]',
            label: label ?? t('modelPicker.title'),
            popover: { align, side, close, keepOpenOnPick: !!keepOpenOnPick },
            afterPick: keepOpenOnPick ? undefined : close,
          })}
        />
      </AnchoredPopover>
    </>
  );
}

function DefaultChip({ trigger, catalog, value, inherit, className }: {
  /** Not spread as props: React 18 keeps `ref` from reaching a function component. */
  trigger: ModelPickerTriggerProps;
  catalog: BackendCatalog;
  value: ModelPick | null;
  inherit?: { label: string };
  className?: string;
}): React.ReactElement {
  const backend = value ? catalog.backends.find((b) => b.id === value.backend) : undefined;
  const model = backend?.models.find((m) => m.slug === value?.model);
  const orphan = orphanOf(catalog, value);
  const text = value ? pickLabel(catalog, value) : inherit?.label ?? t('modelPicker.choose');
  return (
    <button
      type="button"
      {...trigger}
      title={orphan?.kind === 'gone' ? orphan.label : backend ? `${vendorLabel(backend)} · ${value?.model ?? ''}` : undefined}
      className={cn(
        'inline-flex h-8 max-w-full items-center gap-2 rounded-lg bg-muted/50 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
        orphan?.kind === 'gone' && 'text-muted-foreground',
        className,
      )}
    >
      {value && (
        <BrandMark
          icon={model?.icon}
          brand={model?.brand}
          slug={value.model}
          fallbackIcon={backend?.icon}
          fallbackBrand={backend?.brand}
          className="size-4"
        />
      )}
      <span className="min-w-0 truncate">{text}</span>
      <ChevronDown className="size-3.5 flex-none text-muted-foreground" aria-hidden />
    </button>
  );
}
