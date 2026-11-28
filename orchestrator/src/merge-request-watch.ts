/**
 * The watch over the pull / merge requests that tasks carry (`merge-request.ts`):
 * once a person merges one on GitLab or GitHub, the task that waited for it
 * closes by itself, so nobody has to come back and say "it is merged".
 *
 * - merged: the task's `mr_state` becomes `merged`, the merge commit is
 *   recorded, and a task still waiting goes DONE, which frees the tasks that
 *   depend on it.
 * - closed without a merge: one notification, the chip shows `closed`, and the
 *   task stays where it is.
 *
 * Strictly read only on the forge: one GET per request, never a merge, a
 * pipeline or any write. GitLab is reached through the vault broker with the
 * `GITLAB_API_TOKEN` identity (the value never leaves the broker, and nothing
 * the broker refuses with carries it); GitHub through `gh` (`host/forge.ts`),
 * as the landing poller does.
 *
 * The reader is a seam (`MergeRequestReader`): a later poller or a landing step
 * can ask the same question of the same request without a second client. A
 * reading that fails changes nothing and is tried again at the next pass; a
 * pass replayed changes nothing either, because only an `open` chip moves.
 */
import { loadConfig } from './agent-config.js';
import { dbApi, type TaskRow } from './db.js';
import { githubForge, githubRepoFromUrl, type ForgeRunners, type ForgeStateReader } from './host/forge.js';
import { mergeRequestOf, type MergeRequestRef, type MergeRequestState } from './merge-request.js';
import { notifyUser } from './notify.js';
import { readProjectIntegration } from './project-integration.js';
import { BrokerDeniedError, brokerHttpCall, type BrokerDeps } from './secrets/broker.js';
import { taskProjectSlug } from './task-project.js';
import { z } from 'zod';

/** Minutes, not seconds: a request waits for a person. */
export const MR_WATCH_INTERVAL_MS = 5 * 60_000;
/** The first pass leaves the boot alone. */
const FIRST_PASS_DELAY_MS = 90_000;
/** Most requests read in one pass: the longest-unchanged first, so none starves. */
export const MR_WATCH_BATCH = 40;
/** The vault identity GitLab is read with (a `broker` secret listing the GitLab host). */
export const GITLAB_IDENTITY = 'GITLAB_API_TOKEN';

/** Who is asking: the vault's grants are by agent and project. */
export type MergeRequestWatcher = { agent: string; project: string | null };

export type MergeRequestReading =
  | { ok: true; state: MergeRequestState; mergeSha: string | null }
  | { ok: false; reason: string };

export type MergeRequestReader = (ref: MergeRequestRef, who: MergeRequestWatcher) => Promise<MergeRequestReading>;

const SHA = /^[0-9a-f]{40,64}$/i;

const GitlabMergeRequest = z.object({
  state: z.string(),
  merge_commit_sha: z.string().nullish(),
  squash_commit_sha: z.string().nullish(),
  /** The head: what a fast-forward merge leaves as the merge commit. */
  sha: z.string().nullish(),
});

/** `group/sub/project` out of `https://host/group/sub/project/-/merge_requests/7`. */
function gitlabProjectPath(ref: MergeRequestRef): string | null {
  const path = new URL(ref.url).pathname;
  const m = /^\/(.+?)(?:\/-)?\/merge_requests\/\d+$/.exec(path);
  return m?.[1] ?? null;
}

function pickSha(...candidates: Array<string | null | undefined>): string | null {
  const found = candidates.find((c): c is string => typeof c === 'string' && SHA.test(c));
  return found ? found.toLowerCase() : null;
}

/** GitLab API v4, one GET, under the vault identity. */
export function gitlabReader(deps: BrokerDeps = {}): MergeRequestReader {
  return async (ref, who) => {
    const project = gitlabProjectPath(ref);
    if (!project) return { ok: false, reason: 'not a GitLab merge request address' };
    let reply;
    try {
      reply = await brokerHttpCall({
        identity: GITLAB_IDENTITY,
        method: 'GET',
        host: new URL(ref.url).host,
        path: `/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${ref.number}`,
      }, { agent: who.agent, project: who.project }, deps);
    } catch (err) {
      // The broker's refusals name the cause and never the value.
      return { ok: false, reason: err instanceof BrokerDeniedError ? err.message : 'the call to GitLab failed' };
    }
    if (reply.status !== 200) return { ok: false, reason: `GitLab answered ${reply.status}` };
    let body: z.infer<typeof GitlabMergeRequest>;
    try { body = GitlabMergeRequest.parse(JSON.parse(reply.body)); } catch {
      return { ok: false, reason: 'GitLab did not answer a merge request' };
    }
    if (body.state === 'merged') {
      return { ok: true, state: 'merged', mergeSha: pickSha(body.merge_commit_sha, body.squash_commit_sha, body.sha) };
    }
    // `locked` is a merge in flight: still waiting.
    if (body.state === 'closed') return { ok: true, state: 'closed', mergeSha: null };
    return { ok: true, state: 'open', mergeSha: null };
  };
}

/** GitHub through `gh`, signed in with the project's configured folder when it has one. */
export function githubReader(
  runners?: ForgeRunners,
  forge: (configDir: string | null) => ForgeStateReader = (dir) => githubForge(dir, runners),
): MergeRequestReader {
  return async (ref, who) => {
    const repository = githubRepoFromUrl(ref.url);
    if (!repository) return { ok: false, reason: 'not a GitHub pull request address' };
    let configDir: string | null = null;
    if (who.project) {
      try {
        const read = readProjectIntegration(who.project);
        if (!read.invalid) configDir = read.integration.gh_config_dir;
      } catch { /* no setting: the default gh sign-in */ }
    }
    const view = await forge(configDir).pullRequest(repository, ref.number);
    return view.ok ? { ok: true, state: view.state, mergeSha: view.mergeSha } : { ok: false, reason: view.reason };
  };
}

export type WatchDeps = {
  read?: Partial<Record<MergeRequestRef['forge'], MergeRequestReader>>;
  runners?: ForgeRunners;
  broker?: BrokerDeps;
  notify?: typeof notifyUser;
};

/** What one request's reading did. */
export type WatchResult = 'merged' | 'closed' | 'open' | 'unknown';

function watcherOf(task: TaskRow): MergeRequestWatcher {
  let cfg = null;
  try { cfg = loadConfig(task.agent_name); } catch { /* unreadable config: no project from the agent */ }
  return { agent: task.agent_name, project: taskProjectSlug(task, cfg) };
}

/** A task that cannot go DONE without the merge commit (`guardMergeDone`). */
function needsSha(task: TaskRow): boolean {
  return task.type === 'merge' || (task.type === 'code' && task.pipeline === 'code-self');
}

function markMerged(task: TaskRow, mergeSha: string | null): WatchResult {
  // Without a commit, a task the close guard would block waits for the next
  // pass instead of landing BLOCKED on a merge that did happen.
  if (needsSha(task) && !mergeSha && !task.merged_commit_sha) return 'unknown';
  if (mergeSha && !task.merged_commit_sha) dbApi.setTaskMergedSha(task.id, mergeSha);
  if (!dbApi.setTaskMergeRequestState(task.id, 'merged')) return 'open';
  if (task.status !== 'DONE') {
    dbApi.setTaskStatusOnly(task.id, 'DONE', 'Closed automatically: its merge request was merged.');
  }
  console.log(`[mr-watch] merge request of task ${task.id} merged`);
  return 'merged';
}

function markClosed(task: TaskRow, ref: MergeRequestRef, notify: typeof notifyUser): WatchResult {
  if (!dbApi.setTaskMergeRequestState(task.id, 'closed')) return 'open';
  if (task.status !== 'DONE') {
    notify(
      `Merge request closed without a merge: ${task.title}`,
      `${ref.url} was closed without being merged. The task stays where it was; reopen the request or decide what comes next.`,
      { taskId: task.id, type: 'alert' },
    );
  }
  console.log(`[mr-watch] merge request of task ${task.id} closed without a merge`);
  return 'closed';
}

/** One request: read it, act on a change. A failure changes nothing. */
export async function watchTask(task: TaskRow, deps: WatchDeps = {}): Promise<WatchResult> {
  const ref = mergeRequestOf(task);
  if (!ref || ref.state !== 'open') return 'open';
  const read = deps.read?.[ref.forge] ?? (ref.forge === 'gitlab' ? gitlabReader(deps.broker) : githubReader(deps.runners));
  let reading: MergeRequestReading;
  try {
    reading = await read(ref, watcherOf(task));
  } catch (err) {
    reading = { ok: false, reason: (err as Error).message };
  }
  if (!reading.ok) {
    console.warn(`[mr-watch] cannot read the ${ref.forge} request of task ${task.id}: ${reading.reason}`);
    return 'unknown';
  }
  if (reading.state === 'merged') return markMerged(task, reading.mergeSha);
  if (reading.state === 'closed') return markClosed(task, ref, deps.notify ?? notifyUser);
  return 'open';
}

/** One pass over the open requests, a bounded batch. Returns each task's result. */
export async function watchMergeRequests(deps: WatchDeps = {}): Promise<Map<string, WatchResult>> {
  const results = new Map<string, WatchResult>();
  for (const task of dbApi.listOpenMergeRequestTasks(MR_WATCH_BATCH)) {
    try {
      results.set(task.id, await watchTask(task, deps));
    } catch (err) {
      console.error(`[mr-watch] task ${task.id}: ${(err as Error).message}`);
      results.set(task.id, 'unknown');
    }
  }
  return results;
}

/** Arms the watch; returns its stop. One pass at a time. */
export function startMergeRequestWatch(intervalMs: number = MR_WATCH_INTERVAL_MS, deps: WatchDeps = {}): () => void {
  let running = false;
  const pass = (): void => {
    if (running) return;
    running = true;
    watchMergeRequests(deps)
      .catch((err) => console.error(`[mr-watch] pass failed: ${(err as Error).message}`))
      .finally(() => { running = false; });
  };
  const first = setTimeout(pass, Math.min(FIRST_PASS_DELAY_MS, intervalMs));
  const every = setInterval(pass, intervalMs);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
