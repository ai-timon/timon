/**
 * The preparation store against a fake daemon: one install, started once past
 * the welcome; a refusal kept across a reload and never retried behind the
 * reader's back; the configuration written after the service, then handed over.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { OnboardingAnswer, ServiceStatusRead, SetupDoctor } from '@/lib/setup-plan';
import { createPreparation, FAILURE_KEY, viewOf, type PreparationApi } from './preparation';
import { keepSessionChoice, SESSION_CHOICE_KEY, skipsSessionChoice } from './service-session-choice';

const DOCTOR: SetupDoctor = { platform: 'linux', supervisor: 'systemd-user', linux: null, binaries: [], blockers: [], desktop: true };

type Machine = {
  installed: boolean;
  running: boolean;
  firstRun: boolean;
  /** What `install-service` answers; `null` = it registers the service. */
  refusal: OnboardingAnswer | null;
  supervisor: string | null;
  calls: string[];
  /** The `mode` each `install-service` carried. */
  modes: Array<string | undefined>;
  writes: Array<{ endpoint: string; body: Record<string, unknown> }>;
  handOver: boolean;
  existing: boolean;
  navigated: string[];
};

function fake(over: Partial<Machine> = {}): { machine: Machine; api: PreparationApi } {
  const machine: Machine = {
    installed: false, running: false, firstRun: true, refusal: null, supervisor: 'systemd-user',
    calls: [], modes: [], writes: [], handOver: false, existing: false, navigated: [], ...over,
  };
  const api: PreparationApi = {
    firstRun: async () => machine.firstRun,
    doctor: async () => ({ ...DOCTOR, supervisor: machine.supervisor }),
    onboarding: async (action, mode): Promise<ServiceStatusRead> => {
      machine.calls.push(action);
      if (action === 'install-service') machine.modes.push(mode);
      if (!machine.firstRun) return { kind: 'closed' };
      if (action === 'install-service') {
        if (machine.refusal) return { kind: 'answer', answer: machine.refusal };
        machine.installed = true;
        return { kind: 'answer', answer: { ok: true, installed: true, lines: ['installed'] } };
      }
      return { kind: 'answer', answer: { ok: machine.running, installed: machine.installed } };
    },
    browserAvailable: async () => true,
    existingInstance: async () => machine.existing,
    writeSetup: async (endpoint, body) => {
      machine.writes.push({ endpoint, body });
      machine.firstRun = false;
      return { ok: true };
    },
    handOver: async () => machine.handOver,
    navigate: (href) => { machine.navigated.push(href); },
  };
  return { machine, api };
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

test('started past the welcome, the service is installed once, in the background', async () => {
  const { machine, api } = fake();
  const store = createPreparation(api, memoryStorage());
  assert.equal(viewOf(store.getState()).started, false);
  await Promise.all([store.start(), store.start()]);
  assert.deepEqual(machine.calls, ['service-status', 'install-service', 'service-status'], 'one install, read back');
  const view = viewOf(store.getState());
  assert.equal(view.phase, 'installed', 'registered; a packaged first launch starts it at the handover');
  assert.deepEqual(view.items.map((i) => i.state), ['done', 'done', 'done', 'done']);
  assert.equal(view.gate, 'configure');
  await store.start();
  assert.equal(machine.calls.length, 3, 'a second start does nothing');
});

test('a service already registered is not installed again', async () => {
  const { machine, api } = fake({ installed: true, running: true });
  const store = createPreparation(api, memoryStorage());
  await store.start();
  assert.deepEqual(machine.calls, ['service-status']);
  assert.equal(viewOf(store.getState()).phase, 'running');
});

test('a refusal shows its reason and command, survives a reload, and only "Try again" retries', async () => {
  const storage = memoryStorage();
  const refusal = { ok: false, installed: false, lines: [], reason: 'The UAC prompt was dismissed', command: null };
  const { machine, api } = fake({ refusal });
  const store = createPreparation(api, storage);
  await store.start();
  let view = viewOf(store.getState());
  assert.equal(view.phase, 'failed');
  assert.deepEqual(view.shownFailure, { text: 'The UAC prompt was dismissed', command: null });
  assert.equal(view.gate, 'blocked', 'the agent and the chat stay closed');
  assert.ok(storage.getItem(FAILURE_KEY));

  // The next page (a full navigation) reads the machine again but does not prompt again.
  const reloaded = createPreparation(api, storage);
  await reloaded.start();
  assert.deepEqual(machine.calls.filter((c) => c === 'install-service'), ['install-service']);
  assert.equal(viewOf(reloaded.getState()).phase, 'failed');

  // "Try again", this time accepted.
  machine.refusal = null;
  await reloaded.retry();
  view = viewOf(reloaded.getState());
  assert.equal(view.phase, 'installed');
  assert.equal(view.shownFailure, null);
  assert.equal(storage.getItem(FAILURE_KEY), null);
});

test('a service installed by hand since the refusal clears it', async () => {
  const storage = memoryStorage();
  storage.setItem(FAILURE_KEY, JSON.stringify({ text: 'refused', command: 'sudo loginctl enable-linger me' }));
  const { api } = fake({ installed: true });
  const store = createPreparation(api, storage);
  await store.start();
  assert.equal(viewOf(store.getState()).phase, 'installed');
  assert.equal(storage.getItem(FAILURE_KEY), null);
});

test('a machine without a supervisor is portable: nothing installed, nothing blocked', async () => {
  const { machine, api } = fake({ supervisor: null });
  const store = createPreparation(api, memoryStorage());
  await store.start();
  assert.deepEqual(machine.calls, ['service-status']);
  const view = viewOf(store.getState());
  assert.equal(view.phase, 'portable');
  assert.equal(view.items[0]?.state, 'skipped');
  assert.equal(view.gate, 'configure');
});

test('a daemon that wants an account waits for it, then installs at the next step', async () => {
  const { machine, api } = fake();
  let signedIn = false;
  const onboarding = api.onboarding;
  api.onboarding = async (action) => (signedIn ? onboarding(action) : { kind: 'unauthorized' });
  const store = createPreparation(api, memoryStorage());
  await store.start();
  assert.equal(viewOf(store.getState()).phase, 'account');
  assert.equal(viewOf(store.getState()).gate, 'wait');
  signedIn = true;
  await store.nudge();
  assert.equal(viewOf(store.getState()).phase, 'installed');
  assert.ok(machine.calls.includes('install-service'));
});

test('the guard writes the configuration after the service, then hands over to it', async () => {
  const { machine, api } = fake({ handOver: true });
  const store = createPreparation(api, memoryStorage());
  await store.start();
  await store.configure('/onboarding?step=agent');
  assert.equal(machine.writes.length, 1);
  assert.equal(machine.writes[0]?.endpoint, '/api/ui/setup');
  assert.equal(machine.writes[0]?.body.supervisor, 'systemd-user');
  assert.equal(machine.writes[0]?.body.appEnabled, true);
  assert.ok(machine.calls.indexOf('install-service') >= 0, 'the service came first');
  assert.equal(store.getState().configuring, true, 'the desktop reloads the page on the service');
  assert.deepEqual(machine.navigated, []);
});

test('without a handover the step opens in place; a home with work is resumed to the cockpit', async () => {
  const web = fake();
  const store = createPreparation(web.api, memoryStorage());
  await store.start();
  await store.configure('/onboarding?step=agent');
  assert.equal(viewOf(store.getState()).gate, 'open');
  assert.deepEqual(web.machine.navigated, []);

  const resumed = fake({ existing: true });
  const other = createPreparation(resumed.api, memoryStorage());
  await other.start();
  await other.configure('/onboarding?step=agent');
  assert.equal(resumed.machine.writes[0]?.endpoint, '/api/ui/setup/resume');
  assert.deepEqual(resumed.machine.navigated, ['/']);
});

test('a refused configuration is shown and can be tried again', async () => {
  const { machine, api } = fake();
  let refuse = true;
  const write = api.writeSetup;
  api.writeSetup = async (endpoint, body) => (refuse ? { ok: false, message: 'No AI provider can run' } : write(endpoint, body));
  const store = createPreparation(api, memoryStorage());
  await store.start();
  await store.configure('/onboarding?step=agent');
  assert.equal(store.getState().configureError, 'No AI provider can run');
  assert.equal(machine.firstRun, true);
  refuse = false;
  await store.configure('/onboarding?step=agent');
  assert.equal(store.getState().configureError, null);
  assert.equal(viewOf(store.getState()).gate, 'open');
});

test('the install carries the answer of the background step; none chosen, none sent', async () => {
  const chosen = fake();
  const storage = memoryStorage();
  keepSessionChoice(storage, 'always');
  await createPreparation(chosen.api, storage).start();
  assert.deepEqual(chosen.machine.modes, ['always']);

  const unchosen = fake();
  await createPreparation(unchosen.api, memoryStorage()).start();
  assert.deepEqual(unchosen.machine.modes, [undefined], 'the daemon keeps the session default');

  const garbled = fake();
  const odd = memoryStorage();
  odd.setItem(SESSION_CHOICE_KEY, 'enable-linger');
  await createPreparation(garbled.api, odd).start();
  assert.deepEqual(garbled.machine.modes, [undefined], 'only one of the two answers ever travels');
});

test('the background question steps aside when there is nothing to ask', () => {
  assert.equal(skipsSessionChoice({ kind: 'closed' }), true, 'onboarding over');
  assert.equal(skipsSessionChoice({ kind: 'answer', answer: { ok: true, installed: true, sessionModeSupported: true } }), true, 'already installed: Settings holds it');
  assert.equal(skipsSessionChoice({ kind: 'answer', answer: { ok: false, installed: false, sessionModeSupported: false } }), true, 'a Linux without systemd: no supervisor');
  assert.equal(skipsSessionChoice({ kind: 'answer', answer: { ok: false, installed: false, sessionModeSupported: true } }), false);
  assert.equal(skipsSessionChoice({ kind: 'unauthorized' }), false, 'asked anyway before the account');
  assert.equal(skipsSessionChoice({ kind: 'answer', answer: { ok: false, installed: false } }), false, 'an older daemon: asked, the answer is ignored');
});
