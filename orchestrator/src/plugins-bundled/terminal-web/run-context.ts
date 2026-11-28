/**
 * Where and with what the daemon runs an allowed command: the folder (checked
 * against the mission's own territory), the environment (the daemon's, minus
 * what is internal) and the answer that goes back, masked.
 */
import { join } from 'node:path';
import { getAgent } from '../../agent.js';
import { agentDir, TIMON_HOME } from '../../paths.js';
import { dbApi, type CommandRequestRow, type MissionRow } from '../../db.js';
import { getHost } from '../../host/index.js';
import { confineRunCwd, runShellCommand, type CommandRunResult } from '../../host/command-run.js';
import { readMeta } from '../../projects.js';
import { redactText } from '../../secrets/redact.js';
import { settingInt } from '../../settings.js';
import { shellEnv } from './shell.js';

/** What the owner sees when the command never ran, and what the agent reads. */
export const RUN_REFUSALS = {
  missing: 'the folder to run in no longer exists',
  not_directory: 'the folder to run in is not a folder',
  outside: 'the folder to run in is outside this project',
  no_folder: 'no folder to run in is known for this mission',
} as const;

/**
 * The folders a command of this mission may run in: its project's folder, a
 * task worktree of THIS project, the agent's own home. Nothing else — another
 * project's tree, `/`, a folder a symlink points to.
 */
export function allowedRunRoots(mission: MissionRow, project: string | null): string[] {
  const roots: string[] = [];
  let agentCwd: string | undefined;
  try { agentCwd = (mission.cwd_override ?? getAgent(mission.agent_name)?.cwd) || undefined; } catch { agentCwd = undefined; }
  let projectCwd: string | undefined;
  if (project) { try { projectCwd = readMeta(project).cwd ?? undefined; } catch { projectCwd = undefined; } }
  // A project-less agent has only its own working folder to run in.
  const base = projectCwd ?? agentCwd;
  if (base) roots.push(base);
  try { roots.push(agentDir(mission.agent_name)); } catch { /* invalid agent name: no home */ }
  const ids = new Set<string>();
  if (mission.task_id) ids.add(mission.task_id);
  if (project) {
    try { for (const t of dbApi.listTasks()) if (t.project === project) ids.add(t.id); } catch { /* no database: the base only */ }
  }
  for (const id of ids) {
    // Never the path stored on the task: only where the worktree service puts them.
    if (/^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== '.' && id !== '..') roots.push(join(TIMON_HOME, 'worktrees', id));
  }
  return roots;
}

/** The folder the command starts in: the task's worktree, else the mission's working folder. */
export function runCwdFor(mission: MissionRow): string | null {
  const task = mission.task_id ? dbApi.getTask(mission.task_id) : undefined;
  if (task?.worktree_path) return task.worktree_path;
  try { return (mission.cwd_override ?? getAgent(mission.agent_name)?.cwd) || null; } catch { return mission.cwd_override ?? null; }
}

/**
 * The daemon's environment without its internal wiring (`TIMON_*`, so no
 * daemon token), plus the git credentials agents already push with: git asks
 * `timon git-credential`, which the vault answers. Appended, never replacing
 * the user's own helpers.
 */
export function runEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = shellEnv(source);
  // The helper finds the daemon through the home folder; it is a path, not a secret.
  if (source.TIMON_HOME) env.TIMON_HOME = source.TIMON_HOME;
  env.GIT_TERMINAL_PROMPT = '0';
  let timon: string | null = null;
  try { timon = getHost().bin('timon'); } catch { timon = null; }
  if (timon) {
    const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
    const at = Number.isInteger(n) && n >= 0 ? n : 0;
    // git runs a `!` helper through sh, which wants forward slashes (also on Windows).
    const path = timon.replace(/\\/g, '/');
    env[`GIT_CONFIG_KEY_${at}`] = 'credential.helper';
    env[`GIT_CONFIG_VALUE_${at}`] = `!"${path}" git-credential`;
    env.GIT_CONFIG_COUNT = String(at + 1);
  }
  return env;
}

/** Values of the daemon's own secrets that a command could print (its environment is stripped, its files are not). */
function internalSecrets(source: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(source)) {
    if (v && v.length >= 8 && /^TIMON_.*(TOKEN|SECRET|KEY|PASSWORD)/.test(k)) out.push(v);
  }
  return out;
}

export function maskOutput(text: string, source: NodeJS.ProcessEnv = process.env, extra: readonly string[] = []): string {
  let out = redactText(text);
  for (const v of [...internalSecrets(source), ...extra]) {
    if (v.length >= 8 && out.includes(v)) out = out.split(v).join('***');
  }
  return out;
}

export type RunOutcome = CommandRunResult & { cwd: string | null };

/** Dependencies a test replaces. */
export type RunDeps = {
  run?: typeof runShellCommand;
  env?: () => Record<string, string>;
  timeoutMs?: () => number;
};

/** Checks the folder, then runs the request's command. Never throws; the output is masked. */
export async function runCommandRequest(row: CommandRequestRow, mission: MissionRow | undefined, deps: RunDeps = {}): Promise<RunOutcome> {
  const refused = (why: string): RunOutcome => ({
    exitCode: null, timedOut: false, output: `not run: ${why}`, truncated: false, durationMs: 0, failedToStart: true, cwd: null,
  });
  if (!mission) return refused(RUN_REFUSALS.no_folder);
  const wanted = runCwdFor(mission);
  if (!wanted) return refused(RUN_REFUSALS.no_folder);
  const checked = confineRunCwd(wanted, allowedRunRoots(mission, row.project));
  if (!checked.ok) return refused(RUN_REFUSALS[checked.reason]);
  const timeout = deps.timeoutMs?.() ?? settingInt('TIMON_COMMAND_RUN_TIMEOUT_SEC') * 1000;
  let result: CommandRunResult;
  try {
    result = await (deps.run ?? runShellCommand)({
      command: row.command, cwd: checked.cwd, env: (deps.env ?? runEnv)(), timeoutMs: timeout,
    });
  } catch (err) {
    result = { exitCode: null, timedOut: false, output: `not run: ${(err as Error).message}`, truncated: false, durationMs: 0, failedToStart: true };
  }
  return { ...result, output: maskOutput(result.output), cwd: checked.cwd };
}
