'use client';

/**
 * The background preparation of the onboarding (docs/ONBOARDING-PREPARATION.md):
 * the service installed while the reader advances, the machine read once, and
 * the configuration written when the first step that needs the service opens.
 *
 * One store for the whole page, read by the card (`preparation-card.tsx`) and
 * by the guard of the service steps (`service-gate.tsx`): both must agree on
 * one install, never start two. Every decision is a pure function of
 * `@/lib/setup-plan`; this module only calls the daemon and keeps the answers.
 *
 * The daemon is the memory, not this module: a full navigation (a stand-in
 * step that opens `/setup/agent`, the desktop's handover) reloads the page,
 * and the store reads the machine again. The one thing it keeps across a
 * reload is a refusal, in `sessionStorage`, so a dismissed permission prompt
 * is not shown again behind the reader's back at the next step.
 */
import { useSyncExternalStore } from 'react';
import { t } from '@/lib/i18n';
import { fetchCapabilities } from '@/lib/capabilities';
import { apiErrorMessage } from '@/lib/api-error';
import { handOverToService } from '@/lib/desktop';
import { machineSessionStorage } from '@/lib/machines/machine-storage';
import type { ServiceSessionMode } from '@/lib/system-info';
import { readSessionChoice } from './service-session-choice';
import {
  configureTarget, gateAction, phaseAfterInstall, preparationItems, servicePhaseFrom, setupAnswers,
  shouldInstallService, statusFailure,
  type BrowserRead, type GateAction, type OnboardingAnswer, type PreparationFailure, type PreparationItem,
  type ServicePhase, type ServiceStatusRead, type SetupDoctor,
} from '@/lib/setup-plan';

/** Everything the store asks the outside world; a test passes its own. */
export type PreparationApi = {
  firstRun: () => Promise<boolean | null>;
  doctor: () => Promise<SetupDoctor>;
  /** `mode`: the answer of the background step, sent with `install-service` only. */
  onboarding: (action: 'service-status' | 'install-service', mode?: ServiceSessionMode) => Promise<ServiceStatusRead>;
  browserAvailable: () => Promise<boolean>;
  existingInstance: () => Promise<boolean>;
  writeSetup: (endpoint: string, body: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** `true` when the desktop took the page over to the service (it navigates on its own). */
  handOver: (route: string) => Promise<boolean>;
  navigate: (href: string) => void;
};

type FailureStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type PreparationState = {
  started: boolean;
  firstRun: boolean | null;
  doctor: SetupDoctor | null;
  doctorRead: 'checking' | 'ready' | 'failed';
  status: ServiceStatusRead | null;
  installing: boolean;
  /** The refusal of the last install, kept until a service is registered or "Try again". */
  failure: PreparationFailure | null;
  browser: BrowserRead;
  configuring: boolean;
  configureError: string | null;
};

export type PreparationView = PreparationState & {
  phase: ServicePhase;
  items: PreparationItem[];
  /** What blocks the service, read or kept: shown on the card and in the guard. */
  shownFailure: PreparationFailure | null;
  gate: GateAction;
};

export type Preparation = {
  getState: () => PreparationState;
  subscribe: (listener: () => void) => () => void;
  /** Starts once per page; later calls do nothing. */
  start: () => Promise<void>;
  /** Reads the machine again when it was waiting for an account; a step change calls it. */
  nudge: () => Promise<void>;
  /** "Try again": forgets the refusal and installs again. */
  retry: () => Promise<void>;
  /** Writes the configuration, then hands over to the service; `stepHref` is where the reader goes on. */
  configure: (stepHref: string) => Promise<void>;
};

export const FAILURE_KEY = 'timon.onboarding.serviceFailure';

const INITIAL: PreparationState = {
  started: false,
  firstRun: null,
  doctor: null,
  doctorRead: 'checking',
  status: null,
  installing: false,
  failure: null,
  browser: null,
  configuring: false,
  configureError: null,
};

function readFailure(storage: FailureStorage | null): PreparationFailure | null {
  try {
    const raw = storage?.getItem(FAILURE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PreparationFailure>;
    return typeof parsed.text === 'string'
      ? { text: parsed.text, command: typeof parsed.command === 'string' ? parsed.command : null }
      : null;
  } catch { return null; }
}

function keepFailure(storage: FailureStorage | null, failure: PreparationFailure | null): void {
  try {
    if (failure) storage?.setItem(FAILURE_KEY, JSON.stringify(failure));
    else storage?.removeItem(FAILURE_KEY);
  } catch { /* a private window without storage only loses the memory of a refusal */ }
}

export function phaseOf(state: PreparationState): ServicePhase {
  if (state.installing) return 'installing';
  return servicePhaseFrom({
    doctor: state.doctor,
    firstRun: state.firstRun,
    status: state.status,
    failure: state.failure,
  });
}

export function viewOf(state: PreparationState): PreparationView {
  const phase = phaseOf(state);
  const shownFailure = phase === 'failed' ? (state.failure ?? statusFailure(state.status)) : null;
  return {
    ...state,
    phase,
    items: preparationItems({ service: phase, doctor: state.doctorRead, browser: state.browser }),
    shownFailure,
    gate: gateAction({ phase, firstRun: state.firstRun }),
  };
}

export function createPreparation(api: PreparationApi, storage: FailureStorage | null): Preparation {
  let state: PreparationState = { ...INITIAL, failure: readFailure(storage) };
  const listeners = new Set<() => void>();
  let running: Promise<void> | null = null;

  const set = (patch: Partial<PreparationState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  async function readDoctor(): Promise<void> {
    try {
      set({ doctor: await api.doctor(), doctorRead: 'ready' });
    } catch {
      set({ doctorRead: 'failed' });
    }
  }

  async function refresh(): Promise<void> {
    if (state.browser === null) set({ browser: 'checking' });
    const browser = api.browserAvailable()
      .then((ok) => set({ browser: ok ? 'available' : 'unavailable' }))
      .catch(() => set({ browser: 'unavailable' }));
    const [firstRun] = await Promise.all([api.firstRun().catch(() => null), readDoctor()]);
    set({ firstRun });
    if (firstRun !== false) {
      const status = await api.onboarding('service-status');
      // A service registered since (by hand, in a terminal) clears the old refusal.
      const registered = status.kind === 'answer' && status.answer.installed === true;
      if (registered && state.failure) keepFailure(storage, null);
      set({ status, ...(registered ? { failure: null } : {}) });
    }
    await browser;
  }

  async function install(): Promise<void> {
    set({ installing: true });
    try {
      // No answer (a tab opened past the background step): the daemon keeps the session default.
      const answer = await api.onboarding('install-service', readSessionChoice(storage) ?? undefined);
      if (answer.kind !== 'answer') {
        const failure = statusFailure(answer);
        keepFailure(storage, failure);
        set({ status: answer, failure });
        return;
      }
      // Windows may register the task and never start it (TODO #342): the doctor then reports no supervisor.
      if (!answer.answer.ok) await readDoctor();
      const status = await api.onboarding('service-status');
      const read: OnboardingAnswer = status.kind === 'answer' ? status.answer : { ok: false, installed: false };
      const after = phaseAfterInstall({ answer: answer.answer, status: read, doctor: state.doctor });
      keepFailure(storage, after.failure);
      set({ status, failure: after.failure });
    } finally {
      set({ installing: false });
    }
  }

  async function run(): Promise<void> {
    await refresh();
    if (shouldInstallService(phaseOf(state))) await install();
  }

  function once(task: () => Promise<void>): Promise<void> {
    running ??= task().catch(() => undefined).finally(() => { running = null; });
    return running;
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start: async () => {
      if (state.started) return running ?? undefined;
      set({ started: true });
      return once(run);
    },
    nudge: async () => {
      if (!state.started || running) return;
      const phase = phaseOf(state);
      if (phase !== 'account' && phase !== 'checking') return;
      return once(run);
    },
    retry: async () => {
      if (running) return running;
      keepFailure(storage, null);
      set({ failure: null, status: null });
      return once(async () => {
        await refresh();
        const phase = phaseOf(state);
        if (phase === 'missing') await install();
      });
    },
    configure: async (stepHref) => {
      if (state.configuring) return;
      set({ configuring: true, configureError: null });
      try {
        const existing = await api.existingInstance().catch(() => false);
        const target = configureTarget(existing, stepHref);
        const written = await api.writeSetup(target.endpoint, setupAnswers(state.doctor));
        if (!written.ok) {
          set({ configuring: false, configureError: written.message });
          return;
        }
        keepFailure(storage, null);
        // The desktop moves the page onto the service; it reloads at `next` on its own.
        if (await api.handOver(target.next)) return;
        if (target.next !== stepHref) {
          api.navigate(target.next);
          return;
        }
        set({ configuring: false, firstRun: await api.firstRun().catch(() => false) ?? false });
      } catch (error) {
        set({ configuring: false, configureError: (error as Error).message });
      }
    },
  };
}

export async function postOnboarding(action: 'service-status' | 'install-service', mode?: ServiceSessionMode): Promise<ServiceStatusRead> {
  try {
    const response = await fetch('/api/ui/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mode ? { action, mode } : { action }),
    });
    if (response.status === 401) return { kind: 'unauthorized' };
    // The daemon closes its onboarding gestures once `timon.config.json` exists.
    if (response.status === 409) return { kind: 'closed' };
    const body = await response.json().catch(() => ({})) as OnboardingAnswer;
    if (!response.ok) return { kind: 'error', message: apiErrorMessage(body, { status: response.status }) };
    return { kind: 'answer', answer: body };
  } catch (error) {
    return { kind: 'error', message: (error as Error).message };
  }
}

const browserApi: PreparationApi = {
  firstRun: async () => {
    const caps = await fetchCapabilities(true);
    return typeof caps?.firstRun === 'boolean' ? caps.firstRun : null;
  },
  doctor: async () => {
    const response = await fetch('/api/ui/doctor', { cache: 'no-store' });
    if (!response.ok) throw new Error(`doctor: ${response.status}`);
    return await response.json() as SetupDoctor;
  },
  onboarding: postOnboarding,
  browserAvailable: async () => {
    const response = await fetch('/api/ui/native-browser/capabilities', { cache: 'no-store' });
    if (!response.ok) return false;
    return ((await response.json()) as { available?: unknown }).available === true;
  },
  existingInstance: async () => {
    const response = await fetch('/api/ui/setup/resume', { cache: 'no-store' });
    if (!response.ok) return false;
    return ((await response.json()) as { present?: unknown }).present === true;
  },
  writeSetup: async (endpoint, body) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    const answer = await response.json().catch(() => ({})) as { code?: string };
    return {
      ok: false,
      message: answer.code === 'no_provider' ? t('setupPage.noProvider') : apiErrorMessage(answer, t('setupPage.failed')),
    };
  },
  handOver: handOverToService,
  navigate: (href) => window.location.assign(href),
};

let shared: Preparation | null = null;

/** The page's store, created on first use (never during the server render). */
export function preparation(): Preparation {
  if (!shared) {
    // The refusal belongs to this daemon's service: kept per machine, like every daemon's state (TODO #329).
    shared = createPreparation(browserApi, machineSessionStorage());
  }
  return shared;
}

const SERVER_VIEW = viewOf(INITIAL);
let lastState: PreparationState | null = null;
let lastView: PreparationView = SERVER_VIEW;

/** The view of the shared store; the same object until the state changes. */
function snapshot(): PreparationView {
  const state = preparation().getState();
  if (state !== lastState) {
    lastState = state;
    lastView = viewOf(state);
  }
  return lastView;
}

export function usePreparation(): PreparationView {
  return useSyncExternalStore(
    (listener) => preparation().subscribe(listener),
    snapshot,
    () => SERVER_VIEW,
  );
}
