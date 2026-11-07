'use client';

/**
 * The Git widget of `@timon/git` (TODO #278, volet 3): the project's branch
 * and publication state in a header, then three tabs — Branches (working
 * tree, checkout), Graph (commit history) and Publish (remote, push, fetch).
 *
 * It replaces two cards that answered halves of one question side by side.
 * Every read goes through the shared Git store (`lib/git-store.ts`): the
 * composer's branch and this widget move together, and the history is only
 * read while the Graph tab is shown. The Publish tab follows the
 * `chat.panel.git-remote` zone, as its card did: the `lite` preset hides it
 * and keeps the branches.
 *
 * A project folder may hold several repositories (TODO #923): a picker in the
 * toolbar, shown only then, switches every read of the widget to one of them,
 * and a dot beside it flags another repository with commits to push.
 */

import { useEffect, useState } from 'react';
import { GitBranch, GitCommitHorizontal, CloudUpload, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { isZoneVisible, useCapabilities } from '@/lib/capabilities';
import { gitRepoId, invalidateGit, useGit, type GitRemote } from '@/lib/git-store';
import { WIDGET_SELECT, WIDGET_TOOLBAR, WidgetButton, widgetSegmentClass } from '@/components/widget-toolbar';
import { GitBranches } from './git-branches';
import { GitGraphView } from './git-graph-view';
import { GitPublish } from './git-remote-panel';
import { publishTone, publishView, TONE_DOT } from './git-publish-view';

type Tab = 'branches' | 'graph' | 'publish';

const TABS: { id: Tab; icon: typeof GitBranch }[] = [
  { id: 'branches', icon: GitBranch },
  { id: 'graph', icon: GitCommitHorizontal },
  { id: 'publish', icon: CloudUpload },
];

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
function PendingRepoMark({ slug, repo, name, onPick }: {
  slug: string;
  repo: string;
  name: string;
  onPick: (repo: string) => void;
}) {
  const count = toPush(useGit('remote', gitRepoId(slug, repo)).data);
  if (count === null) return null;
  const label = t('gitWidget.repos.otherToPush', { name, count });
  return (
    <button
      type="button"
      onClick={() => onPick(repo)}
      title={label}
      aria-label={label}
      className="flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-muted"
    >
      <span className="size-1.5 rounded-full bg-amber-400" aria-hidden />
    </button>
  );
}

export function GitPanel({ agentId, slug }: { agentId: string; slug: string | null }) {
  const caps = useCapabilities();
  const publishOn = isZoneVisible(caps, 'chat.panel.git-remote');
  const [chosen, setChosen] = useState<Tab>('branches');
  const tab: Tab = chosen === 'publish' && !publishOn ? 'branches' : chosen;

  const repos = useGit('repos', slug).data ?? [];
  // `''` is the project root, the default.
  const [pickedRepo, setPickedRepo] = useState('');
  useEffect(() => { setPickedRepo(''); }, [slug]);
  // A repository that vanished from the list (folder removed) falls back on the root.
  const repo = pickedRepo && repos.some((r) => r.path === pickedRepo) ? pickedRepo : '';
  const repoId = slug ? gitRepoId(slug, repo) : null;

  const dash = useGit('dashboard', repoId);
  const remote = useGit('remote', publishOn ? repoId : null).data;
  const loading = dash.loading;

  if (!slug) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        {t('gitWidget.noProject')}
      </div>
    );
  }

  const data = dash.data;
  const changes = data ? data.staged.length + data.unstaged.length + data.untracked.length : 0;
  const branch = data?.currentBranch ?? remote?.branch ?? null;
  const detached = !!data?.ok && !data.currentBranch;
  const showRemote = !!remote && remote.state !== 'no-cwd' && remote.state !== 'not-a-repo';
  const error = dash.error ?? (data && !data.ok ? data.error ?? null : null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={WIDGET_TOOLBAR}>
        <div className="flex min-w-0 flex-1 items-center gap-0.5" role="tablist" aria-label="Git">
          {TABS.filter((x) => x.id !== 'publish' || publishOn).map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setChosen(id)}
              className={widgetSegmentClass(tab === id)}
            >
              <Icon className="size-3" />
              {t(`gitWidget.tabs.${id}`)}
            </button>
          ))}
        </div>
        {repos.length > 1 && (
          <>
            {publishOn && repos.filter((r) => r.path !== repo).map((r) => (
              <PendingRepoMark key={r.path} slug={slug} repo={r.path} name={r.name} onPick={setPickedRepo} />
            ))}
            <select
              value={repo}
              onChange={(e) => setPickedRepo(e.target.value)}
              className={cn(WIDGET_SELECT, 'max-w-[9rem] shrink truncate')}
              title={t('gitWidget.repos.label')}
              aria-label={t('gitWidget.repos.label')}
            >
              {repos.map((r) => (
                <option key={r.path} value={r.path}>{r.path ? r.name : t('gitWidget.repos.root', { name: r.name })}</option>
              ))}
            </select>
          </>
        )}
        <WidgetButton
          onClick={invalidateGit}
          disabled={loading}
          title={t('chatPage.refresh')}
          aria-label={t('chatPage.refresh')}
          icon={<RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />}
        />
      </div>

      <div className="flex min-w-0 items-center gap-1.5 px-3 pb-1.5 text-[11px]">
        <GitBranch className={cn('size-3.5 shrink-0', detached ? 'text-amber-400' : 'text-primary')} />
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
      </div>

      <div className={cn('flex min-h-0 flex-1 flex-col', tab !== 'graph' && 'overflow-y-auto')} role="tabpanel">
        {error && tab !== 'publish' && (
          // A project with no folder, or a folder that is no repository, is a
          // state to explain, not a failure: it gets a quiet note, and only
          // real errors keep the red.
          <div className={cn('m-2 rounded-md px-2 py-1.5 text-[11.5px]', remote?.state === 'no-cwd' || remote?.state === 'not-a-repo' ? 'bg-foreground/[0.04] text-muted-foreground' : 'bg-destructive/10 text-destructive')}>{error}</div>
        )}
        {tab === 'branches' && data?.ok && (
          <GitBranches slug={slug} repo={repo || null} agentId={agentId} data={data} remote={remote ?? null} />
        )}
        {tab === 'graph' && !error && repoId && <GitGraphView repoId={repoId} />}
        {tab === 'publish' && remote && remote.state !== 'no-cwd' && (
          <GitPublish g={remote} repo={repo || null} repoName={repos.length > 1 ? repos.find((r) => r.path === repo)?.name ?? null : null} />
        )}
      </div>
    </div>
  );
}
