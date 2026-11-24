'use client';

/**
 * The rail of bots as a widget (`plugin:@timon/bots:rail`).
 *
 * On `/bots` it sits in an island of its own, beside the route's island that
 * holds the chat: a pick writes `?agent=` and the chat follows. Dropped on any
 * other view, a pick brings the bot's chat to that view (`pickBot`), the
 * next picks re-targeting that same chat: never a page change.
 */

import { useCallback, useContext, useMemo, type ReactElement } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { IslandContentContext } from '@/components/islands/island-content';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { useActiveAgents } from '@/lib/active-agents';
import type { ActiveState } from '@/lib/agent-state';
import { useIslandBus } from '@/lib/island-bus';
import { cn } from '@/lib/utils';
import { BOTS_ROUTE } from './bots-islands';
import { pickBot } from './bots-pick';
import { BotsRail } from './bots-rail';
import { useBots } from './use-bots';

export function useBotStates(): Map<string, ActiveState> {
  const active = useActiveAgents();
  return useMemo(() => {
    const map = new Map<string, ActiveState>();
    for (const agent of active) map.set(agent.name, agent.state);
    return map;
  }, [active]);
}

/** Picks a bot from wherever the rail is painted; `after` runs once the pick is routed (closing a drawer). */
export function useBotPick(after?: () => void): (name: string) => void {
  const router = useRouter();
  const pathname = usePathname();
  const bus = useIslandBus();
  const inIsland = useContext(IslandContentContext) !== null;
  return useCallback((name: string) => {
    const href = pickBot({ agent: name, pathname, bus, inIsland });
    // `push`, not `replace`: on `/bots` picking a bot is a navigation the back
    // button undoes. A soft one: the view and its islands stay mounted. Also
    // the way out when the workspace refused to open the chat (island limit).
    if (href) router.push(href);
    after?.();
  }, [router, pathname, bus, inIsland, after]);
}

export function BotsRailWidget({ handle, className }: WidgetProps): ReactElement {
  const pathname = usePathname();
  const params = useSearchParams();
  const { bots, teams, refresh } = useBots();
  const states = useBotStates();
  const pick = useBotPick();
  // Only `/bots` names a selected bot: elsewhere the chats it opened are tabs.
  const selected = pathname === BOTS_ROUTE ? params.get('agent') : null;
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <BotsRail
        bots={bots}
        teams={teams}
        selected={selected}
        states={states}
        onSelect={pick}
        onChanged={refresh}
        headerActions={handle}
      />
    </div>
  );
}
