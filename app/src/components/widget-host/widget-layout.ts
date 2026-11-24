/**
 * Widget arrangement: which widget in which zone, at which rank, at which
 * height.
 *
 * Pure model: this file reads and writes nothing. Persistence is the daemon's
 * (`lib/ui-layout-store.ts`), which returns a raw value; `mergeLayout` is
 * what checks it against the registry.
 *
 * A zone is identified by a free string, no longer by the two cockpit rails:
 * the destinations are slots (§10.8), a third-party layout can declare others,
 * and the model has no reason to know their list. The field keeps its
 * historical name `rail`: it is the key written in the placements already
 * persisted, and renaming it would invalidate them all.
 */

export type ZoneId = string;
export type WidgetHeightMode = 'fixed' | 'fill';

/** Includes placements waiting in an unmounted zone (e.g. cockpit widgets
 * while visiting a chat). Adding one affects only the current workspace. */
export function availableWidgets(layout: readonly WidgetLayout[], mounted: readonly ZoneId[]): WidgetLayout[] {
  const zones = new Set(mounted);
  return layout.filter(widget => widget.removed || !zones.has(widget.rail));
}

export type WidgetLayout = {
  id: string;
  rail: ZoneId;
  rang: number;
  hauteur: number;
  /** Fill the zone's remaining height; hauteur remembers the fixed size. */
  heightMode?: WidgetHeightMode;
  /** Share of the FREE height taken in `fill` mode, in percent. Absent = 100.
   *  Two widgets at 50 split the remaining room, a single one at 50 leaves half
   *  of it empty: it is a growth share, not an absolute size. */
  fillPercent?: number;
  /**
   * Taken out of the interface by the user. The entry stays: it remembers the
   * widget is deliberately away, where dropping it from the layout would let
   * `mergeLayout` put it back at its defaults on the next load.
   *
   * This is placement state, owned by the user and stored in the layout JSON.
   * It is NOT `ui.hidden` (config) nor a disabled module (host capabilities):
   * both of those are decided elsewhere, filter earlier, and never surface a
   * widget as merely tidied away — see `widget-host.tsx`.
   */
  removed?: boolean;
  group?: string;
  activeTab?: boolean;
  borderless?: boolean;
  transparent?: boolean;
  /** When the widget made that choice (ms). A choice older than the site-wide style's last change is overruled by it. */
  borderlessAt?: number;
  transparentAt?: number;
  /** A lone widget shows its content only: no tab, no title in its header. */
  untitled?: boolean;
};

/** A widget's constraints, extracted from the registry to keep this module pure. */
export type WidgetConstraints = {
  id: string;
  defaultHeight: number;
  minHeight: number;
  heightMode?: WidgetHeightMode;
  defaultZone: ZoneId;
  defaultRank: number;
  /** See `WidgetOptions.placedByDefault`. */
  placedByDefault?: boolean;
  /** Placement ids this widget used to be stored under (`WidgetOptions.formerKeys`). */
  formerIds?: readonly string[];
};

/**
 * Splits a layout in two: the widgets on screen, and those the user removed.
 *
 * Every mutator below goes through this. Removed entries are inert — they hold
 * a stale zone and rank, so letting them into a regrouping or a renumbering
 * would either shift the placed widgets or, worse, drop the removed one along
 * the way and resurrect it at its defaults on the next load.
 */
function partition(layout: readonly WidgetLayout[]): {
  placed: WidgetLayout[];
  removed: WidgetLayout[];
} {
  const placed: WidgetLayout[] = [];
  const removed: WidgetLayout[] = [];
  for (const w of layout) (w.removed ? removed : placed).push(w);
  return { placed, removed };
}

function isZone(v: unknown): v is ZoneId {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Groups a layout by zone, each group sorted by rank, in the order the zones
 * appear. Used to rewrite a layout without ever mixing two zones.
 */
function groupByZone(layout: readonly WidgetLayout[]): Map<ZoneId, WidgetLayout[]> {
  const groups = new Map<ZoneId, WidgetLayout[]>();
  for (const w of [...layout].sort((a, b) => a.rang - b.rang)) {
    const group = groups.get(w.rail);
    if (group) group.push(w);
    else groups.set(w.rail, [w]);
  }
  return groups;
}

/** A raw storage entry, before being checked against the registry. */
function readEntry(raw: unknown): WidgetLayout | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  if (!isZone(o.rail)) return null;
  if (typeof o.rang !== 'number' || !Number.isFinite(o.rang)) return null;
  if (typeof o.hauteur !== 'number' || !Number.isFinite(o.hauteur)) return null;
  const e: WidgetLayout = { id: o.id, rail: o.rail, rang: o.rang, hauteur: o.hauteur };
  if (o.heightMode === 'fixed' || o.heightMode === 'fill') e.heightMode = o.heightMode;
  const part = readFillPercent(o.fillPercent);
  if (part !== null) e.fillPercent = part;
  // Read back explicitly: this whitelist is what persists across a reload, and
  // a field missing here is a removal that silently undoes itself.
  if (o.removed === true) e.removed = true;
  if (typeof o.group === 'string' && o.group.length > 0) e.group = o.group;
  if (o.activeTab === true) e.activeTab = true;
  // Both ways are kept: `false` is the widget saying "bordered, whatever the
  // site does", which is not the same as having said nothing.
  if (typeof o.borderless === 'boolean') e.borderless = o.borderless;
  if (typeof o.transparent === 'boolean') e.transparent = o.transparent;
  if (typeof o.borderlessAt === 'number' && Number.isFinite(o.borderlessAt)) e.borderlessAt = o.borderlessAt;
  if (typeof o.transparentAt === 'number' && Number.isFinite(o.transparentAt)) e.transparentAt = o.transparentAt;
  if (o.untitled === true) e.untitled = true;
  return e;
}

/**
 * The stored placement a renamed widget takes over: the first of its former
 * ids still on screen. A former id the user had removed hands nothing down —
 * the widget then lands where it would for anyone.
 */
export function inheritedPlacement(raw: unknown, formerIds: readonly string[], id: string): WidgetLayout | null {
  return inheritedSource(raw, formerIds, id)?.entry ?? null;
}

/**
 * Like `inheritedPlacement`, and names the former id the place came from:
 * several widgets split out of one card all inherit its place, and must then
 * share it as one stack rather than overlap.
 */
export function inheritedSource(raw: unknown, formerIds: readonly string[], id: string): { entry: WidgetLayout; from: string } | null {
  if (!Array.isArray(raw) || formerIds.length === 0) return null;
  for (const former of formerIds) {
    const e = raw.map(readEntry).find((entry) => entry?.id === former);
    if (e && !e.removed) return { entry: { ...e, id }, from: former };
  }
  return null;
}

/** Renumbers the ranks 0..n in each rail, in the current order. */
function renumberRanks(layout: WidgetLayout[]): WidgetLayout[] {
  const counters = new Map<ZoneId, number>();
  return layout.map((w) => {
    const rang = counters.get(w.rail) ?? 0;
    counters.set(w.rail, rang + 1);
    return { ...w, rang };
  });
}

/** A departure must not leave a one-tab stack or several selected siblings.
 * Only normalize the affected stack: unrelated singleton records may belong
 * to a plugin that has not registered yet and must retain their group. */
function normalizeStack(layout: WidgetLayout[], source: WidgetLayout): WidgetLayout[] {
  if (!source.group) return layout;
  const members = layout.filter((w) => !w.removed && w.rail === source.rail && w.group === source.group);
  const selected = members.find((w) => w.activeTab) ?? members[0];
  return layout.map((w) => members.includes(w)
    ? { ...w, group: members.length > 1 ? w.group : undefined, activeTab: members.length > 1 ? w.id === selected?.id : undefined }
    : w);
}

/** Group identity is independent of a tab's identity. A detached founding tab
 * can become the target of a new stack without collecting its former siblings. */
function newStackGroup(layout: WidgetLayout[], targetId: string): string {
  const used = new Set(layout.flatMap((w) => w.group ? [w.group] : []));
  const prefix = `stack:${encodeURIComponent(targetId)}:`;
  let suffix = 1;
  while (used.has(`${prefix}${suffix}`)) suffix += 1;
  return `${prefix}${suffix}`;
}

/**
 * Reconciles the storage with the current registry. A soft migration both
 * ways: a widget removed from the code must not break the arrangement of a user
 * who had put it somewhere, and a widget added to the code must appear without
 * the user having to purge their storage.
 */
export function mergeLayout(
  raw: unknown,
  constraints: readonly WidgetConstraints[],
): WidgetLayout[] {
  const byId = new Map(constraints.map((c) => [c.id, c]));
  const seen = new Set<string>();

  const fromStorage: WidgetLayout[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const e = readEntry(item);
      if (!e) continue;
      const c = byId.get(e.id);
      if (!c) continue; // widget gone from the registry → ignored
      if (seen.has(e.id)) continue; // duplicate left by a corrupted storage
      seen.add(e.id);
      fromStorage.push({ ...e, ...(c.heightMode && !e.heightMode ? { heightMode: c.heightMode } : {}), hauteur: Math.max(c.minHeight, e.hauteur) });
    }
  }

  const missing = constraints
    .filter((c) => !seen.has(c.id))
    .map<WidgetLayout>((c) => ({
      id: c.id,
      rail: c.defaultZone,
      rang: c.defaultRank,
      hauteur: c.defaultHeight,
      ...(c.heightMode ? { heightMode: c.heightMode } : {}),
    }));

  // Missing ones are inserted at their default rank; the ranks are then
  // renumbered to stay dense even after a widget is removed.
  const { placed, removed } = partition([...fromStorage, ...missing]);
  // Legacy stacks may contain different plugin defaults. One frame must keep
  // the same sizing when switching tabs, including after a plugin reload.
  for (const members of widgetStacks(placed)) {
    if (members.length < 2) continue;
    const head = members.find((w) => w.activeTab) ?? members[0]!;
    const mode = head.heightMode ?? 'fixed';
    for (const member of members) {
      member.heightMode = mode;
      member.fillPercent = head.fillPercent;
    }
  }
  placed.sort((a, b) => a.rang - b.rang);
  return [...renumberRanks(placed), ...removed];
}

/**
 * Stored placements that no catalogue entry claims.
 *
 * `mergeLayout` drops them, and that had no consequence while the
 * catalogue was a table compiled into the app: an unknown id meant a widget
 * removed from the code. The catalogue is now live (a plugin registers after
 * the page loads, and a disabled plugin does not appear at all): rewriting the
 * layout without these entries would erase for good the place of a plugin that
 * has not finished loading yet, or that was just turned off.
 *
 * The host thus puts them back at the end of what it persists. They are
 * neither placed, nor renumbered, nor shown: they wait for their plugin.
 */
export function orphanPlacements(
  raw: unknown,
  constraints: readonly WidgetConstraints[],
): WidgetLayout[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(constraints.map((c) => c.id));
  const seen = new Set<string>();
  const out: WidgetLayout[] = [];
  for (const item of raw) {
    const e = readEntry(item);
    if (!e || known.has(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * Widgets this installation is allowed to show at all — the config and
 * capabilities filter, applied BEFORE any question of placement.
 *
 * It comes first on purpose, and everything downstream (zones AND palette) is
 * derived from its result: a widget masked by `ui.hidden` or carried by a
 * module that is off must not be offered as merely tidied away, since putting
 * it back is not the user's to decide. The predicate is injected rather than
 * read here, so this module stays free of the capabilities client — the host
 * passes `isZoneVisible` (`lib/capabilities.ts`), which already answers for
 * both `ui.hidden` and the module state.
 */
export function widgetsAllowedByConfig(
  layout: readonly WidgetLayout[],
  isVisible: (id: string) => boolean,
): WidgetLayout[] {
  return layout.filter((w) => isVisible(w.id));
}

/** A template becomes its configured instance without changing its placement.
 * Keep the template in the palette so another instance can be created. */
export function replaceWidget(layout: WidgetLayout[], id: string, replacement: string): WidgetLayout[] {
  const source = layout.find((w) => w.id === id && !w.removed);
  if (!source || replacement === id) return layout;
  return [
    ...layout.filter((w) => w.id !== replacement).map((w) => w.id === id ? { ...w, id: replacement } : w),
    { ...source, removed: true, group: undefined, activeTab: undefined },
  ];
}

/** Widgets of a zone, sorted by rank. A removed widget is in no zone. */
export function widgetsOfZone(layout: readonly WidgetLayout[], zone: ZoneId): WidgetLayout[] {
  return layout.filter((w) => !w.removed && w.rail === zone).sort((a, b) => a.rang - b.rang);
}

/**
 * Widgets the user took out of the interface, in registry order — the palette
 * they can be dragged back from.
 */
export function removedWidgets(layout: readonly WidgetLayout[]): WidgetLayout[] {
  return layout.filter((w) => w.removed === true);
}

/**
 * Takes a widget out of the interface without forgetting it. Its zone and rank
 * are left as they were: they cost nothing, and they are a sensible starting
 * point should a later version offer a "put it back where it was".
 */
export function removeWidget(layout: WidgetLayout[], id: string): WidgetLayout[] {
  const { placed, removed } = partition(layout);
  const source = placed.find((w) => w.id === id);
  if (!source) return layout;
  return normalizeStack([
    ...renumberRanks(placed.filter((w) => w.id !== id)),
    ...removed,
    { ...source, removed: true, group: undefined, activeTab: undefined },
  ], source);
}

/**
 * Undoes a removal: `id` back where it stood in `before` — zone, rank, stack
 * and selected tab — on the layout as it is NOW. Not a write of `before`
 * itself: replayed over another window's write (TODO #647), that would erase
 * whatever the other window changed since. The stack is rebuilt with the
 * siblings still loose in the zone (a stack of two dissolves when one
 * leaves); a sibling stacked elsewhere since keeps its new place. A widget
 * already back by other means is left alone.
 */
export function restoreWidget(layout: WidgetLayout[], before: readonly WidgetLayout[], id: string): WidgetLayout[] {
  const source = before.find((w) => w.id === id && !w.removed);
  const current = layout.find((w) => w.id === id);
  if (!source || !current?.removed) return layout;
  const { placed, removed } = partition(layout);
  const groups = groupByZone(placed);
  const column = groups.get(source.rail) ?? [];
  groups.set(source.rail, column);
  const siblings = new Set(source.group
    ? before.filter((w) => w.id !== id && !w.removed && w.rail === source.rail && w.group === source.group).map((w) => w.id)
    : []);
  const rejoined = column.filter((w) => siblings.has(w.id) && (w.group === undefined || w.group === source.group));
  const stack = rejoined.length > 0 ? source.group : undefined;
  const wasActive = (w: WidgetLayout) => before.find((x) => x.id === w.id)?.activeTab;
  const zone = column.map((w) => rejoined.includes(w) ? { ...w, group: stack, activeTab: wasActive(w) } : w);
  const restored: WidgetLayout = { ...current, rail: source.rail, removed: undefined, group: stack, activeTab: stack ? source.activeTab : undefined };
  zone.splice(Math.max(0, Math.min(source.rang, zone.length)), 0, restored);
  groups.set(source.rail, zone);
  return normalizeStack([
    ...renumberRanks([...groups.values()].flat()),
    ...removed.filter((w) => w.id !== id),
  ], restored);
}

/**
 * Moves `id` right before `beforeId` (or at the end of the zone if `beforeId` is
 * null). Used both for reordering within a zone and for moving from one zone
 * to another: it is the same operation from the model's side.
 */
export function moveWidget(
  layout: WidgetLayout[],
  id: string,
  targetZone: ZoneId,
  beforeId: string | null,
): WidgetLayout[] {
  const source = layout.find((w) => w.id === id);
  if (!source) return layout;

  const { placed, removed } = partition(layout);
  const groups = groupByZone(placed.filter((w) => w.id !== id));
  let column = groups.get(targetZone);
  if (!column) {
    // Zone still empty: it does not exist in the layout until a widget has been
    // put there, but that is precisely the case being handled.
    column = [];
    groups.set(targetZone, column);
  }

  const target = column.find((w) => w.id === beforeId);
  const idx = beforeId === null ? column.length : column.findIndex((w) => target?.group ? w.group === target.group : w.id === beforeId);
  // Dropping a widget somewhere IS putting it back: a removed widget dragged
  // out of the palette has no other way of re-entering the interface.
  column.splice(idx < 0 ? column.length : idx, 0, { ...source, rail: targetZone, removed: undefined, group: undefined, activeTab: undefined });

  return normalizeStack([
    ...renumberRanks([...groups.values()].flat()),
    ...removed.filter((w) => w.id !== id),
  ], source);
}

/**
 * Pours every card of a zone at the end of another, stacks included.
 *
 * Not a series of `moveWidget`: that one detaches the card from its stack,
 * and closing a chat column tab must undo neither the stacks nor the height
 * shares the user composed there. A stack whose name is already used in the
 * target zone is renamed — a stack's identity is (zone, group), and two stacks
 * merged by accident would become one.
 *
 * Removed cards keep their zone: the palette puts them back where they are
 * dropped, never where they were.
 */
export function pourZone(layout: WidgetLayout[], from: ZoneId, to: ZoneId): WidgetLayout[] {
  if (from === to) return layout;
  const { placed, removed } = partition(layout);
  const groups = groupByZone(placed);
  const moving = groups.get(from);
  if (!moving?.length) return layout;
  const column = groups.get(to) ?? [];
  const taken = new Set(column.flatMap((w) => (w.group ? [w.group] : [])));
  const used = new Set(layout.flatMap((w) => (w.group ? [w.group] : [])));
  const renamed = new Map<string, string>();
  const moved = moving.map((w) => {
    if (!w.group || !taken.has(w.group)) return { ...w, rail: to };
    let group = renamed.get(w.group);
    if (!group) {
      let n = 1;
      while (used.has(`${w.group}:${n}`)) n += 1;
      group = `${w.group}:${n}`;
      used.add(group);
      renamed.set(w.group, group);
    }
    return { ...w, rail: to, group };
  });
  groups.delete(from);
  groups.set(to, [...column, ...moved]);
  return [...renumberRanks([...groups.values()].flat()), ...removed];
}

/** Rewrites a zone's order from an already ordered list of ids. */
export function reorderZone(
  layout: WidgetLayout[],
  zone: ZoneId,
  orderedIds: string[],
): WidgetLayout[] {
  const { placed, removed } = partition(layout);
  const byId = new Map(placed.map((w) => [w.id, w]));
  const ordered = orderedIds
    .map((id) => byId.get(id))
    .filter((w): w is WidgetLayout => w !== undefined && w.rail === zone);
  const others = groupByZone(placed.filter((w) => w.rail !== zone));
  return [...renumberRanks([...ordered, ...[...others.values()].flat()]), ...removed];
}

/** Applies a new height, bounded by the widget's floor. */
export function resizeWidget(
  layout: WidgetLayout[],
  id: string,
  height: number,
  minHeight: number,
): WidgetLayout[] {
  const source = layout.find((w) => w.id === id);
  return layout.map((w) =>
    w.id === id || (source?.group && w.group === source.group && w.rail === source.rail)
      ? { ...w, hauteur: Math.max(minHeight, Math.round(height)) } : w,
  );
}

/** `null` = nothing usable, the entry keeps the default (100 %). One decimal
 *  is kept: a share dragged by its edge lands between two whole percents, and
 *  rounding it would make the edge jump under the pointer. */
function readFillPercent(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw * 10) / 10;
  return rounded >= 5 && rounded <= 100 ? rounded : null;
}

/**
 * Shares a column's stacks snap to while an edge between two of them is
 * dragged, as a fraction of the column. The complements (67 %, 75 %) come
 * with them: the neighbour of a card at a third is at two thirds of the pair.
 */
export const HEIGHT_SNAPS: readonly number[] = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1];
/** How close, as a fraction of the column, an edge must come to a snap to stick. */
export const HEIGHT_SNAP_TOLERANCE = 0.025;

/**
 * Moves the edge between stack `index` and stack `index + 1` by `delta` px.
 *
 * Only the two stacks around the edge change: the pair keeps its total, so
 * the column stays exactly full. Each keeps its floor (`mins`). With `snap`,
 * the edge sticks when either card comes within `HEIGHT_SNAP_TOLERANCE` of a
 * known share of the whole column (`HEIGHT_SNAPS`) — the nearest one wins.
 */
export function moveEdge(
  heights: readonly number[], mins: readonly number[], index: number, delta: number, snap = true,
): number[] {
  const a = index;
  const b = index + 1;
  if (a < 0 || b >= heights.length) return [...heights];
  const total = heights[a]! + heights[b]!;
  const minA = Math.min(mins[a] ?? 0, total);
  const maxA = Math.max(minA, total - (mins[b] ?? 0));
  const clamp = (v: number) => Math.min(maxA, Math.max(minA, v));
  let heightA = clamp(heights[a]! + delta);
  if (snap) {
    const column = heights.reduce((sum, h) => sum + h, 0);
    let best: { value: number; gap: number } | null = null;
    for (const part of HEIGHT_SNAPS) {
      const target = part * column;
      for (const candidate of [target, total - target]) {
        if (candidate < minA || candidate > maxA) continue;
        const gap = Math.abs(candidate - heightA);
        if (gap <= HEIGHT_SNAP_TOLERANCE * column && (!best || gap < best.gap)) best = { value: candidate, gap };
      }
    }
    if (best) heightA = best.value;
  }
  const next = [...heights];
  next[a] = heightA;
  next[b] = total - heightA;
  return next;
}

/** Heights in px as shares of their sum, in percent with one decimal. */
export function sharesFromHeights(heights: readonly number[]): number[] {
  const total = heights.reduce((sum, h) => sum + h, 0);
  if (total <= 0) return heights.map(() => Math.round(1000 / Math.max(1, heights.length)) / 10);
  return heights.map((h) => Math.max(5, Math.round((h / total) * 1000) / 10));
}

/**
 * The stored weights of a column's stacks, rescaled to sum to 100 %.
 *
 * A card's share is its flex-grow factor (`part / 100`); flexbox hands out
 * only that fraction of the free space when the factors sum to less than 1.
 * The stored shares stop summing to 100 as soon as a column loses or gains a
 * card (a card dragged away leaves its neighbour at 50 %), so they are read
 * as weights against each other, never as fractions of the column.
 */
export function normalizedShares(weights: readonly number[]): number[] {
  const valid = weights.map((p) => (Number.isFinite(p) && p > 0 ? p : 0));
  const total = valid.reduce((sum, p) => sum + p, 0);
  if (total <= 0) return weights.map(() => 100 / Math.max(1, weights.length));
  return valid.map((p) => (p / total) * 100);
}

/**
 * Writes a column's height shares, by stack head. Every stack named becomes a
 * `fill` card: a column is always shared out at 100 %, nothing has a height of
 * its own any more that could push the last card past the bottom.
 */
export function distributeHeights(
  layout: WidgetLayout[], shares: ReadonlyArray<{ id: string; percent: number }>,
): WidgetLayout[] {
  let next = layout;
  for (const { id, percent } of shares) {
    const part = readFillPercent(percent);
    if (part === null) continue;
    const source = next.find((w) => w.id === id && !w.removed);
    if (!source) continue;
    next = next.map((w) => !w.removed && (w.id === id || (source.group && w.group === source.group && w.rail === source.rail))
      ? { ...w, heightMode: 'fill' as const, fillPercent: part } : w);
  }
  return next;
}

/** Sizing belongs to the whole frame rather than the selected tab. */
export function setWidgetHeightMode(
  layout: WidgetLayout[], id: string, heightMode: WidgetHeightMode, fillPercent?: number,
): WidgetLayout[] {
  const source = layout.find((w) => w.id === id && !w.removed);
  if (!source) return layout;
  // 100 % is not written: it is the default, and an explicit value everywhere
  // would inflate every layout already persisted without changing the render.
  const part = heightMode === 'fill' ? readFillPercent(fillPercent ?? source.fillPercent ?? 100) : null;
  const patch = part !== null && part !== 100 ? { fillPercent: part } : { fillPercent: undefined };
  return layout.map((w) => !w.removed && (w.id === id || (source.group && w.group === source.group && w.rail === source.rail))
    ? { ...w, heightMode, ...patch } : w);
}

/** Merge one dragged tab into a target stack; siblings remain in place. */
export function dockWidget(layout: WidgetLayout[], id: string, targetId: string): WidgetLayout[] {
  const target = layout.find((w) => w.id === targetId && !w.removed);
  if (!target || id === targetId || !layout.some((w) => w.id === id)) return layout;
  const group = target.group ?? newStackGroup(layout, target.id);
  const moved = moveWidget(layout, id, target.rail, target.id);
  return moved.map((w) => w.id === id || w.id === target.id || (w.group === group && w.rail === target.rail)
    ? { ...w, group, activeTab: w.id === id, hauteur: target.hauteur, heightMode: target.heightMode ?? 'fixed', fillPercent: target.fillPercent } : w);
}

/**
 * Moves a tab WITHIN its own stack: same group, same zone, new rank.
 *
 * The direction follows the gesture: a tab dragged to the right lands AFTER
 * its target, dragged to the left it lands BEFORE. Always inserting before
 * would mean a tab dropped on its right neighbour does not move a pixel.
 *
 * Refuses anything that is not a reorder (different groups, different zones,
 * outside a stack): docking has its own function, `dockWidget`, and the two
 * gestures must not overlap.
 */
export type TabSide = 'avant' | 'apres' | 'geste';

/** Where tab `id` lands relative to `targetId`, given the current ranks.
 *  A single source of truth: the insertion cursor draws EXACTLY what this
 *  function decides, otherwise the line lies about the result. */
export function insertionSide(
  layout: readonly WidgetLayout[], id: string, targetId: string, side: TabSide = 'geste',
): 'avant' | 'apres' {
  if (side !== 'geste') return side;
  const placed = layout.filter((w) => !w.removed).sort((a, b) => a.rang - b.rang);
  const from = placed.findIndex((w) => w.id === id);
  const to = placed.findIndex((w) => w.id === targetId);
  return from >= 0 && from < to ? 'apres' : 'avant';
}

export function moveStackTab(
  layout: WidgetLayout[], id: string, targetId: string, side: TabSide = 'geste',
): WidgetLayout[] {
  const source = layout.find((w) => w.id === id && !w.removed);
  const target = layout.find((w) => w.id === targetId && !w.removed);
  if (!source || !target || id === targetId) return layout;
  if (!source.group || source.group !== target.group || source.rail !== target.rail) return layout;

  const { placed, removed } = partition(layout);
  const groups = groupByZone(placed);
  const rail = groups.get(source.rail);
  if (!rail) return layout;
  const after = insertionSide(rail, id, targetId, side) === 'apres';
  const withoutSource = rail.filter((w) => w.id !== id);
  const targetIndex = withoutSource.findIndex((w) => w.id === targetId);
  withoutSource.splice(after ? targetIndex + 1 : targetIndex, 0, source);
  groups.set(source.rail, withoutSource);
  return [...renumberRanks([...groups.values()].flat()), ...removed];
}

/**
 * Puts `id` as the LAST tab of `targetId`'s stack, wherever it comes from: the
 * same stack (reorder), another stack, another zone or the palette (docking).
 * Tabs cannot carry this gesture: dropped on a tab, a widget lands before or
 * after IT, never after the last one when it comes from elsewhere.
 */
export function placeAtStackEnd(layout: WidgetLayout[], id: string, targetId: string): WidgetLayout[] {
  const target = layout.find((w) => w.id === targetId && !w.removed);
  if (!target || (id === targetId && !target.group)) return layout;
  const source = layout.find((w) => w.id === id && !w.removed);
  const sameStack = !!source?.group && source.group === target.group && source.rail === target.rail;
  const docked = sameStack ? layout : dockWidget(layout, id, targetId);
  const group = docked.find((w) => w.id === id)?.group;
  if (!group) return layout;
  const stack = docked.filter((w) => !w.removed && w.group === group && w.rail === target.rail).sort((a, b) => a.rang - b.rang);
  const last = stack[stack.length - 1];
  return last && last.id !== id ? moveStackTab(docked, id, last.id, 'apres') : docked;
}

export function selectWidgetTab(layout: WidgetLayout[], id: string): WidgetLayout[] {
  const target = layout.find((w) => w.id === id);
  if (!target?.group) return layout;
  return layout.map((w) => w.group === target.group && w.rail === target.rail
    ? { ...w, activeTab: w.id === id } : w);
}

/** Each stack occupies one vertical position even with hidden plugins/tabs. */
export function widgetStacks(entries: WidgetLayout[]): WidgetLayout[][] {
  const result: WidgetLayout[][] = [];
  const groups = new Map<string, WidgetLayout[]>();
  for (const entry of entries) {
    const key = entry.group ? JSON.stringify([entry.rail, entry.group]) : null;
    const group = key ? groups.get(key) : null;
    if (group) group.push(entry);
    else {
      const stack = [entry];
      result.push(stack);
      if (key) groups.set(key, stack);
    }
  }
  return result;
}
