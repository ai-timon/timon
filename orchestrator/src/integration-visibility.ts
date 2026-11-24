/**
 * Who may see a job's integration row: the routes of the Kanban jobs and the
 * browser stream that announces their changes read the same rule.
 */
import { dbApi, type IntegrationRow } from './db.js';
import { seriesVisibleTo } from './series-service.js';
import { rowVisible, type DbViewer } from './users/owned.js';

/**
 * Whether a caller may read a job's landing: the same rule as its series (the
 * pilot mission, or one of its tasks), else one of the tasks based on the
 * branch. "Not found" otherwise: a refusal would confirm the job exists.
 */
export function integrationVisibleTo(viewer: DbViewer | null, row: IntegrationRow): boolean {
  if (!viewer) return false;
  if (viewer.isSuperadmin) return true;
  if (row.series_id && seriesVisibleTo(viewer, row.series_id)) return true;
  return dbApi.listTasksByBaseBranch(row.branch)
    .some((t) => (row.project === null || t.project === row.project) && rowVisible(t, viewer, 'tasks') !== undefined);
}
