import { composePrompt } from './prompt-presentation.js';
import { taskAttachmentParts, taskAttachmentsWithInherited, type StoredTaskAttachment } from './attachments.js';
import { existsSync } from 'node:fs';
import {
  dbApi,
  isSelfMergePipeline,
  MAX_BLIND_QUOTA_DEATHS,
  MAX_SYSTEM_REQUEUES,
  type MissionRow,
  type TaskInterruptionOutcome,
  type SeriesPlanLandingRecord,
  type TaskRow,
  type TaskType,
} from './db.js';
import { BackendExhaustedError, spawnAgent, canSpawnMission } from './agent.js';
import { CwdUnusableError } from './cwd-check.js';
import { taskProjectSlug } from './task-project.js';
import { bus } from './bus.js';
import { loadConfig, type AgentConfig } from './agent.js';
import { reportReroutedShellPreallow } from './auto-mode-preallow.js';
import { readRoles, type RoleSpec, type TaskRole } from './projects.js';
import {
  asBackendName, assertBackendEnabled, defaultBackendName, isBackendName, backendCapabilities, backendForModel, catalogClaimsModel,
  type BackendName,
} from './backends/index.js';
import { whenProvidersLoaded } from './backends/registry.js';
import {
  createWorktree, isGitRepo, currentBranch, refreshWorktreeBase, prepareWorktreeDependencies,
  refreshMergeMessage, integrateMergeMessage, branchExists, worktreeDiskGate,
  type WorktreeInfo, type RefreshOutcome,
} from './worktree.js';
import { DiskPause, diskGateMessage, type DiskGate } from './disk-gate.js';
import { formatBytes } from './storage-failure.js';
import { agentDir } from './paths.js';
import { notifyUser } from './notify.js';
import { daemonMessage, type DaemonMessage } from './daemon-message.js';
import { orchestratorForProject } from './main-agent.js';
import { messageTime } from './message-dates.js';
import { CONVENTION_ROLES, inheritedLlm, previewRoleAgent, resolveRoleAgentPreview, roleForTaskType, type RoleAgentPreview } from './agent-seed.js';
import { evaluateDeps, repairWaitStall, type DepGate } from './merge-gate.js';
import {
  describeInterruption,
  interruptionMessage,
  QUOTA_REOPEN_MARGIN_MS,
  requeueBackoffMs,
  toInterruptionReason,
  triggersBackendFallback,
  type InterruptionDetail,
  type InterruptionReason,
} from './interruption.js';
import { MissionFenceBlockedError, MissionFenceRefusedError, profileLimits } from './resources.js';
import { fenceMechanismName } from './fence-refusal.js';
import { codeCloseRefusal, effectiveMergeSha, mergeCloseRefusal, pullRequestCloseRefusal } from './code-gate.js';
import { GIT_MISSING_MESSAGE, GIT_MISSING_REASON, gitTaskRefusal } from './task-git.js';
import {
  ensureIntegrationBranch, integrationBranchName, integrationBranchRefusal, isIntegrationMode, localBaseRef,
  localTargetOf, usesIntegrationBranch, type IntegrationMode,
} from './git-integration.js';
import { integrationBaseRef, readProjectIntegration } from './project-integration.js';
import { chainLanding } from './chain-landing.js';
import { spawnWideningRefusal } from './users/privileged-overrides.js';
import { isMirrorTask } from './task-mirror.js';
import {
  backendResumeRoute, cooldownReason, fallbackFor, interruptionForCooldown, noteBackendRateLimit, redirectTaskSpawn, switchSeriesToFallback,
} from './backend-fallback.js';
import { seriesLlmChoice } from './series-service.js';

/** Max number of Kanban tasks dispatched IN PARALLEL (bound on
 *  countInProgress, dispatched tasks only). Configurable via
 *  TIMON_MAX_PARALLEL — raised from 3 to 8 by default: 64 GB of RAM allow
 *  more parallelism, and the GLOBAL cap (agent.ts, all sources combined) +
 *  the load watchdog now bound the overheating risk upstream.
 *
 *  Lowered during daytime (TIMON_DAY_MAX_PARALLEL) by the resource
 *  profile: the machine is then shared with the user, dispatching only
 *  trickles. */
const MAX_PARALLEL = (): number => profileLimits().maxParallel;
const DEFAULT_INTERVAL_MS = 60_000;
/** Number of consecutive spawn failures tolerated before blocking the
 *  task. Beyond that, we stop the silent retry-spam: the task goes
 *  BLOCKED (which triggers the recovery loop) instead of retrying
 *  forever every tick. */
const MAX_SPAWN_FAILURES = 3;
const spawnFailures = new Map<string, number>();

/** Tool pre-authorizations per task type (--allowedTools). In `auto`, the
 *  Claude classifier auto-authorizes what's safe and DEFERS the ambiguous
 *  to the human Allow/Deny card — which has no timeout and blocks
 *  indefinitely at night. For a role's core business operations (a coder
 *  editing, a merger doing git), we explicitly pre-authorize → zero card,
 *  zero block. We stay CONSERVATIVE: only business ops are listed;
 *  everything else (rm, push --force…) is not pre-authorized → stays
 *  classified/deferred. The worktree already isolates the coder from the
 *  rest of the repo. */
const TYPE_ALLOWED_TOOLS: Partial<Record<TaskType, string[]>> = {
  // Native Claude Code format: `Bash(<prefix>:*)` (prefix + `:*` wildcard).
  code: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(npx tsc:*)', 'Bash(npm run:*)'],
  // `kanban_push_branch`: the daemon pushes a ticket branch for the merger
  // (`ticket-branch-push.ts` holds the rule); the CLI classifier would refuse
  // the same `git push` typed by the agent.
  merge: ['Read', 'Edit', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(npx tsc:*)', 'Bash(npm run:*)', 'mcp__timon__kanban_push_branch'],
  review: ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
  doc: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  research: ['Read', 'Glob', 'Grep'],
};

/** Closing tools, pre-authorized WHATEVER the task type. A closure deferred to
 *  a human card at night is a task that never closes and a pilot that never
 *  gets its return — the exact failure these tools exist to remove. */
const CLOSURE_ALLOWED_TOOLS = [
  'mcp__timon__kanban_mark_as_done',
  'mcp__timon__kanban_mark_as_failed',
];

/** Maps a task type to the role its executing agent must hold. */
const roleFromTaskType = (type: TaskType): string => roleForTaskType(type);

/** Reads project roles tolerating the slug's casing. `validSlug` only
 *  accepts lowercase; but agents often carry a capitalized slug
 *  (`project: "TIMON"`). Without normalization, readRoles throws and
 *  roles.json is ignored (a historical bug). We lowercase for the
 *  lookup, keeping the original slug for agent NAMING (existing folders
 *  are `TIMON.*`). */
function readRoleSpec(slug: string, type: TaskType): RoleSpec | undefined {
  try {
    return readRoles(slug.toLowerCase())[type as TaskRole];
  } catch {
    return undefined;
  }
}

/**
 * Unified resolution of a task's effective agent. Single source of truth:
 *   1. roles.json `<type>.agent` if defined (explicit override), ELSE
 *   2. the agent the task NAMES, when it is an existing agent of the project
 *      that is not an orchestrator and holds no other role (TIM-0082), ELSE
 *   3. the project agent that holds the role, ELSE
 *   4. the `<slug>.<role>` convention (e.g. "TIMON.coder").
 * The resolved agent is guaranteed to exist: if missing, it's seeded as
 * a child agent of the project (config + system-prompt) via
 * ensureProjectAgent — on the backend + model of whoever created the task,
 * not on Claude by default. No more "folder present but incomplete" that made
 * the spawn fail in a loop.
 *
 * Types outside CONVENTION_ROLES (notably `doc` → TIMON.librarian) are
 * never remapped: we honor the task.agent_name set upstream.
 */
export function resolveEffectiveAgentName(task: TaskRow): string {
  return resolveTaskRouting(task).agent;
}

/** Who runs a task, and why when it is not the agent it names (TIM-0109). */
export type TaskRouting = {
  agent: string;
  /** `as_named`: no project or role rule applies, the task's agent runs it. */
  source: RoleAgentPreview['source'] | 'as_named';
  role?: string;
  refusal?: RoleAgentPreview['refusal'];
  heldRole?: string;
};

export function resolveTaskRouting(task: TaskRow): TaskRouting {
  return routeTask(task, true);
}

/**
 * Who the dispatcher WILL hand the task to, read without seeding anything: the
 * board and the creation warning ask it of tasks no mission ran yet (#1109). A
 * role agent that does not exist yet is named all the same when the dispatcher
 * could seed it (the project has a folder).
 */
export function previewTaskRouting(task: TaskRow): TaskRouting {
  return routeTask(task, false);
}

function routeTask(task: TaskRow, seed: boolean): TaskRouting {
  const asNamed: TaskRouting = { agent: task.agent_name, source: 'as_named' };
  const cfg = loadConfig(task.agent_name);
  const slug = taskProjectSlug(task, cfg);
  if (!slug) return asNamed;
  const role = roleFromTaskType(task.type);
  if (!CONVENTION_ROLES.has(role)) return asNamed;

  const spec = readRoleSpec(slug, task.type);
  const creator = task.creator_mission_id ? dbApi.getMission(task.creator_mission_id) : undefined;
  // The named agent may not exist (nothing to read a cwd from): the project's
  // own root is where the seeded role agent works then.
  const cwd = cfg.cwd ?? dbApi.getProjectRow(slug.toLowerCase())?.cwd ?? null;
  // The pilot that assigns work to ITSELF is the case the role system
  // catches, not a choice of agent.
  const avoid = [creator?.agent_name];
  const canonical = seed
    ? resolveRoleAgentPreview(slug, role, { cwd, spec, named: task.agent_name, avoid, inherit: inheritedLlm(task.creator_mission_id) })
    : previewRoleAgent(slug, role, spec, { named: task.agent_name, avoid });
  if (!canonical) return asNamed;
  // Seeding needs a folder: without one the dispatcher falls back on the named agent.
  if (seed ? !existsSync(agentDir(canonical.agent)) : !canonical.exists && !cwd) return asNamed;
  return {
    agent: canonical.agent,
    source: canonical.source,
    role,
    ...(canonical.refusal ? { refusal: canonical.refusal } : {}),
    ...(canonical.heldRole ? { heldRole: canonical.heldRole } : {}),
  };
}

/** One sentence for the daemon log: why `named` did not run its task. */
export function describeRouting(named: string, routing: TaskRouting): string {
  const role = routing.role ?? 'its';
  const why = routing.refusal === 'pinned' ? `the ${role} role is pinned to ${routing.agent} in roles.json`
    : routing.refusal === 'missing' ? `${named} does not exist`
    : routing.refusal === 'other_project' ? `${named} does not belong to the task's project (config.project)`
    : routing.refusal === 'orchestrator' ? `${named} is an orchestrator or the task's creator`
    : routing.refusal === 'other_role' ? `${named} holds the ${routing.heldRole ?? 'another'} role`
    : `${named} was not chosen`;
  const by = routing.source === 'role' ? `, ${routing.agent} holds the ${role} role`
    : routing.source === 'convention' ? `, ${routing.agent} is the ${role} role's default agent`
    : '';
  return `${why}${by}`;
}

/**
 * Orchestrator (target of end-of-mission recaps) for a task, deduced from its
 * PROJECT: the agent that HOLDS the orchestrator role on the task's project,
 * else `_main` (default cross-project orchestrator). The project is derived
 * from the task's agent config (`cfg.project`, otherwise the cwd). Only a
 * fallback since 2026-10-01: `taskOrchestrator` first asks who launched the
 * task.
 *
 * The role is read from the data (`config.role`), not from the name: a
 * project's orchestrator may be called anything. `{project}.main` survives
 * only as a legacy fallback, for the installs whose orchestrator was created
 * before roles were stamped — it used to be tried FIRST, which handed a
 * project's recaps to whoever happened to carry the name.
 *
 * Before either: hard-coded to `['TIMON.main', '_main']` → EVERY task of EVERY
 * project had its `parent_agent` = TIMON.main,
 * so their recaps landed in TIMON.main's inbox instead of their own
 * orchestrator's. The `parent_agent` set here later drives the wake-loop
 * (`orchestratorForTask`), so this is THE routing point.
 */
function findOrchestratorName(task?: TaskRow): string | null {
  // Generic fallback inside: the cross-project orchestrator, under whatever
  // name the user gave it during onboarding (`main-agent.ts` keeps `_main` and
  // `TIMON.main` as the fallbacks they always were).
  return orchestratorForProject(task ? taskProjectSlug(task, loadConfig(task.agent_name)) : null);
}

/**
 * Lineage of the mission that runs `task`: the orchestrator agent its return
 * goes to (`parent_agent`) and the mission it belongs to (`parent_mission_id`).
 *
 * The mission that CREATED the task wins: it is the pilot of the Kanban
 * series, so its agent is the orchestrator by definition. Deducing it from the
 * project of the task's agent is only a fallback, for tasks without a known
 * creator — a project-less agent (`TIMON.librarian`, which serves every
 * project from the vault, outside any project cwd) otherwise resolved to
 * `_main` while the series was piloted by a `timon.main` mission. The two
 * halves of the lineage then named different agents, and the wake-loop
 * ping-ponged the series between them (2026-10-01, 14 wake missions).
 */
export function taskOrchestrator(task: TaskRow): { agent: string | null; missionId: string | null } {
  const creator = task.creator_mission_id ? dbApi.getMission(task.creator_mission_id) : undefined;
  if (creator) return { agent: creator.agent_name, missionId: creator.id };
  // A creator id that names no mission is dropped, not kept: keeping it would
  // pair the fallback agent with a mission of nobody we know, and the two
  // halves of the lineage would disagree again.
  const agent = findOrchestratorName(task);
  return { agent, missionId: fallbackOrchestratorMission(agent) };
}

/**
 * Orchestrator mission to use as `parent_mission_id` when the task has no
 * known creator (no `creator_mission_id`, or one naming a mission that no
 * longer exists: legacy tasks, or created outside an orchestrator mission). Best-effort: the orchestrator's
 * running mission, otherwise its most recent one. Returns null if no
 * mission is known.
 */
function fallbackOrchestratorMission(orchestratorName: string | null): string | null {
  if (!orchestratorName) return null;
  const missions = dbApi.listMissions(20, [orchestratorName]);
  const running = missions.find((m) => m.status === 'running');
  return (running ?? missions[0])?.id ?? null;
}

/** Evaluates a task's deps (all DONE, + `pass` verdict required on a
 *  `merge` task's `review` deps, agreement across the WHOLE verification
 *  chain, and a `code` dep of a `full` pipeline only counts once its chain's
 *  merge is DONE, and one integrated into another base only once that base
 *  landed). Logic lives in merge-gate.ts. */
function depsGate(task: TaskRow): DepGate {
  return evaluateDeps(
    task,
    (id) => dbApi.getTask(id),
    (rootId) => dbApi.listTasksByVerificationRoot(rootId),
    (rootId) => dbApi.listVerificationChain(rootId),
    (dep) => {
      const row = dbApi.getTask(dep.id);
      return row ? chainLanding(row) : 'local';
    },
  );
}

/** Last wait reason logged per task: the dispatcher ticks every few seconds,
 *  so a reason is logged once, and again only when it changes. */
const lastWaitLogged = new Map<string, string>();

/**
 * Resolves the worktree to use for a task at spawn time.
 *
 * - `type=code`: if the task already has a worktree_path (re-spawn),
 *   reuses it; otherwise creates a worktree from the agent's cfg.cwd (if
 *   it's a git repo). For other cwds (non-git), returns null → the agent
 *   runs in its normal cwd with no isolation.
 * - `type=review` or `merge`: inherits the worktree of the first `code`
 *   dep that has one. Lets the reviewer/merger see the same branch as the
 *   builder without manual configuration.
 * - Other types: no worktree.
 *
 * Any creation error is non-fatal: the task spawns in its normal cwd,
 * with a warn log. An agent running without a worktree beats an agent
 * not running at all.
 */
/** Outcome of the worktree refresh at the last spawn, per task.
 *  Deliberately in-memory only: it's a detail of THIS spawn, to tell the
 *  agent in its brief and then forget. Persisting it would resurface
 *  already-resolved conflicts on the next re-spawn. */
/**
 * Merge lock key: the REPO, not the project.
 *
 * The shared working directory is the critical resource — two distinct
 * projects pointing at the same repo must serialize, and a project with
 * no identifiable repo must not block the others. We fall back to the
 * slug (then the agent) when the cwd is unreadable, for lack of better.
 */
function mergeLockKey(task: TaskRow): string {
  let cfg: AgentConfig | null = null;
  try { cfg = loadConfig(task.agent_name); } catch { /* unreadable config */ }
  return cfg?.cwd || taskProjectSlug(task, cfg) || task.agent_name;
}

const lastRefresh = new Map<string, RefreshOutcome>();

/** Keeps a refresh outcome for the brief and logs it. A refusal without
 *  conflict (a hook rejecting the merge message, an unknown base) used to be a
 *  log line only: the brief now tells the agent too. */
function recordRefresh(taskId: string, base: string, outcome: RefreshOutcome): void {
  lastRefresh.delete(taskId);
  if (outcome.status !== 'up-to-date') lastRefresh.set(taskId, outcome);
  if (outcome.status === 'merged') {
    console.log(`[dispatcher] worktree ${taskId} refreshed onto ${base}`);
  } else if (outcome.status === 'conflict') {
    console.warn(
      `[dispatcher] worktree ${taskId}: ${outcome.files.length} conflict(s) with ` +
      `${base} — left to the agent`,
    );
  } else if (outcome.status === 'failed') {
    console.warn(`[dispatcher] worktree ${taskId} not refreshed onto ${base}: ${outcome.reason}`);
  }
}

/**
 * How a task moves its base to `source` (the merger's branch, or `HEAD` of a
 * `code-self` coder's worktree) without writing to the shared checkout.
 *
 * By reference (`push .`) unless the main repo stands ON the base: `push .`
 * only accepts a fast-forward and git refuses it for a branch checked out
 * anywhere, so it can never move another worktree's files. A detached or
 * unreadable HEAD is no exception: a `merge --ff-only` there moves the user's
 * own position and leaves the base where it was (#1018). Only when the user's
 * checkout IS the base does the fast-forward go through it, the working
 * directory following its branch. Either way the agent reads the base back
 * and compares it with its own tip before reporting a sha.
 */
export function baseAdvanceInstructions(
  repo: string,
  base: string,
  source: string,
  activeBranch: string | null,
): string {
  // `HEAD` named in `git -C <repo>` would be the MAIN repo's HEAD: resolve it in
  // the agent's worktree first, and give the destination as a full ref (git
  // needs one when the source is a bare sha).
  const from = source === 'HEAD' ? '$(git rev-parse HEAD)' : source;
  const to = source === 'HEAD' ? `refs/heads/${base}` : base;
  const check =
    `Check the move before reporting anything — both shas must be equal:\n\n` +
    `\`\`\`bash\ngit -C ${repo} rev-parse ${base}\ngit rev-parse ${source}\n\`\`\`\n\n` +
    `If they differ, the base did not move: do not close as merged.`;
  if (activeBranch != null && activeBranch === base) {
    return (
      `The main repo is checked out ON \`${base}\`: the fast-forward goes through ` +
      `the user's checkout, which follows its branch. ONE command, and only one:\n\n` +
      `\`\`\`bash\ngit -C ${repo} merge --ff-only ${from}\n\`\`\`\n\n` +
      `If it refuses (\`${base}\` moved while you were working), bring it into ` +
      `YOUR worktree (\`git merge --no-edit -m "${refreshMergeMessage(base)}" ${base}\`), ` +
      `resolve, then retry. Never force.\n\n${check}`
    );
  }
  const where = activeBranch
    ? `The main repo is on \`${activeBranch}\`, NOT on the base \`${base}\``
    : `The main repo has a detached HEAD (or its branch could not be read)`;
  return (
    `${where}: a fast-forward done IN that repo would move the user's position, ` +
    `not the base. Move the base **by reference**, without touching the ` +
    `working directory, with ONE command:\n\n` +
    `\`\`\`bash\ngit -C ${repo} push . ${from}:${to}\n\`\`\`\n\n` +
    `\`push .\` only accepts a fast-forward. If it refuses (\`${base}\` moved ` +
    `while you were working), go back to YOUR worktree, ` +
    `\`git merge --no-edit -m "${refreshMergeMessage(base)}" ${base}\`, ` +
    `resolve, then try again. If it refuses because \`${base}\` is checked out ` +
    `in another worktree, do not work around it: \`timon task block\` with the reason. ` +
    `Never force, never \`git checkout ${base}\` or \`git merge\` in the main ` +
    `repo.\n\n${check}`
  );
}

/**
 * The brief of the task that opens a job's pull request (`landing = 'pr'`,
 * `docs/KANBAN-PR-PIPELINE.md` §2.4). It merges no task branch: it brings the
 * target in if it moved, moves the integration branch by reference, writes the
 * title and the description, and hands the rest to the daemon (`timon pr
 * open`), whose checks an agent cannot skip. The agent never pushes and never
 * runs `gh`.
 */
export function pullRequestDirective(task: TaskRow, wt: WorktreeInfo, activeBranch: string | null): string {
  const baseRef = task.base_ref ?? '<remote>/<target>';
  const slash = baseRef.indexOf('/');
  const remote = slash > 0 ? baseRef.slice(0, slash) : '<remote>';
  const target = slash > 0 ? baseRef.slice(slash + 1) : '<target>';
  const repo = wt.sourceRepo;
  const branch = wt.base;
  const move = baseAdvanceInstructions(repo, branch, wt.branch, activeBranch);
  return (
    `\n\n## Your task: open the job's pull request\n\n` +
    `This \`merge\` task merges no task branch. The job's work is already in its ` +
    `integration branch \`${branch}\`, which reaches \`${baseRef}\` through a pull ` +
    `request. The daemon pushes the branch and opens the pull request; you never ` +
    `\`git push\`, never run \`gh\`, never merge into \`${target}\`, never force.\n\n` +
    `You have YOUR worktree: \`${wt.path}\` (branch \`${wt.branch}\`, on \`${branch}\`). ` +
    `The main repo (\`${repo}\`) has ONE working directory shared by every agent: ` +
    `run no command that writes there except the single move of step 2.\n\n` +
    `1. **Bring the target in**, if it moved, in your worktree:\n\n` +
    `\`\`\`bash\ngit fetch --no-tags ${remote} ${target}\n` +
    `git merge --no-edit -m "${refreshMergeMessage(baseRef)}" ${baseRef}\n\`\`\`\n\n` +
    `   If the fetch fails, go on with the ref as it is: the daemon fetches it again ` +
    `before opening. Resolve a conflict here (\`git commit --no-edit\` keeps the ` +
    `message), then run the checks of the packages the job touched.\n\n` +
    `2. **If step 1 created a commit**, move \`${branch}\` to it. ${move}\n\n` +
    `3. **Write the pull request**: a title and a description in English, for a ` +
    `reviewer who knows the project but not this job (what changes, why, how it was ` +
    `checked). No task or mission id, no TODO number, no attribution line ` +
    `(\`Co-Authored-By\`, "Generated with"), and no closing keyword (\`Fixes #n\`) ` +
    `for now. Put the description in a file.\n\n` +
    `4. **Open it** (MCP tool \`pr_open\` with \`id\` = your TASK_ID does the same):\n\n` +
    `\`\`\`bash\ntimon pr open <TASK_ID> --title "<title>" --body-file <file>\n\`\`\`\n\n` +
    `   The daemon checks the account, the remote, the identity and the messages of ` +
    `every commit, the private paths and the public tree, then pushes \`${branch}\` ` +
    `and opens the pull request. A refusal lists the failed checks: fix what your ` +
    `worktree can fix with NEW commits (a commit is never rewritten), repeat step 2, ` +
    `retry. A check you cannot fix (an earlier commit's identity or message, the ` +
    `account) → \`timon task block <TASK_ID> --reason "<the failed checks>"\`.\n\n` +
    `5. **Close** with the tip you published and the pull request's address. The daemon ` +
    `refuses DONE (\`pr_not_opened\`) until step 4 opened the pull request:\n\n` +
    `\`\`\`bash\ntimon task done <TASK_ID> --merged-sha "$(git -C ${repo} rev-parse ${branch})" ` +
    `--comment "pull request <url> opened for ${branch}"\n\`\`\`\n\n` +
    `A person merges the pull request on the forge; Timon notices it afterwards.`
  );
}

/**
 * The brief of the task that merges a job's branch into its local target
 * (`landing = 'local'`, `local-landing.ts`). Like a `code-self` coder, it merges
 * on a detached copy of the target in its own worktree (first parent = the
 * target), then moves the target the way every merger does
 * (`baseAdvanceInstructions`): by reference, or through the user's checkout
 * when it stands on the target. Its DONE lands the whole job, so the daemon
 * proves the sha with git before accepting it.
 */
export function localLandingDirective(task: TaskRow, wt: WorktreeInfo, activeBranch: string | null): string {
  const branch = wt.base;
  const target = localTargetOf(task.base_ref) ?? '<target>';
  const repo = wt.sourceRepo;
  const move = baseAdvanceInstructions(repo, target, 'HEAD', activeBranch);
  return (
    `\n\n## Your task: merge the job's branch into ${target}\n\n` +
    `This \`merge\` task merges no task branch. The job's work is already in its ` +
    `branch \`${branch}\`; you merge that branch into \`${target}\`, on this machine. ` +
    `Never push, never force, never rewrite a commit.\n\n` +
    `You have YOUR worktree: \`${wt.path}\` (branch \`${wt.branch}\`, on \`${branch}\`). ` +
    `The main repo (\`${repo}\`) has ONE working directory shared by every agent: ` +
    `run no command that writes there except the single move of step 3.\n\n` +
    `1. **Merge**, in your worktree, on a detached copy of the target:\n\n` +
    `\`\`\`bash\ngit checkout --detach ${target}\n` +
    // The branch name is public-safe (`integrationBranchRefusal` refused ids).
    `git merge --no-ff -m "merge: integrate ${branch} into ${target}" ${branch}\n\`\`\`\n\n` +
    `   Resolve a conflict here (\`git commit --no-edit\` keeps the message), then run ` +
    `the checks of the packages the job touched.\n\n` +
    `2. **Check** that the merge carries the branch: ` +
    `\`git merge-base --is-ancestor ${branch} HEAD\` must succeed.\n\n` +
    `3. **Move \`${target}\`** to your merge. ${move}\n\n` +
    `4. **Close** with the target's FULL sha. The daemon checks that it is in ` +
    `\`${target}\` and carries \`${branch}\`, then lands the job: its TO DO ideas ` +
    `close and its doc task is created.\n\n` +
    `\`\`\`bash\ntimon task done <TASK_ID> --merged-sha "$(git -C ${repo} rev-parse ${target})" ` +
    `--comment "${branch} merged into ${target}"\n\`\`\`\n\n` +
    `Then \`git checkout ${wt.branch}\` to leave your worktree on its branch. A conflict you ` +
    `cannot resolve cleanly → \`timon task block <TASK_ID> --reason "<the conflict>"\`.`
  );
}

/**
 * What the agent needs to know about ITS worktree when it starts.
 *
 * Two things it can't guess: that its base was refreshed under its feet
 * (and that there may be open conflicts to resolve BEFORE anything else),
 * and — for a merger — that it must under no circumstances go work in the
 * main repo.
 */
export function worktreeDirective(
  task: TaskRow,
  wt: WorktreeInfo | null,
  /** Branch checked out in `wt.sourceRepo`, read by the caller (merge only);
   *  null for a detached HEAD, which never takes the fast-forward. */
  activeBranch?: string | null,
): string {
  if (!wt) return '';
  // Always repeat this on retries: existing links are preserved by preparation.
  const parts: string[] = [
    `\n\n## Shared dependencies — mandatory safety rule\n\n` +
    `Installed package node_modules directories are shared through links to \`${wt.sourceRepo}\`. ` +
    `The worktree isolates source code, not these dependencies. ` +
    `Do NOT run \`npm ci\`, \`npm install\`, \`npm rebuild\` or \`electron-rebuild\` ` +
    `in this worktree: they can erase or overwrite the live repository's dependencies ` +
    `and stop the daemon and running missions. This overrides generic installation advice. ` +
    `Run typechecks and tests from each package with its local tools: its own ` +
    `\`typecheck\` and \`test\` scripts when it has them (\`npm run typecheck\`, \`npm test\`), ` +
    `because their pre-steps generate files git ignores, which a fresh worktree does not have; ` +
    `otherwise its local tsc (\`npx tsc --noEmit\`). Never use a global TypeScript compiler. ` +
    `If dependencies are missing, report the missing prerequisite instead of installing them.`,
  ];
  const refresh = lastRefresh.get(task.id);
  if (refresh?.status === 'conflict') {
    parts.push(
      `\n\n## Conflicts to resolve BEFORE anything else\n\n` +
      `Your branch was brought up to date with \`${refresh.base}\` (it predated ` +
      `the merges of the other tasks) and the merge left ${refresh.files.length} ` +
      `open conflict(s):\n` +
      refresh.files.map((f) => `- \`${f}\``).join('\n') +
      `\n\nResolve them and commit BEFORE starting your work (\`git commit --no-edit\` ` +
      `keeps the merge message already prepared). NEVER work around ` +
      `the conflict with a blanket \`git checkout --ours\` or with \`git reset\`: ` +
      `you would erase work other tasks already merged.`,
    );
  } else if (refresh?.status === 'failed') {
    parts.push(
      `\n\n## Your branch was NOT brought up to date\n\n` +
      `The automatic update of your branch with \`${wt.base}\` failed, so you may be ` +
      `working on a stale base. Git said:\n\n` +
      `\`\`\`text\n${refresh.reason}\n\`\`\`\n\n` +
      `Before starting, run it yourself in your worktree:\n\n` +
      `\`\`\`bash\ngit merge --no-edit -m "${refreshMergeMessage(wt.base)}" ${wt.base}\n\`\`\`\n\n` +
      `If it still refuses for a reason you cannot fix, \`timon task block\` with ` +
      `that reason rather than working on the stale base.`,
    );
  } else if (refresh?.status === 'merged') {
    parts.push(
      `\n\n_Note: your branch was automatically brought up to date with ` +
      `\`${refresh.base}\` before this start — you are working on the latest ` +
      `state._`,
    );
  }
  if (task.type === 'merge' && task.landing === 'pr') {
    parts.push(pullRequestDirective(task, wt, activeBranch ?? null));
  } else if (task.type === 'merge' && task.landing === 'local') {
    parts.push(localLandingDirective(task, wt, activeBranch ?? null));
  } else if (task.type === 'merge') {
    const finish = baseAdvanceInstructions(wt.sourceRepo, wt.base, wt.branch, activeBranch ?? null);
    parts.push(
      `\n\n## Where you merge — hard rule\n\n` +
      `You have YOUR worktree: \`${wt.path}\` (branch \`${wt.branch}\`). Do all ` +
      `your work there — merging the source branch, resolving conflicts, build, ` +
      `tests.\n\n` +
      `The main repo (\`${wt.sourceRepo}\`) has only ONE working directory, ` +
      `shared by every agent. **Run no command that writes there**: no ` +
      `\`git add\`, no \`git commit\`, no \`git checkout\`, no \`git reset\`, no ` +
      `\`git update-ref\`. A \`git add -A\` run there commits as DELETED every ` +
      `file the others just merged — that is what erased ` +
      `2,800 lines on 2026-08-20.\n\n` +
      `Base to move forward: \`${wt.base}\`.\n\n` +
      `## Merge messages — hard rule\n\n` +
      `Every merge commit you create carries an explicit English message with ` +
      `NO task or mission id: git's default (\`Merge branch 'timon/task/<id>' …\`) ` +
      `is refused by a public repository's commit-msg hook, and would publish ` +
      `internal ids otherwise. Integrate each source branch with:\n\n` +
      `\`\`\`bash\ngit merge --no-ff -m "${integrateMergeMessage(wt.base)}" <source-branch>\n\`\`\`\n\n` +
      `After resolving a conflict, conclude with \`git commit --no-edit\`: the ` +
      `message given with \`-m\` is kept. Moving the base below creates ` +
      `no commit.\n\n` +
      `When your worktree is green, the final move:\n\n${finish}\n\n` +
      `Then use that FULL sha (40 hex) for \`timon task done --merged-sha\`.`,
    );
  }
  return parts.join('');
}

/**
 * Base branch a task inherits from the chain it belongs to: the first non-null
 * `base_branch` found walking `deps` upward (merge → review → code, or a
 * `code-group` merge → its code tasks). Bounded: a malformed cycle must not spin.
 */
export function inheritedBase(task: TaskRow): string | null {
  const seen = new Set<string>([task.id]);
  let level: TaskRow[] = [task];
  for (let depth = 0; depth < 6 && level.length > 0; depth++) {
    const next: TaskRow[] = [];
    for (const t of level) {
      let ids: unknown;
      try { ids = JSON.parse(t.deps); } catch { continue; }
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id !== 'string' || seen.has(id)) continue;
        seen.add(id);
        const dep = dbApi.getTask(id);
        if (!dep) continue;
        if (dep.base_branch) return dep.base_branch;
        next.push(dep);
      }
    }
    level = next;
  }
  return null;
}

/** Why the last worktree creation of a task failed, for its blocked reason. */
const worktreeFailures = new Map<string, string>();

function worktreeFailure(err: unknown): string {
  const e = err as Error & { stderr?: string };
  return ((e.stderr ?? '').trim() || e.message || 'git worktree add failed').slice(-300);
}

export async function resolveWorktree(task: TaskRow): Promise<WorktreeInfo | null> {
  // Reviews always resolve through their parent below, including on retries.
  // If everything is already in DB (re-spawn), rebuild the info without
  // recreating the worktree. sourceRepo = agent's cfg.cwd at re-spawn
  // time. The path in the DB doesn't prove the folder is still there: a
  // dispose, a GC pass or a manual cleanup may have removed it since.
  // Spawning on a non-existent cwd kills the mission instantly — we then
  // fall back to normal creation, which reattaches to the branch if it
  // survived and so doesn't lose already-committed work.
  if (task.type !== 'review' && task.worktree_path && task.branch_name && task.base_branch && existsSync(task.worktree_path)) {
    const cfg = loadConfig(task.agent_name);
    if (cfg.cwd) {
      // Refresh onto the base BEFORE handing control back to the agent.
      // A worktree is created on the FIRST spawn and reused afterward: a
      // task that iterates (`[iter:2]`, `[iter:3]`) or that gets
      // requeued otherwise stays on the `main` from several hours ago,
      // and its final merge reintroduces that stale state over other
      // agents' work (incident of 2026-08-20). Non-blocking: a
      // failure leaves the task starting on its base as-is, which is
      // still preferable to not launching it at all.
      lastRefresh.delete(task.id);
      const outcome = await refreshWorktreeBase(task.worktree_path, task.base_branch);
      await prepareWorktreeDependencies(cfg.cwd, task.worktree_path);
      recordRefresh(task.id, task.base_branch, outcome);
      return {
        taskId: task.id,
        path: task.worktree_path,
        branch: task.branch_name,
        base: task.base_branch,
        sourceRepo: cfg.cwd,
      };
    }
  }

  if (task.type === 'code') {
    const cfg = loadConfig(task.agent_name);
    if (!cfg.cwd || !(await isGitRepo(cfg.cwd))) return null;
    try {
      // The task's explicit base if it carries one: without it,
      // `createWorktree` falls back on the CURRENT branch of the shared repo, which
      // may be another agent's — and the `code-self` merge then lands
      // on their work (evening of 2026-09-05).
      const info = await createWorktree(task.id, cfg.cwd, task.base_branch ?? undefined);
      dbApi.setTaskWorktree(task.id, info.path, info.branch, info.base);
      console.log(`[dispatcher] worktree ${info.path} (branch=${info.branch}) for task ${task.id}`);
      return info;
    } catch (err) {
      console.warn(`[dispatcher] worktree create failed for ${task.id}: ${(err as Error).message}`);
      worktreeFailures.set(task.id, worktreeFailure(err));
      return null;
    }
  }

  // The MERGER gets its own worktree, on a `timon/merge/<id>` branch
  // starting from the up-to-date base. Before, it inherited the coder's
  // worktree and ended up operating in the main repo to touch `main` —
  // but the main repo has only ONE working directory, shared by every
  // merger. Two merges a minute apart, and one takes the other's
  // intermediate state for "local changes to commit": that's how 2,800
  // freshly merged lines got committed as deleted (
  // 2026-08-20). It now does everything on its own; `main` only advances
  // via a final fast-forward, under lock.
  if (task.type === 'merge') {
    const cfg = loadConfig(task.agent_name);
    if (!cfg.cwd || !(await isGitRepo(cfg.cwd))) return null;
    try {
      // Own base, else the one its code task(s) were created with. The shared
      // repo's active branch is the LAST resort: it is whatever the user is
      // working on, and a merge landing there is a merge on the wrong branch
      // (18/10/2026, SDK API 10 series).
      const base = task.base_branch ?? inheritedBase(task) ?? (await currentBranch(cfg.cwd)) ?? 'main';
      const info = await createWorktree(task.id, cfg.cwd, base, `timon/merge/${task.id}`);
      dbApi.setTaskWorktree(task.id, info.path, info.branch, base);
      // Idempotent: on re-spawn the worktree already exists and may date
      // from an earlier `main` — same refresh as for a coder, reported the same.
      recordRefresh(task.id, base, await refreshWorktreeBase(info.path, base));
      console.log(`[dispatcher] worktree merge ${info.path} (branch=${info.branch}) for task ${task.id}`);
      return info;
    } catch (err) {
      console.warn(`[dispatcher] worktree merge failed for ${task.id}: ${(err as Error).message}`);
      worktreeFailures.set(task.id, worktreeFailure(err));
      return null;
    }
  }

  if (task.type === 'review') {
    let deps: string[];
    try { deps = JSON.parse(task.deps); } catch { return null; }
    for (const depId of deps) {
      const dep = dbApi.getTask(depId);
      if (dep?.worktree_path && dep.branch_name && dep.base_branch && existsSync(dep.worktree_path)) {
        // The inherited worktree belongs to the parent, not the reviewer account.
        const cfg = loadConfig(dep.agent_name);
        if (!cfg.cwd) continue;
        await prepareWorktreeDependencies(cfg.cwd, dep.worktree_path);
        // Also tag this task with the inherited worktree so the
        // timon-worktree skill can find it via `timon task get`.
        dbApi.setTaskWorktree(task.id, dep.worktree_path, dep.branch_name, dep.base_branch);
        return {
          taskId: task.id,
          path: dep.worktree_path,
          branch: dep.branch_name,
          base: dep.base_branch,
          sourceRepo: cfg.cwd,
        };
      }
    }
  }

  return null;
}

/** Series-scoped LLM choice for the task's type (`series_roles`, and the
 *  task's group of volets first — `series_group_roles`), if any. Read live
 *  rather than copied onto the tasks: the tasks the verification loop and
 *  doc-task create later inherit it through their `series_id` and
 *  `plan_group` alone. */
function readSeriesRole(task: TaskRow): SeriesLlmChoice | undefined {
  return seriesLlmChoice(task.series_id, task.type, task.plan_group);
}

/** What `readSeriesRole` resolves: the group's row over the series' one. */
export type SeriesLlmChoice = { backend: string | null; model: string | null };

/**
 * Resolves the RoleSpec to apply for a task.
 * - Fetches the project slug from the agent's cfg.project (or
 *   auto-derived from the cwd).
 * - Reads the project's roles, picks the one matching task.type.
 * - Explicit overrides on the task (backend_override, model_override,
 *   permission_mode_override) take priority over the RoleSpec — a
 *   one-off exception.
 * - Between the two sits the series choice (`timon series role set`): the
 *   planner's picks, scoped to the series so `roles.json` stays untouched —
 *   and, for a task of a group of volets, the group's own choice first
 *   (`--group`, see `seriesLlmChoice`).
 *
 * Resolution chain (symmetric backend/model):
 *   backend = task.backend_override ?? group.backend ?? series.backend ?? roleSpec.backend ?? null  (null → agent config)
 *   model   = task.model_override   ?? group.model   ?? series.model   ?? roleSpec.model   ?? null  (null → backend default)
 *
 * Anti-mismatch guard: a model whose origin doesn't match the effective
 * backend is cancelled (the CLI would crash otherwise, e.g.
 * `codex --model claude-opus-*`).
 */
export function resolveRoleSpec(
  task: TaskRow,
): { backend: BackendName | null; model: string | null; permissionMode: string | null; roleMcpServers: string[] } {
  const cfg = loadConfig(task.agent_name);
  const slug = taskProjectSlug(task, cfg);
  const spec = slug ? readRoleSpec(slug, task.type) : undefined;
  const series = readSeriesRole(task);
  const named = task.backend_override ?? series?.backend ?? spec?.backend ?? cfg.backend;
  assertBackendEnabled(named);
  // A backend that is named but not there (a provider mid-load, uninstalled, or
  // refused for failing its checks) is a refusal, never the default backend:
  // the task would otherwise run on another subscription in silence.
  if (named && !isBackendName(named)) {
    throw new Error(`Backend ${named} is not available (uninstalled, still loading, or refused) — the task will not run on another provider`);
  }
  const backend = asBackendName(task.backend_override) ?? asBackendName(series?.backend) ?? spec?.backend ?? null;
  let model = task.model_override ?? series?.model ?? spec?.model ?? null;
  // Effective backend (override → role → agent config → registry
  // default) to judge model consistency. If incompatible, cancel the
  // model → backend default.
  const effectiveBackend = backend ?? asBackendName(cfg.backend) ?? defaultBackendName();
  // `catalogClaimsModel` first: several backends may serve the same model
  // (an aggregator and the model's own vendor). `backendForModel` only
  // designates one — trusting it alone would wrongly cancel a model the
  // effective backend actually serves.
  const modelBackend = catalogClaimsModel(effectiveBackend, model)
    ? effectiveBackend
    : backendForModel(model);
  if (model && modelBackend && modelBackend !== effectiveBackend) {
    console.warn(
      `[dispatcher] task ${task.id.slice(0, 8)}: model '${model}' incompatible with backend '${effectiveBackend}' → model ignored (backend default applied)`,
    );
    model = null;
  }
  return {
    backend,
    model,
    permissionMode: task.permission_mode_override ?? spec?.permission_mode ?? null,
    roleMcpServers: spec?.mcp_servers ?? [],
  };
}

export type TaskLlmCache = {
  cfg: Map<string, AgentConfig>;
  roles: Map<string, RoleSpec | undefined>;
  series?: Map<string, SeriesLlmChoice | undefined>;
  modelBackend?: Map<string, string | null>;
  defaultBackend?: BackendName;
};

function cachedConfig(name: string, cache?: TaskLlmCache): AgentConfig {
  let cfg = cache?.cfg.get(name);
  if (!cfg) {
    cfg = loadConfig(name);
    cache?.cfg.set(name, cfg);
  }
  return cfg;
}

/** `model`, or null when it belongs to another backend than `backend`. Same
 *  rule as resolveRoleSpec: a model served by several backends is not a
 *  mismatch (cf. catalogClaimsModel). */
function modelOnBackend(backend: string, model: string | null, cache?: TaskLlmCache): string | null {
  if (!model) return null;
  const modelKey = `${backend}\u0000${model}`;
  let modelBackend = cache?.modelBackend?.get(modelKey);
  if (modelBackend === undefined) {
    modelBackend = catalogClaimsModel(backend, model) ? backend : backendForModel(model);
    cache?.modelBackend?.set(modelKey, modelBackend);
  }
  return modelBackend && modelBackend !== backend ? null : model;
}

/**
 * Backend + model ACTUALLY assigned to a task, for display (UI badge).
 * Faithfully reproduces the spawn resolution chain (agent.ts:32-33):
 *   backend = override ?? series ?? roleSpec ?? cfg ?? 'claude'
 *   model   = override ?? series ?? roleSpec ?? cfg ?? null  (null = backend's CLI
 *             default, unknown to the orchestrator → the UI only shows
 *             the backend)
 * Keeps the consistency nullification (model incompatible with the
 * backend → null) to never render "codex / opus".
 *
 * `cache` (optional) memoizes loadConfig/readRoleSpec across a batch of
 * tasks: GET /api/tasks returns ALL tasks and is polled every 5s —
 * without a cache, that's 2×N file reads per tick. `defaultBackend` and
 * `modelBackend` memoize the backend registry and the catalogue: both are
 * rebuilt on every call (overlay query, secret vault, zod parses), and on
 * 2,571 tasks that cost ~20× the SQL and the JSON together (26/09/2026).
 *
 * `runner` is the agent the dispatcher hands the task to (`previewTaskRouting`),
 * when it is not the one the task names: its config is what the spawn falls back
 * on, so the badge must read it too (#1109: a `research` task named after a
 * codex reviewer showed codex while the claude researcher ran it). The project
 * and its role are still read through the named agent, as `resolveRoleSpec` does.
 */
export function resolveTaskLlm(
  task: TaskRow,
  cache?: TaskLlmCache,
  runner?: string,
): { backend: BackendName; model: string | null } {
  const named = cachedConfig(task.agent_name, cache);
  const cfg = runner && runner !== task.agent_name ? cachedConfig(runner, cache) : named;
  const slug = taskProjectSlug(task, named);
  const roleKey = `${slug ?? ''}:${task.type}`;
  let spec: RoleSpec | undefined;
  if (cache?.roles.has(roleKey)) {
    spec = cache.roles.get(roleKey);
  } else {
    spec = slug ? readRoleSpec(slug, task.type) : undefined;
    cache?.roles.set(roleKey, spec);
  }
  const seriesKey = `${task.series_id ?? ''}:${task.type}:${task.plan_group ?? ''}`;
  let series: SeriesLlmChoice | undefined;
  if (cache?.series?.has(seriesKey)) {
    series = cache.series.get(seriesKey);
  } else {
    series = readSeriesRole(task);
    cache?.series?.set(seriesKey, series);
  }

  const backend = task.backend_override ??
    series?.backend ??
    spec?.backend ??
    cfg.backend ??
    (cache ? (cache.defaultBackend ??= defaultBackendName()) : defaultBackendName());
  const model = task.model_override ?? series?.model ?? spec?.model ?? cfg.model ?? null;
  return { backend, model: modelOnBackend(backend, model, cache) };
}

/**
 * Backend + model a mission ran on: what the dispatcher froze on it (or a quota
 * switch, a model change, the account check wrote since), else its own agent's
 * config. The task's board reads this once a mission exists, never the agent
 * the task names.
 */
export function missionLlm(
  mission: Pick<MissionRow, 'agent_name' | 'backend_override' | 'model_override'>,
  cache?: TaskLlmCache,
): { backend: BackendName; model: string | null } {
  const cfg = cachedConfig(mission.agent_name, cache);
  const backend = mission.backend_override ??
    cfg.backend ??
    (cache ? (cache.defaultBackend ??= defaultBackendName()) : defaultBackendName());
  return { backend, model: modelOnBackend(backend, mission.model_override ?? cfg.model ?? null, cache) };
}

/**
 * What the dispatcher writes on a task's mission so it keeps the backend and
 * the model it really runs on (#1109): the resolved pair, completed from the
 * running agent's config when nothing above it decided. The agent's model only
 * goes with the agent's own backend: on another one it would not be served.
 */
export function frozenTaskLlm(
  resolved: { backend: BackendName | null; model: string | null },
  runnerCfg: Pick<AgentConfig, 'backend' | 'model'>,
): { backend: BackendName | null; model: string | null } {
  const backend = resolved.backend ?? asBackendName(runnerCfg.backend) ?? null;
  if (resolved.model || !backend) return { backend, model: resolved.model };
  return { backend, model: backend === runnerCfg.backend ? runnerCfg.model ?? null : null };
}

/** Task types that run IN Timon's working tree: a `code` task writes in its
 *  git worktree, a `merge` integrates in its own. A `review` stays open to any
 *  backend: it reads a diff it can be handed. */
const WORKTREE_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>(['code', 'merge']);

/**
 * Why `task` cannot run on `backend`, or null when it can. A backend that
 * declared no `worktree` capability (an agent working in its own remote space)
 * would otherwise be handed a worktree path it never sees, and its "work"
 * would land nowhere.
 */
export function capabilityRefusal(task: Pick<TaskRow, 'type'>, backend: BackendName, attachmentCount = 0): string | null {
  // Attached files are announced by their path on this host's disk, which an
  // agent without the `attachments` capability (a remote one) cannot open:
  // running anyway would let the task pass for done without its mockups.
  return capabilityRefusalMessage(task, backend, attachmentCount)?.text ?? null;
}

/** `capabilityRefusal` with the code the webview translates (TODO #845). */
function capabilityRefusalMessage(
  task: Pick<TaskRow, 'type'>,
  backend: BackendName,
  attachmentCount: number,
): { text: string; code: DaemonMessage } | null {
  if (attachmentCount > 0 && !backendCapabilities(backend).attachments) {
    return {
      text:
        `Backend \`${backend}\` cannot read files on this host (no \`attachments\` capability), ` +
        `and this task has ${attachmentCount} attached file(s). Assign the task to an agent on a local backend, ` +
        `set a local backend on the task (backend override), or remove the attachments.`,
      code: daemonMessage('backend_cannot_read_attachments', { backend, count: attachmentCount }),
    };
  }
  if (!WORKTREE_TASK_TYPES.has(task.type)) return null;
  if (backendCapabilities(backend).worktree) return null;
  return {
    text:
      `Backend \`${backend}\` does not work in Timon's folder (no \`worktree\` capability), ` +
      `so a \`${task.type}\` task cannot run on it. Assign the task to an agent on a local backend, ` +
      `or set a local backend on the task (backend override) or on the project's role.`,
    code: daemonMessage('backend_cannot_use_worktree', { backend, type: task.type }),
  };
}

/** Blocks `task` with a readable reason when its backend cannot run it.
 *  Blocked, not dropped: the reason wakes the series and the task waits for a
 *  human or its orchestrator to reassign it. */
export function blockIfBackendCannot(task: TaskRow, backend: BackendName, attachmentCount = 0): boolean {
  const refusal = capabilityRefusalMessage(task, backend, attachmentCount);
  if (!refusal) return false;
  console.warn(`[dispatcher] task ${task.id} → BLOCKED: ${refusal.text}`);
  dbApi.updateTaskStatus(task.id, 'BLOCKED', { blockedReason: refusal.text, blockedReasonCode: refusal.code });
  return true;
}

/** BLOCKED with the reason when this host has no git for a code/review/merge task (TODO #275). */
export function blockIfGitMissing(task: TaskRow, capabilities?: readonly string[]): boolean {
  const cwd = (() => { try { return loadConfig(task.agent_name).cwd ?? null; } catch { return null; } })();
  const reason = gitTaskRefusal(task.type, { cwd, ...(capabilities ? { capabilities } : {}) });
  if (!reason) return false;
  console.warn(`[dispatcher] task ${task.id} → BLOCKED: ${reason}`);
  dbApi.updateTaskStatus(task.id, 'BLOCKED', {
    blockedReason: reason,
    blockedReasonCode: reason === GIT_MISSING_REASON ? GIT_MISSING_MESSAGE : null,
  });
  return true;
}

function agentCwd(agentName: string): string | null {
  try { return loadConfig(agentName).cwd ?? null; } catch { return null; }
}

function blockTask(task: TaskRow, reason: string, message: DaemonMessage): void {
  console.warn(`[dispatcher] task ${task.id} → BLOCKED: ${reason}`);
  dbApi.updateTaskStatus(task.id, 'BLOCKED', { blockedReason: reason, blockedReasonCode: message });
}

/**
 * How the chain lands, read up the `deps` like `inheritedBase`: the first task
 * that carries an `integration_mode` or a `base_ref`. A `code-group` final merge
 * finds it on its volets, a review or a merge on the code task of its chain.
 */
export function inheritedIntegration(task: TaskRow): { mode: string | null; baseRef: string | null } | null {
  const seen = new Set<string>([task.id]);
  let level: TaskRow[] = [task];
  for (let depth = 0; depth < 6 && level.length > 0; depth++) {
    const next: TaskRow[] = [];
    for (const t of level) {
      let ids: unknown;
      try { ids = JSON.parse(t.deps); } catch { continue; }
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id !== 'string' || seen.has(id)) continue;
        seen.add(id);
        const dep = dbApi.getTask(id);
        if (!dep) continue;
        if (dep.integration_mode || dep.base_ref) {
          return { mode: dep.integration_mode ?? null, baseRef: dep.base_ref ?? null };
        }
        next.push(dep);
      }
    }
    level = next;
  }
  return null;
}

/** How a root task lands, read from its project's setting. */
export type ProjectLanding =
  | { kind: 'local' }
  | { kind: 'integration'; mode: Extract<IntegrationMode, 'branch' | 'pr'>; baseRef: string; branch: string }
  | { kind: 'refused'; branch: string; baseRef: string; detail: string };

/**
 * The project's integration setting (`project-integration.ts`) applied to a
 * task that starts a chain. No setting, a project Timon does not know or mode
 * `local`: `local`, and nothing is written, as before the setting existed.
 *
 * Mode `pr`: the chain is cut from `<remote>/<target>` on the task's own base
 * when it names one (the series plan gives every volet the branch of the job),
 * else on `<prefix><slug of its title>`. A base under embargo (`sec/`) lands by
 * hand (`branch`), never through a pull request. Refused, never guessed: a
 * setting that no longer validates, a base that is the target itself, a name
 * that is not a valid public branch.
 */
export function projectLanding(
  task: Pick<TaskRow, 'project' | 'agent_name' | 'base_branch' | 'title'> & Partial<Pick<TaskRow, 'series_id'>>,
): ProjectLanding {
  // The branch the Kanban planner chose for the job comes first: it may give a
  // job of a project that merges locally a branch of its own, or start a job
  // of either kind from a branch the repository already has.
  const planned = plannedLanding(task);
  if (planned) {
    const mode: Extract<IntegrationMode, 'branch' | 'pr'> = planned.mode === 'pr' ? 'pr' : 'branch';
    return { kind: 'integration', mode, baseRef: planned.base_ref, branch: planned.branch };
  }
  let cfg: AgentConfig | null = null;
  try { cfg = loadConfig(task.agent_name); } catch { /* unknown agent: no project from it */ }
  const slug = taskProjectSlug(task, cfg);
  if (!slug) return { kind: 'local' };
  let read: ReturnType<typeof readProjectIntegration>;
  try { read = readProjectIntegration(slug); } catch { return { kind: 'local' }; }
  const branchShown = task.base_branch ?? 'none';
  if (read.invalid) {
    return {
      kind: 'refused', branch: branchShown, baseRef: 'none',
      detail: `the integration setting of project ${slug} is invalid (${read.invalid}); fix it with \`timon project set-integration\``,
    };
  }
  const setting = read.integration;
  if (setting.mode !== 'pr') {
    // A task on the branch of a job this project runs on a branch of its own
    // (a task created outside the plan's series, a sequential job's last task
    // created by another mission) carries on in that job's mode.
    const row = task.base_branch && cfg?.cwd ? dbApi.getIntegration(cfg.cwd, task.base_branch) : undefined;
    if (row && row.remote === '' && row.state === 'branch') {
      return { kind: 'integration', mode: 'branch', baseRef: localBaseRef(row.target), branch: row.branch };
    }
    return { kind: 'local' };
  }
  const baseRef = integrationBaseRef(setting);
  const branch = task.base_branch ?? integrationBranchName(task.title, { prefix: setting.branch_prefix });
  if (!branch) {
    return {
      kind: 'refused', branch: 'none', baseRef,
      detail: 'no branch name can be drawn from the task title; give the task a base (--base <prefix><topic>)',
    };
  }
  if (branch === setting.target || branch === baseRef) {
    return {
      kind: 'refused', branch, baseRef,
      detail: `project ${slug} lands through a pull request into ${setting.target}, so its jobs start from an ` +
        `integration branch, never from ${setting.target} itself; remove the base or name a topic branch`,
    };
  }
  const refusal = integrationBranchRefusal(branch);
  if (refusal) return { kind: 'refused', branch, baseRef, detail: refusal };
  return { kind: 'integration', mode: branch.startsWith('sec/') ? 'branch' : 'pr', baseRef, branch };
}

/**
 * What the Kanban planner chose for the job of `task`'s series, when the task
 * starts from that branch (or names none). A task on another base was created
 * outside the plan: the plan does not decide for it.
 */
export function plannedLanding(
  task: Pick<TaskRow, 'base_branch'> & Partial<Pick<TaskRow, 'series_id'>>,
): SeriesPlanLandingRecord | null {
  if (!task.series_id) return null;
  const planned = dbApi.getSeriesPlanLanding(task.series_id);
  if (!planned || !isIntegrationMode(planned.mode) || planned.mode === 'local') return null;
  if (task.base_branch && task.base_branch !== planned.branch) return null;
  return planned;
}

/**
 * Makes sure the base a `code` or `merge` task starts from exists, and BLOCKS
 * the task when it cannot (true = blocked). Before this, a missing base made
 * `createWorktree` fail, `resolveWorktree` return null, and the mission start
 * in the shared checkout (`docs/KANBAN-PR-PIPELINE.md` §3.4).
 *
 * - The chain's `integration_mode` / `base_ref` are frozen on the task first,
 *   from the task itself or the chain it belongs to. A task that starts a chain
 *   (no ancestor carries a base) takes them from its project's setting
 *   (`projectLanding`); a project in `local` mode writes nothing.
 * - An integration branch (`branch`, `pr`) is created from the remote ref,
 *   without a checkout; no remote, an unreachable one or a missing target
 *   blocks the task with the reason — never a fallback on the local base.
 * - Any other named base must resolve in the repository.
 *
 * What it freezes is written to the row and to `task`, which the caller goes on
 * using for the worktree.
 */
export async function blockIfBaseUnavailable(task: TaskRow): Promise<boolean> {
  if (task.type !== 'code' && task.type !== 'merge') return false;
  const cwd = agentCwd(task.agent_name);
  if (!cwd || !(await isGitRepo(cwd))) return false;
  if (!task.integration_mode && !task.base_ref) {
    const inherited = inheritedIntegration(task);
    if (inherited) {
      dbApi.setTaskIntegration(task.id, inherited.mode, inherited.baseRef);
      task.integration_mode = inherited.mode;
      task.base_ref = inherited.baseRef;
    } else if (!inheritedBase(task)) {
      // A chain already under way (an ancestor has a base) keeps the mode it
      // started with: a setting changed mid-way never splits a chain.
      const landing = projectLanding(task);
      if (landing.kind === 'refused') {
        const reason =
          `Integration branch ${landing.branch} is unavailable: ${landing.detail}. The task was not started, ` +
          `and the branch is never cut from the local base instead of ${landing.baseRef}. Fix the remote or ` +
          `the branch name, then retry the task.`;
        blockTask(task, reason, daemonMessage('integration_branch_unavailable', {
          branch: landing.branch, baseRef: landing.baseRef, detail: landing.detail,
        }));
        return true;
      }
      if (landing.kind === 'integration') {
        dbApi.setTaskIntegration(task.id, landing.mode, landing.baseRef);
        task.integration_mode = landing.mode;
        task.base_ref = landing.baseRef;
        if (!task.base_branch) {
          dbApi.setTaskBaseBranch(task.id, landing.branch);
          task.base_branch = landing.branch;
        }
      }
    }
  }
  const base = task.base_branch ?? inheritedBase(task);
  // The task that opens a pull request has nothing to publish in a job that
  // merges locally, or that lands by hand under embargo.
  if (task.landing === 'pr' && task.integration_mode !== 'pr') {
    const detail =
      `this task opens the job's pull request, but the job does not land through one ` +
      `(integration mode "${task.integration_mode ?? 'local'}"); set the project to mode pr or delete the task`;
    const reason =
      `Integration branch ${base ?? 'none'} is unavailable: ${detail}. The task was not started, and the ` +
      `branch is never cut from the local base instead of ${task.base_ref ?? 'none'}. Fix the remote or the ` +
      `branch name, then retry the task.`;
    blockTask(task, reason, daemonMessage('integration_branch_unavailable', {
      branch: base ?? 'none', baseRef: task.base_ref ?? 'none', detail,
    }));
    return true;
  }
  // The task that merges a job's branch into its local target has nothing to
  // merge in a job without a branch of its own, or one that lands remotely.
  if (task.landing === 'local' && (task.integration_mode !== 'branch' || !localTargetOf(task.base_ref))) {
    const detail =
      `this task merges the job's branch into its local target, but the job has no branch of its own in a project ` +
      `that merges locally (integration mode "${task.integration_mode ?? 'local'}"); plan the job on a branch, or delete the task`;
    const reason =
      `Integration branch ${base ?? 'none'} is unavailable: ${detail}. The task was not started, and the ` +
      `branch is never cut from the local base instead of ${task.base_ref ?? 'none'}. Fix the remote or the ` +
      `branch name, then retry the task.`;
    blockTask(task, reason, daemonMessage('integration_branch_unavailable', {
      branch: base ?? 'none', baseRef: task.base_ref ?? 'none', detail,
    }));
    return true;
  }
  if (usesIntegrationBranch(task.integration_mode)) {
    const baseRef = task.base_ref ?? null;
    if (!base || !baseRef) {
      const reason =
        `Integration mode "${task.integration_mode}" needs an integration branch and the remote ref to ` +
        `cut it from (base "${base ?? 'none'}", remote ref "${baseRef ?? 'none'}"). The task was not ` +
        `started: set both on the task, then retry it.`;
      blockTask(task, reason, daemonMessage('integration_branch_unset', {
        mode: task.integration_mode ?? '', branch: base ?? 'none', baseRef: baseRef ?? 'none',
      }));
      return true;
    }
    // A branch the planner chose as existing is never cut; one chosen as new
    // is never an unrelated branch the repository happens to have already.
    const planned = plannedLanding({ base_branch: base, series_id: task.series_id });
    const known = dbApi.getIntegration(cwd, base);
    const out = await ensureIntegrationBranch(cwd, { branch: base, baseRef, mustExist: planned?.branch_kind === 'existing' });
    if (out.ok && !out.created && !known && planned?.branch_kind === 'new') {
      const detail = `${base} already exists in the repository, and the job was planned on a new branch; ` +
        `plan it again on that existing branch or on another name`;
      const reason =
        `Integration branch ${base} is unavailable: ${detail}. The task was not started. Fix the branch name, ` +
        `then retry the task.`;
      blockTask(task, reason, daemonMessage('integration_branch_unavailable', { branch: base, baseRef, detail }));
      return true;
    }
    if (!out.ok) {
      const reason =
        `Integration branch ${base} is unavailable: ${out.reason}. The task was not started, and the ` +
        `branch is never cut from the local base instead of ${baseRef}. Fix the remote or the branch ` +
        `name, then retry the task.`;
      blockTask(task, reason, daemonMessage('integration_branch_unavailable', {
        branch: base, baseRef, detail: out.reason,
      }));
      return true;
    }
    dbApi.recordIntegration({
      repo: cwd,
      branch: base,
      remote: out.remote,
      target: out.target,
      mode: task.integration_mode ?? 'branch',
      project: task.project,
      seriesId: task.series_id,
      baseSha: out.created ? out.sha : null,
    });
    if (out.created) console.log(`[dispatcher] integration branch ${base} created from ${baseRef} for task ${task.id}`);
    if (!task.base_branch) {
      dbApi.setTaskBaseBranch(task.id, base);
      task.base_branch = base;
    }
    return false;
  }
  if (!base || (await branchExists(cwd, base))) return false;
  const reason =
    `Base ${base} does not exist in the repository. The task was not started: a ${task.type} task ` +
    `never runs without its base. Create the branch or change the task's base, then retry it.`;
  blockTask(task, reason, daemonMessage('task_base_missing', { base, type: task.type }));
  return true;
}

/**
 * A `code` or `merge` task of a git repository that got no worktree is BLOCKED
 * (true), never spawned: without `cwdOverride` its mission would run in the
 * agent's folder, the checkout every other agent shares. Both the assigned
 * agent's folder and the one of the agent that will really run it count.
 */
export async function blockIfSharedCheckout(
  task: TaskRow,
  wt: WorktreeInfo | null,
  runningAgent: string,
): Promise<boolean> {
  if (wt || (task.type !== 'code' && task.type !== 'merge')) return false;
  const cwds = [...new Set([agentCwd(task.agent_name), agentCwd(runningAgent)])];
  let inRepository = false;
  for (const cwd of cwds) if (cwd && (await isGitRepo(cwd))) inRepository = true;
  if (!inRepository) return false;
  const cause = worktreeFailures.get(task.id) ?? 'no worktree could be prepared';
  worktreeFailures.delete(task.id);
  const reason =
    `No worktree for this ${task.type} task (${cause}). It was not started: in the agent's own ` +
    `folder it would write to the checkout every agent shares. Fix the cause, then retry the task.`;
  blockTask(task, reason, daemonMessage('task_worktree_unavailable', { type: task.type, cause }));
  return true;
}

/**
 * The MCP servers a task's mission gets: zero by default from the task. Only
 * the MCPs listed in the role's config and in the task's own extras are
 * enabled; the union replaces the agent's `mcp_servers`. A malformed stored
 * list is read as none.
 */
export function taskMcpServers(roleMcpServers: readonly string[], task: Pick<TaskRow, 'extra_mcp_servers'>): string[] {
  let taskExtraMcp: string[] = [];
  try { if (task.extra_mcp_servers) taskExtraMcp = JSON.parse(task.extra_mcp_servers); } catch { /* */ }
  return [...new Set([...roleMcpServers, ...taskExtraMcp])];
}

/** The dispatcher gives every task this skill itself: naming it in the extras grants nothing. */
const DISPATCHER_TASK_SKILL = 'timon-task';

/**
 * Why the extras a task stores may not reach `agentName`, or null.
 *
 * Adding a tool, a skill that pre-authorises one or a stdio MCP server to an
 * agent takes a person. The task route refuses an agent's token that tries,
 * but only when the task is written: a task an agent's mission created before
 * that check existed, or through a path that escaped it, would still hand its
 * extras to the agent at start. So the dispatcher judges them again, against
 * the agent that will really run the task (a rerouted task runs on the role's
 * holder, not on the agent it names).
 *
 * The author is read from `creator_mission_id`: the task route stores a mission
 * there only for a mission's own token (or one an unrestricted caller names),
 * and the daemon's follow-up tasks inherit it from the task they follow. A task
 * without one was written by a person, a routine or a trigger, and starts as
 * before.
 */
export function taskExtrasRefusal(
  task: Pick<TaskRow, 'creator_mission_id' | 'extra_allowed_tools' | 'extra_mcp_servers' | 'extra_skills'>,
  agentName: string,
): string | null {
  if (!task.creator_mission_id) return null;
  // Stored by the route as a JSON list; a malformed value is read as none,
  // exactly as the spawn below reads it.
  const stored = (raw: string | null): string[] | undefined => {
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value.map(String) : undefined;
    } catch { return undefined; }
  };
  const skills = stored(task.extra_skills)?.filter((id) => id !== DISPATCHER_TASK_SKILL);
  const extras = {
    extra_allowed_tools: stored(task.extra_allowed_tools),
    extra_mcp_servers: stored(task.extra_mcp_servers),
    extra_skills: skills?.length ? skills : undefined,
  };
  if (!extras.extra_allowed_tools && !extras.extra_mcp_servers && !extras.extra_skills) return null;
  const config = (() => { try { return loadConfig(agentName); } catch { return null; } })();
  return spawnWideningRefusal(extras, config, agentName);
}

/**
 * BLOCKED with a readable reason when `taskExtrasRefusal` refuses: the task
 * waits for a person to grant the agent what it asks for, or to strip the
 * extras, and the block wakes its pilot like any other.
 */
export function blockIfExtrasWiden(task: TaskRow, agentName: string): boolean {
  const refusal = taskExtrasRefusal(task, agentName);
  if (!refusal) return false;
  const reason = `An agent's mission wrote this task, and its extras would give agent "${agentName}" more than it holds: ${refusal}. `
    + `Remove these extras from the task, or grant them to "${agentName}" first, then retry the task.`;
  console.warn(`[dispatcher] task ${task.id} → BLOCKED: ${reason}`);
  dbApi.insertAuditLog({
    userId: task.creator_mission_id ? dbApi.missionOwnerId(task.creator_mission_id) : null,
    actor: 'api-token',
    action: 'task.override_denied',
    target: `task:${task.id} agent:${agentName} — ${refusal}`,
  });
  dbApi.updateTaskStatus(task.id, 'BLOCKED', {
    blockedReason: reason,
    blockedReasonCode: daemonMessage('task_extras_widen', { agent: agentName, refusal }),
  });
  return true;
}

/**
 * The first message of a task's mission: its id, the brief the human wrote,
 * the paths of its attached files (its verification root's included), then
 * the pipeline and worktree directives.
 */
export function composeTaskPrompt(
  taskId: string,
  brief: string,
  attachments: readonly StoredTaskAttachment[],
  directives: string,
): ReturnType<typeof composePrompt> {
  return composePrompt([
    { kind: 'instruction', text: `TASK_ID: ${taskId}\n\n` },
    { kind: 'text', text: brief },
    ...taskAttachmentParts(attachments),
    { kind: 'instruction', text: directives },
  ]);
}

/**
 * Pipeline note injected at the end of the brief, for "code only" modes.
 *
 * The `timon-task` skill asks the coder to chain review+merge itself:
 * this note is what explicitly exempts it from that. The hard guard (no
 * auto review) lives in verification-loop; this one just prevents the
 * agent from creating the tasks by hand out of habit.
 */
export function pipelineDirective(
  task: TaskRow,
  /** The main repo and the branch it stands on, read by the caller at spawn. */
  place?: { sourceRepo: string; activeBranch: string | null },
): string {
  if (task.type !== 'code') return '';
  if (task.pipeline === 'code-self') {
    const base = task.base_branch ?? '<base>';
    const branch = task.branch_name ?? '<your-branch>';
    const repo = place?.sourceRepo ?? '<main-repository>';
    // The integration happens on a DETACHED copy of the base inside the
    // coder's own worktree: the merge commit has the base as first parent, as
    // a merger's has, and neither the base branch nor the shared checkout is
    // ever checked out or written.
    return (
      `\n\n---\nPIPELINE: \`code-self\`. Create NO \`review\` or \`merge\` task — ` +
      `the user chose the fast mode. When your code is ready and committed, ` +
      `integrate your branch into its base YOURSELF, from YOUR worktree only:\n\n` +
      `\`\`\`bash\n` +
      `git checkout --detach ${base}\n` +
      `git merge --no-ff -m "${integrateMergeMessage(base)}" ${branch}\n` +
      `\`\`\`\n\n` +
      `The message is explicit and carries no task id: git's default names the ` +
      `task id, which a public repository's hook refuses. After resolving a ` +
      `conflict, conclude with \`git commit --no-edit\`. Then move the base:\n\n` +
      `${baseAdvanceInstructions(repo, base, 'HEAD', place?.activeBranch ?? null)}\n\n` +
      `Finally \`git checkout ${branch}\` to leave your worktree on its branch, and ` +
      `close with \`timon task done <TASK_ID> --comment "..." --merged-sha <the base's FULL sha>\`. ` +
      `The sha is REQUIRED: without it the task goes back to BLOCKED (guard against ` +
      `never-merged branches). On a conflict you cannot resolve cleanly, ` +
      `do not force: \`timon task block\` with the reason.`
    );
  }
  if (task.pipeline === 'code-group') {
    return (
      `\n\n---\nPIPELINE: \`code-group\`. Create NO \`review\` or \`merge\` task — ` +
      `the user chose the fast mode and a final \`merge\` task will consolidate the whole ` +
      `group. Commit on your branch, leave it as is, and close with ` +
      `\`timon task done <TASK_ID> --comment "..."\`.`
    );
  }
  return '';
}

/** Night heuristic: 10pm–8am local. */
function isNightSchedule(scheduledAt: number): boolean {
  const h = new Date(scheduledAt).getHours();
  return h >= 22 || h < 8;
}

const diskPause = new DiskPause();

/**
 * False while free space is under `TIMON_DISK_MIN_FREE_MB`: the tick starts
 * nothing, the tasks wait as PENDING, and the user hears it once when the
 * pause starts and once when it ends. Exported for its test.
 */
export function diskAllowsDispatch(gate: DiskGate = worktreeDiskGate()): boolean {
  const change = diskPause.update(gate);
  if (change === 'paused' && !gate.ok) {
    const detail = diskGateMessage(gate);
    console.warn(`[dispatcher] paused: ${detail}`);
    notifyUser(
      'Tasks paused: the disk is almost full',
      `No task starts while ${detail}. Each task adds a worktree and writes to the database; ` +
        'a full disk stops Timon itself. Free some space: dispatching resumes on its own.',
      {
        type: 'alert',
        message: daemonMessage('dispatcher_disk_paused', {
          free: formatBytes(gate.free), min: formatBytes(gate.min), dir: gate.dir,
        }),
      },
    );
  } else if (change === 'resumed') {
    console.log('[dispatcher] resumed: free space is back above the floor');
    notifyUser(
      'Tasks resumed: free space is back',
      'Free space is back above the floor (TIMON_DISK_MIN_FREE_MB): waiting tasks start again.',
      { type: 'report', message: daemonMessage('dispatcher_disk_resumed') },
    );
  }
  return gate.ok;
}

async function dispatch(): Promise<void> {
  // Before the back-pressure below: a requeue spawns nothing, and a task that
  // waits for its quota must not wait one more tick because the machine is busy.
  try {
    requeueBackendBlockedTasks();
  } catch (err) {
    console.error(`[dispatcher] requeue of backend-blocked tasks failed: ${(err as Error).message}`);
  }
  // GLOBAL back-pressure (anti-freeze): past the cap of live missions
  // across all sources, or under overheating (loadavg), we dispatch
  // NOTHING this tick — we defer to the next one. Bounds actual
  // parallelism where MAX_PARALLEL() (countInProgress alone) is blind to
  // wake/pipeline/recovery/resume missions piling up silently.
  const adm = canSpawnMission();
  if (!adm.ok) {
    console.log(`[dispatcher] dispatch deferred: ${adm.reason}`);
    return;
  }
  if (!diskAllowsDispatch()) return;

  const inProgress = dbApi.countInProgress();
  if (inProgress >= MAX_PARALLEL()) return;

  const slots = MAX_PARALLEL() - inProgress;
  const candidates = dbApi.listPendingReady();
  let spawned = 0;
  // Repos with a merge already in progress. Recomputed each tick then
  // kept up to date along the loop, so we don't launch two in the same
  // tick.
  const mergingRepos = new Set(
    dbApi
      .listTasks('IN_PROGRESS')
      .filter((t) => t.type === 'merge')
      .map((t) => mergeLockKey(t)),
  );

  for (const task of candidates) {
    if (spawned >= slots) break;
    // A mirror task is the image of an external ticket, never work. The query
    // already leaves it out (`listPendingReady`); this is the guard that holds
    // if another source of candidates ever feeds the loop.
    if (isMirrorTask(task)) continue;
    // MERGE LOCK: only one merger at a time per repo. Merges all
    // converge onto the same `main`; two in parallel means two agents
    // stepping on each other while integrating, and one ends up
    // committing the other's intermediate state (
    // 2026-08-20: two merges a minute apart, 2,800 lines erased). This
    // is NOT a block: the task stays PENDING and retries next tick, exactly
    // like when the parallelism cap is reached. Coders keep running in
    // parallel — only the integration serializes, costing a handful of
    // seconds per merge.
    if (task.type === 'merge') {
      const key = mergeLockKey(task);
      if (mergingRepos.has(key)) {
        console.log(`[dispatcher] merge ${task.id} waiting: a merge is already in progress on ${key}`);
        continue;
      }
    }
    const gate = depsGate(task);
    if (!gate.ok) {
      // Justified refusal (a merge whose review didn't say `pass`): we
      // move the task to BLOCKED with the reason rather than leaving it
      // silently undispatched — a stall with no reason forces a manual
      // investigation, and blocking emits `task_blocked` which wakes the
      // orchestrator.
      // Same for a wait that never ends: a review asked for changes and no
      // repair iteration exists past the limit (TODO #322).
      const stall = gate.blockedReason ? null : repairWaitStall(gate, Date.now());
      const blockedReason = gate.blockedReason ?? stall?.reason ?? null;
      if (blockedReason) {
        console.warn(`[dispatcher] task ${task.id} → BLOCKED: ${blockedReason}`);
        dbApi.updateTaskStatus(task.id, 'BLOCKED', {
          blockedReason,
          blockedReasonCode: gate.blockedReason ? gate.blockedReasonCode ?? null : stall?.code ?? null,
        });
        lastWaitLogged.delete(task.id);
      } else if (gate.waitingFor && lastWaitLogged.get(task.id) !== gate.waitingFor) {
        lastWaitLogged.set(task.id, gate.waitingFor);
        console.log(`[dispatcher] task ${task.id} waiting: ${gate.waitingFor}`);
      }
      continue;
    }
    lastWaitLogged.delete(task.id);
    // Re-check the global cap on every iteration: we may have spawned
    // enough within this same tick to reach it (the live count climbs
    // along the loop).
    const adm2 = canSpawnMission();
    if (!adm2.ok) {
      console.log(`[dispatcher] stopping tick (${spawned} spawned): ${adm2.reason}`);
      break;
    }

    const taskId = task.id;
    const brief = `${task.title}${task.description ? '\n\n' + task.description : ''}`;
    const routing = resolveTaskRouting(task);
    const effectiveAgentName = routing.agent;
    const rerouted = effectiveAgentName !== task.agent_name;

    try {
      let taskExtraSkills: string[] = [];
      let taskExtraAllowed: string[] = [];
      try { if (task.extra_skills) taskExtraSkills = JSON.parse(task.extra_skills); } catch { /* */ }
      try { if (task.extra_allowed_tools) taskExtraAllowed = JSON.parse(task.extra_allowed_tools); } catch { /* */ }
      // The card a rerouted task raises would read as the named agent's own rule failing.
      if (rerouted) {
        const allowedOf = (name: string): string[] => { try { return loadConfig(name).allowed_tools ?? []; } catch { return []; } };
        reportReroutedShellPreallow({
          taskId, named: task.agent_name, routed: effectiveAgentName, why: describeRouting(task.agent_name, routing),
          namedAllowed: allowedOf(task.agent_name), routedAllowed: [...allowedOf(effectiveAgentName), ...taskExtraAllowed],
        });
      }
      // Before the worktree is created: a refusal after it would leave the
      // worktree and its branch behind.
      if (blockIfExtrasWiden(task, effectiveAgentName)) continue;

      const spec = resolveRoleSpec(task);
      const { permissionMode, roleMcpServers } = spec;
      // Quota exhausted on the planned backend: we redirect AT SPAWN
      // rather than launching a mission that will die from the usage
      // limit. The redirect isn't persisted on the task — the cooldown
      // expires, and a task that kept the fallback carved in stone would
      // stay on it well after the quota returns.
      const redirect = await redirectTaskSpawn(
        spec.backend ?? loadConfig(effectiveAgentName).backend,
        // The scope is the task's TYPE: a long project may want its
        // coder to fall back to another big model while its reviews
        // settle for a small one.
        {
          seriesId: task.series_id,
          scope: task.type,
          planGroup: task.plan_group,
          fromModel: spec.model ?? loadConfig(effectiveAgentName).model ?? null,
          ownerUserId: task.owner_user_id ?? null,
        },
        // Fallback set explicitly on THIS task at creation — takes
        // priority over the series rule and the global setting (cf.
        // fallbackFor).
        { backend: task.fallback_backend_override, model: task.fallback_model_override },
      );
      // Frozen on the mission with the running agent's own pair when nothing
      // above it decided: the board reads what ran from there (#1109).
      const { backend, model } = frozenTaskLlm(
        { backend: redirect?.backend ?? spec.backend, model: redirect ? redirect.model : spec.model },
        loadConfig(effectiveAgentName),
      );
      if (redirect) {
        console.warn(
          `[dispatcher] task ${taskId} redirected to ${redirect.backend} ` +
          `(planned backend ${cooldownReason(spec.backend ?? loadConfig(effectiveAgentName).backend)})`,
        );
      }
      // Checked on the FINAL backend (a quota fallback may land on one that
      // cannot) and BEFORE `resolveWorktree`, which creates the worktree and
      // its branch: a refusal after it would leave both behind.
      const attachments = taskAttachmentsWithInherited(task);
      if (blockIfBackendCannot(task, backend ?? loadConfig(effectiveAgentName).backend ?? defaultBackendName(), attachments.length)) {
        continue;
      }
      // Same moment, same reason: without git, `resolveWorktree` finds no
      // repository and the mission would start in the shared checkout.
      if (blockIfGitMissing(task)) continue;
      // The base a code or merge task starts from must exist before its
      // worktree does: an integration branch is created from the remote here,
      // fail closed, and a missing base is a refusal, not the shared checkout.
      if (await blockIfBaseUnavailable(task)) continue;

      // Worktree handling: before the spawn, for code/review/merge
      // types, we resolve the worktree to use. If the agent runs in a
      // worktree, we also inject the timon-worktree skill so it knows
      // where it is and how to commit/cleanup properly.
      const wt = await resolveWorktree(task);
      // A git task the dispatcher could not give a worktree would start in the
      // agent's own folder: the shared checkout every other agent writes to.
      if (await blockIfSharedCheckout(task, wt, effectiveAgentName)) continue;
      // Only the tasks that move a base read it: a detached HEAD reads as null.
      const activeBranch = wt && (task.type === 'merge' || (task.type === 'code' && task.pipeline === 'code-self'))
        ? await currentBranch(wt.sourceRepo)
        : null;
      const baseSkills = ['timon-task', ...taskExtraSkills];
      if (wt) baseSkills.push('timon-worktree');

      // Night guard: a `code` task scheduled 10pm–8am in a mode that
      // routes prompts to the human UI card (default/acceptEdits/plan)
      // will block with no answer (the user is asleep). `auto` (classifier
      // answers) and `bypassPermissions` (no prompt) are safe. We log a
      // visible warning — no block, just a signal of bad role config.
      if (
        task.type === 'code' &&
        task.scheduled_at != null &&
        isNightSchedule(task.scheduled_at) &&
        permissionMode !== 'bypassPermissions' &&
        permissionMode !== 'auto'
      ) {
        console.warn(
          `[dispatcher] WARN task ${taskId} (code, scheduled night) launching with permission_mode=${permissionMode ?? 'agent default'} — risk of blocking on an unanswered prompt (prefer 'auto')`,
        );
      }

      const mcpServersOverride = taskMcpServers(roleMcpServers, task);

      const prompt = composeTaskPrompt(
        taskId,
        brief,
        attachments,
        pipelineDirective(task, wt ? { sourceRepo: wt.sourceRepo, activeBranch } : undefined) +
          worktreeDirective(task, wt, activeBranch),
      );
      const missionId = await spawnAgent(
        effectiveAgentName,
        prompt.text,
        // Kept with the mission so a mismatch reads back from the database
        // (`json_extract(source_meta, '$.routing')`), not only from the log.
        { channel: 'dispatcher', meta: {
          task_id: taskId,
          ...(rerouted ? { routed_from: task.agent_name, routing: routing.source, routing_reason: routing.refusal ?? null } : {}),
        } },
        {
          origin: { kind: 'dispatcher', from: 'orchestrator', presentation: prompt.presentation },
          extraSkills: [...new Set(baseSkills)],
          mcpServersOverride,
          extraAllowedTools: (() => {
            // Union: business pre-authorizations for the type + explicit
            // extras from the task. Pre-authorizing core business ops
            // removes the Allow/Deny cards that block autonomous flows
            // (cf. TYPE_ALLOWED_TOOLS).
            const merged = [...new Set([
              ...(TYPE_ALLOWED_TOOLS[task.type] ?? []),
              ...CLOSURE_ALLOWED_TOOLS,
              ...taskExtraAllowed,
            ])];
            return merged.length ? merged : undefined;
          })(),
          cwdOverride: wt?.path,
          backendOverride: backend,
          modelOverride: model,
          permissionModeOverride: permissionMode,
          explicitResume: null,
          ownerUserId: task.owner_user_id ?? null,
          // The task names its mission (`preset`): the list reads the title
          // without the join, and no one-shot is ever asked for it.
          title: task.title,
        },
      );
      dbApi.assignTaskMission(taskId, missionId);
      // Sets task_id + parent_agent + parent_mission_id on the mission
      // for the lineage graph. Both come from the mission that created the
      // task (creator_mission_id, set at kanban_add) — the one the
      // orchestrator's wake-up will resume with the project's context. The
      // project's orchestrator is only a fallback for tasks with no creator
      // (see taskOrchestrator).
      const lineage = taskOrchestrator(task);
      dbApi.setMissionLineage(missionId, {
        parentMissionId: lineage.missionId,
        parentAgent: lineage.agent,
        taskId,
      });
      // The backend is part of the tag: since a model can be served by
      // several backends, `model=deepseek-v4-flash` alone doesn't say WHO
      // served it — and that's exactly what we want to check when
      // routing its review to a cheap provider.
      const overrideTag = backend || model || permissionMode
        ? ` [backend=${backend ?? 'agent'} model=${model ?? 'agent'} perm=${permissionMode ?? 'agent'}]`
        : '';
      const resolvedTag = rerouted ? ` (resolved from ${task.agent_name}: ${describeRouting(task.agent_name, routing)})` : '';
      console.log(`[dispatcher] task ${taskId} → mission ${missionId} (${effectiveAgentName}${resolvedTag})${wt ? ' [worktree]' : ''}${overrideTag}`);
      if (task.type === 'merge') mergingRepos.add(mergeLockKey(task));
      spawnFailures.delete(taskId);
      spawned++;
    } catch (err) {
      const msg = (err as Error).message;
      // Refused before spawn: nothing failed, and no spawn would do better until
      // the backend reopens. Counted below, three refusals made a `crash` that ate
      // the task's requeue budget and ended in a block nothing lifts (TIM-0134).
      if (err instanceof BackendExhaustedError) {
        spawnFailures.delete(taskId);
        blockOnRefusedSpawn(task, err.backend);
        continue;
      }
      // The agent's folder is gone (TIM-0148): every replay and every backend would
      // meet the same missing folder. A plain block that names it, for a person to
      // restore the folder or move the agent: no requeue budget, no fallback.
      if (err instanceof CwdUnusableError) {
        spawnFailures.delete(taskId);
        blockOnUnusableCwd(task, err);
        continue;
      }
      // The fence refuses a path the CLI is told to use: no replay and no backend does
      // better until Timon or the setting changes. A plain block that names the path.
      if (err instanceof MissionFenceBlockedError) {
        spawnFailures.delete(taskId);
        blockOnFenceRefusal(task, err);
        continue;
      }
      // `enforce` without a fence refuses every launch the same way until
      // someone changes the machine or the setting: retrying is noise.
      const fails = err instanceof MissionFenceRefusedError ? MAX_SPAWN_FAILURES : (spawnFailures.get(taskId) ?? 0) + 1;
      spawnFailures.set(taskId, fails);
      console.error(`[dispatcher] failed to spawn task ${taskId} (${fails}/${MAX_SPAWN_FAILURES}):`, msg);
      if (fails >= MAX_SPAWN_FAILURES) {
        spawnFailures.delete(taskId);
        // BLOCKED emits task_blocked → the recovery loop takes over
        // (diagnosis then escalation if unsolvable). We stop the spam.
        // `crash`: the mission never started, this is a system failure
        // and not an agent decision — same family as in-flight deaths.
        // Through the same requeue budget as a death in flight: notified once,
        // at the cap, instead of once every three failed ticks (TIM-0065).
        const outcome = dbApi.setTaskInterrupted(
          taskId,
          'crash',
          `Spawn failed (${MAX_SPAWN_FAILURES}×): ${msg}. The mission never started — this is not a business block.`,
          null,
          daemonMessage('task_spawn_failed', { attempts: MAX_SPAWN_FAILURES, error: msg, exhausted: 0, taskId: '' }),
        );
        reportInterruptionOutcome(task, 'crash', outcome, `spawn failed: ${msg}`);
      }
    }
  }
}

/** The block a launch refused for its working directory leads to. No
 *  `interrupted_reason`: that column says the system failed and drives the
 *  automatic replays; this one waits for a person. */
export function blockOnUnusableCwd(task: TaskRow, err: CwdUnusableError): void {
  const reason = `${err.message[0]!.toUpperCase()}${err.message.slice(1)}. The mission was not started: `
    + `restore this folder, or change the working directory of the agent or its project, then retry the task.`;
  console.warn(`[dispatcher] task ${task.id} → BLOCKED: ${reason}`);
  dbApi.updateTaskStatus(task.id, 'BLOCKED', {
    blockedReason: reason,
    blockedReasonCode: daemonMessage('task_cwd_unusable', {
      // snake_case: an ICU select key cannot hold a hyphen.
      cause: err.error.replaceAll('-', '_'),
      path: err.path,
      errno: err.code,
    }),
  });
}

/** The block a launch the fence refused leads to (`fencePreflight`): like a missing
 *  working directory, it waits for a person, never for an automatic replay. */
export function blockOnFenceRefusal(task: TaskRow, err: MissionFenceBlockedError): void {
  const { refusal } = err;
  console.warn(`[dispatcher] task ${task.id} → BLOCKED: ${err.message}`);
  dbApi.updateTaskStatus(task.id, 'BLOCKED', {
    blockedReason: `${err.message} Then retry the task.`,
    blockedReasonCode: daemonMessage('task_fence_refused', {
      access: refusal.access,
      path: refusal.display,
      mechanism: fenceMechanismName(refusal.mechanism),
      // ICU select keys: `timon_home` is a defect of Timon, `grantable` an exception to add.
      kind: refusal.timonHome ? 'timon_home' : refusal.grantable ? 'grantable' : 'protected',
    }),
  });
}

/** The block a spawn refused by the quota guard leads to. Leaves the same way as a
 *  mission that died of it: `requeueBackendBlockedTasks`, or the series moving. */
function blockOnRefusedSpawn(task: TaskRow, backend: string): void {
  const reason = interruptionForCooldown(backend);
  const exact = reason === 'rate_limit' ? exactQuotaReopening(backend) : null;
  const detail = exact ? { rateLimitType: exact.window, resetsAt: exact.until } : undefined;
  const outcome = dbApi.setTaskInterrupted(
    task.id,
    reason,
    `${describeInterruption(reason, Date.now(), detail)} The turn was refused before spawn.`,
    exact?.until ?? null,
    interruptionMessage(reason, Date.now(), detail, { context: 'spawn_refused' }),
  );
  reportInterruptionOutcome(task, reason, outcome, `spawn refused on ${backend}`);
  if (task.series_id) {
    void switchSeriesToFallback(task.series_id, {
      pilotMissionId: task.creator_mission_id,
      reason: fallbackTrigger(task.title, reason),
    }).catch((err) =>
      console.error(`[dispatcher] series fallback switch failed: ${(err as Error).message}`),
    );
  }
}

/**
 * Logs the outcome of a system death, and calls the user once automatic
 * retries are exhausted: at that point the task won't restart on its
 * own, and no one would know — one more BLOCKED on the board reads like
 * an ordinary business block.
 */
/**
 * A requeued task whose model was at capacity leaves on its fallback plan, now.
 *
 * Same cascade as a dry backend (`fallbackFor`: the task's own fallback, the
 * series rule, the equivalence matrix, the global setting) but applied to THIS
 * task only, and persisted on it: nothing here says when the model frees up, so
 * a redirect that lasted one spawn would send the next requeue back into it.
 * No backend cooldown and no series switchover either — one model is full, the
 * account and its other models are fine.
 *
 * With no workable fallback the task keeps its backend and the requeue backoff
 * already scheduled by `setTaskInterrupted`: the model may free up meanwhile.
 */
function moveOverloadedTask(task: TaskRow): void {
  const config = loadConfig(resolveEffectiveAgentName(task));
  const spec = resolveRoleSpec(task);
  const from = spec.backend ?? config.backend;
  const target = fallbackFor(
    from,
    { seriesId: task.series_id, scope: task.type, planGroup: task.plan_group, fromModel: spec.model ?? config.model ?? null, ownerUserId: task.owner_user_id ?? null },
    { backend: task.fallback_backend_override, model: task.fallback_model_override },
  );
  if (!target) {
    console.warn(`[dispatcher] task ${task.id}: ${from} model at capacity, no fallback — replayed later`);
    return;
  }
  if (dbApi.setTaskLlm(task.id, target.backend, target.model)) {
    console.warn(
      `[dispatcher] task ${task.id}: ${from} model at capacity — moved to ` +
      `${target.backend}${target.model ? `/${target.model}` : ''}, replayed now`,
    );
  }
}

function reportInterruptionOutcome(
  task: TaskRow,
  reason: InterruptionReason,
  outcome: TaskInterruptionOutcome,
  context: string,
): void {
  if (outcome === 'noop') return;
  if (outcome === 'requeued') {
    const attempt = (task.requeue_count ?? 0) + 1;
    console.warn(
      `[dispatcher] task ${task.id} → PENDING [${reason}] (${context}, retry ` +
      `${attempt}/${MAX_SYSTEM_REQUEUES} in ${Math.round(requeueBackoffMs(attempt) / 1000)} s)`,
    );
    return;
  }
  console.warn(`[dispatcher] task ${task.id} → BLOCKED [${reason}] (${context})`);
  if (outcome !== 'escalated') return;
  // Re-read: the row passed in predates the death just recorded, and the
  // reason now carries the backend's own last error.
  const after = dbApi.getTask(task.id);
  const deaths = after?.requeue_count ?? MAX_SYSTEM_REQUEUES + 1;
  notifyUser(
    `Task keeps failing (${deaths} system deaths): ${task.title}`,
    `Task \`${task.id}\` was interrupted by a system death (${reason}) after ` +
      `${MAX_SYSTEM_REQUEUES} automatic requeues. It stays BLOCKED: ` +
      `retrying once more would give the same result.` +
      (after?.blocked_reason ? `\n\n${after.blocked_reason}` : ''),
    {
      taskId: task.id,
      // The stored reason stays in English here: its own code lives on the task.
      message: daemonMessage('task_system_deaths', {
        deaths, title: task.title, taskId: task.id, reason, requeues: MAX_SYSTEM_REQUEUES,
        detail: after?.blocked_reason || 'none',
      }),
    },
  );
}

/** Longest backend error carried into a blocked reason. */
const LAST_ERROR_MAX = 600;

function clip(text: string): string {
  return text.length > LAST_ERROR_MAX ? `…${text.slice(-LAST_ERROR_MAX)}` : text;
}

/**
 * What the backend itself said before the mission died: its `backend_failed` /
 * `spawn_failed` notice, or the error-coded message a CLI writes when it cannot
 * authenticate (that death skips `backend_failed`, cf. `agent.ts`). Payloads are
 * excerpted and redacted when written (`stderrExcerpt`, `insertEvent`), never
 * the raw stderr. Without it a crash loop only ever showed "crash", and the
 * cause sat in a mission nobody opened (TIM-0065).
 */
export function lastMissionError(missionId: string): string | null {
  const events = dbApi.listEventsTail(missionId, 50);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type !== 'backend_failed' && ev.type !== 'spawn_failed' && ev.type !== 'fence_refused'
      && ev.type !== 'fence_suspected' && ev.type !== 'assistant') continue;
    let p: {
      binary?: unknown; cause?: unknown; cwd?: unknown; exitCode?: unknown; stderr?: unknown; error?: unknown;
      message?: { content?: unknown }; access?: unknown; display?: unknown; mechanism?: unknown; said?: unknown;
    };
    try { p = JSON.parse(ev.payload) as typeof p; } catch { continue; }
    // Recorded after the CLI's own words when both exist: the cause, rather than its symptom.
    if (ev.type === 'fence_refused') {
      const verb = p.access === 'write' ? 'write to' : 'read';
      return `the mission fence (${fenceMechanismName(String(p.mechanism ?? '?'))}) did not let it ${verb} ${String(p.display ?? '?')}; see Settings › System › Security.`;
    }
    // No path to name: the CLI's words, and the fence as the likely cause.
    if (ev.type === 'fence_suspected') {
      return `the backend stopped on "${clip(String(p.said ?? '?'))}" without naming a path; the mission fence (${fenceMechanismName(String(p.mechanism ?? '?'))}) may have refused it, see Settings › System › Security.`;
    }
    if (ev.type === 'assistant') {
      // Only the CLI's own error-coded message, never what the model wrote.
      if (typeof p.error !== 'string') continue;
      const parts = Array.isArray(p.message?.content) ? p.message.content as Array<{ text?: unknown }> : [];
      const text = parts.map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ').trim();
      return text ? `the backend reported ${p.error}: ${clip(text)}` : `the backend reported ${p.error}.`;
    }
    if (ev.type === 'spawn_failed' && typeof p.cwd === 'string') return `the working directory ${p.cwd} could not be used (${String(p.cause ?? 'unknown')}).`;
    if (ev.type === 'spawn_failed') return `the ${String(p.binary ?? 'backend')} CLI could not start (${String(p.cause ?? 'unknown')}).`;
    const stderr = typeof p.stderr === 'string' ? p.stderr.trim() : '';
    const code = p.exitCode === null || p.exitCode === undefined ? 'none' : String(p.exitCode);
    if (!stderr) return `the backend exited (code ${code}) without any error output.`;
    return `the backend exited (code ${code}): ${clip(stderr)}`;
  }
  return null;
}

/** `describeInterruption`, followed by the backend's last error when it left one. */
function interruptionText(missionId: string, reason: InterruptionReason, detail?: Parameters<typeof describeInterruption>[2]): string {
  const base = describeInterruption(reason, Date.now(), detail);
  const last = lastMissionError(missionId);
  return last ? `${base} Last error: ${last}` : base;
}

/** The code of `interruptionText`, plus the sentence a caller adds after it. */
function interruptionCode(
  missionId: string,
  reason: InterruptionReason,
  detail?: InterruptionDetail,
  context?: 'boot_orphan',
): DaemonMessage {
  return interruptionMessage(reason, Date.now(), detail, { context, lastError: lastMissionError(missionId) });
}

type QualifiedDeath = {
  reason: InterruptionReason;
  detail?: InterruptionDetail;
  /** Reopening the provider announced, still ahead. */
  quotaResetsAt: number | null;
};

/** The exact reopening the registry holds for a quota window on `backend`. */
function exactQuotaReopening(backend: string | null | undefined, now = Date.now()): { until: number; window: string | null } | null {
  const row = backend ? dbApi.getBackendCooldown(backend) : undefined;
  if (row?.kind !== 'rate_limit' || row.until <= now || row.exact !== 1) return null;
  return { until: row.until, window: row.quota_window };
}

/**
 * What a dead task mission means for its task, on the two paths that notice it
 * (`watchMissionComplete`, `reconcileOrphanedTasks`).
 *
 * A quota wall can reach us as `killed`, `timeout` or `crash` (TIM-0134): the
 * reaper finalises a stuck mission with no idea what the stream said. Those
 * causes replay the task after 2 min and count against its budget, so the retries
 * fell before the reopening. They become `rate_limit` when the mission's stream
 * says so, or when its backend is sidelined by a quota window right now: a replay
 * could only be refused at spawn, or fall on the same limit.
 *
 * The exclusion alone proves nothing about THIS death (TODO #724): a real crash
 * reads the same, and a spawn can still start during an exclusion when the usage
 * probe has no answer (`backendStillDry`), so a crash loop would never spend its
 * budget. Nothing separates the two, so such a reading is only granted
 * `MAX_BLIND_QUOTA_DEATHS` times per task. A wall in the mission's own stream is
 * an observation and stays free.
 */
function qualifyMissionDeath(
  task: Pick<TaskRow, 'id' | 'agent_name' | 'blind_quota_deaths'>,
  missionId: string,
  guessed: InterruptionReason,
): QualifiedDeath {
  const signal = dbApi.detectMissionDeathSignal(missionId);
  const quota = signal?.reason === 'rate_limit' ? signal : undefined;
  let backend: string | null | undefined;
  try {
    backend = dbApi.getMission(missionId)?.backend_override ?? loadConfig(task.agent_name).backend;
  } catch {
    backend = null;
  }
  // A queued request recorded nothing, rightly, while its turn could still
  // succeed. Now that it cannot, the rest of Timon has to know, or the next
  // mission walks into the same limit.
  if (quota?.pending) {
    noteBackendRateLimit(backend, {
      kind: 'rate_limit', window: quota.rateLimitType, resetsAt: quota.resetsAt, source: 'event', pending: false,
    });
  }
  const row = backend ? dbApi.getBackendCooldown(backend) : undefined;
  const sidelined = row?.kind === 'rate_limit' && row.until > Date.now();
  const requalifiable = sidelined && (guessed === 'killed' || guessed === 'timeout' || guessed === 'crash');
  if (requalifiable && !quota) {
    if ((task.blind_quota_deaths ?? 0) >= MAX_BLIND_QUOTA_DEATHS) {
      console.warn(
        `[dispatcher] task ${task.id}: ${backend} is sidelined, but ${MAX_BLIND_QUOTA_DEATHS} deaths were already `
        + `read that way with no quota signal: this one stays [${guessed}] and counts`,
      );
      return { reason: guessed, detail: undefined, quotaResetsAt: null };
    }
    dbApi.countBlindQuotaDeath(task.id);
  }
  const reason = requalifiable ? 'rate_limit' : guessed;
  if (reason !== 'rate_limit') return { reason, detail: undefined, quotaResetsAt: null };
  const announced = quota?.resetsAt && quota.resetsAt > Date.now() ? quota.resetsAt : null;
  const exact = exactQuotaReopening(backend);
  const quotaResetsAt = announced ?? exact?.until ?? null;
  return {
    reason,
    detail: { rateLimitType: quota?.rateLimitType ?? exact?.window ?? null, resetsAt: quotaResetsAt },
    quotaResetsAt,
  };
}

/** Why a series is being moved, said the same way whichever path noticed it
 *  (mission death seen live, or orphan reconciled at boot). Shared so the two
 *  cannot drift: the sentence lands in the notification the user reads. */
function fallbackTrigger(taskTitle: string, reason: InterruptionReason): string {
  const trigger = reason === 'rate_limit' ? 'interrupted by the usage limit'
    : reason === 'exhausted' ? 'interrupted: backend account has no credit left (402)'
      : 'interrupted: backend structurally unavailable (circuit breaker)';
  return `task "${taskTitle}" ${trigger}`;
}

/** What a task closed BY THE ORCHESTRATOR carries, when the agent closed
 *  nothing itself. Deliberately free of any verdict token: dropped on a
 *  `review` task it must parse as `unknown` (→ escalation), never as a
 *  fabricated approval. */
const AUTO_CLOSED_COMMENT =
  '[auto-closed by the orchestrator] The mission ended without the agent '
  + 'closing its task: no work return was reported. The status only reflects '
  + 'the mission exiting cleanly — nothing about what was actually done.';

/** Longest reply kept as the close comment of a task whose agent has no tool. */
const REPLY_AS_REPORT_MAX = 4000;

/**
 * What an automatic close carries. An agent on a backend without Timon's MCP
 * servers (`capabilities.timonMcp: false`) has no `kanban_mark_as_done`: its
 * last reply IS its report, and dropping it for the generic sentence would hand
 * the pilot a task closed with nothing to read.
 *
 * Not for `review` and `merge`: the verdict and the merged sha are read from
 * the comment, and a sentence the agent wrote in passing must never pass for
 * one.
 */
function autoCloseComment(task: { type?: string | null; agent_name: string }, missionId: string): string {
  if (task.type === 'review' || task.type === 'merge') return AUTO_CLOSED_COMMENT;
  try {
    const mission = dbApi.getMission(missionId);
    const backend = mission?.backend_override ?? loadConfig(task.agent_name).backend;
    if (backendCapabilities(backend).timonMcp) return AUTO_CLOSED_COMMENT;
  } catch {
    return AUTO_CLOSED_COMMENT;
  }
  const reply = dbApi.getMissionFinalText(missionId)?.trim();
  if (!reply) return AUTO_CLOSED_COMMENT;
  const body = reply.length > REPLY_AS_REPORT_MAX ? `${reply.slice(0, REPLY_AS_REPORT_MAX)}…` : reply;
  return `[closed from the agent's last reply: its backend has no Timon tools to close the task]\n\n${body}`;
}

/**
 * The DONE of a task whose mission ended without the agent closing it, unless
 * the checks every close route applies refuse it (TODO #1053): a `merge` must
 * prove its source branches in the base, a `full` code task already in its base
 * must still be reviewable, the task that opens a job's pull request must have
 * opened it. A refused close goes BLOCKED with the reason, so the chain never
 * starts on a merge that did not happen or a review of nothing.
 */
function autoCloseTask(task: TaskRow, missionId: string): 'DONE' | 'BLOCKED' {
  const refusal = pullRequestCloseRefusal(task)
    ?? mergeCloseRefusal(task, effectiveMergeSha(task, null, null)) ?? codeCloseRefusal(task);
  if (refusal) {
    dbApi.updateTaskStatus(task.id, 'BLOCKED', {
      blockedReason: `The mission ended without closing its task, and the automatic close was refused. ${refusal}`,
      blockedReasonCode: daemonMessage('task_auto_close_refused', { refusal }),
      // Kept as the agent left it: updateTaskStatus writes the column whole.
      doneComment: task.done_comment,
    });
    return 'BLOCKED';
  }
  dbApi.setTaskStatusOnly(task.id, 'DONE', autoCloseComment(task, missionId));
  return 'DONE';
}

/**
 * The idle reap of a task mission that had already finished (TIM-0149): its
 * last turn ended cleanly, every closure question reached it and it still left
 * its task open (`missions.closure_ignored`, set by the wake loop), then the
 * reaper killed the idle process. Nothing failed there: replaying the task
 * would only run the same work again (6 reviews for 4 requeues at a tester's).
 * The task is closed like a mission that exited cleanly — `AUTO_CLOSED_COMMENT`,
 * so a review parses as `unknown` and escalates — and `requeue_count` is left
 * alone. Any other cause (crash, OOM, a turn cut short, a reap with no clean
 * turn) stays a system death, and so does any other `killed`: a manual kill, a
 * scope stop, a plugin's `missions.kill` or a config reload stop the work
 * someone may still want, so only the mark the reaper confirms (2) counts.
 * The agent's prose is never read for a verdict.
 */
function endedAfterIgnoredClosure(missionId: string, reason: InterruptionReason | null | undefined): boolean {
  if (reason !== 'killed') return false;
  return dbApi.getMission(missionId)?.closure_ignored === 2;
}

/** Wire the mission_complete bus event → task status update. Exported so
 *  tests can wire the watcher without starting the dispatch loop. */
export function watchMissionComplete(): () => void {
  const onBusEvent = (ev: import('./bus.js').BusEvent) => {
    if (ev.kind !== 'mission_complete') return;
    const task = dbApi.getTaskByMission(ev.missionId);
    if (!task) return;
    // A qualified death cause overrides the mission's status: a mission
    // killed by quota exits with code 0 → `completed` (measured: 9 of the
    // 11 quota deaths on 2026-07-29/30). Without this check, we'd move
    // the task to DONE while the agent closed out nothing — the Kanban
    // would lie.
    const newStatus = ev.status === 'completed' && !ev.reason ? 'DONE' : 'BLOCKED';
    // NEVER regress a task already in a terminal status. When the agent
    // self-closes its task (DONE/BLOCKED) then we kill its idle process
    // (cf. PATCH task route), the SIGTERM exit publishes a
    // `mission_complete:failed` → newStatus=BLOCKED. Without this guard
    // it would overwrite a DONE with BLOCKED, and the verification-loop
    // (which checks status===DONE) would no longer see DONE → no review.
    // The status set by the agent is authoritative: we only transition
    // non-terminal tasks.
    if (task.status === 'DONE' || task.status === 'BLOCKED') return;
    // At this point, the mission died WITHOUT the agent closing its task.
    // If it died passively, we qualify the cause instead of posting a
    // silent BLOCKED (indistinguishable from a business block — incident
    // of 2026-07-30, cf. interruption.ts).
    if (newStatus === 'BLOCKED' && endedAfterIgnoredClosure(ev.missionId, ev.reason)) {
      const closed = autoCloseTask(task, ev.missionId);
      console.log(`[dispatcher] task ${task.id} → ${closed}: mission ${ev.missionId} reaped idle after ignoring its closure questions`);
      return;
    }
    if (newStatus === 'BLOCKED') {
      // `crash` by default: a failed/terminated mission_complete with no
      // qualified cause remains a system death, never an agent decision.
      // Detail re-read from the events (quota reopening time, affected
      // window): the same detection that qualified the mission, but the
      // bus only carries the cause. Deterministic — a finished mission's
      // events no longer move.
      const { reason, detail, quotaResetsAt } = qualifyMissionDeath(task, ev.missionId, ev.reason ?? 'crash');
      const outcome = dbApi.setTaskInterrupted(
        task.id,
        reason,
        interruptionText(ev.missionId, reason, detail),
        quotaResetsAt,
        interruptionCode(ev.missionId, reason, detail),
      );
      reportInterruptionOutcome(task, reason, outcome, `mission ${ev.missionId}`);
      if (reason === 'overloaded' && outcome === 'requeued') moveOverloadedTask(task);
      // Quota exhausted, or backend structurally unavailable (circuit
      // breaker): the task didn't fail, its backend shut down. It's the
      // WHOLE project that needs moving — orchestrator included,
      // otherwise the wake-up following this BLOCKED dies from the same
      // limit and the series stops there (incident of
      // 2026-08-20). The breaker joins that branch on 2026-09-01: the
      // trigger there is a SHAPE (N sterile turns), not a sentence, so a
      // provider whose vocabulary we do not know still moves the series.
      if (triggersBackendFallback(reason) && task.series_id) {
        void switchSeriesToFallback(task.series_id, {
          pilotMissionId: task.creator_mission_id,
          reason: fallbackTrigger(task.title, reason),
        }).catch((err) =>
          console.error(`[dispatcher] series fallback switch failed: ${(err as Error).message}`),
        );
      }
      return;
    }
    // Idempotent: if the agent already closed via `timon task
    // done/block` right before exiting, its done_comment/blocked_reason
    // are already in the DB. An updateTaskStatus with opts={} would null
    // out those fields (prepared statement clobbers). So we use
    // setTaskStatusOnly which touches ONLY status — plus, when the task
    // carries NO comment at all, a sentence qualifying this automatic
    // closure. Without it the pilot received a mute `task_closed`,
    // indistinguishable from an agent who simply had nothing to say.
    const closed = autoCloseTask(task, ev.missionId);
    console.log(`[dispatcher] task ${task.id} → ${closed} (mission ${ev.missionId})`);
  };
  bus.on('event', onBusEvent);
  return () => void bus.off('event', onBusEvent);
}

/**
 * Reconciles orphaned tasks at boot: an IN_PROGRESS task whose mission is
 * no longer alive (failed/completed) was never transitioned. Historical
 * cause: the zombie sweep (markZombiesAsFailed) published
 * mission_complete BEFORE listeners were registered → event lost → task
 * stuck IN_PROGRESS forever, blocking its dependents. We catch up here
 * after listeners are in place: `failed` → BLOCKED (emits task_blocked →
 * recovery), `completed` → DONE.
 *
 * A cause that says "the backend shut down" (`BACKEND_FALLBACK_REASONS`) also
 * switches its whole series over to its fallback plan, exactly as the live path
 * does — see the loop at the end of this function.
 *
 * Scheduled by `reconcile.ts`: a boot pass (zero grace — the history is
 * frozen, nothing is running) then periodic passes.
 *
 * @param graceMs Ignores missions finished less than `graceMs` ago. On a
 *   live system, a mission that just finished is being handled by the
 *   `mission_complete` listeners and by recovery: intervening in that
 *   window would steal the task from a legitimate resume and wrongly
 *   block it. Reconciliation must only rule on what's durably stuck.
 */
export async function reconcileOrphanedTasks(graceMs = 0): Promise<void> {
  let fixed = 0;
  const cutoff = Date.now() - graceMs;
  /** Series to move once the loop is over, and the cause that moved them.
   *  Deferred on purpose: `switchSeriesToFallback` only ever touches PENDING and
   *  BLOCKED tasks, so switching from inside the loop would leave the sibling
   *  tasks of the same series — still IN_PROGRESS at that instant, blocked a
   *  few iterations later — behind, on the backend we know to be dry. A Set
   *  keyed by series also means one switchover, hence one notification, for a
   *  series that lost ten tasks to the same outage. */
  const outages = new Map<string, { reason: string; pilotMissionId: string | null }>();
  for (const t of dbApi.listTasks()) {
    if (t.status !== 'IN_PROGRESS' || !t.mission_id) continue;
    const m = dbApi.getMission(t.mission_id);
    if (graceMs > 0 && (m?.ended_at ?? 0) > cutoff) continue;
    if (!m) continue;
    // A `completed` mission that carries a qualified death cause is a quota
    // death that exited 0 (`finishMission` persisted the cause): the live path
    // blocks it (`ev.reason`), so must this one — DONE would lie.
    const diedCompleted = m.status === 'completed'
      && (toInterruptionReason(m.interrupted_reason) ?? dbApi.detectMissionDeathSignal(t.mission_id)?.reason) != null;
    if (m.status === 'terminated' && !dbApi.detectMissionDeathSignal(t.mission_id)
      && endedAfterIgnoredClosure(t.mission_id, toInterruptionReason(m.interrupted_reason))) {
      // Same reading as the live path, for a reap whose event died with the daemon.
      const closed = autoCloseTask(t, t.mission_id);
      console.log(`[dispatcher] reconcile: task ${t.id} IN_PROGRESS→${closed} (mission ${t.mission_id.slice(0, 8)} reaped idle after ignoring its closure questions)`);
      fixed++;
    } else if (m.status === 'failed' || m.status === 'terminated' || diedCompleted) {
      // `failed` = a real problem; `terminated` = mission interrupted
      // (reaper / restart) BEFORE the agent closed its task. Either way
      // the task stayed IN_PROGRESS → we BLOCK it to resurface it
      // (otherwise it freezes and blocks its dependents). The status set
      // by the agent is authoritative: we only get here for tasks NEVER
      // closed out.
      // Cause re-read from the mission (set at its finalization or
      // observed before its death), `crash` by default — an orphan
      // caught at boot almost always comes from a brutal orchestrator
      // restart.
      // Events signal first (it may qualify a mission finalized before
      // this fix, whose column stayed NULL), persisted cause next,
      // `crash` by default.
      const signal = dbApi.detectMissionDeathSignal(t.mission_id);
      const { reason, detail, quotaResetsAt } = qualifyMissionDeath(
        t,
        t.mission_id,
        signal?.reason ?? toInterruptionReason(m.interrupted_reason) ?? 'crash',
      );
      const outcome = dbApi.setTaskInterrupted(
        t.id,
        reason,
        `${interruptionText(t.mission_id, reason, detail)} Orphan reconciled at boot: the mission finished without transitioning the task.`,
        quotaResetsAt,
        interruptionCode(t.mission_id, reason, detail, 'boot_orphan'),
      );
      reportInterruptionOutcome(t, reason, outcome, `reconcile, mission ${t.mission_id.slice(0, 8)} ${m.status}`);
      // Same conclusion as the live path (`watchMissionComplete`): the work did
      // not fail, its backend shut down, so the WHOLE series has to move. It
      // was missing here, and that is the incident of 2026-09-01 replayed
      // through another door — a series whose backend runs dry WHILE the daemon
      // is restarting never switched, because the only path that switched it
      // was the mission_complete event, and that event died with the process.
      if (triggersBackendFallback(reason) && t.series_id && !outages.has(t.series_id)) {
        outages.set(t.series_id, {
          reason: fallbackTrigger(t.title, reason),
          pilotMissionId: t.creator_mission_id,
        });
      }
      fixed++;
    } else if (m.status === 'completed') {
      // Same qualified sentence as the live path: without it the pilot got a
      // mute `task_closed` for every orphan caught at boot (TODO #522).
      const closed = autoCloseTask(t, t.mission_id);
      console.log(`[dispatcher] reconcile: task ${t.id} IN_PROGRESS→${closed} (mission ${t.mission_id.slice(0, 8)} completed)`);
      fixed++;
    }
  }
  if (fixed) console.log(`[dispatcher] reconcile: ${fixed} orphaned task(s) caught up`);

  // Sequentially, and each one guarded: a series whose switchover throws must
  // not swallow the ones behind it (`runRules` catches too high up to tell).
  for (const [seriesId, outage] of outages) {
    try {
      await switchSeriesToFallback(seriesId, {
        pilotMissionId: outage.pilotMissionId,
        reason: `${outage.reason} (orphan caught by reconciliation)`,
        // The pilot died with the daemon: repoint it, never respawn it here.
        respawnDeadPilot: false,
      });
    } catch (err) {
      console.error(
        `[dispatcher] reconcile: series fallback switch failed for ${seriesId.slice(0, 8)}: `
        + `${(err as Error).message}`,
      );
    }
  }
}

/**
 * Detection of historical cases from the 2026-05-25 incident:
 * `type='merge'` tasks marked DONE with no `merged_commit_sha` (branch
 * never integrated, fix never shipped while the Kanban shows "done"). The
 * merge guard now prevents creating new ones; this check logs and
 * notifies the user of already-existing cases in the DB so he can replay them.
 * Read-only: mutates no status (these tasks have been closed for a long
 * time, their dependents have moved on — an automatic downgrade would do
 * more harm than good). Call once at boot.
 */
export function auditMergedTasksWithoutSha(): void {
  const offenders = dbApi
    .listTasks()
    .filter(
      (t) =>
        t.status === 'DONE' &&
        !t.merged_commit_sha &&
        // `code` tasks in code-self integrate their own branch: with no
        // sha, they hang exactly like a merge task with no sha.
        (t.type === 'merge' || (t.type === 'code' && isSelfMergePipeline(t.pipeline))),
    );
  if (offenders.length === 0) return;
  const list = offenders
    .map((t) => `  - ${t.id} "${t.title}"`)
    .join('\n');
  console.warn(
    `[dispatcher] merge audit: ${offenders.length} merge/code-self task(s) DONE with no merged_commit_sha (branch probably never integrated):\n${list}`,
  );
  notifyUser(
    `${offenders.length} merge task(s) DONE with no merge sha`,
    `Some merge-type tasks are marked DONE but have no merged_commit_sha — ` +
      `their branch was probably never integrated onto the base (2026-05-25 incident).\n\n` +
      `${list}\n\nCheck whether the changes actually shipped; otherwise replay the merge.`,
    { message: daemonMessage('merge_audit_missing_sha', { count: offenders.length, list }) },
  );
}

/** Requeues already done per task by `requeueBackendBlockedTasks`, in this
 *  daemon run (cf. its backoff). */
const backendRequeues = new Map<string, number>();

/** Why each task is still waiting, as last logged: this runs at every tick, and
 *  the line is what tells a stopped series from a forgotten one in a daemon log. */
const backendWaitsLogged = new Map<string, string>();

function logBackendWait(taskId: string, why: string): void {
  if (backendWaitsLogged.get(taskId) === why) return;
  backendWaitsLogged.set(taskId, why);
  console.warn(`[dispatcher] task ${taskId} kept BLOCKED ${why}`);
}

/** Test-only. */
export function resetBackendRequeues(): void {
  backendRequeues.clear();
  backendWaitsLogged.clear();
}

/**
 * Requeues the tasks that ONLY their backend stopped (usage limit, account with
 * no credit, circuit breaker) as soon as they can leave again: the backend they
 * would launch on reopened, or it is still sidelined but has a workable
 * fallback. Run at every dispatcher tick.
 *
 * WHY (TODO #520). The series switchover was the only path that requeued them
 * (`requeueRateLimitedTasks`). A task outside any series, or whose scope has no
 * fallback, stayed BLOCKED long after the quota had reopened — until a human saw
 * it in the morning. The usage sweep lifted the exclusion and moved nothing.
 *
 * The backend judged is the one the NEXT spawn would use, resolved like
 * `dispatch()` does, not the one the dead mission ran on: a task repointed since
 * (by hand, by a series role) leaves on its new backend.
 *
 * The backoff covers the one case where a reopened backend proves nothing: a
 * limit that stopped the turn without leaving an exclusion behind (a queued
 * request whose CLI then exited). Every re-block wakes the pilot, so an
 * unbounded loop would cost a turn per tick. The wait counts from the block
 * (`updated_at`), so a quota that reopens hours later leaves at once.
 *
 * A reopening the provider announced (TIM-0134, `quota_resets_at`) overrides that
 * backoff: past it plus the margin the task leaves whoever is awake, pilot
 * included, and whatever estimate another mission recorded meanwhile. Before it,
 * an exclusion lifted early (usage probe, a turn that succeeded elsewhere) still
 * earns one try, because observation beats the announced time; a task that already
 * got a try and hit a limit again waits for the announced time.
 */
export function requeueBackendBlockedTasks(now = Date.now()): number {
  let requeued = 0;
  for (const task of dbApi.listTasks('BLOCKED')) {
    const reason = toInterruptionReason(task.interrupted_reason);
    if (!reason || !triggersBackendFallback(reason) || isMirrorTask(task)) continue;
    const attempts = backendRequeues.get(task.id) ?? 0;
    const reopensAt = task.quota_resets_at ?? null;
    const reopened = reopensAt !== null && now >= reopensAt + QUOTA_REOPEN_MARGIN_MS;
    if (!reopened && now - task.updated_at < requeueBackoffMs(attempts + 1)) continue;
    let route: ReturnType<typeof backendResumeRoute>;
    try {
      const agent = resolveTaskRouting(task).agent;
      const spec = resolveRoleSpec(task);
      const cfg = loadConfig(agent);
      route = backendResumeRoute(
        spec.backend ?? cfg.backend ?? defaultBackendName(),
        {
          seriesId: task.series_id,
          scope: task.type,
          planGroup: task.plan_group,
          fromModel: spec.model ?? cfg.model ?? null,
          ownerUserId: task.owner_user_id ?? null,
        },
        { backend: task.fallback_backend_override, model: task.fallback_model_override },
        reopened ? reopensAt : null,
      );
    } catch (err) {
      // A backend that is no longer there (uninstalled, refused) is a block the
      // dispatcher would raise again at spawn: the task waits for a human.
      console.warn(`[dispatcher] task ${task.id} kept BLOCKED [${reason}]: ${(err as Error).message}`);
      continue;
    }
    if (!route) {
      logBackendWait(task.id, `[${reason}]: its backend is still sidelined and no fallback can take it`);
      continue;
    }
    if (route === 'reopened' && reopensAt !== null && !reopened && (now >= reopensAt || attempts > 0)) {
      logBackendWait(task.id, `[${reason}]: waiting for the announced reopening (${messageTime(reopensAt)}) plus its margin`);
      continue;
    }
    if (!dbApi.requeueBackendBlockedTask(task.id)) continue;
    backendWaitsLogged.delete(task.id);
    backendRequeues.set(task.id, attempts + 1);
    requeued++;
    console.warn(
      `[dispatcher] task ${task.id} → PENDING [${reason}]: ` +
      (route === 'reopened' ? 'its backend is available again' : 'its backend is still sidelined, it leaves on its fallback'),
    );
  }
  for (const id of backendRequeues.keys()) {
    const status = dbApi.getTask(id)?.status;
    if (!status || status === 'DONE') backendRequeues.delete(id);
  }
  for (const id of backendWaitsLogged.keys()) {
    if (dbApi.getTask(id)?.status !== 'BLOCKED') backendWaitsLogged.delete(id);
  }
  return requeued;
}

export function startDispatcher(intervalMs = DEFAULT_INTERVAL_MS): () => void {
  const unwatch = watchMissionComplete();
  // Run once immediately at startup, then on interval — once the providers shipped as plugins are registered: a
  // pass that found `codex` unknown would send its tasks to another backend without a word.
  let stopped = false;
  void whenProvidersLoaded().then(() => {
    if (!stopped) dispatch().catch((err) => console.error('[dispatcher] initial dispatch error:', err));
  });
  const timer = setInterval(() => {
    void whenProvidersLoaded().then(() => {
      if (!stopped) dispatch().catch((err) => console.error('[dispatcher] dispatch error:', err));
    });
  }, intervalMs);
  console.log(`[dispatcher] started (interval=${intervalMs}ms, max_parallel=${MAX_PARALLEL()})`);
  return () => { stopped = true; unwatch(); clearInterval(timer); };
}
