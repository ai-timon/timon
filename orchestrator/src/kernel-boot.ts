/**
 * Boot through the modular kernel — the orchestrator's only boot (step 1.7).
 *
 * This file holds NO business logic: it composes. It reads the config, works
 * out what the machine can do, decides which modules may run, lets Cordis
 * activate them in the order their `inject` imposes, checks they are all
 * active, then listens.
 *
 * `index.ts` only imports it. The historical boot and the `TIMON_BOOT` switch
 * that chose between the two were removed at the end of the parity campaign
 * (step 1.6).
 *
 * ## What stays here, and why
 *
 * Three gestures cannot live in a module:
 *
 * 1. **The zombie mission sweep.** A mission still `running` in the database
 *    comes from a previous process. It is marked `failed` and
 *    `mission_complete` is published so the UI leaves its spinner and the
 *    dispatcher moves its task to BLOCKED. The invariant is that ALL the
 *    `mission_complete` listeners are already in place, otherwise the event is
 *    lost and the task stays frozen IN_PROGRESS — the historical orphan-task
 *    bug.
 *
 *    The plan meant to get there with an `inject` on every module that sets a
 *    listener. It was not done: `inject` is a HARD dependency in Cordis 4 (no
 *    optional form), so injecting `librarian` or `merge-integrity` — provided
 *    by `kanban-code`, disabled in the `lite` edition — would leave
 *    `@timon/missions` PENDING and fail the boot of a perfectly valid install.
 *    Doing it AFTER the activation audit gives a stronger, unconditional
 *    guarantee: at that point every `apply()` of the tree has finished,
 *    whatever the edition.
 *
 * 2. **The reaper and the reconcile loop**, for the same reason: they correct
 *    what the listeners could not see, so they come after them.
 *
 * 3. **`app.listen`**, which must come once every route is mounted — otherwise
 *    a request arriving during composition gets a 404.
 */
// Must stay first: it can replace timon.db before db.ts opens it.
import './data-restore-boot.js';
import express from 'express';
import { join } from 'node:path';
import { DB_PATH, TIMON_HOME } from './paths.js';
import { recordHomeLockPort } from './home-lock.js';
import { createDataUpdate, ensureUpdateToken, mountDataUpdateRoutes } from './data-update.js';
import { packagedDaemon, timonVersion } from './data-version.js';
import { createBodyParser } from './kernel/body-parser.js';
import { createRequestObserver } from './kernel/request-observer.js';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import { ConfigError, config } from './config/load.js';
import { apiPort, recordBoundAddress } from './api-url.js';
import { listenAll, listenHostsFor } from './listen-hosts.js';
import { loadSecretsAtBoot } from './secrets.js';
import { setLogLimits } from './log-file.js';
import { settingInt } from './settings.js';
import {
  authIsRequired,
  createDaemonAuthMiddleware,
  ensureDaemonToken,
} from './plugins-bundled/http/auth.js';
import { createHost } from './host/index.js';
import { inspectListenPort } from './host/listen-port.js';
import { endRecordedMissionProcesses, missionProcessDir, sweepOpsFor } from './host/mission-processes.js';
import { bus } from './bus.js';
import { backendNames, onBackendsChanged, primeModelDiscovery } from './backends/index.js';
import { primeProviderSignIn, setSignInEnv } from './backends/sign-in-state.js';
import { mainAgentAuthEnv } from './doctor.js';
import { reportBackendBinaries } from './backends/binary-check.js';
import { expectProviders, providersLoaded } from './backends/registry.js';
import { dbApi } from './db.js';
import { noticeSuspendedAccounts } from './users/suspended-accounts.js';
import { liveMissionBackends, reattachRemoteMissions, startReaper, sweepZombieMissions } from './agent.js';
import { startReconcile } from './reconcile.js';
import { createHttpPlugin } from './kernel/http-service.js';
import { createHostPlugin } from './kernel/host-service.js';
import { apply as applyBusBridge } from './kernel/bus-bridge.js';
import { auditActivation } from './kernel/activation-audit.js';
import {
  licensedModulesOf, planEntries, toLoaderEntries,
  type EntryDecision, type ModuleDescriptor,
} from './kernel/registry.js';
import { CATALOG } from './kernel/catalog.js';
import { setLiveDecisions } from './kernel/capabilities.js';
import { SECRETS_MODULE_ID, VAULT_DISABLED_NOTICE } from './secrets/availability.js';
import { closePluginSecretCards } from './secrets/plugins.js';
import { attachBundledReconciler, createBundledReconciler } from './kernel/bundled-reload.js';
import { PluginLoader } from './plugins/loader.js';
import { closePluginSpawnCards, narrowLivePluginGrants } from './plugins/policy.js';
import { settlePluginPackage } from './plugins/package-binding.js';
import { closePluginLaunchCard } from './backends/launch-card.js';
import { unsignedPluginsAllowed } from './plugins/pubkey.js';
import { resolveBuiltins } from './plugins/builtin.js';
import { daemonHost } from './plugins/context.js';
import { attachPluginLoader, galleryPlugins, loaderFromApp, publicPlugins, setGallerySource } from './plugins/runtime.js';
import { mascotPartsOf } from './plugins/mascot-packs.js';
import { setMascotPartSource } from './agent-look.js';
import { applyLicensedSurfaces } from './kernel/routes/license.js';
import { effectiveEdition } from './license/license.js';
import { bootLicenseState, startLicenseRefresh } from './license/refresh.js';
import { licenseState, setLicenseState } from './license/runtime.js';
import { whiteLabelAllowed } from './license/capabilities.js';
import { createBetaGate } from './license/beta-gate.js';
import { createMcpRelayMiddleware } from './mcp-relay-server.js';
import { kernelBootSummary, pluginFailureNotification } from './kernel/boot-report.js';


/**
 * Composes the application and returns the root context.
 * `listen: false` for tests: they want the tree, not an open port.
 */
export async function boot(opts: { listen?: boolean; catalog?: readonly ModuleDescriptor[] } = {}): Promise<Context> {
  // VERY FIRST gesture of the boot: `~/.timon/secrets.env` must be in
  // `process.env` before anything reads it — the config (whose
  // `env > config > table` resolution gives env the priority), the host
  // adapter, and the modules that check their credentials in `apply()`
  // (`web-push` looks for its VAPID private key there).
  loadSecretsAtBoot();
  const cfg = config();
  // The log module read env and config only; the settings table is open now.
  setLogLimits(() => ({
    days: settingInt('TIMON_LOG_RETENTION_DAYS'),
    maxBytes: settingInt('TIMON_LOG_MAX_MB') * 1024 * 1024,
  }));
  // The device id is explicit: it is the one the activate/renew client sends
  // to the server, hence the one the token's `did` must match.
  // With the offline tolerance: an expired token stays good while the last
  // server contact is within the plan's window (`refresh.ts`).
  setLicenseState(bootLicenseState());
  // The EFFECTIVE state, not the one just read: a beta build locks or expires
  // it, and the module plan below must follow that, not the raw licence.
  const license = licenseState();
  const effectiveConfig = { ...cfg, edition: effectiveEdition(cfg.edition, license.edition) };
  // The host adapter BEFORE the loader entries: it, and it alone, says what
  // this machine can do. `planEntries` and `timon doctor` now read the same
  // list — the gap between the diagnosis and the host (two parallel
  // computations until then) can no longer exist.
  const host = createHost(cfg);
  const capabilities: string[] = host.capabilities();
  const catalog = opts.catalog ?? CATALOG;
  const licensedModules = licensedModulesOf(catalog, license.modules);
  const decisions: EntryDecision[] = planEntries(catalog, { config: effectiveConfig, capabilities, licensed: licensedModules });
  // `/api/capabilities` must return the tree's REAL state, not a recomputation:
  // in kernel mode this one is authoritative.
  setLiveDecisions(decisions, capabilities, effectiveConfig.edition);

  console.log(kernelBootSummary({
    profile: cfg.profile,
    edition: effectiveConfig.edition,
    licenseStatus: license.status,
    licenseReason: license.reason,
    capabilities,
    decisions,
  }));
  // A disabled vault has consequences outside its module (no injection at
  // spawn, no broker): one line of the generic listing above is not enough to
  // make them predictable. A key that does not arrive must have been announced
  // at startup, not discovered ten minutes later.
  if (decisions.some((d) => d.disabled && d.id === SECRETS_MODULE_ID)) console.log(VAULT_DISABLED_NOTICE);

  const app = express();
  // Dedicated update-token auth precedes daemon auth. db.ts has already required
  // approval before opening the database, so approve is a no-op here. Keep that
  // guard: without it, this POST could snapshot a database open for writes.
  if (packagedDaemon()) mountDataUpdateRoutes(app, createDataUpdate({
    home: TIMON_HOME, dbPath: DB_PATH, configPath: join(TIMON_HOME, 'timon.config.json'),
  }, timonVersion(), { migrate: async () => {} }), ensureUpdateToken(TIMON_HOME));
  // Token first, middleware next, body parser last: an unauthenticated 25 MB
  // POST has no reason to be parsed. `GET /api/health` stays public (see
  // `createDaemonAuthMiddleware`).
  // The OAuth MCP relay authenticates with its own per-agent token and must
  // read the body raw: before the daemon's auth and body parser (`mcp-relay-server.ts`).
  app.use(createMcpRelayMiddleware());
  const token = ensureDaemonToken();
  app.use(createDaemonAuthMiddleware({ token, required: authIsRequired(cfg) }));
  // After authentication, so a listener knows who made the request; before any
  // route, so every route is observed (`kernel/request-observer.ts`).
  app.use(createRequestObserver());
  // A beta build that is expired or without a licence answers nothing but
  // licence, health and auth — for every identity, the daemon-token included.
  app.use(createBetaGate());
  // 25 MB: room for a few base64 screenshots pasted in the same turn. Same as
  // the historical boot.
  app.use(createBodyParser());

  // Bundled modules can start the dispatcher during activation, before the provider loader runs.
  expectProviders();

  const ctx = new Context();
  // Loader entries are paths relative to `dist/`: they must resolve from
  // `dist/boot.js`, not from the process cwd. Resolved as a URL end to end:
  // going through `.pathname` yields `/C:/…` on Windows, which `pathToFileURL`
  // then takes for a relative path and doubles into `file:///C:/C:/…` — the
  // packaged daemon then found no plugin and crash-looped (seen 2026-09-12).
  ctx.baseUrl = new URL('./', import.meta.url).href;

  await ctx.plugin(Timer);
  await ctx.plugin(createHttpPlugin(app));
  await ctx.plugin(createHostPlugin(host));
  await ctx.plugin({ name: 'timon-bus-bridge', apply: applyBusBridge });
  await ctx.plugin(Loader);

  for (const entry of toLoaderEntries(decisions)) {
    await ctx.loader.create(entry);
  }

  // An unsatisfied `inject` leaves a module PENDING **silently** (a pitfall
  // documented by Cordis and by dsh). The audit turns that silence into a
  // named startup failure.
  await auditActivation(ctx);

  // THIRD-PARTY plugins mount after the bundled modules, never before: their
  // facades (routes, kanban, missions) rely on services the tree has just
  // activated. Everything is wrapped: a broken plugins folder must not stop
  // TIMON from starting — the same rule as the missing licence of §10.7,
  // applied one level down.
  // A provider plugin (§10.15) changes the backend list live: announcing it
  // lets the UI re-read its catalogue instead of keeping the startup menus.
  // Set BEFORE the loader, to cover a registration made during the `apply`
  // of the first plugin loaded.
  onBackendsChanged(() => bus.publish({ kind: 'backends_changed' }));

  try {
    const loader = new PluginLoader(ctx, {
      host: daemonHost(ctx),
      allowUnsigned: () => unsignedPluginsAllowed(config().developer.unsignedPlugins),
      // Live, not the boot's `license`: `licenseState()` reflects whatever the
      // last `PUT /api/license` (or `/activate`) installed, so a plugin
      // licensed by a fresher token lights up on the next `loader.update()` —
      // which the license route now triggers — instead of at next restart.
      licensedPlugins: () => licenseState().plugins,
      // Live as well: a renewal that adds or withdraws the right recomposes
      // the tree, and the layout follows without a restart.
      whiteLabelAllowed: () => whiteLabelAllowed(licenseState()),
      // Shipped with the product: re-resolved (and, packaged, re-checked
      // against the verified release manifest) on every recomposition.
      builtins: () => resolveBuiltins(),
      // A provider's update waits until no mission is running on its backends.
      backendsInFlight: () => liveMissionBackends(),
      onFailure: (id, message) => notifyPluginFailure(id, message),
      // `timon plugin remove` edits the file from another process (TODO #663).
      beforePass: () => narrowLivePluginGrants(),
      // A package gone without `timon plugin remove` leaves its grants behind (TODO #671).
      settlePackage: (id, pkg) => { settlePluginPackage(id, pkg); },
      // The remover already closed them in the database; only the daemon can
      // close them on the devices and forget what it carded (TODO #661, #663).
      onRemoved: (id) => {
        void closePluginSecretCards(id);
        void closePluginSpawnCards(id);
        void closePluginLaunchCard(id);
      },
      onChange: () => {
        // The daemon publishes, not the plugins: the bus is read-only to them.
        bus.publish({ kind: 'plugins_changed', plugins: publicPlugins(loader) });
      },
    });
    attachPluginLoader(ctx.http.app, loader);
    // A plugin's `ctx.layout` has no request to read the loader from.
    setGallerySource(() => galleryPlugins(loader));
    // An agent's look may name a part of a mascot pack that runs now (docs/AGENT-LOOK.md).
    setMascotPartSource(() => mascotPartsOf(loader.list()));
    await loader.update();
    loader.watch();
  } catch (err) {
    console.warn('[plugins] cannot load plugins:', (err as Error).message);
  }
  // After the plugins: an account provider plugin that just mounted serves the accounts again.
  try { noticeSuspendedAccounts(); } catch (err) { console.warn('[users] suspended accounts notice failed:', (err as Error).message); }
  // Before anything picks a default backend (main agent seeding waits on `providersLoaded`).
  setSignInEnv(mainAgentAuthEnv);
  await primeProviderSignIn(backendNames());
  providersLoaded();
  // Said once the providers shipped as plugins are there: the CLIs the machine cannot run (`codex` among them),
  // and the models of the providers that list them. Neither blocks the boot.
  reportBackendBinaries();
  primeModelDiscovery();

  // Bundled modules become switchable live, like third-party ones since P.3.
  // Installed AFTER the plugin loader: what it publishes describes the whole
  // gallery, catalogue and packages together.
  //
  // Capabilities stay the ones THIS boot resolved (the machine does not change
  // on the way); the licence, though, is re-read live on every `reconcile()`
  // through `kernel/registry.licensedModulesOf` — the ONLY function that
  // expands `licence.modules === '*'`, called here and at boot, so the two
  // readings never diverge (see `installLicenseToken` on the route side, which
  // triggers this `reconcile()` after a successful activation).
  const reconciler = createBundledReconciler(ctx, {
    catalog,
    capabilities,
    decisions,
    onChange: () => {
      bus.publish({ kind: 'plugins_changed', plugins: galleryPlugins(loaderFromApp(app)) });
    },
  });
  attachBundledReconciler(app, reconciler);
  reconciler.watch();

  // ── After the tree: the gestures that need EVERYTHING in place ──────────────
  // Missions of a remote backend that left a resume state still live on their
  // server: reattach them BEFORE the sweep (which spares them) and before the
  // reaper (which would take them for orphans). After the plugin loader, which
  // registers their dialects.
  let reattached = new Set<string>();
  try {
    reattached = await reattachRemoteMissions();
    if (reattached.size) console.log(`[timon] reattached ${reattached.size} remote mission(s) on boot`);
  } catch (err) {
    console.warn('[timon] remote mission reattachment failed:', (err as Error).message);
  }
  // The CLIs of the missions failed just below may still run, reparented,
  // when the previous daemon died without ending them (TODO #565). Ended
  // before the sweep announces those missions over.
  try {
    const leftovers = await endRecordedMissionProcesses(missionProcessDir(TIMON_HOME), sweepOpsFor(host));
    if (leftovers.ended.length) console.log(`[timon] ended ${leftovers.ended.length} mission process(es) a previous daemon left running`);
  } catch (err) {
    console.warn('[timon] leftover mission process sweep failed:', (err as Error).message);
  }
  try {
    const ids = sweepZombieMissions(reattached);
    if (ids.length) console.log(`[timon] swept ${ids.length} zombie mission(s) on boot`);
  } catch (err) {
    console.warn('[timon] zombie sweep failed:', (err as Error).message);
  }

  startReaper();
  startReconcile();
  // Licence renewal loop, AFTER the tree: it publishes `license_changed` and
  // recomposes modules and plugins, which must exist.
  startLicenseRefresh({ app, recompose: applyLicensedSurfaces });
  startMissionSearchBackfill();

  if (opts.listen !== false) {
    const port = apiPort();
    // The bind follows `daemon.listen.host`, the address the auth guards decide on (TODO #339).
    const listenHost = config().daemon.listen.host;
    const extraHosts = config().daemon.listen.extraHosts;
    for (const extra of extraHosts) {
      console.warn(`[timon] daemon.listen.extraHosts: ${extra}:${port} is served without the exposed-host auth — container bridge only`);
    }
    void listenAll(app, listenHost, port, console.warn, extraHosts).then((servers) => {
      const address = servers[0]!.address();
      recordBoundAddress(typeof address === 'object' && address ? address.address : null);
      recordHomeLockPort(TIMON_HOME, port);
      for (const server of servers) {
        // WebSocket upgrades bypass Express: hand them to the modules that claimed one.
        server.on('upgrade', (req, socket, head) => ctx.http.handleUpgrade(req, socket, head));
      }
      console.log(`[timon] orchestrator (kernel) listening on http://localhost:${port}`);
    }, (error: NodeJS.ErrnoException) => {
      // Say who holds the port: a service crash-looping on EADDRINUSE is otherwise undiagnosable.
      void (error.code === 'EADDRINUSE' ? inspectListenPort(host, listenHostsFor(listenHost)[0]!, port) : Promise.resolve(undefined))
        .catch(() => undefined)
        .then((state) => {
          console.error(`[timon] cannot listen on port ${port}: ${error.message}${state ? ` — ${state.detail}` : ''}`);
          process.exit(1);
        });
    });
  }
  return ctx;
}

/**
 * A failing third-party plugin must show: the daemon carries on, but the human
 * has to learn it some other way than by reading the service logs (§10.5).
 */
function notifyPluginFailure(id: string, message: string): void {
  void import('./notifications.js').then(({ createNotification }) => {
    createNotification(pluginFailureNotification(id, message));
  }).catch(() => { /* notifications unavailable: the log has already said it all */ });
}

/**
 * Mission search index catch-up, in the background.
 * Verbatim copy of `index.ts`: one batch every 250 ms rather than a single
 * sweep, which would freeze the event loop — hence every mission in flight —
 * for a minute on a large database.
 */
function startMissionSearchBackfill(): () => void {
  let pending: NodeJS.Timeout;
  const step = () => {
    try {
      const r = dbApi.reindexMissionSearch(500);
      if (r.done) {
        const p = dbApi.missionSearchProgress();
        console.log(`[timon] mission search index up to date (${p.fragments} fragments)`);
        return;
      }
    } catch (err) {
      console.warn('[timon] mission search backfill:', (err as Error).message);
      return; // no runaway loop on a broken database: `timon mission reindex` will pick it up
    }
    pending = setTimeout(step, 250);
    pending.unref();
  };
  pending = setTimeout(step, 5_000);
  pending.unref();
  return () => clearTimeout(pending);
}

// Direct execution (`node dist/boot.js`, or `index.ts` in kernel mode).
try {
  await boot();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[timon] ${err.message}`);
    process.exit(2);
  }
  throw err;
}
