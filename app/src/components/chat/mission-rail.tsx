'use client';

import { useCallback, useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Columns2, Copy, ListFilter, Pencil, Square, SquarePen, TerminalSquare } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import { formatDateTime, formatRelativeTime } from '@/lib/intl';
import { WIDGET_TOOLBAR, WidgetButton, widgetButtonClass } from '@/components/widget-toolbar';
import { RoleBadge } from '@/components/role-badge';
import { ActiveAgentAvatar, useAgentIdentities } from '@/components/agent-avatar';
import { useWidgetEditing } from '@/components/widget-host/widget-host';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { MISSION_RAIL_DISPLAY_SCOPE, missionRailDisplayChanged, readMissionRailDisplay, writeMissionRailDisplay, type MissionRailDisplay } from '@/lib/mission-rail-display';
import { buildMissionRail } from '@/lib/mission-rail-groups';
import { STATE_VISUALS, type ActiveState } from '@/lib/agent-state';
import { agentRoleKey, resolveRole } from '@/lib/roles';
import { Slot } from '@/lib/plugin-host/render';
import { isMissionOrigin } from '@/lib/mission-origin';
import { MissionOriginIcon } from '@/components/mission-origin-icon';
import { FileContextMenu, type FileMenuItem } from './file-context-menu';
import { NewMissionMenu, type NewMissionOptions } from './new-mission-menu';
import { useIslandBus } from '@/lib/island-bus';
import { canDragToIsland, chatSplitActions, startChatIslandDrag } from '@/lib/chat-island-drag';
import { missionDisplayTitle } from '@/lib/mission-title';
import { shortSessionId } from '@/lib/mission-session-id';
import { useMe } from '@/hooks/use-me';
import { actingUser } from '@/lib/auth';
import { HumanFace, humanSpeaker } from './human-speaker';
import type { MissionSummary } from './chat-types';
import { NativeViewCover } from '@/lib/native-view-cover';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

/** Role of a mission whose agent declares none. */
const OTHER_ROLE = 'other';

/** A child row's slice of its group's island: indent, theme-following tint,
 *  and the timeline spine on a pseudo-element (AGENTS.md rule 16 bans a
 *  border or a one-pixel element as a vertical line). `pb-px` replaces the
 *  rows' `mb-px` so the tint and the spine run unbroken. */
const CHILD_ROW = 'ml-3 pb-px pl-3 pr-1 bg-foreground/[0.04] before:absolute before:bottom-0 before:left-1.5 before:top-0 before:w-px before:bg-foreground/15';
/** The open child's fill: opaque card under the island tint. */
const OPEN_CHILD_FILL = 'bg-card bg-[linear-gradient(hsl(var(--foreground)/0.04),hsl(var(--foreground)/0.04))]';

/**
 * The project's missions, as a panel the client half of `@timon/missions`
 * places in a widget zone (§10.12). A toolbar says the filter in effect and
 * opens it (role, automated missions, grouping by orchestrator, avatar); the
 * rows come from `lib/mission-rail-groups.ts`.
 */
export function MissionRail({
  agentId,
  missions,
  currentMissionId,
  thinking,
  onPick,
  onNew,
  newMission,
  onKill,
}: {
  agentId: string;
  missions: MissionSummary[];
  currentMissionId: string | null;
  thinking?: boolean;
  onPick: (id: string, permId?: string | null) => void;
  onNew: () => void;
  newMission?: NewMissionOptions | null;
  onKill?: (id: string) => Promise<void>;
}) {
  const editing = useWidgetEditing();
  const { identityOf } = useAgentIdentities();
  const me = useMe();
  // Missions of the active machine are owned by the account acting there.
  const viewer = actingUser(me);
  const displayStore = useStoredLayout(MISSION_RAIL_DISPLAY_SCOPE);
  const display = readMissionRailDisplay(displayStore.raw);
  const { showAvatar, mineOnly, groupByOrchestrator, expandSubagents } = display;
  // A patch on the row as it stands when written: replayed after another
  // window's write (TODO #647), it keeps that window's other setting.
  const setDisplay = (patch: Partial<MissionRailDisplay>) => {
    void displayStore.update((raw) => writeMissionRailDisplay({ ...readMissionRailDisplay(raw), ...patch }));
  };
  const [killing, setKilling] = useState<string | null>(null);
  /** Right-click menu on a row, and the row being renamed inline. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  /** Names just typed, shown until the next poll brings the stored one. */
  const [renamed, setRenamed] = useState<Record<string, string | null>>({});
  /** Role filter, client-side and per window: the roles present vary from one
   *  project to the next, so a stored "coder" would empty another project's
   *  list behind a filter nobody remembers setting. */
  const [roleFilter, setRoleFilter] = useState<string>('all');
  /** Groups the user flipped away from the stored default (`expandSubagents`):
   *  per window, not stored. A new default starts from a clean slate, or a
   *  group opened by hand would fold once the default opens them all. */
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [toggledFor, setToggledFor] = useState(expandSubagents);
  if (toggledFor !== expandSubagents) {
    setToggledFor(expandSubagents);
    setToggled(new Set());
  }

  // The role is the agent's field, never its name's suffix (AGENTS.md): the
  // identity's role once the agents are read, the row's own copy until then.
  const roleOf = useCallback(
    (m: MissionSummary) => identityOf(m.agent_name ?? agentId).roleKey ?? agentRoleKey(m.agent_role) ?? OTHER_ROLE,
    [identityOf, agentId],
  );
  // "Automated missions" off = the historical `mineOnly` (TODO #284): an origin
  // filter, not an owner one (TIM-0118).
  const rail = useMemo(
    () => buildMissionRail(missions, {
      group: groupByOrchestrator,
      hideAutomated: mineOnly,
      openMissionId: currentMissionId,
      roleOf,
      role: roleFilter,
    }),
    [missions, groupByOrchestrator, mineOnly, currentMissionId, roleOf, roleFilter],
  );
  const { activeRole } = rail;
  const roleLabel = (role: string) => (role === OTHER_ROLE ? i18n('missionRail.otherRole') : resolveRole(role)?.label ?? role);
  const filterChanged = activeRole !== 'all' || missionRailDisplayChanged(display);

  function toggleGroup(id: string) {
    setToggled((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** The standard confirmation of a destructive gesture in the product. */
  function confirmKill(id: string) {
    void confirmAction({ title: i18n('missionRail.killConfirm'), confirmLabel: i18n('confirmDialog.stop'), destructive: true })
      .then((yes) => { if (yes) void doKill(id); });
  }

  async function doKill(id: string) {
    setKilling(id);
    try { await onKill?.(id); } finally { setKilling(null); }
  }

  async function commitRename(id: string, value: string) {
    setRenaming(null);
    const title = value.replace(/\s+/g, ' ').trim() || null;
    setRenamed((prev) => ({ ...prev, [id]: title }));
    try {
      // A name typed here is `manual`: the daemon never overwrites it with a
      // generated one. Once stored, the list reads it from the row itself.
      const r = await fetch(`/api/ui/missions/${encodeURIComponent(id)}/title`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (r.ok) setRenamed((prev) => { const { [id]: _done, ...rest } = prev; return rest; });
    } catch {
      // The next poll restores the stored name.
    }
  }

  /** Name shown for a mission (`lib/mission-title.ts`): the stored title —
   *  typed here, set by the launcher or generated —, else the Kanban task
   *  title, else the prompt without its `TASK_ID: <uuid>` preamble. A name just
   *  typed shows at once, until the stream or the poll brings the stored one. */
  function titleOf(m: MissionSummary): string {
    return missionDisplayTitle({ ...m, title: m.id in renamed ? renamed[m.id] : m.title }, i18n('missionRail.emptyTitle'));
  }

  // A mission opens next to the page on screen (ISLAND-WORKSPACE.md §6, §11);
  // not while the layout is edited, where the card itself is what moves.
  const bus = useIslandBus();
  const draggableRows = canDragToIsland(bus) && !editing;
  const menuMission = menu ? missions.find((m) => m.id === menu.id) : undefined;
  // Absent until the CLI has reported its session (or from an older daemon).
  const menuSessionId = menuMission?.session_id ?? null;
  const menuItems: FileMenuItem[] = menuMission
    ? [
        {
          key: 'rename',
          label: i18n('chatPage.renameMission'),
          icon: <Pencil className="size-3.5" />,
          onSelect: () => setRenaming({ id: menuMission.id, value: titleOf(menuMission) }),
        },
        {
          key: 'copy-id',
          label: i18n('chatPage.copyMissionId'),
          icon: <Copy className="size-3.5" />,
          onSelect: () => { void navigator.clipboard?.writeText(menuMission.id).then(() => toast.success(menuMission.id), () => {}); },
        },
        ...(menuSessionId
          ? [{
              key: 'copy-session-id',
              label: i18n('chatPage.copyCliSessionId'),
              detail: shortSessionId(menuSessionId),
              title: menuSessionId,
              icon: <TerminalSquare className="size-3.5" />,
              onSelect: () => { void navigator.clipboard?.writeText(menuSessionId).then(() => toast.success(menuSessionId), () => {}); },
            }]
          : []),
        ...chatSplitActions(bus, menuMission.agent_name ?? agentId, menuMission.id)
          .map((a) => ({ ...a, icon: <Columns2 className="size-3.5" /> })),
        ...(onKill && menuMission.running
          ? [{
              key: 'stop',
              label: i18n('chatPage.stopMission'),
              icon: <Square className="size-3.5 fill-current" />,
              danger: true,
              onSelect: () => confirmKill(menuMission.id),
            }]
          : []),
      ]
    : [];

  /** One row of the rail. A group head gets its fold toggle and pulses while
   *  one of its children works. Unfolded children sit on a tinted island
   *  hung under their head, threaded by a timeline spine; each child row
   *  paints its own slice of the island (the first and last round its
   *  corners), so the group itself stays a box-less `contents`. A context
   *  head (another role than the filter's, kept to place its children) is
   *  dimmed, and says so to a screen reader. */
  function renderRow(
    m: MissionSummary,
    group?: { count: number; folded: boolean; forced: boolean; childWorking: boolean; context: boolean },
    child?: { first: boolean; last: boolean },
  ) {
    const on = m.id === currentMissionId;
    const needsAction = Boolean(m.pending_action_at);
    const isPinned = !m.task_id;
    // Prefer the Kanban task title when this mission was spawned
    // by the dispatcher; fall back to the prompt with the
    // `TASK_ID: <uuid>` preamble peeled off so the rail never
    // shows raw uuids as titles.
    const title = titleOf(m);
    const missionAgent = m.agent_name ?? agentId;
    // On the open mission, `thinking` (local SSE stream) is
    // fresher than the list's poll: it flips on the first delta.
    // On the others, we fall back to the turn state returned by
    // the server — otherwise only one mission showed the
    // indicator, the chat's.
    const isCurrentThinking = on ? thinking : !!m.turn_active;
    const state: ActiveState = isCurrentThinking || group?.childWorking ? 'thinking' : 'idle';
    const lastTs = m.last_event_at ?? m.started_at;
    const shortTaskId = m.task_id ? m.task_id.slice(0, 8) : null;
    // Someone else's mission (a superadmin's view, TIM-0118): its
    // owner's face, so the rail no longer reads as all the viewer's.
    const foreignOwner = m.owner && viewer && m.owner.id !== viewer.id ? humanSpeaker(m.owner, viewer) : null;
    return (
      <div
        key={m.id}
        data-mission-row={m.id}
        data-mission-context={group?.context ? '' : undefined}
        // The open mission stays in view: it sticks to the top or the
        // bottom edge when its real place is scrolled out. The opaque
        // fill keeps the rows it overlaps from showing through. Each row
        // is its own stacking context (`isolate`): the avatar lifts its
        // face with a z-index, which would otherwise climb over the
        // sticky row as the others scroll beneath it.
        // A child's island slice: the tint follows the theme (darker on a
        // light one, lighter on a dark one), the spine is a `before:` hairline,
        // not a border. The open child keeps an opaque fill under the same
        // tint, so it still hides the rows it overlaps while stuck.
        className={cn(
          'group relative isolate',
          child ? CHILD_ROW : 'mb-px',
          child?.first && 'rounded-t-md pt-1',
          child?.last && 'mb-1 rounded-b-md pb-1 before:bottom-2',
          on && 'sticky bottom-0 top-0 z-10',
          on && (child ? OPEN_CHILD_FILL : 'rounded-md bg-card'),
        )}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ id: m.id, x: e.clientX, y: e.clientY }); }}
        draggable={draggableRows && renaming?.id !== m.id}
        onDragStart={draggableRows ? (e) => startChatIslandDrag(e, missionAgent, m.id, { label: title }) : undefined}
      >
        {renaming?.id === m.id ? (
          <input
            autoFocus
            value={renaming.value}
            maxLength={200}
            placeholder={i18n('chatPage.missionNamePlaceholder')}
            aria-label={i18n('chatPage.renameMission')}
            onChange={(e) => setRenaming({ id: m.id, value: e.target.value })}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => void commitRename(m.id, renaming.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(m.id, renaming.value);
              if (e.key === 'Escape') setRenaming(null);
            }}
            className="w-full rounded-md border border-primary/35 bg-background px-2 py-2 text-[12.5px] font-medium outline-none"
          />
        ) : (
        <button
          type="button"
          onClick={() =>
            onPick(m.id, needsAction ? (m.pending_action_id ?? null) : null)
          }
          // `items-stretch` spelled out: the desktop client's Chromium
          // gives `<button>` `align-items: flex-start`, which sized the
          // rows to their title and let it overflow the card.
          className={cn(
            'flex w-full flex-col items-stretch gap-1.5 rounded-md px-2 py-2 text-left transition-colors',
            'hover:bg-muted/60',
            // Selected is a fill, not a frame: an outline here was the
            // loudest edge of the whole rail.
            on && 'bg-primary/[0.08]',
            needsAction && !on
              && 'border border-[hsl(var(--warning)/0.45)] bg-[hsl(var(--warning)/0.07)]',
          )}
        >
          <div
            className={cn('flex items-start gap-2', group ? 'pr-10' : 'pr-6', group?.context && 'opacity-60')}
            title={group?.context ? i18n('missionRail.contextHead', { role: roleLabel(activeRole) }) : undefined}
          >
            {showAvatar && (
              <ActiveAgentAvatar
                identity={identityOf(missionAgent)}
                state={state}
                size="sm"
                label={state === 'thinking' ? i18n('missionRail.working') : undefined}
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                {!showAvatar && state === 'thinking' && <WorkingDot />}
                <span className="truncate text-[12.5px] font-medium leading-snug">
                  {title.slice(0, 120)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground/75">
                {foreignOwner && (
                  <span className="inline-flex min-w-0 items-center gap-1" title={i18n('missionOrigin.ownedBy', { name: foreignOwner.name })} data-mission-owner={m.owner?.id}>
                    <HumanFace speaker={foreignOwner} className="size-3.5 shrink-0 rounded-full bg-primary/15 text-[7px] font-semibold text-primary" />
                    <span className="truncate">{foreignOwner.name}</span>
                  </span>
                )}
                {isMissionOrigin(m.origin) && m.origin !== 'user' && <MissionOriginIcon origin={m.origin} />}
                {/* Kanban task-type chip (code/review/…) — canonical visual. */}
                {!showAvatar && !isPinned && <RoleBadge role={m.task_type} size="xs" />}
                {(() => {
                  const role = agentRoleKey(m.agent_role);
                  const roleVisual = resolveRole(role);
                  // The avatar already carries the role as its sub-badge.
                  if (showAvatar || !roleVisual) return null;
                  // Dedup: if the task-type chip above already shows the
                  // same canonical role, don't repeat it.
                  if (!isPinned && resolveRole(m.task_type)?.key === roleVisual.key) return null;
                  return <RoleBadge role={role} size="xs" />;
                })()}
                {shortTaskId && (
                  <span
                    className="truncate text-muted-foreground/60"
                    title={m.task_id ?? undefined}
                  >
                    #{shortTaskId}
                  </span>
                )}
                <span className="shrink-0 whitespace-nowrap" title={formatDateTime(lastTs)} suppressHydrationWarning>
                  {formatRelativeTime(lastTs)}
                </span>
              </div>
            </div>
          </div>
          {needsAction && (
            <div
              className="inline-flex items-center gap-1 self-start rounded border border-[hsl(var(--warning)/0.45)] bg-[hsl(var(--warning)/0.12)] px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-[hsl(var(--warning))]"
              title={i18n('chatPage.agentAwaitingAuth')}
            >
              <AlertCircle className="size-3" />
              {i18n('chatPage.actionRequired')}
            </div>
          )}
          {group?.context && <span className="sr-only">{i18n('missionRail.contextHead', { role: roleLabel(activeRole) })}</span>}
        </button>
        )}
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1">
          {group && (
            <button
              type="button"
              aria-expanded={!group.folded}
              aria-label={i18n(group.folded ? 'missionRail.expandGroup' : 'missionRail.collapseGroup', { count: group.count })}
              title={i18n(group.folded ? 'missionRail.expandGroup' : 'missionRail.collapseGroup', { count: group.count })}
              // The group of the open mission stays unfolded: folding it
              // would hide the row the chat is showing.
              disabled={group.forced}
              onClick={(e) => { e.stopPropagation(); toggleGroup(m.id); }}
              className="inline-flex h-4 items-center gap-0.5 rounded px-1 text-[10px] font-medium tabular-nums text-muted-foreground outline-none transition-colors enabled:hover:bg-muted enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            >
              {group.count}
              <ChevronDown className={cn('size-3 transition-transform', group.folded && '-rotate-90')} />
            </button>
          )}
          <Slot name="mission.card.action" />
        </div>
        {onKill && m.running && (
          <button
            type="button"
            title={i18n('missionRail.kill')}
            aria-label={i18n('missionRail.kill')}
            disabled={killing === m.id}
            onClick={(e) => { e.stopPropagation(); confirmKill(m.id); }}
            className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded text-destructive opacity-0 transition-opacity hover:bg-destructive/15 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
          >
            {killing === m.id ? <span className="size-3 animate-spin rounded-full border border-destructive/60 border-t-transparent" /> : <Square className="size-3 fill-current" />}
          </button>
        )}
      </div>
    );
  }

  const CHECK_ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none focus:bg-muted data-[disabled]:opacity-50';
  const displayItems: { key: keyof MissionRailDisplay; label: string; checked: boolean; set: (v: boolean) => Partial<MissionRailDisplay>; disabled?: boolean }[] = [
    { key: 'mineOnly', label: i18n('missionRail.automated'), checked: !mineOnly, set: (v) => ({ mineOnly: !v }) },
    { key: 'groupByOrchestrator', label: i18n('missionRail.groupByOrchestrator'), checked: groupByOrchestrator, set: (v) => ({ groupByOrchestrator: v }) },
    // Only groups fold: without them the choice has nothing to act on.
    { key: 'expandSubagents', label: i18n('missionRail.expandSubagents'), checked: expandSubagents, set: (v) => ({ expandSubagents: v }), disabled: !groupByOrchestrator },
    { key: 'showAvatar', label: i18n('missionRail.avatar'), checked: showAvatar, set: (v) => ({ showAvatar: v }) },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The filter in effect, in words, then the two actions. */}
      <div className={WIDGET_TOOLBAR}>
        <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-muted-foreground" title={agentId}>
          {i18n('missionRail.summary', { filter: activeRole === 'all' ? i18n('missionRail.all') : roleLabel(activeRole), count: rail.count })}
        </span>
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <button type="button" title={i18n('missionRail.filter')} aria-label={i18n('missionRail.filter')} className={cn(widgetButtonClass({ iconOnly: true }), 'relative')}>
              <ListFilter className="size-3.5" />
              {filterChanged && <span aria-hidden data-filter-dot className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />}
            </button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content sideOffset={6} align="end" className="z-50 flex min-w-48 flex-col gap-2 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2">
              <NativeViewCover />
              {rail.roles.length > 1 && (
                <Dropdown.Group>
                  <Dropdown.Label className="px-2 py-1 text-[10.5px] font-medium text-muted-foreground">{i18n('missionRail.role')}</Dropdown.Label>
                  <Dropdown.RadioGroup value={activeRole} onValueChange={setRoleFilter}>
                    {[{ role: 'all', count: rail.total }, ...rail.roles].map((r) => (
                      <Dropdown.RadioItem key={r.role} value={r.role} onSelect={(e) => e.preventDefault()} className={CHECK_ITEM}>
                        <span className="grid w-3 place-items-center">
                          <Dropdown.ItemIndicator><Check className="size-3" /></Dropdown.ItemIndicator>
                        </span>
                        <span className="min-w-0 flex-1 truncate">{r.role === 'all' ? i18n('missionRail.all') : roleLabel(r.role)}</span>
                        <span className="tabular-nums text-muted-foreground">{r.count}</span>
                      </Dropdown.RadioItem>
                    ))}
                  </Dropdown.RadioGroup>
                </Dropdown.Group>
              )}
              <Dropdown.Group>
                <Dropdown.Label className="px-2 py-1 text-[10.5px] font-medium text-muted-foreground">{i18n('missionRail.display')}</Dropdown.Label>
                {displayItems.map((item) => (
                  <Dropdown.CheckboxItem
                    key={item.key}
                    checked={item.checked}
                    disabled={!displayStore.ready || item.disabled}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(v) => setDisplay(item.set(v === true))}
                    className={CHECK_ITEM}
                  >
                    <span className="grid w-3 place-items-center">
                      <Dropdown.ItemIndicator><Check className="size-3" /></Dropdown.ItemIndicator>
                    </span>
                    {item.label}
                  </Dropdown.CheckboxItem>
                ))}
              </Dropdown.Group>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
        <NewMissionMenu current={agentId} options={newMission} onNew={onNew}>
          <WidgetButton
            title={i18n('missionRail.newMission')}
            aria-label={i18n('missionRail.newMission')}
            icon={<SquarePen className="size-3.5" />}
          />
        </NewMissionMenu>
      </div>
      {menu && menuItems.length > 0 && (
        <FileContextMenu x={menu.x} y={menu.y} label={i18n('chatPage.renameMission')} items={menuItems} onClose={() => setMenu(null)} />
      )}
      <div className="flex-1 overflow-auto px-1.5 py-1.5">
        {rail.entries.length === 0 ? (
          <div className="px-2 py-3 text-[11.5px] text-muted-foreground/70">
            {missions.length === 0
              ? i18n('missionRail.noMissions')
              : rail.total === 0
                ? i18n('missionOrigin.noneByHand')
                : i18n('chatPage.noMissionForRole', { role: roleLabel(activeRole) })}
          </div>
        ) : (
          rail.entries.map(({ mission: head, children, context }) => {
            if (children.length === 0) return renderRow(head);
            const forced = children.some((c) => c.id === currentMissionId);
            const folded = !forced && expandSubagents === toggled.has(head.id);
            const childWorking = children.some((c) => (c.id === currentMissionId ? thinking : c.turn_active));
            // `contents`: the group draws no box of its own, so a sticky
            // child is bound by the scrolling list, not by its group's box.
            // The island is painted by the child rows themselves.
            return (
              <div key={head.id} data-mission-group={head.id} className="contents">
                {renderRow(head, { count: children.length, folded, forced, childWorking: !!childWorking, context })}
                {!folded && children.map((c, i) => renderRow(c, undefined, { first: i === 0, last: i === children.length - 1 }))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** The working cue when the avatar is hidden: the avatar ring's colour and pulse, on a dot. */
function WorkingDot() {
  const vis = STATE_VISUALS.thinking;
  return (
    <span className="relative inline-grid size-2 shrink-0" role="img" aria-label={i18n('missionRail.working')}>
      <span aria-hidden className="absolute inset-0 rounded-full opacity-70 motion-safe:animate-[ping_1.6s_ease-out_infinite] motion-reduce:hidden" style={{ background: vis.colorVar }} />
      <span aria-hidden className="relative size-2 rounded-full" style={{ background: vis.colorVar }} />
    </span>
  );
}
