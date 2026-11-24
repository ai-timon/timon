/**
 * What the vault exposes to plugins (SECRETS-VAULT.md §9.4).
 *
 * Two distinct things live here, and confusing them is how a value ends up in
 * the wrong place:
 *
 *  - **Vault entries** — rows of `secrets`, deposited by a human through
 *    `/secrets` or `timon secret set`, read by a plugin through
 *    `ctx.secrets.get(name)`. The plugin never picks its own scope: it asks by
 *    name, and the grant decides whether an answer exists.
 *  - **Manifest settings of type `secret`** — values a user types in the
 *    plugin's own settings form. They stay in `plugin_kv` (that is where
 *    `ctx.settings` reads them) but are sealed with the same envelope as the
 *    vault, which is what closes the P.7 stub: before this module, they were
 *    written in the clear and therefore travelled in every `timon export`.
 *
 * Neither path ever hands a value to a client: `settingStatus` keeps returning
 * `''`, and `ctx.secrets` is behind the `secrets:read` permission.
 */
import { daemonMessage } from '../daemon-message.js';
import { vaultEnabled } from './availability.js';
import { isSealed } from './box.js';
import { dbApi } from '../db.js';
import { PLUGIN_AGENT_PREFIX, resolveSecretsFor, type SecretIdentity, type SecretMode, type SecretTarget } from './resolve.js';
import { openWithVault, PLUGIN_SETTING_KV_PREFIX, pluginKvIdentity, readSecretValue, sealWithVault } from './store.js';

/**
 * The identity a plugin presents to the resolver.
 *
 * A plugin is not an agent and has no project, but the grant model has exactly
 * three scopes (§5.2) and inventing a fourth for plugins would mean a second
 * resolution path to keep correct. It is therefore addressed as the agent
 * `plugin:<id>`: a grant `agent:plugin:<id>` names one plugin and nothing else,
 * and no agent can ever carry that name — `secretScopeFor` compares the mission
 * agent, and a mission agent is a directory of `~/.timon/agents/`.
 *
 * A `global` grant does NOT reach this address (`resolve.ts`, TODO #531,
 * decision 1-B): a plugin reads only what was granted to it by name, and
 * existing `global` grants are not copied over — that would undo the choice.
 * An install that relied on them gets a card instead (`globalOnlyCard`).
 */
export function pluginSecretTarget(pluginId: string): SecretTarget {
  return { agent: `${PLUGIN_AGENT_PREFIX}${pluginId}`, project: null };
}

/** Cards raised, and cards closed, in this process — keyed `<plugin>\0<name>`. */
const CARDED = new Set<string>();
const CLEARED = new Set<string>();

const consentAnchor = (pluginId: string, name: string): string => `plugin-secret:${pluginId}:${name}`;

/** Test seam. */
export function resetPluginSecretCards(): void {
  CARDED.clear();
  CLEARED.clear();
}

/**
 * Withdraw every `agent:plugin:<id>` grant, on every row of the vault, and
 * return the names of the secrets that carried one (sorted, each once).
 *
 * Called by `timon plugin remove` (TODO #659). A grant names an id, not a
 * package: left in place, it would hand these secrets to whatever is next
 * installed under that id — another author's package included — without
 * anyone having granted them to it. The rows themselves stay: a human
 * deposited them, and a mission or another plugin may still be granted them.
 * Vault disabled or not: a grant is a row of `secret_grants`, readable without
 * the master key, and removing it never needs to decrypt anything.
 */
export function revokePluginSecretGrants(pluginId: string): string[] {
  const ref = `${PLUGIN_AGENT_PREFIX}${pluginId}`;
  const names = new Set<string>();
  for (const row of dbApi.listSecrets()) {
    if (!row.grants.some((g) => g.scope_kind === 'agent' && g.scope_ref === ref)) continue;
    dbApi.removeSecretGrant(row.id, 'agent', ref);
    names.add(row.name);
  }
  // A reinstall is a new consent: its first refusal must raise a card again.
  for (const key of [...CARDED, ...CLEARED]) {
    if (!key.startsWith(`${pluginId}\0`)) continue;
    CARDED.delete(key);
    CLEARED.delete(key);
  }
  return [...names].sort();
}

/**
 * The consent an existing install has to give again. A plugin that asks for a
 * name only shared with every agent (`global`) used to receive it; it now gets
 * nothing, and the operator is told which grant would restore it — never by
 * granting it for them. Once per process and name: a job polling every minute
 * must not stack cards. Fire-and-forget, like the spawn card (`policy.ts`): the
 * refusal stands whether or not a notification centre is there to show it.
 */
export function noteGlobalOnlySecret(
  pluginId: string,
  name: string,
  mode: SecretMode,
  rows: readonly SecretIdentity[],
): void {
  const shared = rows.some((row) => row.name === name && row.mode === mode && row.grants.some((g) => g.scope_kind === 'global'));
  if (!shared) return;
  const key = `${pluginId}\0${name}`;
  if (CARDED.has(key)) return;
  CARDED.add(key);
  CLEARED.delete(key);
  const scope = `agent:${PLUGIN_AGENT_PREFIX}${pluginId}`;
  void import('../notifications.js')
    .then(({ createNotification }) => createNotification({
      type: 'action_required',
      title: `Plugin \`${pluginId}\` no longer reads the secret \`${name}\``,
      body: `\`${name}\` is shared with every agent (\`global\`), which no longer reaches plugins. `
        + `If you trust this plugin with it, grant it by name: open this card (Secrets page, Grant) `
        + `or run \`timon secret grant ${name} --scope ${scope}\`.`,
      message: daemonMessage('plugin_secret_global_lost', { pluginId, name, scope }),
      source: `${PLUGIN_AGENT_PREFIX}${pluginId}`,
      anchor: consentAnchor(pluginId, name),
    }))
    .catch(() => { /* no notification subsystem here: the refusal is enough */ });
}

/** The grant was given: the card is answered, and a later revocation may raise a new one. */
export function clearGlobalOnlySecret(pluginId: string, name: string): void {
  const key = `${pluginId}\0${name}`;
  if (CLEARED.has(key)) return;
  CLEARED.add(key);
  CARDED.delete(key);
  void import('../notifications.js')
    .then(({ resolveAnchor }) => resolveAnchor(consentAnchor(pluginId, name)))
    .catch(() => { /* no notification subsystem here */ });
}

/**
 * The plugin is gone (`timon plugin remove`, TODO #661): close every consent
 * card it raised, whatever the secret. Left open, its Grant button would hand
 * the secret to the id — and so to whatever package is next published under
 * it, which nobody consented to. Also forgets what this process carded, so a
 * reinstall's first refusal raises a card of its own.
 *
 * Called twice on purpose: by the remover (the CLI, which shares the database
 * but has no Web Push sink and none of the daemon's memory), and by the
 * daemon's loader once it sees the package gone from disk (closes the system
 * notification on the devices, and a card the plugin raised in between).
 * Awaitable, unlike the cards above: the CLI exits right after.
 */
export async function closePluginSecretCards(pluginId: string): Promise<number> {
  for (const key of [...CARDED, ...CLEARED]) {
    if (!key.startsWith(`${pluginId}\0`)) continue;
    CARDED.delete(key);
    CLEARED.delete(key);
  }
  try {
    const { resolveAnchorPrefix } = await import('../notifications.js');
    return resolveAnchorPrefix(consentAnchor(pluginId, ''));
  } catch {
    return 0; // no notification subsystem here: nothing was carded either
  }
}

/**
 * The vault entry named `name` that this plugin is granted, decrypted, or
 * `undefined` when no grant matches.
 *
 * `broker` secrets never come out here: `resolveSecretsFor` drops them (§6.2),
 * so a plugin cannot obtain by name what an agent cannot obtain by injection.
 *
 * Vault module off: `undefined`, the same answer as "no grant" — but said out
 * loud once per plugin, because a plugin that keeps asking for a key it will
 * never get must leave a trace naming the vault, not just fail later on an
 * empty value.
 */
const warnedVaultOff = new Set<string>();

export function readPluginSecret(pluginId: string, name: string): string | undefined {
  if (!vaultEnabled()) {
    if (!warnedVaultOff.has(pluginId)) {
      warnedVaultOff.add(pluginId);
      console.warn(`[secrets] vault disabled — plugin ${pluginId} gets no vault entry`);
    }
    return undefined;
  }
  const rows = dbApi.listSecrets();
  const resolved = resolveSecretsFor({ ...pluginSecretTarget(pluginId), secrets: rows });
  const hit = resolved.find((secret) => secret.name === name);
  if (!hit) {
    noteGlobalOnlySecret(pluginId, name, 'inject', rows);
    return undefined;
  }
  clearGlobalOnlySecret(pluginId, name);
  return readSecretValue(hit.id);
}

/**
 * Seal the JSON already stored (or about to be stored) in `plugin_kv` for a
 * setting of type `secret`. The envelope wraps the JSON text, so `settings.get`
 * can `JSON.parse` after opening, same as for a non-secret setting.
 */
export function sealPluginKvValue(pluginId: string, kvKey: string, json: string): string {
  return sealWithVault(json, pluginKvIdentity(pluginId, kvKey));
}

/**
 * Delete the settings of type `secret` stored for `pluginId` and return their
 * keys (sorted). Called when another package takes the id (TODO #675): these
 * values were typed for the previous package, and `ctx.settings` opens them by id.
 *
 * Its manifest is gone by then, so a row says for itself: sealed means secret,
 * whatever the next manifest declares. `declared` catches what a seal cannot: a
 * cleartext row the lazy migration has not reached (§10.4), which a package
 * declaring the same key as a plain `string` would otherwise read as is.
 */
export function deletePluginSecretSettings(pluginId: string, declared: readonly string[]): string[] {
  const keys: string[] = [];
  for (const row of dbApi.pluginKvList(pluginId, PLUGIN_SETTING_KV_PREFIX)) {
    const key = row.key.slice(PLUGIN_SETTING_KV_PREFIX.length);
    if (!isSealed(row.value) && !declared.includes(key)) continue;
    dbApi.pluginKvDelete(pluginId, row.key);
    keys.push(key);
  }
  return keys.sort();
}

/**
 * Open a plugin setting payload. A cleartext value (no `enc:1:` prefix) is
 * re-sealed through `writeBack` — the lazy migration of §10.4.
 */
export function openPluginKvValue(
  pluginId: string,
  kvKey: string,
  raw: string,
  writeBack?: (sealed: string) => void,
): string {
  if (isSealed(raw)) return openWithVault(raw, pluginKvIdentity(pluginId, kvKey));
  writeBack?.(sealPluginKvValue(pluginId, kvKey, raw));
  return raw;
}
