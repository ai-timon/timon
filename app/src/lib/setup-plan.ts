/**
 * What the first-run screen must show, and what it must refuse (step 5.7.4).
 *
 * The decision logic lives here rather than in the page for one reason: the
 * page is a `.tsx` nobody can run in the test suite, and this screen now BLOCKS
 * the product. Which supervisor the machine dictates, which prerequisites are
 * missing, whether the user may finish — those are answers that must be tested,
 * not rendered and hoped for.
 *
 * Since the onboarding v2 the same module also decides the background
 * preparation (end of file): the service installed while the reader advances,
 * and the guard of the steps that need it.
 *
 * The screen no longer ASKS which supervisor to use. Installing the daemon as
 * a service is mandatory on the three OSes; the machine dictates the answer and
 * this module states it.
 */

/** The provider behind an AI CLI, as the daemon declares it (`doctor.ts`): nothing about it is known here by name. */
export type SetupProvider = {
  id: string;
  /** Short name on its card. */
  label: string;
  /** Logo key (`BrandMark`). */
  brand: string | null;
  /** Place among the cards. */
  order: number;
  /** The one offered first when no CLI is installed. */
  suggested: boolean;
  /** A fresh install may start its main agent on it. */
  seedsMainAgent: boolean;
};

export type SetupBinary = {
  name: string;
  ok: boolean;
  path: string | null;
  /** From the daemon: what installs it HERE. `null` = no command known. */
  installCommand: string | null;
  /** Present on the AI CLIs of the product's providers. */
  provider?: SetupProvider;
};

/** Whether the user is signed in, for the providers that can tell. */
export type SetupAuth = {
  provider: string;
  /** The binary it belongs to, as `binaries` names it. */
  binary: string;
  ok: boolean;
  detail: string;
  signInCommand: string | null;
  path: string | null;
};

/** A provider reached with an API key through the CLI of another one. */
export type SetupApiKeyProvider = { id: string; label: string; brand: string; via: string; viaLabel: string };

export type SetupDoctor = {
  desktop?: boolean;
  platform: string;
  /** The daemon's home directory. */
  home?: string | null;
  /** `systemd-user` | `launchd` | `windows` | `null` (none available here). */
  supervisor: string | null;
  linux: { id: string | null; prettyName: string | null; packageManager: string | null } | null;
  binaries: SetupBinary[];
  auth?: SetupAuth[];
  apiKeyProviders?: SetupApiKeyProvider[];
  blockers: string[];
};

/** A CLI that is installed but whose provider says nobody is signed in. */
export type MissingLogin = { binary: string; name: string; command: string | null; path: string | null; detail: string };

/**
 * Binary detection and credential availability are separate diagnostics: the first installed CLI
 * whose provider (C4) reports no credentials.
 */
export function missingLogin(doctor: SetupDoctor | null): MissingLogin | null {
  for (const auth of doctor?.auth ?? []) {
    if (auth.ok || !doctor?.binaries.some((b) => b.name === auth.binary && b.ok)) continue;
    return {
      binary: auth.binary,
      name: auth.binary.charAt(0).toUpperCase() + auth.binary.slice(1),
      command: auth.signInCommand,
      path: auth.path,
      detail: auth.detail,
    };
  }
  return null;
}

/**
 * One backend works as it stands: the screen then has nothing to ask about
 * backends and hides the whole block. Codex detected without its login does
 * not count — it would fail at the agent's first turn.
 */
export function backendReady(doctor: SetupDoctor | null): boolean {
  if (!doctor) return false;
  const loginMissing = missingLogin(doctor);
  return doctor.binaries.some((b) => b.ok && b.provider?.seedsMainAgent === true && b.name !== loginMissing?.binary);
}

/** Binaries without which Timon does nothing: it cannot run, or cannot think. */
const REQUIRED = ['node'];
/**
 * Offered, never blocking: without git Timon and its Kanban run, only the
 * git modules and the git tasks of a git project are off (TODO #275).
 */
const RECOMMENDED = ['git'];

/**
 * The supervisor to write in `timon.config.json`.
 *
 * `none` means "the desktop client runs the daemon itself", which is the
 * portable mode — the fallback for a machine where no supervisor can be
 * installed (a Linux without systemd), never a choice offered on a machine
 * that has one.
 */
export function supervisorToWrite(doctor: Pick<SetupDoctor, 'supervisor'>): string {
  return doctor.supervisor ?? 'none';
}

/** A machine with no supervisor cannot be asked to install a service. */
export function serviceInstallable(doctor: Pick<SetupDoctor, 'supervisor'>): boolean {
  return doctor.supervisor !== null;
}

/**
 * The agent backends, in the order the screen shows them, with the brand
 * key of their logotype (`BrandMark`) — read from what the daemon declares for
 * each, never a literal comparison in the JSX.
 */
export function backendCards(doctor: Pick<SetupDoctor, 'binaries'> | null): Array<{ name: string; label: string; brand: string }> {
  return (doctor?.binaries ?? [])
    .flatMap((b) => (b.provider ? [{ name: b.name, label: b.provider.label, brand: b.provider.brand ?? '', order: b.provider.order }] : []))
    .sort((a, b) => a.order - b.order)
    .map(({ name, label, brand }) => ({ name, label, brand }));
}

/**
 * Providers reached with an API key, not a CLI of their own: they run through
 * the CLI of another provider, so the card names which CLI it needs. Informational
 * only — the key is entered in Settings once an account exists, because storing
 * it needs a superadmin.
 */
export function apiKeyCards(doctor: Pick<SetupDoctor, 'apiKeyProviders'> | null): SetupApiKeyProvider[] {
  return doctor?.apiKeyProviders ?? [];
}

/**
 * Prefix of the daemon blocker that says NO backend at all was found.
 *
 * `doctor.ts` already carries the rule — it pushes this blocker only when none
 * of the backend CLIs the providers declare is present. Matching its blocker rather
 * than recomputing the condition here is the point: two implementations of "is
 * a backend missing" would drift, and the screen would either alarm on a
 * machine the daemon considers fine, or stay silent on one it refuses to run.
 */
const NO_BACKEND_BLOCKER = 'no LLM backend installed';

/** True when the daemon reports that not one backend was found. */
export function noBackendInstalled(doctor: Pick<SetupDoctor, 'blockers'>): boolean {
  return doctor.blockers.some((blocker) => blocker.startsWith(NO_BACKEND_BLOCKER));
}

export type Prerequisite = SetupBinary & {
  /** `true` when nothing works without it — shown first, and blocking. */
  required: boolean;
};

/**
 * The prerequisites that are missing, blocking ones first.
 *
 * A backend is required as a GROUP: any one backend CLI is enough.
 * Once one is found, the others disappear from onboarding. If none is found,
 * The provider that declares itself `suggested` is the single prerequisite
 * offered, because Timon can install it unattended; the others remain valid
 * when already installed or pinned.
 */
export function missingPrerequisites(doctor: Pick<SetupDoctor, 'binaries'>): Prerequisite[] {
  const anyBackend = doctor.binaries.some((b) => b.provider && b.ok);
  const out: Prerequisite[] = [];
  for (const b of doctor.binaries) {
    if (b.ok) continue;
    const suggested = b.provider?.suggested === true;
    if (b.provider && (anyBackend || !suggested)) continue;
    const required = REQUIRED.includes(b.name) || (suggested && !anyBackend);
    if (!required && !RECOMMENDED.includes(b.name)) continue; // optional tools are not onboarding material
    out.push({ ...b, required });
  }
  return out.sort((a, b) => Number(b.required) - Number(a.required));
}

export type SetupState = {
  doctor: SetupDoctor | null;
  /** `service-status`: a supervisor is registered for the daemon. */
  serviceInstalled: boolean;
  /** `service-status`: it is running RIGHT NOW. */
  serviceRunning: boolean;
};

/**
 * May the user finish — i.e. write `timon.config.json`?
 *
 * Only once a supervisor is REGISTERED for the daemon. Not "running": on a
 * packaged first launch the daemon serving this very screen is the embedded
 * one, and it holds the port the service wants — the service therefore cannot
 * start until the user quits and relaunches. Gating on "running" would
 * deadlock the screen at exactly the moment it matters most (step 5.7.6).
 *
 * What the gate still guarantees is the thing the step exists for: nobody
 * finishes onboarding without a supervisor that will keep the daemon alive.
 *
 * The one exception is a machine where no supervisor exists: refusing there
 * would lock the user out of their own product for a fact they cannot change.
 * They get the portable mode, and the screen says so.
 */
export function canFinish(state: SetupState): boolean {
  if (!state.doctor) return false;
  if (!serviceInstallable(state.doctor)) return true;
  return state.serviceInstalled;
}

/**
 * The service is installed but not running — normal during a packaged first
 * launch, and the user must know the last gesture is theirs: quit, relaunch,
 * and the service takes over from the embedded daemon.
 */
export function needsHandover(state: SetupState): boolean {
  return state.serviceInstalled && !state.serviceRunning;
}

/** The daemon's answer to an onboarding action, as the screen consumes it. */
export type OnboardingAnswer = {
  ok: boolean;
  /** A supervisor is registered — not necessarily started (see `canFinish`). */
  installed?: boolean;
  lines?: string[];
  command?: string | null;
  reason?: string | null;
  error?: string;
  /** `service-status`: the answer to "keep running when logged out?" changes something here (Linux, macOS, Windows). */
  sessionModeSupported?: boolean;
  /** `service-status`, Linux: lingering is already on for the account, so "only while logged in" turns it off. */
  lingering?: boolean | null;
};

/**
 * What to display after an action: the reason it failed AND the command to
 * paste. Never one without the other when both exist — the reason alone leaves
 * the user stuck, the command alone hides why it was needed.
 */
export function answerMessage(answer: OnboardingAnswer): { text: string; command: string | null } {
  if (answer.error) return { text: answer.error, command: answer.command ?? null };
  if (answer.ok) return { text: (answer.lines ?? []).join('\n'), command: null };
  return {
    text: answer.reason ?? (answer.lines ?? []).join('\n'),
    command: answer.command ?? null,
  };
}

/**
 * The vault path is the `TIMON_BRAIN_VAULT` setting — deliberately NOT
 * `modules['@timon/vault'].path`, a key the loader expands and nothing reads,
 * which would look configured and configure nothing.
 *
 * The working folder is no longer asked (09/10/2026): the daemon gives agents
 * a working directory of its own, so a first run has nothing left to pick.
 * The vault is not asked either — memory is configured later — and an empty
 * value is what triggers the daemon's own detection.
 */
export type PathField = 'vaultPath';

export const PATH_DEFAULTS: Record<PathField, string> = {
  vaultPath: '',
};

/**
 * Where `/setup` goes once the configuration is written.
 *
 * Step 3 (the agent's identity) then step 4 (the team) when those are due,
 * step 5 (the restart) otherwise — and step 5 is the ending in both cases, so
 * nothing reaches the cockpit from here. The first-run gate would route on its
 * own; navigating explicitly avoids a flash of the wrong step.
 *
 * A function rather than a ternary in the page, for the same reason as
 * everything else in this module: the decision is what needs testing, and
 * jsdom refuses to let a test observe a navigation.
 */
export function afterSetup(answer: { teamOnboarding?: boolean }): string {
  // No restart step any more: the desktop hands its embedded daemon over to the
  // service before going there (`handOverToService`); elsewhere the top bar's
  // banner offers the restart.
  return answer.teamOnboarding === true ? '/setup/agent' : '/';
}

/**
 * Nothing left to decide on the first screen: the service answers, a backend
 * works, nothing is missing, no earlier install to resume and no error shown.
 * The page then writes the configuration on its own. Desktop only — the web
 * wizard still asks whether to serve the app.
 */
export function shouldAutoWrite(input: {
  doctor: SetupDoctor | null;
  revealed: boolean;
  ready: boolean;
  missing: number;
  resumable: boolean | null;
  message: string | null;
}): boolean {
  return input.doctor?.desktop === true && input.revealed && input.ready && input.missing === 0
    && input.resumable === false && input.message === null;
}

/* ------------------------------------------------------------------------ *
 * Background preparation (onboarding v2, docs/ONBOARDING-PREPARATION.md).
 *
 * Decision of 04/11/2026: installing the service no longer holds a screen.
 * It starts as soon as the reader leaves the welcome, runs while they create
 * their account and pick their AI, and only the steps that truly need the
 * service wait for it. Everything the card and the guard show is decided
 * below, from what the daemon answered — never from a timer.
 * ------------------------------------------------------------------------ */

/**
 * Where the daemon service stands, as the onboarding sees it.
 *
 * `missing` is "not registered, not tried yet"; `failed` is "tried, refused".
 * `account` is the daemon asking for a session before it answers — an exposed
 * listener refuses anonymous calls even before the first account (`auth.ts`),
 * so the preparation waits for the account step to sign the reader in.
 * `configured` is the end of the service's part: `timon.config.json` exists,
 * and the daemon closes its onboarding gestures (`/api/onboarding` → 409).
 */
export type ServicePhase =
  | 'checking'
  | 'missing'
  | 'installing'
  | 'installed'
  | 'running'
  | 'portable'
  | 'failed'
  | 'account'
  | 'configured';

/** What `service-status` answered: the body, or the HTTP refusal. */
export type ServiceStatusRead =
  | { kind: 'answer'; answer: OnboardingAnswer }
  | { kind: 'unauthorized' }
  | { kind: 'closed' }
  | { kind: 'error'; message: string };

/** A failure shown on the card and in the guard: why, and what to paste when the daemon knows. */
export type PreparationFailure = { text: string; command: string | null };

/**
 * The phase the machine is in. `failure` is the refusal kept from an earlier
 * attempt this session: shown as long as the machine still has no service,
 * forgotten the moment one is registered (installed by hand in a terminal).
 */
export function servicePhaseFrom(input: {
  doctor: Pick<SetupDoctor, 'supervisor'> | null;
  firstRun: boolean | null;
  status: ServiceStatusRead | null;
  failure: PreparationFailure | null;
}): ServicePhase {
  if (input.firstRun === false || input.status?.kind === 'closed') return 'configured';
  if (input.status?.kind === 'unauthorized') return 'account';
  if (input.status?.kind === 'error') return 'failed';
  if (!input.doctor || !input.status) return 'checking';
  if (!serviceInstallable(input.doctor)) return 'portable';
  const { answer } = input.status;
  if (answer.ok) return 'running';
  if (answer.installed === true) return 'installed';
  return input.failure ? 'failed' : 'missing';
}

/** The failure to show for a phase read from a status error (the request itself failed). */
export function statusFailure(status: ServiceStatusRead | null): PreparationFailure | null {
  return status?.kind === 'error' ? { text: status.message, command: null } : null;
}

/**
 * Install now? Once per session and only on a machine that has a supervisor
 * and none registered: a refusal (a dismissed UAC prompt, a polkit refusal)
 * is not retried behind the reader's back — the card's "Try again" does.
 */
export function shouldInstallService(phase: ServicePhase): boolean {
  return phase === 'missing';
}

/**
 * The phase after `install-service`, read back from `service-status` — the
 * click is never trusted (same rule as `/setup`). A refusal on a machine the
 * doctor now reports without a supervisor is the portable mode, not a failure:
 * Windows may register the task and never start it for this account (TODO #342).
 */
export function phaseAfterInstall(input: {
  answer: OnboardingAnswer;
  status: OnboardingAnswer;
  doctor: Pick<SetupDoctor, 'supervisor'> | null;
}): { phase: ServicePhase; failure: PreparationFailure | null } {
  if (input.status.installed === true) return { phase: input.status.ok ? 'running' : 'installed', failure: null };
  if (input.doctor && !serviceInstallable(input.doctor)) return { phase: 'portable', failure: null };
  const shown = answerMessage(input.answer);
  return {
    phase: 'failed',
    failure: { text: shown.text || answerMessage(input.status).text, command: shown.command },
  };
}

/**
 * The service is ready for the steps that need it: registered (on a packaged
 * first launch it starts at the handover, `needsHandover`), running, or out of
 * the question on a machine without a supervisor — the same rule as
 * `canFinish`, for the same reason: refusing there locks the reader out for a
 * fact they cannot change.
 */
export function serviceReady(phase: ServicePhase): boolean {
  return phase === 'installed' || phase === 'running' || phase === 'portable' || phase === 'configured';
}

/**
 * The steps closed until the service is ready, and why each one.
 *
 * - `agent`: creating the agent writes into the daemon that stays. The main
 *   agent is seeded when `timon.config.json` is written, and that write must
 *   come AFTER the service is registered — it ends the first run and closes
 *   `/api/onboarding`, so no service could be installed from the onboarding
 *   afterwards. On the desktop it is also where the embedded daemon hands its
 *   place to the service (`handOverToService`): a handover needs the config.
 *
 * The main agent's welcome that follows (a mission, on the TIMs page) needs the
 * service too: a mission started on the embedded daemon dies with it at the
 * handover, and its token answers 401 on the service beside it (the incident
 * `serviceHandoverNeeded` documents). It is no longer a step: it opens after
 * the agent step, which only lets the reader through once the service is ready.
 *
 * Every step before it only reads the machine or writes an account, a
 * profile or a CLI login, which any daemon of this home serves alike.
 *
 * A stand-in agent step (`/setup/agent?from=onboarding` until the agent step
 * ships) is guarded too, on purpose: it is not mounted — so it does not
 * navigate — before the guard opens. The page stays while the service
 * installs, and the screen it opens finds the configuration written: nobody
 * else writes it once the AI step lives in the onboarding.
 */
export const SERVICE_STEPS = ['agent'] as const;

export function stepNeedsService(step: string): boolean {
  return (SERVICE_STEPS as readonly string[]).includes(step);
}

/**
 * The preparation starts once the welcome is passed, and only on a step that
 * stays on this page (`stays`: the registry's entry has no `leavesPage`). A
 * stand-in that opens another screen unloads the page a moment later: an
 * install started there would raise the system's permission prompt with no
 * card left to answer it, and its refusal would leave with the page — the next
 * screen would ask again behind the reader's back.
 */
export function preparationStarts(step: string, stays: boolean): boolean {
  return stays && !BEFORE_INSTALL_STEPS.includes(step) && !UPGRADE_WELCOME_STEPS.includes(step) && !AFTER_AGENT_STEPS.includes(step);
}

/**
 * The welcome, and the question the install depends on ("keep running when
 * logged out?", `steps/background.tsx`): the install waits for its answer.
 */
const BEFORE_INSTALL_STEPS: readonly string[] = ['splash', 'background'];

/**
 * The steps after the agent ("Discover Timon"): the agent step's guard already waited
 * for the service, so there is nothing left to prepare nor to show — and a
 * reload on it must not read the machine again.
 */
const AFTER_AGENT_STEPS: readonly string[] = ['discover'];

/**
 * The upgrade welcome's steps (docs/ONBOARDING.md, `Upgrade welcome`): an
 * install that already runs, whose account signs in again. Nothing to prepare
 * there, so no card and no service install.
 */
const UPGRADE_WELCOME_STEPS: readonly string[] = ['signin', 'mascot'];

/** How often the preparation asks again while the daemon waits for an account. */
export const ACCOUNT_POLL_MS = 3000;

/**
 * While the daemon refuses anonymous calls (`account`), the preparation asks
 * again on a timer, not only when the step changes: the account may be made
 * and signed in without leaving the step (its code view), or in another tab.
 * One read every `ACCOUNT_POLL_MS`, never two at once (`nudge` skips a run in
 * flight), and none on the welcome or on a page about to unload.
 */
export function pollsForAccount(phase: ServicePhase, step: string, stays: boolean): boolean {
  return phase === 'account' && preparationStarts(step, stays);
}

/**
 * The card is shown on the steps between the welcome and the agent, while the
 * page stays. The agent step has its own guard, which says the same
 * thing in the middle of the screen when it matters.
 */
export function preparationVisible(step: string, started: boolean, stays: boolean): boolean {
  return started && stays && !BEFORE_INSTALL_STEPS.includes(step) && !stepNeedsService(step) && !AFTER_AGENT_STEPS.includes(step);
}

export type PreparationItemId = 'service' | 'database' | 'browser' | 'providers';
export type PreparationItemState = 'idle' | 'running' | 'done' | 'failed' | 'skipped';
export type PreparationItem = { id: PreparationItemId; state: PreparationItemState };

/** What the built-in browser answered (`/api/native-browser/capabilities`), `null` before asking. */
export type BrowserRead = 'checking' | 'available' | 'unavailable' | null;

export type PreparationSnapshot = {
  service: ServicePhase;
  /** The doctor answered: the daemon, and so its database, is up and read the machine. */
  doctor: 'checking' | 'ready' | 'failed';
  browser: BrowserRead;
};

function serviceItem(phase: ServicePhase): PreparationItemState {
  if (phase === 'checking' || phase === 'installing') return 'running';
  if (phase === 'failed') return 'failed';
  if (phase === 'portable') return 'skipped';
  if (phase === 'missing' || phase === 'account') return 'idle';
  return 'done';
}

/**
 * The four lines of the card, in the mockup's order. Each one is a fact the
 * daemon answered: the service its status, the database the daemon that
 * answers at all, the browser its capability probe (absent is not an error:
 * a web install has none and still works), the AIs the doctor's detection.
 */
export function preparationItems(s: PreparationSnapshot): PreparationItem[] {
  const doctor: PreparationItemState = s.doctor === 'ready' ? 'done' : s.doctor === 'failed' ? 'failed' : 'running';
  const browser: PreparationItemState = s.browser === 'available' ? 'done'
    : s.browser === 'unavailable' ? 'skipped'
      : s.browser === 'checking' ? 'running' : 'idle';
  return [
    { id: 'service', state: serviceItem(s.service) },
    { id: 'database', state: doctor },
    { id: 'browser', state: browser },
    { id: 'providers', state: doctor },
  ];
}

/** `ready` once every line is settled without failure, `failed` as soon as one failed. */
export function preparationHeadline(items: readonly PreparationItem[]): 'preparing' | 'ready' | 'failed' {
  if (items.some((i) => i.state === 'failed')) return 'failed';
  return items.every((i) => i.state === 'done' || i.state === 'skipped') ? 'ready' : 'preparing';
}

/** The ring's filling, 0 to 100: one quarter per settled line. */
export function preparationProgress(items: readonly PreparationItem[]): number {
  if (items.length === 0) return 0;
  const settled = items.filter((i) => i.state === 'done' || i.state === 'skipped').length;
  return Math.round((settled / items.length) * 100);
}

/**
 * What the guard of a service step does.
 *
 * - `wait`: the service is still being read or installed;
 * - `blocked`: it was refused — the guard shows why and how to fix it;
 * - `configure`: it is ready and `timon.config.json` is not written yet — the
 *   guard writes it, then hands the embedded daemon over (desktop);
 * - `open`: the step can run.
 */
export type GateAction = 'wait' | 'blocked' | 'configure' | 'open';

export function gateAction(input: { phase: ServicePhase; firstRun: boolean | null }): GateAction {
  if (input.phase === 'failed') return 'blocked';
  if (input.phase === 'configured' || input.firstRun === false) return 'open';
  if (!serviceReady(input.phase) || input.firstRun === null) return 'wait';
  return 'configure';
}

/**
 * What the guard writes: `/setup`'s defaults, without its questions. The
 * edition and the vault are not asked any more (they live in Settings); the
 * desktop serves its own interface, a browser install is served by its own
 * app and keeps `appEnabled` off, as `/setup` left it unchecked. No binary
 * pin: the onboarding connects CLIs, it does not type paths — `/setup` stays the
 * place to pin one.
 */
export function setupAnswers(doctor: Pick<SetupDoctor, 'supervisor' | 'desktop'> | null): {
  edition: 'expert';
  supervisor: string;
  appEnabled: boolean;
  binaries: Record<string, string>;
  vaultPath: string;
} {
  return {
    edition: 'expert',
    supervisor: doctor ? supervisorToWrite(doctor) : 'none',
    appEnabled: doctor?.desktop === true,
    binaries: {},
    vaultPath: PATH_DEFAULTS.vaultPath,
  };
}

/**
 * Where the configuration is written, and where the reader lands after it.
 * A home that already holds agents or work is RESUMED, as `/setup` offers it:
 * the daemon writes the missing config and marks the remaining steps answered,
 * so the onboarding ends on the cockpit rather than on a second main agent.
 */
export function configureTarget(existingInstance: boolean, stepHref: string): { endpoint: string; next: string } {
  return existingInstance
    ? { endpoint: '/api/ui/setup/resume', next: '/' }
    : { endpoint: '/api/ui/setup', next: stepHref };
}
