'use client';

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Tile } from '@/components/tile';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { t } from '@/lib/i18n';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { usePreviousScope } from '@/hooks/use-previous-scope';
import { rowHandover } from '@/lib/layout-handover';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { sharedStripScope } from '@/lib/workspace-scope';
import { parsePinnedProjects, parsePinnedTabs, setPinnedTab, withPinnedProjects, withPinnedTabs } from '@/lib/strip-tabs';
import type { ActiveAgent } from '@/lib/agent-state';
import { activeAgentsNow, useActiveAgents } from '@/lib/active-agents';
import { closeTab, reopenedTabs, updateClosedTabs, useClosedTabs, withoutTabs } from '@/lib/strip-closed';
import { agentIdentity, useAgentIdentities, type AgentIdentity } from '@/components/agent-avatar';
import { useProjectMeta } from '@/hooks/use-project-meta';
import {
  groupWorkingTabs,
  isAgentWorking,
  parseWorkingAgentsOptions,
  projectOrchestrator,
  withWorkingAgentsOptions,
  workingAgentTabs,
  type WorkingAgentsOptions,
} from '@/lib/working-agents';
import { AgentChip, type PinMove, type TabDrag, type TabShape } from './agent-strip';
import { cn } from '@/lib/utils';
import { clampGap, gapAt, placePinned } from '@/lib/strip-reorder';
import { useIslandBus } from '@/lib/island-bus';
import { canDragToIsland, startChatIslandDrag } from '@/lib/chat-island-drag';
import { ProjectTab } from './project-tab';
import { chatHref } from '@/lib/chat-island-params';
import { WorkingAgentsOptionsMenu } from './working-agents-options';

/** The drag of a tab along the strip, beside the island workspace's own type. */
export const STRIP_TAB_DRAG_TYPE = 'application/x-timon-strip-tab';

type SlotKind = 'agent' | 'project';
/** A project's key among the tabs, beside the agents' names. */
const PROJECT_KEY = 'project:';

/**
 * Working agents: every agent doing something, at hand (TODO #479).
 *
 * The top bar's strip of agent tabs, become a widget of `@timon/agents`: it
 * starts in the middle of the top bar and moves or goes away like any other
 * card. It takes the shape of its zone — tabs side by side on the bar, faces
 * stacked in a narrow column (the nav rail), a card of rows anywhere else —
 * and shows what its options say (`lib/working-agents.ts`): the agents at
 * work or every agent, the orchestrators only, one tab per project.
 *
 * Pinned tabs stay at rest and come first, in the order the person gives them
 * by dragging one onto another (SUG-0080). The drag is the tab's own HTML5
 * drag, the one that already opens the agent's chat in the island workspace:
 * one gesture, the drop target decides. Its keyboard and touch form is the
 * tab's right-click menu.
 *
 * Data freshness: `useActiveAgents` polls /api/ui/agents/active every 4s and
 * refreshes on the global SSE bus; the poll is shared at module level, so a
 * second mount costs no request.
 */
export function WorkingAgentsWidget({ orientation = 'vertical', compact = false, editing = false, handle, className }: WidgetProps) {
  const active = useActiveAgents();
  // Faces: the configured agent when known (a synthetic idle tab carries only
  // a name), else what the active-agents feed says about it.
  const { agents: configured, identityOf } = useAgentIdentities();
  const projects = useProjectMeta();
  const faceOf = (a: ActiveAgent): AgentIdentity => (
    configured.some((c) => c.name === a.name)
      ? identityOf(a.name)
      : agentIdentity(a, a.project ? projects.get(a.project) ?? null : null)
  );

  // Pins and options: a habit of the account, one row for every view.
  const { owner, previousOwner } = useWorkspaceLayout();
  const [stripScope, setStripScope] = useState<{ owner: string; scope: string } | null>(null);
  useEffect(() => {
    if (!owner) { setStripScope(null); return; }
    let alive = true;
    void sharedStripScope(owner).then((scope) => { if (alive) setStripScope({ owner, scope }); });
    return () => { alive = false; };
  }, [owner]);
  const previousStrip = usePreviousScope(previousOwner, sharedStripScope);
  const { raw: row, ready, update: updateRow } = useStoredLayout(
    stripScope?.owner === owner && previousStrip !== undefined ? stripScope.scope : null,
    rowHandover(previousStrip),
  );
  const pins = parsePinnedTabs(row);
  const options = parseWorkingAgentsOptions(row);
  const setPins = (next: (pins: string[]) => string[]) => {
    void updateRow((raw) => withPinnedTabs(raw, next(parsePinnedTabs(raw))));
  };
  // Grouped by project, a tab is a project: its pin holds the project.
  const pinnedProjects = parsePinnedProjects(row);
  // The click is decided against what is on screen, then applied to the row
  // as it stands: a toggle replayed over another window's write would undo it.
  const toggleProjectPin = (project: string) => {
    const pin = !pinnedProjects.includes(project);
    void updateRow((raw) => withPinnedProjects(raw, setPinnedTab(parsePinnedProjects(raw), project, pin)));
  };
  const setOptions = (patch: Partial<WorkingAgentsOptions>) => {
    void updateRow((raw) => withWorkingAgentsOptions(raw, patch));
  };

  // Tabs closed by hand, persisted and shared with every mount
  // (cf. lib/strip-closed.ts): a reload must not bring back what was put away.
  const closed = useClosedTabs();
  const dismiss = (a: ActiveAgent) => {
    updateClosedTabs((tabs) => closeTab(tabs, a, activeAgentsNow()));
  };
  // A tab a newer mission brought back stays back: forget its close.
  const reopened = reopenedTabs(closed, active).join('\n');
  useEffect(() => {
    if (!reopened) return;
    updateClosedTabs((tabs) => withoutTabs(tabs, reopened.split('\n')));
  }, [reopened]);
  // Local "now" tick so the per-agent elapsed time updates every second
  // even between server polls. Without this, the strip visually freezes
  // on "thinking" and looks broken even though the data is fresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // The open chat's agent keeps its tab, even once done: it is how one moves
  // back and forth while talking to it. Read from the address, so the widget
  // knows it wherever it is placed.
  const pathname = usePathname();
  const params = useSearchParams();
  const currentAgent = pathname === '/chat' ? params?.get('agent') || undefined : undefined;
  const currentMission = currentAgent ? params?.get('mission') || undefined : undefined;

  const tabs = workingAgentTabs({ active, configured, pins, closed, currentAgent, currentMission, options, now });

  const horizontal = orientation === 'horizontal';
  const shape: TabShape = horizontal ? 'chip' : compact ? 'avatar' : 'row';

  // The tabs on screen, in order: an agent, or a project when grouped. `key`
  // is what the drag carries and what the pins hold (`project:` + slug for a
  // project, whose pin is stored in `pinnedProjects`).
  type Slot = { key: string; kind: SlotKind; pinned: boolean; chat: { agent: string; mission: string | null } | null; node: ReactNode };
  const slots: Slot[] = [];

  // Reordering by a drag (SUG-0080). `held` is what the drag carries: during
  // `dragover` the browser only shows a drag's types, never its data. `gap` is
  // where the tab would land, and where the line is drawn.
  const bus = useIslandBus();
  const track = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<{ key: string; kind: SlotKind } | null>(null);
  const [gap, setGap] = useState<{ index: number; at: number } | null>(null);
  const pinnedKeys = (kind: SlotKind) => slots.filter((slot) => slot.kind === kind && slot.pinned).map((slot) => slot.key);
  const writePins = (kind: SlotKind, key: string, index: number) => {
    const visible = pinnedKeys(kind);
    if (kind === 'agent') {
      setPins((current) => placePinned(current, visible, key, index));
      return;
    }
    const slug = (k: string) => k.slice(PROJECT_KEY.length);
    void updateRow((raw) => withPinnedProjects(raw, placePinned(parsePinnedProjects(raw), visible.map(slug), slug(key), index)));
  };
  // The block a tab of `kind` may land in, among the other tabs: its pinned
  // tabs stand together (grouped, the pinned projects come first).
  const blockOf = (kind: SlotKind, without: string) => {
    const rest = slots.filter((slot) => slot.key !== without);
    const first = rest.findIndex((slot) => slot.kind === kind && slot.pinned);
    const count = rest.filter((slot) => slot.kind === kind && slot.pinned).length;
    const start = first >= 0 ? first : kind === 'agent' ? rest.filter((slot) => slot.kind === 'project' && slot.pinned).length : 0;
    return { rest, start, end: start + count };
  };
  const measure = (e: DragEvent<HTMLElement>, drag: { key: string; kind: SlotKind }) => {
    const box = track.current;
    if (!box) return null;
    const { rest, start, end } = blockOf(drag.kind, drag.key);
    const rects = new Map(Array.from(box.querySelectorAll<HTMLElement>('[data-strip-slot]')).map((el) => [el.dataset.stripSlot ?? '', el.getBoundingClientRect()] as const));
    const rectOf = (slot: Slot | undefined) => (slot ? rects.get(slot.key) : undefined);
    const vertical = !horizontal;
    const centre = (r: DOMRect) => (vertical ? r.top + r.height / 2 : r.left + r.width / 2);
    const index = clampGap(gapAt(rest.map((slot) => { const r = rectOf(slot); return r ? centre(r) : 0; }), vertical ? e.clientY : e.clientX), start, end);
    // The line sits midway between the two tabs around the gap.
    const origin = box.getBoundingClientRect();
    const before = rectOf(rest[index - 1]);
    const after = rectOf(rest[index]);
    const edge = (r: DOMRect, side: 'start' | 'end') => (vertical ? (side === 'start' ? r.top : r.bottom) : (side === 'start' ? r.left : r.right));
    const at = before && after ? (edge(before, 'end') + edge(after, 'start')) / 2 : before ? edge(before, 'end') + 2 : after ? edge(after, 'start') - 2 : (vertical ? origin.top : origin.left);
    return { index: index - start, at: at - (vertical ? origin.top : origin.left) };
  };
  const dragOf = (slot: Pick<Slot, 'key' | 'kind' | 'chat'>): TabDrag | null => (ready ? {
    onDragStart: (e) => {
      e.dataTransfer.setData(STRIP_TAB_DRAG_TYPE, slot.key);
      setHeld({ key: slot.key, kind: slot.kind });
      // Out of the strip, the island workspace takes the chat: its layers
      // rise only once the pointer leaves the strip (`hold`), so along the
      // strip the drag reorders.
      if (slot.chat && canDragToIsland(bus)) startChatIslandDrag(e, slot.chat.agent, slot.chat.mission, { hold: track.current });
    },
    onDragEnd: () => { setHeld(null); setGap(null); },
  } : null);
  const reorder = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!held || !e.dataTransfer.types.includes(STRIP_TAB_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setGap(measure(e, held));
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setGap(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!held || !e.dataTransfer.types.includes(STRIP_TAB_DRAG_TYPE)) return;
      e.preventDefault();
      const place = measure(e, held) ?? gap;
      if (place) writePins(held.kind, held.key, place.index);
      setHeld(null);
      setGap(null);
    },
  };
  // The menu's steps, for a pinned agent: one place earlier or later in its block.
  const pinMove = (name: string): PinMove | null => {
    if (!ready || !pins.includes(name)) return null;
    // Read before the slots are built: grouped, only the agents of no project have a tab of their own.
    const visible = (options.groupByProject ? tabs.filter((a) => !a.project) : tabs).filter((a) => pins.includes(a.name)).map((a) => a.name);
    const at = visible.indexOf(name);
    if (at < 0) return null;
    return {
      earlier: at > 0 ? () => writePins('agent', name, at - 1) : null,
      later: at < visible.length - 1 ? () => writePins('agent', name, at + 1) : null,
      vertical: !horizontal,
    };
  };

  // `listed`: an agent under its project's tab, whose pin and place are the project's.
  const agentTab = (a: ActiveAgent, as: TabShape, listed = false) => {
    const chat = { agent: a.name, mission: a.mission_id || null };
    return (
      <AgentChip
        key={a.name}
        agent={a}
        identity={faceOf(a)}
        highlighted={a.name === currentAgent}
        now={now}
        pinned={pins.includes(a.name)}
        onTogglePin={listed ? null : () => { const pin = !pins.includes(a.name); setPins((current) => setPinnedTab(current, a.name, pin)); }}
        // Every agent is asked for in `all`, and a pinned one or the open chat's never hides.
        onDismiss={options.show === 'all' || a.name === currentAgent || pins.includes(a.name) ? null : () => dismiss(a)}
        shape={as}
        pinMove={listed ? null : pinMove(a.name)}
        drag={listed ? null : dragOf({ key: a.name, kind: 'agent', chat })}
      />
    );
  };
  const addAgent = (a: ActiveAgent) => {
    slots.push({ key: a.name, kind: 'agent', pinned: pins.includes(a.name), chat: { agent: a.name, mission: a.mission_id || null }, node: agentTab(a, shape) });
  };

  if (!options.groupByProject) tabs.forEach(addAgent);
  // An agent of no project keeps its own tab, among the projects.
  else for (const entry of groupWorkingTabs(tabs, ready ? pinnedProjects : [])) {
    if (entry.kind === 'agent') { addAgent(entry.agent); continue; }
    const { group, pinned } = entry;
    const meta = projects.get(group.project) ?? null;
    const label = meta?.name || group.project;
    // The orchestrator's chat, on its mission at work if it has one; without
    // an orchestrator, the project's first agent, else the project on /agents.
    const lead = projectOrchestrator(configured, group.project) ?? group.agents[0]?.name ?? null;
    const leadTab = lead ? group.agents.find((a) => a.name === lead) : undefined;
    const chat = lead ? { agent: lead, mission: leadTab?.mission_id || null } : null;
    const href = chat ? chatHref(chat.agent, chat.mission) : `/agents?project=${encodeURIComponent(group.project)}`;
    // Every agent of the project, not only the ones on screen.
    const size = Math.max(group.agents.length, configured.filter((a) => a.project === group.project && a.ephemeral !== true).length);
    const key = PROJECT_KEY + group.project;
    slots.push({
      key,
      kind: 'project',
      pinned,
      chat,
      node: (
        <ProjectTab
          key={key}
          group={group}
          identity={{ ...agentIdentity({ name: label }, meta), roleKey: null }}
          label={label}
          href={href}
          size={size}
          shape={shape}
          vertical={!horizontal}
          hoverList={options.projectHoverList}
          pinned={pinned}
          onTogglePin={() => toggleProjectPin(group.project)}
          drag={dragOf({ key, kind: 'project', chat })}
        >
          {group.agents.filter(isAgentWorking).map((a) => agentTab(a, 'row', true))}
        </ProjectTab>
      ),
    });
  }
  const content = slots.map((slot) => slot.node);
  // Where the dragged tab will land: a line in the gap, across the strip.
  const dropLine = gap && (
    <span
      aria-hidden
      data-strip-drop-gap={gap.index}
      className={cn('pointer-events-none absolute z-10 rounded-full bg-primary', horizontal ? 'inset-y-0 w-0.5' : 'inset-x-0 h-0.5')}
      style={horizontal ? { left: gap.at - 1 } : { top: gap.at - 1 }}
    />
  );

  const menu = <WorkingAgentsOptionsMenu options={options} onChange={setOptions} disabled={!ready} />;

  if (shape === 'row') {
    return (
      <Tile
        title={t('widgetCatalog.workingAgents.title')}
        className={className}
        bodyClassName="p-2"
        actions={<>{menu}{handle}</>}
      >
        {content.length === 0
          ? <p className="px-1 py-2 text-xs text-muted-foreground">{t(options.show === 'all' ? 'workingAgents.noAgent' : 'workingAgents.empty')}</p>
          : <div ref={track} data-working-agents="row" className="relative flex flex-col gap-1" {...reorder}>{content}{dropLine}</div>}
      </Tile>
    );
  }

  // The bare forms have no header: the options are offered while the layout
  // is edited, next to the grip and the cross.
  if (shape === 'avatar') {
    return (
      <>
        {content.length > 0 && <div ref={track} data-working-agents="avatar" className="relative flex flex-col items-center gap-0.5" {...reorder}>{content}{dropLine}</div>}
        {editing && <span className="flex shrink-0 items-center self-center">{menu}</span>}
        {handle}
      </>
    );
  }

  // Centred in the free space by `mx-auto` on the inner track, NOT by
  // `justify-center` on the scroller: with `justify-center`, a track wider
  // than its frame overflows on BOTH sides, and the part that leaves on the
  // left is out of the scroll range (scrollLeft stops at 0) — the extra tabs
  // became unreachable. A `w-max` track with auto margins centres while there
  // is room and, once there is not, its margins drop to 0: it overflows to the
  // right, the side one can scroll to.
  //
  // `scrollbar-none` (styles/globals.css): the tabs' width changes at every
  // tick of the timer, a real scrollbar would flicker. `touch-pan-x` gives the
  // sideways gesture to the strip instead of the page's vertical scroll.
  return (
    <>
      {content.length > 0 && (
        <div className="flex min-w-0 touch-pan-x items-center overflow-x-auto overscroll-x-contain scrollbar-none">
          <div ref={track} data-working-agents="chip" className="relative mx-auto flex w-max items-center gap-1 md:gap-1.5" {...reorder}>{content}{dropLine}</div>
        </div>
      )}
      {editing && <span className="flex shrink-0 items-center self-center">{menu}</span>}
      {handle}
    </>
  );
}
