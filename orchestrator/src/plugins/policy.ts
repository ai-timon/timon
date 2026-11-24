/**
 * Limits on the three plugin capabilities that reach the machine's AI
 * subscriptions (audit finding #5, `docs/AUDIT-SECU.md`).
 *
 * The façade of `context.ts` decides WHICH capability a plugin holds; this
 * module decides how far each one may go. The distinction matters because the
 * dangerous paths in the audit are all *legitimate* uses of declared
 * permissions: `missions:spawn` in a loop burns the `claude` / `codex`
 * subscription, `host:exec` calls those CLIs directly, and `http:outbound`
 * carries whatever was read back out. A permission bit cannot express "yes,
 * but not that binary" — a policy can.
 *
 * Everything here is deny-by-default and configurable in
 * `pluginPolicy` (`config/schema.ts`). It does NOT make a plugin safe: a
 * loaded plugin is T1 and can bypass this module like any other in-process
 * check (SECURITY.md §9). It closes the paths a plugin takes *without having
 * to look hostile*, and it makes the hostile ones leave a trace.
 */
import { daemonMessage, type DaemonMessage } from '../daemon-message.js';
import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { CONFIG_FILE, config, loadConfig, setConfig } from '../config/load.js';
import { getHost } from '../host/index.js';
import type { Assert, Equals } from '../type-equality.js';
import type { PluginPolicyError as ContractPluginPolicyError } from './contract/core.js';

/** Refusal by policy — distinct from `PluginPermissionError` (undeclared). */
export class PluginPolicyError extends Error {
  override readonly name: 'PluginPolicyError';
  constructor(readonly pluginId: string, readonly rule: string, message: string) {
    super(`plugin \`${pluginId}\` refused (${rule}): ${message}`);
    this.name = 'PluginPolicyError';
  }
}
/** The SDK publishes this class's shape (`contract/core.ts`); it cannot drift from it. */
type _PolicyErrorMatchesContract = Assert<Equals<PluginPolicyError, ContractPluginPolicyError>>;

/**
 * Never executable by a plugin, whatever the allowlist says.
 *
 * These are not "sensitive binaries", they are the subscriptions and the
 * daemon itself: `claude` / `codex` ARE the paid accounts Timon runs on,
 * `git-credential-*` hands out the git tokens, and `timon` drives the daemon
 * with the operator's own rights. An operator who allowlists one of them has
 * almost certainly not understood the consequence, so the list is absolute
 * rather than a default.
 *
 * The CLI of the product's discontinued ancestor is kept here on purpose: the
 * binary still exists on the development machine, and running it would write
 * into the ancestor's home — an archive frozen precisely because it holds data
 * no other copy has.
 */
const SUBSCRIPTION_CLIS = ['claude', 'codex'];
const EXEC_DENIED = [...SUBSCRIPTION_CLIS, 'timon', 'pkos']; // public-name-ok: the archive guard refuses it by name

/**
 * Whether `bin` is one of the subscription CLIs above. The one exemption a mission launch knows
 * (`backends/launch-binary.ts`): an official provider may launch the subscription CLI it declares.
 * Written here, fail-closed, rather than read from the providers' manifests: a list a missing or
 * altered manifest could shorten would stop protecting the subscription at the moment it matters.
 */
export function isSubscriptionCli(bin: string): boolean {
  return SUBSCRIPTION_CLIS.includes(binKey(bin));
}
const EXEC_DENIED_PREFIX = ['git-credential'];

/**
 * Generic launchers — refused for a different reason, and never allowlistable.
 *
 * A denylist that compares basenames is worth exactly nothing if the allowlist
 * may contain a binary whose job is to run ANOTHER command handed to it:
 * `sh -c "claude -p …"` reaches the subscription with `sh` as the binary this
 * module sees. The criterion is that, not a catalogue of "scripting tools":
 * anything that takes a command line and executes it (shells, interpreters,
 * `env` / `xargs` / `find -exec`, the wrappers that exec through, the package
 * runners, the container CLIs).
 *
 * WHAT THIS DOES NOT BUY, said plainly — the guarantee above is name-based and
 * that is all it is:
 *  - a renamed or copied interpreter (`/opt/tools/report` that is a `bash`
 *    build) is allowlisted like any other path; nothing here inspects the file;
 *  - argv is never examined, so an allowlisted binary that runs a command of
 *    its own (`rsync -e …`, `git -c alias.x='!cmd'`, `ssh` config) is a hole
 *    the operator opens by allowlisting it. `git` is deliberately left
 *    allowlistable — plugins legitimately need it — and it is one of those.
 * The list closes the paths a plugin takes without having to look hostile. A
 * plugin is T1 code in this process (`docs/SECURITY.md` §9) and can bypass all
 * of it; what it cannot do is claim the bypass was an accident.
 */
const EXEC_DENIED_LAUNCHERS = [
  // shells
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'busybox',
  'cmd', 'powershell', 'pwsh', 'wscript', 'cscript',
  // interpreters
  'node', 'deno', 'bun', 'python', 'python2', 'python3', 'perl', 'ruby', 'php',
  'awk', 'gawk', 'mawk', 'tclsh', 'lua', 'osascript',
  // "run this command for me" wrappers
  'env', 'xargs', 'find', 'nohup', 'setsid', 'timeout', 'stdbuf', 'flock',
  'nice', 'ionice', 'unshare', 'chroot', 'script', 'watch', 'parallel',
  'sudo', 'doas', 'su', 'ssh', 'systemd-run', 'make',
  // package runners and container CLIs: `npx claude`, `docker run … claude`
  'npm', 'npx', 'yarn', 'pnpm', 'bunx', 'uvx', 'pipx',
  'docker', 'podman', 'nerdctl',
];

/** Comparable form of a binary: basename, no Windows extension, lowercase. */
export function binKey(bin: string): string {
  return basename(bin).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** Why `bin` can never be executed by a plugin, or `null`. Name-based, like the lists above. */
export function execDeniedReason(bin: string): string | null {
  const key = binKey(bin);
  if (EXEC_DENIED.includes(key) || EXEC_DENIED_PREFIX.some((p) => key.startsWith(p))) {
    return `\`${key}\` is never executable by a plugin`;
  }
  if (EXEC_DENIED_LAUNCHERS.includes(key)) {
    return `\`${key}\` runs whatever command it is handed (\`${key} … claude\`), which would re-open the `
      + 'denylist by indirection — no allowlist grants a generic launcher';
  }
  return null;
}

/**
 * The absolute path a bare name resolves to on this host, or `null`. This is
 * what the operator authorizes for a provider (`exec-grants.ts`), so the same
 * resolution must be what the policy compares against.
 */
export function resolveExecutable(bin: string): string | null {
  try { return getHost().bin(bin); } catch { return null; }
}

/**
 * The file a path really names: every link followed, `.`/`..` gone (`realpathSync.native`, which on
 * Windows also returns the case the file system stores). A path that does not resolve keeps its
 * absolute form: what is compared is then the name, and nothing launches from it.
 */
export function canonicalPath(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/**
 * The file a program name launches on this host: `resolveExecutable`, then `canonicalPath`. A link the
 * operator authorized through is not what runs — its target is, and a retargeted link is another program.
 */
export function canonicalExecutable(bin: string): string | null {
  const resolved = resolveExecutable(bin);
  return resolved ? canonicalPath(resolved) : null;
}

/** Paths compare case-insensitively on Windows, where the file system does. */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Throws unless `bin` is allowlisted and outside the absolute denylist.
 * Returns the binary the caller must launch: for a bare name granted through an
 * ABSOLUTE entry it is the resolved path itself, so the spawn cannot land on
 * another program if the search path moves between this check and the launch.
 */
export function assertExecAllowed(pluginId: string, bin: string): string {
  const denied = execDeniedReason(bin);
  if (denied) throw new PluginPolicyError(pluginId, 'host:exec', denied);
  const allow = config().pluginPolicy.exec.allow;
  const key = binKey(bin);
  // A name granted by name keeps its historical meaning: whatever the host resolves.
  if (allow.some((entry) => !isAbsolute(entry) && binKey(entry) === key)) return bin;
  if (allow.some((entry) => isAbsolute(entry) && entry === bin)) return bin;
  // An authorization writes the file itself (`exec-grants.ts`): a path that is a link to it names it too.
  if (isAbsolute(bin)) {
    const target = canonicalPath(bin);
    if (allow.some((entry) => isAbsolute(entry) && samePath(entry, target))) return bin;
  }
  // A bare name granted by the path the operator saw at authorization time.
  if (!isAbsolute(bin)) {
    const resolved = resolveExecutable(bin);
    if (resolved) {
      // The resolved target is checked too: an alias that points at `claude` is still `claude`.
      const deniedTarget = execDeniedReason(resolved);
      if (deniedTarget) throw new PluginPolicyError(pluginId, 'host:exec', deniedTarget);
      const target = canonicalPath(resolved);
      if (allow.some((entry) => isAbsolute(entry) && (samePath(entry, resolved) || samePath(entry, target)))) return resolved;
    }
  }
  throw new PluginPolicyError(
    pluginId,
    'host:exec',
    allow.length
      ? `\`${key}\` is not in pluginPolicy.exec.allow`
      : '`pluginPolicy.exec.allow` is empty — no binary is executable by a plugin',
  );
}

/** `example.com` matches itself; `*.example.com` matches subdomains only. */
function hostMatches(entry: string, host: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e.startsWith('*.')) return host.endsWith(e.slice(1)) && host.length > e.length - 1;
  return e === host;
}

/**
 * Whether allowlist `entry` already opens everything a DECLARED host names
 * (`http.hosts`, TODO #599). A declared wildcard is covered only by a wildcard
 * at the same or a parent level: `api.acme.com` does not open `*.acme.com`.
 */
export function hostCovers(entry: string, declared: string): boolean {
  const host = declared.trim().toLowerCase();
  if (!host.startsWith('*.')) return hostMatches(entry, host);
  const e = entry.trim().toLowerCase();
  return e.startsWith('*.') && host.slice(1).endsWith(e.slice(1));
}

/** URL an outbound call targets, whatever shape `fetch` was handed. */
function targetUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const url = (input as { url?: unknown } | null)?.url;
  if (typeof url === 'string') return url;
  throw new Error('unreadable fetch target');
}

/**
 * The hosts the operator opened to this plugin alone (`pluginPolicy.http.byPlugin`).
 * Own keys only: an id such as `constructor` must not read the prototype, and
 * an empty id (no caller to name) has no entry by construction.
 */
export function pluginHttpHosts(pluginId: string): readonly string[] {
  if (!pluginId) return [];
  const table = config().pluginPolicy.http.byPlugin;
  if (!Object.prototype.hasOwnProperty.call(table, pluginId)) return [];
  const hosts: unknown = table[pluginId];
  return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string') : [];
}

/**
 * Throws unless the target host is allowlisted (and the scheme is http(s)):
 * in the shared `allow`, or in the caller's own `byPlugin` entry — never in
 * another plugin's.
 */
export function assertFetchAllowed(pluginId: string, input: unknown): void {
  let url: URL;
  try { url = new URL(targetUrl(input)); }
  catch { throw new PluginPolicyError(pluginId, 'http:outbound', 'unreadable target URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PluginPolicyError(pluginId, 'http:outbound', `scheme \`${url.protocol}\` refused`);
  }
  const allow = config().pluginPolicy.http.allow;
  const own = pluginHttpHosts(pluginId);
  const host = url.hostname.toLowerCase();
  if (!allow.some((entry) => hostMatches(entry, host)) && !own.some((entry) => hostMatches(entry, host))) {
    throw new PluginPolicyError(
      pluginId,
      'http:outbound',
      allow.length || own.length
        ? `host \`${url.hostname}\` is neither in pluginPolicy.http.allow nor opened to this plugin (pluginPolicy.http.byPlugin)`
        : 'no host is reachable by this plugin — pluginPolicy.http.allow is empty and nothing is opened to it in pluginPolicy.http.byPlugin',
    );
  }
}

/** `live`, keeping only what `disk` still grants. The same object when nothing goes. */
function narrowGrantTable(live: Record<string, string[]>, disk: Record<string, string[]>): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  let changed = false;
  for (const [id, values] of Object.entries(live)) {
    const held = Object.prototype.hasOwnProperty.call(disk, id) ? disk[id]! : null;
    const kept = held ? values.filter((value) => held.includes(value)) : [];
    if (kept.length !== values.length) changed = true;
    if (held) next[id] = kept;
  }
  return changed ? next : live;
}

/**
 * Withdraws from this process the grants by plugin id that the operator's file
 * no longer holds: `spawn.approved`, `kanban.projects`, `http.byPlugin`. Takes
 * in what restricts: an id added to `spawn.denied`, `spawn.autoApproveSigned`
 * turned off.
 *
 * `timon plugin remove` edits the file from ANOTHER process, while the daemon
 * answers from the copy it read at boot: the next package installed under that
 * id, hot, would inherit what nobody granted it until the next restart (TODO
 * #663). Compared with the file rather than dropped by id when a package leaves
 * the disk, for two reasons: `npm` replacing a package during an update makes it
 * absent for a moment, which must not cost it its approval; and a remove followed
 * at once by an add may never show the daemon a package missing.
 *
 * Narrows only. A grant ADDED to the file still waits for a restart, as it always
 * did. An unreadable file says nothing about what the operator meant: nothing moves.
 */
export function narrowLivePluginGrants(file: string = CONFIG_FILE): void {
  if (!existsSync(file)) return;
  let disk: ReturnType<typeof config>['pluginPolicy'];
  try { disk = loadConfig(file, { readonly: true }).pluginPolicy; } catch { return; }
  const live = config();
  const policy = live.pluginPolicy;
  const approved = policy.spawn.approved.filter((id) => disk.spawn.approved.includes(id));
  // A refusal, or the signature no longer standing for a consent, narrows as well.
  const denied = [...policy.spawn.denied, ...disk.spawn.denied.filter((id) => !policy.spawn.denied.includes(id))];
  const autoApproveSigned = policy.spawn.autoApproveSigned && disk.spawn.autoApproveSigned;
  const projects = narrowGrantTable(policy.kanban.projects, disk.kanban.projects);
  const byPlugin = narrowGrantTable(policy.http.byPlugin, disk.http.byPlugin);
  if (approved.length === policy.spawn.approved.length && denied.length === policy.spawn.denied.length
    && autoApproveSigned === policy.spawn.autoApproveSigned
    && projects === policy.kanban.projects && byPlugin === policy.http.byPlugin) return;
  setConfig({
    ...live,
    pluginPolicy: {
      ...policy,
      spawn: { ...policy.spawn, approved, denied, autoApproveSigned },
      kanban: { ...policy.kanban, projects },
      http: { ...policy.http, byPlugin },
    },
  });
}

/**
 * Drops one id's grants from this process, whatever the file says: another package
 * took the id (`package-binding.ts`), and a file failing the schema must not keep
 * them alive here (`narrowLivePluginGrants` moves nothing in that case). A
 * `spawn.denied` entry stays: a refusal handed down to the next package costs
 * nobody anything.
 */
export function forgetLivePluginGrants(pluginId: string): void {
  const live = config();
  const policy = live.pluginPolicy;
  const has = (table: Record<string, string[]>) => Object.prototype.hasOwnProperty.call(table, pluginId);
  if (!policy.spawn.approved.includes(pluginId) && !has(policy.kanban.projects) && !has(policy.http.byPlugin)) return;
  const without = (table: Record<string, string[]>) => Object.fromEntries(Object.entries(table).filter(([id]) => id !== pluginId));
  setConfig({
    ...live,
    pluginPolicy: {
      ...policy,
      spawn: { ...policy.spawn, approved: policy.spawn.approved.filter((id) => id !== pluginId) },
      kanban: { ...policy.kanban, projects: without(policy.kanban.projects) },
      http: { ...policy.http, byPlugin: without(policy.http.byPlugin) },
    },
  });
}

/* ── missions:spawn — approval, then quota ────────────────────────────────── */

/** Spawn timestamps per plugin, kept only for the current window. */
const SPAWNS = new Map<string, number[]>();
/** Plugins whose refusal card has already been raised in this process. */
const CARDED = new Set<string>();
/** Plugins whose spawn card was looked for and closed since their last refusal. */
const CLEARED = new Set<string>();

/** How the loader admitted a mounted plugin: the package's trust and whether its manifest declares `missions:spawn`. */
export type PluginSpawnStanding = { trust: 'builtin' | 'signed' | 'unsigned'; declaresSpawn: boolean };

/**
 * Plugins mounted right now, as the loader admitted them. Fed at mount and
 * emptied at unmount, so a spawn never reads a signature off the disk, and a
 * plugin no longer mounted (its routines still firing, say) falls back to the
 * operator's list.
 */
const MOUNTED = new Map<string, PluginSpawnStanding>();

/** Called by the loader: a standing at mount, `null` at unmount. */
export function setPluginSpawnStanding(pluginId: string, standing: PluginSpawnStanding | null): void {
  if (standing) MOUNTED.set(pluginId, standing);
  else MOUNTED.delete(pluginId);
}

/** Built in or signed: the product's keys vouch for the package, and it asked for the permission. */
function vouchedSpawner(pluginId: string): boolean {
  const standing = MOUNTED.get(pluginId);
  return standing !== undefined && standing.trust !== 'unsigned' && standing.declaresSpawn;
}

/** Test seam: forget the sliding windows, the cards already raised and the mounted plugins. */
export function resetPluginPolicyState(): void {
  SPAWNS.clear();
  CARDED.clear();
  CLEARED.clear();
  MOUNTED.clear();
}

/** Anchor of a plugin's spawn cards (approval and quota): a spawn that goes through closes them. */
const spawnCardAnchor = (pluginId: string): string => `plugin-spawn:${pluginId}`;

/**
 * Card writes, one after the other: a close queued after a raise must land
 * after it, or the card it answers would stay open. Never rejects.
 */
let cardWrites: Promise<void> = Promise.resolve();
function queueCardWrite(write: (notifications: typeof import('../notifications.js')) => unknown): void {
  cardWrites = cardWrites
    .then(() => import('../notifications.js'))
    .then((notifications) => { write(notifications); })
    .catch(() => { /* no notification subsystem here: the refusal stands either way */ });
}

/**
 * Resolves once every card raised or closed so far is written. Callers keep
 * firing and forgetting; tests await this instead of polling against a clock,
 * which the `import()` above loses under load (TODO #629).
 */
export function spawnCardsSettled(): Promise<void> {
  return cardWrites;
}

/** The plugin spawned after all: its card is answered, and a later refusal may raise a new one. */
function closeCard(pluginId: string): void {
  // Once per process and plugin: a card raised before a restart is not in CARDED, yet still shown.
  if (CLEARED.has(pluginId)) return;
  CLEARED.add(pluginId);
  CARDED.delete(pluginId);
  queueCardWrite(({ resolveAnchor }) => resolveAnchor(spawnCardAnchor(pluginId)));
}

/**
 * The plugin is gone (TODO #663): its card asks for an approval of an id nobody
 * installed any more. Forgets what this process carded, so a reinstall's first
 * refusal raises a card of its own. Awaitable, unlike the writes above: the CLI
 * exits right after. Called by the remover, then by the daemon once it sees the
 * package gone (only it can close the card on the devices).
 */
export function closePluginSpawnCards(pluginId: string): Promise<void> {
  CARDED.delete(pluginId);
  CLEARED.delete(pluginId);
  queueCardWrite(({ resolveGoneAnchor }) => resolveGoneAnchor(spawnCardAnchor(pluginId)));
  return spawnCardsSettled();
}

/**
 * The card the operator sees the first time a plugin tries to spawn.
 *
 * Fire-and-forget on purpose: a notification subsystem that is absent (tests,
 * CLI) must not turn a refusal into a crash, and the refusal below stands
 * either way — the card informs, it does not decide.
 */
function raiseCard(pluginId: string, title: string, body: string, message: DaemonMessage): void {
  if (CARDED.has(pluginId)) return;
  CARDED.add(pluginId);
  CLEARED.delete(pluginId);
  queueCardWrite(({ createNotification }) => createNotification({
    type: 'action_required',
    urgent: true,
    title,
    body,
    source: `plugin:${pluginId}`,
    anchor: spawnCardAnchor(pluginId),
    message,
  }));
}

/**
 * The projects whose tasks this plugin's JOBS may read: what the operator wrote
 * in `pluginPolicy.kanban.projects[<pluginId>]`, nothing when absent. The
 * manifest's `kanban:read:project` only asks; this is the grant. A request is
 * not widened by it — a request sees what its user sees.
 */
export function grantedKanbanProjects(pluginId: string): readonly string[] {
  const table = config().pluginPolicy.kanban.projects;
  return Object.prototype.hasOwnProperty.call(table, pluginId) ? table[pluginId]! : [];
}

/**
 * A signed or built-in plugin declaring `missions:spawn` is approved without an
 * entry (decision of 2026-11-02): the distributor's signature stands for the
 * operator's consent, and a fresh install must not stop on a config file nobody
 * can edit from the app. `denied` overrides everything, and `autoApproveSigned:
 * false` puts every plugin back behind `approved`. The quota is not decided here.
 */
function requireSpawnApproval(pluginId: string, via: string): void {
  const policy = config().pluginPolicy.spawn;
  if (policy.denied.includes(pluginId)) {
    throw new PluginPolicyError(
      pluginId,
      'missions:spawn',
      'listed in `pluginPolicy.spawn.denied` — remove it from timon.config.json to allow it',
    );
  }
  if (policy.approved.includes(pluginId)) return;
  if (policy.autoApproveSigned && vouchedSpawner(pluginId)) return;
  // Said only when known: a plugin not mounted any more may well be signed.
  const unsigned = MOUNTED.get(pluginId)?.trust === 'unsigned';
  raiseCard(
    pluginId,
    `Plugin \`${pluginId}\` wants to spawn missions`,
    `It called \`${via}\`, which consumes this machine's AI subscriptions. `
    + (unsigned ? 'It is not signed, so it is not approved automatically. ' : '')
    + `Add \`${pluginId}\` to \`pluginPolicy.spawn.approved\` in timon.config.json to allow it.`,
    daemonMessage('plugin_spawn_requested', { pluginId, via, unsigned: unsigned ? 'yes' : 'no' }),
  );
  throw new PluginPolicyError(
    pluginId,
    'missions:spawn',
    `${unsigned ? 'unsigned plugin, ' : ''}not in \`pluginPolicy.spawn.approved\` — approve it in timon.config.json`,
  );
}

/**
 * Throws unless the operator approved this plugin for spawning — the approval
 * alone, no quota consumed. For the moment work is SCHEDULED to run later as
 * the plugin (a routine, a trigger that opens tasks): refusing it then beats
 * storing something that will be refused at every tick (TODO #591). The quota
 * is taken when the work actually runs, by `assertSpawnAllowed`.
 *
 * Going through answers the plugin's card: a weekly routine would otherwise
 * leave "wants to spawn" on screen for days after the operator approved it.
 */
export function assertSpawnApproved(pluginId: string, via: string = 'ctx.missions.spawn'): void {
  requireSpawnApproval(pluginId, via);
  closeCard(pluginId);
}

/**
 * Throws unless the plugin is approved for spawning AND under its quota.
 *
 * Approval is the "permission card at first spawn" the audit asks for, in the
 * shape this daemon can actually hold: a spawn from a plugin job has no
 * mission to anchor an interactive card to and nobody to wait for, so the
 * first attempt is REFUSED and raises an `action_required` card naming the
 * config line that would grant it. A blocking prompt would either hang a
 * background job forever or auto-deny it silently.
 *
 * `via` names the call on the card: a task that runs, opened by a job, a
 * webhook delivery or an event handler (`ctx.kanban.add`), is a deferred spawn and shares this
 * approval and this quota (TODO #562) — so do the tasks of a plugin's routine
 * tick, of its trigger's run, and a pipeline or workflow run with nobody in
 * front (TODO #591).
 *
 * `count` is how many tasks that run the call opens at once (a pipeline run
 * opens one per step): all fit in the window or none is taken, so a run is
 * never cut in half.
 */
export function assertSpawnAllowed(pluginId: string, now: number = Date.now(), via: string = 'ctx.missions.spawn', count: number = 1): void {
  const policy = config().pluginPolicy.spawn;
  requireSpawnApproval(pluginId, via);
  const window = SPAWNS.get(pluginId)?.filter((t) => now - t < policy.windowMs) ?? [];
  if (window.length + count > policy.max) {
    SPAWNS.set(pluginId, window);
    raiseCard(
      pluginId,
      `Plugin \`${pluginId}\` hit its spawn quota`,
      `${window.length} missions in ${Math.round(policy.windowMs / 60_000)} min`
      + `${count > 1 ? `, and \`${via}\` asked for ${count} more` : ''}. `
      + 'Raise `pluginPolicy.spawn.max` if this is expected.',
      daemonMessage('plugin_spawn_quota', {
        pluginId, count: window.length, minutes: Math.round(policy.windowMs / 60_000), via, extra: count > 1 ? count : 0,
      }),
    );
    throw new PluginPolicyError(
      pluginId,
      'missions:spawn',
      `quota reached (${policy.max} per ${Math.round(policy.windowMs / 60_000)} min${count > 1 ? `, ${count} asked at once` : ''})`,
    );
  }
  for (let i = 0; i < count; i++) window.push(now);
  SPAWNS.set(pluginId, window);
  closeCard(pluginId);
}

/**
 * The binary a PROVIDER plugin runs for its own CLI (`ctx.provider.binary`,
 * `registerProvider`). A plugin shipped inside the release (`trusted`, verified
 * against the signed inventory) is not asked for an allowlist entry and may name
 * the subscription CLIs it declares in its manifest — `PROVIDERS-SDK.md` § 12
 * question 4, case (ii), for the program the manifest names and nothing broader.
 * What stays refused to EVERYONE: a generic launcher, `timon`, its ancestor's CLI, a git
 * credential helper. Any other plugin: exactly `assertExecAllowed`.
 *
 * Returns the program to launch, like `assertExecAllowed`.
 */
export function assertProviderExecAllowed(pluginId: string, bin: string, options: { trusted: boolean }): string {
  if (!options.trusted) return assertExecAllowed(pluginId, bin);
  const key = binKey(bin);
  const subscriptionCli = key === 'claude' || key === 'codex';
  const denied = execDeniedReason(bin);
  if (denied && !subscriptionCli) throw new PluginPolicyError(pluginId, 'host:exec', denied);
  return bin;
}
