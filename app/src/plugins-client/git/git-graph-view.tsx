'use client';

/**
 * The commit graph of the Git widget: one commit per row, a column of linked
 * nodes on the left, the branch pills, hash, author and age on the right.
 *
 * "GitKraken, the light version": the lanes come from `layoutGraph`, the SVG
 * only draws them, the log is bounded (`GIT_LOG_LIMIT`) and nothing here
 * edits history. Rows have one fixed height so a single SVG lines up with the
 * HTML list; the selected commit's details sit below the list rather than
 * inside it, which would shift every row under it.
 */

import { useMemo, useState } from 'react';
import { Cloud, Copy, FolderGit2, Tag, X } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { GIT_LOG_LIMIT, useGit, type GitCommit, type GitWorktree } from '@/lib/git-store';
import { layoutGraph, pillsFor, type GraphEdge, type GraphPill } from '@/lib/git-graph';
import { ageLabel } from './git-format';

const ROW_H = 34;
const LANE_W = 12;
/** Past this many lanes they overlap on the last column: the rail is narrow,
 *  and the text is what one reads. */
const MAX_LANES = 8;
const NODE_R = 3.5;
/** Readable on the light and the dark theme alike; a lane keeps its colour
 *  while it runs. */
const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16'];
/** Pills shown in a row before "+N". */
const PILLS_INLINE = 2;

const laneX = (lane: number) => Math.min(lane, MAX_LANES - 1) * LANE_W + LANE_W / 2;
const colorOf = (i: number) => PALETTE[i % PALETTE.length]!;

function edgePath(e: GraphEdge, row: number): string {
  const top = row * ROW_H;
  const [y1, y2] = e.half === 'top' ? [top, top + ROW_H / 2] : [top + ROW_H / 2, top + ROW_H];
  const x1 = laneX(e.from);
  const x2 = laneX(e.to);
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

function pillTitle(p: GraphPill): string {
  if (p.kind === 'head') return 'HEAD';
  if (p.kind === 'worktree') return t('gitWidget.graph.detachedWorktree', { path: p.path });
  if (p.kind === 'branch') {
    const notes = [p.name];
    if (p.synced) notes.push(t('gitWidget.graph.synced'));
    if (p.worktree) notes.push(t('gitWidget.graph.held', { path: p.worktree }));
    return notes.join(' · ');
  }
  return p.name;
}

function Pill({ pill }: { pill: GraphPill }) {
  const base = 'inline-flex min-w-0 max-w-[9rem] shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[10px] leading-4';
  if (pill.kind === 'head') {
    return <span className={cn(base, 'bg-amber-500/20 font-semibold text-amber-500')} title={pillTitle(pill)}>{t('gitWidget.detached')}</span>;
  }
  if (pill.kind === 'worktree') {
    return (
      <span className={cn(base, 'bg-sky-500/15 text-sky-500')} title={pillTitle(pill)}>
        <FolderGit2 className="size-2.5 shrink-0" />
        <span className="truncate">{pill.name}</span>
      </span>
    );
  }
  if (pill.kind === 'remote' || pill.kind === 'tag') {
    const Icon = pill.kind === 'tag' ? Tag : Cloud;
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground')} title={pillTitle(pill)}>
        <Icon className="size-2.5 shrink-0" />
        <span className="truncate">{pill.name}</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        base,
        pill.current ? 'bg-primary/15 font-semibold text-primary' : pill.worktree ? 'bg-sky-500/15 text-sky-500' : 'bg-muted text-foreground',
      )}
      title={pillTitle(pill)}
    >
      {pill.worktree && <FolderGit2 className="size-2.5 shrink-0" />}
      <span className="truncate">{pill.name}</span>
      {pill.synced && <Cloud className="size-2.5 shrink-0 opacity-60" />}
    </span>
  );
}

function Pills({ pills }: { pills: GraphPill[] }) {
  if (pills.length === 0) return null;
  const shown = pills.slice(0, PILLS_INLINE);
  const rest = pills.slice(PILLS_INLINE);
  return (
    <>
      {shown.map((p, i) => <Pill key={i} pill={p} />)}
      {rest.length > 0 && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" title={rest.map(pillTitle).join('\n')}>
          {t('gitWidget.graph.more', { count: rest.length })}
        </span>
      )}
    </>
  );
}

function CommitDetails({
  commit,
  pills,
  known,
  onPick,
  onClose,
}: {
  commit: GitCommit;
  pills: GraphPill[];
  known: Set<string>;
  onPick: (hash: string) => void;
  onClose: () => void;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(commit.hash);
      toast.success(t('gitWidget.graph.copied'));
    } catch (e) { toast.error(String(e)); }
  }
  return (
    <div className="m-2 shrink-0 rounded-md bg-muted/50 p-2.5 text-[11px]">
      <div className="flex items-start gap-1.5">
        <p className="min-w-0 flex-1 break-words font-medium text-foreground">{commit.subject}</p>
        <button
          type="button"
          onClick={onClose}
          title={t('gitWidget.graph.close')}
          aria-label={t('gitWidget.graph.close')}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
      {pills.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">{pills.map((p, i) => <Pill key={i} pill={p} />)}</div>
      )}
      <div className="mt-1.5 flex items-center gap-1 text-muted-foreground">
        <span className="min-w-0 truncate tabular-nums" title={commit.hash}>{commit.hash}</span>
        <button
          type="button"
          onClick={() => void copy()}
          title={t('gitWidget.graph.copyHash')}
          aria-label={t('gitWidget.graph.copyHash')}
          className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
        >
          <Copy className="size-3" />
        </button>
      </div>
      <div className="mt-0.5 text-muted-foreground" suppressHydrationWarning>
        {commit.author} · {formatDateTime(commit.ts)}
      </div>
      {commit.parents.length > 0 && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-muted-foreground">
          <span>{t('gitWidget.graph.parents')}</span>
          {commit.parents.map((p) => (known.has(p) ? (
            <button
              key={p}
              type="button"
              onClick={() => onPick(p)}
              className="rounded px-1 tabular-nums text-primary hover:bg-muted"
            >
              {p.slice(0, 7)}
            </button>
          ) : (
            <span key={p} className="px-1 tabular-nums">{p.slice(0, 7)}</span>
          )))}
        </div>
      )}
    </div>
  );
}

/** `repoId`: `gitRepoId(slug, repo)`, the repository whose history is drawn. */
export function GitGraphView({ repoId }: { repoId: string }) {
  const log = useGit('log', repoId);
  const worktrees = useGit('worktrees', repoId).data?.worktrees;
  const [selected, setSelected] = useState<string | null>(null);

  const commits = log.data?.commits;
  const layout = useMemo(() => layoutGraph(commits ?? []), [commits]);
  const wts = useMemo<GitWorktree[]>(() => worktrees ?? [], [worktrees]);
  const currentBranch = log.data?.currentBranch ?? null;
  const pills = useMemo(
    () => layout.rows.map((r) => pillsFor(r.commit, wts, currentBranch)),
    [layout, wts, currentBranch],
  );
  const known = useMemo(() => new Set(layout.rows.map((r) => r.commit.hash)), [layout]);
  const now = Date.now();

  const error = log.error ?? (log.data && !log.data.ok ? log.data.error ?? null : null);
  if (error) {
    return (
      <div className="m-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{error}</div>
    );
  }
  if (!log.data) {
    return <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('gitWidget.graph.loading')}</div>;
  }
  if (layout.rows.length === 0) {
    return <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('gitWidget.graph.empty')}</div>;
  }

  const width = Math.min(layout.lanes, MAX_LANES) * LANE_W;
  const selectedIndex = selected ? layout.rows.findIndex((r) => r.commit.hash === selected) : -1;
  const selectedRow = selectedIndex >= 0 ? layout.rows[selectedIndex] : null;

  function pick(hash: string) {
    setSelected(hash);
    document.getElementById(`git-commit-${repoId}-${hash}`)?.scrollIntoView({ block: 'nearest' });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative px-2 py-1" role="group" aria-label={t('gitWidget.graph.label')}>
          <svg
            className="pointer-events-none absolute left-2 top-1"
            width={width}
            height={layout.rows.length * ROW_H}
            aria-hidden
          >
            {layout.rows.map((row, i) => row.edges.map((e, k) => (
              <path
                key={`${i}:${k}`}
                d={edgePath(e, i)}
                fill="none"
                stroke={colorOf(e.color)}
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            )))}
            {layout.rows.map((row, i) => {
              const head = row.commit.refs.some((r) => r.kind === 'head');
              const cx = laneX(row.lane);
              const cy = i * ROW_H + ROW_H / 2;
              return (
                <g key={row.commit.hash}>
                  {head && <circle cx={cx} cy={cy} r={NODE_R + 2.5} fill="none" stroke={colorOf(row.color)} strokeWidth={1.5} />}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={NODE_R}
                    fill={row.commit.parents.length > 1 ? 'hsl(var(--card))' : colorOf(row.color)}
                    stroke={colorOf(row.color)}
                    strokeWidth={1.5}
                  />
                </g>
              );
            })}
          </svg>
          {layout.rows.map((row, i) => {
            const c = row.commit;
            const active = c.hash === selected;
            return (
              <button
                key={c.hash}
                id={`git-commit-${repoId}-${c.hash}`}
                type="button"
                aria-pressed={active}
                onClick={() => setSelected(active ? null : c.hash)}
                className={cn(
                  'flex w-full flex-col justify-center rounded-md pr-1.5 text-left outline-none transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'bg-primary/10' : 'hover:bg-muted/50',
                )}
                style={{ height: ROW_H, paddingLeft: width + 8 }}
              >
                <span className="flex min-w-0 items-center gap-1">
                  <Pills pills={pills[i] ?? []} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground" title={c.subject}>{c.subject}</span>
                </span>
                <span className="truncate text-[10px] tabular-nums text-muted-foreground" suppressHydrationWarning>
                  {c.short} · {c.author} · {ageLabel(c.ts, now)}
                </span>
              </button>
            );
          })}
        </div>
        {log.data.truncated && (
          <p className="px-3 pb-2 text-[10.5px] tabular-nums text-muted-foreground/70">
            {t('gitWidget.graph.truncated', { count: layout.rows.length })}
          </p>
        )}
      </div>
      {selectedRow && (
        <CommitDetails
          commit={selectedRow.commit}
          pills={pills[selectedIndex] ?? []}
          known={known}
          onPick={pick}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
