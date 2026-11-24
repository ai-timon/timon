/**
 * Onboarding step 5 — the restart, which is no longer optional.
 *
 * `timon.config.json` is read ONCE, at boot: the daemon that wrote it during
 * setup is still running on the defaults the wizard just replaced. Until now
 * the restart was advice at the bottom of a confirmation dialog, with a "later"
 * button next to it — so the normal ending of onboarding was a cockpit served
 * by a daemon that knew nothing about the configuration its owner had just
 * chosen. Pinned binaries invisible, modules still at their defaults, and every
 * symptom blamed on the wrong thing.
 *
 * It is now the last step of the wizard, and the first-run gate holds there.
 * Which means "has it restarted?" must be answerable, and unfakeable by a
 * browser reload:
 *
 *   The pending marker holds the BOOT ID of the process that wrote the config.
 *   A process compares it to its own. Equal → this is still that very process,
 *   the restart has not happened. Different (or absent) → a new process is
 *   serving, which is exactly what the step was waiting for.
 *
 * Nothing is written at boot, so the check self-heals: a home carried to
 * another machine, a daemon killed mid-step, a value left over from an install
 * that never finished — all answer "not pending" on the next process.
 */
import { randomUUID } from 'node:crypto';
import { CONFIG_FILE } from './config/load.js';
import { dbApi } from './db.js';
import { diagnose } from './doctor.js';
import { getHost } from './host/index.js';
import { LAUNCHD_SYSTEM_KIND, LINUX_UNIT, MACOS_LABEL, WINDOWS_TASK } from './host/service-install.js';
import { ownLinuxUnit } from './host/packaged-service.js';
import { TIMON_HOME } from './paths.js';
import { mainAgentOnboardingPending } from './onboarding-main-agent.js';
import { teamOnboardingPending } from './onboarding-team-state.js';
import type { SupervisorKind } from './host/machine.js';

/** Settings key holding the boot id of the process awaiting its restart. */
export const RESTART_STEP_KEY = 'onboarding.restart.v1';

/** This process, for as long as it lives. Never persisted on its own. */
const BOOT_ID = randomUUID();

/** Arms the step for THIS process. Kept exported for the tests and for
 *  `armRestartForFirstSetup`, which holds the conditions. */
export function markRestartPending(): void {
  dbApi.setSetting(RESTART_STEP_KEY, BOOT_ID);
}

/**
 * The ONLY legitimate arming: the end of a first setup (the maintainer, 12/09/2026).
 *
 * Restarting the daemon is not a harmless refresh — the agent processes are its
 * children and die with it. It is worth doing exactly once, when a machine that
 * had no `timon.config.json` has just been given one and is serving nothing yet.
 * Every other write of that file happens on an instance that is ALIVE:
 *
 *   - a re-save over an existing configuration (wizard replayed, settings):
 *     `applySetup` reports `firstSetup: false`;
 *   - resuming an existing installation (`resumeExistingInstance`): the daemon
 *     writes the missing file for an install that already holds agents, work
 *     and possibly running missions. It simply never calls this function;
 *   - a config written anywhere else than `CONFIG_FILE`: a test probe
 *     configures nothing this daemon reads.
 *
 * The condition lives here rather than in the route because the route is one
 * caller among several — `/api/setup` today, whatever writes a configuration
 * tomorrow.
 */
export function armRestartForFirstSetup(written: { path: string; firstSetup: boolean }): boolean {
  if (written.path !== CONFIG_FILE || !written.firstSetup) return false;
  markRestartPending();
  return true;
}

/**
 * Steps the wizard still owes an answer for, which the restart must not jump
 * over: step 3 names the orchestrator, step 4 builds the team, and both write
 * into the home this daemon is serving. A restart in the middle of that is a
 * daemon killed between two writes of the parcours it is running.
 *
 * COMPOSED from the two predicates the client gate decides with
 * (`firstRunTarget`), never re-derived: a daemon that refuses on a condition
 * the gate does not know sends the user to step 5 and then answers 409 —
 * a gate nobody can satisfy, since `/skip` refuses on a supervised machine.
 * `mainAgentOnboardingPending` carries its own `teamOnboardingPending()`
 * clause, which is what makes a `null` team state (an install from before
 * these steps existed, or one the seed declared ineligible) mean "the steps do
 * not apply" rather than "pending forever".
 */
export function onboardingStepsPending(): boolean {
  return teamOnboardingPending() || mainAgentOnboardingPending();
}

/** Is the daemon still the one that wrote the configuration? */
export function restartOnboardingPending(): boolean {
  return dbApi.getAllSettings()[RESTART_STEP_KEY] === BOOT_ID;
}

/**
 * Forgets the marker. Used by the step itself on a machine where no supervisor
 * can restart anything (portable mode): there is no process to wait for, and a
 * gate nobody can satisfy is worse than a configuration read one boot late.
 */
export function clearRestartPending(): void {
  dbApi.deleteSetting(RESTART_STEP_KEY);
}

/**
 * The command that restarts the daemon on this machine, as a line a human can
 * paste. Shown when the daemon cannot (or must not) do it itself: a packaged
 * install without a supervisor, or a host adapter whose `selfRestart` is inert.
 */
export function restartCommand(
  supervisor: SupervisorKind,
  launchDaemon: boolean = process.env.TIMON_SERVICE_KIND === LAUNCHD_SYSTEM_KIND,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (supervisor === 'systemd-user') return `systemctl --user restart ${ownLinuxUnit(LINUX_UNIT, TIMON_HOME, env)}`;
  if (supervisor === 'launchd') {
    // The system domain only takes orders from root.
    return launchDaemon
      ? `sudo launchctl kickstart -k system/${MACOS_LABEL}`
      : `launchctl kickstart -k gui/$(id -u)/${MACOS_LABEL}`;
  }
  if (supervisor === 'windows') return `schtasks /End /TN ${WINDOWS_TASK} && schtasks /Run /TN ${WINDOWS_TASK}`;
  return null;
}

export type RestartStatus = {
  /** Still the process that wrote the configuration. */
  pending: boolean;
  supervisor: SupervisorKind;
  /** `true` when the daemon can restart itself — the button does the work. */
  canSelfRestart: boolean;
  /** The line to paste otherwise, or when the attempt fails. */
  command: string | null;
};

/**
 * The one thing that actually restarts the machine's daemon, and the only seam
 * a test may replace.
 *
 * A test that reaches `POST /api/setup/restart` used to exec
 * `systemctl --user restart timon-orchestrator` for real: `TIMON_HOME` isolates
 * the home, never the operating system's services. Three runs of the suite on
 * 12/09/2026 restarted the live daemon three times and killed the missions
 * running under it, including the one running the suite.
 */
export type SelfRestartPort = {
  supervisor: SupervisorKind;
  /** Whether this machine has something able to bring the daemon back up. */
  canSelfRestart: boolean;
  restart: () => void;
};

/** Internal seam for the restart tests, and nothing else: it is the only way
 *  to observe the step's decisions without restarting the machine's daemon.
 *  Never set by production code. */
let port: SelfRestartPort | null = null;

/** Memoised: the supervisor cannot change within a process, and this status is
 *  POLLED while the step waits — `diagnose()` execs, it must not run per poll. */
let detected: SupervisorKind | undefined;

/** A restart is asked for ONCE per process: the step polls, and a double click
 *  must not queue a second signal. */
let requested = false;

export function setSelfRestartPortForTests(next: SelfRestartPort | null): void {
  port = next;
  detected = undefined;
  requested = false;
}

/**
 * Why this process must not restart the daemon itself, or `null`.
 *
 * Under `node --test` the answer is always "the test runner": whatever the
 * suite has isolated, `systemctl` and `launchctl` talk to the real machine.
 * A test that wants to observe the step injects a port instead.
 */
export function selfRestartRefusal(): 'test-runner' | null {
  return process.env.NODE_TEST_CONTEXT ? 'test-runner' : null;
}

/** Performs the real restart, unless something forbids it. `services` is a
 *  parameter so the refusal itself is testable without a system process. */
export function performSelfRestart(services: { selfRestart: () => void } = getHost().services): boolean {
  if (selfRestartRefusal() !== null) return false;
  services.selfRestart();
  return true;
}

export function restartStatus(): RestartStatus {
  if (detected === undefined) detected = port ? port.supervisor : diagnose().supervisor;
  const supervisor = detected;
  return {
    pending: restartOnboardingPending(),
    supervisor,
    // `selfRestart` is only implemented by the systemd host; the generic one is
    // a no-op, and a button wired to a no-op waits forever.
    canSelfRestart: port
      ? port.canSelfRestart
      : supervisor === 'systemd-user' && getHost().capabilities().includes('systemd'),
    command: restartCommand(supervisor),
  };
}

/** What the step answers, so the route stays a mapper and the decision stays
 *  here — a 200 that restarts nothing is how this step lied before. */
export type RestartOutcome =
  | { ok: true; alreadyRequested: boolean }
  | { ok: false; reason: 'setup_complete' | 'steps_pending' | 'restart_not_available'; command: string | null };

/** Delay before the signal: the HTTP answer must have left the process. */
const SIGNAL_DELAY_MS = 150;

/**
 * Restarts the daemon — this process dies. The answer must be written BEFORE
 * the signal lands, which is what the delay buys.
 */
export function restartForOnboarding(): RestartOutcome {
  if (!restartOnboardingPending()) return { ok: false, reason: 'setup_complete', command: null };
  if (onboardingStepsPending()) return { ok: false, reason: 'steps_pending', command: null };
  const status = restartStatus();
  if (!status.canSelfRestart) {
    return { ok: false, reason: 'restart_not_available', command: status.command };
  }
  if (requested) return { ok: true, alreadyRequested: true };
  requested = true;
  const effect = port;
  setTimeout(() => (effect ? effect.restart() : performSelfRestart()), SIGNAL_DELAY_MS);
  return { ok: true, alreadyRequested: false };
}
