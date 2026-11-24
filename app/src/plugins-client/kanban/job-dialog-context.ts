'use client';

/** What a `kanban.job.dialog` occupant reads: the job and its gestures (`job-dialog.tsx`). */

import { createContext, useContext } from 'react';
import type { Landing, LandRequest, RepairKind } from './landing-api';

export type JobDialogValue = {
  /** The job, its `links` and `repairs` included when the daemon sends them;
   *  the host replaces it once `refresh` or `repair` answers. */
  landing: Landing;
  /** The gesture under way, if any: the occupant greys its buttons. */
  busy: 'refresh' | 'land' | RepairKind | null;
  /** Asks the forge for the pull request's checks again. */
  refresh: () => Promise<void>;
  /** Asks for a repair of the job (a person's click only); the host says how
   *  it went and resolves `true` once the daemon started it. */
  repair: (kind: RepairKind) => Promise<boolean>;
  /**
   * Lands a job the planner kept on its branch (a person's click only): merged
   * into its local target, or its pull request opened (`title` required
   * there). The host asks for confirmation with `commits` (read again when
   * absent), says how it went, and resolves `true` once it landed. `null` when
   * the job is not kept.
   */
  land: ((request?: LandRequest, commits?: number | null) => Promise<boolean>) | null;
  /** Why `land` cannot start now (the right is missing, a task of the job still runs), or null. */
  landBlocked: string | null;
  close: () => void;
  /** Closes the dialog and opens the idea, when the screen can show one. */
  openTodo: ((id: number) => void) | null;
  /** Closes the dialog and opens the mission's conversation. */
  openMission: (missionId: string) => void;
};

export const JobDialogContext = createContext<JobDialogValue | null>(null);

/** The job a `kanban.job.dialog` occupant paints, and its gestures. */
export function useJobDialog(): JobDialogValue | null {
  return useContext(JobDialogContext);
}
