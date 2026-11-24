'use client';

/**
 * Repairing one of our jobs (`POST …/landings/:id/repairs`): the icon of each
 * kind, its name, the counter chip, and the gesture the Jobs widget and the
 * job's dialog share. A repair starts only on a person's click; the daemon
 * reads the forge again and refuses when there is nothing to fix.
 */

import type { ReactElement } from 'react';
import { GitMerge, LoaderCircle, MessageSquareText, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { repairsSpent, requestLandingRepair, type Landing, type RepairKind } from './landing-api';

const ICONS: Record<RepairKind, typeof Wrench> = { checks: Wrench, comments: MessageSquareText, conflict: GitMerge };

export function RepairIcon({ kind, className = 'size-3.5' }: { kind: RepairKind; className?: string }): ReactElement {
  const Icon = ICONS[kind];
  return <Icon className={className} aria-hidden />;
}

/** "Fix the checks", "Address the comments", "Resolve the conflict". */
export function repairLabel(kind: RepairKind): string {
  return t(`landings.repair.${kind}`);
}

/** What the click does, for the button's title: the job's agent, with what as data. */
export function repairHint(kind: RepairKind, landing: Landing): string {
  return t(`landings.repair.hint.${kind}`, { target: landing.target });
}

/**
 * Asks for the repair and says how it went; answers the job with its new
 * counter, or null when the daemon refused (the toast says why).
 */
export async function askRepair(landing: Landing, kind: RepairKind): Promise<Landing | null> {
  const out = await requestLandingRepair(landing.id, kind);
  if (!out.ok) {
    toast.error(t('landings.repair.notStarted'), { description: out.message });
    return null;
  }
  toast.success(t('landings.repair.started'), { description: repairLabel(kind) });
  return out.value;
}

const CHIP = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium tabular-nums';

/**
 * The counter on a job's row, once a repair was asked: under way (it turns),
 * spent while the forge still asks for one, or simply how many were used.
 */
export function RepairChip({ landing }: { landing: Landing }): ReactElement | null {
  const r = landing.repairs;
  if (!r || r.used === 0 || landing.state !== 'open') return null;
  const counts = { used: r.used, max: r.max };
  if (r.running) {
    const title = t('landings.repair.runningTitle', { kind: repairLabel(r.running.kind), ...counts });
    return (
      <span data-repair-chip="running" title={title} className={cn(CHIP, 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>
        <LoaderCircle className="size-3 animate-spin [animation-duration:2s]" aria-hidden />
        {t('landings.repair.running', counts)}
      </span>
    );
  }
  const spent = repairsSpent(landing);
  return (
    <span
      data-repair-chip={spent ? 'spent' : 'used'}
      title={spent ? t('landings.repair.spentTitle', counts) : r.last ? t(`landings.repair.last.${r.last.state}`) : undefined}
      className={cn(CHIP, spent ? 'bg-red-500/15 text-red-700 dark:text-red-300' : 'bg-foreground/[0.06] text-muted-foreground')}
    >
      <Wrench className="size-3" aria-hidden />
      {t('landings.repair.counter', counts)}
    </span>
  );
}
