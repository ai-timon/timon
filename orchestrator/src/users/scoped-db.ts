/**
 * Per-request view of owned tables (`docs/MULTI-USER.md` §5).
 *
 * Routes call this instead of `dbApi.listX` / `getX`. The viewer is bound
 * once; every read injects the owner filter. Internal jobs keep using
 * `dbApi` unscoped.
 */
import { dbApi, type MessageStatus, type NotificationType, type TaskStatus, type ProjectTodoStatus } from '../db.js';
import type { DbViewer } from './owned.js';
import type { MissionOriginFilter } from '../mission-origin.js';

export function scopedDb(viewer: DbViewer | null) {
  return {
    listMissions: (limit?: number, agents?: string[], status?: string, origin?: MissionOriginFilter) =>
      dbApi.listMissions(limit, agents, status, viewer, origin),
    listActiveMissions: (endedSince: number) => dbApi.listActiveMissions(endedSince, viewer),
    listLatestMissionCandidates: (agent: string, window?: number) =>
      dbApi.listLatestMissionCandidates(agent, viewer, window),
    getMission: (id: string) => dbApi.getMission(id, viewer),
    searchMissions: (opts: Parameters<typeof dbApi.searchMissions>[0]) =>
      dbApi.searchMissions({ ...opts, viewer }),
    listChildMissions: (parentId: string) => dbApi.listChildMissions(parentId, viewer),
    listMissionsByTask: (taskId: string) => dbApi.listMissionsByTask(taskId, viewer),
    listMissionsByTrace: (traceId: string) => dbApi.listMissionsByTrace(traceId, viewer),
    listTasksByTrace: (traceId: string) => dbApi.listTasksByTrace(traceId, viewer),
    listMessagesByTrace: (traceId: string) => dbApi.listMessagesByTrace(traceId, viewer),

    listTasks: (status?: TaskStatus) => dbApi.listTasks(status, viewer),
    getTask: (id: string) => dbApi.getTask(id, viewer),
    listTasksByRoutine: (routineId: string) => dbApi.listTasksByRoutine(routineId, viewer),
    createTask: (...args: Parameters<typeof dbApi.createTask>) => {
      const [id, title, agentName, opts = {}] = args;
      dbApi.createTask(id, title, agentName, {
        ...opts,
        ownerUserId: opts.ownerUserId !== undefined ? opts.ownerUserId : viewer?.id ?? null,
      });
    },

    listNotifications: (opts: { archived?: boolean; limit?: number } = {}) =>
      dbApi.listNotifications({ ...opts, viewer }),
    getNotification: (id: string) => dbApi.getNotification(id, viewer),
    listActiveNotifications: (type?: NotificationType) => dbApi.listActiveNotifications(type, viewer),
    dismissAllNotifications: (type?: NotificationType) => dbApi.dismissAllNotifications(type, viewer),
    countActiveNotifications: () => dbApi.countActiveNotifications(viewer),
    countActiveByType: () => dbApi.countActiveByType(viewer),

    listProjectTodo: (opts: Omit<Parameters<typeof dbApi.listProjectTodo>[0] & object, 'viewer'> = {}) =>
      dbApi.listProjectTodo({ ...opts, viewer }),
    getProjectTodo: (id: number) => dbApi.getProjectTodo(id, viewer),
    countOpenProjectTodo: () => dbApi.countOpenProjectTodo(viewer),
    listTodoIntegrations: (todoIds: readonly number[]) => dbApi.listTodoIntegrations(todoIds, viewer),
    countProjectTodo: (opts: Omit<Parameters<typeof dbApi.countProjectTodo>[0] & object, 'viewer'> = {}) =>
      dbApi.countProjectTodo({ ...opts, viewer }),
    insertProjectTodo: (t: Parameters<typeof dbApi.insertProjectTodo>[0]) =>
      dbApi.insertProjectTodo({
        ...t,
        ownerUserId: t.ownerUserId !== undefined ? t.ownerUserId : viewer?.id ?? null,
      }),

    enqueueMessage: (m: Parameters<typeof dbApi.enqueueMessage>[0]) =>
      dbApi.enqueueMessage({
        ...m,
        ownerUserId: m.ownerUserId !== undefined ? m.ownerUserId : viewer?.id ?? undefined,
      }),
    getMessage: (id: string) => dbApi.getMessage(id, viewer),
    listInbox: (toAgent: string, opts: { status?: MessageStatus; fromAgent?: string; limit?: number } = {}) =>
      dbApi.listInbox(toAgent, { ...opts, viewer }),
    listAllInbox: (opts: { status?: MessageStatus; limit?: number } = {}) =>
      dbApi.listAllInbox({ ...opts, viewer }),
    pickMessage: (id: string) => dbApi.pickMessage(id, viewer),
    listMessagesForMission: (missionId: string, limit?: number) =>
      dbApi.listMessagesForMission(missionId, limit, viewer),

    getBrowserSession: (project: string) => dbApi.getBrowserSession(project, viewer),
    listBrowserSessions: () => dbApi.listBrowserSessions(viewer),
    browserSessionAccess: (project: string) => dbApi.browserSessionAccess(project, viewer),

    listPendingProposals: (project?: string | null) => dbApi.listPendingProposals(project, viewer),
    getProposal: (id: number) => dbApi.getProposal(id, viewer),

    listDreamProposals: (opts: { status?: string; kind?: string; limit?: number } = {}) =>
      dbApi.listDreamProposals({ ...opts, viewer }),
    listActiveDreams: (now?: number) => dbApi.listActiveDreams(now, viewer),
    getDreamProposal: (id: number) => dbApi.getDreamProposal(id, viewer),
    countActiveDreams: (now?: number) => dbApi.countActiveDreams(now, viewer),

    listWorkflows: () => dbApi.listWorkflows(viewer),
    getWorkflow: (id: string) => dbApi.getWorkflow(id, viewer),
    listWorkflowRuns: (workflowId: string) => dbApi.listWorkflowRuns(workflowId, viewer),
    getWorkflowRun: (id: string) => dbApi.getWorkflowRun(id, viewer),

    getStats: () => dbApi.getStats(viewer),
  };
}

export type ScopedDb = ReturnType<typeof scopedDb>;
