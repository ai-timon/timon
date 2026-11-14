'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { mdToSafeHtml } from '@/lib/markdown';
import { t } from '@/lib/i18n';
import { formatDateTime, formatRelativeTime } from '@/lib/intl';
import { apiErrorMessage } from '@/lib/api-error';

/* ───────── types ───────── */
type Kind = 'decision' | 'pitfall' | 'preference';
type Proposal = {
  hash: string; kind: Kind; count: number; agent: string; ts: string;
  text: string; target: string; status: string; slug?: string;
};
type Overview = {
  counts: { facts: number; pitfalls: number; pending: number; projects: number };
  proposals: Proposal[];
};
type GroupedFact = { hash: string; kind: Kind; text: string; count: number; lastTs: string };
type Project = { slug: string; name?: string | null; color?: string | null };
type Agent = { name: string; project?: string | null; role?: string | null };

const KIND: Record<Kind, { icon: string; label: string; variant: 'default' | 'destructive' | 'secondary' }> = {
  decision: { icon: '🧭', label: 'decision', variant: 'default' },
  pitfall: { icon: '⚠️', label: 'pitfall', variant: 'destructive' },
  preference: { icon: '💡', label: 'preference', variant: 'secondary' },
};
const CURATED = ['instructions.md', 'decisions.md'] as const;

/* ───────── detail of a curation pass ───────── */
type AuditRow = {
  id: number;
  ts: number;
  run_id: string;
  scope: string;
  project: string | null;
  agent: string | null;
  action: 'new' | 'merge' | 'supersede' | 'reject' | 'archive' | 'rescope' | 'retier';
  rule_id: number | null;
  target_rule_id: number | null;
  candidate_text: string | null;
  rationale: string | null;
  reverted: number;
};

const ACTION_META: Record<string, { label: string; className: string }> = {
  new: { label: '+ added', className: 'text-emerald-500 border-emerald-500/40' },
  merge: { label: '⧉ merged', className: 'text-sky-500 border-sky-500/40' },
  supersede: { label: '↻ superseded', className: 'text-amber-500 border-amber-500/40' },
  reject: { label: '✕ rejected', className: 'text-muted-foreground border-border' },
  archive: { label: '⌁ archived', className: 'text-muted-foreground border-border' },
  rescope: { label: '⇄ rescoped', className: 'text-violet-500 border-violet-500/40' },
  retier: { label: '★ retiered', className: 'text-violet-500 border-violet-500/40' },
};

/**
 * What one curator pass decided, line by line. Opened from the
 * `/memory?run=<id>` anchor of the "Memory curated" notifications: the
 * notification's counter ("+13 rule(s)") does not say WHAT was added, and that
 * is the only thing one wants to know before vetoing.
 */
function CurationRunDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ui/memory/audit?run=' + encodeURIComponent(runId), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((j) => { if (!cancelled) setRows(j.audit ?? []); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [runId]);

  const label = rows?.length
    ? (rows[0]!.project ?? 'transverse')
    : '';

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t('memoryPage.curationRun')} {label && <span className="text-muted-foreground">— {label}</span>}
          </DialogTitle>
          <DialogDescription className="tabular-nums text-[11px]">
            {rows === null ? t('memoryPage.loading') : t('memoryPage.decisionsRun', { count: rows.length, run: runId.slice(0, 8) })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {error && (
            <p className="py-6 text-center text-[12px] text-destructive">
              {t('memoryPage.detailError')}: {error}
            </p>
          )}
          {rows !== null && rows.length === 0 && (
            <p className="py-6 text-center text-[12px] text-muted-foreground">
              {t('memoryPage.noAudit')}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {(rows ?? []).map((r) => {
              const meta = ACTION_META[r.action] ?? { label: r.action, className: 'border-border' };
              return (
                <li
                  key={r.id}
                  className="rounded-md border border-border bg-card/40 p-2.5 text-[12px] leading-snug"
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', meta.className)}>
                      {meta.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70">
                      scope {r.scope}
                      {r.agent ? ` · ${r.agent}` : ''}
                      {r.rule_id ? ` · #${r.rule_id}` : ''}
                      {r.target_rule_id ? ` → #${r.target_rule_id}` : ''}
                    </span>
                    {r.reverted === 1 && (
                      <span className="rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] text-destructive">
                        {t('memoryPage.reverted')}
                      </span>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-foreground/90">
                    {r.candidate_text ?? <span className="italic text-muted-foreground">{t('memoryPage.noCandidateText')}</span>}
                  </p>
                  {r.rationale && (
                    <p className="mt-1 text-[11px] italic text-muted-foreground">
                      {r.rationale}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ───────── root ───────── */
type Mode = 'dashboard' | 'browse';

export function MemoryClient() {
  const params = useSearchParams();
  const deepAgent = params.get('agent');
  const deepProject = params.get('project');
  const deepRun = params.get('run');
  const [mode, setMode] = useState<Mode>(deepAgent || deepProject ? 'browse' : 'dashboard');
  // `?run=<id>`: arriving from a "Memory curated" notification. Open the
  // detail of THIS pass over the page.
  const [runId, setRunId] = useState<string | null>(deepRun);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {runId && <CurationRunDialog runId={runId} onClose={() => setRunId(null)} />}
      <div className="flex items-center gap-2 bg-background px-4 py-2.5">
        <h1 className="mr-2 text-sm font-semibold">🧠 {t('memoryPage.title')}</h1>
        <div className="inline-flex gap-0.5 rounded-md border border-border bg-muted/30 p-0.5">
          {(['dashboard', 'browse'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded px-3 py-1 text-[12px]',
                mode === m ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {m === 'dashboard' ? t('memoryPage.dashboard') : t('memoryPage.browse')}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {mode === 'dashboard'
          ? <Dashboard onBrowse={() => setMode('browse')} onOpenRun={setRunId} />
          : <Browse deepAgent={deepAgent} deepProject={deepProject} />}
      </div>

      <MemoryStyles />
    </div>
  );
}

/* ───────── dashboard ───────── */
function Dashboard({ onBrowse, onOpenRun }: { onBrowse: () => void; onOpenRun: (runId: string) => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/ui/memory/overview', { cache: 'no-store' });
      setOv(r.ok ? await r.json() : null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  const act = useCallback(async (p: Proposal, action: 'accept' | 'reject') => {
    if (!p.slug) return;
    try {
      const r = await fetch(`/api/ui/memory/projects/${encodeURIComponent(p.slug)}/proposals/${encodeURIComponent(p.hash)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(apiErrorMessage(j, { status: r.status })); }
      toast.success(action === 'accept' ? t('memoryPage.promoted', { target: p.target || t('memoryPage.projectFile') }) : t('memoryPage.rejected'));
      fetchOverview();
    } catch (e) { toast.error((e as Error).message); }
  }, [fetchOverview]);

  const c = ov?.counts;
  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label={t('memoryPage.facts')} value={c?.facts} />
        <StatCard label={t('memoryPage.pitfalls')} value={c?.pitfalls} />
        <StatCard label={t('memoryPage.pending')} value={c?.pending} accent={!!c?.pending} />
        <StatCard label={t('memoryPage.projects')} value={c?.projects} />
      </div>

      <div className="mt-6 flex items-center gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">{t('memoryPage.pendingPromotions')}</h2>
        <Button size="sm" variant="ghost" className="ml-auto h-6 text-[11px]" onClick={fetchOverview} disabled={loading}>
          {loading ? '…' : '↻'}
        </Button>
      </div>

      {!ov || ov.proposals.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-border px-4 py-8 text-center text-[12.5px] text-muted-foreground">
          {loading ? t('memoryPage.loading') : t('memoryPage.noProposals')}
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {ov.proposals.map((p) => (
            <ProposalRow key={p.slug + p.hash} p={p} onAccept={() => act(p, 'accept')} onReject={() => act(p, 'reject')} />
          ))}
        </ul>
      )}

      <CurationRuns onOpenRun={onOpenRun} />

      <button onClick={onBrowse} className="mt-6 text-[12px] text-muted-foreground hover:text-primary">
        {t('memoryPage.browseByProject')} →
      </button>
    </div>
  );
}

type RunSummary = {
  runId: string;
  ts: number;
  project: string | null;
  counts: Record<string, number>;
  total: number;
};

/**
 * The nightly curator's latest passes, clickable.
 *
 * Why here: since the curator writes straight to the database (no more
 * approval queue), "To review — promotions" is structurally empty, so the
 * dashboard no longer showed anything of what the memory actually does. It is
 * also the way in for notifications sent before 2026-07-28, whose anchor is
 * `/memory` with no run id.
 */
function CurationRuns({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Aggregated on the client: the audit endpoint returns decision lines,
    // not passes. 400 lines easily cover the last few weeks.
    fetch('/api/ui/memory/audit?limit=400', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { audit: [] }))
      .then((j: { audit: AuditRow[] }) => {
        if (cancelled) return;
        const byRun = new Map<string, RunSummary>();
        for (const row of j.audit ?? []) {
          let s = byRun.get(row.run_id);
          if (!s) {
            s = { runId: row.run_id, ts: row.ts, project: row.project, counts: {}, total: 0 };
            byRun.set(row.run_id, s);
          }
          s.ts = Math.max(s.ts, row.ts);
          s.counts[row.action] = (s.counts[row.action] ?? 0) + 1;
          s.total += 1;
        }
        setRuns([...byRun.values()].sort((a, b) => b.ts - a.ts).slice(0, 12));
      })
      .catch(() => { if (!cancelled) setRuns([]); });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <div className="mt-8 flex items-center gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
          {t('memoryPage.latestRuns')}
        </h2>
      </div>
      {runs === null ? (
        <div className="mt-3 px-1 text-[12.5px] text-muted-foreground">{t('memoryPage.loading')}</div>
      ) : runs.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-border px-4 py-8 text-center text-[12.5px] text-muted-foreground">
          {t('memoryPage.noRuns')}
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {runs.map((r) => (
            <li key={r.runId}>
              <button
                type="button"
                onClick={() => onOpenRun(r.runId)}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card/40 px-3 py-2 text-left transition-colors hover:border-foreground/25 hover:bg-muted/50"
              >
                <span className="tabular-nums text-[11px] text-muted-foreground/80">
                  {formatDateTime(r.ts, {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
                <span className="truncate text-[12px] font-medium">
                  {r.project ?? 'transverse'}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums text-[10.5px]">
                  {(['new', 'merge', 'supersede', 'reject'] as const).map((a) =>
                    r.counts[a] ? (
                      <span
                        key={a}
                        className={cn('rounded border px-1.5 py-0.5', ACTION_META[a]?.className)}
                      >
                        {r.counts[a]} {ACTION_META[a]?.label.replace(/^\S+\s/, '')}
                      </span>
                    ) : null,
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function StatCard({ label, value, accent }: { label: string; value?: number; accent?: boolean }) {
  return (
    <div className={cn('rounded-xl border bg-card/40 px-4 py-3', accent ? 'border-primary/40' : 'border-border')}>
      <div className={cn('tabular-nums text-2xl font-semibold', accent ? 'text-primary' : 'text-foreground')}>
        {value ?? '—'}
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function ProposalRow({ p, onAccept, onReject }: { p: Proposal; onAccept: () => void; onReject: () => void }) {
  const k = KIND[p.kind];
  const [busy, setBusy] = useState(false);
  const wrap = (fn: () => void) => async () => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  return (
    <li className="rounded-lg border border-border bg-card/30 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Badge variant={k.variant} className="h-5 px-1.5 text-[10px]">{k.icon} {k.label}</Badge>
        <span className="tabular-nums text-muted-foreground">×{p.count}</span>
        {p.slug && <span className="text-muted-foreground/70">{p.slug}</span>}
        {p.agent && <span className="text-muted-foreground/50">{p.agent}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={busy} onClick={wrap(onAccept)}>✓ {t('memoryPage.promote')}</Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-muted-foreground" disabled={busy} onClick={wrap(onReject)}>✗ {t('memoryPage.reject')}</Button>
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-foreground/90">{p.text}</p>
      {p.target && <p className="mt-0.5 text-[10.5px] text-muted-foreground/60">→ {t('memoryPage.target')}: <code>{p.target}</code></p>}
    </li>
  );
}

/* ───────── browse ───────── */
function Browse({ deepAgent, deepProject }: { deepAgent: string | null; deepProject: string | null }) {
  const [scope, setScope] = useState<'project' | 'agent'>(deepAgent ? 'agent' : 'project');
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [project, setProject] = useState<string>(deepProject || '');
  const [agent, setAgent] = useState<string>(deepAgent || '');

  useEffect(() => {
    (async () => {
      const [rp, ra] = await Promise.all([
        fetch('/api/ui/projects', { cache: 'no-store' }),
        fetch('/api/ui/agents', { cache: 'no-store' }),
      ]);
      const jp = rp.ok ? await rp.json() : { projects: [] };
      const ja = ra.ok ? await ra.json() : { agents: [] };
      const ps: Project[] = jp.projects || [];
      const as: Agent[] = ja.agents || [];
      setProjects(ps); setAgents(as);
      if (!deepProject && ps[0]) setProject(ps[0].slug);
      if (!deepAgent && as[0]) setAgent(as[0].name);
    })();
  }, [deepProject, deepAgent]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col bg-card">
        <div className="p-2">
          <div className="inline-flex w-full gap-0.5 rounded-md border border-border bg-muted/30 p-0.5">
            {(['project', 'agent'] as const).map((s) => (
              <button key={s} onClick={() => setScope(s)}
                className={cn('flex-1 rounded px-2 py-1 text-[12px]', scope === s ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {s === 'project' ? t('memoryPage.projects') : t('memoryPage.agents')}
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-1.5 pb-3">
          {scope === 'project'
            ? (projects.length
                ? projects.map((p) => (
                    <SidebarItem key={p.slug} active={p.slug === project} onClick={() => setProject(p.slug)}
                      label={p.name || p.slug} sub={p.slug !== (p.name || p.slug) ? p.slug : undefined} color={p.color || undefined} />
                  ))
                : <SidebarEmpty>{t('memoryPage.noProjects')}</SidebarEmpty>)
            : (agents.length
                ? agents.map((a) => (
                    <SidebarItem key={a.name} active={a.name === agent} onClick={() => setAgent(a.name)}
                      label={a.name} sub={a.role || undefined} />
                  ))
                : <SidebarEmpty>{t('memoryPage.noAgents')}</SidebarEmpty>)}
        </div>
      </aside>

      <section className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {scope === 'project'
          ? (project ? <ProjectView slug={project} /> : <Empty>{t('memoryPage.chooseProject')}</Empty>)
          : (agent ? <AgentView agent={agent} /> : <Empty>{t('memoryPage.chooseAgent')}</Empty>)}
      </section>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center text-[13px] text-muted-foreground">{children}</div>;
}

function SidebarEmpty({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 py-3 text-[11.5px] text-muted-foreground/70">{children}</div>;
}

function SidebarItem({ active, onClick, label, sub, color }: {
  active: boolean; onClick: () => void; label: string; sub?: string; color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
        active ? 'border border-primary/35 bg-primary/[0.08]' : 'border border-transparent hover:bg-muted/60',
      )}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: color || 'hsl(var(--muted-foreground)/0.5)' }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{label}</span>
        {sub && <span className="block truncate text-[10.5px] text-muted-foreground/70">{sub}</span>}
      </span>
    </button>
  );
}

/* ───────── project view ───────── */
function ProjectView({ slug }: { slug: string }) {
  return (
    <div className="flex w-full flex-col gap-6">
      {CURATED.map((f) => (
        <MarkdownEditor
          key={`${slug}/${f}`}
          title={f === 'instructions.md' ? t('memoryPage.permanentInstructions') : t('memoryPage.technicalDecisions')}
          getUrl={`/api/ui/projects/${encodeURIComponent(slug)}/memory/${f}`}
          putUrl={`/api/ui/projects/${encodeURIComponent(slug)}/memory/${f}`}
          placeholder={t('memoryPage.editorPlaceholder', { file: f, slug })}
        />
      ))}
    </div>
  );
}

/* ───────── agent view ───────── */
function AgentView({ agent }: { agent: string }) {
  const [facts, setFacts] = useState<GroupedFact[] | null>(null);
  const [pieges, setPieges] = useState<string>('');

  useEffect(() => {
    (async () => {
      const [rf, rp] = await Promise.all([
        fetch(`/api/ui/agents/${encodeURIComponent(agent)}/learnings`, { cache: 'no-store' }),
        fetch(`/api/ui/agents/${encodeURIComponent(agent)}/memory/pieges.md`, { cache: 'no-store' }),
      ]);
      const jf = rf.ok ? await rf.json() : { facts: [] };
      setFacts(jf.facts || []);
      setPieges(rp.ok ? await rp.text() : '');
    })();
  }, [agent]);

  const byKind = useMemo(() => {
    const m: Record<Kind, GroupedFact[]> = { decision: [], pitfall: [], preference: [] };
    // no optional chaining: if a kind is added to the union, typing forces the update here.
    for (const f of facts || []) if (m[f.kind]) m[f.kind].push(f);
    return m;
  }, [facts]);

  // injected pitfalls: strip the capture markers for a clean render
  const piegesClean = useMemo(() => pieges.replace(/<!--[^>]*-->/g, '').trim(), [pieges]);

  if (facts === null) return <Empty>{t('memoryPage.loading')}</Empty>;
  if ((facts.length === 0) && !piegesClean) {
    return <Empty>{t('memoryPage.noCapturedMemory', { agent })}</Empty>;
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      {(['pitfall', 'decision', 'preference'] as const).map((k) => byKind[k].length > 0 && (
        <section key={k}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12px] font-semibold">{KIND[k].icon} {KIND[k].label}s</span>
            <span className="tabular-nums text-[11px] text-muted-foreground">{byKind[k].length}</span>
          </div>
          <div className="grid gap-2">
            {byKind[k].map((f) => (
              <div key={f.hash} className="rounded-lg border border-border bg-card/30 px-3.5 py-2.5">
                <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
                  {f.count > 1 && <Badge variant="outline" className="h-4 px-1 text-[9.5px]">×{f.count}</Badge>}
                  <span className="ml-auto">{f.lastTs ? formatRelativeTime(f.lastTs) : ''}</span>
                </div>
                <p className="mt-1 text-[13px] leading-snug text-foreground/90">{f.text}</p>
              </div>
            ))}
          </div>
        </section>
      ))}

      {piegesClean && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12px] font-semibold">⚠️ {t('memoryPage.injectedPitfalls')}</span>
          </div>
          <div className="memory-md rounded-lg border border-border bg-card/20 px-4 py-3"
            dangerouslySetInnerHTML={{ __html: mdToSafeHtml(piegesClean) }} />
        </section>
      )}
    </div>
  );
}

/* ───────── reusable markdown editor (curated project files) ───────── */
function MarkdownEditor({ title, getUrl, putUrl, placeholder }: {
  title: string; getUrl: string; putUrl: string; placeholder?: string;
}) {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetch(getUrl, { cache: 'no-store' });
      const t = r.ok ? await r.text() : '';
      if (cancelled) return;
      setContent(t); setOriginal(t); setSaved('idle');
    })();
    return () => { cancelled = true; };
  }, [getUrl]);

  useEffect(() => {
    if (content === original) return;
    setSaved('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: content });
        if (!r.ok) throw new Error('save failed: ' + r.status);
        setOriginal(content); setSaved('saved');
      } catch (e) { setSaved('error'); toast.error(String((e as Error).message || e)); }
    }, 1200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [content, original, putUrl]);

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-semibold">{title}</span>
        <span className="text-[10.5px] text-muted-foreground">
          {saved === 'saving' ? t('memoryPage.saving') : saved === 'saved' ? t('memoryPage.saved') : saved === 'error' ? t('memoryPage.saveFailed') : ''}
        </span>
      </div>
      <div className="grid gap-px overflow-hidden rounded-lg border border-border md:grid-cols-2">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          /* code-font: markdown source editor */ className="min-h-[160px] resize-y border-0 bg-background px-4 py-3 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/50"
        />
        <div className="memory-md min-h-[160px] overflow-auto bg-card/20 px-4 py-3"
          dangerouslySetInnerHTML={{ __html: mdToSafeHtml(content) }} />
      </div>
    </section>
  );
}

/* ───────── shared markdown styles (carried over from the old page) ───────── */
function MemoryStyles() {
  return (
    <style>{`
      .memory-md h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
      .memory-md h2 { font-size: 15px; font-weight: 600; margin: 16px 0 7px; }
      .memory-md h3 { font-size: 13px; font-weight: 600; margin: 12px 0 5px; }
      .memory-md p { margin: 0 0 9px; font-size: 13px; line-height: 1.6; color: hsl(var(--foreground) / 0.88); }
      .memory-md ul, .memory-md ol { margin: 5px 0 11px 20px; padding: 0; }
      .memory-md li { margin: 2px 0; font-size: 13px; line-height: 1.5; color: hsl(var(--foreground) / 0.88); }
      .memory-md strong { color: hsl(var(--foreground)); font-weight: 600; }
      /* code-font: inline code in rendered markdown */ .memory-md code { font-family: var(--font-mono), monospace; font-size: 11.5px; background: hsl(var(--muted) / 0.6); border: 1px solid hsl(var(--border)); padding: 1px 5px; border-radius: calc(var(--radius) * 0.4); }
      .memory-md a { color: hsl(var(--primary)); }
      /* A thematic break is space, not a drawn rule (AGENTS.md rule 7). */
      .memory-md hr { height: 0; border: 0; margin: 20px 0; }
      /* The code-block copy button is wired by the chat only: nothing handles its click here. */
      .memory-md .copy-btn { display: none; }
    `}</style>
  );
}
