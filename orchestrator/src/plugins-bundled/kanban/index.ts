/**
 * Module `kanban` — the board: tasks, pipelines, series fallback plans, and
 * the "TO DO" notebook of parked ideas. Tier `std`. The "code" half (git
 * worktrees, merge) lives in `kanban-code`, which may be absent.
 *
 * The notebook used to be `@timon/backlog`, a module of its own that could be
 * switched off or moved to a cockpit tile. It is now part of the board: the
 * one place ideas wait before becoming tasks. Its table stays separate from
 * `tasks` on purpose (see `project-todo-routes.ts`) — that is what keeps the
 * dispatcher structurally unable to pick an idea up.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { registerRoutes as registerProjectTodoRoutes } from './project-todo-routes.js';
import { seedBundledPipelines } from '../../pipelines.js';
import { startDispatcher } from '../../dispatcher.js';
import { startTaskChain } from '../../task-chain.js';
import { startWake } from '../../wake.js';
import { startIntegrationPoller } from '../../integration-poller.js';
import { watchIssueOutcomes } from '../../issue-outcome.js';
import { watchLocalLandings } from '../../local-landing.js';
import { settingInt } from '../../settings.js';
import { todoApi, type TodoApi } from './todo-api.js';
import { registerAttachmentRoutes } from './attachment-routes.js';
import { registerIntegrationRoutes } from './integration-routes.js';
import { registerPrRoutes } from './pr-routes.js';
import { registerPushBranchRoutes } from './push-branch-routes.js';
import { registerExternalPrRoutes } from './external-pr-routes.js';
import { watchReviewMissions } from '../../external-pr-review.js';
import { watchPullRequestPages } from '../../pull-request-page.js';
import { registerLandingRoutes } from './landing-routes.js';
import { registerForgeProposalRoutes } from './forge-proposal-routes.js';
import { registerForgeBranchRoutes } from './forge-branch-routes.js';
import { recoverInterruptedPublications } from '../../forge-proposals.js';
import { sweepConflictScratch } from '../../forge-conflicts.js';
import { dbApi } from '../../db.js';
import {
  purgeOrphanTaskAttachments, purgeOrphanTodoAttachments, watchTaskDeletions, watchTodoDeletions,
} from '../../attachments.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ordering token (dispatcher, chain and wake loop are armed) and the TO DO API. */
    kanban: { todos: TodoApi };
  }
}

export const manifest: ModuleManifest = {
  name: '@timon/kanban',
  tier: 'std',
  inject: ['http', 'db', 'settings'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());
  registerProjectTodoRoutes(ctx.http.router());
  registerAttachmentRoutes(ctx.http.router());
  registerIntegrationRoutes(ctx.http.router());
  registerPrRoutes(ctx.http.router());
  registerPushBranchRoutes(ctx.http.router());
  registerExternalPrRoutes(ctx.http.router());
  registerLandingRoutes(ctx.http.router());
  registerForgeProposalRoutes(ctx.http.router());
  registerForgeBranchRoutes(ctx.http.router());

  // `kanban` service: ordering token for the modules that create tasks
  // (`routines`) or extend the pipeline (`kanban-code`). It will carry the
  // `registerWorktreeResolver` of plan §3.4 once `resolveWorktree` is moved out
  // of `dispatcher.ts` — that split belongs to Phase 2.
  ctx.provide('kanban', { todos: todoApi });

  seedBundledPipelines();

  // LOAD-BEARING ORDER: `startDispatcher` registers `watchMissionComplete`,
  // which MUST stay the first consumer of `mission_complete` — it is the one
  // that turns a suffered death into BLOCKED, and the only path for a mission
  // dead without closing its task. The effects of one `apply` run in
  // writing order, so this order is the guarantee.
  ctx.effect(() => startDispatcher(settingInt('DISPATCHER_INTERVAL_MS')));
  ctx.effect(() => startTaskChain());
  ctx.effect(() => startWake());
  // Learns when the pull request of a job is merged or closed; reaches the
  // network only while one is open.
  ctx.effect(() => startIntegrationPoller());
  // A job of a project that merges locally lands when its `--landing local`
  // task is DONE, not through the forge.
  ctx.effect(() => watchLocalLandings());
  // Brings the verdict of a pull request's relecture back to its row.
  ctx.effect(() => watchReviewMissions());
  // An imported idea declined, duplicated or short of details: its issue's
  // answer (and closing) wait for a person in the "Publish on GitHub" window.
  ctx.effect(() => watchIssueOutcomes());
  // A pull request's page read a moment ago is dropped when its job moves.
  ctx.effect(() => watchPullRequestPages());
  // A publication cut by a stop is failed, and looked for on the forge before
  // it is written again.
  recoverInterruptedPublications();
  // A conflict resolution nobody published keeps fetched objects on the disk.
  sweepConflictScratch();

  // A card's files live as long as the card. The sweep catches the cards
  // deleted while this module was off.
  ctx.effect(() => {
    const stop = watchTaskDeletions();
    const purged = purgeOrphanTaskAttachments((id) => dbApi.getTask(id) !== undefined);
    if (purged.length > 0) console.log(`[task-attachments] removed the files of ${purged.length} deleted task(s)`);
    return stop;
  });
  // Same for the ideas of the TO DO notebook (`todo_deleted`).
  ctx.effect(() => {
    const stop = watchTodoDeletions();
    const purged = purgeOrphanTodoAttachments((id) => dbApi.getProjectTodo(id) !== undefined);
    if (purged.length > 0) console.log(`[attachments] removed the files of ${purged.length} deleted idea(s)`);
    return stop;
  });
}
