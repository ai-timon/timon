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

/** The one forge command. `<n>` is the pull request number the agent found. */
export function forgeMergeLine(strategy: MergeStrategy): string {
  return `gh pr merge <n> --${strategy} --delete-branch`;
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
    `1. Find the open pull request. First the one whose head is the task branch, then the one whose head is the base (a fix whose base is already a pull-request branch):`,
    ``,
    '```bash',
    `gh pr list --head ${branch} --state open --json number,mergeable,statusCheckRollup`,
    `gh pr list --head ${base} --state open --json number,mergeable,statusCheckRollup`,
    '```',
    ``,
    `Use the first list that returns a pull request. If neither does, \`timon task block\` with the reason. Do not integrate locally.`,
    `2. Require that pull request to be mergeable (\`mergeable\` is \`MERGEABLE\`) and every check in \`statusCheckRollup\` to be completed and successful. An empty rollup means there is no check to wait for. A pending or failed check, or a pull request that is not mergeable: \`timon task block\` with the reason. Never force.`,
    `3. Remove the worktree that holds the branch, so the forge can delete it. The code task is \`${rootId}\`:`,
    ``,
    '```bash',
    `timon worktree dispose ${rootId}`,
    '```',
    ``,
    `4. Merge on the forge. This is the one line a later forge replaces:`,
    ``,
    '```bash',
    forgeMergeLine(strategy),
    '```',
    ``,
    `5. Take the FULL sha (40 hex) of the pull request's merge commit for \`timon task done --merged-sha\`. If the forge refuses because the branch is checked out in the main repository, \`timon task block\` with the reason. Do not check that branch out there, and run no \`git add\`, \`git commit\`, \`git checkout\`, \`git reset\` or \`git update-ref\` in the main repository.`,
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
    `Find the pull request and merge it as the task description says. Dispose the ` +
    `code task worktree named there before the forge deletes the branch. The forge ` +
    `command is one line:\n\n` +
    `\`\`\`bash\n${forgeMergeLine(strategy)}\n\`\`\`\n\n` +
    `Then \`timon task done --merged-sha\` with the FULL sha (40 hex) of the pull ` +
    `request's merge commit. If the pull request is missing, not mergeable, or a ` +
    `check is pending or failed, \`timon task block\` with the reason. Never force.`
  );
}

/** `code-self` when the project integrates through a pull request. Keeps the fast-mode sentence. */
export function pullRequestCodeSelfDirective(strategy: MergeStrategy): string {
  return (
    `\n\n---\nPIPELINE: \`code-self\`. Create NO \`review\` or \`merge\` task — ` +
    `the user chose the fast mode. This project's integration mode is \`pull-request\`. ` +
    `When your code is ready, follow the Integration section: push the branch and open ` +
    `or update the pull request, or push onto the base when that base already has an ` +
    `open pull request. Do not integrate locally. Require the pull request to be ` +
    `mergeable and every check completed and successful (an empty check list is ` +
    `enough). Then remove your worktree, because it holds the branch the forge ` +
    `deletes (\`timon worktree dispose <TASK_ID>\`; your cwd is gone after that), ` +
    `and merge with the one forge command:\n\n` +
    `\`\`\`bash\n${forgeMergeLine(strategy)}\n\`\`\`\n\n` +
    `Close with \`timon task done <TASK_ID> --comment "..." --merged-sha <SHA of the ` +
    `pull request's merge commit>\`. The sha is REQUIRED: without it the task goes ` +
    `back to BLOCKED (guard against never-merged branches). If the pull request ` +
    `is missing, not mergeable, or a check is pending or failed, do not force: ` +
    `\`timon task block\` with the reason.`
  );
}

/** `code-group` when the project integrates through a pull request. */
export function pullRequestCodeGroupDirective(): string {
  return (
    `\n\n---\nPIPELINE: \`code-group\`. Create NO \`review\` or \`merge\` task — ` +
    `the user chose the fast mode and a final \`merge\` task will consolidate the whole ` +
    `group on the forge. This project's integration mode is \`pull-request\`. ` +
    `Push as the Integration section says. Do not integrate locally. Commit on ` +
    `your branch, leave it as is, and close with ` +
    `\`timon task done <TASK_ID> --comment "..."\`.`
  );
}
