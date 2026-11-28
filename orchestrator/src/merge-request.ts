/**
 * The merge request (GitLab) or pull request (GitHub) a task carries as data,
 * so a card can show it as a chip instead of a URL buried in free text.
 *
 * The agent sends a URL, and at most a state and a pipeline: the forge and the
 * number come from the URL, which a client cannot contradict. The URL is shown
 * and opened in a browser, so only `http(s)` is accepted.
 */
import { z } from 'zod';

export const MERGE_REQUEST_STATES = ['open', 'merged', 'closed'] as const;
export type MergeRequestState = (typeof MERGE_REQUEST_STATES)[number];
export type MergeRequestForge = 'github' | 'gitlab';

/** What is stored on the task row; every column is null when no request is known. */
export interface MergeRequestRef {
  url: string;
  forge: MergeRequestForge;
  number: number;
  state: MergeRequestState;
  pipeline: string | null;
}

export const MergeRequestInput = z.object({
  url: z.string().trim().min(1).max(2048),
  state: z.enum(MERGE_REQUEST_STATES).optional(),
  /** Free label (`success`, `running`, `failed`…): forges name their statuses differently. */
  pipeline: z.string().trim().max(64).nullable().optional(),
}).strict();

export type MergeRequestInputT = z.infer<typeof MergeRequestInput>;

// The first group is the canonical path, cut at the number (`/diffs` and the like dropped).
const GITHUB_PULL = /^(\/[^/]+\/[^/]+\/pull\/(\d+))(?:\/.*)?$/;
const GITLAB_MERGE = /^(.*\/merge_requests\/(\d+))(?:\/.*)?$/;

/** The forge and number a URL designates, or null when it is neither a pull nor a merge request. */
export function parseMergeRequestUrl(raw: string): { url: string; forge: MergeRequestForge; number: number } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // A token in the URL would be stored and displayed: refuse the whole value.
  if (url.username || url.password) return null;
  const github = GITHUB_PULL.exec(url.pathname);
  if (github && /(^|\.)github\.com$/i.test(url.hostname)) {
    return { url: `${url.origin}${github[1]}`, forge: 'github', number: Number(github[2]) };
  }
  const gitlab = GITLAB_MERGE.exec(url.pathname);
  if (gitlab) return { url: `${url.origin}${gitlab[1]}`, forge: 'gitlab', number: Number(gitlab[2]) };
  return null;
}

/** The reference to store, or the text of the refusal. `previous` keeps the state when none is sent. */
export function resolveMergeRequest(
  input: MergeRequestInputT,
  previous?: MergeRequestRef | null,
): { ok: true; ref: MergeRequestRef } | { ok: false; error: string } {
  const parsed = parseMergeRequestUrl(input.url);
  if (!parsed) {
    return { ok: false, error: 'merge_request.url must be the https URL of a GitHub pull request or a GitLab merge request' };
  }
  const same = previous?.url === parsed.url;
  return {
    ok: true,
    ref: {
      ...parsed,
      state: input.state ?? (same ? previous.state : 'open'),
      pipeline: input.pipeline !== undefined ? (input.pipeline || null) : (same ? previous.pipeline : null),
    },
  };
}

/** The reference a task row carries, or null. */
export function mergeRequestOf(task: {
  mr_url?: string | null; mr_forge?: string | null; mr_number?: number | null;
  mr_state?: string | null; mr_pipeline?: string | null;
}): MergeRequestRef | null {
  if (!task.mr_url || (task.mr_forge !== 'github' && task.mr_forge !== 'gitlab') || !task.mr_number) return null;
  const state = (MERGE_REQUEST_STATES as readonly string[]).includes(task.mr_state ?? '') ? task.mr_state as MergeRequestState : 'open';
  return { url: task.mr_url, forge: task.mr_forge, number: task.mr_number, state, pipeline: task.mr_pipeline ?? null };
}
