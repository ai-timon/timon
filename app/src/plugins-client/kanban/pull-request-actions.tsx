'use client';

/**
 * How a pull request's gestures are painted, from the choice
 * `pullRequestActions` makes: as buttons of its window's status card (the
 * filled one and those under it), as entries of a "…" menu (its window's and
 * its row's).
 * A refused gesture keeps its place, greyed, its reason on hover and read by
 * a screen reader; one under way shows a spinner.
 */

import { useId, type ComponentType, type ReactElement } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  ExternalLink, FileText, GitMerge, GitPullRequestArrow, Loader2, MessageSquarePlus, MessageSquareWarning, ScanSearch,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { PullAction, PullActionBlock, PullActionId } from './pull-requests-model';

const ICON: Record<PullActionId, ComponentType<{ className?: string }>> = {
  review: ScanSearch,
  report: FileText,
  updateBranch: GitPullRequestArrow,
  resolveConflict: GitMerge,
  askContributor: MessageSquareWarning,
  comment: MessageSquarePlus,
  forge: ExternalLink,
};

const LABEL: Record<PullActionId, string> = {
  review: 'pullRequests.reviewBrief',
  report: 'pullRequests.showReport',
  updateBranch: 'pullRequests.updateBranch',
  resolveConflict: 'pullRequests.resolveConflict',
  askContributor: 'pullRequests.askContributor',
  comment: 'pullRequests.proposeComment',
  forge: 'pullRequests.openOnForge',
};

/** The menu entry's test hook, one per gesture (`data-menu-update-branch`…). */
const MENU_HOOK: Record<PullActionId, string> = {
  review: 'data-menu-review',
  report: 'data-menu-report',
  updateBranch: 'data-menu-update-branch',
  resolveConflict: 'data-menu-resolve-conflict',
  askContributor: 'data-menu-ask-contributor',
  comment: 'data-menu-comment',
  forge: 'data-menu-forge',
};

export function pullActionLabel(action: PullAction): string {
  if (action.busy) return t(action.id === 'review' ? 'pullRequests.briefPreparing' : 'pullRequests.branchPreparing');
  return t(LABEL[action.id]);
}

/** Why a gesture is greyed, in the person's words. */
export function pullActionReason(blocked: PullActionBlock | null): string | null {
  if (blocked === null) return null;
  if (blocked === 'branch_busy') return t('pullRequests.blocked.branchBusy');
  if (blocked === 'review_running') return t('pullRequests.blocked.reviewRunning');
  return t(`pullRequests.lockedHint.${blocked}`);
}

function ActionIcon({ action, className }: { action: PullAction; className: string }) {
  if (action.busy) return <Loader2 className={cn(className, 'animate-spin')} aria-hidden />;
  const Icon = ICON[action.id];
  return <Icon className={className} />;
}

/**
 * One gesture as a button of the window: `primary` filled, the others
 * outlined; `block` spans the width it is given. Greyed, a disabled button
 * takes no pointer events: the wrapper carries the reason's tooltip, the
 * button names it for a screen reader.
 */
export function PullActionButton({ action, primary = false, block = false, onRun }: {
  action: PullAction;
  primary?: boolean;
  block?: boolean;
  onRun: (id: PullActionId) => void;
}): ReactElement {
  const reasonId = useId();
  const reason = pullActionReason(action.blocked);
  const label = pullActionLabel(action);
  return (
    <span title={reason ?? undefined} data-pull-action-reason={reason ? action.id : undefined} className={block ? 'flex min-w-0' : 'inline-flex shrink-0'}>
      <Button
        type="button"
        size="sm"
        variant={primary ? 'default' : 'outline'}
        data-pull-action={action.id}
        data-pull-action-primary={primary ? '' : undefined}
        disabled={action.blocked !== null || action.busy}
        aria-busy={action.busy || undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => onRun(action.id)}
        className={cn('h-7 gap-1.5 px-2.5 text-[11.5px] [&_svg]:size-3.5', block && 'w-full min-w-0')}
      >
        <ActionIcon action={action} className="size-3.5" />
        <span className="min-w-0 truncate">{label}</span>
      </Button>
      {reason && <span id={reasonId} className="sr-only">{reason}</span>}
    </span>
  );
}

/** A menu entry: its pictogram follows the entry's colour, on hover as at rest. */
export const PULL_MENU_ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 outline-none focus:bg-muted focus:text-foreground data-[disabled]:cursor-default data-[disabled]:opacity-50';

function PullActionMenuItem({ action, onRun }: { action: PullAction; onRun: (id: PullActionId) => void }) {
  const reasonId = useId();
  const reason = pullActionReason(action.blocked);
  return (
    <Dropdown.Item
      {...{ [MENU_HOOK[action.id]]: '' }}
      disabled={action.blocked !== null || action.busy}
      title={reason ?? undefined}
      aria-describedby={reason ? reasonId : undefined}
      onSelect={() => onRun(action.id)}
      className={PULL_MENU_ITEM}
    >
      <ActionIcon action={action} className="size-3.5 shrink-0" />
      {pullActionLabel(action)}
      {reason && <span id={reasonId} className="sr-only">{reason}</span>}
    </Dropdown.Item>
  );
}

/** The gestures of a "…" menu, in the order given. */
export function PullActionMenuItems({ actions, onRun }: {
  actions: readonly PullAction[];
  onRun: (id: PullActionId) => void;
}): ReactElement {
  return <>{actions.map((action) => <PullActionMenuItem key={action.id} action={action} onRun={onRun} />)}</>;
}
