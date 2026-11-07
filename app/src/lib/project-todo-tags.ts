/**
 * Closed vocabulary of the TO DO notebook tags — mirror of
 * `orchestrator/src/project-todo-tags.ts` (the two packages are independent).
 * Two axes, one value each: urgency / kind, and progress.
 *
 * Tailwind classes are whole literals on purpose: the scanner cannot see a
 * class assembled from pieces.
 */
export const TODO_URGENCIES = ['critical', 'bug', 'minor', 'idea'] as const;
export const TODO_PROGRESSES = ['todo', 'analyzed', 'partial', 'to_test', 'done'] as const;

export type TodoUrgency = (typeof TODO_URGENCIES)[number];
export type TodoProgress = (typeof TODO_PROGRESSES)[number];

/** Untagged older ideas read as plain `todo`. */
export function effectiveProgress(progress: TodoProgress | null | undefined): TodoProgress {
  return progress ?? 'todo';
}

/** Chip colours, one set per tag: border + text + soft background. */
// Tint-only, like every other badge: a coloured rim on each tag made the
// to-do lists the busiest pixels of the page. The light scheme takes the
// 700 shade, which still reads on beige; the dark one keeps a lighter tone.
export const URGENCY_CLASS: Record<TodoUrgency, string> = {
  critical: 'border-transparent bg-red-500/[0.12] text-red-700 dark:text-red-400',
  bug: 'border-transparent bg-orange-500/[0.12] text-orange-700 dark:text-orange-400',
  minor: 'border-transparent bg-amber-500/[0.14] text-amber-800 dark:text-amber-400',
  idea: 'border-transparent bg-violet-500/[0.12] text-violet-700 dark:text-violet-300',
};
export const PROGRESS_CLASS: Record<TodoProgress, string> = {
  todo: 'border-transparent bg-foreground/[0.06] text-muted-foreground',
  analyzed: 'border-transparent bg-sky-500/[0.12] text-sky-700 dark:text-sky-400',
  partial: 'border-transparent bg-blue-500/[0.12] text-blue-700 dark:text-blue-300',
  to_test: 'border-transparent bg-fuchsia-500/[0.12] text-fuchsia-700 dark:text-fuchsia-300',
  done: 'border-transparent bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-400',
};
