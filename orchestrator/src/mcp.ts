/**
 * MCP server storage. Each server is one JSON file at ~/.timon/mcp/<id>.json.
 *
 * Two transports supported:
 *   - stdio: an executable + args, runs locally inside the orchestrator
 *     container. Use for things like chrome-devtools-mcp, postgres MCP, etc.
 *   - http: a remote URL (a hosted MCP), with optional Authorization
 *     and other headers.
 *
 * The OAuth tokens of an http server are not in that file: they are sealed in
 * the secrets vault (`mcp-oauth-store.ts`), the file keeps the rest of the
 * OAuth state (metadata, client, redirect uri).
 *
 * Tools-per-server are cached opportunistically from claude `system:init`
 * events seen at spawn time (see refreshToolsCacheFromInit). The cache lives
 * inside the same JSON file so it survives orchestrator restarts.
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { TIMON_HOME } from './paths.js';
import { isInjectedMcpServer, isInjectedMcpStubId } from './injected-mcp.js';
import {
  serializeCodexMcpToml, serializeGrokMcpToml, serializeMcpJson, type McpLaunchServer,
} from './backends/mcp-serialize.js';
import { OAuthRefreshError, refreshTokens } from './oauth.js';
import { mcpHostAddressRefusal } from './mcp-url-guard.js';
import { pinnedLaunchTarget } from './mcp-launch-proxy.js';
import { vaultEnabled } from './secrets/availability.js';
import { SecretStoreError, createSecret, deleteSecret, readSecretValue } from './secrets/store.js';
import { mcpRelayRoute } from './mcp-relay-route.js';
import {
  McpOAuthVaultUnavailableError, forgetMcpOAuthTokens, mcpOAuthVaultAvailable, readMcpOAuthTokens, storeMcpOAuthTokens,
} from './mcp-oauth-store.js';
import type {
  McpExternalConfig, McpServer, McpSummary, McpHttpConfig, McpSource, McpStdioConfig, OAuthStatus, OAuthTokens,
} from './plugins/contract/mcp-servers.js';
export type { McpServer, McpSummary, McpExternalConfig, McpHttpConfig, McpSource, McpStdioConfig, McpTransport, OAuthStatus } from './plugins/contract/mcp-servers.js';

/** A header whose value the vault holds: the secret's id, and what goes before its value (`Bearer `). */
export type McpHeaderSecret = {
  secret_id: string;
  prefix?: string;
  /** `true`: one of the server's own `headers` (typed in the editor, sent
   *  through the API), moved to the vault. It reads back as `***` and is
   *  replaced or removed like any header. Absent: a key the daemon set itself
   *  (an Apps connector), which no reader is shown and only the daemon replaces. */
  typed?: true;
};

/**
 * An http transport as its file holds it. `header_secrets` names, by header,
 * a secret of the vault that the launch reads (`prefix` + value). It is a
 * storage detail of the daemon, not part of the plugin contract: no reader
 * outside this module is handed it (`redactMcpServer` and `presentMcpServer`
 * drop it), and only the daemon's own code writes it — `upsertMcp` drops it
 * from any incoming transport — so no caller can point a stored secret at a
 * url of its choosing; a change of url drops it, and the secret with it.
 *
 * `headers` holds only what the vault could not take: an empty value, or every
 * value of a server written while the vault was off or locked (moved at the
 * next boot, `migrateMcpHeadersToVault`). Such a server is not given to agents
 * meanwhile: the relay it needs is keyed by the vault too.
 */
export type McpStoredHttpConfig = McpHttpConfig & {
  header_secrets?: Record<string, McpHeaderSecret>;
};

/** A server as its file holds it (`McpServer` plus the storage-only fields). */
export type McpStoredServer = Omit<McpServer, 'transport'> & {
  transport: McpStdioConfig | McpStoredHttpConfig | McpExternalConfig;
};

export const MCP_DIR = join(TIMON_HOME, 'mcp');

const ID_RE = /^[a-z0-9._-]+$/;

function validId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid mcp id: ${id}`);
}

function fpath(id: string): string {
  return join(MCP_DIR, id + '.json');
}

function readFileRecord(id: string): McpStoredServer | null {
  const p = fpath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as McpStoredServer;
  } catch {
    return null;
  }
}

function writeFileRecord(server: McpStoredServer): void {
  mkdirSync(MCP_DIR, { recursive: true });
  writeFileSync(fpath(server.id), JSON.stringify(server, null, 2) + '\n');
}

/** The tokens a record still carries in its file: written before the vault held them. */
function fileTokens(s: McpServer): OAuthTokens | undefined {
  return s.transport.type === 'http' ? s.transport.oauth?.tokens : undefined;
}

function withoutTokens(s: McpStoredServer): McpStoredServer {
  if (s.transport.type !== 'http' || !s.transport.oauth?.tokens) return s;
  const { tokens: _sealed, ...oauth } = s.transport.oauth;
  return { ...s, transport: { ...s.transport, oauth } };
}

/**
 * Takes the tokens out of a file that still holds them (written before the
 * vault held them). They are sealed and read back first; when that fails — the
 * vault off, its master key unreadable, a read-back that differs — they are
 * dropped all the same and the server must be connected again: a token never
 * stays in a file the agents' shell can read, waiting for a vault to come back.
 * Returns the record as it now stands and whether its tokens reached the vault.
 */
// Every read of a server file retries the move: one warning per server and process is enough.
const moveWarned = new Set<string>();

function warnDropped(id: string, why: string): void {
  if (moveWarned.has(id)) return;
  moveWarned.add(id);
  console.warn(`[timon] mcp ${id}: its OAuth tokens were removed from its file without reaching the secrets vault (${why}); connect it again`);
}

function moveTokensToVault(s: McpStoredServer): { record: McpStoredServer; moved: boolean } {
  const tokens = fileTokens(s);
  if (!tokens || s.transport.type !== 'http') return { record: s, moved: false };
  let failure: string | null = null;
  if (!mcpOAuthVaultAvailable()) failure = 'the secrets vault is off';
  else {
    try {
      storeMcpOAuthTokens(s.id, s.transport.url, tokens);
      if (JSON.stringify(readMcpOAuthTokens(s.id, s.transport.url)) !== JSON.stringify(tokens)) {
        failure = 'the vault did not give them back';
      }
    } catch (error) {
      failure = error instanceof McpOAuthVaultUnavailableError ? 'the secrets vault is unavailable' : (error as Error).name;
    }
  }
  if (failure) {
    forgetMcpOAuthTokens(s.id);
    warnDropped(s.id, failure);
    const dropped: McpStoredServer = { ...withoutTokens(s), last_status: 'needs-auth' };
    writeFileRecord(dropped);
    return { record: dropped, moved: false };
  }
  moveWarned.delete(s.id);
  const stripped = withoutTokens(s);
  writeFileRecord(stripped);
  return { record: stripped, moved: true };
}

function readRaw(id: string): McpStoredServer | null {
  const s = readFileRecord(id);
  // A file from before the vault held the tokens is cleaned at first read, not only at boot.
  return s && fileTokens(s) ? moveTokensToVault(s).record : s;
}

/**
 * Writes a server: its tokens to the vault, the rest to its file. Without a
 * vault, tokens are refused (`McpOAuthVaultUnavailableError`) rather than
 * written in clear.
 */
function writeRaw(server: McpStoredServer): void {
  const tokens = fileTokens(server);
  if (!tokens || server.transport.type !== 'http') {
    writeFileRecord(server);
    return;
  }
  // Throws when the vault is off or its master key unreadable (a locked keyring).
  storeMcpOAuthTokens(server.id, server.transport.url, tokens);
  writeFileRecord(withoutTokens(server));
}

/**
 * The OAuth tokens of a server, from the vault only; without one, the relay
 * answers "not connected".
 */
function oauthTokensOf(s: McpServer): OAuthTokens | undefined {
  if (s.transport.type !== 'http' || !s.transport.oauth) return undefined;
  return readMcpOAuthTokens(s.id, s.transport.url);
}

/**
 * Takes out of every server file the OAuth tokens it still holds (written
 * before the vault held them): moved into the vault, or dropped when it cannot
 * take them (`moveTokensToVault`). Idempotent, run at every boot.
 */
export function migrateMcpOAuthTokensToVault(): { moved: string[]; dropped: string[] } {
  const moved: string[] = [];
  const dropped: string[] = [];
  if (!existsSync(MCP_DIR)) return { moved, dropped };
  for (const f of readdirSync(MCP_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    const s = readFileRecord(id);
    if (!s || !fileTokens(s)) continue;
    if (moveTokensToVault(s).moved) moved.push(id);
    else dropped.push(id);
  }
  return { moved, dropped };
}

function oauthStatus(s: McpServer): OAuthStatus {
  if (s.transport.type !== 'http' || !s.transport.oauth) return 'none';
  const t = oauthTokensOf(s);
  if (!t) return 'pending';
  if (t.expires_at && t.expires_at < Date.now() && !t.refresh_token) return 'expired';
  return 'authorized';
}

function summarise(s: McpStoredServer): McpSummary {
  // Strip the transport union to a plain enum + drop secrets from the summary.
  const { transport, ...rest } = s;
  return {
    ...rest,
    transport_type: transport.type,
    tools_count: s.tools_cache?.length ?? 0,
    oauth_status: oauthStatus(s),
    // Said on the list, not only in the daemon's log: the page is where a user
    // looks for why an agent did not get the server.
    ...(relayedServer(s) && !vaultEnabled() ? { held_back: 'vault_off' as const } : {}),
  };
}

/**
 * A stub `refreshToolsCacheFromInit` wrote for a server Timon itself injects
 * (`timon`, `timon-browser`…). Older versions did, and the entry then read as a
 * second server with other rights, while excluding it banned the real one.
 */
function isInjectedStub(s: McpServer): boolean {
  return s.transport.type === 'external' && isInjectedMcpServer(s.transport.claude_key);
}

/**
 * Whether `key` (a server name from claude's `init`) is a claude.ai account
 * connector. claude names those `claude.ai <X>` (tools `mcp__claude_ai_<X>__*`);
 * anything else it reports comes from the user's own claude configuration,
 * and labelling it "claude.ai" told a tester without an account that Timon had
 * one (TIM-0088).
 */
export function isClaudeAiConnectorKey(key: string): boolean {
  return /^claude[._]ai[\s_]/i.test(key);
}

/** Origin of a server claude reports and Timon does not manage. */
export function discoveredSource(key: string): 'claude_ai' | 'claude_cli' {
  return isClaudeAiConnectorKey(key) ? 'claude_ai' : 'claude_cli';
}

const DISCOVERED_DESCRIPTION: Record<'claude_ai' | 'claude_cli', string> = {
  claude_ai: 'Auto-discovered from claude (account connector).',
  claude_cli: 'Auto-discovered from claude (local claude configuration).',
};

/**
 * Whether an entry was discovered from claude rather than added in Timon.
 * Both kinds load through claude itself, so both can only be cut with
 * `--disallowedTools`, and a mission may manage neither.
 */
export function isDiscoveredMcp(s: { source?: McpSource }): boolean {
  return s.source === 'claude_ai' || s.source === 'claude_cli';
}

export function listMcp(): McpSummary[] {
  if (!existsSync(MCP_DIR)) return [];
  const out: McpSummary[] = [];
  for (const f of readdirSync(MCP_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    const s = readRaw(id);
    // Hidden even before `purgeInjectedMcpStubs` has removed the file: nothing
    // may offer such an entry to a user or to an exclusion list.
    if (s && !isInjectedStub(s)) out.push(summarise(s));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * What a freshly created agent starts without: every discovered account
 * connector, since each loads its whole tool catalogue into every turn. A
 * server Timon injects itself is never one of them, even if a stale entry for
 * it is still around — excluding it bans its tools (`mcp__timon__*`).
 */
export function defaultExcludedMcpIds(): string[] {
  return listMcp()
    .filter((m) => m.id.startsWith('ext-') && !isInjectedMcpStubId(m.id) && !isInjectedMcpServer(m.name || m.id))
    .map((m) => m.id);
}

/** The stored server, storage-only fields included: for the daemon's own code. A plugin reads `redactMcpServer`'s. */
export function getMcp(id: string): McpStoredServer | null {
  validId(id);
  return readRaw(id);
}

/** What a masked secret becomes for a caller who may not manage MCP servers. */
const SECRET_MASK = '***';

function maskValues(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map)) out[key] = SECRET_MASK;
  return out;
}

/**
 * Every header of a server as a reader is shown it: the ones its file still
 * holds and the ones the vault holds for it, each worth `***`. The keys the
 * daemon set itself (an Apps connector's) are not among them.
 */
function maskedHeaders(transport: McpStoredHttpConfig): Record<string, string> | undefined {
  const typed = Object.entries(transport.header_secrets ?? {}).filter(([, ref]) => ref.typed).map(([header]) => header);
  const names = [...Object.keys(transport.headers ?? {}), ...typed];
  return names.length ? Object.fromEntries(names.map((name) => [name, SECRET_MASK])) : undefined;
}

/**
 * A server as a caller who manages MCP servers reads it (the editor): the
 * stored record, with no header value — a value the vault holds is never read
 * back, as for a connector's key, and one its file still holds is masked the
 * same way, so that the form is the same whatever the vault could take. A save
 * that sends `***` back keeps the stored value (`upsertMcp`).
 */
export function presentMcpServer(s: McpStoredServer): McpServer {
  if (s.transport.type !== 'http') return s;
  const { header_secrets: _vaultRefs, headers: _stored, ...rest } = s.transport;
  const headers = maskedHeaders(s.transport);
  return { ...s, transport: { ...rest, ...(headers ? { headers } : {}) } };
}

/**
 * A server with every secret scrubbed, for a caller who may not manage MCP
 * servers (audit CLI/MCP P1-4). `GET /api/mcp/:id` returns the full transport — headers,
 * OAuth tokens, stdio env — and an agent (through `mcp_server_get`) or an
 * employee must not read those back. Keys are kept (the editor and tool
 * descriptions need the shape), only the VALUES are masked, so no secret ever
 * reaches a non-privileged caller. `command`, `args`, `url`, OAuth metadata and
 * `client_id` are not secrets and stay.
 */
export function redactMcpServer(s: McpStoredServer): McpServer {
  const transport = s.transport;
  if (transport.type === 'stdio') {
    const env = transport.env ? maskValues(transport.env) : transport.env;
    return { ...s, transport: { ...transport, ...(env ? { env } : {}) } };
  }
  if (transport.type === 'http') {
    const headers = maskedHeaders(transport);
    let oauth = transport.oauth;
    if (oauth) {
      const tokens = oauth.tokens
        ? {
            ...oauth.tokens,
            access_token: SECRET_MASK,
            ...(oauth.tokens.refresh_token ? { refresh_token: SECRET_MASK } : {}),
          }
        : oauth.tokens;
      oauth = {
        ...oauth,
        client: {
          ...oauth.client,
          ...(oauth.client.client_secret ? { client_secret: SECRET_MASK } : {}),
        },
        ...(tokens ? { tokens } : {}),
      };
    }
    // Which vault secret holds a key is the daemon's business, not the reader's.
    const { header_secrets: _vaultRefs, headers: _stored, ...publicTransport } = transport;
    return {
      ...s,
      transport: { ...publicTransport, ...(headers ? { headers } : {}), ...(oauth ? { oauth } : {}) },
    };
  }
  // external: `claude_key` is a server name, not a secret.
  return s;
}

/**
 * The transport a mission token asks to store, with the secrets it could not
 * read put back (audit CLI/MCP P1-4).
 *
 * A mission is shown a server with every secret value masked (`redactMcpServer`),
 * so an agent that edits one and sends it back returns `***` where the stored
 * value was. Writing that would destroy the secret; the stored value is kept
 * instead — but only while the server still points where it did. A mask carried
 * to another `url` (or another `command` / `args`) would have the next spawn send
 * the stored credential to a destination of the caller's choosing: that is
 * refused, the caller has to type the value itself.
 *
 * `oauth` never comes from a mission: only the authorisation flow writes it, and
 * a masked round trip would overwrite the stored tokens with `***`. The stored
 * state is kept by `upsertMcp` while the url is unchanged.
 */
export function missionTransport(
  existing: McpStoredServer | null,
  incoming: McpStdioConfig | McpHttpConfig,
): { transport: McpStdioConfig | McpHttpConfig } | { refusal: string } {
  const stored = existing?.transport;
  if (incoming.type === 'stdio') {
    const env = incoming.env;
    if (!env || !Object.values(env).includes(SECRET_MASK)) return { transport: incoming };
    const sameTarget = stored?.type === 'stdio'
      && stored.command === incoming.command
      && JSON.stringify(stored.args ?? []) === JSON.stringify(incoming.args ?? []);
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== SECRET_MASK) { kept[key] = value; continue; }
      const old = sameTarget && stored?.type === 'stdio' ? stored.env?.[key] : undefined;
      if (old === undefined) return { refusal: maskedRefusal('env', key, sameTarget ? 'no stored value' : 'command or args changed') };
      kept[key] = old;
    }
    return { transport: { ...incoming, env: kept } };
  }
  const rest: McpHttpConfig = { ...incoming };
  delete rest.oauth;
  // A masked header stays masked: `upsertMcp` carries the stored value over
  // itself, from the vault or the file. Refused here first, so that the
  // mission's refusal is audited and says why.
  for (const [key, value] of Object.entries(rest.headers ?? {})) {
    if (value !== SECRET_MASK) continue;
    const why = maskedHeaderGap(stored ?? null, rest.url, key);
    if (why) return { refusal: maskedRefusal('headers', key, why) };
  }
  return { transport: rest };
}

/** Why a masked header cannot keep its stored value at `url`; `null` when it can. */
function maskedHeaderGap(stored: McpStoredServer['transport'] | null, url: string, header: string): string | null {
  if (stored?.type !== 'http' || stored.url !== url) return stored?.type === 'http' ? 'url changed' : 'no stored value';
  if (stored.headers?.[header] !== undefined || stored.header_secrets?.[header]?.typed) return null;
  return 'no stored value';
}

function maskedRefusal(field: 'env' | 'headers', key: string, why: string): string {
  return `${field}.${key} is the masked value (${SECRET_MASK}) and the stored secret cannot be carried over (${why}): `
    + 'send the real value, or leave the entry out';
}

export type UpsertMcpInput = {
  id: string;
  name?: string;
  description?: string;
  transport: McpStdioConfig | McpHttpConfig;
  /** The stamp of the mission that declares the server; absent for a human. */
  createdBy?: McpServer['created_by'];
  /** The writer is held to public addresses (`McpServer.public_only`); a write
   *  without it clears the mark — to `false` on a server a mission declared, so
   *  that it never reads as one written before the rule. */
  publicOnly?: boolean;
  /** Vault-held headers (`McpHttpConfig.header_secrets`). Only the daemon's
   *  own code passes this: a `header_secrets` inside `transport` is dropped. */
  headerSecrets?: McpStoredHttpConfig['header_secrets'];
  /** The Apps catalogue entry this server was connected from (`McpServer.app_slug`). */
  appSlug?: string;
};

export function upsertMcp(input: UpsertMcpInput): McpStoredServer {
  validId(input.id);
  if (input.transport.type === 'stdio') {
    if (!input.transport.command) throw new Error('stdio transport requires command');
  } else if (input.transport.type === 'http') {
    if (!input.transport.url) throw new Error('http transport requires url');
  } else {
    throw new Error(`unknown transport type: ${(input.transport as { type: string }).type}`);
  }
  const existing = readRaw(input.id);
  // Preserve oauth state across UI saves: the editor only round-trips
  // url/headers, so we'd otherwise wipe tokens on every "Save".
  let transport = withoutHeaderSecrets(input.transport);
  if (
    transport.type === 'http' &&
    existing?.transport.type === 'http' &&
    existing.transport.oauth &&
    !transport.oauth &&
    existing.transport.url === transport.url
  ) {
    transport = { ...transport, oauth: existing.transport.oauth };
  }
  const sameTarget = transport.type === 'http' && existing?.transport.type === 'http'
    && existing.transport.url === transport.url;
  let sealed: Record<string, McpHeaderSecret> = {};
  if (transport.type === 'http') {
    // Same rule as oauth: a stored key keeps reaching the url it was given
    // for, and is never carried to another one.
    const before = sameTarget && existing?.transport.type === 'http' ? existing.transport : undefined;
    const daemonKeys = input.headerSecrets ?? daemonHeaderSecrets(before?.header_secrets);
    const { kept, clear } = resolveHeaders(input.id, transport.headers, existing?.transport ?? null, transport.url);
    const { refs, file } = sealOrKeep(input.id, clear);
    sealed = refs;
    const { headers: _incoming, ...rest } = transport;
    const vaultHeld = { ...daemonKeys, ...kept, ...refs };
    transport = {
      ...rest,
      ...(hasEntries(file) ? { headers: file } : {}),
      ...(hasEntries(vaultHeld) ? { header_secrets: vaultHeld } : {}),
    };
  }
  // The Apps provenance vouches for a reviewed endpoint: a server moved to
  // another url is no longer that app's connection, and Apps leaves it alone.
  const appSlug = input.appSlug ?? (sameTarget ? existing?.app_slug : undefined);
  // Tokens obtained for another url, or for a server that no longer uses OAuth, are forgotten.
  if (existing?.transport.type === 'http' && existing.transport.oauth
    && (transport.type !== 'http' || !transport.oauth || transport.url !== existing.transport.url)) {
    forgetMcpOAuthTokens(input.id);
  }
  const merged: McpStoredServer = {
    id: input.id,
    name: input.name ?? input.id,
    description: input.description,
    transport,
    last_status: existing?.last_status,
    last_seen_at: existing?.last_seen_at,
    tools_cache: existing?.tools_cache,
    tools_cached_at: existing?.tools_cached_at,
    source: 'timon',
    ...(input.createdBy ? { created_by: input.createdBy } : {}),
    ...(transport.type === 'http' && (input.publicOnly || input.createdBy) ? { public_only: !!input.publicOnly } : {}),
    ...(appSlug ? { app_slug: appSlug } : {}),
  };
  try {
    writeRaw(merged);
  } catch (err) {
    // Nothing names them: left in the vault, they would be keys nobody sees the use of.
    deleteRefs(sealed);
    throw err;
  }
  // Only once the new record is written: a failed write leaves the server
  // as it was, keys included.
  forgetUnreferencedKeys(input.id, existing, merged);
  return merged;
}

/** The keys the daemon set itself (an Apps connector's): kept across a save that does not name them. */
function daemonHeaderSecrets(refs: McpStoredHttpConfig['header_secrets']): Record<string, McpHeaderSecret> {
  return Object.fromEntries(Object.entries(refs ?? {}).filter(([, ref]) => !ref.typed));
}

/**
 * The headers a write asks for, split into the vault-held ones a masked value
 * (`***`) keeps (`kept`) and the values to store (`clear`): typed, or carried
 * over from the file for a masked one. A masked header whose stored value
 * cannot be carried — none stored, or the server moved to another url — is an
 * error: the stored credential never follows a server elsewhere.
 */
function resolveHeaders(
  id: string,
  headers: Record<string, string> | undefined,
  stored: McpStoredServer['transport'] | null,
  url: string,
): { kept: Record<string, McpHeaderSecret>; clear: Record<string, string> } {
  const kept: Record<string, McpHeaderSecret> = {};
  const clear: Record<string, string> = {};
  for (const [header, value] of Object.entries(headers ?? {})) {
    if (value !== SECRET_MASK) { clear[header] = value; continue; }
    const why = maskedHeaderGap(stored, url, header);
    if (why || stored?.type !== 'http') throw new Error(`mcp ${id}: ${maskedRefusal('headers', header, why ?? 'no stored value')}`);
    const ref = stored.header_secrets?.[header];
    if (ref?.typed) kept[header] = ref;
    else clear[header] = stored.headers?.[header] ?? '';
  }
  return { kept, clear };
}

/** `MCP_<ID>_<HEADER>`: the vault names secrets like environment variables. */
function headerSecretName(id: string, header: string): string {
  return `MCP_${`${id}_${header}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Seals each non-empty header value into the vault, as a secret with no grant
 * (no agent's environment receives it), and reads it back. On any failure the
 * secrets already created are deleted and the reason is returned — never the
 * value: the caller then keeps the headers in the file.
 */
function sealHeaders(id: string, headers: Record<string, string>): { refs: Record<string, McpHeaderSecret> } | { failure: string } {
  if (!vaultEnabled()) return { failure: 'the secrets vault is switched off' };
  const refs: Record<string, McpHeaderSecret> = {};
  try {
    for (const [header, value] of Object.entries(headers)) {
      const secret = createSecret({ name: headerSecretName(id, header), value, note: `MCP server ${id}: header ${header}` });
      refs[header] = { secret_id: secret.id, typed: true };
      if (readSecretValue(secret.id) !== value) return abandon(refs, 'the vault did not give the value back');
    }
    return { refs };
  } catch (err) {
    // The code, not the message: a keyring error may quote more than it should.
    return abandon(refs, err instanceof SecretStoreError ? `vault error: ${err.code}` : (err as Error).name);
  }
}

function deleteRefs(refs: Record<string, McpHeaderSecret>): void {
  for (const ref of Object.values(refs)) {
    try { deleteSecret(ref.secret_id); } catch { /* nothing names it: an orphan row at worst */ }
  }
}

function abandon(refs: Record<string, McpHeaderSecret>, failure: string): { failure: string } {
  deleteRefs(refs);
  return { failure };
}

// A read retries nothing, but a boot and each save do: one warning per server and process is enough.
const headersKeptWarned = new Set<string>();

function warnHeadersKept(id: string, why: string): void {
  if (headersKeptWarned.has(id)) return;
  headersKeptWarned.add(id);
  console.warn(`[timon] mcp ${id}: its headers stay in its file, the secrets vault could not take them (${why}); agents do not get this server until it can`);
}

/**
 * The headers to store, sealed into the vault when it can take them: `refs`
 * for the vault, `file` for what stays in the server's file — an empty value
 * (not a secret, and one the vault refuses), or every value when the vault is
 * off or locked, as the server was written before the vault held headers.
 */
function sealOrKeep(id: string, clear: Record<string, string>): { refs: Record<string, McpHeaderSecret>; file: Record<string, string> } {
  const values = Object.fromEntries(Object.entries(clear).filter(([, value]) => value !== ''));
  if (!hasEntries(values)) return { refs: {}, file: clear };
  const sealed = sealHeaders(id, values);
  if ('failure' in sealed) {
    warnHeadersKept(id, sealed.failure);
    return { refs: {}, file: clear };
  }
  headersKeptWarned.delete(id);
  return { refs: sealed.refs, file: Object.fromEntries(Object.entries(clear).filter(([, value]) => value === '')) };
}

/**
 * Moves into the vault the headers a server's file still holds in clear
 * (written before the vault held them, or while it was off or locked). Unlike
 * OAuth tokens, nothing is dropped: when the vault cannot take them — switched
 * off, its master key unreadable — the file is left as it is and a warning
 * names the server, never a value; the server stays out of the launches as it
 * already was. Idempotent, run at every boot.
 */
export function migrateMcpHeadersToVault(): { moved: string[]; kept: string[] } {
  const moved: string[] = [];
  const kept: string[] = [];
  if (!existsSync(MCP_DIR)) return { moved, kept };
  for (const f of readdirSync(MCP_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    const s = readFileRecord(id);
    if (!s || s.transport.type !== 'http') continue;
    if (!Object.values(s.transport.headers ?? {}).some((value) => value !== '')) continue;
    const { refs, file } = sealOrKeep(id, s.transport.headers ?? {});
    if (!hasEntries(refs)) { kept.push(id); continue; }
    const { headers: _clear, ...rest } = s.transport;
    const next: McpStoredServer = {
      ...s,
      transport: { ...rest, ...(hasEntries(file) ? { headers: file } : {}), header_secrets: { ...rest.header_secrets, ...refs } },
    };
    try {
      writeFileRecord(next);
    } catch (err) {
      deleteRefs(refs);
      warnHeadersKept(id, (err as Error).name);
      kept.push(id);
      continue;
    }
    forgetUnreferencedKeys(id, s, next);
    moved.push(id);
  }
  return { moved, kept };
}

function headerSecretIds(s: McpStoredServer | null): string[] {
  return s?.transport.type === 'http' ? Object.values(s.transport.header_secrets ?? {}).map((ref) => ref.secret_id) : [];
}

/**
 * Deletes from the vault the keys `before` named and `after` no longer does
 * (`after` null: the server is gone). A vault-held key belongs to its server:
 * left behind, it would be a credential nobody can see the use of.
 */
function forgetUnreferencedKeys(id: string, before: McpStoredServer | null, after: McpStoredServer | null): void {
  const still = new Set(headerSecretIds(after));
  for (const secretId of headerSecretIds(before)) {
    if (still.has(secretId)) continue;
    try {
      deleteSecret(secretId);
    } catch (err) {
      console.warn(`[timon] mcp ${id}: its key ${secretId} could not be removed from the vault: ${(err as Error).message}`);
    }
  }
}

function withoutHeaderSecrets(transport: McpStdioConfig | McpStoredHttpConfig): McpStdioConfig | McpStoredHttpConfig {
  if (transport.type !== 'http' || !('header_secrets' in transport)) return transport;
  const { header_secrets: _dropped, ...rest } = transport;
  return rest;
}

/**
 * Deletes the stubs of the servers Timon injects, which earlier versions
 * auto-discovered from the harness's `init`. Returns the ids removed.
 * Idempotent: only an external-transport entry is touched — a server the user
 * added under such a name is a stdio/http one, and stays.
 */
export function purgeInjectedMcpStubs(): string[] {
  if (!existsSync(MCP_DIR)) return [];
  const removed: string[] = [];
  for (const f of readdirSync(MCP_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    const s = readRaw(id);
    if (!s || !isInjectedStub(s)) continue;
    rmSync(fpath(id));
    removed.push(id);
  }
  return removed;
}

/**
 * Relabels the stubs earlier versions flagged `claude_ai` although claude had
 * them from the user's local configuration. Returns the ids relabelled.
 * Idempotent; a description the user edited is kept.
 */
export function relabelLocalClaudeStubs(): string[] {
  if (!existsSync(MCP_DIR)) return [];
  const relabelled: string[] = [];
  for (const f of readdirSync(MCP_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    const s = readRaw(id);
    if (!s || s.source !== 'claude_ai' || s.transport.type !== 'external') continue;
    if (isClaudeAiConnectorKey(s.transport.claude_key)) continue;
    const description = s.description === DISCOVERED_DESCRIPTION.claude_ai
      ? DISCOVERED_DESCRIPTION.claude_cli
      : s.description;
    writeRaw({ ...s, source: 'claude_cli', description });
    relabelled.push(id);
  }
  return relabelled;
}

/**
 * Holds to public addresses every `http` server a mission or a plugin declared
 * before the rule existed (TODO #530): it carries `created_by` but no
 * `public_only` at all, and cannot be told from one a holder of
 * agents:privileged-config wrote — whose writes now say `false`. The safe
 * reading wins: it is judged again at each launch and goes through the pinned
 * proxy; one that points at this host or the LAN is left out until a human
 * saves it again from the MCP servers page, which lifts the mark. Returns the
 * ids held. Idempotent: every write since sets the field, so it runs at every boot.
 */
export function holdLegacyMissionServersToPublic(): string[] {
  if (!existsSync(MCP_DIR)) return [];
  const held: string[] = [];
  for (const f of readdirSync(MCP_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    const s = readRaw(id);
    if (!s || s.transport.type !== 'http' || !s.created_by || s.public_only !== undefined) continue;
    writeRaw({ ...s, public_only: true });
    held.push(id);
  }
  return held;
}

export function deleteMcp(id: string): boolean {
  validId(id);
  const p = fpath(id);
  if (!existsSync(p)) return false;
  const s = readRaw(id);
  rmSync(p);
  forgetUnreferencedKeys(id, s, null);
  forgetMcpOAuthTokens(id);
  return true;
}

/**
 * The headers `header_secrets` names, read from the vault; `null` when one
 * cannot be (vault switched off, locked, secret deleted): the server is then
 * left out of the launch, and the relay answers it as not connected, rather
 * than sending it without its key.
 */
function vaultHeaders(id: string, transport: McpStoredHttpConfig): Record<string, string> | null {
  const entries = Object.entries(transport.header_secrets ?? {});
  if (!entries.length) return {};
  if (!vaultEnabled()) {
    console.warn(`[timon] mcp ${id} unavailable: its key is in the vault, which is switched off`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const [header, ref] of entries) {
    try {
      out[header] = (ref.prefix ?? '') + readSecretValue(ref.secret_id);
    } catch (err) {
      console.warn(`[timon] mcp ${id} unavailable: its key for ${header} cannot be read (${(err as Error).message})`);
      return null;
    }
  }
  return out;
}

/**
 * Persist OAuth state for an MCP server. Used by the /oauth/* routes.
 * Returns the updated server, or null if it doesn't exist or isn't http.
 * `oauth.tokens` go to the vault (`writeRaw`); without them, the stored ones
 * are kept. Throws `McpOAuthVaultUnavailableError` when tokens arrive and the vault is off.
 */
export function setMcpOAuth(
  id: string,
  oauth: NonNullable<McpHttpConfig['oauth']>,
): McpServer | null {
  validId(id);
  const s = readRaw(id);
  if (!s || s.transport.type !== 'http') return null;
  const next: McpServer = {
    ...s,
    transport: { ...s.transport, oauth },
    last_status: oauth.tokens || readMcpOAuthTokens(id, s.transport.url) ? 'connected' : 'needs-auth',
    last_seen_at: Date.now(),
  };
  writeRaw(next);
  return next;
}

/**
 * Refresh the access_token for an MCP if expired and we have a refresh_token;
 * `force` refreshes whatever the clock says (the server answered 401).
 */
async function maybeRefreshTokens(s: McpServer, force = false): Promise<McpServer> {
  if (s.transport.type !== 'http' || !s.transport.oauth) return s;
  const tokens = oauthTokensOf(s);
  if (!tokens?.refresh_token) return s;
  const { metadata, client } = s.transport.oauth;
  // Refresh ~30s before actual expiry to avoid races.
  const fresh = tokens.expires_at && tokens.expires_at - 30_000 > Date.now();
  if (fresh && !force) return s;
  try {
    const next = await refreshTokens(metadata, client, tokens.refresh_token);
    const updated: McpServer = {
      ...s,
      transport: {
        ...s.transport,
        oauth: { ...s.transport.oauth, tokens: next },
      },
    };
    // Deleted while the provider answered: writing would bring it, and its tokens, back.
    if (!readFileRecord(s.id)) return s;
    writeRaw(updated);
    return updated;
  } catch (err) {
    // Opaque on purpose: a parse error quotes the provider's body, a network error its url.
    const why = err instanceof OAuthRefreshError ? `HTTP ${err.status}` : (err as Error).name;
    console.warn(`[timon] refresh failed for mcp ${s.id} (${why})`);
    return s;
  }
}

// One refresh at a time per server: a provider that rotates its refresh token
// invalidates the second of two concurrent refreshes, and with it the connection.
const refreshing = new Map<string, Promise<McpServer>>();

async function refreshOnce(s: McpServer, force = false): Promise<McpServer> {
  const running = refreshing.get(s.id);
  if (running) return running;
  const next = maybeRefreshTokens(s, force).finally(() => refreshing.delete(s.id));
  refreshing.set(s.id, next);
  return next;
}

async function launchHostRefusal(url: string): Promise<string | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return 'invalid url';
  }
  return mcpHostAddressRefusal(hostname);
}

/** The proxy serves a launch only while its server is still declared at that origin. */
function sameHttpOrigin(id: string, origin: string): boolean {
  const s = readRaw(id);
  if (!s || s.transport.type !== 'http') return false;
  try {
    return new URL(s.transport.url).origin === origin;
  } catch {
    return false;
  }
}

function hasEntries(record: Record<string, unknown> | undefined): boolean {
  return record !== undefined && Object.keys(record).length > 0;
}

/**
 * Whether a server reaches its CLI only through the daemon's relay: it carries
 * a credential — an OAuth connection, headers of its own, or headers whose
 * value the vault holds — which must not be written into the CLI's
 * configuration, in the mission's scratch folder.
 */
function relayedServer(s: McpStoredServer): s is McpStoredServer & { transport: McpStoredHttpConfig } {
  if (s.transport.type !== 'http') return false;
  return Boolean(s.transport.oauth) || hasEntries(s.transport.headers) || hasEntries(s.transport.header_secrets);
}

/** What a launch hands a CLI for a server that carries a credential (`mcp-relay.ts`). */
export type McpRelayMinter = (server: { id: string; url: string }) => { url: string; headers: Record<string, string> } | null;

/**
 * The servers `ids` name, ready to be written for a CLI: external connectors
 * skipped (they are loaded by claude itself) and a server that carries a
 * credential — OAuth, stored headers, vault-held headers — replaced by the
 * daemon's relay (`relay`), so that neither its bearer nor its headers reach
 * the CLI's configuration. Without `relay` — no mission to bind the relay token
 * to — or without a relay key (vault off), such a server is left out. The
 * CLI-specific text is `backends/mcp-serialize.ts`, which a provider plugin shares.
 */
export async function resolveLaunchServers(ids: string[], relay?: McpRelayMinter): Promise<McpLaunchServer[]> {
  const out: McpLaunchServer[] = [];
  for (const id of ids) {
    const s = readRaw(id);
    if (!s) continue;
    // External MCPs are loaded by claude itself — we don't inline them into
    // any CLI's configuration (they would not know what to do with type:'external').
    if (s.transport.type === 'external') continue;
    // The record the write was judged on may have been changed since: a name
    // that now points at this host or the LAN is not handed to the CLI.
    if (s.public_only && s.transport.type === 'http') {
      const refusal = await launchHostRefusal(s.transport.url);
      if (refusal) {
        console.warn(`[timon] mcp ${id} left out of the launch: ${refusal}`);
        continue;
      }
    }
    const name = s.name && /^[A-Za-z0-9_-]+$/.test(s.name) ? s.name : id;
    if (relayedServer(s)) {
      // A key the vault cannot give now would only reach the CLI as a dead server.
      if (!vaultHeaders(id, s.transport)) continue;
      // The relay adds the bearer and the headers itself, refreshing an OAuth
      // token when it is due, and pins a `public_only` server's address at
      // every request: the CLI gets none of them.
      if (!relay) {
        console.warn(`[timon] mcp ${id} left out of the launch: a server with credentials goes through the relay, and this launch has no mission to bind it to`);
        continue;
      }
      const target = relay({ id, url: s.transport.url });
      if (!target) {
        console.warn(`[timon] mcp ${id} left out of the launch: the MCP relay is unavailable (secrets vault off)`);
        continue;
      }
      out.push({ type: 'http', name, ...target });
      continue;
    }
    if (s.transport.type === 'stdio') {
      out.push({
        type: 'stdio',
        name,
        command: s.transport.command,
        args: s.transport.args ?? [],
        env: s.transport.env ?? {},
      });
    } else if (s.transport.type === 'http') {
      if (s.public_only) {
        // The check above proves nothing to a CLI that resolves the name again
        // later: it talks to a loopback proxy that connects to the address it
        // judged, at every request (TODO #577).
        const origin = new URL(s.transport.url).origin;
        const pinned = await pinnedLaunchTarget(id, s.transport.url, () => sameHttpOrigin(id, origin));
        out.push({ type: 'http', name, url: pinned.url, headers: { ...pinned.headers } });
      } else {
        out.push({ type: 'http', name, url: s.transport.url, headers: {} });
      }
    }
  }
  return out;
}

/** The relayed server a relay route leads to: `null` once deleted, moved to another url, or no longer relayed. */
export function mcpRelayServerForRoute(route: string): string | null {
  if (!existsSync(MCP_DIR)) return null;
  for (const f of readdirSync(MCP_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    const s = readRaw(id);
    if (!s || !relayedServer(s)) continue;
    if (mcpRelayRoute(id, s.transport.url) === route) return id;
  }
  return null;
}

/** Where the relay sends a request for a server, with what. Never leaves the daemon. */
export type McpRelayUpstream = {
  url: string;
  /** The stored headers, the vault-held ones and, for an OAuth server, the current bearer. */
  headers: Record<string, string>;
  /** Held to public addresses (`McpServer.public_only`): the relay pins every hop. */
  publicOnly: boolean;
};

/**
 * The upstream of a relayed server, read at every request — a server deleted,
 * moved, disconnected, or whose vault-held key cannot be read is `null`.
 * `rejected` is the `Authorization` the server just answered 401 to: an OAuth
 * token is then refreshed once, unless another request already did; `null`
 * when it could not be (no refresh token, the provider refused, or a server
 * with no OAuth, whose key nothing can renew), so the caller stops instead of
 * replaying a dead credential.
 */
export async function mcpRelayUpstream(id: string, rejected?: string): Promise<McpRelayUpstream | null> {
  validId(id);
  // A refresh in flight is waited for: it may be the one that settles this request.
  await refreshing.get(id)?.catch(() => undefined);
  let s = readRaw(id);
  if (!s || !relayedServer(s)) return null;
  const current = (server: McpStoredServer): McpRelayUpstream | null => {
    if (server.transport.type !== 'http') return null;
    const fromVault = vaultHeaders(server.id, server.transport);
    if (!fromVault) return null;
    const headers = { ...(server.transport.headers ?? {}), ...fromVault };
    if (server.transport.oauth) {
      const tok = oauthTokensOf(server);
      if (!tok) return null;
      if (!headers.Authorization && !headers.authorization) {
        headers.Authorization = `${tok.token_type || 'Bearer'} ${tok.access_token}`;
      }
    }
    return { url: server.transport.url, headers, publicOnly: server.public_only === true };
  };
  if (!s.transport.oauth) return rejected === undefined ? current(s) : null;
  if (!oauthTokensOf(s)) return null;
  if (rejected === undefined) return current(await refreshOnce(s));
  const before = current(s);
  if (before && authorizationOf(before) !== rejected) return before;
  s = await refreshOnce(s, true);
  const after = current(s);
  return after && authorizationOf(after) !== rejected ? after : null;
}

function authorizationOf(upstream: McpRelayUpstream): string | undefined {
  return upstream.headers.Authorization ?? upstream.headers.authorization;
}

/**
 * Build the `.mcp.json` blob claude expects, restricted to the given server
 * ids. Returns the JSON string ready to pass via --mcp-config <string>.
 * Returns null if no valid servers resolved.
 *
 * Async because we may refresh OAuth tokens inline when they're stale.
 */
export async function buildMcpConfig(ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  return serializeMcpJson(await resolveLaunchServers(ids));
}

/**
 * Build the `[mcp_servers.*]` blocks for a Codex `config.toml`, restricted to
 * the given server ids (stdio: command/args/env, http: url/http_headers).
 * External (claude.ai) MCPs are skipped — they don't apply to Codex.
 */
export async function buildCodexMcpToml(ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  return serializeCodexMcpToml(await resolveLaunchServers(ids));
}

/** The same for a grok `config.toml` (cf. `serializeGrokMcpToml`). */
export async function buildGrokMcpToml(ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  return serializeGrokMcpToml(await resolveLaunchServers(ids));
}

/**
 * Walk a system:init payload from claude and update each known MCP's tools
 * cache + connection status. Tool names are of the form mcp__<server>__<tool>
 * where <server> is the original key from .mcp.json with non-alnum chars
 * replaced by underscores. We match by trying both the server name and the id.
 */
export function refreshToolsCacheFromInit(initPayload: unknown): void {
  if (!initPayload || typeof initPayload !== 'object') return;
  const p = initPayload as Record<string, unknown>;
  const tools = Array.isArray(p.tools) ? (p.tools as unknown[]) : [];
  const serversStatus = Array.isArray(p.mcp_servers)
    ? (p.mcp_servers as Array<{ name?: string; status?: string }>)
    : [];

  // Index TIMON-managed entries by the claude key they'd surface as.
  type Indexed = { id: string; raw: McpServer; claudeKey: string };
  const timonByKey = new Map<string, Indexed>();
  if (existsSync(MCP_DIR)) {
    for (const f of readdirSync(MCP_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      if (!ID_RE.test(id)) continue;
      const raw = readRaw(id);
      if (!raw || isInjectedStub(raw)) continue;
      const claudeKey =
        raw.transport.type === 'external'
          ? raw.transport.claude_key
          : raw.name && /^[A-Za-z0-9_-]+$/.test(raw.name)
          ? raw.name
          : raw.id;
      timonByKey.set(claudeKey, { id, raw, claudeKey });
    }
  }

  // 1) Auto-create stub entries for MCPs claude knows about but TIMON doesn't:
  //    claude.ai account connectors, or servers from the user's own claude
  //    configuration.
  for (const s of serversStatus) {
    const key = s.name;
    if (!key) continue;
    // Skip the servers Timon injects itself (`timon`, the forms MCP under its
    // current and former names, the embedded browser, grepai): they are an
    // implementation detail, not an account connector the user could toggle.
    // Listed as one, the entry reads as a second `timon` and excluding it
    // bans the real server's tools.
    if (isInjectedMcpServer(key)) continue;
    if (timonByKey.has(key)) continue;
    const id = ('ext-' + key).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    if (!ID_RE.test(id)) continue;
    const source = discoveredSource(key);
    const stub: McpServer = {
      id,
      name: key,
      description: DISCOVERED_DESCRIPTION[source],
      transport: { type: 'external', claude_key: key },
      source,
      last_status: (s.status as McpServer['last_status']) ?? 'connected',
      last_seen_at: Date.now(),
    };
    writeRaw(stub);
    timonByKey.set(key, { id, raw: stub, claudeKey: key });
  }

  // 2) For every server we now know about (managed + external), gather tools
  //    and update status from this init payload.
  for (const { raw, claudeKey } of timonByKey.values()) {
    const prefix = 'mcp__' + claudeKey.replace(/[^A-Za-z0-9]+/g, '_') + '__';
    const myTools: string[] = [];
    for (const t of tools) {
      if (typeof t === 'string' && t.startsWith(prefix)) {
        myTools.push(t.slice(prefix.length));
      }
    }
    const statusEntry = serversStatus.find(
      (s) => s.name === claudeKey || s.name === raw.name || s.name === raw.id,
    );
    const next: McpServer = { ...raw };
    if (myTools.length) {
      next.tools_cache = myTools.sort();
      next.tools_cached_at = Date.now();
    }
    if (statusEntry?.status) {
      next.last_status = statusEntry.status as McpServer['last_status'];
      next.last_seen_at = Date.now();
    }
    if (myTools.length || statusEntry) {
      writeRaw(next);
    }
  }
}

/**
 * grepai MCP server to inject for a mission, or null.
 *
 * grepai is "global" in the sense that it does not have to be declared agent by agent:
 * the server is cwd-bound (it resolves the project from its launch
 * directory), so a single rule is enough — inject it wherever there is
 * something to query.
 *
 * Conditioned on `<cwd>/.grepai` existing: without an index, `mcp-serve`
 * would start for nothing and add a failing server to the spawn of every
 * agent of an unindexed project (10 projects out of 14 today).
 *
 * Injected by the claude and codex dialects, just like `timon` and
 * `timon_ask` — that is what makes it backend-agnostic.
 */
export function grepaiMcpEntry(cwd?: string | null): { command: string; args: string[] } | null {
  if (!cwd) return null;
  if (!existsSync(join(cwd, '.grepai'))) return null;
  return { command: 'grepai', args: ['mcp-serve'] };
}
