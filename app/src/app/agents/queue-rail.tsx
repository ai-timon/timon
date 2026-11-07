'use client';

import { ChatLink } from '@/components/chat/chat-link';
import { Tile } from '@/components/tile';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { useChatRail } from '@/components/chat/chat-rails';
import { t } from '@/lib/i18n';
import { chatHref } from '@/lib/chat-island-params';
import { ALL_FILTER } from '@/lib/kanban-filters';
import { filterQueueByProject, readQueueRailProject, writeQueueRailProject } from '@/lib/queue-rail-filter';
import { sharedGet } from '@/lib/shared-read';
import { useEffect, useMemo, useState } from 'react';
import { sseOn } from '@/lib/sse-stream';
import { missionActivity } from '@/lib/mission-activity';
import { machineScopedStorage } from '@/lib/machines/machine-storage';

type Mission = {
  id: string;
  agent_name: string;
  mission: string;
  status: string;
  source_channel?: string | null;
  turn_active?: boolean;
  pending_action_at?: number | null;
};

type Task = {
  id: string;
  title: string;
  agent_name: string;
  status: string;
  scheduled_at?: number | null;
  type?: string | null;
  project?: string | null;
};

type Projet = { slug: string; name?: string | null };

function firstLine(s: string | undefined | null, max = 64): string {
  if (!s) return '—';
  // Skips "TASK_ID: …" and empty lines, takes the first useful line of text.
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.find((l) => !/^TASK_ID:/i.test(l)) ?? lines[0] ?? '—';
  return meaningful.length > max ? meaningful.slice(0, max - 1) + '…' : meaningful;
}

export function QueueRail({ poignee, className }: WidgetProps) {
  const [running, setRunning] = useState<Mission[]>([]);
  const [queued, setQueued] = useState<Task[]>([]);
  const [agentProjects, setAgentProjects] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [projects, setProjects] = useState<Projet[]>([]);
  const [choice, setChoice] = useState<string>(ALL_FILTER);

  // In a chat, the conversation's project decides; elsewhere (the Agents page,
  // the cockpit) no single project is in context, so the rail lists them all
  // unless the user picks one. Same split as the Project TO DO widget.
  const chatSlug = useChatRail()?.slug ?? null;
  const slug = chatSlug ?? choice;

  // Read after mount: `localStorage` does not exist during server rendering.
  useEffect(() => { setChoice(readQueueRailProject(machineScopedStorage(window.localStorage))); }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [ar, pr] = await Promise.all([
          sharedGet('/api/ui/agents'),
          chatSlug ? Promise.resolve(null) : sharedGet('/api/ui/projects'),
        ]);
        if (ar.ok) {
          const aj = (await ar.json()) as { agents?: { name: string; project?: string | null }[] };
          if (alive) setAgentProjects(new Map((aj.agents ?? []).map((a) => [a.name, a.project ?? null])));
        }
        if (pr?.ok) {
          const pj = (await pr.json()) as { projects?: Projet[] };
          if (alive) setProjects(pj.projects ?? []);
        }
      } catch { /* no mapping: only the unfiltered view works */ }
    })();
    return () => { alive = false; };
  }, [chatSlug]);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const [mr, tr] = await Promise.all([
          fetch('/api/ui/missions?limit=200', { cache: 'no-store' }),
          fetch('/api/ui/tasks?status=PENDING', { cache: 'no-store' }),
        ]);
        if (!mr.ok || !tr.ok) return;
        const mj = (await mr.json()) as { missions: Mission[] };
        const tj = (await tr.json()) as { tasks: Task[] };
        if (cancelled) return;
        // Exclude internal wake-loop missions ("Tu as N notifications…") —
        // system plumbing, not user-facing work.
        setRunning(
          (mj.missions ?? [])
            .filter((m) => m.status === 'running' && m.source_channel !== 'wake'),
        );
        setQueued(tj.tasks ?? []);
      } catch { /* ignore */ }
    }
    refresh();
    const timer = setInterval(refresh, 5000);
    const h = () => refresh();
    const unsubs = [sseOn('mission_complete', h), sseOn('turn_complete', h)];
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubs.forEach((u) => u());
    };
  }, []);

  // De-dup guaranteed: IN_PROGRESS tasks are not returned (filter
  // status=PENDING on the API side), and running missions have no counterpart
  // in queued by construction. We still filter out the PENDING ones whose
  // agent + title match an active mission (rare dispatcher edge case when a
  // task has just been picked without a state flip).
  // Capped after the project filter, so a busy project is not hidden behind
  // the first rows of the others.
  const shown = useMemo(() => {
    const f = filterQueueByProject(running, queued, slug, agentProjects);
    return { missions: f.missions.slice(0, 12), tasks: f.tasks.slice(0, 20) };
  }, [running, queued, slug, agentProjects]);
  const runningKeys = new Set(shown.missions.map((m) => m.agent_name + '|' + firstLine(m.mission, 80)));
  const queuedClean = shown.tasks.filter((task) => !runningKeys.has(task.agent_name + '|' + firstLine(task.title, 80)));

  const runningShown = shown.missions;
  const empty = runningShown.length === 0 && queuedClean.length === 0;

  const picker = chatSlug ? null : (
    <select
      value={choice}
      aria-label={t('agentsLayout.projectFilter')}
      onChange={(e) => { setChoice(e.target.value); writeQueueRailProject(machineScopedStorage(window.localStorage), e.target.value); }}
      className="pointer-events-auto w-full rounded-md border border-transparent bg-foreground/[0.05] px-1.5 py-1 text-[11.5px] text-muted-foreground outline-none transition-colors focus:border-primary/60"
    >
      <option value={ALL_FILTER}>{t('agentsLayout.allProjects')}</option>
      {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name || p.slug}</option>)}
    </select>
  );

  // The rail keeps its place when the queue is empty instead of unmounting:
  // a column that vanishes looks like a regression when there is simply
  // nothing left to do, and the layout no longer jumps when the last task
  // moves to DONE.
  return (
    <Tile title={t('agentsLayout.tasks')} subtitle={runningShown.length + queuedClean.length || undefined} actions={poignee} className={className} bodyClassName="p-3">
      <div className="flex flex-col gap-3 overflow-y-auto pr-1 scrollbar-none flex-1 pointer-events-auto">
      {picker}
      {runningShown.length > 0 && (
        <section className="flex flex-col gap-2 pointer-events-auto">
          <h3 className="px-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-[hsl(var(--warning))] align-middle shadow-[0_0_6px_hsl(var(--warning))]" />
            {t('agentsLayout.runningCount', { count: runningShown.length })}
          </h3>
          {runningShown.map((m) => {
            // Read per mission: an agent running two missions at once must
            // animate both (the agents/active feed keeps one row per agent).
            const activity = missionActivity(m);
            return (
            <ChatLink
              key={m.id}
              href={chatHref(m.agent_name, m.id)}
              className="qr-card group relative block rounded-xl border border-border/60 bg-card/70 px-3 py-2.5 shadow-lg backdrop-blur transition-all hover:border-primary/60 hover:bg-card/90"
            >
              <div className="flex items-center gap-2">
                {activity === 'thinking' ? (
                  <span className="qr-thinking shrink-0" aria-label={t('agentsLayout.activityThinking')}>
                    <span className="qr-dot" />
                    <span className="qr-dot" />
                    <span className="qr-dot" />
                  </span>
                ) : activity === 'needs_action' ? (
                  <span className="qr-needs-action shrink-0" aria-label={t('agentsLayout.activityNeedsAction')}>⚠</span>
                ) : (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                    aria-label={t('agentsLayout.activityIdle')}
                  />
                )}
                <span className="truncate text-[11px] font-medium text-foreground">
                  {m.agent_name}
                </span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground group-hover:text-foreground/85">
                {firstLine(m.mission, 140)}
              </p>
              {activity === 'needs_action' && (
                <div className="qr-validation-badge mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold">
                  <span>⚠</span>
                  <span>{t('agentsLayout.validationRequired')}</span>
                </div>
              )}
            </ChatLink>
            );
          })}
        </section>
      )}

      {queuedClean.length > 0 && (
        <section className="flex flex-col gap-2 pointer-events-auto">
          <h3 className="px-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-muted-foreground/40 align-middle" />
            {t('agentsLayout.queuedCount', { count: queuedClean.length })}
          </h3>
          {queuedClean.map((task) => (
            <ChatLink
              key={task.id}
              href={chatHref(task.agent_name)}
              className="qr-card group relative block rounded-xl border border-border/50 bg-card/55 px-3 py-2.5 shadow-md backdrop-blur transition-all hover:border-primary/50 hover:bg-card/85"
            >
              {/* Comic-style Z's floating away — 3 chars, offset in x/delay
                  so the sequence shows a continuous loop. */}
              <span className="qr-zzz" aria-hidden>
                <span className="qr-z">Z</span>
                <span className="qr-z">Z</span>
                <span className="qr-z">Z</span>
              </span>
              <div className="flex items-center gap-2">
                <span className="truncate text-[11px] font-medium text-foreground/85">
                  {task.agent_name}
                </span>
                {task.type && (
                  <span className="shrink-0 rounded border border-border/60 bg-muted/30 px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                    {task.type}
                  </span>
                )}
              </div>
              <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground group-hover:text-foreground/80">
                {firstLine(task.title, 140)}
              </p>
            </ChatLink>
          ))}
        </section>
      )}

      {empty && (
        <div className="pointer-events-auto rounded-xl bg-card/40 px-3 py-4 text-center backdrop-blur">
          <p className="text-[12.5px] font-medium text-foreground/80">
            {t('agentsLayout.emptyTitle')}
          </p>
          <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
            {t('agentsLayout.emptyBody')}
          </p>
        </div>
      )}

      </div>{/* end scrollable content */}
      <style>{`
        .qr-card { transform: translateZ(0); }
        .qr-thinking { display: inline-flex; align-items: center; gap: 3px; height: 10px; }
        .qr-thinking .qr-dot {
          width: 4px; height: 4px; border-radius: 50%;
          background: hsl(var(--warning));
          box-shadow: 0 0 6px hsl(var(--warning) / 0.6);
          animation: qr-bounce 1.05s ease-in-out infinite;
        }
        .qr-thinking .qr-dot:nth-child(2) { animation-delay: 0.15s; }
        .qr-thinking .qr-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes qr-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.55; }
          40% { transform: translateY(-4px); opacity: 1; }
        }

        .qr-needs-action {
          font-size: 10px;
          color: #f59e0b;
          text-shadow: 0 0 6px rgba(245,158,11,.7);
          animation: qr-na-blink 1.4s ease-in-out infinite;
        }
        @keyframes qr-na-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .qr-validation-badge {
          background: rgba(245,158,11,0.12);
          border: 1px solid rgba(245,158,11,0.35);
          color: #f59e0b;
          text-shadow: 0 0 4px rgba(245,158,11,0.4);
          animation: qr-na-blink 1.4s ease-in-out infinite;
        }

        .qr-zzz {
          position: absolute;
          top: 6px; right: 10px;
          width: 28px; height: 28px;
          pointer-events: none;
        }
        .qr-zzz .qr-z {
          position: absolute;
          left: 50%;
          bottom: 0;
          font-weight: 700;
          color: hsl(var(--primary) / 0.75);
          text-shadow: 0 0 4px hsl(var(--primary) / 0.35);
          opacity: 0;
          transform: translate(-50%, 0) rotate(0deg) scale(0.85);
          animation: qr-zfly 2.4s ease-in-out infinite;
        }
        .qr-zzz .qr-z:nth-child(1) { font-size: 9px;  animation-delay: 0s;    }
        .qr-zzz .qr-z:nth-child(2) { font-size: 11px; animation-delay: 0.8s;  }
        .qr-zzz .qr-z:nth-child(3) { font-size: 13px; animation-delay: 1.6s;  }
        @keyframes qr-zfly {
          0%   { opacity: 0;   transform: translate(-50%, 6px)   rotate(-6deg) scale(0.75); }
          15%  { opacity: 0.95; }
          60%  { opacity: 0.6; transform: translate(-30%, -16px) rotate(10deg) scale(1);    }
          100% { opacity: 0;   transform: translate(-10%, -28px) rotate(22deg) scale(1.1);  }
        }
      `}</style>
    </Tile>
  );
}
