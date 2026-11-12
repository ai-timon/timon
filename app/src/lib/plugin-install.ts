/**
 * The gallery's install flow (TODO #332): what the daemon's
 * `/api/plugins/-/install/*` routes return, and the calls the page makes
 * through the Next proxy (`/api/ui/plugin-install/*`).
 *
 * The daemon decides everything: who may install (a superadmin signed in to
 * the app), whether a package is altered, whether it would load. The browser
 * only shows the preview and sends the confirmation — nothing installs before
 * that click, and the token it carries is all the daemon trusts.
 */
import { t } from '@/lib/i18n';
import { pathsToAuthorize, type ProviderBinary } from '@/lib/providers';
import { settingsPath } from '@/lib/settings-path';

export type InstallSignature =
  | { state: 'signed'; keyId: string }
  | { state: 'unsigned'; loads: boolean }
  | { state: 'tampered' };

export type PluginPreview = {
  token: string;
  origin: 'upload' | 'path' | 'detected';
  format: 'archive' | 'folder';
  pkg: string;
  version: string;
  id: string | null;
  label: string | null;
  description: string | null;
  author: string | null;
  kind: string[];
  permissions: string[];
  slots: string[];
  route: string | null;
  declares: Record<string, string>;
  modifies: string[];
  contains: string[];
  settings: string[];
  webhooks: string[];
  licenseRequired: boolean;
  /** `kind: provider` only: the programs it launches, as the daemon resolves them on its machine. */
  provider: { binaries: ProviderBinary[]; osCredentials?: Array<{ service: string; account?: string }>; credentialDirs?: string[] } | null;
  /** `kind: dictation` only: where each engine sends the voice (read through `readDictationDecl`). Absent from older daemons. */
  dictation?: unknown;
  /** The secrets and hosts the manifest names, where each stands on this daemon (TODO #599). `null`: it names none; absent from older daemons. */
  vault?: PluginVault | null;
  /** `kind: bundle` only: each entry of `contains`, as the daemon could read it (TODO #660). Absent from older daemons. */
  children?: BundleChildPreview[];
  /** `data:` URLs built by the daemon from files the manifest names. */
  icon: string | null;
  cover: string | null;
  signature: InstallSignature;
  manifestError: string | null;
  /** `engines.node` excludes the Node the daemon runs plugins on (TODO #763). Absent from older daemons. */
  engineError?: string | null;
  installed: { version: string } | null;
  /** npm name of the package gone from this id, whose grants go when this one lands. Absent from older daemons. */
  replaces?: string | null;
  /** This signed package updates an unsigned copy of itself: data, settings and grants kept. Absent from older daemons. */
  updatesUnsigned?: boolean;
  installable: boolean;
  blocked: 'manifest' | 'tampered' | 'node-engine' | null;
};

/**
 * Where a named secret stands on the daemon (`plugins/vault-grants.ts`):
 * only `grantable` can be ticked; `missing` is created on the Secrets page;
 * `ambiguous` (several entries of that name) is a choice the Secrets page makes.
 */
export type PluginSecretState = 'granted' | 'grantable' | 'missing' | 'ambiguous' | 'vault-off';

export type PluginVaultSecret = {
  name: string;
  mode: 'read' | 'broker';
  /** The author's words, shown as they are: they cannot be translated. */
  why: string | null;
  present: boolean;
  /** An entry of this name exists only for the other mode, which would not serve. */
  otherMode: boolean;
  state: PluginSecretState;
};

export type PluginVaultHost = {
  host: string;
  why: string | null;
  /** `global`: already open to every plugin; `plugin`: already open to this one. */
  allowedBy: 'global' | 'plugin' | null;
};

export type PluginVault = { scope: string; secrets: PluginVaultSecret[]; hosts: PluginVaultHost[] };

/** What the confirmation carries back: EVERY line as it was shown, ticked or not — any difference is a 409. */
export type VaultConsent = {
  secrets: Array<{ name: string; mode: 'read' | 'broker'; state: PluginSecretState; grant: boolean }>;
  hosts: Array<{ host: string; allowedBy: 'global' | 'plugin' | null; grant: boolean }>;
};

/** The boxes of the sheet, by secret name and by host. */
export type VaultTicks = { secrets: Record<string, boolean>; hosts: Record<string, boolean> };

export function secretTickable(secret: PluginVaultSecret): boolean {
  return secret.state === 'grantable';
}

/** A host every plugin already reaches needs no consent for this one. */
export function hostTickable(host: PluginVaultHost): boolean {
  return host.allowedBy !== 'global';
}

/**
 * Nothing new is consented by default. A host already open to this plugin
 * starts ticked: the daemon REPLACES the plugin's host list with the ticked
 * ones, so an unticked box would close it.
 */
export function initialVaultTicks(vault: PluginVault): VaultTicks {
  const hosts: Record<string, boolean> = {};
  for (const line of vault.hosts) if (line.allowedBy === 'plugin') hosts[line.host] = true;
  return { secrets: {}, hosts };
}

export function vaultConsent(vault: PluginVault, ticks: VaultTicks): VaultConsent {
  const ticked = (record: Record<string, boolean>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(record, key) && record[key] === true;
  return {
    secrets: vault.secrets.map((line) => ({
      name: line.name, mode: line.mode, state: line.state, grant: secretTickable(line) && ticked(ticks.secrets, line.name),
    })),
    hosts: vault.hosts.map((line) => ({
      host: line.host, allowedBy: line.allowedBy, grant: hostTickable(line) && ticked(ticks.hosts, line.host),
    })),
  };
}

/** The Secrets page's consent card for a secret to create, then grant (`pluginGrantRequest`). */
export function secretCreateHref(name: string, pluginId: string): string {
  return `/secrets?grant=${encodeURIComponent(name)}&plugin=${encodeURIComponent(pluginId)}`;
}

export type PluginCandidate = {
  name: string;
  format: 'archive' | 'folder';
  pkg: string;
  version: string;
  id: string | null;
  label: string | null;
  description: string | null;
  kind: string[];
};

export type InstallOutcome = {
  ok: boolean;
  id: string;
  pkg: string;
  version: string;
  refused: string | null;
  signature: { state: string };
  /** Child by child, what became of the accepted programs. `null` or absent when none was accepted. */
  authorizeExecChildren?: ChildExecOutcome[] | null;
  /** Child by child, what became of the secrets and hosts consented to. `null` or absent without `vaultChildren`. */
  vaultChildren?: ChildVaultOutcome[] | null;
};

/**
 * One `contains` entry of a bundle. `install`: it comes with the bundle, and
 * `provider` and `dictation` say what it launches and where the voice goes
 * (`null` for a child that will not load); `kept`: already installed, untouched;
 * `unreadable`: only npm could read it; `unresolved`: no dependency declares it.
 */
export type BundleChildPreview = {
  id: string;
  pkg: string | null;
  version: string | null;
  label: string | null;
  state: 'install' | 'kept' | 'unreadable' | 'unresolved';
  permissions: string[];
  signature: InstallSignature | null;
  vault: PluginVault | null;
  provider: PluginPreview['provider'];
  /** Read through `readDictationDecl`. */
  dictation?: unknown;
  /** npm name of the package gone from this child's id, as `PluginPreview.replaces`. */
  replaces?: string | null;
  /** As `PluginPreview.engineError`: it lands with the bundle but will not load (TODO #794). Absent from older daemons. */
  engineError?: string | null;
};

/** A child's programs, as the sheet showed them and the person accepted them. */
export type ChildExecConsent = { id: string; pkg: string; version: string; paths: string[] };

export type ChildExecOutcome = { id: string; granted: string[] | null; refused: 'not-installed' | 'changed' | 'grant-failed' | null };

/** A child's secrets and hosts, every line as the sheet showed it (TODO #660). */
export type ChildVaultConsent = VaultConsent & { id: string; pkg: string; version: string };

export type ChildVaultOutcome = {
  id: string;
  granted: { secrets: string[]; hosts: string[] } | null;
  refused: 'not-installed' | 'changed' | 'grant-failed' | null;
};

/** Same bound as the daemon (`PLUGIN_UPLOAD_MAX_BYTES`): refused before the upload starts. */
export const PLUGIN_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** A hint to the browser's picker only: the daemon reads the archive's first bytes, not its name or type. */
export const ARCHIVE_ACCEPT = '.tgz,.tar.gz,.zip,application/gzip,application/x-gzip,application/zip,application/x-zip-compressed';

const BASE = '/api/ui/plugin-install';

export class PluginInstallError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'PluginInstallError';
  }
}

/**
 * What the user reads when a step fails. The daemon's codes are mapped to
 * sentences of the locale; an unknown code falls back to the daemon's own
 * message (path-free by construction) rather than to nothing.
 */
export function installErrorMessage(status: number, body: unknown): string {
  const code = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : '';
  const message = typeof (body as { message?: unknown } | null)?.message === 'string' ? (body as { message: string }).message : '';
  if (status === 401) return t('pluginsPage.install.errors.unauthenticated');
  if (status === 403 && code === 'plugin_composition_fixed') return t('freeLicense.plugin_composition_fixed');
  if (status === 403) return t('pluginsPage.install.errors.forbidden');
  const known = ['too-large', 'too-many-entries', 'not-gzip', 'not-archive', 'not-zip', 'zip64', 'encrypted', 'multi-volume', 'compression', 'unsafe-path', 'link', 'layout', 'corrupt', 'not-a-plugin',
    'invalid-path', 'forbidden-path', 'unreadable', 'not-found', 'expired', 'tampered', 'manifest', 'npm-missing', 'install-failed', 'name-taken',
    'mismatch', 'refused', 'not-provider', 'not-grantable', 'conflict'];
  if (known.includes(code)) return t(`pluginsPage.install.errors.${code}`);
  return message || t('pluginsPage.install.errors.generic', { status });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, cache: 'no-store' };
  if (body instanceof Blob) {
    init.headers = { 'content-type': 'application/octet-stream' };
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  if (response.status === 204) return undefined as T;
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof (json as { error?: unknown } | null)?.error === 'string' ? (json as { error: string }).error : '';
    throw new PluginInstallError(response.status, code, installErrorMessage(response.status, json));
  }
  return json as T;
}

export async function fetchCandidates(): Promise<PluginCandidate[]> {
  const data = await request<{ candidates?: PluginCandidate[] }>('GET', '/candidates');
  return data.candidates ?? [];
}

export function stageDetected(name: string): Promise<PluginPreview> {
  return request('POST', '/stage', { source: 'detected', name });
}

export function stagePath(path: string): Promise<PluginPreview> {
  return request('POST', '/stage', { source: 'path', path });
}

export function stageUpload(file: Blob): Promise<PluginPreview> {
  if (file.size > PLUGIN_UPLOAD_MAX_BYTES) {
    return Promise.reject(new PluginInstallError(413, 'too-large', t('pluginsPage.install.errors.too-large')));
  }
  return request('POST', '/upload', file);
}

/**
 * `authorizeExec`: the resolved paths the person accepted for a provider — only what the sheet showed.
 * `vault`: the named secrets and hosts, every line as shown; omitted when the preview had none.
 * `execChildren`: the same paths for the providers a bundle brings, only those ticked.
 * `vaultChildren`: the named lines of each child a bundle brings, every one as shown;
 * omitted when no child names anything, so nothing is granted to any child.
 */
export function confirmInstall(token: string, authorizeExec?: string[], vault?: VaultConsent, execChildren?: ChildExecConsent[], vaultChildren?: ChildVaultConsent[]): Promise<InstallOutcome> {
  return request('POST', '/confirm', {
    token,
    confirm: true,
    ...(authorizeExec ? { authorizeExec } : {}),
    ...(vault ? { vault } : {}),
    ...(execChildren?.length ? { authorizeExecChildren: execChildren } : {}),
    ...(vaultChildren?.length ? { vaultChildren } : {}),
  });
}

/**
 * The paths a child's box accepts. None for a program that can never be allowed:
 * the daemon refuses the whole child, so the sheet offers no box (it says why).
 */
export function childAuthorizable(child: BundleChildPreview): string[] {
  if (child.state !== 'install' || !child.provider || child.provider.binaries.some((b) => b.refused)) return [];
  return pathsToAuthorize(child.provider.binaries);
}

/** One line per ticked child; a child left unticked is not named. */
export function childExecConsent(children: readonly BundleChildPreview[], allowed: Readonly<Record<string, boolean>>): ChildExecConsent[] {
  return children.flatMap((child) => {
    const paths = childAuthorizable(child);
    return allowed[child.id] === true && paths.length > 0 && child.pkg !== null && child.version !== null
      ? [{ id: child.id, pkg: child.pkg, version: child.version, paths }]
      : [];
  });
}

/** What to tell the person when the bundle landed but a child's programs were not allowlisted. */
export function childExecNotices(outcome: InstallOutcome, children: readonly BundleChildPreview[]): string[] {
  return (outcome.authorizeExecChildren ?? []).flatMap((line) => {
    if (line.refused === null) return [];
    const child = children.find((c) => c.id === line.id);
    return [t(`pluginsPage.install.childrenAccess.refused.${line.refused}`, { name: child?.label ?? line.id, settingsPath: settingsPath('models', 'backends') })];
  });
}

/**
 * The children whose secrets and hosts the sheet asks for: those that come with
 * the bundle and name something. The daemon expects exactly these, no more, no less.
 */
export function childAsksVault(child: BundleChildPreview): child is BundleChildPreview & { vault: PluginVault; pkg: string; version: string } {
  return child.state === 'install' && child.vault !== null && child.pkg !== null && child.version !== null;
}

/** A child's boxes, by its id alone: never another child's, never the bundle's. */
export function childVaultTicks(child: BundleChildPreview & { vault: PluginVault }, ticks: Readonly<Record<string, VaultTicks>>): VaultTicks {
  return Object.prototype.hasOwnProperty.call(ticks, child.id) ? ticks[child.id]! : initialVaultTicks(child.vault);
}

/** One entry per child that names something, ticked or not: one left out is a 409. */
export function childVaultConsent(children: readonly BundleChildPreview[], ticks: Readonly<Record<string, VaultTicks>>): ChildVaultConsent[] {
  return children.filter(childAsksVault).map((child) => ({
    id: child.id, pkg: child.pkg, version: child.version, ...vaultConsent(child.vault, childVaultTicks(child, ticks)),
  }));
}

/** What to tell the person when the bundle landed but a child got none of its secrets and hosts. */
export function childVaultNotices(outcome: InstallOutcome, children: readonly BundleChildPreview[]): string[] {
  return (outcome.vaultChildren ?? []).flatMap((line) => {
    if (line.refused === null) return [];
    const child = children.find((c) => c.id === line.id);
    return [t(`pluginsPage.install.childrenAccess.vaultRefused.${line.refused}`, { name: child?.label ?? line.id })];
  });
}

/** The daemon refused the click because what the sheet showed is no longer true: show it again, refreshed. */
export function isStalePreview(err: unknown): boolean {
  return err instanceof PluginInstallError && err.status === 409;
}

/** Best effort: an abandoned preview also expires on its own on the daemon. */
export function discardPreview(token: string): void {
  void request('DELETE', `/staged/${encodeURIComponent(token)}`).catch(() => {});
}

/**
 * One line for the signature verdict, and how loud it must be. `unsignedLoads`
 * is developer mode as the daemon applies it NOW: the preview's `loads` was
 * judged at staging, and the mode may have been turned on since (from the
 * sheet itself, or in Settings).
 */
export function signatureSummary(signature: InstallSignature, unsignedLoads?: boolean): { tone: 'ok' | 'warn' | 'danger'; text: string } {
  if (signature.state === 'signed') return { tone: 'ok', text: t('pluginsPage.install.signed') };
  if (signature.state === 'tampered') return { tone: 'danger', text: t('pluginsPage.install.tampered') };
  return { tone: 'warn', text: t((unsignedLoads ?? signature.loads) ? 'pluginsPage.install.unsignedLoads' : 'pluginsPage.install.unsignedBlocked') };
}

/** `data:` URLs only: the preview must never make the browser fetch an address. */
export function previewImage(url: string | null): string | null {
  return url && url.startsWith('data:image/') ? url : null;
}

/**
 * What the sheet says about the vault and the network, from the permissions
 * the manifest asks for (TODO #597). A permission whose use the manifest names
 * is left to the named block (`named`, TODO #692), which says more; one it does
 * not name keeps its line, because the named block would otherwise leave it
 * unexplained. Also flags the one combination that cannot work
 * (`secrets:broker` without `http:outbound`, refused since #531 4-B). i18n keys,
 * in display order; warnings flagged.
 */
export function vaultConsentLines(permissions: readonly string[], named?: PluginVault | null): { key: string; warn: boolean }[] {
  const has = (p: string) => permissions.includes(p);
  const names = (mode: PluginVaultSecret['mode']) => named?.secrets.some((secret) => secret.mode === mode) ?? false;
  const lines: { key: string; warn: boolean }[] = [];
  if (has('secrets:read') && !names('read')) lines.push({ key: 'pluginsPage.install.vault.read', warn: false });
  if (has('secrets:broker')) {
    if (!names('broker')) lines.push({ key: 'pluginsPage.install.vault.broker', warn: false });
    if (!has('http:outbound')) lines.push({ key: 'pluginsPage.install.vault.brokerNoHttp', warn: true });
  }
  if (has('http:outbound') && !named?.hosts.length) lines.push({ key: 'pluginsPage.install.vault.network', warn: false });
  return lines;
}
