'use client';

/**
 * The composer's Git bar (TODO #278, volet 4): branch · folder · lines added
 * and removed, and on click the picker of every branch and worktree of the
 * project, with a checkout from the list.
 *
 * Everything shown comes from the shared Git store: the bar reads the
 * agent's folder, the open picker the project checkout and its worktrees —
 * the same keys as the Git widget, so the two never disagree. The lists are
 * only read while the picker is open: the branch read walks every branch.
 */

import { useState } from 'react';
import { FolderGit2, GitBranch } from 'lucide-react';

import { useAccess } from '@/hooks/use-me';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { useGit, type AgentGitInfo } from '@/lib/git-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { checkoutBranch } from './git-checkout';
import { folderOf, pickerModel, type PickerBranch, type PickerWorktree } from './git-picker-model';

const SECTION_TITLE = 'px-1.5 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60';
const TAG = 'shrink-0 rounded px-1 text-[9px] font-semibold';

export function GitBranchPicker({
  slug,
  info,
  cwd,
  compact = false,
}: {
  /** The project whose checkout the picker switches; null = no picker. */
  slug: string | null;
  info: AgentGitInfo;
  cwd: string | null | undefined;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const dash = useGit('dashboard', open ? slug : null);
  const list = useGit('worktrees', open ? slug : null);
  const model = pickerModel(dash.data, list.data, info, cwd);

  const folder = folderOf(info, cwd);
  const added = info.added ?? 0;
  const removed = info.removed ?? 0;
  const title = [
    slug ? t('gitWidget.picker.title') : null,
    info.worktree && folder ? t('gitWidget.picker.worktreeOf', { name: folder }) : null,
    info.dirty ? t('gitWidget.picker.dirty') : t('gitWidget.picker.clean'),
    added || removed ? t('gitWidget.picker.diff', { added, removed }) : null,
  ].filter(Boolean).join('\n');

  const label = (
    <>
      <GitBranch className="size-3 shrink-0" />
      <span className={cn('min-w-0 truncate text-foreground', compact ? 'max-w-[9rem]' : 'max-w-[14rem]')}>
        {info.branch ?? t('gitWidget.detached')}
      </span>
      {folder && !compact && (
        <>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className="min-w-0 max-w-[8rem] truncate">{folder}</span>
        </>
      )}
      {info.dirty && <span className="shrink-0 text-[hsl(var(--warning))]" aria-hidden>●</span>}
      {(added > 0 || removed > 0) && (
        <span className="shrink-0 tabular-nums">
          <span className="text-emerald-400">+{added}</span>{' '}
          <span className="text-rose-400">−{removed}</span>
        </span>
      )}
    </>
  );

  if (!slug) {
    return <span className="inline-flex min-w-0 items-center gap-1" title={title}>{label}</span>;
  }

  async function switchTo(branch: string) {
    if (!slug) return;
    setSwitching(branch);
    try { await checkoutBranch(slug, branch, model.changes); }
    finally { setSwitching(null); }
  }

  return (
    // Non-modal, like the context gauge beside it (TIM-0035): a modal menu
    // and the confirmation it may open fight over the focus.
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={t('gitWidget.picker.title')}
          className={cn(
            'inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted/60',
            switching && 'opacity-60',
          )}
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-72 p-1">
        <div className={SECTION_TITLE}>{t('gitWidget.picker.branches')}</div>
        {model.inWorktree && (
          <p className="px-1.5 pb-1 text-[10.5px] leading-snug text-muted-foreground">
            {t('gitWidget.picker.inWorktree', { name: model.inWorktree })}
          </p>
        )}
        {model.inOtherRepo !== null && (
          <p className="px-1.5 pb-1 text-[10.5px] leading-snug text-muted-foreground">
            {model.inOtherRepo
              ? t('gitWidget.picker.otherRepo', { name: model.inOtherRepo })
              : t('gitWidget.picker.otherRepoUnnamed')}
          </p>
        )}
        <ManageNote />
        {dash.error && !model.branches && (
          <p className="px-1.5 py-1 text-[11px] text-destructive">{dash.error}</p>
        )}
        {!model.branches && !dash.error && (
          <p className="px-1.5 py-1 text-[11px] text-muted-foreground/60">{t('gitWidget.picker.loading')}</p>
        )}
        {model.branches?.map((b) => (
          <BranchRow key={b.name} b={b} busy={!!switching} onPick={() => void switchTo(b.name)} />
        ))}

        {model.worktrees && model.worktrees.length > 0 && (
          <div className="pt-2">
            <div className={SECTION_TITLE}>{t('gitWidget.picker.worktrees')}</div>
            {model.worktrees.map((w) => <WorktreeRow key={w.path} w={w} />)}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A checkout is `projects:manage` (TODO #525); the list stays readable. Read
 *  from inside the open menu only: the closed bar reads nothing. */
function ManageNote() {
  const manage = useAccess('projects:manage');
  if (!manage.denied) return null;
  return <p className="px-1.5 pb-1 text-[10.5px] leading-snug text-muted-foreground">{manage.denied}</p>;
}

function BranchRow({ b, busy, onPick }: { b: PickerBranch; busy: boolean; onPick: () => void }) {
  const manage = useAccess('projects:manage');
  return (
    <DropdownMenuItem
      disabled={!!b.blocked || busy || !manage.allowed}
      onSelect={onPick}
      title={b.blocked === 'worktree'
        ? t('chatPage.occupiedByWorktree')
        : b.blocked === 'current'
          ? t('chatPage.currentBranch')
          : b.blocked === 'elsewhere'
            ? undefined
            : t('gitWidget.branches.checkout', { branch: b.name })}
      className={cn(
        'items-start gap-1.5 px-1.5 py-1 text-[11.5px]',
        b.here && 'bg-primary/10',
        // The current branch is not switchable, yet it is the row to read:
        // it keeps its full contrast.
        b.blocked === 'current' && 'data-[disabled]:opacity-100',
      )}
    >
      <GitBranch className={cn('mt-0.5 !size-3', b.here ? 'text-primary' : 'text-muted-foreground/40')} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className={cn('truncate', b.here ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
            {b.name}
          </span>
          {b.current && (
            <span className={cn(TAG, 'bg-primary/15 text-primary')}>{t('gitWidget.picker.current')}</span>
          )}
          {b.worktree && (
            <span className={cn(TAG, 'bg-sky-500/20 text-sky-400')}>{t('gitWidget.branches.worktree')}</span>
          )}
          {(b.ahead > 0 || b.behind > 0) && (
            <span className="ml-auto shrink-0 text-[10px] font-medium tabular-nums">
              {b.ahead > 0 && <span className="text-emerald-400">↑{b.ahead}</span>}
              {b.ahead > 0 && b.behind > 0 && ' '}
              {b.behind > 0 && <span className="text-rose-400">↓{b.behind}</span>}
            </span>
          )}
        </div>
        {b.subject && <div className="truncate text-[10px] text-muted-foreground/50">{b.subject}</div>}
      </div>
    </DropdownMenuItem>
  );
}

/** A worktree is a place, not an action: the row only shows where each
 *  branch is checked out. */
function WorktreeRow({ w }: { w: PickerWorktree }) {
  return (
    <div
      className={cn('flex items-start gap-1.5 rounded-sm px-1.5 py-1 text-[11.5px]', w.here && 'bg-primary/10')}
      title={w.path}
    >
      <FolderGit2 className={cn('mt-0.5 size-3 shrink-0', w.here ? 'text-primary' : 'text-muted-foreground/40')} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className={cn('truncate', w.here ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
            {w.name}
          </span>
          {w.main && <span className={cn(TAG, 'bg-muted text-muted-foreground')}>{t('gitWidget.picker.main')}</span>}
          {w.here && <span className={cn(TAG, 'bg-primary/15 text-primary')}>{t('gitWidget.picker.here')}</span>}
          {w.locked && <span className={cn(TAG, 'bg-amber-500/15 text-amber-400')}>{t('gitWidget.picker.locked')}</span>}
          {w.prunable && <span className={cn(TAG, 'bg-rose-500/15 text-rose-400')}>{t('gitWidget.picker.missing')}</span>}
        </div>
        <div className="truncate text-[10px] text-muted-foreground/50">
          {w.detached ? t('gitWidget.detached') : w.branch ?? '—'}
        </div>
      </div>
    </div>
  );
}
