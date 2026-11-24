'use client';

/**
 * The Publish tab of the Git widget: is the project published, and is work
 * waiting locally?
 *
 * A versioned project without a remote looks like nothing in particular until
 * one types `git remote -v`, hence the explicit state rather than a silence
 * read as "everything is pushed". Two corrective gestures, one click each:
 * create the remote (gh) when there is none, push when work is waiting. Any
 * other remote — SSH, GitLab, Gitea, a server of one's own — is added or
 * re-pointed from the remotes dialog.
 *
 * Three counts used to read as "0 to push" when they meant something else
 * (bugs #22-#24): a comparison ref that does not resolve (`ahead: null`) is
 * now "unknown", a detached HEAD says so and asks for a branch, and a branch
 * never pushed is "not published" whatever its gap to the default branch.
 *
 * Every push is confirmed first, naming the repository (when the project
 * holds several), the remote, its short url, the branch and the count — a
 * push cannot be taken back once the history is somewhere else. A repository
 * with several remotes gets a destination picker beside Push: the branch's
 * own remote by default, any other one under a stronger warning.
 */

import { useCallback, useEffect, useState } from 'react';
import { CloudDownload, CloudUpload, GitBranch, Link2, Settings2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { GitRemoteCreateDialog, type CreateRemoteOptions } from '@/components/git-remote-create-dialog';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { useAccess } from '@/hooks/use-me';
import { gitRepoId, invalidateGit, setGitRemote, type GitRemote } from '@/lib/git-store';
import { t } from '@/lib/i18n';
import { responseErrorText } from '@/lib/permission-refusal';
import { cn } from '@/lib/utils';
import { agoLabel } from './git-format';
import { defaultPushRemote, publishTone, publishView, pushConfirmation, remotePending } from './git-publish-view';
import { GitRemotesDialog } from './git-remotes-dialog';

/** The repository as one reads it, `owner/name`, not the whole url. */
function shortRepo(url: string): string {
  const m = /([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return m ? m[1]! : url;
}

/** The remote shown is the one the branch tracks, not `origin`: on a
 *  repository with two remotes, which one must read without a terminal. */
function remoteLabel(g: GitRemote): string {
  const repo = g.remote ? shortRepo(g.remote) : '';
  const named = g.remote_name && (g.remote_count > 1 || g.remote_name !== 'origin');
  return named ? `${g.remote_name} · ${repo}` : repo;
}

/** What a remote of the picker lacks of the branch to push. */
function pendingLabel(p: ReturnType<typeof remotePending>): string {
  if (!p || (p.published && p.ahead === null)) return t('gitWidget.publish.unknown');
  if (!p.published) return t('gitWidget.publish.remoteAbsent');
  return p.ahead === 0 ? t('gitWidget.publish.upToDate') : t('gitWidget.publish.remotePending', { count: p.ahead ?? 0 });
}


/** `repo`: the nested repository shown, relative to the project; null = the root.
 *  `repoName`: its name when the project holds several, said before a push. */
export function GitPublish({ g, repo = null, repoName = null }: {
  g: GitRemote;
  repo?: string | null;
  repoName?: string | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Create, add, push and fetch are `projects:manage` (TODO #525): an account
  // without it sees why instead of a button that can only answer 403.
  const manage = useAccess('projects:manage');
  const [createOpen, setCreateOpen] = useState(false);
  const [remotesOpen, setRemotesOpen] = useState(false);
  // Branch targeted by the next push, distinct from `g.branch` (the current
  // one): never a checkout from here, a listed branch may be in use by an
  // agent's worktree.
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  // Remote picked for the next push; null = the branch's own remote, which is
  // what the daemon reaches when the request names none.
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);

  // Falls back on the current branch when the choice disappears (branch
  // deleted after a merge) or on the first read — never on a read that
  // changes nothing to the list, which would overwrite a valid choice.
  useEffect(() => {
    setSelectedBranch((prev) => (prev && g.branches.some((b) => b.name === prev) ? prev : g.branch));
  }, [g]);

  const act = useCallback(
    async (action: 'create-remote' | 'push' | 'fetch', body: unknown = {}) => {
      setBusy(action);
      setErr(null);
      let ok = false;
      try {
        const q = repo ? `?repo=${encodeURIComponent(repo)}` : '';
        const r = await fetch(`/api/ui/git-remote/${encodeURIComponent(g.slug)}/${action}${q}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = (await r.json()) as { git?: GitRemote; error?: string };
        if (r.ok && j.git) { setGitRemote(gitRepoId(g.slug, repo), j.git); ok = true; }
        else if (!r.ok || j.error) setErr(responseErrorText(j, t('apiErrors.http_status', { status: r.status })));
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(null);
        // A push or a fetch moves ahead/behind in the branches and the
        // composer too, not only here.
        invalidateGit();
      }
      return ok;
    },
    [g.slug, repo],
  );

  // The dialog closes ONLY on success: "name already taken" is the common
  // failure, and closing would make the user type the description again.
  const submitCreate = useCallback(
    async (opts: CreateRemoteOptions) => {
      const ok = await act('create-remote', opts);
      if (ok) setCreateOpen(false);
    },
    [act],
  );

  const view = publishView(g, selectedBranch);
  const { published, detached, ahead, behind, branchPublished, compareRef } = view;
  const target = selectedBranch ?? g.branch;
  const onOther = !!selectedBranch && selectedBranch !== g.branch;
  const warn = publishTone(view) !== 'green';

  const countText = !branchPublished && !detached
    ? (ahead ? t('gitWidget.publish.notPublishedCount', { count: ahead }) : t('gitWidget.publish.notPublished'))
    : ahead === null
      ? t('gitWidget.publish.unknown')
      : ahead === 0
        ? t('gitWidget.publish.upToDate')
        : t('gitWidget.publish.commits', { count: ahead });
  const countTitle = ahead === null
    ? t('gitWidget.publish.unknownTitle')
    : !compareRef
      ? t('gitWidget.publish.nothingPublished')
      : branchPublished
        ? t('gitWidget.publish.comparedTo', { ref: compareRef })
        : t('gitWidget.publish.neverPushedVs', { ref: compareRef });

  const [beforeCmd, afterCmd] = t('gitWidget.publish.notVersioned').split('{cmd}');
  // A branch never pushed stays pushable at zero gap with the default branch:
  // what the remote lacks is the branch itself.
  const remotes = g.remotes ?? [];
  const defaultRemote = defaultPushRemote(g, target);
  // A remote removed meanwhile falls back on the default, never on a stale name.
  const pushRemote = selectedRemote && remotes.some((r) => r.name === selectedRemote) ? selectedRemote : defaultRemote;
  const elsewhere = !!pushRemote && pushRemote !== defaultRemote;
  const there = elsewhere ? remotePending(g, pushRemote, target) : null;
  const canPush = manage.allowed && !!target && busy === null && (elsewhere
    ? !(there?.published && there.ahead === 0)
    : ahead === null || ahead > 0 || !branchPublished);

  const push = async () => {
    if (!target) return;
    // The url of the destination, as the picker reads it; a single remote is
    // only known through `g.remote`, the url of the branch's own.
    const name = pushRemote ?? g.remote_name ?? t('gitWidget.publish.remote');
    const url = remotes.find((r) => r.name === name)?.url ?? (elsewhere ? null : g.remote);
    const yes = await confirmAction(pushConfirmation({
      repo: repoName,
      branch: target,
      remote: name,
      url: url ? shortRepo(url) : name,
      upstream: !elsewhere,
      published: elsewhere ? there?.published ?? true : branchPublished,
      ahead: elsewhere ? there?.ahead ?? null : ahead,
    }));
    if (!yes) return;
    await act('push', elsewhere ? { branch: target, remote: pushRemote } : { branch: target });
  };

  return (
    <div className="p-3">
      {/* `minmax(0, 1fr)`: a plain `1fr` grows to its longest value (a branch
          and its "no upstream" tag), past a 300 px card. */}
      <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-y-1.5 text-[12px]">
        <span className="text-muted-foreground">{t('gitWidget.publish.remote')}</span>
        {g.remote ? (
          g.remote_web ? (
            <a
              href={g.remote_web}
              target="_blank"
              rel="noreferrer"
              className="truncate text-primary hover:underline"
              title={g.remote}
            >
              {remoteLabel(g)}
            </a>
          ) : (
            <span className="truncate" title={g.remote}>{remoteLabel(g)}</span>
          )
        ) : (
          <span className="text-red-400">
            {g.state === 'not-a-repo' ? t('gitWidget.publish.notRepo') : t('gitWidget.publish.none')}
          </span>
        )}

        {(g.branch || detached) && (
          <>
            <span className="text-muted-foreground">{t('gitWidget.publish.branch')}</span>
            {g.branches.length > 1 || (detached && g.branches.length > 0) ? (
              <Select
                value={selectedBranch ?? ''}
                onValueChange={setSelectedBranch}
                disabled={busy !== null}
              >
                <SelectTrigger title={selectedBranch ?? undefined} className="h-6 min-w-0 gap-1 border-none bg-transparent px-0 text-[12px] shadow-none focus:ring-0 [&>span]:!block [&>span]:min-w-0 [&>span]:truncate [&>svg]:size-3">
                  <GitBranch className="size-3 shrink-0 text-muted-foreground/70" />
                  <SelectValue placeholder={t('gitWidget.detached')} />
                </SelectTrigger>
                <SelectContent>
                  {g.branches.map((b) => (
                    <SelectItem key={b.name} value={b.name} className="text-[12px]">
                      {b.name}
                      {!b.upstream && <span className="ml-1 text-[10px] text-amber-400">{t('gitWidget.publish.noUpstream')}</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch className="size-3 shrink-0 text-muted-foreground/70" />
                <span className={cn('truncate', detached && 'text-amber-400')}>{g.branch ?? t('gitWidget.detached')}</span>
                {published && !g.upstream && g.branch && (
                  <span className="shrink-0 text-[10px] text-amber-400">· {t('gitWidget.publish.noUpstream')}</span>
                )}
              </span>
            )}
          </>
        )}

        {published && (
          <>
            <span className="text-muted-foreground">
              {detached ? t('gitWidget.publish.ahead') : t('gitWidget.publish.toPush')}
            </span>
            <span className={cn('tabular-nums', warn && 'text-amber-400')} title={countTitle}>
              {countText}
            </span>
          </>
        )}

        {!!behind && (
          <>
            <span className="text-muted-foreground">{t('gitWidget.publish.behind')}</span>
            <span className="tabular-nums">{t('gitWidget.publish.commits', { count: behind })}</span>
          </>
        )}

        {!!g.dirty && (
          <>
            <span className="text-muted-foreground">{t('gitWidget.publish.dirty')}</span>
            <span className="tabular-nums text-muted-foreground/80">{t('gitWidget.publish.files', { count: g.dirty })}</span>
          </>
        )}

        {g.last_commit_at !== null && (
          <>
            <span className="text-muted-foreground">{t('gitWidget.publish.last')}</span>
            <span className="tabular-nums" suppressHydrationWarning>{agoLabel(g.last_commit_at, Date.now())}</span>
          </>
        )}
      </div>

      {g.state === 'not-a-repo' && (
        <p className="mt-2 text-[11.5px] text-muted-foreground/70">
          {beforeCmd}
          {/* code-font: a command to type */}
          <code className="font-mono">git init</code>
          {afterCmd}
        </p>
      )}

      {g.state === 'no-remote' && (
        <p className="mt-2 text-[11.5px] text-muted-foreground/70">
          {g.has_commits ? t('gitWidget.publish.noRemote') : t('gitWidget.publish.noRemoteNoCommit')}
        </p>
      )}

      {published && detached && !onOther && (
        <p className="mt-2 text-[11.5px] text-muted-foreground/70">{t('gitWidget.publish.detachedHint')}</p>
      )}

      {published && !detached && !view.upstream && (
        <p className="mt-2 text-[11.5px] text-muted-foreground/70">{t('gitWidget.publish.neverPushed')}</p>
      )}

      {manage.denied && (g.state === 'no-remote' || published) && (
        <p className="mt-2 text-[11.5px] text-muted-foreground/70">{manage.denied}</p>
      )}

      {err && <p className="mt-2 break-words text-[11.5px] text-red-400">{err}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {g.state === 'no-remote' && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={busy !== null || !manage.allowed || !g.has_commits || !g.gh_available}
              title={
                manage.denied
                  ? manage.denied
                  : !g.gh_available
                    ? t('gitWidget.publish.ghMissing')
                    : !g.has_commits
                      ? t('gitWidget.publish.noCommit')
                      : `gh repo create ${g.default_repo_name ?? ''} + push`
              }
              onClick={() => { setErr(null); setCreateOpen(true); }}
            >
              <CloudUpload className="size-3" />
              {t('gitWidget.publish.createRemote')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={busy !== null || !manage.allowed}
              title={manage.denied ?? t('gitWidget.publish.addRemoteTitle')}
              onClick={() => setRemotesOpen(true)}
            >
              <Link2 className="size-3" />
              {t('gitWidget.publish.addRemote')}
            </Button>
          </>
        )}
        {published ? (
          <>
            {remotes.length > 1 && (
              <Select
                value={pushRemote ?? ''}
                onValueChange={(v) => setSelectedRemote(v === defaultRemote ? null : v)}
                disabled={busy !== null || !target}
              >
                <SelectTrigger
                  className="h-7 w-auto max-w-[160px] gap-1 px-2 text-[11px] [&>svg]:size-3"
                  aria-label={t('gitWidget.publish.destination')}
                  title={t('gitWidget.publish.destination')}
                >
                  <SelectValue>{pushRemote}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {remotes.map((r) => (
                    <SelectItem key={r.name} value={r.name} className="text-[12px]">
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1">
                          <span>{r.name}</span>
                          {r.name === defaultRemote && (
                            <span className="text-[10px] text-muted-foreground">{t('gitWidget.publish.upstreamTag')}</span>
                          )}
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            · {pendingLabel(remotePending(g, r.name, target))}
                          </span>
                        </span>
                        {r.url && <span className="truncate text-[10.5px] text-muted-foreground/70">{shortRepo(r.url)}</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 min-w-0 max-w-full gap-1 px-2 text-[11px] tabular-nums"
              disabled={!canPush}
              title={manage.denied ?? undefined}
              onClick={() => { void push(); }}
            >
              <Upload className="size-3 shrink-0" />
              <span className="truncate">{busy === 'push'
                ? t('gitWidget.publish.pushing')
                : elsewhere
                  ? there?.published && there.ahead === 0
                    ? t('gitWidget.publish.upToDate')
                    : [
                        t('gitWidget.publish.pushTo', { remote: pushRemote ?? '' }),
                        onOther ? selectedBranch : null,
                        there?.ahead ? `(${there.ahead})` : null,
                      ].filter(Boolean).join(' ')
                : target && ahead === 0 && branchPublished
                  ? t('gitWidget.publish.upToDate')
                  : [
                      t(branchPublished || !target ? 'gitWidget.publish.push' : 'gitWidget.publish.publishBranch'),
                      onOther ? selectedBranch : null,
                      ahead ? `(${ahead})` : null,
                    ].filter(Boolean).join(' ')}</span>
            </Button>
            {/* Secondary gestures in icons, named by their tooltip: with their
                labels the row ran past a 300 px card. */}
            <Button
              variant="ghost"
              size="sm"
              className="size-7 shrink-0 p-0"
              disabled={busy !== null || !manage.allowed}
              title={manage.denied ?? t('gitWidget.publish.fetchTitle')}
              aria-label={t('gitWidget.publish.fetch')}
              onClick={() => act('fetch')}
            >
              <CloudDownload className={cn('size-3.5', busy === 'fetch' && 'animate-pulse')} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-7 shrink-0 p-0"
              disabled={busy !== null}
              title={t('gitWidget.publish.remotesTitle')}
              aria-label={t('gitWidget.publish.remotes')}
              onClick={() => setRemotesOpen(true)}
            >
              <Settings2 className="size-3.5" />
            </Button>
          </>
        ) : null}
      </div>

      <GitRemoteCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultName={g.default_repo_name ?? g.slug}
        branch={g.branch}
        commits={g.ahead}
        ghAccount={g.gh_account}
        busy={busy === 'create-remote'}
        error={err}
        onSubmit={submitCreate}
      />
      <GitRemotesDialog
        open={remotesOpen}
        onOpenChange={setRemotesOpen}
        slug={g.slug}
        repo={repo}
        publication={g.remote_name}
      />
    </div>
  );
}
