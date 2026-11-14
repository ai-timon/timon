/**
 * Catalogue of the LLM backends and their models, DERIVED from the active profiles.
 *
 * The data itself lives in the registered profiles (a profile = "which
 * binary, which env, which models"); this module only keeps the
 * "display + resolution" view of it. Direct consequence: a profile disabled for lack
 * of credentials appears nowhere, without conditional code on the UI side.
 *
 * It is the single view for "which backends exist, which
 * models they serve, how they are displayed". It feeds:
 *   - `backendForModel()` (the dispatcher's anti-mismatch guard) through an exact
 *     lookup of the slug — no more regex guessing on the shape of the slug;
 *   - the `GET /api/backends/catalog` API, which the UI consumes at runtime to
 *     build its menus (the UI no longer redeclares the list at build time).
 *
 * Adding a model = adding an entry in the matching profile, and nothing
 * else: it appears in the UI's menus AND becomes resolvable by the
 * dispatcher.
 *
 * A backend of the catalogue is not necessarily served by a first-party CLI: a
 * custom provider profile declares its models with `custom: true`, or
 * declares none (`models: []`) when the upstream list is not known. The UI must
 * tolerate an empty list.
 */

import { modelPreferences, mergeModelPreferences } from './model-preferences.js';
import { activeProfiles, dialectDeclarations } from './registry.js';
import { isSecretRef } from './credentials.js';
import { discoveredModels, refreshAll, type DiscoverySource } from './model-discovery.js';
import { profileBaseUrl, resolveModelReasoning, type DeclaredReasoningControl, type ModelReasoning, type ReasoningControl } from './reasoning.js';
import type { ProviderModelCache, UnverifiedSubject } from './provider-declarations.js';
import { BUILTIN_DECLARATIONS } from './builtin-declarations.js';
import { baseBackendId } from './instance-id.js';
import { resolveCapabilities } from './capabilities.js';
import { resolveSupportedPermissionMode } from './permission-models.js';
import { isRemoteDialect, type BackendCapabilities, type BackendProfile, type PermissionModel, type RateLimitReporting } from './types.js';

export type { CatalogModel } from './catalog-model.js';
import type { CatalogModel } from './catalog-model.js';

export type CatalogBackend = {
  /** Backend identifier = REGISTRY key for a native backend. */
  id: string;
  /** Label of the backend in the selectors. */
  label: string;
  /** Provider name (left column of the LLM selector). Absent →
   *  the UI falls back on `label`. */
  vendor?: string;
  /** Logo key resolved on the UI side (see `BackendProfile.brand`). */
  brand?: string;
  /** Pictogram chosen by the user (see `BackendProfile.icon`). Wins over
   *  `brand`: it is a human's explicit choice against a default. Failing that,
   *  the logo the provider declared (C9, `declares.brand`): a
   *  `data:image/svg+xml;base64,…` the UI shows as an image, never
   *  injected into the page. */
  icon?: string;
  models: CatalogModel[];
  /** Model preselected on backend switch. `null` if the backend has
   *  no known list (blank custom profile) — the UI then leaves the field
   *  free. */
  defaultModel: string | null;
  /** Backend served by a custom provider profile rather than by a first-party
   *  CLI. Informative for the UI (badge), without effect on resolution. */
  custom?: boolean;
  /** Net AFTER the exact lookup, for the full versioned slugs the
   *  catalogue does not list (`claude-sonnet-4-6` vs the alias `sonnet`). List
   *  of literal prefixes, not a pattern: a backend that declares none
   *  claims ONLY its exact slugs. */
  slugPrefixes?: string[];
  /* ── Capabilities of the dialect, carried up to the UI ────────────────
     So that the UI adapts its wording (permissions, quota gauges) without
     ever comparing `backend.id` to a literal name. */
  /** How the CLI arbitrates tool uses (see `PermissionModel`). */
  permissionModel: PermissionModel;
  /** What its stream says about a usage limit (see `RateLimitReporting`). */
  rateLimitReporting: RateLimitReporting;
  /** Can the backend report the ACCOUNT's usage? False → the UI
   *  shows no quota gauge rather than a gauge at zero. */
  accountUsage: boolean;
  /** Does the session survive the death of the process (see `Backend.sessionResumable`)?
   *  False → cutting a turn is a HARD stop: the UI must warn before
   *  offering it, instead of promising a resume the CLI will refuse. */
  sessionResumable: boolean;
  /** The agent arbitrates its tools itself and never asks Timon (opencode):
   *  the UI says "permissions managed by the agent" instead of waiting for a card
   *  that will not come. Derived from the dialect (`Dialect.permissionsByAgent`),
   *  present only when true. */
  selfManagedPermissions?: boolean;
  /** The provider applies the agent's permission mode itself before it asks
   *  (Pi's gate, `PermissionStrategy.appliesMode`): the UI says the mode holds.
   *  Present only when true. */
  permissionModeApplied?: boolean;
  /** The only permission modes the provider honours (`PermissionStrategy.supportedModes`):
   *  the selectors offer only these, and any other mode runs in `plan`.
   *  Absent = every mode is honoured. */
  supportedPermissionModes?: string[];
  /** The agent is served by a remote session: Timon starts no process on this
   *  machine for it (`isRemoteDialect`). Present only when true. What it does
   *  runs on someone else's host, so it cannot widen what a mission may do HERE
   *  — the reason a non-admin may select it (cf. `backendRefusal`). */
  remote?: boolean;
  /** What the backend declared it can do (cf. `BackendCapabilities`), resolved
   *  from dialect and profile. Always present and complete: the UI disables an
   *  attachment button or shows a "remote" badge from it, never from an id. */
  capabilities: BackendCapabilities;
  /** The agent compacts its own session (`SessionStrategy.compact`): a
   *  compaction stays in the mission instead of forking. Present only when
   *  true (`POST /api/missions/:id/compact`, docs/MISSION-COMPACT.md). */
  nativeCompact?: boolean;
  /** Billing/auth wording specific to the provider (see `BackendProfile`). */
  subscription?: { note: string; planMaxToggle?: boolean };
  /** Set on a subscription account instance (`claude@<id>`): the backend it
   *  belongs to, and the account's display name. Never a path or a secret. */
  instanceOf?: string;
  account?: { id: string; name: string };
  /** Kinds of thinking control the dialect can send for this custom provider
   *  (cf. `Dialect.thinkingControls`). Absent = levels only: the UI must not
   *  offer a budget or a switch the dialect would pass on as a level. */
  thinkingControls?: ReasoningControl['type'][];
  /** What a person types in a terminal to sign in to this provider's CLI (`grok login`),
   *  so the screens that say "not signed in" can name it. Only the product's own providers
   *  declare one. */
  signInCommand?: string;
  /** What to do once that command runs, when the CLI does not sign in by itself. */
  signInThen?: string;
  /** What the provider says it has not seen work on the real program (`declares.unverified`):
   *  the screens show it with the backend. Present only when it lists something. */
  unverified?: { subject: UnverifiedSubject; note: string }[];
};

/**
 * Current view of the catalogue.
 *
 * Recomputed on each call rather than frozen when the module loads: the
 * models of a provider that exposes an enumeration endpoint are discovered at
 * runtime (see `model-discovery.ts`), and a constant evaluated once would have
 * frozen them at the start state. The cost is that of a `map` over a
 * handful of profiles — negligible next to the HTTP call it serves.
 *
 * Deliberate side effect: each read re-primes a refresh if the TTL
 * has elapsed. It is asynchronous, the current call returns the previous state.
 */
export function backendCatalog(): CatalogBackend[] {
  refreshAll(profiles());
  return currentBackends();
}

/** Primes the discovery at start, so that the first read of the catalogue
 *  already has the up-to-date list. No await: the boot does not depend on the network. */
export function primeModelDiscovery(): void {
  refreshAll(profiles(), true);
}

function profiles(): DiscoverySource[] {
  // An account instance lists its backend's models: probing it again would
  // only repeat its backend's request.
  return activeProfiles().filter((entry) => !entry.account).map(({ profile, dialect }) => {
    const probe = dialect.discoverModels;
    if (!probe) return { profile };
    // A discovery probe opens no mission, so it has no credential to resolve.
    const cmd = isRemoteDialect(dialect) ? '' : profile.cmd ?? dialect.defaultCmd;
    // What a probe may know of the profile: its non-secret environment (where the
    // CLI keeps its login) and the models the profile itself lists.
    const runtime = { id: profile.id, cmd, env: probeEnv(profile), knownModels: profile.models.map((m) => m.slug) };
    return { profile, discover: () => probe.call(dialect, runtime) };
  });
}

/** The `envFrom` of a profile that is not a credential: a vault reference of
 *  the same name means a secret, which no probe receives. */
function probeEnv(profile: BackendProfile): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [child, source] of Object.entries(profile.envFrom ?? {})) {
    if (isSecretRef(profile.env?.[child])) continue;
    const value = process.env[source];
    if (value) env[child] = value;
  }
  return env;
}

/**
 * Merge slugs from the Codex account cache that are not already in the profile
 * list. New entries carry a minimal shape: label = slug, no invented metadata.
 */
function withCacheSlugs(profileModels: CatalogModel[], cacheSlugs: readonly string[]): CatalogModel[] {
  const known = new Set(profileModels.map((m) => m.slug));
  const extra: CatalogModel[] = cacheSlugs
    .filter((slug) => !known.has(slug))
    .map((slug) => ({ slug, label: slug }));
  return extra.length ? [...profileModels, ...extra] : profileModels;
}

/** Catalogue with the discovered models substituted, WITHOUT side effects: it is
 *  the view the resolutions read (`catalogBackend`, `catalogClaimsModel`,
 *  `backendIdForModel`), which must stay purely local and synchronous —
 *  they are on the dispatch path. */
function currentBackends(): CatalogBackend[] {
  return staticCatalogEntries().map((b) => {
    // Discovered if it exists, static otherwise: an unreachable endpoint returns the
    // repo's list, never an empty list.
    const found = discoveredModels(b.instanceOf ?? b.id);
    const preferences = modelPreferences(b.instanceOf ?? b.id);
    // For a CLI that lists the account's models itself (Codex), merge the slugs from the
    // account's cache that the frozen profile does not already list. Cache absent → fall
    // back to the profile list. Uses the same set that withReasoning consults.
    // The cache file's mtime guards staleness.
    const cacheSlugs = modelCaches.get(b.instanceOf ?? b.id)?.slugs();
    const base = cacheSlugs ? withCacheSlugs(b.models, cacheSlugs) : b.models;
    const all = mergeModelPreferences(base, found, preferences?.models, preferences?.removed);
    // A provider the user added declares its windows in its own file: every
    // figure there was typed by them.
    const marked = b.custom
      ? all.map((model) => (model.contextWindow ? { ...model, contextWindowDeclared: true } : model))
      : all;
    const models = withReasoning(b, marked.filter((model) => !model.hidden));
    const selected = preferences?.defaultModel === undefined ? b.defaultModel : preferences.defaultModel;
    const defaultModel = selected && models.some((model) => model.slug === selected) ? selected : models[0]?.slug ?? null;
    return { ...b, models, defaultModel };
  });
}

/**
 * Each model with its resolved thinking controls. Provenance comes from where
 * the levels sit: on the profile's own entry they were declared, present only
 * after the merge they came from the agent (discovery), and the levels the
 * endpoint's listing reported (`reportedReasoningLevels`) count as the agent's. The catalogue answers
 * for custom providers only — a first-party CLI's list is the vendor's own.
 *
 * The Codex account is the exception to "declared wins": its levels in
 * its profile are a frozen fallback, and the CLI's own cache of the account
 * (`models-cache.js` of the `provider-codex` plugin) replaces them for every model it lists — in
 * `supportedReasoningLevels` too, since that is what the agent editor offers
 * and the dialect sends.
 */
function withReasoning(b: CatalogBackend, models: CatalogModel[]): CatalogModel[] {
  const declared = new Map(b.models.map((model) => [model.slug, model.supportedReasoningLevels]));
  const declaredControls = new Map(b.models.map((model) => [model.slug, model.reasoningControl]));
  const catalog = b.custom ? { baseUrl: baseUrls.get(b.id) ?? null } : undefined;
  const account = modelCaches.get(b.id)?.levels() ?? null;
  return models.map((model) => {
    const accountLevels = account?.get(model.slug);
    const declaredLevels = accountLevels ? undefined : declared.get(model.slug);
    // A profile's empty list is still the profile's own (discovery never fills
    // over it), not something the agent reported.
    const discovered = declaredLevels === undefined ? model.supportedReasoningLevels : undefined;
    const reasoning = resolveModelReasoning({
      slug: model.slug,
      declaredLevels,
      declaredControl: accountLevels ? undefined : declaredControls.get(model.slug),
      agentLevels: accountLevels ?? (declaredLevels?.length ? undefined : discovered ?? model.reportedReasoningLevels),
      ...(catalog ? { catalog } : {}),
    });
    // Whatever a profile wrote in this output field is not a source.
    const { reasoning: _written, ...rest } = model;
    const levels = accountLevels ? { supportedReasoningLevels: [...accountLevels] } : {};
    return reasoning ? { ...rest, ...levels, reasoning } : { ...rest, ...levels };
  });
}

/**
 * View derived from the profiles alone, before any discovery. Memoised rather than
 * constant: the registry lives (a provider plugin installs hot), so
 * the view is thrown away when it moves, not recomputed on each read — it is
 * on the dispatch path.
 */
let staticCatalog: CatalogBackend[] | null = null;
let staticCatalogSource: ReturnType<typeof activeProfiles> | null = null;
/** Base URL of each custom profile, kept beside the static view rather than in
 *  it: `CatalogBackend` is served as is to the UI, and an address has no
 *  business there. */
let baseUrls = new Map<string, string | null>();
/** Profiles that run a product CLI's own account — its dialect with no provider
 *  block (Codex lists its models in a cache of its own). A custom
 *  `openai-responses` provider speaks the same dialect but has nothing to do
 *  with the account's model cache. */
let modelCaches = new Map<string, ProviderModelCache>();

function staticCatalogEntries(): CatalogBackend[] {
  // Keyed on the identity of the registry's answer: visibility is re-evaluated
  // on every read there, and the array only changes when something moved.
  const source = activeProfiles();
  if (staticCatalog && staticCatalogSource === source) return staticCatalog;
  staticCatalogSource = source;
  baseUrls = new Map(source.filter(({ profile }) => profile.custom).map(({ profile }) => [profile.id, profileBaseUrl(profile)]));
  modelCaches = new Map(source.flatMap(({ profile }) => {
    const cache = !profile.custom && !profile.providerConfig
      ? dialectDeclarations(profile.dialect)?.modelCache
      : undefined;
    return cache ? [[profile.id, cache] as const] : [];
  }));
  staticCatalog = source.map(({ profile, dialect, account }): CatalogBackend => ({
    id: profile.id,
    ...(account ? { instanceOf: account.backend, account: { id: account.id, name: account.name } } : {}),
    label: profile.label,
    models: profile.models,
    defaultModel: profile.defaultModel,
    permissionModel: dialect.permissionModel,
    rateLimitReporting: dialect.rateLimitReporting,
    sessionResumable: dialect.sessionResumable,
    capabilities: resolveCapabilities(dialect, profile),
    ...(dialect.nativeCompact ? { nativeCompact: true } : {}),
    // `custom` = profile redirected to a third-party endpoint: the dialect's probe
    // may exist, but it measures the first-party account (see
    // `claudeDialect.accountUsage`, which returns null in that case). So it is announced
    // as absent instead of promising a gauge that will stay empty.
    accountUsage: !!dialect.accountUsage && !profile.custom,
    ...(dialect.permissionsByAgent?.(profile.id) ? { selfManagedPermissions: true } : {}),
    ...(dialect.appliesPermissionMode ? { permissionModeApplied: true } : {}),
    ...(dialect.supportedPermissionModes ? { supportedPermissionModes: [...dialect.supportedPermissionModes] } : {}),
    ...(isRemoteDialect(dialect) ? { remote: true } : {}),
    ...(profile.custom && dialect.thinkingControls ? { thinkingControls: [...dialect.thinkingControls] } : {}),
    ...(profile.vendor ? { vendor: profile.vendor } : {}),
    ...(profile.brand ? { brand: profile.brand } : {}),
    ...((profile.icon ?? providerBrandIcon(profile)) ? { icon: (profile.icon ?? providerBrandIcon(profile))! } : {}),
    ...(profile.custom ? { custom: true } : {}),
    ...(profile.subscription ? { subscription: profile.subscription } : {}),
    ...(profile.slugPrefixes ? { slugPrefixes: profile.slugPrefixes } : {}),
    ...unverifiedOf(profile.dialect),
    ...productHints(profile.id),
  }));
  return staticCatalog;
}

/** What the provider of `dialect` marked as unverified, copied: the catalogue is served as is. */
function unverifiedOf(dialect: string): Pick<CatalogBackend, 'unverified'> {
  const claims = dialectDeclarations(dialect)?.unverified;
  return claims?.length ? { unverified: claims.map(({ subject, note }) => ({ subject, note })) } : {};
}

/** What the product's own providers add for the screens (`builtin-declarations.ts`); an account instance reads its backend's. */
function productHints(id: string): Pick<CatalogBackend, 'signInCommand' | 'signInThen'> {
  const declared = BUILTIN_DECLARATIONS[baseBackendId(id)];
  return {
    ...(declared?.signInCommand ? { signInCommand: declared.signInCommand } : {}),
    ...(declared?.signInThen ? { signInThen: declared.signInThen } : {}),
  };
}

/**
 * C9 — the logo a provider declared, as a data URL. The SVG was checked at
 * registration (`brandProblems`: no script, no handler, no external reference) and
 * is shown through an image, where a script would not run anyway. A choice of the
 * user (`profile.icon`) always wins over it.
 */
function providerBrandIcon(profile: BackendProfile): string | undefined {
  const svg = dialectDeclarations(profile.dialect)?.brand?.svg;
  return svg ? `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}` : undefined;
}

/** Catalogue entry for `id`, or undefined. */
export function catalogBackend(id: string | null | undefined): CatalogBackend | undefined {
  if (!id) return undefined;
  return currentBackends().find((b) => b.id === id);
}

/**
 * The permission mode an agent asking for `mode` really runs in on `backend`:
 * on a provider that declares the only modes it honours
 * (`PermissionStrategy.supportedModes`), any other mode is `plan`
 * (`resolveSupportedPermissionMode`). Untouched on a backend that honours
 * every mode, and on one the catalogue does not know.
 */
export function resolvedPermissionModeFor(backend: string | null | undefined, mode: string | null | undefined): string | undefined {
  return resolveSupportedPermissionMode(mode, catalogBackend(backend)?.supportedPermissionModes);
}

/**
 * Backend that serves `model`, or null if nobody claims it.
 *
 * Resolution in two steps, both explicit:
 *   1. EXACT lookup of the slug in the catalogue;
 *   2. failing that, a literal prefix declared by a backend (`slugPrefixes`),
 *      to cover the full versioned IDs missing from the catalogue.
 *
 * Documented fallback: a slug that neither step resolves returns
 * `null`, that is "unknown model, let it through as is". The
 * dispatcher then triggers no guard and the target CLI decides.
 * Intended consequence: adding a provider whose models are not catalogued
 * yet degrades into "no check", never into "attributed to the
 * wrong backend".
 */
/**
 * Does `backendId` itself serve `model`?
 *
 * An indispensable complement of `backendIdForModel` since several profiles
 * may serve the SAME model: aggregator providers (Ollama Cloud…)
 * expose open weights their publisher also serves directly. The lookup
 * returns a single winner, which would wrongly conclude "incompatible
 * model" for the other backend that does serve it. The dispatcher's
 * anti-mismatch guard must therefore query THIS predicate, not compare
 * names for equality.
 */
export function catalogClaimsModel(
  backendId: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (!backendId || !model) return false;
  const b = catalogBackend(backendId);
  if (!b) return false;
  if (modelIsHidden(backendId, model)) return false;
  if (b.models.some((m) => m.slug === model)) return true;
  return !!b.slugPrefixes?.some((p) => model.startsWith(p));
}

export function backendIdForModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const backends = currentBackends();
  for (const b of backends) {
    if (b.models.some((m) => m.slug === model)) return b.id;
  }
  for (const b of backends) {
    if (modelIsHidden(b.id, model)) continue;
    if (b.slugPrefixes?.some((p) => model.startsWith(p))) return b.id;
  }
  return null;
}

function modelIsHidden(id: string, slug: string): boolean {
  const local = modelPreferences(id)?.models.find((entry) => entry.slug === slug);
  if (local) return !!local.hidden;
  return !!activeProfiles().find((entry) => entry.profile.id === id)?.profile.models.find((entry) => entry.slug === slug)?.hidden;
}
