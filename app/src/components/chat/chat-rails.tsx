'use client';

import dynamic from 'next/dynamic';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useDroppable } from '@dnd-kit/core';

import { cn } from '@/lib/utils';
import { isWidgetSurfaceAllowed, isZoneVisible, useCapabilities, type Capabilities } from '@/lib/capabilities';
import { t as i18n } from '@/lib/i18n';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { workspaceRowHandover } from '@/lib/workspace-route';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { WidgetZone } from '@/components/widget-host/widget-zone';
import { GlassClear } from '@/components/glass-scope';
import { useAfterConversation } from '@/lib/load-priority';
import { useWidgetHost } from '@/components/widget-host/widget-host';
import { declareSlot, register, slotKind, type WidgetOptions } from '@/lib/plugin-host/slots';
import { zoneDropId } from '@/components/widget-host/widget-dnd';
import { pluginPlacementId } from '@/components/widget-host/widget-catalog';
import {
  addTab,
  addSecond,
  setCollapsed,
  detachSecond,
  selectTab,
  isCollapsed,
  swapColumns,
  widthOf,
  readColumns,
  activeTab,
  tabsOf,
  planRails,
  setWidth,
  setThreadWidth,
  removeTab,
  secondOf,
  zoneOfSide,
  WIDTH_MAX,
  WIDTH_MIN,
  THREAD_READING_MIN,
  pairedWidths,
  SECOND_COLUMN_WIDTH,
  showsDrawers,
  type ChatColumns,
  type ColumnSide,
  type SideRequest,
  type SidePlacement,
} from './chat-columns';
import { MissionRail } from './mission-rail';
import { MissionCard } from './mission-card';
import { SkillsCard } from './skills-card';
import { McpCard } from './mcp-card';
import { AgentTodosCard } from './agent-todos-card';
import type { Agent, AgentTodo, McpItem, MissionSummary, SkillItem } from './chat-types';
import type { Delegation } from '@/hooks/use-delegations';
import type { BackendName } from '@/lib/backends';
import type { NewMissionOptions } from './new-mission-menu';
import { widgetPicto } from '@/plugins-client/widget-pictos';
import { FileContextMenu } from './file-context-menu';
import { columnMenuItems, useMenuPress, type ColumnCommands } from './chat-column-menu';

// The rail cards come after the conversation (`useAfterConversation`): their
// code too, fetched when a card first paints (docs/BUNDLE-SIZE.md).
const VideoFactoryPanel = dynamic(() => import('@/components/video-factory-panel').then((m) => m.VideoFactoryPanel), { ssr: false });
const DockerMissionPanel = dynamic(() => import('@/components/docker-mission-panel').then((m) => m.DockerMissionPanel), { ssr: false });
const OrchestratorSelfPanel = dynamic(() => import('@/components/orchestrator-self-panel').then((m) => m.OrchestratorSelfPanel), { ssr: false });
const FileBrowser = dynamic(() => import('./file-browser').then((m) => m.FileBrowser), { ssr: false });
const GitBranchesPanel = dynamic(() => import('@/plugins-client/git/git-panel').then((m) => m.GitBranchesPanel), { ssr: false });
const GitGraphPanel = dynamic(() => import('@/plugins-client/git/git-panel').then((m) => m.GitGraphPanel), { ssr: false });
const GitPublishPanel = dynamic(() => import('@/plugins-client/git/git-panel').then((m) => m.GitPublishPanel), { ssr: false });
const ChatTraceWidget = dynamic(() => import('@/plugins-client/workflows/chat-trace-widget').then((m) => m.ChatTraceWidget), { ssr: false });

/**
 * The two chat columns, as widget zones (§10.12).
 *
 * The left rail was a tabbed `<aside>`: a single container, three panels you
 * could neither move, remove nor restore. Missions, Files and Git now stack
 * like the cockpit tiles, in the SAME host (`WidgetHost`, mounted by the root
 * layout), hence with the same handle, the same cross, the same palette, and a
 * persisted placement. Nothing is copied here: no drag context, no card, no
 * palette.
 *
 * Both zones carry the name of their slot, like `sidebar.left.widget`: the
 * slot → zone table is the identity, and the cockpit stays the only exception
 * (its two rails share a slot). The `.widget` suffix is what opens them to any
 * widget, from the product or from a third party (`slot-compat.ts`).
 */

export const CHAT_LEFT_ZONE = 'chat.left.widget';
export const CHAT_RIGHT_ZONE = 'chat.right.widget';

/** The chat columns, in their original order. */
export const COLUMNS: readonly string[] = [CHAT_LEFT_ZONE, CHAT_RIGHT_ZONE];

/** Key of the left rail collapse before the column order was persisted. */


/**
 * The chat state the three panels need.
 *
 * A widget registers without props (`ctx.slots.register`): the host mounts it
 * and passes it nothing. What the rail received as props thus goes through a
 * context, provided by the chat page and read by each panel. A panel dragged
 * out of the chat (into the cockpit rail, for instance) finds nothing and
 * paints nothing: it has no mission to show.
 */
export type ChatRailValue = {
  agentId: string;
  agent: Agent;
  /**
   * Project the tooling panels talk about (index, containers, git
   * remote…). Derived as it was in the mission sheet: the agent's project,
   * otherwise the prefix of a `<project>.<role>` name.
   */
  slug: string | null;
  agentRole?: string | null;
  projectColor?: string | null;
  projectIcon?: string | null;
  missions: MissionSummary[];
  /**
   * The child missions of the conversation whose return has not come back
   * yet. The page reads them ONCE (`useDelegations`) and passes them down
   * here: the rail card and the thread banner show the same list, without two
   * concurrent reads.
   */
  delegations: Delegation[];
  currentMissionId: string | null;
  thinking?: boolean;
  onPick: (id: string, permId?: string | null) => void;
  onNew: () => void;
  /** The project's agents a New button offers (TODO #344); absent = one click. */
  newMission?: NewMissionOptions | null;
  onKill?: (id: string) => Promise<void>;
};

/**
 * What the mission sheet reads, and the other cards do not have to follow.
 *
 * Separate from `ChatRailValue` because it changes at every stream event
 * (cost, tokens): in a single context, each token received would also
 * re-render the missions list. The sheet was memoised for the same reason
 * before it became a card.
 */
export type ChatInfoValue = {
  currentSessionId: string | null;
  stats: { tok: number; cost: number };
  /** Effective backend and model of the next turn, as the composer shows them. */
  backend: BackendName;
  model: string;
  agentTodos: AgentTodo[];
  allSkills: SkillItem[];
  onToggleSkill: (id: string) => void;
  allMcp: McpItem[];
  onToggleMcp: (id: string) => void;
};

const ChatRailContext = createContext<ChatRailValue | null>(null);
const ChatInfoContext = createContext<ChatInfoValue | null>(null);

/** What a rail card of another module reads: the chat it is mounted in, or
 *  `null` outside a chat (the card then paints nothing). */
export function useChatRail(): ChatRailValue | null {
  return useContext(ChatRailContext);
}

export function ChatRailProvider({
  value,
  info,
  children,
}: {
  /** `null`: no chat to describe yet (`ChatChrome`, before its conversation mounts). */
  value: ChatRailValue | null;
  info: ChatInfoValue | null;
  children: ReactNode;
}) {
  return (
    <ChatRailContext.Provider value={value}>
      <ChatInfoContext.Provider value={info}>{children}</ChatInfoContext.Provider>
    </ChatRailContext.Provider>
  );
}

function MissionsWidget() {
  const chat = useContext(ChatRailContext);
  if (!chat) return null;
  return (
    <MissionRail
      agentId={chat.agentId}
      missions={chat.missions}
      currentMissionId={chat.currentMissionId}
      thinking={chat.thinking}
      onPick={chat.onPick}
      onNew={chat.onNew}
      newMission={chat.newMission}
      onKill={chat.onKill}
    />
  );
}

// The panels below read the daemon on mount (git, docker, files…): they
// wait for the conversation, which would otherwise queue behind them
// (`lib/load-priority.ts`). The ones fed by the chat's own state don't.
function FilesWidget() {
  const chat = useContext(ChatRailContext);
  const later = useAfterConversation();
  if (!chat || !later) return null;
  return <FileBrowser agentId={chat.agentId} />;
}

/** Video production in progress: the client half of `video-factory`. */
function VideoFactoryWidget() {
  const chat = useContext(ChatRailContext);
  const later = useAfterConversation();
  if (!chat || !later) return null;
  return <VideoFactoryPanel slug={chat.slug} />;
}

/** Project containers: the client half of `docker-supervision`. */
function DockerWidget() {
  const chat = useContext(ChatRailContext);
  const later = useAfterConversation();
  if (!chat || !later) return null;
  return <DockerMissionPanel slug={chat.slug} />;
}

/** Daemon self-supervision: the client half of `orchestrator-self`. */
function OrchestratorSelfWidget() {
  const chat = useContext(ChatRailContext);
  const later = useAfterConversation();
  if (!chat || !later) return null;
  return <OrchestratorSelfPanel slug={chat.slug} />;
}

/** The current mission's sheet: the client half of `@timon/missions`. */
function MissionCardWidget() {
  const chat = useContext(ChatRailContext);
  const info = useContext(ChatInfoContext);
  if (!chat || !info) return null;
  return (
    <MissionCard
      agent={chat.agent}
      agentId={chat.agentId}
      missions={chat.missions}
      currentMissionId={chat.currentMissionId}
      currentSessionId={info.currentSessionId}
      stats={info.stats}
      backend={info.backend}
      model={info.model}
      onNew={chat.onNew}
      newMission={chat.newMission}
    />
  );
}

/** The agent's skills: the client half of `@timon/agents`. */
function SkillsWidget() {
  const chat = useContext(ChatRailContext);
  const info = useContext(ChatInfoContext);
  if (!chat || !info) return null;
  return (
    <SkillsCard agent={chat.agent} allSkills={info.allSkills} onToggleSkill={info.onToggleSkill} />
  );
}

/** The agent's MCP servers: the client half of `@timon/agents`. */
function McpWidget() {
  const chat = useContext(ChatRailContext);
  const info = useContext(ChatInfoContext);
  if (!chat || !info) return null;
  return <McpCard agent={chat.agent} allMcp={info.allMcp} onToggleMcp={info.onToggleMcp} />;
}

/** The agent's todo list: the client half of `@timon/missions` (it is
 *  rebuilt from the event stream of the current mission). */
function AgentTodosWidget() {
  const info = useContext(ChatInfoContext);
  if (!info) return null;
  return <AgentTodosCard agentTodos={info.agentTodos} />;
}

/** The client half of `@timon/git`: one widget per view of the project's
 *  repository, each read only once the conversation is on screen. */
function gitWidget(Panel: typeof GitBranchesPanel) {
  return function GitWidget() {
    const chat = useContext(ChatRailContext);
    const later = useAfterConversation();
    if (!chat || !later) return null;
    return <Panel agentId={chat.agentId} slug={chat.slug} />;
  };
}

const GitBranchesWidget = gitWidget(GitBranchesPanel);
const GitGraphWidget = gitWidget(GitGraphPanel);
const GitPublishWidget = gitWidget(GitPublishPanel);

/**
 * Ids the single Git card was stored under, newest first. Each of the three
 * widgets split out of it claims them all: together they take over its place
 * as one stack (`widget-defaults.ts`), and a link to the card leads to
 * Branches, the first claimant.
 */
const FORMER_GIT_CARD = [
  'plugin:@timon/git:repository',
  'plugin:@timon/git:git-remote',
  'plugin:@timon/git:Git',
  'plugin:@timon/kanban-code:git-remote',
  'plugin:@timon/kanban-code:Git',
];

/**
 * The chat panels, registered in the slot registry while the chat is on
 * screen.
 *
 * The chat zones only exist on this page: `ui-layout` does not declare them
 * (the chat is outside its tree), so the page declares and collapses them
 * itself. The declaration comes before the registrations and outlives them for
 * the time of the unmount: `collapseSlot` disposes of what occupies it.
 *
 * The ids are those of the modules these panels are the client half of
 * (§10.12): a card's persisted place is `plugin:<module>:<key>`, and it will
 * not move once these widgets really come from the module.
 */
type Registration = {
  zone: string;
  pluginId: string;
  key: string;
  /** What the card says about itself to the host: title, heights (U.3). */
  widget?: WidgetOptions;
  Component: () => ReactNode;
  /**
   * UI zone the panel depends on (`chat.panel.*`). Absent = the widget is
   * always registered. Present and hidden (module off or `ui.hidden`): the
   * widget is NOT registered. It is an install filter, not a removal by the
   * user (which can be restored from the palette).
   */
  uiZone?: string;
};

/** A catalogue entry's name and sentence, read when the widget is registered and
 *  not when this module loads: the locale is not known before that. */
function card(key: string, options: WidgetOptions = {}): WidgetOptions {
  return {
    ...options,
    icon: widgetPicto(key),
    get title() { return i18n(`widgetCatalog.${key}.title`); },
    get description() { return i18n(`widgetCatalog.${key}.description`); },
  };
}

/**
 * Visual order, not writing order: `defaultRank` follows the order of this
 * array (see `buildWidgetCatalog`), so a card added here lands where the block
 * it replaces stood in the mission sheet.
 */
const REGISTRATIONS: Registration[] = [
  { zone: CHAT_LEFT_ZONE, pluginId: '@timon/missions', key: 'Missions', widget: card('missionsList'), Component: MissionsWidget },
  // Its own plugin (TODO #356), reading the agent's folder from the core
  // `@timon/agents` (`/api/agents/:name/files`), which it depends on: the
  // zone follows `@timon/files-widget`, off whenever that route is.
  // `formerIds` keeps the place a user gave the card under `kanban-code`
  // (TODO #311) then `agents`.
  {
    zone: CHAT_LEFT_ZONE,
    pluginId: '@timon/files-widget',
    key: 'Files',
    widget: card('files', { formerIds: ['plugin:@timon/kanban-code:Files', 'plugin:@timon/agents:Files'] }),
    Component: FilesWidget,
    uiZone: 'chat.panel.files',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/missions',
    key: 'agent-todos',
    widget: card('agentTasks', { height: 200, minHeight: 110 }),
    Component: AgentTodosWidget,
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/video-factory',
    key: 'video',
    widget: card('videoFactory', { height: 240, minHeight: 130 }),
    Component: VideoFactoryWidget,
    uiZone: 'chat.panel.video-factory',
  },
  // Three widgets since the "Git" stack, split out of the single card of
  // TODO #278 and stacked with the pull requests and jobs by default
  // (`widget-defaults.ts`). Publish alone follows `chat.panel.git-remote`: the
  // `lite` preset hides it and keeps the branches and the graph.
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/git',
    key: 'branches',
    widget: card('gitBranches', { height: 320, minHeight: 180, formerIds: FORMER_GIT_CARD }),
    Component: GitBranchesWidget,
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/git',
    key: 'graph',
    widget: card('gitGraph', { height: 320, minHeight: 180, formerIds: FORMER_GIT_CARD }),
    Component: GitGraphWidget,
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/git',
    key: 'publish',
    widget: card('gitPublish', { height: 320, minHeight: 180, formerIds: FORMER_GIT_CARD }),
    Component: GitPublishWidget,
    uiZone: 'chat.panel.git-remote',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/docker-supervision',
    key: 'docker',
    widget: card('docker', { height: 260, minHeight: 140 }),
    Component: DockerWidget,
    uiZone: 'chat.panel.docker',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/orchestrator-self',
    key: 'orchestrator',
    widget: card('timonDaemon', { height: 240, minHeight: 130 }),
    Component: OrchestratorSelfWidget,
    uiZone: 'chat.panel.orchestrator-self',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/missions',
    key: 'mission',
    widget: card('missionDetails', { height: 260, minHeight: 150 }),
    Component: MissionCardWidget,
  },
  // Their own plugins (TODO #357), like Files: the skills and MCP routes stay
  // in the core `@timon/agents`, which both depend on. `formerIds` keeps the
  // place a user gave each card under `agents`.
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/skills-widget',
    key: 'skills',
    widget: card('agentSkills', { height: 260, minHeight: 140, formerIds: ['plugin:@timon/agents:skills'] }),
    Component: SkillsWidget,
    uiZone: 'chat.panel.skills',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/mcp-widget',
    key: 'mcp',
    widget: card('mcpServers', { height: 220, minHeight: 120, formerIds: ['plugin:@timon/agents:mcp'] }),
    Component: McpWidget,
    uiZone: 'chat.panel.mcp',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/workflows',
    key: 'trace',
    widget: card('trace', { height: 300, minHeight: 160 }),
    Component: () => <ChatTraceWidget />,
  },
];

/**
 * Exported for its test: which cards register, for these capabilities. Each is
 * behind the `widget:<module>` grant of its plugin (TODO #356, #357, #645). The
 * daemon checks its routes on its own: this only decides what is painted.
 */
export function visibleRegistrations(caps: Capabilities | null): Registration[] {
  return REGISTRATIONS.filter((i) =>
    (!i.uiZone || isZoneVisible(caps, i.uiZone))
    && isWidgetSurfaceAllowed(caps, i.pluginId, i.key));
}

/** The missions card's placement id: the narrow chat checks it is in a column. */
export const MISSIONS_WIDGET_ID = pluginPlacementId('@timon/missions', 'Missions');

/** Exported for its test: the narrow chat's way back obeys the same grant as the card. */
export function chatMissionsAllowed(caps: Capabilities | null): boolean {
  return isWidgetSurfaceAllowed(caps, '@timon/missions', 'Missions');
}

export function useChatMissionsAllowed(): boolean {
  return chatMissionsAllowed(useCapabilities());
}

/**
 * The missions list on its own, outside any zone: the narrow chat's way back to
 * it when the user took the card out of both columns. Not a `WidgetZone` — the
 * card is placed elsewhere, or nowhere, and a zone mounted twice breaks dnd-kit.
 */
export function ChatMissionsList() {
  return <MissionsWidget />;
}

/**
 * A panel of the chat's island: what a column becomes when the chat is too
 * narrow for it to float beside the thread.
 *
 * Rounded, inset by the island gap, below the topbar and clear of the nav —
 * the page places it inside the island's own box. It stays mounted closed,
 * slid out by its edge: its zone must stay declared to the host, or the cards
 * of a closed column would show up in the palette as cards without a zone.
 * Escape and a swipe towards its edge close it; a tap outside is the page's
 * (the scrim belongs to whatever is under the panel).
 */
export function DrawerPanel({
  id,
  side,
  label,
  open,
  onClose,
  width,
  swipe = true,
  className,
  children,
}: {
  id: string;
  side: ColumnSide;
  label: string;
  open: boolean;
  onClose: () => void;
  /** Preferred width in px; the screen caps it. */
  width: number;
  /** Off while a card is dragged or the layout edited: those gestures move too. */
  swipe?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const start = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Out by its own edge, past the island gap and, on the left, the nav: the
  // island clips it, and no sliver is left over the thread.
  const offscreen = side === 'left'
    ? 'translateX(calc(-100% - var(--timon-nav-w, 0px) - 2 * var(--timon-island-gap)))'
    : 'translateX(calc(100% + 2 * var(--timon-island-gap)))';
  return (
    <div
      id={id}
      role="region"
      aria-label={label}
      aria-hidden={!open || undefined}
      data-open={open || undefined}
      // Scrolling inside the drawer is not scrolling the page: the top bar stays put.
      data-header-scroll="ignore"
      style={{
        // A strip of the thread stays visible beside it: that is where a tap
        // closes it.
        width: `min(${width}px, calc(100% - var(--timon-nav-w, 0px) - 2 * var(--timon-island-gap) - 48px))`,
        ...(side === 'left'
          ? { left: 'calc(var(--timon-nav-w, 0px) + var(--timon-island-gap))' }
          : {}),
        ...(open ? {} : { transform: offscreen, visibility: 'hidden', transitionDelay: '0s, 200ms' }),
      }}
      className={cn(
        'chat-widget-drawer timon-island absolute top-[var(--timon-island-gap)] bottom-[var(--timon-island-gap)] z-30 flex min-h-0 flex-col gap-2 p-2 shadow-elev-2',
        // Inside the island where it is painted (md+), on the page below.
        'md:bottom-[calc(2*var(--timon-island-gap))]',
        side === 'right' && 'right-[var(--timon-island-gap)] md:right-[calc(2*var(--timon-island-gap))]',
        // Vertical panning stays the browser's; a horizontal move is ours.
        'touch-pan-y transition-[transform,visibility] duration-200 ease-out motion-reduce:transition-none',
        !open && 'pointer-events-none',
        className,
      )}
      onPointerDown={(e) => {
        // A swipe is a touch gesture: with a mouse, the same move selects text.
        if (!swipe || !open || e.pointerType === 'mouse') return;
        start.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        const d = start.current;
        start.current = null;
        if (!d || d.pointerId !== e.pointerId || !swipe) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        const towardsEdge = side === 'left' ? dx < 0 : dx > 0;
        if (towardsEdge && Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > 1.5 * Math.abs(dy)) onClose();
      }}
      // The browser took the gesture over (a scroll): not a swipe.
      onPointerCancel={() => { start.current = null; }}
    >
      {/* It slides over the thread, not over the wallpaper: with the glass on
          it lays its own frosted copy of the wallpaper, like an island of the
          workspace, so the thread never shows through it. The scope decides
          the rest (frosted plate, or the wallpaper left sharp). */}
      <GlassClear />
      {children}
    </div>
  );
}

/** How far, in px, a swipe must travel towards the panel's edge to close it. */
const SWIPE_THRESHOLD = 56;

export function ChatRailWidgets() {
  const caps = useCapabilities();

  useEffect(() => {
    const disposers: Array<() => void> = [];
    for (const name of [CHAT_LEFT_ZONE, CHAT_RIGHT_ZONE]) {
      // Two non-compact chats on screen would declare the same zone twice, and
      // `declareSlot` refuses: the second makes do with the first one's rather
      // than bring the page down.
      if (slotKind(name) === null) disposers.push(declareSlot(name, 'list', 'chat-rails'));
    }
    return () => { for (const d of disposers.reverse()) d(); };
  }, []);

  // An effect separate from the declaration: `collapseSlot` disposes of
  // EVERYTHING that occupies the zone, including a third-party widget we did not
  // register. Redoing the registrations when the capabilities arrive must not
  // cost that.
  useEffect(() => {
    const disposers = visibleRegistrations(caps).map((i) =>
      register(
        { slot: i.zone, pluginId: i.pluginId, key: i.key, widget: i.widget },
        i.Component,
      ),
    );
    return () => { for (const d of disposers.reverse()) d(); };
  }, [caps]);

  return null;
}

/**
 * The column order and collapse, as the daemon kept them.
 *
 * Same persistence as the card placement (`ui_layout`), on its own scope: no
 * new table, no new shape to cohabit in the cockpit JSON. Two safeguards taken
 * from `WidgetHost`, for the same reasons: no write until the read has
 * succeeded (saving the defaults over an order we failed to read would erase
 * it at the first click), and a first render on the defaults (waiting for the
 * network would leave the page without columns).
 *
 * `storage: null` turns off picking up the layout left in `localStorage`: it
 * only knows one key, the cockpit's, and would write it here as a column
 * order.
 */
export function useChatColumns(known: readonly string[] = COLUMNS): {
  columns: ChatColumns;
  swap: () => void;
  toggle: (zone: string) => void;
  addTab: (column: string) => void;
  selectTab: (column: string, zone: string) => void;
  closeTab: (column: string, zone: string) => void;
  /** `persist: false` while a drag is under way: shown, not written yet. */
  setWidth: (zone: string, width: number | null, persist?: boolean) => void;
  /** Several widths in one write: a column and its mirror on the other side. */
  setWidths: (widths: ReadonlyArray<readonly [string, number | null]>, persist?: boolean) => void;
  /** Width of the thread's reading column; `null` = follow the room. */
  setThreadWidth: (width: number | null, persist?: boolean) => void;
  addSecond: (column: string) => void;
  removeSecond: (column: string) => void;
} {
  const { onMergeZone, widgetsOf } = useWidgetHost();
  const { key, previousKey } = useWorkspaceLayout();
  const { raw: stored, update } = useStoredLayout(
    key ? `${key}.columns` : null,
    workspaceRowHandover(previousKey, 'columns', 'chat.columns'),
  );
  const columns = useMemo(() => readColumns(stored, known), [stored, known]);
  const mutate = useCallback((op: (c: ChatColumns) => ChatColumns) => {
    update((raw) => op(readColumns(raw, known)));
  }, [update, known]);

  // Swaps the sides seen: already swapped elsewhere, there is nothing left to do.
  const swap = useCallback(() => {
    const first = columns.ordre[0];
    mutate((c) => c.ordre[0] === first ? swapColumns(c) : c);
  }, [columns, mutate]);
  const width = useCallback((zone: string, value: number | null, persist = true) => {
    void update((raw) => setWidth(readColumns(raw, known), zone, value), persist);
  }, [update, known]);
  const widths = useCallback((list: ReadonlyArray<readonly [string, number | null]>, persist = true) => {
    void update((raw) => list.reduce((c, [zone, value]) => setWidth(c, zone, value), readColumns(raw, known)), persist);
  }, [update, known]);
  const thread = useCallback((value: number | null, persist = true) => {
    void update((raw) => setThreadWidth(readColumns(raw, known), value), persist);
  }, [update, known]);
  // What the click asks for is decided here, against the columns on screen:
  // an op runs again on a row another window rewrote (TODO #647), and must
  // neither toggle back nor mint another suffix there.
  const toggle = useCallback((zone: string) => {
    const collapsed = !isCollapsed(columns, zone);
    mutate((c) => setCollapsed(c, zone, collapsed));
  }, [columns, mutate]);
  // A clock-based suffix is never reused, even after a close (cf.
  // `addTab`).
  const add = useCallback((column: string) => {
    const suffix = Date.now().toString(36);
    mutate((c) => addTab(c, column, suffix));
  }, [mutate]);
  const select = useCallback(
    (column: string, zone: string) => mutate((c) => selectTab(c, column, zone)),
    [mutate],
  );
  // Cards leave before the tab does: the other way round, they would sit for a
  // moment in a zone nothing declares, hence in the palette. The first tab is
  // then shown, since that is where they went.
  const close = useCallback((column: string, zone: string) => {
    if (zone === column) return;
    onMergeZone(zone, column);
    mutate((c) => selectTab(removeTab(c, column, zone), column, column));
  }, [mutate, onMergeZone]);

  // Same never-reused suffix as a tab: a second column IS a tab.
  const second = useCallback((column: string) => {
    const suffix = Date.now().toString(36);
    mutate((c) => addSecond(c, column, suffix));
  }, [mutate]);
  // An empty second column goes away; one holding cards goes back among the
  // tabs, cards included — removing a column never throws a card out.
  const removeSecondColumn = useCallback((column: string) => {
    const zone = secondOf(columns, column);
    if (!zone) return;
    const filled = widgetsOf(zone).length > 0;
    mutate((c) => secondOf(c, column) !== zone ? c : filled ? detachSecond(c, column) : removeTab(c, column, zone));
  }, [columns, mutate, widgetsOf]);

  return {
    columns,
    swap,
    toggle,
    addTab: add,
    selectTab: select,
    closeTab: close,
    setWidth: width,
    setWidths: widths,
    setThreadWidth: thread,
    addSecond: second,
    removeSecond: removeSecondColumn,
  };
}

/** A panel's width when the user never resized its column; the screen caps it
 *  (`DrawerPanel`). */
const DRAWER_WIDTH = 340;

/** Default width of a side's column. The left one keeps the narrower width it
 *  had below `xl` (1280px), where the fixed classes used to set it. */
function defaultWidth(side: ColumnSide, available: number): number {
  return side === 'left' && available > 0 && available < 1280 ? 280 : 300;
}

/** A column as the page paints it: where, how wide, and what it shows. */
export type ShownRail = {
  /** Zone shown first — the column's, or its second column's tab. */
  zone: string;
  /** Slot whose rules govern it: always the column's. */
  slot: string;
  tabs: string[];
  active: string;
  /** Width painted, in px. */
  width: number;
  /** Widest the user can drag it right now, in px. */
  max: number;
  /** Distance from the screen edge (nav excluded), in px. */
  offset: number;
  /** The column's second column, rather than the column itself. */
  second: boolean;
  /** Names of its tabs, by zone (`ChatColumns.noms`). */
  names: Readonly<Record<string, string>>;
};

export type ShownSide = {
  side: ColumnSide;
  /** The column zone of this side. */
  column: string;
  /** Not collapsed, and has something to show (or a drag / edit is on). */
  visible: boolean;
  /** Any of its zones holds a card. */
  occupied: boolean;
  /** It has a second column, shown or folded into its tabs. */
  hasSecond: boolean;
  rails: ShownRail[];
  /** Width the thread reserves for this side, nav excluded, in px. */
  gutter: number;
};

/**
 * Lays the chat's columns out on the width the chat actually has.
 *
 * Measured on the element holding them, not on the window: a pinned browser
 * shrinks the shell without resizing the window. The nav's width is read off
 * the same element (`--timon-nav-w`), since it widens when pinned.
 */
export function useChatRailsLayout(
  columns: ChatColumns,
  { compact = false }: { compact?: boolean } = {},
): {
  left: ShownSide;
  right: ShownSide;
  /** Too narrow for floating columns: each one is a panel of the island. */
  drawer: boolean;
  /** Width of the measured area minus the nav rail, in px; 0 until measured. */
  available: number;
  measure: (node: HTMLElement | null) => void;
} {
  const { widgetsOf, dragging, editing } = useWidgetHost();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [available, setAvailable] = useState(0);
  const [drawer, setDrawer] = useState(false);
  useLayoutEffect(() => {
    if (!element) return;
    const read = () => {
      const nav = Number.parseFloat(getComputedStyle(element).getPropertyValue('--timon-nav-w')) || 0;
      const width = element.getBoundingClientRect().width;
      setAvailable(Math.max(0, width - nav));
      setDrawer(showsDrawers(width));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    // Pinning the nav rewrites `--timon-nav-w` on the root without resizing
    // anything this element can observe.
    const rootObserver = new MutationObserver(read);
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => { observer.disconnect(); rootObserver.disconnect(); };
  }, [element]);

  const ui = dragging !== null || editing;
  const isOccupied = useCallback((zone: string) => widgetsOf(zone).length > 0, [widgetsOf]);

  return useMemo(() => {
    const sides = (['left', 'right'] as const).map((side) => {
      const column = zoneOfSide(columns, side) ?? (side === 'left' ? CHAT_LEFT_ZONE : CHAT_RIGHT_ZONE);
      const tabs = tabsOf(columns, column);
      const occupied = tabs.some(isOccupied);
      // Collapsing is the wide screen's gesture: a panel is closed already.
      const visible = !compact && (drawer || !isCollapsed(columns, column)) && (occupied || ui);
      const second = secondOf(columns, column);
      const withoutSecond = second ? tabs.filter((z) => z !== second) : tabs;
      const request: SideRequest | null = visible
        ? {
          width: widthOf(columns, column, defaultWidth(side, available)),
          first: withoutSecond.some(isOccupied) || ui,
          second: second && (isOccupied(second) || ui) ? widthOf(columns, second, SECOND_COLUMN_WIDTH) : null,
        }
        : null;
      return { side, column, tabs, withoutSecond, second, occupied, visible, request };
    });
    const [g, d] = sides as [typeof sides[number], typeof sides[number]];
    if (drawer) {
      // One panel per side, every tab in its bar — a second column included,
      // there is no room beside anything. The thread reserves nothing.
      const panel = (c: typeof g): ShownSide => {
        const active = activeTab(columns, c.column);
        return {
          side: c.side,
          column: c.column,
          visible: c.visible,
          occupied: c.occupied,
          hasSecond: c.second !== null,
          rails: c.visible ? [{
            zone: c.column,
            slot: c.column,
            tabs: c.tabs,
            active: c.tabs.includes(active) ? active : c.column,
            width: widthOf(columns, c.column, DRAWER_WIDTH),
            max: WIDTH_MAX,
            offset: 0,
            second: false,
            names: columns.noms ?? {},
          }] : [],
          gutter: 0,
        };
      };
      return { left: panel(g), right: panel(d), drawer, available, measure: setElement };
    }
    const plan = planRails(available, g.request, d.request);
    const layoutSide = (c: typeof g, place: SidePlacement | null): ShownSide => {
      const rails: ShownRail[] = [];
      // Folded for lack of room, the second column is a tab again: one tab
      // entry per column, in the bar of the column it belongs to.
      const tabs = place?.secondFolded ? c.tabs : c.withoutSecond;
      if (place && place.first !== null) {
        const active = activeTab(columns, c.column);
        rails.push({
          zone: c.column,
          slot: c.column,
          tabs,
          active: tabs.includes(active) ? active : c.column,
          width: place.first,
          max: Math.min(WIDTH_MAX, place.first + plan.slack),
          offset: 0,
          second: false,
          names: columns.noms ?? {},
        });
      }
      if (place && place.second !== null && c.second) {
        rails.push({
          zone: c.second,
          slot: c.column,
          tabs: [c.second],
          active: c.second,
          width: place.second,
          max: Math.min(WIDTH_MAX, place.second + plan.slack),
          offset: place.secondOffset,
          second: true,
          names: columns.noms ?? {},
        });
      }
      return {
        side: c.side,
        column: c.column,
        visible: c.visible,
        occupied: c.occupied,
        hasSecond: c.second !== null,
        rails,
        gutter: place?.gutter ?? 0,
      };
    };
    return { left: layoutSide(g, plan.left), right: layoutSide(d, plan.right), drawer, available, measure: setElement };
  }, [columns, compact, ui, isOccupied, available, drawer]);
}

/** What a column needs to be resized: its width and where it may go. */
export type RailResize = {
  width: number;
  max: number;
  /**
   * The column on the other side, resized by the same amount so the screen
   * stays symmetrical. Absent = nothing to mirror. Ctrl (⌘ on a Mac) held
   * during the gesture resizes this column alone.
   */
  twin?: { width: number; max: number };
  /** `persist: false` while dragging. `jumelle`: the mirror's new width, `null` when not mirrored. */
  onChange: (width: number, persist: boolean, twin: number | null) => void;
  onReset: () => void;
};

/**
 * The width handle on a column's inner edge: the side the thread is on.
 *
 * A thin vertical line shows on hover, focus and drag — no rule drawn at rest
 * (AGENTS.md rule 16). Drag with mouse, pen or finger (pointer capture), arrows
 * from the keyboard (Shift for larger steps), Home / End for the bounds,
 * double-click for the default width. The column on the other side follows
 * (`jumelle`) unless Ctrl / ⌘ is held.
 */
function WidthHandle({
  side,
  label,
  resize,
}: {
  side: ColumnSide;
  label: string;
  resize: RailResize;
}) {
  const { width, max, twin, onChange, onReset } = resize;
  const min = Math.min(WIDTH_MIN, max);
  const clamp = useCallback((v: number) => Math.round(Math.max(min, Math.min(max, v))), [min, max]);
  // The edge follows the pointer: on the left the column grows to the right,
  // on the right it grows to the left.
  const direction = side === 'left' ? 1 : -1;
  const drag = useRef<{ pointerId: number; x: number; width: number; twin: { width: number; max: number } | null; moved: boolean } | null>(null);
  const frame = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  /** Where the gesture lands: this column, and its mirror unless `seul`. */
  const aim = (start: number, twin: { width: number; max: number } | null, wanted: number, alone: boolean): [number, number | null] => {
    if (!twin || alone) return [clamp(wanted), null];
    const r = pairedWidths(start, wanted, max, twin);
    return [r.width, r.twin];
  };
  const follow = (x: number, alone: boolean) => {
    const start = drag.current;
    if (!start) return;
    start.moved = true;
    // One layout per frame: a pointer reports far more often than the screen
    // repaints, and each report re-renders the chat.
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const [w, j] = aim(start.width, start.twin, start.width + direction * (x - start.x), alone);
      onChange(w, false, j);
    });
  };
  const finish = (x: number | null, alone: boolean) => {
    const start = drag.current;
    drag.current = null;
    setActive(false);
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    if (!start) return;
    const [w, j] = x === null
      ? [start.width, start.twin ? start.twin.width : null]
      : aim(start.width, start.twin, start.width + direction * (x - start.x), alone);
    // A click, or the first half of a double-click, moved nothing: no write.
    if (start.moved || w !== start.width) onChange(w, true, j);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      className={cn(
        'absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full after:transition-colors',
        'hover:after:bg-primary/50 focus-visible:after:bg-primary',
        active && 'after:bg-primary',
        side === 'left' ? '-right-[10px]' : '-left-[10px]',
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { pointerId: e.pointerId, x: e.clientX, width, twin: twin ?? null, moved: false };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (drag.current?.pointerId === e.pointerId) follow(e.clientX, e.ctrlKey || e.metaKey);
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        finish(e.clientX, e.ctrlKey || e.metaKey);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      // Capture lost without a release (window left, touch cancelled): the
      // column goes back to where the gesture started.
      onLostPointerCapture={() => { if (drag.current) finish(null, true); }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const target = {
          ArrowRight: width + direction * step,
          ArrowLeft: width - direction * step,
          Home: min,
          End: max,
        }[e.key];
        if (target === undefined) return;
        e.preventDefault();
        const [w, j] = aim(width, twin ?? null, target, e.ctrlKey || e.metaKey);
        onChange(w, true, j);
      }}
      onDoubleClick={onReset}
    />
  );
}

/**
 * The handles on both edges of the thread's reading column. The column is
 * centred, so it grows on both sides at once: dragging an edge by `dx` widens
 * it by twice that. Double-click goes back to the width the room gives.
 * Measured at the start of the gesture, from the box it sits in: the stored
 * width may be wider than the screen shows.
 */
export function ThreadHandles({ onChange, onReset }: {
  /** `persist: false` while dragging. */
  onChange: (width: number, persist: boolean) => void;
  onReset: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number; max: number; direction: 1 | -1 } | null>(null);
  const frame = useRef<number | null>(null);
  const [active, setActive] = useState<'left' | 'right' | null>(null);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  // 48px: the reading column's own gutters, inside the box (`--chat-col` + 48).
  const GUTTERS = 48;
  const aim = (d: NonNullable<typeof drag.current>, x: number) =>
    Math.round(Math.max(THREAD_READING_MIN, Math.min(d.max, d.width + 2 * d.direction * (x - d.x))));
  const finish = (x: number | null) => {
    const d = drag.current;
    drag.current = null;
    setActive(null);
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    if (d && x !== null && x !== d.x) onChange(aim(d, x), true);
  };
  const handle = (side: 'left' | 'right') => (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={i18n('chatPage.resizeThread')}
      title={i18n('chatPage.resizeThread')}
      tabIndex={0}
      className={cn(
        'pointer-events-auto absolute inset-y-0 w-2 cursor-col-resize touch-none outline-none',
        'after:absolute after:inset-y-6 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full after:transition-colors',
        'hover:after:bg-primary/50 focus-visible:after:bg-primary',
        active === side && 'after:bg-primary',
        side === 'left' ? '-left-3' : '-right-3',
      )}
      onPointerDown={(e) => {
        const el = box.current;
        if (e.button !== 0 || !el) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const parent = el.parentElement?.getBoundingClientRect().width ?? el.getBoundingClientRect().width;
        drag.current = {
          pointerId: e.pointerId,
          x: e.clientX,
          width: el.getBoundingClientRect().width - GUTTERS,
          max: Math.max(THREAD_READING_MIN, parent - GUTTERS),
          direction: side === 'left' ? -1 : 1,
        };
        setActive(side);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d?.pointerId !== e.pointerId) return;
        const x = e.clientX;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => { frame.current = null; onChange(aim(d, x), false); });
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        finish(e.clientX);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onLostPointerCapture={() => { if (drag.current) finish(null); }}
      onKeyDown={(e) => {
        const el = box.current;
        if (!el || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        const step = (e.shiftKey ? 128 : 32) * ((e.key === 'ArrowRight') === (side === 'right') ? 1 : -1);
        const parent = el.parentElement?.getBoundingClientRect().width ?? 0;
        const current = el.getBoundingClientRect().width - GUTTERS;
        onChange(Math.round(Math.max(THREAD_READING_MIN, Math.min(Math.max(THREAD_READING_MIN, parent - GUTTERS), current + step))), true);
      }}
      onDoubleClick={onReset}
    />
  );
  return (
    <div
      ref={box}
      className="pointer-events-none relative mx-auto h-full w-[calc(100%-var(--chat-pad)*2)] max-w-[calc(var(--chat-col,780px)+48px)]"
    >
      {handle('left')}
      {handle('right')}
    </div>
  );
}

/**
 * A chat column: the zone, and the fixed chrome that carries it.
 *
 * The column disappears when empty (the cockpit's `hideWhenEmpty`, carried by
 * the container so that its tab and menu leave with it), except during a
 * drag; otherwise nothing could ever be dropped in it once emptied.
 */
export function ChatWidgetRail({
  zone,
  slot = zone,
  tabs: tabIds,
  active,
  side,
  label,
  className,
  style,
  offset = 0,
  resize,
  onCollapse,
  onSwap,
  onSelectTab,
  onAddTab,
  onCloseTab,
  onAddColumn,
  onRemoveColumn,
  pushedAside = false,
  drawer,
  names,
}: {
  /** The column's zone, which is also its first tab. */
  zone: string;
  /** The column's tabs, first included. Absent = a single one. */
  tabs?: readonly string[];
  /** Tab shown. Absent = the first. */
  active?: string;
  /** Slot whose rules govern its zones. Absent = `zone` itself. */
  slot?: string;
  /** Side where the page puts it. Decides the icon and the controls' edge. */
  side: ColumnSide;
  label: string;
  className?: string;
  /** Position and width, which the page computes from the room it has. */
  style?: CSSProperties;
  /** Distance from the screen edge, in px: how far focus mode slides it out. */
  offset?: number;
  /** Absent = no width handle. */
  resize?: RailResize;
  onCollapse?: () => void;
  /** Swaps the two columns. The gesture belongs to both, not to one. */
  onSwap?: () => void;
  onSelectTab?: (zone: string) => void;
  onAddTab?: () => void;
  onCloseTab?: (zone: string) => void;
  /** Opens a second column beside this one. */
  onAddColumn?: () => void;
  /** Removes this second column. */
  onRemoveColumn?: () => void;
  /** Focus mode: the column leaves through ITS edge instead of disappearing. */
  pushedAside?: boolean;
  /**
   * The chat is too narrow for floating columns: this one is a panel of the
   * island (`DrawerPanel`), open or closed. Position, width handle and focus
   * mode are the wide screen's and do not apply.
   */
  drawer?: { id: string; open: boolean; onClose: () => void; width: number };
  /** Names of the tabs, by zone. */
  names?: Readonly<Record<string, string>>;
}) {
  const { dragging, editing, widgetsOf, widget } = useWidgetHost();
  // Keyed by content, not array identity: tabs register zones in the host,
  // whose update re-renders the page — a fresh array on every render would
  // re-register forever.
  const tabsKey = tabIds?.join('\n') ?? '';
  const tabs = useMemo(
    () => (tabsKey ? tabsKey.split('\n') : [zone]),
    [tabsKey, zone],
  );
  const shown = active && tabs.includes(active) ? active : zone;
  const occupied = useMemo(() => tabs.some((z) => widgetsOf(z).length > 0), [tabs, widgetsOf]);
  useHiddenTabs(tabs, shown, slot, label);
  // The tab whose menu is open, and where: the menu sits at the pointer.
  const [menu, setMenu] = useState<{ zone: string; x: number; y: number } | null>(null);
  if (!occupied && dragging === null && !editing) return null;

  const multiple = tabs.length > 1;
  const commands: ColumnCommands = { side, zone, onAddTab, onCloseTab, onAddColumn, onRemoveColumn, onSwap, onCollapse };
  const hasCommands = !!(onAddTab || onCollapse || onSwap || onAddColumn || onRemoveColumn);
  const openAt = (z: string) => (columnMenuItems(commands, z).length > 0
    ? (x: number, y: number) => setMenu({ zone: z, x, y })
    : undefined);
  // Unnamed tabs are thin pills: they say there are tabs, not what they hold
  // (that is in their tooltip). A named one needs the line height for its
  // text, and a drag needs targets a card can be dropped on.
  const thin = !tabs.some((z) => names?.[z]) && dragging === null;

  const content = (
    <>
      {multiple ? (
        // The column's own line: its tabs. Everything else about the column
        // is in the menu of a right click on them; the widgets' own controls
        // live on the widgets, never here.
        <div
          role="tablist"
          aria-label={i18n('chatPage.columnTabs')}
          className={cn(
            'flex min-w-0 shrink-0 items-center',
            thin ? 'gap-1' : 'gap-0.5 rounded-lg bg-muted p-[3px]',
          )}
        >
          {tabs.map((z, i) => (
            <ColumnTab
              key={z}
              zone={z}
              column={zone}
              rank={i + 1}
              label={label}
              name={names?.[z]}
              active={z === shown}
              thin={thin}
              titles={widgetsOf(z).map((w) => widget(w.id)?.title ?? w.id)}
              onSelect={() => onSelectTab?.(z)}
              onMenu={openAt(z)}
            />
          ))}
        </div>
      ) : hasCommands && (
        <SingleTab label={label} accent={editing} onMenu={openAt(zone)} />
      )}
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          label={i18n('chatPage.columnMenu', { column: label })}
          items={columnMenuItems(commands, menu.zone)}
          onClose={() => setMenu(null)}
        />
      )}
      <WidgetZone
        zone={shown}
        slot={slot}
        label={tabs.length > 1 ? `${label} · ${names?.[shown] ?? i18n('chatPage.columnTab', { n: String(tabs.indexOf(shown) + 1) })}` : label}
        className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-1"
      />
    </>
  );

  if (drawer) {
    return (
      <DrawerPanel
        id={drawer.id}
        side={side}
        label={label}
        open={drawer.open}
        onClose={drawer.onClose}
        width={drawer.width}
        swipe={dragging === null && !editing}
      >
        {content}
      </DrawerPanel>
    );
  }

  return (
    <div
      // Pushed aside, the column stays mounted: that is what lets you see it
      // SLIDE, both ways. An unmount animates nothing, it cuts.
      // Off screen, it no longer takes clicks or tab stops, and the screen reader
      // no longer announces it.
      aria-hidden={pushedAside || undefined}
      // `visibility` flips at the END of the exit slide and at the START of the
      // entry one: it is what removes the column from the tab order (React 18
      // does not render `inert`), and applying it right away would cut the
      // animation just written.
      style={{
        ...style,
        ...(pushedAside ? {
          visibility: 'hidden',
          transitionDelay: '0s, 200ms',
          // Out by its own edge, past whatever lies between it and that edge.
          transform: side === 'left'
            ? `translateX(calc(-100% - ${offset + 16}px - var(--timon-nav-w, 0px)))`
            : `translateX(calc(100% + ${offset + 16}px))`,
        } : {}),
      }}
      className={cn(
        'chat-widget-rail pointer-events-auto fixed z-[5] hidden min-h-0 flex-col gap-2 transition-[transform,visibility] duration-200 ease-out motion-reduce:transition-none lg:flex',
        pushedAside && 'pointer-events-none',
        className,
      )}
    >
      {resize && !pushedAside && (
        <WidthHandle side={side} label={i18n('chatPage.resizeColumn', { column: label })} resize={resize} />
      )}
      {content}
    </div>
  );
}

/**
 * Declares to the host the column's tabs that are not shown.
 *
 * They are not mounted — their cards would read the daemon for nothing — but
 * they exist: without this, the host would take their cards for cards without
 * a zone and list them in the palette, and a drop on the tab would be refused
 * for lack of an admitting zone.
 */
function useHiddenTabs(
  tabs: readonly string[],
  shown: string,
  column: string,
  label: string,
): void {
  const { registerZone } = useWidgetHost();
  const hiddenTabs = useMemo(
    () => tabs.flatMap((zone, i) => (zone === shown ? [] : [{
      id: zone,
      slot: column,
      label: `${label} · ${i18n('chatPage.columnTab', { n: String(i + 1) })}`,
      hidden: true,
    }])),
    [tabs, shown, column, label],
  );
  useEffect(() => {
    const disposers = hiddenTabs.map((def) => registerZone(def));
    return () => { for (const d of disposers) d(); };
  }, [hiddenTabs, registerZone]);
}

type OpenMenu = (x: number, y: number) => void;

type TabProps = {
  zone: string;
  column: string;
  rank: number;
  label: string;
  /** The tab's own name, written in the pill. */
  name?: string;
  /** A thin pill without text: no tab of the column has a name. */
  thin: boolean;
  titles: string[];
  onSelect: () => void;
  /** Opens the column menu on this tab. Absent = the menu would be empty. */
  onMenu?: OpenMenu;
};

/**
 * A column tab. The shown tab is only a button; the others are drop targets
 * too (`TargetTab`), in a separate component because dnd-kit keys its targets
 * by id and the last one registered wins: a shown tab registering its own
 * would shadow the end of its own zone.
 */
function ColumnTab({ active, ...props }: TabProps & { active: boolean }) {
  return active ? <TabButton {...props} active /> : <TargetTab {...props} />;
}

/**
 * During a drag, a hidden tab is a target: dropping a card on it puts the card
 * at the end of that tab, without leaving the one being looked at. The id is
 * the end-of-zone one (`rail:`), which the host already resolves and names to
 * screen readers.
 */
function TargetTab(props: TabProps) {
  const { dragging, accepts } = useWidgetHost();
  const accepted = accepts({ id: props.zone, slot: props.column, label: props.label });
  const { setNodeRef, isOver } = useDroppable({
    id: zoneDropId(props.zone),
    data: { zone: props.zone },
    disabled: dragging === null || !accepted,
  });
  return (
    <TabButton
      {...props}
      active={false}
      target={dragging !== null && accepted}
      hovered={isOver && dragging !== null && accepted}
      targetRef={setNodeRef}
    />
  );
}

/** The visible pill of a thin tab, inside a taller hit area. */
const THIN_PILL = 'h-1.5 w-full rounded-full transition-colors group-focus-visible/tab:ring-2 group-focus-visible/tab:ring-ring';

function TabButton({
  rank,
  name,
  thin,
  titles,
  onSelect,
  onMenu,
  active,
  target = false,
  hovered = false,
  targetRef,
}: TabProps & {
  active: boolean;
  target?: boolean;
  hovered?: boolean;
  targetRef?: (node: HTMLElement | null) => void;
}) {
  const menuPress = useMenuPress(onMenu);
  const n = name ?? String(rank);
  const description = titles.length > 0
    ? i18n('chatPage.columnTabCards', { n, titles: titles.join(', ') })
    : i18n('chatPage.columnTabEmpty', { n });
  return (
    <button
      ref={targetRef}
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={description}
      title={onMenu ? `${description}\n${i18n('chatPage.columnMenuHint')}` : description}
      onClick={onSelect}
      {...menuPress}
      className={cn(
        'min-w-0 flex-1',
        thin
          ? 'group/tab flex h-3 items-center rounded-full outline-none'
          : cn(
            'h-5 rounded-md px-2 text-[11px] font-medium transition-colors',
            active
              ? 'bg-background text-foreground shadow-sm'
              : 'bg-background/30 hover:bg-background/60',
            target && 'bg-background/50',
            hovered && 'bg-primary/15 text-foreground',
            name && 'truncate',
          ),
      )}
    >
      {thin ? (
        <span
          aria-hidden
          className={cn(THIN_PILL, active ? 'bg-muted-foreground/45' : 'bg-muted group-hover/tab:bg-muted-foreground/25')}
        />
      ) : name}
    </button>
  );
}

/**
 * The tab of a column that has only one: a thin pill without text, there to
 * carry the column menu (right click, Menu key, long press — or a plain click,
 * since it has nothing else to do). Firmer while the layout is being edited.
 */
function SingleTab({ label, accent, onMenu }: { label: string; accent: boolean; onMenu?: OpenMenu }) {
  const menuPress = useMenuPress(onMenu);
  if (!onMenu) return null;
  return (
    <button
      type="button"
      data-column-tab
      aria-label={i18n('chatPage.columnMenu', { column: label })}
      title={i18n('chatPage.columnMenuHint')}
      onClick={(e) => {
        // A keyboard click has no pointer: the menu opens under the pill.
        const r = e.currentTarget.getBoundingClientRect();
        if (e.detail === 0) onMenu(r.left, r.bottom);
        else onMenu(e.clientX, e.clientY);
      }}
      {...menuPress}
      className="group/tab flex h-3 w-full shrink-0 items-center rounded-full outline-none"
    >
      <span
        aria-hidden
        // A short grip in the middle, not a bar across the column: full width,
        // it read as a separator line. The whole row stays the hit area.
        className={cn(THIN_PILL, 'mx-auto max-w-12', accent ? 'bg-muted-foreground/30' : 'bg-foreground/[0.08]', 'group-hover/tab:max-w-none group-hover/tab:bg-muted-foreground/25')}
      />
    </button>
  );
}
