/**
 * The landing poller (`docs/KANBAN-PR-PIPELINE.md` §2.6, step 6 of §8): learns
 * that the pull request of a Kanban job was merged, or closed without a
 * merge, and concludes its `integrations` row.
 *
 * Git decides the merge, not the forge: once `<remote>/<target>` is fetched,
 * the branch's pushed head being one of its ancestors is the merge. It holds
 * because the repository merges pull requests with a merge commit, which
 * keeps every commit of the branch. The forge (`gh pr view`) is only asked
 * what git cannot tell: a pull request closed without a merge, or merged under
 * another commit (squash, rebase), which git must still find in the target
 * before anything lands.
 *
 * Nothing is concluded on a failure: a fetch that does not answer, a `gh` that
 * fails or answers something odd leaves the row 'open' for the next pass. A
 * pass replayed changes nothing: 'merged' is final, 'closed' only comes from
 * 'open', the landing replay and the pilot's notice each happen once.
 *
 * Each pass also moves the repairs a person asked for (`landing-repair.ts`):
 * once a repair's chain integrated its work, the branch is pushed forward to
 * its pull request.
 *
 * Every network gesture goes through `host/forge.ts`; the local reads through
 * the host adapter.
 */
import { existsSync } from 'node:fs';
import { dbApi, type IntegrationRow } from './db.js';
import {
  githubForge, githubRepoFromUrl, gitTransport,
  type ForgeStateReader, type ForgeRunners, type GitTransport,
} from './host/forge.js';
import { getHost } from './host/index.js';
import type { ExecResult } from './host/types.js';
import { landIntegration } from './integration-landing.js';
import { advanceRepairs, type RepairDeps } from './landing-repair.js';
import { proposeResolutionCommentsOf } from './issue-resolution.js';
import { readProjectIntegration } from './project-integration.js';
import type { TodoClosure } from './todo-closure.js';
import { notifyIntegrationOutcome } from './wake.js';

/** Minutes, not seconds: a pull request waits for a person. */
export const POLL_INTERVAL_MS = 5 * 60_000;
/** The first pass leaves the boot alone. */
const FIRST_POLL_DELAY_MS = 60_000;

export type Notify = (integrationId: string, outcome: 'merged' | 'closed', lines: readonly string[]) => boolean;

export type PollerDeps = {
  /** Stand-ins for gh and git's network side: tests never reach a forge. */
  runners?: ForgeRunners;
  transport?: (repo: string) => GitTransport;
  forge?: (configDir: string | null) => ForgeStateReader;
  notify?: Notify;
  /** What pushing a repair reaches (`landing-repair.ts`); `runners` and
   *  `transport` above by default. */
  repairs?: RepairDeps;
};

/**
 * - `merged` / `closed`: concluded by this pass.
 * - `open`: the pull request is still waiting.
 * - `unknown`: the pass could not tell (network, gh, an unreadable
 *   repository); nothing was written but the poll time.
 */
export type PollResult = 'merged' | 'closed' | 'open' | 'unknown';

const defaultNotify: Notify = (id, outcome, lines) => notifyIntegrationOutcome(id, outcome, lines);

// ─── Local git reads ────────────────────────────────────────────────────────

async function gitRead(repo: string, args: string[]): Promise<ExecResult> {
  try {
    return await getHost().execAsync('git', ['-C', repo, ...args], { timeout: 30_000, windowsHide: true });
  } catch (err) {
    return { code: 1, stdout: '', stderr: (err as Error).message };
  }
}

const SHA = /^[0-9a-f]{40,64}$/;

async function refSha(repo: string, ref: string): Promise<string | null> {
  const r = await gitRead(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

/** `yes` / `no`, or `unknown` when git cannot tell (a commit it does not have). */
async function ancestry(repo: string, ancestor: string, descendant: string): Promise<'yes' | 'no' | 'unknown'> {
  const r = await gitRead(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return r.code === 0 ? 'yes' : r.code === 1 ? 'no' : 'unknown';
}

/**
 * The commit of the target that brought `head` in: the oldest commit of its
 * first-parent line that descends from `head`, or `head` itself when it sits
 * on that line (a fast-forward). Null when git cannot say.
 */
export async function mergeCommitOf(repo: string, head: string, target: string): Promise<string | null> {
  if (head === target) return head;
  const r = await gitRead(repo, ['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${head}..${target}`]);
  const first = r.code === 0 ? r.stdout.split('\n')[0]?.trim() ?? '' : '';
  if (!SHA.test(first)) return null;
  return (await refSha(repo, `${first}^1`)) === head ? head : first;
}

// ─── Conclusions ────────────────────────────────────────────────────────────

/** `#12 done`, `#13 partial (1/2)`: what the pilot reads of a TO DO move. */
function describeClosure(c: TodoClosure): string {
  const share = c.progress === 'partial' && c.total ? ` (${c.landed ?? 0}/${c.total})` : '';
  return `#${c.todoId} ${c.progress}${share}${c.osTest ? ', OS test owed' : ''}`;
}

/**
 * The integration `id` was merged into its target. Lands it (one replay of
 * its closures, `integration-landing.ts`), proposes the resolution comments of
 * the issues it fixed (`issue-resolution.ts`) and tells its pilot. Shared by
 * the poller and `mark-merged`; idempotent on all counts.
 */
export async function concludeMerged(id: string, mergeSha: string | null, notify: Notify = defaultNotify): Promise<void> {
  const lines: string[] = [];
  try {
    const out = await landIntegration(id, mergeSha);
    if (out.replayed) {
      lines.push(`Landing replayed on ${out.tasks} task(s): ${out.closures.length} TO DO move(s), ${out.docs} doc task(s) created.`);
      if (out.closures.length) lines.push(`TO DO ideas: ${out.closures.map(describeClosure).join(', ')}.`);
    }
  } catch (err) {
    // The row is 'merged' whatever happened next: the reconciliation replays
    // the landing, and the pilot still learns of the merge now.
    console.error(`[landing-poller] landing replay of ${id} failed: ${(err as Error).message}`);
    lines.push('The landing replay failed; the reconciliation retries it.');
  }
  // After the landing, whatever its outcome: the comments wait for a person,
  // and their keys make a second conclusion propose nothing more.
  try {
    const comments = proposeResolutionCommentsOf(id);
    if (comments.proposed > 0) lines.push(`${comments.proposed} resolution comment(s) proposed: a person publishes them.`);
  } catch (err) {
    console.error(`[landing-poller] resolution comments of ${id} not proposed: ${(err as Error).message}`);
  }
  notify(id, 'merged', lines);
}

/** The pull request of `id` was closed without a merge. */
function concludeClosed(id: string, notify: Notify): boolean {
  if (!dbApi.markIntegrationClosed(id)) return false;
  console.log(`[landing-poller] pull request of integration ${id} closed without a merge`);
  notify(id, 'closed', []);
  return true;
}

// ─── One pass ───────────────────────────────────────────────────────────────

type Target = { repo: string; remote: string; target: string };

/** Where the forge is reached for `row`: from its project's setting. */
function forgeOf(row: IntegrationRow): { configDir: string | null; repository: string } | null {
  if (!row.project || !row.pr_number) return null;
  let read;
  try { read = readProjectIntegration(row.project); } catch { return null; }
  if (read.invalid || read.integration.forge !== 'github' || !read.integration.remote_url) return null;
  const repository = githubRepoFromUrl(read.integration.remote_url);
  return repository ? { configDir: read.integration.gh_config_dir, repository } : null;
}

async function pollRow(
  row: IntegrationRow, tracking: string | null, at: Target, deps: Required<Pick<PollerDeps, 'forge' | 'notify'>>,
): Promise<PollResult> {
  dbApi.touchIntegrationPolled(row.id);
  if (!tracking) return 'unknown';

  if (row.head_sha) {
    const merged = await ancestry(at.repo, row.head_sha, tracking);
    if (merged === 'yes') {
      await concludeMerged(row.id, await mergeCommitOf(at.repo, row.head_sha, tracking), deps.notify);
      return 'merged';
    }
  }

  const where = forgeOf(row);
  if (!where) return 'unknown';
  const view = await deps.forge(where.configDir).pullRequest(where.repository, row.pr_number!);
  if (!view.ok) {
    console.warn(`[landing-poller] cannot read the pull request of ${row.branch}: ${view.reason}`);
    return 'unknown';
  }
  if (view.state === 'closed') return concludeClosed(row.id, deps.notify) ? 'closed' : 'unknown';
  if (view.state === 'merged') {
    // Merged under another commit (squash, rebase): it lands once git finds
    // that commit in the target, never on the forge's word alone.
    if (view.mergeSha && (await ancestry(at.repo, view.mergeSha, tracking)) === 'yes') {
      await concludeMerged(row.id, view.mergeSha, deps.notify);
      return 'merged';
    }
    return 'unknown';
  }
  return 'open';
}

/**
 * One pass over the open pull requests: one fetch per repository and target,
 * then each row. Also tells the pilots of rows concluded without being told
 * (a stop between the two writes). Does nothing, and reaches nothing, when no
 * pull request is open.
 */
export async function pollOpenIntegrations(deps: PollerDeps = {}): Promise<Map<string, PollResult>> {
  const notify = deps.notify ?? defaultNotify;
  const results = new Map<string, PollResult>();
  for (const row of dbApi.listUnnotifiedIntegrations()) {
    try {
      notify(row.id, row.state as 'merged' | 'closed', []);
    } catch (err) {
      console.error(`[landing-poller] notice of ${row.branch} failed: ${(err as Error).message}`);
    }
  }

  // Repairs first: a pushed one moves the head the merge is compared with.
  try {
    await advanceRepairs(deps.repairs ?? {
      ...(deps.runners ? { runners: deps.runners } : {}),
      ...(deps.transport ? { transport: deps.transport } : {}),
    });
  } catch (err) {
    console.error(`[landing-poller] repairs: ${(err as Error).message}`);
  }

  const open = dbApi.listOpenIntegrations();
  if (open.length === 0) return results;
  const forge = deps.forge ?? ((dir) => githubForge(dir, deps.runners));
  const transport = deps.transport ?? ((repo) => gitTransport(repo, deps.runners));

  const groups = new Map<string, { at: Target; rows: IntegrationRow[] }>();
  for (const row of open) {
    const key = `${row.repo}\0${row.remote}\0${row.target}`;
    const group = groups.get(key) ?? { at: { repo: row.repo, remote: row.remote, target: row.target }, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  for (const { at, rows } of groups.values()) {
    let tracking: string | null = null;
    if (existsSync(at.repo)) {
      const into = `refs/remotes/${at.remote}/${at.target}`;
      const fetched = await transport(at.repo).fetchBranch(at.remote, at.target, into);
      if (fetched.ok) tracking = await refSha(at.repo, into);
      else console.warn(`[landing-poller] cannot fetch ${at.remote}/${at.target}: ${fetched.reason}`);
    }
    for (const row of rows) {
      try {
        results.set(row.id, await pollRow(row, tracking, at, { forge, notify }));
      } catch (err) {
        console.error(`[landing-poller] ${row.branch}: ${(err as Error).message}`);
        results.set(row.id, 'unknown');
      }
    }
  }
  return results;
}

/** Arms the poller; returns its stop. One pass at a time. */
export function startIntegrationPoller(intervalMs: number = POLL_INTERVAL_MS, deps: PollerDeps = {}): () => void {
  let running = false;
  const pass = (): void => {
    if (running) return;
    running = true;
    pollOpenIntegrations(deps)
      .catch((err) => console.error(`[landing-poller] pass failed: ${(err as Error).message}`))
      .finally(() => { running = false; });
  };
  const first = setTimeout(pass, Math.min(FIRST_POLL_DELAY_MS, intervalMs));
  const every = setInterval(pass, intervalMs);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
