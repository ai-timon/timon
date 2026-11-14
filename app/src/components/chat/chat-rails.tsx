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
import { useAfterConversation } from '@/lib/load-priority';
import { useWidgetHost } from '@/components/widget-host/widget-host';
import { declareSlot, register, slotKind, type WidgetOptions } from '@/lib/plugin-host/slots';
import { zoneDropId } from '@/components/widget-host/widget-dnd';
import { idPlacementPlugin } from '@/components/widget-host/widget-catalog';
import {
  ajouterOnglet,
  ajouterSeconde,
  poserMasquee,
  detacherSeconde,
  choisirOnglet,
  estMasquee,
  inverserColonnes,
  largeurDe,
  lireColonnes,
  ongletActif,
  ongletsDe,
  planifierRails,
  poserLargeur,
  poserFil,
  retirerOnglet,
  secondeDe,
  zoneDuCote,
  LARGEUR_MAX,
  LARGEUR_MIN,
  FIL_LECTURE_MIN,
  largeursJumelees,
  LARGEUR_SECONDE,
  estEnTiroir,
  type ChatColumns,
  type CoteColonne,
  type DemandeCote,
  type PlaceCote,
} from './chat-columns';
import { MissionRail } from './mission-rail';
import { MissionCard } from './mission-card';
import { SkillsCard } from './skills-card';
import { McpCard } from './mcp-card';
import { AgentTodosCard } from './agent-todos-card';
import type { Agent, AgentTodo, McpItem, MissionSummary, SkillItem } from './chat-types';
import type { Delegation } from '@/hooks/use-delegations';
import type { NewMissionOptions } from './new-mission-menu';
import { widgetPicto } from '@/plugins-client/widget-pictos';
import { FileContextMenu } from './file-context-menu';
import { itemsColonne, useAppuiMenu, type CommandesColonne } from './chat-column-menu';

// The rail cards come after the conversation (`useAfterConversation`): their
// code too, fetched when a card first paints (docs/BUNDLE-SIZE.md).
const VideoFactoryPanel = dynamic(() => import('@/components/video-factory-panel').then((m) => m.VideoFactoryPanel), { ssr: false });
const DockerMissionPanel = dynamic(() => import('@/components/docker-mission-panel').then((m) => m.DockerMissionPanel), { ssr: false });
const OrchestratorSelfPanel = dynamic(() => import('@/components/orchestrator-self-panel').then((m) => m.OrchestratorSelfPanel), { ssr: false });
const FileBrowser = dynamic(() => import('./file-browser').then((m) => m.FileBrowser), { ssr: false });
const GitPanel = dynamic(() => import('@/plugins-client/git/git-panel').then((m) => m.GitPanel), { ssr: false });
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
export const COLONNES: readonly string[] = [CHAT_LEFT_ZONE, CHAT_RIGHT_ZONE];

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

/** Branches, graph and publication of the project — the client half of `@timon/git`. */
function GitWidget() {
  const chat = useContext(ChatRailContext);
  const later = useAfterConversation();
  if (!chat || !later) return null;
  return <GitPanel agentId={chat.agentId} slug={chat.slug} />;
}

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
type Inscription = {
  zone: string;
  pluginId: string;
  key: string;
  /** What the card says about itself to the host: title, heights (U.3). */
  widget?: WidgetOptions;
  Composant: () => ReactNode;
  /**
   * UI zone the panel depends on (`chat.panel.*`). Absent = the widget is
   * always registered. Present and hidden (module off or `ui.hidden`): the
   * widget is NOT registered. It is an install filter, not a removal by the
   * user (which can be restored from the palette).
   */
  zoneUi?: string;
};

/** A catalogue entry's name and sentence, read when the widget is registered and
 *  not when this module loads: the locale is not known before that. */
function carte(cle: string, options: WidgetOptions = {}): WidgetOptions {
  return {
    ...options,
    icon: widgetPicto(cle),
    get title() { return i18n(`widgetCatalog.${cle}.title`); },
    get description() { return i18n(`widgetCatalog.${cle}.description`); },
  };
}

/**
 * Visual order, not writing order: `rangDefaut` follows the order of this
 * array (see `catalogueWidgets`), so a card added here lands where the block
 * it replaces stood in the mission sheet.
 */
const INSCRIPTIONS: Inscription[] = [
  { zone: CHAT_LEFT_ZONE, pluginId: '@timon/missions', key: 'Missions', widget: carte('missionsList'), Composant: MissionsWidget },
  // Its own plugin (TODO #356), reading the agent's folder from the core
  // `@timon/agents` (`/api/agents/:name/files`), which it depends on: the
  // zone follows `@timon/files-widget`, off whenever that route is.
  // `formerIds` keeps the place a user gave the card under `kanban-code`
  // (TODO #311) then `agents`.
  {
    zone: CHAT_LEFT_ZONE,
    pluginId: '@timon/files-widget',
    key: 'Files',
    widget: carte('files', { formerIds: ['plugin:@timon/kanban-code:Files', 'plugin:@timon/agents:Files'] }),
    Composant: FilesWidget,
    zoneUi: 'chat.panel.files',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/missions',
    key: 'agent-todos',
    widget: carte('agentTasks', { height: 200, minHeight: 110 }),
    Composant: AgentTodosWidget,
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/video-factory',
    key: 'video',
    widget: carte('videoFactory', { height: 240, minHeight: 130 }),
    Composant: VideoFactoryWidget,
    zoneUi: 'chat.panel.video-factory',
  },
  // One card since TODO #278 for the former Git panel and publication card:
  // it takes over the place of the first of them still on screen, the
  // publication card first (it was the shown tab of the shipped stack).
  // No `zoneUi`, like the Git panel: `chat.panel.git-remote` now hides only
  // the Publish tab.
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/git',
    key: 'repository',
    widget: carte('git', {
      height: 320,
      minHeight: 180,
      formerIds: [
        'plugin:@timon/git:git-remote',
        'plugin:@timon/git:Git',
        'plugin:@timon/kanban-code:git-remote',
        'plugin:@timon/kanban-code:Git',
      ],
    }),
    Composant: GitWidget,
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/docker-supervision',
    key: 'docker',
    widget: carte('docker', { height: 260, minHeight: 140 }),
    Composant: DockerWidget,
    zoneUi: 'chat.panel.docker',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/orchestrator-self',
    key: 'orchestrator',
    widget: carte('timonDaemon', { height: 240, minHeight: 130 }),
    Composant: OrchestratorSelfWidget,
    zoneUi: 'chat.panel.orchestrator-self',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/missions',
    key: 'mission',
    widget: carte('missionDetails', { height: 260, minHeight: 150 }),
    Composant: MissionCardWidget,
  },
  // Their own plugins (TODO #357), like Files: the skills and MCP routes stay
  // in the core `@timon/agents`, which both depend on. `formerIds` keeps the
  // place a user gave each card under `agents`.
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/skills-widget',
    key: 'skills',
    widget: carte('agentSkills', { height: 260, minHeight: 140, formerIds: ['plugin:@timon/agents:skills'] }),
    Composant: SkillsWidget,
    zoneUi: 'chat.panel.skills',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/mcp-widget',
    key: 'mcp',
    widget: carte('mcpServers', { height: 220, minHeight: 120, formerIds: ['plugin:@timon/agents:mcp'] }),
    Composant: McpWidget,
    zoneUi: 'chat.panel.mcp',
  },
  {
    zone: CHAT_RIGHT_ZONE,
    pluginId: '@timon/workflows',
    key: 'trace',
    widget: carte('trace', { height: 300, minHeight: 160 }),
    Composant: () => <ChatTraceWidget />,
  },
];

/**
 * Exported for its test: which cards register, for these capabilities. Each is
 * behind the `widget:<module>` grant of its plugin (TODO #356, #357, #645). The
 * daemon checks its routes on its own: this only decides what is painted.
 */
export function inscriptionsVisibles(caps: Capabilities | null): Inscription[] {
  return INSCRIPTIONS.filter((i) =>
    (!i.zoneUi || isZoneVisible(caps, i.zoneUi))
    && isWidgetSurfaceAllowed(caps, i.pluginId, i.key));
}

/** The missions card's placement id: the narrow chat checks it is in a column. */
export const MISSIONS_WIDGET_ID = idPlacementPlugin('@timon/missions', 'Missions');

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
export function PanneauTiroir({
  id,
  cote,
  label,
  ouvert,
  onFermer,
  largeur,
  glissement = true,
  className,
  children,
}: {
  id: string;
  cote: CoteColonne;
  label: string;
  ouvert: boolean;
  onFermer: () => void;
  /** Preferred width in px; the screen caps it. */
  largeur: number;
  /** Off while a card is dragged or the layout edited: those gestures move too. */
  glissement?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const depart = useRef<{ pointeur: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!ouvert) return;
    const touche = (e: KeyboardEvent) => { if (e.key === 'Escape') onFermer(); };
    document.addEventListener('keydown', touche);
    return () => document.removeEventListener('keydown', touche);
  }, [ouvert, onFermer]);

  // Out by its own edge, past the island gap and, on the left, the nav: the
  // island clips it, and no sliver is left over the thread.
  const dehors = cote === 'left'
    ? 'translateX(calc(-100% - var(--timon-nav-w, 0px) - 2 * var(--timon-island-gap)))'
    : 'translateX(calc(100% + 2 * var(--timon-island-gap)))';
  return (
    <div
      id={id}
      role="region"
      aria-label={label}
      aria-hidden={!ouvert || undefined}
      data-open={ouvert || undefined}
      // Scrolling inside the drawer is not scrolling the page: the top bar stays put.
      data-header-scroll="ignore"
      style={{
        // A strip of the thread stays visible beside it: that is where a tap
        // closes it.
        width: `min(${largeur}px, calc(100% - var(--timon-nav-w, 0px) - 2 * var(--timon-island-gap) - 48px))`,
        ...(cote === 'left'
          ? { left: 'calc(var(--timon-nav-w, 0px) + var(--timon-island-gap))' }
          : {}),
        ...(ouvert ? {} : { transform: dehors, visibility: 'hidden', transitionDelay: '0s, 200ms' }),
      }}
      className={cn(
        'chat-widget-drawer timon-island absolute top-[var(--timon-island-gap)] bottom-[var(--timon-island-gap)] z-30 flex min-h-0 flex-col gap-2 bg-background p-2 shadow-elev-2',
        // Inside the island where it is painted (md+), on the page below.
        'md:bottom-[calc(2*var(--timon-island-gap))]',
        cote === 'right' && 'right-[var(--timon-island-gap)] md:right-[calc(2*var(--timon-island-gap))]',
        // Vertical panning stays the browser's; a horizontal move is ours.
        'touch-pan-y transition-[transform,visibility] duration-200 ease-out motion-reduce:transition-none',
        !ouvert && 'pointer-events-none',
        className,
      )}
      onPointerDown={(e) => {
        // A swipe is a touch gesture: with a mouse, the same move selects text.
        if (!glissement || !ouvert || e.pointerType === 'mouse') return;
        depart.current = { pointeur: e.pointerId, x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        const d = depart.current;
        depart.current = null;
        if (!d || d.pointeur !== e.pointerId || !glissement) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        const versLeBord = cote === 'left' ? dx < 0 : dx > 0;
        if (versLeBord && Math.abs(dx) >= SEUIL_GLISSEMENT && Math.abs(dx) > 1.5 * Math.abs(dy)) onFermer();
      }}
      // The browser took the gesture over (a scroll): not a swipe.
      onPointerCancel={() => { depart.current = null; }}
    >
      {children}
    </div>
  );
}

/** How far, in px, a swipe must travel towards the panel's edge to close it. */
const SEUIL_GLISSEMENT = 56;

export function ChatRailWidgets() {
  const caps = useCapabilities();

  useEffect(() => {
    const jeter: Array<() => void> = [];
    for (const nom of [CHAT_LEFT_ZONE, CHAT_RIGHT_ZONE]) {
      // Two non-compact chats on screen would declare the same zone twice, and
      // `declareSlot` refuses: the second makes do with the first one's rather
      // than bring the page down.
      if (slotKind(nom) === null) jeter.push(declareSlot(nom, 'list', 'chat-rails'));
    }
    return () => { for (const d of jeter.reverse()) d(); };
  }, []);

  // An effect separate from the declaration: `collapseSlot` disposes of
  // EVERYTHING that occupies the zone, including a third-party widget we did not
  // register. Redoing the registrations when the capabilities arrive must not
  // cost that.
  useEffect(() => {
    const jeter = inscriptionsVisibles(caps).map((i) =>
      register(
        { slot: i.zone, pluginId: i.pluginId, key: i.key, widget: i.widget },
        i.Composant,
      ),
    );
    return () => { for (const d of jeter.reverse()) d(); };
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
export function useChatColumns(connues: readonly string[] = COLONNES): {
  colonnes: ChatColumns;
  inverser: () => void;
  basculer: (zone: string) => void;
  ajouterOnglet: (colonne: string) => void;
  choisirOnglet: (colonne: string, zone: string) => void;
  fermerOnglet: (colonne: string, zone: string) => void;
  /** `persist: false` while a drag is under way: shown, not written yet. */
  poserLargeur: (zone: string, largeur: number | null, persist?: boolean) => void;
  /** Several widths in one write: a column and its mirror on the other side. */
  poserLargeurs: (largeurs: ReadonlyArray<readonly [string, number | null]>, persist?: boolean) => void;
  /** Width of the thread's reading column; `null` = follow the room. */
  poserFil: (largeur: number | null, persist?: boolean) => void;
  ajouterSeconde: (colonne: string) => void;
  retirerSeconde: (colonne: string) => void;
} {
  const { onMergeZone, widgetsOf } = useWidgetHost();
  const { key, previousKey } = useWorkspaceLayout();
  const { raw: stocke, update } = useStoredLayout(
    key ? `${key}.columns` : null,
    workspaceRowHandover(previousKey, 'columns', 'chat.columns'),
  );
  const colonnes = useMemo(() => lireColonnes(stocke, connues), [stocke, connues]);
  const muter = useCallback((op: (c: ChatColumns) => ChatColumns) => {
    update((raw) => op(lireColonnes(raw, connues)));
  }, [update, connues]);

  // Swaps the sides seen: already swapped elsewhere, there is nothing left to do.
  const inverser = useCallback(() => {
    const premiere = colonnes.ordre[0];
    muter((c) => c.ordre[0] === premiere ? inverserColonnes(c) : c);
  }, [colonnes, muter]);
  const largeur = useCallback((zone: string, valeur: number | null, persist = true) => {
    void update((raw) => poserLargeur(lireColonnes(raw, connues), zone, valeur), persist);
  }, [update, connues]);
  const largeurs = useCallback((liste: ReadonlyArray<readonly [string, number | null]>, persist = true) => {
    void update((raw) => liste.reduce((c, [zone, valeur]) => poserLargeur(c, zone, valeur), lireColonnes(raw, connues)), persist);
  }, [update, connues]);
  const fil = useCallback((valeur: number | null, persist = true) => {
    void update((raw) => poserFil(lireColonnes(raw, connues), valeur), persist);
  }, [update, connues]);
  // What the click asks for is decided here, against the columns on screen:
  // an op runs again on a row another window rewrote (TODO #647), and must
  // neither toggle back nor mint another suffix there.
  const basculer = useCallback((zone: string) => {
    const masquee = !estMasquee(colonnes, zone);
    muter((c) => poserMasquee(c, zone, masquee));
  }, [colonnes, muter]);
  // A clock-based suffix is never reused, even after a close (cf.
  // `ajouterOnglet`).
  const ajouter = useCallback((colonne: string) => {
    const suffixe = Date.now().toString(36);
    muter((c) => ajouterOnglet(c, colonne, suffixe));
  }, [muter]);
  const choisir = useCallback(
    (colonne: string, zone: string) => muter((c) => choisirOnglet(c, colonne, zone)),
    [muter],
  );
  // Cards leave before the tab does: the other way round, they would sit for a
  // moment in a zone nothing declares, hence in the palette. The first tab is
  // then shown, since that is where they went.
  const fermer = useCallback((colonne: string, zone: string) => {
    if (zone === colonne) return;
    onMergeZone(zone, colonne);
    muter((c) => choisirOnglet(retirerOnglet(c, colonne, zone), colonne, colonne));
  }, [muter, onMergeZone]);

  // Same never-reused suffix as a tab: a second column IS a tab.
  const seconde = useCallback((colonne: string) => {
    const suffixe = Date.now().toString(36);
    muter((c) => ajouterSeconde(c, colonne, suffixe));
  }, [muter]);
  // An empty second column goes away; one holding cards goes back among the
  // tabs, cards included — removing a column never throws a card out.
  const retirerSecondeColonne = useCallback((colonne: string) => {
    const zone = secondeDe(colonnes, colonne);
    if (!zone) return;
    const garnie = widgetsOf(zone).length > 0;
    muter((c) => secondeDe(c, colonne) !== zone ? c : garnie ? detacherSeconde(c, colonne) : retirerOnglet(c, colonne, zone));
  }, [colonnes, muter, widgetsOf]);

  return {
    colonnes,
    inverser,
    basculer,
    ajouterOnglet: ajouter,
    choisirOnglet: choisir,
    fermerOnglet: fermer,
    poserLargeur: largeur,
    poserLargeurs: largeurs,
    poserFil: fil,
    ajouterSeconde: seconde,
    retirerSeconde: retirerSecondeColonne,
  };
}

/** A panel's width when the user never resized its column; the screen caps it
 *  (`PanneauTiroir`). */
const LARGEUR_TIROIR = 340;

/** Default width of a side's column. The left one keeps the narrower width it
 *  had below `xl` (1280px), where the fixed classes used to set it. */
function largeurParDefaut(cote: CoteColonne, disponible: number): number {
  return cote === 'left' && disponible > 0 && disponible < 1280 ? 280 : 300;
}

/** A column as the page paints it: where, how wide, and what it shows. */
export type RailAffiche = {
  /** Zone shown first — the column's, or its second column's tab. */
  zone: string;
  /** Slot whose rules govern it: always the column's. */
  slot: string;
  onglets: string[];
  actif: string;
  /** Width painted, in px. */
  largeur: number;
  /** Widest the user can drag it right now, in px. */
  max: number;
  /** Distance from the screen edge (nav excluded), in px. */
  decalage: number;
  /** The column's second column, rather than the column itself. */
  seconde: boolean;
  /** Names of its tabs, by zone (`ChatColumns.noms`). */
  noms: Readonly<Record<string, string>>;
};

export type CoteAffiche = {
  cote: CoteColonne;
  /** The column zone of this side. */
  colonne: string;
  /** Not collapsed, and has something to show (or a drag / edit is on). */
  visible: boolean;
  /** Any of its zones holds a card. */
  occupee: boolean;
  /** It has a second column, shown or folded into its tabs. */
  aSeconde: boolean;
  rails: RailAffiche[];
  /** Width the thread reserves for this side, nav excluded, in px. */
  gouttiere: number;
};

/**
 * Lays the chat's columns out on the width the chat actually has.
 *
 * Measured on the element holding them, not on the window: a pinned browser
 * shrinks the shell without resizing the window. The nav's width is read off
 * the same element (`--timon-nav-w`), since it widens when pinned.
 */
export function useChatRailsLayout(
  colonnes: ChatColumns,
  { compact = false }: { compact?: boolean } = {},
): {
  gauche: CoteAffiche;
  droite: CoteAffiche;
  /** Too narrow for floating columns: each one is a panel of the island. */
  tiroir: boolean;
  /** Width of the measured area minus the nav rail, in px; 0 until measured. */
  disponible: number;
  mesurer: (node: HTMLElement | null) => void;
} {
  const { widgetsOf, dragging, editing } = useWidgetHost();
  const [noeud, setNoeud] = useState<HTMLElement | null>(null);
  const [disponible, setDisponible] = useState(0);
  const [tiroir, setTiroir] = useState(false);
  useLayoutEffect(() => {
    if (!noeud) return;
    const lire = () => {
      const nav = Number.parseFloat(getComputedStyle(noeud).getPropertyValue('--timon-nav-w')) || 0;
      const largeur = noeud.getBoundingClientRect().width;
      setDisponible(Math.max(0, largeur - nav));
      setTiroir(estEnTiroir(largeur));
    };
    lire();
    if (typeof ResizeObserver === 'undefined') return;
    const observateur = new ResizeObserver(lire);
    observateur.observe(noeud);
    // Pinning the nav rewrites `--timon-nav-w` on the root without resizing
    // anything this element can observe.
    const racine = new MutationObserver(lire);
    racine.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => { observateur.disconnect(); racine.disconnect(); };
  }, [noeud]);

  const ui = dragging !== null || editing;
  const occupe = useCallback((zone: string) => widgetsOf(zone).length > 0, [widgetsOf]);

  return useMemo(() => {
    const cotes = (['left', 'right'] as const).map((cote) => {
      const colonne = zoneDuCote(colonnes, cote) ?? (cote === 'left' ? CHAT_LEFT_ZONE : CHAT_RIGHT_ZONE);
      const onglets = ongletsDe(colonnes, colonne);
      const occupee = onglets.some(occupe);
      // Collapsing is the wide screen's gesture: a panel is closed already.
      const visible = !compact && (tiroir || !estMasquee(colonnes, colonne)) && (occupee || ui);
      const seconde = secondeDe(colonnes, colonne);
      const sans = seconde ? onglets.filter((z) => z !== seconde) : onglets;
      const demande: DemandeCote | null = visible
        ? {
          largeur: largeurDe(colonnes, colonne, largeurParDefaut(cote, disponible)),
          premiere: sans.some(occupe) || ui,
          seconde: seconde && (occupe(seconde) || ui) ? largeurDe(colonnes, seconde, LARGEUR_SECONDE) : null,
        }
        : null;
      return { cote, colonne, onglets, sans, seconde, occupee, visible, demande };
    });
    const [g, d] = cotes as [typeof cotes[number], typeof cotes[number]];
    if (tiroir) {
      // One panel per side, every tab in its bar — a second column included,
      // there is no room beside anything. The thread reserves nothing.
      const panneau = (c: typeof g): CoteAffiche => {
        const actif = ongletActif(colonnes, c.colonne);
        return {
          cote: c.cote,
          colonne: c.colonne,
          visible: c.visible,
          occupee: c.occupee,
          aSeconde: c.seconde !== null,
          rails: c.visible ? [{
            zone: c.colonne,
            slot: c.colonne,
            onglets: c.onglets,
            actif: c.onglets.includes(actif) ? actif : c.colonne,
            largeur: largeurDe(colonnes, c.colonne, LARGEUR_TIROIR),
            max: LARGEUR_MAX,
            decalage: 0,
            seconde: false,
            noms: colonnes.noms ?? {},
          }] : [],
          gouttiere: 0,
        };
      };
      return { gauche: panneau(g), droite: panneau(d), tiroir, disponible, mesurer: setNoeud };
    }
    const plan = planifierRails(disponible, g.demande, d.demande);
    const affiche = (c: typeof g, place: PlaceCote | null): CoteAffiche => {
      const rails: RailAffiche[] = [];
      // Folded for lack of room, the second column is a tab again: one tab
      // entry per column, in the bar of the column it belongs to.
      const onglets = place?.secondeRepliee ? c.onglets : c.sans;
      if (place && place.premiere !== null) {
        const actif = ongletActif(colonnes, c.colonne);
        rails.push({
          zone: c.colonne,
          slot: c.colonne,
          onglets,
          actif: onglets.includes(actif) ? actif : c.colonne,
          largeur: place.premiere,
          max: Math.min(LARGEUR_MAX, place.premiere + plan.marge),
          decalage: 0,
          seconde: false,
          noms: colonnes.noms ?? {},
        });
      }
      if (place && place.seconde !== null && c.seconde) {
        rails.push({
          zone: c.seconde,
          slot: c.colonne,
          onglets: [c.seconde],
          actif: c.seconde,
          largeur: place.seconde,
          max: Math.min(LARGEUR_MAX, place.seconde + plan.marge),
          decalage: place.decalageSeconde,
          seconde: true,
          noms: colonnes.noms ?? {},
        });
      }
      return {
        cote: c.cote,
        colonne: c.colonne,
        visible: c.visible,
        occupee: c.occupee,
        aSeconde: c.seconde !== null,
        rails,
        gouttiere: place?.gouttiere ?? 0,
      };
    };
    return { gauche: affiche(g, plan.gauche), droite: affiche(d, plan.droite), tiroir, disponible, mesurer: setNoeud };
  }, [colonnes, compact, ui, occupe, disponible, tiroir]);
}

/** What a column needs to be resized: its width and where it may go. */
export type RedimensionRail = {
  largeur: number;
  max: number;
  /**
   * The column on the other side, resized by the same amount so the screen
   * stays symmetrical. Absent = nothing to mirror. Ctrl (⌘ on a Mac) held
   * during the gesture resizes this column alone.
   */
  jumelle?: { largeur: number; max: number };
  /** `persist: false` while dragging. `jumelle`: the mirror's new width, `null` when not mirrored. */
  onChange: (largeur: number, persist: boolean, jumelle: number | null) => void;
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
function PoigneeLargeur({
  cote,
  label,
  redimension,
}: {
  cote: CoteColonne;
  label: string;
  redimension: RedimensionRail;
}) {
  const { largeur, max, jumelle, onChange, onReset } = redimension;
  const min = Math.min(LARGEUR_MIN, max);
  const borne = useCallback((v: number) => Math.round(Math.max(min, Math.min(max, v))), [min, max]);
  // The edge follows the pointer: on the left the column grows to the right,
  // on the right it grows to the left.
  const sens = cote === 'left' ? 1 : -1;
  const glisse = useRef<{ pointeur: number; x: number; largeur: number; jumelle: { largeur: number; max: number } | null; bouge: boolean } | null>(null);
  const image = useRef<number | null>(null);
  const [actif, setActif] = useState(false);
  useEffect(() => () => { if (image.current !== null) cancelAnimationFrame(image.current); }, []);

  /** Where the gesture lands: this column, and its mirror unless `seul`. */
  const viser = (depart: number, twin: { largeur: number; max: number } | null, voulue: number, seul: boolean): [number, number | null] => {
    if (!twin || seul) return [borne(voulue), null];
    const r = largeursJumelees(depart, voulue, max, twin);
    return [r.largeur, r.jumelle];
  };
  const suivre = (x: number, seul: boolean) => {
    const depart = glisse.current;
    if (!depart) return;
    depart.bouge = true;
    // One layout per frame: a pointer reports far more often than the screen
    // repaints, and each report re-renders the chat.
    if (image.current !== null) cancelAnimationFrame(image.current);
    image.current = requestAnimationFrame(() => {
      image.current = null;
      const [w, j] = viser(depart.largeur, depart.jumelle, depart.largeur + sens * (x - depart.x), seul);
      onChange(w, false, j);
    });
  };
  const finir = (x: number | null, seul: boolean) => {
    const depart = glisse.current;
    glisse.current = null;
    setActif(false);
    if (image.current !== null) { cancelAnimationFrame(image.current); image.current = null; }
    if (!depart) return;
    const [w, j] = x === null
      ? [depart.largeur, depart.jumelle ? depart.jumelle.largeur : null]
      : viser(depart.largeur, depart.jumelle, depart.largeur + sens * (x - depart.x), seul);
    // A click, or the first half of a double-click, moved nothing: no write.
    if (depart.bouge || w !== depart.largeur) onChange(w, true, j);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={largeur}
      tabIndex={0}
      className={cn(
        'absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full after:transition-colors',
        'hover:after:bg-primary/50 focus-visible:after:bg-primary',
        actif && 'after:bg-primary',
        cote === 'left' ? '-right-[10px]' : '-left-[10px]',
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        glisse.current = { pointeur: e.pointerId, x: e.clientX, largeur, jumelle: jumelle ?? null, bouge: false };
        setActif(true);
      }}
      onPointerMove={(e) => {
        if (glisse.current?.pointeur === e.pointerId) suivre(e.clientX, e.ctrlKey || e.metaKey);
      }}
      onPointerUp={(e) => {
        if (glisse.current?.pointeur !== e.pointerId) return;
        finir(e.clientX, e.ctrlKey || e.metaKey);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      // Capture lost without a release (window left, touch cancelled): the
      // column goes back to where the gesture started.
      onLostPointerCapture={() => { if (glisse.current) finir(null, true); }}
      onKeyDown={(e) => {
        const pas = e.shiftKey ? 64 : 16;
        const cible = {
          ArrowRight: largeur + sens * pas,
          ArrowLeft: largeur - sens * pas,
          Home: min,
          End: max,
        }[e.key];
        if (cible === undefined) return;
        e.preventDefault();
        const [w, j] = viser(largeur, jumelle ?? null, cible, e.ctrlKey || e.metaKey);
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
export function PoigneesFil({ onChange, onReset }: {
  /** `persist: false` while dragging. */
  onChange: (largeur: number, persist: boolean) => void;
  onReset: () => void;
}) {
  const boite = useRef<HTMLDivElement>(null);
  const glisse = useRef<{ pointeur: number; x: number; largeur: number; max: number; sens: 1 | -1 } | null>(null);
  const image = useRef<number | null>(null);
  const [actif, setActif] = useState<'left' | 'right' | null>(null);
  useEffect(() => () => { if (image.current !== null) cancelAnimationFrame(image.current); }, []);
  // 48px: the reading column's own gutters, inside the box (`--chat-col` + 48).
  const GOUTTIERES = 48;
  const viser = (d: NonNullable<typeof glisse.current>, x: number) =>
    Math.round(Math.max(FIL_LECTURE_MIN, Math.min(d.max, d.largeur + 2 * d.sens * (x - d.x))));
  const finir = (x: number | null) => {
    const d = glisse.current;
    glisse.current = null;
    setActif(null);
    if (image.current !== null) { cancelAnimationFrame(image.current); image.current = null; }
    if (d && x !== null && x !== d.x) onChange(viser(d, x), true);
  };
  const poignee = (cote: 'left' | 'right') => (
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
        actif === cote && 'after:bg-primary',
        cote === 'left' ? '-left-3' : '-right-3',
      )}
      onPointerDown={(e) => {
        const el = boite.current;
        if (e.button !== 0 || !el) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const parent = el.parentElement?.getBoundingClientRect().width ?? el.getBoundingClientRect().width;
        glisse.current = {
          pointeur: e.pointerId,
          x: e.clientX,
          largeur: el.getBoundingClientRect().width - GOUTTIERES,
          max: Math.max(FIL_LECTURE_MIN, parent - GOUTTIERES),
          sens: cote === 'left' ? -1 : 1,
        };
        setActif(cote);
      }}
      onPointerMove={(e) => {
        const d = glisse.current;
        if (d?.pointeur !== e.pointerId) return;
        const x = e.clientX;
        if (image.current !== null) cancelAnimationFrame(image.current);
        image.current = requestAnimationFrame(() => { image.current = null; onChange(viser(d, x), false); });
      }}
      onPointerUp={(e) => {
        if (glisse.current?.pointeur !== e.pointerId) return;
        finir(e.clientX);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onLostPointerCapture={() => { if (glisse.current) finir(null); }}
      onKeyDown={(e) => {
        const el = boite.current;
        if (!el || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        const pas = (e.shiftKey ? 128 : 32) * ((e.key === 'ArrowRight') === (cote === 'right') ? 1 : -1);
        const parent = el.parentElement?.getBoundingClientRect().width ?? 0;
        const actuelle = el.getBoundingClientRect().width - GOUTTIERES;
        onChange(Math.round(Math.max(FIL_LECTURE_MIN, Math.min(Math.max(FIL_LECTURE_MIN, parent - GOUTTIERES), actuelle + pas))), true);
      }}
      onDoubleClick={onReset}
    />
  );
  return (
    <div
      ref={boite}
      className="pointer-events-none relative mx-auto h-full w-[calc(100%-var(--chat-pad)*2)] max-w-[calc(var(--chat-col,780px)+48px)]"
    >
      {poignee('left')}
      {poignee('right')}
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
  onglets,
  actif,
  cote,
  label,
  className,
  style,
  decalage = 0,
  redimension,
  onCollapse,
  onSwap,
  onSelectTab,
  onAddTab,
  onCloseTab,
  onAddColumn,
  onRemoveColumn,
  ecartee = false,
  tiroir,
  noms,
}: {
  /** The column's zone, which is also its first tab. */
  zone: string;
  /** The column's tabs, first included. Absent = a single one. */
  onglets?: readonly string[];
  /** Tab shown. Absent = the first. */
  actif?: string;
  /** Slot whose rules govern its zones. Absent = `zone` itself. */
  slot?: string;
  /** Side where the page puts it. Decides the icon and the controls' edge. */
  cote: CoteColonne;
  label: string;
  className?: string;
  /** Position and width, which the page computes from the room it has. */
  style?: CSSProperties;
  /** Distance from the screen edge, in px: how far focus mode slides it out. */
  decalage?: number;
  /** Absent = no width handle. */
  redimension?: RedimensionRail;
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
  ecartee?: boolean;
  /**
   * The chat is too narrow for floating columns: this one is a panel of the
   * island (`PanneauTiroir`), open or closed. Position, width handle and focus
   * mode are the wide screen's and do not apply.
   */
  tiroir?: { id: string; ouvert: boolean; onFermer: () => void; largeur: number };
  /** Names of the tabs, by zone. */
  noms?: Readonly<Record<string, string>>;
}) {
  const { dragging, editing, widgetsOf, widget } = useWidgetHost();
  // Keyed by content, not array identity: tabs register zones in the host,
  // whose update re-renders the page — a fresh array on every render would
  // re-register forever.
  const cleOnglets = onglets?.join('\n') ?? '';
  const tabs = useMemo(
    () => (cleOnglets ? cleOnglets.split('\n') : [zone]),
    [cleOnglets, zone],
  );
  const affiche = actif && tabs.includes(actif) ? actif : zone;
  const occupee = useMemo(() => tabs.some((z) => widgetsOf(z).length > 0), [tabs, widgetsOf]);
  useOngletsCaches(tabs, affiche, slot, label);
  // The tab whose menu is open, and where: the menu sits at the pointer.
  const [menu, setMenu] = useState<{ zone: string; x: number; y: number } | null>(null);
  if (!occupee && dragging === null && !editing) return null;

  const plusieurs = tabs.length > 1;
  const commandes: CommandesColonne = { cote, zone, onAddTab, onCloseTab, onAddColumn, onRemoveColumn, onSwap, onCollapse };
  const aCommandes = !!(onAddTab || onCollapse || onSwap || onAddColumn || onRemoveColumn);
  const ouvrirSur = (z: string) => (itemsColonne(commandes, z).length > 0
    ? (x: number, y: number) => setMenu({ zone: z, x, y })
    : undefined);
  // Unnamed tabs are thin pills: they say there are tabs, not what they hold
  // (that is in their tooltip). A named one needs the line height for its
  // text, and a drag needs targets a card can be dropped on.
  const fines = !tabs.some((z) => noms?.[z]) && dragging === null;

  const contenu = (
    <>
      {plusieurs ? (
        // The column's own line: its tabs. Everything else about the column
        // is in the menu of a right click on them; the widgets' own controls
        // live on the widgets, never here.
        <div
          role="tablist"
          aria-label={i18n('chatPage.columnTabs')}
          className={cn(
            'flex min-w-0 shrink-0 items-center',
            fines ? 'gap-1' : 'gap-0.5 rounded-lg bg-muted p-[3px]',
          )}
        >
          {tabs.map((z, i) => (
            <OngletColonne
              key={z}
              zone={z}
              colonne={zone}
              rang={i + 1}
              label={label}
              nom={noms?.[z]}
              actif={z === affiche}
              fine={fines}
              titres={widgetsOf(z).map((w) => widget(w.id)?.titre ?? w.id)}
              onSelect={() => onSelectTab?.(z)}
              onMenu={ouvrirSur(z)}
            />
          ))}
        </div>
      ) : aCommandes && (
        <OngletUnique label={label} accent={editing} onMenu={ouvrirSur(zone)} />
      )}
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          label={i18n('chatPage.columnMenu', { column: label })}
          items={itemsColonne(commandes, menu.zone)}
          onClose={() => setMenu(null)}
        />
      )}
      <WidgetZone
        zone={affiche}
        slot={slot}
        label={tabs.length > 1 ? `${label} · ${noms?.[affiche] ?? i18n('chatPage.columnTab', { n: String(tabs.indexOf(affiche) + 1) })}` : label}
        className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-1"
      />
    </>
  );

  if (tiroir) {
    return (
      <PanneauTiroir
        id={tiroir.id}
        cote={cote}
        label={label}
        ouvert={tiroir.ouvert}
        onFermer={tiroir.onFermer}
        largeur={tiroir.largeur}
        glissement={dragging === null && !editing}
      >
        {contenu}
      </PanneauTiroir>
    );
  }

  return (
    <div
      // Pushed aside, the column stays mounted: that is what lets you see it
      // SLIDE, both ways. An unmount animates nothing, it cuts.
      // Off screen, it no longer takes clicks or tab stops, and the screen reader
      // no longer announces it.
      aria-hidden={ecartee || undefined}
      // `visibility` flips at the END of the exit slide and at the START of the
      // entry one: it is what removes the column from the tab order (React 18
      // does not render `inert`), and applying it right away would cut the
      // animation just written.
      style={{
        ...style,
        ...(ecartee ? {
          visibility: 'hidden',
          transitionDelay: '0s, 200ms',
          // Out by its own edge, past whatever lies between it and that edge.
          transform: cote === 'left'
            ? `translateX(calc(-100% - ${decalage + 16}px - var(--timon-nav-w, 0px)))`
            : `translateX(calc(100% + ${decalage + 16}px))`,
        } : {}),
      }}
      className={cn(
        'chat-widget-rail pointer-events-auto fixed z-[5] hidden min-h-0 flex-col gap-2 transition-[transform,visibility] duration-200 ease-out motion-reduce:transition-none lg:flex',
        ecartee && 'pointer-events-none',
        className,
      )}
    >
      {redimension && !ecartee && (
        <PoigneeLargeur cote={cote} label={i18n('chatPage.resizeColumn', { column: label })} redimension={redimension} />
      )}
      {contenu}
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
function useOngletsCaches(
  onglets: readonly string[],
  affiche: string,
  colonne: string,
  label: string,
): void {
  const { registerZone } = useWidgetHost();
  const caches = useMemo(
    () => onglets.flatMap((zone, i) => (zone === affiche ? [] : [{
      id: zone,
      slot: colonne,
      label: `${label} · ${i18n('chatPage.columnTab', { n: String(i + 1) })}`,
      hidden: true,
    }])),
    [onglets, affiche, colonne, label],
  );
  useEffect(() => {
    const jeter = caches.map((def) => registerZone(def));
    return () => { for (const d of jeter) d(); };
  }, [caches, registerZone]);
}

type Ouvrir = (x: number, y: number) => void;

type OngletProps = {
  zone: string;
  colonne: string;
  rang: number;
  label: string;
  /** The tab's own name, written in the pill. */
  nom?: string;
  /** A thin pill without text: no tab of the column has a name. */
  fine: boolean;
  titres: string[];
  onSelect: () => void;
  /** Opens the column menu on this tab. Absent = the menu would be empty. */
  onMenu?: Ouvrir;
};

/**
 * A column tab. The shown tab is only a button; the others are drop targets
 * too (`OngletCible`), in a separate component because dnd-kit keys its targets
 * by id and the last one registered wins: a shown tab registering its own
 * would shadow the end of its own zone.
 */
function OngletColonne({ actif, ...props }: OngletProps & { actif: boolean }) {
  return actif ? <BoutonOnglet {...props} actif /> : <OngletCible {...props} />;
}

/**
 * During a drag, a hidden tab is a target: dropping a card on it puts the card
 * at the end of that tab, without leaving the one being looked at. The id is
 * the end-of-zone one (`rail:`), which the host already resolves and names to
 * screen readers.
 */
function OngletCible(props: OngletProps) {
  const { dragging, accepts } = useWidgetHost();
  const admis = accepts({ id: props.zone, slot: props.colonne, label: props.label });
  const { setNodeRef, isOver } = useDroppable({
    id: zoneDropId(props.zone),
    data: { zone: props.zone },
    disabled: dragging === null || !admis,
  });
  return (
    <BoutonOnglet
      {...props}
      actif={false}
      cible={dragging !== null && admis}
      survole={isOver && dragging !== null && admis}
      refCible={setNodeRef}
    />
  );
}

/** The visible pill of a thin tab, inside a taller hit area. */
const PILULE_FINE = 'h-1.5 w-full rounded-full transition-colors group-focus-visible/onglet:ring-2 group-focus-visible/onglet:ring-ring';

function BoutonOnglet({
  rang,
  nom,
  fine,
  titres,
  onSelect,
  onMenu,
  actif,
  cible = false,
  survole = false,
  refCible,
}: OngletProps & {
  actif: boolean;
  cible?: boolean;
  survole?: boolean;
  refCible?: (node: HTMLElement | null) => void;
}) {
  const appuiMenu = useAppuiMenu(onMenu);
  const n = nom ?? String(rang);
  const description = titres.length > 0
    ? i18n('chatPage.columnTabCards', { n, titles: titres.join(', ') })
    : i18n('chatPage.columnTabEmpty', { n });
  return (
    <button
      ref={refCible}
      type="button"
      role="tab"
      aria-selected={actif}
      aria-label={description}
      title={onMenu ? `${description}\n${i18n('chatPage.columnMenuHint')}` : description}
      onClick={onSelect}
      {...appuiMenu}
      className={cn(
        'min-w-0 flex-1',
        fine
          ? 'group/onglet flex h-3 items-center rounded-full outline-none'
          : cn(
            'h-5 rounded-md px-2 text-[11px] font-medium transition-colors',
            actif
              ? 'bg-background text-foreground shadow-sm'
              : 'bg-background/30 hover:bg-background/60',
            cible && 'bg-background/50',
            survole && 'bg-primary/15 text-foreground',
            nom && 'truncate',
          ),
      )}
    >
      {fine ? (
        <span
          aria-hidden
          className={cn(PILULE_FINE, actif ? 'bg-muted-foreground/45' : 'bg-muted group-hover/onglet:bg-muted-foreground/25')}
        />
      ) : nom}
    </button>
  );
}

/**
 * The tab of a column that has only one: a thin pill without text, there to
 * carry the column menu (right click, Menu key, long press — or a plain click,
 * since it has nothing else to do). Firmer while the layout is being edited.
 */
function OngletUnique({ label, accent, onMenu }: { label: string; accent: boolean; onMenu?: Ouvrir }) {
  const appuiMenu = useAppuiMenu(onMenu);
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
      {...appuiMenu}
      className="group/onglet flex h-3 w-full shrink-0 items-center rounded-full outline-none"
    >
      <span
        aria-hidden
        // A short grip in the middle, not a bar across the column: full width,
        // it read as a separator line. The whole row stays the hit area.
        className={cn(PILULE_FINE, 'mx-auto max-w-12', accent ? 'bg-muted-foreground/30' : 'bg-foreground/[0.08]', 'group-hover/onglet:max-w-none group-hover/onglet:bg-muted-foreground/25')}
      />
    </button>
  );
}
