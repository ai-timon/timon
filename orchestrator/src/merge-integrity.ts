/**
 * Integrity check of a merge: did it erase work that did not
 * belong to it?
 *
 * FOUNDING INCIDENT (2026-08-20). On a job of 170 tasks in
 * 14 h, three commits on `main` erased the work freshly integrated by
 * others — including one titled (in French) "chore: validate the local changes
 * before integration", which on its own deleted 2,800 lines of analytics and
 * product.* merged an hour earlier.
 *
 * The cause is mechanical and has nothing of a reasoning fault: several
 * mergers converged on the main repo, which has only ONE working
 * directory. One saw the other's intermediate state there, took it for
 * "local changes" and committed it. The merge lock and the dedicated
 * worktree (see `dispatcher.ts`) remove that collision; this module is the
 * net for anything that would still get through — a wholesale `git checkout --ours`,
 * an unfortunate `reset`, a conflict resolved the wrong way round.
 *
 * WHAT IT DOES NOT DO: block. A BLOCKED task stays stuck until
 * a human sees it, which is exactly the failure mode we
 * seek to eliminate. A broken integrity therefore relaunches the SAME task with the
 * list of the erased files — the agent restores and retries by itself, as it
 * already does for a `changes_requested` verdict. The user is only called on after
 * `MAX_REPAIRS` attempts.
 */
import { dbApi, type TaskRow } from './db.js';
import { bus, type BusEvent } from './bus.js';
import { notifyUser } from './notify.js';
import { daemonMessage } from './daemon-message.js';
import { loadConfig } from './agent.js';
import { execFileHost } from './host/index.js';

const exec = execFileHost;

/** Beyond this, stop relaunching and call the user. Three attempts is
 *  the same ceiling as the verification loop — beyond it, the agent clearly
 *  does not understand what is asked and insisting costs more
 *  than waiting for a human. */
export const MAX_REPAIRS = 3;

/**
 * Deletions a merge introduced without the integrated branch asking
 * for them.
 *
 * `mergeDeletions`: what the merge erased on the base.
 * `branchDeletions`: what the branch legitimately deleted, since its
 * divergence point.
 *
 * Pure function, exported to be testable without git: it carries
 * the decision, the rest of the module is only plumbing.
 */
export function unjustifiedDeletions(
  mergeDeletions: readonly string[],
  branchDeletions: readonly string[],
): string[] {
  const legitimate = new Set(branchDeletions);
  return mergeDeletions.filter((f) => !legitimate.has(f));
}

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const r = await exec('git', ['-C', cwd, ...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export type IntegrityReport =
  | { status: 'clean' }
  | { status: 'broken'; deleted: string[] }
  /** Inspection impossible (unknown sha, vanished branch, unreadable repo).
   *  NOTHING is concluded: accusing a merge on a failed inspection would relaunch
   *  an agent for a non-existent problem. */
  | { status: 'unknown'; reason: string };

/**
 * Inspects an already integrated merge.
 *
 * The merge commit has two parents: `^1` is the base before integration, `^2` the
 * integrated branch. So we compare "what the base lost" with "what the
 * branch deleted". A fast-forward merge has only one parent: it cannot
 * have erased anything other than what the branch asked for, and comes out `clean`
 * without further computation.
 */
export async function inspectMerge(
  repoCwd: string,
  mergeSha: string,
): Promise<IntegrityReport> {
  try {
    const parents = (await gitLines(repoCwd, ['rev-list', '--parents', '-n', '1', mergeSha]))[0]
      ?.split(/\s+/)
      .slice(1) ?? [];
    if (parents.length < 2) {
      // Fast-forward (or plain commit): the base lost nothing that does not come
      // from the branch itself.
      return { status: 'clean' };
    }
    const [base, branch] = parents as [string, string];
    const mergeDeletions = await gitLines(repoCwd, [
      'diff', '--diff-filter=D', '--name-only', base, mergeSha,
    ]);
    if (mergeDeletions.length === 0) return { status: 'clean' };
    const mergeBase = (await gitLines(repoCwd, ['merge-base', base, branch]))[0];
    if (!mergeBase) return { status: 'unknown', reason: 'merge base not found' };
    const branchDeletions = await gitLines(repoCwd, [
      'diff', '--diff-filter=D', '--name-only', mergeBase, branch,
    ]);
    const deleted = unjustifiedDeletions(mergeDeletions, branchDeletions);
    return deleted.length ? { status: 'broken', deleted } : { status: 'clean' };
  } catch (err) {
    return { status: 'unknown', reason: (err as Error).message.slice(0, 300) };
  }
}

/** Repair instruction added to the description of the relaunched task. */
function repairBrief(deleted: string[], mergeSha: string, attempt: number): string {
  const shown = deleted.slice(0, 40);
  const rest = deleted.length - shown.length;
  return [
    ``,
    `---`,
    ``,
    `## ⚠️ Merge to repair (attempt ${attempt}/${MAX_REPAIRS})`,
    ``,
    `Your merge \`${mergeSha.slice(0, 8)}\` DELETED ${deleted.length} file(s) that`,
    `the merged branch did not ask to delete. They existed on the base`,
    `and most likely come from the work of other tasks merged`,
    `while you were working.`,
    ``,
    ...shown.map((f) => `- \`${f}\``),
    ...(rest > 0 ? [`- … and ${rest} more`] : []),
    ``,
    `### What you must do`,
    ``,
    `1. Restore these files to the state the base had BEFORE your merge:`,
    `   \`git checkout ${mergeSha}^1 -- <file>\` (\`^1\` is the base before).`,
    `2. Check that your own contribution is still there — the point is not to undo`,
    `   your merge, but to make it additive.`,
    `3. Build/tests, then merge again and close with the FULL sha (40 hex).`,
    ``,
    `Use neither \`git reset --hard\` nor a blanket \`git checkout --ours\`: this`,
    `time you would erase work in the other direction.`,
  ].join('\n');
}

/**
 * Relaunches the task for repair, or escalates if we already tried too much.
 *
 * The task goes back to PENDING rather than BLOCKED: it leaves again on its own at the
 * dispatcher's next tick, with the instruction at the head of the brief. No
 * human intervention is needed as long as the agent makes progress.
 */
function requeueForRepair(task: TaskRow, report: { deleted: string[] }, mergeSha: string): void {
  const attempt = (task.iteration ?? 1) + 1;
  if (attempt > MAX_REPAIRS) {
    notifyUser(
      `Merge to repair by hand: ${task.title}`,
      [
        `Task \`${task.id}\` erased ${report.deleted.length} file(s) it should not`,
        `have touched, and ${MAX_REPAIRS} automatic repair attempts changed`,
        `nothing. It stays DONE — the check touches nothing more, so as not`,
        `to pile up half-repairs.`,
        ``,
        `Merge concerned: \`${mergeSha}\``,
        `Files: ${report.deleted.slice(0, 20).join(', ')}`,
        report.deleted.length > 20 ? `… and ${report.deleted.length - 20} more` : '',
      ].filter(Boolean).join('\n'),
      {
        taskId: task.id,
        message: daemonMessage('merge_repair_by_hand', {
          title: task.title,
          taskId: task.id,
          count: report.deleted.length,
          max: MAX_REPAIRS,
          sha: mergeSha,
          files: report.deleted.slice(0, 20).join(', '),
          more: Math.max(0, report.deleted.length - 20),
        }),
      },
    );
    console.error(
      `[merge-integrity] task ${task.id}: ${report.deleted.length} unjustified ` +
      `deletion(s), repair cap reached — escalating`,
    );
    return;
  }
  const description = (task.description ?? '') + repairBrief(report.deleted, mergeSha, attempt);
  dbApi.updateTask(task.id, { description });
  dbApi.setTaskVerificationMeta(task.id, attempt, task.verification_root_id ?? task.id);
  // The sha is erased: it names a merge we just judged incorrect, and
  // the closing guard must ask for that of the repair.
  dbApi.setTaskMergedSha(task.id, null);
  dbApi.setTaskStatusOnly(task.id, 'PENDING');
  console.warn(
    `[merge-integrity] task ${task.id} requeued for repair ` +
    `(${report.deleted.length} file(s), attempt ${attempt}/${MAX_REPAIRS})`,
  );
}

async function handleMissionComplete(missionId: string): Promise<void> {
  const mission = dbApi.getMission(missionId);
  if (!mission?.task_id) return;
  const task = dbApi.getTask(mission.task_id);
  if (!task || task.type !== 'merge' || task.status !== 'DONE') return;
  if (!task.merged_commit_sha) return; // the closing guard already takes care of it

  let repoCwd: string | null = null;
  try { repoCwd = loadConfig(task.agent_name).cwd ?? null; } catch { /* config illisible */ }
  if (!repoCwd) return;

  const report = await inspectMerge(repoCwd, task.merged_commit_sha);
  if (report.status === 'clean') return;
  if (report.status === 'unknown') {
    console.warn(`[merge-integrity] task ${task.id} cannot be checked: ${report.reason}`);
    return;
  }
  requeueForRepair(task, report, task.merged_commit_sha);
}

export function startMergeIntegrityCheck(): () => void {
  const onBusEvent = (ev: BusEvent) => {
    if (ev.kind !== 'mission_complete') return;
    handleMissionComplete(ev.missionId).catch((err) => {
      console.error(`[merge-integrity] handler error for ${ev.missionId}: ${(err as Error).message}`);
    });
  };
  bus.on('event', onBusEvent);
  console.log('[merge-integrity] destructive merge check active');
  return () => void bus.off('event', onBusEvent);
}
