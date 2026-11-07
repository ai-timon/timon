'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { missionDisplayTitle } from '@/lib/mission-title';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChatLink } from '@/components/chat/chat-link';
import { Search, X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { MissionTrace } from '@/plugins-client/workflows/mission-trace';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ProjectBadge } from '@/components/project-badge';
import { MissionBadgeSlot } from '@/plugins-client/missions/mission-badge-slot';
import { toMissionItem, type MissionItem } from '@/lib/mission-liveness';
import { MissionOriginIcon } from '@/components/mission-origin-icon';
import { MISSION_ORIGIN_FILTERS, isMissionOrigin, type MissionOrigin } from '@/lib/mission-origin';
import { t } from '@/lib/i18n';
import { chatHref } from '@/lib/chat-island-params';
import { forgetChatMission } from '@/lib/chat-mission-cache';

type RawMission = {
  id: string;
  mission?: string;
  agent_name?: string;
  status?: string;
  running?: boolean;
  started_at: number;
  ended_at?: number | null;
  event_count?: number;
  source_channel?: string;
  origin?: string;
  total_cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  turn_active?: boolean;
  turn_complete?: boolean;
  liveness?: string | null;
  interrupted_reason?: string | null;
  pending_messages?: number;
  open_deliveries?: number;
};

type Row = {
  id: string;
  fullId: string;
  title: string;
  agent: string;
  status: 'running' | 'done' | 'terminated' | 'failed' | 'queued' | 'backlog';
  startedAt: number;
  duration: number;
  cost: number;
  tokIn: number;
  tokOut: number;
  events: number;
  running: boolean;
  origin: MissionOrigin | null;
  item: MissionItem;
};

type Agent = { name: string; color?: string; project?: string | null };

type DetailEvent = { timestamp: number; type: string; payload?: unknown };

type Lineage = {
  parent_mission_id: string | null;
  parent_agent: string | null;
  task_id: string | null;
  routine_id: string | null;
  children: Array<{ id: string; agent_name: string; status: string; started_at: number }>;
};

const STATUS_TONE: Record<Row['status'], { label: string; chip: string; dot: string }> = {
  running: {
    label: 'running',
    chip: 'bg-primary/10 text-primary border-primary/30',
    dot: 'bg-primary animate-pulse shadow-[0_0_6px_hsl(var(--primary))]',
  },
  done: {
    label: 'done',
    chip: 'bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))] border-[hsl(var(--success)/0.25)]',
    dot: 'bg-[hsl(var(--success))]',
  },
  terminated: {
    label: 'terminated',
    chip: 'bg-muted-foreground/10 text-muted-foreground border-muted-foreground/25',
    dot: 'bg-muted-foreground/60',
  },
  failed: {
    label: 'failed',
    chip: 'bg-destructive/10 text-destructive border-destructive/25',
    dot: 'bg-destructive',
  },
  queued: {
    label: 'queued',
    chip: 'bg-[hsl(var(--info)/0.08)] text-[hsl(var(--info))] border-[hsl(var(--info)/0.25)]',
    dot: 'bg-[hsl(var(--info))]',
  },
  backlog: {
    label: 'backlog',
    chip: 'bg-muted text-muted-foreground border-border',
    dot: 'bg-muted-foreground/50',
  },
};

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

function fmtDur(s: number) {
  if (!s) return '—';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

function fmtTime(ms: number) {
  if (!ms) return '—';
  const d = new Date(ms);
  const dt = Date.now() - ms;
  if (dt < 24 * 3600e3) return d.toTimeString().slice(0, 5);
  return d.toISOString().slice(5, 10) + ' ' + d.toTimeString().slice(0, 5);
}

function kfmt(n: number) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function mapStatus(s: string | undefined, running?: boolean): Row['status'] {
  if (running || s === 'running') return 'running';
  if (s === 'completed' || s === 'done') return 'done';
  if (s === 'terminated') return 'terminated';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'queued') return 'queued';
  return 'backlog';
}

function shape(m: RawMission): Row {
  const ended = m.ended_at ?? null;
  const dur = ended
    ? Math.floor((ended - m.started_at) / 1000)
    : Math.floor((Date.now() - m.started_at) / 1000);
  return {
    id: m.id.slice(0, 8),
    fullId: m.id,
    title: missionDisplayTitle(m, '').slice(0, 200),
    agent: m.agent_name || '—',
    status: mapStatus(m.status, m.running),
    startedAt: m.started_at,
    duration: Math.max(0, dur),
    cost: m.total_cost_usd || 0,
    tokIn: m.tokens_in || 0,
    tokOut: m.tokens_out || 0,
    events: m.event_count || 0,
    running: !!m.running,
    origin: isMissionOrigin(m.origin) ? m.origin : null,
    item: toMissionItem(m),
  };
}

type SortKey = 'started' | 'duration' | 'cost';

export function MissionsClient() {
  const [missions, setMissions] = useState<Row[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [filters, setFilters] = useState({
    agent: 'all',
    project: 'all',
    status: 'all',
    origin: 'all',
    search: '',
  });
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: 'started',
    dir: -1,
  });
  const [selected, setSelected] = useState<Row | null>(null);
  const router = useRouter();
  // `?selected=<id>` is how Messages, Pipelines and the lineage links of the
  // detail panel point at one mission (TIM-0100).
  const deepLinked = useSearchParams()?.get('selected') ?? null;
  const [detailEvents, setDetailEvents] = useState<DetailEvent[]>([]);
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [tab, setTab] = useState<'timeline' | 'output' | 'logs' | 'trace'>('timeline');

  // The origin filters on the daemon, before its limit: the user's own
  // conversations are a small share of the latest 200 missions.
  const originRef = useRef(filters.origin);
  originRef.current = filters.origin;
  const fetchAll = useCallback(async () => {
    const origin = originRef.current;
    const qs = new URLSearchParams({ limit: '200' });
    if (origin !== 'all') qs.set('origin', origin);
    try {
      const [mr, ar] = await Promise.all([
        fetch(`/api/ui/missions?${qs}`, { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { missions: [] },
        ),
        fetch('/api/ui/agents', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { agents: [] },
        ),
      ]);
      // A poll started before the filter changed must not overwrite its result.
      if (origin !== originRef.current) return;
      const shaped = (mr.missions || []).map((m: RawMission) => shape(m));
      setMissions(shaped);
      setAgents(ar.agents || []);
    } catch {
      /* keep state */
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 3000);
    return () => clearInterval(id);
  }, [fetchAll, filters.origin]);

  const missionsRef = useRef(missions);
  missionsRef.current = missions;
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selected?.fullId ?? null;
  useEffect(() => {
    if (!deepLinked || selectedIdRef.current === deepLinked) return;
    const listed = missionsRef.current.find((m) => m.fullId === deepLinked);
    if (listed) {
      setSelected(listed);
      return;
    }
    // Not among the latest 200 (or hidden by the origin filter, or the list
    // has not loaded yet): the detail route answers for any mission.
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/ui/missions/${encodeURIComponent(deepLinked)}?view=status`, {
          cache: 'no-store',
        });
        if (cancelled) return;
        if (!r.ok) {
          toast.error(`Mission ${deepLinked.slice(0, 8)} not found`);
          router.replace('/missions', { scroll: false });
          return;
        }
        const d = (await r.json()) as RawMission;
        if (!cancelled) setSelected(shape(d));
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [deepLinked, router]);

  // The URL mirrors the open panel, so a lineage link back to the mission
  // already in the address bar still changes it, and a reload reopens it.
  const select = useCallback(
    (row: Row | null) => {
      setSelected(row);
      router.replace(row ? `/missions?selected=${encodeURIComponent(row.fullId)}` : '/missions', {
        scroll: false,
      });
    },
    [router],
  );

  useEffect(() => {
    if (!selected) return;
    const fresh = missions.find((m) => m.fullId === selected.fullId);
    if (fresh) setSelected(fresh);
  }, [missions, selected]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/ui/missions/${selected.fullId}`, {
          cache: 'no-store',
        });
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled && Array.isArray(d.events)) setDetailEvents(d.events);
        if (!cancelled) {
          setLineage({
            parent_mission_id: d.parent_mission_id ?? null,
            parent_agent: d.parent_agent ?? null,
            task_id: d.task_id ?? null,
            routine_id: d.routine_id ?? null,
            children: Array.isArray(d.children) ? d.children : [],
          });
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const agentProject = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of agents) m.set(a.name, a.project ?? null);
    return m;
  }, [agents]);

  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) if (a.project) set.add(a.project);
    return [...set].sort();
  }, [agents]);

  const rows = useMemo(() => {
    const f = filters;
    const q = f.search.trim().toLowerCase();
    const filtered = missions.filter((m) => {
      if (f.agent !== 'all' && m.agent !== f.agent) return false;
      if (f.status !== 'all' && m.status !== f.status) return false;
      if (f.project !== 'all') {
        const p = agentProject.get(m.agent) ?? null;
        const wanted = f.project === '__none__' ? null : f.project;
        if (p !== wanted) return false;
      }
      if (q) {
        if (
          !m.title.toLowerCase().includes(q) &&
          !m.id.includes(q) &&
          !m.fullId.includes(q)
        )
          return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      const ka =
        sort.key === 'started'
          ? a.startedAt
          : sort.key === 'duration'
            ? a.duration
            : a.cost;
      const kb =
        sort.key === 'started'
          ? b.startedAt
          : sort.key === 'duration'
            ? b.duration
            : b.cost;
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * sort.dir;
    });
    return filtered;
  }, [missions, filters, sort]);

  const stats = useMemo(() => {
    const done = missions.filter((m) => m.status === 'done').length;
    const terminated = missions.filter((m) => m.status === 'terminated').length;
    const failed = missions.filter((m) => m.status === 'failed').length;
    // The rate only covers TERMINAL missions (running/queued/backlog excluded).
    // `terminated` (normal end via reaper/kill) counts as a non-failure, same
    // as `done` — only `failed` (an actual problem) penalizes the rate.
    const terminal = done + terminated + failed;
    return {
      count: missions.length,
      cost: missions.reduce((s, m) => s + m.cost, 0),
      tok: missions.reduce((s, m) => s + m.tokIn + m.tokOut, 0),
      succ: terminal ? Math.round(((done + terminated) / terminal) * 100) + '%' : '—',
      failed,
    };
  }, [missions]);

  function toggleSort(k: SortKey) {
    setSort((cur) => (cur.key === k ? { key: k, dir: (cur.dir * -1) as 1 | -1 } : { key: k, dir: -1 }));
  }

  async function killSelected() {
    if (!selected) return;
    const r = await fetch(`/api/ui/missions/${selected.fullId}`, { method: 'DELETE' });
    if (r.ok) {
      forgetChatMission(selected.fullId);
      toast.success('killed');
      fetchAll();
    } else {
      toast.error('failed: ' + r.status);
    }
  }

  return (
    // The scroller lives here (not in page.tsx) so it can be locked while the
    // detail sheet is open: the Radix scroll lock misses it on Electron/Windows (TIM-0100).
    <div
      className={cn(
        'relative z-[1] h-full overscroll-contain px-6 pb-8 pt-5',
        selected ? 'overflow-hidden' : 'overflow-auto',
      )}
    >
      <h1 className="text-[22px] font-semibold -tracking-[0.01em]">Missions</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Every task you've handed off to an agent. Tap a row for the full trace.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Missions" value={stats.count} />
        <Stat label="Total cost" value={`$${stats.cost.toFixed(2)}`} unit="USD" />
        <Stat label="Tokens consumed" value={kfmt(stats.tok)} unit="in / out" />
        <Stat
          label="Success rate"
          value={stats.succ}
          accent
          delta={stats.failed ? `${stats.failed} failed` : 'all green'}
          bad={stats.failed > 0}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 rounded-t-xl bg-card px-3.5 py-3">
        <FilterField label={t('missionOrigin.label')}>
          <Select
            value={filters.origin}
            onValueChange={(v) => setFilters((f) => ({ ...f, origin: v }))}
          >
            <SelectTrigger className="h-7 border-0 bg-transparent px-1 text-[12.5px] focus:ring-0 focus:ring-offset-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('missionOrigin.all')}</SelectItem>
              {MISSION_ORIGIN_FILTERS.map((o) => (
                <SelectItem key={o} value={o}>
                  {t(`missionOrigin.${o}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="Project">
          <Select
            value={filters.project}
            onValueChange={(v) => setFilters((f) => ({ ...f, project: v }))}
          >
            <SelectTrigger className="h-7 border-0 bg-transparent px-1 text-[12.5px] focus:ring-0 focus:ring-offset-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
              <SelectItem value="__none__">· no project</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="Agent">
          <Select
            value={filters.agent}
            onValueChange={(v) => setFilters((f) => ({ ...f, agent: v }))}
          >
            <SelectTrigger className="h-7 border-0 bg-transparent px-1 text-[12.5px] focus:ring-0 focus:ring-offset-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.name} value={a.name}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="Status">
          <Select
            value={filters.status}
            onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}
          >
            <SelectTrigger className="h-7 border-0 bg-transparent px-1 text-[12.5px] focus:ring-0 focus:ring-offset-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all</SelectItem>
              <SelectItem value="running">running</SelectItem>
              <SelectItem value="done">done</SelectItem>
              <SelectItem value="terminated">terminated</SelectItem>
              <SelectItem value="failed">failed</SelectItem>
              <SelectItem value="queued">queued</SelectItem>
              <SelectItem value="backlog">backlog</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        <div className="flex items-center gap-1.5 rounded-lg border border-transparent bg-foreground/[0.05] px-2.5 py-1.5 text-[12.5px] focus-within:border-ring/60">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder="Search title or ID…"
            className="border-0 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-muted-foreground"
          onClick={() =>
            setFilters({ agent: 'all', project: 'all', status: 'all', origin: 'all', search: '' })
          }
        >
          Clear
        </Button>
        <div className="flex-1" />
        <span className="tabular-nums text-[12px] text-muted-foreground">
          <b className="font-medium text-foreground">{rows.length}</b> missions
        </span>
      </div>

      <div className="overflow-x-auto rounded-b-xl bg-card">
        <table className="w-full border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr>
              <Th>ID</Th>
              <Th>Title</Th>
              <Th>Agent</Th>
              <Th onClick={() => toggleSort('started')} active={sort.key === 'started'} dir={sort.dir}>
                Started
              </Th>
              <Th
                onClick={() => toggleSort('duration')}
                active={sort.key === 'duration'}
                dir={sort.dir}
                right
              >
                Duration
              </Th>
              <Th onClick={() => toggleSort('cost')} active={sort.key === 'cost'} dir={sort.dir} right>
                Cost
              </Th>
              <Th right>Tokens (in/out)</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr
                key={m.fullId}
                onClick={() => select(m)}
                className={cn(
                  'cursor-pointer transition-colors',
                  i % 2 === 1 && 'bg-foreground/[0.015]',
                  'hover:bg-muted/40',
                  selected?.fullId === m.fullId &&
                    'bg-primary/10 shadow-[inset_2px_0_0_hsl(var(--primary))]',
                )}
              >
                <Td className="text-[11.5px] text-muted-foreground">{m.id}</Td>
                <Td className="max-w-[380px] truncate font-medium text-foreground">
                  {m.origin && <MissionOriginIcon origin={m.origin} className="mr-1.5 align-[-1px]" />}
                  {m.title}
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5 text-[11.5px]">
                    <span
                      className="size-2 rounded-sm"
                      style={{ background: paletteFor(m.agent) }}
                    />
                    {m.agent}
                    <ProjectBadge
                      project={agentProject.get(m.agent) ?? null}
                      size="xs"
                      withIcon={false}
                    />
                  </span>
                </Td>
                <Td className="tabular-nums text-[11.5px] text-muted-foreground">
                  {fmtTime(m.startedAt)}
                </Td>
                <Td right className="tabular-nums text-[12px]">
                  {fmtDur(m.duration)}
                </Td>
                <Td right className="tabular-nums text-[12px]">
                  {m.cost ? '$' + m.cost.toFixed(3) : '—'}
                </Td>
                <Td right className="tabular-nums text-[11.5px] text-muted-foreground">
                  <b className="font-medium text-foreground">{kfmt(m.tokIn)}</b>
                  <span className="mx-1 text-muted-foreground/40">/</span>
                  <b className="font-medium text-foreground">{kfmt(m.tokOut)}</b>
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusBadge status={m.status} />
                    <MissionBadgeSlot mission={m.item} />
                  </div>
                </Td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="py-10 text-center text-[12.5px] text-muted-foreground/70"
                >
                  No missions match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Sheet open={!!selected} onOpenChange={(o) => !o && select(null)}>
        <SheetContent side="right" className="w-[560px] max-w-[96vw] p-0 sm:max-w-[560px]">
          {selected && (
            <div className="flex h-full flex-col">
              <SheetHeader className="space-y-2 px-5 py-4 text-left">
                <div className="flex items-center gap-2">
                  <SheetTitle className="text-[15px]">{selected.title}</SheetTitle>
                </div>
                <SheetDescription className="flex flex-wrap items-center gap-2.5 tabular-nums text-[11.5px]">
                  {selected.origin && <MissionOriginIcon origin={selected.origin} />}
                  <span>{selected.id}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{selected.agent}</span>
                  <ProjectBadge
                    project={agentProject.get(selected.agent) ?? null}
                    size="xs"
                  />
                  <span className="text-muted-foreground/40">·</span>
                  <span>
                    {fmtTime(selected.startedAt)}
                    {selected.duration ? ` · ${fmtDur(selected.duration)}` : ''}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <StatusBadge status={selected.status} />
                    <MissionBadgeSlot mission={selected.item} />
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-[11px]"
                    >
                      <ChatLink
                        href={chatHref(selected.agent, selected.fullId)}
                      >
                        Open in chat →
                      </ChatLink>
                    </Button>
                    {selected.running && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={killSelected}
                        className="h-7 border-destructive/40 px-2 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <X className="mr-1 size-3" /> Kill
                      </Button>
                    )}
                  </span>
                </SheetDescription>
              </SheetHeader>

              {lineage && (lineage.parent_mission_id || lineage.task_id || lineage.routine_id || lineage.children.length > 0) && (
                <div className="mx-5 mb-3 space-y-1.5 rounded-lg bg-muted/30 px-3 py-2.5 text-[11.5px]">
                  {lineage.parent_mission_id && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>↑ Spawned by</span>
                      <Link
                        href={`/missions?selected=${lineage.parent_mission_id}`}
                        className="tabular-nums text-primary hover:underline"
                      >
                        {lineage.parent_mission_id.slice(0, 8)}
                      </Link>
                      {lineage.parent_agent && (
                        <span className="text-muted-foreground/70">({lineage.parent_agent})</span>
                      )}
                    </div>
                  )}
                  {lineage.task_id && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>↑ Task</span>
                      <Link
                        href={`/kanban?task=${lineage.task_id}`}
                        className="tabular-nums text-[hsl(var(--info))] hover:underline"
                      >
                        {lineage.task_id.slice(0, 8)}
                      </Link>
                    </div>
                  )}
                  {lineage.children.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                      <span>↓ Spawned {lineage.children.length}:</span>
                      {lineage.children.slice(0, 6).map((c) => (
                        <Link
                          key={c.id}
                          href={`/missions?selected=${c.id}`}
                          className="tabular-nums text-primary hover:underline"
                          title={`${c.agent_name} · ${c.status}`}
                        >
                          {c.id.slice(0, 6)}
                        </Link>
                      ))}
                      {lineage.children.length > 6 && (
                        <span className="text-muted-foreground/70">+{lineage.children.length - 6}</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-4 gap-2.5 px-5 pb-3.5">
                <MiniKpi label="Cost" value={'$' + selected.cost.toFixed(3)} />
                <MiniKpi label="Tokens in" value={kfmt(selected.tokIn)} />
                <MiniKpi label="Tokens out" value={kfmt(selected.tokOut)} />
                <MiniKpi label="Events" value={detailEvents.length || selected.events} />
              </div>

              <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as typeof tab)}
                className="flex min-h-0 flex-1 flex-col"
              >
                <TabsList className="h-auto justify-start gap-0 rounded-none bg-transparent px-5 py-0">
                  <DrawerTab value="timeline">Timeline</DrawerTab>
                  <DrawerTab value="output">Output</DrawerTab>
                  <DrawerTab value="logs">Logs</DrawerTab>
                  <DrawerTab value="trace">Trace</DrawerTab>
                </TabsList>
                <div className="flex-1 overflow-auto px-5 py-4">
                  <TabsContent value="timeline" className="m-0">
                    <Timeline events={detailEvents} />
                  </TabsContent>
                  <TabsContent value="output" className="m-0">
                    <Output events={detailEvents} />
                  </TabsContent>
                  <TabsContent value="logs" className="m-0">
                    <Logs events={detailEvents} agent={selected.agent} />
                  </TabsContent>
                  <TabsContent value="trace" className="m-0">
                    <MissionTrace missionId={selected.id} />
                  </TabsContent>
                </div>
              </Tabs>
            </div>
          )}
        </SheetContent>
      </Sheet>

    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  accent,
  delta,
  bad,
}: {
  label: string;
  value: React.ReactNode;
  unit?: React.ReactNode;
  accent?: boolean;
  delta?: React.ReactNode;
  bad?: boolean;
}) {
  return (
    <div
      className={cn(
        // Surface contrast instead of an outline; the accented figure keeps
        // its warm gradient.
        'rounded-xl bg-card px-4 py-3.5',
        accent && 'bg-gradient-to-b from-primary/[0.08] to-transparent',
      )}
    >
      <div className="text-[12.5px] font-medium text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'mt-1.5 flex items-baseline gap-2 tabular-nums text-[24px] font-semibold',
          accent && 'text-primary',
        )}
      >
        <span>{value}</span>
        {unit && (
          <span className="font-sans text-xs font-medium text-muted-foreground">{unit}</span>
        )}
        {delta && (
          <span
            className={cn(
              'font-sans text-xs font-medium',
              bad ? 'text-[hsl(var(--warning))]' : 'text-[hsl(var(--success))]',
            )}
          >
            {delta}
          </span>
        )}
      </div>
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-foreground/[0.05] px-2 py-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  dir,
  right,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  dir?: 1 | -1;
  right?: boolean;
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        'sticky top-0 z-[1] bg-card px-3 py-2.5 text-[12px] font-medium text-muted-foreground',
        right ? 'text-right' : 'text-left',
        onClick && 'cursor-pointer select-none hover:text-foreground',
        active && 'text-foreground',
      )}
    >
      {children}
      {active && <span className="ml-1.5 text-[9px] text-primary/60">{dir === -1 ? '▼' : '▲'}</span>}
    </th>
  );
}

function Td({
  children,
  className,
  right,
}: {
  children: React.ReactNode;
  className?: string;
  right?: boolean;
}) {
  return (
    <td
      className={cn(
        'px-3 py-2.5 align-middle',
        right && 'text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

function StatusBadge({ status }: { status: Row['status'] }) {
  const tone = STATUS_TONE[status];
  return (
    <Badge
      variant="outline"
      // Tint-only like every other badge: the status colour fills, no rim.
      className={cn('gap-1.5 border font-normal', tone.chip, 'border-transparent')}
    >
      <span className={cn('size-1.5 rounded-full', tone.dot)} />
      {tone.label}
    </Badge>
  );
}

function MiniKpi({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-2">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 tabular-nums text-[14px]">{value}</div>
    </div>
  );
}

function DrawerTab({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  return (
    <TabsTrigger
      value={value}
      className="relative h-auto rounded-none border-0 bg-transparent px-3.5 py-2.5 text-[12.5px] data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:bg-primary"
    >
      {children}
    </TabsTrigger>
  );
}

function classifyEvent(t: string) {
  if (t === 'user') return 'user';
  if (t === 'result' || t === 'system') return 'stop';
  if (t === 'assistant') return 'post';
  if (t.includes('tool')) return 'pre';
  return 'post';
}

const KIND_DOT: Record<string, string> = {
  user: 'bg-[hsl(var(--info))]',
  pre: 'bg-[hsl(var(--info))]',
  post: 'bg-[hsl(var(--success))]',
  stop: 'bg-primary',
};

function summarizePayload(p: any): string {
  if (!p || typeof p !== 'object') return '';
  if (p.type === 'assistant' && p.message && Array.isArray(p.message.content)) {
    return p.message.content
      .map((b: any) => {
        if (b.type === 'text') return (b.text || '').slice(0, 200);
        if (b.type === 'tool_use') return 'tool_use(' + b.name + ')';
        return b.type;
      })
      .join(' · ');
  }
  if (p.type === 'result') return 'result · cost=$' + (p.total_cost_usd || 0).toFixed(4);
  if (p.subtype) return p.type + ':' + p.subtype;
  return p.type || '';
}

function Timeline({ events }: { events: DetailEvent[] }) {
  if (!events.length) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-[12px] text-muted-foreground/70">
        No trace recorded yet.
      </div>
    );
  }
  return (
    <div className="relative pl-5 before:absolute before:bottom-1.5 before:left-[5px] before:top-1.5 before:w-px before:bg-border">
      {events.map((e, i) => {
        const kind = classifyEvent(e.type);
        return (
          <div
            key={i}
            className="relative py-1.5 pl-3.5 tabular-nums text-[12px] text-foreground/80"
          >
            <span
              className={cn(
                'absolute left-[-15px] top-[11px] size-1.5 rounded-full ring-2 ring-card',
                KIND_DOT[kind] || 'bg-muted-foreground',
              )}
            />
            <span className="mr-2.5 text-muted-foreground/50">
              {new Date(e.timestamp).toTimeString().slice(0, 8)}
            </span>
            <span
              className={cn(
                'mr-2 font-medium',
                kind === 'user' && 'text-[hsl(var(--info))]',
                kind === 'pre' && 'text-[hsl(var(--info))]',
                kind === 'post' && 'text-[hsl(var(--success))]',
                kind === 'stop' && 'text-primary',
              )}
            >
              {e.type}
            </span>
            <span className="text-muted-foreground">{summarizePayload(e.payload)}</span>
          </div>
        );
      })}
    </div>
  );
}

function extractAssistantText(events: DetailEvent[]) {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const blocks = (e.payload as any)?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) if (b.type === 'text' && b.text) out.push(b.text);
  }
  return out.join('\n').trim();
}

function Output({ events }: { events: DetailEvent[] }) {
  const text = extractAssistantText(events);
  if (!text) {
    return (
      <p className="text-[13px] italic text-muted-foreground/70">
        No assistant output recorded for this mission.
      </p>
    );
  }
  return (
    <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-4 text-[12px] leading-relaxed text-foreground/90">
      {text}
    </pre>
  );
}

function Logs({ events, agent }: { events: DetailEvent[]; agent: string }) {
  if (!events.length) {
    return (
      <pre /* code-font: raw log lines */ className="rounded-lg border border-border bg-muted/30 p-4 font-mono text-[11.5px] text-muted-foreground/70">
        # no raw logs recorded
      </pre>
    );
  }
  return (
    <pre /* code-font: raw JSON log lines */ className="whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/30 p-4 font-mono text-[11.5px] leading-relaxed text-foreground/85">
      {events
        .map(
          (e) =>
            `{"t":"${new Date(e.timestamp).toTimeString().slice(0, 8)}", "ev":"${e.type}", "agent":"${agent}", "msg":"${summarizePayload(e.payload).replace(/"/g, '\\"')}"}`,
        )
        .join('\n')}
    </pre>
  );
}
