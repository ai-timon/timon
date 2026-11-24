'use client';

import { useState } from 'react';

import { Tile } from '@/components/tile';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useChatRail } from '@/components/chat/chat-rails';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { formatTokens, tokensByOrigin, type InjectionBlock, type SkillReads } from '@/lib/agent-injections';
import { t } from '@/lib/i18n';
import { useAgents } from '../agent-chat/use-agents';
import { BlockBadges, BlockDetail, OnDemandNote, OriginBar, tokensLabel } from './injection-detail';
import { useAgentInjections } from './use-agent-injections';

function Row({ block, share, reads, onOpen }: { block: InjectionBlock; share: number; reads: SkillReads | null; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} aria-haspopup="dialog"
        className="flex w-full flex-col gap-1 rounded-lg border border-border bg-card/60 px-2.5 py-2 text-left hover:border-primary/50">
        <span className="flex items-center gap-2">
          {block.injected_by === 'timon' && (
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[10px] tabular-nums text-primary">{block.order}</span>
          )}
          <span className="min-w-0 flex-1 break-words text-xs font-medium">{block.label}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <BlockBadges block={block} reads={reads} />
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/80">{tokensLabel(block.tokens)}</span>
        </span>
        {block.injected_by === 'timon' && (
          <span aria-hidden className="h-0.5 overflow-hidden rounded bg-border/50">
            <span className="block h-full bg-primary/50" style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * The ordered list of everything Timon injects into an agent when it is spawned —
 * to understand an agent that drifts because of a rule it was handed, and to see
 * how much context goes out before the first message. The list is the daemon's,
 * computed by the very function the spawn uses. Files the backend CLI may load
 * on its own come last, unnumbered: Timon does not compose them, so they carry
 * no measured position.
 *
 * Pinned in an agent's chat it shows that agent and nothing else; anywhere else
 * it offers a choice of agent. A row opens the block in a dialog: an edit goes to
 * the real source the block names, then the list is read again.
 */
export function AgentInjectionsCard({ handle, className }: WidgetProps) {
  const chat = useChatRail();
  const agents = useAgents();
  const [chosen, setChosen] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const inChat = chat !== null;
  const agent = inChat ? chat.agent.name : chosen ?? agents[0]?.name ?? null;
  const { load, data, reload, reads } = useAgentInjections(agent, chat?.currentMissionId ?? null);
  const open = data?.blocks.find((b) => b.id === openId) ?? null;
  const origins = data ? tokensByOrigin(data.blocks) : [];

  return (
    <Tile
      title={t('agentInjections.title')}
      subtitle={data ? t('agentInjections.summary', { blocks: data.blocks.length, tokens: formatTokens(data.prompt_tokens) }) : undefined}
      className={className}
      actions={handle}
    >
      <div className="flex flex-col gap-3">
        {!inChat && (
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {t('agentInjections.agent')}
            <select
              value={agent ?? ''}
              onChange={(e) => { setChosen(e.target.value); setOpenId(null); }}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            >
              {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </label>
        )}
        {!agent && <p className="text-[11px] text-muted-foreground">{t('agentInjections.noAgent')}</p>}
        {load.state === 'loading' && <p className="text-[11px] text-muted-foreground">{t('agentInjections.loading')}</p>}
        {load.state === 'error' && <p role="alert" className="text-[11px] text-destructive">{t('agentInjections.error', { message: load.message })}</p>}
        {data && (
          <>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t('agentInjections.beforeFirst', { tokens: formatTokens(data.prompt_tokens) })}
            </p>
            <OnDemandNote tokens={data.on_demand_tokens} />
            <OriginBar origins={origins} />
            <ol key={data.agent} className="flex flex-col gap-1.5" aria-label={t('agentInjections.listLabel')}>
              {data.blocks.map((b) => (
                <Row key={b.id} block={b} share={data.prompt_tokens > 0 ? b.tokens / data.prompt_tokens : 0} reads={reads} onOpen={() => setOpenId(b.id)} />
              ))}
            </ol>
          </>
        )}
      </div>
      <Dialog open={open !== null} onOpenChange={(v) => { if (!v) setOpenId(null); }}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogTitle className="sr-only">{open?.label ?? t('agentInjections.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('agentInjections.dialogDescription')}</DialogDescription>
          {open && data && <BlockDetail agent={data.agent} block={open} onSaved={reload} reads={reads} />}
        </DialogContent>
      </Dialog>
    </Tile>
  );
}
