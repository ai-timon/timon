'use client';

import { ChatLink } from '@/components/chat/chat-link';
import { chatHref } from '@/lib/chat-island-params';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Users, X, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { compareText } from '@/lib/intl';
import { mainAgentOf } from '@/lib/main-agent';
import { onAgentStateEvent } from '@/lib/active-agents';
import { STATE_VISUALS, type ActiveState } from '@/lib/agent-state';
import { AgentAvatar, agentIdentity } from '@/components/agent-avatar';
import { useProjectMeta } from '@/hooks/use-project-meta';

/**
 * Mobile-only quick navigator for the agents canvas.
 *
 * The D3 constellation is hard to aim at on a phone, so this adds a
 * floating button (bottom-right, `md:hidden`) that opens a bottom-sheet
 * listing every orchestrator (`.main` / lead) agent with a live-status
 * dot and an instant name filter. Tapping a row opens that agent's chat
 * — same destination as double-clicking its node on desktop.
 *
 * Self-contained: fetches its own data (`/api/ui/agents` for the roster,
 * `/api/ui/agents/active` for live state) so it stays decoupled from the
 * D3 closure in agents-client. Uses the shared `sseOn` singleton — never
 * opens its own EventSource (6-connection HTTP/1.1 limit).
 */

type MainAgent = {
  name: string;
  project: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  role?: string | null;
  look?: unknown;
  avatar?: unknown;
  /** Live state from /agents/active, defaults to 'idle' when offline. */
  state: ActiveState;
  pending: number;
};

type RawAgent = {
  name: string;
  main?: boolean;
  role?: string | null;
  project?: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  /** Mascot look and picked head (`config.look`, `config.avatar`), read by `agentIdentity`. */
  look?: unknown;
  avatar?: unknown;
};

type RawActive = {
  name: string;
  state: ActiveState;
  pending_count?: number;
};

/** The main agent (flagged by the daemon) and every orchestrator — project
 *  leads and standalone ones alike. Read from the flag and the role, never
 *  from the name: `_main` / `<slug>.main` are only seed names, renamed away
 *  at onboarding, and a lead may be called anything (`assoJS`). */
export function isMainAgent(a: RawAgent): boolean {
  return a.main === true || a.role === 'orchestrator';
}

export function MobileAgentList() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [agents, setAgents] = useState<MainAgent[]>([]);
  // The project's logo and colour fill in for an agent without its own, as in every other view.
  const projects = useProjectMeta();

  const refresh = useCallback(async () => {
    try {
      const [rosterRes, activeRes] = await Promise.all([
        fetch('/api/ui/agents', { cache: 'no-store' }),
        fetch('/api/ui/agents/active', { cache: 'no-store' }),
      ]);
      const roster = rosterRes.ok ? await rosterRes.json() : { agents: [] };
      const active = activeRes.ok ? await activeRes.json() : { agents: [] };
      const stateByName = new Map<string, RawActive>(
        ((active.agents ?? []) as RawActive[]).map((a) => [a.name, a]),
      );
      const rosterAgents = (roster.agents ?? []) as RawAgent[];
      const principal = mainAgentOf(rosterAgents);
      const mains = rosterAgents
        .filter(isMainAgent)
        .map<MainAgent>((a) => {
          const live = stateByName.get(a.name);
          return {
            name: a.name,
            project: a.project ?? null,
            emoji: a.emoji,
            color: a.color,
            icon_url: a.icon_url,
            role: a.role ?? null,
            look: a.look,
            avatar: a.avatar,
            state: live?.state ?? 'idle',
            pending: live?.pending_count ?? 0,
          };
        })
        // The main agent first, then alphabetical.
        .sort((x, y) => {
          if (x.name === principal) return -1;
          if (y.name === principal) return 1;
          return compareText(x.name, y.name);
        });
      setAgents(mains);
    } catch { /* ignore */ }
  }, []);

  // Poll only while the drawer is open (no network load while the list is
  // closed). Also refresh on the SSE events that can change an agent's state.
  useEffect(() => {
    if (!open) return;
    refresh();
    const timer = setInterval(refresh, 4000);
    const stopStateEvents = onAgentStateEvent(() => { void refresh(); });
    return () => {
      clearInterval(timer);
      stopStateEvents();
    };
  }, [open, refresh]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => a.name.toLowerCase().includes(q));
  }, [agents, query]);

  // Swipe down on the handle → close. Follows the touch's Y delta.
  const dragY = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    dragY.current = e.touches[0]?.clientY ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = dragY.current;
    dragY.current = null;
    const end = e.changedTouches[0]?.clientY;
    if (start == null || end == null) return;
    if (end - start > 60) setOpen(false);
  };

  return (
    <>
      {/* FAB — mobile only, above the action bar. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('mobileAgentList.open')}
        className="fixed bottom-20 right-4 z-[7] grid size-12 place-items-center rounded-full border border-border bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95 md:hidden"
      >
        <Users className="size-5" />
      </button>

      {open && (
        <div className="timon-below-window-band fixed inset-0 z-[21] md:hidden" role="dialog" aria-modal="true" aria-label={t('mobileAgentList.title')}>
          {/* Backdrop — tap to close. */}
          <div
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          {/* Bottom sheet. */}
          <div className="absolute inset-x-0 bottom-0 flex max-h-[80vh] flex-col rounded-t-2xl bg-popover shadow-elev-3">
            {/* Handle + swipe down. */}
            <div
              className="flex flex-col items-center pt-2"
              onTouchStart={onTouchStart}
              onTouchEnd={onTouchEnd}
            >
              <span className="h-1 w-10 rounded-full bg-muted-foreground/40" />
            </div>

            <div className="flex items-center justify-between px-4 py-2">
              <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-foreground">
                {t('mobileAgentList.title')} <span className="text-muted-foreground">{/* i18n-exempt: decorative suffix */}.main</span>
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('mobileAgentList.close')}
                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Search. */}
            <div className="px-3 pb-2">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  type="text"
                  inputMode="search"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('mobileAgentList.search')}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label={t('mobileAgentList.clear')}
                    className="grid size-5 place-items-center rounded text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Scrollable list. */}
            <div className="flex-1 overflow-y-auto px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {filtered.length === 0 ? (
                <p className="py-8 text-center text-[12px] text-muted-foreground">
                  {t('mobileAgentList.empty')}
                </p>
              ) : (
                filtered.map((a) => {
                  const vis = STATE_VISUALS[a.state];
                  return (
                    <ChatLink
                      key={a.name}
                      href={chatHref(a.name)}
                      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors active:bg-muted"
                    >
                      {/* state dot */}
                      <span className="relative inline-flex size-2.5 shrink-0 items-center justify-center">
                        <span
                          className="size-2.5 rounded-full"
                          style={{ background: vis.colorVar }}
                        />
                        {vis.pulse && (
                          <span
                            className="absolute inset-[-3px] animate-[ping_1.6s_ease-out_infinite] rounded-full opacity-60"
                            style={{ border: `1px solid ${vis.colorVar}` }}
                            aria-hidden
                          />
                        )}
                      </span>
                      {/* The agent's head, by the same rule as every other view (docs/AGENT-AVATAR.md). */}
                      <AgentAvatar identity={agentIdentity(a, a.project ? projects.get(a.project) ?? null : null)} size="sm" roleBadge={false} />
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-[13px] text-foreground"
                          style={a.color ? { color: a.color } : undefined}
                        >
                          {a.name}
                        </span>
                        {a.project && (
                          <span className="block truncate text-[10px] text-muted-foreground">
                            [{a.project}]
                          </span>
                        )}
                      </span>
                      <span className={cn('shrink-0 tabular-nums text-[10.5px]', vis.textClass)}>
                        {t(vis.labelKey)}
                      </span>
                      {a.pending > 0 && (
                        <span
                          className="shrink-0 rounded px-1 tabular-nums text-[9.5px] font-bold"
                          style={{ background: vis.colorVar, color: '#0c0c0c' }}
                        >
                          {a.pending}
                        </span>
                      )}
                    </ChatLink>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
