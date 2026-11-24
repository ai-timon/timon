'use client';

import { useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { Plus, X, ChevronsLeftRight, Columns2, Pencil } from 'lucide-react';
import { FileContextMenu } from '@/components/chat/file-context-menu';
import { AgentHead, agentIdentity, showsMascot } from '@/components/agent-avatar';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import {
  autoColorFor,
  type AgentMeta,
  type ProjectMeta,
  type Slot,
} from './types';
import { MissionPicker } from './mission-picker';
import { OpenMissionLink } from './open-mission-link';
import { AGENT_DRAG_TYPE, SlotDropZone } from './slot-drop-zone';
import { useIslandBus } from '@/lib/island-bus';
import { canDragToIsland, chatSplitActions, startChatIslandDrag } from '@/lib/chat-island-drag';
import { useMultichatGrid } from './grid-hold';

// Loaded on demand: an empty grid, or a cell still picking its mission,
// never fetches the chat.
const ChatClient = dynamic(() => import('@/app/chat/chat-client').then((m) => m.ChatClient), { ssr: false });

export function ChatSlot({
  slot,
  slotIndex,
  agent,
  project,
  needsAction,
  draggingAgent,
  swap,
  onDragAgent,
  onDropAgent,
  onClear,
  onPickMission,
  onNewConversation,
  onResetMission,
  onMissionChange,
}: {
  slot: Slot;
  slotIndex: number;
  agent: AgentMeta | null;
  project: ProjectMeta | null;
  needsAction: boolean;
  /** Agent being dragged anywhere on the page, or null. */
  draggingAgent: string | null;
  /** The dragged agent sits in another cell: a drop here swaps them. */
  swap: boolean;
  /** Start (a name) or end (null) of a drag from this cell's header. */
  onDragAgent: (agentName: string | null) => void;
  onDropAgent: (agentName: string, slotIndex: number) => void;
  onClear: (slotIndex: number) => void;
  /** Pick an existing mission for this slot. */
  onPickMission: (slotIndex: number, missionId: string) => void;
  /** Force the slot back to mission-picker (e.g. user wants to start a new
   *  conversation rather than continue current one). */
  onResetMission: (slotIndex: number) => void;
  onNewConversation: (slotIndex: number) => void;
  /** Report the running chat's actual mission without changing its mount key. */
  onMissionChange?: (missionId: string) => void;
}) {
  const bus = useIslandBus();
  const grid = useMultichatGrid();
  // "Open in a split" on the header: the cell's chat, mission included, moves
  // into the workspace and the cell empties — the drag's own rule (§13).
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [reported, setReported] = useState<{ slot: Slot; missionId: string } | null>(null);
  const missionId = reported?.slot === slot ? reported.missionId : slot.missionId;
  const reportMission = useCallback((id: string | null) => {
    // The initial null precedes loading a forced mission; it cannot replace it.
    if (!id) return;
    setReported({ slot, missionId: id });
    onMissionChange?.(id);
  }, [slot, onMissionChange]);
  const splitActions = agent ? chatSplitActions(bus, agent.name, missionId ?? null, () => onClear(slotIndex)) : [];
  const slug = agent?.project ?? null;
  const projectColor = useMemo(
    () => project?.color || (slug ? autoColorFor(slug) : 'hsl(var(--border))'),
    [project, slug],
  );
  // Same resolution as `AgentAvatar`: the picked head first (docs/AGENT-AVATAR.md).
  const identity = useMemo(() => (agent ? agentIdentity(agent, project) : null), [agent, project]);

  return (
    <SlotDropZone
      slotIndex={slotIndex}
      draggingAgent={draggingAgent}
      occupant={agent?.name ?? null}
      swap={swap}
      onDropAgent={onDropAgent}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border-2 bg-card/50 backdrop-blur transition-shadow',
        needsAction && 'mc-needs-action',
      )}
      style={{
        borderColor: projectColor,
        background: agent
          ? `radial-gradient(ellipse at top left, ${projectColor}14, transparent 60%), hsl(var(--card) / 0.5)`
          : undefined,
      }}
    >
      {/* One thin line: who is in the cell, then its actions. The identity
          part is a drag handle, so an agent moves to another cell (or swaps
          with its occupant) without a trip through the rail. */}
      {agent ? (
        <div
          className="flex h-7 shrink-0 items-center gap-1.5 px-2"
          style={{ background: `${projectColor}18` }}
          onContextMenu={splitActions.length > 0 ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } : undefined}
          onKeyDown={(e) => {
            if (splitActions.length === 0 || (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10'))) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          <div
            draggable
            tabIndex={splitActions.length > 0 ? 0 : undefined}
            aria-label={t('multichat.slot.openMenu', { name: agent.name })}
            aria-haspopup={splitActions.length > 0 ? 'menu' : undefined}
            onDragStart={(e) => {
              e.dataTransfer.setData(AGENT_DRAG_TYPE, agent.name);
              e.dataTransfer.effectAllowed = 'move';
              // The cell's chat, mission included, into the island workspace
              // (ISLAND-WORKSPACE.md §6) anywhere but over the grid (§13). It
              // moves there: the cell empties, as it does for another cell.
              if (canDragToIsland(bus)) {
                startChatIslandDrag(e, agent.name, missionId ?? null, { hold: grid(), onDropped: () => onClear(slotIndex) });
              }
              onDragAgent(agent.name);
            }}
            onDragEnd={() => onDragAgent(null)}
            title={t('multichat.slot.move', { name: agent.name })}
            className="flex min-w-0 cursor-grab items-center gap-1.5 active:cursor-grabbing"
          >
            {identity && (
              <div
                className={cn(
                  'grid size-4 shrink-0 place-items-center text-[8px] font-bold',
                  // A mascot is its own frame: a clipped disc would cut its ears.
                  !showsMascot(identity) && 'overflow-hidden rounded-full border bg-background',
                )}
                style={showsMascot(identity) ? undefined : { borderColor: projectColor }}
              >
                <AgentHead identity={identity} px={16} glyphClassName="uppercase" glyphStyle={{ color: projectColor }} />
              </div>
            )}
            <span className="truncate text-[10.5px] font-semibold text-foreground">
              {agent.name}
            </span>
            {project?.name && (
              <span
                className="truncate text-[9px] uppercase tracking-[0.08em]"
                style={{ color: projectColor }}
              >
                {project.name}
              </span>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Link
              href={`/edit?agent=${encodeURIComponent(agent.name)}`}
              onClick={(e) => {
                e.preventDefault();
                openAgentEditor({ agent: agent.name });
              }}
              title={t('multichat.slot.edit')}
              aria-label={t('multichat.slot.edit')}
              className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil className="size-2.5" />
            </Link>
            <OpenMissionLink agent={agent.name} missionId={missionId} />
            {(slot.missionId || slot.newConvKey) && (
              <button
                type="button"
                onClick={() => onResetMission(slotIndex)}
                aria-label={t('multichat.slot.changeMission')}
                title={t('multichat.slot.changeMission')}
                className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronsLeftRight className="size-2.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onClear(slotIndex)}
              title={t('multichat.slot.clear')}
              aria-label={t('multichat.slot.clear')}
              className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
            >
              <X className="size-2.5" />
            </button>
          </div>
        </div>
      ) : null}
      {menu && splitActions.length > 0 && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          label={t('islands.openIn.menu')}
          items={splitActions.map((a) => ({ ...a, icon: <Columns2 className="size-3.5" /> }))}
          onClose={closeMenu}
        />
      )}

      {/* Slot body */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {!agent ? (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <div className="grid size-10 place-items-center rounded-full border-2 border-dashed border-border">
                <Plus className="size-5 opacity-50" />
              </div>
              <p className="text-[11px]">
                {t('multichat.slot.empty')}
              </p>
            </div>
          </div>
        ) : !slot.missionId && !slot.newConvKey ? (
          <MissionPicker
            agentName={agent.name}
            onPick={(mid) => onPickMission(slotIndex, mid)}
            onNewConversation={() => onNewConversation(slotIndex)}
          />
        ) : (
          // Mount ChatClient in compact mode. Key on agent+mission (or
          // agent+new:N for a fresh chat) so any switch fully remounts
          // — avoids state bleed and forces a clean remount when the
          // user clicks "New" several times in a row.
          <div className="flex h-full min-h-0 flex-col">
            <ChatClient
              key={
                slot.missionId
                  ? `${agent.name}:${slot.missionId}`
                  : `${agent.name}:new:${slot.newConvKey}`
              }
              forcedAgent={agent.name}
              forcedMission={slot.missionId ?? undefined}
              initialFresh={!slot.missionId && !!slot.newConvKey}
              onMissionChange={reportMission}
              compact
            />
          </div>
        )}
      </div>
    </SlotDropZone>
  );
}
