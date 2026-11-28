/**
 * The copy of a landed job's branch on the remote (TODO #1210): never deleted
 * by the cleanup after a landing (`integration-cleanup.ts`), only proposed.
 *
 * Like every write on the forge it is a proposal (`forge-proposals.ts`, kind
 * `delete_branch`): the daemon prepares it once the job's local leftovers are
 * dealt with, a signed-in person approves it in the "Publish on GitHub"
 * window, or keeps the branch. Nothing reaches the remote before that.
 *
 * Publishing proves everything again, at that moment: the proposal still
 * names the job's row as it landed, the project still pushes to the
 * repository it was made for, the commit that landed is in the target, and
 * the remote branch still ends on it. The push that deletes it is leased on
 * that very commit, so a branch someone pushed to since is refused, never
 * deleted. A branch already gone answers so, and nothing is written.
 */
import { dbApi, type IntegrationRow } from './db.js';
import { projectRepository } from './external-pr-review.js';
import {
  proposalPayload, proposeForgeWrite, registerForgeProposalExecutor,
  type ForgeProposalDeps, type ForgeProposalExecution, type ForgeProposalExecutorResult, type ProposeOutcome,
} from './forge-proposals.js';
import { deleteRemoteBranch, githubRepoFromUrl, gitTransport } from './host/forge.js';
import { getHost } from './host/index.js';

/** What the proposal and its publication reach (tests: the stand-ins of `gh` and git). */
export type RemoteDeletionDeps = ForgeProposalDeps;

/** Branch names never deleted, whatever a row says. */
export function sacredBranch(row: Pick<IntegrationRow, 'target'>, branch: string): boolean {
  return branch === 'main' || branch === 'master' || branch === row.target;
}

/** The ref the landed work is in: the remote's target, or the local one. */
export function landedRef(row: Pick<IntegrationRow, 'remote' | 'target'>): string {
  return row.remote ? `refs/remotes/${row.remote}/${row.target}` : `refs/heads/${row.target}`;
}

/** The proposal's key: one deletion per landed integration. */
export function remoteDeletionKey(row: Pick<IntegrationRow, 'id'>): string {
  return `integration:${row.id}:delete-branch`;
}

/** What the window shows: what GitHub loses, and on which condition. */
export function deletionText(row: Pick<IntegrationRow, 'branch' | 'target' | 'pr_number' | 'head_sha'>): string {
  return `Delete the branch \`${row.branch}\` of pull request #${row.pr_number} on GitHub, now merged into \`${row.target}\`. `
    + `Only while it still ends on ${row.head_sha!.slice(0, 12)}, the commit that landed: a branch pushed to since is kept.`;
}

const SHA = /^[0-9a-f]{40,64}$/;

async function landed(row: IntegrationRow, sha: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const r = await getHost().execAsync('git', ['-C', row.repo, 'merge-base', '--is-ancestor', sha, landedRef(row)], { timeout: 30_000, windowsHide: true });
    if (r.timedOut) return 'unknown';
    return r.code === 0 ? 'yes' : r.code === 1 ? 'no' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Proposes the deletion of the remote copy of the landed `row`'s branch, when
 * there is one that still ends on the commit that landed. Null when there is
 * nothing to propose; a refusal when the project cannot take one.
 */
export async function proposeRemoteBranchDeletion(row: IntegrationRow, deps: ForgeProposalDeps = {}): Promise<ProposeOutcome | null> {
  if (row.state !== 'merged' || row.mode !== 'pr' || !row.remote || !row.project) return null;
  if (!row.head_sha || !SHA.test(row.head_sha) || !row.pr_number) return null;
  if (sacredBranch(row, row.branch)) return null;
  // A project that no longer lands through pull requests has nothing to ask.
  const where = projectRepository(row.project);
  if (!where.ok) return null;
  // The branch lives where it was pushed: the fork when the project has one.
  const url = where.value.integration.push_remote_url ?? where.value.integration.remote_url;
  if (!url) return null;
  // The forge may delete a merged head itself: nothing to ask then.
  const there = await gitTransport(row.repo, deps.runners, where.value.integration.gh_config_dir).remoteBranchSha(url, row.branch);
  if (there.ok && there.sha === null) return null;
  if (there.ok && there.sha !== row.head_sha) {
    console.log(`[integration-cleanup] remote ${row.branch} kept: it moved since its pull request was merged`);
    return null;
  }
  return proposeForgeWrite({
    project: row.project,
    kind: 'delete_branch',
    target: { type: 'pull', number: row.pr_number },
    body: deletionText(row),
    trigger: 'landing',
    key: remoteDeletionKey(row),
    sourceRef: `integration:${row.id}`,
    payload: { integration_id: row.id, branch: row.branch, head_sha: row.head_sha },
    createdBy: null,
  }, deps);
}

type Refusal = Extract<ForgeProposalExecutorResult, { ok: false }>;
const refused = (code: Refusal['code'], reason: string, status: number, failed: boolean): Refusal =>
  ({ ok: false, code, reason, status, failed });

async function executeDelete(run: ForgeProposalExecution): Promise<ForgeProposalExecutorResult> {
  const payload = proposalPayload(run.row);
  const id = typeof payload.integration_id === 'string' ? payload.integration_id : null;
  const branch = typeof payload.branch === 'string' ? payload.branch : null;
  const head = typeof payload.head_sha === 'string' && SHA.test(payload.head_sha) ? payload.head_sha : null;
  if (!id || !branch || !head) return refused('forge_proposal_invalid', 'this proposal does not say which branch to delete', 500, true);
  const row = dbApi.getIntegrationById(id);
  if (!row || row.project !== run.row.project || row.state !== 'merged' || row.branch !== branch || row.head_sha !== head) {
    return refused('forge_proposal_invalid', 'the job this branch belongs to changed since the deletion was proposed: discard it', 409, true);
  }
  if (sacredBranch(row, branch)) return refused('forge_branch_forbidden', `${branch} is never deleted`, 409, true);
  const targetUrl = run.integration.remote_url;
  if (!targetUrl || githubRepoFromUrl(targetUrl)?.toLowerCase() !== run.row.repo.toLowerCase()) {
    return refused('forge_proposal_repository_changed', `the project no longer pushes to ${run.row.repo}: discard it`, 409, true);
  }
  const proof = await landed(row, head);
  if (proof !== 'yes') {
    return refused('forge_head_unknown', proof === 'no'
      ? `the commit that landed is not in ${row.remote}/${row.target} on this machine: the branch is kept`
      : 'git cannot tell whether the commit that landed is in the target', 409, proof === 'no');
  }
  const configDir = run.integration.gh_config_dir;
  const url = run.integration.push_remote_url ?? targetUrl;
  const there = await gitTransport(row.repo, run.deps.runners, configDir).remoteBranchSha(url, branch);
  if (!there.ok) return refused('forge_read_failed', `the remote branch could not be read: ${run.scrub(there.reason)}`, 502, false);
  const pull = row.pr_url ?? `https://github.com/${run.row.repo}/pull/${run.row.target_number}`;
  if (there.sha === null) return { ok: true, url: pull, already: true };
  if (there.sha !== head) return refused('forge_head_moved', 'someone pushed to the branch since it was merged: it is kept', 409, true);
  const out = await deleteRemoteBranch(row.repo, url, branch, head, run.deps.runners, configDir);
  if (!out.ok) {
    return out.code === 'rejected'
      ? refused('forge_push_rejected', `the remote refused the deletion: ${run.scrub(out.reason)}`, 409, true)
      : refused('forge_publish_failed', `the branch was not deleted: ${run.scrub(out.reason)}`, 502, true);
  }
  console.log(`[integration-cleanup] remote ${branch} deleted on ${run.row.repo}, approved by a person`);
  return { ok: true, url: pull, already: false };
}

registerForgeProposalExecutor('delete_branch', { editable: false, execute: executeDelete });
