/**
 * Which package holds a plugin id (TODO #671).
 *
 * What a human grants a plugin names its id: vault grants, `pluginPolicy` entries,
 * user connections and their keys. `timon plugin remove` withdraws them, but a
 * package can leave otherwise (folder deleted, `npm uninstall`, a manifest
 * unreadable at removal), and the next package under that id, another author's
 * included, would inherit all of it. So the daemon remembers which package holds
 * each id, and withdraws everything the moment another one takes it, before any
 * of its code runs.
 *
 * Decided when a package SHOWS UP, never when one leaves: `npm` can take a package
 * off the disk for the length of an update, and a loader pass in that window would
 * destroy the keys of a plugin nobody removed (`PluginLoader.onRemoved` is not the
 * place). A package with no manifest or no admission never gets here either, so it
 * takes nothing away from anyone.
 *
 * The record is one row per id and survives a removal on purpose: a removal that
 * could not read the manifest purged nothing, and the record still catches the
 * next package. Webhook secrets are not handled here: they carry their own binding
 * (`webhooks.ts`, TODO #575) and ask for a regeneration instead of disappearing.
 *
 * A plugin's data outlives a removal by decision, so that a reinstall finds it,
 * but it was written by and for THAT package: when another one takes the id, it
 * gets none of it. Settings of type `secret` are deleted (TODO #675), then every
 * other setting and the free `plugin_kv`, and the data folder is moved aside
 * (TODO #677): a credential kept anywhere in there would otherwise change hands.
 * The folder goes to a dated trash rather than nowhere: the operator may still
 * want what the previous package wrote.
 */
import { daemonMessage } from '../daemon-message.js';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CONFIG_FILE } from '../config/load.js';
import { dbApi } from '../db.js';
import { PLUGINS_DATA_DIR, pluginDataDir } from '../paths.js';
import { PLUGIN_CONNECTION_KV_PREFIX, PLUGIN_SETTING_KV_PREFIX } from '../secrets/store.js';
import { closePluginLaunchCard } from '../backends/launch-card.js';
import { closePluginSecretCards, deletePluginSecretSettings, revokePluginSecretGrants } from '../secrets/plugins.js';
import { disablePluginAutomations, type PluginAutomations } from './automation-cleanup.js';
import { forgetPluginHttpHosts, forgetPluginPolicyGrants } from './install.js';
import { closePluginSpawnCards, forgetLivePluginGrants } from './policy.js';
import { withdrawPluginUserConnections } from './user-connections-host.js';
import type { PluginWebhookPublisher } from './webhooks.js';

/**
 * The same two facts as a webhook secret's publisher, for the same reasons, and
 * the keys its manifest declares as `secret`: that manifest is gone by the time
 * they have to be deleted. They do not take part in telling two packages apart.
 */
export type PluginPackage = PluginWebhookPublisher & { secretSettings?: readonly string[] };

/** `plugin_kv` namespace of the records: no manifest id can take it. */
export const PLUGIN_PACKAGE_STORE = '@timon/plugin-packages';

/**
 * Where the data folder of a package that lost its id goes. Inside
 * `plugins-data/` so the move is a rename on one volume, never a copy; a manifest
 * id cannot start with a dot, so no plugin owns this name.
 */
export const PLUGIN_DATA_TRASH_DIR = join(PLUGINS_DATA_DIR, '.trash');

const PackageSchema = z.object({
  pkg: z.string().min(1),
  trust: z.enum(['builtin', 'signed', 'unsigned']),
  secretSettings: z.array(z.string()).optional(),
});

function parseRecord(raw: string): PluginPackage | null {
  try {
    const parsed = PackageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function boundPluginPackage(id: string): PluginPackage | null {
  const raw = dbApi.pluginKvGet(PLUGIN_PACKAGE_STORE, id);
  return raw === undefined ? null : parseRecord(raw);
}

/**
 * Every record, by id. Read by an install BEFORE npm runs: the daemon's next
 * pass may settle the package it lands before the install reports on it.
 */
export function boundPluginPackages(): Map<string, PluginPackage> {
  const records = new Map<string, PluginPackage>();
  for (const { key, value } of dbApi.pluginKvList(PLUGIN_PACKAGE_STORE)) {
    const record = parseRecord(value);
    if (record) records.set(key, record);
  }
  return records;
}

/**
 * Does `incoming` keep what was granted to `bound`, the package on record? Same
 * npm name first. Then the signature, in one direction only: built in and signed
 * are one side, both vouched for by the product's own keys, so a built-in moved
 * to the registry, or one the release starts signing, stays the same plugin. A
 * signed package also keeps what an unsigned copy of its name held: only the
 * holder of the keys can produce it, so it hands nothing to a stranger, and the
 * testers of an unsigned release candidate keep their data when the signed one
 * lands. The reverse is a takeover: anyone can build an unsigned package under
 * the official name.
 */
export function keepsPluginData(bound: PluginPackage, incoming: PluginPackage): boolean {
  if (bound.pkg !== incoming.pkg) return false;
  return incoming.trust !== 'unsigned' || bound.trust === 'unsigned';
}

/** `incoming` is the signed (or built-in) release of the unsigned copy on record: an update, said so on the sheet. */
export function signsUnsignedCopy(bound: PluginPackage | null, incoming: PluginPackage): boolean {
  return bound !== null && bound.trust === 'unsigned' && incoming.trust !== 'unsigned' && keepsPluginData(bound, incoming);
}

/** Would this package take the id from the one on record? Nothing on record: no. */
export function pluginPackageChanged(id: string, pkg: PluginPackage): boolean {
  const bound = boundPluginPackage(id);
  return bound !== null && !keepsPluginData(bound, pkg);
}

/** Resolves once the card of the last takeover is written. Tests await this rather than a clock. */
let takeoverCard: Promise<unknown> = Promise.resolve();
export const pluginTakeoverCardWritten = (): Promise<unknown> => takeoverCard;

/** What another package taking the id withdrew. */
export type PluginTakeover = {
  previous: PluginPackage;
  httpHosts: string[];
  secretGrants: string[];
  spawnApproval: boolean;
  kanbanProjects: string[];
  /** Ids of the user connections sent back to approval, their keys deleted. */
  connections: string[];
  /** Keys of the settings of type `secret` deleted, never their values. */
  secretSettings: string[];
  /** Keys of the other settings deleted. */
  settings: string[];
  /** How many entries of the free `plugin_kv` (`ctx.storage.kv`) were deleted. */
  storage: number;
  /** Where the data folder went; `null` when there was none. */
  dataDir: string | null;
  automations: PluginAutomations;
};

/** Thrown on a file the entries may still sit in: the package must not mount yet. */
function assertConfigReadable(file: string): void {
  if (!existsSync(file)) return;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the configuration file root must be a JSON object');
  }
}

/**
 * Deletes what is left of the plugin's `plugin_kv` once the secret settings are
 * gone. Key by key, as `deletePluginSecretSettings` does, so a database that
 * refuses one refuses them all the same way and the next pass finishes the job.
 * Connection keys belong to the step that sends the connections back to approval:
 * deleted here if it left any, never counted twice.
 */
function deletePluginStorage(id: string): { settings: string[]; storage: number } {
  const settings: string[] = [];
  let storage = 0;
  for (const { key } of dbApi.pluginKvList(id)) {
    dbApi.pluginKvDelete(id, key);
    if (key.startsWith(PLUGIN_SETTING_KV_PREFIX)) settings.push(key.slice(PLUGIN_SETTING_KV_PREFIX.length));
    else if (!key.startsWith(PLUGIN_CONNECTION_KV_PREFIX)) storage++;
  }
  return { settings: settings.sort(), storage };
}

/** Same characters as a manifest id, and none a file name refuses on Windows. */
const trashStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * Moves `plugins-data/<id>/` to `plugins-data/.trash/<id>-<stamp>/` and returns
 * where it went. Throws when it cannot: a file held open on Windows refuses the
 * rename, and leaving the folder in place would hand it to the new package.
 */
function setAsideDataDir(id: string): string | null {
  const dir = pluginDataDir(id);
  if (!existsSync(dir)) return null;
  const stamp = trashStamp();
  let target = join(PLUGIN_DATA_TRASH_DIR, `${id}-${stamp}`);
  for (let n = 1; existsSync(target); n++) target = join(PLUGIN_DATA_TRASH_DIR, `${id}-${stamp}-${n}`);
  try {
    mkdirSync(PLUGIN_DATA_TRASH_DIR, { recursive: true });
    renameSync(dir, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`the data folder ${dir} could not be moved to ${PLUGIN_DATA_TRASH_DIR}${code ? ` (${code})` : ''}: `
      + 'something may still hold a file open in it');
  }
  return target;
}

function withdrawGrants(id: string, previous: PluginPackage, next: PluginPackage, file: string): PluginTakeover {
  const failures: string[] = [];
  // Every step runs even if one fails, and each is safe to run again: the record
  // only moves once all of them went through, so the next pass finishes the job.
  const step = <T>(fallback: T, run: () => T): T => {
    try { return run(); } catch (err) {
      failures.push((err as Error).message);
      return fallback;
    }
  };
  step(undefined, () => assertConfigReadable(file));
  const httpHosts = step<string[]>([], () => forgetPluginHttpHosts(id, file));
  const policy = step({ spawn: false, projects: [] as string[] }, () => forgetPluginPolicyGrants(id, file));
  // `narrowLivePluginGrants` keeps its copy when the file fails the schema: this one does not ask.
  if (file === CONFIG_FILE) step(undefined, () => forgetLivePluginGrants(id));
  const secretGrants = step<string[]>([], () => revokePluginSecretGrants(id));
  const connections = step<string[]>([], () => withdrawPluginUserConnections(id));
  // A built-in renamed by a release is still the product: a grant can be given
  // again, but what it keeps under `@settings/` (saved browser passwords) cannot.
  const productRename = previous.trust === 'builtin' && next.trust === 'builtin';
  // The rest of its data stays for the same reason.
  const secretSettings = productRename ? [] : step<string[]>([], () => deletePluginSecretSettings(id, previous.secretSettings ?? []));
  const storage = productRename ? { settings: [], storage: 0 } : step({ settings: [] as string[], storage: 0 }, () => deletePluginStorage(id));
  const dataDir = productRename ? null : step<string | null>(null, () => setAsideDataDir(id));
  const automations = step<PluginAutomations>({ routines: [], triggers: [], pipelines: [] }, () => disablePluginAutomations(id));
  if (failures.length) throw new Error(`cannot withdraw what was granted to the previous package \`${previous.pkg}\`: ${failures.join('; ')}`);
  return {
    previous, httpHosts, secretGrants, spawnApproval: policy.spawn, kanbanProjects: policy.projects, connections, secretSettings,
    settings: storage.settings, storage: storage.storage, dataDir, automations,
  };
}

/** One line per kind of thing withdrawn, for the card and the log. Empty when nothing was. */
function describeTakeover(t: PluginTakeover): string[] {
  const lines: string[] = [];
  if (t.secretGrants.length) lines.push(`vault grants withdrawn: ${t.secretGrants.join(', ')}`);
  if (t.httpHosts.length) lines.push(`hosts closed: ${t.httpHosts.join(', ')}`);
  if (t.spawnApproval) lines.push('mission approval withdrawn (pluginPolicy.spawn.approved)');
  if (t.kanbanProjects.length) lines.push(`Kanban projects no longer readable: ${t.kanbanProjects.join(', ')}`);
  if (t.connections.length) lines.push(`user connections sent back to approval, their keys deleted: ${t.connections.join(', ')}`);
  if (t.secretSettings.length) lines.push(`secret settings deleted, to be typed again: ${t.secretSettings.join(', ')}`);
  if (t.settings.length) lines.push(`settings deleted: ${t.settings.join(', ')}`);
  if (t.storage) lines.push(`stored entries deleted: ${t.storage}`);
  if (t.dataDir) lines.push(`data folder moved to ${t.dataDir}`);
  const stopped = [...t.automations.routines, ...t.automations.triggers];
  if (stopped.length) lines.push(`routines and triggers switched off: ${stopped.join(', ')}`);
  return lines;
}

/** No empty list on record: most packages declare no secret setting. */
function writeRecord(id: string, pkg: PluginPackage, secretSettings: readonly string[]): void {
  dbApi.pluginKvSet(PLUGIN_PACKAGE_STORE, id, JSON.stringify({
    pkg: pkg.pkg, trust: pkg.trust, ...(secretSettings.length ? { secretSettings: [...secretSettings].sort() } : {}),
  }));
}

/**
 * Records the package holding `id` and, when another one held it, withdraws what
 * was granted to that one. Synchronous, and called before anything of the package
 * runs. Throws when something could not be withdrawn: the caller must not run the
 * package, and the record stays for the next attempt. Returns what was withdrawn,
 * `null` when the package keeps the id or is the first one seen under it (a record
 * older than this code is adopted, like a webhook secret: nothing says otherwise).
 */
export function settlePluginPackage(id: string, pkg: PluginPackage, file: string = CONFIG_FILE): PluginTakeover | null {
  const previous = boundPluginPackage(id);
  if (previous !== null && keepsPluginData(previous, pkg)) {
    // An update can declare a new secret, or stop declaring one whose row stays:
    // once declared, a key stays on record until the package changes.
    const known = previous.secretSettings ?? [];
    const added = (pkg.secretSettings ?? []).filter((key) => !known.includes(key));
    // Signed from now on: an unsigned copy coming back must take the id, not inherit it.
    const signed = signsUnsignedCopy(previous, pkg);
    if (added.length || signed) writeRecord(id, signed ? pkg : previous, [...known, ...added]);
    if (signed) console.warn(`[plugins] ${id}: \`${pkg.pkg}\` now ${pkg.trust}, was unsigned — an update, its data and settings kept`);
    return null;
  }
  const takeover = previous === null ? null : withdrawGrants(id, previous, pkg, file);
  writeRecord(id, pkg, pkg.secretSettings ?? []);
  if (!takeover) return null;

  // A card that asked for a consent of the id would now grant it to the new package.
  void closePluginSecretCards(id);
  void closePluginSpawnCards(id);
  void closePluginLaunchCard(id);
  console.warn(`[plugins] ${id}: now provided by \`${pkg.pkg}\` (${pkg.trust}), was \`${previous!.pkg}\` (${previous!.trust})`);
  const lines = describeTakeover(takeover);
  for (const line of lines) console.warn(`[plugins] ${id}: ${line}`);
  if (lines.length) {
    takeoverCard = import('../notifications.js')
      .then(({ createNotification }) => createNotification({
        type: 'action_required',
        title: `Plugin \`${id}\` now comes from another package`,
        body: `\`${pkg.pkg}\` replaced \`${previous!.pkg}\` under this id, and nobody granted it what the previous package held. `
          + `${lines.join('. ')}. Grant them again only if you trust this package with them.`,
        anchor: `plugin-package:${id}`,
        message: daemonMessage('plugin_package_takeover', {
          id, pkg: pkg.pkg, previous: previous!.pkg, changes: lines.join('. '),
        }),
      }))
      .catch(() => { /* no notification subsystem here: the log above says it */ });
  }
  return takeover;
}
