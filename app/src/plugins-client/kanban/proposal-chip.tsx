'use client';

/**
 * "To approve": a publication on GitHub waits for a person on this row. A
 * click opens the first one in the "Publish on GitHub" dialog; the others
 * follow once it is dealt with.
 */

import type { ReactElement } from 'react';
import { Send } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ForgeProposal } from './forge-proposals-api';

export function ProposalChip({ proposals, onOpen, className }: {
  proposals: readonly ForgeProposal[];
  onOpen: (proposal: ForgeProposal) => void;
  className?: string;
}): ReactElement | null {
  const first = proposals[0];
  if (!first) return null;
  const label = t('forgePublish.toApprove', { count: proposals.length });
  return (
    <button
      type="button"
      data-proposal-chip={first.id}
      onClick={(e) => { e.stopPropagation(); onOpen(first); }}
      title={t('forgePublish.title')}
      aria-label={`${label} · ${t('forgePublish.title')}`}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-amber-500/15 px-1.5 text-[10.5px] font-medium tabular-nums text-amber-700 hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-300',
        className,
      )}
    >
      <Send className="size-3" aria-hidden />{label}
    </button>
  );
}
