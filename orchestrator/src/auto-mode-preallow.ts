/**
 * A pre-allow of every shell command that the claude CLI drops in auto mode.
 *
 * `allowed_tools: ["Bash"]` reaches the CLI as `--allowedTools Bash`, and the
 * CLI reads a bare tool name as "every use of it": in `acceptEdits` or
 * `default`, every shell command runs without a card. In `auto` it removes that
 * rule before the first turn ("Ignoring dangerous permission Bash(*) from
 * cliArg (bypasses classifier)", claude 2.1.322 `--debug-file`), so the
 * classifier judges each command and the ones it cannot judge become an
 * Allow/Deny card. An autonomous mission has nobody to answer it, and the card
 * is denied after its delay.
 *
 * Timon does not put the rule back: answering those cards for the agent would
 * turn a pre-allow the CLI refuses into bypassPermissions for the shell. It says
 * so instead, where the person who set it can read it: in the answer of the
 * call that sets it, and once per agent in the notification centre when a
 * mission runs into it (the agent can be in `acceptEdits` while its task's
 * project role launches it in `auto`). A task the dispatcher runs on another
 * agent than the one it names (a pinned role, its own creator) loses the named
 * agent's rule the same silent way, and is reported the same way.
 */
import { notifyUser } from './notify.js';
import { daemonMessage } from './daemon-message.js';
import { getBackend, type BackendName } from './backends/index.js';
import type { PermissionModel } from './backends/types.js';

/** The shell tools of the claude CLI. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Patterns that mean "any command", as the CLI reads them. */
const ANY_COMMAND = new Set(['*', ':*', '*:*']);

/**
 * The rules of `allowed` that pre-allow every command of a shell tool: the bare
 * name (`Bash`) or a pattern that matches anything (`Bash(*)`). A narrow
 * pattern (`Bash(git:*)`) is not one of them.
 */
export function wholeShellPreallows(allowed: readonly string[] | null | undefined): string[] {
  const found: string[] = [];
  for (const raw of allowed ?? []) {
    if (typeof raw !== 'string') continue;
    const rule = raw.trim();
    const open = rule.indexOf('(');
    if (open < 0) {
      if (SHELL_TOOLS.has(rule)) found.push(rule);
      continue;
    }
    if (!rule.endsWith(')') || !SHELL_TOOLS.has(rule.slice(0, open))) continue;
    if (ANY_COMMAND.has(rule.slice(open + 1, -1).trim())) found.push(rule);
  }
  return found;
}

/**
 * The rules the CLI will drop for a launch in `mode` on a backend with this
 * permission model. Only the claude bridge (`mcp-bridge`) takes `--allowedTools`
 * and only `auto` drops them; anything else gets an empty list.
 */
export function inertShellPreallows(
  mode: string | null | undefined,
  permissionModel: PermissionModel | null | undefined,
  allowed: readonly string[] | null | undefined,
): string[] {
  if (mode !== 'auto' || permissionModel !== 'mcp-bridge') return [];
  return wholeShellPreallows(allowed);
}

/** What the person reads: the rule, why it does nothing, and the two ways out. */
export function inertShellPreallowWarning(agent: string, rules: readonly string[]): string {
  return `${agent} pre-allows ${rules.join(', ')} but runs in auto mode: the claude CLI ignores a rule that allows `
    + 'every shell command there, and a command its classifier cannot judge waits for an approval '
    + '(an autonomous mission is denied after the delay). To keep the rule, run the agent in acceptEdits, '
    + "and its project role too if it sets one; or pre-allow narrower patterns such as Bash(git:*).";
}

/**
 * The warnings the call that saves agent `name` answers with: empty unless its
 * config, as saved, pre-allows every shell command in a mode where the CLI drops
 * the rule. An unknown backend says nothing: the spawn refuses it anyway.
 */
export function agentConfigWarnings(
  name: string,
  cfg: { backend?: string | null; permission_mode?: string | null; allowed_tools?: readonly string[] | null },
): string[] {
  let model: PermissionModel | null = null;
  try { model = getBackend(cfg.backend as BackendName | undefined).permissionModel; } catch { return []; }
  const rules = inertShellPreallows(cfg.permission_mode, model, cfg.allowed_tools);
  return rules.length ? [inertShellPreallowWarning(name, rules)] : [];
}

/** Agents already reported by this process: one notice per agent, not one per mission. */
const reported = new Set<string>();

/**
 * Logs, and notifies once per agent and process, a launch whose shell pre-allow
 * the CLI will drop. `modeSource` says who chose auto: the mission (its task,
 * the project role, the spawn) or the agent's own config. Returns the dropped
 * rules, empty when there is nothing to say.
 */
export function reportInertShellPreallow(opts: {
  agent: string;
  missionId: string;
  mode: string | null | undefined;
  permissionModel: PermissionModel | null | undefined;
  allowed: readonly string[] | null | undefined;
  modeSource: 'mission' | 'agent';
}): string[] {
  const rules = inertShellPreallows(opts.mode, opts.permissionModel, opts.allowed);
  if (!rules.length) return rules;
  const by = opts.modeSource === 'mission' ? 'its task or project role' : 'its own config';
  console.warn(
    `[spawn] ${opts.agent} (mission ${opts.missionId.slice(0, 8)}): auto mode, set by ${by}, `
    + `drops the pre-allow ${rules.join(', ')} — shell commands go to the classifier`,
  );
  if (reported.has(opts.agent)) return rules;
  reported.add(opts.agent);
  notifyUser(
    `Shell pre-allow ignored in auto mode: ${opts.agent}`,
    `${inertShellPreallowWarning(opts.agent, rules)}\n\nAuto mode was set by ${by}.`,
    {
      type: 'alert',
      fromMission: opts.missionId,
      message: daemonMessage('shell_preallow_inert', {
        agent: opts.agent, rules: rules.join(', '), source: opts.modeSource,
      }),
    },
  );
  return rules;
}

/** Named agents whose lost pre-allow this process already reported. */
const reportedReroutes = new Set<string>();

/**
 * The whole-shell pre-allows of `named` that `routed` does not hold: what a task
 * that names one agent loses when the dispatcher runs it on another (a pinned
 * role, the task's own creator, an agent of another project).
 */
export function lostShellPreallows(
  named: readonly string[] | null | undefined,
  routed: readonly string[] | null | undefined,
): string[] {
  const kept = new Set(wholeShellPreallows(routed));
  return wholeShellPreallows(named).filter((rule) => !kept.has(rule));
}

/**
 * Logs, and notifies once per named agent and process, a task rerouted away
 * from the agent that pre-allows the shell: its card would otherwise read as if
 * that agent's own rule had failed. Information only: nothing is granted to the
 * agent that runs the task. Returns the lost rules.
 */
export function reportReroutedShellPreallow(opts: {
  taskId: string;
  named: string;
  routed: string;
  why: string;
  namedAllowed: readonly string[] | null | undefined;
  routedAllowed: readonly string[] | null | undefined;
}): string[] {
  const rules = lostShellPreallows(opts.namedAllowed, opts.routedAllowed);
  if (!rules.length) return rules;
  const body = `Task ${opts.taskId.slice(0, 8)} names ${opts.named}, which pre-allows ${rules.join(', ')}, but runs on `
    + `${opts.routed}, which does not (${opts.why}). Its shell commands go to the classifier, and one it cannot judge `
    + `waits for an approval. Give ${opts.routed} the same allowed tools, or let the task run on ${opts.named}.`;
  console.warn(`[dispatcher] ${body}`);
  if (reportedReroutes.has(opts.named)) return rules;
  reportedReroutes.add(opts.named);
  notifyUser(`Shell pre-allow not used: ${opts.named}`, body, {
    type: 'alert',
    taskId: opts.taskId,
    message: daemonMessage('shell_preallow_rerouted', {
      task: opts.taskId.slice(0, 8), named: opts.named, routed: opts.routed, rules: rules.join(', '), why: opts.why,
    }),
  });
  return rules;
}

/** Test seam: forget which agents were reported. */
export function resetInertShellPreallowReportsForTests(): void {
  reported.clear();
  reportedReroutes.clear();
}
