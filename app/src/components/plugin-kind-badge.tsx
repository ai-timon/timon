'use client';

/**
 * One kind of a plugin, as a coloured chip.
 *
 * The stored kind is the contract (`behavior`, `widget`, …). The label is
 * what a human reads: `behavior` becomes "Backend", because "plugs into
 * nothing" was the gallery telling everyone the same non-information.
 */
import { Badge } from '@/components/ui/badge';
import { kindLabel } from '@/lib/plugin-gallery';
import { cn } from '@/lib/utils';

/** Same tones on the card badge and on the type filter chips. Tinted, with
 *  no outline: eleven coloured rims in a row read as noise, not as kinds. */
export const KIND_TONE: Record<string, string> = {
  widget: 'border-transparent bg-sky-500/[0.12] text-sky-800 dark:text-sky-300',
  page: 'border-transparent bg-violet-500/[0.12] text-violet-800 dark:text-violet-300',
  island: 'border-transparent bg-sky-500/[0.12] text-sky-800 dark:text-sky-300',
  overlay: 'border-transparent bg-amber-500/[0.12] text-amber-800 dark:text-amber-300',
  theme: 'border-transparent bg-pink-500/[0.12] text-pink-800 dark:text-pink-300',
  composer: 'border-transparent bg-emerald-500/[0.12] text-emerald-800 dark:text-emerald-300',
  layout: 'border-transparent bg-slate-500/[0.12] text-slate-800 dark:text-slate-300',
  behavior: 'border-transparent bg-zinc-500/[0.12] text-zinc-700 dark:text-zinc-300',
  provider: 'border-transparent bg-teal-500/[0.12] text-teal-800 dark:text-teal-300',
  dictation: 'border-transparent bg-rose-500/[0.12] text-rose-800 dark:text-rose-300',
  bundle: 'border-transparent bg-orange-500/[0.12] text-orange-800 dark:text-orange-300',
};

export function PluginKindBadge({ kind }: { kind: string }): React.ReactElement {
  return (
    <Badge
      variant="outline"
      className={cn('border font-medium shadow-none', KIND_TONE[kind] ?? 'text-muted-foreground')}
    >
      {kindLabel(kind)}
    </Badge>
  );
}
