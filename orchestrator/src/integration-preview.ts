/**
 * What a person reads about a Kanban job that lands through a pull request
 * (`docs/KANBAN-PR-PIPELINE.md` §8, step 7): the state of its integration
 * branch and pull request, the forge's checks, and a preview of what the pull
 * request would carry before anything is pushed.
 *
 * Three reads, none of which moves the job:
 *
 * - **The view** of an `integrations` row, from the database only.
 * - **The checks** of an open pull request, read from the forge on demand
 *   (the island asks about once a minute while a check runs) and kept in the
 *   row's `checks` column. Asking again within `CHECKS_MIN_INTERVAL_MS`
 *   answers the stored copy: several open windows cost one forge call. The
 *   landing poller (5 min) stays the only one to conclude a merge or a close.
 * - **The preview**: commits and diff of the branch against its target as
 *   last fetched, a conflict probe, and the pull request's pre-checks run dry
 *   (`runPrChecks` with `dryRun`): no fetch, no push, no `gh pr create`, no
 *   script of the repository, nothing written in the database.
 *
 * Local git goes through the host adapter, whose git runs nothing a mission
 * could have configured (`host/git-neutral.ts`); the forge through
 * `host/forge.ts`, whose answers never carry a token.
 */
import { z } from 'zod';
import { dbApi, type IntegrationRow } from './db.js';
import {
  githubForge, githubRepoFromUrl, gitTransport,
  MERGE_STATE_STATUSES,
  type Forge, type ForgeChecksReader, type ForgeRunners, type ForgeThreadsReader, type GitTransport,
  type PullRequestCheck, type PullRequestChecks,
} from './host/forge.js';
import { getHost } from './host/index.js';
import type { ExecResult } from './host/types.js';
import { pullRequestSetting, runPrChecks, type PrCheck } from './pr-open.js';
import { readProjectIntegration } from './project-integration.js';
import type { DbViewer } from './users/owned.js';
import { integrationVisibleTo } from './integration-visibility.js';

export { integrationVisibleTo };

/** The island asks every 60 s; a little less here, so its own call is never
 *  the one answered from the stored copy. */
export const CHECKS_MIN_INTERVAL_MS = 55_000;

export const PREVIEW_LIMITS = {
  commits: 200,
  files: 300,
  /** Characters of patch per file, and for the whole diff. */
  filePatch: 64_000,
  totalPatch: 400_000,
  conflictFiles: 50,
} as const;

// ─── Stored checks ──────────────────────────────────────────────────────────

const CheckSchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'fail', 'pending', 'skipped']),
  url: z.string().nullable(),
});

const StoredChecksSchema = z.object({
  read_at: z.number(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  review: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
  title: z.string(),
  body: z.string(),
  items: z.array(CheckSchema),
  // Read since the pull request reader grew: a copy stored before has none.
  merge_state: z.enum(MERGE_STATE_STATUSES).default('unknown'),
  labels: z.array(z.object({ name: z.string(), color: z.string().nullable() })).default([]),
  closing_issues: z.array(z.object({ repo: z.string().nullable(), number: z.number(), url: z.string().nullable() })).default([]),
  /** Review threads nobody resolved; null when the forge could not say. */
  unresolved_threads: z.number().nullable().default(null),
});

export type StoredChecks = z.infer<typeof StoredChecksSchema>;

export type ChecksCounts = { pass: number; fail: number; pending: number; skipped: number };

/** The `checks` column, or null when empty or not written by this module. */
export function parseStoredChecks(raw: string | null): StoredChecks | null {
  if (!raw) return null;
  try {
    const parsed = StoredChecksSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function countChecks(items: readonly PullRequestCheck[]): ChecksCounts {
  const counts: ChecksCounts = { pass: 0, fail: 0, pending: 0, skipped: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function storedFrom(view: PullRequestChecks, unresolvedThreads: number | null, now: number): StoredChecks {
  return {
    read_at: now,
    state: view.state,
    draft: view.draft,
    mergeable: view.mergeable,
    review: view.review,
    title: view.title,
    body: view.body,
    items: view.checks,
    merge_state: view.mergeStateStatus,
    labels: view.labels,
    closing_issues: view.closingIssues,
    unresolved_threads: unresolvedThreads,
  };
}

// ─── The view ───────────────────────────────────────────────────────────────

export type IntegrationChecksView = {
  read_at: number;
  draft: boolean;
  mergeable: StoredChecks['mergeable'];
  review: StoredChecks['review'];
  counts: ChecksCounts;
  items: StoredChecks['items'];
  /** `behind` asks for a branch update, `dirty` is a conflict. */
  merge_state: StoredChecks['merge_state'];
  labels: StoredChecks['labels'];
  /** The issues the forge will close at the merge, as the description says. */
  closing_issues: StoredChecks['closing_issues'];
  unresolved_threads: StoredChecks['unresolved_threads'];
};

/** One job's landing, without the repository's path. */
export type IntegrationView = {
  id: string;
  project: string | null;
  series_id: string | null;
  branch: string;
  remote: string;
  target: string;
  mode: string;
  state: IntegrationRow['state'];
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  merge_sha: string | null;
  landed: boolean;
  created_at: number;
  updated_at: number;
  checks: IntegrationChecksView | null;
  /** From the forge's mergeability; null while unknown or before a PR. */
  conflict: boolean | null;
  /** A check still runs: the island keeps asking while this is true. */
  checks_running: boolean;
  /** Title of the pull request, as the forge last answered it. */
  pr_title: string | null;
};

export function integrationView(row: IntegrationRow): IntegrationView {
  const stored = parseStoredChecks(row.checks);
  const checks: IntegrationChecksView | null = stored
    ? {
        read_at: stored.read_at,
        draft: stored.draft,
        mergeable: stored.mergeable,
        review: stored.review,
        counts: countChecks(stored.items),
        items: stored.items,
        merge_state: stored.merge_state,
        labels: stored.labels,
        closing_issues: stored.closing_issues,
        unresolved_threads: stored.unresolved_threads,
      }
    : null;
  const open = row.state === 'open';
  return {
    id: row.id,
    project: row.project,
    series_id: row.series_id,
    branch: row.branch,
    remote: row.remote,
    target: row.target,
    mode: row.mode,
    state: row.state,
    pr_number: row.pr_number,
    pr_url: row.pr_url,
    head_sha: row.head_sha,
    merge_sha: row.merge_sha,
    landed: row.landed_at !== null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    checks,
    conflict: open && stored && stored.mergeable !== 'unknown' ? stored.mergeable === 'conflicting' : null,
    checks_running: open && !!checks && checks.counts.pending > 0,
    pr_title: stored?.title || null,
  };
}

/** `todo`: the jobs of one idea, oldest first, the way its badge finds them. */
export type IntegrationFilter = { project?: string; series?: string; todo?: number };

function integrationsOfTodo(todoId: number, viewer: DbViewer | null): IntegrationRow[] {
  // An idea the caller cannot see has no jobs: the answer must not tell it exists.
  if (!viewer || !dbApi.getProjectTodo(todoId, viewer)) return [];
  const ids = [...new Set(dbApi.listTodoIntegrations([todoId], viewer).map((r) => r.id))];
  return ids.map((id) => dbApi.getIntegrationById(id)).filter((r): r is IntegrationRow => !!r)
    .sort((a, b) => a.created_at - b.created_at);
}

export function listIntegrationViews(filter: IntegrationFilter, viewer: DbViewer | null): IntegrationView[] {
  let rows: IntegrationRow[];
  if (filter.todo !== undefined) {
    rows = integrationsOfTodo(filter.todo, viewer);
    if (filter.series) rows = rows.filter((r) => r.series_id === filter.series);
  } else if (filter.series) rows = dbApi.listIntegrationsBySeries(filter.series);
  else if (filter.project) rows = dbApi.listIntegrationsByProject(filter.project);
  else rows = dbApi.listRecentIntegrations();
  if (filter.project) rows = rows.filter((r) => r.project === filter.project);
  return rows.filter((r) => integrationVisibleTo(viewer, r)).map(integrationView);
}

// ─── Checks refresh ─────────────────────────────────────────────────────────

export type PreviewDeps = {
  /** Stand-ins for gh and git's network side: tests never reach a forge. */
  runners?: ForgeRunners;
  forge?: (configDir: string | null) => Forge & ForgeChecksReader & ForgeThreadsReader;
  transport?: (repo: string) => GitTransport;
  now?: () => number;
};

export type ChecksRefreshOutcome =
  | { ok: true; integration: IntegrationView; fresh: boolean }
  | { ok: false; code: 'checks_not_applicable' | 'checks_unavailable'; reason: string };

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+$/;

const inFlight = new Map<string, Promise<ChecksRefreshOutcome>>();

/** Reads the checks of the job's open pull request from the forge, at most
 *  once per `CHECKS_MIN_INTERVAL_MS`; concurrent askers share one call. */
export function refreshIntegrationChecks(row: IntegrationRow, deps: PreviewDeps = {}): Promise<ChecksRefreshOutcome> {
  const running = inFlight.get(row.id);
  if (running) return running;
  const call = readChecks(row, deps).finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, call);
  return call;
}

async function readChecks(row: IntegrationRow, deps: PreviewDeps): Promise<ChecksRefreshOutcome> {
  const now = (deps.now ?? Date.now)();
  if (row.state !== 'open' || row.pr_number === null) {
    return { ok: false, code: 'checks_not_applicable', reason: 'the job has no open pull request' };
  }
  const stored = parseStoredChecks(row.checks);
  if (stored && now - stored.read_at < CHECKS_MIN_INTERVAL_MS) {
    return { ok: true, integration: integrationView(row), fresh: false };
  }
  if (!row.project) return { ok: false, code: 'checks_unavailable', reason: 'the job belongs to no project' };
  let read;
  try { read = readProjectIntegration(row.project); } catch (err) {
    return { ok: false, code: 'checks_unavailable', reason: (err as Error).message };
  }
  if (read.invalid) return { ok: false, code: 'checks_unavailable', reason: 'the project\'s integration setting is invalid' };
  // The pull request's own address names its repository, whatever the setting
  // says today; the setting's push URL is the fallback.
  const repository = PR_URL.exec(row.pr_url ?? '')?.[1]
    ?? (read.integration.remote_url ? githubRepoFromUrl(read.integration.remote_url) : null);
  if (!repository) return { ok: false, code: 'checks_unavailable', reason: 'no GitHub repository is known for this pull request' };
  const forge = (deps.forge ?? ((dir) => githubForge(dir, deps.runners)))(read.integration.gh_config_dir);
  const out = await forge.pullRequestChecks(repository, row.pr_number);
  if (!out.ok) return { ok: false, code: 'checks_unavailable', reason: out.reason };
  // The threads are a second call: their failure leaves the checks readable.
  const threads = out.view.state === 'open' ? await forge.pullRequestReviewThreads(repository, row.pr_number) : null;
  const unresolved = threads?.ok ? threads.unresolved : null;
  dbApi.setIntegrationChecks(row.id, JSON.stringify(storedFrom(out.view, unresolved, now)));
  const fresh = dbApi.getIntegrationById(row.id) ?? row;
  return { ok: true, integration: integrationView(fresh), fresh: true };
}

// ─── Preview ────────────────────────────────────────────────────────────────

export type PreviewCommit = { sha: string; short: string; author: string; subject: string };

export type PreviewFile = {
  path: string;
  /** null for a binary file. */
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** null when the budget was spent before this file, or the diff unreadable. */
  patch: string | null;
  patch_truncated: boolean;
};

export type PreviewPrechecks =
  | { ran: true; ready: boolean; checks: PrCheck[] }
  | { ran: false; reason: string };

export type IntegrationPreview = {
  integration: IntegrationView;
  head_sha: string | null;
  target_sha: string | null;
  /** Why the branch could not be compared, when it could not. */
  problem: string | null;
  commit_count: number;
  commits: PreviewCommit[];
  commits_truncated: boolean;
  files: PreviewFile[];
  files_truncated: boolean;
  patch_truncated: boolean;
  totals: { files: number; additions: number; deletions: number };
  conflict: { state: 'clean' | 'conflicting' | 'unknown'; files: string[] };
  /** The text the pull request carries, or would: the caller's draft, else
   *  what the forge last answered. */
  pull_request: { title: string; body: string } | null;
  prechecks: PreviewPrechecks;
};

export type PreviewRequest = { title?: string; body?: string; prechecks: boolean };

async function gitRead(repo: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<ExecResult> {
  try {
    return await getHost().execAsync('git', ['-C', repo, ...args], { timeout: 30_000, windowsHide: true, maxBuffer });
  } catch (err) {
    return { code: 1, stdout: '', stderr: (err as Error).message };
  }
}

async function refSha(repo: string, ref: string): Promise<string | null> {
  const r = await gitRead(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

async function readCommits(repo: string, range: string): Promise<{ count: number; commits: PreviewCommit[] } | null> {
  const count = await gitRead(repo, ['rev-list', '--count', range]);
  const total = count.code === 0 ? Number(count.stdout.trim()) : NaN;
  if (!Number.isFinite(total)) return null;
  const log = await gitRead(repo, [
    'log', '--no-color', `--max-count=${PREVIEW_LIMITS.commits}`, `--format=%H${FIELD}%h${FIELD}%an${FIELD}%s${RECORD}`, range,
  ]);
  if (log.code !== 0) return null;
  const commits = log.stdout.split(RECORD)
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.length > 0)
    .map((rec) => {
      const [sha = '', short = '', author = '', subject = ''] = rec.split(FIELD);
      return { sha, short, author, subject };
    });
  return { count: total, commits };
}

type NumstatEntry = { path: string; additions: number | null; deletions: number | null };

function parseNumstat(stdout: string): NumstatEntry[] {
  return stdout.split('\0').filter(Boolean).map((entry) => {
    const [added = '-', deleted = '-', ...rest] = entry.split('\t');
    const path = rest.join('\t');
    return {
      path,
      additions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
    };
  }).filter((e) => e.path.length > 0);
}

/** The patch cut in one piece per file, in the order git printed them. */
export function splitPatch(patch: string): string[] {
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) parts.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) parts.push(current.join('\n').replace(/\n$/, ''));
  return parts;
}

/** Cuts at the last line break before `max`, so a hunk line is never split. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const at = text.lastIndexOf('\n', max);
  return text.slice(0, at > 0 ? at : max);
}

async function readDiff(repo: string, range3: string): Promise<{
  files: PreviewFile[]; filesTruncated: boolean; patchTruncated: boolean; totals: IntegrationPreview['totals'];
} | null> {
  const stat = await gitRead(repo, ['diff', '--numstat', '-z', '--no-renames', range3]);
  if (stat.code !== 0) return null;
  const entries = parseNumstat(stat.stdout);
  const totals = {
    files: entries.length,
    additions: entries.reduce((n, e) => n + (e.additions ?? 0), 0),
    deletions: entries.reduce((n, e) => n + (e.deletions ?? 0), 0),
  };
  const shown = entries.slice(0, PREVIEW_LIMITS.files);
  // Twice the budget: what git prints beyond it is never shown anyway, and an
  // output cut by the buffer is still read up to where it stopped.
  const patch = await gitRead(
    repo,
    ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', range3],
    PREVIEW_LIMITS.totalPatch * 2,
  );
  const overflow = patch.code !== 0 && /maxBuffer/i.test(patch.stderr);
  const pieces = patch.code === 0 || overflow ? splitPatch(patch.stdout) : [];
  let budget = PREVIEW_LIMITS.totalPatch;
  let patchTruncated = overflow;
  const files = shown.map((entry, i): PreviewFile => {
    const binary = entry.additions === null && entry.deletions === null;
    const piece = pieces[i];
    // The last piece of a cut output is incomplete.
    const partial = overflow && i === pieces.length - 1;
    if (piece === undefined || budget <= 0) {
      if (piece !== undefined || overflow) patchTruncated = true;
      return { ...entry, binary, patch: null, patch_truncated: piece !== undefined || overflow };
    }
    const limit = Math.min(PREVIEW_LIMITS.filePatch, budget);
    const text = cut(piece, limit);
    budget -= text.length;
    const truncated = partial || text.length < piece.length;
    if (truncated) patchTruncated = true;
    return { ...entry, binary, patch: text, patch_truncated: truncated };
  });
  return { files, filesTruncated: entries.length > shown.length, patchTruncated, totals };
}

/** Would the branch merge into the target? Computed in memory by git
 *  (`merge-tree --write-tree`): no working tree, no ref moved. */
export async function readConflict(repo: string, target: string, head: string): Promise<IntegrationPreview['conflict']> {
  const r = await gitRead(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, head]);
  if (r.code === 0) return { state: 'clean', files: [] };
  if (r.code !== 1) return { state: 'unknown', files: [] };
  // First line: the tree; then the conflicted paths.
  const files = [...new Set(r.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))];
  return { state: 'conflicting', files: files.slice(0, PREVIEW_LIMITS.conflictFiles) };
}

function chainIdsOf(row: IntegrationRow): string[] {
  const ids = new Set<string>();
  if (row.series_id) {
    ids.add(row.series_id);
    for (const t of dbApi.listTasksBySeries(row.series_id)) ids.add(t.id);
  }
  for (const t of dbApi.listTasksByBaseBranch(row.branch)) ids.add(t.id);
  return [...ids];
}

async function dryRun(row: IntegrationRow, title: string, body: string, deps: PreviewDeps): Promise<PreviewPrechecks> {
  if (row.branch.startsWith('sec/') || row.mode === 'branch') {
    return { ran: false, reason: `${row.branch} is under embargo or lands by hand: Timon never pushes it` };
  }
  if (row.state !== 'branch') return { ran: false, reason: `the pull request is already ${row.state}` };
  const resolved = pullRequestSetting(row, row.project);
  if ('refusal' in resolved) return { ran: false, reason: resolved.refusal };
  const forge = (deps.forge ?? ((dir) => githubForge(dir, deps.runners)))(resolved.setting.gh_config_dir);
  const transport = (deps.transport ?? ((r) => gitTransport(r, deps.runners)))(row.repo);
  const { checks } = await runPrChecks({
    row,
    chainIds: chainIdsOf(row),
    remoteUrl: resolved.remoteUrl,
    account: resolved.account,
    forge,
    transport,
    title,
    body,
    // Never called in a dry run: the repository's own script does not run.
    publicTree: async () => ({ ran: false }),
    dryRun: true,
  });
  return { ran: true, ready: checks.every((c) => c.ok), checks };
}

/** Commits, diff, conflict and dry pre-checks of a job's integration branch. */
export async function previewIntegration(
  row: IntegrationRow, request: PreviewRequest, deps: PreviewDeps = {},
): Promise<IntegrationPreview> {
  const repo = row.repo;
  const head = await refSha(repo, `refs/heads/${row.branch}`);
  // A job of a project that merges locally has no remote: its target is the
  // local branch.
  const target = await refSha(repo, row.remote ? `refs/remotes/${row.remote}/${row.target}` : `refs/heads/${row.target}`);
  const stored = parseStoredChecks(row.checks);
  const draft = request.title?.trim()
    ? { title: request.title, body: request.body ?? '' }
    : stored ? { title: stored.title, body: stored.body } : null;
  const prechecks: PreviewPrechecks = request.prechecks
    ? await dryRun(row, request.title ?? '', request.body ?? '', deps)
    : { ran: false, reason: 'the pre-checks need the projects:manage permission' };

  const empty = {
    commit_count: 0, commits: [], commits_truncated: false,
    files: [], files_truncated: false, patch_truncated: false,
    totals: { files: 0, additions: 0, deletions: 0 },
    conflict: { state: 'unknown' as const, files: [] },
  };
  const base = { integration: integrationView(row), head_sha: head, target_sha: target, pull_request: draft, prechecks };
  if (!head || !target) {
    const problem = !head
      ? `${row.branch} does not exist in the repository`
      : row.remote
        ? `${row.remote}/${row.target} was never fetched into the repository`
        : `${row.target} does not exist in the repository`;
    return { ...base, ...empty, problem };
  }
  const commits = await readCommits(repo, `${target}..${head}`);
  const diff = await readDiff(repo, `${target}...${head}`);
  const conflict = await readConflict(repo, target, head);
  if (!commits || !diff) return { ...base, ...empty, conflict, problem: 'git could not compare the branch with its target' };
  return {
    ...base,
    problem: null,
    commit_count: commits.count,
    commits: commits.commits,
    commits_truncated: commits.count > commits.commits.length,
    files: diff.files,
    files_truncated: diff.filesTruncated,
    patch_truncated: diff.patchTruncated,
    totals: diff.totals,
    conflict,
  };
}
