/**
 * TIM-0121, part B: the cascade a sandbox failure leaves behind in a pipeline.
 *
 * A tester whose codex coder kept failing on its sandbox moved the coder alone
 * to another backend. The code landed; then the review, and the merge after it,
 * resolved back to codex — a series role or a task override governs ONE task
 * type (`resolveRoleSpec`) — and blocked the same way. Nothing said why the
 * series was stuck downstream of a code task that had worked.
 *
 * This is no fallback: a sandbox failure is not a quota, and moving a task to
 * another provider on a guess is a choice for the human or the pilot. We only
 * name the cascade where both read it: the "Task blocked" notification and the
 * pilot's return (reactive), and an alert when a review or merge is created on
 * a backend that a task of the same series just blocked on (ahead).
 */
import { dbApi, type TaskRow } from './db.js';
import { resolveTaskLlm } from './dispatcher.js';
import { notifyUser } from './notify.js';
import { daemonMessage } from './daemon-message.js';

/** What a sandbox refusal reads like, in the words of codex, of the OS and of
 *  an agent reporting it in its blocked reason (English or French). */
const SANDBOX_FAILURE: readonly RegExp[] = [
  /\bsandbox\w*\b[^\n]{0,80}?\b(denied|refus\w*|block\w*|fail\w*|error|read-only|lecture seule|forbidden|403|cannot|could not|unable|interdit\w*)/i,
  /\b(denied|refus\w*|block\w*|fail\w*|read-only|lecture seule|forbidden|403|cannot|interdit\w*)\b[^\n]{0,80}?\bsandbox/i,
  /blocked by policy/i,
  /read-only file system/i,
  /refusing to run unsandboxed/i,
  /writable descendants under read-only carveouts/i,
  // 0xC0000142 STATUS_DLL_INIT_FAILED: a restricted-token process that never
  // initialised, as codex's Windows sandbox reports it.
  /-1073741502|0xC0000142|STATUS_DLL_INIT_FAILED/i,
];

export function looksLikeSandboxFailure(text: string | null | undefined): boolean {
  if (!text) return false;
  return SANDBOX_FAILURE.some((re) => re.test(text));
}

const CHAIN_TYPES: ReadonlySet<string> = new Set(['review', 'merge']);

function depsOf(task: TaskRow): string[] {
  try {
    const deps: unknown = JSON.parse(task.deps);
    return Array.isArray(deps) ? deps.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** The code task a review or merge follows: up its deps, a merge being one
 *  review away from it. */
function chainCodeTask(task: TaskRow): TaskRow | undefined {
  let frontier = depsOf(task);
  const seen = new Set<string>([task.id]);
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const dep = dbApi.getTask(id);
      if (!dep) continue;
      if (dep.type === 'code') return dep;
      next.push(...depsOf(dep));
    }
    frontier = next;
  }
  return undefined;
}

/** The backend a task ran on: its mission's, which carries a quota redirect,
 *  else what the dispatcher resolves for it. */
function backendOf(task: TaskRow): string {
  const mission = task.mission_id ? dbApi.getMission(task.mission_id) : undefined;
  return mission?.backend_override ?? resolveTaskLlm(task).backend;
}

function advice(task: TaskRow, failing: string, coder: string): string {
  const series = task.series_id ? ` --series ${task.series_id}` : '';
  const move = task.series_id
    ? [
      `  timon series role set --scope review --backend ${coder}${series}`,
      `  timon series role set --scope merge --backend ${coder}${series}`,
    ]
    : [`  set backend_override=${coder} on the review and merge tasks (kanban_update)`];
  return [
    `Sandbox failure on \`${failing}\` while the code of this chain ran on \`${coder}\`. ` +
      `Review and merge do not follow the coder: they stay on \`${failing}\` and block the same way. Move them too:`,
    ...move,
    `then requeue the blocked task.`,
  ].join('\n');
}

/**
 * The line to add to a blocked review or merge when its reason is a sandbox
 * failure and the code it follows ran on another backend; '' otherwise. Never
 * throws: a notice must not cost the blocked task its notification.
 */
export function sandboxCascadeNotice(task: TaskRow, reason: string | null): string {
  try {
    if (!CHAIN_TYPES.has(task.type) || !looksLikeSandboxFailure(reason ?? task.blocked_reason)) return '';
    const code = chainCodeTask(task);
    if (!code) return '';
    const failing = backendOf(task);
    const coder = backendOf(code);
    return failing === coder ? '' : advice(task, failing, coder);
  } catch (err) {
    console.warn(`[sandbox-cascade] notice skipped for ${task.id}: ${(err as Error).message}`);
    return '';
  }
}

/**
 * When a review or merge is created on a backend a task of the same series is
 * BLOCKED on for its sandbox, while the code it follows ran elsewhere: alerts
 * the user before it runs, and returns the text (null when there is nothing to
 * say). Never throws.
 */
export function warnSandboxCascadeAhead(task: TaskRow): string | null {
  try {
    if (!CHAIN_TYPES.has(task.type) || !task.series_id) return null;
    const code = chainCodeTask(task);
    if (!code) return null;
    const target = backendOf(task);
    const coder = backendOf(code);
    if (target === coder) return null;
    const evidence = dbApi.listTasksBySeries(task.series_id).find((t) =>
      t.id !== task.id && t.status === 'BLOCKED' && looksLikeSandboxFailure(t.blocked_reason) && backendOf(t) === target);
    if (!evidence) return null;
    const text = `${advice(task, target, coder)}\n(Blocked on its sandbox in this series: task ${evidence.id.slice(0, 8)} — ${evidence.title}.)`;
    notifyUser(`${task.type} will run on \`${target}\`, whose sandbox just failed: ${task.title}`, text, {
      taskId: task.id,
      type: 'alert',
      message: daemonMessage('sandbox_cascade_ahead', {
        type: task.type,
        target,
        coder,
        title: task.title,
        series: task.series_id,
        evidenceId: evidence.id.slice(0, 8),
        evidenceTitle: evidence.title,
      }),
    });
    return text;
  } catch (err) {
    console.warn(`[sandbox-cascade] ahead check skipped for ${task.id}: ${(err as Error).message}`);
    return null;
  }
}
