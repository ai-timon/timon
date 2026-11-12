/**
 * Schema of the configuration file `~/.timon/timon.config.json`.
 *
 * Every key is optional: a missing or empty file must reproduce
 * EXACTLY the current installation (`linux-desktop` profile, `expert` edition,
 * every module on `auto`). That is the condition for the migration to a
 * config-driven system to change no behaviour on the day it lands.
 *
 * The file is our own format (machine profile, host, daemon, licence, UI).
 * The `settings` section overrides the `settings.ts` registry with the same
 * `TIMON_*` keys; the `modules` section will be translated into plugin entries by
 * `kernel/registry.ts` (Phase 1).
 */
import { z } from 'zod';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

/**
 * Where this daemon is installed, inferred from the location of its own code.
 *
 * The value was hard-coded to the source checkout of the development
 * workstation. Right there, wrong everywhere else, and silently:
 * in a Windows package, `timon service install` registered a task
 * pointing at a non-existent `dist/boot.js`. The task got created, the service never
 * started, and the shell silently fell back on its embedded
 * daemon (observed 12/09/2026). The fallback on `packagedServiceOptions` only
 * covered linux and darwin.
 *
 * `<root>/dist/config/schema.js` compiled, `<root>/src/config/schema.ts`
 * under tsx: two levels up in both cases. A config file
 * keeps the last word, and `TIMON_INSTALL_DIR` above it.
 */
export function defaultInstallDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Current schema version — incremented on each migration (`config/load.ts`). */
export const CONFIG_VERSION = 1;

export const ProfileSchema = z.enum(['linux-desktop', 'linux-server', 'macos', 'windows']);
export const EditionSchema = z.enum(['expert', 'lite']);

const ListenSchema = z.object({
  host: z.string().default('127.0.0.1').describe("Listener address; use loopback for local-only access."),
  port: z.number().int().positive().default(3000).describe("TCP listening port."),
});

/** `0.0.0.0` / `::` would be every interface again — the hole TODO #339 closed. */
function isUnspecifiedAddress(value: string): boolean {
  const address = value.trim().replace(/^\[(.*)\]$/, '$1');
  return isIP(address) === 4 ? address === '0.0.0.0' : /^[0:]+$/.test(address);
}

const DaemonListenSchema = ListenSchema.extend({
  /**
   * Extra addresses the daemon also binds, WITHOUT counting as exposed: auth
   * and cookies keep following `host`. Meant for one thing — the Docker bridge
   * gateway (`172.17.0.1`), so a containerised app reaches a loopback daemon.
   * Every process able to reach such an address talks to the daemon
   * unauthenticated: never a LAN address. IP literals only, no wildcard.
   */
  extraHosts: z.array(
    z.string()
      .refine((value) => isIP(value.trim().replace(/^\[(.*)\]$/, '$1')) !== 0, { message: 'an IP address literal' })
      .refine((value) => !isUnspecifiedAddress(value), { message: 'never a wildcard address (0.0.0.0, ::)' }),
  ).default([]).describe("Unauthenticated extra listener addresses, for a container bridge only (e.g. 172.17.0.1)."),
});

export const DaemonSchema = z.object({
  listen: DaemonListenSchema.prefault({}).describe("Network listener configuration."),
  installDir: z.string().default(defaultInstallDir).describe("Absolute orchestrator installation directory; defaults to where this daemon's own code lives."),
  /**
   * Who keeps the daemon alive. `windows` = the logon scheduled task of step
   * 5.7.2 — added when the service became mandatory on the three OSes. Purely
   * additive: no existing file carries it, so no migration.
   * `none` = nobody, i.e. the desktop client runs the daemon itself.
   */
  supervisor: z.enum(['systemd-user', 'launchd', 'windows', 'none']).default('systemd-user').describe("Operating-system supervisor responsible for the daemon."),
  heapMb: z.number().int().positive().default(4096).describe("Maximum Node heap size in MiB."),
  /** `auto` = required as soon as the daemon or the WebUI listens off the loopback, or `behindTlsProxy` is set. */
  auth: z.enum(['auto', 'required', 'off']).default('auto').describe("Daemon authentication mode; auto requires authentication as soon as the daemon or the web app listens off loopback, or behind a TLS proxy."),
  /**
   * Peer addresses allowed to speak for someone else through
   * `X-Forwarded-For` (audit finding #9). Empty by default: the audit trail
   * then records the TCP peer, the only address a client cannot forge. List
   * the reverse proxy's own address here — anything else keeps its socket
   * address in the log even when it sends the header.
   */
  trustedProxies: z.array(z.string()).default([]).describe("Peer addresses trusted to supply forwarded client addresses."),
  /**
   * The daemon listens on the loopback but the browser reaches it over
   * HTTPS through a reverse proxy (Caddy, Tailscale Serve…). `listen.host`
   * alone would then say "plain HTTP" and the session cookie would go out
   * without `Secure` (SECU-USERS U-8). True forces the flag.
   */
  behindTlsProxy: z.boolean().default(false).describe("Force secure session cookies when HTTPS terminates at a reverse proxy."),
});

/** Loopback literals only: a name could resolve elsewhere, a LAN address exposes the proxy. */
function isLoopbackAddress(value: string): boolean {
  const address = value.trim().replace(/^\[(.*)\]$/, '$1');
  if (isIP(address) === 4) return address.startsWith('127.');
  return isIP(address) === 6 && (address === '::1' || /^(0{1,4}:){7}0{0,3}1$/.test(address));
}

/**
 * The daemon's egress proxy (TODO #590, option B): missions' outbound
 * traffic is journaled per mission, never blocked. `log` is the only active
 * mode; a filtering mode would be option C. The proxy authenticates every
 * client with the mission's own token, and binds the loopback only — it is
 * an open relay for whoever holds a token, so it never faces a network.
 * Port `0` lets the OS pick a free one; missions learn it from the daemon.
 */
export const EgressSchema = z.object({
  mode: z.enum(['log', 'off']).default('off').describe("Outbound proxy for missions: off (no proxy, no connection journal, the default), or log each connection per mission without blocking."),
  host: z.string()
    .refine(isLoopbackAddress, { message: 'a loopback address literal (127.0.0.1, ::1)' })
    .default('127.0.0.1')
    .describe("Loopback address the egress proxy listens on."),
  port: z.number().int().min(0).max(65_535).default(0).describe("Egress proxy port; 0 lets the system choose a free one."),
});

/**
 * Filesystem confinement of a mission (audit finding #4, `host/isolation.ts`).
 *
 * `auto` means "mask the sensitive paths wherever the launcher accepts the
 * directives". Today the mission launcher is a systemd `--scope`, which
 * rejects every `Exec*` sandboxing directive, so `auto` degrades to the
 * historical behaviour rather than breaking the spawn — the reasoning, and the
 * measurements behind it, are in `host/isolation.ts` and `docs/SECURITY.md`
 * §9.1.
 */
export const IsolationSchema = z.object({
  filesystem: z.enum(['auto', 'off']).default('auto').describe("Requested mission filesystem confinement mode; availability depends on the host launcher."),
  /** Extra paths to mask, absolute or `~/…`. Added to the built-in list. */
  deny: z.array(z.string()).default([]).describe("Additional paths requested to be hidden from missions."),
  /** Paths kept visible but read-only. */
  readOnly: z.array(z.string()).default([]).describe("Paths requested to remain visible but read-only."),
  /** Paths never masked, whatever the built-in list says. Applied last. */
  allow: z.array(z.string()).default([]).describe("Paths exempted from filesystem masking."),
  /**
   * EXTENSION POINT, not implemented (`Host.isolation.runAs`). A real boundary
   * needs the mission to run under another OS account or in a namespace, which
   * needs a privileged helper Timon does not ship. Setting it today is refused
   * loudly rather than honoured silently.
   */
  runAs: z.string().nullable().default(null).describe("Reserved OS-account isolation option; non-null values are currently refused by the runtime."),
  egress: EgressSchema.prefault({}).describe("Outbound network proxy offered to missions."),
});

export const HostSchema = z.object({
  docker: z.enum(['auto', 'required', 'disabled']).default('auto').describe("Container capability policy."),
  traefik: z.boolean().default(true).describe("Whether a Traefik deployment is available."),
  gui: z.enum(['auto', 'disabled']).default('auto').describe("Native graphical integration policy."),
  /** Absolute path (or `~/…`) of a binary; `null`/absent = looked up in the PATH. */
  binaries: z.record(z.string(), z.string().nullable()).default({}).describe("Binary names mapped to absolute paths; null uses PATH discovery."),
  /** Mission filesystem confinement (audit finding #4). */
  isolation: IsolationSchema.prefault({}).describe("Requested mission filesystem restrictions."),
});

export const AppSchema = z.object({
  /**
   * Default `false` — a deliberate departure from plan §4.3.1, which imagined it as `true`.
   * The app runs today in Compose and the orchestrator under systemd: a
   * `true` default would spawn a second Next on :3100 at the next restart
   * of the daemon, without a human gesture, contradicting the rule "missing
   * config file = current behaviour" of this schema. The switch is
   * described in `docs/REBUILD.md`.
   */
  enabled: z.boolean().default(false).describe("Whether this feature is enabled."),
  listen: ListenSchema.prefault({ host: '127.0.0.1', port: 3100 }).describe("Network listener configuration."),
  publicUrl: z.string().default('http://timon.localhost').describe("Public URL through which users reach the web app."),
});

/**
 * Value of a module in `config.modules`:
 * `true` (forced on), `false` (disabled), `"auto"` (on if its host
 * capabilities are present), or an object `{ enabled?, …options }`.
 * The object is `passthrough`: the options are specific to each module.
 */
export const ModuleSettingSchema = z.union([
  z.boolean(),
  z.literal('auto'),
  z.looseObject({ enabled: z.union([z.boolean(), z.literal('auto')]).optional().describe("Whether this feature is enabled.") }),
]);
export type ModuleSetting = z.infer<typeof ModuleSettingSchema>;

export const UiSchema = z.object({
  /** Zone ids (see plan §3.6) hidden even if the module runs. */
  hidden: z.array(z.string()).default([]).describe("UI zone identifiers hidden by instance configuration."),
  home: z.enum(['cockpit', 'chat', 'kanban']).default('cockpit').describe("Initial application destination."),
});

export const DeveloperSchema = z.object({
  /** Unset = resolved by `unsignedPluginsAllowed()` against the key registry, closed since it holds a key. */
  unsignedPlugins: z.boolean().optional().describe("Developer mode: allows unsigned plugins when `true`, on Free as on a paid licence; a licence with a fixed plugin composition still refuses them. Unset or `false` refuses them."),
});

/**
 * Secrets vault (SECRETS-VAULT.md §6.1).
 *
 * `inheritEnv` is an escape hatch, not a feature: `false` (the default) means a
 * mission only receives the system whitelist plus the secrets granted to it,
 * `true` restores the historical behaviour where every agent inherited the
 * whole daemon environment — every token included. It exists so a production
 * breakage can be undone in one gesture while it is being diagnosed, and it is
 * expected to stay `false`.
 */
export const SecretsSchema = z.object({
  inheritEnv: z.boolean().default(false).describe("Allow missions to inherit the daemon environment instead of the restricted system and granted-secret set."),
  /**
   * `auto`: the vault master key goes to the OS keyring when a real probe
   * succeeds, otherwise to the `~/.timon/secret-key` file.
   * `off`: always the file. The fallback is not a degradation — the Secret
   * Service is locked outside a graphical session and absent from a VPS
   * (`docs/SECRETS-VAULT.md` §4.2).
   */
  keyring: z.enum(['auto', 'off']).default('auto').describe("Store the vault master key in an available OS keyring, or use the local key file."),
});

/**
 * What a THIRD-PARTY plugin may do with the capabilities it declared
 * (audit finding #5). Permissions say *which* façade a plugin may call;
 * this section says *how far* that call may go.
 *
 * Every list is empty by default, and an empty list REFUSES (one exception: a
 * signed plugin may spawn without an entry, `spawn.autoApproveSigned`). The three
 * capabilities gated here are exactly the ones that reach the machine's AI
 * subscriptions: spawning missions burns them, `host:exec` calls their CLI
 * directly, and `http:outbound` carries whatever was read back out. Refusing
 * by default costs a config line to the operator who wants one of them, and
 * costs an attacker the whole path.
 */
export const PluginPolicySchema = z.object({
  spawn: z.object({
    /** Missions a single plugin may spawn per window. `0` refuses outright. */
    max: z.number().int().nonnegative().default(5).describe("Maximum missions one plugin may spawn in a window; zero denies spawning."),
    windowMs: z.number().int().positive().default(3_600_000).describe("Time window in milliseconds."),
    /**
     * Plugin ids allowed to spawn at all. A plugin absent from this list, and not
     * approved by its signature below, is refused and raises an `action_required`
     * card on its FIRST attempt: the operator sees the request instead of
     * discovering it in a quota log.
     */
    approved: z.array(z.string()).default([]).describe("Plugin IDs explicitly approved to spawn missions."),
    /**
     * A built-in or signed plugin declaring `missions:spawn` needs no entry in
     * `approved`: the distributor's signature stands for the consent (decision of
     * 2026-11-02). `false` puts every plugin back behind `approved`.
     */
    autoApproveSigned: z.boolean().default(true).describe("Approve signed and built-in plugins that declare missions:spawn without listing them in approved."),
    /** Plugin ids refused whatever else says, signature and `approved` included. */
    denied: z.array(z.string()).default([]).describe("Plugin IDs refused mission spawning, even when signed or listed in approved."),
  }).prefault({}).describe("Approval and rate limits for plugin mission spawning."),
  /** Binary basenames (or absolute paths) a plugin may `host:exec`. */
  exec: z.object({ allow: z.array(z.string()).default([]).describe("Operator allowlist; an empty list refuses access.") }).prefault({}).describe("Allowed binaries for plugin host execution; built-in denials still apply."),
  /**
   * Projects whose tasks a plugin JOB may read (`kanban:read:project`), keyed by
   * plugin id. A job otherwise sees only the tasks it created; the permission
   * says the plugin asks, this table says the operator agreed, and which projects.
   */
  kanban: z.object({
    projects: z.record(z.string(), z.array(z.string()))
      .default({})
      .describe("Plugin ID to the project slugs its jobs may read tasks of; an absent plugin reads none."),
  }).prefault({}).describe("Operator grants for plugin access to the Kanban."),
  /** Hostnames a plugin may reach; `*.example.com` covers subdomains only. */
  http: z.object({
    allow: z.array(z.string()).default([]).describe("Operator allowlist; an empty list refuses access."),
    /**
     * Hosts opened to ONE plugin, keyed by plugin id (TODO #599). Consenting
     * to the host a plugin's manifest names must not open it to every
     * `http:outbound` plugin, which `allow` would; a plugin reaches `allow`
     * plus its own entry here, never another plugin's. Same form as `allow`.
     */
    byPlugin: z.record(z.string().min(1), z.array(z.string()))
      .default({})
      .describe("Plugin ID to the hostnames that plugin alone may reach, on top of the shared allowlist."),
    /**
     * Who opens a host a USER typed in a plugin connection. `admin` by
     * default: an approved URL becomes reachable by the plugin's `ctx.fetch`.
     */
    connectionApproval: z.enum(['admin', 'owner']).default('admin').describe("Who approves the destination of a user's plugin connection: an administrator, or its owner."),
  }).prefault({}).describe("Allowed outbound hostnames; a wildcard covers subdomains only."),
});

/**
 * Online brute-force protection on the credential endpoints (audit finding
 * #6): login, invitation acceptance and invitation peek.
 *
 * Two buckets are counted for every attempt — the caller's address and the
 * subject it aims at (the submitted email, or the invitation token hash).
 * Both must be under their threshold; a lockout on either refuses. Keying on
 * the submitted email rather than on an existing account is what keeps the
 * answer free of an existence oracle: an unknown address is counted exactly
 * like a real one.
 *
 * `trustProxy` says which address to count. `false` (default) counts the TCP
 * peer, the only address a client cannot forge. `true` counts the first hop of
 * `X-Forwarded-For` — correct ONLY behind a reverse proxy that rewrites the
 * header, since every peer address is then the proxy's and a single attacker
 * would lock every user out.
 */
export const AuthThrottleSchema = z.object({
  enabled: z.boolean().default(true).describe("Whether this feature is enabled."),
  /** Failed attempts allowed inside `windowMs` before the first lockout. */
  maxAttempts: z.number().int().positive().default(5).describe("Failed credential attempts allowed before lockout."),
  /** Idle time after which a bucket that is not locked forgets its failures. */
  windowMs: z.number().int().positive().default(900_000).describe("Time window in milliseconds."),
  /** First lockout; each further failure doubles it, up to `maxLockoutMs`. */
  lockoutMs: z.number().int().positive().default(60_000).describe("Initial credential lockout duration in milliseconds."),
  maxLockoutMs: z.number().int().positive().default(3_600_000).describe("Maximum credential lockout duration in milliseconds."),
  trustProxy: z.boolean().default(false).describe("Use forwarded client addresses for throttling only behind a proxy that rewrites them."),
});

/**
 * Anonymous usage statistics (`@timon/telemetry`). The value accepts anything
 * on purpose: a typed one would refuse the whole file over a `null` or a
 * `"maybe"`, while the telemetry itself (`parseToggle`) reads anything that is
 * not a clear yes or no as NO. Fail-closed for this switch, without taking the
 * rest of the configuration down with it.
 */
export const TelemetrySchema = z.object({
  // Documented as the boolean it is meant to be; accepted as anything.
  enabled: z.unknown().optional().meta({
    type: 'boolean',
    description: "Share anonymous usage statistics: true or false. Unset follows the app setting (on by default); any other value turns sharing off without invalidating the file. The TIMON_TELEMETRY environment variable overrides it.",
  }),
});

export const TimonConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION).describe("Configuration schema version."),
  profile: ProfileSchema.default('linux-desktop').describe("Host platform profile."),
  edition: EditionSchema.default('expert').describe("Requested edition; the effective edition remains constrained by the licence."),
  // No default: an absent key means agents seeded by onboarding work in
  // `<TIMON_HOME>/workspace`, never in a folder guessed from one machine.
  workspacesRoot: z.string().optional().describe("Working folder of the agents created during onboarding; when unset, they use the workspace folder inside the Timon home."),
  daemon: DaemonSchema.prefault({}).describe("Daemon process and listener configuration."),
  host: HostSchema.prefault({}).describe("Host capabilities and binary configuration."),
  app: AppSchema.prefault({}).describe("Web app served as a daemon-managed child process."),
  modules: z.record(z.string(), ModuleSettingSchema).default({}).describe("Bundled module IDs mapped to enabled state or module-specific options."),
  /**
   * THIRD-PARTY plugins (§10.5), indexed by their manifest id — not by their
   * npm package name: it is the id that governs routes, storage and data
   * folder, and it is the one the user sees. Same shape as `modules`
   * (`false` disables, an object passes its keys to `apply`), with one
   * nuance: a plugin missing from this table is ACTIVE. Installing a plugin is
   * already an explicit act; requiring a second declaration for it to run
   * would make `timon plugin add` a command with no visible effect.
   */
  plugins: z.record(z.string(), ModuleSettingSchema).default({}).describe("Third-party manifest IDs mapped to enabled state or plugin options; absent installed plugins are enabled."),
  developer: DeveloperSchema.prefault({}).describe("Developer-mode preferences."),
  /** Limits applied to third-party plugin capabilities (audit finding #5). */
  pluginPolicy: PluginPolicySchema.prefault({}).describe("Operator ceilings on third-party plugin capabilities."),
  /** Back-off and lockout on the credential endpoints (audit finding #6). */
  authThrottle: AuthThrottleSchema.prefault({}).describe("Credential endpoint back-off and lockout policy."),
  secrets: SecretsSchema.prefault({}).describe("Secret injection and master-key storage preferences."),
  ui: UiSchema.prefault({}).describe("Instance UI visibility and home preferences."),
  telemetry: TelemetrySchema.prefault({}).describe("Anonymous usage statistics sent to the Timon team."),
  /** Overrides of the `settings.ts` registry, same `TIMON_*` keys. */
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}).describe("Registry overrides keyed by setting name; environment overrides still take precedence."),
});

export type TimonConfig = z.infer<typeof TimonConfigSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Edition = z.infer<typeof EditionSchema>;
