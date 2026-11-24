/** Write-only browser passwords. Sealed plugin settings participate in the
 * existing vault's key-loss protection and atomic key rotation. */
import { randomUUID } from 'node:crypto';
import { db, dbApi } from './db.js';
import type { BrowserProfile } from './browser-profiles.js';
import { isSealed } from './secrets/box.js';
import { openWithVault, pluginKvIdentity, readSecretValue, sealWithVault } from './secrets/store.js';
import { boundBrowserSecret, requestedBrowserCredentials, REQUESTED_CREDENTIAL_PREFIX } from './secrets/requests.js';
import { callNativeBrowser, NativeBrowserError } from './native-browser-provider.js';
import { apiError } from './api-error.js';

const STORE = '@timon/browser-embedded';
const META_PREFIX = 'browser-credentials/';
const SECRET_PREFIX = '@settings/browser-credentials/';
const CREDENTIAL_ID = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type BrowserCredentialMetadata = {
  id: string;
  profileId: string;
  origin: string;
  label: string;
  usernameHint: string;
  createdAt: number;
  updatedAt: number;
};
export type BrowserCredentialInput = {
  id?: string;
  origin: string;
  label?: string;
  username: string;
  password: string;
};
type StoredCredential = {
  version: 1;
  id: string;
  profileId: string;
  ownerUserId: string | null;
  origin: string;
  username: string;
  password: string;
};

/** A full page URL is accepted at save time; only its exact canonical origin
 * is persisted. Userinfo is rejected, not silently stripped. */
export function canonicalCredentialOrigin(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 16_384) throw new NativeBrowserError(apiError('browser_origin_invalid', 'A valid HTTP or HTTPS origin is required.'));
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) throw new Error();
    return url.origin;
  } catch { throw new NativeBrowserError(apiError('browser_origin_invalid', 'A valid HTTP or HTTPS origin without userinfo is required.')); }
}

const metaKey = (profile: BrowserProfile, id: string) => `${META_PREFIX}${profile.id}/${id}`;
const secretKey = (profile: BrowserProfile, id: string) => `${SECRET_PREFIX}${profile.id}/${id}`;
const unavailable = () => new NativeBrowserError(apiError('browser_vault_unavailable', 'The browser credential vault is unavailable or its encrypted data is invalid.'), 503);

function metadata(profile: BrowserProfile, value: string): BrowserCredentialMetadata {
  try {
    const row = JSON.parse(value) as BrowserCredentialMetadata;
    if (!row || !CREDENTIAL_ID.test(row.id) || row.profileId !== profile.id
      || canonicalCredentialOrigin(row.origin) !== row.origin || typeof row.label !== 'string'
      || typeof row.usernameHint !== 'string' || !Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt)) throw new Error();
    return { id: row.id, profileId: row.profileId, origin: row.origin, label: row.label,
      usernameHint: row.usernameHint, createdAt: row.createdAt, updatedAt: row.updatedAt };
  } catch { throw unavailable(); }
}

function getMetadata(profile: BrowserProfile, id: string): BrowserCredentialMetadata {
  if (typeof id !== 'string' || !CREDENTIAL_ID.test(id)) throw new NativeBrowserError(apiError('browser_credential_not_found', 'Browser credential not found.'), 404);
  const raw = dbApi.pluginKvGet(STORE, metaKey(profile, id));
  if (!raw) throw new NativeBrowserError(apiError('browser_credential_not_found', 'Browser credential not found.'), 404);
  const row = metadata(profile, raw);
  if (row.id !== id) throw unavailable();
  return row;
}

/** Never export a decrypt-by-id operation. Plaintext is only used by the
 * daemon's private, origin-checking provider command below. */
function readCredential(profile: BrowserProfile, row: BrowserCredentialMetadata): StoredCredential {
  try {
    const key = secretKey(profile, row.id);
    const envelope = dbApi.pluginKvGet(STORE, key);
    if (!envelope || !isSealed(envelope)) throw new Error();
    const value = JSON.parse(openWithVault(envelope, pluginKvIdentity(STORE, key))) as StoredCredential;
    if (value.version !== 1 || value.id !== row.id || value.profileId !== profile.id
      || value.ownerUserId !== profile.owner_user_id || value.origin !== row.origin
      || typeof value.username !== 'string' || typeof value.password !== 'string' || !value.password) throw new Error();
    return value;
  } catch { throw unavailable(); }
}

/** The caller must resolve/authorize the profile first. Metadata never requires
 * opening the vault and contains neither the username nor password. */
export function listBrowserCredentials(profile: BrowserProfile): BrowserCredentialMetadata[] {
  return dbApi.pluginKvList(STORE, `${META_PREFIX}${profile.id}/`)
    .map((row) => metadata(profile, row.value)).sort((a, b) => a.origin.localeCompare(b.origin) || a.label.localeCompare(b.label));
}

/** Internal write primitive; the HTTP facade admits signed-in owners only. */
export function upsertBrowserCredential(profile: BrowserProfile, input: BrowserCredentialInput): BrowserCredentialMetadata {
  const origin = canonicalCredentialOrigin(input.origin);
  if (typeof input.username !== 'string' || input.username.length > 1024 || input.username.includes('\0')) throw new NativeBrowserError(apiError('browser_credential_username_invalid', 'The username is invalid.'));
  if (typeof input.password !== 'string' || !input.password || input.password.length > 16_384 || input.password.includes('\0')) throw new NativeBrowserError(apiError('browser_credential_password_required', 'A non-empty password is required.'));
  if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 160 || /[\u0000-\u001f]/.test(input.label))) throw new NativeBrowserError(apiError('browser_credential_label_invalid', 'The credential label is invalid.'));
  let previous: BrowserCredentialMetadata | undefined;
  if (input.id !== undefined) previous = getMetadata(profile, input.id);
  else {
    // An explicit Save on the same form updates the account, instead of adding
    // a duplicate on every login. No plaintext is returned by this lookup.
    previous = listBrowserCredentials(profile).find((row) => row.origin === origin && readCredential(profile, row).username === input.username);
  }
  const id = previous?.id ?? `bc-${randomUUID()}`;
  const now = Date.now();
  const row: BrowserCredentialMetadata = {
    id, profileId: profile.id, origin, label: input.label?.trim() || previous?.label || new URL(origin).hostname,
    usernameHint: input.username ? `${[...input.username][0]}•••` : '', createdAt: previous?.createdAt ?? now, updatedAt: now,
  };
  const plain: StoredCredential = { version: 1, id, profileId: profile.id, ownerUserId: profile.owner_user_id, origin,
    username: input.username, password: input.password };
  const key = secretKey(profile, id);
  let envelope: string;
  try { envelope = sealWithVault(JSON.stringify(plain), pluginKvIdentity(STORE, key)); }
  catch { throw unavailable(); }
  db.transaction(() => {
    dbApi.pluginKvSet(STORE, key, envelope);
    dbApi.pluginKvSet(STORE, metaKey(profile, id), JSON.stringify(row));
  })();
  return row;
}

export function deleteBrowserCredential(profile: BrowserProfile, id: string): boolean {
  getMetadata(profile, id);
  db.transaction(() => {
    dbApi.pluginKvDelete(STORE, secretKey(profile, id));
    dbApi.pluginKvDelete(STORE, metaKey(profile, id));
  })();
  return true;
}

/** Must run under the same controller lease/queue as ordinary browser input.
 * Origin/form checks and filling happen atomically INSIDE the provider. */
export async function fillBrowserCredential(profile: BrowserProfile, credentialId: string, call: typeof callNativeBrowser = callNativeBrowser,
  commandActor: 'human' | 'agent' = 'agent'): Promise<{ filled: true }> {
  const credential = readCredential(profile, getMetadata(profile, credentialId));
  try {
    // The id lets a recording name the entry (never its secret); the actor is the daemon's own marking.
    const result = await call(profile.id, { action: 'fillCredential', origin: credential.origin, credentialId: credential.id,
      username: credential.username, password: credential.password, commandActor }) as { filled?: unknown };
    if (result?.filled !== true) throw new Error();
    return { filled: true };
  } catch {
    // Provider/DOM error text can be site-controlled. Never echo it after
    // supplying credentials, even if it appears to be an ordinary exception.
    throw new NativeBrowserError(apiError('browser_credential_fill_refused', 'Credential filling was refused. Check the exact site origin and login form.'), 409);
  }
}

/** A value the mission's user typed for a page (`secret_request` with `origin`), as `list_credentials` shows it. */
export type RequestedCredentialMetadata = {
  id: string;
  origin: string;
  label: string;
  source: 'request';
  lifetime: string;
};

/** The mission's requested page values, for `list_credentials`. A human's list never has them: they belong to one mission. */
export function listRequestedCredentials(missionId: string | null | undefined): RequestedCredentialMetadata[] {
  return requestedBrowserCredentials(missionId).map((c) => ({ id: c.id, origin: c.origin, label: c.name, source: 'request', lifetime: c.lifetime }));
}

export const isRequestedCredentialId = (id: unknown): boolean => typeof id === 'string' && id.startsWith(REQUESTED_CREDENTIAL_PREFIX);

/** What a requested fill needs besides the provider: injectable in tests. */
export type RequestedFillDeps = {
  openValue?: (secretId: string) => string;
  journal?: typeof dbApi.recordSecretAccess;
};

/**
 * Fill a value the user typed for THIS mission (`secret_request` with
 * `origin`) into the current page: its password field, or its one-time-code
 * field — never a username, never a submit. The mission id comes from the
 * caller's token; another mission's id answers like an unknown one.
 *
 * The page's origin is read first, with no value in the command: a fill aimed
 * at the wrong page is refused before the value leaves the daemon, so a `once`
 * value is not burnt by a mistake. The provider checks the origin again inside
 * the page, atomically with the fill (the page may have navigated in between).
 * A `once` value's use is claimed atomically just before it is handed to the
 * provider, and from then on it is spent whatever the outcome: it may already
 * sit in the page's context.
 */
export async function fillRequestedCredential(profile: BrowserProfile, missionId: string | null | undefined, credentialId: unknown,
  call: typeof callNativeBrowser = callNativeBrowser, deps: RequestedFillDeps = {}): Promise<{ filled: true }> {
  const bound = boundBrowserSecret(missionId, credentialId);
  if (!bound) throw new NativeBrowserError(apiError('browser_credential_not_found', 'Browser credential not found.'), 404);
  const journal = deps.journal ?? ((line) => dbApi.recordSecretAccess(line));
  const note = (outcome: 'ok' | 'denied', detail: string): void => {
    journal({ secret_id: bound.secretId, name: bound.name, mission_id: missionId ?? null, agent: bound.agent, kind: 'fill', outcome, detail, at: Date.now() });
  };
  const wrongPage = new NativeBrowserError(apiError('browser_credential_wrong_origin', `This value may only be filled on ${bound.origin}. Open a page of that exact origin first.`, { origin: bound.origin }), 409);
  let pageOrigin: unknown;
  try {
    pageOrigin = ((await call(profile.id, { action: 'evaluate', expression: 'location.origin', commandActor: 'agent' })) as { result?: unknown } | null)?.result;
  } catch {
    throw new NativeBrowserError(apiError('browser_page_unchecked', 'The current page could not be checked.'), 409);
  }
  if (pageOrigin !== bound.origin) {
    note('denied', `wrong page (expected ${bound.origin})`);
    throw wrongPage;
  }
  let value: string;
  try {
    value = (deps.openValue ?? readSecretValue)(bound.secretId);
  } catch {
    note('denied', 'decrypt-failed');
    throw unavailable();
  }
  // The origin check above was awaited: a second fill of the same `once` value
  // may have passed it too. The one use is claimed now, before the value goes
  // to the provider — a single conditional update, only one fill wins it.
  if (!bound.claim()) {
    note('denied', 'once: already used');
    throw new NativeBrowserError(apiError('browser_credential_not_found', 'Browser credential not found.'), 404);
  }
  try {
    const result = await call(profile.id, { action: 'fillCredential', origin: bound.origin, credentialId: String(credentialId),
      username: null, password: value, commandActor: 'agent' }) as { filled?: unknown };
    if (result?.filled !== true) throw new Error();
    note('ok', `filled on ${bound.origin}`);
    return { filled: true };
  } catch {
    // Same rule as a saved login: the provider's words may be the page's.
    note('denied', `fill refused on ${bound.origin}`);
    throw new NativeBrowserError(apiError('browser_credential_fill_refused', 'Credential filling was refused. Check the exact site origin and that the page shows one password or one-time-code field.'), 409);
  } finally {
    bound.used(`browser fill on ${bound.origin}`);
  }
}

/** User action only. This is a dedicated provider command, never arbitrary
 * evaluation supplied by a page or caller; capture results stay in the daemon. */
export async function saveBrowserCredentialFromPage(profile: BrowserProfile, label?: string, call: typeof callNativeBrowser = callNativeBrowser,
  commandActor: 'human' | 'agent' = 'agent'): Promise<{ credential: BrowserCredentialMetadata }> {
  let captured: unknown;
  try { captured = await call(profile.id, { action: 'captureCredential', commandActor }); }
  catch { throw new NativeBrowserError(apiError('browser_login_form_unsaved', 'The current login form could not be saved. Check the page and form origin.'), 409); }
  if (!captured || typeof captured !== 'object') throw new NativeBrowserError(apiError('browser_login_form_missing', 'The current page has no supported login form.'), 409);
  const value = captured as Record<string, unknown>;
  if (typeof value.origin !== 'string' || typeof value.username !== 'string' || typeof value.password !== 'string') throw new NativeBrowserError(apiError('browser_login_form_missing', 'The current page has no supported login form.'), 409);
  return { credential: upsertBrowserCredential(profile, { origin: value.origin, username: value.username, password: value.password, label }) };
}
