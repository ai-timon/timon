/**
 * Publications proposed on the forge (`docs/FORGE-FLOW-PLAN.md` §0.4, §5): the
 * only way Timon writes on GitHub besides opening its own pull request.
 *
 * A proposal is prepared by the daemon (after a landing, a resolved idea), by
 * a person's click, or by a plugin holding `forge:propose` (`ctx.forge.propose`,
 * API 19, outside a request or in one a signed-in person made), never by an
 * agent: no MCP tool and no CLI verb creates one, and nothing but a person's
 * route publishes one. A signed-in person reads it, edits it and publishes it;
 * the daemon then runs `gh` with the account and the
 * config folder of the project's integration setting, after `gh api user`
 * answered that very account. Any other answer is a refusal, and nothing is
 * written.
 *
 * Idempotence holds at both ends:
 * - one trigger, one proposal: `idem_key` is unique per project, so a trigger
 *   that fires twice finds the proposal it already made;
 * - one publication, one comment: the row is claimed ('publishing') before
 *   `gh` runs, a published row answers what it published without calling the
 *   forge again, and a retry after an interrupted attempt first looks for the
 *   hidden marker the comment carries.
 *
 * What `gh` prints reaches a row, an answer or a log only through
 * `redactedOutput`, with the config folder masked as well.
 *
 * Three kinds of write: a comment (`comment`), the update of a pull request's
 * branch GitHub performs (`update_branch`, `forge-branch-update.ts`), and the
 * commit that resolves a contributor's conflict, pushed fast-forward to their
 * branch (`conflict_push`, `forge-conflicts.ts`). The last two carry a
 * `payload` the daemon wrote when it prepared them (the head they expect, the
 * commit they push) and run through the executor their module registers
 * (`registerForgeProposalExecutor`); the account check above is the same.
 */
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { daemonMessage } from './daemon-message.js';
import { projectRepository, type ExternalPrRefusal } from './external-pr-review.js';
import {
  githubForge, ISSUE_COMMENT_LIMIT, redactedOutput,
  type ForgeBranchWriter, type ForgeCommentWriter, type ForgeRunners, type GitRunner,
} from './host/forge.js';
import type { SshHostResolver } from './host/forge-scratch.js';
import type { ProjectIntegration } from './project-integration.js';
import { createNotification, resolveAnchor } from './notifications.js';

export const FORGE_PROPOSAL_KINDS = ['comment', 'update_branch', 'conflict_push'] as const;
export type ForgeProposalKind = (typeof FORGE_PROPOSAL_KINDS)[number];

export const FORGE_PROPOSAL_TARGETS = ['issue', 'pull'] as const;
export type ForgeProposalTarget = (typeof FORGE_PROPOSAL_TARGETS)[number];

export const FORGE_PROPOSAL_STATES = ['draft', 'publishing', 'published', 'failed', 'discarded'] as const;
export type ForgeProposalState = (typeof FORGE_PROPOSAL_STATES)[number];

/** What made the proposal: shown in the dialog, so the person knows why. */
export const FORGE_PROPOSAL_TRIGGERS = ['person', 'landing', 'todo_resolved', 'plugin'] as const;
export type ForgeProposalTrigger = (typeof FORGE_PROPOSAL_TRIGGERS)[number];

/** Most characters of a proposal's text: the comment the forge receives. */
export const FORGE_PROPOSAL_BODY_LIMIT = ISSUE_COMMENT_LIMIT;
/** Most characters of an idempotency key or a source reference. */
const KEY_LIMIT = 200;

export type ForgeProposalRow = {
  id: string;
  project: string;
  repo: string;
  kind: ForgeProposalKind;
  target_type: ForgeProposalTarget;
  target_number: number;
  body: string;
  state: ForgeProposalState;
  trigger: ForgeProposalTrigger;
  idem_key: string;
  source_ref: string | null;
  /** JSON the daemon wrote for a write other than a comment, else null. */
  payload: string | null;
  created_by: string | null;
  edited_by: string | null;
  published_by: string | null;
  account: string | null;
  result_url: string | null;
  error_code: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  published_at: number | null;
};

/** What the routes show of a proposal. */
export type ForgeProposalView = {
  id: string;
  project: string;
  repo: string;
  kind: ForgeProposalKind;
  target: { type: ForgeProposalTarget; number: number; url: string };
  body: string;
  state: ForgeProposalState;
  trigger: ForgeProposalTrigger;
  /** The plugin that proposed it (`trigger: 'plugin'`), else null. */
  plugin: string | null;
  key: string;
  source_ref: string | null;
  /** What a branch update or a conflict push runs with (`payload`), else null. */
  details: Record<string, unknown> | null;
  /** Whether a person may change the text before publishing. */
  editable: boolean;
  /** The account that published it, once published. */
  account: string | null;
  url: string | null;
  error: { code: string; reason: string | null } | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
};

export type ForgeProposalRefusalCode =
  | 'project_not_found'
  | 'integration_invalid'
  | 'integration_not_pr'
  | 'pr_repository_unknown'
  | 'forge_proposal_not_found'
  | 'forge_proposal_invalid'
  | 'forge_proposal_closed'
  | 'forge_proposal_busy'
  | 'forge_proposal_repository_changed'
  | 'forge_account_unset'
  | 'forge_account_unknown'
  | 'forge_account_mismatch'
  | 'forge_publish_failed'
  | 'forge_proposal_not_editable'
  | 'forge_read_failed'
  | 'forge_pull_closed'
  | 'forge_pull_not_behind'
  | 'forge_pull_not_conflicting'
  | 'forge_pull_not_fork'
  | 'forge_head_unknown'
  | 'forge_head_moved'
  | 'forge_branch_not_modifiable'
  | 'forge_branch_conflict'
  | 'forge_branch_forbidden'
  | 'forge_push_rejected'
  | 'forge_conflict_changed'
  | 'conflict_resolution_disabled'
  | 'conflict_not_found'
  | 'conflict_closed'
  | 'conflict_invalid'
  | 'conflict_git_unavailable'
  | 'conflict_fetch_failed'
  | 'conflict_fetch_too_large'
  | 'conflict_none'
  | 'conflict_unsupported'
  | 'conflict_markers_left'
  | 'conflict_unresolved'
  | 'conflict_outside_files'
  | 'conflict_suggest_unavailable'
  | 'conflict_suggest_failed';

export type ForgeProposalRefusal = {
  ok: false;
  status: number;
  code: ForgeProposalRefusalCode;
  reason: string;
  /** The row as it stands after the refusal, when there is one. */
  proposal?: ForgeProposalView;
};

export type ForgeProposalDeps = {
  /** Stands in for `gh` in tests: nothing in the suite reaches GitHub. */
  forge?: (configDir: string | null) => ForgeCommentWriter;
  /** Same, for the branch of a pull request (read, update). */
  branchForge?: (configDir: string | null) => ForgeBranchWriter;
  /** Stands in for git in the scratch repository of a conflict resolution. */
  scratchGit?: GitRunner;
  /** Stands in for `ssh -G` in tests: the host an SSH alias of the remote connects to. */
  sshHostName?: SshHostResolver;
  /** Where scratch repositories go; `TIMON_HOME/tmp/forge-conflicts` by default. */
  scratchRoot?: string;
  runners?: ForgeRunners;
  now?: () => number;
};

const refuse = (status: number, code: ForgeProposalRefusalCode, reason: string, row?: ForgeProposalRow): ForgeProposalRefusal =>
  ({ ok: false, status, code, reason, ...(row ? { proposal: viewOf(row) } : {}) });

/** The project's repository could not be resolved: the same refusal, under this module's codes. */
function repositoryRefusal(out: ExternalPrRefusal): ForgeProposalRefusal {
  switch (out.code) {
    case 'project_not_found':
    case 'integration_invalid':
    case 'integration_not_pr':
    case 'pr_repository_unknown':
      return refuse(out.status, out.code, out.reason);
    default:
      return refuse(500, 'forge_proposal_invalid', 'the project repository could not be read');
  }
}

/** Proposals this process is publishing right now: a recovery never takes them. */
const inFlight = new Set<string>();

const NOTIFICATION_ANCHOR = 'forge-proposal:';

/**
 * The anchor of a proposal's notification card, closed once it is dealt with.
 * It names the project too: the card opens the proposal, and a proposal is
 * read under its project (a slug never holds a `:`).
 */
export function proposalAnchor(project: string, id: string): string {
  return `${NOTIFICATION_ANCHOR}${project}:${id}`;
}

/** The hidden line a published comment ends with: how a retry recognises it. */
export function proposalMarker(id: string): string {
  return `<!-- timon-proposal:${id} -->`;
}

function targetUrl(repo: string, type: ForgeProposalTarget, number: number): string {
  return `https://github.com/${repo}/${type === 'pull' ? 'pull' : 'issues'}/${number}`;
}

const PLUGIN_AUTHOR = 'plugin:';

/** What a plugin's proposal records as its author. */
export function pluginAuthor(pluginId: string): string {
  return `${PLUGIN_AUTHOR}${pluginId}`;
}

function pluginOf(row: ForgeProposalRow): string | null {
  return row.trigger === 'plugin' && row.created_by?.startsWith(PLUGIN_AUTHOR) ? row.created_by.slice(PLUGIN_AUTHOR.length) : null;
}

function detailsOf(row: ForgeProposalRow): Record<string, unknown> | null {
  if (!row.payload) return null;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** The payload of a proposal, as its executor reads it. */
export function proposalPayload(row: ForgeProposalRow): Record<string, unknown> {
  return detailsOf(row) ?? {};
}

function editable(kind: ForgeProposalKind): boolean {
  return executors.get(kind)?.editable ?? kind === 'comment';
}

export function viewOf(row: ForgeProposalRow): ForgeProposalView {
  return {
    id: row.id,
    project: row.project,
    repo: row.repo,
    kind: row.kind,
    target: { type: row.target_type, number: row.target_number, url: targetUrl(row.repo, row.target_type, row.target_number) },
    body: row.body,
    state: row.state,
    trigger: row.trigger,
    plugin: pluginOf(row),
    key: row.idem_key,
    source_ref: row.source_ref,
    details: detailsOf(row),
    editable: editable(row.kind),
    account: row.account,
    url: row.result_url,
    error: row.error_code ? { code: row.error_code, reason: row.error } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
  };
}

const getStmt = db.prepare(`SELECT * FROM forge_proposals WHERE id = ?`);
const getByKeyStmt = db.prepare(`SELECT * FROM forge_proposals WHERE project = ? AND idem_key = ?`);
const listStmt = db.prepare(`SELECT * FROM forge_proposals WHERE project = ? ORDER BY created_at DESC, id LIMIT 200`);
const listByStateStmt = db.prepare(`SELECT * FROM forge_proposals WHERE project = ? AND state = ? ORDER BY created_at DESC, id LIMIT 200`);
const byAuthorStmt = db.prepare(`
  SELECT * FROM forge_proposals WHERE project = ? AND created_by = ? AND trigger = 'plugin' ORDER BY created_at DESC, id LIMIT 200
`);
const openByAuthorStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM forge_proposals WHERE created_by = ? AND trigger = 'plugin' AND state IN ('draft', 'failed')
`);
const openPersonDraftStmt = db.prepare(`
  SELECT * FROM forge_proposals
  WHERE project = ? AND repo = ? AND kind = ? AND target_type = ? AND target_number = ? AND trigger = 'person' AND state IN ('draft', 'failed')
  ORDER BY created_at DESC LIMIT 1
`);
const insertStmt = db.prepare(`
  INSERT INTO forge_proposals
    (id, project, repo, kind, target_type, target_number, body, state, trigger, idem_key, source_ref, payload, created_by, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (project, idem_key) DO NOTHING
`);
const editStmt = db.prepare(`
  UPDATE forge_proposals SET body = ?, edited_by = ?, updated_at = ? WHERE id = ? AND state IN ('draft', 'failed')
`);
const discardStmt = db.prepare(`
  UPDATE forge_proposals SET state = 'discarded', edited_by = ?, updated_at = ? WHERE id = ? AND state IN ('draft', 'failed')
`);
const claimStmt = db.prepare(`
  UPDATE forge_proposals SET state = 'publishing', attempts = attempts + 1, updated_at = ?
  WHERE id = ? AND state IN ('draft', 'failed')
`);
const releaseStmt = db.prepare(`
  UPDATE forge_proposals SET state = ?, error_code = ?, error = ?, updated_at = ? WHERE id = ? AND state = 'publishing'
`);
const publishedStmt = db.prepare(`
  UPDATE forge_proposals
  SET state = 'published', account = ?, published_by = ?, result_url = ?, error_code = NULL, error = NULL,
      published_at = ?, updated_at = ?
  WHERE id = ? AND state = 'publishing'
`);
const publishingStmt = db.prepare(`SELECT id FROM forge_proposals WHERE state = 'publishing'`);
const interruptedStmt = db.prepare(`
  UPDATE forge_proposals SET state = 'failed', error_code = 'interrupted', error = NULL, updated_at = ? WHERE id = ? AND state = 'publishing'
`);

function get(id: string): ForgeProposalRow | undefined {
  return getStmt.get(id) as ForgeProposalRow | undefined;
}

export function getForgeProposal(project: string, id: string): ForgeProposalRow | undefined {
  const row = get(id);
  return row && row.project === project ? row : undefined;
}

export function listForgeProposals(project: string, state?: ForgeProposalState): ForgeProposalRow[] {
  return (state ? listByStateStmt.all(project, state) : listStmt.all(project)) as ForgeProposalRow[];
}

/** The proposal a trigger already made under `key`, if any. */
export function getForgeProposalByKey(project: string, key: string): ForgeProposalRow | undefined {
  return getByKeyStmt.get(project, key) as ForgeProposalRow | undefined;
}

/** The proposals a plugin made on a project, newest first. */
export function listPluginForgeProposals(project: string, pluginId: string): ForgeProposalRow[] {
  return byAuthorStmt.all(project, pluginAuthor(pluginId)) as ForgeProposalRow[];
}

/** How many of a plugin's proposals still wait for a person, all projects together. */
export function openPluginForgeProposals(pluginId: string): number {
  return (openByAuthorStmt.get(pluginAuthor(pluginId)) as { n: number }).n;
}

/** Why a text cannot be published, or null. */
export function bodyProblem(body: string): string | null {
  if (body.trim().length === 0) return 'the text is empty';
  if (body.length > FORGE_PROPOSAL_BODY_LIMIT) return `the text is longer than ${FORGE_PROPOSAL_BODY_LIMIT} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) return 'the text holds control characters';
  if (body.includes('<!-- timon-proposal:')) return 'the text holds a publication marker';
  return null;
}

function keyProblem(key: string): string | null {
  // eslint-disable-next-line no-control-regex
  return key.length === 0 || key.length > KEY_LIMIT || /[\u0000-\u001f\u007f]/.test(key) ? 'not an idempotency key' : null;
}

export type ProposeInput = {
  project: string;
  kind: ForgeProposalKind;
  target: { type: ForgeProposalTarget; number: number };
  body: string;
  trigger: ForgeProposalTrigger;
  /** One trigger, one proposal: `todo:<id>:comment` for a resolved idea. A
   *  person's proposal gets one per target instead. */
  key?: string;
  sourceRef?: string | null;
  /** What a write other than a comment runs with: written by the daemon only. */
  payload?: Readonly<Record<string, unknown>>;
  /** The person's user id, `pluginAuthor(id)` for a plugin, or null for the daemon. */
  createdBy: string | null;
};

export type ProposeOutcome = { ok: true; proposal: ForgeProposalRow; created: boolean } | ForgeProposalRefusal;

/**
 * Prepares a write on the forge and tells the people who validate it. Called
 * by the daemon's own producers, by a person's route and by `ctx.forge.propose`,
 * never on an agent's request. Nothing reaches the forge here.
 */
export function proposeForgeWrite(input: ProposeInput, deps: ForgeProposalDeps = {}): ProposeOutcome {
  const now = (deps.now ?? Date.now)();
  if (!Number.isSafeInteger(input.target.number) || input.target.number <= 0) {
    return refuse(400, 'forge_proposal_invalid', 'not an issue or a pull request number');
  }
  const bad = bodyProblem(input.body);
  if (bad) return refuse(400, 'forge_proposal_invalid', bad);
  const where = projectRepository(input.project);
  if (!where.ok) return repositoryRefusal(where);
  const repo = where.value.repo;

  if (input.trigger === 'person' && input.key === undefined) {
    // A second click on the same target opens the draft already waiting.
    const open = openPersonDraftStmt.get(input.project, repo, input.kind, input.target.type, input.target.number) as ForgeProposalRow | undefined;
    if (open) return { ok: true, proposal: open, created: false };
  }
  const key = input.key ?? `person:${input.kind}:${input.target.type}:${input.target.number}:${randomUUID()}`;
  const badKey = keyProblem(key) ?? (input.sourceRef && keyProblem(input.sourceRef));
  if (badKey) return refuse(400, 'forge_proposal_invalid', badKey);

  const id = randomUUID();
  const inserted = insertStmt.run(
    id, input.project, repo, input.kind, input.target.type, input.target.number, input.body,
    input.trigger, key, input.sourceRef ?? null, input.payload ? JSON.stringify(input.payload) : null, input.createdBy, now, now,
  ).changes > 0;
  if (!inserted) {
    const existing = getByKeyStmt.get(input.project, key) as ForgeProposalRow;
    return { ok: true, proposal: existing, created: false };
  }
  const row = get(id)!;
  const target = `${repo}#${input.target.number}`;
  createNotification({ type: 'action_required', anchor: proposalAnchor(input.project, id), ...pendingNotice(input.kind, target) });
  console.log(`[forge-proposals] ${input.kind} proposed on ${target} (${id.slice(0, 8)}, ${input.trigger})`);
  return { ok: true, proposal: row, created: true };
}

function pendingNotice(kind: ForgeProposalKind, target: string) {
  switch (kind) {
    case 'comment': return {
      title: 'A GitHub comment waits for your approval',
      body: `Read and publish, edit or discard the comment proposed on ${target}.`,
      message: daemonMessage('forge_proposal_pending', { target }),
    };
    case 'update_branch': return {
      title: 'A branch update waits for your approval',
      body: `Publish or discard the update of the branch of ${target} on GitHub.`,
      message: daemonMessage('forge_branch_update_pending', { target }),
    };
    case 'conflict_push': return {
      title: 'A conflict resolution waits for your approval',
      body: `Read the resolution prepared for ${target}, then publish or discard it.`,
      message: daemonMessage('forge_conflict_push_pending', { target }),
    };
  }
}

// ─── Writes other than a comment ────────────────────────────────────────────

/** What an executor runs with: a row this process claimed, the account `gh`
 *  answered for (already checked against the project's), the project's
 *  setting and the comment writer (a conflict push comments after pushing). */
export type ForgeProposalExecution = {
  row: ForgeProposalRow;
  /** `attempts` before this one: an earlier attempt may have reached the forge. */
  earlierAttempts: number;
  login: string;
  integration: ProjectIntegration;
  configDir: string | null;
  comments: ForgeCommentWriter;
  deps: ForgeProposalDeps;
  /** `redactedOutput` with the config folder masked too. */
  scrub: (text: string) => string;
};

export type ForgeProposalExecutorResult =
  | { ok: true; url: string; already: boolean }
  /** `failed: false` puts the proposal back as it was (nothing reached the
   *  forge), `true` marks it failed. Both can be published again. */
  | { ok: false; code: ForgeProposalRefusalCode; reason: string; status: number; failed: boolean };

export type ForgeProposalExecutor = {
  /** Whether a person may change the text (a branch update has none to post). */
  editable: boolean;
  execute(run: ForgeProposalExecution): Promise<ForgeProposalExecutorResult>;
  /** Called once the proposal is discarded: whatever it held goes. */
  discarded?(row: ForgeProposalRow): void;
};

const executors = new Map<ForgeProposalKind, ForgeProposalExecutor>();

/** Called by the module that runs a kind of write, when it loads. */
export function registerForgeProposalExecutor(kind: Exclude<ForgeProposalKind, 'comment'>, executor: ForgeProposalExecutor): void {
  executors.set(kind, executor);
}

type Change = { ok: true; proposal: ForgeProposalRow } | ForgeProposalRefusal;

function closedRefusal(row: ForgeProposalRow): ForgeProposalRefusal {
  return row.state === 'publishing'
    ? refuse(409, 'forge_proposal_busy', 'this proposal is being published', row)
    : refuse(409, 'forge_proposal_closed', `this proposal is already ${row.state}`, row);
}

/** Replaces the text of a proposal still waiting (or whose publication failed). */
export function editForgeProposal(project: string, id: string, body: string, by: string, deps: ForgeProposalDeps = {}): Change {
  const row = getForgeProposal(project, id);
  if (!row) return refuse(404, 'forge_proposal_not_found', 'no proposal has this id in this project');
  if (!editable(row.kind)) return refuse(409, 'forge_proposal_not_editable', 'this proposal has no text to change', row);
  const bad = bodyProblem(body);
  if (bad) return refuse(400, 'forge_proposal_invalid', bad);
  if (editStmt.run(body, by, (deps.now ?? Date.now)(), id).changes === 0) return closedRefusal(get(id)!);
  return { ok: true, proposal: get(id)! };
}

/** "Do not publish": the proposal stays, closed, and its card goes away. */
export function discardForgeProposal(project: string, id: string, by: string, deps: ForgeProposalDeps = {}): Change {
  const row = getForgeProposal(project, id);
  if (!row) return refuse(404, 'forge_proposal_not_found', 'no proposal has this id in this project');
  if (row.state === 'discarded') return { ok: true, proposal: row };
  if (discardStmt.run(by, (deps.now ?? Date.now)(), id).changes === 0) return closedRefusal(get(id)!);
  resolveAnchor(proposalAnchor(row.project, id));
  const discarded = get(id)!;
  try { executors.get(row.kind)?.discarded?.(discarded); } catch (err) {
    console.error('[forge-proposals] cleanup after a discard failed:', (err as Error).name);
  }
  return { ok: true, proposal: discarded };
}

export type PublishOutcome = { ok: true; proposal: ForgeProposalRow; already: boolean } | ForgeProposalRefusal;

/** `redactedOutput`, plus the config folder, which must not leave this machine's logs either. */
function scrub(text: string, configDir: string | null): string {
  const masked = configDir ? text.split(configDir).join('[gh config]') : text;
  return redactedOutput(masked);
}

/**
 * Publishes a proposal a signed-in person validated: claims it, checks the
 * account `gh` answers for, then writes once. `body`, when given, is the text
 * the person just validated and replaces the stored one first.
 */
export async function publishForgeProposal(
  project: string, id: string, by: string, body: string | undefined, deps: ForgeProposalDeps = {},
): Promise<PublishOutcome> {
  const now = deps.now ?? Date.now;
  const row = getForgeProposal(project, id);
  if (!row) return refuse(404, 'forge_proposal_not_found', 'no proposal has this id in this project');
  if (row.state === 'published') return { ok: true, proposal: row, already: true };
  if (body !== undefined && body !== row.body) {
    const edited = editForgeProposal(project, id, body, by, deps);
    if (!edited.ok) return edited;
  }
  const previous = get(id)!;
  if (claimStmt.run(now(), id).changes === 0) {
    const current = get(id)!;
    if (current.state === 'published') return { ok: true, proposal: current, already: true };
    return closedRefusal(current);
  }
  // From here the row is ours until it is released, published or failed.
  inFlight.add(id);
  const release = (code: ForgeProposalRefusalCode, reason: string, status: number): ForgeProposalRefusal => {
    releaseStmt.run(previous.state, code, reason, now(), id);
    console.warn(`[forge-proposals] publication of ${id.slice(0, 8)} refused: ${code}`);
    return refuse(status, code, reason, get(id)!);
  };
  const fail = (reason: string): ForgeProposalRefusal => {
    releaseStmt.run('failed', 'forge_publish_failed', reason, now(), id);
    console.warn(`[forge-proposals] publication of ${id.slice(0, 8)} failed`);
    return refuse(502, 'forge_publish_failed', `the comment was not published: ${reason}`, get(id)!);
  };

  try {
    const where = projectRepository(project);
    if (!where.ok) {
      const refusal = repositoryRefusal(where);
      return release(refusal.code, refusal.reason, refusal.status);
    }
    const { integration, repo } = where.value;
    if (repo.toLowerCase() !== previous.repo.toLowerCase()) {
      return release('forge_proposal_repository_changed',
        `the project now points at ${repo}, the proposal was made for ${previous.repo}: discard it`, 409);
    }
    const account = integration.account;
    if (!account) return release('forge_account_unset', 'the project names no GitHub account (account)', 409);
    const configDir = integration.gh_config_dir;
    const forge = (deps.forge ?? ((dir) => githubForge(dir, deps.runners)))(configDir);

    const login = await forge.login();
    if (!login.ok) return release('forge_account_unknown', `cannot tell which account gh signs in as: ${scrub(login.reason, configDir)}`, 502);
    // GitHub logins ignore case.
    if (login.login.toLowerCase() !== account.toLowerCase()) {
      return release('forge_account_mismatch', `gh signs in as ${login.login}, the project expects ${account}`, 409);
    }

    if (previous.kind !== 'comment') {
      const executor = executors.get(previous.kind);
      if (!executor) return release('forge_publish_failed', 'this kind of write cannot run in this daemon', 501);
      const out = await executor.execute({
        row: get(id)!, earlierAttempts: previous.attempts, login: login.login, integration, configDir,
        comments: forge, deps, scrub: (text) => scrub(text, configDir),
      });
      if (!out.ok) {
        if (!out.failed) return release(out.code, out.reason, out.status);
        releaseStmt.run('failed', out.code, out.reason, now(), id);
        console.warn(`[forge-proposals] ${previous.kind} ${id.slice(0, 8)} failed: ${out.code}`);
        return refuse(out.status, out.code, out.reason, get(id)!);
      }
      publishedStmt.run(login.login, by, out.url, now(), now(), id);
      resolveAnchor(proposalAnchor(row.project, id));
      console.log(`[forge-proposals] ${previous.kind} ${id.slice(0, 8)} published on ${previous.repo}#${previous.target_number} as ${login.login}`);
      return { ok: true, proposal: get(id)!, already: out.already };
    }

    const marker = proposalMarker(id);
    if (previous.attempts > 0) {
      // An earlier attempt may have reached the forge before its answer was lost.
      const found = await forge.findIssueComment(previous.repo, previous.target_number, login.login, marker);
      if (!found.ok) return fail(scrub(found.reason, configDir));
      if (found.comment) {
        publishedStmt.run(login.login, by, found.comment.url, now(), now(), id);
        resolveAnchor(proposalAnchor(row.project, id));
        console.log(`[forge-proposals] ${id.slice(0, 8)} was already on ${previous.repo}#${previous.target_number}`);
        return { ok: true, proposal: get(id)!, already: true };
      }
    }
    const posted = await forge.postIssueComment(previous.repo, previous.target_number, `${previous.body}\n\n${marker}`);
    if (!posted.ok) return fail(scrub(posted.reason, configDir));
    publishedStmt.run(login.login, by, posted.comment.url, now(), now(), id);
    resolveAnchor(proposalAnchor(row.project, id));
    console.log(`[forge-proposals] ${id.slice(0, 8)} published on ${previous.repo}#${previous.target_number} as ${login.login}`);
    return { ok: true, proposal: get(id)!, already: false };
  } catch (err) {
    // Not echoed: an unexpected failure may quote a path of this machine.
    console.error('[forge-proposals] publication crashed:', (err as Error).name);
    return fail('an unexpected error stopped the publication');
  } finally {
    inFlight.delete(id);
  }
}

/**
 * A daemon stopped while `gh` ran leaves rows 'publishing': they become
 * 'failed' ("interrupted"), and their next publication looks for the comment
 * on the forge before writing it again.
 */
export function recoverInterruptedPublications(now = Date.now()): number {
  let changed = 0;
  for (const { id } of publishingStmt.all() as { id: string }[]) {
    if (!inFlight.has(id)) changed += interruptedStmt.run(now, id).changes;
  }
  if (changed > 0) console.log(`[forge-proposals] ${changed} interrupted publication(s) marked failed`);
  return changed;
}
