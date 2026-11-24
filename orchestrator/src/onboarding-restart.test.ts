import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const { CONFIG_FILE } = await import('./config/load.js');
const { db, dbApi } = await import('./db.js');
const {
  RESTART_STEP_KEY, armRestartForFirstSetup, clearRestartPending, markRestartPending, onboardingStepsPending,
  performSelfRestart, restartCommand, restartForOnboarding, restartOnboardingPending, restartStatus,
  selfRestartRefusal, setSelfRestartPortForTests,
} = await import('./onboarding-restart.js');
const { MAIN_AGENT_STEP_KEY } = await import('./onboarding-main-agent.js');
const { TEAM_STATE_KEY } = await import('./onboarding-team-state.js');
const { applySetup } = await import('./setup.js');
const { resumeExistingInstance } = await import('./onboarding-resume.js');
const { capabilitiesPayload } = await import('./kernel/capabilities.js');
const { ownLinuxUnit, packagedUnit } = await import('./host/packaged-service.js');
const { TIMON_HOME } = await import('./paths.js');

/** Steps 3 and 4 answered — what the end of a first setup looks like. */
function stepsAnswered() {
  dbApi.setSetting(MAIN_AGENT_STEP_KEY, 'complete');
  dbApi.setSetting(TEAM_STATE_KEY, JSON.stringify({ status: 'complete' }));
}

function reset() {
  rmSync(CONFIG_FILE, { force: true });
  dbApi.deleteSetting(RESTART_STEP_KEY);
  dbApi.deleteSetting(TEAM_STATE_KEY);
  stepsAnswered();
}

test('the step is pending for the process that wrote the config, and for no other', () => {
  reset();
  assert.equal(restartOnboardingPending(), false, 'nothing written: nothing to wait for');
  markRestartPending();
  assert.equal(restartOnboardingPending(), true);
  // What another process would read: the marker holds a boot id, not a flag, so
  // a daemon that did not write it answers "not pending" without any write of
  // its own. A browser reload cannot satisfy the step; a restart can.
  dbApi.setSetting(RESTART_STEP_KEY, 'another-process');
  assert.equal(restartOnboardingPending(), false);
  markRestartPending();
  clearRestartPending();
  assert.equal(restartOnboardingPending(), false);
});

test('the end of a FIRST setup arms the step, and capabilities says so', () => {
  reset();
  assert.equal(capabilitiesPayload().restartOnboarding, false);
  // Writing alone no longer arms anything: the caller says whether this write
  // was a first setup, and the arming function is what decides.
  const written = applySetup({ edition: 'expert', supervisor: 'none' });
  assert.equal(written.firstSetup, true);
  assert.equal(restartOnboardingPending(), false, 'the write on its own arms nothing');
  assert.equal(armRestartForFirstSetup(written), true);
  assert.equal(restartOnboardingPending(), true);
  assert.equal(capabilitiesPayload().restartOnboarding, true);
  assert.equal(restartStatus().pending, true);
});

test('a re-save over an existing configuration is not a first setup', () => {
  reset();
  armRestartForFirstSetup(applySetup({ edition: 'expert', supervisor: 'none' }));
  clearRestartPending();
  // The wizard replayed, or a configuration saved again: the instance is alive,
  // its agents are the daemon's children, and nothing here asks for a restart.
  const again = applySetup({ edition: 'lite', supervisor: 'none' }, CONFIG_FILE, true);
  assert.equal(again.firstSetup, false);
  assert.equal(armRestartForFirstSetup(again), false);
  assert.equal(restartOnboardingPending(), false);
});

test('a config written elsewhere arms nothing: only the real file is the daemon\'s', () => {
  reset();
  const probe = applySetup({ edition: 'expert', supervisor: 'none' }, `${CONFIG_FILE}.probe`);
  assert.equal(probe.firstSetup, false);
  assert.equal(armRestartForFirstSetup(probe), false);
  assert.equal(restartOnboardingPending(), false);
  rmSync(`${CONFIG_FILE}.probe`, { force: true });
});

test('resuming an existing installation never arms the step', () => {
  reset();
  // An install with work of its own: `resumeExistingInstance` writes the
  // configuration it was missing and closes the remaining steps. It keeps
  // running — a restart there would kill the missions it already holds.
  db.prepare('INSERT INTO projects (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('resume-probe', 'resume probe', Date.now(), Date.now());
  try {
    resumeExistingInstance({ supervisor: 'none' });
    assert.equal(restartOnboardingPending(), false);
    assert.equal(capabilitiesPayload().restartOnboarding, false);
  } finally {
    db.prepare('DELETE FROM projects WHERE slug = ?').run('resume-probe');
  }
});

test('the restart never jumps over a step the wizard still owes', () => {
  reset();
  markRestartPending();
  setSelfRestartPortForTests({ supervisor: 'systemd-user', canSelfRestart: true, restart: () => {
    throw new Error('a pending step must never reach the supervisor');
  } });
  try {
    // Step 3 unanswered, on an install eligible for the team step: the
    // orchestrator has no name yet, and step 4 writes into the home this
    // daemon is serving.
    dbApi.setSetting(TEAM_STATE_KEY, JSON.stringify({ status: 'pending' }));
    dbApi.deleteSetting(MAIN_AGENT_STEP_KEY);
    assert.equal(onboardingStepsPending(), true);
    assert.deepEqual(restartForOnboarding(), { ok: false, reason: 'steps_pending', command: null });
    // Step 3 answered, step 4 not.
    dbApi.setSetting(MAIN_AGENT_STEP_KEY, 'complete');
    assert.equal(onboardingStepsPending(), true);
    assert.deepEqual(restartForOnboarding(), { ok: false, reason: 'steps_pending', command: null });
    // Both answered: the ending of the wizard, and only there.
    stepsAnswered();
    assert.equal(onboardingStepsPending(), false);
    // An install the team step never applied to (no state at all): the same
    // answer as the client gate gives, or step 5 would be a dead end — the
    // gate sends the user here and `/skip` refuses on a supervised machine.
    dbApi.deleteSetting(TEAM_STATE_KEY);
    dbApi.deleteSetting(MAIN_AGENT_STEP_KEY);
    assert.equal(onboardingStepsPending(), false);
  } finally {
    setSelfRestartPortForTests(null);
    clearRestartPending();
  }
});

test('each supervisor has a command a human can paste, and portable mode has none', () => {
  assert.equal(restartCommand('systemd-user', false, {}), 'systemctl --user restart timon-orchestrator');
  assert.match(restartCommand('launchd', false)!, /^launchctl kickstart -k gui\/\$\(id -u\)\/com\.timon\.daemon$/);
  assert.equal(restartCommand('launchd', true), 'sudo launchctl kickstart -k system/com.timon.daemon');
  assert.match(restartCommand('windows')!, /^schtasks \/End \/TN TimonOrchestrator && schtasks \/Run \/TN TimonOrchestrator$/);
  // No supervisor: nothing will restart on its own, and the step says so rather
  // than offering a command that does not exist.
  assert.equal(restartCommand(null), null);
});

test('a packaged Linux service is restarted under its own unit, not the source checkout\'s', () => {
  const unit = packagedUnit(TIMON_HOME);
  assert.match(unit, /^timon-desktop-[0-9a-f]{24}$/);
  assert.equal(restartCommand('systemd-user', false, { TIMON_DESKTOP_SERVICE: '1' }), `systemctl --user restart ${unit}`);
  assert.equal(ownLinuxUnit('timon-orchestrator', TIMON_HOME, { TIMON_DESKTOP_SERVICE: '1' }), unit);
  assert.equal(ownLinuxUnit('timon-orchestrator', TIMON_HOME, {}), 'timon-orchestrator');
});

test('the daemon only offers to restart itself where it actually can', () => {
  const status = restartStatus();
  // Machine-dependent by design — what must hold everywhere is the implication:
  // a self-restart is only ever offered with a supervisor behind it.
  assert.equal(status.canSelfRestart && status.supervisor === null, false);
  assert.equal(status.canSelfRestart ? status.supervisor : 'systemd-user', 'systemd-user');
  assert.equal(status.command === null, status.supervisor === null);
});

test('under the test runner the daemon never restarts the machine\'s service', () => {
  // `TIMON_HOME` isolates the home, NOT the operating system's services: this
  // very refusal is what stops a suite from restarting the live daemon — and
  // killing the missions running under it, the suite's own included.
  assert.equal(selfRestartRefusal(), 'test-runner');
  let execed = false;
  assert.equal(performSelfRestart({ selfRestart: () => { execed = true; } }), false);
  assert.equal(execed, false, 'no supervisor call is ever made from a test');
});

test('the routes close once the step is answered: no restart of a live daemon', async () => {
  reset();
  // Injected BEFORE the server exists: the route restarts the daemon for real
  // otherwise, and the assertions below would depend on the machine running
  // them (systemd → 200, anything else → 409).
  let restarts = 0;
  let signalled: (() => void) | undefined;
  const signal = new Promise<void>((resolve) => { signalled = resolve; });
  setSelfRestartPortForTests({
    supervisor: 'systemd-user',
    canSelfRestart: true,
    restart: () => { restarts += 1; signalled?.(); },
  });
  const express = (await import('express')).default;
  const { registerRoutes } = await import('./plugins-bundled/http/routes.js');
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/setup/restart`;
  try {
    // Nothing pending — onboarding is over, or never armed this process. A
    // restart here would kill every mission running under the daemon, and a
    // stale tab left on step 5 must not be able to ask for one.
    const answeredPost = await fetch(base, { method: 'POST' });
    assert.equal(answeredPost.status, 409);
    assert.equal(((await answeredPost.json()) as { code?: string }).code, 'setup_already_complete');
    const skipped = await fetch(`${base}/skip`, { method: 'POST' });
    assert.equal(skipped.status, 409);
    assert.deepEqual(await skipped.json(), { error: 'Setup is already complete.', code: 'setup_already_complete' });
    // Reading stays harmless, and says the step is answered.
    const answered = await (await fetch(base)).json() as { pending: boolean };
    assert.equal(answered.pending, false);
    assert.equal(restarts, 0, 'a closed step signals nothing');

    // Armed, at the end of the first setup: accepted, and the signal is fired.
    markRestartPending();
    const armed = await fetch(base, { method: 'POST' });
    assert.equal(armed.status, 200);
    assert.deepEqual(await armed.json(), { restarting: true, alreadyRequested: false });
    // A double click must not queue a second supervisor call.
    const again = await fetch(base, { method: 'POST' });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { restarting: true, alreadyRequested: true });
    await signal;
    assert.equal(restarts, 1);

    // A machine with nothing to bring the daemon back up gets the command to
    // paste, never a 200 that restarts nothing.
    setSelfRestartPortForTests({ supervisor: 'systemd-user', canSelfRestart: false, restart: () => { restarts += 1; } });
    const unavailable = await fetch(base, { method: 'POST' });
    assert.equal(unavailable.status, 409);
    assert.deepEqual(await unavailable.json(), {
      restarting: false, error: 'Timon cannot restart itself on this machine.', code: 'setup_restart_unavailable',
      command: 'systemctl --user restart timon-orchestrator',
    });
    assert.equal(restarts, 1);
  } finally {
    setSelfRestartPortForTests(null);
    server.close();
  }
});
