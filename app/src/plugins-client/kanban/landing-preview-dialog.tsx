'use client';

/**
 * The product's job dialog (`kanban.job.dialog`, host `job-dialog.tsx`): what
 * the job's pull request brings (the diff, file by file, and the commits),
 * whether Timon would open it (the pre-checks, run dry by the daemon: nothing
 * fetched, pushed or opened), and, beside them, its links — the ideas it
 * carries, their issues, the mission that pilots it, its branch and target —
 * and its checks on the forge with the repair counter. The foot holds the
 * window's gestures: read the checks again, and the repair the forge calls
 * for (or, once the repairs are spent, the pull request to take it over); for
 * a job the planner kept on its branch, its landing — "Merge into main", or
 * "Open the pull request" with the title it will carry.
 *
 * Two islands rather than one long page: a branch of a few hundred files keeps
 * its commits, its verdict and its links one click away. A file's patch is
 * painted only once unfolded.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, CircleDot, CircleMinus, ExternalLink, GitPullRequest, LoaderCircle, MessageSquare, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { WidgetButton, widgetButtonClass } from '@/components/widget-toolbar';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { safeHref } from './project-todo-links';
import { useJobDialog, type JobDialogValue } from './job-dialog-context';
import {
  diffLineKind, landsInPlace, mainRepair, NO_LINKS, patchBody, previewLanding, repairsSpent,
  type CheckStatus, type DiffLineKind, type Landing, type LandingPreview, type LinkedIssue, type Precheck, type PreviewFile,
} from './landing-api';
import { RepairIcon, repairHint, repairLabel } from './landing-repair';
import { LandIcon, landLabel, titleFromBranch } from './landing-land';

/** How each kind of diff line is painted, here and in the open pull requests' dialog. */
export const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  del: 'bg-red-500/10 text-red-800 dark:text-red-200',
  hunk: 'text-sky-700 dark:text-sky-300',
  meta: 'text-muted-foreground',
  context: 'text-foreground/85',
};

const NOTE = 'rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-800 dark:text-amber-200';
const ISLAND = 'rounded-lg bg-foreground/[0.035]';

function FileDiff({ file, open, onToggle }: { file: PreviewFile; open: boolean; onToggle: () => void }) {
  return (
    <li className={ISLAND}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-foreground/[0.04]"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        {/* code-font: a file path */}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={file.path}>{file.path}</span>
        {file.binary
          ? <span className="text-[11px] text-muted-foreground">{t('landings.previewDialog.binary')}</span>
          : (
            <span className="shrink-0 text-[11px] tabular-nums">
              <span className="text-emerald-700 dark:text-emerald-300">+{file.additions ?? 0}</span>
              {' '}
              <span className="text-red-700 dark:text-red-300">−{file.deletions ?? 0}</span>
            </span>
          )}
      </button>
      {open && (
        <div className="px-2 pb-2">
          {file.patch === null
            ? <p className="px-1 text-[11.5px] text-muted-foreground">{t('landings.previewDialog.noPatch')}</p>
            : (
              // code-font: a diff
              <pre className="scrollbar-thin overflow-x-auto rounded-md bg-background/70 py-1.5 font-mono text-[11px] leading-[1.5]">
                {/* w-max + min-w-full: a line's colour spans the scrolled width. */}
                <div className="w-max min-w-full">
                  {patchBody(file.patch).map((line, i) => (
                    <div key={i} className={cn('whitespace-pre px-2', DIFF_LINE_CLASS[diffLineKind(line)])} data-kind={diffLineKind(line)}>{line || ' '}</div>
                  ))}
                </div>
              </pre>
            )}
          {file.patch_truncated && <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{t('landings.previewDialog.fileCut')}</p>}
        </div>
      )}
    </li>
  );
}

function PrecheckRow({ check }: { check: Precheck }) {
  const Icon = check.skipped ? CircleMinus : check.ok ? CircleCheck : CircleAlert;
  const tone = check.skipped ? 'text-muted-foreground' : check.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return (
    <li className={cn(ISLAND, 'flex items-start gap-2 px-2.5 py-2')} data-check={check.name} data-ok={check.ok}>
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', tone)} aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-medium">
          {t(`landings.precheck.${check.name}`)}
          {check.skipped && <span className="ml-1.5 font-normal text-muted-foreground">{t('landings.previewDialog.skipped')}</span>}
        </p>
        {/* The daemon's own wording: a branch, a commit or an account. */}
        <p className="break-words text-[11.5px] text-muted-foreground">{check.detail}</p>
      </div>
    </li>
  );
}

function Verdict({ preview }: { preview: LandingPreview }) {
  const p = preview.prechecks;
  if (!p.ran) return <p className="text-[11.5px] text-muted-foreground">{t('landings.previewDialog.prechecksNotRun', { reason: p.reason })}</p>;
  const refused = p.checks.filter((c) => !c.ok).length;
  return p.ready
    ? <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">{t('landings.previewDialog.ready')}</p>
    : <p className="text-xs font-medium text-red-700 dark:text-red-300">{t('landings.previewDialog.refused', { count: refused })}</p>;
}

export function ProductJobDialog(): ReactElement | null {
  const host = useJobDialog();
  if (!host) return null;
  return <JobDialogBody host={host} />;
}

const CHIP = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium tabular-nums';

/** One line of the Links island: what it is on the left, the link on the right. */
function LinkRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center justify-end gap-1 text-right">{children}</dd>
    </div>
  );
}

function IssueLink({ issue, prRepo }: { issue: LinkedIssue; prRepo: string | null }) {
  // The pull request's own repository goes without saying; another one is named.
  const same = prRepo !== null && prRepo.toLowerCase() === issue.repo.toLowerCase();
  const text = same ? `#${issue.number}` : `${issue.repo}#${issue.number}`;
  const href = safeHref(issue.url);
  const label = issue.closes ? t('landings.links.issueCloses', { ref: `${issue.repo}#${issue.number}` }) : `${issue.repo}#${issue.number}`;
  const body = (
    <>
      <CircleDot className="size-3" aria-hidden />
      {text}
      {issue.closes && <span className="font-normal opacity-80">· {t('landings.links.closes')}</span>}
    </>
  );
  const tone = 'bg-foreground/[0.06] text-foreground/85';
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" data-job-issue={issue.number} title={label} aria-label={label}
      className={cn(CHIP, tone, 'underline-offset-2 hover:underline')}>{body}</a>
  ) : <span data-job-issue={issue.number} title={label} className={cn(CHIP, tone)}>{body}</span>;
}

const PR_REPO = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/;

/** The job's links: its ideas, their issues, its pilot mission, its branch. */
export function JobLinksIsland({ landing, openTodo, openMission }: {
  landing: Landing;
  openTodo: ((id: number) => void) | null;
  openMission: (missionId: string) => void;
}): ReactElement {
  const links = landing.links ?? NO_LINKS;
  const prRepo = landing.pr_url ? PR_REPO.exec(landing.pr_url)?.[1] ?? null : null;
  return (
    <section data-job-links="" aria-label={t('landings.links.title')} className={cn(ISLAND, 'flex flex-col gap-2 px-3 py-2.5')}>
      <h3 className="text-[11.5px] font-medium text-muted-foreground">{t('landings.links.title')}</h3>
      <dl className="flex flex-col gap-2">
        {links.todos.length > 0 && (
          <LinkRow label={t('landings.links.todo', { count: links.todos.length })}>
            {links.todos.map((todo) => (
              openTodo ? (
                <button key={todo.id} type="button" data-job-todo={todo.id} onClick={() => openTodo(todo.id)} title={todo.text}
                  className="min-w-0 max-w-full truncate rounded-sm text-right text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {todo.text}
                </button>
              ) : <span key={todo.id} data-job-todo={todo.id} title={todo.text} className="min-w-0 max-w-full truncate">{todo.text}</span>
            ))}
          </LinkRow>
        )}
        {links.issues.length > 0 && (
          <LinkRow label={t('landings.links.issue', { count: links.issues.length })}>
            {links.issues.map((issue) => <IssueLink key={`${issue.repo}#${issue.number}`} issue={issue} prRepo={prRepo} />)}
          </LinkRow>
        )}
        {links.pilot_mission_id && (
          <LinkRow label={t('landings.links.job')}>
            <button type="button" data-job-pilot={links.pilot_mission_id} onClick={() => openMission(links.pilot_mission_id!)}
              className={cn(CHIP, 'bg-foreground/[0.06] text-foreground/85 hover:bg-foreground/[0.1]')}>
              <MessageSquare className="size-3" aria-hidden />{t('landings.links.openMission')}
            </button>
          </LinkRow>
        )}
        <LinkRow label={t('landings.links.branch')}>
          <span className="min-w-0 truncate" title={`${landing.branch} → ${landing.remote}/${landing.target}`}>
            {landing.branch} → {landing.target}
          </span>
        </LinkRow>
      </dl>
    </section>
  );
}

const CHECK_TONE: Record<CheckStatus, string> = {
  fail: 'bg-red-500/15 text-red-700 dark:text-red-300',
  pass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  skipped: 'bg-foreground/[0.06] text-muted-foreground',
};

/** The pull request's checks as last read, failures first, and the repair counter. */
export function JobChecksIsland({ landing }: { landing: Landing }): ReactElement {
  const items = [...(landing.checks?.items ?? [])].sort((a, b) => (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1));
  const r = landing.repairs;
  return (
    <section data-job-checks="" aria-label={t('landings.checksIsland.title')} className={cn(ISLAND, 'flex flex-col gap-2 px-3 py-2.5')}>
      <h3 className="text-[11.5px] font-medium text-muted-foreground">{t('landings.checksIsland.title')}</h3>
      {landing.checks === null && <p className="text-xs text-muted-foreground">{t('landings.checksIsland.none')}</p>}
      <dl className="flex flex-col gap-2">
        {items.map((check) => {
          const href = safeHref(check.url);
          return (
            <LinkRow key={check.name} label={check.name}>
              <span data-check-status={check.status} className={cn(CHIP, CHECK_TONE[check.status])}>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                    {t(`landings.checksIsland.status.${check.status}`)}
                  </a>
                ) : t(`landings.checksIsland.status.${check.status}`)}
              </span>
            </LinkRow>
          );
        })}
        {r && (
          <div data-repair-counter="" className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
            <dt className="shrink-0 text-muted-foreground">{t('landings.repair.counterLabel')}</dt>
            <dd className="tabular-nums" title={r.last ? t(`landings.repair.last.${r.last.state}`) : undefined}>{r.used} / {r.max}</dd>
          </div>
        )}
      </dl>
      {r?.running && (
        <p data-repair-running="" className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <LoaderCircle className="size-3.5 animate-spin [animation-duration:2s]" aria-hidden />
          {t('landings.repair.underWay', { kind: repairLabel(r.running.kind) })}
        </p>
      )}
      {!r?.running && r?.last?.state === 'failed' && r.last.error && (
        // The daemon's own wording: why the last repair was not pushed.
        <p className="break-words text-[11.5px] text-muted-foreground">{t('landings.repair.last.failed')} · {r.last.error}</p>
      )}
    </section>
  );
}

/**
 * The foot of a kept job: its landing as the window's main action. A pull
 * request needs a title: it starts from the branch's name, and the person
 * writes the real one here (the pre-checks refuse an id or a French title).
 */
function JobLandFoot({ host, commits }: { host: JobDialogValue; commits: number | null }): ReactElement | null {
  const { landing, busy, land, landBlocked: blocked } = host;
  const local = landsInPlace(landing);
  const [title, setTitle] = useState(() => titleFromBranch(landing.branch));
  if (!land) return null;
  const label = landLabel(landing);
  const missingTitle = !local && !title.trim();
  return (
    <div data-job-land-foot="" className="flex flex-wrap items-center justify-end gap-2">
      {!local && (
        <Input
          data-job-land-title=""
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={256}
          aria-label={t('landings.land.titleLabel')}
          placeholder={t('landings.land.titleLabel')}
          className="h-7 min-w-0 flex-1 text-xs"
        />
      )}
      {/* A disabled button takes no pointer events: the wrapper carries the reason's tooltip. */}
      <span title={blocked ?? undefined} className="shrink-0">
        <WidgetButton
          primary
          data-job-land=""
          onClick={() => { void land(local ? {} : { title: title.trim() }, commits); }}
          disabled={busy !== null || blocked !== null || missingTitle}
          aria-busy={busy === 'land' || undefined}
          icon={<LandIcon landing={landing} busy={busy === 'land'} />}
          label={label}
        />
      </span>
    </div>
  );
}

/** The foot of the window: read the checks again, and the repair the forge calls for. */
function JobDialogFoot({ host }: { host: JobDialogValue }): ReactElement {
  const { landing, busy } = host;
  const kind = mainRepair(landing);
  return (
    <div data-job-foot="" className="flex flex-wrap items-center justify-end gap-2">
      <WidgetButton
        data-job-refresh=""
        onClick={() => { void host.refresh(); }}
        disabled={busy !== null}
        icon={<RefreshCw className={cn('size-3.5', busy === 'refresh' && 'animate-spin')} />}
        label={t('landings.reload')}
      />
      {kind && (
        <WidgetButton
          primary
          data-job-repair={kind}
          onClick={() => { void host.repair(kind); }}
          disabled={busy !== null}
          title={repairHint(kind, landing)}
          icon={busy === kind ? <LoaderCircle className="size-3.5 animate-spin" /> : <RepairIcon kind={kind} />}
          label={repairLabel(kind)}
        />
      )}
      {!kind && repairsSpent(landing) && landing.pr_url && (
        <a
          href={landing.pr_url}
          target="_blank"
          rel="noopener noreferrer"
          data-job-take-over=""
          title={t('landings.repair.takeOverTitle')}
          className={widgetButtonClass({ primary: true })}
        >
          <ExternalLink className="size-3.5" aria-hidden />{t('landings.repair.takeOver')}
        </a>
      )}
    </div>
  );
}

function JobDialogBody({ host }: { host: JobDialogValue }) {
  const { landing, close: onClose, openTodo, openMission } = host;
  const [preview, setPreview] = useState<LandingPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void previewLanding(landing.id).then((out) => {
      if (!alive) return;
      if (!out.ok) { setError(out.message); return; }
      setPreview(out.value);
      // A short diff opens whole; a long one waits to be asked.
      if (out.value.files.length <= 3) setOpen(new Set(out.value.files.map((f) => f.path)));
    });
    return () => { alive = false; };
  }, [landing.id]);

  const toggle = (path: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(path)) n.delete(path); else n.add(path);
    return n;
  });
  const target = `${landing.remote}/${landing.target}`;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] max-w-[900px] flex-col gap-3 overflow-hidden">
        <DialogTitle className="flex min-w-0 items-center gap-2 text-sm">
          <GitPullRequest className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate" title={landing.pr_title ?? landing.branch}>{landing.pr_title || landing.branch}</span>
          {landing.pr_number !== null && (
            <span className={cn(CHIP, 'bg-foreground/[0.06] text-muted-foreground')}>{t('landings.state.open', { number: landing.pr_number })}</span>
          )}
          {!landing.pr_title && <span className="shrink-0 font-normal text-muted-foreground">{t('landings.into', { target })}</span>}
          {landing.pr_url && (
            <a
              href={landing.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              data-landing-forge=""
              title={t('landings.openPr')}
              aria-label={t('landings.openPr')}
              className={cn(widgetButtonClass({ iconOnly: true }), 'ml-auto mr-6 shrink-0')}
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </DialogTitle>
        <DialogDescription className="sr-only">{t('landings.previewDialog.description')}</DialogDescription>

        {/* The links show at once: they come with the job, the diff takes a git read. */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_17rem]">
          <div className={cn(ISLAND, 'flex min-h-0 min-w-0 flex-col gap-2 p-2.5')}>
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            {!preview && !error && <p className="text-xs text-muted-foreground">{t('landings.loading')}</p>}

            {preview && (
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] tabular-nums text-muted-foreground">
                  <span>{t('landings.previewDialog.summary', { commits: preview.commit_count, files: preview.totals.files })}</span>
                  <span>
                    <span className="text-emerald-700 dark:text-emerald-300">+{preview.totals.additions}</span>
                    {' '}
                    <span className="text-red-700 dark:text-red-300">−{preview.totals.deletions}</span>
                  </span>
                  <span className={cn(preview.conflict.state === 'conflicting' && 'font-medium text-red-700 dark:text-red-300')}>
                    {t(`landings.previewDialog.conflict.${preview.conflict.state}`, { target })}
                  </span>
                  <span className="ml-auto"><Verdict preview={preview} /></span>
                </div>
                {preview.problem && <p className={NOTE}>{preview.problem}</p>}
                {preview.conflict.files.length > 0 && (
                  <p className={NOTE}>{t('landings.previewDialog.conflictFiles', { files: preview.conflict.files.join(', ') })}</p>
                )}

                <Tabs defaultValue="changes" className="flex min-h-0 flex-1 flex-col gap-2">
                  <TabsList className="h-8 self-start">
                    <TabsTrigger value="changes" className="text-xs">{t('landings.previewDialog.tabChanges')}</TabsTrigger>
                    <TabsTrigger value="commits" className="text-xs">{t('landings.previewDialog.tabCommits')}</TabsTrigger>
                    <TabsTrigger value="checks" className="text-xs">{t('landings.previewDialog.tabChecks')}</TabsTrigger>
                  </TabsList>

                  <TabsContent value="changes" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
                    {preview.files.length === 0 && !preview.problem && (
                      <p className="text-xs text-muted-foreground">{t('landings.previewDialog.nothing', { target })}</p>
                    )}
                    <ul className="flex flex-col gap-1.5">
                      {preview.files.map((file) => (
                        <FileDiff key={file.path} file={file} open={open.has(file.path)} onToggle={() => toggle(file.path)} />
                      ))}
                    </ul>
                    {(preview.files_truncated || preview.patch_truncated) && (
                      <p className={cn(NOTE, 'mt-2')}>
                        {preview.files_truncated
                          ? t('landings.previewDialog.filesCut', { shown: preview.files.length, total: preview.totals.files })
                          : t('landings.previewDialog.patchCut')}
                      </p>
                    )}
                  </TabsContent>

                  <TabsContent value="commits" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
                    <ul className="flex flex-col gap-1">
                      {preview.commits.map((c) => (
                        <li key={c.sha} className={cn(ISLAND, 'flex min-w-0 items-baseline gap-2 px-2.5 py-1.5')}>
                          {/* code-font: a commit sha */}
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{c.short}</span>
                          <span className="min-w-0 flex-1 truncate text-xs" title={c.subject}>{c.subject}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">{c.author}</span>
                        </li>
                      ))}
                    </ul>
                    {preview.commits_truncated && (
                      <p className={cn(NOTE, 'mt-2')}>{t('landings.previewDialog.commitsCut', { shown: preview.commits.length, total: preview.commit_count })}</p>
                    )}
                  </TabsContent>

                  <TabsContent value="checks" className="scrollbar-thin mt-0 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto data-[state=inactive]:hidden">
                    {preview.pull_request && (
                      <div className={cn(ISLAND, 'px-2.5 py-2')}>
                        <p className="text-xs font-medium">{preview.pull_request.title}</p>
                        {preview.pull_request.body && (
                          <p className="mt-1 whitespace-pre-wrap break-words text-[11.5px] text-muted-foreground">{preview.pull_request.body}</p>
                        )}
                      </div>
                    )}
                    {preview.prechecks.ran
                      ? (
                        <ul className="flex flex-col gap-1">
                          {preview.prechecks.checks.map((c) => <PrecheckRow key={c.name} check={c} />)}
                        </ul>
                      )
                      : <Verdict preview={preview} />}
                  </TabsContent>
                </Tabs>
              </>
            )}
          </div>
          <div className="flex min-h-0 flex-col gap-3 md:overflow-y-auto">
            <JobLinksIsland landing={landing} openTodo={openTodo} openMission={openMission} />
            {landing.state === 'open' && <JobChecksIsland landing={landing} />}
          </div>
        </div>
        {landing.state === 'open' && <JobDialogFoot host={host} />}
        {host.land && <JobLandFoot host={host} commits={preview && !preview.problem ? preview.commit_count : null} />}
      </DialogContent>
    </Dialog>
  );
}
