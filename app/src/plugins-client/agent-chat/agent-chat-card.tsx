'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import dynamic from 'next/dynamic';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { Tile } from '@/components/tile';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { apiErrorMessage } from '@/lib/api-error';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AgentAdd } from './agent-add';
import { AgentShortcuts } from './agent-shortcuts';
import { AgentContextMenu, useChangeAvatar, type AgentMenuTarget } from './agent-context-menu';
import { DuplicateAgentDialog } from '@/components/duplicate-agent-dialog';
import { CustomizeAgentDialog } from './customize-agent-dialog';
import {
  shownAgent,
  instanceModes,
  customizationOf,
  customizeAgent,
  removeAgent,
  type AgentChatInstance,
} from './instances';
import { useAgents, useProjects, agentFace } from './use-agents';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

// Loaded on demand: statically imported, it weighed on every page of the app.
const ChatClient = dynamic(() => import('@/app/chat/chat-client').then((m) => m.ChatClient), { ssr: false });

type StopReport = { missions: unknown[]; messages: unknown[]; tasks: unknown[]; triggers: unknown[]; workflow_runs?: unknown[]; workflows?: unknown[] };

/** Technical stop of one agent (`POST /api/stop`), confirmed first: it kills
 *  missions and blocks tasks, which a mis-click must not do. */
async function arreterAgent(nom: string): Promise<void> {
  if (!(await confirmAction({ title: t('agentChat.menu.stopConfirm', { name: nom }), confirmLabel: t('confirmDialog.stop'), destructive: true }))) return;
  try {
    const res = await fetch('/api/ui/stop', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: nom }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = apiErrorMessage(data, { status: res.status });
      toast.error(t('agentChat.menu.stopFailed', { name: nom, error }));
      return;
    }
    const report = data as StopReport;
    toast.success(t('agentChat.menu.stopped', {
      name: nom,
      missions: report.missions.length,
      messages: report.messages.length,
      tasks: report.tasks.length,
      triggers: report.triggers.length,
      runs: report.workflow_runs?.length ?? 0,
      workflows: report.workflows?.length ?? 0,
    }));
  } catch (err) {
    toast.error(t('agentChat.menu.stopFailed', { name: nom, error: (err as Error).message }));
  }
}

/** Seats an orchestrator as the one every wake recap and notification is
 *  addressed to (`PUT /api/agents/main`); the daemon refuses an agent that is
 *  not a cross-project orchestrator. */
async function definirOrchestratrice(nom: string): Promise<void> {
  try {
    const res = await fetch('/api/ui/agents/main', {
      method: 'PUT',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: nom }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = apiErrorMessage(data, { status: res.status });
      toast.error(t('agentChat.menu.makeMainFailed', { name: nom, error }));
      return;
    }
    toast.success(t('agentChat.menu.makeMainDone', { name: nom }));
  } catch (err) {
    toast.error(t('agentChat.menu.makeMainFailed', { name: nom, error: (err as Error).message }));
  }
}

/**
 * One agent's thread, as a card.
 *
 * This is what the cockpit's hard-coded medallion became once made generic: a
 * row of agent avatars on top — the current one larger, standing for the
 * medallion — and the same `ChatClient` below. Nothing of the thread is
 * reimplemented — resuming the last conversation, the model picker, the context
 * gauge, the tools in flight all come from `/chat` itself, and a second chat
 * kept in parallel would be an endless rewrite of what it already does.
 *
 * What that tile knew in its code — one agent, one sub-agent under it — is now
 * the instance's config: the card renders any agent, with any ordered list of
 * sub-agents as avatar shortcuts on top. The tile itself is gone.
 */
export function AgentChatCard({
  instance,
  onSave,
  onDelete,
  handle,
  editing = false,
  className,
}: WidgetProps & {
  instance: AgentChatInstance;
  onSave: (instance: AgentChatInstance) => void;
  onDelete: () => void;
}) {
  // Selected agent: the instance's own, or one of its sub-agents. Kept as a
  // name rather than an index so reordering the config doesn't switch thread.
  const [selection, setSelection] = useState(instance.agent);
  // Right-click menu of an avatar, and the agent being customised.
  const [menu, setMenu] = useState<AgentMenuTarget | null>(null);
  // The agent's face is its config: only an account that may edit agents gets the entry.
  const changeAvatar = useChangeAvatar();
  const [personnalise, setPersonnalise] = useState<string | null>(null);
  const [duplique, setDuplique] = useState<string | null>(null);
  const agents = useAgents();
  const projets = useProjects();

  const modes = useMemo(() => instanceModes(instance), [instance]);
  const onCard = useMemo(() => new Set(modes.map((m) => m.value.toLowerCase())), [modes]);
  const agent = shownAgent(instance, selection);

  const changerAgent = useCallback((nom: string) => {
    setSelection(nom);
  }, []);

  const retirer = useCallback((nom: string) => {
    const suivante = removeAgent(instance, nom);
    if (suivante) onSave(suivante);
    else onDelete();
  }, [instance, onSave, onDelete]);

  return (
    <Tile
      // The header row only exists while editing the layout, for the drag
      // handle. Everything else about the card is on the avatars' right-click
      // menu; new conversation and voice live in the composer.
      className={cn(className)}
      bodyClassName="p-0"
      actions={editing ? handle : undefined}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* The one picture of the card: one avatar per agent, the current
            one larger. Right-click on one opens its menu. */}
        <div className="flex shrink-0 items-center justify-center pr-2">
          <AgentShortcuts
            modes={modes}
            active={agent}
            agents={agents}
            projets={projets}
            onSelect={changerAgent}
            onContextMenu={(nom, e) => setMenu({ agent: nom, x: e.clientX, y: e.clientY })}
          />
          <AgentAdd
            agents={agents}
            projets={projets}
            excluded={onCard}
            onAdd={(nom) => onSave({ ...instance, subAgents: [...instance.subAgents, { agent: nom }] })}
          />
        </div>

        {/* `key` forces a full remount on agent change: without it the
            internal state (mission, messages, stream) would leak from one
            agent to the next. */}
        <div className="min-h-0 flex-1">
          <Suspense fallback={null}>
            <ChatClient
              key={agent}
              forcedAgent={agent}
              compact
              chromeComplet
            />
          </Suspense>
        </div>
      </div>

      {menu && (
        <AgentContextMenu
          target={menu}
          onClose={() => setMenu(null)}
          onCustomize={() => setPersonnalise(menu.agent)}
          onChangeAvatar={changeAvatar ? () => changeAvatar(menu.agent) : undefined}
          onEdit={() => openAgentEditor({ agent: menu.agent })}
          onDuplicate={() => setDuplique(menu.agent)}
          onRemove={() => retirer(menu.agent)}
          onStop={() => { void arreterAgent(menu.agent); }}
          onMakeMain={() => { void definirOrchestratrice(menu.agent); }}
        />
      )}
      {duplique && <DuplicateAgentDialog source={duplique} onClose={() => setDuplique(null)} />}
      {personnalise && (
        <CustomizeAgentDialog
          agent={personnalise}
          initial={customizationOf(instance, personnalise)}
          visage={agentFace(personnalise, agents, projets)}
          onClose={() => setPersonnalise(null)}
          onSave={(valeur) => {
            onSave(customizeAgent(instance, personnalise, valeur));
            setPersonnalise(null);
          }}
        />
      )}
    </Tile>
  );
}
