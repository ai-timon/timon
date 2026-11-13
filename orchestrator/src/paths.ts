import { homedir } from 'node:os';
import { join, resolve as resolvePath, sep } from 'node:path';

/**
 * Guard: under the test runner, `TIMON_HOME` is MANDATORY, and it is
 * never the real home.
 *
 * Without it, a test that loads `db.ts` — even indirectly, through a module
 * that imports it — opens `~/.timon/timon.db` FOR WRITING and runs the
 * schema migrations on it. This is not theoretical: on 2026-08-21, a test
 * applied a migration under development to the production database.
 *
 * The guard lives here rather than in `db.ts` because `TIMON_HOME` is the
 * root of ALL the state (database, agents, skills, memories): targeting the real
 * folder from a test is a mistake even read-only.
 *
 * `NODE_TEST_CONTEXT` is set by the `node --test` runner itself.
 *
 * The ancestor's home is refused too: it is a frozen archive. Timon has no
 * right to read it, write it, or rename it.
 */
const REAL_PKOS_HOME = join(homedir(), '.pkos'); // public-name-ok: the archive guard refuses it by name
const REAL_TIMON_HOME = join(homedir(), '.timon');

function sameDir(a: string, b: string): boolean {
  // Normalises without touching the filesystem: `realpath` would read the archive.
  return resolvePath(a) === resolvePath(b);
}

function resolveTimonHome(): string {
  const fromEnv = process.env.TIMON_HOME;
  if (process.env.NODE_TEST_CONTEXT && (fromEnv === undefined || fromEnv === '')) {
    throw new Error(
      'TIMON_HOME is required under the test runner: without it, this test would write into '
      + `${REAL_TIMON_HOME} (the real Timon home). `
      + 'Point it at a temporary folder BEFORE the first import of the tested module, e.g.:\n'
      + "  const HOME = mkdtempSync(join(tmpdir(), 'timon-<suite>-test-'));\n"
      + "  process.env.TIMON_HOME = HOME;\n"
      + "  const { dbApi } = await import('./db.js');   // dynamic import, after the variable",
    );
  }
  const home = (fromEnv && fromEnv.length > 0) ? fromEnv : REAL_TIMON_HOME;
  if (sameDir(home, REAL_PKOS_HOME)) {
    throw new Error(
      // public-name-ok: the archive guard names what it refuses
      'TIMON_HOME refuses ~/.pkos (the frozen PKOS home). '
      + 'Timon lives in ~/.timon, or in a temporary TIMON_HOME for tests.',
    );
  }
  if (process.env.NODE_TEST_CONTEXT && sameDir(home, REAL_TIMON_HOME)) {
    throw new Error(
      'TIMON_HOME refuses the real ~/.timon under the test runner. '
      + 'Use a temporary folder (mkdtemp).',
    );
  }
  return home;
}

export const TIMON_HOME = resolveTimonHome();
export const AGENTS_DIR = join(TIMON_HOME, 'agents');
export const SKILLS_DIR = join(TIMON_HOME, 'skills');
export const PROJECTS_DIR = join(TIMON_HOME, 'projects');
export const GLOBAL_MEMORY_DIR = join(TIMON_HOME, 'memory');
export const DB_PATH = join(TIMON_HOME, 'timon.db');
export const INTEGRATIONS_DB_PATH = join(TIMON_HOME, 'integrations.db');
/** The rows of the account tables the core no longer keeps, owner-only, for the
 *  plugin that serves the accounts to read once (`users/legacy-account-tables.ts`).
 *  `config` zone: an export carries it to an install that has not run the plugin yet. */
export const LEGACY_ACCOUNT_TABLES_FILE = join(TIMON_HOME, 'legacy-account-tables.json');
/** Fallback `cwd` of the agents onboarding seeds when the config names no
 *  `workspacesRoot`: inside the Timon home, never the user's home itself. */
export const WORKSPACE_DIR = join(TIMON_HOME, 'workspace');
/** The user's instructions sent to every agent (see `global-instructions.ts`). */
export const GLOBAL_INSTRUCTIONS_FILE = join(TIMON_HOME, 'global-instructions.md');
/** Inbound channels (`telegram.json`…), read by the app and by the
 *  `telegram` module. The same path is computed on the app side in `app/src/lib/paths.ts`:
 *  the two packages are independent, so the constant is duplicated, not
 *  shared. */
export const CHANNELS_DIR = join(TIMON_HOME, 'channels');
/** User-defined custom agent roles (built-ins live in code). */
export const CUSTOM_ROLES_FILE = join(TIMON_HOME, 'roles.json');
export const BUILTIN_ROLE_OVERRIDES_FILE = join(TIMON_HOME, 'role-prompt-overrides.json');

/** Deleted agents wait here, `agents/<entry id>/`, until restored or purged
 *  (`agent-trash.ts`). Zone `config`: a backup carries what is still restorable. */
export const TRASH_DIR = join(TIMON_HOME, 'trash');
export const AGENT_TRASH_DIR = join(TRASH_DIR, 'agents');

export const agentDir = (name: string) => join(AGENTS_DIR, name);
export const agentSystemPrompt = (name: string) => join(agentDir(name), 'system-prompt.md');
export const agentConfig = (name: string) => join(agentDir(name), 'config.json');
export const agentMemoryDir = (name: string) => join(agentDir(name), 'memory');
export const agentMemoryFile = (name: string, file: string) => join(agentMemoryDir(name), file);
export const agentLog = (name: string) => join(agentMemoryDir(name), 'log.jsonl');

export const skillDir = (id: string) => join(SKILLS_DIR, id);
export const skillFile = (id: string) => join(skillDir(id), 'SKILL.md');

/** Chromium profiles of the embedded browsers, one folder per project, mounted on
 *  the container's `/config`. Holds the session, the cookies and the tabs: it
 *  SURVIVES the container's stop and is never deleted by the lifecycle
 *  (see browser-sessions.ts) — that is the whole point of a browser per project,
 *  staying logged in to a client's sites without going through authentication again. */
export const BROWSER_PROFILES_DIR = join(TIMON_HOME, 'browser-profiles');
export const browserProfileDir = (slug: string) => join(BROWSER_PROFILES_DIR, slug);

/**
 * Pid files of the child processes supervised by the daemon (`web-app`…).
 *
 * The only channel through which a local CLI command can reach a child of the
 * daemon: `timon app restart` has neither access to its memory, nor the right to go
 * through `systemctl` (a restart of the daemon would kill every living mission).
 * Rebuildable content specific to THIS machine — `cache` zone, never
 * exported.
 */
export const RUN_DIR = join(TIMON_HOME, 'run');
export const childPidFile = (label: string) => join(RUN_DIR, `${label}.pid`);

/** Third-party plugins: `plugins/` is the npm tree installed by `timon plugin add`
 *  (P.3), `plugins-data/<id>/` the working folder a plugin receives in
 *  `ctx.storage.dir` — the only place on disk it has the right to write.
 *  One folder per id, never shared: it is the file counterpart of the
 *  partitioning of `plugin_kv`.
 *
 *  Both folders are in `ZONES.config` (see below): an export
 *  therefore takes the installed plugins and their data along, restored as they are
 *  at import. See `export.test.ts` for the proof. */
export const PLUGINS_DIR = join(TIMON_HOME, 'plugins');
/** User-added backend profiles, one `<id>.json` each (docs/BACKENDS-OUVERTS.md §3). */
export const BACKENDS_DIR = join(TIMON_HOME, 'backends');
/** Notification sounds a user imported, `<userId>/<event>` + `<event>.json`
 *  (`plugins-bundled/notifications/sound-routes.ts`). Never served by path:
 *  only through the owner's authenticated route. */
export const NOTIFICATION_SOUNDS_DIR = join(TIMON_HOME, 'notification-sounds');
export const PLUGINS_DATA_DIR = join(TIMON_HOME, 'plugins-data');
export const pluginDataDir = (id: string) => join(PLUGINS_DATA_DIR, id);

/** The daemon's bearer token (Phase 4). Generated at first boot, 0600, secrets zone. */
export const DAEMON_TOKEN_FILE = join(TIMON_HOME, 'daemon-token');
/** HMAC key of the `ctx.ui.token()` tokens (§10.4). Generated at the first call, it
 *  never leaves the machine — hence the `secrets` zone. */
export const PLUGIN_TOKEN_KEY_FILE = join(TIMON_HOME, 'plugin-token-key');
/** Master key of the secrets vault (S.1), 32 bytes in base64, `0600`.
 *  File fallback when the OS keyring is missing or locked — it is the
 *  normal case for a headless daemon, not a degradation (SECRETS-VAULT §4.2).
 *  `secrets` zone: never exported, otherwise the export would carry what it takes
 *  to decrypt the database it contains. */
export const SECRET_KEY_FILE = join(TIMON_HOME, 'secret-key');
/** Candidate key of a rotation in progress (§4.5). Present only between the
 *  draw of the new key and its promotion by `rename`; at boot, its presence
 *  triggers the recovery. Same `secrets` zone as the key it replaces. */
export const PENDING_SECRET_KEY_FILE = join(TIMON_HOME, 'secret-key.next');
/** Records WHERE the master key lives when it lives in the OS keyring (S.2).
 *  Holds no secret, but stays in the `secrets` zone: exported and then restored
 *  onto a machine without a keyring, this marker would block the boot for
 *  nothing. Without it, a keyring gone unreachable would look like a fresh
 *  install — and produce a new key (SECRETS-VAULT §4.4). */
export const SECRET_KEY_LOCATION_FILE = join(TIMON_HOME, 'secret-key.location');
/** Signed offline licence. Its content is a commercial secret and is never exported. */
export const LICENSE_FILE = join(TIMON_HOME, 'license.jwt');
/** Device identifier, drawn at first need, `0600` (see `license/device.ts`).
 *  It is the `did` the licence server binds to the token: `activate` and `renew`
 *  send it, `verifyLicenseToken` compares it. `secrets` zone: exported then
 *  restored elsewhere, it would clone the device binding onto a second machine
 *  — exactly what the `did` exists to prevent. */
export const DEVICE_ID_FILE = join(TIMON_HOME, 'device-id');
/** Installation identifier sent with every mail code to the site relay
 *  (`users/install-id.ts`). Its own file: the licence `device-id` rotates on a
 *  binding conflict and the telemetry id must never meet an email. `secrets`
 *  zone, like `device-id`: a restored copy would let a second machine ask for
 *  reset codes in the owner's name. */
export const INSTALL_ID_FILE = join(TIMON_HOME, 'install-id');
/** Activation key, kept so the refresh loop can `renew` (SECU-LICENCES L-1).
 *  `0600`, zone `secrets`: it is the credential the token is minted from. */
export const LICENSE_KEY_FILE = join(TIMON_HOME, 'license.key');
/** Free recovery bearer, persisted before enrollment; never exported. */
export const LICENSE_ENROLLMENT_FILE = join(TIMON_HOME, 'license.enrollment-secret');
/** Refresh metadata and clock anchor (`every`, `offlineHours`, last server
 *  contact, highest `srv` accepted). Zone `secrets`: restored elsewhere it
 *  would carry a clock anchor that belongs to another machine (L-5). */
export const LICENSE_STATE_FILE = join(TIMON_HOME, 'license.state.json');

export const projectDir = (slug: string) => join(PROJECTS_DIR, slug);
export const projectRolesFile = (slug: string) => join(projectDir(slug), 'roles.json');
export const projectMetaFile = (slug: string) => join(projectDir(slug), 'meta.json');
/** Shared memory of a project (instructions.md, decisions.md, proposals.md…),
 *  read by buildEffectivePrompt for the PRIME injection. Distinct from the
 *  per-agent memory (agentMemoryDir). */
export const projectMemoryDir = (slug: string) => join(projectDir(slug), 'memory');
export const projectMemoryFile = (slug: string, file: string) => join(projectMemoryDir(slug), file);

/** Memory dir of a session mission (scope=session). Deleted at the end. */
export const missionMemoryDir = (agent: string, missionId: string) =>
  join(agentDir(agent), 'missions', missionId, 'memory');

/* ────────────────────────────────────────────────────────────────────────
   LOGICAL zoning of ~/.timon.

   The folder is not physically reorganised (moving `agents/` would break
   the preamble, the CLI, the app container and every agent that writes by
   path). This zoning serves export/import, the GC and the backups:
   it says what is taken along, what is never shown and what can be thrown away.
   ──────────────────────────────────────────────────────────────────────── */
export const ZONES = {
  /** Taken by an export: what describes the installation. */
  config: [
    'agents', 'projects', 'skills', 'mcp', 'memory', 'roles.json', 'apps', 'uploads',
    'timon.config.json', 'plugins', 'plugins-data', 'backends', 'notification-sounds', 'trash',
    'legacy-account-tables.json',
  ],
  /** NEVER exported, never logged. */
  secrets: ['secrets.env', 'remote-key', 'remote.db', 'daemon-token', 'update-token', 'plugin-token-key', 'secret-key', 'secret-key.next', 'secret-key.location', 'license.jwt', 'device-id', 'install-id', 'license.key', 'license.state.json', 'license.enrollment-secret'],
  /** Exported through `VACUUM INTO`, not by file copy (wal/shm).
   *  `integrations.db` carries the per-user connections and the messaging
   *  receipts (deduplication, checkpoints): outside the export, an import lost them
   *  without saying so (TODO #547). */
  state: ['timon.db', 'integrations.db'],
  /** Exported only with `--with-archive`. */
  archive: ['archive'],
  /** Rebuildable: never exported, first candidate for cleanup. */
  cache: ['run', 'worktrees', 'codex-runs', 'grok-runs', 'provider-runs', 'provider-cache', 'browser-profiles', 'tmp', 'tts', 'backups', 'plans', 'quarantine', '_salvage-e2e-parcours', 'appearance.json'],
} as const;

export type Zone = keyof typeof ZONES;

/** Exception to the zoning: in `agents/<name>/memory/`, this file is
 *  archive (tens of MB per agent), everything else is config. */
export const AGENT_ARCHIVE_FILES = ['log.jsonl'] as const;

/** Absolute path → portable: `/home/user/x` becomes `~/x`. Idempotent. */
export function portablePath(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + sep)) return '~/' + p.slice(home.length + 1);
  return p;
}

/** L'inverse : `~/x` devient `<home>/x`. Idempotent. */
export function expandPath(p: string): string {
  const home = homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}
