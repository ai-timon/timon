'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronsDownUp, ChevronsUpDown, CircleUserRound, Copy, FolderInput, LocateFixed, MessageSquare, Network, Settings2, Shapes, Trash2 } from 'lucide-react';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { deleteAgentAfterConfirm } from '@/components/agent-editor/delete-agent';
import { useCan } from '@/hooks/use-me';
import { ChatLink } from '@/components/chat/chat-link';
import { chatHref } from '@/lib/chat-island-params';
import type { Hierarchy } from '@/lib/hierarchy';
import { t } from '@/lib/i18n';
import type { FoldInfo, PoleRecord } from './agents-client';
import { NativeViewCover } from '@/lib/native-view-cover';

export type MenuTarget = { id: string; x: number; y: number };

type Agent = { name: string; project?: string | null };

/** Right-click menu of a graph node (or of a row of the Organization tree). */
export function NodeMenu({ target, agents, poles, hierarchy, mainAgent, fold, pinned, onClose, onReportsTo, onMovePole, onEditPole, onDuplicate, onToggleFold, onResetPosition }: {
  target: MenuTarget;
  agents: readonly Agent[];
  poles: readonly PoleRecord[];
  hierarchy: Hierarchy;
  /** The main orchestrator, which the daemon refuses to delete. */
  mainAgent?: string | null;
  /** Null for a node without sub-agents, or outside the graph. */
  fold?: FoldInfo | null;
  /** The node was moved by hand on the graph. */
  pinned?: boolean;
  onClose: () => void;
  onReportsTo: (agent: string, manager: string | null) => void;
  onMovePole: (agent: string, project: string, pole: PoleRecord | null) => void;
  onEditPole: (pole: PoleRecord) => void;
  onDuplicate: (agent: string) => void;
  onToggleFold?: () => void;
  onResetPosition?: () => void;
}) {
  const [mode, setMode] = useState<'root' | 'reports' | 'pole'>('root');
  // The agent's face is its config: only an account that may edit agents gets the entry.
  const canEditAgents = useCan('agents:manage') === true;
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });

  const poleSlug = target.id.startsWith('workspace:') ? target.id.slice('workspace:'.length) : hierarchy.workspaceOfLead.get(target.id) ?? null;
  const pole = poleSlug ? poles.find((p) => p.slug === poleSlug) ?? null : null;
  const agent = agents.find((a) => a.name === target.id) ?? null;
  const project = agent?.project ?? null;
  const leadsProject = !!project && hierarchy.leadOfProject.get(project.toLowerCase()) === agent?.name;
  // Offered only where the daemon would accept it: deleting takes
  // agents:manage, and the main orchestrator's seat must be handed over first.
  const canDelete = !!agent && canEditAgents && agent.name.toLowerCase() !== mainAgent?.toLowerCase();

  // Keep the menu inside the window, whichever corner was clicked.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(target.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - r.height - 8)),
    });
  }, [target.x, target.y, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Capture phase: d3-zoom and d3-drag stop the mousedown's propagation, so a
    // bubbling listener never hears a click on the graph (TIM-0123).
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown, true); };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none';

  const picker = (entries: Array<{ key: string; label: string; onPick: () => void }>) => (
    <>
      <button type="button" className={item} onClick={() => { setMode('root'); setQuery(''); }}>
        <ArrowLeft className="size-3.5" />{t('agentsPage.menuBack')}
      </button>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('agentsPage.menuSearch')}
        className="my-1 h-8 w-full rounded border border-input bg-card px-2 text-[12.5px]"
      />
      <div className="max-h-64 overflow-y-auto">
        {entries.filter((e) => !q || e.label.toLowerCase().includes(q)).map((e) => (
          <button type="button" key={e.key} className={item} onClick={() => { e.onPick(); onClose(); }}>
            <span className="truncate">{e.label}</span>
          </button>
        ))}
      </div>
    </>
  );

  // In `<body>`: the menu is placed in window coordinates (the pointer's, a
  // button's rectangle), and the page may sit in an island of the workspace,
  // where a `fixed` element resolves against the island instead (§1).
  return createPortal(
    <div
      ref={box}
      role="menu"
      className="fixed z-[60] w-64 rounded-lg border border-border bg-popover p-1 shadow-elev-3"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <NativeViewCover />
      <div className="truncate px-2 pb-1 pt-1.5 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
        {pole && !agent ? pole.name : target.id}
      </div>
      {mode === 'root' && (
        <>
          {agent && (
            <>
              <ChatLink className={item} href={chatHref(agent.name)} onClick={onClose}>
                <MessageSquare className="size-3.5" />{t('agentsPage.menuChat')}
              </ChatLink>
              <button type="button" className={item} onClick={() => { openAgentEditor({ agent: agent.name }); onClose(); }}>
                <Settings2 className="size-3.5" />{t('agentsPage.menuConfigure')}
              </button>
              {canEditAgents && (
                <button type="button" className={item} data-menu-change-avatar onClick={() => { openAgentEditor({ agent: agent.name, tab: 'avatar' }); onClose(); }}>
                  <CircleUserRound className="size-3.5" />{t('agentsPage.menuChangeAvatar')}
                </button>
              )}
              <button type="button" className={item} onClick={() => { onDuplicate(agent.name); onClose(); }}>
                <Copy className="size-3.5" />{t('agentsPage.menuDuplicate')}
              </button>
              <button type="button" className={item} onClick={() => setMode('reports')}>
                <Network className="size-3.5" />{t('agentsPage.menuReportsTo')}
              </button>
              {leadsProject && (
                <button type="button" className={item} onClick={() => setMode('pole')}>
                  <FolderInput className="size-3.5" />{t('agentsPage.menuMovePole')}
                </button>
              )}
            </>
          )}
          {fold && onToggleFold && (
            <button type="button" className={item} onClick={() => { onToggleFold(); onClose(); }}>
              {fold.folded
                ? <><ChevronsUpDown className="size-3.5" />{t('agentsPage.menuUnfold')}</>
                : <><ChevronsDownUp className="size-3.5" />{t('agentsPage.menuFold')}</>}
            </button>
          )}
          {pinned && onResetPosition && (
            <button type="button" className={item} onClick={() => { onResetPosition(); onClose(); }}>
              <LocateFixed className="size-3.5" />{t('agentsPage.menuResetPosition')}
            </button>
          )}
          {pole && (
            <button type="button" className={item} onClick={() => { onEditPole(pole); onClose(); }}>
              <Shapes className="size-3.5" />{t('agentsPage.editPoleNamed', { name: pole.name })}
            </button>
          )}
          {/* Last, set apart by a gap: the one entry that removes something. */}
          {canDelete && agent && (
            <button
              type="button"
              className={`${item} mt-1 text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10`}
              data-menu-delete-agent
              onClick={() => { onClose(); void deleteAgentAfterConfirm(agent.name); }}
            >
              <Trash2 className="size-3.5" />{t('agentsPage.menuDelete')}
            </button>
          )}
        </>
      )}
      {mode === 'reports' && agent && picker([
        { key: '', label: t('agentsPage.menuDefault'), onPick: () => onReportsTo(agent.name, null) },
        ...agents
          .filter((a) => a.name !== agent.name)
          .map((a) => ({ key: a.name, label: a.name, onPick: () => onReportsTo(agent.name, a.name) })),
      ])}
      {mode === 'pole' && agent && project && picker([
        { key: '', label: t('agentsPage.menuNoPole'), onPick: () => onMovePole(agent.name, project, null) },
        ...poles.map((p) => ({ key: p.slug, label: p.name, onPick: () => onMovePole(agent.name, project, p) })),
      ])}
    </div>,
    document.body,
  );
}
