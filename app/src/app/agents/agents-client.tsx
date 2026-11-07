'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { openChat } from '@/lib/chat-navigation';
import { chatHref } from '@/lib/chat-island-params';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { SlotRegion } from '@/lib/plugin-host/render';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as d3 from 'd3';
import { graphNodeFace, type GraphFace } from '@/lib/graph-face';
import type { AgentLook } from '@/components/mascot/agent-look';
import { LiveAgentMascot } from '@/components/mascot/live-agent-mascot';
import { resolveRole, roleIconSvg } from '@/lib/roles';
import { ListTodo, ListTree, Maximize2, MessageSquare, Plus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { onAgentStateEvent } from '@/lib/active-agents';
import { TaskFormModal } from '@/components/task-form-modal';
import { MobileAgentList } from '@/components/mobile-agent-list';
import { t as i18n } from '@/lib/i18n';
import type { ActiveAgent } from '@/lib/agent-state';
import { livenessHint } from '@/plugins-client/missions/liveness-badge';
import { mainAgentOf, mainSeatCandidates } from '@/lib/main-agent';
import { MainSeatNotice } from './main-seat-notice';
import { resolveHierarchy, workspaceNodeId } from '@/lib/hierarchy';
import { planDrop, type DropPlan } from '@/lib/hierarchy-drop';
import { applyPlan, setProjectPole, setReportsTo, type MoveSnapshot } from './hierarchy-actions';
import { DuplicateAgentDialog } from '@/components/duplicate-agent-dialog';
import { NodeMenu, type MenuTarget } from './node-menu';
import { ORG_ROOT, OrgTree } from './org-tree';
import { PoleDialog } from './pole-dialog';
import { FAN_CLAIM, framesOf, layoutForest, type Frame } from '@/lib/graph-layout';
import {
  descendantsOf,
  inheritedOffset,
  ownOffsetAt,
  parentsOf,
  parsePins,
  PIN_MIN_MOVE,
  PINS_STORAGE_KEY,
  reaimAnchors,
  serializePins,
  totalOffset,
} from '@/lib/graph-pins';
import { leadsItsProject, nodeCaption, nodeInitials } from '@/lib/graph-labels';
import { FOLD_STORAGE_KEY, foldedStates, foldsHiding, foldView, parseFoldOverrides, toggleFold } from '@/lib/graph-fold';
import { AGENTS_CHANGED_EVENT } from '@/lib/agents-changed';
import { machineScopedStorage } from '@/lib/machines/machine-storage';

type LiveAgent = {
  name: string;
  main?: boolean;
  kind?: string;
  role?: string | null;
  model?: string;
  project?: string | null;
  reports_to?: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  /** Mascot look and picked head (`config.look`, `config.avatar`), read by `graphNodeFace`. */
  look?: unknown;
  avatar?: unknown;
  ephemeral?: boolean;
};

/** A pole (workspace) as GET /api/workspaces returns it. */
export type PoleRecord = {
  slug: string;
  name: string;
  color: string | null;
  lead_agent: string | null;
  projects: string[];
};

type Node = {
  id: string;
  kind: string;
  status: string;
  lastAction: string;
  isMain: boolean;
  spawnedBy: string | null;
  model: string;
  tokIn: number;
  tokOut: number;
  cost: number;
  spawnedAt: number;
  events: number;
  tools: string[];
  log: { t: string; type: string; msg: string }[];
  active: boolean;
  live?: boolean;
  project?: string | null;
  /** Color / glyph / workspace derived from the project meta. Pre-mixed
   *  here rather than at render time so we can filter by workspace in O(n)
   *  without touching the project→meta mapping on every tick. */
  projectColor?: string | null;
  projectIcon?: string | null;
  workspace?: string | null;
  /** Agent visual identity. When set, takes priority over the project
   *  values (stroke color + center glyph). */
  agentColor?: string | null;
  agentEmoji?: string | null;
  agentIconUrl?: string | null;
  /** The agent's head, resolved like `AgentAvatar` (picked mode first). Absent on a pole. */
  face?: GraphFace;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
  /** Soft anchor target — where the layoutStar() wants this node.
   *  The forceX/forceY anchor force pulls each node toward (tx,ty),
   *  giving a spring-mass feel: drag a node and its neighbours wobble
   *  via the link force, then everyone settles back. */
  tx?: number;
  ty?: number;
  /** Branch id (= the cluster's lead id, or '_main', or self for an
   *  orphan). Used by the `branchRepel` force to repel ONLY nodes from
   *  different branches → clusters repel one another and don't cross,
   *  without stiffening the inside of a cluster. */
  branch?: string;
  /** Link rest length to its parent, from the seed layout. */
  rest?: number | null;
  /** Explicit manager (config `reports_to`), null when on the default. */
  reportsTo?: string | null;
  /** Slug of the pole this agent leads. */
  hubOf?: string | null;
  /** Set on the grouping node of a pole that has no lead agent. */
  pole?: { slug: string; name: string } | null;
  /** Agents hidden under this node while it is folded (0 when open). */
  hiddenBelow?: number;
  /** Place the layout computed, before any offset the user dragged in. */
  seedX?: number;
  seedY?: number;
};

/** What the node menu needs to offer folding a node. */
export type FoldInfo = { folded: boolean; hidden: number };

/** Text inside a node: its emoji, or the initials of its caption when it
 *  has no picture — never a word, which overflowed the disc. */
function centreText(d: Node): string {
  if (nodeIconUrl(d) || d.face?.look) return '';
  if (d.pole) return nodeInitials(d);
  if (d.face) return d.face.glyph || nodeInitials(d);
  return d.projectIcon || d.agentEmoji || nodeInitials(d);
}

/** Initials take the agent's or the project's colour; an emoji keeps its own. */
function centreFill(d: Node): string | null {
  if (d.face) return d.face.iconUrl || d.face.look || d.face.glyph ? null : d.agentColor || d.projectColor || null;
  if (nodeIconUrl(d) || d.projectIcon || d.agentEmoji) return null;
  return d.agentColor || d.projectColor || null;
}

/** Icon URL to display at the center of a node, if any: the agent's
 *  icon_url takes priority, otherwise the project icon — ONLY if it's an
 *  http(s) URL. Returns null if the icon is text (emoji/initials) or absent,
 *  in which case the node's center renders text. Avoids showing the raw URL. */
function nodeIconUrl(d: { agentIconUrl?: string | null; projectIcon?: string | null; face?: GraphFace }): string | null {
  if (d.face) return d.face.iconUrl;
  const c = d.agentIconUrl || d.projectIcon;
  // http(s) OR a relative path served by TIMON (uploaded icon `/api/uploads/...`).
  return c && (c.startsWith('http://') || c.startsWith('https://') || c.startsWith('/')) ? c : null;
}

/** Radius of a node's disc (`circle.node-core`). */
function nodeRadius(d: { isMain: boolean }): number {
  return d.isMain ? 30 : 20;
}

/** A node's mascot, as the D3 join hands it to React. */
type GraphMascot = { id: string; el: HTMLElement; look: AgentLook; size: number };

function sameMascots(a: readonly GraphMascot[], b: readonly GraphMascot[]): boolean {
  return a.length === b.length && a.every((m, i) => {
    const o = b[i]!;
    return m.id === o.id && m.el === o.el && m.size === o.size && JSON.stringify(m.look) === JSON.stringify(o.look);
  });
}

const KIND_HUES: Record<string, string> = {
  research: '#9ec7ff',
  coder: '#a8e3a3',
  browser: '#ffd28b',
  filesystem: '#c8b8ff',
  planner: '#ffc18a',
  memory: '#f0a4d4',
  web: '#9fe0d4',
  shell: '#d6d6d6',
  calendar: '#ffd58a',
  mail: '#a3d8ff',
};

/** LEGACY glyph for NON-role kinds (browser/filesystem/web/…) that have
 *  no role equivalent. Real roles (coder/reviewer/…) are now rendered via
 *  the canonical lucide picto from `@/lib/roles` (roleIconSvg) — these role
 *  entries now only serve as a fallback. */
const KIND_GLYPH: Record<string, string> = {
  coder: '⚒',
  code: '⚒',
  research: '🔎',
  planner: '🗺',
  reviewer: '👁',
  review: '👁',
  merger: '⛙',
  merge: '⛙',
  browser: '🌐',
  filesystem: '📁',
  memory: '🧠',
  web: '🌐',
  shell: '$',
  calendar: '📅',
  mail: '✉',
  doc: '📖',
  chore: '🔧',
};

function colorFor(k: string) {
  return KIND_HUES[k] || '#cccccc';
}

function kfmt(n: number) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function AgentsClient() {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  /** Bridge between the workspace effect (which reacts to the switch) and
   *  the big D3 effect (which holds render/sim/layoutStar in closure). The
   *  big effect publishes its re-filter function here; the workspace effect
   *  calls it. */
  const redrawRef = useRef<(() => void) | null>(null);
  /** Same idea: the D3 closure publishes its zoom-to-fit function
   *  ("auto-fit") here, called by the floating button and after every
   *  re-layout (workspace switch, load, resize). */
  const fitRef = useRef<(() => void) | null>(null);
  /** Current workspace read by the D3 closure (a ref, not React state, so
   *  it stays accessible from the big effect with `[]` deps). */
  const workspaceRef = useRef<string>('all');

  // Stats panel removed from the navbar — we keep the computation (feeds
  // other potential derivatives and the missions polling) but the value is
  // no longer read.
  const [, setStats] = useState({ active: 0, events: 0, cost: 0 });
  const [showNewTask, setShowNewTask] = useState(false);
  /** Mobile-only: toggle for the Notifications sidebar. */
  const [agentNames, setAgentNames] = useState<string[]>([]);
  // What the hierarchy gestures work on — the same lists the graph was built
  // from, republished by every load().
  const [graphAgents, setGraphAgents] = useState<LiveAgent[]>([]);
  const [mainAgent, setMainAgent] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [poleDialog, setPoleDialog] = useState<{ pole: PoleRecord | null } | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const [orgOpen, setOrgOpen] = useState(false);
  /** Nodes whose head is their mascot, published by every D3 join. */
  const [mascots, setMascots] = useState<GraphMascot[]>([]);
  /** Bridges from the D3 closure (drag end, right click) to React. */
  const dropRef = useRef<((source: string, target: string) => void) | null>(null);
  const menuRef = useRef<((target: MenuTarget) => void) | null>(null);
  /** The router, for the D3 closure's click: a chat opens without reloading the app. */
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  /** Folding, published by the D3 closure: state of a node, and its toggle. */
  const foldRef = useRef<{ info: (id: string) => FoldInfo | null; toggle: (id: string) => void } | null>(null);
  /** Hand-placed nodes, published by the D3 closure. */
  const pinRef = useRef<{ has: (id: string) => boolean; reset: (id: string) => void } | null>(null);
  /** Current workspace — filters the graph: on switch we redraw the
   *  constellation with only the workspace's nodes/links (+ `_main`), and
   *  the D3 simulation only runs on that subset (a full re-layout, vs. the
   *  old opacity fade). Persisted in localStorage to keep the selection
   *  after a reload. */
  const [workspace, setWorkspaceState] = useState<string>('all');
  const [poles, setPoles] = useState<PoleRecord[]>([]);
  /** The D3 effect publishes its reload here: page actions (new pole, moved
   *  agent) call it once the daemon has accepted the change. */
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  const setWorkspace = useCallback((w: string) => {
    setWorkspaceState(w);
    if (typeof window !== 'undefined') {
      if (w === 'all') machineScopedStorage(window.localStorage).removeItem('timon:workspace');
      else machineScopedStorage(window.localStorage).setItem('timon:workspace', w);
    }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = machineScopedStorage(window.localStorage).getItem('timon:workspace');
    if (stored) setWorkspaceState(stored);
  }, []);

  // Workspace switch: we no longer hide out-of-workspace nodes. Leads are
  // grouped by workspace into contiguous arcs (layoutStar), and the toggle
  // moves the CAMERA (pan/zoom) to the current workspace's zone while
  // DIMMING the rest (reduced opacity) — `_main` always stays at full
  // opacity since it's the shared hub. "all" = global fit, everything at
  // full opacity. The actual logic (focusWorkspace) lives in the big D3
  // effect (render/sim closure) and is exposed via redrawRef; here we only
  // push the current workspace and trigger the focus.
  useEffect(() => {
    workspaceRef.current = workspace;
    redrawRef.current?.();
  }, [workspace, poles]);
  // A pole remembered from a previous visit that no longer exists would dim
  // the whole graph: fall back to everything.
  useEffect(() => {
    if (poles.length && workspace !== 'all' && !poles.some((p) => p.slug === workspace)) setWorkspace('all');
  }, [poles, workspace, setWorkspace]);

  const hierarchy = useMemo(
    () => resolveHierarchy(graphAgents, poles, graphAgents.length ? mainAgent : null),
    [graphAgents, poles, mainAgent],
  );
  // An empty seat is a state of the page, not a gap to fill with a guess
  // (TIM-0143): it is said, and the eligible agents are offered.
  const seatCandidates = useMemo(
    () => (graphAgents.length && !mainAgent ? mainSeatCandidates(graphAgents) : null),
    [graphAgents, mainAgent],
  );
  const reload = useCallback(() => { void loadRef.current?.(); }, []);

  /** Runs a move, then offers to undo it from the confirmation toast. */
  const runMove = useCallback(
    async (message: string, run: () => Promise<{ error: string | null; undo?: () => Promise<string | null> }>) => {
      const { error, undo } = await run();
      reload();
      if (error) {
        toast.error(i18n('agentsPage.actionFailed', { error }));
        return;
      }
      toast.success(message, undo ? {
        action: {
          label: i18n('agentsPage.undo'),
          onClick: () => {
            void undo().then((failed) => {
              reload();
              if (failed) toast.error(i18n('agentsPage.actionFailed', { error: failed }));
              else toast(i18n('agentsPage.undone'));
            });
          },
        },
      } : undefined);
    },
    [reload],
  );

  const snapshotOf = useCallback((agent: string): MoveSnapshot => {
    const a = graphAgents.find((x) => x.name === agent);
    const project = a?.project?.toLowerCase();
    const slug = project ? hierarchy.workspaceOfProject.get(project) : undefined;
    return { reportsTo: a?.reports_to ?? null, projectPole: slug ? poles.find((p) => p.slug === slug)?.name ?? null : null };
  }, [graphAgents, hierarchy, poles]);

  const runPlan = useCallback((plan: DropPlan) => {
    if (plan.kind === 'none') {
      if (plan.reason === 'not-a-project') toast.info(i18n('agentsPage.dropNotProject'));
      if (plan.reason === 'not-the-lead') toast.info(i18n('agentsPage.dropNotLead'));
      return;
    }
    const before = snapshotOf(plan.agent);
    const message = plan.kind === 'reportsTo'
      ? i18n('agentsPage.movedReports', { agent: plan.agent, manager: plan.manager })
      : i18n('agentsPage.movedProject', { project: plan.project, pole: plan.pole.name });
    void runMove(message, () => applyPlan(plan, before));
  }, [runMove, snapshotOf]);

  /** Hands an agent back to its default manager (no explicit reports_to). */
  const resetManager = useCallback((agent: string) => {
    const before = snapshotOf(agent);
    if (!before.reportsTo) return;
    void runMove(i18n('agentsPage.movedDefault', { agent }), async () => ({
      error: await setReportsTo(agent, null),
      undo: () => setReportsTo(agent, before.reportsTo),
    }));
  }, [runMove, snapshotOf]);

  const onDrop = useCallback((source: string, target: string) => {
    if (target === ORG_ROOT) { resetManager(source); return; }
    runPlan(planDrop(source, target, graphAgents, poles, hierarchy));
  }, [graphAgents, poles, hierarchy, runPlan, resetManager]);

  const onReportsTo = useCallback((agent: string, manager: string | null) => {
    if (manager === null) resetManager(agent);
    else runPlan({ kind: 'reportsTo', agent, manager });
  }, [resetManager, runPlan]);

  const onMovePole = useCallback((agent: string, project: string, pole: PoleRecord | null) => {
    if (pole) {
      const a = graphAgents.find((x) => x.name === agent);
      runPlan({ kind: 'moveProject', agent, project, pole, clearReportsTo: !!a?.reports_to });
      return;
    }
    const before = snapshotOf(agent);
    if (!before.projectPole) return;
    void runMove(i18n('agentsPage.removedProject', { project }), async () => ({
      error: await setProjectPole(project, null),
      undo: () => setProjectPole(project, before.projectPole),
    }));
  }, [graphAgents, runPlan, runMove, snapshotOf]);

  useEffect(() => {
    dropRef.current = onDrop;
    menuRef.current = setMenu;
  }, [onDrop]);

  // The D3 simulation lives in a ref so React renders don't recreate it.
  const stateRef = useRef<{
    nodes: Node[];
    links: { source: any; target: any }[];
    totalEvents: number;
    totalCost: number;
    filter: string;
  }>({
    nodes: [],
    links: [],
    totalEvents: 0,
    totalCost: 0,
    filter: '',
  });

  // Live agent-state mirror: poll /api/ui/agents/active and stamp a
  // `data-state` attribute on each matching <g.node>. The CSS rules below
  // pick that up to colour the pulse-ring / status-dot the same way the
  // chat topbar strip does, so the canvas reflects "thinking / needs you
  // / done" without bespoke per-event animations. Idle agents get the
  // attribute cleared, falling back to the legacy styling.
  // Hidden agent → the folded node that stands for it (cf. applyFilter), so
  // an agent working under a fold still lights the bubble that hides it.
  const hiddenOwnerRef = useRef<Map<string, string>>(new Map());
  const liveStatesRef = useRef<Map<string, string>>(new Map());
  // Fine state per agent (finished turn / open / cut), for the small dot on a node.
  const liveInfoRef = useRef<Map<string, ActiveAgent>>(new Map());
  // Repaints from the last poll; applyFilter calls it after a fold change
  // rather than leaving the bubble stale until the next 4 s tick.
  const paintStatesRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    function paint() {
      const svgEl = stageRef.current;
      if (!svgEl) return;
      const shown = foldedStates(liveStatesRef.current, hiddenOwnerRef.current);
      const nodes = svgEl.querySelectorAll<SVGGElement>('g.node[data-id]');
      nodes.forEach((g) => {
        const id = g.getAttribute('data-id');
        if (!id) return;
        // Written only on change: every write re-styles the graph, and
        // this runs every 4 s on every node.
        const s = shown.get(id) ?? null;
        if (g.getAttribute('data-state') !== s) {
          if (s) g.setAttribute('data-state', s);
          else g.removeAttribute('data-state');
        }
        // The ring above says "working"; this dot says what the others are —
        // a live process whose turn ended, an open mission, a cut one.
        const info = liveInfoRef.current.get(id);
        const fine = info?.liveness === 'turn_done' || info?.liveness === 'open' || info?.liveness === 'interrupted' ? info.liveness : null;
        if (g.getAttribute('data-liveness') !== fine) {
          if (fine && info) {
            g.setAttribute('data-liveness', fine);
            const tip = g.querySelector('.liveness-dot title');
            if (tip) {
              tip.textContent = [
                i18n(`missionLiveness.${fine}`) + ' — ' + livenessHint({ liveness: fine, interrupted_reason: info.interrupted_reason ?? null }),
                info.pending_messages ? i18n('missionLiveness.pendingMessages', { count: info.pending_messages }) : '',
                info.open_deliveries ? i18n('missionLiveness.openDeliveries', { count: info.open_deliveries }) : '',
              ].filter(Boolean).join(' · ');
            }
          } else g.removeAttribute('data-liveness');
        }
        const ring = g.querySelector('.pulse-ring');
        if (ring) {
          let on = s === 'thinking' || s === 'needs_action' ? true : s === 'done' ? false : null;
          // A ring lit only by a hidden agent goes dark once the fold opens
          // or that agent stops, where an agent's own state leaves it as is.
          const byFold = on === true && s !== liveStatesRef.current.get(id);
          if (on === null && g.hasAttribute('data-fold-lit')) on = false;
          if (byFold) g.setAttribute('data-fold-lit', '');
          else g.removeAttribute('data-fold-lit');
          if (on !== null && ring.classList.contains('on') !== on) ring.classList.toggle('on', on);
        }
      });
    }
    paintStatesRef.current = paint;

    async function refresh() {
      try {
        const r = await fetch('/api/ui/agents/active', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { agents: ActiveAgent[] };
        if (cancelled) return;
        liveStatesRef.current = new Map(j.agents.map((a) => [a.name, a.state]));
        liveInfoRef.current = new Map(j.agents.map((a) => [a.name, a]));
        paint();
      } catch { /* ignore */ }
    }
    refresh();
    timer = setInterval(refresh, 4000);
    const stopStateEvents = onAgentStateEvent(() => { void refresh(); });
    return () => {
      cancelled = true;
      paintStatesRef.current = () => {};
      if (timer) clearInterval(timer);
      stopStateEvents();
    };
  }, []);

  useEffect(() => {
    const svgEl = stageRef.current;
    if (!svgEl) return;
    const state = stateRef.current;

    // `state.nodes` / `state.links` = master (everything that exists, fed
    // by the loader + refreshNodeStats). `viewNodes` / `viewLinks` = the
    // subset actually rendered and simulated, derived from the master
    // according to the current workspace. render() / layoutStar() / the
    // simulation operate on the VIEW; the master remains the global source
    // of truth.
    let viewNodes: Node[] = [];
    let viewLinks: { source: any; target: any }[] = [];
    // Constellation frames of the last layout (cf. layoutStar).
    let frames: Map<string, Frame> | null = null;
    // Timer for the deferred auto-fit (cf. applyFilter).
    let fitTimer: number | null = null;
    // The agent the daemon flags as main when the list lands — never the
    // `_main` literal, which onboarding renames away. `null` is an empty seat:
    // no node is drawn as main and nobody is hung under a stand-in (TIM-0143).
    let mainName: string | null = null;
    // Agents that report to nobody, from the last load. With an empty seat the
    // real root is one of them, not the main node, and must not start folded.
    let rootAgents = new Set<string>();
    // Agents of the previous load: one that appears later is revealed, never left under a fold.
    let knownAgents: Set<string> | null = null;

    const svg = d3.select(svgEl);
    let labelsOff = false;
    const viewport = svg.select<SVGGElement>('#viewport');
    const gLinks = viewport.select<SVGGElement>('#links');
    const gFlows = viewport.select<SVGGElement>('#flows');
    const gNodes = viewport.select<SVGGElement>('#nodes');
    let tickLinks = gLinks.selectAll<SVGPathElement, any>('path.link');
    let tickNodes = gNodes.selectAll<SVGGElement, Node>('g.node');
    let flowOf = new Map<unknown, SVGPathElement>();

    // Pan / pinch-zoom: D3 zoom on the SVG, applied to the viewport group.
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.12, 6])
      .on('zoom', (e) => {
        target = e.transform;
        // A wheel gesture is scaled by the compositor and the graph redrawn
        // once it pauses; anything else (a pan, a fit transition) is drawn
        // at most once per frame. Redrawing the SVG — every caption, every
        // gradient — at each wheel notch was what made zooming crawl.
        const wheel = (e.sourceEvent as Event | null)?.type === 'wheel';
        if (settleTimer != null) window.clearTimeout(settleTimer);
        settleTimer = wheel ? window.setTimeout(() => { settleTimer = null; paintZoom(false); }, 120) : null;
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => paintZoom(wheel));
      });
    // Transform drawn into the SVG, and the one d3-zoom asks for.
    let committed = d3.zoomIdentity;
    let target = d3.zoomIdentity;
    let frame = 0;
    let settleTimer: number | null = null;
    const stageEl = svgEl.parentElement as HTMLElement;
    function paintZoom(fast: boolean) {
      frame = 0;
      if (fast) {
        // The stage layer shows `target` by scaling what `committed` drew.
        const kr = target.k / committed.k;
        stageEl.style.transform = `translate(${target.x - kr * committed.x}px, ${target.y - kr * committed.y}px) scale(${kr})`;
        return;
      }
      stageEl.style.transform = '';
      viewport.attr('transform', target.toString());
      committed = target;
      // Zoomed out, the names are unreadable anyway: they only come back
      // on hover (pole names excepted), which declutters the whole graph.
      // Written only when the threshold is crossed: rewriting the class on
      // every frame re-styled the whole graph each time.
      const off = target.k < 0.6;
      if (off !== labelsOff) {
        labelsOff = off;
        svg.classed('labels-off', off);
      }
    }
    svg.call(zoom);

    // The stage's frame is `fixed inset-0`: the window alone, the page's
    // island in the island workspace (§1), where `fixed` resolves against
    // the island. Its size, not the window's, is the room the graph has.
    const frameEl = svgEl.parentElement ?? svgEl;
    const frameSize = () => ({ w: frameEl.clientWidth || window.innerWidth, h: frameEl.clientHeight || window.innerHeight });
    let W = frameSize().w;
    let H = frameSize().h;
    const consoleH = 200;
    // Read on the stage, not the document root: the island workspace sets
    // them to 0 for what it holds — no nav rail, no top bar in an island.
    const chromeVar = (name: string, fallback: number) => {
      const n = parseInt(getComputedStyle(frameEl).getPropertyValue(name), 10);
      return Number.isFinite(n) ? n : fallback;
    };
    // Actual TopBar height (fixed, overlaid on the canvas), read live from
    // the CSS variable published by components/topbar.tsx — the active
    // agents row makes it vary, so a fixed number regularly underestimated
    // the occupied space and let fitNodes() wedge nodes under the header
    // (e.g. a .main agent's avatar clipped at the top of the screen).
    const topInset = () => chromeVar('--timon-topbar-h', 72) + 16;
    // On mobile (W < 640) we tighten the constellation: less room, so no
    // reason to keep the desktop spacing. Linear scale between 0.45 (very
    // narrow) and 1 (≥ 768 px). Recomputed on resize.
    const layoutScale = () => Math.max(0.45, Math.min(1, W / 768));

    // Pole hub: the agent leading a pole, or the grouping node of a pole
    // without one. Heavier anchor and charge.
    const isHub = (d: Node) => !!d.hubOf || !!d.pole;

    // Only the orchestrators show by default: the main agent, the pole hubs
    // and any other root stay open, every other agent with sub-agents starts
    // folded.
    const foldedByDefault = (d: Node) => !d.isMain && !isHub(d) && !rootAgents.has(d.id);
    let foldOverrides = parseFoldOverrides(machineScopedStorage(window.localStorage).getItem(FOLD_STORAGE_KEY));
    const isFolded = (d: Node) => foldOverrides.get(d.id) ?? foldedByDefault(d);
    let foldParents = new Set<string>();

    const anchorX = (d: Node) => d.tx ?? W / 2;
    const anchorY = (d: Node) => d.ty ?? (H - consoleH) / 2 + 16;
    const sim = d3
      .forceSimulation<Node>(viewNodes)
      .force(
        'link',
        d3
          .forceLink<Node, any>(viewLinks)
          .id((d) => d.id)
          // Rest length = the seed distance (cf. layoutStar), so link and
          // anchor pull toward the SAME target and nothing fights the layout.
          .distance((l: any) => (l.target as Node).rest ?? 130 * layoutScale())
          .strength(0.6),
      )
      .force(
        'charge',
        // Weak and short-ranged: the seed already spaces everything, charge
        // only adds a little organic give around it.
        d3.forceManyBody<Node>().strength((d) => (d.isMain || isHub(d) ? -260 : -120)).distanceMax(260),
      )
      .force(
        'collide',
        // A sub-agent's radius matches FAN_CLAIM (graph-layout.ts), or the
        // collision would push a fan back out to its old length.
        d3.forceCollide<Node>().radius((d) => (d.isMain ? 70 : isHub(d) ? 62 : FAN_CLAIM)),
      )
      // Anchor: each node has a target (tx,ty) set by layoutStar(), which
      // already guarantees the spacing; the spring is firm enough that the
      // forces only wobble around it (a dragged node pulls its neighbours,
      // then everyone settles back). No centering force: the seed places the
      // largest constellation at the centre itself.
      .force(
        'anchorX',
        d3
          .forceX<Node>(anchorX)
          .strength((d) => (d.isMain || isHub(d) ? 0.45 : 0.35)),
      )
      .force(
        'anchorY',
        d3
          .forceY<Node>(anchorY)
          .strength((d) => (d.isMain || isHub(d) ? 0.45 : 0.35)),
      )
      .alphaDecay(0.04)
      // The seed already places everything: stop once the give around it is
      // imperceptible rather than ticking on for another second.
      .alphaMin(0.01);

    // ── INTER-BRANCH repulsion: clusters (lead + its sub-agents) repel one
    //    another so they never overlap → their links don't cross. INSIDE a
    //    cluster, nothing is repelled: link + charge keep the cohesion, so
    //    dragging a node does pull its neighbors along (no stiffening).
    //    O(n²), ~100 nodes on a busy install.
    let repelNodes: Node[] = [];
    function branchRepel(alpha: number) {
      const minSep = 118 * layoutScale(); // min gap between 2 nodes of different branches
      const n = repelNodes.length;
      for (let i = 0; i < n; i++) {
        const a = repelNodes[i];
        if (!a) continue;
        const ax = a.x ?? 0;
        const ay = a.y ?? 0;
        for (let j = i + 1; j < n; j++) {
          const b = repelNodes[j];
          if (!b) continue;
          // Same branch → let link/charge do their job; we only repel
          // nodes belonging to different clusters.
          if (a.branch && b.branch && a.branch === b.branch) continue;
          let dx = (b.x ?? 0) - ax;
          let dy = (b.y ?? 0) - ay;
          let d = Math.sqrt(dx * dx + dy * dy);
          if (d < 1e-6) {
            dx = (j - i) * 0.5;
            dy = 0;
            d = Math.abs(dx) || 1;
          }
          if (d < minSep) {
            const push = ((minSep - d) / d) * alpha * 0.5;
            const ox = dx * push;
            const oy = dy * push;
            // `_main` is the hub: we don't push it (centered elsewhere).
            if (!a.isMain) {
              a.x = ax - ox;
              a.y = ay - oy;
            }
            if (!b.isMain) {
              b.x = (b.x ?? 0) + ox;
              b.y = (b.y ?? 0) + oy;
            }
          }
        }
      }
    }
    (branchRepel as any).initialize = (nodes: Node[]) => {
      repelNodes = nodes;
    };
    sim.force('branchRepel', branchRepel as any);

    function cssEscape(s: string) {
      return typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(s)
        : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    // Nodes whose ring paintActive last lit, so a fold change can put out
    // the ones a hidden agent no longer lights.
    const litNodes = new Set<string>();
    function paintActive(id: string) {
      const n = state.nodes.find((x) => x.id === id);
      if (!n) return;
      const sel = gNodes.select<SVGGElement>(`g.node[data-id="${cssEscape(id)}"]`);
      if (sel.empty()) return;
      const owner = hiddenOwnerRef.current;
      const on = !!n.active || state.nodes.some((x) => x.active && owner.get(x.id) === id);
      const ring = sel.select('.pulse-ring');
      if (on) {
        litNodes.add(id);
        const rStart = n.isMain ? 34 : 22;
        const rEnd = n.isMain ? 70 : 50;
        ring
          .style('--r-start', rStart + 'px')
          .style('--r-end', rEnd + 'px')
          .attr('r', rEnd)
          .classed('on', true);
        sel.select('.halo').attr('opacity', n.isMain ? 0.95 : 0.8);
      } else {
        litNodes.delete(id);
        ring.classed('on', false).attr('r', n.isMain ? 34 : 22);
        sel.select('.halo').attr('opacity', n.isMain ? 0.8 : 0.35);
      }
    }
    function repaintActive() {
      const owner = hiddenOwnerRef.current;
      const ids = new Set(litNodes);
      state.nodes.forEach((x) => { if (x.active) ids.add(owner.get(x.id) ?? x.id); });
      ids.forEach(paintActive);
    }

    function showTip(e: MouseEvent, d: Node) {
      const tip = tipRef.current;
      if (!tip) return;
      const name = tip.querySelector('.t-name') as HTMLElement | null;
      const status = tip.querySelector('.t-status') as HTMLElement | null;
      const last = tip.querySelector('.t-last') as HTMLElement | null;
      const swatch = tip.querySelector('.swatch') as HTMLElement | null;
      const dot = tip.querySelector('.status .d') as HTMLElement | null;
      if (name) name.textContent = d.project && !d.pole ? `${d.id} · ${d.project}` : d.pole?.name ?? d.id;
      if (status) status.textContent = d.status || 'idle';
      if (last) last.textContent = d.lastAction || '—';
      const color = d.isMain ? 'hsl(var(--primary))' : colorFor(d.kind);
      if (swatch) swatch.style.background = color;
      if (dot) dot.style.background = d.active ? 'hsl(var(--primary))' : 'hsl(var(--success))';
      tip.classList.add('on');
      moveTip(e);
    }
    function moveTip(e: MouseEvent) {
      const tip = tipRef.current;
      if (!tip) return;
      // The tooltip is `fixed` in the page's box: the window alone, the
      // island in the workspace. The pointer is in window coordinates.
      const origin = rootRef.current?.getBoundingClientRect();
      tip.style.left = e.clientX - (origin?.left ?? 0) + 'px';
      tip.style.top = e.clientY - (origin?.top ?? 0) - 18 + 'px';
    }
    function hideTip() {
      tipRef.current?.classList.remove('on');
    }

    // Recomputes the VIEW from the master + current workspace, then
    // re-layouts and re-renders. render()'s data-join removes (exit) the
    // filtered-out nodes and re-adds (enter) the ones coming back; the
    // simulation only runs on the view. No SVG teardown → the tick/zoom
    // handlers (bound once on persistent groups) stay intact, and the drag
    // listeners of removed nodes leave with their <g> via exit().remove().
    // Semantics: `_main` always visible; a node with no workspace is only
    // visible in "all". ALL nodes are NOW always rendered: the workspace
    // toggle no longer hides them (the old `isVisible`), it reframes the
    // camera on the workspace's zone and dims the rest (cf. focusWorkspace).
    // A node with no workspace stays visible and is only dimmed when a
    // named workspace is focused.
    function applyFilter(refit = true) {
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      const idOf = (e: any): string => (typeof e === 'object' && e ? e.id : e);
      const fold = foldView(
        state.nodes.map((n) => n.id),
        state.links.map((l) => ({ source: idOf(l.source), target: idOf(l.target) })),
        (id) => { const n = byId.get(id); return !!n && isFolded(n); },
      );
      foldParents = fold.parents;
      hiddenOwnerRef.current = fold.hiddenOwner;
      viewNodes = state.nodes.filter((n) => !fold.hidden.has(n.id));
      viewNodes.forEach((n) => { n.hiddenBelow = fold.hiddenBelow.get(n.id) ?? 0; });
      const visibleIds = new Set(viewNodes.map((n) => n.id));
      viewLinks = state.links.filter((l) => {
        const s = typeof l.source === 'object' && l.source ? l.source.id : l.source;
        const t = typeof l.target === 'object' && l.target ? l.target.id : l.target;
        return visibleIds.has(s) && visibleIds.has(t);
      });
      layoutStar();
      render();
      repaintActive();
      paintStatesRef.current();
      // After an edit made on this page the camera stays where the user is.
      if (!refit) return;
      // Reframes the view AFTER the forces have settled (otherwise we'd
      // frame the tight seed, then the constellation would spread and
      // overflow). Deferred + deduplicated via fitTimer. In "all" → global
      // fit; otherwise we (re)focus the current workspace's zone.
      if (fitTimer != null) window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        if (workspaceRef.current === 'all') fitToView(true);
        else focusWorkspace();
      }, 750);
    }

    // The node a dragged node is released onto: the closest one whose disc it
    // overlaps (graph coordinates, the space fx/fy live in).
    function dropTargetAt(dragged: Node, x: number, y: number): Node | null {
      let best: Node | null = null;
      let bestD = 34;
      // Its own sub-tree travels with it: never a target (nor a cycle).
      const carried = new Set(dragGroup.map((g) => g.n));
      for (const n of viewNodes) {
        if (n === dragged || carried.has(n) || n.x == null || n.y == null) continue;
        const dist = Math.hypot(n.x - x, n.y - y);
        if (dist < bestD) { bestD = dist; best = n; }
      }
      return best;
    }
    function markDropTarget(target: Node | null) {
      gNodes.selectAll<SVGGElement, Node>('g.node').classed('drop-target', (n) => n === target);
    }

    function render() {
      const lk = gLinks
        .selectAll<SVGPathElement, any>('path.link')
        .data(
          viewLinks,
          (d: any) => (d.source.id || d.source) + '→' + (d.target.id || d.target),
        );
      lk.enter()
        .append('path')
        .attr('class', 'link')
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round')
        .attr('fill', 'none');
      lk.exit().remove();
      // Edge color: if both endpoints share the same project and that
      // project has a color, we tint the edge to visually materialize the
      // project cluster. Otherwise we remove the attribute so the CSS
      // `.link` (primary at 40%) takes back over.
      gLinks
        .selectAll<SVGPathElement, any>('path.link')
        .attr('stroke', (d: any) => {
          const s = (d.source && typeof d.source === 'object' ? d.source : null) as Node | null;
          const t = (d.target && typeof d.target === 'object' ? d.target : null) as Node | null;
          if (s && t && s.project && s.project === t.project && s.projectColor) {
            return s.projectColor;
          }
          return null;
        })
        .attr('stroke-opacity', (d: any) => {
          const s = (d.source && typeof d.source === 'object' ? d.source : null) as Node | null;
          const t = (d.target && typeof d.target === 'object' ? d.target : null) as Node | null;
          if (s && t && s.project && s.project === t.project && s.projectColor) return 0.7;
          return null;
        });

      const fl = gFlows
        .selectAll<SVGPathElement, any>('path.link-flow')
        .data(
          viewLinks,
          (d: any) => (d.source.id || d.source) + '→' + (d.target.id || d.target),
        );
      fl.enter().append('path').attr('class', 'link-flow').attr('fill', 'none');
      fl.exit().remove();

      const nd = gNodes.selectAll<SVGGElement, Node>('g.node').data(viewNodes, (d) => d.id);
      const ent = nd
        .enter()
        .append('g')
        .attr('class', (d) => 'node ' + (d.isMain ? 'main' : d.pole ? 'sub pole' : 'sub'))
        .attr('data-id', (d) => d.id)
        .style('cursor', 'pointer')
        .call(
          d3
            .drag<SVGGElement, Node>()
            // Stop zoom from interpreting a node drag as a canvas pan.
            .on('start', (e, d) => {
              e.sourceEvent?.stopPropagation();
              if (!e.active) sim.alphaTarget(0.3).restart();
              d.fx = d.x;
              d.fy = d.y;
              dragFrom = { x: e.x, y: e.y };
              // The visible sub-tree follows through its anchors, not pinned to
              // the cursor: the springs lag behind and the branches stretch a
              // little, then catch up.
              const below = descendantsOf(d.id, hierarchy());
              dragGroup = viewNodes
                .filter((n) => below.has(n.id) && n.tx != null && n.ty != null)
                .map((n) => ({ n, x: n.tx!, y: n.ty! }));
            })
            .on('drag', (e, d) => {
              d.fx = e.x;
              d.fy = e.y;
              if (dragFrom) {
                const dx = e.x - dragFrom.x;
                const dy = e.y - dragFrom.y;
                for (const g of dragGroup) { g.n.tx = g.x + dx; g.n.ty = g.y + dy; }
                if (dragGroup.length) reaimAnchors(sim, anchorX, anchorY);
              }
              markDropTarget(d.pole ? null : dropTargetAt(d, e.x, e.y));
            })
            .on('end', (e, d) => {
              if (!e.active) sim.alphaTarget(0);
              // Releases the node: it rebalances under the forces around its
              // target, its sub-tree with it.
              d.fx = null;
              d.fy = null;
              // Released onto another node: that is a move in the hierarchy.
              const target = d.pole ? null : dropTargetAt(d, e.x, e.y);
              markDropTarget(null);
              const moved = !!dragFrom && Math.hypot(e.x - dragFrom.x, e.y - dragFrom.y) >= PIN_MIN_MOVE;
              if (target) dropRef.current?.(d.id, target.id);
              // Released in the open: a constellation root stays where it was
              // put, now and after a reload, its sub-tree with it.
              else if (moved && !hierarchy().has(d.id)) pinNode(d, e.x, e.y);
              // Anything else springs back under its parent: keeping it would
              // leave one very long branch.
              else {
                retarget(d.id);
                sim.alpha(0.3).restart();
              }
              dragFrom = null;
              dragGroup = [];
            }),
        )
        .on('mouseenter', (e, d) => showTip(e as MouseEvent, d))
        .on('mousemove', (e) => moveTip(e as MouseEvent))
        .on('mouseleave', hideTip)
        .on('contextmenu', (e, d) => {
          (e as MouseEvent).preventDefault();
          hideTip();
          menuRef.current?.({ id: d.id, x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
        })
        .on('click', (_e, d) => {
          // A pole without a lead is not an agent: nothing to chat with.
          if (d.pole) return;
          openChat(chatHref(d.id), routerRef.current);
        });

      ent.append('circle').attr('class', 'pulse-ring');
      ent
        .append('circle')
        .attr('class', 'halo')
        .attr('r', (d) => (d.isMain ? 50 : 32))
        .attr('fill', (d) => (d.isMain ? 'url(#g-halo-salmon)' : 'url(#g-halo)'))
        .attr('opacity', (d) => (d.isMain ? 0.8 : 0.35));
      ent
        .append('circle')
        .attr('class', 'needs-action-halo')
        .attr('r', (d) => (d.isMain ? 50 : 32))
        .attr('fill', 'url(#g-halo-amber)')
        .attr('opacity', 0);
      ent
        .append('circle')
        .attr('class', 'ring')
        .attr('r', (d) => (d.isMain ? 34 : 22))
        .attr('fill', 'none')
        .attr('stroke', (d) => (d.isMain ? 'hsl(var(--primary) / 0.55)' : 'rgba(255,255,255,.08)'))
        .attr('stroke-width', (d) => (d.isMain ? 1.2 : 1));
      ent
        .filter((d) => d.isMain)
        .append('circle')
        .attr('class', 'ring2')
        .attr('r', 38)
        .attr('fill', 'none')
        .attr('stroke', 'hsl(var(--primary) / 0.22)')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '3 4');
      ent
        .append('circle')
        .attr('class', 'node-core')
        .attr('r', (d) => (d.isMain ? 30 : 20))
        .attr('fill', (d) => (d.isMain ? 'url(#g-main)' : 'url(#g-sub)'))
        // If a project color is set, it takes priority over the default
        // gray/salmon stroke → this is our main visual signal for "which
        // project does this node belong to".
        .attr('stroke', (d) => d.agentColor || d.projectColor || (d.isMain || d.pole ? 'hsl(var(--primary))' : '#2a2a2a'))
        .attr('stroke-width', (d) => ((d.agentColor || d.projectColor) ? 2 : (d.isMain ? 1.4 : 1)));
      ent
        .append('circle')
        .attr('class', 'liveness-dot')
        .attr('r', 4.5)
        .attr('cx', (d) => (d.isMain ? 22 : 15))
        .attr('cy', (d) => (d.isMain ? -22 : -15))
        .append('title');
      ent
        .append('text')
        .attr('class', (d) => 'node-label' + (d.isMain ? ' main' : ''))
        .attr('text-anchor', 'middle')
        .attr('dy', '0.36em')
        // Node center = project logo/emoji, else the caption's initials.
        // A URL icon is drawn by the clipped <image> added right after.
        .text(centreText)
        .style('fill', centreFill);

      // Image icon (project logo or agent icon_url when it's a URL):
      // <image> clipped to a circle, above the node-core, under the badges.
      // Fixes the display bug where an icon URL was shown as text instead
      // of the image. preserveAspectRatio "slice" → the image covers the
      // disc (cropped), pointer-events none so it doesn't interfere with
      // dragging.
      ent
        .filter((d) => !!nodeIconUrl(d))
        .append('image')
        .attr('href', (d) => nodeIconUrl(d) as string)
        .attr('x', (d) => (d.isMain ? -30 : -20))
        .attr('y', (d) => (d.isMain ? -30 : -20))
        .attr('width', (d) => (d.isMain ? 60 : 40))
        .attr('height', (d) => (d.isMain ? 60 : 40))
        .attr('preserveAspectRatio', 'xMidYMid slice')
        .attr('clip-path', (d) => (d.isMain ? 'url(#clip-node-main)' : 'url(#clip-node-sub)'))
        .attr('pointer-events', 'none');

      // Bottom-right role badge: small circle with the business glyph
      // (coder ⚒, planner 🗺, etc.). Shown for any sub-agent whose kind has
      // a defined glyph. Badge color = kind color (KIND_HUES) to stay
      // legible even when the node is colored by the project.
      ent
        // Orchestrators go without: every folded node is one, the badge told
        // nothing apart. Roles keep it next to their full name.
        .filter((d) => !d.isMain && !leadsItsProject(d) && (!!resolveRole(d.kind) || !!KIND_GLYPH[d.kind]))
        .append('g')
        .attr('class', 'role-badge')
        .attr('transform', 'translate(15, 15)')
        .call((g) => {
          g.append('circle')
            .attr('r', 8)
            // Canonical role colour (lib/roles) when the kind is a real role;
            // legacy KIND_HUES for non-role kinds (browser/fs/…).
            .attr('fill', (d) => resolveRole(d.kind)?.color ?? colorFor(d.kind))
            .attr('stroke', 'hsl(var(--background))')
            .attr('stroke-width', 1.5);
          // Role kinds → the exact lucide picto from the single source of truth.
          g.filter((d) => !!resolveRole(d.kind))
            .append('g')
            .attr('transform', 'translate(-5.5, -5.5) scale(0.46)')
            .attr('fill', 'none')
            .attr('stroke', '#fff')
            .attr('stroke-width', 2.5)
            .attr('stroke-linecap', 'round')
            .attr('stroke-linejoin', 'round')
            .html((d) => roleIconSvg(d.kind));
          // Non-role kinds → keep the legacy glyph (no lucide equivalent).
          g.filter((d) => !resolveRole(d.kind))
            .append('text')
            .attr('text-anchor', 'middle')
            .attr('dy', '0.34em')
            .attr('font-size', 8)
            .attr('fill', '#111')
            .text((d) => KIND_GLYPH[d.kind] ?? '');
        });
      // ⚠ top-left badge — only visible in needs_action state via CSS.
      ent
        .append('text')
        .attr('class', 'needs-action-badge')
        .attr('x', (d) => (d.isMain ? -26 : -17))
        .attr('y', (d) => (d.isMain ? -26 : -17))
        .attr('text-anchor', 'middle')
        .attr('font-size', (d) => (d.isMain ? 14 : 11))
        .text('⚠');

      // One caption per node; the full name and the project are in the tooltip.
      ent
        .append('text')
        .attr('class', (d) => 'node-sub' + (d.isMain ? ' main' : ''))
        .attr('text-anchor', 'middle')
        .attr('dy', (d) => (d.isMain ? 52 : 36))
        .text(nodeCaption);

      nd.exit().remove();
      // Nodes already on screen follow a reload too (a pole renamed, an
      // agent that became a pole lead or stopped being one).
      nd.attr('class', (d) => 'node ' + (d.isMain ? 'main' : d.pole ? 'sub pole' : 'sub'));
      nd.select<SVGCircleElement>('circle.node-core')
        .attr('stroke', (d) => d.agentColor || d.projectColor || (d.isMain || d.pole ? 'hsl(var(--primary))' : '#2a2a2a'))
        .attr('stroke-width', (d) => ((d.agentColor || d.projectColor) ? 2 : (d.isMain ? 1.4 : 1)));
      nd.select<SVGTextElement>('text.node-sub').text(nodeCaption);
      nd.select<SVGTextElement>('text.node-label').text(centreText).style('fill', centreFill);
      // The mascot of a node whose head is one: a box over the disc, under the
      // badges, that React fills through a portal (the graph is D3, the
      // mascot is a component, and a plugin may replace it).
      gNodes
        .selectAll<SVGGElement, Node>('g.node')
        .selectAll<SVGForeignObjectElement, Node>('foreignObject.node-mascot')
        .data((d) => (d.face?.look ? [d] : []), (d) => d.id)
        .join((enter) => {
          const fo = enter.insert('foreignObject', 'text.node-label').attr('class', 'node-mascot').attr('pointer-events', 'none');
          fo.append('xhtml:div').attr('style', 'width:100%;height:100%;display:grid;place-items:center');
          return fo;
        })
        .attr('x', (d) => -nodeRadius(d))
        .attr('y', (d) => -nodeRadius(d))
        .attr('width', (d) => nodeRadius(d) * 2)
        .attr('height', (d) => nodeRadius(d) * 2);
      // A mascot's node drops its disc, halo and static rings (see the
      // `data-head` rules below); the core stays, transparent, as the hit area.
      gNodes.selectAll<SVGGElement, Node>('g.node').attr('data-head', (d) => (d.face?.look ? 'mascot' : null));
      const mascots: GraphMascot[] = [];
      gNodes.selectAll<SVGForeignObjectElement, Node>('foreignObject.node-mascot').each(function (d) {
        const el = this.firstElementChild;
        if (el instanceof HTMLElement && d.face?.look) mascots.push({ id: d.id, el, look: d.face.look, size: nodeRadius(d) * 2 });
      });
      setMascots((prev) => (sameMascots(prev, mascots) ? prev : mascots));
      // Fold badge on every node with sub-agents: folded it counts the agents
      // it hides, open it folds them back; a click flips it either way.
      // It swallows the mousedown so a click on it never starts a drag.
      const badgeLabel = (d: Node) => (d.hiddenBelow ? '+' + d.hiddenBelow : '−');
      const badgeWidth = (d: Node) => 12 + 6 * badgeLabel(d).length;
      const badge = gNodes
        .selectAll<SVGGElement, Node>('g.node')
        .selectAll<SVGGElement, Node>('g.fold-badge')
        .data((d) => (foldParents.has(d.id) ? [d] : []), (d) => d.id)
        .join((enter) => {
          const g = enter.append('g').attr('class', 'fold-badge');
          g.append('title');
          g.append('rect').attr('rx', 8).attr('height', 16).attr('y', -8);
          g.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em');
          g.on('mousedown', (e) => e.stopPropagation())
            .on('click', (e, d) => {
              e.stopPropagation();
              toggleNodeFold(d.id);
            });
          return g;
        });
      badge.attr('transform', (d) => (d.isMain ? 'translate(30, -30)' : 'translate(20, -20)'));
      badge.classed('open', (d) => !d.hiddenBelow);
      badge.select('title').text((d) =>
        d.hiddenBelow ? i18n('agentsPage.foldBadge', { count: d.hiddenBelow }) : i18n('agentsPage.foldBadgeCollapse'),
      );
      badge.select('text').text(badgeLabel);
      badge.select('rect')
        .attr('width', badgeWidth)
        .attr('x', (d) => -badgeWidth(d) / 2);
      // The tick reuses these instead of querying the DOM on every frame.
      tickLinks = gLinks.selectAll<SVGPathElement, any>('path.link');
      tickNodes = gNodes.selectAll<SVGGElement, Node>('g.node');
      flowOf = new Map();
      gFlows.selectAll<SVGPathElement, any>('path.link-flow').each(function (d: any) { flowOf.set(d, this); });
      sim.nodes(viewNodes);
      sim.force<d3.ForceLink<Node, any>>('link')!.links(viewLinks);
      sim.alpha(0.7).restart();
    }

    // Seed targets (tx,ty) from the radial layout (graph-layout.ts): one ring
    // per depth around each constellation's root, constellations packed side
    // by side. The forces only relax around these targets.
    // Hand-placed nodes (cf. graph-pins.ts), and where the current drag began.
    let pins = parsePins(machineScopedStorage(window.localStorage).getItem(PINS_STORAGE_KEY));
    let dragFrom: { x: number; y: number } | null = null;
    let dragGroup: { n: Node; x: number; y: number }[] = [];
    // The whole hierarchy, folded parts included: a hidden node inherits its
    // ancestors' offsets when it comes back.
    function hierarchy() {
      const idOf = (e: any): string => (typeof e === 'object' && e ? e.id : e);
      return parentsOf(state.links.map((l) => ({ source: idOf(l.source), target: idOf(l.target) })));
    }
    // Re-aims a node and its visible sub-tree at seed + composed offsets.
    function retarget(id: string) {
      const parentOf = hierarchy();
      const ids = descendantsOf(id, parentOf).add(id);
      for (const n of viewNodes) {
        if (!ids.has(n.id) || n.seedX == null || n.seedY == null) continue;
        const o = totalOffset(n.id, parentOf, pins);
        n.tx = n.seedX + o.dx;
        n.ty = n.seedY + o.dy;
      }
      reaimAnchors(sim, anchorX, anchorY);
    }
    function savePins() {
      const raw = serializePins(pins);
      if (raw) machineScopedStorage(window.localStorage).setItem(PINS_STORAGE_KEY, raw);
      else machineScopedStorage(window.localStorage).removeItem(PINS_STORAGE_KEY);
    }
    // A moved node's links rest at the distance it was given, or the link
    // force would keep pulling it back toward its computed place.
    function restFromTargets() {
      const byId = new Map(viewNodes.map((n) => [n.id, n]));
      const idOf = (e: any): string => (typeof e === 'object' && e ? e.id : e);
      for (const l of viewLinks) {
        const a = byId.get(idOf(l.source));
        const b = byId.get(idOf(l.target));
        if (a?.tx == null || a.ty == null || b?.tx == null || b.ty == null) continue;
        b.rest = Math.hypot(b.tx - a.tx, b.ty - a.ty);
      }
    }
    function pinNode(d: Node, x: number, y: number) {
      if (d.seedX == null || d.seedY == null) return;
      pins.set(d.id, ownOffsetAt(x, y, { x: d.seedX, y: d.seedY }, inheritedOffset(d.id, hierarchy(), pins)));
      savePins();
      retarget(d.id);
      restFromTargets();
      // Re-reads the rest lengths just changed.
      sim.force<d3.ForceLink<Node, any>>('link')!.links(viewLinks);
      // Settles the group on its new target instead of freezing mid-release.
      sim.alpha(0.3).restart();
    }
    function unpinNode(id: string) {
      const d = viewNodes.find((n) => n.id === id);
      if (!pins.delete(id)) return;
      savePins();
      if (!d) return;
      // Back under its parent; its sub-tree follows.
      retarget(id);
      restFromTargets();
      sim.force<d3.ForceLink<Node, any>>('link')!.links(viewLinks);
      sim.alpha(0.4).restart();
    }
    pinRef.current = { has: (id) => pins.has(id), reset: unpinNode };

    function layoutStar() {
      const idOf = (e: any) => (typeof e === 'string' ? e : (e as Node).id);
      const placed = layoutForest(
        viewNodes.map((n) => n.id),
        viewLinks.map((l) => ({ source: idOf(l.source), target: idOf(l.target) })),
        { scale: layoutScale(), cx: W / 2, cy: (H - consoleH) / 2 + 16, preferCenter: mainName, previous: frames },
      );
      // Remembered for the next layout: folding, a reload or a move keeps
      // every constellation where the user last saw it.
      frames = framesOf(placed);
      const parentOf = pins.size ? hierarchy() : new Map<string, string>();
      // Only constellation roots keep a hand-placed spot: drops what an older
      // build pinned below a parent, and what a re-parenting left behind.
      let pruned = false;
      for (const id of [...pins.keys()]) if (parentOf.has(id)) pruned = pins.delete(id) || pruned;
      if (pruned) savePins();
      viewNodes.forEach((n) => {
        const p = placed.get(n.id);
        if (!p) return;
        const o = totalOffset(n.id, parentOf, pins);
        n.seedX = p.x;
        n.seedY = p.y;
        n.tx = p.x + o.dx;
        n.ty = p.y + o.dy;
        n.branch = p.root;
        n.rest = p.parentDistance;
        // Seed x/y from the target the FIRST time only (no fly-in from 0,0).
        if (n.x == null) n.x = p.x;
        if (n.y == null) n.y = p.y;
      });
      if (pins.size) restFromTargets();
      // No link re-binding here: the simulation may still hold the previous
      // nodes, and forceLink throws "node not found" on any id it cannot
      // resolve. render() binds nodes then links, which also re-reads the
      // rest lengths set above.
    }

    /**
     * Auto-fit ("fit to view"): computes the bbox of the tx/ty targets
     * (current x/y positions once the simulation has settled) and applies
     * a zoom transform that frames the whole constellation within the
     * visible zone (above the console). Called by the floating button and,
     * deferred, after every re-layout (giving the forces time to settle).
     */
    function fitNodes(nodes: Node[], animate = true, maxScale = 2) {
      if (!nodes.length) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      nodes.forEach((n) => {
        const x = n.x ?? n.tx;
        const y = n.y ?? n.ty;
        if (x == null || y == null) return;
        const r = n.isMain ? 56 : 38; // halo + label margin
        if (x - r < minX) minX = x - r;
        if (x + r > maxX) maxX = x + r;
        if (y - r < minY) minY = y - r;
        if (y + r > maxY) maxY = y + r;
      });
      if (!Number.isFinite(minX)) return;
      const bw = Math.max(1, maxX - minX);
      const bh = Math.max(1, maxY - minY);
      const pad = 72;
      const inset = topInset();
      const railBounds = (zone: string) => document.querySelector(`[data-widget-zone="${zone}"]`)?.getBoundingClientRect();
      const leftRail = railBounds('agents.left.widget');
      const rightRail = railBounds('agents.right.widget');
      const nav = chromeVar('--timon-nav-w', 56);
      const left = W >= 1024 && leftRail ? nav + leftRail.width + 32 : nav;
      const right = W >= 1024 && rightRail ? rightRail.width + 32 : 0;
      const availW = Math.max(1, W - left - right - pad * 2);
      const availH = Math.max(1, H - inset - consoleH - pad * 2);
      const scale = Math.max(0.12, Math.min(maxScale, Math.min(availW / bw, availH / bh)));
      const bcx = (minX + maxX) / 2;
      const bcy = (minY + maxY) / 2;
      const tx = left + (W - left - right) / 2 - scale * bcx;
      const ty = inset + (H - inset - consoleH) / 2 - scale * bcy;
      const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
      if (animate) svg.transition().duration(550).call(zoom.transform, t);
      else svg.call(zoom.transform, t);
    }

    // Global fit (the whole constellation) — floating button + after re-layout.
    function fitToView(animate = true) {
      fitNodes(viewNodes, animate, 2);
    }

    // Dims nodes/links outside workspace `ws` ('all' = everything at full
    // opacity). `_main` (the hub, shared by all) always stays at full
    // opacity.
    function applyDim(ws: string) {
      const DIM = 0.1;
      const op = (vis: boolean) => (ws === 'all' || vis ? 1 : DIM);
      gNodes
        .selectAll<SVGGElement, Node>('g.node')
        .transition()
        .duration(400)
        .style('opacity', (d) => op(!!d.isMain || d.workspace === ws));
      // A link "belongs" to its child's workspace (target = sub-node).
      // ⚠ We only touch `.link` (the solid stroke). `.link-flow` is a
      // dashed stroke driven by its own CSS (opacity:0 by default, .on→.85
      // for the flow animation): forcing an opacity here would make it
      // permanently visible → fake "dashed links".
      const linkOp = (d: any) => op((d.target as Node)?.workspace === ws);
      gLinks
        .selectAll<SVGPathElement, any>('path.link')
        .transition()
        .duration(400)
        .style('opacity', linkOp);
    }

    // Workspace toggle: reframes the camera on the zone + dims the rest,
    // WITHOUT re-layouting (positions are stable). 'all' = global fit,
    // everything at full opacity. A named workspace with no node →
    // fallback to global fit.
    function focusWorkspace() {
      const ws = workspaceRef.current;
      applyDim(ws);
      if (ws === 'all') {
        fitToView(true);
        return;
      }
      const zone = viewNodes.filter((n) => n.workspace === ws);
      if (zone.length) fitNodes(zone, true, 1.1);
      else fitToView(true);
    }

    /**
     * Slightly-bowed ray from source to target — quadratic curve
     * whose control point is offset perpendicular to the segment by
     * ~14% of its length. Always bent to the "left" of the
     * source→target vector so every ray bows in the same rotational
     * direction around the hub for visual consistency.
     */
    function ray(source: Node, target: Node): string {
      const sx = source.x ?? 0;
      const sy = source.y ?? 0;
      const tx = target.x ?? 0;
      const ty = target.y ?? 0;
      const dx = tx - sx;
      const dy = ty - sy;
      const len = Math.hypot(dx, dy);
      if (len < 1) return `M ${sx} ${sy} L ${tx} ${ty}`;
      // ⚠ Layout safeguard: the curvature (excursion ≈ offset/2 at the
      // midpoint) must stay < layoutStar()'s sector `pad` margin, otherwise
      // a link can overflow into the neighboring sector and reintroduce
      // crossings. Do not increase this factor without widening `pad`
      // accordingly.
      const offset = len * 0.14;
      const nx = -dy / len;
      const ny = dx / len;
      const cx = (sx + tx) / 2 + nx * offset;
      const cy = (sy + ty) / 2 + ny * offset;
      const [ax, ay] = trimmed(source, sx, sy, cx, cy);
      const [bx, by] = trimmed(target, tx, ty, cx, cy);
      return `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`;
    }

    // A link stops at its node's disc, or past the caption when it arrives
    // through it: nothing ever runs across a caption, so the text needs no
    // rim — a rim in the page colour showed on a wallpaper.
    function trimmed(d: Node, px: number, py: number, cx: number, cy: number): [number, number] {
      const vx = cx - px;
      const vy = cy - py;
      const vl = Math.hypot(vx, vy) || 1;
      const ux = vx / vl;
      const uy = vy / vl;
      const disc = (d.isMain ? 34 : 22) + 3;
      let t = disc;
      // Also when zoomed out: the caption comes back on hover.
      const caption = nodeCaption(d);
      if (caption && uy > 0) {
        // Caption box, below the disc (dy 36/52, 10.5/12 px; width estimated per character).
        const top = d.isMain ? 40 : 26;
        const bottom = (d.isMain ? 56 : 40) + 3;
        const half = (caption.length * (d.isMain ? 7.4 : 6.4)) / 2 + 4;
        if (Math.abs((ux * top) / uy) < half) t = Math.max(t, Math.min(bottom / uy, half / Math.abs(ux || 1e-9)));
      }
      t = Math.min(t, vl);
      return [px + ux * t, py + uy * t];
    }

    sim.on('tick', () => {
      // One path per link, shared by the link and its flow overlay.
      tickLinks.each(function (d: any) {
        const path = ray(d.source as Node, d.target as Node);
        this.setAttribute('d', path);
        flowOf.get(d)?.setAttribute('d', path);
      });
      tickNodes.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    const onResize = () => {
      const size = frameSize();
      // The observer reports its first reading at once: nothing moved yet.
      if (size.w === W && size.h === H) return;
      W = size.w;
      H = size.h;
      svg.attr('viewBox', `0 0 ${W} ${H}`);
      // Recomputes the targets for the new layoutScale, then re-binds the
      // links (same nodes) so their rest lengths follow.
      layoutStar();
      // Same nodes, so no sim.nodes(): the anchors must be re-aimed by hand.
      reaimAnchors(sim, anchorX, anchorY);
      (sim.force('link') as d3.ForceLink<Node, any>).links(viewLinks);
      sim.alpha(0.4).restart();
      fitToView(false);
    };
    // A gutter of the island workspace resizes the stage without resizing the window.
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    resizeObserver?.observe(frameEl);
    window.addEventListener('resize', onResize);
    svg.attr('viewBox', `0 0 ${W} ${H}`);

    // Publishes focus-workspace for the workspace effect (cf. useEffect
    // above): the toggle pans+dims, without re-layouting the whole
    // constellation.
    redrawRef.current = focusWorkspace;
    fitRef.current = () => fitToView(true);

    // ─── load live agents and seed nodes ───
    // Rebuilds the master from the daemon: at mount, and after every edit made
    // from this page (pole created, agent moved). Existing Node objects are
    // reused by id, so a reload keeps positions instead of flying in again.
    async function load(refit = true) {
      try {
        const [agentsRes, projectsRes, polesRes] = await Promise.all([
          fetch('/api/ui/agents', { cache: 'no-store' }),
          fetch('/api/ui/projects', { cache: 'no-store' }),
          fetch('/api/ui/workspaces', { cache: 'no-store' }),
        ]);
        const j = agentsRes.ok ? await agentsRes.json() : { agents: [] };
        const pj = projectsRes.ok ? await projectsRes.json() : { projects: [] };
        const wj = polesRes.ok ? await polesRes.json() : { workspaces: [] };
        const metaBySlug = new Map<string, { color?: string; icon?: string }>();
        for (const p of (pj.projects ?? []) as Array<{ slug: string; color?: string; icon?: string }>) {
          metaBySlug.set(p.slug.toLowerCase(), { color: p.color, icon: p.icon });
        }
        const poles = (wj.workspaces ?? []) as PoleRecord[];
        const live = (j.agents || []) as LiveAgent[];
        setPoles(poles);

        // Who sits at the centre: the agent the daemon flags as main. An empty
        // seat stays empty: falling back to the first agent of the list drew a
        // project coder as main, above the real root (TIM-0143).
        mainName = mainAgentOf(live, poles.map((p) => p.lead_agent));
        const hierarchy = resolveHierarchy(live, poles, mainName);
        rootAgents = new Set(live.filter((a) => !hierarchy.parentOf.get(a.name)).map((a) => a.name));
        const previous = new Map(state.nodes.map((n) => [n.id, n]));
        const nodes: Node[] = [];
        for (const a of live) {
          const isMain = a.name === mainName;
          const n = previous.get(a.name) ?? makeNode(a.role && a.role !== 'live' ? a.role : 'research', a.name, isMain);
          n.isMain = isMain;
          n.kind = isMain ? a.kind || 'main' : a.role || 'live';
          n.model = a.model || n.model;
          n.project = a.project ?? null;
          n.live = true;
          n.reportsTo = a.reports_to ?? null;
          n.agentColor = a.color ?? null;
          n.agentEmoji = a.emoji ?? null;
          n.agentIconUrl = a.icon_url ?? null;
          const proj = n.project?.toLowerCase() ?? null;
          const meta = proj ? metaBySlug.get(proj) : undefined;
          n.face = graphNodeFace(a, meta);
          n.projectColor = meta?.color ?? null;
          n.projectIcon = meta?.icon ?? null;
          // A pole lead belongs to its pole (it is not dimmed as foreign when
          // the pole is focused) and wears the orchestrator's ring.
          const led = hierarchy.workspaceOfLead.get(a.name) ?? null;
          n.hubOf = led;
          n.workspace = led ?? (proj ? hierarchy.workspaceOfProject.get(proj) ?? null : null);
          if (led) n.agentColor = n.agentColor ?? poles.find((w) => w.slug === led)?.color ?? 'hsl(var(--primary))';
          nodes.push(n);
        }
        // A pole without a lead agent still exists on the graph, as a grouping
        // node its projects hang from — and as a place to drop them.
        for (const ws of poles) {
          if (hierarchy.leadOfWorkspace.has(ws.slug)) continue;
          const id = workspaceNodeId(ws.slug);
          const n = previous.get(id) ?? makeNode('workspace', id);
          n.pole = { slug: ws.slug, name: ws.name };
          n.workspace = ws.slug;
          n.projectColor = ws.color;
          n.status = 'pole';
          n.lastAction = i18n('agentsPage.poleProjects', { count: ws.projects.length });
          nodes.push(n);
        }
        const links: { source: any; target: any }[] = [];
        for (const [child, parent] of hierarchy.parentOf) {
          if (!parent) continue;
          links.push({ source: parent.kind === 'agent' ? parent.id : workspaceNodeId(parent.slug), target: child });
        }
        state.nodes = nodes;
        state.links = links;
        if (knownAgents) {
          const fresh = live.map((a) => a.name).filter((name) => !knownAgents!.has(name));
          const byId = new Map(nodes.map((n) => [n.id, n]));
          const open = foldsHiding(fresh, links, (id) => { const n = byId.get(id); return !!n && isFolded(n); });
          if (open.length) {
            for (const id of open) foldOverrides.set(id, false);
            machineScopedStorage(window.localStorage).setItem(FOLD_STORAGE_KEY, JSON.stringify(Object.fromEntries(foldOverrides)));
          }
        }
        knownAgents = new Set(live.map((a) => a.name));
        applyFilter(refit);
        setAgentNames(live.map((a) => a.name));
        setGraphAgents(live);
        setMainAgent(mainName);
      } catch (err) {
        // Never silent: an empty graph with nothing in the console is how
        // this failure hid on 26/09/2026.
        console.error('[agents] graph load failed', err);
        applyFilter();
      }
    }
    loadRef.current = () => load(false);
    const onAgentsChanged = () => { void load(false); };
    window.addEventListener(AGENTS_CHANGED_EVENT, onAgentsChanged);

    function toggleNodeFold(id: string) {
      const n = state.nodes.find((x) => x.id === id);
      if (!n || !foldParents.has(id)) return;
      foldOverrides = toggleFold(foldOverrides, id, isFolded(n), foldedByDefault(n));
      if (foldOverrides.size) machineScopedStorage(window.localStorage).setItem(FOLD_STORAGE_KEY, JSON.stringify(Object.fromEntries(foldOverrides)));
      else machineScopedStorage(window.localStorage).removeItem(FOLD_STORAGE_KEY);
      // The camera stays on the node the user is working on.
      applyFilter(false);
      applyDim(workspaceRef.current);
    }
    foldRef.current = {
      info: (id) => {
        const n = state.nodes.find((x) => x.id === id);
        if (!n || !foldParents.has(id)) return null;
        return { folded: isFolded(n), hidden: n.hiddenBelow ?? 0 };
      },
      toggle: toggleNodeFold,
    };
    void load();

    function makeNode(kind: string, id: string, isMain = false): Node {
      return {
        id,
        kind: isMain ? 'main' : kind,
        status: isMain ? 'orchestrating' : 'idle',
        lastAction: isMain ? 'dispatching tasks' : 'awaiting task',
        isMain,
        spawnedBy: isMain ? 'user' : mainName,
        model: 'claude-haiku-4-5',
        tokIn: 0,
        tokOut: 0,
        cost: 0,
        spawnedAt: Date.now(),
        events: 0,
        tools: [],
        log: [],
        active: false,
      };
    }

    // ─── live stats refresh ───
    async function refreshNodeStats() {
      try {
        const r = await fetch('/api/ui/missions?limit=500', { cache: 'no-store' });
        if (!r.ok) return;
        const { missions } = await r.json();
        state.totalCost = 0;
        state.totalEvents = 0;
        state.nodes.forEach((n) => {
          const mine = missions.filter((m: any) => m.agent_name === n.id);
          n.events = mine.reduce((s: number, m: any) => s + (m.event_count || 0), 0);
          n.cost = mine.reduce((s: number, m: any) => s + (m.total_cost_usd || 0), 0);
          n.tokIn = mine.reduce((s: number, m: any) => s + (m.tokens_in || 0), 0);
          n.tokOut = mine.reduce((s: number, m: any) => s + (m.tokens_out || 0), 0);
          const last = mine[0];
          n.lastAction = last ? `mission ${last.id.slice(0, 8)} · ${last.status}` : '—';
          state.totalCost += n.cost;
          state.totalEvents += n.events;
        });
        // Only on change: a new object every 5 s re-rendered the whole page.
        const next = {
          active: state.nodes.filter((nn) => nn.active || nn.isMain).length,
          events: state.totalEvents,
          cost: state.totalCost,
        };
        setStats((prev) => (prev.active === next.active && prev.events === next.events && prev.cost === next.cost ? prev : next));
        if (readoutRef.current) {
          // Counts = what's actually displayed (filtered view), not the
          // master, so the readout follows the selected workspace.
          const subs = Math.max(0, viewNodes.length - 1);
          readoutRef.current.textContent = `${viewNodes.length} nodes · ${viewLinks.length} edges · ${subs} subagents`;
        }
        const names = state.nodes.map((n) => n.id);
        setAgentNames((prev) => (prev.length === names.length && prev.every((n, i) => n === names[i]) ? prev : names));
      } catch {}
    }
    const statsTimer = setInterval(refreshNodeStats, 5000);
    refreshNodeStats();

    return () => {
      window.removeEventListener('resize', onResize);
      resizeObserver?.disconnect();
      window.removeEventListener(AGENTS_CHANGED_EVENT, onAgentsChanged);
      clearInterval(statsTimer);
      if (fitTimer != null) window.clearTimeout(fitTimer);
      sim.stop();
      svg.on('.zoom', null);
      if (frame) cancelAnimationFrame(frame);
      if (settleTimer != null) window.clearTimeout(settleTimer);
      redrawRef.current = null;
    };
  }, []);

  const poleChips = [{ slug: 'all', label: 'all' }, ...poles.map((p) => ({ slug: p.slug, label: p.name }))];

  return (
    // `h-full`: the route's height, the viewport's alone, an island's in the workspace (§1).
    <div ref={rootRef} className="relative z-[1] h-full overflow-hidden">
      {/* graph */}
      {/* Its own compositor layer: a wheel zoom scales it (cf. paintZoom). */}
      <div className="fixed inset-0 origin-top-left will-change-transform">
        <svg ref={stageRef} id="graph" className="block h-full w-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            {/* Circular clip for image icons (project/agent logo as a URL).
               Radii aligned with node-core (main=30, sub=20). */}
            <clipPath id="clip-node-main"><circle r={30} /></clipPath>
            <clipPath id="clip-node-sub"><circle r={20} /></clipPath>
            <radialGradient id="g-main" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#1f1410" />
              <stop offset="100%" stopColor="#120a08" />
            </radialGradient>
            <radialGradient id="g-sub" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#181818" />
              <stop offset="100%" stopColor="#0e0e0e" />
            </radialGradient>
            <radialGradient id="g-halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(125,210,138,.55)" />
              <stop offset="60%" stopColor="rgba(125,210,138,.10)" />
              <stop offset="100%" stopColor="rgba(125,210,138,0)" />
            </radialGradient>
            <radialGradient id="g-halo-salmon" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="hsl(var(--primary) / 0.55)" />
              <stop offset="60%" stopColor="hsl(var(--primary) / 0.10)" />
              <stop offset="100%" stopColor="hsl(var(--primary) / 0)" />
            </radialGradient>
            <radialGradient id="g-halo-amber" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(245,158,11,.70)" />
              <stop offset="60%" stopColor="rgba(245,158,11,.14)" />
              <stop offset="100%" stopColor="rgba(245,158,11,0)" />
            </radialGradient>
          </defs>
          <g id="viewport">
            <g id="links" />
            <g id="flows" />
            <g id="nodes" />
          </g>
        </svg>
        {mascots.map((m) => createPortal(<LiveAgentMascot name={m.id} look={m.look} size={m.size} />, m.el, m.id))}
      </div>

      {/* Shared TopBar (logo + nav + active-agents strip + theme
          toggle), with the page's stats badge + Add Agent button
          injected as `extra`. fixed top + z-[6] so it overlays the
          full-screen canvas. */}
      {/* Pole selector — centred under the top bar. Always shown: its last
       *  chip creates a pole, which is how the first one gets made. The
       *  selection only reframes and dims the graph; Kanban / Stats /
       *  Missions stay global. */}
        <div className="pointer-events-none fixed left-1/2 top-[calc(var(--timon-topbar-h)+14px)] z-[5] -translate-x-1/2 hidden flex-col items-center gap-1.5 md:flex">
          {/* Workspace header chip — centered, aligned under the header */}
          <div className="pointer-events-auto relative flex items-center justify-center rounded-xl bg-card/90 px-6 py-2 shadow-elev-1 backdrop-blur-sm">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground">
              Workspace
            </span>
          </div>
          {/* Toggles chip */}
          <div className="pointer-events-auto flex flex-wrap justify-center gap-1 rounded-xl bg-card/90 px-2 py-1.5 shadow-elev-1 backdrop-blur-sm">
            {poleChips.map((w) => (
              <button
                key={w.slug}
                type="button"
                onClick={() => setWorkspace(w.slug)}
                className={cn(
                  'rounded-md px-2 py-0.5 text-[10.5px] transition-colors',
                  workspace === w.slug
                    ? 'bg-primary/15 text-primary'
                    : 'bg-foreground/[0.05] text-muted-foreground hover:text-foreground',
                )}
              >
                {w.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPoleDialog({ pole: null })}
              title={i18n('agentsPage.newPole')}
              aria-label={i18n('agentsPage.newPole')}
              className="flex items-center gap-1 rounded-md bg-foreground/[0.05] px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <Plus className="size-3" />
              {i18n('agentsPage.newPole')}
            </button>
          </div>
        </div>
      {/* Mobile pole chips — floating under the topbar */}
        <div className="fixed left-[calc(var(--timon-nav-w)+8px)] top-[calc(var(--timon-topbar-h)+58px)] z-[5] flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card/80 px-1.5 py-1 shadow-lg backdrop-blur md:hidden">
          <span className="px-1 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">workspace</span>
          {poleChips.map((w) => (
            <button
              key={w.slug}
              type="button"
              onClick={() => setWorkspace(w.slug)}
              className={cn(
                'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                workspace === w.slug
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border bg-muted/30 text-muted-foreground hover:text-foreground',
              )}
            >
              {w.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPoleDialog({ pole: null })}
            aria-label={i18n('agentsPage.newPole')}
            className="flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 text-muted-foreground"
          >
            <Plus className="size-3" />
          </button>
        </div>



      {/* tooltip */}
      <div
        ref={tipRef}
        id="tooltip"
        className="pointer-events-none fixed z-[9] min-w-[170px] rounded-lg border border-border bg-popover px-3 py-2.5 text-[11.5px] opacity-0 shadow-elev-3 transition-opacity"
        style={{ transform: 'translate(-50%, -110%)' }}
      >
        <div className="flex items-center gap-2 text-[12.5px] font-semibold">
          <span
            className="swatch"
            style={{ width: 8, height: 8, borderRadius: 2, background: 'hsl(var(--success))' }}
          />
          <span className="t-name">_main</span>
        </div>
        <div className="status mt-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
          <span className="d size-1.5 rounded-full" style={{ background: 'hsl(var(--success))' }} />
          <span className="t-status">idle</span>
        </div>
        <div className="t-last mt-1.5 truncate text-[10.5px] text-muted-foreground">
          awaiting input
        </div>
      </div>

      {seatCandidates && !orgOpen && (
        <MainSeatNotice candidates={seatCandidates} className="fixed bottom-16 left-4 z-[5] w-[min(18rem,calc(100%-6rem))]" />
      )}

      {/* Auto-fit: reframes the whole constellation into view. Top right, the
          one corner no widget slot claims: at the bottom it sat on top of
          the right-hand placeholder. */}
      <button
        type="button"
        onClick={() => fitRef.current?.()}
        title={i18n('agentsPage.autoFitView')}
        aria-label={i18n('agentsPage.autoFitView')}
        className="fixed right-4 top-[calc(var(--timon-topbar-h)+14px)] z-[5] flex size-9 items-center justify-center rounded-lg bg-card/90 text-muted-foreground shadow-elev-1 backdrop-blur transition-colors hover:bg-card hover:text-foreground"
      >
        <Maximize2 className="size-4" />
      </button>

      {/* readout: 16px above the action bar, not 8, so it reads as a caption
          of the canvas rather than a part of the bar. */}
      <div
        ref={readoutRef}
        className="pointer-events-none fixed bottom-[4.5rem] left-1/2 -translate-x-1/2 z-[4] rounded-md bg-card/70 px-2.5 py-1 tabular-nums text-[10.5px] text-muted-foreground backdrop-blur"
      >
        node graph
      </div>

      {/* Action bar — quick shortcuts above the event stream console.
       *  On mobile the bar becomes horizontally scrollable (overflow-x-auto)
       *  to avoid overflowing the viewport. We keep the creation actions +
       *  the _main chat; the Kanban / Missions nav links live in the main
       *  menu, not here. */}
      {/* Ghost buttons in one bar: outlined buttons inside an outlined bar
          were a box in a box. The plugins' own controls get the same look. */}
      <div className="fixed bottom-4 left-1/2 z-[5] flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 overflow-x-auto rounded-xl bg-card/90 px-2 py-1.5 shadow-elev-2 backdrop-blur scrollbar-none [&_[data-slot-region]_button]:border-transparent [&_[data-slot-region]_button]:bg-transparent [&_[data-slot-region]_button]:shadow-none">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium"
          onClick={() => setShowNewTask(true)}
        >
          <ListTodo className="size-3.5" />
          New task
        </Button>
        <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium" asChild>
          <Link
            href="/edit?new=1"
            onClick={(e) => {
              e.preventDefault();
              openAgentEditor({ isNew: true });
            }}
          >
            <UserPlus className="size-3.5" />
            New agent
          </Link>
        </Button>
        {/* Controls of plugins (agent import, export): nothing painted when empty. */}
        <SlotRegion name="agents.toolbar" className="flex shrink-0 items-center gap-2" />
        <Button
          size="sm"
          variant={orgOpen ? 'default' : 'ghost'}
          className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium"
          onClick={() => setOrgOpen((v) => !v)}
          aria-pressed={orgOpen}
        >
          <ListTree className="size-3.5" />
          {i18n('agentsPage.orgTitle')}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium" asChild>
          <Link href="/chat">
            <MessageSquare className="size-3.5" />
            {i18n('chatEntry.openMain')}
          </Link>
        </Button>
        {/* Mobile-only: opens the event-stream sidebar. On desktop it's
         *  already always visible so the button is hidden. */}

      </div>



      {/* Mobile-only : FAB + bottom-sheet liste/recherche des agents .main. */}
      <MobileAgentList />

      <OrgTree
        open={orgOpen}
        onOpenChange={setOrgOpen}
        agents={graphAgents}
        poles={poles}
        hierarchy={hierarchy}
        main={mainAgent}
        notice={seatCandidates && <MainSeatNotice candidates={seatCandidates} />}
        menuOpen={!!menu}
        onDrop={onDrop}
        onMenu={setMenu}
      />
      {menu && (
        <NodeMenu
          target={menu}
          agents={graphAgents}
          poles={poles}
          hierarchy={hierarchy}
          fold={foldRef.current?.info(menu.id) ?? null}
          onToggleFold={() => foldRef.current?.toggle(menu.id)}
          pinned={pinRef.current?.has(menu.id) ?? false}
          onResetPosition={() => pinRef.current?.reset(menu.id)}
          onClose={() => setMenu(null)}
          onReportsTo={onReportsTo}
          onMovePole={onMovePole}
          onEditPole={(pole) => setPoleDialog({ pole })}
          onDuplicate={setDuplicateOf}
        />
      )}
      {duplicateOf && <DuplicateAgentDialog source={duplicateOf} onClose={() => setDuplicateOf(null)} />}
      {poleDialog && (
        <PoleDialog
          pole={poleDialog.pole}
          agents={agentNames}
          onClose={() => setPoleDialog(null)}
          onSaved={reload}
        />
      )}

      {showNewTask && (
        <TaskFormModal
          agents={agentNames.map((n) => ({ name: n }))}
          onClose={() => setShowNewTask(false)}
          onSaved={() => { setShowNewTask(false); }}
        />
      )}




      <style>{`
        #tooltip.on { opacity: 1; }
        /* The node-core circle is dark in BOTH themes (radial gradient
           g-sub / g-main on a near-black base), so the label needs to
           stay light regardless of theme — --foreground flips to
           near-black in light mode and the text disappeared. */
        .node-label { font: 600 11px var(--font-sans), system-ui, sans-serif; letter-spacing: .04em; fill: hsl(0 0% 96% / 0.88); pointer-events: none; user-select: none; }
        .node-label.main { font-size: 12.5px; fill: hsl(0 0% 100%); font-weight: 600; }
        /* The node a dragged node would be dropped onto. */
        g.node.drop-target .node-core { stroke: hsl(var(--primary)) !important; stroke-width: 3.5 !important; }
        g.node.drop-target .halo { opacity: 0.95 !important; }
        /* A pole without a lead agent: a grouping, drawn hollow and dashed. */
        g.node.pole .node-core { fill: hsl(var(--card) / 0.6); stroke-dasharray: 4 3; stroke-width: 1.6; }
        g.node.pole .node-label { fill: hsl(var(--foreground) / 0.85); }
        #graph.labels-off g.node:not(.pole):not(:hover) .node-sub { opacity: 0; }
        .fold-badge { cursor: pointer; }
        .fold-badge rect { fill: hsl(var(--primary)); stroke: hsl(var(--background)); stroke-width: 1.5; }
        .fold-badge text { font: 600 9.5px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums; fill: hsl(var(--primary-foreground)); pointer-events: none; user-select: none; }
        .fold-badge:hover rect { filter: brightness(1.1); }
        .fold-badge.open rect { fill: hsl(var(--surface-3)); stroke: hsl(var(--background)); }
        .fold-badge.open text { fill: hsl(var(--primary)); }
        g.node.pole .node-sub { fill: hsl(var(--foreground) / 0.8); font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
        /* Nothing blurs what lies over the graph: a backdrop-filter above a
           canvas that redraws on every tick, pan and zoom frame is recomputed
           on each of them — that, more than the graph, made the page crawl.
           Surfaces turn nearly opaque instead. From md up the chrome has no
           ::before of its own: its single layer sits UNDER the page and reads
           the wallpaper only (globals.css), so the graph never re-blurs it.
           Whatever the glass scope: a widget over the graph is never a clear
           card (widgets scope) nor a faint surface on its island (island
           scope), and the reading column's card is no exception. */
        html:has(#graph) [class*='backdrop-blur'],
        html:has(#graph) :is(.timon-topbar-bar, .timon-topbar-agents, .timon-topbar-safe, .timon-nav-rail, .widget-stack, .widget-frame > .widget-content > section)::before {
          -webkit-backdrop-filter: none !important;
          backdrop-filter: none !important;
        }
        html[data-glass]:has(#graph) :is(.timon-topbar-bar, .timon-topbar-agents, .timon-topbar-safe, .timon-nav-rail)::before { background: hsl(var(--chrome) / 0.92) !important; }
        html[data-glass]:has(#graph) :is(.widget-stack, .widget-frame > .widget-content > section)::before,
        html[data-glass]:has(#graph) .timon-glass-chat-card > div { background: hsl(var(--card) / 0.92) !important; }
        html:has(#graph) .timon-glass-chat-card > div { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
        /* No rim: links stop short of captions instead (cf. trimmed()). */
        .node-sub { font: 500 10.5px var(--font-sans), system-ui, sans-serif; fill: hsl(var(--foreground) / 0.82); pointer-events: none; user-select: none; letter-spacing: .02em; }
        .node-sub.main { font-size: 12px; font-weight: 700; fill: hsl(var(--foreground)); }
        /* Light theme: charcoal discs rather than near-black, softer on a
           light page; the white initials stay readable on them. */
        :root:not(.dark) #g-sub stop:first-child { stop-color: #4a4d52; }
        :root:not(.dark) #g-sub stop:last-child { stop-color: #33363a; }
        :root:not(.dark) #g-main stop:first-child { stop-color: #4d4340; }
        :root:not(.dark) #g-main stop:last-child { stop-color: #37302d; }
        .link { stroke: hsl(var(--primary) / 0.4); stroke-width: 1.5; transition: stroke .2s ease, stroke-opacity .2s ease; fill: none; }
        .link.active { stroke: hsl(var(--primary) / 0.85); stroke-width: 1.8; }
        .link-flow { stroke: hsl(var(--primary)); stroke-width: 1.3; stroke-dasharray: 4 8; fill: none; opacity: 0; }
        .link-flow.on { opacity: .85; animation: flow 1.1s linear infinite; }
        @keyframes flow { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -36; } }
        .pulse-ring { fill: none; stroke: hsl(var(--success)); stroke-width: 1.2; opacity: 0; }
        .pulse-ring.on { animation: ring-pulse 1.4s ease-out infinite; }
        @keyframes ring-pulse {
          0%   { opacity: .6; stroke-width: 1.4; r: var(--r-start, 28); }
          100% { opacity: 0; stroke-width: .4; r: var(--r-end, 60); }
        }
        .halo, .node-core { transition: fill .25s ease, stroke .25s ease, opacity .25s ease, r .4s ease; }

        /* Live-state overrides for the agent canvas — mirror the colours
         * and animations used by the chat topbar's active-agents strip.
         * Driven by polling /api/ui/agents/active, classes set per-node
         * via setAttribute('data-state', ...). */
        g.node[data-state='thinking'] .pulse-ring { stroke: hsl(var(--warning)); }
        g.node[data-state='thinking'] .pulse-ring.on { animation: ring-pulse 1.4s ease-out infinite; }

        g.node[data-state='needs_action'] .pulse-ring { stroke: #f59e0b; }
        g.node[data-state='needs_action'] .pulse-ring.on { animation: ring-pulse 1.1s ease-out infinite; }
        g.node[data-state='needs_action'] .halo { opacity: 0 !important; }
        g.node[data-state='needs_action'] .needs-action-halo { opacity: 0.95 !important; }

        .needs-action-badge { fill: #f59e0b; visibility: hidden; filter: drop-shadow(0 0 5px rgba(245,158,11,.75)); }
        g.node[data-state='needs_action'] .needs-action-badge {
          visibility: visible;
          animation: na-badge-blink 1.5s ease-in-out infinite;
        }
        @keyframes na-badge-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }

        g.node[data-state='done'] .pulse-ring { opacity: 0; }
        /* A mascot is its own frame: no disc, halo or static ring behind it. The
           pulse ring and the needs-action halo stay, they say the agent works. */
        g.node[data-head='mascot'] :is(.halo, .ring, .ring2) { display: none; }
        g.node[data-head='mascot'] .node-core { fill: transparent !important; }
        /* Still outlined as a drop target: that ring answers a drag, it is not a frame. */
        g.node[data-head='mascot']:not(.drop-target) .node-core { stroke: none !important; }

        /* Fine mission state, beside the ring: finished turn / open / cut. */
        .liveness-dot { visibility: hidden; stroke: hsl(var(--background)); stroke-width: 1.5; }
        g.node[data-liveness] .liveness-dot { visibility: visible; }
        g.node[data-liveness='turn_done'] .liveness-dot { fill: hsl(var(--success)); }
        g.node[data-liveness='open'] .liveness-dot { fill: hsl(var(--muted-foreground)); }
        g.node[data-liveness='interrupted'] .liveness-dot { fill: hsl(var(--destructive)); }

      `}</style>
    </div>
  );
}

