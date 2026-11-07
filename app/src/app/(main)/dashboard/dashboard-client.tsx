'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Tile } from '@/components/tile';
import { Kpi } from '@/components/kpi';
import { getLocale, t } from '@/lib/i18n';
import { formatRelativeTime, numberFormat } from '@/lib/intl';

type Stats = {
  activeMissions: { id: string; agent_name: string | null; started_at: number; running: boolean }[];
  messagesPerSec: number;
  sparkline: { hour: number; count: number }[];
  activityByAgent: { agent: string; count: number }[];
  taskCounts: { PENDING: number; IN_PROGRESS: number; DONE: number; BLOCKED: number };
};

function fmtDuration(startMs: number, number: Intl.NumberFormat): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  if (s < 60) return t('missionsPage.duration.seconds', { seconds: number.format(s) });
  const m = Math.floor(s / 60);
  if (m < 60) return t('missionsPage.duration.minutes', { minutes: number.format(m) });
  return t('missionsPage.duration.hoursMinutes', {
    hours: number.format(Math.floor(m / 60)),
    minutes: number.format(m % 60),
  });
}

function paletteFor(name: string) {
  const c = [
    'hsl(var(--primary))',
    'hsl(var(--agenda-2))',
    'hsl(var(--agenda-3))',
    'hsl(var(--agenda-4))',
    'hsl(var(--agenda-5))',
    'hsl(var(--agenda-6))',
    'hsl(var(--salmon-2))',
    'hsl(var(--success))',
  ];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return c[h % c.length]!;
}

export function DashboardClient() {
  const locale = getLocale();
  const formats = useMemo(() => ({
    number: numberFormat(undefined, locale),
    rate: numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 }, locale),
  }), [locale]);
  const [stats, setStats] = useState<Stats | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/stats', { cache: 'no-store' });
      if (r.ok) setStats(await r.json());
    } catch { /* keep state */ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!stats) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const { activeMissions, messagesPerSec, sparkline, activityByAgent, taskCounts } = stats;
  const maxActivity = Math.max(1, ...activityByAgent.map((a) => a.count));

  return (
    <div className="relative z-[1] grid h-full min-h-0 grid-cols-1 gap-3.5 overflow-auto p-5 pb-6 md:grid-cols-2 md:overflow-hidden md:grid-rows-[1fr_1fr]">

      {/* ── Active missions ─────────────────────────────────────────── */}
      <Tile
        title={t('missionsPage.dashboard.activeMissions')}
        subtitle={t('missionsPage.dashboard.runningCount', { count: activeMissions.length, formattedCount: formats.number.format(activeMissions.length) })}
        className="md:col-start-1 md:row-start-1"
      >
        {activeMissions.length === 0 ? (
          <div className="grid flex-1 place-items-center text-[12px] text-muted-foreground/60">
            {t('missionsPage.dashboard.noActiveMissions')}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
            {activeMissions.map((m) => {
              const name = m.agent_name ?? '—';
              return (
                <div
                  key={m.id}
                  className="grid grid-cols-[28px_1fr_auto] items-center gap-2.5"
                >
                  <span
                    className="grid size-[28px] shrink-0 place-items-center rounded-lg text-[10px] font-bold text-[#0c0c0c]"
                    style={{ background: paletteFor(name) }}
                  >
                    {name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <span className="block truncate text-[12px]">{name}</span>
                    <span className="tabular-nums text-[10px] text-muted-foreground">
                      {m.id.slice(0, 8)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="block tabular-nums text-[11px] text-muted-foreground">
                      {fmtDuration(m.started_at, formats.number)}
                    </span>
                    <span className="block text-[9px] uppercase tracking-wider text-[hsl(var(--success))]">
                      {t('missionsPage.status.running')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Tile>

      {/* ── Kanban summary + messages/s ───────────────────────────────── */}
      <Tile
        title={t('missionsPage.dashboard.kanbanActivity')}
        subtitle={t('missionsPage.dashboard.tasksLive')}
        className="md:col-start-2 md:row-start-1"
        bodyClassName="!p-3.5"
      >
        <div className="grid h-full grid-cols-2 gap-2.5">
          <Kpi
            accent
            label={t('missionsPage.dashboard.inProgress')}
            value={formats.number.format(taskCounts.IN_PROGRESS)}
            delta={t('missionsPage.dashboard.blockedCount', { count: taskCounts.BLOCKED, formattedCount: formats.number.format(taskCounts.BLOCKED) })}
          />
          <Kpi
            label={t('missionsPage.dashboard.pending')}
            value={formats.number.format(taskCounts.PENDING)}
            delta={t('missionsPage.status.queued')}
          />
          <Kpi
            label={t('missionsPage.status.done')}
            value={formats.number.format(taskCounts.DONE)}
            delta={t('missionsPage.dashboard.completed')}
          />
          <Kpi
            label={t('missionsPage.dashboard.messagesPerSecond')}
            value={messagesPerSec < 10 ? formats.rate.format(messagesPerSec) : formats.number.format(Math.round(messagesPerSec))}
            unit={t('missionsPage.dashboard.perSecond')}
            delta={t('missionsPage.dashboard.rollingMinute')}
            accent={messagesPerSec > 0.5}
          />
        </div>
      </Tile>

      {/* ── 24h sparkline ────────────────────────────────────────────── */}
      <Tile
        title={t('missionsPage.dashboard.events24Hours')}
        subtitle={t('missionsPage.dashboard.hourlyPoints')}
        className="md:col-start-1 md:row-start-2"
      >
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkline} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke="hsl(var(--border))"
                strokeOpacity={0.4}
                vertical={false}
              />
              <XAxis
                dataKey="hour"
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 9 }}
                tickFormatter={(h: number) => formatRelativeTime((h - 23) * 3600_000, 0, 'short', locale)}
                interval={5}
              />
              <YAxis hide />
              <Tooltip
                cursor={{ stroke: 'hsl(var(--primary))', strokeWidth: 1, strokeDasharray: '3 3' }}
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 'calc(var(--radius) * 0.8)',
                  fontSize: 11,
                }}
                labelFormatter={(h: number) => formatRelativeTime((h - 23) * 3600_000, 0, 'long', locale)}
                formatter={(v: number) => [formats.number.format(v), t('missionsPage.detail.events')]}
              />
              <Area
                type="monotone"
                dataKey="count"
                stroke="hsl(var(--primary))"
                strokeWidth={1.5}
                fill="url(#sparkGrad)"
                dot={false}
                activeDot={{ r: 3, fill: 'hsl(var(--primary))' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Tile>

      {/* ── Activity by agent ────────────────────────────────────────── */}
      <Tile
        title={t('missionsPage.dashboard.activityByAgent')}
        subtitle={t('missionsPage.dashboard.topFiveToday')}
        className="md:col-start-2 md:row-start-2"
      >
        {activityByAgent.length === 0 ? (
          <div className="grid flex-1 place-items-center text-[12px] text-muted-foreground/60">
            {t('missionsPage.dashboard.noEventsToday')}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col justify-around gap-2 overflow-auto">
            {activityByAgent.map((a) => (
              <div key={a.agent} className="grid grid-cols-[28px_1fr_auto] items-center gap-2.5">
                <span
                  className="grid size-[28px] shrink-0 place-items-center rounded-lg text-[10px] font-bold text-[#0c0c0c]"
                  style={{ background: paletteFor(a.agent) }}
                >
                  {a.agent.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="mb-1.5 truncate text-[12px]">{a.agent}</div>
                  <div className="relative h-1.5 overflow-hidden rounded bg-muted">
                    <span
                      className="absolute inset-y-0 left-0 rounded bg-gradient-to-r from-primary to-[hsl(var(--salmon-2))]"
                      style={{ width: `${(a.count / maxActivity) * 100}%` }}
                    />
                  </div>
                </div>
                <span className="tabular-nums text-[13px]">
                  {formats.number.format(a.count)}
                  <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{t('missionsPage.dashboard.eventUnit')}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Tile>
    </div>
  );
}
