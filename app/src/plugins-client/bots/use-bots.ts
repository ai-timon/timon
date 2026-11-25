'use client';

/**
 * Bots and teams of the `/bots` view, in one store shared by every reader
 * (the rail widget and the chat page).
 *
 * Both lists are re-read on demand (`refresh`) because every mutation of the
 * teams menu changes one or the other: renaming a team, or moving a bot,
 * which is written on the bot's own config. They are also re-read when an
 * agent is saved elsewhere (`AGENTS_CHANGED_EVENT`): "New TIM" opens the
 * shared agent editor, which knows nothing of this view, and the new TIM
 * only showed after a reload.
 */
import { useSyncExternalStore } from 'react';
import { isGlobalAgent } from '@/app/agents-grid/agents-grid-client';
import { AGENTS_CHANGED_EVENT } from '@/lib/agents-changed';
import { mainBotOf, type Bot, type Team } from './types';

/** A bot of this view: every agent the user named, project or not, but no
 *  workspace hub. Ephemeral agents are left out — they are the throwaway
 *  product of a mission, and they would bury the handful of bots the user
 *  actually named. A project agent stays listed: its team is where the user
 *  looks for it, and the team is shown nowhere else. The main agent is kept
 *  under whatever name the daemon flags (`mainBotOf`), never by its seed name
 *  `_main`, which onboarding renames away. */
export function isListedBot(bot: Bot, mainName: string | null): boolean {
  if (bot.ephemeral) return false;
  return bot.name === mainName || !isGlobalAgent(bot.name);
}

export type BotsData = {
  bots: Bot[];
  teams: Team[];
  loading: boolean;
  refresh: () => Promise<void>;
};

type BotsSnapshot = Omit<BotsData, 'refresh'>;

/**
 * One store for the whole page, not one per caller: the rail widget and the
 * chat page both read it, and two private copies meant two reads of each list
 * and a chat banner that only saw a team move made in the rail at the next
 * read. Every caller now shares one snapshot, refreshed by `refresh()`.
 */
const INITIAL: BotsSnapshot = { bots: [], teams: [], loading: true };

let snapshot: BotsSnapshot = INITIAL;
const subscribers = new Set<() => void>();
/** Bumped when the last reader leaves: an answer still in flight then belongs
 *  to a past session of the store and must not repaint the next one. */
let epoch = 0;
let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;

function publish(next: BotsSnapshot): void {
  snapshot = next;
  for (const fn of subscribers) fn();
}

async function read(): Promise<void> {
  const at = epoch;
  const [agentsRes, teamsRes] = await Promise.all([
    fetch('/api/ui/agents', { cache: 'no-store' }).catch(() => null),
    fetch('/api/ui/teams', { cache: 'no-store' }).catch(() => null),
  ]);
  let { bots, teams } = snapshot;
  try {
    if (agentsRes?.ok) {
      const json = (await agentsRes.json()) as { agents?: Bot[] };
      const all = json.agents ?? [];
      const mainName = mainBotOf(all);
      bots = all.filter((b) => isListedBot(b, mainName));
    }
    // Teams are optional: a daemon older than the teams routes answers 404,
    // and the rail then shows every bot under "no team" instead of nothing.
    if (teamsRes?.ok) {
      const json = (await teamsRes.json()) as { teams?: Team[] };
      teams = json.teams ?? [];
    }
  } catch {
    /* an unreadable answer keeps the last known lists */
  }
  if (at !== epoch) return;
  publish({ bots, teams, loading: false });
}

/**
 * Re-reads both lists. A call made while a read is in flight is not folded
 * into it: that read may have left before the mutation the caller just made,
 * so one more read follows it, shared by every call made in the meantime.
 */
function refresh(): Promise<void> {
  if (!running) {
    running = read().finally(() => { running = null; });
    return running;
  }
  queued ??= running.then(() => {
    queued = null;
    return refresh();
  });
  return queued;
}

function onAgentsChanged(): void {
  void refresh();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (subscribers.size === 1) {
    // An agent saved elsewhere ("New TIM" opens the shared agent editor,
    // which knows nothing of this view) re-reads the lists at once.
    window.addEventListener(AGENTS_CHANGED_EVENT, onAgentsChanged);
    void refresh();
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size > 0) return;
    window.removeEventListener(AGENTS_CHANGED_EVENT, onAgentsChanged);
    // Nobody reads the lists any more: the next reader starts from a blank,
    // loading store, as a fresh mount always did, rather than from lists
    // that may belong to another session.
    epoch += 1;
    snapshot = INITIAL;
  };
}

const getSnapshot = (): BotsSnapshot => snapshot;
const getServerSnapshot = (): BotsSnapshot => INITIAL;

export function useBots(): BotsData {
  const { bots, teams, loading } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { bots, teams, loading, refresh };
}
