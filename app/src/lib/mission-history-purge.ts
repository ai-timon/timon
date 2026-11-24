/**
 * What the chat says about a conversation the retention emptied.
 *
 * The daemon marks a mission whose history the retention deleted with the
 * retention that applied (`history_purged_days` on the mission detail). An
 * emptied conversation then reads why it is empty instead of inviting the
 * user to start one, and a purged conversation resumed later says its
 * beginning is gone.
 */

/** Retention in days that deleted the history, or null when nothing was deleted. */
export function parseHistoryPurgedDays(detail: Record<string, unknown>): number | null {
  const days = detail.history_purged_days;
  return typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : null;
}

export type PurgeNotice = { key: 'chatSurface.historyPurged' | 'chatSurface.historyPurgedEarlier'; days: number } | null;

/**
 * The line the conversation shows about a purge: the whole of it when no
 * message is left, above the first one when the conversation went on after
 * the purge and its start is on screen (older pages still to load are not
 * the purged part yet).
 */
export function purgeNotice(days: number | null, messageCount: number, hasOlderHistory: boolean): PurgeNotice {
  if (days === null) return null;
  if (messageCount === 0) return { key: 'chatSurface.historyPurged', days };
  if (hasOlderHistory) return null;
  return { key: 'chatSurface.historyPurgedEarlier', days };
}
