/**
 * Runs the push `ticket-branch-push.ts` accepts, for the merger mission that
 * asks for it (`POST /api/tasks/:id/push-branch`, `timon task push`, the MCP
 * tool `kanban_push_branch`).
 *
 * The caller is identified by its own mission, never by what it claims: the
 * mission's agent must hold the `merger` role (`config.role`, not its name),
 * the mission must run the merge task named in the request, and the branch
 * pushed must belong to a task of that task's project. Anything else is
 * refused before git is touched. Every push that goes through is audited.
 */
import { loadConfig } from './agent-config.js';
import { dbApi } from './db.js';
import { getHost } from './host/index.js';
import type { ExecResult } from './host/types.js';
import { redactedOutput } from './host/forge.js';
import { readProjectIntegration } from './project-integration.js';
import { taskProjectSlug } from './task-project.js';
import {
  checkTicketBranchPush, isUnder, ticketPrefixesFromText, ticketPushArguments, type TicketPush,
} from './ticket-branch-push.js';

export type TicketPushRefusalCode =
  | 'push_not_merger' | 'push_wrong_task' | 'push_no_project' | 'push_not_covered' | 'push_source_missing'
  | 'push_rejected' | 'push_failed';

export type TicketPushOutcome =
  | { ok: true; remote: string; branch: string; source: string }
  | { ok: false; status: number; code: TicketPushRefusalCode; reason: string };

export type TicketPushDeps = {
  git?: (args: string[]) => Promise<ExecResult>;
  audit?: (action: string, target: string) => void;
};

function agentOf(name: string): { role: string | null; project: string | null; cwd: string | null } {
  try {
    const cfg = loadConfig(name);
    return { role: cfg.role ?? null, project: cfg.project ?? null, cwd: cfg.cwd ?? null };
  } catch {
    return { role: null, project: null, cwd: null };
  }
}

const refusal = (status: number, code: TicketPushRefusalCode, reason: string): TicketPushOutcome => ({ ok: false, status, code, reason });

export async function pushTicketBranch(
  input: { missionId: string; taskId: string; branch: string; sourceTask?: string; setUpstream?: boolean },
  deps: TicketPushDeps = {},
): Promise<TicketPushOutcome> {
  const mission = dbApi.getMission(input.missionId);
  if (!mission || agentOf(mission.agent_name).role !== 'merger') {
    return refusal(403, 'push_not_merger', 'only a mission whose agent holds the merger role may push a ticket branch');
  }
  const own = dbApi.getTaskByMission(input.missionId);
  if (!own || own.id !== input.taskId || own.type !== 'merge') {
    return refusal(403, 'push_wrong_task', 'the request must name the merge task this mission runs');
  }
  const slug = taskProjectSlug(own, agentOf(own.agent_name));
  const project = slug ? dbApi.getProjectRow(slug.toLowerCase()) : undefined;
  if (!slug || !project?.cwd) return refusal(409, 'push_no_project', 'the merge task has no project with a repository');

  const remote = readProjectIntegration(project.slug).integration.remote;
  const sameProject = (taskId: string): boolean => {
    const t = dbApi.getTask(taskId);
    if (!t) return false;
    const s = taskProjectSlug(t, agentOf(t.agent_name));
    return !!s && s.toLowerCase() === project.slug.toLowerCase();
  };
  const src = `timon/task/${input.sourceTask ?? input.taskId}`;
  const command = `git push ${input.setUpstream ? '--set-upstream ' : ''}${remote} ${src}:refs/heads/${input.branch}`;
  const cwd = project.cwd;
  const checked = checkTicketBranchPush(command, {
    remote,
    ticketPrefixes: ticketPrefixesFromText(project.speech),
    protectedBranches: [],
    isProjectTaskBranch: sameProject,
    isProjectDir: (dir) => isUnder(cwd, dir),
  });
  if (!checked.ok) return refusal(403, 'push_not_covered', checked.reason);
  const push: TicketPush = checked.push;

  const git = deps.git ?? ((args: string[]) => getHost().execAsync('git', args, {
    // No terminal behind the daemon: fail rather than wait for a password.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000, windowsHide: true,
  }));
  const exists = await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${push.src}`]).catch(() => null);
  if (!exists || exists.code !== 0) return refusal(409, 'push_source_missing', `${push.src} does not exist in the repository`);

  deps.audit?.('task.push_branch', `${project.slug}:${push.src}->${push.remote}/${push.dst}`);
  const run = await git(ticketPushArguments(push, cwd)).catch((err: Error): ExecResult => ({ code: 1, stdout: '', stderr: err.message }));
  if (run.code === 0) return { ok: true, remote: push.remote, branch: push.dst, source: push.src };
  const said = redactedOutput(run.stderr || run.stdout) || `git push failed (code ${run.code})`;
  const rejected = /\[rejected\]|non-fast-forward|fetch first/i.test(run.stderr);
  return refusal(rejected ? 409 : 502, rejected ? 'push_rejected' : 'push_failed', said);
}
