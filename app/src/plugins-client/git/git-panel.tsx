'use client';

/**
 * The three widgets of `@timon/git`: Branches (working tree, checkout), Graph
 * (commit history) and Publish (remote, push, fetch).
 *
 * They were the three hard-coded tabs of one card (TODO #278); each is now a
 * widget of its own, stacked by default in the chat's "Git" stack
 * (`widget-defaults.ts`) and movable or removable like any other. Branches and
 * Publish open on one compact line: the current branch, its uncommitted
 * changes and where its publication stands. Publish follows the
 * `chat.panel.git-remote` zone: the `lite` preset hides it and keeps the rest.
 *
 * Every read goes through the shared Git store (`lib/git-store.ts`): the
 * composer's branch and these widgets move together, and the history is only
 * read while the Graph is on screen.
 *
 * A project folder may hold several repositories (TODO #923): a picker, shown
 * only then, switches the three widgets at once to one of them, and a dot
 * beside it flags another repository with commits to push.
 */

import { useSyncExternalStore } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { apiErrorMessageOrNull } from '@/lib/api-error';
import { t } from '@/lib/i18n';
import { isZoneVisible, useCapabilities } from '@/lib/capabilities';
import { gitRepoId, invalidateGit, useGit, type GitRemote, type GitRepo } from '@/lib/git-store';
import { WIDGET_SELECT, WidgetButton } from '@/components/widget-toolbar';
import { GitBranches } from './git-branches';
import { GitGraphView } from './git-graph-view';
import { GitPublish } from './git-remote-panel';
import { publishTone, publishView, TONE_DOT } from './git-publish-view';

type GitWidgetProps = { agentId: string; slug: string | null };

/** The repository picked per project, shared by the three widgets: picking
 *  one in Branches shows the same one in Graph and Publish. `''` = the root. */
const pickedRepos = new Map<string, string>();
const pickListeners = new Set<() => void>();

function pickRepo(slug: string, repo: string): void {
  pickedRepos.set(slug, repo);
  for (const listener of pickListeners) listener();
}

function subscribePicks(listener: () => void): () => void {
  pickListeners.add(listener);
  return () => { pickListeners.delete(listener); };
}

/** The project's repositories and the one shown; a repository that vanished
 *  from the list (folder removed) falls back on the root. */
function useRepoChoice(slug: string | null): { repos: GitRepo[]; repo: string; repoId: string | null } {
  const repos = useGit('repos', slug).data ?? [];
  const picked = useSyncExternalStore(subscribePicks, () => (slug ? pickedRepos.get(slug) ?? '' : ''), () => '');
  const repo = picked && repos.some((r) => r.path === picked) ? picked : '';
  return { repos, repo, repoId: slug ? gitRepoId(slug, repo) : null };
}

/** The header's word on publication, beside its dot. */
function publishSummary(g: GitRemote): string {
  if (g.state === 'no-remote') return t('gitWidget.status.noRemote');
  const v = publishView(g, g.branch);
  if (v.detached || v.ahead === null) return t('gitWidget.status.unknown');
  if (!v.branchPublished) return t('gitWidget.status.unpublished');
  if (v.ahead > 0) return t('gitWidget.status.toPush', { count: v.ahead });
  return t('gitWidget.status.synced');
}

/** Commits waiting on the current branch, as the header counts them; null
 *  when unknown or nothing waits. */
function toPush(g: GitRemote | null): number | null {
  if (!g || g.state === 'no-remote' || g.state === 'no-cwd' || g.state === 'not-a-repo') return null;
  const v = publishView(g, g.branch);
  return !v.detached && v.ahead !== null && v.ahead > 0 ? v.ahead : null;
}

/** A dot for another repository of the project with commits to push; a click
 *  shows that repository. Nothing at all while there is nothing to push. */
function PendingRepoMark({ slug, repo, name }: { slug: string; repo: string; name: string }) {
  const count = toPush(useGit('remote', gitRepoId(slug, repo)).data);
  if (count === null) return null;
  const label = t('gitWidget.repos.otherToPush', { name, count });
  return (
    <button
      type="button"
      onClick={() => pickRepo(slug, repo)}
      title={label}
      aria-label={label}
      className="flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-muted"
    >
      <span className="size-1.5 rounded-full bg-amber-400" aria-hidden />
    </button>
  );
}

/** The repository picker, only when the project holds several. */
function RepoPicker({ slug, repos, repo, marks }: { slug: string; repos: GitRepo[]; repo: string; marks: boolean }) {
  if (repos.length < 2) return null;
  return (
    <div className="flex min-w-0 items-center gap-1 px-3 pt-1.5">
      {marks && repos.filter((r) => r.path !== repo).map((r) => (
        <PendingRepoMark key={r.path} slug={slug} repo={r.path} name={r.name} />
      ))}
      <select
        value={repo}
        onChange={(e) => pickRepo(slug, e.target.value)}
        className={cn(WIDGET_SELECT, 'min-w-0 flex-1 truncate')}
        title={t('gitWidget.repos.label')}
        aria-label={t('gitWidget.repos.label')}
      >
        {repos.map((r) => (
          <option key={r.path} value={r.path}>{r.path ? r.name : t('gitWidget.repos.root', { name: r.name })}</option>
        ))}
      </select>
    </div>
  );
}

function NoProject() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
      {t('gitWidget.noProject')}
    </div>
  );
}

/** A project with no folder, or a folder that is no repository, is a state to
 *  explain, not a failure: it gets a quiet note, and only real errors keep
 *  the red. */
function ReadError({ error, remote }: { error: string; remote: GitRemote | null | undefined }) {
  const quiet = remote?.state === 'no-cwd' || remote?.state === 'not-a-repo';
  return (
    <div className={cn('m-2 rounded-md px-2 py-1.5 text-[11.5px]', quiet ? 'bg-foreground/[0.04] text-muted-foreground' : 'bg-destructive/10 text-destructive')}>{error}</div>
  );
}

/**
 * The compact line Branches and Publish open on: the current branch, its
 * uncommitted changes, where its publication stands, and a refresh.
 */
function HeadLine({ repoId, remote, publishOn }: { repoId: string | null; remote: GitRemote | null | undefined; publishOn: boolean }) {
  const dash = useGit('dashboard', repoId);
  const data = dash.data;
  const loading = dash.loading;
  const changes = data ? data.staged.length + data.unstaged.length + data.untracked.length : 0;
  const branch = data?.currentBranch ?? remote?.branch ?? null;
  const detached = !!data?.ok && !data.currentBranch;
  const showRemote = publishOn && !!remote && remote.state !== 'no-cwd' && remote.state !== 'not-a-repo';
  return (
    <div data-git-head="" className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 pl-3 pr-1.5 text-[11px]">
      <GitBranch className={cn('size-3.5 shrink-0', detached ? 'text-amber-400' : 'text-primary')} aria-hidden />
      <span className={cn('min-w-0 truncate font-semibold', detached ? 'text-amber-400' : 'text-foreground')}>
        {detached ? t('gitWidget.detached') : branch ?? (loading ? '…' : '—')}
      </span>
      {changes > 0 && (
        <span
          className="shrink-0 rounded-full bg-amber-500/25 px-1.5 text-[10px] font-bold tabular-nums text-amber-400"
          title={t('gitWidget.status.changes', { count: changes })}
        >
          {changes}
        </span>
      )}
      {showRemote && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums">
          <span className={cn('size-1.5 rounded-full', TONE_DOT[publishTone(publishView(remote, remote.branch))])} aria-hidden />
          {publishSummary(remote)}
        </span>
      )}
      <WidgetButton
        onClick={invalidateGit}
        disabled={loading}
        className={showRemote ? undefined : 'ml-auto'}
        title={t('chatPage.refresh')}
        aria-label={t('chatPage.refresh')}
        icon={<RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />}
      />
    </div>
  );
}

/** The repository's working tree and branches, with a checkout on click. */
export function GitBranchesPanel({ agentId, slug }: GitWidgetProps) {
  const publishOn = isZoneVisible(useCapabilities(), 'chat.panel.git-remote');
  const { repos, repo, repoId } = useRepoChoice(slug);
  const dash = useGit('dashboard', repoId);
  const remote = useGit('remote', publishOn ? repoId : null).data;
  if (!slug) return <NoProject />;
  const data = dash.data;
  const error = dash.error ?? (data && !data.ok ? apiErrorMessageOrNull(data) : null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RepoPicker slug={slug} repos={repos} repo={repo} marks={publishOn} />
      <HeadLine repoId={repoId} remote={remote} publishOn={publishOn} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && <ReadError error={error} remote={remote} />}
        {data?.ok && <GitBranches slug={slug} repo={repo || null} agentId={agentId} data={data} remote={remote ?? null} />}
      </div>
    </div>
  );
}

/** The repository's commit history, read only while it is on screen. */
export function GitGraphPanel({ slug }: GitWidgetProps) {
  const publishOn = isZoneVisible(useCapabilities(), 'chat.panel.git-remote');
  const { repos, repo, repoId } = useRepoChoice(slug);
  const dash = useGit('dashboard', repoId);
  if (!slug) return <NoProject />;
  const data = dash.data;
  const error = dash.error ?? (data && !data.ok ? apiErrorMessageOrNull(data) : null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RepoPicker slug={slug} repos={repos} repo={repo} marks={publishOn} />
      {error ? <ReadError error={error} remote={null} /> : repoId && <GitGraphView repoId={repoId} />}
    </div>
  );
}

/** The repository's remote: what waits to be pushed, push and fetch. */
export function GitPublishPanel({ slug }: GitWidgetProps) {
  const { repos, repo, repoId } = useRepoChoice(slug);
  const remote = useGit('remote', repoId).data;
  if (!slug) return <NoProject />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RepoPicker slug={slug} repos={repos} repo={repo} marks />
      <HeadLine repoId={repoId} remote={remote} publishOn />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {remote && remote.state !== 'no-cwd' && (
          <GitPublish g={remote} repo={repo || null} repoName={repos.length > 1 ? repos.find((r) => r.path === repo)?.name ?? null : null} />
        )}
      </div>
    </div>
  );
}
