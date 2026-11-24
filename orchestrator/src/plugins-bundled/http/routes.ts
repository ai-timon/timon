import { applyTeam, teamStatus, TeamChoiceSchema, TeamSetupError } from '../../onboarding-team.js';
import { teamOnboardingPending } from '../../onboarding-team-state.js';
import { registerSetupChatRoutes } from '../../onboarding-main-agent-routes.js';
import { stopSetupChat } from '../../onboarding-main-agent-chat.js';
import { setupTeam } from '../../onboarding-setup-team.js';
import { requestActor } from '../../users/audit-actor.js';
import { applyMainAgent, mainAgentStatus, MainAgentSchema, MainAgentSetupError, skipMainAgent } from '../../onboarding-main-agent.js';
/**
 * Module `@timon/http` — the transport itself: SSE stream, statistics, health
 * of the resources, usage, latest events. Tier `core`.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Router } from 'express';
import { capabilitiesPayload } from '../../kernel/capabilities.js';
import { isRunning, liveMissionCount } from '../../agent.js';
import { dbApi } from '../../db.js';
import { resourceHealth } from '../../resources.js';
import { daemonMemory } from '../../daemon-memory.js';
import { sseHandler } from '../../sse.js';
import { getBackendUsage } from '../../usage.js';
import { splitBackendInstance } from '../../backends/instance-id.js';
import { getBackendAccountFor } from '../../backends/accounts.js';
import { diagnose } from '../../doctor.js';
import { webUiAccess } from '../../web-access.js';
import { applySetup, isFirstRun, noProviderForSetup, SetupError, type SetupInput } from '../../setup.js';
import { OnboardingError, parseOnboardingAction, runOnboardingAction } from '../../onboarding.js';
import { existingInstance, resumeExistingInstance, ResumeError } from '../../onboarding-resume.js';
import {
  armRestartForFirstSetup, clearRestartPending, restartForOnboarding, restartOnboardingPending, restartStatus,
} from '../../onboarding-restart.js';
import { requireSuperadmin, viewerFromRequest } from '../../users/identity.js';
import { viewerSeesAll } from '../../users/owned.js';
import { scopedDb } from '../../users/scoped-db.js';
import { attachSurfaces } from '../../users/surfaces.js';
import { galleryPlugins, loaderFromApp } from '../../plugins/runtime.js';
import { instanceId } from '../../host/packaged-service.js';
import { TIMON_HOME } from '../../paths.js';
import { BRAND } from '../../brand.js';
import { packagedDaemon } from '../../data-version.js';
import { onboardingStep } from '../../onboarding-events.js';
import { apiError } from '../../api-error.js';
import { alreadyCompleteBody, invalidIdentityBody, invalidPresetBody, mainAgentErrorBody, restartRefusalBody, restartRequiredBody, resumeErrorBody, teamErrorBody } from './setup-errors.js';

export function registerRoutes(app: Router): void {
  /**
   * Liveness probe. Public: the auth middleware (mounted before
   * `express.json` in `boot.ts`) lets `GET /api/health` through without a
   * token. Electron and the probes use it to know whether the daemon
   * answers, before having a secret. `/api/health/resources` stays protected.
   */
  app.get('/api/health', (_req, res) => {
    // `service` is what makes this probe conclusive. On a machine where
    // another daemon already holds the port — the v1 on :3000 — a bare
    // `{ ok: true }` let the desktop shell believe Timon was alive: it opened
    // a window on an app port nobody served and showed a blank page. The
    // The instance digest lets the shell reject another data directory without
    // exposing its path, account names or credentials on this public route.
    // `packaged` tells the desktop whether this daemon is one it can update: a
    // daemon run from the sources has no update routes and no update token, so
    // offering it a data migration could only end in a failure (TODO #477).
    res.json({ ok: true, service: BRAND.id, instance: instanceId(TIMON_HOME), packaged: packagedDaemon() });
  });

  /**
   * What this installation can do: active modules, host capabilities,
   * edition, hidden UI zones. The front hides what does not exist rather
   * than showing buttons that fail.
   *
   * M.4: `surfaces` is filtered per viewer before the JSON leaves. The
   * kernel fields stay the machine's truth (a hidden page does not stop
   * its module); advertising the page/widget/plugin is what we strip.
   */
  app.get('/api/capabilities', (req, res) => {
    res.json(attachSurfaces(
      capabilitiesPayload(),
      viewerFromRequest(req),
      galleryPlugins(loaderFromApp(req.app)),
    ));
  });

  /**
   * Full diagnostic of THIS machine — binaries, capabilities, blockers. The
   * first-run wizard reads it to prefill the binary paths; `timon doctor`
   * renders the very same report.
   */
  app.get('/api/doctor', (_req, res) => {
    res.json({ ...diagnose(), desktop: process.env.TIMON_DESKTOP_EMBEDDED === '1' || process.env.TIMON_DESKTOP_SERVICE === '1' });
  });

  /**
   * How the web UI is reached — bind address, machine addresses, tailnet
   * state, security posture. Read-only; the `WebUI` settings tab renders it.
   *
   * It must be answered HERE and not in the Next app: the UI commonly runs in
   * a container where the interfaces are the Docker bridge and the
   * `tailscale` binary is absent (`web-access.ts`). Same auth posture as
   * `/api/doctor` above, which already exposes more about this machine.
   */
  app.get('/api/webui-access', (_req, res) => {
    res.json(webUiAccess());
  });

  /**
   * First-run wizard (§5.4). Writes `timon.config.json`, and refuses to
   * flatten an existing one: a stale browser tab must not undo a hand edit.
   * The daemon does NOT restart itself here — the answer says so, and the
   * restart is the user's gesture (or the desktop client's).
   */
  app.post('/api/setup', (req, res) => {
    // Anonymous only while no account exists (first run). Once the instance
    // has users, rewriting `timon.config.json` is an operator gesture
    // (SECU-USERS U-3).
    if (dbApi.countUsers() > 0 && !requireSuperadmin(req, res)) return;
    try {
      const body = (req.body ?? {}) as SetupInput & { force?: boolean };
      const missing = noProviderForSetup(body);
      if (missing) {
        res.status(409).json(apiError('no_provider', missing));
        return;
      }
      const written = applySetup(body, undefined, body.force === true);
      // The end of a FIRST setup is the one moment step 5 exists for; the
      // function itself checks that this write was one (`onboarding-restart.ts`).
      const armed = armRestartForFirstSetup(written);
      onboardingStep('configuration', 'completed');
      res.json({ ...written, restartRequired: armed, teamOnboarding: teamOnboardingPending() });
    } catch (e) {
      const status = e instanceof SetupError ? 400 : 500;
      res.status(status).json(apiError('setup_failed', (e as Error).message, { detail: (e as Error).message }));
    }
  });

  /**
   * Onboarding actions (§5.7.3) — the screen ACTS instead of advising.
   *
   * Three gates, and none of them is redundant:
   *  - the same auth predicate as `/api/setup`: anonymous only while the
   *    instance has no account, superadmin afterwards (SECU-USERS U-3);
   *  - first run only. Installing a service is an onboarding gesture; on a
   *    configured instance it is `timon service install`, run by whoever
   *    administers the machine. Note the order this imposes on the client:
   *    install the service FIRST, write `timon.config.json` after — writing it
   *    is what ends the first run, and would close this route;
   *  - a closed list of named actions (`onboarding.ts`). No string from this
   *    body ever becomes an argv.
   */
  app.post('/api/onboarding', async (req, res) => {
    if (dbApi.countUsers() > 0 && !requireSuperadmin(req, res)) return;
    if (!isFirstRun()) {
      res.status(409).json({
        ...apiError('onboarding_over', 'onboarding is over on this machine (timon.config.json exists)'),
        command: null,
      });
      return;
    }
    try {
      const action = parseOnboardingAction(req.body);
      const result = await runOnboardingAction(action);
      const step = action.action === 'install-service' ? 'install_service' : action.action === 'install-binary' ? 'install_binary' : null;
      if (step) onboardingStep(step, result.ok ? 'completed' : 'failed');
      res.json(result);
    } catch (e) {
      const status = e instanceof OnboardingError ? 400 : 500;
      res.status(status).json(apiError('onboarding_action_failed', (e as Error).message, { detail: (e as Error).message }));
    }
  });

  /**
   * Step 2 — is there an instance to come back to? Read-only, and gated like
   * `/api/setup` rather than like the team screen: it is answered while the
   * machine may still have no account at all.
   */
  app.get('/api/setup/resume', (req, res) => {
    if (dbApi.countUsers() > 0 && !requireSuperadmin(req, res)) return;
    res.json({ ...existingInstance(), firstRun: isFirstRun() });
  });

  /** Ends onboarding on an instance that already holds agents or work. Writes
   *  the missing `timon.config.json` and touches nothing else. */
  app.post('/api/setup/resume', (req, res) => {
    if (dbApi.countUsers() > 0 && !requireSuperadmin(req, res)) return;
    try {
      const written = resumeExistingInstance((req.body ?? {}) as SetupInput);
      // No restart offered here: this instance is alive, with agents and
      // possibly running missions, and the configuration it was missing is
      // read at its next ordinary restart (`onboarding-restart.ts`).
      onboardingStep('resume', 'completed');
      res.json({ ...written, restartRequired: false, resumed: true });
    } catch (error) {
      const known = error instanceof ResumeError || error instanceof SetupError;
      res.status(known ? 409 : 500).json(resumeErrorBody(error));
    }
  });

  /**
   * Step 3 — the main agent's identity. Superadmin only, like the team screen:
   * it renames an agent and writes into its directory.
   */
  app.get('/api/setup/main-agent', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    // The teammates the conversation recruited: the wizard lists them beside the chat.
    res.json({ ...mainAgentStatus(), team: setupTeam() });
  });

  registerSetupChatRoutes(app);

  app.post('/api/setup/main-agent', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    if (req.body && (req.body as { skip?: unknown }).skip === true) {
      const skipped = skipMainAgent();
      // Answered by skipping: the conversation that was setting it up has nothing left it may do.
      stopSetupChat({ source: 'POST /api/setup/main-agent (skip)', actor: requestActor(req) });
      onboardingStep('main_agent', 'skipped');
      res.json(skipped);
      return;
    }
    const parsed = MainAgentSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(invalidIdentityBody()); return; }
    try {
      const applied = applyMainAgent(parsed.data);
      onboardingStep('main_agent', 'completed');
      res.json(applied);
    } catch (error) {
      res.status(error instanceof MainAgentSetupError ? 409 : 500).json(mainAgentErrorBody(error));
    }
  });

  /**
   * Step 5 — the restart, the last gate of the wizard.
   *
   * Read while the daemon may still be the process that wrote the config, and
   * answered by a NEW process once it is not: that is the whole test (cf.
   * `onboarding-restart.ts`).
   *
   * Gated like `/api/setup` and NOT like steps 3 and 4 — anonymous while the
   * instance has no account, superadmin afterwards. The same route that wrote
   * the configuration must be able to close the step it armed: a 401 here would
   * leave an account-less install staring at a gate it cannot satisfy.
   */
  app.get('/api/setup/restart', (req, res) => {
    if (dbApi.countUsers() > 0 && !requireSuperadmin(req, res)) return;
    res.json(restartStatus());
  });

  /**
   * Restarts the daemon itself. The answer leaves before the signal lands.
   *
   * Closed once the step is answered, like `/api/onboarding` is closed once the
   * config exists: restarting a LIVE daemon kills every mission running under it
   * (agent processes are its children), and a stale tab left on this screen must
   * not be able to do that months later. Afterwards it is
   * `timon service restart`, run by whoever administers the machine.
   */
  app.post('/api/setup/restart', (req, res) => {
    if (dbApi.countUsers() > 0 && !requireSuperadmin(req, res)) return;
    // Every refusal is decided in `restartForOnboarding`, not here: this route
    // is one of two callers (the desktop shell restarts its own shell through
    // its bridge), and a guard living in a route is a guard the next caller
    // does not get.
    const outcome = restartForOnboarding();
    if (!outcome.ok) {
      res.status(409).json({ restarting: false, command: outcome.command, ...restartRefusalBody(outcome.reason) });
      return;
    }
    if (!outcome.alreadyRequested) onboardingStep('restart', 'completed');
    res.json({ restarting: true, alreadyRequested: outcome.alreadyRequested });
  });

  /**
   * Lets the step through on a machine with NO supervisor. Not an escape hatch
   * for everyone else: a 409 otherwise. Portable mode has no process to wait
   * for, and a gate that cannot be satisfied is worse than a configuration read
   * one boot late.
   */
  app.post('/api/setup/restart/skip', (req, res) => {
    if (dbApi.countUsers() > 0 && !requireSuperadmin(req, res)) return;
    if (!restartOnboardingPending()) { res.status(409).json(alreadyCompleteBody()); return; }
    if (restartStatus().supervisor !== null) {
      res.status(409).json(restartRequiredBody());
      return;
    }
    clearRestartPending();
    onboardingStep('restart', 'skipped');
    res.json(restartStatus());
  });

  app.get('/api/setup/team', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    res.json(teamStatus());
  });

  app.post('/api/setup/team', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    const choice = TeamChoiceSchema.safeParse(req.body);
    if (!choice.success) { res.status(400).json(invalidPresetBody()); return; }
    try {
      const team = applyTeam(choice.data.preset);
      onboardingStep('team', 'completed');
      res.json(team);
    } catch (error) {
      res.status(error instanceof TeamSetupError ? 409 : 500).json(teamErrorBody(error));
    }
  });

  app.get('/api/usage', async (req, res) => {
    const backend = typeof req.query.backend === 'string' ? req.query.backend : null;
    // A subscription account is measured for whoever may use it, and does not
    // exist for anyone else: same 404 as the account routes.
    const accountId = backend ? splitBackendInstance(backend).accountId : null;
    if (accountId !== null) {
      const viewer = viewerFromRequest(req);
      if (!viewer || !getBackendAccountFor(viewer, accountId)) {
        res.status(404).json(apiError('backend_unknown', 'unknown backend'));
        return;
      }
    }
    try {
      // `?refresh=1`: a person's ↻, which skips the probe's cache (checked
      // AFTER the access check above: a refused caller never reaches a probe).
      const report = await getBackendUsage(backend, req.query.refresh === '1' ? { force: true } : undefined);
      if (!report.supported) {
        res.json({ backend: report.backend, supported: false, reason: report.reason });
        return;
      }
      if (!report.connected) {
        res.json({
          backend: report.backend,
          supported: true,
          connected: false,
          reason: report.reason,
        });
        return;
      }
      res.json({ backend: report.backend, supported: true, connected: true, ...report.usage });
    } catch (e) {
      res.status(503).json({ backend: backend ?? null, ...apiError('usage_unavailable', (e as Error).message, { detail: (e as Error).message }) });
    }
  });

  app.get('/api/events/recent', (req, res) => {
    const viewer = viewerFromRequest(req);
    const scope = scopedDb(viewer);
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const rows = dbApi.listRecentEvents(limit);
    const missions = new Map<string, { agent_name: string } | null>();
    const events: Array<{
      mission_id: string;
      agent_name: string | null;
      type: string;
      timestamp: number;
      payload: unknown;
    }> = [];
    for (const e of rows) {
      if (!missions.has(e.mission_id)) {
        const m = scope.getMission(e.mission_id);
        missions.set(e.mission_id, m ? { agent_name: m.agent_name } : null);
      }
      const info = missions.get(e.mission_id);
      // Signed-in viewer without :all: drop events whose mission is not visible.
      // Superadmin / :all / anonymous loopback keep the historical unscoped list,
      // including events whose mission row has since been deleted.
      if (viewer && !viewerSeesAll(viewer, 'missions') && !info) continue;
      events.push({
        mission_id: e.mission_id,
        agent_name: info?.agent_name ?? null,
        type: e.type,
        timestamp: e.timestamp,
        payload: JSON.parse(e.payload) as unknown,
      });
    }
    res.json({ events });
  });

  app.get('/api/missions/:id/stream', sseHandler);

  app.get('/api/stream', sseHandler);

  app.get('/api/stats', (req, res) => {
    const stats = scopedDb(viewerFromRequest(req)).getStats();
    res.json({
      ...stats,
      activeMissions: stats.activeMissions.map((m) => ({
        ...m,
        running: isRunning(m.id),
      })),
    });
  });

  app.get('/api/health/resources', (_req, res) => {
    res.json({ ...resourceHealth(), liveMissions: liveMissionCount(), daemon: daemonMemory() });
  });
}
