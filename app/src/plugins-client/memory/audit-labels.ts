/**
 * How the memory page names a curation journal row: its action's label and
 * colour, and what it says when the row carries no text.
 */
import { t } from '@/lib/i18n';

/** Colour of each curation action; its label is `memoryPage.action.<action>`. */
export const ACTION_CLASS: Record<string, string> = {
  new: 'text-emerald-500 border-emerald-500/40',
  merge: 'text-sky-500 border-sky-500/40',
  supersede: 'text-amber-500 border-amber-500/40',
  reject: 'text-muted-foreground border-border',
  archive: 'text-muted-foreground border-border',
  rescope: 'text-violet-500 border-violet-500/40',
  retier: 'text-violet-500 border-violet-500/40',
  manual_delete: 'text-muted-foreground border-border',
};

/** A known action's label, the raw action for one a newer daemon adds. */
export function actionLabel(action: string): string {
  const key = `memoryPage.action.${action}`;
  const label = t(key);
  return label === key ? action : label;
}

/**
 * The words in place of a row's missing text: the rule was deleted and its
 * wording with it, or the row never carried one (read the targeted rule).
 */
export function missingTextKey(row: { rule_deleted?: number }): string {
  return row.rule_deleted === 1 ? 'memoryPage.textDeletedWithRule' : 'memoryPage.noCandidateText';
}
