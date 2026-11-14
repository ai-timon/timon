import {
  isRemoteDialect, probeLaunchContext,
  type AccountUsage, type Backend, type BackendLaunchContext, type BackendName, type BuildSpawnOpts, type NormalizedEvent,
  type RemoteDialect, type RemoteSessionOpenArgs, type SessionOpenArgs, type SpawnResult, type UsageProbeOptions,
} from './types.js';
import { credentialValues, deferredDriver, serializeResumeState } from './remote-session.js';
import {
  activeProfiles, assertBackendEnabled, dialectDeclarations, installedProfiles, oneShotProfiles, getDialect, dialectTrust, type ResolvedProfile,
} from './registry.js';
import { sealMissionToken } from './mission-token-seal.js';
import { sealFor } from './launch-seal.js';
import { journalInjectedSecrets } from '../secrets/env.js';
import { dbApi } from '../db.js';
import { backendIdForModel, catalogBackend } from './catalog.js';
import { baseBackendId, isAccountInstanceId, splitBackendInstance } from './instance-id.js';
import { providerSignedOut } from './sign-in-state.js';
import { settingStr } from '../settings.js';
import { projectFromCwd } from '../task-project.js';
import type { SecretTarget } from '../secrets/resolve.js';

export type {
  AccountUsage, ApprovalScope, AssistantDeltaPayload, Backend, BackendCapabilities, BackendCapability, BackendName, BackendProfile, BuildSpawnOpts,
  AnyDialect, BackendLaunchContext, Dialect, ImageAttachment,
  EnvResolver, EnvValue, NormalizedEvent, OpenSpan, PermissionDecision, PermissionModel, PermissionRequest, PermissionWait,
  ProfileRuntime, ProviderConfig, ProviderRetryKind, ProviderRetryPayload, RateLimitReporting, RemoteDialect, RemoteResumeState,
  RemoteSessionHost, RemoteSessionOpenArgs,
  RemoteSessionResume, SecretRef, SessionAnswer, SessionAskOutcome, SessionAskRequest, SessionCapabilities, SessionDriver, SessionEnd, SessionHost,
  SessionInfo, SessionOpenArgs, SessionQuestion, SessionQuestionOption, SessionStdio,
  SpanOp, SpanState, SpawnResult, TurnOutcome, UsageProbeOptions, UsageWindow,
} from './types.js';
export {
  probeLaunchContext,
  ASSISTANT_DELTA, BACKEND_CAPABILITIES, DEFAULT_BACKEND_CAPABILITIES, isRemoteDialect, NO_SESSION_CAPABILITIES, PERMISSION_MODELS, RATE_LIMIT_REPORTINGS,
  REMOTE_RESUME_MAX_BYTES, SESSION_STORES, PROVIDER_RETRY, PROVIDER_RETRY_KINDS,
} from './types.js';
export type { CatalogBackend, CatalogModel } from './catalog.js';
export {
  backendCatalog, primeModelDiscovery, catalogBackend, backendIdForModel,
  catalogClaimsModel,
} from './catalog.js';
export { backendCapabilities, canReadSkillOnDemand, nativeCompactCommand, nativeRewindStrategy, resolveCapabilities } from './capabilities.js';
export { activeProfiles, getDialect, inactiveProfiles, onBackendsChanged, type ResolvedProfile } from './registry.js';
export { ProfileEnvError } from './credentials.js';

/**
 * Rewrites the `backend` of a `system:init` with the PROFILE's name.
 *
 * A dialect only knows itself: codex's synthesises its init by
 * announcing itself as "codex", which is wrong as soon as another profile reuses that
 * CLI. A mission served by Ollama Cloud thus declared itself "codex" in its
 * own history — and the agent, reading its init, believed it was GPT.
 *
 * The dialect cannot fix that (it does not know which profile uses it), but the
 * registry knows: it is the one that bound them.
 */
function stampBackend(events: NormalizedEvent[], profileId: string): NormalizedEvent[] {
  return events.map((ev) => {
    if (ev.type !== 'system') return ev;
    const p = ev.payload as { subtype?: string } | null;
    if (!p || p.subtype !== 'init') return ev;
    return { ...ev, payload: { ...p, backend: profileId } };
  });
}

/**
 * For whom this spawn runs, read off the mission's own row — the one place the
 * owner is recorded, whoever launched it (a chat, a Kanban task, a plugin). A
 * spawn with no mission row behind it (a daemon one-shot: `summary-…`) is not a
 * mission: it gets the `probe` context, never an id nobody can look up.
 */
export function launchContextFor(spawn: Pick<BuildSpawnOpts, 'missionId' | 'agentName' | 'cfg'>): BackendLaunchContext {
  let owner: string | null | undefined;
  try {
    owner = dbApi.getMission(spawn.missionId)?.owner_user_id;
  } catch {
    owner = undefined;
  }
  if (owner === undefined) return probeLaunchContext();
  return Object.freeze({
    kind: 'mission',
    missionId: spawn.missionId,
    ownerUserId: owner ?? null,
    agentName: spawn.agentName,
    project: spawn.cfg.project ?? null,
  });
}

/**
 * Who the vault sees behind a launch: the agent, and the project the mission's
 * own vault slice uses (`agent.ts`: declared, else the cwd's). A delegated
 * mission or a one-shot answers as the agent it runs for, so a key reserved to
 * a backend and granted to one project reaches its missions there and nowhere
 * else (TODO #531, decision 5-B). The backend is added by the credentials
 * layer, from the profile.
 */
export function secretTargetFor(spawn: Pick<BuildSpawnOpts, 'agentName' | 'cfg'>): SecretTarget {
  return { agent: spawn.agentName, project: spawn.cfg.project ?? projectFromCwd(spawn.cfg.cwd) ?? null };
}

/**
 * Binds a profile (binary, env, provider) to its dialect (the code) to produce
 * the `Backend` the rest of the orchestrator consumes. The dialect stays
 * shared by all the profiles that use it — only the `ProfileRuntime`
 * captured here differs.
 */
/**
 * C6: the non-secret variables a provider declared (its CLI's own home or config
 * folder) are copied from the daemon's environment under the provider's spec, which
 * wins. The names were checked at registration (`passthroughProblem`): nothing that
 * reads like a credential gets here.
 */
function withPassthroughEnv(spawn: SpawnResult, names: readonly string[] | undefined): SpawnResult {
  if (!names || names.length === 0) return spawn;
  const copied: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) copied[name] = value;
  }
  return Object.keys(copied).length === 0 ? spawn : { ...spawn, env: { ...copied, ...(spawn.env ?? {}) } };
}

function backendFromProfile({ profile, dialect, runtimeFor }: ResolvedProfile): Backend {
  if (isRemoteDialect(dialect)) return remoteBackendFromProfile(profile, dialect, runtimeFor);
  const coreDialect = dialectTrust(profile, dialect) === 'core';
  return {
    name: profile.id,
    persistentProcess: dialect.persistentProcess,
    finishMissionOnExit: dialect.finishMissionOnExit,
    sessionResumable: dialect.sessionResumable,
    sessionStore: dialect.sessionStore,
    permissionModel: dialect.permissionModel,
    rateLimitReporting: dialect.rateLimitReporting,
    hostedConnectors: dialect.hostedConnectors,
    ...(dialect.browserToolsHint ? { browserToolsHint: dialect.browserToolsHint } : {}),
    ...(dialect.permissionsHint ? { permissionsHint: dialect.permissionsHint } : {}),
    // The usage probe receives the profile: it is the one that says whether it is
    // applicable (first-party endpoint) or not (third-party redirection).
    // No mission here, hence no target: only what any mission would get. A
    // profile whose credentials cannot be produced has no usage to report.
    ...(dialect.accountUsage
      ? {
        accountUsage: async (options?: UsageProbeOptions): Promise<AccountUsage | null> => {
          const resolved = await runtimeFor().catch(() => null);
          return resolved ? dialect.accountUsage!(resolved.runtime, options) : null;
        },
      }
      : {}),
    // Credentials are resolved HERE, per spawn, and scoped to the mission: a
    // key rotated or a short-lived token refreshed between two missions is
    // seen by the second one, with no registry mutation and no restart.
    buildSpawn: async (opts: BuildSpawnOpts): Promise<SpawnResult> => {
      const { runtime, injected } = await runtimeFor(secretTargetFor(opts), launchContextFor(opts));
      const model = opts.cfg.model ?? catalogBackend(profile.id)?.defaultModel;
      const spawn = await dialect.buildSpawn(model ? { ...opts, cfg: { ...opts.cfg, model } } : opts, runtime);
      journalInjectedSecrets({ missionId: opts.missionId, agent: opts.agentName, injected });
      return withPassthroughEnv(spawn, dialectDeclarations(profile.dialect)?.passthroughEnv);
    },
    writeUserInput: dialect.writeUserInput.bind(dialect),
    parseLine: (line: string) => stampBackend(dialect.parseLine(line), profile.id),
    extractSessionId: dialect.extractSessionId.bind(dialect),
    ...(dialect.spans ? { spans: dialect.spans.bind(dialect) } : {}),
    // Same rule as `setModel`: absent from the dialect ⇒ absent from the
    // backend, and that absence is how a caller learns the line-oriented path
    // is the only one. The profile id is closed over here.
    ...(dialect.openSession
      ? {
        openSession: (args: Omit<SessionOpenArgs, 'profileId' | 'launch'>) => {
          // A dialect a plugin registered — the release's own included — never holds the
          // mission's token: it gets a reference and the daemon swaps it on the way to
          // the process. Only a dialect compiled into the daemon is handed the value.
          const sealed = !coreDialect && args.mcpEnv ? sealMissionToken(args.io, args.mcpEnv, sealFor(args.spawn.missionId)) : null;
          return dialect.openSession!({
            ...args,
            ...(sealed ?? {}),
            profileId: profile.id,
            launch: launchContextFor(args.spawn),
          });
        },
      }
      : {}),
    ...(dialect.isSessionNotFoundError
      ? { isSessionNotFoundError: dialect.isSessionNotFoundError.bind(dialect) }
      : {}),
    // Missing from the dialect ⇒ missing from the backend: an undefined `backend.setModel`
    // is how the caller learns there is no hot switch.
    ...(dialect.setModel ? { setModel: dialect.setModel.bind(dialect) } : {}),
    ...(dialect.maxPromptBytes ? { maxPromptBytes: dialect.maxPromptBytes } : {}),
    ...(dialect.nativeCompact ? { nativeCompact: dialect.nativeCompact } : {}),
    ...(dialect.dispose ? { dispose: dialect.dispose.bind(dialect) } : {}),
    ...(dialect.enrichEvent ? { enrichEvent: dialect.enrichEvent.bind(dialect) } : {}),
  };
}

/**
 * Same binding for a dialect with no process. Every member a caller may read
 * is there; the three that would need a process refuse loudly instead of
 * spawning an empty command. Credentials are resolved when the session starts
 * (`deferredDriver`), with the same per-mission scope and journal as a spawn.
 */
function remoteBackendFromProfile(
  profile: ResolvedProfile['profile'],
  dialect: RemoteDialect,
  runtimeFor: ResolvedProfile['runtimeFor'],
): Backend {
  const noProcess = (): never => {
    throw new Error(`backend ${profile.id} is remote: it runs no local process`);
  };
  return {
    name: profile.id,
    // The session outlives its turns, and its end is the mission's.
    persistentProcess: true,
    finishMissionOnExit: true,
    sessionResumable: dialect.sessionResumable,
    sessionStore: dialect.sessionStore,
    permissionModel: dialect.permissionModel,
    rateLimitReporting: dialect.rateLimitReporting,
    hostedConnectors: dialect.hostedConnectors,
    ...(dialect.browserToolsHint ? { browserToolsHint: dialect.browserToolsHint } : {}),
    ...(dialect.permissionsHint ? { permissionsHint: dialect.permissionsHint } : {}),
    ...(dialect.nativeCompact ? { nativeCompact: dialect.nativeCompact } : {}),
    ...(dialect.accountUsage
      ? {
        accountUsage: async (options?: UsageProbeOptions): Promise<AccountUsage | null> => {
          const resolved = await runtimeFor().catch(() => null);
          return resolved ? dialect.accountUsage!(resolved.runtime, options) : null;
        },
      }
      : {}),
    buildSpawn: async (): Promise<SpawnResult> => noProcess(),
    writeUserInput: () => noProcess(),
    parseLine: () => noProcess(),
    extractSessionId: dialect.extractSessionId.bind(dialect),
    ...(dialect.spans ? { spans: dialect.spans.bind(dialect) } : {}),
    openRemoteSession: (args: Omit<RemoteSessionOpenArgs, 'profileId' | 'env' | 'launch'>) => deferredDriver(async () => {
      const { spawn } = args;
      // One context for the resolver and the driver: both pick the same account.
      const launch = launchContextFor(spawn);
      const { runtime, injected } = await runtimeFor(secretTargetFor(spawn), launch);
      journalInjectedSecrets({ missionId: spawn.missionId, agent: spawn.agentName, injected });
      const model = spawn.cfg.model ?? catalogBackend(profile.id)?.defaultModel;
      const credentials = credentialValues(runtime.env, injected.map((secret) => secret.name));
      return dialect.openSession({
        ...args,
        spawn: model ? { ...spawn, cfg: { ...spawn.cfg, model } } : spawn,
        // The init announces the PROFILE, as `parseLine` makes it for the others.
        host: {
          emit: (ev) => args.host.emit(stampBackend([ev], profile.id)[0]!),
          requestPermission: (req, wait) => args.host.requestPermission(req, wait),
          ...(args.host.ask ? { ask: args.host.ask.bind(args.host) } : {}),
          end: (outcome) => args.host.end(outcome),
          // The credential check needs the env, which only this layer sees.
          saveResume: (state) => {
            if (state !== null) serializeResumeState(state, credentials);
            args.host.saveResume(state);
          },
        },
        profileId: profile.id,
        launch,
        env: { ...runtime.env },
      });
    }),
    ...(dialect.dispose ? { dispose: dialect.dispose.bind(dialect) } : {}),
    ...(dialect.enrichEvent ? { enrichEvent: dialect.enrichEvent.bind(dialect) } : {}),
  };
}

/**
 * Source of truth of the available LLM backends. Adding a backend = adding
 * a profile (`registerProductProfile` for a provider of the product, `ctx.backends`
 * for a third-party plugin): the names accepted by the API, the project roles and the dispatcher
 * are all derived from it through `isBackendName`.
 *
 * The registry contains ONLY the active profiles — a third-party profile whose
 * credentials are missing is not in it, so `isBackendName` rejects it and nothing
 * can be dispatched onto it by mistake.
 *
 * Recomputed when the registry moves, never frozen at import: a provider plugin
 * installed hot must be dispatchable within the second, and an
 * unloaded plugin must stop being so.
 */
let registry: Record<string, Backend> | null = null;
let registrySource: ResolvedProfile[] | null = null;

// Keyed on the IDENTITY of what the registry returns, not on a change event:
// `activeProfiles()` re-evaluates visibility on every read (a key that appears
// mid-life activates its profile), and hands back the same array until
// something moved.
function backendRegistry(): Record<string, Backend> {
  const source = activeProfiles();
  if (!registry || registrySource !== source) {
    registry = Object.fromEntries(source.map((rp) => [rp.profile.id, backendFromProfile(rp)]));
    registrySource = source;
  }
  return registry;
}

/** Names of the active backends, read AT CALL TIME: a constant would freeze the list
 *  at the start state, before any provider plugin. */
export function backendNames(): readonly BackendName[] {
  return Object.keys(backendRegistry());
}

/** Validates an arbitrary value (JSON body, DB column, config file)
 *  against the registry's keys. The only legitimate entry point to accept
 *  a backend name coming from outside. */
export function isBackendName(v: unknown): v is BackendName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(backendRegistry(), v);
}

/** Same, but returns the normalised value or null — handy in expression
 *  position (`spec.backend = asBackendName(o.backend) ?? undefined`). */
export function asBackendName(v: unknown): BackendName | null {
  return isBackendName(v) ? v : null;
}

export function getBackend(name: BackendName | undefined | null): Backend {
  assertBackendEnabled(name);
  const current = backendRegistry();
  // An account is never swapped for the default backend: that would run the
  // mission on another subscription without a word (TODO #52).
  if (isAccountInstanceId(name) && !current[name!]) {
    throw new Error(`The ${baseBackendId(name)} account ${splitBackendInstance(name!).accountId} is not available: it was deleted, or its backend is off.`);
  }
  // An explicit name that is not in the registry is an error, never another
  // backend: running a mission on a different subscription in silence is the
  // one drift this function must not allow (a provider mid-update, an
  // uninstalled plugin, a profile switched off). Only an ABSENT name takes the
  // default.
  if (name) {
    const found = current[name];
    if (!found) throw new Error(`Backend ${name} is not available`);
    return found;
  }
  return current[defaultBackendName()]!;
}

/** Backend that claims `model`, or null if none (unknown model → it is
 *  let through as is, the CLI decides). Feeds the dispatcher's
 *  anti-mismatch guard.
 *
 *  The resolution comes entirely from the catalogue (`./catalog.ts`): exact
 *  lookup of the slug, then declared literal prefix. No heuristic on the
 *  shape of the slug — an unknown `grok-4.5` returns null instead of being attributed
 *  at random. */
export function backendForModel(model: string | null | undefined): BackendName | null {
  return backendIdForModel(model);
}

/** An implicit default may follow the active catalogue; an explicit choice never does.
 *  `null` when no provider is active: the daemon starts that way, and a screen
 *  that only wants to show the catalogue must not die on it. */
export function tryDefaultBackendName(): BackendName | null {
  const names = backendNames();
  const preferred = settingStr('TIMON_PREFERRED_BACKEND')?.trim();
  if (preferred && names.includes(preferred) && !providerSignedOut(preferred)) return preferred;
  // A provider whose CLI is there but signed out is no default: every turn on it would
  // end on "Not logged in". When all are signed out, the order below still names one.
  const pool = signedInFirst(names);
  // The first active provider that can serve the daemon's own tasks (C5 `oneShot`), then the first active one.
  return oneShotProfiles().find(({ id }) => pool.includes(id))?.id ?? pool[0] ?? null;
}

/** `names` without the providers known to be signed out, unless that leaves nothing. */
function signedInFirst(names: readonly BackendName[]): readonly BackendName[] {
  const ready = names.filter((name) => !providerSignedOut(name));
  return ready.length ? ready : names;
}

/**
 * Where the daemon's own tasks (dreaming, memory capture and synthesis, scoring, the
 * librarian…) run: the first active provider that declared it can serve them (C5
 * `oneShot`), else the default backend. The operator's model setting is honoured when it
 * is a model of that backend (or one the catalogue does not know, which the CLI decides);
 * a model of ANOTHER backend would only fail there, so the provider's declared model, then
 * its catalogue default, takes its place.
 */
export function oneShotTarget(settingModel: string | null | undefined): { backend: BackendName | undefined; model: string | undefined } {
  const names = signedInFirst(backendNames());
  const declared = oneShotProfiles().find(({ id }) => names.includes(id));
  const backend = declared?.id ?? tryDefaultBackendName() ?? undefined;
  const wanted = settingModel?.trim() || undefined;
  const owner = wanted ? backendForModel(wanted) : null;
  if (wanted && (owner === null || owner === backend)) return { backend, model: wanted };
  return { backend, model: declared?.model ?? (backend ? catalogBackend(backend)?.defaultModel ?? undefined : undefined) };
}

/** What an unset backend (agent config, role, override) stands for right now; empty when no provider is active. */
export function implicitBackendName(): string {
  return tryDefaultBackendName() ?? '';
}

/** Same, for a caller that is about to launch something: no provider is an error it can name. */
export function defaultBackendName(): BackendName {
  const chosen = tryDefaultBackendName();
  if (!chosen) throw new Error('No active LLM backend is available');
  return chosen;
}

export { assertBackendEnabled } from './registry.js';

/** What stopping or cleaning a mission needs of a backend that no longer exists. */
const VANISHED_BACKEND = Object.freeze({
  sessionResumable: false,
  sessionStore: 'global',
  persistentProcess: false,
  dispose: undefined,
} satisfies Pick<Backend, 'sessionResumable' | 'sessionStore' | 'persistentProcess' | 'dispose'>);

/** Stopping, inspecting or cleaning an old session must not require permission to launch. */
export function backendMetadata(name: BackendName | null | undefined): Pick<Backend, 'sessionResumable' | 'sessionStore' | 'persistentProcess' | 'dispose'> {
  // An account shares its backend's dialect, and a deleted account must not
  // keep its old missions from being stopped or cleaned.
  const base = name ? baseBackendId(name) : tryDefaultBackendName();
  if (!base) return VANISHED_BACKEND;
  const profile = installedProfiles().find((entry) => entry.id === base);
  const dialect = profile && getDialect(profile.dialect);
  if (dialect && isRemoteDialect(dialect)) {
    return { sessionResumable: dialect.sessionResumable, sessionStore: dialect.sessionStore, persistentProcess: true, dispose: dialect.dispose?.bind(dialect) };
  }
  if (dialect) return dialect;
  // The provider is gone (plugin uninstalled, agent removed, files that failed
  // verification): its missions must still be stoppable and cleanable, and
  // `getBackend` refuses to answer for a backend that is not there.
  try { return getBackend(base); } catch { return VANISHED_BACKEND; }
}
