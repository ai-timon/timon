/**
 * The git worktree of a task, created and disposed through one path for the
 * routes (`plugins-bundled/kanban-code`) and the plugin facade
 * (`plugins/worktrees-facade.ts`). The bodies are the routes' own, with
 * `res.status(..).json(..)` turned into a thrown `WorktreeServiceError`.
 */
import { existsSync } from 'node:fs';
import { loadConfig } from './agent.js';
import { dbApi, type TaskRow } from './db.js';
import { integrationSettings, type IntegrationMode } from './integration-mode.js';
import { taskProjectSlug } from './task-project.js';
import { createWorktree, disposeWorktree, isGitRepo, releaseWorktreeFolder, type WorktreeInfo } from './worktree.js';

/** `invalid` (400: no cwd, not a repo, bad base), `busy` (409: the task is
 *  running), `failed` (500: git refused). */
export type WorktreeErrorCode = 'invalid' | 'busy' | 'failed';

export class WorktreeServiceError extends Error {
  constructor(readonly code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = 'WorktreeServiceError';
  }
}

/** A base is handed to `git worktree add` as a positional argument: a leading `-` would be read as an option. */
const BASE_REF = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/;

export function worktreeOfTask(task: TaskRow): {
  task_id: string;
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  merged_commit_sha: string | null;
} {
  return {
    task_id: task.id, worktree_path: task.worktree_path, branch_name: task.branch_name,
    base_branch: task.base_branch, merged_commit_sha: task.merged_commit_sha,
  };
}

/** Same project the briefs use. A missing slug stays `local`, so this path does not fetch. */
function worktreeIntegration(task: TaskRow): IntegrationMode {
  let slug: string | null = task.project ?? null;
  if (!slug && task.agent_name) {
    try { slug = taskProjectSlug(task, loadConfig(task.agent_name)); } catch { slug = null; }
  }
  return integrationSettings(slug).mode;
}

export async function createTaskWorktree(task: TaskRow, base?: string): Promise<WorktreeInfo> {
  const cfg = loadConfig(task.agent_name);
  if (!cfg.cwd) throw new WorktreeServiceError('invalid', 'agent has no cwd');
  if (!(await isGitRepo(cfg.cwd))) throw new WorktreeServiceError('invalid', `agent cwd is not a git repo: ${cfg.cwd}`);
  if (base !== undefined && !BASE_REF.test(base)) throw new WorktreeServiceError('invalid', `invalid base ref: "${base}"`);
  try {
    const info = await createWorktree(task.id, cfg.cwd, base, undefined, worktreeIntegration(task));
    dbApi.setTaskWorktree(task.id, info.path, info.branch, info.base);
    return info;
  } catch (err) {
    throw new WorktreeServiceError('failed', (err as Error).message);
  }
}

/** Idempotent: a task with no worktree answers `disposed: false`. */
export async function disposeTaskWorktree(task: TaskRow, force: boolean): Promise<{ disposed: boolean }> {
  if (!task.worktree_path || !task.branch_name) return { disposed: false };
  // Folder already gone (removed by hand with git): only the stale reference is
  // left. It needs neither the agent's cwd nor git, and the branch is kept in
  // case it still holds unmerged commits (TIM-0113).
  if (!existsSync(task.worktree_path)) {
    dbApi.clearTaskWorktree(task.id);
    return { disposed: true };
  }
  const cfg = loadConfig(task.agent_name);
  if (!cfg.cwd) throw new WorktreeServiceError('invalid', 'agent has no cwd');
  try {
    await disposeWorktree(
      {
        taskId: task.id,
        path: task.worktree_path,
        branch: task.branch_name,
        base: task.base_branch ?? 'HEAD',
        sourceRepo: cfg.cwd,
      },
      force,
    );
    dbApi.clearTaskWorktree(task.id);
    return { disposed: true };
  } catch (err) {
    throw new WorktreeServiceError('failed', (err as Error).message);
  }
}

/**
 * Detaches a task from its worktree (TIM-0113): the folder goes, the branch and
 * its commits stay, and the next dispatch reattaches to the branch. Unlike
 * {@link disposeTaskWorktree}, which deletes the branch once it is merged,
 * this is safe on unmerged work — and git refuses a folder with uncommitted
 * changes. Never on a running task: its agent is working in that folder.
 */
export async function detachTaskWorktree(task: TaskRow): Promise<{ detached: boolean }> {
  if (!task.worktree_path) return { detached: false };
  if (task.status === 'IN_PROGRESS') throw new WorktreeServiceError('busy', 'The task is running in this worktree. Stop it first.');
  if (existsSync(task.worktree_path)) {
    try {
      await releaseWorktreeFolder(task.worktree_path);
    } catch (err) {
      throw new WorktreeServiceError('failed', (err as Error).message);
    }
  }
  dbApi.detachTaskWorktree(task.id);
  return { detached: true };
}
