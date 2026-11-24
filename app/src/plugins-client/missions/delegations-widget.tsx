'use client';

/**
 * "Waiting for a reply" — the child missions of the open conversation.
 *
 * The card reads the chat through its context, like the other rail cards:
 * outside a chat (in the cockpit, where it can be moved like any tile) it
 * finds nothing and paints nothing.
 *
 * `frame: 'none'`: it paints its own chassis, which is the only way to paint
 * NONE when there is nothing to wait for. Framed by the host, an empty card
 * would leave a titled 220 px block — the "chatty emptiness" we do not want.
 * It reappears while rearranging (`editing`), otherwise an invisible card
 * could no longer be moved or removed.
 *
 * The seconds counter is LOCAL, and only ticks when it has something to
 * count: putting it in the shared context would re-render the whole rail
 * every second (see `RunningToolBar`).
 */

import { ChatLink } from '@/components/chat/chat-link';
import { chatHref } from '@/lib/chat-island-params';
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Tile } from '@/components/tile';
import { useChatRail } from '@/components/chat/chat-rails';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { cn } from '@/lib/utils';
import { formatElapsed } from '@/lib/elapsed';
import { t } from '@/lib/i18n';
import type { Delegation } from '@/hooks/use-delegations';

export function DelegationsWidget({ handle, className, editing }: WidgetProps) {
  const chat = useChatRail();
  const delegations = chat?.delegations ?? [];
  const [now, setNow] = useState(() => Date.now());
  const active = delegations.length > 0;

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!active && !editing) return null;

  return (
    <Tile
      title={t('delegations.title')}
      subtitle={active ? String(delegations.length) : null}
      className={cn('border-border bg-card', className)}
      actions={handle}
      bodyClassName="p-0"
    >
      {active ? (
        <ul className="space-y-2 overflow-y-auto p-3">
          {delegations.map((d) => (
            <DelegationRow key={d.id} delegation={d} now={now} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-4 text-center text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/50">
          {t('delegations.none')}
        </p>
      )}
    </Tile>
  );
}

function DelegationRow({ delegation: d, now }: { delegation: Delegation; now: number }) {
  return (
    <li className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-1.5 flex-none rounded-full',
            d.turn_active ? 'animate-pulse bg-primary' : 'bg-muted-foreground/40',
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{d.agent_name}</span>
        <span className="flex-none text-[10.5px] tabular-nums text-muted-foreground/80">
          {formatElapsed(now - d.started_at)}
        </span>
        <ChatLink
          href={chatHref(d.agent_name, d.id)}
          className="flex-none text-muted-foreground/70 hover:text-foreground"
          title={t('delegations.open')}
        >
          <ExternalLink className="size-3" aria-hidden="true" />
        </ChatLink>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground" title={d.excerpt}>
        {d.task_title ?? d.excerpt}
      </p>
      <p className="mt-0.5 text-[10.5px] text-muted-foreground/70">
        {d.turn_active ? t('delegations.working') : t('delegations.idle')}
      </p>
    </li>
  );
}
