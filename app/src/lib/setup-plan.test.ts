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

/** La machine dicte la réponse : ce n'est plus un menu déroulant. */
test('le superviseur écrit est celui que la machine impose', () => {
  assert.equal(supervisorToWrite({ supervisor: 'systemd-user' }), 'systemd-user');
  assert.equal(supervisorToWrite({ supervisor: 'launchd' }), 'launchd');
  assert.equal(supervisorToWrite({ supervisor: 'windows' }), 'windows');
  // Aucun superviseur installable (Linux sans systemd) : mode portable.
  assert.equal(supervisorToWrite({ supervisor: null }), 'none');
  assert.equal(serviceInstallable({ supervisor: null }), false);
});

test('les prérequis manquants sont listés, les bloquants en premier', () => {
  const missing = missingPrerequisites(doctor());
  // Claude est déjà présent : Codex, Grok et Docker ne polluent pas l'onboarding.
  assert.deepEqual(missing, []);
});

test('sans aucun backend, Codex est proposé comme unique installation automatique', () => {
  const d = doctor();
  const claude = d.binaries.find((b) => b.name === 'claude');
  if (claude) { claude.ok = false; claude.path = null; }
  const missing = missingPrerequisites(d);
  assert.deepEqual(missing.filter((m) => m.required).map((m) => m.name), ['codex']);
});

test('node manquant est bloquant, et vient en tête', () => {
  const d = doctor();
  for (const b of d.binaries) if (b.name === 'node' || b.name === 'git') { b.ok = false; b.path = null; }
  const missing = missingPrerequisites(d);
  assert.deepEqual(missing.map((m) => [m.name, m.required]), [['node', true], ['git', false]]);
});

/** TODO #275 : sans git, Timon et son Kanban tournent ; git est proposé, jamais exigé. */
test('git manquant est recommandé, jamais bloquant', () => {
  const d = doctor();
  const git = d.binaries.find((b) => b.name === 'git');
  if (git) { git.ok = false; git.path = null; }
  const missing = missingPrerequisites(d);
  assert.deepEqual(missing.map((m) => [m.name, m.required]), [['git', false]]);
  assert.equal(missing.some((m) => m.required), false);
});

/**
 * Le cœur de l'étape : l'écran BLOQUE tant que le service ne répond pas. Un
 * écran qui laissait passer avec un daemon mort produisait une installation
 * qui avait l'air faite et ne faisait rien.
 */
test("on ne peut pas finir tant qu'aucun superviseur n'est enregistré", () => {
  assert.equal(canFinish({ doctor: doctor(), serviceInstalled: false, serviceRunning: false }), false);
  assert.equal(canFinish({ doctor: doctor(), serviceInstalled: true, serviceRunning: true }), true);
  assert.equal(canFinish({ doctor: null, serviceInstalled: true, serviceRunning: true }), false);
});

/**
 * Le piège de l'étape 5.7.6 : au premier lancement d'un paquet, le daemon qui
 * SERT cet écran est l'embarqué, et il tient le port que le service veut. Le
 * service ne peut donc pas démarrer avant que l'utilisateur relance. Bloquer
 * sur « tourne » verrouillerait l'écran exactement là où il compte le plus.
 */
test('un service installé mais pas encore démarré laisse finir, et demande la relève', () => {
  const state = { doctor: doctor(), serviceInstalled: true, serviceRunning: false };
  assert.equal(canFinish(state), true);
  assert.equal(needsHandover(state), true);
  assert.equal(needsHandover({ ...state, serviceRunning: true }), false);
});

test("une machine sans superviseur possible n'est pas enfermée dehors", () => {
  // Refuser ici verrouillerait l'utilisateur pour un fait qu'il ne peut pas
  // changer : il obtient le mode portable, et l'écran le dit.
  assert.equal(
    canFinish({ doctor: doctor({ supervisor: null }), serviceInstalled: false, serviceRunning: false }),
    true,
  );
});

/**
 * `canFinish` porte AUSSI la révélation du reste de l'écran (onboarding.2) :
 * tant qu'il est faux, seul le bloc « Daemon service » est affiché.
 *
 * D'où ce test : sur une machine sans superviseur, le bloc service n'est pas
 * rendu du tout (`serviceInstallable` est faux) et `serviceInstalled` ne
 * pourra JAMAIS devenir vrai. Révéler sur `serviceInstalled` y afficherait une
 * page vide, sans le moindre moyen d'en sortir.
 */
test('le mode portable voit le reste de l\'écran, faute de quoi il ne voit rien', () => {
  const portable = doctor({ supervisor: null });
  assert.equal(serviceInstallable(portable), false);
  assert.equal(canFinish({ doctor: portable, serviceInstalled: false, serviceRunning: false }), true);
  // Et le cas normal reste fermé tant que le service n'a pas répondu.
  assert.equal(canFinish({ doctor: doctor(), serviceInstalled: false, serviceRunning: false }), false);
});

test('un échec montre le motif ET la commande à coller', () => {
  const msg = answerMessage({
    ok: false,
    reason: 'systemctl refused: Interactive authentication required.',
    command: 'timon service install',
  });
  assert.match(msg.text, /Interactive authentication required/);
  assert.equal(msg.command, 'timon service install');

  // Un succès n'affiche aucune commande à coller.
  assert.deepEqual(answerMessage({ ok: true, lines: ['service installed'] }), {
    text: 'service installed',
    command: null,
  });
});

test('aucun dossier de travail n’est demandé, le vault reste vide par défaut', () => {
  assert.deepEqual(Object.keys(PATH_DEFAULTS), ['vaultPath']);
  // Vide = détection automatique par le daemon.
  assert.equal(PATH_DEFAULTS.vaultPath, '');
});

/**
 * La règle d'erreur des backends appartient au daemon, pas à l'écran.
 *
 * `doctor.ts` ne pousse `no LLM backend installed (...)` dans `blockers` que si
 * AUCUN des trois n'est trouvé. L'écran lit ce verdict ; il ne recalcule pas la
 * condition, sinon les deux implémentations divergent et l'UI alarme sur une
 * machine que le daemon juge saine (ou se tait sur une qu'il refuse).
 */
test('le recours backend suit le blocker du daemon, jamais un second calcul', () => {
  // La chaîne exacte que produit orchestrator/src/doctor.ts.
  const none = doctor({ blockers: ['no LLM backend installed (claude, codex, grok, copilot)'] });
  assert.equal(noBackendInstalled(none), true);

  // Un seul backend présent : le daemon ne bloque pas, l'écran non plus — même
  // si les deux autres binaires sont absents de `binaries`.
  assert.equal(noBackendInstalled(doctor()), false);
  assert.equal(doctor().binaries.filter((b) => ['claude', 'codex', 'grok'].includes(b.name) && b.ok).length, 1);

  // Un autre blocker ne déclenche pas le recours.
  assert.equal(noBackendInstalled(doctor({ blockers: ['git not found'] })), false);
});

test('les cartes de backend sont celles que le daemon déclare, dans son ordre', () => {
  const all = doctor({ binaries: Object.keys(PROVIDERS).reverse().map((name) => binary(name, false)).concat([binary('node', true)]) });
  const cards = backendCards(all);
  assert.deepEqual(cards.map((c) => c.name), ['codex', 'claude', 'grok', 'copilot', 'opencode', 'hermes-acp', 'pi']);
  // Une marque par carte : `BrandMark` les rend depuis brand-icons, sans asset
  // supplémentaire.
  assert.deepEqual(cards.map((c) => c.brand), ['openai', 'anthropic', 'xai', 'github', 'opencode', 'nous', 'pi']);
  assert.deepEqual(cards.map((c) => c.label), ['GPT', 'Claude', 'Grok', 'Copilot', 'opencode', 'Hermes', 'Pi']);
  // Un binaire sans fournisseur n'est pas une carte ; un fournisseur d'un tiers qui se déclare l'est.
  const third = binary('acme', false);
  assert.deepEqual(backendCards(doctor({ binaries: [third, { ...third, name: 'acme-agent', provider: { id: 'acme', label: 'Acme', brand: null, order: 8, suggested: false, seedsMainAgent: false } }] })).map((c) => c.name), ['acme-agent']);
});

test('les cartes à clé d\'API nomment le CLI qui les porte', () => {
  const apiKeyProviders = [
    { id: 'deepseek', label: 'DeepSeek', brand: 'deepseek', via: 'claude', viaLabel: 'Claude' },
    { id: 'ollama-cloud', label: 'Ollama Cloud', brand: 'ollama', via: 'codex', viaLabel: 'Codex' },
  ];
  assert.deepEqual(apiKeyCards(doctor({ apiKeyProviders })).map((c) => [c.id, c.via]), [['deepseek', 'claude'], ['ollama-cloud', 'codex']]);
  assert.deepEqual(apiKeyCards(doctor()), []);
});

test('le bloc des backends se masque dès qu\'un backend marche tel quel', () => {
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
  // Un fournisseur dont le CLI est absent n'a pas de connexion à réclamer.
  assert.equal(missingLogin({ ...doctor(), auth: auth(false) }), null);
  // opencode seul ne porte pas l'agent principal : la liste reste visible.
  assert.equal(backendReady(doctor({ binaries: [binary('opencode', true)] })), false);
});

test('la configuration s\'écrit seule quand il ne reste rien à décider', () => {
  const base = { doctor: doctor({ desktop: true }), revealed: true, ready: true, missing: 0, resumable: false, message: null };
  assert.equal(shouldAutoWrite(base), true);
  assert.equal(shouldAutoWrite({ ...base, revealed: false }), false, 'service pas encore là');
  assert.equal(shouldAutoWrite({ ...base, ready: false }), false, 'aucun backend prêt');
  assert.equal(shouldAutoWrite({ ...base, missing: 1 }), false, 'un prérequis à installer');
  assert.equal(shouldAutoWrite({ ...base, resumable: null }), false, 'reprise pas encore connue');
  assert.equal(shouldAutoWrite({ ...base, resumable: true }), false, 'une install existante est un choix');
  assert.equal(shouldAutoWrite({ ...base, message: 'boom' }), false, 'une erreur affichée');
  assert.equal(shouldAutoWrite({ ...base, doctor: doctor() }), false, 'assistant web : il reste la case de l\'app');
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
  // Ready = registered, running, portable or already configured — never « still installing ».
  assert.deepEqual(
    (['checking', 'missing', 'installing', 'installed', 'running', 'portable', 'failed', 'account', 'configured'] as ServicePhase[]).filter(serviceReady),
    ['installed', 'running', 'portable', 'configured'],
  );
});

test('the preparation starts past the welcome, and the card steps aside on the service steps', () => {
  assert.equal(preparationStarts('splash', true), false);
  assert.equal(preparationStarts('background', true), false, 'the install carries the answer of this step: it waits for it');
  assert.equal(preparationVisible('background', true, true), false, 'reached again through « Back »: no card over the question');
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
