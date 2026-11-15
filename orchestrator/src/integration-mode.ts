/**
 * How a project integrates a finished task branch.
 *
 * `local` (the default, including a missing or unreadable setting) keeps the
 * historical briefs: the merger fast-forwards the base from its worktree.
 * `pull-request` replaces those briefs. The daemon never calls the forge.
 * The brief names one command, so a later forge is a one-line change.
 */
import { readMeta } from './projects.js';

export type IntegrationMode = 'local' | 'pull-request';
export type MergeStrategy = 'squash' | 'merge' | 'rebase';

const STRATEGIES: readonly MergeStrategy[] = ['squash', 'merge', 'rebase'];

/** Block reason when a merge queue does not finish. English, so the public tree stays English. */
const MERGE_QUEUE_WAIT = 'merge queue wait exceeded 30 minutes';

export function integrationSettings(slug: string | null | undefined): {
  mode: IntegrationMode;
  strategy: MergeStrategy;
} {
  if (!slug) return { mode: 'local', strategy: 'squash' };
  let integration: string | null | undefined;
  let mergeStrategy: string | null | undefined;
  try {
    const meta = readMeta(slug);
    integration = meta.integration;
    mergeStrategy = meta.merge_strategy;
  } catch {
    return { mode: 'local', strategy: 'squash' };
  }
  const mode: IntegrationMode = integration === 'pull-request' ? 'pull-request' : 'local';
  const strategy: MergeStrategy = STRATEGIES.includes(mergeStrategy as MergeStrategy)
    ? (mergeStrategy as MergeStrategy)
    : 'squash';
  return { mode, strategy };
}

/** Every `gh` command. Resolved before any worktree is removed, so `gh` still
 *  knows the repository after that checkout is gone. */
const GH_REPO = '--repo <owner/name>';

/** The one forge command. `<n>` is the pull request number the agent found. */
export function forgeMergeLine(strategy: MergeStrategy): string {
  return `gh pr merge <n> ${GH_REPO} --${strategy} --delete-branch`;
}

function resolveRepoStep(): string {
  return [
    `Resolve \`<owner/name>\` before you remove any worktree. Run this from the worktree, or from the source repository:`,
    ``,
    '```bash',
    'gh repo view --json nameWithOwner --jq .nameWithOwner',
    '```',
    ``,
    `Pass \`${GH_REPO}\` on every later \`gh\` command. Once a worktree is gone, \`gh\` has no checkout to guess the repository from: keep \`${GH_REPO}\`, or run \`gh\` from the source repository.`,
  ].join('\n');
}

function waitForChecksStep(): string {
  return [
    `Wait while checks are still running. Do not block because a check is pending. An empty rollup means there is no check to wait for. Otherwise:`,
    ``,
    '```bash',
    `gh pr checks <n> ${GH_REPO} --watch --fail-fast`,
    '```',
    ``,
    `Or a bounded loop, at most 30 minutes, on \`gh pr view <n> ${GH_REPO} --json statusCheckRollup\` until every check has completed. Block only when a check fails, the pull request is not \`MERGEABLE\`, or that wait exceeds 30 minutes. Never force.`,
  ].join('\n');
}

/** `rootHint` says which worktree is not the one to remove by default. */
function disposeHeadStep(rootHint: string): string {
  return [
    `Remove the worktree whose branch is the pull request's head, so the forge can delete that branch. ${rootHint}`,
    ``,
    '```bash',
    'git -C <source-repo> worktree list --porcelain',
    '```',
    ``,
    `\`<source-repo>\` is the source repository this brief names. Match the \`branch\` line \`refs/heads/<head>\` to the task whose \`branch_name\` is that head, then dispose that task. If no worktree has that branch, skip disposal.`,
    ``,
    '```bash',
    'timon worktree dispose <task-id>',
    '```',
  ].join('\n');
}

function mergeAndShaStep(strategy: MergeStrategy): string {
  return [
    `Merge on the forge. This is the one line a later forge replaces:`,
    ``,
    '```bash',
    forgeMergeLine(strategy),
    '```',
    ``,
    `If that command puts the pull request in the merge queue, \`state\` is not \`MERGED\` yet. Wait with a bounded loop, at most 30 minutes, before you read the sha:`,
    ``,
    '```bash',
    `gh pr view <n> ${GH_REPO} --json state,mergeCommit`,
    '```',
    ``,
    `Stop when \`state\` is \`MERGED\` and \`mergeCommit.oid\` is a full sha (40 hex). If the wait exceeds 30 minutes, \`timon task block\` with the reason \`${MERGE_QUEUE_WAIT}\`.`,
    ``,
    `If \`gh pr merge\` exits non-zero, still read the merge commit before you decide the forge refused:`,
    ``,
    '```bash',
    `gh pr view <n> ${GH_REPO} --json mergeCommit --jq .mergeCommit.oid`,
    '```',
    ``,
    `A full sha means the pull request is merged and only the local branch deletion failed, because the branch was still checked out. Close DONE with \`timon task done --merged-sha\` and that sha. No sha means the forge refused: \`timon task block\` with the reason. Do not check that branch out in the main repository, and run no \`git add\`, \`git commit\`, \`git checkout\`, \`git reset\` or \`git update-ref\` there.`,
  ].join('\n');
}

/**
 * Appended to a coding task's worktree brief when the project integrates
 * through a pull request. The agent decides, from `gh pr list`, whether the
 * base already carries an open pull request: the daemon does not call the forge.
 */
export function codeIntegrationSection(branch: string, base: string): string {
  const same = branch === base;
  const head = same
    ? `Your branch \`${branch}\` is the base. Push that branch. Do not open a pull ` +
      `request whose head and base are the same.\n\n` +
      `\`\`\`bash\ngit push -u origin ${branch}\n\`\`\`\n`
    : `- If that list is not empty: push your commits onto \`${base}\`. Do not open a ` +
      `second pull request. Do not integrate locally.\n\n` +
      `\`\`\`bash\ngit push origin HEAD:${base}\n\`\`\`\n\n` +
      `- If that list is empty: push your branch and open a pull request against ` +
      `\`${base}\`. If a pull request for head \`${branch}\` already exists, update ` +
      `it. Do not open a second one.\n\n` +
      `\`\`\`bash\ngit push -u origin ${branch}\n` +
      `gh pr create --base ${base} --head ${branch} --title "<title>" --body "<summary>"\n\`\`\`\n`;
  return (
    `\n\n## Integration — pull request\n\n` +
    `This project's integration mode is \`pull-request\`. That mode is the explicit ` +
    `push authorisation the timon-worktree skill asks for: push only what this ` +
    `section names. Do not push \`${base}\`. Do not integrate locally into \`${base}\`.\n\n` +
    `Find whether the base already has an open pull request:\n\n` +
    `\`\`\`bash\ngh pr list --head ${base} --state open --json number\n\`\`\`\n\n` +
    head
  );
}

/** Replaces the local merge description. No local merge, fast-forward, or push of the base. */
export function pullRequestMergeDescription(args: {
  reviewId: string;
  rootId: string;
  branch: string;
  base: string;
  strategy: MergeStrategy;
}): string {
  const { reviewId, rootId, branch, base, strategy } = args;
  return [
    `Automatic merge through a pull request: review [${reviewId}] approved (verdict pass) the branch produced by code task [${rootId}].`,
    ``,
    `This project's integration mode is \`pull-request\`. That mode is the explicit push authorisation for the forge command below, and for no other push. Do not integrate into \`${base}\`: no fast-forward of \`${base}\`, no push of \`${base}\`, no merge whose destination is \`${base}\`.`,
    ``,
    `**Branch**: \`${branch}\``,
    `**Base**: \`${base}\``,
    ``,
    `## What to do`,
    ``,
    `### 1. Repository`,
    ``,
    resolveRepoStep(),
    ``,
    `### 2. Pull request`,
    ``,
    `Find the open pull request. First the one whose head is the task branch, then the one whose head is the base (a fix whose base is already a pull-request branch):`,
    ``,
    '```bash',
    `gh pr list ${GH_REPO} --head ${branch} --state open --json number,mergeable,statusCheckRollup`,
    `gh pr list ${GH_REPO} --head ${base} --state open --json number,mergeable,statusCheckRollup`,
    '```',
    ``,
    `Use the first list that returns a pull request. If neither does, \`timon task block\` with the reason. Do not integrate locally.`,
    ``,
    `### 3. Checks`,
    ``,
    waitForChecksStep(),
    ``,
    `### 4. Worktree`,
    ``,
    disposeHeadStep(
      `Do not remove the worktree of code task \`${rootId}\` unless its branch is that head. A fix whose base is already a pull-request branch is checked out in the earlier task's worktree, not in \`${rootId}\`'s.`,
    ),
    ``,
    `### 5. Merge`,
    ``,
    mergeAndShaStep(strategy),
  ].join('\n');
}

/** Replaces the "Where you merge" hard rule. Refresh notes above it stay: they update the task branch, not the base. */
export function pullRequestMergeWorktreeSection(args: {
  path: string;
  branch: string;
  base: string;
  sourceRepo: string;
  strategy: MergeStrategy;
}): string {
  const { path, branch, base, sourceRepo, strategy } = args;
  return (
    `\n\n## Where you merge — hard rule\n\n` +
    `This project's integration mode is \`pull-request\`. You have YOUR worktree: ` +
    `\`${path}\` (branch \`${branch}\`). Do not use it to integrate into \`${base}\`.\n\n` +
    `The main repo (\`${sourceRepo}\`) has only ONE working directory, shared by ` +
    `every agent. **Run no command that writes there**: no \`git add\`, no ` +
    `\`git commit\`, no \`git checkout\`, no \`git reset\`, no \`git update-ref\`.\n\n` +
    `Do not integrate into \`${base}\`: no fast-forward of \`${base}\`, no push of ` +
    `\`${base}\`, no merge whose destination is \`${base}\`.\n\n` +
    `The source repository is \`${sourceRepo}\`. Resolve \`<owner/name>\` with ` +
    `\`gh repo view --json nameWithOwner --jq .nameWithOwner\` before you remove ` +
    `any worktree, and pass \`${GH_REPO}\` on every \`gh\` command. After a worktree ` +
    `is gone, run \`gh\` with that \`--repo\` or from \`${sourceRepo}\`.\n\n` +
    `Follow the task description. Wait for checks (\`gh pr checks <n> ${GH_REPO} ` +
    `--watch --fail-fast\`, or a bounded loop); do not block while a check is still ` +
    `pending. List worktrees with \`git -C ${sourceRepo} worktree list --porcelain\` ` +
    `and dispose the task whose branch is the pull request head. Do not dispose a ` +
    `task whose branch is not that head.\n\n` +
    `The forge command is one line:\n\n` +
    `\`\`\`bash\n${forgeMergeLine(strategy)}\n\`\`\`\n\n` +
    `If that queues the pull request, wait until \`gh pr view <n> ${GH_REPO} --json ` +
    `state,mergeCommit\` reports \`MERGED\`, at most 30 minutes, before you read the ` +
    `sha. Past that, \`timon task block\` with the reason \`${MERGE_QUEUE_WAIT}\`. ` +
    `If \`gh pr merge\` exits non-zero, a full sha from \`gh pr view <n> ${GH_REPO} ` +
    `--json mergeCommit\` still closes the task DONE: the pull request merged and ` +
    `only the local branch deletion failed. No merge commit means the forge refused. ` +
    `Never force.\n\n` +
    `\`code-group\` is not supported in \`pull-request\` mode. If this task consolidates ` +
    `a group, do not merge one pull request and leave the others open: \`timon task ` +
    `block\` with the reason \`code-group is not supported in pull-request mode\`.`
  );
}

/** `code-self` when the project integrates through a pull request. Keeps the fast-mode sentence. */
export function pullRequestCodeSelfDirective(strategy: MergeStrategy): string {
  return (
    `\n\n---\nPIPELINE: \`code-self\`. Create NO \`review\` or \`merge\` task — ` +
    `the user chose the fast mode. This project's integration mode is \`pull-request\`. ` +
    `When your code is ready, follow the Integration section: push the branch and open ` +
    `or update the pull request, or push onto the base when that base already has an ` +
    `open pull request. Do not integrate locally.\n\n` +
    `${resolveRepoStep()}\n\n` +
    `Find that pull request with \`gh pr list ${GH_REPO}\`: first \`--head\` your branch, ` +
    `then \`--head\` the base when you pushed onto a pull request that already exists. ` +
    `Use the first list that returns one. If neither does, \`timon task block\` with ` +
    `the reason.\n\n` +
    `${waitForChecksStep()}\n\n` +
    `${mergeAndShaStep(strategy)}\n\n` +
    `Close with \`timon task done <TASK_ID> --comment "..." --merged-sha <SHA of the ` +
    `pull request's merge commit>\`. The sha is REQUIRED: without it the task goes ` +
    `back to BLOCKED (guard against never-merged branches). Close before you remove ` +
    `any worktree. Your cwd is that worktree: removing it first makes this close ` +
    `fail, and the task never finishes.\n\n` +
    `${disposeHeadStep(
      `Do this last, after \`timon task done\`. That worktree is yours only when the head is your branch. When you pushed onto a base that already has a pull request, the head is that base, checked out in the earlier task's worktree. Do not dispose your own task id unless its branch is the head.`,
    )}`
  );
}

/** `code-group` is not supported in pull-request mode.
 *
 *  Each code task would open its own pull request, and the merge brief only
 *  knows how to merge one. Refusing here is the honest path: a real group
 *  merge would have to order those pull requests and resolve conflicts
 *  between them, which this mode does not specify. `local` mode is unchanged.
 */
export function pullRequestCodeGroupDirective(): string {
  return (
    `\n\n---\nPIPELINE: \`code-group\`. Create NO \`review\` or \`merge\` task — ` +
    `the user chose the fast mode. This project's integration mode is \`pull-request\`, ` +
    `and \`code-group\` is not supported in that mode: each code task would open its ` +
    `own pull request, and nothing merges every one of them. Do not push. Do not ` +
    `open a pull request. Do not integrate locally. \`timon task block\` with ` +
    `the reason \`code-group is not supported in pull-request mode\`.`
  );
}
