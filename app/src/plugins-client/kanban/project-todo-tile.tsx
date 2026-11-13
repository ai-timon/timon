'use client';

/**
 * The "TO DO" tile — the notebook edited outside the board.
 *
 * Two widgets are painted from this one component (part 4/4): "Kanban TO DO",
 * every idea of every project, and "Project TO DO", the same list narrowed to
 * one project. Narrowing is all that separates them, so the lines, the check,
 * the delete and the detail dialog are written once.
 *
 * It was the alternative to the board column, chosen by a `surfaces` option that
 * disappeared with `@timon/backlog`. It is now a widget of its own: a
 * registration in `cockpit.widget`, movable to any widget zone, which takes
 * nothing away from the column.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Lightbulb, Plus, Settings2 } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Tile } from '@/components/tile';
import { WidgetButton, widgetButtonClass, widgetSegmentClass } from '@/components/widget-toolbar';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import { t } from '@/lib/i18n';
import { sharedGet } from '@/lib/shared-read';
import { KanbanCardHost } from './kanban-card-slot';
import { TodoFormModal } from './todo-form-modal';
import { handOffIdea } from './todo-handoff';
import { UntypedBadge, UrgencyBadge } from './project-todo-tag-chips';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { TODO_DISPLAY_SCOPE, readTodoDisplay, writeTodoDisplay, type TodoDisplay } from '@/lib/project-todo-display';
import {
  countByUrgency, filterByUrgency, toggleUrgency, visibleUrgencyKeys, type UrgencyFilterKey,
} from '@/lib/project-todo-filter';
import type { ProjectTodo } from './project-todo-types';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import type { ClientRealtime } from '@/lib/plugin-host/realtime';
import { subscribeProjectTodoChanges } from '@/lib/project-todo-realtime';
import { cn } from '@/lib/utils';
import { NativeViewCover } from '@/lib/native-view-cover';

/**
 * What the tile lists.
 *
 * `all` is the general widget: the whole notebook, project column included in
 * each line. `project` narrows to one slug — and when no slug resolves, it says
 * so rather than falling back to the whole notebook, which would show the ideas
 * of every OTHER project under a header promising one.
 */
export type ProjectTodoScope =
  | { kind: 'all' }
  | { kind: 'project'; slug: string | null };

// Local only: `widgetSegmentClass` serves every widget toolbar. A notch lower,
// the segments match the type chips and the filter bar stays one thin line.
const SEGMENT_COMPACT = 'h-6 gap-1 px-1.5';

// ── Tile ────────────────────────────────────────────────────────────────────

export function ProjectTodoTile({
  scope,
  realtime,
  titre,
  entete,
  poignee,
  className,
  editing = false,
}: WidgetProps & {
  realtime: ClientRealtime;
  scope: ProjectTodoScope;
  titre: string;
  /** Placed in the header, before the facts toggle — that is where the
   *  "Project TO DO" tile puts its picker when no chat gives it a project.
   *  The tile owns its chassis, nobody else can put it there. */
  entete?: ReactNode;
}) {
  const [items, setItems] = useState<ProjectTodo[]>([]);
  const [chargement, setChargement] = useState(true);
  const [vueChoisie, setVue] = useState<'open' | 'done'>('open');
  const [creation, setCreation] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const detail = detailId === null ? null : items.find((i) => i.id === detailId) ?? null;
  // What each line shows besides title and tags, one setting per widget.
  const affichage = useStoredLayout(TODO_DISPLAY_SCOPE);
  const display = readTodoDisplay(affichage.raw, scope.kind);
  // A patch, applied to the row as it stands when written: a toggle made in
  // another window on the other badge must survive this one.
  const setDisplay = (patch: Partial<TodoDisplay>) => {
    if (!affichage.ready) return;
    void affichage.update((raw) => writeTodoDisplay(raw, scope.kind, { ...readTodoDisplay(raw, scope.kind), ...patch }));
  };
  // Plain React state: the widget host keeps no per-instance options, and a
  // type filter is a glance at the list, not a setting worth a registry.
  const [types, setTypes] = useState<ReadonlySet<UrgencyFilterKey>>(() => new Set());

  // A project scope without a slug loads NOTHING: the empty list is the right
  // answer, not the whole notebook under a header that promises a project.
  const projet = scope.kind === 'project' ? scope.slug : null;
  const inerte = scope.kind === 'project' && !projet;

  const load = useCallback(async () => {
    if (inerte) {
      setItems([]);
      setChargement(false);
      return;
    }
    try {
      const query = projet ? `?status=all&project=${encodeURIComponent(projet)}` : '?status=all';
      const r = await sharedGet(`/api/ui/project-todo${query}`);
      const j = (await r.json()) as { items?: ProjectTodo[] };
      setItems(j.items ?? []);
    } catch {
      // Silent: the cockpit must not shout about an API being down.
    } finally {
      setChargement(false);
    }
  }, [inerte, projet]);

  useEffect(() => {
    const unsubscribe = subscribeProjectTodoChanges(realtime, () => { void load(); });
    void load();
    return unsubscribe;
  }, [load, realtime]);

  const patch = async (id: number, fields: Partial<Pick<ProjectTodo, 'text' | 'status' | 'project' | 'notes'>>) => {
    await fetch(`/api/ui/project-todo/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });
    await load();
  };

  const supprimer = async (id: number) => {
    await fetch(`/api/ui/project-todo/${id}`, { method: 'DELETE' });
    await load();
  };

  const ouverts = useMemo(() => items.filter((i) => i.status === 'open'), [items]);
  const faits = useMemo(() => items.filter((i) => i.status === 'done'), [items]);
  // Reopening the last done idea must not strand the tile on an empty list.
  // Read on the unfiltered lists: a type filter must not flip the view.
  const vue = faits.length > 0 ? vueChoisie : 'open';
  const liste = vue === 'done' ? faits : ouverts;
  const visibles = useMemo(() => filterByUrgency(liste, types), [liste, types]);

  // Each control counts what pressing it would show, given the other one:
  // Open/Done count the selected types, a type chip counts the current view.
  const ouvertsFiltres = useMemo(() => filterByUrgency(ouverts, types).length, [ouverts, types]);
  const faitsFiltres = useMemo(() => filterByUrgency(faits, types).length, [faits, types]);
  const parType = useMemo(() => countByUrgency(liste), [liste]);
  const puces = visibleUrgencyKeys(parType, types);
  // One chip alone filters nothing: the row appears once there is a choice.
  const montrerFiltre = puces.length > 1 || types.size > 0;
  const filtreVide = visibles.length === 0 && liste.length > 0;

  return (
    <Tile
      title={titre}
      className={cn(HUD_SURFACE, className)}
      // The body scrolls on its own below the toolbar, so the filters stay put.
      bodyClassName="overflow-hidden p-0"
      actions={
        <>
          {/* Like the style menu of the card, only while the layout is edited. */}
          {editing && (
            <Dropdown.Root>
              <Dropdown.Trigger asChild>
                {/* A plain button: Radix anchors the menu through a ref, which a
                    function component does not forward on React 18. */}
                <button type="button" title={t('projectTodo.displayOptions')} aria-label={t('projectTodo.displayOptions')} className={widgetButtonClass({ iconOnly: true })}>
                  <Settings2 className="size-3" />
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content sideOffset={6} align="end" className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2">
                  <NativeViewCover />
                  <Dropdown.Label className="px-2 py-1.5 font-medium">{t('projectTodo.displayOptions')}</Dropdown.Label>
                  {([['showId', 'projectTodo.showId'], ['showAuthor', 'projectTodo.showAuthor']] as const).map(([key, label]) => (
                    <Dropdown.CheckboxItem
                      key={key}
                      checked={display[key]}
                      disabled={!affichage.ready}
                      // Kept open: the two badges are usually set together.
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(v) => setDisplay({ [key]: v === true })}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 outline-none focus:bg-muted data-[disabled]:opacity-50"
                    >
                      <span className="w-3">{display[key] ? '✓' : ''}</span>{t(label)}
                    </Dropdown.CheckboxItem>
                  ))}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          )}
          {entete}
          {/* The only way in: the full dialog, title and description at once.
              Without a resolved project it would file an idea the tile never
              shows, so it waits for the project. */}
          <WidgetButton
            primary
            onClick={() => setCreation(true)}
            title={t('projectTodo.newIdea')}
            disabled={inerte}
            icon={<Plus className="size-3" />}
            label={t('projectTodo.add')}
          />
          {poignee}
        </>
      }
    >
      {/* Under the header, not in it: `Tile` lays title, subtitle and actions on
          one line, where the counts squeezed the title out in a narrow zone. */}
      {/* One line in a ~320 px zone: the type chips are icon + count, pushed
          right; the wrap only rescues a very narrow zone. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-1.5">
        {/* The counts ARE the filter: one control says how many ideas are open,
            how many are done, and which of the two lists is showing. */}
        <span role="group" aria-label={t('projectTodo.filter')} className="inline-flex items-center gap-0.5">
          <button type="button" aria-pressed={vue === 'open'} onClick={() => setVue('open')} className={cn(widgetSegmentClass(vue === 'open'), SEGMENT_COMPACT)}>
            {t('projectTodo.open')}
            <span className="tabular-nums">{chargement ? '…' : ouvertsFiltres}</span>
          </button>
          <button type="button" aria-pressed={vue === 'done'} disabled={faits.length === 0} onClick={() => setVue('done')} className={cn(widgetSegmentClass(vue === 'done'), SEGMENT_COMPACT)}>
            {t('projectTodo.done')}
            <span className="tabular-nums">{chargement ? '…' : faitsFiltres}</span>
          </button>
        </span>
        {montrerFiltre && (
          <span role="group" aria-label={t('projectTodo.filterType')} className="ml-auto flex flex-wrap items-center gap-0.5">
            {puces.map((k) => {
              const actif = types.has(k);
              const libelle = k === 'none' ? t('projectTodo.urgencyNone') : t(`projectTodo.urgency.${k}`);
              const compte = <span className="tabular-nums opacity-80">{parType[k]}</span>;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={actif}
                  title={libelle}
                  aria-label={t('projectTodo.filterChip', { type: libelle, count: parType[k] })}
                  onClick={() => setTypes((s) => toggleUrgency(s, k))}
                  className={cn(
                    'rounded-md outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring',
                    actif ? 'opacity-100' : 'opacity-45 hover:opacity-80',
                  )}
                >
                  {k === 'none' ? <UntypedBadge compact>{compte}</UntypedBadge> : <UrgencyBadge value={k} compact>{compte}</UrgencyBadge>}
                </button>
              );
            })}
          </span>
        )}
      </div>

      {/* The fade says the list goes on: a row cut through its badge read as
          a rendering fault. The bottom padding lets the last row scroll
          clear of it. */}
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-6 pt-2 [mask-image:linear-gradient(to_bottom,#000_calc(100%-28px),transparent)]">
        {visibles.length === 0 && !chargement ? (
          <div className="flex flex-col items-center justify-center gap-2 py-6">
            <Lightbulb className="size-4 text-muted-foreground/60" aria-hidden />
            <span className="text-center text-[12.5px] text-muted-foreground">
              {inerte
                ? t('projectTodo.chooseProject')
                : filtreVide
                  ? t('projectTodo.emptyFilter')
                  : projet
                    ? t('projectTodo.emptyProject', { project: projet })
                    : t('projectTodo.empty')}
            </span>
            {filtreVide && (
              <WidgetButton onClick={() => setTypes(new Set())} label={t('projectTodo.clearFilter')} />
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visibles.map((it) => (
              <KanbanCardHost
                key={it.id}
                value={{
                  kind: 'todo',
                  density: 'row',
                  item: it,
                  show: { id: display.showId, author: display.showAuthor, project: scope.kind === 'all' },
                  open: () => setDetailId(it.id),
                  toggleDone: () => void patch(it.id, { status: it.status === 'done' ? 'open' : 'done' }),
                  handoff: it.project ? () => void handOffIdea(it.id) : null,
                  remove: () => void supprimer(it.id),
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {creation && <TodoFormModal defaultProject={projet} onSaved={load} onClose={() => setCreation(false)} />}

      {/* The item is read again from `items` on every render: after a save,
          the modal shows the reloaded version, not a frozen snapshot. */}
      {detail && <TodoFormModal item={detail} onSaved={load} onClose={() => setDetailId(null)} />}
    </Tile>
  );
}
