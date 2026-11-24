/**
 * "Update the branch" of a pull request (`docs/FORGE-FLOW-PLAN.md` §6.1, D7):
 * GitHub merges the base into the pull request's branch, on its side, through
 * its `update-branch` endpoint. Nothing is fetched, checked out or run here.
 *
 * It is a publication like any other (`forge-proposals.ts`): a signed-in
 * person asks for it, the daemon reads the branch and prepares a proposal that
 * records the head it saw, and the person publishes it. Publishing reads the
 * branch again and passes that head to GitHub as `expected_head_sha`: a push
 * of the contributor in between makes GitHub refuse, so the update never lands
 * on a branch the person did not look at.
 *
 * Refused before anything is proposed: a closed pull request, one GitHub does
 * not see behind its base (a conflict goes to `forge-conflicts.ts` instead),
 * and a fork whose author did not let the maintainers modify the branch.
 */
import { projectRepository, type ExternalPrRefusal } from './external-pr-review.js';
import {
  proposalPayload, proposeForgeWrite, registerForgeProposalExecutor,
  type ForgeProposalDeps, type ForgeProposalExecution, type ForgeProposalExecutorResult, type ForgeProposalRefusal,
  type ForgeProposalRefusalCode, type ProposeOutcome,
} from './forge-proposals.js';
import {
  githubForge, type ForgeBranchWriter, type PullRequestBranch, type PullRequestSummary,
} from './host/forge.js';
import type { ProjectIntegration } from './project-integration.js';

const COMMIT_SHA = /^[0-9a-f]{40,64}$/;

const refuse = (status: number, code: ForgeProposalRefusalCode, reason: string): ForgeProposalRefusal =>
  ({ ok: false, status, code, reason });

export function branchForge(configDir: string | null, deps: ForgeProposalDeps): ForgeBranchWriter {
  return (deps.branchForge ?? ((dir) => githubForge(dir, deps.runners)))(configDir);
}

/** The project's repository could not be resolved: the same refusal, under the proposals' codes. */
export function repositoryRefusal(out: ExternalPrRefusal): ForgeProposalRefusal {
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

/** The branch lives in another repository than the pull request (a fork). */
export function isFork(repo: string, headRepository: string | null): boolean {
  return headRepository === null || headRepository.toLowerCase() !== repo.toLowerCase();
}

/** What the person may do about a pull request's branch, as its list shows it. */
export type BranchGestures = {
  /** GitHub sees the branch behind its base: "Update the branch". */
  update_branch: boolean;
  /** The branch conflicts with its base: "Ask the contributor" (a comment). */
  ask_contributor: boolean;
  /** …and Timon may merge it itself (`forge-conflicts.ts`): a fork whose
   *  author lets the maintainers push, on a project that allows it. */
  resolve_conflict: boolean;
  /** Why no one here may write the branch, whatever its state: its author
   *  does not let the maintainers modify it, or its fork was deleted. The
   *  list says it on the row, so a missing "Update" or "Resolve" has a reason. */
  locked: 'not_allowed' | 'fork_deleted' | null;
};

/** Read from the list's summary: no call to the forge. */
export function branchGestures(
  repo: string,
  pull: Pick<PullRequestSummary, 'headRepository' | 'maintainerCanModify' | 'mergeStateStatus'>,
  setting: Pick<ProjectIntegration, 'contributor_conflicts'>,
): BranchGestures {
  const fork = isFork(repo, pull.headRepository);
  // A deleted fork has no branch left to write.
  const writable = pull.headRepository !== null && (!fork || pull.maintainerCanModify);
  const dirty = pull.mergeStateStatus === 'dirty';
  return {
    update_branch: pull.mergeStateStatus === 'behind' && writable,
    ask_contributor: dirty,
    resolve_conflict: dirty && fork && writable && setting.contributor_conflicts === 'resolve',
    locked: writable ? null : pull.headRepository === null ? 'fork_deleted' : 'not_allowed',
  };
}

/** What a branch update runs with, written when it was proposed. */
type UpdatePayload = { expected_head_sha: string; base_ref: string; head_ref: string; head_repository: string | null };

/** The idempotency key of a branch update: one per pull request and head. */
export function branchUpdateKey(number: number, headSha: string): string {
  return `pull:${number}:update-branch:${headSha}`;
}

function updateText(number: number, branch: PullRequestBranch, headSha: string): string {
  return `Update the branch of #${number} on GitHub: GitHub merges \`${branch.baseRef}\` into \`${branch.headRef}\`, `
    + `whose head is ${headSha.slice(0, 12)}. Nothing runs on this machine.`;
}

/** Why GitHub would refuse to update this branch, or null. */
function updateProblem(repo: string, branch: PullRequestBranch): ForgeProposalRefusal | null {
  if (branch.state !== 'open') return refuse(409, 'forge_pull_closed', `the pull request is ${branch.state}`);
  if (!branch.headSha) return refuse(409, 'forge_head_unknown', 'the forge did not tell the head of the branch');
  if (branch.headRepository === null) return refuse(409, 'forge_branch_not_modifiable', 'the fork of this pull request was deleted');
  if (isFork(repo, branch.headRepository) && !branch.maintainerCanModify) {
    return refuse(409, 'forge_branch_not_modifiable', 'the author of this pull request does not let the maintainers modify its branch');
  }
  // A draft hides its merge state behind `draft`: GitHub then tells only
  // whether it merges cleanly, and refuses the update itself when it is not behind.
  const behind = branch.mergeStateStatus === 'behind' || (branch.mergeStateStatus === 'draft' && branch.mergeable === 'mergeable');
  if (!behind) {
    return branch.mergeable === 'conflicting' || branch.mergeStateStatus === 'dirty'
      ? refuse(409, 'forge_pull_not_behind', 'the branch conflicts with its base: GitHub cannot update it, resolve the conflict instead')
      : refuse(409, 'forge_pull_not_behind', `GitHub does not see the branch behind its base (${branch.mergeStateStatus})`);
  }
  return null;
}

/**
 * Prepares the update of a pull request's branch for a person to publish.
 * One call to the forge (the branch), nothing written there.
 */
export async function proposeBranchUpdate(
  project: string, number: number, by: string, deps: ForgeProposalDeps = {},
): Promise<ProposeOutcome> {
  if (!Number.isSafeInteger(number) || number <= 0) return refuse(400, 'forge_proposal_invalid', 'not a pull request number');
  const where = projectRepository(project);
  if (!where.ok) return repositoryRefusal(where);
  const { repo, integration } = where.value;
  const read = await branchForge(integration.gh_config_dir, deps).pullRequestBranch(repo, number);
  if (!read.ok) return refuse(502, 'forge_read_failed', `the pull request could not be read: ${read.reason}`);
  const problem = updateProblem(repo, read.branch);
  if (problem) return problem;
  const headSha = read.branch.headSha!;
  const payload: UpdatePayload = {
    expected_head_sha: headSha,
    base_ref: read.branch.baseRef,
    head_ref: read.branch.headRef,
    head_repository: read.branch.headRepository,
  };
  return proposeForgeWrite({
    project,
    kind: 'update_branch',
    target: { type: 'pull', number },
    body: updateText(number, read.branch, headSha),
    trigger: 'person',
    key: branchUpdateKey(number, headSha),
    payload,
    createdBy: by,
  }, deps);
}

const failed = (code: ForgeProposalRefusalCode, reason: string, status = 409): ForgeProposalExecutorResult =>
  ({ ok: false, code, reason, status, failed: true });
const unchanged = (code: ForgeProposalRefusalCode, reason: string, status = 409): ForgeProposalExecutorResult =>
  ({ ok: false, code, reason, status, failed: false });

async function executeUpdate(run: ForgeProposalExecution): Promise<ForgeProposalExecutorResult> {
  const { row } = run;
  const payload = proposalPayload(row);
  const expected = typeof payload.expected_head_sha === 'string' && COMMIT_SHA.test(payload.expected_head_sha)
    ? payload.expected_head_sha : null;
  if (!expected) return failed('forge_proposal_invalid', 'this proposal does not say which head it expects', 500);
  const forge = branchForge(run.configDir, run.deps);
  const read = await forge.pullRequestBranch(row.repo, row.target_number);
  if (!read.ok) return failed('forge_read_failed', `the pull request could not be read: ${run.scrub(read.reason)}`, 502);
  const branch = read.branch;
  if (branch.state !== 'open') return unchanged('forge_pull_closed', `the pull request is ${branch.state}`);
  if (branch.headSha !== expected) {
    // An earlier attempt may have updated the branch before its answer was
    // lost: the new head is then GitHub's merge on top of the expected one.
    if (run.earlierAttempts > 0 && branch.headSha) {
      const parents = await forge.commitParents(row.repo, branch.headSha);
      if (parents.ok && parents.parents[0] === expected) return { ok: true, url: branch.url, already: true };
    }
    return failed('forge_head_moved', 'the branch moved since this update was proposed: discard it and look again');
  }
  if (isFork(row.repo, branch.headRepository) && !branch.maintainerCanModify) {
    return unchanged('forge_branch_not_modifiable', 'the author of this pull request no longer lets the maintainers modify its branch');
  }
  const out = await forge.updatePullRequestBranch(row.repo, row.target_number, expected);
  if (out.ok) return { ok: true, url: branch.url, already: false };
  const reason = run.scrub(out.reason);
  switch (out.code) {
    case 'head_moved': return failed('forge_head_moved', 'the branch moved since this update was proposed: discard it and look again');
    case 'conflict': return failed('forge_branch_conflict', 'GitHub cannot merge the base into this branch: it conflicts');
    case 'forbidden': return failed('forge_branch_forbidden', `GitHub refused the update to this account: ${reason}`, 403);
    default: return failed('forge_publish_failed', `the branch was not updated: ${reason}`, 502);
  }
}

registerForgeProposalExecutor('update_branch', { editable: false, execute: executeUpdate });
