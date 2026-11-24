/**
 * `ctx.forge` (API 19): the GitHub repository of a Timon project, for a plugin
 * that has neither `gh` nor the project's account (docs/FORGE-FLOW-PLAN.md §0.8).
 *
 * Reading (`forge:read`) goes through the daemon's forge reader, signed in with
 * the config folder of the project's integration setting; the plugin sees the
 * answer, never the folder, the login or what `gh` printed. Writing does not
 * exist here: `propose` (`forge:propose`) stores a proposed comment
 * (`forge-proposals.ts`), which a signed-in person reads, edits and publishes
 * or discards in the "Publish on GitHub" window. No member publishes, edits or
 * discards a proposal.
 *
 * Who acts is decided by `context.ts` before this module is reached: a job (or
 * an unattended callback) acts as `plugin:<id>`; a request needs an account
 * holding `projects:manage`, as the routes over the same data do, and a
 * proposal made in a request needs a signed-in person behind it. A request
 * carried by the daemon token, a mission's token or a plugin's is not a person:
 * an agent never proposes through a plugin's route.
 *
 * Every text from the forge was written by someone else: titles, bodies,
 * comments, labels and logins are bounded here and stay data for the plugin.
 */
import {
  getForgeProposal, getForgeProposalByKey, listPluginForgeProposals, openPluginForgeProposals, pluginAuthor, proposeForgeWrite,
  type ForgeProposalDeps, type ForgeProposalRefusal, type ForgeProposalRow,
} from '../forge-proposals.js';
import { projectRepository } from '../external-pr-review.js';
import {
  FORGE_BODY_LIMIT, githubForge, type ForgeChecksReader, type ForgeIssueReader, type ForgeReader,
  type IssueDetails, type IssueSummary, type PullRequestDetails, type PullRequestSummary,
} from '../host/forge.js';

import type {
  PluginForgeChecks, PluginForgeErrorCode, PluginForgeIssue, PluginForgeIssueDetails, PluginForgeProposal,
  PluginForgeProposalInput, PluginForgeProposeResult, PluginForgePull, PluginForgePullDetails, PluginForgeRepository,
} from './contract/forge.js';
export type {
  PluginForgeChecks, PluginForgeErrorCode, PluginForgeIssue, PluginForgeIssueDetails, PluginForgeProposal,
  PluginForgeProposalInput, PluginForgeProposeResult, PluginForgePull, PluginForgePullDetails, PluginForgeRepository,
} from './contract/forge.js';

export class PluginForgeError extends Error {
  constructor(readonly code: PluginForgeErrorCode, message: string = code) {
    super(message);
    this.name = 'PluginForgeError';
  }
}

export type ForgeCallerScope = {
  pluginId: string;
  /** A proposal may be made: a job, or a request a signed-in person made. */
  mayPropose: boolean;
};

export type ForgeFacadeReader = ForgeReader & ForgeChecksReader & ForgeIssueReader;

export type ForgeFacadeDeps = {
  /** Stands in for `gh` in tests: nothing in the suite reaches GitHub. */
  reader?: (configDir: string | null) => ForgeFacadeReader;
  proposals?: ForgeProposalDeps;
};

export type ScopedForge = {
  repository(project: string): PluginForgeRepository | undefined;
  issues: {
    list(project: string, opts: { label: string }): Promise<PluginForgeIssue[]>;
    get(project: string, number: number): Promise<PluginForgeIssueDetails | undefined>;
  };
  pulls: {
    list(project: string): Promise<PluginForgePull[]>;
    get(project: string, number: number): Promise<PluginForgePullDetails | undefined>;
    checks(project: string, number: number): Promise<PluginForgeChecks | undefined>;
  };
  propose(project: string, input: PluginForgeProposalInput): PluginForgeProposeResult;
  proposals: {
    list(project: string): PluginForgeProposal[];
    get(project: string, id: string): PluginForgeProposal | undefined;
  };
};

/** Forge calls one plugin may have running at once: each is a `gh` process. */
export const FORGE_CALLS_PER_PLUGIN = 4;
/** Proposals of one plugin that may wait for a person at once: each raises a card. */
export const FORGE_OPEN_PROPOSALS_PER_PLUGIN = 20;
/** Most characters of a plugin's proposal key; the stored key names the plugin too. */
export const FORGE_PROPOSAL_KEY_LIMIT = 120;
/** Most comments of a pull request handed over, and characters of each. */
const PULL_COMMENT_LIMIT = 20;
const PULL_COMMENT_BODY_LIMIT = 2_000;

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** gh's answer for a number that names nothing in the repository. */
const NOT_FOUND = /could not resolve to an? (?:issue|pull ?request)|no pull requests? found|not found/i;

const inFlight = new Map<string, number>();

function slugOf(project: unknown): string {
  if (typeof project !== 'string' || !SLUG.test(project)) throw new PluginForgeError('invalid', 'not a project slug');
  return project;
}

function numberOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000) {
    throw new PluginForgeError('invalid', 'not an issue or a pull request number');
  }
  return value;
}

/** The repository and config folder of a project, or the contract's refusal. */
function where(project: string): { repo: string; configDir: string | null } {
  const out = projectRepository(project);
  if (!out.ok) {
    if (out.code === 'project_not_found') throw new PluginForgeError('not_found', 'project not found');
    throw new PluginForgeError('not_configured', 'the project does not open pull requests on GitHub');
  }
  return { repo: out.value.repo, configDir: out.value.integration.gh_config_dir };
}

function proposalView(row: ForgeProposalRow, pluginId: string): PluginForgeProposal {
  const prefix = keyPrefix(pluginId);
  return {
    id: row.id,
    project: row.project,
    repo: row.repo,
    // A plugin proposes comments only (`propose`): its rows are all comments.
    kind: 'comment',
    target: {
      type: row.target_type,
      number: row.target_number,
      url: `https://github.com/${row.repo}/${row.target_type === 'pull' ? 'pull' : 'issues'}/${row.target_number}`,
    },
    body: row.body,
    state: row.state,
    key: row.idem_key.startsWith(prefix) ? row.idem_key.slice(prefix.length) : row.idem_key,
    sourceRef: row.source_ref,
    url: row.result_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

/** Plugin keys live under their own prefix: a plugin cannot take the daemon's
 *  `todo:<id>:comment`, nor another plugin's key. */
function keyPrefix(pluginId: string): string {
  return `plugin:${pluginId}:`;
}

function issueView(issue: IssueSummary): PluginForgeIssue {
  return {
    number: issue.number, title: issue.title, author: issue.author, url: issue.url, state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    createdAt: issue.createdAt, updatedAt: issue.updatedAt,
  };
}

function pullView(pull: PullRequestSummary): PluginForgePull {
  return {
    number: pull.number, title: pull.title, author: pull.author, url: pull.url, isDraft: pull.isDraft,
    updatedAt: pull.updatedAt, headOwner: pull.headOwner, headRepository: pull.headRepository,
    maintainerCanModify: pull.maintainerCanModify, mergeState: pull.mergeStateStatus,
    labels: pull.labels.map((l) => ({ name: l.name, color: l.color })),
    closingIssues: pull.closingIssues.map((i) => ({ repo: i.repo, number: i.number, url: i.url })),
  };
}

function pullDetailsView(pull: PullRequestDetails): PluginForgePullDetails {
  return {
    ...pullView(pull),
    body: pull.body.slice(0, FORGE_BODY_LIMIT),
    baseRef: pull.baseRef, headRef: pull.headRef, headSha: pull.headSha,
    additions: pull.additions, deletions: pull.deletions, changedFiles: pull.changedFiles,
    comments: pull.comments.slice(-PULL_COMMENT_LIMIT)
      .map((c) => ({ author: c.author, body: c.body.slice(0, PULL_COMMENT_BODY_LIMIT) })),
  };
}

function refusalError(out: ForgeProposalRefusal): PluginForgeError {
  switch (out.code) {
    case 'project_not_found': return new PluginForgeError('not_found', 'project not found');
    case 'integration_invalid':
    case 'integration_not_pr':
    case 'pr_repository_unknown':
      return new PluginForgeError('not_configured', 'the project does not open pull requests on GitHub');
    default:
      return new PluginForgeError('invalid', out.reason);
  }
}

export function forgeFor(scope: ForgeCallerScope, deps: ForgeFacadeDeps = {}): ScopedForge {
  const { pluginId } = scope;
  const readerOf = deps.reader ?? ((dir: string | null) => githubForge(dir));

  /**
   * One read on the forge. `gh`'s words never reach the plugin: they may name
   * the config folder, and nothing in them is the plugin's to act on.
   */
  const read = async <T>(
    project: unknown,
    call: (reader: ForgeFacadeReader, repo: string) => Promise<{ ok: true; value: T } | { ok: false; code: string; reason: string }>,
    missing: 'undefined' | 'throw',
  ): Promise<T | undefined> => {
    const { repo, configDir } = where(slugOf(project));
    const running = inFlight.get(pluginId) ?? 0;
    if (running >= FORGE_CALLS_PER_PLUGIN) throw new PluginForgeError('busy', 'too many forge calls of this plugin at once');
    inFlight.set(pluginId, running + 1);
    try {
      const out = await call(readerOf(configDir), repo);
      if (out.ok) return out.value;
      if (missing === 'undefined' && out.code === 'gh_failed' && NOT_FOUND.test(out.reason)) return undefined;
      throw new PluginForgeError('unavailable', 'the forge did not answer');
    } finally {
      const left = (inFlight.get(pluginId) ?? 1) - 1;
      if (left > 0) inFlight.set(pluginId, left);
      else inFlight.delete(pluginId);
    }
  };

  return {
    repository(project) {
      const out = projectRepository(slugOf(project));
      return out.ok ? { project: out.value.slug, repo: out.value.repo, url: `https://github.com/${out.value.repo}` } : undefined;
    },

    issues: {
      async list(project, opts) {
        const label = (opts as { label?: unknown } | undefined)?.label;
        if (typeof label !== 'string' || label.length === 0 || label.length > 50 || CONTROL.test(label) || label.includes(',')) {
          throw new PluginForgeError('invalid', 'a label is required: up to 50 characters, no comma');
        }
        const issues = await read(project, async (reader, repo) => {
          const out = await reader.listIssues(repo, label);
          return out.ok ? { ok: true as const, value: out.issues } : out;
        }, 'throw');
        return (issues ?? []).map(issueView);
      },
      async get(project, number) {
        const n = numberOf(number);
        const issue = await read<IssueDetails>(project, async (reader, repo) => {
          const out = await reader.issueDetails(repo, n);
          return out.ok ? { ok: true as const, value: out.issue } : out;
        }, 'undefined');
        return issue
          ? { ...issueView(issue), body: issue.body, bodyTruncated: issue.bodyTruncated, stateReason: issue.stateReason }
          : undefined;
      },
    },

    pulls: {
      async list(project) {
        const pulls = await read(project, async (reader, repo) => {
          const out = await reader.listOpenPullRequests(repo);
          return out.ok ? { ok: true as const, value: out.pulls } : out;
        }, 'throw');
        return (pulls ?? []).map(pullView);
      },
      async get(project, number) {
        const n = numberOf(number);
        const pull = await read<PullRequestDetails>(project, async (reader, repo) => {
          const out = await reader.pullRequestDetails(repo, n);
          return out.ok ? { ok: true as const, value: out.pull } : out;
        }, 'undefined');
        return pull ? pullDetailsView(pull) : undefined;
      },
      async checks(project, number) {
        const n = numberOf(number);
        const view = await read(project, async (reader, repo) => {
          const out = await reader.pullRequestChecks(repo, n);
          return out.ok ? { ok: true as const, value: out.view } : out;
        }, 'undefined');
        return view
          ? {
            number: n, state: view.state, draft: view.draft, mergeable: view.mergeable, review: view.review,
            mergeState: view.mergeStateStatus,
            checks: view.checks.map((c) => ({ name: c.name, status: c.status, url: c.url })),
          }
          : undefined;
      },
    },

    propose(project, input) {
      if (!scope.mayPropose) {
        throw new PluginForgeError('forbidden', 'a proposal is made by the plugin itself or in a request a signed-in person made');
      }
      const slug = slugOf(project);
      const raw = (input ?? {}) as Partial<Record<keyof PluginForgeProposalInput, unknown>>;
      const target = raw.target as { type?: unknown; number?: unknown } | undefined;
      if (!target || (target.type !== 'issue' && target.type !== 'pull')) throw new PluginForgeError('invalid', 'target.type is `issue` or `pull`');
      const number = numberOf(target.number);
      if (typeof raw.body !== 'string') throw new PluginForgeError('invalid', 'body must be a string');
      const key = raw.key;
      if (typeof key !== 'string' || key.length === 0 || key.length > FORGE_PROPOSAL_KEY_LIMIT || CONTROL.test(key)) {
        throw new PluginForgeError('invalid', `key is required: up to ${FORGE_PROPOSAL_KEY_LIMIT} characters, no control character`);
      }
      const sourceRef = raw.sourceRef;
      if (sourceRef !== undefined && (typeof sourceRef !== 'string' || sourceRef.length === 0 || sourceRef.length > 200 || CONTROL.test(sourceRef))) {
        throw new PluginForgeError('invalid', 'sourceRef: up to 200 characters, no control character');
      }
      const stored = `${keyPrefix(pluginId)}${key}`;
      // A key already used answers its proposal, even past the cap: the cap
      // only holds back new cards.
      const known = getForgeProposalByKey(slug, stored);
      if (known) return { proposal: proposalView(known, pluginId), created: false };
      if (openPluginForgeProposals(pluginId) >= FORGE_OPEN_PROPOSALS_PER_PLUGIN) {
        throw new PluginForgeError('busy', `${FORGE_OPEN_PROPOSALS_PER_PLUGIN} proposals of this plugin already wait for a person`);
      }
      const out = proposeForgeWrite({
        project: slug,
        kind: 'comment',
        target: { type: target.type, number },
        body: raw.body,
        trigger: 'plugin',
        key: stored,
        sourceRef: sourceRef ?? null,
        createdBy: pluginAuthor(pluginId),
      }, deps.proposals);
      if (!out.ok) throw refusalError(out);
      return { proposal: proposalView(out.proposal, pluginId), created: out.created };
    },

    proposals: {
      list(project) {
        return listPluginForgeProposals(slugOf(project), pluginId).map((row) => proposalView(row, pluginId));
      },
      get(project, id) {
        if (typeof id !== 'string' || id.length > 64) return undefined;
        const row = getForgeProposal(slugOf(project), id);
        return row && row.trigger === 'plugin' && row.created_by === pluginAuthor(pluginId) ? proposalView(row, pluginId) : undefined;
      },
    },
  };
}
