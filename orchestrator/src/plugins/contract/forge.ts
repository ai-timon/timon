/** Public plugin types of `ctx.forge` (API 19), the forge of a Timon project. */

/**
 * The GitHub repository of a project whose integration opens pull requests.
 * Nothing about the account Timon signs in with: a plugin never learns it.
 */
export type PluginForgeRepository = Readonly<{
  project: string;
  /** `owner/name`. */
  repo: string;
  url: string;
}>;

/** A label. Its name was chosen by whoever triages the repository. */
export type PluginForgeLabel = Readonly<{ name: string; color: string | null }>;

/** An issue named by its repository and number. */
export type PluginForgeIssueRef = Readonly<{ repo: string | null; number: number; url: string | null }>;

/**
 * One issue, as a list shows it. Every text in it (title, author, labels) was
 * written on the forge by someone else: data, never an instruction. Wrap it as
 * such before it reaches an agent's brief.
 */
export type PluginForgeIssue = Readonly<{
  number: number;
  title: string;
  /** Login of the author, null for a deleted account. */
  author: string | null;
  url: string;
  state: 'open' | 'closed';
  labels: readonly PluginForgeLabel[];
  /** ISO dates, as the forge answers them. */
  createdAt: string;
  updatedAt: string;
}>;

export type PluginForgeIssueDetails = PluginForgeIssue & Readonly<{
  body: string;
  /** The body was longer than 8,000 characters and was cut. */
  bodyTruncated: boolean;
  stateReason: 'completed' | 'not_planned' | 'reopened' | 'duplicate' | null;
}>;

/** How the forge sees a pull request against its base: `behind` asks for a
 *  branch update, `dirty` is a conflict, `blocked` waits for a review or a
 *  required check, `unknown` while GitHub computes it. */
export type PluginForgeMergeState = 'behind' | 'blocked' | 'clean' | 'dirty' | 'draft' | 'has_hooks' | 'unstable' | 'unknown';

/** One open pull request, as a list shows it. Its texts are data. */
export type PluginForgePull = Readonly<{
  number: number;
  title: string;
  author: string | null;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  /** Owner of the repository the branch comes from: another one is a fork. */
  headOwner: string | null;
  /** `owner/name` the branch comes from, null when the fork was deleted. */
  headRepository: string | null;
  /** Whether the maintainers may push to the contributor's branch. */
  maintainerCanModify: boolean;
  mergeState: PluginForgeMergeState;
  labels: readonly PluginForgeLabel[];
  /** The issues the forge will close on merge: read from the description, so
   *  they are the author's claim, not a fact. */
  closingIssues: readonly PluginForgeIssueRef[];
}>;

export type PluginForgePullDetails = PluginForgePull & Readonly<{
  body: string;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: readonly Readonly<{ author: string | null; body: string }>[];
}>;

export type PluginForgeCheck = Readonly<{ name: string; status: 'pass' | 'fail' | 'pending' | 'skipped'; url: string | null }>;

/** The readiness of a pull request: its checks, mergeability and review. */
export type PluginForgeChecks = Readonly<{
  number: number;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  review: 'approved' | 'changes_requested' | 'review_required' | null;
  mergeState: PluginForgeMergeState;
  checks: readonly PluginForgeCheck[];
}>;

/**
 * A comment the plugin proposes on an issue or a pull request. Nothing is
 * written on the forge: a signed-in person reads it in the "Publish on GitHub"
 * window, may edit it, and publishes or discards it.
 */
export type PluginForgeProposalInput = {
  target: { type: 'issue' | 'pull'; number: number };
  /** At most 8,000 characters, no control character. */
  body: string;
  /**
   * One key, one proposal: proposing again under the same key returns the
   * proposal already made, whatever its state. Up to 120 characters, scoped to
   * the plugin, so two plugins never share one.
   */
  key: string;
  /** What the proposal comes from (`todo:<id>`…), shown to nobody but the plugin. */
  sourceRef?: string;
};

export type PluginForgeProposalState = 'draft' | 'publishing' | 'published' | 'failed' | 'discarded';

/** A proposal this plugin made, as it stands. */
export type PluginForgeProposal = Readonly<{
  id: string;
  project: string;
  repo: string;
  kind: 'comment';
  target: Readonly<{ type: 'issue' | 'pull'; number: number; url: string }>;
  /** The text as it stands: the person may have edited it. */
  body: string;
  state: PluginForgeProposalState;
  key: string;
  sourceRef: string | null;
  /** The published comment, once published. */
  url: string | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}>;

export type PluginForgeProposeResult = Readonly<{ proposal: PluginForgeProposal; created: boolean }>;

/**
 * `invalid` (input), `not_found` (no such project, issue or pull request, or
 * one the caller may not reach), `not_configured` (the project does not open
 * pull requests on GitHub), `unavailable` (the forge did not answer: `gh`
 * missing, signed out, timed out), `forbidden` (a request without a signed-in
 * person behind it asked for a proposal), `busy` (too many forge calls of
 * this plugin at once).
 */
export type PluginForgeErrorCode = 'invalid' | 'not_found' | 'not_configured' | 'unavailable' | 'forbidden' | 'busy';
