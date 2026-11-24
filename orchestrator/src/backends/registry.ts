/**
 * LIVING registry of the LLM backends (§10.15).
 *
 * It used to fit in two constants evaluated at import (`ACTIVE_PROFILES` in
 * the old `./profiles.ts`, `REGISTRY` in `./index.ts`). That was enough as long as
 * "adding a provider" meant "editing the repo": the orchestrator's env
 * does not move during its life, nor does the list.
 *
 * Open-core breaks that assumption: a third-party plugin brings its provider
 * (zAI, Qwen…) and can be installed, enabled, disabled and removed **without a
 * restart**. A constant would freeze the list at the boot state; the
 * dispatcher would refuse a freshly installed backend, and would keep
 * accepting that of an unloaded plugin.
 *
 * Hence: a mutable state, a cache invalidated on each mutation, and readers
 * that call a function instead of reading a constant. The cost is that
 * of a `map` over a handful of profiles, paid only when the cache is
 * cold.
 *
 * The registry holds NO credential value: it memorises the shape
 * of the profiles, and the env is resolved at each spawn (`./credentials.ts`). The
 * visibility itself is read again on each read — a key that appears during
 * the process's life activates its profile without a mutation or a restart.
 *
 * What the registry NEVER delegates to a plugin: launching the process
 * (`host.spawn` stays with the daemon), allowing the binary (`host:exec` policy),
 * and deciding a profile's visibility (missing credentials make it
 * inactive, exactly like a profile of the repo).
 */

import { modelPreferences, mergeModelPreferences } from './model-preferences.js';
import { dbApi } from '../db.js';
import { dialectProblems } from './dialect-check.js';
import { credentialDirProblem } from './provider-declarations.js';
import { otherBackendHomeDirProblem } from './credential-home-dirs.js';
import { getHost } from '../host/index.js';
import type { SecretTarget } from '../secrets/resolve.js';
import type { InjectedSecret } from '../secrets/env.js';
import {
  BACKEND_CAPABILITIES, isRemoteDialect, probeLaunchContext, type AnyDialect, type BackendLaunchContext, type BackendProfile, type EnvResolver, type ProfileRuntime, type RegisteredProfile,
} from './types.js';
import { definitionProblems, dialectFromDefinition, type NativeProviderDefinition } from './engine/index.js';
import type { ProviderAuthStatus, ProviderBinaryDeclaration, ProviderDeclarations, ProviderProtocol } from './provider-declarations.js';
import { MODEL_TIERS } from './catalog-model.js';
import { setDeclaredBinariesSource } from '../host/declared-binaries.js';
import { setDeclaredCredentialDirsSource } from '../host/isolation.js';
import { BUILTIN_DECLARATIONS, type BuiltinDeclarations } from './builtin-declarations.js';
import { ProfileEnvError, probeProfileEnv, probeResolver, resolveProfileEnv } from './credentials.js';
import { localEnvNames, localEnvReason } from './local-env.js';
import { accountConfigDir, accountInstance, listBackendAccounts, onBackendAccountsChanged, type BackendAccountRow } from './accounts.js';
import { baseBackendId, isAccountInstanceId } from './instance-id.js';

/**
 * The SHAPE of an active profile. No credential lives here: `runtimeFor`
 * resolves the env for one spawn, and the caller lets go of it afterwards.
 */
export type ResolvedProfile = {
  profile: BackendProfile;
  dialect: AnyDialect;
  /** Rejects with a `ProfileEnvError` (message safe to show) when a credential
   *  cannot be produced. `target` scopes vault references to the mission;
   *  `launch` is what the plugin's resolver receives (`probe` when omitted). */
  runtimeFor(target?: SecretTarget, launch?: BackendLaunchContext): Promise<{ runtime: ProfileRuntime; injected: InjectedSecret[] }>;
  /** Present on a subscription account instance (`claude@<id>`). */
  account?: { id: string; name: string; ownerUserId: string | null; backend: string };
};

/**
 * Same resolution as the spawn (`host.bin`): a `host.binaries` pin, then the
 * PATH with Windows' `.exe`/`.cmd`, then the places a daemon's PATH forgets
 * (Homebrew under launchd, the npm folder under `%APPDATA%`). A bare PATH scan
 * would hide a backend the spawn itself would have found — an npm-installed
 * CLI on Windows is `copilot.cmd`, never `copilot`.
 */
function hasBinary(cmd: string): boolean {
  try {
    getHost().bin(cmd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every profile comes from a registration: the product's own from its official provider plugins
 * (`registerProductProfile`), kept in the product's order; the others in the order they arrive.
 */
const profiles: BackendProfile[] = [];
const dialects = new Map<string, AnyDialect>();
/** `env` given as a function by a plugin — kept OUT of the profile, which stays
 *  plain data (catalogue, routes), and called at each spawn. */
const envResolvers = new Map<string, EnvResolver>();
// Daemon-owned, synchronous probes for declarative settings; no cached key or verdict.
const settingProbes = new Map<string, () => string | null>();

/**
 * What the last call of a plugin's `env` function said about its profile.
 *
 * That function may be async (an OAuth exchange) while the registry is read
 * synchronously, on the dispatch path: its answer is therefore REMEMBERED, and
 * re-asked once it is older than `RESOLVER_RECHECK_MS` — on a read, never on a
 * timer. A spawn with no mission refreshes it too, for free; a mission's
 * failure triggers a fresh probe and keeps the profile out until it answers.
 * Only the verdict is kept, never what the function returned.
 */
type ResolverHealth = { reason: string | null; checkedAt: number; pending: Promise<void> | null };
const resolverHealth = new Map<string, ResolverHealth>();
const RESOLVER_RECHECK_MS = 15_000;

let cache: ResolvedProfile[] | null = null;
let cacheKey = '';
let inactive: { id: string; reason: string }[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function invalidate(): void {
  cache = null;
  notify();
}

// An account's state and its grants are not in the cache key (what a viewer
// sees is filtered later, per request): the account store says when they move.
onBackendAccountsChanged(invalidate);

/**
 * The providers the product ships as plugins (`codex`, `grok`, `copilot`…) exist only once the plugin loader has run, which
 * is after the modules that start working at boot (the dispatcher fires a pass the moment it starts). A pass that finds
 * `codex` unknown would send its tasks to ANOTHER backend without a word (`PROVIDERS-SDK.md` § 11.3): whatever acts on
 * the registry at boot waits here. Outside the daemon's boot — a test, a tool — nothing is expected and the wait is over.
 */
let providersExpected: { promise: Promise<void>; done: () => void } | null = null;
const PROVIDERS_WAIT_MS = 120_000;

/** Boot only: the plugin loader is about to run. */
export function expectProviders(): void {
  if (providersExpected) return;
  let done!: () => void;
  const promise = new Promise<void>((resolve) => { done = resolve; });
  providersExpected = { promise, done };
  // A loader that never comes back must not freeze the dispatcher for good.
  setTimeout(done, PROVIDERS_WAIT_MS).unref();
}

/** Boot only: the plugin loader has run (or failed), the providers that are going to exist do. */
export function providersLoaded(): void {
  providersExpected?.done();
}

/**
 * Providers still being put back after the loader has run: the agents of the ACP registry are
 * hashed again before they register, in the background, and a task aimed at `acp-<id>` in that
 * window failed its launches (`MAX_SPAWN_FAILURES`) instead of waiting. A rejection counts as done.
 */
const pendingProviders = new Set<Promise<void>>();

export function providersPending(work: Promise<unknown>): void {
  const settled = work.then(() => undefined, () => undefined);
  pendingProviders.add(settled);
  void settled.then(() => { pendingProviders.delete(settled); });
}

function pendingProvidersSettled(): Promise<void> {
  if (!pendingProviders.size) return Promise.resolve();
  let bound: ReturnType<typeof setTimeout> | undefined;
  // Same bound as the loader: a restore that never ends must not freeze the dispatcher.
  const timeout = new Promise<void>((resolve) => { bound = setTimeout(resolve, PROVIDERS_WAIT_MS); bound.unref?.(); });
  return Promise.race([Promise.all([...pendingProviders]).then(() => undefined), timeout])
    .finally(() => { if (bound) clearTimeout(bound); });
}

/** Resolves once the providers shipped as plugins are registered, and those being restored are
 *  back; at once when none is expected. */
export function whenProvidersLoaded(): Promise<void> {
  return (providersExpected?.promise ?? Promise.resolve()).then(pendingProvidersSettled);
}

/** Called on every change of the registry — a mutation, or a credential that
 *  appeared / vanished: the daemon turns it into a `backends_changed` SSE so
 *  the UI reloads its menus. */
export function onBackendsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function settleResolver(id: string, resolver: EnvResolver, reason: string | null): void {
  // The plugin may have been unloaded, or reloaded, while its function ran.
  if (envResolvers.get(id) !== resolver) return;
  resolverHealth.set(id, { reason, checkedAt: Date.now(), pending: null });
}

function checkResolver(id: string, resolver: EnvResolver): Promise<void> {
  const current = resolverHealth.get(id);
  if (current?.pending) return current.pending;
  const verdict = probeResolver(resolver);
  if (!(verdict instanceof Promise)) {
    settleResolver(id, resolver, verdict);
    return Promise.resolve();
  }
  const pending = verdict.then((reason) => {
    settleResolver(id, resolver, reason);
    // Nobody may read the registry for a while: re-read it here, so the
    // profile appears (or leaves) and the UI is told as soon as it is known.
    // Nothing awaits this promise: a throwing listener must not become an
    // unhandled rejection in the daemon.
    try { activeProfiles(); } catch { /* the next read retries */ }
  });
  // Until a first answer, the profile stays out: a mission must not be the one
  // that finds out the credential is missing.
  resolverHealth.set(id, {
    reason: current ? current.reason : 'credential resolver has not answered yet',
    checkedAt: current?.checkedAt ?? Date.now(),
    pending,
  });
  return pending;
}

/** What a profile reads while the probe a mission's failure triggered has not
 *  answered: neutral on purpose, since the failure may be one account's. */
const RECHECKING_AFTER_FAILURE = 'credential resolver is being checked again after a mission failed';

/**
 * A mission's failure speaks for one account, so the probe decides whether the
 * profile stays. An async probe answers later, though, and until then the next
 * mission would be sent to the profile that just failed: hold it out meanwhile.
 * A probe already in flight is reused — it may predate the failure, and the
 * periodic re-check then catches up.
 */
function recheckAfterMissionFailure(id: string, resolver: EnvResolver): void {
  void checkResolver(id, resolver);
  const health = resolverHealth.get(id);
  if (envResolvers.get(id) !== resolver || !health?.pending || health.reason) return;
  resolverHealth.set(id, { ...health, reason: RECHECKING_AFTER_FAILURE });
}

/**
 * Re-asks every plugin resolver now, whatever its age, and resolves once they
 * all answered. For whoever just changed a credential and wants the menus to
 * follow without waiting for the next periodic check.
 */
export async function recheckCredentials(): Promise<void> {
  await Promise.all([...envResolvers].map(([id, resolver]) => checkResolver(id, resolver)));
  activeProfiles();
}

/** Why `profile` cannot get its credentials right now, or null. Runs on every
 *  read of the registry — see `credentials.ts` for what each probe costs. */
function credentialReason(profile: BackendProfile): string | null {
  const reason = probeProfileEnv(profile);
  if (reason) return reason;
  const settingProbe = settingProbes.get(profile.id);
  if (settingProbe) return settingProbe();
  const resolver = envResolvers.get(profile.id);
  if (!resolver) return null;
  const health = resolverHealth.get(profile.id);
  if (!health || (!health.pending && Date.now() - health.checkedAt >= RESOLVER_RECHECK_MS)) {
    void checkResolver(profile.id, resolver);
  }
  return resolverHealth.get(profile.id)?.reason ?? null;
}

function compute(reasons: readonly (string | null)[], source: BackendProfile[]): ResolvedProfile[] {
  inactive = [];
  return source.flatMap((profile, index) => {
    const dialect = dialects.get(profile.dialect);
    if (!dialect) {
      inactive.push({ id: profile.id, reason: `dialect ${profile.dialect} is not installed (a plugin may provide it)` });
      return [];
    }
    // The dialect's allowlist, applied HERE and not only at parse time: a file
    // may name a dialect a plugin brings later, and this is the only moment
    // that exists for it. A name the dialect never declared keeps the profile
    // inactive, with the reason, instead of reaching a spawn.
    if (fileOwned.has(profile.id)) {
      const refused = localEnvNames(profile).map((key) => localEnvReason(dialect, key)).find((why) => why !== null);
      if (refused) {
        inactive.push({ id: profile.id, reason: refused });
        return [];
      }
    }
    const reason = reasons[index];
    if (reason) {
      inactive.push({ id: profile.id, reason });
      return [];
    }
    // A remote dialect runs nothing here: no binary, so no command to resolve.
    const cmd = isRemoteDialect(dialect) ? '' : profile.cmd ?? dialect.defaultCmd;
    if (profile.requiredBinary && !hasBinary(profile.requiredBinary)) {
      inactive.push({ id: profile.id, reason: `binary ${profile.requiredBinary} not found in PATH` });
      return [];
    }
    return [{
      profile,
      dialect,
      runtimeFor: async (target, launch = probeLaunchContext()) => {
        assertBackendEnabled(profile.id);
        const resolver = envResolvers.get(profile.id);
        // A mission's answer speaks for ONE account (its connection, its
        // gateway): it must not hide the profile from, nor show it to, everyone
        // else. Only an answer given without a mission is the profile's.
        const forEveryone = launch.kind === 'probe';
        let resolved: Awaited<ReturnType<typeof resolveProfileEnv>>;
        try {
          resolved = await resolveProfileEnv(profile, resolver, target, launch);
        } catch (err) {
          // The credential vanished between the last probe and this spawn: the
          // profile leaves the registry NOW, so the next mission is not sent
          // to it. Vault and `requiredEnv` failures need nothing here — the
          // next read re-probes them. Under a mission, the probe is asked
          // again instead and decides: a synchronous one before this returns,
          // an async one with the profile held out until it answers.
          if (resolver && err instanceof ProfileEnvError) {
            if (forEveryone) settleResolver(profile.id, resolver, err.reason);
            else recheckAfterMissionFailure(profile.id, resolver);
            activeProfiles();
          }
          throw err;
        }
        if (resolver && forEveryone) settleResolver(profile.id, resolver, null);
        const { env, injected } = resolved;
        return {
          runtime: { id: profile.id, cmd, env, providerConfig: profile.providerConfig, minCliVersion: profile.minCliVersion },
          injected,
        };
      },
    }];
  });
}

/**
 * Whether the active backend `id` could be served to a mission of `target` —
 * the contextualised catalogue (TODO #531, decision 5-B). A status only: the
 * vault entry is selected for the target and opened, its value dropped. The
 * registry's own visibility stays target-less (an administrator's inventory);
 * a picker that knows its project asks this instead, and the spawn decides
 * again whatever was answered here. A plugin's credential resolver is not run
 * per target: the spawn is where it answers for one account.
 */
export function profileServes(id: string, target: SecretTarget): boolean {
  const entry = activeProfiles().find((candidate) => candidate.profile.id === id);
  if (!entry) return false;
  // An account instance carries its backend's references under its own id.
  const profile = entry.account ? { ...entry.profile, id: entry.account.backend } : entry.profile;
  return probeProfileEnv(profile, target) === null;
}

/** Trust comes only from the live registration vouched for by the release loader and a product-owned profile. */
export function isProductDialect(profile: Pick<BackendProfile, 'id' | 'dialect'>, dialect: AnyDialect): boolean {
  return dialectTrust(profile, dialect) !== 'third-party';
}

/**
 * Who answers for the code that talks to a backend's CLI:
 *  - `core`: retained in the public type for compatibility; no provider is compiled in any more;
 *  - `official`: a plugin shipped in the release (see `isProductDialect`). It gets
 *    what a core dialect gets — the mission's token in the process environment and
 *    the vault slice — and, being a plugin, ALSO the launch seal (`ctx.provider.mcp`,
 *    `ctx.provider.env`) that a plugin's services answer from;
 *  - `third-party`: anything else, an unresolvable backend included.
 */
export type BackendTrust = 'core' | 'official' | 'third-party';

export function dialectTrust(profile: Pick<BackendProfile, 'id' | 'dialect'>, dialect: AnyDialect): BackendTrust {
  return trustedDialects.has(profile.dialect)
    && dialects.get(profile.dialect) === dialect
    && profileVouched(baseBackendId(profile.id))
    ? 'official'
    : 'third-party';
}

/**
 * Whether the LIVE registration of dialect `dialect` (the object a profile resolved to) is the one a
 * plugin shipped in the release made — the dialect alone, whoever owns the profile on it. What a
 * third party's profile without a command of its own launches is that dialect's program (`launch-binary.ts`).
 */
export function isOfficialDialect(dialectId: string, dialect: AnyDialect): boolean {
  return trustedDialects.has(dialectId) && dialects.get(dialectId) === dialect;
}

/**
 * The trust of the backend `id` (an account instance included). Fail-closed: an
 * id that no active profile answers to is third-party, so a doubt withholds the
 * mission's credentials instead of handing them over.
 */
export function backendTrust(id: string): BackendTrust {
  const entry = activeProfiles().find((candidate) => candidate.profile.id === id);
  return entry ? dialectTrust(entry.profile, entry.dialect) : 'third-party';
}

/**
 * Whether a mission on backend `id` (an account instance included) can be launched with
 * `BuildSpawnOpts.readOnlyTools`: the live registration of its dialect is the trusted one, and the
 * product's declarations (its official plugin's manifest) say that dialect honours it. Read by dialect, so a profile riding on one (an
 * API-key provider, a user's own endpoint) inherits it; fail-closed on an id nobody answers to.
 */
export function backendRunsReadOnlyTools(id: string | null | undefined): boolean {
  if (!id) return false;
  const entry = activeProfiles().find((candidate) => candidate.profile.id === id);
  if (!entry) return false;
  const dialectId = entry.profile.dialect;
  return trustedDialects.has(dialectId) && dialects.get(dialectId) === entry.dialect
    && BUILTIN_DECLARATIONS[dialectId]?.readOnlyTools === true;
}

/** Whether the backend `id` runs on a dialect the product answers for (core or official). */
export function isProductBackend(id: string): boolean {
  return backendTrust(id) !== 'third-party';
}

/**
 * What the product's OWN provider `id` declares in its plugin's manifest (`builtin-declarations.ts`, data only): the same vocabulary a provider plugin writes.
 */
function builtinDeclarations(id: string): ProviderDeclarations | undefined {
  const data: BuiltinDeclarations | undefined = BUILTIN_DECLARATIONS[id];
  return data;
}

/**
 * How a profile's CLI signs an account in (S7), if it does: the dialect's own declaration
 * for a provider that is a plugin, the product's for the dialects it ships (`claude`, `codex`).
 * A CLI keeps its sign-in in a directory of its own (`CLAUDE_CONFIG_DIR`, the `auth.json` of
 * a `CODEX_HOME`) and a spawn runs on the account's one. Not a plugin capability for the
 * product's dialects: a dialect that ignored the account would run it on the host's sign-in
 * without a word, so a profile on a dialect that is not the product's own gets nothing from them.
 */
export function profileAccountsDeclaration({ profile, dialect }: Pick<ResolvedProfile, 'profile' | 'dialect'>): ProviderDeclarations['accounts'] {
  return dialects.get(profile.dialect) === dialect ? dialectDeclarations(profile.dialect)?.accounts : undefined;
}

/** A profile that signs in through the CLI's own login, not a key or an
 *  endpoint of its own: the only kind an account can split. */
function takesAccounts(resolved: ResolvedProfile): boolean {
  const { profile } = resolved;
  return profileAccountsDeclaration(resolved) !== undefined && !profile.custom && !profile.providerConfig
    && !Object.keys(profile.env ?? {}).length && !Object.keys(profile.envFrom ?? {}).length
    && !(profile.requiredEnv ?? []).length;
}

/**
 * One instance per account, right after its backend. An account whose backend
 * is inactive (disabled, binary missing) is absent like its backend: the launch
 * then refuses it by name instead of running it elsewhere.
 */
function withAccountInstances(resolved: ResolvedProfile[], accounts: readonly BackendAccountRow[]): ResolvedProfile[] {
  if (!accounts.length) return resolved;
  return resolved.flatMap((base) => {
    if (!takesAccounts(base)) return [base];
    const instances = accounts.filter((row) => row.backend === base.profile.id).map((row): ResolvedProfile => {
      const id = accountInstance(row);
      return {
        profile: { ...base.profile, id, label: `${base.profile.label} · ${row.name}` },
        dialect: base.dialect,
        account: { id: row.id, name: row.name, ownerUserId: row.owner_user_id, backend: row.backend },
        runtimeFor: async (target) => {
          const { runtime, injected } = await base.runtimeFor(target);
          return {
            runtime: Object.assign({ ...runtime, id }, { account: { id: row.id, name: row.name, configDir: accountConfigDir(row.id) } }),
            injected,
          };
        },
      };
    });
    return [base, ...instances];
  });
}

/**
 * Profiles actually available in this process, dialect resolved. A profile
 * whose dialect does not exist is skipped rather than failing the startup.
 *
 * What is memoised is the SHAPE (existence, dialect, models), never a
 * credential value. And visibility is not frozen at boot: every call re-asks
 * each profile whether it can get its credentials, and the cache is keyed on
 * the ANSWERS — not on what usually explains them. A key set or removed, a
 * vault entry made readable again: the profile appears or disappears with no
 * registry mutation and no restart. The returned array keeps its identity
 * until an answer moved — derived views use it as their cache key.
 */
export function activeProfiles(): ResolvedProfile[] {
  const overlays = dbApi.listBackendOverlays();
  const byId = new Map(overlays.filter((row) => !fileOwned.has(row.id)).map((row) => [row.id, row]));
  const source = profiles.map((profile) => {
    const overlay = byId.get(profile.id);
    if (!overlay) return profile;
    const preferences = modelPreferences(profile.id);
    return { ...profile,
      models: mergeModelPreferences(profile.models, null, preferences?.models, preferences?.removed),
      ...(preferences?.defaultModel !== undefined ? { defaultModel: preferences.defaultModel } : {}),
      ...(overlay.label !== null ? { label: overlay.label, vendor: overlay.label } : {}),
      ...(overlay.icon !== null ? { icon: overlay.icon || undefined } : {}),
      ...(overlay.brand !== null ? { brand: overlay.brand || undefined } : {}),
    };
  }).sort((a, b) => (byId.get(a.id)?.rank ?? a.rank ?? 10000) - (byId.get(b.id)?.rank ?? b.rank ?? 10000));
  const reasons = source.map((profile) => (byId.get(profile.id)?.disabled ?? profile.disabled)
    ? 'disabled in settings' : credentialReason(profile));
  const accounts = listBackendAccounts();
  const key = JSON.stringify([reasons, overlays, accounts.map((row) => [row.id, row.backend, row.name, row.owner_user_id])]);
  if (cache && key === cacheKey) return cache;
  const refreshed = cache !== null;
  // Set BEFORE notifying: a listener that reads the registry back must find
  // the new state, not re-enter this computation.
  cache = withAccountInstances(compute(reasons, source), accounts);
  cacheKey = key;
  if (refreshed) notify();
  return cache;
}

/** Profiles left out and WHY — never a value, only the name of what is
 *  missing. A profile without its key leaves the dispatch, not the diagnosis. */
export function inactiveProfiles(): { id: string; reason: string }[] {
  activeProfiles();
  return [...inactive];
}

/* ── Mutations (plugins fournisseurs, §10.15) ─────────────────────────────── */

/** Who brought what, for the conflict message and for the removal. */
const profileOwners = new Map<string, string>();
/**
 * Profiles that came from a USER FILE (`registerFileProfile`). They are the
 * only ones whose env names are subject to the dialect's allowlist: everything
 * else was written in the product or brought by a signed plugin — a pack's
 * entries (`registerPackProfile`) were already held to the pack policy when
 * parsed, and that policy needs no dialect.
 */
const fileOwned = new Set<string>();
const dialectOwners = new Map<string, string>();
/**
 * Dialects whose LIVE registration came from a plugin shipped in the release
 * (see `isProductDialect`). Set and cleared with the registration itself (same
 * token), so a release, a swap or a rollback cannot leave a stale verdict.
 */
const trustedDialects = new Set<string>();
/** Profiles a plugin shipped in the release registered: the only plugin profiles the product vouches for. */
const trustedProfiles = new Set<string>();

/**
 * Whether the product answers for a profile that runs on a registered dialect:
 * a profile with no owner, an operator's file, or a profile of a plugin shipped in
 * the release (the product's own providers are such plugins). Pack profiles and third-party plugin profiles
 * are not.
 */
function profileVouched(id: string): boolean {
  return !profileOwners.has(id) || fileOwned.has(id) || trustedProfiles.has(id);
}

export type { RegisteredProfile } from './types.js';

/**
 * Hot update of a provider plugin (`docs/PROVIDERS-SDK.md` §11.3, §12.5).
 *
 * The loader remounts a changed plugin by disposing the old fiber and applying
 * the new one, and between the two a backend would not exist: a mission
 * dispatched in that window found `isBackendName('cursor')` false and, until
 * `getBackend` stopped doing so, ran on ANOTHER subscription without a word.
 * While a swap is open for an owner:
 *  - what that owner's old fiber releases is DEFERRED, not applied;
 *  - what its new fiber registers REPLACES the old registration (same owner,
 *    same id) instead of colliding with it;
 *  - at the end, the deferred releases run only where they still describe the
 *    live registration (identity), so what the new version re-registered stays
 *    and what it dropped goes.
 * A running mission keeps the `Backend` object it already holds.
 */
const swapping = new Map<string, Array<() => void>>();

/**
 * Who holds a registration RIGHT NOW. A release is judged by this token, not by
 * the dialect or profile object: a rollback re-applies the previous module,
 * which registers the very same objects again, and the stale release queued by
 * the failed update must not delete them.
 */
const dialectTokens = new Map<string, symbol>();
const profileTokens = new Map<string, symbol>();

/**
 * A hot update that would change how a mission talks to its provider: the same
 * mission could not keep working across it. Refused; the previous version keeps
 * running until the mission (or the daemon) is restarted.
 */
export class HotUpdateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HotUpdateRefusedError';
  }
}

function hotUpdateConflict(before: AnyDialect, after: AnyDialect): string | null {
  const kind = (d: AnyDialect): string => (isRemoteDialect(d) ? 'remote' : d.persistentProcess ? 'persistent' : 'per-turn');
  if (kind(before) !== kind(after)) return `its transport changed (${kind(before)} → ${kind(after)})`;
  if (before.sessionStore !== after.sessionStore) return `its session store changed (${before.sessionStore} → ${after.sessionStore})`;
  return null;
}

/** Opens a swap for `owner`; the returned function closes it. Idempotent per owner. */
export function beginProviderSwap(owner: string): () => void {
  if (swapping.has(owner)) return () => {};
  const deferred: Array<() => void> = [];
  swapping.set(owner, deferred);
  return () => {
    if (swapping.get(owner) !== deferred) return;
    swapping.delete(owner);
    for (const release of deferred) release();
    if (deferred.length) invalidate();
  };
}

/** Runs `release` now, or when the owner's swap closes. */
function releaseOrDefer(owner: string, release: () => void): void {
  const deferred = swapping.get(owner);
  if (deferred) deferred.push(release);
  else release();
}

function assertFreeProfileId(id: string, claimant?: string, trusted = false): void {
  const owner = profileOwners.get(id);
  // A plugin being swapped re-registers what its previous version held.
  if (owner && owner === claimant && swapping.has(owner)) return;
  if (BUILTIN_DECLARATIONS[id] && !trusted) throw new Error(`backend \`${id}\` is a product profile — pick another id`);
  if (owner) throw new Error(`backend \`${id}\` already registered by \`${owner}\``);
  if (profiles.some((p) => p.id === id)) throw new Error(`backend \`${id}\` is a product profile — pick another id`);
}

/** Members a dialect MUST carry: without them, a mission would start and
 *  die at the first event, far from the installation that caused it. */
const DIALECT_REQUIRED = [
  'defaultCmd', 'sessionStore', 'permissionModel', 'rateLimitReporting',
  'buildSpawn', 'writeUserInput', 'parseLine', 'extractSessionId',
] as const;

/** A key outside the closed list, or a value that is not a boolean, is a
 *  contract error: a typo (`worktrees: false`) silently ignored would leave the
 *  backend claiming what it cannot do. */
function assertCapabilitiesShape(label: string, value: unknown): void {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: \`capabilities\` must be an object`);
  }
  for (const [key, flag] of Object.entries(value)) {
    if (!(BACKEND_CAPABILITIES as readonly string[]).includes(key)) {
      throw new Error(`${label}: unknown capability \`${key}\` (known: ${BACKEND_CAPABILITIES.join(', ')})`);
    }
    if (typeof flag !== 'boolean') throw new Error(`${label}: capability \`${key}\` must be a boolean`);
  }
}

/** Same, for a dialect with no process: nothing to spawn, the session is all. */
const REMOTE_DIALECT_REQUIRED = [
  'sessionStore', 'permissionModel', 'rateLimitReporting', 'extractSessionId', 'openSession',
] as const;

function assertRemoteDialectShape(id: string, dialect: AnyDialect & { transport: 'remote' }): void {
  const missing = REMOTE_DIALECT_REQUIRED.filter((key) => dialect[key] === undefined);
  if (missing.length) {
    throw new Error(`dialect \`${id}\` is incomplete: missing ${missing.join(', ')}`);
  }
  for (const key of ['extractSessionId', 'openSession'] as const) {
    if (typeof dialect[key] !== 'function') throw new Error(`dialect \`${id}\`: \`${key}\` must be a function`);
  }
}

function assertDialectShape(id: string, candidate: AnyDialect): void {
  const transport = (candidate as { transport?: unknown }).transport;
  if (transport !== undefined && transport !== 'remote') {
    throw new Error(`dialect \`${id}\`: unknown \`transport\` (${String(transport)}) — omit it, or set 'remote'`);
  }
  if (isRemoteDialect(candidate)) {
    assertRemoteDialectShape(id, candidate);
    assertCapabilitiesShape(`dialect \`${id}\``, candidate.capabilities);
    return;
  }
  const dialect = candidate;
  const missing = DIALECT_REQUIRED.filter((key) => dialect[key] === undefined);
  if (missing.length) {
    throw new Error(`dialect \`${id}\` is incomplete: missing ${missing.join(', ')}`);
  }
  for (const key of ['buildSpawn', 'writeUserInput', 'parseLine', 'extractSessionId'] as const) {
    if (typeof dialect[key] !== 'function') throw new Error(`dialect \`${id}\`: \`${key}\` must be a function`);
  }
  if (dialect.openSession !== undefined) {
    if (typeof dialect.openSession !== 'function') throw new Error(`dialect \`${id}\`: \`openSession\` must be a function`);
    // A driver owns a process that outlives a turn: over a one-shot process the
    // runner would respawn under it and orphan its pending requests.
    if (dialect.persistentProcess !== true) {
      throw new Error(`dialect \`${id}\`: \`openSession\` requires \`persistentProcess: true\``);
    }
  }
  assertCapabilitiesShape(`dialect \`${id}\``, dialect.capabilities);
}

/**
 * A declaration that contradicts what the dialect provides (cf. `dialectProblems`).
 * Refused for a plugin written against API 11 or later; a plugin written before
 * keeps registering, as it always did, with the reasons in the log — the
 * previous contract is supported, not retroactively tightened.
 */
function assertDialectCoherent(id: string, dialect: AnyDialect, strict: boolean): void {
  const problems = dialectProblems(dialect);
  if (problems.length === 0) return;
  const message = `dialect \`${id}\` contradicts itself: ${problems.join('; ')}`;
  if (strict) throw new Error(message);
  console.warn(`[backends] ${message} (refused for plugins declaring apiVersion 11 or later)`);
}

/** C3: a tier outside the closed list, or a rank that is not a number, would silently drop the profile out of the fallback. */
function assertDeclaredRanking(profile: BackendProfile): void {
  if (profile.fallbackRank !== undefined && !Number.isFinite(profile.fallbackRank)) {
    throw new Error(`profile \`${profile.id}\`: \`fallbackRank\` must be a finite number`);
  }
  for (const model of profile.models ?? []) {
    if (model.tier !== undefined && !(MODEL_TIERS as readonly string[]).includes(model.tier)) {
      throw new Error(`profile \`${profile.id}\`: model \`${model.slug}\` has tier \`${String(model.tier)}\`; it must be one of ${MODEL_TIERS.join(', ')}`);
    }
  }
}

/** The folders a profile names as its own: a list of home-relative paths the product's rules accept for THIS profile's id. */
function assertProfileCredentialDirs(profile: Pick<BackendProfile, 'id' | 'credentialDirs'>, trusted: boolean): void {
  if (profile.credentialDirs === undefined) return;
  if (!Array.isArray(profile.credentialDirs)) throw new Error(`profile \`${profile.id}\`: \`credentialDirs\` must be a list of folders`);
  for (const dir of profile.credentialDirs) {
    // The table folder of the profile's own id is for a profile shipped in the release; anyone else gets none.
    const problem = credentialDirProblem(dir, trusted ? profile.id : []);
    if (problem) throw new Error(`profile \`${profile.id}\`: ${problem}`);
  }
}

function addProfile(
  owner: string, profile: BackendProfile, resolver?: EnvResolver, deferDialect = false, userFile = false, trusted = false,
): () => void {
  assertFreeProfileId(profile.id, owner, trusted);
  assertCapabilitiesShape(`profile \`${profile.id}\``, profile.capabilities);
  assertDeclaredRanking(profile);
  if (!deferDialect && !dialects.has(profile.dialect)) {
    throw new Error(`profile \`${profile.id}\`: unknown dialect \`${profile.dialect}\` (register it first)`);
  }
  const previous = profiles.findIndex((p) => p.id === profile.id);
  if (previous >= 0) profiles.splice(previous, 1);
  // Product profiles keep their catalogue position, ahead of every other profile, whatever the order
  // their plugins load in (a user's file or a third party's plugin may register first).
  // Explicit user ranks are still applied by activeProfiles after this default ordering.
  const productIds = Object.keys(BUILTIN_DECLARATIONS);
  const productIndex = trusted ? productIds.indexOf(profile.id) : -1;
  const nextProduct = productIndex < 0 ? -1 : profiles.findIndex((entry) => {
    const index = trustedProfiles.has(entry.id) ? productIds.indexOf(entry.id) : -1;
    return index < 0 || index > productIndex;
  });
  if (nextProduct < 0) profiles.push(profile);
  else profiles.splice(nextProduct, 0, profile);
  profileOwners.set(profile.id, owner);
  const token = Symbol(profile.id);
  profileTokens.set(profile.id, token);
  if (userFile) fileOwned.add(profile.id); else fileOwned.delete(profile.id);
  if (trusted) trustedProfiles.add(profile.id); else trustedProfiles.delete(profile.id);
  envResolvers.delete(profile.id);
  settingProbes.delete(profile.id);
  resolverHealth.delete(profile.id);
  if (resolver) {
    envResolvers.set(profile.id, resolver);
    void checkResolver(profile.id, resolver);
  }
  invalidate();
  return () => releaseOrDefer(owner, () => {
    // The token, not just the owner: a swapped-in registration is not ours to remove.
    if (profileOwners.get(profile.id) !== owner || profileTokens.get(profile.id) !== token) return;
    const index = profiles.findIndex((p) => p.id === profile.id);
    if (index < 0) return;
    profiles.splice(index, 1);
    profileOwners.delete(profile.id);
    profileTokens.delete(profile.id);
    fileOwned.delete(profile.id);
    trustedProfiles.delete(profile.id);
    envResolvers.delete(profile.id);
    settingProbes.delete(profile.id);
    resolverHealth.delete(profile.id);
    invalidate();
  });
}

/**
 * Adds a PROFILE ("which binary, which env, which models") onto an existing
 * dialect. It is the common case: a drop-in provider of an already
 * supported CLI requires no parsing line.
 */
export function registerProfile(owner: string, profile: RegisteredProfile, options: { trusted?: boolean } = {}): () => void {
  const trusted = options.trusted === true;
  assertProfileCredentialDirs(profile, trusted);
  const { env, ...shape } = profile;
  // The dialect it names may be one the product ships as a plugin (`codex`), loaded before or after this one:
  // the profile sits inactive, with its reason, until the dialect is there (PROVIDERS-SDK § 12 question 3).
  // Any other unknown dialect is a typo, and refused rather than left to vanish.
  const deferred = BUILTIN_DECLARATIONS[profile.dialect] !== undefined;
  if (typeof env === 'function') return addProfile(owner, shape, env, deferred, false, trusted);
  // An unset value (a setting nobody filled in yet) is dropped, as it always
  // was in effect; anything else that is not a string is a contract error.
  const literals: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {}) as [string, unknown][]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new Error(`profile \`${profile.id}\`: \`env\` takes strings only — a credential goes through a function`);
    }
    literals[key] = value;
  }
  return addProfile(owner, { ...shape, ...(env ? { env: literals } : {}) }, undefined, deferred, false, trusted);
}

/**
 * Same, for a source the DAEMON owns (operator-written data): the full
 * `BackendProfile`, vault references and `requiredEnv` included. Never exposed
 * on a plugin context — a plugin naming a vault entry would read it without
 * holding `secrets:read`.
 */
export function registerTrustedProfile(
  owner: string, profile: BackendProfile, options: { deferDialect?: boolean; trusted?: boolean } = {},
): () => void {
  const trusted = options.trusted === true;
  if (trusted) assertProfileCredentialDirs(profile, true);
  return addProfile(owner, profile, undefined, options.deferDialect === true, false, trusted);
}

/**
 * Same, for a profile read from `~/.timon/backends/*.json`. A data file may
 * name a dialect that is not installed (yet): the profile then sits INACTIVE
 * with a readable reason instead of failing the load, and comes alive by
 * itself the day a plugin brings that dialect — once its env names pass that
 * dialect's allowlist.
 */
export function registerFileProfile(owner: string, profile: BackendProfile): () => void {
  return addProfile(owner, profile, undefined, true, true);
}

/**
 * Same, for an entry of a signed provider pack (`plugins/provider-pack.ts`):
 * dialect deferred likewise, env names already held to the pack policy at
 * parse time, credentials bound from the pack's secret settings.
 */
export function registerPackProfile(
  owner: string, profile: BackendProfile,
  settings?: { resolve: EnvResolver; probe: () => string | null },
): () => void {
  const dispose = addProfile(owner, profile, settings?.resolve, true, false);
  if (settings) settingProbes.set(profile.id, settings.probe);
  return dispose;
}

/**
 * Adds a DIALECT ("how to talk to this CLI"). To reserve for a really
 * different protocol: a drop-in endpoint is a profile, not a dialect.
 */
export function registerDialect(
  owner: string, id: string, dialect: AnyDialect, options: { strict?: boolean; trusted?: boolean } = {},
): () => void {
  const existing = dialectOwners.get(id);
  const swapped = existing !== undefined && existing === owner && swapping.has(owner);
  if (existing && !swapped) throw new Error(`dialect \`${id}\` already registered by \`${existing}\``);
  if (!existing && dialects.has(id)) throw new Error(`dialect \`${id}\` is a product dialect — pick another id`);
  assertDialectShape(id, dialect);
  assertDialectCoherent(id, dialect, options.strict === true);
  if (swapped) {
    const conflict = hotUpdateConflict(dialects.get(id)!, dialect);
    if (conflict) throw new HotUpdateRefusedError(`dialect \`${id}\`: ${conflict} — restart the daemon (or the missions on it) to apply this version`);
  }
  dialects.set(id, dialect);
  dialectOwners.set(id, owner);
  const token = Symbol(id);
  dialectTokens.set(id, token);
  setDialectTrust(id, options.trusted === true);
  invalidate();
  return dialectReleaser(owner, id, token);
}

/** The trust of a dialect is the trust of its live registration: a new one overwrites the old verdict. */
function setDialectTrust(id: string, trusted: boolean): void {
  if (trusted) trustedDialects.add(id); else trustedDialects.delete(id);
}

/** Withdraws a dialect registration if it is still the live one (by token, not by object). */
function dialectReleaser(owner: string, id: string, token: symbol): () => void {
  return () => releaseOrDefer(owner, () => {
    if (dialectOwners.get(id) !== owner || dialectTokens.get(id) !== token) return;
    dialects.delete(id);
    dialectOwners.delete(id);
    dialectTokens.delete(id);
    trustedDialects.delete(id);
    // The profiles set on this dialect become inactive on their own
    // (`activeProfiles` ignores them): nothing to delete, and reloading the
    // plugin puts them back into service without anyone having to rewrite them.
    invalidate();
  });
}

/**
 * Replaces, in ONE step, the dialect this owner registered under `id`
 * (`ctx.provider.replaceProvider`, `PROVIDERS-SDK.md` § 11.3). `registerDialect`
 * refuses a duplicate, so replacing by "remove, then register" leaves a moment
 * where `isBackendName(id)` is false; here the old dialect serves until the new
 * one is in place, and a mission already running keeps the `Backend` it holds.
 * Refused, like a hot update, when it would change how a mission talks to its
 * provider (transport, session store).
 */
export function replaceDialect(
  owner: string, id: string, dialect: AnyDialect, options: { strict?: boolean; trusted?: boolean } = {},
): () => void {
  const existing = dialects.get(id);
  if (!existing || dialectOwners.get(id) !== owner) {
    throw new Error(`dialect \`${id}\` is not registered by \`${owner}\`: register it first`);
  }
  assertDialectShape(id, dialect);
  assertDialectCoherent(id, dialect, options.strict === true);
  const conflict = hotUpdateConflict(existing, dialect);
  if (conflict) throw new HotUpdateRefusedError(`dialect \`${id}\`: ${conflict} — restart the daemon (or the missions on it) to apply this version`);
  dialects.set(id, dialect);
  const token = Symbol(id);
  dialectTokens.set(id, token);
  setDialectTrust(id, options.trusted === true);
  invalidate();
  return dialectReleaser(owner, id, token);
}

/* ── Providers written against the SDK (API 12) ──────────────────────────── */

/**
 * What a provider DECLARED (C1 to C9, `provider-declarations.ts`), by the id of
 * its dialect, with the token of the registration that set it so that a released
 * or replaced one is not mistaken for the live one. The core reads these instead
 * of asking a provider's name; a dialect registered the old way has none.
 */
const declarationEntries = new Map<string, { owner: string; declares: ProviderDeclarations; token: symbol }>();

/** A native definition that contradicts itself, or whose declarations the manifest did not authorize. */
export class ProviderDefinitionError extends Error {
  constructor(readonly providerId: string, readonly problems: readonly string[]) {
    super(`provider \`${providerId}\` is refused: ${problems.join('; ')}`);
    this.name = 'ProviderDefinitionError';
  }
}

type ProviderAuthorization = {
  authorizedBinaries?: readonly string[];
  authorizedCredentialDirs?: readonly string[];
  /** The plugin ships in the release and its files are vouched for (`plugins/builtin.ts`): decided by the loader, never by the plugin. */
  trusted?: boolean;
};

function checkedDialect(def: NativeProviderDefinition, { authorizedBinaries, authorizedCredentialDirs, trusted }: ProviderAuthorization) {
  const problems = definitionProblems(def);
  const names = def.declares?.binary?.names ?? [];
  if (authorizedBinaries) {
    for (const name of names) {
      if (!authorizedBinaries.includes(name)) {
        problems.push(`\`${name}\` is declared in \`declares.binary.names\` but not in the manifest's \`provider.binaries\`: the operator authorizes what the manifest lists`);
      }
    }
  }
  if (!trusted) {
    // `definitionProblems` lets a provider claim the table folder of the backend whose id it carries. Only a
    // provider shipped in the release may: `ollama-cloud` and `kimi` are PROFILES of the product, not dialect
    // ids, so a third party could otherwise register under one of them and take `.ollama` / `.kimi`.
    for (const dir of def.declares?.credentialDirs ?? []) {
      const reserved = otherBackendHomeDirProblem(dir, []);
      if (reserved) problems.push(`\`declares.credentialDirs\`: ${reserved} (only a provider shipped in the release may claim it)`);
    }
  }
  if (authorizedCredentialDirs) {
    for (const dir of def.declares?.credentialDirs ?? []) {
      if (!authorizedCredentialDirs.includes(dir)) {
        problems.push(`\`${dir}\` is declared in \`declares.credentialDirs\` but not in the manifest's \`provider.credentialDirs\`: the operator sees and authorizes the folders the manifest lists`);
      }
    }
  }
  if (problems.length > 0) throw new ProviderDefinitionError(typeof def?.id === 'string' ? def.id : '?', problems);
  return dialectFromDefinition(def);
}

function holdDeclarations(owner: string, def: NativeProviderDefinition): () => void {
  const token = Symbol(def.id);
  declarationEntries.set(def.id, { owner, declares: def.declares ?? {}, token });
  invalidate();
  return () => releaseOrDefer(owner, () => {
    if (declarationEntries.get(def.id)?.token !== token) return;
    declarationEntries.delete(def.id);
    invalidate();
  });
}

/**
 * Registers a provider written against the SDK (`ctx.provider.registerProvider`).
 * Checked first (`definitionProblems`: a capability declared without the member
 * that serves it is refused, naming both), then adapted to the dialect the
 * registry and the runner speak. `authorizedBinaries` is the manifest's
 * `provider.binaries` (names and aliases): the operator authorized those, so a
 * definition cannot declare another program.
 */
export function registerProvider(
  owner: string, def: NativeProviderDefinition, options: ProviderAuthorization = {},
): () => void {
  const dialect = checkedDialect(def, options);
  const releaseDialect = registerDialect(owner, def.id, dialect, { strict: true, trusted: options.trusted === true });
  const releaseDeclarations = holdDeclarations(owner, def);
  return () => { releaseDialect(); releaseDeclarations(); };
}

/**
 * Replaces the provider this owner registered under `def.id` in one step
 * (`ctx.provider.replaceProvider`): see `replaceDialect`. The declarations move
 * with it. Refused when the transport or the session store would change.
 */
export function replaceProvider(
  owner: string, def: NativeProviderDefinition, options: ProviderAuthorization = {},
): () => void {
  const dialect = checkedDialect(def, options);
  const releaseDialect = replaceDialect(owner, def.id, dialect, { strict: true, trusted: options.trusted === true });
  const releaseDeclarations = holdDeclarations(owner, def);
  return () => { releaseDialect(); releaseDeclarations(); };
}

/** What the provider behind the dialect `dialectId` declared, if it was registered natively. */
export function dialectDeclarations(dialectId: string): ProviderDeclarations | undefined {
  return declarationEntries.get(dialectId)?.declares;
}

/** What the provider behind the profile `id` declared (an account instance reads its backend's). */
export function profileDeclarations(id: string): ProviderDeclarations | undefined {
  const base = baseBackendId(id);
  const profile = profiles.find((p) => p.id === base);
  return profile ? dialectDeclarations(profile.dialect) ?? builtinDeclarations(base) : undefined;
}

// The host adapter asks the registry, through these two seams, for what providers declared.
setDeclaredBinariesSource((): ProviderBinaryDeclaration[] =>
  [...declarationEntries.values()].flatMap(({ declares }) => (declares.binary ? [declares.binary] : [])));
setDeclaredCredentialDirsSource((): Record<string, readonly string[]> => Object.fromEntries(
  profiles.flatMap((profile) => {
    // A profile that names its own folders keeps THOSE (`ollama-cloud` on `codex` must not spare `.codex`).
    const dirs = profile.credentialDirs ?? dialectDeclarations(profile.dialect)?.credentialDirs;
    return dirs && dirs.length > 0 ? [[profile.id, dirs] as const] : [];
  })));

/** The credential folders (relative to the home) that the providers `owner` registered declared. */
export function ownerCredentialDirs(owner: string): string[] {
  const own = new Set(profiles.filter((p) => profileOwners.get(p.id) === owner).flatMap((p) => p.credentialDirs ?? []));
  for (const entry of declarationEntries.values()) {
    if (entry.owner === owner) for (const dir of entry.declares.credentialDirs ?? []) own.add(dir);
  }
  return [...own];
}

/** The variables (C2 bis) that move the sign-in folder of the providers `owner` registered. */
export function ownerCredentialDirEnv(owner: string): string[] {
  const own = new Set<string>();
  for (const entry of declarationEntries.values()) {
    if (entry.owner === owner) for (const name of entry.declares.credentialDirEnv ?? []) own.add(name);
  }
  return [...own];
}

/**
 * C5 — what a profile declared for the daemon's own tasks, if it may serve them.
 *
 * Those tasks carry the transcripts of every mission (memory capture, synthesis, dreaming):
 * only a provider the product answers for may be asked to read them — the product's own, or one
 * shipped in the release and vouched for. What a third-party provider declares is ignored: the
 * consent it gets at install (`SDK § 12.6`) covers ITS missions, not everyone's.
 */
function serviceableOneShot(profile: BackendProfile): { model: string } | undefined {
  if (profile.custom || profile.providerConfig || Object.keys(profile.env ?? {}).length || Object.keys(profile.envFrom ?? {}).length || profile.requiredEnv?.length) return undefined;
  return trustedDialects.has(profile.dialect) && profileVouched(profile.id) ? dialectDeclarations(profile.dialect)?.oneShot : undefined;
}

/** C5 — the active profiles whose provider can serve the daemon's own one-shot tasks, in display order. */
export function oneShotProfiles(): Array<{ id: string; model: string }> {
  return activeProfiles().flatMap(({ profile, account }) => {
    const oneShot = account ? undefined : serviceableOneShot(profile);
    return oneShot ? [{ id: profile.id, model: oneShot.model }] : [];
  });
}

/**
 * The providers that declared they can serve the daemon's own tasks (C5), whether or not they are
 * active right now — the models the product's templates name (the seeded agents' tiers) are theirs.
 */
export function oneShotProviderIds(): string[] {
  return profiles.filter((profile) => serviceableOneShot(profile) !== undefined).map((profile) => profile.id);
}

/** C4 — is the user signed in to this provider, as the provider says it? `null` when it declared no way to tell. */
export async function providerAuthStatus(id: string, env: Readonly<Record<string, string>> = {}): Promise<ProviderAuthStatus | null> {
  const authStatus = profileDeclarations(id)?.authStatus;
  return authStatus ? authStatus(env) : null;
}

/** Dialects the product answers for (compiled in, or shipped in the release and vouched for), in a fixed order: by id. */
function productDialectIds(): string[] {
  return [...dialects.keys()].filter((id) => trustedDialects.has(id)).sort((a, b) => a.localeCompare(b));
}

/** What the product's dialect `id` declares about itself (a plugin's declaration, else the product's table). */
function declaredBy(id: string): ProviderDeclarations | undefined {
  return dialectDeclarations(id);
}

/**
 * C12 — the dialect that serves an API `protocol` for an endpoint the user typed in. Only a dialect
 * the product answers for counts (the user's key would go to its CLI); when two declare the same
 * protocol the lowest id wins. `null` when none is installed.
 */
export function dialectForProtocol(protocol: ProviderProtocol): string | null {
  return productDialectIds().find((id) => declaredBy(id)?.protocols?.includes(protocol)) ?? null;
}

/** C12 reversed: the protocol a profile's dialect speaks, the first it declares; `null` for a dialect that declares none. */
export function protocolOfDialect(dialectId: string): ProviderProtocol | null {
  if (!productDialectIds().includes(dialectId)) return null;
  return declaredBy(dialectId)?.protocols?.[0] ?? null;
}

/**
 * C4 for the providers that answer at once — all a diagnostic or the first-run screen can wait for.
 * `null` when the provider declared no way to tell, or only an asynchronous one.
 */
export function authStatusNow(id: string, env: Readonly<Record<string, string>> = {}): ProviderAuthStatus | null {
  const authStatus = profileDeclarations(id)?.authStatus;
  if (!authStatus) return null;
  const status = authStatus(env);
  return status instanceof Promise ? null : status;
}

/**
 * The plugin that runs backend `id` (an account instance included): the owner
 * of the dialect its profile speaks, else of the profile itself. Null for a
 * backend no plugin registered. The fence grants a mission that plugin's
 * scratch and cache folders, never another's.
 *
 * The dialect comes first because its `buildSpawn` is what opens the scratch
 * folder, under its own plugin id. A profile a user's file or a provider pack
 * adds is data on another plugin's dialect: its owner (`local-file`, the pack)
 * never opens a folder, and naming it left the mission fenced out of the one
 * the CLI was told to read.
 */
export function backendOwnerPlugin(id: string): string | null {
  const base = baseBackendId(id);
  const dialect = profiles.find((profile) => profile.id === base)?.dialect;
  const dialectOwner = dialect === undefined ? undefined : dialectOwners.get(dialect);
  return dialectOwner ?? profileOwners.get(base) ?? null;
}

/** What a plugin brought, for the gallery and the tests. */
export function registeredBackendOwners(): { profiles: Record<string, string>; dialects: Record<string, string> } {
  return {
    profiles: Object.fromEntries(profileOwners),
    dialects: Object.fromEntries(dialectOwners),
  };
}

/** Ids of every installed dialect, product and plugins alike. */
export function dialectIds(): string[] {
  return [...dialects.keys()];
}

/** Dialect registered under `id`, from the repo or from a plugin. */
export function getDialect(id: string): AnyDialect | undefined {
  return dialects.get(id);
}

/** Raw definitions stay authoritative for execution and cannot be overwritten by an overlay. */
export function installedProfiles(): readonly BackendProfile[] {
  return profiles;
}

export function assertBackendEnabled(id: string | null | undefined): void {
  if (!id) return;
  // An account instance is as enabled as its backend.
  const base = baseBackendId(id);
  const reason = inactiveProfiles().find((entry) => entry.id === base)?.reason;
  if (reason === 'disabled in settings') throw new Error(`Backend ${base} is disabled in settings`);
}

/** Whether accounts can be created on this backend right now: an active,
 *  first-party profile whose dialect runs a CLI login. */
export function backendTakesAccounts(id: string): boolean {
  const entry = activeProfiles().find((candidate) => candidate.profile.id === id && !candidate.account);
  return !!entry && takesAccounts(entry);
}

/** The account instance of `id`, when it is one and its backend is active. */
export function accountInstanceProfile(id: string | null | undefined): ResolvedProfile | undefined {
  if (!isAccountInstanceId(id)) return undefined;
  return activeProfiles().find((entry) => entry.profile.id === id);
}

export function isFileProfile(id: string): boolean {
  return fileOwned.has(id);
}
