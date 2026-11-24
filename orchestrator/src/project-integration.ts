/**
 * How a project's Kanban jobs land (`docs/KANBAN-PR-PIPELINE.md` §7.2, step 3
 * of §8): merged locally into their base, as every pipeline does today, or
 * gathered on an integration branch that reaches the remote through a pull
 * request.
 *
 * One setting per project, stored as JSON in `projects.integration` and
 * validated by zod on every read and every write. No row (NULL) is the local
 * merge: nothing changes for a project nobody configured.
 *
 * `gh_config_dir` and `account` belong to this machine: `gh` run with that
 * folder must answer that login before the daemon writes anything to the
 * forge. The folder is the one credential store the daemon will hand `gh`, so
 * it must sit in the user's home and out of every folder a mission can write:
 * an agent able to plant a `hosts.yml` there would choose the account the
 * daemon pushes as.
 */
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { dbApi } from './db.js';
import { checkRemoteUrl, REMOTE_URL_MESSAGES } from './git-remote-url.js';
import { missionWritableProblem } from './host/mission-writable.js';
import { isPlausibleGitRef } from './task-git.js';

/** `local`: the base is merged into as it is (the current pipelines).
 *  `pr`: an integration branch cut from `<remote>/<target>`, landed by a pull
 *  request. Same words as `tasks.integration_mode`, which a job inherits. */
export const PROJECT_INTEGRATION_MODES = ['local', 'pr'] as const;
export type ProjectIntegrationMode = (typeof PROJECT_INTEGRATION_MODES)[number];

/** What Timon may do when a contributor's pull request conflicts with its
 *  base (`forge-conflicts.ts`): `ask` the contributor (a comment proposed to a
 *  person, the default), or also let a person `resolve` it here, without a
 *  working tree, and push the resolution to the contributor's branch. */
export const CONTRIBUTOR_CONFLICT_MODES = ['ask', 'resolve'] as const;
export type ContributorConflictMode = (typeof CONTRIBUTOR_CONFLICT_MODES)[number];

/** Forges the daemon knows how to open a pull request on. Others land by hand
 *  (`mark-merged`). */
export const INTEGRATION_FORGES = ['github'] as const;

// GitHub's own rule: 1 to 39 characters, letters, digits and single inner dashes.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// One lowercase segment and its slash (`feat/`, `sec/`): the branch name is
// public once pushed, so nothing a user could mistype into a path.
const BRANCH_PREFIX = /^[a-z0-9][a-z0-9._-]{0,30}\/$/;

const GitName = z.string().trim().min(1).max(255)
  .refine(isPlausibleGitRef, { message: 'not a valid git name' });

const BranchPrefix = z.string().trim().regex(BRANCH_PREFIX, 'one lowercase segment ending with "/", like "feat/"')
  .refine((p) => p !== 'timon/', { message: '"timon/" is reserved for Timon\'s own task branches' });

const Account = z.string().trim().regex(GITHUB_LOGIN, 'not a valid GitHub login');

const GhConfigDir = z.string().trim().min(1).max(1024);

// The push URL the remote must answer before anything is pushed: a mission
// writes `.git/config`, so the remote's URL there proves nothing on its own.
// Same allow-list as every remote URL Timon accepts, credentials refused.
const RemoteUrl = z.string().trim().superRefine((value, ctx) => {
  const check = checkRemoteUrl(value);
  if (!check.ok) ctx.addIssue({ code: 'custom', message: REMOTE_URL_MESSAGES[check.reason] });
});

export const ProjectIntegrationSchema = z.object({
  mode: z.enum(PROJECT_INTEGRATION_MODES),
  remote: GitName,
  target: GitName,
  forge: z.enum(INTEGRATION_FORGES),
  account: Account.nullable(),
  gh_config_dir: GhConfigDir.nullable(),
  branch_prefix: BranchPrefix,
  // Added after the first stored settings: a row without it reads as unset.
  remote_url: RemoteUrl.nullable().default(null),
  // Added later still: a row without it asks the contributor.
  contributor_conflicts: z.enum(CONTRIBUTOR_CONFLICT_MODES).default('ask'),
}).strict();

export type ProjectIntegration = z.infer<typeof ProjectIntegrationSchema>;

/** Body of a write: only the fields to change; `null` clears `account`,
 *  `gh_config_dir` or `remote_url`. Unknown keys are refused rather than dropped. */
export const ProjectIntegrationPatchSchema = z.object({
  mode: z.enum(PROJECT_INTEGRATION_MODES).optional(),
  remote: GitName.optional(),
  target: GitName.optional(),
  forge: z.enum(INTEGRATION_FORGES).optional(),
  account: Account.nullable().optional(),
  gh_config_dir: GhConfigDir.nullable().optional(),
  branch_prefix: BranchPrefix.optional(),
  remote_url: RemoteUrl.nullable().optional(),
  contributor_conflicts: z.enum(CONTRIBUTOR_CONFLICT_MODES).optional(),
}).strict();

export type ProjectIntegrationPatch = z.infer<typeof ProjectIntegrationPatchSchema>;

export const DEFAULT_PROJECT_INTEGRATION: Readonly<ProjectIntegration> = Object.freeze({
  mode: 'local',
  remote: 'origin',
  target: 'main',
  forge: 'github',
  account: null,
  gh_config_dir: null,
  branch_prefix: 'feat/',
  remote_url: null,
  contributor_conflicts: 'ask',
});

export class ProjectIntegrationError extends Error {
  constructor(readonly code: 'not_found' | 'invalid', message: string) {
    super(message);
    this.name = 'ProjectIntegrationError';
  }
}

export type ProjectIntegrationRead = {
  integration: ProjectIntegration;
  /** False when the project never set one: `integration` is the default. */
  configured: boolean;
  /** Set when the stored value no longer validates. `integration` is then the
   *  default, and a caller about to push or open a pull request must refuse. */
  invalid?: string;
};

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

export type GhConfigDirOptions = {
  /** Stands in for the user's home in tests. */
  home?: string;
  /** Folders missions write on top of the fence's list: the projects' own. */
  projectFolders?: readonly string[];
};

/**
 * Why `path` cannot be the `GH_CONFIG_DIR` handed to `gh`, or null. Worded
 * without the path: the caller already has it, and it never goes to a log.
 */
export function ghConfigDirProblem(path: string, opts: GhConfigDirOptions = {}): string | null {
  if (!isAbsolute(path)) return 'gh_config_dir must be an absolute path';
  // `..` or `.` would make the folder the user reads differ from the one gh opens.
  if (path.split(/[\\/]+/).some((part) => part === '..' || part === '.')) {
    return 'gh_config_dir must not hold "." or ".." segments';
  }
  const home = opts.home ?? homedir();
  const typed = resolve(path);
  const spellings = [typed, canonical(typed)];
  const homes = [home, canonical(home)];
  if (!spellings.every((p) => homes.some((h) => isInside(h, p)))) {
    return 'gh_config_dir must be a folder inside your home folder';
  }
  for (const p of spellings) {
    if (missionWritableProblem(p, { alsoRoots: opts.projectFolders ?? [] })) {
      return 'gh_config_dir must not be a folder an agent can write (the Timon home, a project folder, a writable folder of the fence)';
    }
  }
  try {
    if (!statSync(typed).isDirectory()) return 'gh_config_dir must be a folder';
  } catch { /* not created yet: `gh auth login` will create it */ }
  return null;
}

/** The folders of every registered project: missions write in them. */
function projectFolders(): string[] {
  return dbApi.listProjectRows().map((row) => row.cwd).filter((cwd): cwd is string => !!cwd);
}

/** Checks what zod cannot: the folder against the machine, and an account in
 *  `pr` mode. Returns the setting as it will be stored. */
export function checkProjectIntegration(value: ProjectIntegration, opts: GhConfigDirOptions = {}): ProjectIntegration {
  if (value.mode === 'pr' && !value.account) {
    throw new ProjectIntegrationError('invalid', 'mode "pr" needs the GitHub account gh must be signed in as (account)');
  }
  let ghConfigDir = value.gh_config_dir;
  if (ghConfigDir !== null) {
    const problem = ghConfigDirProblem(ghConfigDir, { projectFolders: projectFolders(), ...opts });
    if (problem) throw new ProjectIntegrationError('invalid', problem);
    ghConfigDir = resolve(ghConfigDir);
  }
  return { ...value, gh_config_dir: ghConfigDir };
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

/** Parses a stored value; a broken one says why instead of passing for local. */
export function parseStoredIntegration(raw: string | null): ProjectIntegrationRead {
  if (raw === null) return { integration: { ...DEFAULT_PROJECT_INTEGRATION }, configured: false };
  let json: unknown;
  try { json = JSON.parse(raw); } catch {
    return { integration: { ...DEFAULT_PROJECT_INTEGRATION }, configured: true, invalid: 'stored setting is not valid JSON' };
  }
  const parsed = ProjectIntegrationSchema.safeParse(json);
  if (!parsed.success) {
    return { integration: { ...DEFAULT_PROJECT_INTEGRATION }, configured: true, invalid: zodMessage(parsed.error) };
  }
  return { integration: parsed.data, configured: true };
}

export function readProjectIntegration(slug: string): ProjectIntegrationRead {
  const row = dbApi.getProjectRow(slug);
  if (!row) throw new ProjectIntegrationError('not_found', `project not found: "${slug}"`);
  return parseStoredIntegration(row.integration);
}

/**
 * Applies `body` (a patch, validated here) over the current setting, or over
 * the default when there is none or it no longer validates, checks the result
 * as a whole and stores it.
 */
export function updateProjectIntegration(
  slug: string, body: unknown, opts: GhConfigDirOptions & {
    /** Sees the setting as it is and as it would be stored; throws to refuse the write. */
    guard?: (current: ProjectIntegration, next: ProjectIntegration) => void;
  } = {},
): ProjectIntegration {
  const current = readProjectIntegration(slug);
  const patch = ProjectIntegrationPatchSchema.safeParse(body ?? {});
  if (!patch.success) throw new ProjectIntegrationError('invalid', zodMessage(patch.error));
  const merged = ProjectIntegrationSchema.safeParse({ ...current.integration, ...patch.data });
  if (!merged.success) throw new ProjectIntegrationError('invalid', zodMessage(merged.error));
  const { guard, ...checkOpts } = opts;
  const value = checkProjectIntegration(merged.data, checkOpts);
  guard?.(current.integration, value);
  if (!dbApi.setProjectIntegration(slug, JSON.stringify(value))) {
    throw new ProjectIntegrationError('not_found', `project not found: "${slug}"`);
  }
  return value;
}

/** The fields that decide where a contributor's conflict resolution is
 *  fetched from and pushed to, and as whom (`forge-conflicts.ts`). */
export const PUSH_TARGET_FIELDS = ['remote_url', 'account', 'gh_config_dir', 'mode', 'remote'] as const;

/** The push-target fields `next` changes from `current`. */
export function changedPushTargetFields(current: ProjectIntegration, next: ProjectIntegration): string[] {
  return PUSH_TARGET_FIELDS.filter((field) => current[field] !== next[field]);
}

/** Back to the local merge. */
export function clearProjectIntegration(slug: string): void {
  if (!dbApi.setProjectIntegration(slug, null)) {
    throw new ProjectIntegrationError('not_found', `project not found: "${slug}"`);
  }
}

/** `origin/main`: the remote ref an integration branch is cut from, as
 *  `tasks.base_ref` holds it. */
export function integrationBaseRef(value: Pick<ProjectIntegration, 'remote' | 'target'>): string {
  return `${value.remote}/${value.target}`;
}
