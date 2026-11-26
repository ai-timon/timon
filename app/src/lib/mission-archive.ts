/**
 * Archiving, seen from the lists: which missions a list shows, when a row may
 * be archived, and how the daemon's `mission_archived` / `mission_unarchived`
 * events land in a list already on screen. The daemon owns the rule (a running
 * mission answers 409); this only keeps the menu honest and the list live.
 */

export type ArchivableMission = { id: string; running?: boolean; archived_at?: number | null };

export type MissionArchiveChange = { missionId: string; archived: boolean };

/** An archived row has a timestamp; an older daemon sends none. */
export function isArchived(m: Pick<ArchivableMission, 'archived_at'>): boolean {
  return typeof m.archived_at === 'number';
}

/** A mission at work cannot be archived: its conversation is still being written. */
export function canArchive(m: Pick<ArchivableMission, 'running' | 'archived_at'>): boolean {
  return !m.running && !isArchived(m);
}

/**
 * The rows a list draws. With the toggle off an archived row is dropped even
 * if a stale poll still carries it, so archiving from the menu is instant.
 */
export function filterArchived<M extends ArchivableMission>(missions: readonly M[], includeArchived: boolean): M[] {
  return includeArchived ? [...missions] : missions.filter((m) => !isArchived(m));
}

/** `?archived=` of the list request: omitted when off, the daemon's default being to hide them. */
export function archivedQuery(includeArchived: boolean): 'include' | undefined {
  return includeArchived ? 'include' : undefined;
}

/** The body of a `mission_archived` / `mission_unarchived` event of the global stream. */
export function parseMissionArchiveChange(kind: 'mission_archived' | 'mission_unarchived', raw: string): MissionArchiveChange | null {
  try {
    const data = JSON.parse(raw) as { missionId?: unknown };
    if (typeof data.missionId !== 'string' || !data.missionId) return null;
    return { missionId: data.missionId, archived: kind === 'mission_archived' };
  } catch {
    return null;
  }
}

/**
 * Flag a row as archived (stamped `now`) or not. Rows the list does not hold
 * are untouched; a row already in that state keeps its own timestamp.
 */
export function applyMissionArchiveChange<M extends ArchivableMission>(missions: readonly M[], change: MissionArchiveChange, now: number): M[] {
  return missions.map((m) => {
    if (m.id !== change.missionId || isArchived(m) === change.archived) return m;
    return { ...m, archived_at: change.archived ? now : null };
  });
}
