import { setupPolicy } from '../users/setup-policy.js';
import { teamOnboardingPending } from '../onboarding-team-state.js';
import { mainAgentOnboardingPending } from '../onboarding-main-agent.js';
import { restartOnboardingPending } from '../onboarding-restart.js';
/**
 * What this installation can do — the answer of `GET /api/capabilities`.
 *
 * The front uses it to hide what does not exist rather than show dead
 * buttons: a Git tab on a machine without `git`, a Docker panel
 * without Docker. A button that fails costs more than a missing button.
 *
 * Two sources, depending on the current boot:
 *  - kernel: the REAL decisions taken by `boot.ts` (state of the tree);
 *  - legacy: an on-the-fly recomputation over the same catalogue and the same
 *    rules. The legacy mounts everything unconditionally, so this recomputation describes
 *    what the kernel would do — it is the only honest answer possible, and it
 *    keeps the front identical in both modes for the duration of the parity.
 */
import { config, loadConfig } from '../config/load.js';
import type { TimonConfig } from '../config/schema.js';
import { getHost } from '../host/index.js';
import { unsignedPluginsAllowed } from '../plugins/pubkey.js';
import { CATALOG } from './catalog.js';
import { wantedOf } from './module-config.js';
import { setActiveModules } from './module-state.js';
import { capabilitiesReport, planEntries, type CapabilitiesReport, type EntryDecision, type ModuleTier } from './registry.js';
import { effectiveEdition } from '../license/license.js';
import { bootLicenseState } from '../license/refresh.js';
import { applyBuildPolicy } from '../license/build-policy.js';
import { whiteLabelAllowed } from '../license/capabilities.js';
import { licenseState } from '../license/runtime.js';
import { isFirstRun } from '../setup.js';
import { timonVersion } from '../data-version.js';

let live: { decisions: EntryDecision[]; capabilities: string[]; edition: 'lite' | 'expert' } | null = null;

/** Set by `boot.ts`: the real state wins over any recomputation. */
export function setLiveDecisions(decisions: EntryDecision[], capabilities: string[], edition: 'lite' | 'expert'): void {
  live = { decisions, capabilities, edition };
  // Code outside the modules (agent spawn, plugin context) asks "is this
  // module running?" without being able to import this file — see
  // `kernel/module-state.ts`. Set here, so at boot AND on every hot
  // toggle, never in two calls we would end up forgetting to pair.
  setActiveModules(decisions.filter((d) => !d.disabled).map((d) => d.id));
}

/**
 * Contract level between an interface and this daemon (multi-machine, TODO #329).
 *
 * An app relays its whole UI to whichever machine is active; that machine may
 * run another version. `version` is informative, this integer is what an
 * interface compares against the range it supports, and refuses to switch
 * outside of it (the maintainer's arbitration: `apiLevel` blocks, semver informs).
 *
 * Bump it — and only then — when a change breaks what an interface of the
 * previous level sends or reads: a route removed or renamed, a field whose
 * meaning or type changes, a new requirement on a request. Adding a route or
 * an optional field is not a break. The app holds its own `APP_API_LEVEL`.
 */
export const API_LEVEL = 1;

export type CapabilitiesPayload = CapabilitiesReport & {
  /** This daemon's version (`orchestrator/package.json`), shown, never compared. */
  version: string;
  /** See `API_LEVEL`: the integer an interface checks before switching here. */
  apiLevel: number;
  /** UI zones hidden by the configuration, even when their module runs. */
  ui: { hidden: string[]; home: string };
  /** `true` when the Cordis tree is really mounted, that is as soon as
   *  `boot.ts` has finished its activation audit. False before, and in the tests that
   *  query the catalogue without booting. */
  kernel: boolean;
  developer: { unsignedPlugins: boolean };
  /** `true` while `timon.config.json` is absent: the front shows the first-run
   *  wizard (§5.4) instead of a cockpit built on defaults nobody chose. */
  firstRun: boolean;
  teamOnboarding: boolean;
  /** `true` while step 3 (naming the main agent) has not been answered. The
   *  first-run gate routes there before the team screen. */
  mainAgentOnboarding: boolean;
  /** `true` while the daemon is still the process that wrote
   *  `timon.config.json` — the last step of the wizard waits for its restart. */
  restartOnboarding: boolean;
  beta: boolean;
  /** Whether a layout plugin may replace the whole interface here. The only
   *  licence detail the browser gets for it: neither the plan nor the signed
   *  features, just the answer its second barrier needs. */
  whitelabel: boolean;
};

/**
 * The decisions the daemon stands by right now — live ones when the kernel has
 * booted, the same computation replayed otherwise.
 *
 * Extracted so that the gallery (`GET /api/plugins`) and `/api/capabilities`
 * answer from ONE source. Recomputing on the gallery side would drop the
 * licence whitelist and show a licensed module as running on the very screen
 * where capabilities says it is not.
 */
function resolveDecisions(): { decisions: EntryDecision[]; capabilities: string[]; effectiveConfig: TimonConfig } {
  const cfg = config();
  // Same read as the boot, offline tolerance included (`refresh.ts`).
  // The build's channel has its word too: a beta build is never Free here either.
  const diskLicense = applyBuildPolicy(bootLicenseState());
  const edition = live?.edition ?? effectiveEdition(cfg.edition, diskLicense.edition);
  const effectiveConfig = { ...cfg, edition };
  // Outside a kernel boot (tests, CLI), the host answers the same thing `boot.ts`
  // would have made it say: it is the same `capabilities()`.
  const capabilities = live ? live.capabilities : getHost().capabilities();
  const decisions = live
    ? live.decisions
    : planEntries(CATALOG, {
        config: effectiveConfig,
        capabilities,
        license: diskLicense,
        licensed: diskLicense.modules === '*' ? CATALOG.filter((m) => m.licensed).map((m) => m.id) : diskLicense.modules,
      });
  return { decisions, capabilities, effectiveConfig };
}

/** One bundled module, as the gallery needs it (plan §10.12). */
export type BundledModuleRow = {
  id: string;
  tier: ModuleTier;
  /** What the kernel does with it right now — licence and host caps included. */
  active: boolean;
  reason: string | null;
  missing: string[];
  /** Running but degraded by a missing host capability (`ModuleDescriptor.recommends`). */
  warning?: string | null;
  /** What the config asks for. Drives the switch, see below. */
  wanted: boolean | 'auto';
};

/**
 * The bundled half of the gallery. `active` is the daemon's reality, `wanted`
 * is the user's wish. They are still two fields although the tree is now
 * recomposed during the toggle request (`kernel/bundled-reload.ts`): a module
 * the daemon refuses to run — licence, missing host capability — is off while
 * the config asks for it, and the switch must keep showing the wish rather than
 * flipping back on its own.
 *
 * `wanted` is re-read from the file on every call, never from the process
 * singleton, because the toggle has just written it.
 */
export function bundledModuleRows(): BundledModuleRow[] {
  const { decisions } = resolveDecisions();
  const onDisk = loadConfig();
  return decisions.map((d) => ({
    id: d.id,
    tier: d.tier,
    active: !d.disabled,
    reason: d.reason,
    missing: d.missing,
    warning: d.warning ?? null,
    wanted: wantedOf(onDisk.modules[d.id]),
  }));
}

export function capabilitiesPayload(): CapabilitiesPayload {
  const { decisions, capabilities, effectiveConfig } = resolveDecisions();
  const cfg = config();

  return {
    ...capabilitiesReport(decisions, { config: effectiveConfig, capabilities }),
    version: timonVersion(),
    apiLevel: API_LEVEL,
    ui: { hidden: [...cfg.ui.hidden], home: cfg.ui.home },
    kernel: live !== null,
    developer: { unsignedPlugins: unsignedPluginsAllowed(cfg.developer.unsignedPlugins) },
    firstRun: isFirstRun(),
    teamOnboarding: teamOnboardingPending(),
    mainAgentOnboarding: mainAgentOnboardingPending(),
    restartOnboarding: restartOnboardingPending(),
    beta: setupPolicy() === 'beta',
    // The state the plugin loader reads, so the two barriers never disagree.
    whitelabel: whiteLabelAllowed(licenseState()),
  };
}
