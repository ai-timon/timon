import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { APP_INFO_CHANNEL } from './app-info.js';
import { ABOUT_CHANNEL } from './about.js';
import { OPEN_LOGS_CHANNEL } from './diagnostic-dialog.js';
import { UI_ZOOM_CHANNELS } from './ui-zoom.js';
import { WINDOW_FRAME_CHANNELS } from './window-frame.js';
import {
  canRestartFromSetup, handoverKeptMessage, handoverRoute, relaunchOptions, serviceHandover, serviceHandoverNeeded, setupRestarter,
  setupRestartPending, SETUP_HANDOVER_CHANNEL, SETUP_RESTART_CHANNEL, SETUP_RESTART_STATUS_CHANNEL, waitWhileBooting, lateHandover, type WaitClock,
} from './restart.js';
import type { HealthResult } from './health.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDesktopConfig, originOf } from './config.js';

test('only the main Timon window on its own origin can restart after navigation', () => {
  const sender = { isWindow: true, isMainFrame: true, url: 'http://127.0.0.1:4312/setup' };
  const origin = 'http://127.0.0.1:4312';
  assert.equal(canRestartFromSetup(sender, origin), true);
  assert.equal(canRestartFromSetup({ ...sender, url: `${origin}/setup/?from=login` }, origin), true);
  for (const path of ['/setup/team', '/', '/chat?agent=assistant']) {
    assert.equal(canRestartFromSetup({ ...sender, url: origin + path }, origin), true);
  }
  for (const change of [
    { isWindow: false }, { isMainFrame: false },
    { url: 'http://evil.test/setup' }, { url: 'http://127.0.0.1:4313/setup' },
    { url: 'not a URL' }, { url: 'file:///setup' },
  ]) assert.equal(canRestartFromSetup({ ...sender, ...change }, origin), false);
});

test('AppImage relaunch uses the persistent file and literal arguments, not shell interpolation', () => {
  const env = { APPIMAGE: '/tmp/Timon test.AppImage', TIMON_HOME: '/tmp/existing-instance' };
  assert.deepEqual(relaunchOptions('linux', env, ['/tmp/.mount_old/timon', '--no-sandbox']), {
    execPath: env.APPIMAGE, args: ['--no-sandbox'],
  });
  assert.equal(env.TIMON_HOME, '/tmp/existing-instance');
  assert.deepEqual(relaunchOptions('linux', {}, ['/opt/timon/timon']), { args: [] });
  assert.deepEqual(relaunchOptions('darwin', env, ['/Applications/Timon.app']), { args: [] });
  assert.throws(() => relaunchOptions('linux', { APPIMAGE: 'relative.AppImage' }, []), /not absolute/);
});

test('a failed quit cancels the queued native restart', async () => {
  const calls: string[] = [];
  const restart = setupRestarter({
    validate: () => {}, stopEmbedded: async () => {},
    relaunch: async () => { calls.push('queued'); return () => { calls.push('cancelled'); }; },
    quit: () => { throw new Error('quit refused'); },
  });
  await assert.rejects(restart(), /quit refused/);
  assert.deepEqual(calls, ['queued', 'cancelled']);
});

test('restart validates first, waits for the embedded child, and relaunches only once', async () => {
  const calls: string[] = [];
  let exited!: () => void;
  const childExit = new Promise<void>((resolve) => { exited = resolve; });
  const restart = setupRestarter({
    validate: () => { calls.push('validate'); },
    stopEmbedded: async () => { calls.push('stop'); await childExit; calls.push('exited'); },
    relaunch: () => { calls.push('relaunch'); },
    quit: () => { calls.push('quit'); },
  });
  const first = restart();
  assert.equal(first, restart());
  await Promise.resolve();
  assert.deepEqual(calls, ['validate', 'stop']);
  exited();
  await first;
  await restart();
  assert.deepEqual(calls, ['validate', 'stop', 'exited', 'relaunch', 'quit']);
});

test('validation and shutdown failures do not quit and leave a retry available', async () => {
  for (const failure of ['validate', 'stop']) {
    let fail = true;
    const calls: string[] = [];
    const restart = setupRestarter({
      validate: () => { if (failure === 'validate' && fail) throw new Error('missing config'); },
      stopEmbedded: async () => { calls.push('stop'); if (failure === 'stop' && fail) throw new Error('still running'); },
      relaunch: () => { calls.push('relaunch'); }, quit: () => { calls.push('quit'); },
    });
    await assert.rejects(restart());
    assert.equal(calls.includes('quit'), false);
    assert.equal(calls.includes('relaunch'), false);
    if (failure === 'validate') assert.deepEqual(calls, []);
    fail = false;
    await restart();
    assert.deepEqual(calls.slice(-2), ['relaunch', 'quit']);
  }
});

test('the sandbox preload exposes narrow restart, directory and browser presentation capabilities', async () => {
  // Exercise the shipping compiler settings without writing to live dist/.
  const { fileURLToPath } = await import('node:url');
  const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(new URL('..', import.meta.url)));
  const program = ts.createProgram([fileURLToPath(new URL('./preload.cts', import.meta.url))], parsed.options);
  let compiled = '';
  program.emit(undefined, (path, source) => {
    assert.match(path, /preload\.cjs$/);
    compiled = source;
  });
  assert.ok(compiled, 'the packaging glob dist/**/* must contain preload.cjs');
  let bridge!: {
    setupRestartPending: (...args: unknown[]) => Promise<boolean>;
    restartAfterSetup: (...args: unknown[]) => Promise<void>;
    handOverToService: (...args: unknown[]) => Promise<string>;
    selectDirectory: (...args: unknown[]) => Promise<string | null>;
    selectPluginSource: (...args: unknown[]) => Promise<string | null>;
    selectExecutable: (...args: unknown[]) => Promise<string | null>;
    revealPath: (...args: unknown[]) => Promise<void>;
    appInfo: (...args: unknown[]) => Promise<{ version: string }>;
    openLogsFolder: (...args: unknown[]) => Promise<string>;
    openAbout: (...args: unknown[]) => Promise<void>;
    browser: { attach: (...args: unknown[]) => Promise<void>; detach: (...args: unknown[]) => Promise<void> };
    windowMachine: { set: (...args: unknown[]) => Promise<unknown> };
    openWindow: (...args: unknown[]) => Promise<unknown>;
    windowScheme: (...args: unknown[]) => Promise<unknown>;
    dockIcon: { get: (...args: unknown[]) => Promise<unknown>; set: (...args: unknown[]) => Promise<unknown> };
    windowFrame: {
      get: (...args: unknown[]) => Promise<unknown>;
      act: (...args: unknown[]) => Promise<unknown>;
      onChange: (listener: (state: unknown) => void) => () => void;
    };
    zoom: {
      current: () => number;
      get: (...args: unknown[]) => Promise<unknown>;
      set: (...args: unknown[]) => Promise<unknown>;
      step: (...args: unknown[]) => Promise<unknown>;
      onChange: (listener: (factor: number) => void) => () => void;
    };
    tailscale: { openInstaller: (...args: unknown[]) => Promise<unknown>; openApp: (...args: unknown[]) => Promise<unknown> };
    updates: {
      state: (...args: unknown[]) => Promise<unknown>;
      start: (...args: unknown[]) => Promise<unknown>;
      cancel: (...args: unknown[]) => Promise<unknown>;
      open: (...args: unknown[]) => Promise<unknown>;
      install: (...args: unknown[]) => Promise<unknown>;
      onState: (listener: (state: unknown) => void) => () => void;
    };
    speech: {
      getState: (...args: unknown[]) => Promise<unknown>;
      startDictation: (...args: unknown[]) => Promise<unknown>;
      feed: (...args: unknown[]) => void;
      stopDictation: (...args: unknown[]) => Promise<void>;
      onEvent: (listener: (event: unknown) => void) => () => void;
      microphone: (...args: unknown[]) => Promise<unknown>;
      listModels: (...args: unknown[]) => Promise<unknown>;
      importModel: (...args: unknown[]) => Promise<unknown>;
      proposePack: (...args: unknown[]) => Promise<unknown>;
    };
  };
  const calls: unknown[][] = [];
  const sent: unknown[][] = [];
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  let blinkZoom = 1.25;
  runInNewContext(compiled, {
    exports: {},
    require: (name: string) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key: string, api: typeof bridge) => {
          assert.equal(key, 'timonDesktop'); bridge = api;
        } },
        ipcRenderer: {
          invoke: async (...args: unknown[]) => { calls.push(args); },
          send: (...args: unknown[]) => { sent.push(args); },
          on: (channel: string, fn: (event: unknown, payload: unknown) => void) => { listeners.set(channel, fn); },
          removeListener: (channel: string, fn: unknown) => { if (listeners.get(channel) === fn) listeners.delete(channel); },
        },
        webFrame: { getZoomFactor: () => blinkZoom },
      };
    },
  });
  assert.deepEqual(Object.keys(bridge), ['selectDirectory', 'selectPluginSource', 'selectExecutable', 'revealPath', 'setupRestartPending', 'restartAfterSetup', 'handOverToService', 'appInfo', 'openLogsFolder', 'openAbout', 'uninstall', 'speech', 'windowMachine', 'windowScheme', 'dockIcon', 'windowFrame', 'zoom', 'openWindow', 'browser', 'updates', 'tailscale']);
  assert.deepEqual(Object.keys(bridge.browser), ['attach', 'detach']);
  // Multi-window V3: an id crosses, nothing else; the main process checks it is one.
  assert.deepEqual(Object.keys(bridge.windowMachine), ['set']);
  await bridge.windowMachine.set('vps', 'https://evil.example');
  assert.deepEqual(calls.pop(), ['timon:window-machine', 'vps', undefined]);
  await bridge.windowMachine.set('vps', { route: '/kanban', url: 'https://evil.example' });
  assert.equal(JSON.stringify(calls.pop()), '["timon:window-machine","vps",{"route":"/kanban"}]', 'V4: a route, nothing else');
  // Each machine its own mode: one object crosses, as given; the main process checks it is { scheme, machineId? }.
  await bridge.windowScheme({ scheme: 'light', machineId: 'vps' }, 'https://evil.example');
  assert.deepEqual(calls.pop(), ['timon:window-scheme', { scheme: 'light', machineId: 'vps' }]);
  // Multi-window V5: one object crosses, as given; the main process checks it is { route, machineId? }.
  await bridge.openWindow({ route: '/kanban', machineId: 'vps' }, 'https://evil.example');
  assert.deepEqual(calls.pop(), ['timon:open-window', { route: '/kanban', machineId: 'vps' }]);
  // The Dock icon: a name crosses, never a path; the main process checks it is one it knows.
  assert.deepEqual(Object.keys(bridge.dockIcon), ['get', 'set']);
  await bridge.dockIcon.get('untrusted extra option');
  assert.deepEqual(calls.pop(), ['timon:dock-icon-get']);
  await bridge.dockIcon.set('dark', '/Users/example/evil.png');
  assert.equal(JSON.stringify(calls.pop()), '["timon:dock-icon-set",{"icon":"dark"}]');
  // The window's frame: a gesture's name crosses, nothing else; the main process checks it is one of three.
  assert.deepEqual(Object.keys(bridge.windowFrame), ['get', 'act', 'onChange']);
  await bridge.windowFrame.get('untrusted extra option');
  assert.deepEqual(calls.pop(), [WINDOW_FRAME_CHANNELS.get]);
  await bridge.windowFrame.act('close', { bounds: { x: 0, y: 0 } });
  assert.equal(JSON.stringify(calls.pop()), `["${WINDOW_FRAME_CHANNELS.action}",{"action":"close"}]`);
  const frames: unknown[] = [];
  const stopFrame = bridge.windowFrame.onChange((state) => frames.push(state));
  listeners.get(WINDOW_FRAME_CHANNELS.changed)?.({ sender: 'ipc event' }, { maximized: true });
  assert.deepEqual(frames, [{ maximized: true }], 'the state reaches the page, the IPC event does not');
  stopFrame();
  assert.equal(listeners.has(WINDOW_FRAME_CHANNELS.changed), false);
  // The interface size: a number or a direction crosses, nothing else; the main process snaps and checks it.
  const callsBefore = calls.length;
  assert.deepEqual(Object.keys(bridge.zoom), ['current', 'get', 'set', 'step', 'onChange']);
  // The factor Blink lays the page out at, read synchronously: no IPC, so a measure never waits or races.
  assert.equal(bridge.zoom.current(), 1.25);
  blinkZoom = 0.9;
  assert.equal(bridge.zoom.current(), 0.9, 'read live, not cached');
  assert.equal(calls.length, callsBefore, 'current() calls nothing in the main process');
  await bridge.zoom.get('untrusted extra option');
  assert.deepEqual(calls.pop(), [UI_ZOOM_CHANNELS.get]);
  await bridge.zoom.set(1.25, { factor: 9 });
  assert.equal(JSON.stringify(calls.pop()), `["${UI_ZOOM_CHANNELS.set}",{"factor":1.25}]`);
  await bridge.zoom.step('in', 'untrusted extra option');
  assert.equal(JSON.stringify(calls.pop()), `["${UI_ZOOM_CHANNELS.step}",{"direction":"in"}]`);
  const factors: number[] = [];
  const stopZoom = bridge.zoom.onChange((factor) => factors.push(factor));
  listeners.get(UI_ZOOM_CHANNELS.changed)?.({}, { factor: 1.5 });
  listeners.get(UI_ZOOM_CHANNELS.changed)?.({}, { factor: 'huge' });
  listeners.get(UI_ZOOM_CHANNELS.changed)?.({}, null);
  assert.deepEqual(factors, [1.5], 'only a number reaches the page');
  stopZoom();
  assert.equal(listeners.has(UI_ZOOM_CHANNELS.changed), false);
  assert.deepEqual(Object.keys(bridge.tailscale), ['openInstaller', 'openApp']);
  await bridge.restartAfterSetup('untrusted executable', 'another home');
  await bridge.selectDirectory('/Users/example/My Project', 'untrusted extra option');
  assert.deepEqual(calls, [[SETUP_RESTART_CHANNEL], ['timon:select-directory', '/Users/example/My Project']]);
  await bridge.selectPluginSource('archive', 'untrusted extra option');
  assert.deepEqual(calls.at(-1), ['timon:select-plugin-source', 'archive']);
  calls.pop();
  await bridge.selectExecutable('/opt/homebrew/bin/claude', 'untrusted extra option');
  assert.deepEqual(calls.at(-1), ['timon:select-executable', '/opt/homebrew/bin/claude']);
  calls.pop();
  await bridge.revealPath({ agentId: 'a', path: 'a b.txt' }, 'untrusted extra option');
  assert.deepEqual(calls.at(-1), ['timon:reveal-path', { agentId: 'a', path: 'a b.txt' }]);
  calls.pop();
  const presentation = { profileId: 'client-a', viewToken: 'ticket', bounds: { x: 0, y: 0, width: 400, height: 300 } };
  await bridge.browser.attach(presentation, 'untrusted extra capability');
  await bridge.browser.detach('untrusted extra capability');
  assert.deepEqual(calls.slice(2), [['timon:browser-attach', presentation], ['timon:browser-detach']]);
  await bridge.setupRestartPending('untrusted home');
  assert.deepEqual(calls.at(-1), [SETUP_RESTART_STATUS_CHANNEL]);
  // A path crosses, and nothing else; the main process checks it is one of the interface.
  await bridge.handOverToService('/setup/agent', 'untrusted home');
  assert.deepEqual(calls.at(-1), [SETUP_HANDOVER_CHANNEL, '/setup/agent']);
  await bridge.appInfo('untrusted extra option');
  assert.deepEqual(calls.at(-1), [APP_INFO_CHANNEL]);
  await bridge.openLogsFolder('/etc');
  assert.deepEqual(calls.at(-1), [OPEN_LOGS_CHANNEL], 'no path crosses the bridge');
  await bridge.openAbout('file:///etc/passwd');
  assert.deepEqual(calls.at(-1), [ABOUT_CHANNEL], 'the page cannot choose what the About window shows');
  await bridge.tailscale.openInstaller('C:\\evil.msi', { url: 'https://evil.example/x.pkg' });
  assert.deepEqual(calls.at(-1), ['timon:tailscale-installer'], 'no path or URL crosses the bridge');
  await bridge.tailscale.openApp('/Applications/Evil.app');
  assert.deepEqual(calls.at(-1), ['timon:tailscale-open-app']);
  // A newer Timon (P2): the installer is the daemon's verified offer; no URL, path or version crosses.
  assert.deepEqual(Object.keys(bridge.updates), ['state', 'start', 'cancel', 'open', 'install', 'onState']);
  await bridge.updates.start('https://evil.example/Timon.exe', { url: 'https://evil.example/x' });
  assert.deepEqual(calls.at(-1), ['timon:update-start'], 'no URL crosses the bridge');
  await bridge.updates.cancel('C:\\evil');
  assert.deepEqual(calls.at(-1), ['timon:update-cancel']);
  await bridge.updates.state({ version: '9.9.9' });
  assert.deepEqual(calls.at(-1), ['timon:update-state']);
  await bridge.updates.open('installer', 'C:\\evil.exe');
  assert.equal(JSON.stringify(calls.at(-1)), '["timon:update-open",{"target":"installer"}]', 'a gesture, never a path');
  // P3: install carries a strict boolean, whatever the page passes.
  await bridge.updates.install('yes', 'C:\\evil.exe');
  assert.equal(JSON.stringify(calls.at(-1)), '["timon:update-install",{"confirmed":false}]');
  await bridge.updates.install(true);
  assert.equal(JSON.stringify(calls.at(-1)), '["timon:update-install",{"confirmed":true}]');
  const updateStates: unknown[] = [];
  const stopUpdates = bridge.updates.onState((state) => updateStates.push(state));
  listeners.get('timon:update-event')!({ sender: 'raw ipc event' }, { phase: 'idle' });
  assert.equal(JSON.stringify(updateStates), '[{"phase":"idle"}]');
  stopUpdates();
  assert.equal(listeners.has('timon:update-event'), false);
  // Local dictation (TODO #443): fixed channels, extra arguments dropped, audio
  // sent without a round trip, events without the raw IPC event. Objects built
  // inside the vm context have its prototypes: compare them through JSON.
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));
  assert.deepEqual(plain(Object.keys(bridge.speech)), [
    'getState', 'downloadModel', 'cancelDownload', 'deleteModel', 'startDictation', 'listModels', 'importModel', 'proposePack',
    'feed', 'stopDictation', 'cancelDictation', 'microphone', 'onEvent',
  ]);
  // The live catalog (TODO #484): no path crosses, extra arguments are dropped.
  await bridge.speech.listModels('/etc');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-list-models']);
  await bridge.speech.importModel({ family: 'whisper' }, '/home/me/model');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-import-model', { family: 'whisper' }]);
  await bridge.speech.proposePack({ pluginId: 'acme', modelId: 'acme.x' }, 'extra');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-propose-pack', { pluginId: 'acme', modelId: 'acme.x' }]);
  await bridge.speech.getState(undefined, 'untrusted extra option');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-state', null]);
  // The language crosses as a value; the main process parses it (speech-ipc.test.ts).
  // The provisional-text choice travels as is: the main process holds it to a closed list. A fourth argument is dropped.
  await bridge.speech.startDictation('parakeet-tdt-0.6b-v3-int8', 'fr-FR', 'final-only', '/etc/passwd');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-start', { modelId: 'parakeet-tdt-0.6b-v3-int8', language: 'fr-FR', interim: 'final-only' }]);
  await bridge.speech.startDictation(undefined, undefined, 'delayed');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-start', { interim: 'delayed' }]);
  await bridge.speech.startDictation(undefined, 'fr');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-start', { language: 'fr' }]);
  await bridge.speech.startDictation();
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-start', null]);
  await bridge.speech.microphone('untrusted extra option');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-microphone', { request: true }], 'only a boolean crosses');
  await bridge.speech.microphone();
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-microphone', null]);
  const samples = new Float32Array(1600);
  bridge.speech.feed('id', samples, 48_000);
  assert.equal(sent.length, 1);
  const [channel, payload] = sent[0] as [string, { sessionId: string; samples: Float32Array; sampleRate: number }];
  assert.equal(channel, 'timon:speech-feed');
  assert.equal(payload.samples, samples, 'the audio buffer crosses as is');
  assert.deepEqual([payload.sessionId, payload.sampleRate, Object.keys(payload).length], ['id', 16000, 3]);
  await bridge.speech.stopDictation('id', 'extra');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-stop', { sessionId: 'id' }]);
  const received: unknown[] = [];
  const unsubscribe = bridge.speech.onEvent((event) => received.push(event));
  listeners.get('timon:speech-event')?.({ sender: 'raw ipc event' }, { type: 'stopped', sessionId: 'id' });
  assert.deepEqual(received, [{ type: 'stopped', sessionId: 'id' }]);
  unsubscribe();
  assert.equal(listeners.has('timon:speech-event'), false);
});


test('deferred setup survives navigation but clears on the next configured launch', () => {
  const boot = { embedded: true, configuredAtLaunch: false, configuredNow: false, serviceInstalled: false };
  assert.equal(setupRestartPending(boot), false);
  const saved = { ...boot, configuredNow: true };
  assert.equal(setupRestartPending(saved), true, 'saved bootstrap configuration awaits restart on every platform');
  assert.equal(setupRestartPending({ ...saved, serviceInstalled: true }), true);
  assert.equal(setupRestartPending({ ...saved, configuredAtLaunch: true }), false, 'ordinary portable launch');
  assert.equal(setupRestartPending({ ...saved, configuredAtLaunch: true, embedded: false, serviceInstalled: true }), false, 'service took over');
});

test('a service-run daemon is restarted through its service, never by relaunching the shell', async () => {
  const calls: string[] = [];
  const restart = setupRestarter({
    validate: () => { calls.push('validate'); },
    stopEmbedded: async () => { calls.push('stop-embedded'); },
    relaunch: () => { calls.push('relaunch'); },
    quit: () => { calls.push('quit'); },
    serviceOwnsDaemon: () => true,
    restartService: async () => { calls.push('restart-service'); },
  });
  await restart();
  assert.deepEqual(calls, ['validate', 'restart-service']);
  // Still pending after that restart (the page asks again): the button must work again.
  await restart();
  assert.deepEqual(calls, ['validate', 'restart-service', 'validate', 'restart-service']);
});

test('an embedded daemon keeps the relaunch path even when a service is installed', async () => {
  const calls: string[] = [];
  const restart = setupRestarter({
    validate: () => {}, stopEmbedded: async () => { calls.push('stop-embedded'); },
    relaunch: () => { calls.push('relaunch'); }, quit: () => { calls.push('quit'); },
    serviceOwnsDaemon: () => false,
    restartService: async () => { calls.push('restart-service'); },
  });
  await restart();
  assert.deepEqual(calls, ['stop-embedded', 'relaunch', 'quit']);
});

const fresh = {
  embedded: true, configuredAtLaunch: false, configuredNow: true, serviceInstalled: true,
  serviceRefused: false, supervisor: 'systemd-user', sameOrigins: true,
};

test('a first setup that installed the service hands the embedded daemon over to it', () => {
  assert.equal(serviceHandoverNeeded(fresh), true);
  for (const supervisor of ['launchd', 'windows']) assert.equal(serviceHandoverNeeded({ ...fresh, supervisor }), true);
});

test('nothing changes where no service takes over, or where it would answer elsewhere', () => {
  for (const change of [
    { embedded: false },                 // the service already served the wizard
    { configuredAtLaunch: true },        // not a first setup
    { configuredNow: false },            // the configuration is not written yet
    { serviceInstalled: false },         // portable mode
    { supervisor: 'none' },              // portable mode, chosen
    { serviceRefused: true },            // Windows will not run the task (TODO #342)
    { sameOrigins: false },              // the window would lose its interface
  ]) assert.equal(serviceHandoverNeeded({ ...fresh, ...change }), false, JSON.stringify(change));
});

test('the handover route is a path of the interface, never another origin', () => {
  const origin = 'http://127.0.0.1:3110';
  assert.equal(handoverRoute('/setup/agent', origin), '/setup/agent');
  assert.equal(handoverRoute('/', origin), '/');
  assert.equal(handoverRoute('/setup/agent?from=setup', origin), '/setup/agent?from=setup');
  for (const route of ['//evil.example/x', 'http://evil.example/', 'setup/agent', '/\\evil.example', '', 42, null, undefined]) {
    assert.equal(handoverRoute(route, origin), null, String(route));
  }
});

function handover(over: Partial<Parameters<typeof serviceHandover>[0]> = {}) {
  const calls: string[] = [];
  const run = serviceHandover({
    needed: () => { calls.push('needed'); return true; },
    showRestarting: (route) => { calls.push(`waiting ${route}`); },
    stopEmbedded: async () => { calls.push('stop'); },
    kickService: async () => { calls.push('kick'); return true; },
    waitService: async () => { calls.push('wait'); return true; },
    resume: () => { calls.push('resume'); },
    resumeEmbedded: async () => { calls.push('embedded again'); },
    reportKept: (why) => { calls.push(`kept ${why ?? ''}`.trim()); },
    ...over,
  });
  return { run, calls };
}

test('the pages wait before the embedded daemon stops, and reopen once the service answers', async () => {
  const { run, calls } = handover();
  assert.equal(await run('/setup/agent'), 'handed-over');
  assert.deepEqual(calls, ['needed', 'waiting /setup/agent', 'stop', 'kick', 'wait', 'resume']);
});

test('a handover that is not needed touches nothing: the page goes on by itself', async () => {
  const { run, calls } = handover({ needed: () => { calls.push('needed'); return false; } });
  assert.equal(await run('/setup/agent'), 'not-needed');
  assert.deepEqual(calls, ['needed']);
});

test('a service that does not answer leaves the embedded daemon serving, and says so', async () => {
  const silent = handover({ waitService: async () => { silent.calls.push('wait'); return false; } });
  assert.equal(await silent.run('/setup/agent'), 'kept-embedded');
  assert.deepEqual(silent.calls, ['needed', 'waiting /setup/agent', 'stop', 'kick', 'wait', 'embedded again', 'kept']);
  // Windows refused to run the task: no wait on a daemon nothing starts.
  const refused = handover({ kickService: async () => { refused.calls.push('kick'); return false; } });
  assert.equal(await refused.run('/'), 'kept-embedded');
  assert.deepEqual(refused.calls, ['needed', 'waiting /', 'stop', 'kick', 'embedded again', 'kept']);
  const failing = handover({ kickService: async () => { throw new Error('systemctl failed'); } });
  assert.equal(await failing.run('/'), 'kept-embedded');
  assert.equal(failing.calls.at(-1), 'kept systemctl failed');
});

test('an embedded daemon that will not stop keeps the pages, and the error is reported', async () => {
  const stuck = handover({ stopEmbedded: async () => { throw new Error('still running'); } });
  await assert.rejects(stuck.run('/setup/agent'), /still running/);
  assert.deepEqual(stuck.calls, ['needed', 'waiting /setup/agent', 'resume']);
});

test('a double click hands over once, and a later call finds nothing left to do', async () => {
  let embedded = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { run, calls } = handover({
    needed: () => { calls.push('needed'); return embedded; },
    stopEmbedded: async () => { calls.push('stop'); await gate; embedded = false; },
  });
  const first = run('/setup/agent');
  assert.equal(run('/setup/agent'), first);
  release();
  assert.equal(await first, 'handed-over');
  assert.equal(await run('/setup/agent'), 'not-needed');
  assert.equal(calls.filter((c) => c === 'stop').length, 1);
});

test('a service that answers too late is let go before the embedded daemon serves again', async () => {
  const late = handover({
    waitService: async () => { late.calls.push('wait'); return false; },
    releaseService: async () => { late.calls.push('release'); },
  });
  assert.equal(await late.run('/setup/agent'), 'kept-embedded');
  assert.deepEqual(late.calls, ['needed', 'waiting /setup/agent', 'stop', 'kick', 'wait', 'release', 'embedded again', 'kept']);
  // A release that fails never keeps the setup from going on.
  const failing = handover({
    waitService: async () => false,
    releaseService: async () => { throw new Error('taskkill refused'); },
  });
  assert.equal(await failing.run('/'), 'kept-embedded');
  assert.deepEqual(failing.calls.slice(-2), ['embedded again', 'kept']);
});

test('a service found answering as the embedded daemon restarts is a handover, with no notice and no watch', async () => {
  const caught = handover({
    waitService: async () => false,
    resumeEmbedded: async () => { caught.calls.push('embedded again'); return 'service'; },
  });
  assert.equal(await caught.run('/setup/agent'), 'handed-over');
  assert.deepEqual(caught.calls, ['needed', 'waiting /setup/agent', 'stop', 'kick', 'embedded again']);
  const kept = handover({
    waitService: async () => false,
    resumeEmbedded: async () => { kept.calls.push('embedded again'); return 'embedded'; },
  });
  assert.equal(await kept.run('/'), 'kept-embedded');
  assert.equal(kept.calls.at(-1), 'kept');
});

/** A clock that only moves when the wait sleeps: no real timer in these tests. */
function fakeClock(): WaitClock & { slept: number } {
  let t = 0;
  const clock = { slept: 0, now: () => t, sleep: async (ms: number) => { t += ms; clock.slept += ms; } };
  return clock;
}
const down: HealthResult = { ok: false, status: null, error: 'connection refused: nothing listens on the port' };
const up: HealthResult = { ok: true, status: 200, identity: 'timon', instance: 'abc' };

test('the handover wait ends at its first budget when the service\'s process is gone', async () => {
  const clock = fakeClock();
  let asked = 0;
  const result = await waitWhileBooting({
    probe: async () => down, stillBooting: async () => { asked += 1; return false; },
    baseMs: 90_000, maxMs: 300_000, intervalMs: 1_000, clock,
  });
  assert.equal(result.health, down);
  assert.equal(result.extended, false);
  assert.ok(result.waitedMs >= 89_000 && result.waitedMs <= 90_000, String(result.waitedMs));
  assert.equal(asked, 1, 'asked once, at the end of the first budget');
});

test('the handover wait goes on while the task runs, and sees a service answering after 90 s (TIM-0158)', async () => {
  const clock = fakeClock();
  let asked = 0;
  const result = await waitWhileBooting({
    probe: async () => (clock.now() >= 150_000 ? up : down),
    stillBooting: async () => { asked += 1; return true; },
    baseMs: 90_000, maxMs: 300_000, intervalMs: 1_000, recheckMs: 10_000, clock,
  });
  assert.equal(result.health, up);
  assert.equal(result.extended, true);
  assert.equal(result.waitedMs, 150_000);
  // One query every ten seconds past the budget, never one per probe.
  assert.ok(asked >= 6 && asked <= 7, String(asked));
});

test('the handover wait never passes its cap, even with a task that keeps running', async () => {
  const clock = fakeClock();
  const result = await waitWhileBooting({
    probe: async () => down, stillBooting: async () => true,
    baseMs: 90_000, maxMs: 300_000, intervalMs: 1_000, clock,
  });
  assert.equal(result.health, down);
  assert.equal(result.extended, true);
  assert.ok(result.waitedMs < 300_000 && result.waitedMs >= 299_000, String(result.waitedMs));
});

test('the handover wait stops extending once the task ends, and a failed query counts as ended', async () => {
  const clock = fakeClock();
  const ended = await waitWhileBooting({
    probe: async () => down, stillBooting: async () => clock.now() < 120_000,
    baseMs: 90_000, maxMs: 300_000, intervalMs: 1_000, recheckMs: 10_000, clock,
  });
  assert.ok(ended.waitedMs >= 120_000 && ended.waitedMs < 131_000, String(ended.waitedMs));
  const unreadable = await waitWhileBooting({
    probe: async () => down, stillBooting: async () => { throw new Error('powershell missing'); },
    baseMs: 10_000, maxMs: 300_000, intervalMs: 1_000, clock: fakeClock(),
  });
  assert.equal(unreadable.extended, false);
  assert.ok(unreadable.waitedMs < 10_000);
});

test('the handover wait returns at once on an answer, foreign ones included', async () => {
  const foreign: HealthResult = { ok: true, status: 404, identity: 'foreign' };
  const clock = fakeClock();
  const result = await waitWhileBooting({
    probe: async () => foreign, stillBooting: async () => true, baseMs: 90_000, maxMs: 300_000, clock,
  });
  assert.equal(result.health, foreign);
  assert.equal(clock.slept, 0);
});

test('a service that shows up after the fallback gets the home, through the same handover (TIM-0158)', async () => {
  const clock = fakeClock();
  // The fake service: started by its supervisor 4 minutes after the fallback, refused the home.
  const refusedAt = 240_000;
  let embedded = true;
  const { run, calls } = handover({
    needed: () => { calls.push('needed'); return embedded; },
    stopEmbedded: async () => { calls.push('stop'); embedded = false; },
  });
  const late = lateHandover({
    serviceWaiting: (since) => clock.now() >= refusedAt && refusedAt >= since,
    handover: () => run('/setup/agent'),
    clock, intervalMs: 30_000, maxMs: 30 * 60_000,
  });
  assert.equal(await late.start(0), 'handed-over');
  assert.deepEqual(calls, ['needed', 'waiting /setup/agent', 'stop', 'kick', 'wait', 'resume']);
  assert.equal(clock.now(), 240_000);
});

test('the late watch hands nothing over without a sign of the service, and ends at its cap', async () => {
  const clock = fakeClock();
  let handovers = 0;
  let reads = 0;
  const late = lateHandover({
    serviceWaiting: () => { reads += 1; return false; },
    handover: async () => { handovers += 1; return 'handed-over'; },
    clock, intervalMs: 30_000, maxMs: 30 * 60_000,
  });
  assert.equal(await late.start(0), 'gave-up');
  assert.equal(handovers, 0);
  assert.equal(clock.now(), 30 * 60_000);
  assert.equal(reads, 59);
});

test('a refusal older than the fallback is not a sign, and a late fallback is retried once more at most', async () => {
  const clock = fakeClock();
  const refusals = [10_000, 100_000];
  const since: number[] = [];
  let handovers = 0;
  const late = lateHandover({
    serviceWaiting: (from) => { since.push(from); return refusals.some((at) => at >= from && at <= clock.now()); },
    handover: async () => { handovers += 1; refusals.push(clock.now() + 60_000); return 'kept-embedded'; },
    clock, intervalMs: 30_000, maxMs: 30 * 60_000, attempts: 2,
  });
  assert.equal(await late.start(20_000), 'gave-up');
  assert.equal(handovers, 2, 'two late handovers, then the embedded daemon keeps the home');
  assert.ok(since.every((from) => from >= 20_000));
  assert.equal(late.start(0), null, 'no third watch');
});

test('the late watch stops on quit, runs once, and a failed handover ends it', async () => {
  const clock = fakeClock();
  const late = lateHandover({ serviceWaiting: () => false, handover: async () => 'handed-over', clock });
  const watching = late.start(0);
  assert.ok(watching);
  assert.equal(late.start(0), null, 'one watch at a time');
  late.stop();
  assert.equal(await watching, 'stopped');
  const failing = lateHandover({
    serviceWaiting: () => true, handover: async () => { throw new Error('still running'); }, clock: fakeClock(),
  });
  assert.equal(await failing.start(0), 'failed');
});

test('the kept-embedded notice names the home and the reason, in the user\'s language', () => {
  const en = handoverKeptMessage('en-US', '/home/me/.timon', 'timeout');
  assert.match(en.message, /slow to start/);
  assert.doesNotMatch(en.detail, /reopen/, 'the service is taken over on its own');
  assert.match(en.detail, /\/home\/me\/\.timon/);
  assert.match(en.detail, /timeout/);
  assert.match(handoverKeptMessage('fr', 'C:\\Users\\me\\.timon', null).message, /tarde à démarrer/); // french-ok: the French locale under test
});

test('the configuration the wizard writes keeps the origins the window opened on', () => {
  // `applySetup` writes only the ports the embedded daemon got from its
  // environment (`readEnvDecisions`): no host. The handover compares origins,
  // so a host or port that changed on the way would silently skip it.
  const written = (daemonPort: number, appPort: number) => JSON.stringify({
    version: 1, edition: 'expert', profile: 'default',
    daemon: { supervisor: 'systemd-user', listen: { port: daemonPort } },
    app: { enabled: true, listen: { port: appPort } },
  });
  const origins = (home: string) => {
    const cfg = loadDesktopConfig(home, { packaged: true });
    return [originOf(cfg.daemon.listen), originOf(cfg.app.listen)];
  };
  const first = mkdtempSync(join(tmpdir(), 'timon-handover-'));
  const before = origins(first);
  writeFileSync(join(first, 'timon.config.json'), written(3010, 3110));
  assert.deepEqual(origins(first), before);
  // Ports moved at first launch (`desktop-bootstrap.json`) are written back the same way.
  const moved = mkdtempSync(join(tmpdir(), 'timon-handover-'));
  writeFileSync(join(moved, 'desktop-bootstrap.json'), JSON.stringify({ daemonPort: 41010, appPort: 41110 }));
  const bootstrap = origins(moved);
  assert.deepEqual(bootstrap, ['http://127.0.0.1:41010', 'http://127.0.0.1:41110']);
  writeFileSync(join(moved, 'timon.config.json'), written(41010, 41110));
  assert.deepEqual(origins(moved), bootstrap);
});
