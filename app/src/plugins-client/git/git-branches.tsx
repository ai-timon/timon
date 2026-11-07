'use client';

/**
 * The Branches tab of the Git widget: the project checkout's working tree,
 * then its branches, with a checkout on click. A branch held by a worktree
 * cannot be switched to (git refuses it), and says so.
 */

import { useState } from 'react';
import { GitBranch, GitMerge } from 'lucide-react';
import { toast } from 'sonner';

import { useAccess } from '@/hooks/use-me';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { fileViewer } from '@/lib/file-viewer';
import type { GitDashboard, GitRemote } from '@/lib/git-store';
import type { FileBody } from '@/components/chat/chat-types';
import { checkoutBranch } from './git-checkout';

const SECTION_TITLE = 'mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60';

export function GitBranches({
  slug,
  repo,
  agentId,
  data,
  remote,
}: {
  slug: string;
  /** The nested repository shown, relative to the project; null = the root. */
  repo: string | null;
  agentId: string;
  data: GitDashboard;
  /** Publication state, when read: marks the branches that were never pushed. */
  remote: GitRemote | null;
}) {
  const [openingFile, setOpeningFile] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  // Switching the shared checkout is `projects:manage` (TODO #525).
  const manage = useAccess('projects:manage');
  const totalChanges = data.staged.length + data.unstaged.length + data.untracked.length;
  const unpublished = new Set(
    remote && remote.remote ? remote.branches.filter((b) => !b.published).map((b) => b.name) : [],
  );

  async function openFile(rel: string) {
    setOpeningFile(rel);
    try {
      // git names a file from its own repository; the agent reads from the
      // project folder, where a nested repository sits under `repo`.
      const path = repo ? `${repo}/${rel}` : rel;
      const r = await fetch(
        '/api/ui/agents/' + encodeURIComponent(agentId) +
        '/files?path=' + encodeURIComponent(path),
      );
      const j = await r.json();
      if (!r.ok || j.kind !== 'file') {
        toast.error(j.error || t('chatPage.cannotOpen', { path: rel }));
        return;
      }
      fileViewer.openText(agentId, j as FileBody);
    } catch (e) { toast.error(String(e)); }
    finally { setOpeningFile(null); }
  }

  async function checkout(branch: string) {
    setCheckingOut(branch);
    try { await checkoutBranch(slug, branch, totalChanges, repo); }
    finally { setCheckingOut(null); }
  }

  return (
    <div className="flex flex-col gap-3 px-2.5 py-2">
      <section>
        <div className={SECTION_TITLE}>{t('gitWidget.branches.workingTree')}</div>
        {totalChanges === 0 ? (
          <div className="text-[11px] text-muted-foreground/50">{t('chatPage.clean')}</div>
        ) : (
          <div className="flex flex-col gap-px">
            {data.staged.map((f) => (
              <GitFileRow key={'s:' + f} path={f} status="S" tone="text-emerald-400" dot="bg-emerald-400"
                loading={openingFile === f} onClick={() => void openFile(f)} />
            ))}
            {data.unstaged.map((f) => (
              <GitFileRow key={'u:' + f} path={f} status="M" tone="text-amber-400" dot="bg-amber-400"
                loading={openingFile === f} onClick={() => void openFile(f)} />
            ))}
            {data.untracked.map((f) => (
              <GitFileRow key={'t:' + f} path={f} status="?" tone="text-zinc-400" dot="bg-zinc-500"
                loading={openingFile === f} onClick={() => void openFile(f)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className={SECTION_TITLE}>{t('gitWidget.branches.title')}</div>
        {manage.denied && <p className="mb-1 text-[10.5px] leading-snug text-muted-foreground">{manage.denied}</p>}
        <div className="flex flex-col gap-0.5">
          {data.branches.map((b) => {
            const canSwitch = manage.allowed && !b.current && !b.worktree;
            const isLoading = checkingOut === b.name;
            return (
              <button
                key={b.name}
                type="button"
                disabled={!canSwitch || !!checkingOut}
                onClick={() => canSwitch && void checkout(b.name)}
                title={b.worktree
                  ? t('chatPage.occupiedByWorktree')
                  : b.current
                    ? t('chatPage.currentBranch')
                    : manage.denied ?? t('gitWidget.branches.checkout', { branch: b.name })}
                className={cn(
                  'flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left',
                  b.current && 'bg-primary/10',
                  canSwitch && 'cursor-pointer hover:bg-muted/50',
                  !canSwitch && 'cursor-default',
                  isLoading && 'opacity-60',
                )}
              >
                <GitBranch
                  className={cn('mt-0.5 size-3 shrink-0', b.current ? 'text-primary' : 'text-muted-foreground/40')}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1">
                    <span
                      className={cn(
                        'truncate text-[11.5px]',
                        b.current ? 'font-semibold text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {b.name}
                    </span>
                    {b.worktree && (
                      <span className="shrink-0 rounded bg-sky-500/20 px-1 text-[9px] font-semibold text-sky-400">
                        {t('gitWidget.branches.worktree')}
                      </span>
                    )}
                    {unpublished.has(b.name) && (
                      <span
                        className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] font-semibold text-amber-400"
                        title={t('gitWidget.branches.localOnlyTitle')}
                      >
                        {t('gitWidget.branches.localOnly')}
                      </span>
                    )}
                  </div>
                  {(b.ahead > 0 || b.behind > 0) && (
                    <div className="text-[10px] font-medium tabular-nums">
                      {b.ahead > 0 && <span className="text-emerald-400">↑{b.ahead}</span>}
                      {b.ahead > 0 && b.behind > 0 && ' '}
                      {b.behind > 0 && <span className="text-rose-400">↓{b.behind}</span>}
                    </div>
                  )}
                  {b.lastCommitSubject && (
                    <div className="truncate text-[10px] text-muted-foreground/50">{b.lastCommitSubject}</div>
                  )}
                </div>
                {b.merged && !b.current && (
                  <GitMerge className="mt-0.5 size-3 shrink-0 text-muted-foreground/30" />
                )}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function GitFileRow({
  path,
  status,
  tone,
  dot,
  loading,
  onClick,
}: {
  path: string;
  status: string;
  tone: string;
  dot: string;
  loading: boolean;
  onClick: () => void;
}) {
  const name = path.split('/').pop() ?? path;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      title={path}
      className={cn(
        'group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left',
        'hover:bg-muted/50 disabled:opacity-60',
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', dot)} />
      <span className={cn('min-w-0 flex-1 truncate text-[11px]', tone)}>
        {dir && <span className="opacity-50">{dir}</span>}
        {name}
      </span>
      <span className={cn('shrink-0 text-[10px] font-bold', tone)}>{status}</span>
    </button>
  );
}
