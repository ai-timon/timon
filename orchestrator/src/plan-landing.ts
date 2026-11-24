/**
 * How the job a series plan (`kanban_plan`) launches will land, read from the
 * project the job is for (`docs/KANBAN-PR-PIPELINE.md` §2.2, step 8 of §8):
 * the planning mission's own, else its agent's, else the registered project
 * whose folder holds the mission's or the agent's working directory
 * (`planProject`).
 *
 * A project set to land through pull requests gets one integration branch per
 * job, named after the job's title or the name the agent proposed (and the
 * person answering the planner may change): the plan's commands give it to
 * every task (`--base`, and `--project` when the planning agent is not in that
 * project) and end with the task that opens the pull request. A sequential job
 * has its pilot ask the daemon for the branch (`series-integration.ts`) and
 * code in a worktree on it.
 *
 * The person answering may also pick a branch the repository already has, and
 * keep the work on the branch instead of merging it (`finish: 'keep'`). In a
 * project that merges locally, a branch chosen in the planner puts the job in
 * the `branch` integration mode: the branch is cut from the project's local
 * target, the job's ideas wait in `partial`, and the last task merges the
 * branch into that target on this machine (`--landing local`), or nothing does.
 * What was chosen is recorded for the series (`series_landing`): the
 * dispatcher and `timon pr branch` read it. Without a choice, a project that
 * merges locally gets null: the plan stays what it was.
 */
import { loadConfig } from './agent-config.js';
import { registeredProjects } from './browser-project.js';
import { dbApi } from './db.js';
import { integrationBranchName, integrationBranchRefusal, localBaseRef } from './git-integration.js';
import { integrationBaseRef, readProjectIntegration, type ProjectIntegration } from './project-integration.js';
import { listRepoBranches, repoBranchExists, type RepoBranch } from './repo-branches.js';
import { planBranchChoice, type SeriesPlanAnswer, type SeriesPlanLanding } from './series-plan.js';
import { projectFromCwd, projectFromRegisteredCwd, taskProjectSlug, type RegisteredProject } from './task-project.js';

export type PlanBranchKind = 'new' | 'existing';
export type PlanFinish = 'merge' | 'keep';

export type PlanLanding = SeriesPlanLanding & {
  /** What a new branch is cut from: `origin/main`, or `refs/heads/main` in a
   *  project that merges locally. */
  baseRef: string;
  /** What the orchestrator must know before it applies the plan. */
  note: string;
  /** The project whose setting decided, for the form's check route. */
  project: string;
  /** `feat/`: shown before the field, never asked again. */
  prefix: string;
  /** The job already has its integration branch: the name no longer changes. */
  locked: boolean;
  /** Why the proposed name cannot be used; `branch` then holds it as typed. */
  refusal?: string;
  /** The project's own setting. */
  projectMode: 'pr' | 'local';
  /** The tasks' `integration_mode`. */
  mode: 'pr' | 'branch';
  kind: PlanBranchKind;
  finish: PlanFinish;
  /** The branch the job ends up in: the pull request's target, or the local one. */
  target: string;
  /** The project's repository, when known. */
  repo: string | null;
  /** The answer named the kind of branch (`{ kind, name }`), not the earlier bare name. */
  explicit: boolean;
};

/** Beyond this, the title is too generic to name a job: the caller names it. */
const MAX_SUFFIX = 20;
/** A branch name the agent or the form proposes: a ref, not a paragraph. */
export const MAX_PLAN_BRANCH_CHARS = 200;

/**
 * The branch of a new job: the title's slug, with `-2`, `-3`… when Timon already
 * recorded that branch for an earlier job of the repository, so two jobs never
 * share one pull request. `taken` adds names held otherwise (a branch the
 * repository already has, for a person who asked for a new one).
 */
export function freeBranch(base: string, repo: string | null, taken: (name: string) => boolean = () => false): string | null {
  if (!repo) return base;
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (integrationBranchRefusal(name)) return null;
    if (!dbApi.getIntegration(repo, name) && !taken(name)) return name;
  }
  return null;
}

/**
 * The full name a proposal stands for: the project's prefix is written once,
 * so `topic` and `feat/topic` both mean `feat/topic`.
 */
export function planBranchName(proposed: string, prefix: string): string {
  const name = proposed.trim();
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

export type PlanBranchCheck =
  | { ok: true; branch: string }
  | { ok: false; branch: string; refusal: string };

export type PlanBranchCheckOptions = {
  /** `existing`: a branch the repository has, taken as named. Default `new`. */
  kind?: PlanBranchKind;
  /** A new branch also skips the names the repository already has (the
   *  answer named the kind); the earlier bare name only skipped recorded jobs. */
  strict?: boolean;
  /** The project merges locally: the job merges into `target`, no pull request. */
  local?: boolean;
};

/**
 * Whether `proposed` can name the branch of a new job, and the name it will
 * really get (`-2` when an earlier job holds a new one). The form's check route
 * and the plan's answer both go through here: the browser never decides alone.
 *
 * An existing branch is taken as named, never numbered: it must be in the
 * repository, be neither the target nor one of Timon's task branches, carry no
 * id, and not be the branch of a job that already landed or was closed.
 */
export function checkPlanBranch(
  proposed: string,
  setting: { target: string; remote: string; branch_prefix: string },
  repo: string | null,
  opts: PlanBranchCheckOptions = {},
): PlanBranchCheck {
  const raw = proposed.trim();
  const existing = opts.kind === 'existing';
  const branch = existing ? raw : planBranchName(raw, setting.branch_prefix);
  if (!raw || branch === setting.branch_prefix) {
    return { ok: false, branch, refusal: existing ? 'name the existing branch' : 'name the branch after the job\'s topic' };
  }
  // A task branch pasted as is would only be renamed under the prefix: say why
  // it cannot serve rather than accept a lookalike.
  if (raw.startsWith('timon/')) return { ok: false, branch: raw, refusal: integrationBranchRefusal(raw)! };
  if (branch.length > MAX_PLAN_BRANCH_CHARS) {
    return { ok: false, branch, refusal: `the name is longer than ${MAX_PLAN_BRANCH_CHARS} characters` };
  }
  const baseRef = integrationBaseRef(setting);
  if (branch === setting.target || branch === baseRef) {
    return {
      ok: false, branch,
      refusal: opts.local
        ? `the job merges into ${setting.target}: it needs a branch of its own`
        : `the pull request targets ${setting.target}: the job needs a branch of its own`,
    };
  }
  const refusal = integrationBranchRefusal(branch);
  if (refusal) return { ok: false, branch, refusal };
  if (existing) {
    const there = repo ? repoBranchExists(repo, branch) : null;
    if (there === null) return { ok: false, branch, refusal: 'the branches of the project\'s repository cannot be read' };
    if (!there) return { ok: false, branch, refusal: `${branch} does not exist in the repository` };
    const row = dbApi.getIntegration(repo!, branch);
    if (row?.state === 'merged') return { ok: false, branch, refusal: `${branch} already landed in ${row.target}: start a new branch` };
    if (row?.state === 'closed') return { ok: false, branch, refusal: `the pull request of ${branch} was closed: start a new branch` };
    return { ok: true, branch };
  }
  const taken = opts.strict && repo ? (name: string) => repoBranchExists(repo, name) === true : undefined;
  const free = freeBranch(branch, repo, taken);
  if (!free) {
    return { ok: false, branch, refusal: `${branch} and its numbered variants are already taken by earlier jobs` };
  }
  return { ok: true, branch: free };
}

/** The project's setting when it lands through pull requests, with its repository. */
export function prLandingSetting(slug: string, cwd?: string | null): {
  setting: ProjectIntegration; repo: string | null;
} | null {
  const found = landingSetting(slug, cwd);
  return found && found.setting.mode === 'pr' ? found : null;
}

/** The project's setting, whatever its mode, with its repository. Null when
 *  it cannot be read or no longer validates (refused at dispatch, with its
 *  reason, on the first task). */
export function landingSetting(slug: string, cwd?: string | null): {
  setting: ProjectIntegration; repo: string | null;
} | null {
  let read: ReturnType<typeof readProjectIntegration>;
  try { read = readProjectIntegration(slug); } catch { return null; }
  if (read.invalid) return null;
  return { setting: read.integration, repo: dbApi.getProjectRow(slug)?.cwd ?? cwd ?? null };
}

/**
 * The branch the series already works on in this project: once a task was
 * dispatched on it, every task of the job starts from it, so a plan opened
 * again reuses it instead of numbering a new one. Either the integration row
 * the dispatcher recorded for the series, or the branch the planner chose for
 * it, once one of its tasks started there (an existing branch keeps the row of
 * the job that cut it).
 */
function seriesBranch(seriesId: string | null | undefined, slug: string, repo: string | null): string | null {
  if (!seriesId) return null;
  const row = dbApi.listIntegrationsBySeries(seriesId)
    .find((r) => r.project === slug || (repo !== null && r.repo === repo));
  if (row) return row.branch;
  const planned = dbApi.getSeriesPlanLanding(seriesId);
  if (!planned || !(planned.project === slug || (repo !== null && planned.repo === repo))) return null;
  const started = dbApi.listTasksBySeries(seriesId)
    .some((t) => t.base_branch === planned.branch && t.integration_mode !== null && t.integration_mode !== undefined);
  return started ? planned.branch : null;
}

export type PlanLandingOptions = {
  /** The name the agent (`kanban_plan`) proposed, or the branch the answer chose. */
  branch?: SeriesPlanAnswer['branch'] | null;
  /** Where the job's branch ends up; `merge` by default. */
  finish?: PlanFinish;
  /** The job is coded in a mission (`sequential-*` modes): no task but the
   *  last one, and the pilot asks the daemon for the branch itself. */
  sequential?: boolean;
  /** The mission that opens the planner: the series of the job's tasks, and
   *  the first place the job's project is read from. */
  seriesId?: string | null;
  /** The form is being built: a project that merges locally gets its landing
   *  too, and the agent's proposal names a new branch whatever the project. */
  form?: boolean;
};

export type PlanProject = {
  /** The project the job is for. */
  slug: string;
  /** The working directory it was found from, the repository's fallback. */
  cwd: string | null;
  /** The planning agent's own project: the tasks need `--project` when it differs. */
  agentSlug: string | null;
};

const slugOrNull = (value: string | null | undefined): string | null => (value && value.trim()) || null;

/** The project the planning mission already works for: the task it runs, else the job its series started. */
function missionProject(missionId: string): string | null {
  const mission = dbApi.getMission(missionId);
  if (!mission) return null;
  const own = mission.task_id ? slugOrNull(dbApi.getTask(mission.task_id)?.project) : null;
  if (own) return own;
  const series = dbApi.listTasksBySeries(missionId);
  return slugOrNull(series.find((t) => slugOrNull(t.project))?.project);
}

/**
 * The project a plan is for, in order: the planning mission's own (the task it
 * runs, the job its series started), its own working directory when it has one
 * (`cwd_override`), the agent's (`config.project`, else the
 * `…/projects/<slug>` marker of its cwd), then the registered project whose
 * folder holds that cwd. The agent's declared project comes before the
 * registry so an agent of a project plans exactly as before, even when two
 * projects share one folder; the registry is what finds the project of an
 * agent that belongs to none but works in a project's folder.
 */
export function planProject(
  agentName: string,
  missionId: string | null | undefined,
  registered: () => RegisteredProject[] = registeredProjects,
): PlanProject | null {
  let cfg: ReturnType<typeof loadConfig> | null = null;
  try { cfg = loadConfig(agentName); } catch { return null; }
  const agentSlug = slugOrNull(taskProjectSlug({}, cfg));
  const agentCwd = slugOrNull(cfg.cwd);
  const mission = missionId ? dbApi.getMission(missionId) : undefined;
  const missionCwd = slugOrNull(mission?.cwd_override);
  const own = missionId ? missionProject(missionId) : null;
  if (own) return { slug: own, cwd: missionCwd ?? agentCwd, agentSlug };
  if (missionCwd) {
    const marked = slugOrNull(projectFromCwd(missionCwd)) ?? slugOrNull(projectFromRegisteredCwd(missionCwd, registered()));
    if (marked) return { slug: marked, cwd: missionCwd, agentSlug };
  }
  if (agentSlug) return { slug: agentSlug, cwd: agentCwd, agentSlug };
  const found = agentCwd ? slugOrNull(projectFromRegisteredCwd(agentCwd, registered())) : null;
  return found ? { slug: found, cwd: agentCwd, agentSlug } : null;
}

export function planLanding(agentName: string, chantier: string, opts: PlanLandingOptions = {}): PlanLanding | null {
  const target = planProject(agentName, opts.seriesId);
  if (!target) return null;
  const slug = target.slug;
  const found = landingSetting(slug, target.cwd);
  if (!found) return null;
  const { setting, repo } = found;
  const local = setting.mode !== 'pr';
  const choice = planBranchChoice(opts.branch ?? undefined);
  // The earlier bare name only ever applied to a project that lands through
  // pull requests: a project that merges locally stays what it was without a
  // branch named with its kind.
  const chosen = local && choice?.legacy && !opts.form ? null : choice;
  if (local && !chosen && !opts.form) return null;
  const finish: PlanFinish = opts.finish ?? 'merge';
  const baseRef = local ? localBaseRef(setting.target) : integrationBaseRef(setting);
  const prefix = setting.branch_prefix;
  const held = seriesBranch(opts.seriesId, slug, repo);
  const planned = opts.seriesId ? dbApi.getSeriesPlanLanding(opts.seriesId) : undefined;
  let kind: PlanBranchKind = chosen?.kind ?? 'new';
  let branch: string;
  let refusal: string | undefined;
  if (held) {
    branch = held;
    // Fixed with the branch: what the planner recorded, not what is proposed now.
    kind = planned?.branch === held && planned.branch_kind === 'existing' ? 'existing' : 'new';
  } else if (chosen && chosen.name.trim()) {
    const strict = !chosen.legacy || (opts.form === true && local);
    const checked = checkPlanBranch(chosen.name, setting, repo, { kind, strict, local });
    branch = checked.branch;
    if (!checked.ok) refusal = checked.refusal;
  } else {
    const derived = integrationBranchName(chantier, { prefix });
    const taken = opts.form && repo ? (name: string) => repoBranchExists(repo, name) === true : undefined;
    branch = (derived && freeBranch(derived, repo, taken)) ?? `${prefix}<topic>`;
  }
  const mode: PlanLanding['mode'] = local || branch.startsWith('sec/') ? 'branch' : 'pr';
  const last: SeriesPlanLanding['last'] = finish === 'keep' ? 'none' : local ? 'local' : 'pr';
  // An agent outside the project would create tasks the project's setting
  // never reaches: they name it.
  const taskProject = slug !== target.agentSlug ? slug : null;
  const note = landingNote({
    slug, branch, baseRef, target: setting.target, kind, last, local,
    sequential: opts.sequential === true, taskProject,
  });
  return {
    branch,
    chantier,
    baseRef,
    project: slug,
    prefix,
    locked: held !== null,
    ...(taskProject ? { taskProject } : {}),
    ...(refusal ? { refusal } : {}),
    // The bare name of a project that lands through pull requests: the last
    // task stays implicit, so the commands are the earlier ones to the byte.
    ...(local || finish === 'keep' ? { last, target: setting.target } : {}),
    note,
    projectMode: local ? 'local' : 'pr',
    mode,
    kind,
    finish,
    target: setting.target,
    repo,
    explicit: chosen !== null && !chosen.legacy,
  };
}

/** What the orchestrator must know before it applies the plan. */
function landingNote(p: {
  slug: string; branch: string; baseRef: string; target: string; kind: PlanBranchKind;
  last: NonNullable<SeriesPlanLanding['last']>; local: boolean; sequential: boolean; taskProject: string | null;
}): string {
  const { slug, branch, target } = p;
  const named = branch.endsWith('<topic>')
    ? `Replace \`${branch}\` with a short English topic (letters, digits, dashes, no id) in every command. `
    : '';
  const head = p.local
    ? `Project ${slug} merges locally into ${target}, and this job works on a branch of its own. `
    : `Project ${slug} lands through a pull request into ${p.baseRef}. `;
  const cutFrom = p.local ? target : p.baseRef;
  const what = p.local ? 'branch' : 'integration branch';
  const kept = p.local
    ? `No task merges it into ${target}: the work stays on \`${branch}\`, and the job's ideas stay partial until the branch lands.`
    : `No pull request is opened and the branch is never pushed: the work stays on \`${branch}\`, and the job's ideas ` +
      `stay partial until the branch lands.`;
  const lastTask = p.last === 'pr'
    ? `the task that opens the pull request (\`--landing pr\`)`
    : `the task that merges \`${branch}\` into ${target} on this machine (\`--landing local\`), which closes the job's ideas`;
  if (p.sequential) {
    const project = p.taskProject ? `, keep \`--project ${p.taskProject}\`` : '';
    const first = p.kind === 'existing'
      ? `has the daemon take the existing branch \`${branch}\` as it is`
      : `has the daemon cut the ${what} \`${branch}\` from ${cutFrom}`;
    const end = p.last === 'none'
      ? `Once the work is committed, remove the worktree (\`git worktree remove <worktree>\`). ${kept}`
      : `Once the work is committed, run the last command (add \`--todo <id>\` when the job carries a TO DO idea${project}): ` +
        `it creates ${lastTask}. Then remove the worktree (\`git worktree remove <worktree>\`)` +
        (p.last === 'pr' ? `; a person merges the pull request on the forge.` : '.');
    return `${head}${named}This job is coded in a mission, not by Kanban tasks. Its first command (\`timon pr branch\`) ` +
      `${first} and answers with \`worktree\`, a folder of your own detached on that branch: code and commit only ` +
      `there (in sequential-new-mission, give that folder to the mission you spawn), never in the shared checkout, ` +
      `never on ${target}, and nothing is merged into ${target} by hand. After each commit, move the branch by ` +
      `reference from the worktree: \`git push . HEAD:refs/heads/${branch}\`. ${end}`;
  }
  const carried = p.taskProject ? `Every command carries \`--project ${slug}\`: keep it. ` : '';
  const from = p.kind === 'existing'
    ? `the existing branch \`${branch}\`, which the daemon takes as it is`
    : `the ${what} \`${branch}\`, which the daemon cuts from ${cutFrom}`;
  const end = p.last === 'none'
    ? kept
    : `The last command creates ${lastTask}` + (p.last === 'pr' ? `; a person merges it on the forge.` : '.');
  return `${head}${named}${carried}Every task of this job starts from ${from}: never from ${target}, and nothing ` +
    `is merged into ${target} by hand. ${end}`;
}

/** The branch field of the planner, for any project the job is for. */
export type PlanLandingForm = {
  project: string;
  /** The project's own setting: `pr` lands through a pull request. */
  mode: 'pr' | 'local';
  prefix: string;
  /** The name proposed for a new branch, or the job's branch once locked. */
  branch: string;
  kind: PlanBranchKind;
  /** `merge` unless the job already chose otherwise. */
  finish: PlanFinish;
  /** The branch the job ends up in. */
  target: string;
  /** What a new branch is cut from, as a person reads it: `origin/main`, `main`. */
  base_ref: string;
  locked: boolean;
  refusal?: string;
  /** The repository's branches a job may start from, newest first. */
  branches: RepoBranch[];
};

/**
 * What the planner's form shows of the job's branch, for any project: the name
 * proposed for a new branch, the prefix, the target, the project's mode, and
 * the branches the job may start from instead. Null when the job has no project.
 */
export function planLandingForm(
  agentName: string, chantier: string, proposed: string | null, seriesId: string | null | undefined,
): PlanLandingForm | null {
  const landing = planLanding(agentName, chantier, { branch: proposed, seriesId, form: true });
  if (!landing) return null;
  const planned = seriesId ? dbApi.getSeriesPlanLanding(seriesId) : undefined;
  const finish: PlanFinish = landing.locked && planned?.branch === landing.branch && planned.finish === 'keep' ? 'keep' : 'merge';
  return {
    project: landing.project,
    mode: landing.projectMode,
    prefix: landing.prefix,
    branch: landing.branch,
    kind: landing.kind,
    finish,
    target: landing.target,
    base_ref: landing.projectMode === 'local' ? landing.target : landing.baseRef,
    locked: landing.locked,
    ...(landing.refusal ? { refusal: landing.refusal } : {}),
    branches: (landing.repo ? listRepoBranches(landing.repo) : null) ?? [],
  };
}
