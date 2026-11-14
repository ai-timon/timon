/**
 * The telemetry of this daemon: one runtime per process, started by the
 * `@timon/telemetry` module and disposed with it.
 *
 * Nothing at all happens without a destination (`telemetryDestination`): no
 * identity drawn, no listener on the bus. With one, every catalogue event is
 * validated, stamped with the global properties and queued; the queue is
 * flushed on a timer. The preference is re-read before each event and on
 * every tick, so a change made anywhere (the settings route, the config file)
 * is seen within a tick. Switching it off drops the queue and stops the wave
 * in flight, sends exactly one `telemetry_preference_changed`, and nothing
 * after; an environment that says no gets no goodbye either.
 */
import { cpus, totalmem } from 'node:os';
import { bus, type BusEvent } from '../../bus.js';
import { config } from '../../config/load.js';
import { dbApi } from '../../db.js';
import { timonVersion, packagedDaemon } from '../../data-version.js';
import { daemonMode, stdoutIsJournal } from '../../system-info.js';
import { licenseState } from '../../license/runtime.js';
import { loadConfig } from '../../agent-config.js';
import { implicitBackendName } from '../../backends/index.js';
import { catalogBackend } from '../../backends/catalog.js';
import { TIMON_HOME } from '../../paths.js';
import { currentGallery } from '../../plugins/runtime.js';
import { onRequestFinished, type FinishedRequest } from '../../kernel/request-observer.js';
import { listAgents } from '../../agent.js';
import { listProjects } from '../../projects.js';
import { listSkills } from '../../skills.js';
import { listMcp } from '../../mcp.js';
import { TelemetryCollector, missionFactsFrom, type CollectorDeps } from './collector.js';
import {
  EVENT_SCHEMA_VERSION, archValue, backendValue, licenseTierValue, platformValue, validateEvent, validateGlobals, versionValue,
  type GlobalProperties, type TelemetryEventName,
} from './events.js';
import { resolvePreference, type PreferenceSources, type TelemetryPreference } from './preference.js';
import { loadTelemetryState, saveTelemetryState, type TelemetryState } from './state.js';
import { TelemetryTransport, telemetryDestination } from './transport.js';
import {
  ACCOUNT_LIMIT_CODES, FEATURE_MILESTONES, apiAreaOf, causeOf, cpuClassOf, featureOf, installAgeOf, pageSectionOf,
  ramClassOf, type Actor, type Milestone,
} from './features.js';

export const FLUSH_INTERVAL_MS = 10_000;
const STATEFUL_KINDS: ReadonlySet<string> = new Set(['plugins_changed', 'license_changed']);
const reportedStarts = new Set<string>();
/** Tests: forget which homes already reported their start in this process. */
export function resetReportedStartsForTests(): void {
  reportedStarts.clear();
}
/** The preference is a database read: a burst of events shares one. */
const PREFERENCE_TTL_MS = 2_000;

export type Surface = GlobalProperties['surface'];

/** Who an event is about, when a person is behind it. */
export type EventContext = { userId?: string | null };

/** What the web app or the desktop shell reports, already validated by the route. */
export type UiEvent =
  | { name: 'app_opened'; surface: 'web' | 'desktop'; setupCompleted: boolean; loadMs?: number }
  | { name: 'ui_error'; surface: 'web' | 'desktop'; path: string }
  | { name: 'page_viewed'; surface: 'web' | 'desktop'; path: string }
  | { name: 'upgrade_action'; surface: 'web' | 'desktop'; action: 'plans_viewed' | 'buy_opened'; entryPoint: 'license_page' | 'users' | 'settings' | 'banner' | 'other' };

const ACTOR_OF: Record<FinishedRequest['actor'], Actor> = { person: 'person', mission: 'agent', daemon: 'cli', other: 'other' };

export type TelemetryOptions = {
  env?: NodeJS.ProcessEnv;
  packaged?: boolean;
  home?: string;
  fetch?: typeof fetch;
  intervalMs?: number;
  preference?: PreferenceSources;
  now?: () => number;
  /** Tests: deps of the collector; the database by default. */
  collector?: Partial<CollectorDeps>;
};

export type TelemetryRuntime = {
  readonly active: boolean;
  track(name: TelemetryEventName, props: Record<string, unknown>, surface?: Surface, context?: EventContext): void;
  /** An event of the web app or the desktop shell, for the person `context` names. */
  trackUi(event: UiEvent, context: EventContext): void;
  /** Re-reads the preference now (after a write) and acts on a change. */
  refreshPreference(): TelemetryPreference;
  preference(): TelemetryPreference;
  /** Sends what is queued and waits for it. Never rejects. */
  flushNow(): Promise<void>;
  dispose(): Promise<void>;
};

/** Is `model` one the product's catalogue lists for `backend`, not one a person added? */
export function isCatalogModel(backend: string, model: string): boolean {
  const entry = catalogBackend(backend);
  if (!entry || entry.custom) return false;
  return entry.models.some((m) => m.slug === model && m.addedAt === undefined && !m.hidden);
}

function databaseDeps(): Pick<CollectorDeps, 'missionFacts' | 'taskFacts'> {
  return {
    missionFacts(missionId) {
      const row = dbApi.getMission(missionId);
      if (!row) return null;
      let backend: string | null = row.backend_override;
      let model: string | null = row.model_override;
      try {
        const cfg = loadConfig(row.agent_name);
        backend ??= cfg.backend ?? null;
        model ??= cfg.model ?? null;
      } catch { /* agent gone: what the row says is all there is */ }
      if (!backend) { try { backend = implicitBackendName(); } catch { backend = null; } }
      return missionFactsFrom(row, backend, model, isCatalogModel);
    },
    taskFacts(taskId) {
      const row = dbApi.getTask(taskId);
      return row ? {
        type: row.type, pipeline: row.pipeline, status: row.status,
        createdAt: row.created_at, doneComment: row.done_comment, merged: Boolean(row.merged_commit_sha),
      } : null;
    },
  };
}

function appMode(): 'host' | 'docker' {
  // The daemon always runs on the host (HOST_MODE.md); what varies is who serves
  // the web app: the daemon itself (`app.enabled`), or a container beside it.
  try { return config().app.enabled ? 'host' : 'docker'; } catch { return 'host'; }
}

function edition(): 'expert' | 'lite' {
  try { return config().edition; } catch { return 'expert'; }
}

/** The account's rank among every account ever created (1 = the first), never its id. */
function accountSlotOf(userId: string | null | undefined): number | undefined {
  if (!userId) return undefined;
  try {
    const index = dbApi.listUsers().findIndex((user) => user.id === userId);
    return index >= 0 ? index + 1 : undefined;
  } catch { return undefined; }
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const loadBucketOf = (ms: number): 'lt1s' | '1-3s' | '3-10s' | 'gt10s' =>
  ms < 1_000 ? 'lt1s' : ms < 3_000 ? '1-3s' : ms < 10_000 ? '3-10s' : 'gt10s';

/** Homes whose exit is recorded: one process-level listener each, kept across module restarts. */
const exitRecorded = new Set<string>();
function recordExitOf(home: string): void {
  // `exit` runs for `process.exit()` (a clean stop through the resource guard)
  // and for an uncaught exception (non-zero code); a SIGKILL, an OOM kill or a
  // power cut run nothing, which the next start reads as `unknown`.
  if (exitRecorded.size === 0) {
    process.on('exit', (code) => {
      for (const recorded of exitRecorded) {
        try { saveTelemetryState({ ...loadTelemetryState(recorded), running: false, lastExitCode: code }, recorded); } catch { /* best effort */ }
      }
    });
  }
  exitRecorded.add(home);
}

/** Counts only, never a name; a source that cannot be read is left out. */
function installationSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = { ram_class: ramClassOf(totalmem()), cpu_class: cpuClassOf(cpus().length || 1) };
  const put = (key: string, read: () => number): void => { try { out[key] = read(); } catch { /* unreadable: omitted */ } };
  let agents: ReturnType<typeof listAgents> = [];
  try { agents = listAgents(); out.agents = agents.length; } catch { /* omitted */ }
  put('projects', () => listProjects().length);
  put('routines', () => dbApi.listRoutines().length);
  put('routines_enabled', () => dbApi.listRoutines().filter((r) => Boolean(r.enabled)).length);
  put('workflows', () => dbApi.listWorkflows().length);
  put('mcp_servers', () => listMcp().length);
  put('skills', () => listSkills().length);
  put('accounts', () => dbApi.listUsers().filter((u) => u.status === 'active').length);
  put('teams', () => dbApi.listTeams().length);
  try {
    const gallery = currentGallery();
    out.bundled_plugins_active = gallery.filter((p) => p.source === 'bundled' && p.state === 'active').length;
    out.third_party_plugins = gallery.filter((p) => p.source === 'third-party' && !p.builtin).length;
  } catch { /* gallery not attached yet */ }
  if (agents.length) {
    const backends = new Set(agents.map((a) => backendValue(a.backend)).filter((b) => b !== 'other'));
    out.backends = [...backends].sort();
  }
  return out;
}

const INERT: TelemetryRuntime = {
  active: false,
  track() {},
  trackUi() {},
  refreshPreference: () => ({ enabled: false, source: 'default', malformed: false }),
  preference: () => ({ enabled: false, source: 'default', malformed: false }),
  flushNow: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
};

export function startTelemetry(opts: TelemetryOptions = {}): TelemetryRuntime {
  const env = opts.env ?? process.env;
  const apiUrl = telemetryDestination(env, opts.packaged ?? packagedDaemon(env));
  if (!apiUrl) return INERT;

  const now = opts.now ?? Date.now;
  const home = opts.home ?? TIMON_HOME;
  const version = versionValue(timonVersion()) ?? '0.0.0';
  // Drawn on the first event actually queued: an installation that never
  // shares anything never gets an identity either.
  let state: TelemetryState | null = null;
  const identity = (): TelemetryState => {
    if (state) return state;
    state = loadTelemetryState(home, now);
    if (!state.firstSeenDay) {
      state = { ...state, firstSeenDay: utcDay(now()) };
      saveTelemetryState(state, home);
    }
    return state;
  };
  const transport = new TelemetryTransport({ apiUrl, sdkVersion: version, fetch: opts.fetch });
  const prefSources: PreferenceSources = { env, ...opts.preference };

  let pref = resolvePreference(prefSources);
  let prefReadAt = now();
  let disposed = false;

  const globals = (surface: Surface, context?: EventContext): GlobalProperties | null => {
    let tier = 'unlicensed';
    try { tier = licenseTierValue(licenseState()); } catch { /* licence not loaded yet */ }
    const slot = accountSlotOf(context?.userId);
    const firstDay = identity().firstSeenDay;
    return validateGlobals({
      surface, app_version: version, platform: platformValue(), arch: archValue(),
      event_schema_version: EVENT_SCHEMA_VERSION, license_tier: tier,
      ...(slot ? { account_slot: slot } : {}),
      ...(firstDay ? { install_age: installAgeOf(firstDay, utcDay(now())) } : {}),
    });
  };

  const enqueue = (
    name: TelemetryEventName, props: Record<string, unknown>, surface: Surface, context?: EventContext, person = false,
  ): void => {
    const valid = validateEvent(name, props);
    const global = globals(surface, context);
    if (!valid || !global) return;
    transport.enqueue({ type: 'track', payload: { name, profileId: identity().installId, properties: { ...global, ...valid } } }, { person });
  };

  /** Acts on a change of the preference; returns whether events may be queued. */
  const checkPreference = (force: boolean): boolean => {
    if (disposed) return false;
    if (!force && now() - prefReadAt < PREFERENCE_TTL_MS) return pref.enabled;
    const next = resolvePreference(prefSources);
    prefReadAt = now();
    const before = pref;
    pref = next;
    if (before.enabled && !next.enabled) {
      transport.cancel();
      // The one goodbye, for a choice a person made — never for an environment
      // that forbids sending, nor for a value nobody can read.
      if (!next.malformed && (next.source === 'settings' || next.source === 'config')) {
        enqueue('telemetry_preference_changed', { enabled: false, source: next.source }, 'daemon');
        void transport.tick();
      }
    } else if (!before.enabled && next.enabled && (next.source === 'settings' || next.source === 'config')) {
      enqueue('telemetry_preference_changed', { enabled: true, source: next.source }, 'daemon');
    }
    return next.enabled;
  };

  const track = (name: TelemetryEventName, props: Record<string, unknown>, surface: Surface = 'daemon', context?: EventContext): void => {
    try {
      if (!checkPreference(false)) return;
      enqueue(name, props, surface, context);
    } catch { /* analytics never breaks the caller */ }
  };

  const trackUi = (event: UiEvent, context: EventContext): void => {
    try {
      if (!checkPreference(false)) return;
      if (event.name === 'app_opened') {
        // At most once a day per account: it counts the days a person used
        // Timon, not how often a tab reloads.
        const key = String(accountSlotOf(context.userId) ?? 0);
        const today = utcDay(now());
        const known = identity();
        if (known.openedDays[key] === today) return;
        state = { ...known, openedDays: { ...known.openedDays, [key]: today } };
        saveTelemetryState(state, home);
        enqueue('app_opened', {
          setup_completed: event.setupCompleted,
          ...(typeof event.loadMs === 'number' ? { load: loadBucketOf(event.loadMs) } : {}),
        }, event.surface, context, true);
      } else if (event.name === 'ui_error') {
        enqueue('ui_error', { section: pageSectionOf(event.path) }, event.surface, context, true);
      } else if (event.name === 'page_viewed') {
        const section = pageSectionOf(event.path);
        enqueue('page_viewed', { section }, event.surface, context, true);
        enqueue('screen_view', { section, __path: `/${section}` }, event.surface, context, true);
      } else {
        enqueue('upgrade_action', { action: event.action, entry_point: event.entryPoint }, event.surface, context, true);
      }
    } catch { /* analytics never breaks the caller */ }
  };

  /** A first time is reported once per installation, ever. */
  const reachMilestone = (milestone: Milestone): void => {
    try {
      if (!checkPreference(false)) return;
      const known = identity();
      if (known.milestones.includes(milestone)) return;
      state = { ...known, milestones: [...known.milestones, milestone] };
      saveTelemetryState(state, home);
      enqueue('milestone_reached', { milestone }, 'daemon');
    } catch { /* analytics never breaks the caller */ }
  };

  const onRequest = (request: FinishedRequest): void => {
    if (!request.template?.startsWith('/api/') || request.template.startsWith('/api/telemetry/')) return;
    const feature = featureOf(request.method, request.template);
    const { cause: failureCode, upstreamStatus } = causeOf(request.status, request.errorCode, request.errorText, request.errorSystemCode);
    const context: EventContext = { userId: request.userId };
    if (feature) {
      track('feature_used', {
        feature, actor: ACTOR_OF[request.actor],
        result: request.status < 400 ? 'success' : 'failure', failure_code: failureCode,
      }, 'daemon', context);
      const milestone = FEATURE_MILESTONES[feature];
      if (milestone && request.status < 400) reachMilestone(milestone);
      if ((feature === 'account.create' || feature === 'account.invite') && ACCOUNT_LIMIT_CODES.includes(failureCode)) {
        track('upgrade_action', { action: 'account_limit_reached', entry_point: 'users' }, 'daemon', context);
      }
    }
    if (request.status >= 500) {
      track('operation_failed', {
        area: apiAreaOf(request.template) ?? 'other', feature: feature ?? 'other', cause_code: failureCode,
        ...(upstreamStatus ? { upstream_status: upstreamStatus } : {}),
      }, 'daemon', context);
    }
  };

  const snapshotIfDue = (): void => {
    if (!pref.enabled) return;
    const today = utcDay(now());
    const known = identity();
    if (known.snapshotDay === today) return;
    state = { ...known, snapshotDay: today };
    saveTelemetryState(state, home);
    enqueue('installation_snapshot', installationSnapshot(), 'daemon');
  };

  const collector = new TelemetryCollector({
    ...databaseDeps(),
    now,
    milestone: (m) => reachMilestone(m),
    installCreatedAt: () => {
      const created = Date.parse(identity().createdAt ?? '');
      return Number.isFinite(created) ? created : null;
    },
    ...opts.collector,
  }, (name, props) => track(name, props));
  try { collector.setInitialLicense(licenseState().status === 'valid'); } catch { /* not loaded */ }

  const onBus = (ev: BusEvent): void => {
    // The hottest event on the bus, and of no interest here.
    if (ev.kind === 'event_delta') return;
    try {
      // While sharing is off, the plugin and licence baselines keep up (their
      // events are dropped by `track`), so turning it back on reports no
      // phantom installs.
      if (!checkPreference(false) && !STATEFUL_KINDS.has(ev.kind)) return;
      collector.handle(ev);
    } catch { /* a listener that throws would surface inside a mission's own code path */ }
  };
  const observe = (): void => {
    try {
      const license = licenseState();
      collector.observeLicense(license.status === 'valid', license.reason);
    } catch { /* licence not loaded */ }
    try { collector.seedPlugins(currentGallery()); } catch { /* gallery not attached yet */ }
  };
  bus.on('event', onBus);
  const stopObserving = onRequestFinished((request) => { try { onRequest(request); } catch { /* never breaks a response */ } });

  // Start and update are counted once per process and installation: a module
  // re-applied on a recomposition is not a new start.
  if (checkPreference(true) && !reportedStarts.has(home)) {
    reportedStarts.add(home);
    let daemon: 'embedded' | 'service' | 'process' = 'process';
    try { daemon = daemonMode(env, process.platform, stdoutIsJournal(env)); } catch { /* unknown: process */ }
    const before = identity();
    const previousExit = before.running ? 'unknown'
      : before.lastExitCode === null ? (before.lastVersion ? 'unknown' : 'first')
        : before.lastExitCode === 0 ? 'clean' : 'error';
    enqueue('app_started', {
      mode: appMode(), daemon_mode: daemon, edition: edition(),
      previous_exit: previousExit, boot_ms: Math.min(3_600_000, Math.round(process.uptime() * 1000)),
    }, 'daemon');
    state = { ...before, running: true, lastExitCode: null };
    saveTelemetryState(state, home);
    recordExitOf(home);
    const known = identity();
    const previous = versionValue(known.lastVersion);
    if (previous && previous !== version) enqueue('app_updated', { from_version: previous, to_version: version }, 'daemon');
    // Kept in memory too: every later write (opened day, milestone, snapshot)
    // starts from `state`, and would otherwise put the previous version back.
    if (known.lastVersion !== version) {
      state = { ...known, lastVersion: version };
      saveTelemetryState(state, home);
    }
  }

  const timer = setInterval(() => {
    checkPreference(true);
    observe();
    try { snapshotIfDue(); } catch { /* a snapshot never stops the flush */ }
    void transport.tick();
  }, opts.intervalMs ?? FLUSH_INTERVAL_MS);
  timer.unref();

  return {
    active: true,
    track,
    trackUi,
    refreshPreference: () => { checkPreference(true); return pref; },
    preference: () => pref,
    flushNow: () => transport.flush(),
    async dispose() {
      if (disposed) return;
      clearInterval(timer);
      bus.off('event', onBus);
      stopObserving();
      // Whatever was queued before the module stopped still goes, briefly.
      await transport.flush();
      disposed = true;
    },
  };
}

let current: TelemetryRuntime = INERT;

/** The runtime the module started, or an inert one. */
export function telemetry(): TelemetryRuntime {
  return current;
}

export function setTelemetryRuntime(runtime: TelemetryRuntime): void {
  current = runtime;
}

/** Forgets `runtime` if it is still the current one (module disposed). */
export function clearTelemetryRuntime(runtime: TelemetryRuntime): void {
  if (current === runtime) current = INERT;
}
