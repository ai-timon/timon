'use client';

/**
 * "Open pull requests": the pull requests open on the repository of ONE
 * project in `pr` mode, contributors' ones included, and the brief of their
 * relecture.
 *
 * One group, one filter (the author), one main action per row: "Prepare the
 * review". It prepares the reviewer's brief and shows it beside the diff, with
 * a way to copy it; Timon starts no mission from here, since its reviewer
 * would not be confined, and nothing is ever posted on the forge. Opening the
 * pull request on the forge, or a past report, sit in the row's menu. A click
 * on the row opens its page, as GitHub shows it, in a window of the app
 * (`pull-request-dialog.tsx`), whose buttons and "…" menu offer the same
 * gestures in the same order (`pullRequestActions`).
 *
 * A widget of the "Git" stack. The project comes from the chat rail when
 * there is one, else from a picker the jobs widget shares
 * (`git-stack-project.tsx`): it is chosen once for both.
 *
 * A job of the project that opens, merges or closes its pull request is
 * announced by the daemon (`landing-events.ts`): the list is read again then,
 * behind what it shows. A slow poll, in front only, catches the contributors'
 * pull requests, which nothing announces.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Copy, Eye, GitPullRequest, Loader2, MoreHorizontal, ScanSearch } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { Tile } from '@/components/tile';
import { WIDGET_SELECT, WidgetButton, widgetButtonClass } from '@/components/widget-toolbar';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiErrorMessage } from '@/lib/api-error';
import { copyToClipboard } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import { NativeViewCover } from '@/lib/native-view-cover';
import { cn } from '@/lib/utils';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { useWidgetAttention, useWidgetCount, useWidgetInFront } from '@/components/widget-host/widget-self';
import { sharedGet } from '@/lib/shared-read';
import {
  anyReviewRunning, branchChip, branchLock, filterByAuthor, keepPullList, lastPullList, pullAuthors, pullMenuActions, pullRequestActions,
  reviewBadge, shouldReadPulls, type PullActionId, type PullBranchWork, type PullRequestItem, type PullRequestList, type PullWork,
  type ReviewBadge,
} from './pull-requests-model';
import { diffLineKind, getLanding, type Landing } from './landing-api';
import { DIFF_LINE_CLASS } from './landing-preview-dialog';
import { JobDialog } from './job-dialog';
import { JobLinksMenuItems } from './job-links-menu';
import { useTodoOpener } from './todo-opener';
import { proposalsForPull, waitingCount, type ForgeProposal } from './forge-proposals-api';
import { ProposalChip } from './proposal-chip';
import { PublishDialog, type PublishTarget } from './publish-dialog';
import { useForgeProposals } from './use-forge-proposals';
import { StackProjectPicker, useStackProject } from './git-stack-project';
import { proposeAskContributor, proposeBranchUpdate } from './forge-branch-api';
import { ConflictDialog } from './conflict-dialog';
import { useLandingChanges, useLandingFallbackPoll, type LandingChange } from './landing-events';
import { landsLocally, LocalLandingEmpty, useProjectIntegration } from './local-landing';
import { onIntegrationChanged } from './project-integration-api';
import { PullRequestDialog } from './pull-request-dialog';
import { PULL_MENU_ITEM, PullActionMenuItems } from './pull-request-actions';

/** How often a running review is asked for its verdict. */
const RUNNING_POLL_MS = 15_000;
/** Most diff lines painted: a 2 MB diff would freeze the dialog. */
const DIFF_LINES_SHOWN = 3000;

type Load =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; list: PullRequestList };

type Draft = { number: number; title: string; brief: string };

/** The diff of pull request `number`: an answer for an earlier dialog is dropped. */
type DiffLoad = { number: number } & (
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; diff: string; truncated: boolean }
);

const projectPath = (slug: string) => `/api/ui/projects/${encodeURIComponent(slug)}/pull-requests`;

export function PullRequestsWidget({ handle, className }: WidgetProps) {
  const project = useStackProject();
  const slug = project.slug;
  const [load, setLoad] = useState<Load>({ kind: 'idle' });
  const [author, setAuthor] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [diff, setDiff] = useState<DiffLoad>({ number: 0, kind: 'loading' });
  const [report, setReport] = useState<PullRequestItem | null>(null);
  const [job, setJob] = useState<Landing | null>(null);
  const { openTodo, todoModal } = useTodoOpener();
  const closeJob = useCallback(() => setJob(null), []);
  const proposals = useForgeProposals(useMemo(() => (slug ? [slug] : []), [slug]));
  // A proposal waiting on a row, or a new comment a person writes on a pull request.
  const [publishing, setPublishing] = useState<{ proposal?: ForgeProposal; proposalId?: string; target?: PublishTarget } | null>(null);
  const [resolving, setResolving] = useState<PullRequestItem | null>(null);
  /** The branch gesture being prepared, so its row and its window show it and a second click waits. */
  const [branchBusy, setBranchBusy] = useState<{ number: number; work: PullBranchWork } | null>(null);
  /** The pull request whose page is open. Two dialogs do not stack: a gesture
   *  that opens one closes the window, once what it opens is ready. */
  const [detail, setDetail] = useState<PullRequestItem | null>(null);

  /** Prepares a write on a pull request's branch and opens it in "Publish on GitHub". */
  const prepareWrite = async (pull: PullRequestItem, work: PullBranchWork) => {
    if (!slug) return;
    const [step, failure] = work === 'updateBranch'
      ? [proposeBranchUpdate, t('pullRequests.updateBranchError')]
      : [proposeAskContributor, t('pullRequests.askContributorError')];
    setBranchBusy({ number: pull.number, work });
    const out = await step(slug, pull.number);
    setBranchBusy(null);
    if (!out.ok) { toast.error(failure, { description: out.message }); return; }
    proposals.reload();
    setDetail(null);
    setPublishing({ proposal: out.value });
  };

  const openJob = async (id: string) => {
    const out = await getLanding(id);
    if (out.ok) setJob(out.value);
    else toast.error(out.message);
  };

  const reload = useCallback(async (quiet = false) => {
    if (!slug) { setLoad({ kind: 'idle' }); return; }
    if (!quiet) setLoad({ kind: 'loading' });
    try {
      const res = await sharedGet(projectPath(slug));
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setLoad({ kind: 'error', message: apiErrorMessage(json, { status: res.status }) }); return; }
      keepPullList(slug, json as PullRequestList);
      setLoad({ kind: 'ready', list: json as PullRequestList });
    } catch (err) {
      setLoad({ kind: 'error', message: (err as Error).message });
    }
  }, [slug]);

  // The list comes from `gh` on the daemon's side. Behind another tab of the
  // Git stack (kept mounted for its count), a list read less than a minute
  // ago is enough; in front, or older, it is read again.
  const front = useWidgetInFront();
  const frontNow = useRef(front);
  frontNow.current = front;
  useEffect(() => {
    setAuthor(null);
    const known = slug ? lastPullList(slug) : undefined;
    if (known) setLoad({ kind: 'ready', list: known.list });
    if (shouldReadPulls(frontNow.current, known?.at ?? null, Date.now())) void reload(!!known);
  }, [reload, slug]);
  // Brought to the front: read again, behind what it already shows.
  const wasFront = useRef(front);
  useEffect(() => {
    if (front && !wasFront.current) void reload(true);
    wasFront.current = front;
  }, [front, reload]);

  // Its checks and its landing do not change the list of open pull requests.
  useLandingChanges(() => { void reload(true); }, useCallback(
    (change: LandingChange) => change.project === slug && change.changed.some((c) => c === 'state' || c === 'pull_request'),
    [slug],
  ), slug);
  useLandingFallbackPoll(() => { if (frontNow.current) void reload(true); });
  // Turned to pull requests from the shortcut below: the list exists from now on.
  useEffect(() => (slug ? onIntegrationChanged(slug, () => { void reload(); }) : undefined), [slug, reload]);
  const integration = useProjectIntegration(slug);

  const pulls = load.kind === 'ready' ? load.list.pulls : [];
  const running = anyReviewRunning(pulls);
  useEffect(() => {
    if (!running || !front) return;
    const timer = setInterval(() => { void reload(true); }, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [running, front, reload]);

  const authors = useMemo(() => pullAuthors(pulls), [pulls]);
  const shown = useMemo(() => filterByAuthor(pulls, author), [pulls, author]);
  // In the Git stack the count sits on the tab ("PR 3"); alone, by the title.
  const countOnTab = useWidgetCount(load.kind === 'ready' ? shown.length : null);
  // A publication waiting on one of the pull requests: a dot on the tab, the chip on its row.
  const repo = load.kind === 'ready' ? load.list.repo : null;
  const waiting = useMemo(
    () => (repo ? waitingCount(pulls.map((pull) => proposalsForPull(proposals.pending, repo, pull))) : 0),
    [repo, pulls, proposals.pending],
  );
  useWidgetAttention(waiting > 0 ? t('forgePublish.tabWaiting', { count: waiting }) : null);

  const prepare = async (pull: PullRequestItem) => {
    if (!slug) return;
    setPreparing(pull.number);
    try {
      const res = await fetch(`${projectPath(slug)}/${pull.number}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const json = await res.json().catch(() => ({})) as { brief?: string };
      if (!res.ok || !json.brief) {
        toast.error(t('pullRequests.briefError'), { description: apiErrorMessage(json, { status: res.status }) });
        return;
      }
      setDiff({ number: pull.number, kind: 'loading' });
      setDetail(null);
      setDraft({ number: pull.number, title: pull.title, brief: json.brief });
      void readDiff(slug, pull.number);
    } catch (err) {
      toast.error(t('pullRequests.briefError'), { description: (err as Error).message });
    } finally {
      setPreparing(null);
    }
  };

  const readDiff = async (project: string, number: number) => {
    const show = (next: DiffLoad) => setDiff((current) => (current.number === number ? next : current));
    try {
      const res = await fetch(`${projectPath(project)}/${number}/diff`, { cache: 'no-store' });
      const json = await res.json().catch(() => ({})) as { diff?: string; truncated?: boolean };
      if (!res.ok || typeof json.diff !== 'string') {
        show({ number, kind: 'error', message: apiErrorMessage(json, { status: res.status }) });
        return;
      }
      show({ number, kind: 'ready', diff: json.diff, truncated: json.truncated === true });
    } catch (err) {
      show({ number, kind: 'error', message: (err as Error).message });
    }
  };

  const copyBrief = async () => {
    if (!draft) return;
    if (await copyToClipboard(draft.brief)) toast.success(t('pullRequests.dialog.copied'));
    else toast.error(t('pullRequests.dialog.copyFailed'));
  };

  /** What is under way on a pull request, for its buttons and its menu. */
  const workOn = (pull: PullRequestItem): PullWork => ({
    branch: branchBusy?.number === pull.number ? branchBusy.work : null,
    preparing: preparing === pull.number,
  });

  /** Runs a gesture of a pull request, from its row's menu or from its window. */
  const run = (pull: PullRequestItem, id: PullActionId) => {
    // A gesture that opens its dialog at once closes the window first; one
    // prepared by the daemon closes it once ready, its button spinning meanwhile.
    const opens = (fn: () => void) => { setDetail(null); fn(); };
    switch (id) {
      case 'review': void prepare(pull); return;
      case 'updateBranch': case 'askContributor': void prepareWrite(pull, id); return;
      case 'report': opens(() => setReport(pull)); return;
      case 'resolveConflict': opens(() => setResolving(pull)); return;
      case 'comment':
        opens(() => setPublishing({ target: { type: 'pull', number: pull.number, url: pull.url, repo } }));
        return;
      case 'forge': window.open(pull.url, '_blank', 'noopener,noreferrer'); return;
    }
  };

  const projectPicker = (
    <StackProjectPicker project={project} none={t('pullRequests.noProjectOption')} label={t('pullRequests.selectProject')} />
  );

  const authorFilter = authors.length > 1 ? (
    <select
      data-pull-author-filter=""
      value={author ?? ''}
      aria-label={t('pullRequests.filterAuthor')}
      onChange={(e) => setAuthor(e.target.value || null)}
      className={cn(WIDGET_SELECT, 'max-w-[8rem]')}
    >
      <option value="">{t('pullRequests.allAuthors')}</option>
      {authors.map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
  ) : null;

  return (
    <Tile
      title={t('pullRequests.title')}
      subtitle={load.kind === 'ready' && !countOnTab ? String(shown.length) : undefined}
      className={cn(HUD_SURFACE, className)}
      bodyClassName="px-1.5 pb-3 pt-1"
      actions={<>{authorFilter}{projectPicker}{handle}</>}
    >
      {!slug ? (
        <Empty text={t('pullRequests.chooseProject')} />
      ) : landsLocally(integration) ? (
        <LocalLandingEmpty project={slug} read={integration} />
      ) : load.kind === 'loading' || load.kind === 'idle' ? (
        <Empty text={t('pullRequests.loading')} />
      ) : load.kind === 'error' ? (
        <Empty text={load.message} />
      ) : shown.length === 0 ? (
        <Empty text={author ? t('pullRequests.emptyAuthor') : t('pullRequests.empty')} />
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((pull) => (
            <PullRow
              key={pull.number}
              pull={pull}
              preparing={preparing === pull.number}
              branchBusy={branchBusy?.number === pull.number}
              proposals={load.kind === 'ready' ? proposalsForPull(proposals.pending, load.list.repo, pull) : []}
              onOpenProposal={(proposal) => setPublishing({ proposal })}
              onOpen={() => setDetail(pull)}
              onReview={() => void prepare(pull)}
              menu={(
                <PullMenuItems
                  pull={pull}
                  // The loupe beside the menu prepares the review: the menu leaves it out.
                  actions={pullMenuActions(pullRequestActions(pull, workOn(pull))).filter((a) => a.id !== 'review')}
                  onRun={(id) => run(pull, id)}
                  onOpenJob={(id) => { void openJob(id); }}
                  onOpenTodo={openTodo}
                />
              )}
            />
          ))}
        </ul>
      )}

      {detail && slug && (
        <PullRequestDialog
          key={detail.number}
          project={slug}
          repo={repo}
          pull={detail}
          onClose={() => setDetail(null)}
          onOpenJob={(id) => { setDetail(null); void openJob(id); }}
          onOpenTodo={(id) => { setDetail(null); openTodo(id); }}
          actions={pullRequestActions(detail, workOn(detail))}
          onAction={(id) => run(detail, id)}
          links={(
            <PullLinkItems
              pull={detail}
              onOpenJob={(id) => { setDetail(null); void openJob(id); }}
              onOpenTodo={(id) => { setDetail(null); openTodo(id); }}
            />
          )}
        />
      )}

      {draft && (
        <Dialog open onOpenChange={(open) => { if (!open) setDraft(null); }}>
          <DialogContent className="max-w-3xl">
            <DialogTitle className="text-sm">{t('pullRequests.dialog.title', { number: draft.number })}</DialogTitle>
            <DialogDescription data-pull-brief-description="" className="text-xs text-muted-foreground">{t('pullRequests.dialog.description')}</DialogDescription>
            <Tabs defaultValue="brief" className="flex min-h-0 min-w-0 flex-col gap-2">
              <TabsList className="h-8 self-start">
                <TabsTrigger value="brief" className="text-xs">{t('pullRequests.dialog.tabBrief')}</TabsTrigger>
                <TabsTrigger value="diff" data-pull-diff-tab="" className="text-xs">{t('pullRequests.dialog.tabDiff')}</TabsTrigger>
              </TabsList>
              <TabsContent value="brief" className="mt-0 min-w-0">
                <div data-pull-brief="" className="scrollbar-thin max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-[12px] leading-relaxed text-foreground">
                  {draft.brief}
                </div>
              </TabsContent>
              <TabsContent value="diff" className="mt-0 min-w-0">
                <DiffView load={diff} />
              </TabsContent>
            </Tabs>
            <div className="flex justify-end gap-2">
              <WidgetButton onClick={() => setDraft(null)} label={t('pullRequests.dialog.close')} />
              <WidgetButton primary data-pull-copy="" onClick={() => void copyBrief()} icon={<Copy className="size-3" />} label={t('pullRequests.dialog.copy')} />
            </div>
          </DialogContent>
        </Dialog>
      )}

      {job && <JobDialog landing={job} onClose={closeJob} openTodo={openTodo} />}
      {todoModal}
      {publishing && slug && (
        <PublishDialog
          key={publishing.proposal?.id ?? publishing.proposalId ?? `new:${publishing.target?.number}`}
          project={slug}
          {...(publishing.proposal ? { proposal: publishing.proposal } : {})}
          {...(publishing.proposalId ? { proposalId: publishing.proposalId } : {})}
          {...(publishing.target ? { target: publishing.target } : {})}
          onClose={() => setPublishing(null)}
          // A published branch update or push changes what GitHub says of the branch.
          onChange={() => { proposals.reload(); void reload(true); }}
        />
      )}

      {resolving && slug && (
        <ConflictDialog
          key={resolving.number}
          project={slug}
          pull={{ number: resolving.number, title: resolving.title }}
          onClose={() => { setResolving(null); proposals.reload(); }}
          onPublish={(proposalId) => {
            // Two dialogs do not stack: the conflict closes before its publication opens.
            setResolving(null);
            proposals.reload();
            setPublishing({ proposalId });
          }}
        />
      )}

      {report?.review?.report && (
        <Dialog open onOpenChange={(open) => { if (!open) setReport(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogTitle className="text-sm">{t('pullRequests.report.title', { number: report.number })}</DialogTitle>
            <DialogDescription className="sr-only">{report.title}</DialogDescription>
            <div className="scrollbar-thin max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-[12.5px] leading-relaxed text-foreground">
              {report.review.report}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Tile>
  );
}

function DiffView({ load }: { load: DiffLoad }) {
  if (load.kind === 'loading') return <p className="text-xs text-muted-foreground">{t('pullRequests.loading')}</p>;
  if (load.kind === 'error') return <p className="text-xs text-red-600 dark:text-red-400">{load.message}</p>;
  if (!load.diff.trim()) return <p className="text-xs text-muted-foreground">{t('pullRequests.dialog.diffEmpty')}</p>;
  const lines = load.diff.split('\n');
  const cut = load.truncated || lines.length > DIFF_LINES_SHOWN;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* The dialog is a grid: without min-w-0 up the chain, the longest diff
          line widens the dialog instead of scrolling inside it. */}
      {/* code-font: a diff */}
      <pre data-pull-diff="" className="scrollbar-thin max-h-[55vh] w-full overflow-auto rounded-lg bg-muted/40 py-1.5 font-mono text-[11px] leading-[1.5]">
        {/* w-max + min-w-full: a line's colour spans the scrolled width, not only the visible one. */}
        <div className="w-max min-w-full">
          {lines.slice(0, DIFF_LINES_SHOWN).map((line, i) => (
            <div key={i} className={cn('whitespace-pre px-2', DIFF_LINE_CLASS[diffLineKind(line)])}>{line || ' '}</div>
          ))}
        </div>
      </pre>
      {cut && <p className="text-[11px] text-muted-foreground">{t('pullRequests.dialog.diffCut')}</p>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-6">
      <GitPullRequest className="size-4 text-muted-foreground/60" aria-hidden />
      <span className="text-center text-[12.5px] text-muted-foreground">{text}</span>
    </div>
  );
}

const VERDICT_TONE: Record<string, string> = {
  mergeable: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  changes_requested: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  reject: 'bg-red-500/15 text-red-700 dark:text-red-300',
  product_decision: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  none: 'bg-muted text-muted-foreground',
};

function VerdictChip({ badge }: { badge: ReviewBadge }) {
  const label = badge.kind === 'running'
    ? t('pullRequests.reviewing')
    : badge.kind === 'failed'
      ? t('pullRequests.verdict.failed')
      : t(`pullRequests.verdict.${badge.verdict ?? 'none'}`);
  const tone = badge.kind === 'verdict' ? VERDICT_TONE[badge.verdict ?? 'none'] : VERDICT_TONE.none;
  const outdated = badge.kind === 'verdict' && badge.outdated;
  return (
    <span
      title={outdated ? t('pullRequests.outdated') : undefined}
      data-pull-verdict={badge.kind === 'verdict' ? badge.verdict ?? 'none' : badge.kind}
      className={cn('inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10.5px] font-medium', tone, outdated && 'opacity-60')}
    >
      {label}{outdated ? ' *' : ''}
    </span>
  );
}

const BRANCH_CHIP_TONE = {
  conflict: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  behind: 'bg-foreground/[0.06] text-muted-foreground',
} as const;

/** The way from a pull request to its job and its ideas, after its gestures in a "…" menu. */
function PullLinkItems({ pull, onOpenJob, onOpenTodo }: {
  pull: PullRequestItem;
  onOpenJob: (id: string) => void;
  onOpenTodo: (id: number) => void;
}) {
  const jobId = pull.links?.job_id ?? null;
  return (
    <>
      {jobId && (
        <Dropdown.Item data-menu-job={jobId} onSelect={() => onOpenJob(jobId)} className={PULL_MENU_ITEM}>
          <Eye className="size-3.5" />{t('pullRequests.showJob')}
        </Dropdown.Item>
      )}
      <JobLinksMenuItems links={pull.links} onOpenTodo={onOpenTodo} itemClassName={PULL_MENU_ITEM} />
    </>
  );
}

/** The entries of a row's "…" menu: its gestures in the window's order, then its links. */
function PullMenuItems({ pull, actions, onRun, onOpenJob, onOpenTodo }: {
  pull: PullRequestItem;
  actions: Parameters<typeof PullActionMenuItems>[0]['actions'];
  onRun: (id: PullActionId) => void;
  onOpenJob: (id: string) => void;
  onOpenTodo: (id: number) => void;
}) {
  return (
    <>
      <PullActionMenuItems actions={actions} onRun={onRun} />
      <PullLinkItems pull={pull} onOpenJob={onOpenJob} onOpenTodo={onOpenTodo} />
    </>
  );
}

/** A click inside the row's buttons or menu (portalled, but its events still
 *  bubble through React) must not open the window too. */
const keepInside = (e: { stopPropagation: () => void }) => { e.stopPropagation(); };

function PullRow({
  pull, preparing, proposals, branchBusy, onOpen, onReview, onOpenProposal, menu,
}: {
  pull: PullRequestItem;
  preparing: boolean;
  branchBusy: boolean;
  proposals: readonly ForgeProposal[];
  onOpen: () => void;
  onReview: () => void;
  onOpenProposal: (proposal: ForgeProposal) => void;
  menu: ReactNode;
}) {
  const chip = branchChip(pull);
  const lock = branchLock(pull);
  const badge = reviewBadge(pull);
  const running = badge?.kind === 'running';
  const meta = [`#${pull.number}`, pull.author ?? t('pullRequests.deletedAuthor')];
  if (pull.isDraft) meta.push(t('pullRequests.draft'));
  return (
    <li data-pull-row={pull.number} className="group/pull flex items-center gap-1 rounded-lg bg-muted/30 py-2 pl-2.5 pr-1 transition-colors hover:bg-muted/50 has-[[data-pull-open]:focus-visible]:bg-muted/50">
      <div
        role="button"
        tabIndex={0}
        data-pull-open=""
        aria-label={t('pullRequests.openDetail', { number: pull.number, title: pull.title })}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
        }}
        className="min-w-0 flex-1 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <div className="line-clamp-2 break-words text-[12.5px] font-medium leading-snug text-foreground group-hover/pull:underline group-hover/pull:decoration-foreground/30 group-hover/pull:underline-offset-2" title={pull.title}>{pull.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
          <span className="truncate tabular-nums">{meta.join(' · ')}</span>
          {chip && (
            <span data-pull-branch={chip} className={cn('inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10.5px] font-medium', BRANCH_CHIP_TONE[chip])}>
              {t(`pullRequests.branch.${chip}`)}
            </span>
          )}
          {lock && (
            <span data-pull-locked={lock} title={t(`pullRequests.lockedHint.${lock}`)} className="inline-flex max-w-full items-center rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
              {t(`pullRequests.locked.${lock}`)}
            </span>
          )}
          {branchBusy && <Loader2 className="size-3 shrink-0 animate-spin" aria-label={t('pullRequests.branchPreparing')} />}
          {badge && <VerdictChip badge={badge} />}
          <span className="contents" onClick={keepInside} onKeyDown={keepInside}>
            <ProposalChip proposals={proposals} onOpen={onOpenProposal} />
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1" onClick={keepInside} onKeyDown={keepInside}>
        {/* Icon only: the row's width belongs to the pull request, not to its action. */}
        <WidgetButton
          data-pull-review=""
          onClick={onReview}
          disabled={running || preparing}
          title={preparing ? t('pullRequests.briefPreparing') : t('pullRequests.reviewBrief')}
          aria-label={preparing ? t('pullRequests.briefPreparing') : t('pullRequests.reviewBrief')}
          icon={preparing ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />}
        />
        <Dropdown.Root modal={false}>
          <Dropdown.Trigger asChild>
            <button type="button" data-pull-menu="" title={t('pullRequests.more')} aria-label={t('pullRequests.more')} className={widgetButtonClass({ iconOnly: true })}>
              <MoreHorizontal className="size-3.5" />
            </button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content sideOffset={6} align="end" className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2">
              <NativeViewCover />
              {menu}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
    </li>
  );
}
