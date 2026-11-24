/**
 * The rows of Settings › System › Privacy that say how long Timon keeps what
 * agents leave on the computer. Pure: the pane paints what this decides.
 */

/** The retention settings the pane paints, in display order, with their copy prefix. */
export const RETENTION_ROWS = [
  { key: 'TIMON_EVENTS_RETENTION_DAYS', copy: 'history' },
  { key: 'TIMON_LEARNINGS_RETENTION_DAYS', copy: 'learnings' },
] as const;

export type RetentionCopy = (typeof RETENTION_ROWS)[number]['copy'];

/** The fields of a `/api/ui/settings` row this view reads. */
export type RetentionSettingLike = {
  key: string;
  value: boolean | number | string;
  default: boolean | number | string;
  source: 'env' | 'config' | 'db' | 'default';
  overridden: boolean;
};

export type RetentionRowView = {
  /** 0 keeps everything. */
  days: number;
  defaultDays: number;
  /** Who decides instead of this pane, if anyone. */
  lockedBy: 'env' | 'config' | null;
  /** "Keep everything" in the menu: not when it already does. */
  canKeepAll: boolean;
  /** "Back to the default" in the menu: only once someone set a value here. */
  canReset: boolean;
};

const asDays = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

export function retentionRowView(setting: RetentionSettingLike): RetentionRowView {
  const lockedBy = setting.source === 'env' || setting.source === 'config' ? setting.source : null;
  const days = asDays(setting.value);
  return {
    days,
    defaultDays: asDays(setting.default),
    lockedBy,
    canKeepAll: lockedBy === null && days > 0,
    canReset: lockedBy === null && setting.overridden,
  };
}

/** The message keys of a row's status line: how long, then who decides when not this pane. */
export function retentionStatus(copy: RetentionCopy, view: RetentionRowView): { key: string; values?: Record<string, number>; lock: string | null } {
  const lock = view.lockedBy === 'env' ? 'privacySettings.lockedEnv'
    : view.lockedBy === 'config' ? 'privacySettings.lockedConfig' : null;
  return view.days > 0
    ? { key: `privacySettings.${copy}.after`, values: { days: view.days }, lock }
    : { key: `privacySettings.${copy}.forever`, lock };
}
