import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerMessage,
  PATH_DEFAULTS,
  canFinish,
  apiKeyCards,
  backendCards,
  missingLogin,
  noBackendInstalled,
  backendReady,
  shouldAutoWrite,
  needsHandover,
  missingPrerequisites,
  serviceInstallable,
  supervisorToWrite,
  configureTarget,
  gateAction,
  phaseAfterInstall,
  preparationHeadline,
  preparationItems,
  preparationProgress,
  ACCOUNT_POLL_MS,
  pollsForAccount,
  preparationStarts,
  preparationVisible,
  serviceReady,
  servicePhaseFrom,
  setupAnswers,
  shouldInstallService,
  stepNeedsService,
  statusFailure,
  SERVICE_STEPS,
  type ServicePhase,
  type ServiceStatusRead,
  type SetupBinary,
  type SetupDoctor,
  type SetupProvider,
} from './setup-plan';

/** What the daemon sends for the AI CLIs of the product's providers (`doctor.ts`, from their declarations). */
const PROVIDERS: Record<string, SetupProvider> = {
  codex: { id: 'codex', label: 'GPT', brand: 'openai', order: 1, suggested: true, seedsMainAgent: true },
  claude: { id: 'claude', label: 'Claude', brand: 'anthropic', order: 2, suggested: false, seedsMainAgent: true },
  grok: { id: 'grok', label: 'Grok', brand: 'xai', order: 3, suggested: false, seedsMainAgent: true },
  copilot: { id: 'copilot', label: 'Copilot', brand: 'github', order: 4, suggested: false, seedsMainAgent: true },
  opencode: { id: 'opencode', label: 'opencode', brand: 'opencode', order: 5, suggested: false, seedsMainAgent: false },
  'hermes-acp': { id: 'hermes', label: 'Hermes', brand: 'nous', order: 6, suggested: false, seedsMainAgent: false },
  pi: { id: 'pi', label: 'Pi', brand: 'pi', order: 7, suggested: false, seedsMainAgent: false },
};

/** A binary report, with its provider when it is an AI CLI. */
function binary(name: string, ok: boolean, installCommand: string | null = null): SetupBinary {
  return { name, ok, path: ok ? `/usr/bin/${name}` : null, installCommand, ...(PROVIDERS[name] ? { provider: PROVIDERS[name] } : {}) };
}

function doctor(over: Partial<SetupDoctor> = {}): SetupDoctor {
  return {
    platform: 'linux',
    supervisor: 'systemd-user',
    linux: { id: 'ubuntu', prettyName: 'Ubuntu 24.04', packageManager: 'apt' },
    binaries: [
      { name: 'node', ok: true, path: '/usr/bin/node', installCommand: 'sudo apt-get install -y nodejs' },
      { name: 'git', ok: true, path: '/usr/bin/git', installCommand: 'sudo apt-get install -y git' },
      { ...binary('claude', true, 'npm install -g @anthropic-ai/claude-code'), path: '/home/user/.local/bin/claude' },
      binary('codex', false, 'npm install -g @openai/codex'),
      binary('grok', false),
      { name: 'docker', ok: false, path: null, installCommand: 'sudo apt-get install -y docker.io' },
    ],
    blockers: [],
    ...over,
  };
}

/** The machine dictates the answer: it is no longer a drop-down menu. */
test('the written supervisor is the one the machine imposes', () => {
  assert.equal(supervisorToWrite({ supervisor: 'systemd-user' }), 'systemd-user');
  assert.equal(supervisorToWrite({ supervisor: 'launchd' }), 'launchd');
  assert.equal(supervisorToWrite({ supervisor: 'windows' }), 'windows');
  // No installable supervisor (Linux without systemd): portable mode.
  assert.equal(supervisorToWrite({ supervisor: null }), 'none');
  assert.equal(serviceInstallable({ supervisor: null }), false);
});

test('the missing prerequisites are listed, the blocking ones first', () => {
  const missing = missingPrerequisites(doctor());
  // Claude is already there: Codex, Grok and Docker do not clutter the onboarding.
  assert.deepEqual(missing, []);
});

test('with no backend at all, Codex is offered as the only automatic install', () => {
  const d = doctor();
  const claude = d.binaries.find((b) => b.name === 'claude');
  if (claude) { claude.ok = false; claude.path = null; }
  const missing = missingPrerequisites(d);
  assert.deepEqual(missing.filter((m) => m.required).map((m) => m.name), ['codex']);
});

test('a missing node is blocking, and comes first', () => {
  const d = doctor();
  for (const b of d.binaries) if (b.name === 'node' || b.name === 'git') { b.ok = false; b.path = null; }
  const missing = missingPrerequisites(d);
  assert.deepEqual(missing.map((m) => [m.name, m.required]), [['node', true], ['git', false]]);
});

/** TODO #275: without git, Timon and its Kanban run; git is offered, never required. */
test('a missing git is recommended, never blocking', () => {
  const d = doctor();
  const git = d.binaries.find((b) => b.name === 'git');
  if (git) { git.ok = false; git.path = null; }
  const missing = missingPrerequisites(d);
  assert.deepEqual(missing.map((m) => [m.name, m.required]), [['git', false]]);
  assert.equal(missing.some((m) => m.required), false);
});

/**
 * The heart of the step: the screen BLOCKS as long as the service does not answer. A
 * screen that let you through with a dead daemon produced an install that
 * looked done and did nothing.
 */
test('you cannot finish as long as no supervisor is registered', () => {
  assert.equal(canFinish({ doctor: doctor(), serviceInstalled: false, serviceRunning: false }), false);
  assert.equal(canFinish({ doctor: doctor(), serviceInstalled: true, serviceRunning: true }), true);
  assert.equal(canFinish({ doctor: null, serviceInstalled: true, serviceRunning: true }), false);
});

/**
 * The trap of step 5.7.6: on the first launch of a package, the daemon that
 * SERVES this screen is the embedded one, and it holds the port the service wants. The
 * service therefore cannot start before the user relaunches. Blocking
 * on "running" would lock the screen exactly where it matters most.
 */
test('a service installed but not started yet lets you finish, and asks for the handover', () => {
  const state = { doctor: doctor(), serviceInstalled: true, serviceRunning: false };
  assert.equal(canFinish(state), true);
  assert.equal(needsHandover(state), true);
  assert.equal(needsHandover({ ...state, serviceRunning: true }), false);
});

test('a machine with no possible supervisor is not locked out', () => {
  // Refusing here would lock the user out over a fact they cannot
  // change: they get the portable mode, and the screen says so.
  assert.equal(
    canFinish({ doctor: doctor({ supervisor: null }), serviceInstalled: false, serviceRunning: false }),
    true,
  );
});

/**
 * `canFinish` ALSO carries the reveal of the rest of the screen (onboarding.2):
 * as long as it is false, only the "Daemon service" block is shown.
 *
 * Hence this test: on a machine with no supervisor, the service block is not
 * rendered at all (`serviceInstallable` is false) and `serviceInstalled` can
 * NEVER become true. Revealing on `serviceInstalled` would show an
 * empty page there, with no way out of it.
 */
test('the portable mode sees the rest of the screen, otherwise it would see nothing', () => {
  const portable = doctor({ supervisor: null });
  assert.equal(serviceInstallable(portable), false);
  assert.equal(canFinish({ doctor: portable, serviceInstalled: false, serviceRunning: false }), true);
  // And the normal case stays closed as long as the service has not answered.
  assert.equal(canFinish({ doctor: doctor(), serviceInstalled: false, serviceRunning: false }), false);
});

test('a failure shows the reason AND the command to paste', () => {
  const msg = answerMessage({
    ok: false,
    reason: 'systemctl refused: Interactive authentication required.',
    command: 'timon service install',
  });
  assert.match(msg.text, /Interactive authentication required/);
  assert.equal(msg.command, 'timon service install');

  // A success shows no command to paste.
  assert.deepEqual(answerMessage({ ok: true, lines: ['service installed'] }), {
    text: 'service installed',
    command: null,
  });
});

test('no work folder is asked for, the vault stays empty by default', () => {
  assert.deepEqual(Object.keys(PATH_DEFAULTS), ['vaultPath']);
  // Empty = automatic detection by the daemon.
  assert.equal(PATH_DEFAULTS.vaultPath, '');
});

/**
 * The backend error rule belongs to the daemon, not to the screen.
 *
 * `doctor.ts` pushes `no LLM backend installed (...)` into `blockers` only if
 * NONE of the three is found. The screen reads that verdict; it does not recompute the
 * condition, otherwise the two implementations drift and the UI raises an alarm on a
 * machine the daemon deems healthy (or stays quiet on one it refuses).
 */
test('the backend fallback follows the daemon blocker, never a second computation', () => {
  // The exact string orchestrator/src/doctor.ts produces.
  const none = doctor({ blockers: ['no LLM backend installed (claude, codex, grok, copilot)'] });
  assert.equal(noBackendInstalled(none), true);

  // A single backend present: the daemon does not block, neither does the screen — even
  // if the two other binaries are missing from `binaries`.
  assert.equal(noBackendInstalled(doctor()), false);
  assert.equal(doctor().binaries.filter((b) => ['claude', 'codex', 'grok'].includes(b.name) && b.ok).length, 1);

  // Another blocker does not trigger the fallback.
  assert.equal(noBackendInstalled(doctor({ blockers: ['git not found'] })), false);
});

test('the backend cards are the ones the daemon declares, in its order', () => {
  const all = doctor({ binaries: Object.keys(PROVIDERS).reverse().map((name) => binary(name, false)).concat([binary('node', true)]) });
  const cards = backendCards(all);
  assert.deepEqual(cards.map((c) => c.name), ['codex', 'claude', 'grok', 'copilot', 'opencode', 'hermes-acp', 'pi']);
  // One brand per card: `BrandMark` renders them from brand-icons, without an extra
  // asset.
  assert.deepEqual(cards.map((c) => c.brand), ['openai', 'anthropic', 'xai', 'github', 'opencode', 'nous', 'pi']);
  assert.deepEqual(cards.map((c) => c.label), ['GPT', 'Claude', 'Grok', 'Copilot', 'opencode', 'Hermes', 'Pi']);
  // A binary without a provider is not a card; a third-party provider that declares itself is.
  const third = binary('acme', false);
  assert.deepEqual(backendCards(doctor({ binaries: [third, { ...third, name: 'acme-agent', provider: { id: 'acme', label: 'Acme', brand: null, order: 8, suggested: false, seedsMainAgent: false } }] })).map((c) => c.name), ['acme-agent']);
});

test('the API key cards name the CLI that carries them', () => {
  const apiKeyProviders = [
    { id: 'deepseek', label: 'DeepSeek', brand: 'deepseek', via: 'claude', viaLabel: 'Claude' },
    { id: 'ollama-cloud', label: 'Ollama Cloud', brand: 'ollama', via: 'codex', viaLabel: 'Codex' },
  ];
  assert.deepEqual(apiKeyCards(doctor({ apiKeyProviders })).map((c) => [c.id, c.via]), [['deepseek', 'claude'], ['ollama-cloud', 'codex']]);
  assert.deepEqual(apiKeyCards(doctor()), []);
});

test('the backend block hides as soon as a backend works as is', () => {
  assert.equal(backendReady(null), false);
  assert.equal(backendReady(doctor()), true);
  const codexOnly = doctor({ binaries: [binary('codex', true)] });
  const auth = (ok: boolean) => [{ provider: 'codex', binary: 'codex', ok, detail: 'd', signInCommand: ok ? null : 'codex login', path: '/h/.codex/auth.json' }];
  assert.equal(backendReady({ ...codexOnly, auth: auth(false) }), false);
  assert.equal(backendReady({ ...codexOnly, auth: auth(true) }), true);
  assert.deepEqual(missingLogin({ ...codexOnly, auth: auth(false) }), {
    binary: 'codex', name: 'Codex', command: 'codex login', path: '/h/.codex/auth.json', detail: 'd',
  });
  assert.equal(missingLogin({ ...codexOnly, auth: auth(true) }), null);
  // A provider whose CLI is missing has no connection to claim.
  assert.equal(missingLogin({ ...doctor(), auth: auth(false) }), null);
  // opencode alone does not carry the main agent: the list stays visible.
  assert.equal(backendReady(doctor({ binaries: [binary('opencode', true)] })), false);
});

test('the configuration writes itself when there is nothing left to decide', () => {
  const base = { doctor: doctor({ desktop: true }), revealed: true, ready: true, missing: 0, resumable: false, message: null };
  assert.equal(shouldAutoWrite(base), true);
  assert.equal(shouldAutoWrite({ ...base, revealed: false }), false, 'service not there yet');
  assert.equal(shouldAutoWrite({ ...base, ready: false }), false, 'no backend ready');
  assert.equal(shouldAutoWrite({ ...base, missing: 1 }), false, 'a prerequisite to install');
  assert.equal(shouldAutoWrite({ ...base, resumable: null }), false, 'reprise pas encore connue');
  assert.equal(shouldAutoWrite({ ...base, resumable: true }), false, 'an existing install is a choice');
  assert.equal(shouldAutoWrite({ ...base, message: 'boom' }), false, 'an error shown');
  assert.equal(shouldAutoWrite({ ...base, doctor: doctor() }), false, 'web assistant: the app box is still there');
});


/* ---- Background preparation (onboarding v2, docs/ONBOARDING-PREPARATION.md) ---- */

const answer = (a: { ok: boolean; installed?: boolean; reason?: string; command?: string | null }): ServiceStatusRead =>
  ({ kind: 'answer', answer: { lines: [], ...a } });

test('the service phase is read from the machine, not from a click', () => {
  const machine = { supervisor: 'systemd-user' };
  assert.equal(servicePhaseFrom({ doctor: null, firstRun: true, status: null, failure: null }), 'checking');
  assert.equal(servicePhaseFrom({ doctor: machine, firstRun: true, status: answer({ ok: false, installed: false }), failure: null }), 'missing');
  assert.equal(servicePhaseFrom({ doctor: machine, firstRun: true, status: answer({ ok: false, installed: true }), failure: null }), 'installed',
    'a packaged first launch: registered, started at the handover');
  assert.equal(servicePhaseFrom({ doctor: machine, firstRun: true, status: answer({ ok: true, installed: true }), failure: null }), 'running');
  // No supervisor on this machine: nothing to install, the portable mode.
  assert.equal(servicePhaseFrom({ doctor: { supervisor: null }, firstRun: true, status: answer({ ok: false }), failure: null }), 'portable');
});

test('a refusal is kept until a service is registered', () => {
  const machine = { supervisor: 'windows' };
  const failure = { text: 'The UAC prompt was dismissed', command: null };
  assert.equal(servicePhaseFrom({ doctor: machine, firstRun: true, status: answer({ ok: false, installed: false }), failure }), 'failed');
  // Installed by hand since, in a terminal: the old refusal no longer counts.
  assert.equal(servicePhaseFrom({ doctor: machine, firstRun: true, status: answer({ ok: true, installed: true }), failure }), 'running');
});

test('the daemon refusing the call is told apart from the service refusing to install', () => {
  const machine = { supervisor: 'launchd' };
  // An exposed listener refuses anonymous calls before the first account.
  assert.equal(servicePhaseFrom({ doctor: machine, firstRun: true, status: { kind: 'unauthorized' }, failure: null }), 'account');
  // `timon.config.json` exists: the daemon closed its onboarding gestures (409).
  assert.equal(servicePhaseFrom({ doctor: machine, firstRun: true, status: { kind: 'closed' }, failure: null }), 'configured');
  assert.equal(servicePhaseFrom({ doctor: machine, firstRun: false, status: null, failure: null }), 'configured');
  const broken: ServiceStatusRead = { kind: 'error', message: 'fetch failed' };
  assert.equal(servicePhaseFrom({ doctor: null, firstRun: true, status: broken, failure: null }), 'failed');
  assert.deepEqual(statusFailure(broken), { text: 'fetch failed', command: null });
  assert.equal(statusFailure({ kind: 'unauthorized' }), null);
});

test('the install starts on its own once, never again behind the reader after a refusal', () => {
  const all: ServicePhase[] = ['checking', 'missing', 'installing', 'installed', 'running', 'portable', 'failed', 'account', 'configured'];
  assert.deepEqual(all.filter(shouldInstallService), ['missing']);
});

test('after an install, the phase is what service-status says', () => {
  const machine = { supervisor: 'systemd-user' };
  assert.deepEqual(
    phaseAfterInstall({ answer: { ok: true, installed: true }, status: { ok: true, installed: true }, doctor: machine }),
    { phase: 'running', failure: null },
  );
  assert.deepEqual(
    phaseAfterInstall({ answer: { ok: true, installed: true }, status: { ok: false, installed: true }, doctor: machine }),
    { phase: 'installed', failure: null },
  );
  // A refusal carries its reason AND the command to paste, never one without the other.
  assert.deepEqual(
    phaseAfterInstall({
      answer: { ok: false, reason: 'systemctl refused: Access denied', command: 'systemctl --user daemon-reload' },
      status: { ok: false, installed: false },
      doctor: machine,
    }),
    { phase: 'failed', failure: { text: 'systemctl refused: Access denied', command: 'systemctl --user daemon-reload' } },
  );
  // Windows registered the task and never started it (TODO #342): the doctor now says portable.
  assert.deepEqual(
    phaseAfterInstall({ answer: { ok: false, reason: 'task refused' }, status: { ok: false, installed: false }, doctor: { supervisor: null } }),
    { phase: 'portable', failure: null },
  );
});

test('the agent step is the service step, and only it: the welcome that follows is no longer a step', () => {
  assert.deepEqual([...SERVICE_STEPS], ['agent']);
  for (const step of ['splash', 'account', 'llm', 'profile']) assert.equal(stepNeedsService(step), false, step);
  assert.equal(stepNeedsService('agent'), true);
  // Ready = registered, running, portable or already configured — never "still installing".
  assert.deepEqual(
    (['checking', 'missing', 'installing', 'installed', 'running', 'portable', 'failed', 'account', 'configured'] as ServicePhase[]).filter(serviceReady),
    ['installed', 'running', 'portable', 'configured'],
  );
});

test('the preparation starts past the welcome, and the card steps aside on the service steps', () => {
  assert.equal(preparationStarts('splash', true), false);
  assert.equal(preparationStarts('background', true), false, 'the install carries the answer of this step: it waits for it');
  assert.equal(preparationVisible('background', true, true), false, 'reached again through "Back": no card over the question');
  assert.equal(preparationStarts('account', true), true);
  for (const step of ['signin', 'mascot']) assert.equal(preparationStarts(step, true), false, `${step}: an install that already runs`);
  assert.equal(preparationVisible('account', false, true), false, 'not before it started');
  for (const step of ['account', 'llm', 'profile']) assert.equal(preparationVisible(step, true, true), true, step);
  for (const step of ['splash', 'agent', 'discover']) assert.equal(preparationVisible(step, true, true), false, step);
  assert.equal(preparationStarts('discover', true), false, 'after the agent: the service is already there, a reload reads nothing again');
});

test('the wait for an account is asked again on a timer, only while it waits and on a page that stays', () => {
  assert.ok(ACCOUNT_POLL_MS >= 2000, 'a slow beat: four reads per round');
  for (const step of ['account', 'llm', 'profile', 'agent']) assert.equal(pollsForAccount('account', step, true), true, step);
  assert.equal(pollsForAccount('account', 'splash', true), false, 'not before the welcome is passed');
  assert.equal(pollsForAccount('account', 'agent', false), false, 'not on a page about to unload');
  for (const phase of ['checking', 'missing', 'installing', 'installed', 'running', 'failed', 'configured'] as ServicePhase[]) {
    assert.equal(pollsForAccount(phase, 'account', true), false, phase);
  }
});

test('a stand-in that leaves the page starts nothing and shows no card', () => {
  // An install started on a page about to unload: a prompt nobody answers, a refusal lost with the page.
  for (const step of ['account', 'llm', 'profile', 'agent']) {
    assert.equal(preparationStarts(step, false), false, step);
    assert.equal(preparationVisible(step, true, false), false, step);
  }
});

test('the four lines of the card follow the daemon, and the headline follows them', () => {
  const start = preparationItems({ service: 'checking', doctor: 'checking', browser: null });
  assert.deepEqual(start.map((i) => i.id), ['service', 'database', 'browser', 'providers']);
  assert.deepEqual(start.map((i) => i.state), ['running', 'running', 'idle', 'running']);
  assert.equal(preparationHeadline(start), 'preparing');
  assert.equal(preparationProgress(start), 0);

  const halfway = preparationItems({ service: 'installing', doctor: 'ready', browser: 'checking' });
  assert.deepEqual(halfway.map((i) => i.state), ['running', 'done', 'running', 'done']);
  assert.equal(preparationProgress(halfway), 50);

  // No built-in browser on a web install, a portable machine: settled, not failed.
  const settled = preparationItems({ service: 'portable', doctor: 'ready', browser: 'unavailable' });
  assert.deepEqual(settled.map((i) => i.state), ['skipped', 'done', 'skipped', 'done']);
  assert.equal(preparationHeadline(settled), 'ready');
  assert.equal(preparationProgress(settled), 100);

  const ready = preparationItems({ service: 'installed', doctor: 'ready', browser: 'available' });
  assert.equal(preparationHeadline(ready), 'ready');

  const failed = preparationItems({ service: 'failed', doctor: 'ready', browser: 'available' });
  assert.equal(failed[0]?.state, 'failed');
  assert.equal(preparationHeadline(failed), 'failed');
  assert.equal(preparationHeadline(preparationItems({ service: 'running', doctor: 'failed', browser: 'available' })), 'failed');
  // Waiting for an account is not a failure.
  assert.equal(preparationItems({ service: 'account', doctor: 'ready', browser: null })[0]?.state, 'idle');
});

test('the guard waits, blocks, configures, then opens', () => {
  assert.equal(gateAction({ phase: 'checking', firstRun: null }), 'wait');
  assert.equal(gateAction({ phase: 'installing', firstRun: true }), 'wait');
  assert.equal(gateAction({ phase: 'missing', firstRun: true }), 'wait');
  assert.equal(gateAction({ phase: 'account', firstRun: true }), 'wait');
  assert.equal(gateAction({ phase: 'failed', firstRun: true }), 'blocked');
  // Ready and not configured yet: the guard writes the configuration (after the service, never before).
  assert.equal(gateAction({ phase: 'installed', firstRun: true }), 'configure');
  assert.equal(gateAction({ phase: 'running', firstRun: true }), 'configure');
  assert.equal(gateAction({ phase: 'portable', firstRun: true }), 'configure');
  // Ready, but whether the config exists is not known yet: wait rather than write over it.
  assert.equal(gateAction({ phase: 'running', firstRun: null }), 'wait');
  assert.equal(gateAction({ phase: 'configured', firstRun: false }), 'open');
  assert.equal(gateAction({ phase: 'running', firstRun: false }), 'open');
});

test('the guard writes /setup defaults, and resumes a home that already holds work', () => {
  assert.deepEqual(setupAnswers({ supervisor: 'launchd', desktop: true }), {
    edition: 'expert', supervisor: 'launchd', appEnabled: true, binaries: {}, vaultPath: '',
  });
  assert.deepEqual(setupAnswers({ supervisor: null, desktop: false }), {
    edition: 'expert', supervisor: 'none', appEnabled: false, binaries: {}, vaultPath: '',
  });
  assert.equal(setupAnswers(null).supervisor, 'none');
  assert.deepEqual(configureTarget(false, '/onboarding?step=agent'), { endpoint: '/api/ui/setup', next: '/onboarding?step=agent' });
  assert.deepEqual(configureTarget(true, '/onboarding?step=agent'), { endpoint: '/api/ui/setup/resume', next: '/' });
});
