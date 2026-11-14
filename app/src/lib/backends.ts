/**
 * UI access to the catalogue of LLM backends + models.
 *
 * The list itself is no longer written here: it lives in
 * `orchestrator/src/backends/catalog.ts` and arrives at runtime through
 * `GET /api/ui/backends/catalog`. Adding a model there makes it appear in the
 * menus without an app rebuild, and makes it resolvable by the dispatcher —
 * one edit, one truth.
 *
 * This module therefore only exposes: the types, the loading hook, and the
 * display derivations (menus per backend, presets, default model).
 *
 * The `slug` values are passed as is to the `--model` flag of the matching
 * CLI → they are names the CLI recognises.
 */
'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { onAccountChange } from './account-change';
import { catalogTargetQuery, type CatalogTarget } from './catalog-target';
import { t } from './i18n';
import { settingsPath } from './settings-path';
import { sseOn } from './sse-stream';

/** Backend name. Deliberately open (`string`): the registry on the
 *  orchestrator side is the source of truth, not a union frozen here. */
export type BackendName = string;

export type CatalogModel = {
  slug: string;
  addedAt?: number;
  label: string;
  /** Absent when the value is not known from a reliable source — never
   *  substitute a default, degrade the display instead. */
  contextWindow?: number;
  /** `contextWindow` was typed by the user (Settings → AI models → Providers): it wins
   *  over the window the runtime reports (`contextLimitFor`). */
  contextWindowDeclared?: boolean;
  presetLabel?: string;
  presetRank?: number;

  /** Supported reasoning levels (e.g. ["low", "medium", "high", "xhigh"]).
   *  Absent = no reasoning choice for this model. */
  supportedReasoningLevels?: string[];
  /** How the model's thinking is set and where that comes from. Mirror of
   *  `ModelReasoning` (`orchestrator/src/backends/reasoning.ts`); read through
   *  `thinkingBarFor`, never directly by a selector. */
  reasoning?: ModelReasoning;

  /** Brand of the MODEL when it differs from the vendor's. When declared, it
   *  wins over `BrandMark`'s guess from the slug. */
  brand?: string;
  /** Icon picked by the user: an emoji, or an image served by our own upload
   *  route. Wins over everything else. */
  icon?: string;
};

/** One way of setting a model's thinking (mirror of `ReasoningControl`). */
export type ReasoningControl =
  | { type: 'levels'; values: string[] }
  | { type: 'budget'; min?: number; max?: number }
  | { type: 'toggle' };

/** A budget, a switch or "does not think", declared by hand on a custom
 *  provider's model (mirror of `DeclaredReasoningControl`). */
export type DeclaredReasoningControl =
  | { type: 'budget'; min?: number; max?: number }
  | { type: 'toggle' }
  | { type: 'none' };

export type ModelReasoning = {
  source: 'declared' | 'agent' | 'catalog';
  thinks: boolean;
  controls: ReasoningControl[];
  catalogEntry?: string;
};

/** How a backend's CLI arbitrates tool uses. Exact mirror of
 *  `PermissionModel` on the orchestrator side (`backends/types.ts`). */
export type PermissionModel = 'mcp-bridge' | 'sandbox' | 'protocol' | 'none';

/** What a backend declared it can do. Mirror of `BackendCapabilities` on the
 *  orchestrator side (`backends/types.ts`): `worktree` = it works in Timon's
 *  folder, `timonMcp` = Timon's tools can be handed to it, `attachments` =
 *  files other than images can be joined to a turn. The daemon also declares
 *  `timonPreamble` (what its system prompt starts with): not a limit a user
 *  can act on, so it is not mirrored. */
export type BackendCapabilities = { worktree: boolean; timonMcp: boolean; attachments: boolean };
/** Subjects a provider may mark as not checked on the real program (daemon: `UNVERIFIED_SUBJECTS`). */
export type UnverifiedSubject =
  | 'session' | 'mcp' | 'permissions' | 'sign-in' | 'models' | 'extension-requests' | 'credential-dirs' | 'binary-identity';

export type BackendCapability = keyof BackendCapabilities;

/** The behaviour of every backend that declares nothing. */
export const DEFAULT_BACKEND_CAPABILITIES: BackendCapabilities = Object.freeze({
  worktree: true, timonMcp: true, attachments: true,
});

export type CatalogBackend = {
  id: BackendName;
  label: string;
  /** Name of the PROVIDER ("Anthropic", "xAI"…), shown in the left column of
   *  the LLM selector. Distinct from `label`, which names the product or the
   *  CLI. Absent → fall back on `label`. */
  vendor?: string;
  /** Logo key, resolved to an SVG component by `brand-icons.tsx`. An unknown
   *  key must degrade to a dot, never break the rendering. */
  brand?: string;
  /** Icon picked by the user for this vendor (emoji or image from our upload
   *  route). Also the fallback for the models that have none — the case of a
   *  backend added by hand. */
  icon?: string;
  models: CatalogModel[];
  defaultModel: string | null;
  custom?: boolean;
  slugPrefixes?: string[];
  /* ── Capabilities reported by the orchestrator ──────────────────────────
     Every UI adaptation to a backend goes through these fields. Comparing
     `backend.id` to a literal name is a bug in waiting: the registry is open,
     a third-party profile can reuse the same CLI (and so the same
     capabilities) under another id. */
  permissionModel?: PermissionModel;
  /** The agent behind this backend decides its tool uses by itself (opencode
   *  refuses a write outside its cwd without asking anybody). Declared per
   *  PROFILE, never inferred from `permissionModel`: two agents can share a
   *  dialect, hence the same model, and only one of them ever asks. Absent →
   *  no claim, no badge. */
  selfManagedPermissions?: boolean;
  /** The provider applies the agent's permission mode itself before it asks
   *  (Pi): the editor says the mode holds. Absent → no claim. */
  permissionModeApplied?: boolean;
  /** The only permission modes the provider honours: the selectors offer only
   *  these, and the daemon runs any other in `plan`. Absent → every mode. */
  supportedPermissionModes?: string[];
  rateLimitReporting?: 'structured' | 'textual' | 'none';
  /** Can the backend report the account's usage? */
  accountUsage?: boolean;
  /** Does the session survive the death of its process? Decides whether
   *  cutting a turn (STOP button) leaves the conversation resumable or stops it
   *  for good. Absent (catalogue not loaded yet) → treated as not resumable:
   *  better to warn wrongly than to promise an impossible resume. */
  sessionResumable?: boolean;
  /** The backend compacts its own session (`/compact`): compaction keeps the
   *  conversation instead of forking it. Absent → it forks. */
  nativeCompact?: boolean;
  /** Resolved capabilities (always sent by a daemon of contract 7 or later).
   *  Absent → read as all true: an older daemon predates the field, and its
   *  backends could all do everything. */
  capabilities?: BackendCapabilities;
  /** Billing/auth wording specific to the provider, DECLARED by the profile.
   *  It is what avoids an `if (backend === 'x')` to tell the user how this
   *  backend is paid. Absent → the UI shows nothing. */
  subscription?: { note: string; planMaxToggle?: boolean };
  /** Kinds of thinking control the dialect can send for this custom provider.
   *  Absent = levels only. */
  thinkingControls?: ReasoningControl['type'][];
  /** What a person types in a terminal to sign in to this provider's CLI. Absent
   *  for a provider that did not declare one. */
  signInCommand?: string;
  /** What to do once that command runs, when the CLI does not sign in by itself. */
  signInThen?: string;
  /** What the provider says it has not seen work on the real program
   *  (`declares.unverified`). Absent → no claim, no chip. */
  unverified?: { subject: UnverifiedSubject; note: string }[];
  /** Set on a subscription account instance (`claude@<id>`, TODO #52): the
   *  backend it belongs to. Its models are its backend's. */
  instanceOf?: BackendName;
  /** The account behind the instance. The daemon only lists the accounts on
   *  the caller's access list. */
  account?: { id: string; name: string; state?: AccountState };
  /** The host's own sign-in to this provider: `false` only when the daemon KNOWS
   *  it is signed out (CLI installed, signed in to nobody). Still pickable. */
  signedIn?: boolean | null;
};

/** Mirror of `AccountState` (`plugins-bundled/backends/account-routes.ts`). */
export type AccountState = 'active' | 'cooldown' | 'reauth';

export type BackendCatalog = {
  backends: CatalogBackend[];
  defaultBackend: BackendName;
  /** Model-name fragments that tell the providers' models apart where several providers'
   *  are listed together (an aggregator serving `kimi-…`), served whether or not the
   *  provider is active here. First match wins. */
  modelBrands?: ReadonlyArray<{ match: string; brand: string }>;
};

/** Before the catalogue is loaded no backend is known, so none is assumed: the
 *  default is the one the daemon names (`tryDefaultBackendName`). */
const EMPTY_CATALOG: BackendCatalog = { backends: [], defaultBackend: '' };

/* ── Loading (module cache, one request per tab and per target) ── */

/** The store's key for the whole inventory; a target's key is its query string. */
const INVENTORY = '';

const cached = new Map<string, { cat: BackendCatalog; at: number }>();
const inflight = new Map<string, Promise<BackendCatalog>>();
/** Bumped by every invalidation: a response that left before it describes a
 *  catalogue (or an account) that is gone, and must not become the cache. */
let generation = 0;
/** Every mounted `useBackendCatalog`, per target: one fetch feeds them all. */
const subscribers = new Map<string, Set<(cat: BackendCatalog) => void>>();
let stopSse: (() => void) | null = null;

/** An account's state (signed out, out of quota) changes without any
 *  `backends_changed` event: past this age, a selector that mounts or opens
 *  reads the catalogue again, so a dead account is not offered on a stale
 *  state. */
const ACCOUNT_STATE_TTL_MS = 30_000;

async function fetchCatalog(key: string = INVENTORY): Promise<BackendCatalog> {
  const held = cached.get(key);
  if (held) return held.cat;
  const running = inflight.get(key);
  if (running) return running;
  const started = generation;
  const raw = fetch(`/api/ui/backends/catalog${key ? `?${key}` : ''}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((j: Partial<BackendCatalog>) => {
      const cat: BackendCatalog = {
        backends: Array.isArray(j.backends) ? j.backends : [],
        defaultBackend: j.defaultBackend || '',
        ...(Array.isArray(j.modelBrands) ? { modelBrands: j.modelBrands } : {}),
      };
      if (started === generation) {
        cached.set(key, { cat, at: Date.now() });
        for (const subscriber of subscribers.get(key) ?? []) subscriber(cat);
      }
      return cat;
    })
    .catch(() => EMPTY_CATALOG)
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  // Outdated on arrival (another user signed in, the registry changed):
  // its callers get the current catalogue instead.
  const request: Promise<BackendCatalog> = raw.then((cat) => (started === generation ? cat : fetchCatalog(key)));
  inflight.set(key, request);
  return request;
}

/**
 * Drops the cache: the daemon announced `backends_changed` (a provider plugin
 * installed, enabled or unloaded, §10.15). Without it the menus would keep the
 * startup list — a backend gone would stay selectable, a new backend would
 * stay invisible until reload.
 */
export function invalidateBackendCatalog(): void {
  cached.clear();
  inflight.clear();
  generation += 1;
}

/** Invalidate, then read once for every mounted selector, target by target. */
export function refreshBackendCatalog(): void {
  invalidateBackendCatalog();
  for (const key of subscribers.keys()) void fetchCatalog(key);
}

/** Read again when a cached catalogue is older than the account-state TTL.
 *  Called when a selector mounts, and when a long-mounted one opens. A target
 *  nobody reads any more is only forgotten, which also keeps the cache to the
 *  few projects on screen. */
export function refreshBackendCatalogIfStale(now = Date.now()): void {
  let stale = false;
  for (const [key, entry] of cached) {
    if (now - entry.at <= ACCOUNT_STATE_TTL_MS) continue;
    if (subscribers.has(key)) stale = true;
    else cached.delete(key);
  }
  if (stale) refreshBackendCatalog();
}

/**
 * Follow the catalogue of a target (by default the inventory): `listener`
 * receives every new one. The first subscriber opens the single
 * `backends_changed` subscription of the tab, the last one closes it — one
 * event, one request per target, whatever the number of selectors on screen.
 */
export function subscribeBackendCatalog(
  listener: (cat: BackendCatalog) => void,
  target?: CatalogTarget | null,
): () => void {
  return subscribeKey(catalogTargetQuery(target), listener);
}

function subscribeKey(key: string, listener: (cat: BackendCatalog) => void): () => void {
  const listeners = subscribers.get(key) ?? new Set();
  subscribers.set(key, listeners);
  listeners.add(listener);
  if (!stopSse) stopSse = sseOn('backends_changed', () => refreshBackendCatalog());
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && subscribers.get(key) === listeners) subscribers.delete(key);
    if (subscribers.size === 0 && stopSse) {
      stopSse();
      stopSse = null;
    }
  };
}

// The catalogue lists the account instances of the SIGNED-IN user: another
// user in the same tab must not be offered the previous one's accounts.
onAccountChange(() => refreshBackendCatalog());

/** The target of the ModelPicker this component is painted in, so that the
 *  `useBackendCatalog()` of an occupant (a plugin's too) reads what its host offers. */
const CatalogTargetContext = createContext<CatalogTarget | null>(null);

export const CatalogTargetProvider = CatalogTargetContext.Provider;

/**
 * Current catalogue. Returns `{backends: []}` on the first paint, then fills
 * up — every consumer must tolerate an empty list (it is also the legitimate
 * case of a custom provider profile without known models).
 *
 * `target` names the mission the list is for; `null` asks for the whole
 * inventory; absent, the picker around this component decides. A target not
 * read yet is empty, hence `catalogPending`, never the inventory for an
 * instant: a backend must not be offered and then taken away.
 */
export function useBackendCatalog(target?: CatalogTarget | null): BackendCatalog {
  const fromHost = useContext(CatalogTargetContext);
  const key = catalogTargetQuery(target === undefined ? fromHost : target);
  const [held, setHeld] = useState(() => ({ key, cat: cached.get(key)?.cat ?? EMPTY_CATALOG }));
  useEffect(() => {
    let alive = true;
    const show = (cat: BackendCatalog) => {
      if (alive) setHeld((prev) => (prev.key === key && prev.cat === cat ? prev : { key, cat }));
    };
    const unsubscribe = subscribeKey(key, show);
    refreshBackendCatalogIfStale();
    const now = cached.get(key);
    if (now) show(now.cat);
    else void fetchCatalog(key).then(show);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [key]);
  return held.key === key ? held.cat : cached.get(key)?.cat ?? EMPTY_CATALOG;
}

/* ── Display derivations ────────────────────────────────────────────────── */

/* ── Subscription account instances (TODO #52) ───────────────────────── */

/** `claude@<id>`: the daemon's instance id. `@` never appears in a backend id. */
export function isAccountInstance(id: BackendName | null | undefined): boolean {
  return !!id && id.includes('@');
}

/** Why this entry cannot be picked right now, or null. An account to sign in
 *  again, or out of quota, is shown but never offered: a mission sent to it
 *  would fail, and Timon never moves it to another subscription on its own. */
export function accountUnavailable(b: CatalogBackend | null | undefined): 'reauth' | 'cooldown' | null {
  const state = b?.account?.state;
  return state === 'reauth' || state === 'cooldown' ? state : null;
}

export function isPickable(b: CatalogBackend | null | undefined): boolean {
  return accountUnavailable(b) === null;
}

/** Short state word for a badge, or null when the entry can be picked. */
export function accountStateLabel(b: CatalogBackend | null | undefined): string | null {
  const reason = entryWarning(b);
  return reason ? t(`llm.account.${reason}`) : null;
}

/** Sentence explaining why an entry is not offered (a `title`, a hint). */
export function accountStateHint(b: CatalogBackend | null | undefined): string | null {
  const reason = entryWarning(b);
  return reason ? t(`llm.account.${reason}Hint`, { settingsPath: settingsPath('models') }) : null;
}

/** What a badge warns about: an account that cannot run, or a provider nobody signed in to. */
function entryWarning(b: CatalogBackend | null | undefined): 'reauth' | 'cooldown' | 'signedOut' | null {
  return accountUnavailable(b) ?? (b?.signedIn === false ? 'signedOut' : null);
}

/** The vendor column of a selector: the company, then the account it bills,
 *  so that two Anthropic entries never read the same. */
export function vendorLabel(b: CatalogBackend): string {
  const vendor = b.vendor ?? b.label;
  return b.account ? `${vendor} · ${b.account.name}` : vendor;
}

/**
 * No backend known yet: the catalogue has not answered (or could not be read).
 * Nothing is missing then — a stored account is not "unavailable", a slug is
 * not "typed by hand" — and every screen shows the value as it is held. The
 * ModelPicker (`orphanOf`, its rows) and `backendLabel` both follow this one
 * rule, so no surface greys a stored account for the instant the catalogue
 * takes to arrive.
 */
export function catalogPending(cat: BackendCatalog): boolean {
  return cat.backends.length === 0;
}

/** Compacting `id` keeps the conversation (native) rather than forking it.
 *  An account instance compacts as its backend does. */
export function nativeCompactFor(cat: BackendCatalog, id: BackendName): boolean {
  const entry = cat.backends.find((b) => b.id === id);
  if (entry?.nativeCompact) return true;
  const parent = entry?.instanceOf ?? (isAccountInstance(id) ? id.split('@')[0] : null);
  return !!parent && !!cat.backends.find((b) => b.id === parent)?.nativeCompact;
}

/**
 * Display name of a backend id, catalogued or not. An account instance the
 * catalogue no longer lists (deleted, or taken away from this user) reads as
 * an unavailable account of its backend — never as a raw id, never as another
 * account. While the catalogue loads it reads as its backend, unjudged.
 */
export function backendLabel(cat: BackendCatalog, id: BackendName): string {
  const entry = cat.backends.find((b) => b.id === id);
  if (entry) return entry.label;
  if (!isAccountInstance(id)) return id;
  const base = id.slice(0, id.indexOf('@'));
  if (catalogPending(cat)) return base;
  const baseLabel = cat.backends.find((b) => b.id === base)?.label ?? base;
  return `${baseLabel} · ${t('llm.account.unavailable')}`;
}

/**
 * Short name of a backend id for a compact chip (TODO #454): an account
 * instance reads as the name its owner gave it (Settings → accounts), so a
 * card never shows `claude@1oikjpok09`. Anything else — a plain backend, an
 * account the catalogue does not list, a catalogue still loading — keeps its id.
 */
export function backendShortName(cat: BackendCatalog, id: BackendName): string {
  return cat.backends.find((b) => b.id === id)?.account?.name || id;
}

/** "Model" menu of a backend. Empty list when the backend is unknown or
 *  announces no model — the caller then shows a free field. */
export function modelsFor(cat: BackendCatalog, backend: BackendName): CatalogModel[] {
  return cat.backends.find((b) => b.id === backend)?.models ?? [];
}

/** Model preselected on a backend switch, or '' when none is known. */
export function defaultModelFor(cat: BackendCatalog, backend: BackendName): string {
  return cat.backends.find((b) => b.id === backend)?.defaultModel ?? '';
}

/** Label of a slug (menu), or the raw slug when it is not catalogued. */
export function modelLabel(cat: BackendCatalog, backend: BackendName, slug: string): string {
  return modelsFor(cat, backend).find((m) => m.slug === slug)?.label ?? slug;
}

/**
 * Thinking levels of a model, for ALL the selectors (agent editor, composer,
 * LLM menu and dialog, workflow node): a single lookup, so that they do not
 * diverge.
 *
 * The catalogue's exact slug decides first. A versioned slug the catalogue
 * does not list (`claude-opus-5-5`, forced by hand instead of the `opus`
 * alias) is still claimed by the backend through its `slugPrefixes`: it then
 * takes the levels of its family (the slug token that names a catalogue
 * model), failing that the ones ALL the backend's models share. A slug no
 * prefix claims, or a model without levels, gets no slider: better no slider
 * than values the CLI would refuse.
 */
export function reasoningLevelsFor(cat: BackendCatalog, backend: BackendName, model: string): string[] {
  const b = cat.backends.find((item) => item.id === backend);
  if (!b || !model) return [];
  const own = b.models.find((m) => m.slug === model)?.supportedReasoningLevels;
  if (own) return own;
  if (!b.slugPrefixes?.some((prefix) => model.startsWith(prefix))) return [];
  const withLevels = b.models.filter((m) => m.slug !== model && m.supportedReasoningLevels?.length);
  const tokens = model.split('-');
  const family = withLevels.filter((m) => tokens.includes(m.slug));
  const pool = family.length > 0 ? family : withLevels;
  const [first, ...rest] = pool.map((m) => m.supportedReasoningLevels ?? []);
  if (!first) return [];
  return first.filter((level) => rest.every((levels) => levels.includes(level)));
}

/** The window the user typed for this model, or `undefined`. */
export function declaredContextWindowFor(
  cat: BackendCatalog,
  backend: BackendName,
  slug: string,
): number | undefined {
  const model = modelsFor(cat, backend).find((m) => m.slug === slug);
  return model?.contextWindowDeclared ? model.contextWindow : undefined;
}

/** Context window of a model, or `undefined` when not known from a reliable
 *  source. Never replace with a default on the caller's side. */
export function contextWindowFor(
  cat: BackendCatalog,
  backend: BackendName,
  slug: string,
): number | undefined {
  return modelsFor(cat, backend).find((m) => m.slug === slug)?.contextWindow;
}

/** Flattened `{backend, model, label}` presets for the button grids (new
 *  mission / fork / compact). Derived from the catalogue: a model is one of
 *  them when it carries a `presetLabel`, the order comes from `presetRank`. */
export function presetsOf(
  cat: BackendCatalog,
): { backend: BackendName; model: string; label: string }[] {
  return cat.backends
    .flatMap((b) =>
      b.models
        .filter((m) => m.presetLabel)
        .map((m) => ({
          backend: b.id,
          model: m.slug,
          label: m.presetLabel as string,
          rank: m.presetRank ?? Number.MAX_SAFE_INTEGER,
        })),
    )
    .sort((a, b) => a.rank - b.rank)
    .map(({ backend, model, label }) => ({ backend, model, label }));
}

/**
 * Permission model of a backend, or `null` while the catalogue is not loaded /
 * when the backend is unknown. The caller must tolerate this `null` by showing
 * NO wording about permissions — better to say nothing than to describe the
 * wrong mechanism.
 */
export function permissionModelFor(
  cat: BackendCatalog,
  backend: BackendName,
): PermissionModel | null {
  return cat.backends.find((b) => b.id === backend)?.permissionModel ?? null;
}

/**
 * The only permission modes `backend` honours, or null when it honours every
 * mode (or the catalogue is not loaded yet: nothing is hidden on a guess).
 */
export function supportedPermissionModesFor(cat: BackendCatalog, backend: BackendName | null | undefined): readonly string[] | null {
  if (!backend) return null;
  return cat.backends.find((b) => b.id === backend)?.supportedPermissionModes ?? null;
}

/** The sandbox names, as the mode they mean (the daemon's `canonicalPermissionMode`). */
const SANDBOX_MODE_NAMES: Readonly<Record<string, string>> = {
  'read-only': 'plan',
  'workspace-write': 'auto',
  'danger-full-access': 'bypassPermissions',
};

/**
 * The mode an agent asking for `mode` really runs in, as the daemon resolves it
 * (`resolveSupportedPermissionMode`): on a backend with a list, any mode outside
 * it runs in `plan`. Null when it runs as asked — nothing to tell the person.
 */
export function unsupportedModeRunsAs(supported: readonly string[] | null, mode: string | null | undefined): 'plan' | null {
  if (!supported) return null;
  const named = (mode && SANDBOX_MODE_NAMES[mode]) ?? mode;
  return named && supported.includes(named) ? null : 'plan';
}

/** Does the agent decide its permissions on its own? False while the
 *  catalogue is not loaded and for an unknown backend: a badge is only shown
 *  on an explicit declaration of the profile. */
export function managesOwnPermissions(cat: BackendCatalog, backend: BackendName): boolean {
  return cat.backends.find((b) => b.id === backend)?.selfManagedPermissions === true;
}

/**
 * The i18n key of the line the agent editor shows above the permission mode,
 * or null while the catalogue loads (a mechanism described at random is worse
 * than none). A `protocol` backend that applies the mode itself (Pi's gate)
 * gets its own line: the generic one says the agent's own rules decide.
 */
export function permissionHintKey(cat: BackendCatalog, backend: BackendName): string | null {
  switch (permissionModelFor(cat, backend)) {
    case 'mcp-bridge':
      return 'editPage.permissionHintMcpBridge';
    case 'sandbox':
      return 'editPage.permissionHintSandbox';
    case 'protocol':
      return cat.backends.find((b) => b.id === backend)?.permissionModeApplied === true
        ? 'editPage.permissionHintProtocolMode'
        : 'editPage.permissionHintProtocol';
    case 'none':
      return 'editPage.permissionHintNone';
    default:
      return null;
  }
}

/** Can an agent of this backend read a skill's body when it wants to? Mirror of
 *  the daemon's function of the same name (`backends/capabilities.ts`): with
 *  neither Timon's tools nor Timon's disk, the spawn pastes the body. */
export function canReadSkillOnDemand(caps: Pick<BackendCapabilities, 'timonMcp' | 'attachments'>): boolean {
  return caps.timonMcp || caps.attachments;
}

/** What `backend` can do. All true while the catalogue loads or when the
 *  daemon did not say: a button must never flash disabled on first paint. */
export function capabilitiesFor(cat: BackendCatalog, backend: BackendName): BackendCapabilities {
  return cat.backends.find((b) => b.id === backend)?.capabilities ?? DEFAULT_BACKEND_CAPABILITIES;
}

/** The capabilities `backend` lacks, in a stable order — what a limits badge
 *  lists. Empty for a backend that can do everything. */
export function backendLimits(cat: BackendCatalog, backend: BackendName): BackendCapability[] {
  const caps = capabilitiesFor(cat, backend);
  return (['worktree', 'timonMcp', 'attachments'] as const).filter((key) => !caps[key]);
}

/** Can the backend report the account's usage? False while the catalogue is
 *  not loaded → no gauge shown meanwhile, rather than an empty gauge that
 *  would read "quota intact". */
export function hasAccountUsage(cat: BackendCatalog, backend: BackendName): boolean {
  return cat.backends.find((b) => b.id === backend)?.accountUsage === true;
}

/** Does cutting a turn on this backend leave the conversation resumable?
 *  False while the catalogue is not loaded, and false for an unknown backend:
 *  STOP then warns that the stop is final, the only harmless default of the
 *  two. */
export function isSessionResumable(cat: BackendCatalog, backend: BackendName): boolean {
  return cat.backends.find((b) => b.id === backend)?.sessionResumable === true;
}

/** Normalises an arbitrary backend value. An empty value falls back on the
 *  daemon's default (empty while the catalogue is not loaded); any other is
 *  kept as is (open registry: it cannot be decided here that an unknown
 *  backend does not exist). */
export function asBackend(v: string | null | undefined): BackendName {
  return v && v.trim() ? v : cached.get(INVENTORY)?.cat.defaultBackend ?? '';
}

/**
 * The backend and model a screen should light up for what an agent or a mission runs on.
 * A backend that is no id of the catalogue but starts like a provider's model names
 * (`claude-opus-…`, stored by older versions) is that provider; a versioned model slug
 * (`claude-opus-5-2`) lights up the alias the catalogue lists (`opus`). Nothing here names a
 * provider: the prefixes are the ones each backend declares (`slugPrefixes`).
 */
export function currentLlm(
  cat: BackendCatalog, backend: string | null | undefined, model: string | null | undefined,
): { backend: BackendName; model: string } {
  const claimedBy = (value: string): { backend: CatalogBackend; prefix: string } | null => {
    for (const b of cat.backends) {
      if (b.instanceOf) continue;
      const prefix = b.slugPrefixes?.find((p) => value.startsWith(p));
      if (prefix) return { backend: b, prefix };
    }
    return null;
  };
  const named = backend && backend.trim() ? backend : cat.defaultBackend;
  const resolved = cat.backends.some((b) => b.id === named) ? named : claimedBy(named)?.backend.id ?? named;
  const slug = model ?? '';
  const owner = claimedBy(slug);
  const alias = owner ? /^[a-z]+/.exec(slug.slice(owner.prefix.length))?.[0] : undefined;
  return { backend: resolved, model: alias ?? slug };
}

/** A server-assigned date, never renewed just because a model was renamed. */
export function isNewModel(model: Pick<CatalogModel, 'addedAt'>, now = Date.now()): boolean {
  return model.addedAt !== undefined && model.addedAt <= now && now - model.addedAt < 7 * 24 * 60 * 60 * 1000;
}
