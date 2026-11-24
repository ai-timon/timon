/**
 * Filesystem isolation of a mission (audit finding #4).
 *
 * WHAT THE FINDING SAYS
 * ---------------------
 * `confine()` caps memory and CPU, nothing else. Agents run as child processes
 * of the daemon, under the SAME OS account, so `~/.ssh`, `~/.claude`,
 * `~/.codex` or another home's state are readable from any agent as soon as it
 * runs a shell command. The `cwd` is a working directory, never a jail.
 *
 * WHAT SYSTEMD CAN AND CANNOT DO HERE — measured, not assumed
 * ----------------------------------------------------------
 * Missions are launched through `systemd-run --user --scope`. A **scope** does
 * not have systemd execute the payload: `systemd-run` registers the cgroup and
 * then `exec()`s the command itself. That is precisely why `proc.pid` stays the
 * backend CLI's pid and why every `proc.kill('SIGTERM')` of `agent.ts` works.
 * The price is that a scope carries NO `Exec*` sandboxing directive:
 *
 *     $ systemd-run --user --quiet --scope --property=ProtectHome=tmpfs /bin/true
 *     Unknown assignment: ProtectHome=tmpfs        (exit 1, systemd 255)
 *
 * The same directive on a transient **service** works (`InaccessiblePaths` on
 * `~/.ssh` gives `rc=2` inside the unit), but a service means systemd owns the
 * process: stdio goes through `--pipe`, `proc.pid` becomes `systemd-run`'s, and
 * SIGTERM to that pid leaves the payload running (measured: the unit stays
 * `active`, the child survives). Moving missions to a service unit is a change
 * of process model — kill paths, reaper, stdio — not a hardening flag.
 *
 * Emitting the directives on the scope anyway would be the `-p=K=V` incident of
 * `resources.ts` all over again: `probeWrapper()` would find the wrapper
 * unusable and EVERY mission would then launch with no MemoryMax, no nice and
 * no ionice. Removing the resource guard to add a sandbox that systemd refuses
 * is a net loss. So the rule is hard:
 *
 *   **No masking directive is ever emitted on a `--scope` launcher.**
 *
 * WHAT THIS MODULE THEREFORE IS
 * -----------------------------
 * The policy — which paths a mission has no business reading — resolved as pure
 * data, with the guards that make it safe, and its rendering as systemd
 * properties. It is wired into `confine()` behind the launcher kind, so the day
 * missions run in a unit that accepts sandboxing (a service unit, a dedicated
 * OS account, a namespace: `Host.isolation.runAs`), the policy is already
 * written, tested and configurable. Until then the scope path is byte-for-byte
 * what it was, and `docs/SECURITY.md` §9.1 says so out loud.
 *
 * THE FENCE
 * ---------
 * The second half of the module (`resolveFence`) needs no systemd at all: it
 * is the projection a native launcher hands the kernel (Landlock and a seccomp
 * socket filter on Linux, Seatbelt on macOS) right before it `exec`s the CLI,
 * so the pid and every kill path stay as they are. Unlike the masking, it is
 * an allow-list inside the Timon home and keeps the user's home read-only.
 */
import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { TimonConfig } from '../config/schema.js';
import { isValidAgentName } from '../agent-name.js';
import { PROTECTED_HOME_DIRS } from '../backends/credential-home-dirs.js';
import { BACKEND_HOME_DIRS } from '../backends/builtin-declarations.js';

// The two tables live in a leaf the published SDK can reach; isolation re-exports them for its callers.
export { PROTECTED_HOME_DIRS, otherBackendHomeDirProblem, protectedHomeDirProblem } from '../backends/credential-home-dirs.js';
export { BACKEND_HOME_DIRS } from '../backends/builtin-declarations.js';

/**
 * Unit kind a mission command is wrapped in. Only a unit whose process systemd
 * itself executes can carry `Exec*` sandboxing directives — see the header.
 */
export type LauncherKind = 'scope' | 'service';

export function sandboxSupported(kind: LauncherKind): boolean {
  return kind === 'service';
}

/** Why a scope cannot carry the masking, in one line, for logs and docs. */
export const SCOPE_SANDBOX_REASON =
  'a systemd --scope executes the payload itself and rejects Exec* sandboxing directives '
  + '(“Unknown assignment”), which would break the launch of every mission';

/**
 * The credential folders PROVIDERS declared (C2, `backends/provider-declarations.ts`),
 * by backend: the registry installs the source, this module asks. They join the
 * built-in table in both directions — another backend's folder is masked, the
 * mission's own is spared — which is what closes the gap the table had for the
 * providers it never named (`PROVIDERS-SDK.md` § 12.8). No source = none declared.
 */
let declaredDirsSource: () => Readonly<Record<string, readonly string[]>> = () => ({});

export function setDeclaredCredentialDirsSource(fn: () => Readonly<Record<string, readonly string[]>>): void {
  declaredDirsSource = fn;
}

/**
 * Paths masked by default, relative to the home directory. Two families:
 * OS-wide credentials an agent never needs (`.ssh`, `.gnupg`, cloud tokens),
 * and the state directories of the OTHER LLM backends — a `codex` mission has
 * no reason to read the `claude` subscription. The ancestor's home is masked
 * too (`docs/DUAL-HOME.md`); Timon must not read it.
 */
export const DEFAULT_DENY_HOME_DIRS: readonly string[] = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gcloud',
  '.pkos', // public-name-ok: the archive's home is masked by name
  ...Object.values(BACKEND_HOME_DIRS).flat(),
]);

/**
 * What a mission may reach under `TIMON_HOME` (inventory of the fence
 * framing, §1). The fence treats the Timon home as an allow-list: it is
 * invisible to a mission except the folders `resolveFence` grants inside
 * `writable` and `readable`, so a private file added tomorrow is protected
 * without anyone remembering to list it.
 *
 * `refused` is still spelled out, for three reasons: a launcher that can only
 * mask (`resolveIsolation`, a systemd unit) needs the names; a grant computed
 * from a caller or from the configuration must never land on one; and the
 * tests prove each of them stays out of the projection. The prefixes catch the
 * copies the daemon and the operator leave next to a file (`timon.db-wal`,
 * `timon.config.json.bak-…`, `license.state.json.tmp-…`).
 */
export const MISSION_TIMON_ZONES = Object.freeze({
  /** Top-level folders holding one sub-folder per mission, agent, account or
   *  plugin. Only that sub-folder is granted, never the whole folder. */
  writable: Object.freeze([
    'worktrees', 'tmp', 'backend-accounts', 'provider-runs', 'provider-cache', 'codex-runs', 'grok-runs',
    'workflows', 'workspace',
  ]),
  /** Readable on a declared need (identity docs, skills, project memory,
   *  attachments, the code of a plugin's MCP server), never writable — except
   *  the mission's own agent memory. */
  readable: Object.freeze(['agents', 'skills', 'projects', 'uploads', 'plugins']),
  /** Readable and executable, never writable, and only the one release a
   *  packaged daemon runs from (`desktop-runtime/releases/<id>`): its Node and
   *  its scripts start the mission's own Timon MCP servers. */
  runtime: Object.freeze(['desktop-runtime']),
  /** Never granted, read or write: secrets, the database, the configuration
   *  the daemon executes, sessions and other tenants' state. */
  refused: Object.freeze([
    'daemon-token', 'plugin-token-key', 'setup-token', 'update-token', 'remote-key', 'remote.db',
    'secrets.env', 'secret-key', 'secret-key.next', 'secret-key.location',
    'license.jwt', 'license.key', 'license.state.json', 'license.enrollment-secret',
    'device-id', 'install-id', 'partner-leads.json', 'cli-daemons.json', 'legacy-account-tables.json',
    'timon.db', 'timon.db-wal', 'timon.db-shm', 'integrations.db', 'integrations.db-wal', 'integrations.db-shm',
    'timon.config.json', 'daemon.lock', 'daemon.lock.json',
    'plugins-data', 'browser-profiles', 'browser-native', 'desktop-profile', 'mcp', 'run', 'backups', 'archive',
  ]),
  refusedPrefixes: Object.freeze([
    'secret-key', 'license.', 'partner-leads.json', 'timon.db', 'integrations.db', 'timon.config.json', 'remote.db', 'daemon.lock',
  ]),
});

/** `name`, a top-level entry of the Timon home, is one a mission never reaches. */
export function isRefusedTimonEntry(name: string): boolean {
  return MISSION_TIMON_ZONES.refused.includes(name)
    || MISSION_TIMON_ZONES.refusedPrefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * The refused entries of `timonHome` as absolute paths: the fixed names, plus
 * every listed entry a prefix catches. Pure — the caller lists the folder when
 * it wants the copies (`timon.config.json.bak-…`) included.
 */
export function timonRefusedPaths(timonHome: string, entries: readonly string[] = []): string[] {
  const names = [...MISSION_TIMON_ZONES.refused];
  for (const entry of entries) {
    if (!names.includes(entry) && isRefusedTimonEntry(entry)) names.push(entry);
  }
  return names.map((name) => join(timonHome, name));
}

/**
 * The top-level entry names of the Timon home, for `timonRefusedPaths`, when
 * the caller did not list them. An unreadable folder gives no name: the fixed
 * list still applies.
 */
function listTimonHome(timonHome: string): string[] {
  try {
    return readdirSync(timonHome);
  } catch {
    return [];
  }
}

export type IsolationTarget = {
  /** Working directory of the mission. Never masked, ancestors included. */
  cwd?: string | undefined;
  /** Backend the mission actually runs on; its credential dir is spared. */
  backend?: string | undefined;
  /** Timon's own home. Never masked: missions read and write their state there. */
  timonHome?: string | undefined;
  /** Overridable for tests; defaults to the daemon user's home. */
  home?: string | undefined;
  /** Top-level entries of the Timon home; listed from the folder when absent, so the copies get masked. */
  timonHomeEntries?: readonly string[] | undefined;
};

export type IsolationPolicy = {
  /** Absolute paths made invisible (`InaccessiblePaths`). */
  deny: readonly string[];
  /** Absolute paths kept visible but not writable (`ReadOnlyPaths`). */
  readOnly: readonly string[];
  /** `false` when `host.isolation.filesystem` is `off`. */
  enabled: boolean;
};

const EMPTY: IsolationPolicy = { deny: [], readOnly: [], enabled: false };

function expand(path: string, home: string): string {
  const raw = path.startsWith('~/') ? join(home, path.slice(2)) : path;
  return resolve(raw);
}

/** `parent` is `child` or contains it. Pure path arithmetic: no `realpath`,
 *  which would touch (and on a guarded home, read) the filesystem. */
function contains(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * The policy for one mission launch. Same inputs, same output; the only thing
 * read from the filesystem is the list of the Timon home's top-level entries,
 * when the target does not give it, so the copies of a private file
 * (`timon.config.json.bak-…`) are masked like the file.
 *
 * Three guards, and they are the point of the function — a deny list that
 * swallows one of these turns a hardening measure into an outage:
 *  1. never mask the mission's `cwd`, nor any ancestor of it (a worktree under
 *     a masked home folder is exactly that case);
 *  2. never mask the credential directory of the backend actually in use;
 *  3. never mask `TIMON_HOME` nor any ancestor of it — but the private files
 *     it holds (`MISSION_TIMON_ZONES.refused`) are masked whatever the target
 *     or the configuration says: sparing the folder must not spare the
 *     operator token, the vault key or the database inside it.
 * `host.isolation.allow` is applied last and wins over everything but those
 * private files.
 */
export function resolveIsolation(config: TimonConfig, target: IsolationTarget = {}): IsolationPolicy {
  const iso = config.host.isolation;
  if (iso.filesystem === 'off') return EMPTY;

  const home = target.home ?? homedir();
  const spared: string[] = [];
  if (target.cwd) spared.push(resolve(target.cwd));
  if (target.timonHome) spared.push(resolve(target.timonHome));
  const declared = declaredDirsSource();
  const ownBuiltIn = BACKEND_HOME_DIRS[target.backend ?? ''] ?? [];
  for (const dir of ownBuiltIn) spared.push(expand(`~/${dir}`, home));
  for (const path of iso.allow) spared.push(expand(path, home));

  // What a plugin declared for the running backend is spared only as that exact
  // folder, and never when it touches something the user's own credentials live
  // in: registration already refuses those (`protectedHomeDirProblem`), this is
  // the second lock for a declaration that got through another way.
  const neverSpared = [...DEFAULT_DENY_HOME_DIRS, ...PROTECTED_HOME_DIRS]
    .filter((d) => !ownBuiltIn.includes(d))
    .map((d) => expand(`~/${d}`, home));
  const sparedDeclared = (declared[target.backend ?? ''] ?? [])
    .map((dir) => expand(`~/${dir}`, home))
    .filter((path) => !neverSpared.some((n) => contains(n, path) || contains(path, n)));

  const candidates = [
    ...DEFAULT_DENY_HOME_DIRS.map((d) => expand(`~/${d}`, home)),
    ...Object.values(declared).flat().map((d) => expand(`~/${d}`, home)),
    ...iso.deny.map((p) => expand(p, home)),
  ];

  const deny: string[] = [];
  for (const path of candidates) {
    // A candidate that is a spared path, or that CONTAINS one, is dropped:
    // masking a home folder would take the worktree living under it with it.
    if (spared.some((s) => contains(path, s) || contains(s, path))) continue;
    if (sparedDeclared.includes(path)) continue;
    if (!deny.includes(path)) deny.push(path);
  }

  const readOnly: string[] = [];
  for (const path of iso.readOnly.map((p) => expand(p, home))) {
    if (deny.includes(path) || readOnly.includes(path)) continue;
    readOnly.push(path);
  }

  // Guard 3 spares the Timon home, never what a mission must not read in it.
  // Added after every spared path on purpose: neither the cwd nor `allow` can
  // reopen them.
  if (target.timonHome) {
    const timonHome = resolve(target.timonHome);
    const entries = target.timonHomeEntries ?? listTimonHome(timonHome);
    for (const path of timonRefusedPaths(timonHome, entries)) {
      if (!deny.includes(path)) deny.push(path);
    }
  }

  return { deny, readOnly: readOnly.filter((path) => !deny.includes(path)), enabled: true };
}

/** systemd takes a space-separated path list; a path holding a space must be
 *  quoted or the rest of it becomes a second path. */
function pathList(paths: readonly string[]): string {
  return paths.map((p) => (/[\s"']/.test(p) ? `"${p.replace(/(["\\])/g, '\\$1')}"` : p)).join(' ');
}

/**
 * The masking directives, in the long `--property=K=V` form — the short
 * `-p=K=V` is rejected by systemd-run and breaks the spawn (see
 * `resources.test.ts`). Empty when the policy masks nothing.
 */
export function isolationProperties(policy: IsolationPolicy): string[] {
  if (!policy.enabled) return [];
  const out: string[] = [];
  if (policy.deny.length > 0) out.push(`--property=InaccessiblePaths=${pathList(policy.deny)}`);
  if (policy.readOnly.length > 0) out.push(`--property=ReadOnlyPaths=${pathList(policy.readOnly)}`);
  return out;
}

/**
 * Directives for a given launcher: the policy on a unit that accepts it, and
 * strictly nothing on a scope. Single decision point, so a future migration of
 * the mission launcher lights the whole path up by changing one argument.
 */
export function isolationArgsFor(
  kind: LauncherKind,
  config: TimonConfig,
  target: IsolationTarget = {},
): string[] {
  if (!sandboxSupported(kind)) return [];
  return isolationProperties(resolveIsolation(config, target));
}

/* ──────────────────────────────────────────────────────────────────────────
   THE FENCE — what the kernel lets a mission reach (Landlock, Seatbelt)

   The masking above needs systemd to execute the payload, which a `--scope`
   never does. The fence does not: a launcher that `exec`s the backend CLI
   asks the kernel to confine it, from inside the launch chain, and the pid
   stays the CLI's. This section is the policy that launcher applies, as pure
   data: the OS adapters render it (`host/linux.ts`, `host/darwin.ts`).

   Semantics, shared by every renderer and spelled out by `fenceAccess`:
   - each listed path carries a level — none (`deny`, `denyUnderTimonHome`),
     read (`ro`) or read-write (`rw`) — and a file gets the level of its
     DEEPEST listed ancestor; on the very same path, none beats read, which
     beats read-write;
   - a file is executable when it is readable and the deepest ancestor among
     `exec`, `deny` and `denyUnderTimonHome` is an `exec` root.
   So the system root is readable, the Timon home is not (it is in `deny`),
   and the mission's own folders inside it are reopened one by one. Landlock
   renders "deeper refusal" by granting the siblings at each level instead of
   the parent; Seatbelt by emitting the rules shallow first, last match wins.
   ────────────────────────────────────────────────────────────────────────── */

export type FenceMode = TimonConfig['host']['isolation']['filesystem'];

export type FenceTarget = {
  /** Timon's home: invisible to the mission except its own folders. */
  timonHome: string;
  /** Working directory of the mission: writable wherever it is, unless `workspace` is `ro`. */
  cwd?: string | undefined;
  /**
   * The working directory the agent's own config file holds, read by the
   * daemon at launch: never a task's worktree, a provider's choice or a path a
   * mission hands over. Its one use: an agent whose folder is the Timon home's
   * `workspace` itself, as the setup of 0.1.8 and earlier made them, keeps
   * that folder (`sharedWorkspace` of the policy).
   */
  agentCwd?: string | undefined;
  /**
   * `ro` when the level the mission runs at writes nothing (a CLI whose own
   * read-only sandbox the fence replaces): the working directory and its git
   * directories are granted read-only. The CLI's own state (its scratch
   * folder, its account, `TMPDIR`) stays writable: the CLI itself, not the
   * commands it runs, writes there. Default `rw`.
   */
  workspace?: 'rw' | 'ro' | undefined;
  /** Backend the mission runs on; its own state folders stay writable when no account is given. */
  backend?: string | undefined;
  /** Overridable for tests; defaults to the daemon user's home. */
  home?: string | undefined;
  /** Overridable for tests; picks the system folders every program writes to. */
  platform?: NodeJS.Platform | undefined;
  missionId?: string | undefined;
  /** Agent running the mission: its identity docs readable, its memory writable. */
  agent?: string | undefined;
  /** Project slug: its shared memory and attachments readable. */
  project?: string | undefined;
  /** Backend account of the mission (`backend-accounts/<id>`): the only account it sees. */
  account?: string | undefined;
  /** Provider plugin holding the mission's scratch folder (`provider-runs/<plugin>/<mission>`). */
  providerPlugin?: string | undefined;
  /**
   * Profile the mission runs on, when it runs on no account: of the plugin's per-profile
   * folders (`provider-cache/<plugin>/profiles/<profile>`), the only one the mission reaches.
   */
  providerProfile?: string | undefined;
  /** Git directories the worktree commits into (the main repository's `.git`). */
  gitDirs?: readonly string[] | undefined;
  /** Install folders of the plugins whose MCP servers the mission runs: readable and executable. */
  pluginDirs?: readonly string[] | undefined;
  /**
   * What the daemon itself runs from: its executable, its orchestrator folder,
   * the Node it starts MCP servers with. A packaged install on macOS and Linux
   * runs from a copy under `desktop-runtime/releases/<id>` of the Timon home;
   * that release, and no other, is readable and executable, never writable.
   * A path outside the Timon home needs nothing: the system is readable.
   */
  runtime?: readonly string[] | undefined;
  /** Further paths under the Timon home the daemon hands the mission (chat attachments): readable. */
  timonRead?: readonly string[] | undefined;
  /** Top-level entries of the Timon home: refused copies get named. Listed from the folder when absent. */
  timonHomeEntries?: readonly string[] | undefined;
  /**
   * Resolves an existing path, links followed; `fs.realpathSync.native` by
   * default, throws when the path does not exist. Landlock and Seatbelt follow
   * links, so every grant is checked on the path it resolves to, and a path
   * that does not resolve gets no grant at all: the caller creates the
   * mission's own folders before it resolves the fence.
   */
  realpath?: ((path: string) => string) | undefined;
};

export type FencePolicy = {
  mode: FenceMode;
  /** `false` when `host.isolation.filesystem` is `off`: nothing is confined. */
  enabled: boolean;
  /** Readable subtrees: the system root, and what is reopened under a refused one. */
  ro: readonly string[];
  /** Readable and writable subtrees. */
  rw: readonly string[];
  /** Roots under which files may be executed (see the semantics above). */
  exec: readonly string[];
  /** Subtrees the mission cannot reach at all: the Timon home, other credentials, `host.isolation.deny`. */
  deny: readonly string[];
  /** The refused entries of the Timon home, named, for renderers that can only mask. */
  denyUnderTimonHome: readonly string[];
  unixSockets: 'deny' | 'allow';
  /** Grants dropped because they would open what a mission never reaches, with the reason. */
  ignored: ReadonlyArray<{ path: string; reason: string }>;
  /**
   * The Timon home's `workspace` folder when it was granted whole, because it
   * is the agent's configured folder (`FenceTarget.agentCwd`): the agent then
   * reaches every other folder of `workspace` too. Absent otherwise.
   */
  sharedWorkspace?: string | undefined;
};

/** Folders every program of the platform writes to (`/dev/null`, a temporary file). */
const SYSTEM_WRITABLE: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = Object.freeze({
  linux: Object.freeze(['/tmp', '/var/tmp', '/dev']), // portability: Linux table, read only for platform 'linux'
  // Seatbelt matches resolved paths: `/tmp` is `/private/tmp`, and the per-user
  // temporary folder of `confstr(_CS_DARWIN_USER_TEMP_DIR)` lives in `/private/var/folders`.
  darwin: Object.freeze(['/private/tmp', '/private/var/tmp', '/private/var/folders', '/dev']),
});

/** The system folders the fence leaves every mission writing on `platform`. */
export function systemWritableFolders(platform: NodeJS.Platform): readonly string[] {
  return SYSTEM_WRITABLE[platform] ?? [];
}

const FENCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A mission id, agent name or account id the fence may turn into a folder name. */
export function isFenceSegment(value: string): boolean {
  return FENCE_SEGMENT.test(value);
}

/**
 * An agent name the fence may turn into a folder name: a plain segment, or
 * any name the agent rule accepts (`马斯克`, `_main`, `_eph-…`). Both refuse a
 * `.` first, so `.agents` stays out of any agent's reach, and a separator.
 */
export function isFenceAgent(value: string): boolean {
  return isFenceSegment(value) || isValidAgentName(value);
}

/** The mission's own temporary folder, its `TMPDIR` once fenced; the caller checks `missionId` with `isFenceSegment`. */
export function missionTmpDir(timonHome: string, missionId: string): string {
  return join(timonHome, 'tmp', 'missions', missionId);
}

/**
 * Folder of `provider-cache/<plugin>/` holding one folder per profile the plugin launches
 * (`ctx.provider.scratch.profile`). A mission reaches its own profile's folder only.
 */
export const PROVIDER_PROFILES = 'profiles';

/**
 * Folder of `provider-cache/` holding one package cache per agent. Its name
 * starts with `.` so that no provider plugin id, which `FENCE_SEGMENT` makes
 * start with a letter or a digit, can ever be granted it as its own cache.
 */
const AGENT_CACHES = '.agents';

/**
 * The package cache of one agent: where a fenced mission's `npx`, `pnpm dlx`
 * and `uvx` download, since the user's own caches sit in the read-only home.
 * One per agent, shared by its missions only: a mission of another agent
 * cannot plant a package that this agent's MCP servers then run, and the
 * user's own `~/.npm`, which programs outside Timon read, stays out of reach.
 * Under `provider-cache/` because it is a cache: never exported, rebuilt on
 * demand. The caller checks `agent` with `isFenceAgent`.
 */
export function agentPackageCacheDir(timonHome: string, agent: string): string {
  return join(timonHome, 'provider-cache', AGENT_CACHES, agent);
}

/**
 * Where a grant comes from, which decides how far it may reach into the Timon home:
 * - `own`: a folder the fence builds itself from the mission's identity (its
 *   account, its scratch folders), each segment checked by `FENCE_SEGMENT`;
 * - `own-memory`: the same, for the agent's memory, the one writable folder
 *   of a read-only zone;
 * - `mission`: a path the caller hands over (the working directory, a git
 *   directory, a file or a plugin folder), which a mission may have chosen:
 *   an agent's `cwd` is only checked for existence, and a mission holding
 *   `agents:manage` sets it;
 * - `config`: `host.isolation`, which grants nothing inside the Timon home;
 * - `runtime`: the release folder the daemon runs from, read-only, derived
 *   from the daemon's own executable and code, never from a mission;
 * - `agent-workspace`: the mission's working directory when it is the
 *   `workspace` folder itself AND the agent's configured folder. Checked as a
 *   `mission` grant, but for the depth of that one folder: agents set up by
 *   0.1.8 and earlier were given it, and lost their own folder to the fence.
 */
type GrantSource = 'own' | 'own-memory' | 'mission' | 'config' | 'runtime' | 'agent-workspace';

/** The Timon home's folder of shared working folders (`WORKSPACE_DIR` of `paths.ts`). */
const WORKSPACE_ENTRY = 'workspace';

/** Where a packaged install keeps its releases, below the Timon home (`host/packaged-service.ts`). */
const RUNTIME_RELEASES = Object.freeze(['desktop-runtime', 'releases']);

/**
 * The release folder `path` sits in, `<timonHome>/desktop-runtime/releases/<id>`,
 * or null when it sits in none. Pure path arithmetic on both arguments as given.
 */
export function runtimeReleaseOf(timonHome: string, path: string): string | null {
  const releases = join(timonHome, ...RUNTIME_RELEASES);
  if (!contains(releases, path) || path === releases) return null;
  const id = relative(releases, path).split(sep)[0] ?? '';
  return FENCE_SEGMENT.test(id) ? join(releases, id) : null;
}

/**
 * Zones of the Timon home where a handed-over path never lands, by their
 * leading segments. Each holds one folder per account or per mission, and
 * the fence grants the mission's own one itself, from its identity. A depth
 * would not be enough there: `backend-accounts/<other>/.credentials.json`
 * sits two segments down and is still another account's sign-in, and
 * `tmp/missions/<other>` is still another mission's TMPDIR.
 */
const OWNER_ZONES: readonly (readonly string[])[] = Object.freeze([
  ['backend-accounts'], // backend-accounts/<account>: a sign-in, credentials included
  ['provider-runs'], // provider-runs/<plugin>/<mission>: a mission's provider home
  ['provider-cache'], // provider-cache/<plugin>: shared by every mission of that provider, but its profiles/<profile>; .agents/<agent>: one agent's package cache
  ['codex-runs'], // codex-runs/<mission>: CODEX_HOME of one mission
  ['grok-runs'], // grok-runs/<mission>: GROK_HOME of one mission
  ['tmp', 'missions'], // tmp/missions/<mission>: TMPDIR of one mission
]);

/**
 * How many segments below its zone root a handed-over path must sit, at
 * least. A zone root lists every task's, agent's or plugin's folder: handing
 * it over grants all of them, so depth 0 is never enough.
 */
const HANDED_DEPTH: Readonly<Record<string, number>> = Object.freeze({
  worktrees: 1, // worktrees/<task>: one task's checkout
  workflows: 1, // workflows/<slug>: one workflow's fallback working directory
  workspace: 1, // workspace/<name>: one shared working folder
  tmp: 1, // tmp/<folder>: a scratch folder; tmp itself holds the daemon's logs
  agents: 1, // agents/<name>: one agent's identity docs and memory
  projects: 1, // projects/<slug>: one project's memory
  skills: 1, // skills/<id>: one skill
  uploads: 2, // uploads/<kind>/<owner>: chat/<conversation>, projects/<slug>
  plugins: 2, // plugins/node_modules/<package>: one installed plugin
});

/** Why a grant must be dropped, or `null` when it may stand. */
function timonGrantProblem(timonHome: string, path: string, access: 'ro' | 'rw', source: GrantSource): string | null {
  if (path === timonHome) return 'the Timon home itself is never granted, only the mission\'s folders in it';
  // An ancestor of the Timon home may be granted: the home stays refused, deeper.
  if (!contains(timonHome, path)) return null;
  if (source === 'config') return 'the configuration cannot open a folder of the Timon home';
  const segments = relative(timonHome, path).split(sep);
  const first = segments[0] ?? '';
  if (isRefusedTimonEntry(first)) return `"${first}" holds private state a mission never reaches`;
  if (source === 'runtime') {
    const release = MISSION_TIMON_ZONES.runtime.includes(first) && segments[1] === RUNTIME_RELEASES[1]
      && segments.length === 3 && FENCE_SEGMENT.test(segments[2] ?? '');
    if (!release) return 'only one release folder of the desktop runtime is opened, to run the daemon\'s own code';
    return access === 'ro' ? null : 'the release the daemon runs from is never writable';
  }
  const writable = MISSION_TIMON_ZONES.writable.includes(first);
  if (access === 'rw' && !writable && source !== 'own-memory') return `"${first}" is never writable from a mission`;
  if (!writable && !MISSION_TIMON_ZONES.readable.includes(first)) return `"${first}" is not one of the mission zones`;
  if (source !== 'mission' && source !== 'agent-workspace') return null;
  const owner = OWNER_ZONES.find((zone) => zone.every((name, i) => segments[i] === name));
  if (owner) return `"${owner.join('/')}" holds other accounts' or missions' folders; the fence grants the mission's own one`;
  if (source === 'agent-workspace' && segments.length === 1 && first === WORKSPACE_ENTRY) return null;
  const depth = HANDED_DEPTH[first] ?? Number.POSITIVE_INFINITY;
  if (segments.length - 1 < depth) return `"${segments.join('/')}" lists other missions' folders; only a folder ${depth} level(s) inside "${first}" is handed over`;
  return null;
}

/** The global fence values, relaxed by the project's then the agent's exception. */
function fenceExceptions(iso: TimonConfig['host']['isolation'], target: Pick<FenceTarget, 'agent' | 'project'>): {
  unixSockets: 'deny' | 'allow';
  writable: readonly string[];
} {
  const { agents, projects } = iso.exceptions;
  const project = target.project && Object.hasOwn(projects, target.project) ? projects[target.project] : undefined;
  const agent = target.agent && Object.hasOwn(agents, target.agent) ? agents[target.agent] : undefined;
  return {
    unixSockets: agent?.unixSockets ?? project?.unixSockets ?? iso.unixSockets,
    writable: [...iso.writable, ...(project?.writable ?? []), ...(agent?.writable ?? [])],
  };
}

const NO_FENCE: FencePolicy = Object.freeze({
  mode: 'off', enabled: false, ro: [], rw: [], exec: [], deny: [], denyUnderTimonHome: [], unixSockets: 'allow', ignored: [],
});

/**
 * The fence of one mission launch. Same inputs, same output; what it reads
 * from the filesystem is where each granted path leads (`target.realpath`)
 * and, when the target does not list them, the Timon home's top-level entries.
 *
 * - The system is readable and executable; the user's home is read-only but
 *   for the mission's own working folders, the backend's state when the
 *   mission runs on the host's own sign-in, and `host.isolation.writable`.
 *   A writable home is how a mission escapes: the daemon later runs what it
 *   finds in `~/.gitconfig` or `~/.local/bin`.
 * - The Timon home is refused as a whole, then the mission's folders are
 *   reopened from `MISSION_TIMON_ZONES` — an allow-list, never a deny-list.
 * - The masking candidates of `resolveIsolation` (other backends' credentials,
 *   `~/.ssh`, `host.isolation.deny`) are refused too; the running backend's
 *   own folders are not.
 * - No grant, whatever its origin, lands on a refused entry of the Timon home
 *   or on the home itself; the configuration grants nothing inside it.
 * - A path the caller hands over (working directory, git directory, file,
 *   plugin folder) never opens a zone root, nor a zone of per-account or
 *   per-mission folders (`HANDED_DEPTH`, `OWNER_ZONES`).
 * - Every check runs on the path a grant resolves to, links followed and,
 *   on macOS and Windows, without case: the kernel follows links too.
 */
export function resolveFence(config: TimonConfig, target: FenceTarget): FencePolicy {
  const iso = config.host.isolation;
  if (iso.filesystem === 'off') return NO_FENCE;

  const home = resolve(target.home ?? homedir());
  const platform = target.platform ?? process.platform;
  const realpath = target.realpath ?? ((path: string) => realpathSync.native(path));
  const resolveLinks = (path: string): string | null => {
    try {
      return realpath(path);
    } catch {
      return null;
    }
  };
  // The folder the links lead to is the one to refuse: a Timon home reached
  // through a link would otherwise be granted under its real name.
  const lexicalHome = resolve(target.timonHome);
  const timonHome = resolveLinks(lexicalHome) ?? lexicalHome;
  // macOS and Windows file systems ignore case by default: `~/.TIMON` is the Timon home there.
  const fold = platform === 'darwin' || platform === 'win32'
    ? (path: string) => path.toLowerCase()
    : (path: string) => path;
  const foldedHome = fold(timonHome);
  const exceptions = fenceExceptions(iso, target);
  const ignored: Array<{ path: string; reason: string }> = [];
  const ro = new Set<string>([parse(home).root]);
  const rw = new Set<string>(SYSTEM_WRITABLE[platform] ?? []);
  const exec = new Set<string>([parse(home).root]);

  /**
   * Grants `path` once resolved, and returns what it resolved to, or `null`
   * when the grant is dropped. Every check runs on the resolved path: a link
   * planted in a worktree must not carry a grant into the Timon home.
   * `handed` adds the check of one kind of handed-over path.
   */
  const grant = (
    path: string,
    access: 'ro' | 'rw',
    source: GrantSource,
    handed?: (folded: string) => string | null,
  ): string | null => {
    const resolved = resolveLinks(path);
    if (resolved === null) {
      ignored.push({ path, reason: 'the path does not resolve to an existing file or folder' });
      return null;
    }
    const folded = fold(resolved);
    // A folder the fence builds from the mission's identity is granted under
    // that name only: a link in it pointing elsewhere in the Timon home would
    // reopen what the identity checks closed.
    const redirected = (source === 'own' || source === 'own-memory' || source === 'runtime')
      && contains(foldedHome, folded) && folded !== fold(path);
    const problem = redirected
      ? 'a link leads it elsewhere in the Timon home'
      : (handed?.(folded) ?? timonGrantProblem(foldedHome, folded, access, source));
    if (problem) {
      ignored.push({ path, reason: resolved === path ? problem : `${problem} (resolves to ${resolved})` });
      return null;
    }
    (access === 'rw' ? rw : ro).add(resolved);
    return resolved;
  };
  const segment = (kind: string, value: string | undefined): string | null => {
    if (value === undefined || value === '') return null;
    if (FENCE_SEGMENT.test(value)) return value;
    ignored.push({ path: value, reason: `${kind} is not a plain folder name` });
    return null;
  };
  const inTimon = (...parts: string[]) => join(timonHome, ...parts);

  const workspace = target.workspace === 'ro' ? 'ro' : 'rw';
  // A read-only level still runs the project's commands, as the CLI's own
  // read-only sandbox did: the workspace stays executable, every write refused.
  const workspaceGrant = (path: string, source: GrantSource = 'mission'): string | null => {
    const granted = grant(resolve(path), workspace, source);
    if (granted && workspace === 'ro') exec.add(granted);
    return granted;
  };
  // The `workspace` folder whole, only when the working directory AND the
  // agent's configured folder both resolve to it: a task's worktree, a
  // provider's own folder or any other handed path keeps the depth rule.
  const sharedRoot = fold(join(timonHome, WORKSPACE_ENTRY));
  const isSharedRoot = (path: string | undefined): boolean => {
    if (!path) return false;
    const resolved = resolveLinks(resolve(path));
    return resolved !== null && fold(resolved) === sharedRoot;
  };
  const shared = isSharedRoot(target.cwd) && isSharedRoot(target.agentCwd);
  const sharedWorkspace = target.cwd ? workspaceGrant(target.cwd, shared ? 'agent-workspace' : 'mission') : null;
  for (const dir of target.gitDirs ?? []) workspaceGrant(dir);

  const missionId = segment('mission id', target.missionId);
  const agent = target.agent !== undefined && target.agent !== '' && isFenceAgent(target.agent)
    ? target.agent
    : segment('agent name', target.agent);
  const project = segment('project slug', target.project);
  const account = segment('account id', target.account);
  const plugin = segment('provider plugin id', target.providerPlugin);
  // An account's mission keeps its CLI's state in the account's folder, never in a profile's.
  const profile = plugin && !account ? segment('provider profile id', target.providerProfile) : null;

  if (missionId) {
    // `tmp/missions/<id>` becomes the mission's TMPDIR: a `mktemp` must not
    // land in a folder the mission can list, nor in another mission's.
    grant(missionTmpDir(timonHome, missionId), 'rw', 'own');
    grant(inTimon('codex-runs', missionId), 'rw', 'own');
    grant(inTimon('grok-runs', missionId), 'rw', 'own');
    if (plugin) grant(inTimon('provider-runs', plugin, missionId), 'rw', 'own');
  }
  // The plugin's cache is shared by its missions, but for the folder each profile keeps its
  // CLI's sessions and settings in: a mission of one profile must neither read another's
  // transcripts nor plant a hook its CLI would run. Refused whole, even before it exists
  // (Landlock grants a folder's future entries), then the mission's own one is reopened.
  const profiles = plugin ? inTimon('provider-cache', plugin, PROVIDER_PROFILES) : null;
  if (plugin) grant(inTimon('provider-cache', plugin), 'rw', 'own');
  if (plugin && profile) grant(inTimon('provider-cache', plugin, PROVIDER_PROFILES, profile), 'rw', 'own');
  if (account) grant(inTimon('backend-accounts', account), 'rw', 'own');
  if (agent) {
    // Writable and executable: `npx` runs the package it installed there.
    grant(agentPackageCacheDir(timonHome, agent), 'rw', 'own');
    grant(inTimon('agents', agent), 'ro', 'own');
    grant(inTimon('agents', agent, 'memory'), 'rw', 'own-memory');
    if (missionId) grant(inTimon('agents', agent, 'missions', missionId, 'memory'), 'rw', 'own-memory');
  }
  grant(inTimon('skills'), 'ro', 'own');
  if (project) {
    grant(inTimon('projects', project, 'memory'), 'ro', 'own');
    grant(inTimon('uploads', 'projects', project), 'ro', 'own');
  }
  // Handed-over files come from a read-only zone; a writable one holds other missions' folders.
  const handedFile = (folded: string): string | null => {
    const first = relative(foldedHome, folded).split(sep)[0] ?? '';
    return contains(foldedHome, folded) && !MISSION_TIMON_ZONES.readable.includes(first)
      ? `"${first}" is not a zone the daemon hands files from`
      : null;
  };
  for (const raw of target.timonRead ?? []) grant(resolve(raw), 'ro', 'mission', handedFile);
  // Executable code from the Timon home comes from one plugin's folder, nowhere else.
  const plugins = join(foldedHome, 'plugins');
  const pluginFolder = (folded: string): string | null => (
    !contains(plugins, folded) || folded === plugins
      ? 'a plugin folder lives under the plugins folder of the Timon home'
      : null
  );
  for (const dir of target.pluginDirs ?? []) {
    const granted = grant(resolve(dir), 'ro', 'mission', pluginFolder);
    if (granted) exec.add(granted);
  }
  // A packaged daemon runs from a release copied into the Timon home, and the
  // mission's Timon MCP servers start with that release's Node and scripts:
  // without it, every one of them fails to start (EACCES, EPERM). Only the
  // release a path of the daemon resolves into is opened; the other releases,
  // and `desktop-runtime` itself, stay refused with the rest of the home.
  for (const raw of target.runtime ?? []) {
    const resolved = resolveLinks(resolve(raw));
    const release = resolved === null ? null : runtimeReleaseOf(timonHome, resolved);
    if (release === null || ro.has(release)) continue;
    const granted = grant(release, 'ro', 'runtime');
    if (granted) exec.add(granted);
  }

  // The backend's own state. With an account, the CLI is pointed at the
  // account's folder: the host's own sign-in stays read-only, so a mission
  // cannot plant a hook the user's interactive CLI would run.
  const declared = declaredDirsSource();
  const ownBuiltIn = BACKEND_HOME_DIRS[target.backend ?? ''] ?? [];
  const neverSpared = [...DEFAULT_DENY_HOME_DIRS, ...PROTECTED_HOME_DIRS]
    .filter((d) => !ownBuiltIn.includes(d))
    .map((d) => expand(`~/${d}`, home));
  const ownDeclared = (declared[target.backend ?? ''] ?? [])
    .map((dir) => expand(`~/${dir}`, home))
    .filter((path) => !neverSpared.some((n) => contains(n, path) || contains(path, n)));
  const ownDirs = [...ownBuiltIn.map((d) => expand(`~/${d}`, home)), ...ownDeclared];
  if (!account) for (const path of ownDirs) grant(path, 'rw', 'own');

  for (const path of exceptions.writable) grant(expand(path, home), 'rw', 'config');
  const allowed = iso.allow
    .map((p) => grant(expand(p, home), 'ro', 'config'))
    .filter((path): path is string => path !== null);
  for (const path of iso.readOnly) grant(expand(path, home), 'ro', 'config');

  // Read-only wins over read-write on the very same path: `readOnly` is a restriction.
  for (const path of ro) rw.delete(path);

  const deny = new Set<string>();
  const candidates = [
    ...DEFAULT_DENY_HOME_DIRS.map((d) => expand(`~/${d}`, home)),
    ...Object.values(declared).flat().map((d) => expand(`~/${d}`, home)),
    ...iso.deny.map((p) => expand(p, home)),
  ];
  for (const path of candidates) {
    if (ownDirs.includes(path)) continue;
    if (allowed.some((a) => contains(a, path))) continue;
    // A grant on the very same path wins (a cwd under `~/.ssh` is the user's
    // choice); a grant deeper down reopens only itself.
    if (rw.has(path) || ro.has(path)) continue;
    deny.add(path);
  }
  deny.add(timonHome);
  deny.add(lexicalHome);
  if (profiles) deny.add(profiles);

  for (const path of rw) exec.add(path);

  return {
    mode: iso.filesystem,
    enabled: true,
    ro: [...ro],
    rw: [...rw],
    exec: [...exec],
    deny: [...deny],
    denyUnderTimonHome: timonRefusedPaths(timonHome, target.timonHomeEntries ?? listTimonHome(timonHome)),
    unixSockets: exceptions.unixSockets,
    ignored,
    ...(shared && sharedWorkspace ? { sharedWorkspace } : {}),
  };
}

/**
 * What a fence lets a mission do with `path` — the reference semantics every
 * renderer must reproduce (see the section header). Pure path arithmetic.
 */
export function fenceAccess(policy: FencePolicy, path: string): { read: boolean; write: boolean; exec: boolean } {
  if (!policy.enabled) return { read: true, write: true, exec: true };
  const target = resolve(path);
  const refused = [...policy.deny, ...policy.denyUnderTimonHome];
  // Lists in order of precedence on an equal path: the first one listed wins a tie.
  const deepest = <T>(lists: ReadonlyArray<readonly [readonly string[], T]>, fallback: T): T => {
    let length = -1;
    let found = fallback;
    for (const [paths, value] of lists) {
      for (const p of paths) {
        if (p.length > length && contains(p, target)) {
          length = p.length;
          found = value;
        }
      }
    }
    return found;
  };
  const level = deepest<'none' | 'ro' | 'rw'>([[refused, 'none'], [policy.ro, 'ro'], [policy.rw, 'rw']], 'none');
  const executable = deepest<boolean>([[refused, false], [policy.exec, true]], false);
  return { read: level !== 'none', write: level === 'rw', exec: level !== 'none' && executable };
}

/**
 * Whether a fenced mission may still write the OS credential store where a CLI
 * keeps a subscription account's sign-in: on macOS the login keychain, a file
 * the CLI's process rewrites itself, so a `writable` grant that reaches its
 * folder lets the mission renew the entry in place. Such a mission writes the
 * entry like an unfenced one (`mission-fence-state.ts`). No other platform keeps
 * an account's sign-in there.
 */
export function fenceWritesCredentialStore(policy: FencePolicy, platform: NodeJS.Platform = process.platform, home: string = homedir()): boolean {
  const folder = credentialStoreFolder(platform, home);
  return folder !== null && [folder, join(folder, 'login.keychain-db')].some((path) => fenceAccess(policy, path).write);
}

/**
 * The same question asked of the configuration, before the launch is built: whether a
 * `writable` path (global, the project's exception, the agent's) reaches the login
 * keychain's folder. `resolveFence` keeps such a grant when the path exists, so the
 * two agree; a listed path that does not exist only makes this side the cautious one.
 */
export function fenceConfigWritesCredentialStore(
  config: TimonConfig,
  target: Pick<FenceTarget, 'agent' | 'project'>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): boolean {
  const folder = credentialStoreFolder(platform, home);
  if (folder === null) return false;
  return fenceExceptions(config.host.isolation, target).writable
    .map((path) => expand(path, resolve(home)))
    .some((path) => contains(path, folder) || contains(folder, path));
}

function credentialStoreFolder(platform: NodeJS.Platform, home: string): string | null {
  return platform === 'darwin' ? join(resolve(home), 'Library', 'Keychains') : null;
}
