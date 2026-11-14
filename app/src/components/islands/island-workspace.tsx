'use client';

/**
 * The island workspace (`docs/ISLAND-WORKSPACE.md`): the content area of a
 * view, split into islands, each a stack of tabs.
 *
 * Contents are rendered FLAT, keyed by tab, and positioned over rectangles
 * computed from the tree (§8): if the DOM followed the tree, splitting an
 * island would re-parent — and remount — what it holds (a terminal would lose
 * its screen, the route's page its state). The route's page is keyed by a
 * constant: its tab id is minted when the tree is, and a tree read from
 * storage must not remount the page the default tree was showing.
 *
 * One island holding only the route paints nothing of its own: the page sits
 * in the frame it always had, with the classes the host passes. That is the
 * guarantee that the screen does not change until something is opened.
 */

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AppWindow, ChevronDown, ChevronLeft, ChevronRight, Droplets, ExternalLink, GripVertical, Minus, PanelRight, Pin, PinOff, Plus, X } from 'lucide-react';
import { Picto } from '@/components/picto';
import { ChatTabIcon } from '@/plugins-client/missions/chat-tab-icon';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { useSlotEntry } from '@/lib/plugin-host/render';
import {
  HOST_ROUTE,
  activateTab,
  addTab,
  allLeaves,
  closeTab,
  collectLeaves,
  floatLeaf,
  resizeFloatRect,
  type FloatEdges,
  floatOf,
  floatRectAt,
  openFloat,
  floatTab,
  moveLeafToRoot,
  moveTab,
  setFloatMinimized,
  setFloatPinned,
  setLeafGlassScope,
  shownIslandTree,
  equalizeAt,
  expandIslandFromGrid,
  findLeaf,
  findNode,
  fitsMinimums,
  focusLeaf,
  insertAt,
  isDefaultIslandTree,
  layoutRects,
  leafOfTab,
  minFractions,
  readIslandTree,
  resizeAt,
  setSplitRatios,
  withIslandIds,
  type DropRegion,
  type IslandContent,
  type IslandLeaf,
  type IslandParams,
  type IslandResult,
  type IslandSplit,
  type IslandTab,
  type IslandTree,
  type MinSize,
  type GutterRect,
  type Rect,
  type TabId,
  sameContentAs,
  setRouteParams,
  setTabParams,
  tabsLeaving,
} from '@/lib/island-tree';
import { usePathname, useSearchParams } from 'next/navigation';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { workspaceRowHandover } from '@/lib/workspace-route';
import { usePreviousScope } from '@/hooks/use-previous-scope';
import { rowHandover } from '@/lib/layout-handover';
import { mergeAmbient, readAmbient, splitAmbient, type AmbientIslands } from '@/lib/island-ambient';
import { sharedPinnedIslandsScope } from '@/lib/workspace-scope';
import { navLabelKeyOf } from '@/plugins-client/nav';
import { routeChatOfUrl } from '@/lib/chat-island-params';
import { announceIslandWorkspace, publishIslandTabs, type IslandWorkspaceHandle } from '@/lib/island-bus';
import { mayCloseTabs } from '@/lib/island-close';
import { IslandDropLayer, IslandDropPreview } from './island-drop-layer';
import { beginIslandDrag, setIslandWindowMoving, useIslandDrag, type IslandDrag } from '@/lib/island-drag';
import { exclusiveOwner, type ExclusiveCandidate } from '@/lib/island-exclusive';
import { dropLabelKey, planIslandDrop, type IslandDragSource, type IslandDropTarget, type ResolvedContent } from '@/lib/island-drop';
import {
  arrowDirection,
  cycleIsland,
  initialMoveTarget,
  islandInDirection,
  isIslandFocusKey,
  moveKeyOf,
  nextRegion,
  tabForKey,
  type MoveTarget,
} from '@/lib/island-keyboard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { GlassClear, IslandGlassScopeProvider, useGlassScope } from '@/components/glass-scope';
import { GLASS_TUNING_ENABLED, readGlassScope, type GlassScope } from '@/lib/glass-scope';
import {
  ISLAND_MIN_HEIGHT,
  ISLAND_MIN_WIDTH,
  IslandContentContext,
  pluginOfType,
  useIslandContentTypes,
  type IslandContentType,
  type IslandContentValue,
} from './island-content';
import { usePublishIslandSnapshot } from './use-island-snapshot';
import { useIslandWindowMove } from './use-island-window-move';
import { ISLANDS_SUFFIX } from '@/lib/island-presets';
import { arrangementIdOf } from '@/lib/island-arrangements';
import { useArrangementName } from '@/lib/island-arrangements-store';

/** Height of an island's header (tabs or title). */
const HEADER_PX = 32;
/** Height of the tab picker of the stacked (narrow) rendering. */
const PICKER_PX = 40;
/** Fallback of `--timon-island-gap` when it cannot be read. */
const DEFAULT_GAP = 8;
/** Below it, nothing splits (§10). */
const NARROW_VIEWPORT = 768;
/** Where a pinned popup opens (fractions of the workspace): the bottom-right corner. */
const PINNED_FLOAT_RECT = { x: 0.56, y: 0.16, width: 0.42, height: 0.82 };

/** Variables the page bodies offset themselves with, zeroed inside a painted workspace (§1). */
const CONFINED_VARS = {
  '--timon-nav-w': '0px',
  '--timon-topbar-h': '0px',
} as CSSProperties;

function isNarrowViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < NARROW_VIEWPORT
    || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useIsomorphicLayoutEffect(() => {
    const read = () => setNarrow(isNarrowViewport());
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return narrow;
}

type Box = { x: number; y: number; width: number; height: number; gap: number; measured: boolean };

/**
 * The container's content box. Its padding is the host's way to keep the
 * islands off the nav rail and the chrome's edges (the chat, which paints
 * edge to edge): absolute children are placed from the padding edge, so the
 * rectangles start at the padding.
 */
function useBoxSize(ref: React.RefObject<HTMLDivElement | null>, painted: boolean): Box {
  const [size, setSize] = useState<Box>({ x: 0, y: 0, width: 0, height: 0, gap: DEFAULT_GAP, measured: false });
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const style = getComputedStyle(el);
      const px = (name: string) => {
        const value = parseFloat(style.getPropertyValue(name));
        return Number.isFinite(value) && value >= 0 ? value : 0;
      };
      const raw = parseFloat(style.getPropertyValue('--timon-island-gap'));
      const next: Box = {
        x: px('padding-left'),
        y: px('padding-top'),
        width: Math.max(0, el.clientWidth - px('padding-left') - px('padding-right')),
        height: Math.max(0, el.clientHeight - px('padding-top') - px('padding-bottom')),
        gap: Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GAP,
        // `display: contents` (the page alone) has no box: a size of zero is
        // "not measured", or the first painted frame lays the page out in
        // nothing and flashes the backdrop before the observer catches up.
        measured: el.clientWidth > 0 && el.clientHeight > 0,
      };
      setSize((old) => (old.measured === next.measured && old.x === next.x && old.y === next.y && old.width === next.width
        && old.height === next.height && old.gap === next.gap ? old : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
    // `painted` flips the container between `contents` and a real box: read
    // again in the same commit, before paint, rather than a frame later.
  }, [ref, painted]);
  return size;
}

/**
 * Whether the workspace around the route's page paints islands. The page
 * reads it to drop what stood in for an island while it was alone (the chat's
 * `IslandUnderlay`).
 */
const IslandPaintedContext = createContext(false);
export const useIslandWorkspacePainted = (): boolean => useContext(IslandPaintedContext);

/**
 * Whether the route's page is the primary instance of the `exclusive` group
 * its host enrolled it in (`routeExclusive`, Q10). `true` outside a workspace,
 * and while nothing is split: alone, the page is the only instance.
 */
const IslandRoutePrimaryContext = createContext(true);
export const useIslandRoutePrimary = (): boolean => useContext(IslandRoutePrimaryContext);

/**
 * Whether the route's page sits in the focused island. `true` outside a
 * workspace and while nothing is split. What only one content may answer —
 * a key held for push-to-talk — follows the focus, not the group.
 */
const IslandRouteFocusedContext = createContext(true);
export const useIslandRouteFocused = (): boolean => useContext(IslandRouteFocusedContext);

/**
 * The view's tree and a writer for the route tab's params, for the page that
 * keeps something of its own in the view (the chat's page panel, TIM-0140).
 * `setParams` is `null` while the view's own row would not be stored (the page
 * alone, or with popups pinned elsewhere only): nothing to keep it in.
 */
export type IslandRouteTab = { tree: IslandTree; setParams: ((next: IslandParams) => void) | null };
const IslandRouteTabContext = createContext<IslandRouteTab | null>(null);
export const useIslandRouteTab = (): IslandRouteTab | null => useContext(IslandRouteTabContext);

/** For a page body whose decisions are taken above the route node it hands the workspace. */
export function IslandRoutePrimary({ children }: { children: (primary: boolean) => ReactNode }): ReactElement {
  return <>{children(useIslandRoutePrimary())}</>;
}

/**
 * The size of the route's island while the workspace paints, `null` while the
 * page is alone. A page that switches its layout on the viewport's width
 * (`/agents`' rails) reads it: an island narrower than its breakpoint is a
 * narrow screen for it, whatever the window.
 */
const IslandRouteSizeContext = createContext<{ width: number; height: number } | null>(null);
export const useIslandRouteSize = (): { width: number; height: number } | null => useContext(IslandRouteSizeContext);

/** Whether two contents of one type are the same live tab (§5): by the `singletonBy` params, else by all of them. */
export function sameIslandIdentity(singletonBy: string | readonly string[] | undefined, a: IslandParams, b: IslandParams): boolean {
  return sameContentAs(b, singletonBy)({ type: '', params: a });
}

const HIDDEN_TAB_ATTRS = { inert: true, 'aria-hidden': true } as const;

const rectStyle = (rect: Rect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });

/** A drop as an op on the tree it is handed: planned again when replayed on a rewritten one. */
function droppedOn(
  tree: IslandTree,
  source: IslandDragSource,
  target: IslandDropTarget,
  resolve: (content: IslandContent) => ResolvedContent | null,
): IslandResult {
  const plan = planIslandDrop(tree, source, target, resolve);
  // Quietly: a drop that no longer applies was already announced as done.
  return plan.refused ? { tree, refused: 'unknownTarget' } : { tree: plan.tree, refused: null };
}

export type IslandWorkspaceViewProps = {
  tree: IslandTree;
  /**
   * `persist: false` during a gesture (a gutter being dragged), `true` once it
   * ends. `replay` is the gesture itself: applied to a tree another window
   * rewrote, it gives what this gesture makes of it, or `null` when it no
   * longer applies (TODO #647).
   */
  onTree: (next: IslandTree, persist: boolean, replay: (tree: IslandTree) => IslandTree | null) => void;
  /** The page the URL names: the `host:route` tab. */
  route: ReactNode;
  /** Title of the route's tab, once there are headers to show it. */
  routeTitle?: string;
  /** The agent whose chat the page is: its avatar and name head the route's tab. */
  routeAgent?: string;
  /** Classes of the container while nothing is split: the frame the page always had. */
  className?: string;
  /** Classes of the container once islands are painted (it must fill the frame's place). */
  splitClassName?: string;
  /** Offer this workspace to the rest of the app (`openInIsland`). Only once its arrangement is read. */
  announce?: boolean;
  /**
   * The `exclusive` group the route's page belongs to: the chat page holds the
   * chat's widget zones like a chat island does (Q10).
   */
  routeExclusive?: string;
  /** The view this tree is stored under: a recall aimed at it releases the tabs it replaces. */
  viewKey?: string | null;
};

export function IslandWorkspaceView({
  tree,
  onTree,
  route,
  routeTitle,
  routeAgent,
  className,
  splitClassName = 'relative min-h-0 min-w-0 flex-1',
  announce = false,
  routeExclusive,
  viewKey = null,
}: IslandWorkspaceViewProps): ReactElement {
  const types = useIslandContentTypes();
  const pathname = usePathname();
  // What the view on screen asks of its workspace (`PageOptions`), from the page plugin registered on its route.
  const pageOptions = useSlotEntry('page', pathname ?? '')?.page;
  const narrow = useNarrow();
  const container = useRef<HTMLDivElement>(null);
  const box = useBoxSize(container, !isDefaultIslandTree(shownIslandTree(tree)));
  const [titles, setTitles] = useState<Record<TabId, string>>({});
  const [announcement, setAnnouncement] = useState('');
  const treeRef = useRef(tree);
  treeRef.current = tree;

  // Every op is a function of the tree it is handed, never of the tree on
  // screen: it runs again, with the same ids, when its write is refused
  // because another window rewrote the row (TODO #647).
  const apply = useCallback((op: (current: IslandTree) => IslandResult, persist = true, force = false): IslandResult => {
    const current = treeRef.current;
    const ids: string[] = [];
    const result = withIslandIds(ids, () => op(current));
    if (result.refused) {
      if (result.refused !== 'unknownTarget') toast.error(t(`islands.refused.${result.refused}`), { id: 'islands-refused' });
      return result;
    }
    if (result.tree !== current || force) {
      treeRef.current = result.tree;
      onTree(result.tree, persist, (tree) => {
        const again = withIslandIds(ids, () => op(tree));
        return again.refused ? null : again.tree;
      });
    }
    return result;
  }, [onTree]);

  // Stable per tab: a content that puts `setTitle` in an effect's dependencies
  // must not re-run it on every render of the workspace (a gutter drag is
  // dozens of them).
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const typesRef = useRef(types);
  typesRef.current = types;
  const actions = useRef(new Map<TabId, TabActions>());
  const actionsOf = (tabId: TabId): TabActions => {
    let found = actions.current.get(tabId);
    if (!found) {
      found = {
        // A change that cannot land says so: a silent no-op left a popup's
        // View button dead for weeks (TIM-0127).
        setParams: (next) => {
          const tab = allLeaves(treeRef.current).flatMap((leaf) => leaf.tabs).find((x) => x.id === tabId);
          const type = tab ? typesRef.current.get(tab.content.type) : undefined;
          const parsed = type ? type.options.parseParams(next) : null;
          const refused = parsed ? applyRef.current((tr) => setTabParams(tr, tabId, parsed)).refused : null;
          if (parsed && !refused) return;
          const why = !tab ? 'unknown tab' : !type ? 'unknown type' : !parsed ? 'params refused by parseParams' : refused;
          console.warn('[islands] setParams not applied', { tabId, type: tab?.content.type, why, next });
          toast.error(t('islands.paramsRefused'), { id: 'islands-params-refused' });
        },
        setTitle: (title) => setTitles((old) => {
          if ((old[tabId] ?? null) === title) return old;
          const next = { ...old };
          if (title === null) delete next[tabId];
          else next[tabId] = title;
          return next;
        }),
        close: () => { closeRef.current(tabId); },
      };
      actions.current.set(tabId, found);
    }
    return found;
  };

  const titleOf = useCallback((tab: IslandTab): string => {
    if (tab.content.type === HOST_ROUTE) return routeTitle || t('islands.page');
    return titles[tab.id] ?? types.get(tab.content.type)?.options.title ?? pluginOfType(tab.content.type);
  }, [routeTitle, titles, types]);

  /** Closes a tab and says so (§11): otherwise it vanishes from under a screen reader. */
  const close = useCallback((tabId: TabId): IslandResult => {
    const tab = allLeaves(treeRef.current).flatMap((leaf) => leaf.tabs).find((x) => x.id === tabId);
    const result = apply((tr) => closeTab(tr, tabId));
    if (tab && !result.refused) {
      setAnnouncement(t('islands.announce.closed', { title: titleOf(tab) }));
      typesRef.current.get(tab.content.type)?.options.onClose?.(tab.content.params, tab.id);
    }
    return result;
  }, [apply, titleOf]);
  const closeRef = useRef(close);
  closeRef.current = close;

  const setRoute = useCallback((next: IslandParams) => { applyRef.current((tr) => setRouteParams(tr, next)); }, []);
  const keepsRoute = !isDefaultIslandTree(splitAmbient(tree).view);
  const routeTab = useMemo<IslandRouteTab>(() => ({ tree, setParams: keepsRoute ? setRoute : null }), [tree, keepsRoute, setRoute]);
  const titleOfRef = useRef(titleOf);
  titleOfRef.current = titleOf;

  /**
   * A close the user asked for: each type may veto it first (`beforeClose`:
   * unsaved changes). All tabs pass or none closes — an island whose close was
   * cancelled keeps every tab. A guard that throws keeps its tab too: it stands
   * for unsaved work, and a broken one must not throw that work away. `before`
   * runs once they all passed (a Detach
   * opens its window only then), `after` once they are closed. Stays
   * synchronous while no type answers with a promise, like the plain close it
   * stands for.
   */
  const asking = useRef(new Set<TabId>());
  const mayClose = useCallback((tabs: readonly IslandTab[]): Promise<boolean> => mayCloseTabs(
    tabs,
    (type) => typesRef.current.get(type)?.options,
    (tab) => titleOfRef.current(tab),
  ), []);
  const requestClose = useCallback(async (tabIds: readonly TabId[], { before, after }: { before?: () => void; after?: () => void } = {}): Promise<boolean> => {
    if (tabIds.some((id) => asking.current.has(id))) return false;
    for (const id of tabIds) asking.current.add(id);
    try {
      const all = allLeaves(treeRef.current).flatMap((leaf) => leaf.tabs);
      const tabs = tabIds.map((id) => all.find((x) => x.id === id)).filter((tab): tab is IslandTab => tab !== undefined);
      if (!await mayClose(tabs)) return false;
    } finally {
      for (const id of tabIds) asking.current.delete(id);
    }
    before?.();
    const closed = tabIds.map((tabId) => closeRef.current(tabId)).filter((result) => !result.refused);
    if (closed.length > 0) after?.();
    return true;
  }, [mayClose]);
  const userClose = useCallback((tabId: TabId, before?: () => void) => { void requestClose([tabId], { before }); }, [requestClose]);

  /** The "+" of an island: the type makes the params of one more tab, which joins that island. */
  const newTabIn = useCallback(async (leafId: string, from: IslandTab): Promise<void> => {
    const type = typesRef.current.get(from.content.type);
    const make = type?.options.newTab;
    if (!type || !make) return;
    const made = await make(from.content.params).catch(() => null);
    const parsed = made ? type.options.parseParams(made) : null;
    if (!parsed) return;
    applyRef.current((tr) => addTab(tr, leafId, { type: from.content.type, params: parsed }, undefined, {
      existing: sameContentAs(parsed, type.options.singletonBy),
    }));
  }, []);

  const minOf = useCallback((leaf: IslandLeaf): MinSize => {
    const tab = leaf.tabs.find((x) => x.id === leaf.active);
    const options = tab ? types.get(tab.content.type)?.options : undefined;
    return { width: options?.minWidth ?? ISLAND_MIN_WIDTH, height: options?.minHeight ?? ISLAND_MIN_HEIGHT };
  }, [types]);

  /**
   * A content from outside, checked against the registry: params cleaned by
   * the type, and what counts as "already open" (singleton, same identity).
   */
  const resolve = useCallback((content: IslandContent): ResolvedContent | null => {
    const type = types.get(content.type);
    if (!type) return null;
    const params = type.options.parseParams(content.params);
    if (!params) return null;
    const existing = sameContentAs(params, type.options.singletonBy);
    return { content: { type: content.type, params }, options: { existing } };
  }, [types]);

  // --------------------------------------------------- announced to the app
  const open = useCallback((content: IslandContent, edge: DropRegion | 'float', pinned = false): boolean => {
    const resolved = resolve(content);
    const type = types.get(content.type);
    if (!resolved || !type) return false;
    const { content: clean, options } = resolved;
    const current = treeRef.current;
    const inTree = (id: string | null) => !!id && !floatOf(current, id);
    // Sides only exist in the tree: a focused popup stands for the route's island.
    const target = inTree(current.focus)
      ? current.focus!
      : (collectLeaves(current.root).find((leaf) => leaf.tabs.some((x) => x.content.type === HOST_ROUTE)) ?? collectLeaves(current.root)[0]!).id;
    // A content that belongs with others (a terminal of the same scope) joins their island.
    const groupKey = type.options.groupBy;
    const group = groupKey && (edge === 'float' || edge === 'center')
      ? allLeaves(current).find((leaf) => leaf.tabs.some((x) => x.content.type === clean.type && x.content.params[groupKey] === clean.params[groupKey]))
      : undefined;
    let result: IslandResult;
    if (group) result = apply((tr) => addTab(tr, group.id, clean, undefined, options));
    else if (edge === 'float' && !narrow) {
      // Pinned: the popup follows the user across pages (the guided tour's chat).
      result = apply((tr) => {
        // A pinned popup talks over pages the user is shown: it sits in the
        // bottom-right corner instead of covering the middle of the page.
        const rect = pinned ? PINNED_FLOAT_RECT : floatRectAt(0.5, 0.5, { width: 0.5, height: 0.55 });
        const opened = openFloat(tr, clean, rect, options);
        const leafId = opened.tree.focus;
        return pinned && !opened.refused && leafId && floatOf(opened.tree, leafId)
          ? setFloatPinned(opened.tree, leafId, true)
          : opened;
      });
    }
    else if (edge === 'center' || edge === 'float' || narrow) result = apply((tr) => addTab(tr, target, clean, undefined, options));
    else result = apply((tr) => insertAt(tr, target, edge, clean, options));
    if (result.refused) return false;
    const targetLeaf = allLeaves(current).find((leaf) => leaf.id === (group?.id ?? target));
    const where = targetLeaf ? titleOf(targetLeaf.tabs.find((x) => x.id === targetLeaf.active) ?? targetLeaf.tabs[0]!) : '';
    setAnnouncement(t(group || edge === 'center' || narrow ? 'islands.announce.tab' : `islands.announce.${edge}`, {
      title: type.options.title,
      target: where,
    }));
    return true;
  }, [resolve, types, narrow, apply, titleOf]);

  const openRef = useRef(open);
  openRef.current = open;
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;
  const handle = useMemo<IslandWorkspaceHandle>(() => ({
    open: (content, edge, pinned) => openRef.current(content, edge, pinned),
    activate: (tabId) => { apply((tr) => activateTab(tr, tabId)); },
    close: (tabId) => { closeRef.current(tabId); },
    openGrid: (grid, cells) => {
      const clean = cells.map((cell) => cell ? resolve(cell)?.content ?? null : null);
      // A missing plugin or invalid param must not silently lose a cell.
      if (cells.some((cell, index) => cell && !clean[index])) return false;
      const current = treeRef.current;
      const route = collectLeaves(current.root).find((leaf) => leaf.tabs.some((tab) => tab.content.type === HOST_ROUTE));
      if (!route) return false;
      const result = apply((tr) => expandIslandFromGrid(tr, route.id, grid, clean));
      if (result.refused) return false;
      setAnnouncement(t('multichat.grid.opened'));
      return true;
    },
    // A recall writes the stored row and the tree is read again: the tabs it
    // drops never went through `close`, and a terminal kept its shell.
    release: async (key, next) => {
      if (!viewKeyRef.current || key !== viewKeyRef.current) return () => {};
      const leaving = tabsLeaving(treeRef.current, next, (type) => typesRef.current.get(type)?.options.singletonBy);
      if (!await mayClose(leaving)) return null;
      return () => {
        for (const tab of leaving) typesRef.current.get(tab.content.type)?.options.onClose?.(tab.content.params, tab.id);
      };
    },
    owns: (key) => !!viewKeyRef.current && key === viewKeyRef.current,
  }), [apply, resolve, mayClose]);

  useEffect(() => {
    if (!announce) return;
    return announceIslandWorkspace(handle);
  }, [announce, handle]);

  const leaves = useMemo(() => allLeaves(tree), [tree]);
  const allTabs = useMemo(() => leaves.flatMap((leaf) => leaf.tabs), [leaves]);
  useEffect(() => {
    if (announce) publishIslandTabs(handle, allTabs, narrow);
  }, [announce, handle, allTabs, narrow]);

  // ------------------------------------------------------------- geometry
  // The scene leaves the folded popups out: the page alone with only folded
  // ones is painted as it always was, their tabs waiting in the corner.
  const shown = useMemo(() => shownIslandTree(tree), [tree]);
  const shownLeaves = useMemo(() => allLeaves(shown), [shown]);
  const folded = useMemo(() => new Set((tree.floats ?? []).filter((f) => f.minimized === true).map((f) => f.leaf.id)), [tree.floats]);
  const painted = !isDefaultIslandTree(shown);
  // Not measured yet (first paint of a stored split): not "too small" either,
  // or every load would flash the stacked picker before the islands.
  const stacked = painted && (narrow || (box.measured && !fitsMinimums(tree, box, box.gap, minOf)));
  const layout = useMemo(() => {
    if (!painted || stacked) return null;
    const placed = layoutRects(tree, { x: box.x, y: box.y, width: box.width, height: box.height }, box.gap);
    if (!shown.floats?.length) return placed;
    // A popup's place is a fraction of the box, above whatever the tree lays out.
    const islands = { ...placed.islands };
    for (const f of shown.floats) {
      islands[f.leaf.id] = {
        x: box.x + f.rect.x * box.width,
        y: box.y + f.rect.y * box.height,
        width: f.rect.width * box.width,
        height: f.rect.height * box.height,
      };
    }
    return { ...placed, islands };
  }, [painted, stacked, tree, shown, box]);
  // Stacking of the popups: in their order, the focused one on top.
  const floatZ = useMemo(() => {
    const floats = tree.floats ?? [];
    const ordered = [...floats.filter((f) => f.leaf.id !== tree.focus), ...floats.filter((f) => f.leaf.id === tree.focus)];
    // Three layers each: chassis, content above it, resize handles above both.
    return new Map(ordered.map((f, i) => [f.leaf.id, 20 + i * 3]));
  }, [tree.floats, tree.focus]);
  const focusLeafOf = shownLeaves.find((leaf) => leaf.id === tree.focus) ?? shownLeaves[0]!;
  const shownInStack = focusLeafOf.active;
  const routeLeafId = leaves.find((leaf) => leaf.tabs.some((tab) => tab.content.type === HOST_ROUTE))?.id;
  const routeRect = routeLeafId ? layout?.islands[routeLeafId] : undefined;
  // Painted only for popups: the page keeps the frame it had alone. A "Page"
  // header over it would push the whole page down by the header's height.
  // Alone, the workspace is the frame the host gave it: an island when the
  // host says so (AppFrame), and then it lays the clear glass itself.
  const frameIsIsland = (className ?? '').split(/\s+/).includes('timon-island');
  const singleGlass = tree.root.kind === 'leaf' ? tree.root.glassScope ?? null : null;
  const routeBare = painted && !stacked && tree.root.kind === 'leaf' && tree.root.id === routeLeafId && tree.root.tabs.length === 1;
  // Docked islands whose only tab asks to be the whole island (`bare`): no header painted.
  const bareLeaves = new Set(
    painted && !stacked
      ? leaves.filter((leaf) => {
          if (leaf.tabs.length !== 1 || floatOf(tree, leaf.id)) return false;
          const content = leaf.tabs[0]!.content;
          if (content.type === HOST_ROUTE) return pageOptions?.bareRoute === true;
          return types.get(content.type)?.options.bare?.(content.params, { route: pathname ?? '' }) === true;
        }).map((leaf) => leaf.id)
      : [],
  );
  const headerOf = (leafId: string): number => ((routeBare && leafId === routeLeafId) || bareLeaves.has(leafId) ? 0 : HEADER_PX);
  // Not measured yet: no size rather than a zero one, which would read as "narrow".
  const routeWidth = !painted || !box.measured ? null : stacked ? box.width : routeRect?.width ?? null;
  const routeHeight = !painted || !box.measured ? null : stacked ? Math.max(0, box.height - PICKER_PX) : routeRect ? Math.max(0, routeRect.height - (routeLeafId ? headerOf(routeLeafId) : HEADER_PX)) : null;
  const routeSize = useMemo(
    () => (routeWidth === null || routeHeight === null ? null : { width: routeWidth, height: routeHeight }),
    [routeWidth, routeHeight],
  );

  const isVisible = (leaf: IslandLeaf, tab: IslandTab): boolean => (!painted
    ? tab.content.type === HOST_ROUTE
    : stacked ? tab.id === shownInStack : leaf.active === tab.id && !folded.has(leaf.id));

  // ------------------------------------------------- exclusive contents (Q10)
  // Only what is mounted AND shown competes: a hidden tab holds nothing.
  const previousOwners = useRef(new Map<string, TabId | null>());
  const owners = useMemo(() => {
    const groups = new Map<string, ExclusiveCandidate[]>();
    for (const leaf of leaves) {
      for (const tab of leaf.tabs) {
        if (!isVisible(leaf, tab)) continue;
        const route = tab.content.type === HOST_ROUTE;
        const group = route ? routeExclusive : types.get(tab.content.type)?.options.exclusive;
        if (!group) continue;
        const list = groups.get(group) ?? [];
        list.push({ tabId: tab.id, leafId: leaf.id, route });
        groups.set(group, list);
      }
    }
    const out = new Map<string, TabId | null>();
    for (const [group, candidates] of groups) {
      out.set(group, exclusiveOwner(candidates, tree.focus, previousOwners.current.get(group) ?? null));
    }
    return out;
    // `isVisible` reads only `painted`, `stacked`, `shownInStack` and `folded`, listed.
  }, [leaves, painted, stacked, shownInStack, folded, routeExclusive, types, tree.focus]);
  useEffect(() => {
    for (const [group, owner] of owners) previousOwners.current.set(group, owner);
  }, [owners]);
  const isPrimary = (tab: IslandTab, group: string | undefined): boolean => (group ? owners.get(group) === tab.id : true);

  const focusIsland = useCallback((leafId: string) => { apply((tr) => focusLeaf(tr, leafId)); }, [apply]);

  // --------------------------------------------------------- drag & drop
  const drag = useIslandDrag();
  // Not before the arrangement is read (a write would be refused), never
  // below 768 px nor while stacked: no split there (§10).
  const canDrop = announce && !narrow && !stacked;
  const canDrag = canDrop && painted;
  const labelOf = useCallback((d: IslandDrag): string => {
    if (d.label) return d.label;
    const source = d.source;
    if (source.kind === 'content') return types.get(source.content.type)?.options.title ?? pluginOfType(source.content.type);
    const tabs = allLeaves(treeRef.current).flatMap((leaf) => leaf.tabs.map((tab) => ({ leaf, tab })));
    const found = source.kind === 'tab'
      ? tabs.find((x) => x.tab.id === source.tabId)
      : tabs.find((x) => x.leaf.id === source.islandId && x.tab.id === x.leaf.active);
    return found ? titleOf(found.tab) : '';
  }, [types, titleOf]);
  const leafTitle = useCallback((leafId: string): string => {
    const leaf = allLeaves(treeRef.current).find((x) => x.id === leafId);
    const tab = leaf ? leaf.tabs.find((x) => x.id === leaf.active) ?? leaf.tabs[0] : undefined;
    return tab ? titleOf(tab) : '';
  }, [titleOf]);
  const onDrop = useCallback((d: IslandDrag, target: IslandDropTarget) => {
    const plan = planIslandDrop(treeRef.current, d.source, target, resolve);
    if (plan.refused) return;
    apply((tr) => droppedOn(tr, d.source, target, resolve));
    d.onDropped?.();
    const vars = { title: labelOf(d), target: target.kind === 'island' ? leafTitle(target.islandId) : '' };
    setAnnouncement(target.kind === 'root'
      ? t('islands.announce.root', vars)
      : target.kind === 'float'
        ? t('islands.announce.float', vars)
        : t(target.region === 'center' ? 'islands.announce.tab' : `islands.announce.${target.region}`, vars));
  }, [resolve, apply, labelOf, leafTitle]);

  // A drop that landed on nothing — the top bar, the nav rail, another part of
  // the page — is a popup, where the pointer let go (§12). Only a drag nobody
  // took (`dropEffect` none), released outside the workspace's own layer: a
  // refused drop over it stays refused, and Escape (which reports no position)
  // cancels.
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const canDropRef = useRef(canDrop);
  canDropRef.current = canDrop;
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging || !canDropRef.current) return;
    const onEnd = (e: DragEvent) => {
      const d = dragRef.current;
      if (!d || e.dataTransfer?.dropEffect !== 'none') return;
      if (e.screenX === 0 && e.screenY === 0) return;
      const layer = document.querySelector('[data-island-drop-layer]');
      const r = layer?.getBoundingClientRect();
      if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
      if (!window.innerWidth || !window.innerHeight) return;
      onDropRef.current(d, { kind: 'float', rect: floatRectAt(e.clientX / window.innerWidth, e.clientY / window.innerHeight) });
    };
    window.addEventListener('dragend', onEnd);
    return () => window.removeEventListener('dragend', onEnd);
  }, [dragging]);
  const startTabDrag = useCallback((e: React.DragEvent, tab: IslandTab) => {
    beginIslandDrag(e, { kind: 'tab', tabId: tab.id }, titleOf(tab));
  }, [titleOf]);

  /**
   * Stacked mode: a tab is reordered within its own island, never moved to
   * another — the stacked rendering never rewrites the tree's shape (§10).
   */
  const reorderStacked = useCallback((tabId: TabId, target: TabId, after = false) => {
    const leaf = allLeaves(treeRef.current).find((l) => l.tabs.some((x) => x.id === tabId));
    const tab = leaf?.tabs.find((x) => x.id === tabId);
    if (!leaf || !tab || tabId === target || !leaf.tabs.some((x) => x.id === target)) return;
    const others = leaf.tabs.filter((x) => x.id !== tabId);
    const result = apply((tr) => moveTab(tr, tabId, leaf.id, others.findIndex((x) => x.id === target) + (after ? 1 : 0)));
    if (!result.refused) setAnnouncement(t('islands.stack.moved', { title: titleOf(tab) }));
  }, [apply, titleOf]);

  // ------------------------------------------------------------- keyboard
  // A tab to give the focus to once the tree it lives in is on screen (after
  // an arrow key, a close, a move, the focus key).
  const [focusRequest, setFocusRequest] = useState<{ tabId: TabId } | null>(null);
  useIsomorphicLayoutEffect(() => {
    if (!focusRequest) return;
    setFocusRequest(null);
    const handle = Array.from(container.current?.querySelectorAll<HTMLElement>('[data-island-tab-handle]') ?? [])
      .find((el) => el.dataset.islandTabHandle === focusRequest.tabId);
    (handle?.querySelector<HTMLElement>('[role="tab"]') ?? handle)?.focus();
  }, [focusRequest]);
  const focusActiveOf = useCallback((next: IslandTree, leafId: string) => {
    const leaf = findLeaf(next, leafId) ?? findLeaf(next, next.focus ?? '') ?? collectLeaves(next.root)[0]!;
    setFocusRequest({ tabId: leaf.active });
  }, []);

  /** Delete on a tab of a bar: closed, and the focus stays in that bar (§11). */
  const closeFromKeyboard = useCallback((tabId: TabId) => {
    const leafId = leafOfTab(treeRef.current, tabId)?.id;
    void requestClose([tabId], { after: () => { if (leafId) focusActiveOf(treeRef.current, leafId); } });
  }, [requestClose, focusActiveOf]);
  const activateFromKeyboard = useCallback((tabId: TabId) => {
    apply((tr) => activateTab(tr, tabId));
    setFocusRequest({ tabId });
  }, [apply]);

  // F6 / Shift+F6: the focus goes to the next island's tab bar. Only while
  // islands are laid out; a key already handled (a terminal's) is left alone.
  const hasLayout = layout !== null;
  useEffect(() => {
    if (!hasLayout) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isIslandFocusKey(e)) return;
      e.preventDefault();
      const current = treeRef.current;
      const from = islandOfElement(current, document.activeElement, container.current) ?? current.focus;
      const next = cycleIsland(current, from, e.shiftKey);
      const result = apply((tr) => focusLeaf(tr, next));
      focusActiveOf(result.tree, next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasLayout, apply, focusActiveOf]);

  // "Move…" (§11): the arrows pick the island, Tab the place, Enter drops,
  // Escape cancels. The target is a drop target: the plan, the preview and the
  // pill are the pointer's own.
  const [moving, setMoving] = useState<{ source: IslandDragSource; title: string; target: MoveTarget } | null>(null);
  const movingRef = useRef(moving);
  movingRef.current = moving;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const startMove = useCallback((source: IslandDragSource) => {
    const current = layoutRef.current;
    if (!current) return;
    const target = initialMoveTarget(treeRef.current, current, source);
    if (!target) return;
    const title = source.kind === 'island' ? leafTitle(source.islandId)
      : source.kind === 'tab' ? titleOf(allLeaves(treeRef.current).flatMap((leaf) => leaf.tabs).find((x) => x.id === source.tabId)!)
        : '';
    setMoving({ source, title, target });
    setAnnouncement(t('islands.move.start', { title }));
  }, [leafTitle, titleOf]);
  const isMoving = moving !== null;
  useEffect(() => {
    if (!isMoving) return;
    const end = (said: string | null) => {
      setMoving(null);
      if (said) setAnnouncement(said);
    };
    const onKey = (e: KeyboardEvent) => {
      const m = movingRef.current;
      const current = layoutRef.current;
      if (!m || !current) return;
      const direction = arrowDirection(e.key);
      let target: MoveTarget | null = null;
      if (direction) target = { islandId: islandInDirection(current, m.target.islandId, direction) ?? m.target.islandId, region: m.target.region };
      else if (e.key === 'Tab') target = { islandId: m.target.islandId, region: nextRegion(m.target.region, e.shiftKey) };
      else if (e.key !== 'Enter' && e.key !== 'Escape') return;
      // The mode owns these keys: nothing under it (a terminal, the page) sees them.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { end(t('islands.move.cancelled')); return; }
      const drop: IslandDropTarget = { kind: 'island', ...m.target };
      if (e.key === 'Enter') {
        const plan = planIslandDrop(treeRef.current, m.source, drop, resolve);
        if (plan.refused) { setAnnouncement(t(`islands.refused.${plan.refused}`)); return; }
        const where = leafTitle(m.target.islandId);
        apply((tr) => droppedOn(tr, m.source, drop, resolve));
        end(t(m.target.region === 'center' ? 'islands.announce.tab' : `islands.announce.${m.target.region}`, { title: m.title, target: where }));
        // An island merged into another is gone: the focus goes to where it went.
        const moved = m.source.kind === 'tab' ? m.source.tabId
          : (findLeaf(plan.tree, m.source.kind === 'island' ? m.source.islandId : '') ?? findLeaf(plan.tree, m.target.islandId))?.active ?? null;
        if (moved) setFocusRequest({ tabId: moved });
        return;
      }
      if (target) {
        setMoving({ ...m, target });
        const plan = planIslandDrop(treeRef.current, m.source, { kind: 'island', ...target }, resolve);
        setAnnouncement(plan.refused
          ? t(`islands.refused.${plan.refused}`)
          : t(dropLabelKey({ kind: 'island', ...target }), { target: leafTitle(target.islandId) }));
      }
    };
    // A click elsewhere is a change of mind.
    const onPointer = () => end(t('islands.move.cancelled'));
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [isMoving, apply, resolve, leafTitle]);
  // No layout any more (narrow, stacked): nothing to move among.
  useEffect(() => { if (!hasLayout && movingRef.current) setMoving(null); }, [hasLayout]);

  // An island moved by its handle, like a window (§12): no drop layer, only the screen's edges dock it.
  const windowMove = useIslandWindowMove({
    container,
    treeRef,
    layoutRef,
    box,
    apply,
    resolve,
    onDocked: (leafId, target) => {
      const vars = { title: leafTitle(leafId), target: target.kind === 'island' ? leafTitle(target.islandId) : '' };
      setAnnouncement(target.kind === 'island' ? t(`islands.announce.${target.region}`, vars) : t('islands.announce.root', vars));
    },
  });

  // A popup carried past the workspace's edge is painted where the pointer is (see `IslandWindowMove.shift`).
  const moved = windowMove.state;
  const carrying = moved !== null;
  // A popup painted past the workspace's edge widens the scrollable area of
  // every ancestor and the document: bars appear and the whole UI shifts under
  // the pointer. Scrollers that have no bar yet are held at `overflow: hidden`
  // for the length of the move; one that already scrolls keeps its bar, so
  // nothing is added or taken away.
  useEffect(() => {
    if (!carrying || !container.current) return;
    const held: Array<[HTMLElement, string]> = [];
    const hold = (el: HTMLElement) => {
      const { overflowX, overflowY } = getComputedStyle(el);
      // `visible` only matters on the root, where it means "the viewport scrolls".
      const root = el === document.body || el === document.documentElement;
      const scrolls = (v: string) => v === 'auto' || v === 'scroll' || (root && v === 'visible');
      if (!scrolls(overflowX) && !scrolls(overflowY)) return;
      if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) return;
      held.push([el, el.style.overflow]);
      el.style.overflow = 'hidden';
    };
    for (let el = container.current.parentElement; el && el !== document.body; el = el.parentElement) hold(el);
    hold(document.body);
    hold(document.documentElement);
    return () => { for (const [el, previous] of held) el.style.overflow = previous; };
  }, [carrying]);
  const shiftStyle = (leafId: string): CSSProperties => (moved?.shift && moved.leafId === leafId
    ? { transform: `translate(${moved.shift.x}px, ${moved.shift.y}px)` }
    : {});

  // ------------------------------------------------------------- folding
  // The pressed button goes away with its popup: the focus follows it to its
  // tab in the corner, and back into the popup when it is shown again.
  const [foldedFocus, setFoldedFocus] = useState<string | null>(null);
  useIsomorphicLayoutEffect(() => {
    if (!foldedFocus) return;
    setFoldedFocus(null);
    document.querySelector<HTMLElement>(`[data-island-minimized="${foldedFocus}"]`)?.focus();
  }, [foldedFocus]);
  const minimize = useCallback((leafId: string) => {
    // A docked island folds too: it first becomes a popup where it stands, then
    // folds into the corner (the page's island is refused by `floatLeaf`).
    const result = apply((tr) => {
      if (floatOf(tr, leafId)) return setFloatMinimized(tr, leafId, true);
      const floated = floatLeaf(tr, leafId, floatRectAt(0.5, 0.5));
      return floated.refused ? floated : setFloatMinimized(floated.tree, leafId, true);
    });
    if (result.refused) return;
    setAnnouncement(t('islands.announce.minimized', { title: leafTitle(leafId) }));
    setFoldedFocus(leafId);
  }, [apply, leafTitle]);
  const restore = useCallback((leafId: string) => {
    const result = apply((tr) => setFloatMinimized(tr, leafId, false));
    if (!result.refused) focusActiveOf(result.tree, leafId);
  }, [apply, focusActiveOf]);

  // ------------------------------------------------------------- chassis
  const chassis: ReactElement[] = [];
  if (layout) {
    for (const leaf of leaves) {
      const rect = layout.islands[leaf.id];
      if (!rect) continue;
      const popup = floatOf(tree, leaf.id);
      chassis.push(
        <div
          key={leaf.id}
          data-island={leaf.id}
          data-island-float={popup ? (popup.pinned ? 'pinned' : 'view') : undefined}
          // The island's own glass (its menu); absent, it follows <html>'s.
          data-glass-scope={leaf.glassScope}
          className={cn(
            'timon-island absolute flex flex-col',
            popup && 'shadow-elev-2 ring-1 ring-border',
          )}
          style={{ ...rectStyle(rect), ...CONFINED_VARS, ...(popup ? { zIndex: floatZ.get(leaf.id) } : {}), ...shiftStyle(leaf.id) }}
          onPointerDownCapture={() => focusIsland(leaf.id)}
        >
          <IslandGlassScopeProvider value={leaf.glassScope ?? null}><GlassClear /></IslandGlassScopeProvider>
          {/* The page alone keeps no header, only the island's own fill. */}
          {!(routeBare && leaf.id === routeLeafId) && !bareLeaves.has(leaf.id) && <IslandHeader
            leaf={leaf}
            types={types}
            titleOf={titleOf}
            onDragTab={canDrag ? startTabDrag : undefined}
            onMoveWindow={canDrag ? windowMove.start : undefined}
            onActivate={(tabId) => apply((tr) => activateTab(tr, tabId))}
            onClose={userClose}
            onKeyActivate={activateFromKeyboard}
            onKeyClose={closeFromKeyboard}
            onMove={canDrop ? startMove : undefined}
            canMoveIsland={shownLeaves.length > 1}
            floating={!!popup}
            pinned={popup?.pinned === true}
            onNewTab={(tab) => { void newTabIn(leaf.id, tab); }}
            onPopup={canDrop ? (tabId) => { apply((tr) => floatTab(tr, tabId, floatRectAt(0.5, 0.5))); } : undefined}
            onDock={canDrop && popup ? () => { apply((tr) => moveLeafToRoot(tr, leaf.id, 'right')); } : undefined}
            onPin={canDrop && popup ? () => { apply((tr) => setFloatPinned(tr, leaf.id, popup.pinned !== true)); } : undefined}
            // The island holding the page can neither fold nor close: the view must always paint it.
            onMinimize={canDrop && leaf.id !== routeLeafId ? () => { minimize(leaf.id); } : undefined}
            // Tab by tab, so each type hears its own close and the screen reader each title.
            onCloseIsland={leaf.id !== routeLeafId ? () => { void requestClose(leaf.tabs.map((tab) => tab.id)); } : undefined}
            onGlassScope={(scope) => { apply((tr) => setLeafGlassScope(tr, leaf.id, scope)); }}
            routeAgent={routeAgent}
          />}
        </div>,
      );
      if (leaf.id === tree.focus && shownLeaves.length > 1 && pageOptions?.focusRing !== false) {
        // Inside the island, above its content: an outer ring would be cut by
        // the nav rail, the top bar or a neighbour, and the content covers the
        // chassis' own inside.
        const above = floatZ.get(leaf.id);
        chassis.push(
          <div
            key={`${leaf.id}:focus`}
            data-island-focus-ring=""
            aria-hidden
            className="pointer-events-none absolute rounded-[var(--timon-island-radius)] ring-2 ring-inset ring-primary/60"
            style={{ ...rectStyle(rect), zIndex: above !== undefined ? above + 2 : 15, ...shiftStyle(leaf.id) }}
          />,
        );
      }
      if (popup && canDrop) {
        const above = floatZ.get(leaf.id);
        chassis.push(
          <FloatResizeFrame
            key={`${leaf.id}:resize`}
            rect={popup.rect}
            at={rect}
            zIndex={above !== undefined ? above + 2 : undefined}
            shift={shiftStyle(leaf.id)}
            box={box}
            onResize={(next, persist) => { apply((tr) => floatLeaf(tr, leaf.id, next), persist); }}
          />,
        );
      }
    }
  } else if (stacked) {
    chassis.push(
      // In the flow, not placed from the measured box: a phone's top bar folds
      // and unfolds while the thread scrolls, and a box measured one frame
      // late made the content jump under it at every frame of the animation.
      <div key="stack" className="timon-island flex shrink-0 flex-col rounded-b-none" style={CONFINED_VARS}>
        <StackPicker
          tabs={allTabs}
          shown={shownInStack}
          titleOf={titleOf}
          detachOf={(tab) => (tab.content.type === HOST_ROUTE ? undefined : types.get(tab.content.type)?.options.detach)}
          onActivate={(tabId) => apply((tr) => activateTab(tr, tabId))}
          onClose={userClose}
          onKeyActivate={activateFromKeyboard}
          onKeyClose={closeFromKeyboard}
          onReorder={reorderStacked}
          islandOf={(tabId) => leaves.find((leaf) => leaf.tabs.some((x) => x.id === tabId))?.id}
          canDrag={!narrow}
        />
      </div>,
    );
  }

  // ------------------------------------------------------------- contents
  const contents: ReactElement[] = [];
  for (const leaf of leaves) {
    for (const tab of leaf.tabs) {
      const isRoute = tab.content.type === HOST_ROUTE;
      const type = isRoute ? undefined : types.get(tab.content.type);
      const visible = isVisible(leaf, tab);
      if (!visible && !isRoute && !type?.options.keepMounted) continue;
      let style: CSSProperties | undefined;
      let wrapperClass: string;
      if (!visible) {
        // Before the frame's own case: a kept tab of a folded popup must not
        // lay out in the page while nothing else is painted.
        wrapperClass = 'hidden';
      } else if (!painted) {
        // No box of its own: the page lays out in the host's frame exactly as before.
        wrapperClass = 'contents';
      } else if (routeBare && isRoute) {
        // The page alone, over popups: the whole container, nav and edge
        // gutters included, as it had when the workspace was `contents`. A
        // narrower box centres the chat's thread a few pixels off.
        wrapperClass = 'absolute inset-0 isolate flex flex-col overflow-hidden';
      } else if (stacked) {
        // Under the picker, in the flow (see the picker's chassis).
        wrapperClass = 'timon-island relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-none';
      } else {
        const rect = layout?.islands[leaf.id];
        wrapperClass = 'absolute flex flex-col overflow-hidden';
        style = rect ? {
          left: rect.x,
          top: rect.y + headerOf(leaf.id),
          width: rect.width,
          height: Math.max(0, rect.height - headerOf(leaf.id)),
        } : undefined;
      }
      if (painted && visible && !(routeBare && isRoute)) {
        const above = floatZ.get(leaf.id);
        style = {
          ...style,
          ...(above !== undefined ? { zIndex: above + 1 } : {}),
          ...shiftStyle(leaf.id),
          // The page bodies offset themselves by the nav and the docks; in an
          // island there is neither. Set here and not on the container, whose
          // own padding may use the real values (§1).
          ...CONFINED_VARS,
          // A `fixed` element of the page resolves against this box, not the viewport (§1).
          contain: 'layout paint',
          borderBottomLeftRadius: 'var(--timon-island-radius)',
          borderBottomRightRadius: 'var(--timon-island-radius)',
          // Without a header above it, the content holds the island's top corners too.
          ...(bareLeaves.has(leaf.id) ? { borderTopLeftRadius: 'var(--timon-island-radius)', borderTopRightRadius: 'var(--timon-island-radius)' } : {}),
        };
      }
      contents.push(
        <div
          key={isRoute ? HOST_ROUTE : tab.id}
          // The route's tab id is minted per render of a default tree: on the
          // server and in the browser alike, a constant keeps hydration quiet.
          data-island-tab={isRoute ? HOST_ROUTE : tab.id}
          // The chassis is a sibling, not a parent: the contents carry the
          // island's glass themselves, for the widgets they hold.
          data-glass-scope={painted ? leaf.glassScope : undefined}
          className={wrapperClass}
          style={style}
          // `inert` hides a kept-mounted tab from the keyboard and assistive
          // tech. A boolean: React 19 drops the attribute for an empty string.
          {...(!visible ? HIDDEN_TAB_ATTRS : {})}
          // On the click, not on the press: focusing an island can reshape
          // its content (a passive chat gets its columns back, a card moves
          // to another column). React repaints only once the click has reached
          // its button; on a press, the button moved or was remounted before
          // its click, which never came.
          onClickCapture={painted && !stacked ? () => focusIsland(leaf.id) : undefined}
        >
          <IslandGlassScopeProvider value={leaf.glassScope ?? null}>
          {isRoute ? (
            <IslandPaintedContext.Provider value={painted}>
              <IslandRouteSizeContext.Provider value={routeSize}>
              <IslandRoutePrimaryContext.Provider value={!painted || isPrimary(tab, routeExclusive)}>
                <IslandRouteFocusedContext.Provider value={!painted || leaf.id === tree.focus}>
                  <IslandRouteTabContext.Provider value={routeTab}>{route}</IslandRouteTabContext.Provider>
                </IslandRouteFocusedContext.Provider>
              </IslandRoutePrimaryContext.Provider>
              </IslandRouteSizeContext.Provider>
            </IslandPaintedContext.Provider>
          ) : (
            <IslandTabBody
              islandId={leaf.id}
              tab={tab}
              type={type}
              focused={leaf.id === tree.focus}
              active={visible}
              primary={isPrimary(tab, type?.options.exclusive)}
              actions={actionsOf(tab.id)}
            />
          )}
          </IslandGlassScopeProvider>
        </div>,
      );
    }
  }

  // ------------------------------------------------------------- gutters
  const gutters: ReactElement[] = layout ? layout.gutters.map((gutter) => {
    const split = findNode(tree.root, gutter.splitId);
    if (!split || split.kind !== 'split') return null;
    return (
      <IslandGutter
        key={`${gutter.splitId}:${gutter.index}`}
        gutter={gutter}
        split={split}
        gap={box.gap}
        minOf={minOf}
        apply={apply}
      />
    );
  }).filter((g): g is ReactElement => g !== null) : [];

  return (
    <div
      ref={container}
      data-island-workspace={painted ? (stacked ? 'stacked' : 'split') : 'single'}
      // Alone, the page keeps the glass its island chose before the others closed.
      data-glass-scope={painted ? undefined : singleGlass ?? undefined}
      // `isolate`: the islands' own layers (popups, focus ring, resize handles)
      // stack among themselves, never above the nav rail or the top bar.
      className={painted ? cn('timon-island-backdrop isolate', splitClassName, stacked && 'flex flex-col') : className}
    >
      {!painted && frameIsIsland && <IslandGlassScopeProvider value={singleGlass}><GlassClear /></IslandGlassScopeProvider>}
      {chassis}
      {contents}
      {gutters}
      {moving && layout && (() => {
        const target: IslandDropTarget = { kind: 'island', ...moving.target };
        return (
          <div data-island-move-layer="" className="pointer-events-none absolute inset-0 z-40">
            <IslandDropPreview
              tree={tree}
              target={target}
              refused={planIslandDrop(tree, moving.source, target, resolve).refused}
              layout={layout}
              box={box}
              headerPx={HEADER_PX}
              leafTitle={leafTitle}
            />
            <div className="absolute inset-x-0 bottom-3 grid place-items-center" style={{ paddingLeft: box.x }}>
              <span aria-hidden className="rounded-full bg-popover/95 px-3 py-1 text-xs text-muted-foreground shadow-elev-2 backdrop-blur-sm">
                {t('islands.move.hint')}
              </span>
            </div>
          </div>
        );
      })()}
      {windowMove.state && layout && (windowMove.state.target || windowMove.state.outline) && (
        // Under the moved popup, above everything else: the window stays sharp over the place it would take.
        <div
          data-island-window-snap=""
          className="pointer-events-none absolute inset-0"
          style={{ zIndex: (floatZ.get(windowMove.state.leafId) ?? 41) - 1 }}
        >
          {windowMove.state.outline && (
            <div
              data-island-window-outline=""
              className="absolute rounded-[var(--timon-island-radius)] bg-primary/10 ring-2 ring-inset ring-primary/60 backdrop-blur-md"
              style={rectStyle(windowMove.state.outline)}
            />
          )}
          {windowMove.state.target && (
            <IslandDropPreview
              tree={tree}
              target={windowMove.state.target}
              refused={null}
              layout={layout}
              box={box}
              headerPx={HEADER_PX}
              leafTitle={leafTitle}
            />
          )}
        </div>
      )}
      {windowMove.state && typeof document !== 'undefined' && createPortal(
        // Above any iframe or canvas that would swallow the pointer on its way.
        <div data-island-window-move="" className="fixed inset-0 z-[70] cursor-grabbing" />,
        document.body,
      )}
      {drag && canDrop && (
        <IslandDropLayer
          drag={drag}
          tree={tree}
          layout={layout}
          box={box}
          frame={container}
          headerPx={HEADER_PX}
          resolve={resolve}
          leafTitle={leafTitle}
          onDrop={onDrop}
        />
      )}
      {announce && !stacked && folded.size > 0 && typeof document !== 'undefined' && createPortal(
        <MinimizedPopups tree={tree} titleOf={titleOf} onRestore={restore} />,
        document.body,
      )}
      <div aria-live="polite" className="sr-only">{announcement}</div>
    </div>
  );
}

/** The island an element of the workspace belongs to: its chassis (header), or the body of one of its tabs. */
function islandOfElement(tree: IslandTree, el: Element | null, root: HTMLElement | null): string | null {
  if (!el || !root?.contains(el)) return null;
  const chassis = el.closest('[data-island]');
  if (chassis) return chassis.getAttribute('data-island');
  const tabId = el.closest('[data-island-tab]')?.getAttribute('data-island-tab');
  if (!tabId) return null;
  if (tabId === HOST_ROUTE) {
    return collectLeaves(tree.root).find((leaf) => leaf.tabs.some((tab) => tab.content.type === HOST_ROUTE))?.id ?? null;
  }
  return leafOfTab(tree, tabId)?.id ?? null;
}

type TabActions = Pick<IslandContentValue, 'setParams' | 'setTitle' | 'close'>;

/** The content of one tab, or what stands in for it while its type is missing. */
function IslandTabBody({
  islandId,
  tab,
  type,
  focused,
  active,
  primary,
  actions,
}: {
  islandId: string;
  tab: IslandTab;
  type: IslandContentType | undefined;
  focused: boolean;
  active: boolean;
  primary: boolean;
  actions: TabActions;
}): ReactElement {
  const valid = useMemo(() => (type ? type.options.parseParams(tab.content.params) !== null : false), [type, tab.content.params]);
  const value = useMemo<IslandContentValue>(() => ({
    islandId,
    tabId: tab.id,
    type: tab.content.type,
    params: tab.content.params,
    ...actions,
    focused,
    active,
    primary,
  }), [islandId, tab, focused, active, primary, actions]);
  const onClose = actions.close;
  if (!type || !valid) {
    // Kept in the tree: it comes back as soon as its plugin registers again (§2).
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <p>{t('islands.unavailable', { plugin: pluginOfType(tab.content.type) })}</p>
        <button type="button" onClick={onClose} className="rounded-md bg-muted px-3 py-1.5 text-foreground hover:bg-muted/70">
          {t('islands.close')}
        </button>
      </div>
    );
  }
  const Component = type.entry.Component;
  return (
    <IslandContentContext.Provider value={value}>
      <PluginBoundary pluginId={type.entry.pluginId}><Component /></PluginBoundary>
    </IslandContentContext.Provider>
  );
}

/**
 * The keys of a tab bar (ARIA tabs pattern, §11): arrows and Home/End move to
 * a tab and show it, Delete closes the focused one (never the page's), the
 * menu key opens its menu.
 */
function tabBarKeyDown(
  e: ReactKeyboardEvent<HTMLElement>,
  tabs: readonly IslandTab[],
  onKeyActivate: (tabId: TabId) => void,
  onKeyClose: (tabId: TabId) => void,
  onMenu?: (tabId: TabId) => void,
  onMoveKey?: (tabId: TabId, what: 'tab' | 'island') => void,
): void {
  const current = (e.target as HTMLElement).closest<HTMLElement>('[data-island-tab-handle]')?.dataset.islandTabHandle;
  if (!current) return;
  if (e.key === 'Delete') {
    const tab = tabs.find((x) => x.id === current);
    if (!tab || tab.content.type === HOST_ROUTE) return;
    e.preventDefault();
    onKeyClose(current);
    return;
  }
  if (onMenu && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
    e.preventDefault();
    onMenu(current);
    return;
  }
  const move = onMoveKey ? moveKeyOf(e) : null;
  if (move) {
    e.preventDefault();
    onMoveKey!(current, move);
    return;
  }
  const next = tabForKey(tabs.map((x) => x.id), current, e.key);
  if (!next) return;
  e.preventDefault();
  onKeyActivate(next);
}

function IslandHeader({
  leaf,
  types,
  titleOf,
  onActivate,
  onClose,
  onKeyActivate,
  onKeyClose,
  onDragTab,
  onMoveWindow,
  onMove,
  canMoveIsland,
  onNewTab,
  floating,
  pinned,
  onPopup,
  onDock,
  onPin,
  onMinimize,
  onCloseIsland,
  onGlassScope,
  routeAgent,
}: {
  leaf: IslandLeaf;
  types: ReadonlyMap<string, IslandContentType>;
  titleOf: (tab: IslandTab) => string;
  onActivate: (tabId: TabId) => void;
  /** A close the user asked for; `before` runs once no content vetoed it. */
  onClose: (tabId: TabId, before?: () => void) => void;
  onKeyActivate: (tabId: TabId) => void;
  onKeyClose: (tabId: TabId) => void;
  /** Set while tabs and islands may be dragged (§6). */
  onDragTab?: (e: React.DragEvent, tab: IslandTab) => void;
  /** The island's handle pressed: it moves like a window (§12). */
  onMoveWindow?: (e: React.PointerEvent<HTMLElement>, leafId: string) => void;
  /** The keyboard's "Move…" (§11), keys M / Shift+M on a tab; absent while nothing may move. */
  onMove?: (source: IslandDragSource) => void;
  canMoveIsland: boolean;
  /** The "+" of a type that makes its own tabs (`newTab`): asked with the shown tab. */
  onNewTab?: (tab: IslandTab) => void;
  /** A popup: it docks, and it can be kept everywhere (§12). */
  floating?: boolean;
  pinned?: boolean;
  onPopup?: (tabId: TabId) => void;
  onDock?: () => void;
  onPin?: () => void;
  /** Folds the popup into its tab in the corner, beside its close. */
  onMinimize?: () => void;
  /** A popup's own close, at its right end like a window's. */
  onCloseIsland?: () => void;
  /** Where this island's glass sits; `null` follows the Appearance setting. */
  onGlassScope?: (scope: GlassScope | null) => void;
  /** The agent the page is the chat of: the route's tab wears its avatar. */
  routeAgent?: string;
}): ReactElement {
  const active = leaf.tabs.find((tab) => tab.id === leaf.active) ?? leaf.tabs[0]!;
  const detach = active.content.type === HOST_ROUTE ? undefined : types.get(active.content.type)?.options.detach;
  const single = leaf.tabs.length === 1;
  // The menu is the header's, and also each tab's context menu: it then
  // speaks of that tab rather than the active one.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuTabId, setMenuTabId] = useState<TabId | null>(null);
  const menuTab = leaf.tabs.find((tab) => tab.id === menuTabId) ?? active;
  const openMenuFor = onMove ? (tabId: TabId) => { setMenuTabId(tabId); setMenuOpen(true); } : undefined;
  const canMoveTab = !single || canMoveIsland;
  const onMoveKey = onMove ? (tabId: TabId, what: 'tab' | 'island') => {
    if (what === 'island' ? canMoveIsland : canMoveTab) onMove(what === 'island' ? { kind: 'island', islandId: leaf.id } : { kind: 'tab', tabId });
  } : undefined;
  const moveHint = onMove ? t('islands.move.keys') : undefined;
  // With the glass on, every island's menu says where its glass sits.
  const glassOn = useGlassScope() !== null && !!onGlassScope;
  const menuHasItems = glassOn || menuTab.content.type !== HOST_ROUTE || (floating === true && !!(onDock || onPin || onMinimize));
  // Right after the last tab, not at the far end of the bar: it adds to that row.
  const newTabButton = onNewTab && active.content.type !== HOST_ROUTE && types.get(active.content.type)?.options.newTab ? (
    <button
      type="button"
      aria-label={t('islands.newTab')}
      title={t('islands.newTab')}
      onClick={() => onNewTab(active)}
      // Inside the window handle of a single tab: a click is not a move.
      onPointerDown={(e) => e.stopPropagation()}
      className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Plus className="size-3.5" />
    </button>
  ) : null;
  return (
    <div className="flex shrink-0 items-center gap-1 px-1.5" style={{ height: HEADER_PX }}>
      {onMoveWindow && (
        // The island's handle: the whole island, all its tabs, moved like a window (§12).
        <span
          data-island-move-handle=""
          onPointerDown={(e) => onMoveWindow(e, leaf.id)}
          title={t('islands.drag.island')}
          aria-hidden
          className="shrink-0 cursor-grab touch-none select-none rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </span>
      )}
      {single ? (
        <div
          className={cn('flex min-w-0 flex-1 items-center gap-1.5 pl-0 outline-none', onMoveWindow && 'cursor-grab touch-none select-none active:cursor-grabbing')}
          data-island-tab-handle={active.id}
          // Reached by the focus key (F6), not by Tab: it is a title.
          tabIndex={-1}
          onPointerDown={onMoveWindow ? (e) => onMoveWindow(e, leaf.id) : undefined}
          onContextMenu={openMenuFor ? (e) => { e.preventDefault(); openMenuFor(active.id); } : undefined}
          aria-keyshortcuts={onMove ? 'M Shift+M' : undefined}
          title={moveHint}
          onKeyDown={openMenuFor ? (e) => {
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openMenuFor(active.id); return; }
            const move = moveKeyOf(e);
            if (move && onMoveKey) { e.preventDefault(); onMoveKey(active.id, move); }
          } : undefined}
        >
          <TabGlyph tab={active} types={types} routeAgent={routeAgent} />
          <span className="truncate text-xs font-medium text-foreground">{titleOf(active)}</span>
          {active.content.type !== HOST_ROUTE && !onCloseIsland && (
            <CloseTabButton title={titleOf(active)} onClick={() => onClose(active.id)} />
          )}
          {newTabButton}
        </div>
      ) : (
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          // Too many tabs for the width: the bar scrolls, wheel included (§8).
          onWheel={(e) => { if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY; }}
        >
        <div
          role="tablist"
          aria-label={t('islands.tabs')}
          className="flex shrink-0 items-center gap-1"
          onKeyDown={(e) => tabBarKeyDown(e, leaf.tabs, onKeyActivate, onKeyClose, openMenuFor, onMoveKey)}
        >
          {leaf.tabs.map((tab) => {
            const selected = tab.id === leaf.active;
            const closable = tab.content.type !== HOST_ROUTE;
            return (
              <div
                key={tab.id}
                data-island-tab-handle={tab.id}
                draggable={!!onDragTab}
                onDragStart={onDragTab ? (e) => onDragTab(e, tab) : undefined}
                onContextMenu={openMenuFor ? (e) => { e.preventDefault(); openMenuFor(tab.id); } : undefined}
                className={cn(
                  'group flex shrink-0 items-center gap-1 rounded-md pl-2 pr-1 text-xs transition-colors',
                  // Surface contrast, never an underline (rule 16).
                  selected ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  // Roving focus: Tab enters the bar on the shown tab, the arrows walk it.
                  tabIndex={selected ? 0 : -1}
                  aria-keyshortcuts={onMove ? 'M Shift+M' : undefined}
                  title={moveHint}
                  onClick={() => onActivate(tab.id)}
                  onAuxClick={(e) => { if (e.button === 1 && closable) { e.preventDefault(); onClose(tab.id); } }}
                  className="flex max-w-48 items-center gap-1.5 rounded-sm py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <TabGlyph tab={tab} types={types} routeAgent={routeAgent} />
                  <span className="truncate">{titleOf(tab)}</span>
                </button>
                {/* Delete closes from the keyboard: the button stays out of the Tab order. */}
                {closable && <CloseTabButton title={titleOf(tab)} onClick={() => onClose(tab.id)} tabIndex={-1} />}
              </div>
            );
          })}
        </div>
        {newTabButton}
        </div>
      )}
      {detach && (
        <button
          type="button"
          aria-label={t('islands.detach')}
          title={t('islands.detach')}
          onClick={() => { onClose(active.id, () => detach(active.content.params)); }}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </button>
      )}
      {onMove && menuHasItems && (
        <DropdownMenu open={menuOpen} onOpenChange={(open) => { setMenuOpen(open); if (!open) setMenuTabId(null); }}>
          <DropdownMenuTrigger
            aria-label={t('islands.menu')}
            title={t('islands.menu')}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onPopup && !floating && menuTab.content.type !== HOST_ROUTE && (
              <DropdownMenuItem data-island-menu="popup" onSelect={() => onPopup(menuTab.id)}>
                <AppWindow className="size-4" aria-hidden />
                {t('islands.popup.open', { title: titleOf(menuTab) })}
              </DropdownMenuItem>
            )}
            {onDock && floating && (
              <DropdownMenuItem data-island-menu="dock" onSelect={onDock}>
                <PanelRight className="size-4" aria-hidden />
                {t('islands.popup.dock')}
              </DropdownMenuItem>
            )}
            {onPin && floating && (
              <DropdownMenuItem data-island-menu="pin" onSelect={onPin}>
                {pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}
                {pinned ? t('islands.popup.unpin') : t('islands.popup.pin')}
              </DropdownMenuItem>
            )}
            {onMinimize && floating && (
              <DropdownMenuItem data-island-menu="minimize" onSelect={onMinimize}>
                <Minus className="size-4" aria-hidden />
                {t('islands.popup.minimize')}
              </DropdownMenuItem>
            )}
            {glassOn && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-island-menu="glass">
                  <Droplets className="size-4" aria-hidden />
                  {t('islands.glass.menu')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={leaf.glassScope ?? 'follow'}
                    onValueChange={(value) => { onGlassScope?.(readGlassScope(value)); }}
                  >
                    <DropdownMenuRadioItem value="follow" data-island-glass="follow">{t('islands.glass.follow')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="island" data-island-glass="island">{t('islands.glass.island')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="widgets" data-island-glass="widgets">{t('islands.glass.widgets')}</DropdownMenuRadioItem>
                    {GLASS_TUNING_ENABLED && <DropdownMenuRadioItem value="both" data-island-glass="both">{t('islands.glass.both')}</DropdownMenuRadioItem>}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {menuTab.content.type !== HOST_ROUTE && (
              <DropdownMenuItem data-island-menu="close" onSelect={() => onClose(menuTab.id)}>
                <X className="size-4" aria-hidden />
                {t('islands.closeTab', { title: titleOf(menuTab) })}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onMinimize && (
        <button
          type="button"
          data-island-minimize=""
          aria-label={t('islands.popup.minimize')}
          title={t('islands.popup.minimize')}
          onClick={onMinimize}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Minus className="size-3.5" />
        </button>
      )}
      {onCloseIsland && (
        <button
          type="button"
          data-island-close=""
          aria-label={t('islands.popup.close')}
          title={t('islands.popup.close')}
          onClick={onCloseIsland}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * The folded popups, one tab each in the bottom-right corner, above the
 * chrome: the workspace is `isolate`, so they are carried to `<body>`. A click
 * (or Enter) brings the popup back where it was.
 */
function MinimizedPopups({
  tree,
  titleOf,
  onRestore,
}: {
  tree: IslandTree;
  titleOf: (tab: IslandTab) => string;
  onRestore: (leafId: string) => void;
}): ReactElement {
  const folded = (tree.floats ?? []).filter((f) => f.minimized === true);
  return (
    <div
      role="group"
      aria-label={t('islands.popup.minimized')}
      data-island-minimized-group=""
      className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2"
    >
      {folded.map(({ leaf }) => {
        const active = leaf.tabs.find((tab) => tab.id === leaf.active) ?? leaf.tabs[0]!;
        const title = titleOf(active);
        return (
          <button
            key={leaf.id}
            type="button"
            data-island-minimized={leaf.id}
            onClick={() => onRestore(leaf.id)}
            aria-label={t('islands.popup.restore', { title })}
            title={t('islands.popup.restore', { title })}
            className="flex max-w-60 items-center gap-2 rounded-full bg-card px-3 py-2 text-xs font-medium text-card-foreground shadow-elev-2 ring-1 ring-border transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AppWindow className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{title}</span>
            {leaf.tabs.length > 1 && <span className="tabular-nums text-muted-foreground">{leaf.tabs.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The eight handles of a popup, straddling its border so they never cover its content. */
const FLOAT_RESIZE_HANDLES: { key: string; edges: FloatEdges; className: string }[] = [
  { key: 'n', edges: { n: true }, className: 'inset-x-3 -top-1 h-2 cursor-ns-resize' },
  { key: 's', edges: { s: true }, className: 'inset-x-3 -bottom-1 h-2 cursor-ns-resize' },
  { key: 'w', edges: { w: true }, className: 'inset-y-3 -left-1 w-2 cursor-ew-resize' },
  { key: 'e', edges: { e: true }, className: 'inset-y-3 -right-1 w-2 cursor-ew-resize' },
  { key: 'nw', edges: { n: true, w: true }, className: '-left-1 -top-1 size-4 cursor-nwse-resize' },
  { key: 'ne', edges: { n: true, e: true }, className: '-right-1 -top-1 size-4 cursor-nesw-resize' },
  { key: 'sw', edges: { s: true, w: true }, className: '-bottom-1 -left-1 size-4 cursor-nesw-resize' },
  { key: 'se', edges: { s: true, e: true }, className: '-bottom-1 -right-1 size-4 cursor-nwse-resize' },
];

/**
 * The edges and corners of a popup: dragging one resizes it, the opposite
 * sides staying put. A frame of its own above the popup's content (which is
 * painted over its chassis), so the handles stay reachable. `box` turns the
 * pointer's pixels into the fractions the model stores.
 */
function FloatResizeFrame({
  rect,
  at,
  zIndex,
  shift,
  box,
  onResize,
}: {
  /** The popup's place in the model (fractions). */
  rect: Rect;
  /** The same, on screen (pixels of the workspace). */
  at: Rect;
  zIndex: number | undefined;
  /** Follows the popup carried past the workspace's edge. */
  shift: CSSProperties;
  box: Box;
  onResize: (next: Rect, persist: boolean) => void;
}): ReactElement {
  const start = useRef<{ x: number; y: number; rect: Rect; edges: FloatEdges } | null>(null);
  const move = (e: ReactPointerEvent<HTMLDivElement>, persist: boolean) => {
    const from = start.current;
    if (!from || box.width <= 0 || box.height <= 0) return;
    onResize(resizeFloatRect(from.rect, from.edges, (e.clientX - from.x) / box.width, (e.clientY - from.y) / box.height), persist);
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>, persist: boolean) => {
    if (!start.current) return;
    move(e, persist);
    start.current = null;
    setIslandWindowMoving(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return (
    <div data-island-float-resize="" className="pointer-events-none absolute" style={{ ...rectStyle(at), zIndex, ...shift }}>
      {FLOAT_RESIZE_HANDLES.map(({ key, edges, className }) => (
        <div
          key={key}
          data-island-float-resize-handle={key}
          aria-hidden
          title={t('islands.resize')}
          className={cn('pointer-events-auto absolute touch-none', className)}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            start.current = { x: e.clientX, y: e.clientY, rect, edges };
            // The native browser view, above the DOM, would swallow the pointer on its way.
            setIslandWindowMoving(true);
          }}
          onPointerMove={(e) => move(e, false)}
          onPointerUp={(e) => end(e, true)}
          onPointerCancel={(e) => end(e, true)}
        />
      ))}
    </div>
  );
}

/**
 * What says, at the left of a tab, which kind of island it is: the type's own
 * drawing (`tabIcon` — an agent's chat wears its avatar — or `icon`), the
 * page's, or a generic window for a type that declares none.
 */
function TabGlyph({ tab, types, routeAgent }: { tab: IslandTab; types: ReadonlyMap<string, IslandContentType>; routeAgent?: string }): ReactElement | null {
  const cls = 'size-4 shrink-0 text-muted-foreground';
  // The page's island is told by what it cannot do (no close, no fold), not by a picto;
  // only an agent's chat page wears that agent's avatar.
  if (tab.content.type === HOST_ROUTE) return routeAgent ? <ChatTabIcon params={{ agent: routeAgent }} className={cls} /> : null;
  const options = types.get(tab.content.type)?.options;
  if (options?.tabIcon) {
    const Icon = options.tabIcon;
    return <Icon params={tab.content.params} className={cls} />;
  }
  if (options?.icon) return <Picto icon={options.icon} className={cls} />;
  return <AppWindow aria-hidden className={cls} />;
}

function CloseTabButton({ title, onClick, tabIndex }: { title: string; onClick: () => void; tabIndex?: number }): ReactElement {
  return (
    <button
      type="button"
      aria-label={t('islands.closeTab', { title })}
      title={t('islands.closeTab', { title })}
      onClick={onClick}
      tabIndex={tabIndex}
      className="shrink-0 rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
    >
      <X className="size-3" />
    </button>
  );
}

/**
 * french-ok: §12 is quoted by its heading in the French maintainers' note.
 * The narrow (or too small) rendering's header: every tab of every island in
 * one row. It keeps the gestures of an island's header that still mean
 * something when only one content shows (§12, "Un seul en-tête") — close,
 * Detach, the tab menu (right click, Menu key, the arrow of the shown tab) and
 * dragging a tab to reorder it, with its keyboard twin in the menu. A tab only
 * moves within its own island: the shape of the tree is the desktop's and is
 * never rewritten from here (§10). There is no drop layer: no island is
 * painted to split or to float over. Below 768 px nothing is draggable (§10).
 */
function StackPicker({
  tabs,
  shown,
  titleOf,
  detachOf,
  onActivate,
  onClose,
  onKeyActivate,
  onKeyClose,
  onReorder,
  islandOf,
  canDrag,
}: {
  tabs: readonly IslandTab[];
  shown: TabId;
  titleOf: (tab: IslandTab) => string;
  /** The "Detach" of a tab's content type, if it has one: stacked, no header offers it otherwise. */
  detachOf: (tab: IslandTab) => ((params: IslandTab['content']['params']) => void) | undefined;
  onActivate: (tabId: TabId) => void;
  onClose: (tabId: TabId, before?: () => void) => void;
  onKeyActivate: (tabId: TabId) => void;
  onKeyClose: (tabId: TabId) => void;
  /** Puts `tabId` before (or after) `target`, a tab of the same island. */
  onReorder: (tabId: TabId, target: TabId, after?: boolean) => void;
  islandOf: (tabId: TabId) => string | undefined;
  /** Too small but wide: a pointer that drags. Narrow: a touch screen, nothing is draggable (§10). */
  canDrag: boolean;
}): ReactElement {
  const [menuTabId, setMenuTabId] = useState<TabId | null>(null);
  const [dragged, setDragged] = useState<TabId | null>(null);
  const [over, setOver] = useState<TabId | null>(null);
  const menuTab = tabs.find((tab) => tab.id === menuTabId) ?? null;
  const step = (tab: IslandTab, delta: -1 | 1): (() => void) | undefined => {
    const neighbour = tabs[tabs.findIndex((x) => x.id === tab.id) + delta];
    return neighbour && islandOf(neighbour.id) === islandOf(tab.id) ? () => onReorder(tab.id, neighbour.id, delta > 0) : undefined;
  };
  const accepts = (tabId: TabId): boolean => dragged !== null && dragged !== tabId && islandOf(dragged) === islandOf(tabId);
  const menuDetach = menuTab ? detachOf(menuTab) : undefined;
  const earlier = menuTab ? step(menuTab, -1) : undefined;
  const later = menuTab ? step(menuTab, 1) : undefined;
  return (
    <div
      role="tablist"
      aria-label={t('islands.tabs')}
      className="flex shrink-0 items-center gap-1 overflow-x-auto px-2"
      style={{ height: PICKER_PX }}
      onKeyDown={(e) => tabBarKeyDown(e, tabs, onKeyActivate, onKeyClose, setMenuTabId)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === shown;
        const detach = selected ? detachOf(tab) : undefined;
        return (
          <div
            key={tab.id}
            data-island-tab-handle={tab.id}
            data-stack-drop={over === tab.id && accepts(tab.id) ? '' : undefined}
            draggable={canDrag || undefined}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', titleOf(tab));
              setDragged(tab.id);
            }}
            onDragEnd={() => { setDragged(null); setOver(null); }}
            onDragOver={(e) => {
              if (!accepts(tab.id)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (over !== tab.id) setOver(tab.id);
            }}
            onDragLeave={() => { if (over === tab.id) setOver(null); }}
            onDrop={(e) => {
              if (!dragged || !accepts(tab.id)) return;
              e.preventDefault();
              onReorder(dragged, tab.id);
              setDragged(null);
              setOver(null);
            }}
            onContextMenu={(e) => { e.preventDefault(); setMenuTabId(tab.id); }}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full pl-3 pr-1 text-xs',
              selected ? 'bg-card text-foreground shadow-sm' : 'bg-muted/60 text-muted-foreground',
              // Where the dragged tab lands: before this one.
              over === tab.id && accepts(tab.id) && 'ring-2 ring-primary',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onActivate(tab.id)}
              className="max-w-40 truncate rounded-full py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {titleOf(tab)}
            </button>
            {detach && (
              <button
                type="button"
                aria-label={t('islands.detach')}
                title={t('islands.detach')}
                tabIndex={-1}
                onClick={() => { onClose(tab.id, () => detach(tab.content.params)); }}
                className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </button>
            )}
            {selected && (
              <button
                type="button"
                data-stack-menu=""
                aria-label={t('islands.menu')}
                title={t('islands.menu')}
                tabIndex={-1}
                onClick={() => setMenuTabId(tab.id)}
                className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronDown className="size-3.5" />
              </button>
            )}
            {tab.content.type !== HOST_ROUTE && <CloseTabButton title={titleOf(tab)} onClick={() => onClose(tab.id)} tabIndex={-1} />}
          </div>
        );
      })}
      {/* One menu for the row, anchored to nothing visible: opened by the arrow, a right click or the Menu key. */}
      <DropdownMenu modal={false} open={menuTab !== null} onOpenChange={(open) => { if (!open) setMenuTabId(null); }}>
        <DropdownMenuTrigger aria-hidden tabIndex={-1} className="pointer-events-none size-0 shrink-0 opacity-0" />
        {menuTab && (
          <DropdownMenuContent align="end">
            {earlier && (
              <DropdownMenuItem data-stack-menu-item="earlier" onSelect={earlier}>
                <ChevronLeft className="size-4" aria-hidden />
                {t('islands.stack.earlier', { title: titleOf(menuTab) })}
              </DropdownMenuItem>
            )}
            {later && (
              <DropdownMenuItem data-stack-menu-item="later" onSelect={later}>
                <ChevronRight className="size-4" aria-hidden />
                {t('islands.stack.later', { title: titleOf(menuTab) })}
              </DropdownMenuItem>
            )}
            {menuDetach && (
              <DropdownMenuItem data-stack-menu-item="detach" onSelect={() => onClose(menuTab.id, () => menuDetach(menuTab.content.params))}>
                <ExternalLink className="size-4" aria-hidden />
                {t('islands.detach')}
              </DropdownMenuItem>
            )}
            {menuTab.content.type !== HOST_ROUTE && (
              <DropdownMenuItem data-stack-menu-item="close" onSelect={() => onClose(menuTab.id)}>
                <X className="size-4" aria-hidden />
                {t('islands.closeTab', { title: titleOf(menuTab) })}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        )}
      </DropdownMenu>
    </div>
  );
}

/** Keyboard steps of a gutter, as fractions of the split (§11). */
const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;

/**
 * The gap between two siblings, and the handle that moves their boundary.
 * Nothing at rest, a primary line
 * and a centred grip under the pointer or while dragging — never a permanent
 * line (rule 16).
 */
function IslandGutter({
  gutter,
  split,
  gap,
  minOf,
  apply,
}: {
  gutter: GutterRect;
  split: IslandSplit;
  gap: number;
  minOf: (leaf: IslandLeaf) => MinSize;
  apply: (op: (tree: IslandTree) => IslandResult, persist?: boolean, force?: boolean) => IslandResult;
}): ReactElement {
  const row = gutter.dir === 'row';
  // The split's shares at pointer-down: every move resizes from them, so deltas
  // do not accumulate rounding, and the release replays from them too.
  const drag = useRef<{ start: number; ratios: readonly number[]; free: number; mins: number[]; delta: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const mins = () => minFractions(split, gutter.size, gap, minOf);
  const free = Math.max(1, gutter.size - gap * (split.children.length - 1));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { start: row ? e.clientX : e.clientY, ratios: split.ratios, free, mins: mins(), delta: null };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = ((row ? e.clientX : e.clientY) - d.start) / d.free;
    const { ratios, mins: m } = d;
    if (!apply((tree) => resizeAt(setSplitRatios(tree, split.id, ratios), split.id, gutter.index, delta, m), false).refused) d.delta = delta;
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    // One write per gesture, at release.
    if (d && d.delta !== null) {
      const { ratios, mins: m, delta } = d;
      apply((tree) => resizeAt(setSplitRatios(tree, split.id, ratios), split.id, gutter.index, delta, m), true, true);
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const back = row ? 'ArrowLeft' : 'ArrowUp';
    const forth = row ? 'ArrowRight' : 'ArrowDown';
    let delta: number | null = null;
    if (e.key === back) delta = -step;
    else if (e.key === forth) delta = step;
    else if (e.key === 'Home') delta = -1;
    else if (e.key === 'End') delta = 1;
    if (delta === null) return;
    e.preventDefault();
    const m = mins();
    apply((tree) => resizeAt(tree, split.id, gutter.index, delta, m));
  };
  const percent = Math.round((split.ratios[gutter.index] ?? 0) * 100);
  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={t('islands.resize')}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => apply((tree) => equalizeAt(tree, split.id, gutter.index))}
      onKeyDown={onKeyDown}
      className={cn('group absolute z-10 touch-none outline-none', row ? 'cursor-col-resize' : 'cursor-row-resize')}
      style={rectStyle(gutter.rect)}
    >
      <span
        aria-hidden
        className={cn(
          'absolute rounded-full bg-primary/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
          row ? 'inset-y-0 left-1/2 w-0.5 -translate-x-1/2' : 'inset-x-0 top-1/2 h-0.5 -translate-y-1/2',
          dragging && 'opacity-100',
        )}
      />
      <span
        aria-hidden
        className={cn(
          'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
          row ? 'h-10 w-1.5' : 'h-1.5 w-10',
          dragging && 'opacity-100',
        )}
      />
    </div>
  );
}

/** Lives with the preset rule (`lib/island-presets.ts`), which a lib must reach without this component. */
export { ISLANDS_SUFFIX };

/**
 * The workspace of the view on screen, stored per account, view and project
 * under `<workspaceKey>.islands`. The default tree is never stored: going back
 * to it hands `null` to `useStoredLayout`, which erases the row (a `DELETE`) —
 * the daemon refuses to store `null` itself.
 */
export function IslandWorkspace(props: Omit<IslandWorkspaceViewProps, 'tree' | 'onTree' | 'announce' | 'routeTitle' | 'viewKey'>): ReactElement {
  const { key, owner, previousKey, previousOwner } = useWorkspaceLayout();
  const pathname = usePathname();
  // What an agent's `islands_get` lists, and its `islands_propose` is checked against.
  usePublishIslandSnapshot(owner, useIslandContentTypes());
  const { raw, update, ready } = useStoredLayout(
    key ? `${key}.${ISLANDS_SUFFIX}` : null,
    workspaceRowHandover(previousKey, ISLANDS_SUFFIX),
  );
  // The popups the user keeps everywhere: one row for the account, read by
  // every view, merged into the view's tree and split back before writing.
  const [pinnedScope, setPinnedScope] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!owner) { setPinnedScope(null); return; }
    void sharedPinnedIslandsScope(owner).then((scope) => { if (alive) setPinnedScope(scope); });
    return () => { alive = false; };
  }, [owner]);
  const previousPinned = usePreviousScope(previousOwner, sharedPinnedIslandsScope);
  const { raw: pinnedRaw, update: pinnedUpdate } = useStoredLayout(
    previousPinned === undefined ? null : pinnedScope,
    rowHandover(previousPinned),
  );
  const ambient = useMemo(() => readAmbient(pinnedRaw), [pinnedRaw]);
  // Memoised on the stored value: a fresh default tree on every render would
  // be a fresh one for every gesture to start from.
  const view = useMemo(() => readIslandTree(raw), [raw]);
  const tree = useMemo(() => mergeAmbient(view, ambient), [view, ambient]);
  const ambientRef = useRef(ambient);
  ambientRef.current = ambient;
  const viewRef = useRef(view);
  viewRef.current = view;
  // No row is the default tree, whose ids are drawn at each read: a replay on
  // an empty row starts from the one on screen, which the gestures name.
  const defaultView = useRef<IslandTree | null>(null);
  if (raw === null) defaultView.current = view;
  /**
   * Each row gets the gesture's result the first time — the tree on screen it
   * was computed from — and the gesture itself afterwards: replayed on a row
   * another window rewrote (TODO #647), on the merged tree that row makes
   * with the other one as this window holds it now. A gesture that no longer
   * applies there leaves the row as it is.
   */
  const onTree = useCallback((next: IslandTree, persist: boolean, replay: (tree: IslandTree) => IslandTree | null) => {
    const split = splitAmbient(next);
    // A lone page whose island chose its glass keeps its row: nothing is
    // painted around it, but the choice outlives the other islands.
    const viewRow = (view: IslandTree) => (isDefaultIslandTree(view) && !(view.root.kind === 'leaf' && view.root.glassScope) ? null : view);
    const ambientRow = (pinned: AmbientIslands) => (pinned.floats.length > 0 ? pinned : null);
    let firstView = true;
    void update((stored) => {
      if (firstView) { firstView = false; return viewRow(split.view); }
      const tree = replay(mergeAmbient(stored === null && defaultView.current ? defaultView.current : readIslandTree(stored), ambientRef.current));
      return tree ? viewRow(splitAmbient(tree).view) : stored;
    }, persist);
    if (JSON.stringify(split.ambient) !== JSON.stringify(ambientRef.current)) {
      let firstPinned = true;
      void pinnedUpdate((stored) => {
        if (firstPinned) { firstPinned = false; return ambientRow(split.ambient); }
        const tree = replay(mergeAmbient(viewRef.current, readAmbient(stored)));
        return tree ? ambientRow(splitAmbient(tree).ambient) : stored;
      }, persist);
    }
  }, [update, pinnedUpdate]);
  const search = useSearchParams();
  const labelKey = pathname ? navLabelKeyOf(pathname) : null;
  // `/chat?agent=…` is that agent's chat: its tab says who, not "Page". In a
  // split, the page's panel may keep another agent's conversation: the tab
  // names the agent it shows, as the panel reads it (TIM-0140).
  const routeAgent = pathname === '/chat' && search
    ? (routeChatOfUrl(tree, search)?.agent ?? search.get('agent')) || undefined
    : undefined;
  // `/islands/<id>` is a named arrangement's page: its tab carries that name.
  const arrangementName = useArrangementName(arrangementIdOf(pathname));
  const routeTitle = routeAgent ?? arrangementName ?? (labelKey ? t(labelKey) : pathname === '/chat' ? t('islands.chat.title') : undefined);
  return (
    <IslandWorkspaceView
      {...props}
      tree={tree}
      onTree={onTree}
      announce={ready}
      routeTitle={routeTitle}
      routeAgent={routeAgent}
      viewKey={key}
    />
  );
}
