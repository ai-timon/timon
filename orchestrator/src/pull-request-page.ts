/**
 * The page of one pull request of a project, as the detail window of the Pull
 * requests widget shows it: GitHub's page, read only (`host/forge-pull-view.ts`),
 * and the end of a failed check's log.
 *
 * A short cache per (project, repository, number) keeps a window opened twice
 * from starting `gh` twice. It is bypassed when the caller knows the pull
 * request changed since (its `updatedAt` from the list differs: a push moved
 * its head, a comment was added) or asks for a fresh read, and dropped for a
 * project whose job moved (`integration_changed`).
 */
import { bus, type BusEvent } from './bus.js';
import { projectRepository, type ExternalPrRefusal } from './external-pr-review.js';
import { githubForge, type FailedCheckLog, type ForgeCheckLogReader } from './host/forge.js';
import {
  githubPullPageReader, type ForgePullPageReader, type PullRequestPage, type ReviewThreadsPage,
} from './host/forge-pull-view.js';

/** How long a page read is shown again without asking the forge. */
export const PAGE_CACHE_MS = 30_000;
/** Most pages kept: a person looks at a handful at a time. */
const PAGE_CACHE_SIZE = 50;

export type PullRequestPageView = PullRequestPage & {
  threads: ReviewThreadsPage['threads'];
  threadsMore: number;
  /** Why the review threads could not be read; the rest of the page still shows. */
  threadsError: string | null;
};

export type PageDeps = {
  /** Stand in for `gh` in tests: nothing in the suite reaches GitHub. */
  pageReader?: (configDir: string | null) => ForgePullPageReader;
  checkLogReader?: (configDir: string | null) => ForgeCheckLogReader;
  now?: () => number;
};

type Entry = { at: number; project: string; view: PullRequestPageView };
const cache = new Map<string, Entry>();

const keyOf = (slug: string, repo: string, number: number) => `${slug}\n${repo.toLowerCase()}\n${number}`;

function remember(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
  // A Map keeps insertion order: the first key is the oldest read.
  while (cache.size > PAGE_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

/** Forgets every page read for `project` (all of them when null). */
export function forgetPullRequestPages(project: string | null = null): void {
  if (project === null) { cache.clear(); return; }
  for (const [key, entry] of cache) if (entry.project === project) cache.delete(key);
}

export type PageOutcome = { ok: true; view: PullRequestPageView; cached: boolean } | ExternalPrRefusal;

export async function readPullRequestPage(
  slug: string, number: number, deps: PageDeps = {},
  opts: { fresh?: boolean; updatedAt?: string | null } = {},
): Promise<PageOutcome> {
  const resolved = projectRepository(slug);
  if (!resolved.ok) return resolved;
  const { repo, integration } = resolved.value;
  const now = (deps.now ?? Date.now)();
  const key = keyOf(slug, repo, number);
  const known = cache.get(key);
  if (known && !opts.fresh && now - known.at < PAGE_CACHE_MS && (!opts.updatedAt || opts.updatedAt === known.view.updatedAt)) {
    return { ok: true, view: known.view, cached: true };
  }
  const reader = (deps.pageReader ?? ((dir) => githubPullPageReader(dir)))(integration.gh_config_dir);
  const [page, threads] = await Promise.all([
    reader.pullRequestPage(repo, number),
    reader.pullRequestThreadsPage(repo, number),
  ]);
  if (!page.ok) return { ok: false, status: 502, code: 'forge_read_failed', reason: page.reason };
  const view: PullRequestPageView = {
    ...page.page,
    threads: threads.ok ? threads.value.threads : [],
    threadsMore: threads.ok ? threads.value.threadsMore : 0,
    threadsError: threads.ok ? null : threads.reason,
  };
  remember(key, { at: now, project: slug, view });
  return { ok: true, view, cached: false };
}

export type CheckLogOutcome =
  | { ok: true; log: FailedCheckLog }
  | ExternalPrRefusal
  | { ok: false; status: 422; code: 'check_log_unavailable'; reason: string };

/** The end of a failed check's log, when it is a job of the repository's own
 *  CI (`failedCheckLog` refuses any other address). */
export async function readCheckLog(slug: string, checkUrl: string, deps: PageDeps = {}): Promise<CheckLogOutcome> {
  const resolved = projectRepository(slug);
  if (!resolved.ok) return resolved;
  const { repo, integration } = resolved.value;
  const reader = (deps.checkLogReader ?? ((dir) => githubForge(dir)))(integration.gh_config_dir);
  const out = await reader.failedCheckLog(repo, checkUrl);
  if (out.ok) return out;
  if (out.code === 'not_actions') return { ok: false, status: 422, code: 'check_log_unavailable', reason: out.reason };
  return { ok: false, status: 502, code: 'forge_read_failed', reason: out.reason };
}

/** Drops a project's pages when one of its jobs moves: its pull request was
 *  opened, merged, closed or got new checks. */
export function watchPullRequestPages(): () => void {
  const onEvent = (ev: BusEvent): void => {
    if (ev.kind === 'integration_changed' && ev.project) forgetPullRequestPages(ev.project);
  };
  bus.on('event', onEvent);
  return () => { bus.off('event', onEvent); };
}
