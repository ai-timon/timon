/**
 * `timon pr open`: the daemon opens the pull request of a Kanban job whose
 * chain lands through one (`docs/KANBAN-PR-PIPELINE.md` §2.5, step 5 of §8).
 *
 * The agent writes the title and the description; every gesture that reaches
 * the forge is the daemon's, after checks an agent cannot skip. They fail
 * closed: a check that cannot answer (no network, no gh, an unreadable
 * repository) refuses the same way a check that answers "no" does, and nothing
 * is pushed until every one of them passed.
 *
 * The account, the remote and its push URL come from the project's setting,
 * never from the request: the caller names the job, nothing else.
 *
 * A branch under embargo (`sec/…`) is never pushed from here, whatever its
 * setting says: it lands by hand once the advisory is out.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './agent.js';
import { config } from './config/load.js';
import { dbApi, type IntegrationRow, type TaskRow } from './db.js';
import { integrationBranchRefusal } from './git-integration.js';
import {
  githubForge, githubRepoFromUrl, gitTransport, redactedOutput,
  type Forge, type ForgeRunners, type GitTransport, type PullRequestRef,
} from './host/forge.js';
import { getHost } from './host/index.js';
import { nodeRuntime } from './host/node-runtime.js';
import type { ExecResult } from './host/types.js';
import { readProjectIntegration, type ProjectIntegration } from './project-integration.js';
import { issueLines, jobIssueClosings, pullRequestBody } from './issue-closing.js';

export const PR_CHECKS = [
  'branch_name',
  'account',
  'remote_url',
  'target',
  'commits',
  'commit_identity',
  'commit_messages',
  'pr_text',
  'private_paths',
  'public_tree',
  'remote_branch',
] as const;
export type PrCheckName = (typeof PR_CHECKS)[number];

/** One pre-check: `ok` false refuses the pull request; `skipped` says a
 *  check that does not apply here, and why, without refusing. */
export type PrCheck = { name: PrCheckName; ok: boolean; skipped?: boolean; detail: string };

export type PrOpenRequest = {
  /** What `id` names: a task of the job, its series, or its integration row
   *  (the landing gesture of the board, `integration-land.ts`). */
  target: 'task' | 'series' | 'integration';
  id: string;
  title: string;
  body: string;
};

export type PrOpenRefusalCode =
  | 'pr_target_not_found'
  | 'pr_refused'
  | 'pr_open_busy'
  | 'pr_precheck_failed'
  | 'pr_push_failed'
  | 'pr_create_failed';

export type PrOpenOutcome =
  | {
      ok: true;
      pr: PullRequestRef;
      /** True when the forge already had this pull request open. */
      existing: boolean;
      branch: string;
      target: string;
      repository: string;
      head_sha: string;
      checks: PrCheck[];
      /** `Fixes owner/repo#n` / `Refs owner/repo#n` the daemon added to the description. */
      issues: string[];
    }
  | { ok: false; status: number; code: PrOpenRefusalCode; reason: string; checks?: PrCheck[] };

export type PublicTreeOutcome =
  | { ran: false }
  | { ran: true; ok: boolean; summary: string };

export type PrOpenDeps = {
  /** Stand-ins for gh and git's network side: tests never reach a forge. */
  runners?: ForgeRunners;
  forge?: (configDir: string | null) => Forge;
  transport?: (repo: string) => GitTransport;
  /** Stand-in for the repository's own public tree check. */
  publicTree?: (repo: string, branch: string) => Promise<PublicTreeOutcome>;
  agentCwd?: (agentName: string) => string | null;
};

// ─── Text rules ─────────────────────────────────────────────────────────────

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const TODO_NUMBER = /\bTODO\s*#?\s*\d+/i;
const ATTRIBUTION = /^\s*co-authored-by:|generated (?:with|by) |\u{1F916}/imu;

/**
 * What in `text` must not reach a public repository: a task or mission id (in
 * full, or the short form of one of `chainIds`), an internal TODO number, and,
 * with `attribution`, a line crediting a tool.
 */
export function leakProblems(text: string, chainIds: readonly string[], opts: { attribution?: boolean } = {}): string[] {
  const found: string[] = [];
  if (UUID.test(text)) found.push('a task or mission id');
  else {
    const lower = text.toLowerCase();
    const short = chainIds.map((id) => id.slice(0, 8).toLowerCase()).filter((s) => /^[0-9a-f]{8}$/.test(s));
    if (short.some((s) => new RegExp(`(?:^|[^0-9a-z])${s}`).test(lower))) found.push('a task id');
  }
  if (TODO_NUMBER.test(text)) found.push('an internal TODO number');
  if (opts.attribution && ATTRIBUTION.test(text)) found.push('an attribution line');
  return found;
}

// ─── Local git reads ────────────────────────────────────────────────────────

async function gitRead(repo: string, args: string[]): Promise<ExecResult> {
  try {
    return await getHost().execAsync('git', ['-C', repo, ...args], { timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    return { code: 1, stdout: '', stderr: (err as Error).message };
  }
}

async function refSha(repo: string, ref: string): Promise<string | null> {
  const r = await gitRead(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await gitRead(repo, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

/** Same remote whatever the ending: a trailing `/` or `.git` does not count. */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string): string => u.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  return norm(a) === norm(b);
}

// ─── Resolution ─────────────────────────────────────────────────────────────

function defaultAgentCwd(agentName: string): string | null {
  try { return loadConfig(agentName).cwd ?? null; } catch { return null; }
}

type Resolved = { row: IntegrationRow; chainIds: string[]; project: string | null };
type Refusal = Extract<PrOpenOutcome, { ok: false }>;

function refuse(status: number, code: PrOpenRefusalCode, reason: string, checks?: PrCheck[]): Refusal {
  return { ok: false, status, code, reason, ...(checks ? { checks } : {}) };
}

function chainIdsOf(seriesId: string | null, extra: string[]): string[] {
  const ids = new Set(extra);
  if (seriesId) for (const t of dbApi.listTasksBySeries(seriesId)) ids.add(t.id);
  return [...ids];
}

function resolveFromTask(task: TaskRow, agentCwd: (name: string) => string | null): Resolved | Refusal {
  if (task.integration_mode !== 'pr') {
    return task.integration_mode === 'branch'
      ? refuse(409, 'pr_refused', 'this job lands by hand (integration mode "branch"): Timon never pushes its branch')
      : refuse(409, 'pr_refused', 'this job does not land through a pull request (integration mode "local")');
  }
  const branch = task.base_branch;
  if (!branch) return refuse(409, 'pr_refused', 'the task has no integration branch yet: dispatch the job first');
  const repo = agentCwd(task.agent_name);
  if (!repo) return refuse(409, 'pr_refused', `the folder of agent ${task.agent_name} is unknown`);
  const row = dbApi.getIntegration(repo, branch);
  if (!row) return refuse(409, 'pr_refused', `${branch} was never created by Timon: dispatch the job first`);
  return { row, chainIds: chainIdsOf(task.series_id, [task.id]), project: row.project ?? task.project };
}

function resolveFromSeries(seriesId: string): Resolved | Refusal {
  const rows = dbApi.listIntegrationsBySeries(seriesId);
  if (rows.length === 0) return refuse(404, 'pr_target_not_found', 'no series with an integration branch has this id');
  if (rows.length > 1) {
    return refuse(409, 'pr_refused', `the series has several integration branches (${rows.map((r) => r.branch).join(', ')}): name one of its tasks`);
  }
  const row = rows[0]!;
  return { row, chainIds: chainIdsOf(seriesId, [seriesId]), project: row.project };
}

function resolveFromIntegration(id: string): Resolved | Refusal {
  const row = dbApi.getIntegrationById(id);
  if (!row) return refuse(404, 'pr_target_not_found', 'no job with an integration branch has this id');
  const onBranch = dbApi.listTasksByBaseBranch(row.branch)
    .filter((t) => !row.project || t.project === row.project).map((t) => t.id);
  return { row, chainIds: chainIdsOf(row.series_id, row.series_id ? [row.series_id, ...onBranch] : onBranch), project: row.project };
}

// ─── Checks ─────────────────────────────────────────────────────────────────

async function checkAccount(forge: Forge, account: string): Promise<PrCheck> {
  const out = await forge.login();
  if (!out.ok) return { name: 'account', ok: false, detail: `cannot tell which account gh signs in as: ${out.reason}` };
  // GitHub logins ignore case.
  return out.login.toLowerCase() === account.toLowerCase()
    ? { name: 'account', ok: true, detail: `gh signs in as ${out.login}` }
    : { name: 'account', ok: false, detail: `gh signs in as ${out.login}, the project expects ${account}` };
}

async function checkRemoteUrl(repo: string, remote: string, expected: string): Promise<PrCheck> {
  const r = await gitRead(repo, ['remote', 'get-url', '--push', '--', remote]);
  if (r.code !== 0) return { name: 'remote_url', ok: false, detail: `the repository has no remote ${remote}` };
  return sameUrl(r.stdout, expected)
    ? { name: 'remote_url', ok: true, detail: `${remote} pushes to the expected URL` }
    : { name: 'remote_url', ok: false, detail: `${remote} does not push to the URL the project expects` };
}

async function repositoryIdentity(repo: string): Promise<{ name: string; email: string } | null> {
  const name = (await gitRead(repo, ['config', '--get', 'user.name'])).stdout.trim();
  const email = (await gitRead(repo, ['config', '--get', 'user.email'])).stdout.trim();
  return name && email ? { name, email } : null;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

async function commitRecords(repo: string, range: string, format: string): Promise<string[][] | null> {
  const r = await gitRead(repo, ['log', '--no-color', `--format=${format}${RECORD}`, range]);
  if (r.code !== 0) return null;
  return r.stdout.split(RECORD).map((rec) => rec.replace(/^\n/, '')).filter((rec) => rec.length > 0).map((rec) => rec.split(FIELD));
}

async function checkIdentity(repo: string, range: string): Promise<PrCheck> {
  const expected = await repositoryIdentity(repo);
  if (!expected) return { name: 'commit_identity', ok: false, detail: 'the repository configures no user.name and user.email to compare the commits with' };
  const records = await commitRecords(repo, range, ['%h', '%an', '%ae', '%cn', '%ce'].join(FIELD));
  if (!records) return { name: 'commit_identity', ok: false, detail: 'cannot read the commits of the branch' };
  const wrong = records.filter(([, an, ae, cn, ce]) => an !== expected.name || ae !== expected.email || cn !== expected.name || ce !== expected.email);
  if (wrong.length === 0) return { name: 'commit_identity', ok: true, detail: `every commit is by ${expected.name} <${expected.email}>` };
  const shown = wrong.slice(0, 5).map(([h]) => h).join(', ');
  return {
    name: 'commit_identity',
    ok: false,
    detail: `${wrong.length} commit(s) not authored and committed as ${expected.name} <${expected.email}> (${shown}); a branch is never rewritten here`,
  };
}

async function checkMessages(repo: string, range: string, chainIds: readonly string[]): Promise<PrCheck> {
  const records = await commitRecords(repo, range, ['%h', '%B'].join(FIELD));
  if (!records) return { name: 'commit_messages', ok: false, detail: 'cannot read the commit messages of the branch' };
  const bad: string[] = [];
  for (const [hash, message] of records) {
    const found = leakProblems(message ?? '', chainIds);
    if (found.length > 0) bad.push(`${hash}: ${found.join(', ')}`);
  }
  return bad.length === 0
    ? { name: 'commit_messages', ok: true, detail: `${records.length} message(s) carry no id and no TODO number` }
    : { name: 'commit_messages', ok: false, detail: `messages carry internal references (${bad.slice(0, 5).join('; ')})` };
}

function checkText(title: string, body: string, chainIds: readonly string[]): PrCheck {
  const found = leakProblems(`${title}\n\n${body}`, chainIds, { attribution: true });
  return found.length === 0
    ? { name: 'pr_text', ok: true, detail: 'the title and the description carry no id, TODO number or attribution' }
    : { name: 'pr_text', ok: false, detail: `the title or the description carries ${found.join(', ')}` };
}

/**
 * Paths of the diff that the repository's own ignore rules cover: force-added
 * files that were meant to stay out of it. For Timon this is `docs/`, the
 * maintainers' internal repository, which the public one ignores.
 */
async function checkPrivatePaths(repo: string, range3: string): Promise<PrCheck> {
  const diff = await gitRead(repo, ['diff', '--name-only', '-z', '--no-renames', range3]);
  if (diff.code !== 0) return { name: 'private_paths', ok: false, detail: 'cannot list the files the branch changes' };
  const paths = diff.stdout.split('\0').filter(Boolean);
  // Each top-level folder once, then each file at the root: a file inside an
  // ignored folder is ignored even when no rule names it.
  const candidates = [...new Set(paths.map((p) => (p.includes('/') ? `${p.slice(0, p.indexOf('/'))}/` : p)))];
  if (candidates.length === 0) return { name: 'private_paths', ok: true, detail: 'the branch changes no file' };
  const r = await gitRead(repo, ['check-ignore', '--no-index', '--', ...candidates]);
  // 0: some are ignored, 1: none is; anything else is an error, which refuses.
  if (r.code === 1) return { name: 'private_paths', ok: true, detail: 'no file of the diff is one the repository ignores' };
  if (r.code !== 0) return { name: 'private_paths', ok: false, detail: 'cannot check the files of the diff against the ignore rules' };
  const ignored = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    name: 'private_paths',
    ok: false,
    detail: `the diff carries files the repository ignores, which must stay private (${ignored.slice(0, 5).join(', ')})`,
  };
}

const PUBLIC_TREE_SCRIPT = ['docs', 'oss', 'check-public-tree.mjs'] as const;

/** Runs the repository's own public tree check, when it has one. */
async function runPublicTree(repo: string, branch: string): Promise<PublicTreeOutcome> {
  const script = join(repo, ...PUBLIC_TREE_SCRIPT);
  if (!existsSync(script)) return { ran: false };
  const runtime = nodeRuntime(config());
  let r: ExecResult;
  try {
    r = await getHost().execAsync(runtime.command, [script, '--ref', branch], {
      cwd: repo,
      env: { ...process.env, ...runtime.env },
      timeout: 180_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    return { ran: true, ok: false, summary: `the check could not start: ${(err as Error).message}` };
  }
  const blockers = /^Blockers:\s*(\d+)\s*$/m.exec(r.stdout);
  if (r.timedOut) return { ran: true, ok: false, summary: 'the check timed out' };
  if (!blockers) return { ran: true, ok: false, summary: redactedOutput(r.stderr || r.stdout) || `the check exited with code ${r.code}` };
  return { ran: true, ok: r.code === 0 && blockers[1] === '0', summary: `Blockers: ${blockers[1]}` };
}

async function checkPublicTree(
  repo: string, branch: string, run: (repo: string, branch: string) => Promise<PublicTreeOutcome>,
): Promise<PrCheck> {
  const out = await run(repo, branch);
  if (!out.ran) {
    return { name: 'public_tree', ok: true, skipped: true, detail: `${PUBLIC_TREE_SCRIPT.join('/')} is absent from the repository: public tree check skipped` };
  }
  return { name: 'public_tree', ok: out.ok, detail: out.ok ? out.summary : `the public tree check refuses the branch: ${out.summary}` };
}

/** The remote branch, if any, must be contained in the local one: the push
 *  then only moves it forward. A remote that moved on its own is never
 *  overwritten; it is merged into the local branch first, by hand. */
async function checkRemoteBranch(
  repo: string, transport: GitTransport, url: string, remote: string, branch: string, head: string, dryRun = false,
): Promise<PrCheck> {
  const read = await transport.remoteBranchSha(url, branch);
  if (!read.ok) return { name: 'remote_branch', ok: false, detail: `cannot read ${branch} on the remote: ${read.reason}` };
  if (read.sha === null) return { name: 'remote_branch', ok: true, detail: `${branch} is not on the remote yet` };
  if (read.sha === head) return { name: 'remote_branch', ok: true, detail: `${branch} is already pushed at this commit` };
  if (!(await refSha(repo, read.sha))) {
    // Every ancestor of the local head is in the repository: a remote commit
    // it lacks cannot be one, so the preview knows the answer without a fetch.
    if (dryRun) {
      return {
        name: 'remote_branch',
        ok: false,
        detail: `${branch} moved on the remote: merge it into the local branch first (it is never overwritten)`,
      };
    }
    const fetched = await transport.fetchBranch(url, branch, `refs/remotes/${remote}/${branch}`);
    if (!fetched.ok) return { name: 'remote_branch', ok: false, detail: `cannot fetch ${branch} from the remote: ${fetched.reason}` };
  }
  return (await isAncestor(repo, read.sha, head))
    ? { name: 'remote_branch', ok: true, detail: `the push moves ${branch} forward` }
    : {
        name: 'remote_branch',
        ok: false,
        detail: `${branch} moved on the remote: merge it into the local branch first (it is never overwritten)`,
      };
}

export type PrChecksInput = {
  row: IntegrationRow;
  /** Ids whose short form must not appear in a message (`leakProblems`). */
  chainIds: readonly string[];
  remoteUrl: string;
  account: string;
  forge: Forge;
  transport: GitTransport;
  title: string;
  body: string;
  publicTree: (repo: string, branch: string) => Promise<PublicTreeOutcome>;
  /**
   * The preview's run (`integration-preview.ts`): it writes nothing, not even
   * a remote-tracking ref, and runs no code of the repository. The target is
   * compared as last fetched, a remote branch git does not have is reported
   * without being fetched, the public tree check (a script of the repository)
   * is left to the opening, and an absent title is not a failure.
   */
  dryRun?: boolean;
  /**
   * The push of an open pull request's branch (`pushIntegrationUpdate`): its
   * title and description stay what the forge holds, so there is no new text
   * to check.
   */
  keepText?: boolean;
};

/** Runs every pre-check of a pull request, in order; nothing is pushed here. */
export async function runPrChecks(input: PrChecksInput): Promise<{ checks: PrCheck[]; head: string | null }> {
  const { row, chainIds, remoteUrl, account, forge, transport } = input;
  const repo = row.repo;
  const branch = row.branch;
  const checks: PrCheck[] = [];

  const nameProblem = integrationBranchRefusal(branch);
  checks.push(nameProblem
    ? { name: 'branch_name', ok: false, detail: nameProblem }
    : { name: 'branch_name', ok: true, detail: `${branch} is a public branch name` });
  checks.push(await checkAccount(forge, account));
  checks.push(await checkRemoteUrl(repo, row.remote, remoteUrl));

  const head = await refSha(repo, `refs/heads/${branch}`);
  const tracking = `refs/remotes/${row.remote}/${row.target}`;
  let target: string | null;
  if (input.dryRun) {
    target = await refSha(repo, tracking);
    checks.push(target
      ? { name: 'target', ok: true, detail: `compared with ${row.remote}/${row.target} as last fetched (the preview fetches nothing)` }
      : { name: 'target', ok: false, detail: `${row.remote}/${row.target} was never fetched into the repository` });
  } else {
    const fetched = await transport.fetchBranch(remoteUrl, row.target, tracking);
    checks.push(fetched.ok
      ? { name: 'target', ok: true, detail: `${row.remote}/${row.target} is up to date` }
      : { name: 'target', ok: false, detail: `cannot fetch ${row.target} from the remote: ${fetched.reason}` });
    target = fetched.ok ? await refSha(repo, tracking) : null;
  }
  const text = (): PrCheck => (input.keepText
    ? { name: 'pr_text', ok: true, skipped: true, detail: 'the pull request keeps its title and description' }
    : input.dryRun && input.title.trim() === ''
      ? { name: 'pr_text', ok: true, skipped: true, detail: 'no title yet: the text is checked when the pull request is opened' }
      : checkText(input.title, input.body, chainIds));

  if (!head || !target) {
    const why = !head ? `${branch} does not exist in the repository` : `${row.remote}/${row.target} could not be read`;
    for (const name of ['commits', 'commit_identity', 'commit_messages', 'private_paths', 'public_tree', 'remote_branch'] as const) {
      checks.push({ name, ok: false, detail: `not checked: ${why}` });
    }
    checks.push(text());
  } else {
    const range = `${target}..${head}`;
    const count = await gitRead(repo, ['rev-list', '--count', range]);
    const commits = count.code === 0 ? Number(count.stdout.trim()) : NaN;
    checks.push(Number.isFinite(commits) && commits > 0
      ? { name: 'commits', ok: true, detail: `${commits} commit(s) beyond ${row.remote}/${row.target}` }
      : { name: 'commits', ok: false, detail: Number.isFinite(commits) ? `${branch} brings nothing beyond ${row.remote}/${row.target}` : 'cannot count the commits of the branch' });
    checks.push(await checkIdentity(repo, range));
    checks.push(await checkMessages(repo, range, chainIds));
    checks.push(text());
    checks.push(await checkPrivatePaths(repo, `${target}...${head}`));
    checks.push(input.dryRun
      ? { name: 'public_tree', ok: true, skipped: true, detail: 'runs a script of the repository: checked only when the pull request is opened' }
      : await checkPublicTree(repo, branch, input.publicTree));
    checks.push(await checkRemoteBranch(repo, transport, remoteUrl, row.remote, branch, head, input.dryRun === true));
  }
  return { checks, head };
}

// ─── The action ─────────────────────────────────────────────────────────────

const busy = new Set<string>();

function settingRefusal(setting: ProjectIntegration, row: IntegrationRow): string | null {
  if (setting.mode !== 'pr') return 'the project does not land through pull requests (mode "local")';
  if (setting.forge !== 'github') return `forge ${setting.forge} cannot open pull requests`;
  if (!setting.account) return 'the project names no GitHub account (account)';
  if (!setting.remote_url) return 'the project names no push URL for its remote (remote_url)';
  if (setting.remote !== row.remote || setting.target !== row.target) {
    return `the branch was cut from ${row.remote}/${row.target}, the project now targets ${setting.remote}/${setting.target}`;
  }
  return null;
}

export type PullRequestSetting = {
  setting: ProjectIntegration;
  remoteUrl: string;
  account: string;
  /** `owner/name` on the forge. */
  repository: string;
};

/** The project's setting, read again and held against the branch's row. */
export function pullRequestSetting(row: IntegrationRow, project: string | null): PullRequestSetting | { refusal: string } {
  if (!project) return { refusal: 'the job belongs to no project, so no integration setting applies' };
  let read;
  try { read = readProjectIntegration(project); } catch (err) {
    return { refusal: (err as Error).message };
  }
  if (read.invalid) return { refusal: `the project's integration setting is invalid: ${read.invalid}` };
  const setting = read.integration;
  const settingProblem = settingRefusal(setting, row);
  if (settingProblem) return { refusal: settingProblem };
  const remoteUrl = setting.remote_url!;
  const account = setting.account!;
  const repository = githubRepoFromUrl(remoteUrl);
  if (!repository) return { refusal: 'the push URL names no GitHub repository (owner/name)' };
  return { setting, remoteUrl, account, repository };
}

/**
 * Checks, pushes the job's integration branch and opens its pull request.
 * Nothing reaches the forge before every check passed.
 */
export async function openPullRequest(request: PrOpenRequest, deps: PrOpenDeps = {}): Promise<PrOpenOutcome> {
  let resolved: Resolved | Refusal;
  if (request.target === 'task') {
    const task = dbApi.getTask(request.id);
    resolved = task
      ? resolveFromTask(task, deps.agentCwd ?? defaultAgentCwd)
      : refuse(404, 'pr_target_not_found', 'no task has this id');
  } else if (request.target === 'series') {
    resolved = resolveFromSeries(request.id);
  } else {
    resolved = resolveFromIntegration(request.id);
  }
  if ('ok' in resolved) return resolved;
  const { row, chainIds, project } = resolved;

  // Embargo first: nothing about such a branch is even read from the network.
  if (row.branch.startsWith('sec/') || row.mode === 'branch') {
    return refuse(409, 'pr_refused', `${row.branch} is under embargo or lands by hand: Timon never pushes it`);
  }
  if (row.state === 'open') {
    return refuse(409, 'pr_refused', `a pull request is already open for ${row.branch}${row.pr_url ? `: ${row.pr_url}` : ''}`);
  }
  if (row.state !== 'branch') return refuse(409, 'pr_refused', `the pull request of ${row.branch} is already ${row.state}`);
  const resolvedSetting = pullRequestSetting(row, project);
  if ('refusal' in resolvedSetting) return refuse(409, 'pr_refused', resolvedSetting.refusal);
  const { setting, remoteUrl, account, repository } = resolvedSetting;

  const key = `${row.repo}\0${row.branch}`;
  if (busy.has(key)) return refuse(409, 'pr_open_busy', `a pull request is already being opened for ${row.branch}`);
  busy.add(key);
  try {
    const repo = row.repo;
    const branch = row.branch;
    const forge = (deps.forge ?? ((dir) => githubForge(dir, deps.runners)))(setting.gh_config_dir);
    const transport = (deps.transport ?? ((r) => gitTransport(r, deps.runners)))(repo);
    const { checks, head } = await runPrChecks({
      row, chainIds, remoteUrl, account, forge, transport,
      title: request.title, body: request.body, publicTree: deps.publicTree ?? runPublicTree,
    });

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0 || !head) {
      return refuse(409, 'pr_precheck_failed', failed.map((c) => `${c.name}: ${c.detail}`).join('; '), checks);
    }

    const pushed = await transport.pushBranch(remoteUrl, branch);
    if (!pushed.ok) {
      return refuse(502, 'pr_push_failed', `${branch} was not pushed: ${pushed.reason}`, checks);
    }
    // The issues come from the job's ideas, never from the agent's text, whose
    // own closing keywords are defused (`issue-closing.ts`).
    const issues = issueLines(jobIssueClosings(row));
    const created = await forge.createPullRequest({
      repo: repository, base: row.target, head: branch, title: request.title, body: pullRequestBody(request.body, issues),
    });
    if (!created.ok) {
      return refuse(502, 'pr_create_failed', `${branch} was pushed, the pull request was not created: ${created.reason}. Run the command again to retry.`, checks);
    }
    dbApi.markIntegrationOpen(row.id, { number: created.pr.number, url: created.pr.url, headSha: head });
    return {
      ok: true,
      pr: created.pr,
      existing: created.existing,
      branch,
      target: row.target,
      repository,
      head_sha: head,
      checks,
      issues,
    };
  } finally {
    busy.delete(key);
  }
}

// ─── Pushing a repair ───────────────────────────────────────────────────────

export type PrUpdateOutcome =
  | { ok: true; pushed: true; head_sha: string; checks: PrCheck[] }
  | { ok: true; pushed: false; head_sha: string | null }
  | {
      ok: false;
      /** `precheck`: a check refused, pushing again changes nothing until the
       *  branch does. `push`: the remote did not take it, which may pass. */
      stage: 'refused' | 'precheck' | 'push';
      reason: string;
      checks?: PrCheck[];
    };

/**
 * Pushes the integration branch of an open pull request forward, once a
 * repair's chain integrated new commits into it (`landing-repair.ts`). The
 * same checks as the opening run first, the text aside, and nothing is pushed
 * until every one passed; the push is never forced, so a remote branch that
 * moved on its own refuses it. The pull request itself is not touched: the
 * forge shows the new commits on it.
 */
export async function pushIntegrationUpdate(row: IntegrationRow, chainIds: readonly string[], deps: PrOpenDeps = {}): Promise<PrUpdateOutcome> {
  if (row.branch.startsWith('sec/') || row.mode === 'branch') {
    return { ok: false, stage: 'refused', reason: `${row.branch} is under embargo or lands by hand: Timon never pushes it` };
  }
  if (row.state !== 'open' || !row.head_sha) {
    return { ok: false, stage: 'refused', reason: `the pull request of ${row.branch} is not open` };
  }
  const resolved = pullRequestSetting(row, row.project);
  if ('refusal' in resolved) return { ok: false, stage: 'refused', reason: resolved.refusal };
  const head = await refSha(row.repo, `refs/heads/${row.branch}`);
  if (head === row.head_sha) return { ok: true, pushed: false, head_sha: head };
  if (!head || !(await isAncestor(row.repo, row.head_sha, head))) {
    return {
      ok: false, stage: 'refused',
      reason: head
        ? `${row.branch} no longer contains the commit its pull request ends on: it is never rewritten`
        : `${row.branch} does not exist in the repository`,
    };
  }
  const key = `${row.repo}\0${row.branch}`;
  if (busy.has(key)) return { ok: false, stage: 'push', reason: `${row.branch} is already being pushed` };
  busy.add(key);
  try {
    const forge = (deps.forge ?? ((dir) => githubForge(dir, deps.runners)))(resolved.setting.gh_config_dir);
    const transport = (deps.transport ?? ((r) => gitTransport(r, deps.runners)))(row.repo);
    const { checks, head: checked } = await runPrChecks({
      row, chainIds, remoteUrl: resolved.remoteUrl, account: resolved.account, forge, transport,
      title: '', body: '', keepText: true, publicTree: deps.publicTree ?? runPublicTree,
    });
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0 || checked !== head) {
      const reason = failed.length > 0
        ? failed.map((c) => `${c.name}: ${c.detail}`).join('; ')
        : `${row.branch} moved while it was checked`;
      return { ok: false, stage: 'precheck', reason, checks };
    }
    const pushed = await transport.pushBranch(resolved.remoteUrl, row.branch);
    if (!pushed.ok) return { ok: false, stage: 'push', reason: `${row.branch} was not pushed: ${pushed.reason}`, checks };
    dbApi.setIntegrationHead(row.id, head);
    return { ok: true, pushed: true, head_sha: head, checks };
  } finally {
    busy.delete(key);
  }
}
