// french-ok-file: the French locale of the update dialogs under test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createReleaseNotes } from '../scripts/release-notes.mjs';
import {
  DaemonStartTimeoutError, finishUpdate, LIGHT_THEME, REPLACE_BUDGET_MS, START_BUDGET_MS, readProgress, renderNotes, requestUpdate, THEME, themeFor, updateCopy, updateOffer, updatePage, updateProgressPage, updateUnauthorizedMessage,
  unmanagedDaemon, UpdateTokenMissingError, updateFailureDialog, type UpdateStatus,
} from './data-update.js';
import { instanceId, windowsBatchLauncher } from './service.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'desktop-update-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
const state = (status: UpdateStatus['status']): UpdateStatus => ({ status, daemonVersion: '0.2.0', backup: { failure: null }, error: null });

test('local preflight: fresh, legacy, older, equal and newer data; never writes', t => {
  const home = fixture(t);
  assert.equal(updateOffer(home, '0.2.0'), null);
  writeFileSync(join(home, 'timon.db'), 'unchanged');
  assert.deepEqual(updateOffer(home, '0.2.0'), { from: '0.1.0', to: '0.2.0' });
  for (const [version, pending] of [['0.1.0', true], ['0.2.0', false], ['0.3.0', false]] as const) {
    writeFileSync(join(home, 'data-version'), version);
    assert.equal(!!updateOffer(home, '0.2.0'), pending);
    assert.equal(readFileSync(join(home, 'data-version'), 'utf8'), version);
    assert.equal(readFileSync(join(home, 'timon.db'), 'utf8'), 'unchanged');
  }
});

test('the offer stands exactly when the daemon will wait for approval (TODO #535)', async t => {
  // The two packages are built apart: read the daemon's own gate.
  const daemon = await import(new URL('../../orchestrator/src/data-version.ts', import.meta.url).href) as {
    updateNeedsApproval(files: { home: string; dbPath: string; configPath: string }, version: string): boolean;
  };
  const recorded = [null, '', '0.1.0', '0.2.0-rc.1', '0.2.0', '0.3.0', 'garbage', 'v0.2', '0.1.9\n'];
  const approvals = [null, '0.2.0', '0.1.0', 'not json', '{"version":2}', 'null', '{}'];
  for (const app of ['0.2.0', '0.2.0-rc.2', 'nightly']) {
    for (const version of recorded) {
      for (const approval of approvals) {
        const home = fixture(t);
        writeFileSync(join(home, 'timon.db'), 'unchanged');
        if (version !== null) writeFileSync(join(home, 'data-version'), version);
        if (approval !== null) {
          writeFileSync(join(home, 'update-approval.json'), approval.startsWith('{') || approval === 'null' || approval === 'not json'
            ? approval : JSON.stringify({ version: approval, approvedAt: 1 }));
        }
        const files = { home, dbPath: join(home, 'timon.db'), configPath: join(home, 'timon.config.json') };
        assert.equal(!!updateOffer(home, app), daemon.updateNeedsApproval(files, app), `app ${app}, data-version ${version}, approval ${approval}`);
      }
    }
  }
});

test('an approved update whose copy blocked its migration keeps the window, where the copy is retried', t => {
  const home = fixture(t);
  writeFileSync(join(home, 'timon.db'), 'unchanged');
  writeFileSync(join(home, 'data-version'), '0.1.0');
  writeFileSync(join(home, 'update-approval.json'), JSON.stringify({ version: '0.2.0', approvedAt: 1 }));
  assert.equal(updateOffer(home, '0.2.0'), null);
  mkdirSync(join(home, 'backups'));
  const failure = (fields: object) => writeFileSync(join(home, 'backups', 'snapshot-failure.json'),
    JSON.stringify({ version: '0.2.0', message: 'disk full', at: 1, ...fields }));
  failure({ blocking: false });
  assert.equal(updateOffer(home, '0.2.0'), null);
  failure({ version: '0.1.9', blocking: true });
  assert.equal(updateOffer(home, '0.2.0'), null);
  failure({ blocking: true });
  assert.deepEqual(updateOffer(home, '0.2.0'), { from: '0.1.0', to: '0.2.0' });
  // Older failure files carry no `blocking`: the daemon reads them as blocking.
  failure({});
  assert.deepEqual(updateOffer(home, '0.2.0'), { from: '0.1.0', to: '0.2.0' });
});

test('an unreadable data-version is offered as it reads, like the daemon that waits on it', t => {
  const home = fixture(t);
  writeFileSync(join(home, 'timon.db'), 'unchanged');
  writeFileSync(join(home, 'data-version'), 'garbage');
  assert.deepEqual(updateOffer(home, '0.2.0'), { from: 'garbage', to: '0.2.0' });
  rmSync(join(home, 'data-version'));
  mkdirSync(join(home, 'data-version'));
  assert.deepEqual(updateOffer(home, '0.2.0'), { from: '0.1.0', to: '0.2.0' });
});

test('notes absent have no empty section; RC date is omitted and Markdown is escaped', t => {
  const home = fixture(t), path = join(home, 'notes.json');
  const offer = { from: '0.1.0', to: '0.2.0-rc.1' };
  const absent = updatePage(offer, path, 'fr-FR');
  assert.ok(!absent.html.includes('<section>'));
  assert.match(absent.html, /Mettre à jour Timon de 0.1.0 vers 0.2.0-rc.1/);
  writeFileSync(path, JSON.stringify(createReleaseNotes('## [Unreleased]\n<script>bad</script>\n## [0.1.0] — 2026-09-01\nOld', offer.to)));
  const page = updatePage(offer, path, 'en');
  assert.match(page.html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.ok(!page.html.includes('<script>'));
  assert.match(page.html, /<h3>0.2.0-rc.1<\/h3>/);
  assert.ok(!page.html.includes('<pre>Old</pre>'));
  assert.equal(page.links.length, 2);
});

test('the update window uses the app theme accent for its button and progress bar', t => {
  const home = fixture(t);
  const { html } = updatePage({ from: '0.1.0', to: '0.2.0' }, join(home, 'notes.json'), 'en');
  assert.ok(html.includes(`.primary{background:${THEME.primary}`));
  assert.ok(html.includes(`accent-color:${THEME.primary}`));
  assert.ok(!/#5550b5|#a5a0ff/i.test(html));
});

test('local route uses dedicated token and strict target; remote hosts never receive it', async t => {
  const home = fixture(t);
  writeFileSync(join(home, 'update-token'), 'a'.repeat(64));
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${'a'.repeat(64)}`);
    if (init?.method === 'POST') assert.deepEqual(JSON.parse(String(init.body)), { version: '0.2.0', approve: true });
    return new Response(JSON.stringify(state('ready')));
  };
  await requestUpdate('http://127.0.0.1:3010', home, undefined, fetcher);
  await requestUpdate('http://127.0.0.1:3010', home, '0.2.0', fetcher);
  await assert.rejects(requestUpdate('https://example.com', home, '0.2.0', fetcher), /local daemon/);
  assert.deepEqual(calls, ['http://127.0.0.1:3010/api/update/status', 'http://127.0.0.1:3010/api/update/approve']);
});

// A daemon started without the packaged environment has no update routes: its
// general auth answers 401 (Windows revision-1 task, 0.1.1-rc.7 → 0.1.2-rc.1).
test('a 401 says the daemon was not started by the app, and what to do', async t => {
  const home = fixture(t);
  writeFileSync(join(home, 'update-token'), 'a'.repeat(64));
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  await assert.rejects(requestUpdate('http://127.0.0.1:3010', home, undefined, fetcher), /not started by the Timon app.*\(401\).*Quit Timon/s);
});

// TIM-0087: the task written by `timon service install` of 0.1.3 and earlier
// is not "an older daemon": it is this version, run without the marker.
test('a 401 behind an unmarked Windows launcher names the service and how to repair it', async t => {
  const home = fixture(t);
  writeFileSync(join(home, 'update-token'), 'a'.repeat(64));
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(windowsBatchLauncher(home), ['@echo off', 'set "TIMON_HOME=C:\\Users\\sam\\.timon"', 'set "PORT=3010"', ''].join('\r\n'));
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const error = await requestUpdate('http://127.0.0.1:3010', home, undefined, fetcher).then(() => null, (e: Error) => e);
  assert.match(error?.message ?? '', /installed by `timon service install` from Timon 0\.1\.3 or earlier/);
  assert.match(error?.message ?? '', /accept the Windows permission prompt/);
  assert.doesNotMatch(error?.message ?? '', /older/);
  // A marked launcher is not the cause: the generic message stays.
  writeFileSync(windowsBatchLauncher(home), ['@echo off', 'set "TIMON_DESKTOP_SERVICE=1"', ''].join('\r\n'));
  assert.equal(updateUnauthorizedMessage(home), updateUnauthorizedMessage(home, false));
});

test('approval waits through pending health, reports partial warning, and only finishes on real boot', async t => {
  const home = fixture(t);
  let probes = 0, posts = 0;
  const warnings: string[] = [];
  await finishUpdate({ home, origin: 'http://127.0.0.1:3010', version: '0.2.0', locale: 'fr',
    progress: () => {}, warning: async (_, detail) => { warnings.push(detail); } }, {
    request: async (_, __, version) => {
      if (!version) return state('pending');
      posts++;
      return { ...state('ready'), backup: { failure: { blocking: false, partial: true, at: 42, message: 'Partial backup: plugins excluded' } } };
    },
    health: async () => ({ ok: true, status: 200, identity: 'timon', instance: instanceId(home), updatePending: ++probes < 4 }),
    sleep: async () => {},
  });
  assert.equal(posts, 1); assert.equal(probes, 4); assert.equal(warnings.length, 1);
  // Shown in the update window: the main window that opens next does not show it again (TIM-0068).
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'backups', 'snapshot-warning-shown.json'), 'utf8')), { at: 42 });
});

test('a migrated daemon that is slow to boot is "still starting", not a failed update', async t => {
  const home = fixture(t);
  let clock = 1_000;
  let probes = 0;
  const error = await finishUpdate({ home, origin: 'http://127.0.0.1:3010', version: '0.2.0', locale: 'en',
    progress: () => {}, warning: async () => {} }, {
    request: async () => state('ready'),
    health: async () => { probes++; return { ok: false, status: null, error: 'connection refused' }; },
    sleep: async () => { clock += 60_000; },
    now: () => clock,
  }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof DaemonStartTimeoutError, 'its own class: the shell shows a warning, never "data may have changed"');
  assert.match(error.message, /taking longer than expected/);
  assert.match(error.detail, /update completed/);
  // One probe before approval, then one per minute of the budget.
  assert.equal(probes, 1 + START_BUDGET_MS / 60_000, 'the whole budget was waited');
});

test('blocking backup or failed migration never opens the main UI', async t => {
  const home = fixture(t);
  for (const failure of [null, { blocking: true, message: 'Copy failed; data unchanged' }]) {
    let warned = false;
    await assert.rejects(finishUpdate({ home, origin: 'http://127.0.0.1:3010', version: '0.2.0', locale: 'en',
      progress: () => {}, warning: async () => { warned = true; } }, {
      request: async (_, __, version) => version ? { ...state('failed'), error: 'Migration refused', backup: { failure } } : state('pending'),
      health: async () => ({ ok: false, status: null }), sleep: async () => {},
    }), failure ? /Copy failed/ : /Migration refused/);
    assert.equal(warned, !!failure);
  }
});

test('progress tolerates missing, partial, stale and frozen files', t => {
  const home = fixture(t);
  assert.equal(readProgress(home, '0.2.0', 10), null);
  mkdirSync(join(home, 'backups'));
  const path = join(home, 'backups', 'snapshot-progress.json');
  writeFileSync(path, '{'); assert.equal(readProgress(home, '0.2.0', 10), null);
  const p = { version: '0.2.0', phase: 'plugins', copiedBytes: 42, totalBytes: 100, at: 10 };
  writeFileSync(path, JSON.stringify(p));
  assert.deepEqual(readProgress(home, '0.2.0', 10), p);
  assert.deepEqual(readProgress(home, '0.2.0', 10), p);
  assert.equal(readProgress(home, '0.2.0', 11), null);
  assert.equal(readProgress(home, '0.3.0', 10), null);
});

// Run the real startup function with all subsequent side effects made observable.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const main = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'main')!;
const compiled = ts.transpileModule(main.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: Quit before approval calls no service, API, restore or browser operation`, async () => {
    const calls: string[] = [];
    const context = {
      app: { isPackaged: true, getAppPath: () => 'app', getVersion: () => '0.2.0', quit: () => calls.push('quit') },
      uiLocale: () => 'fr', initShellLocale: async () => {},
      // main() writes its decisions to the desktop log (TODO #343).
      console: { log: () => {} }, originOf: () => 'http://127.0.0.1',
      process: { platform, resourcesPath: 'resources', env: {} },
      verifyInstalledRelease: async () => { calls.push('verify'); }, readFileSync: () => '', join,
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, APP_ICON_PATH: 'icon', applyDockIcon: () => false, readDockIcon: () => 'classic',
      windowScheme: () => 'dark', nativeTheme: { shouldUseDarkColors: true },
      desktopHome: 'home', packagedFirstRun: () => false, loadDesktopConfig: () => ({ home: 'home', daemon: { listen: {} } }), updateOffer: () => ({ from: '0.1.0', to: '0.2.0' }),
      probeHealth: async () => ({ ok: false, status: null }), hasDesktopService: () => false, unmanagedDaemon: () => null,
      updateWindow: null, updateApproved: false,
      UpdateWindow: class { choice = Promise.resolve(false); },
      NativeBrowserEngine: class { constructor() { throw new Error('Unexpected side effect'); } },
      // Web permissions of the window are set before any window, update window included.
      installWindowPermissions: () => {}, session: { defaultSession: {} }, microphone: {}, installAppMenu: () => {}, installJumpList: () => {},
        // The per-window machine header (multi-window V3) is a session hook: nothing to observe here.
        installMachineHeader: () => {}, interfaceUrl: '',
        // Spell-check dictionaries stay local: a session setting, nothing to observe here.
        keepDictionariesLocal: () => {},
        // P3: the approval screen counts missions; the new AppImage drops the previous one.
        localDaemonGet: () => async () => null, readMissionCount: async () => null, missionsAtStake: () => 0, removeAppImageBackup: async () => {}, previousAppImage: async () => null,
        // §10: no consent left by "Restart and install", so the approval screen asks.
        takeUpdateConsent: () => { calls.push('consent'); return null; }, consentApproves: () => false,
    };
    await runInNewContext(`${compiled}\nmain()`, context);
    assert.deepEqual(calls, ['verify', 'consent', 'quit']);
    assert.equal(context.updateApproved, false);
  });
}

test('real update window rejects unknown navigation, latches approval and guards closing', async t => {
  const home = fixture(t);
  const module = readFileSync(new URL('./update-window.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('window.ts', module, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find(ts.isClassDeclaration)!;
  const code = ts.transpileModule(cls.getText(tree).replace('export class', 'class'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  type Handler = (event: { preventDefault: () => void }, url?: string) => void;
  const handlers = new Map<string, Handler>();
  const opened: string[] = [];
  const scripts: string[] = [];
  const context = {
    updateCopy: () => ({ working: 'Working' }), updatePage, themeFor,
    shell: { openExternal: (url: string) => { opened.push(url); } },
    BrowserWindow: class {
      webContents = {
        setWindowOpenHandler: () => {},
        on: (name: string, fn: Handler) => handlers.set(name, fn),
        executeJavaScript: async (s: string) => { scripts.push(s); },
      };
      on(name: string, fn: Handler) { handlers.set(name, fn); }
      loadURL() { return Promise.resolve(); }
      isDestroyed() { return false; }
      destroy() {}
    },
    offer: { from: '0.1.0', to: '0.2.0' }, path: join(home, 'missing'),
  };
  const window = runInNewContext(`${code}\nnew UpdateWindow(offer, path, 'en')`, context) as { choice: Promise<boolean>; close: () => void };
  let prevented = 0;
  const event = { preventDefault: () => { prevented++; } };
  handlers.get('will-navigate')!(event, 'https://untrusted.example');
  assert.equal(opened.length, 0);
  handlers.get('will-navigate')!(event, 'timon-update:approve');
  handlers.get('will-navigate')!(event, 'timon-update:approve');
  assert.equal(await window.choice, true);
  assert.equal(scripts.length, 1);
  handlers.get('close')!(event);
  assert.equal(prevented, 4);
  window.close();
  handlers.get('close')!(event);
  assert.equal(prevented, 4);
});

test('the approval screen counts running missions: Wait / Update anyway, then nothing once approved (P3)', async t => {
  const home = fixture(t);
  const module = readFileSync(new URL('./update-window.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('window.ts', module, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find(ts.isClassDeclaration)!;
  const code = ts.transpileModule(cls.getText(tree).replace('export class', 'class'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  type Handler = (event: { preventDefault: () => void }, url?: string) => void;
  const handlers = new Map<string, Handler>();
  const scripts: string[] = [];
  const timers: { fn: () => void; cleared: boolean }[] = [];
  let count = 2;
  let asked = 0;
  const context = {
    updateCopy, updatePage, themeFor, MISSIONS_POLL_MS: 5000,
    setInterval: (fn: () => void) => { const timer = { fn, cleared: false }; timers.push(timer); return timer; },
    clearInterval: (timer: { cleared: boolean }) => { timer.cleared = true; },
    shell: { openExternal: () => {} },
    BrowserWindow: class {
      webContents = {
        setWindowOpenHandler: () => {},
        on: (name: string, fn: Handler) => handlers.set(name, fn),
        executeJavaScript: async (s: string) => { scripts.push(s); },
      };
      on(name: string, fn: Handler) { handlers.set(name, fn); }
      loadURL() { return Promise.resolve(); }
      isDestroyed() { return false; }
      destroy() {}
    },
    offer: { from: '0.1.0', to: '0.2.0' }, path: join(home, 'missing'),
    countMissions: async () => { asked++; return count; },
  };
  const window = runInNewContext(`${code}\nnew UpdateWindow(offer, path, 'en', 'dark', countMissions)`, context) as { choice: Promise<boolean> };
  const event = { preventDefault: () => {} };
  handlers.get('did-finish-load')!(event);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(scripts.at(-1)!, /2 missions are running on Timon 0\.1\.0/);
  assert.match(scripts.at(-1)!, /"Wait"/);
  assert.match(scripts.at(-1)!, /"Update anyway"/);
  assert.match(scripts.at(-1)!, /m\.hidden = false/);
  count = 0;
  timers[0]!.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(scripts.at(-1)!, /m\.hidden = true/);
  assert.match(scripts.at(-1)!, /"Quit"/);
  assert.match(scripts.at(-1)!, /"Update"/);
  handlers.get('will-navigate')!(event, 'timon-update:approve');
  assert.equal(await window.choice, true);
  assert.equal(timers[0]!.cleared, true);
  const before = asked;
  handlers.get('did-finish-load')!(event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asked, before);
  const page = updatePage({ from: '0.1.0', to: '0.2.0' }, join(home, 'missing'), 'en').html;
  assert.match(page, /<p id="missions" class="missions" role="alert" hidden><\/p>/);
});

test('§10: a consent for this exact update shows a progress only, without the missions guard; any other asks as before', async () => {
  for (const [label, consent, approves] of [
    ['matching', { from: '0.1.0', to: '0.2.0' }, true], ['other version', { from: '0.1.0', to: '0.3.0' }, false], ['none', null, false],
  ] as const) {
    const calls: string[] = [];
    const built: { countMissions: unknown; preApproved: unknown }[] = [];
    const logs: string[] = [];
    const offer = { from: '0.1.0', to: '0.2.0' };
    const context = {
      app: { isPackaged: true, getAppPath: () => 'app', getVersion: () => '0.2.0', quit: () => calls.push('quit') },
      uiLocale: () => 'en', initShellLocale: async () => {},
      console: { log: (line: string) => { logs.push(line); } }, originOf: () => 'http://127.0.0.1',
      process: { platform: 'linux', resourcesPath: 'resources', env: {} },
      verifyInstalledRelease: async () => {}, readFileSync: () => '', join,
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, APP_ICON_PATH: 'icon', applyDockIcon: () => false, readDockIcon: () => 'classic',
      windowScheme: () => 'dark', nativeTheme: { shouldUseDarkColors: true },
      desktopHome: 'home', packagedFirstRun: () => false, loadDesktopConfig: () => ({ home: 'home', daemon: { listen: {} } }), updateOffer: () => offer,
      probeHealth: async () => ({ ok: false, status: null }), hasDesktopService: () => false, unmanagedDaemon: () => null,
      updateWindow: null, updateApproved: false,
      UpdateWindow: class {
        choice = Promise.resolve(false);
        constructor(...args: unknown[]) { built.push({ countMissions: args[4], preApproved: args[5] }); }
      },
      installWindowPermissions: () => {}, session: { defaultSession: {} }, microphone: {}, installAppMenu: () => {}, installJumpList: () => {},
      installMachineHeader: () => {}, interfaceUrl: '', keepDictionariesLocal: () => {},
      localDaemonGet: () => async () => null, readMissionCount: async () => null, missionsAtStake: () => 0, removeAppImageBackup: async () => {}, previousAppImage: async () => null,
      takeUpdateConsent: (home: string) => { calls.push(`take ${home}`); return consent; },
      consentApproves: (given: unknown, seen: unknown) => { assert.equal(given, consent); assert.equal(seen, offer); return approves; },
    };
    await runInNewContext(`${compiled}\nmain()`, context);
    assert.deepEqual(calls, ['take home', 'quit'], label);
    assert.equal(built.length, 1, label);
    assert.equal(built[0]!.preApproved, approves, label);
    assert.equal(typeof built[0]!.countMissions, approves ? 'undefined' : 'function', `${label}: the missions guard`);
    if (consent) assert.ok(logs.some(line => line.includes(approves ? 'approves this update' : 'does not match')), logs.join('\n'));
  }
});

test('§10: the pre-approved window shows a progress, answers at once and cannot be closed mid-migration', async t => {
  const home = fixture(t);
  const module = readFileSync(new URL('./update-window.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('window.ts', module, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find(ts.isClassDeclaration)!;
  const code = ts.transpileModule(cls.getText(tree).replace('export class', 'class'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  type Handler = (event: { preventDefault: () => void }, url?: string) => void;
  const handlers = new Map<string, Handler>();
  const scripts: string[] = [];
  const loaded: string[] = [];
  let asked = 0;
  const context = {
    updateCopy, updatePage, updateProgressPage, themeFor,
    setInterval: () => { throw new Error('no missions poll'); }, clearInterval: () => {},
    shell: { openExternal: () => { throw new Error('nothing to open'); } },
    BrowserWindow: class {
      webContents = {
        setWindowOpenHandler: () => {},
        on: (name: string, fn: Handler) => handlers.set(name, fn),
        executeJavaScript: async (s: string) => { scripts.push(s); },
      };
      on(name: string, fn: Handler) { handlers.set(name, fn); }
      loadURL(url: string) { loaded.push(decodeURIComponent(url)); return Promise.resolve(); }
      isDestroyed() { return false; }
      destroy() {}
    },
    offer: { from: '0.1.0', to: '0.2.0' }, path: join(home, 'missing'),
    countMissions: async () => { asked++; return 3; },
  };
  const window = runInNewContext(`${code}\nnew UpdateWindow(offer, path, 'en', 'dark', countMissions, true)`, context) as {
    choice: Promise<boolean>; progress: (message: string) => void; close: () => void;
  };
  assert.equal(await window.choice, true);
  assert.equal(asked, 0);
  assert.equal(handlers.has('did-finish-load'), false);
  const page = loaded[0]!;
  assert.match(page, /Updating Timon to 0\.2\.0/);
  assert.match(page, /Preparing the update…/);
  assert.doesNotMatch(page, /timon-update:|id="intro"|id="missions"|<footer|<section|<a /);
  handlers.get('will-navigate')!({ preventDefault: () => {} }, 'timon-update:quit');
  let prevented = 0;
  handlers.get('close')!({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1, 'closing would interrupt the migration');
  window.progress('Copying data');
  assert.match(scripts.at(-1)!, /Copying data/);
  assert.match(scripts.at(-1)!, /if \(e\) e\.hidden = true/);
  window.close();
});

test('a refused AppImage update offers "Go back to x.y.z" between Quit and Update, only when the previous file is there', t => {
  const home = fixture(t);
  const offer = { from: '0.1.8', to: '0.2.0' };
  const offered = updatePage(offer, join(home, 'missing'), 'en', 'dark', true).html;
  assert.match(offered, /id="quit"[^>]*>Quit<\/a><a class="button" id="rollback" role="button" href="timon-update:rollback">Go back to 0\.1\.8<\/a><a class="button primary" id="approve"/);
  assert.match(offered, /Go back to 0\.1\.8 puts that version back and opens it\./);
  assert.doesNotMatch(offered, /reinstall its installer/);
  assert.match(offered, /footer\{display:flex;flex-wrap:wrap;/, 'three buttons wrap in a narrow window');
  assert.match(updatePage(offer, join(home, 'missing'), 'fr', 'dark', true).html, />Revenir à 0\.1\.8<\/a>/);
  for (const plain of [updatePage(offer, join(home, 'missing'), 'en').html, updatePage(offer, join(home, 'missing'), 'en', 'dark', false).html]) {
    assert.doesNotMatch(plain, /rollback|Go back to/);
    assert.match(plain, /reinstall its installer/);
  }
});

test('"Go back to x.y.z" refuses the update, says it is going back and locks the screen', async t => {
  const home = fixture(t);
  const module = readFileSync(new URL('./update-window.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('window.ts', module, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find(ts.isClassDeclaration)!;
  const code = ts.transpileModule(cls.getText(tree).replace('export class', 'class'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  type Handler = (event: { preventDefault: () => void }, url?: string) => void;
  for (const rollback of [true, false]) {
    const handlers = new Map<string, Handler>();
    const scripts: string[] = [];
    const timers: { cleared: boolean }[] = [];
    let asked = 0;
    const context = {
      updateCopy, updatePage, updateProgressPage, themeFor, MISSIONS_POLL_MS: 5000,
      setInterval: () => { const timer = { cleared: false }; timers.push(timer); return timer; },
      clearInterval: (timer: { cleared: boolean }) => { timer.cleared = true; },
      shell: { openExternal: () => { throw new Error('nothing to open'); } },
      BrowserWindow: class {
        webContents = {
          setWindowOpenHandler: () => {},
          on: (name: string, fn: Handler) => handlers.set(name, fn),
          executeJavaScript: async (s: string) => { scripts.push(s); },
        };
        on(name: string, fn: Handler) { handlers.set(name, fn); }
        loadURL() { return Promise.resolve(); }
        isDestroyed() { return false; }
        destroy() {}
      },
      offer: { from: '0.1.8', to: '0.2.0' }, path: join(home, 'missing'), rollback,
      countMissions: async () => { asked++; return 2; },
    };
    const window = runInNewContext(`${code}\nnew UpdateWindow(offer, path, 'en', 'dark', countMissions, false, rollback)`, context) as {
      choice: Promise<boolean>; rollbackChosen: boolean;
    };
    let settled: boolean | undefined;
    void window.choice.then(value => { settled = value; });
    const event = { preventDefault: () => {} };
    handlers.get('will-navigate')!(event, 'timon-update:rollback');
    await new Promise(resolve => setImmediate(resolve));
    if (!rollback) {
      assert.equal(settled, undefined, 'no previous AppImage: the link does nothing');
      assert.equal(window.rollbackChosen, false);
      handlers.get('will-navigate')!(event, 'timon-update:quit');
      assert.equal(await window.choice, false);
      assert.equal(window.rollbackChosen, false);
      continue;
    }
    assert.equal(settled, false);
    assert.equal(window.rollbackChosen, true);
    assert.equal(timers[0]!.cleared, true, 'the missions are no longer counted');
    assert.match(scripts.at(-1)!, /Going back to Timon 0\.1\.8…/);
    assert.match(scripts.at(-1)!, /\['approve', 'quit', 'rollback'\]/);
    const written = scripts.length;
    handlers.get('will-navigate')!(event, 'timon-update:approve');
    handlers.get('did-finish-load')!(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scripts.length, written, 'neither an approval nor a missions count follows the choice');
    assert.equal(asked, 0);
  }
});

test('main: a refused AppImage update offers the way back when the previous file is there, and takes it on request', async () => {
  for (const [label, platform, previous, preApproved, chosen] of [
    ['linux, previous present, going back', 'linux', '/apps/.Timon.AppImage.previous', false, true],
    ['linux, previous present, quit', 'linux', '/apps/.Timon.AppImage.previous', false, false],
    ['linux, no previous', 'linux', null, false, false],
    ['linux, pre-approved', 'linux', '/apps/.Timon.AppImage.previous', true, false],
    ['macOS', 'darwin', '/apps/.Timon.AppImage.previous', false, false],
  ] as const) {
    const calls: string[] = [];
    const built: unknown[] = [];
    const offer = { from: '0.1.8', to: '0.2.0' };
    const context = {
      app: { isPackaged: true, getAppPath: () => 'app', getVersion: () => '0.2.0', quit: () => calls.push('quit') },
      uiLocale: () => 'en', initShellLocale: async () => {},
      console: { log: () => {} }, originOf: () => 'http://127.0.0.1',
      process: { platform, resourcesPath: 'resources', env: { APPIMAGE: '/apps/Timon.AppImage' } },
      verifyInstalledRelease: async () => {}, readFileSync: () => '', join,
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, APP_ICON_PATH: 'icon', applyDockIcon: () => false, readDockIcon: () => 'classic',
      windowScheme: () => 'dark', nativeTheme: { shouldUseDarkColors: true },
      desktopHome: 'home', packagedFirstRun: () => false, loadDesktopConfig: () => ({ home: 'home', daemon: { listen: {} }, app: { listen: {} } }), updateOffer: () => offer,
      probeHealth: async () => ({ ok: false, status: null }), hasDesktopService: () => false, unmanagedDaemon: () => null,
      updateWindow: null, updateApproved: false,
      UpdateWindow: class {
        choice = Promise.resolve(preApproved);
        rollbackChosen = chosen;
        constructor(...args: unknown[]) { built.push(args[6]); }
      },
      NativeBrowserEngine: class { constructor() { throw new Error('the window opens after the approval only'); } },
      installWindowPermissions: () => {}, session: { defaultSession: {} }, microphone: {}, installAppMenu: () => {}, installJumpList: () => {},
      installMachineHeader: () => {}, interfaceUrl: '', keepDictionariesLocal: () => {},
      localDaemonGet: () => async () => null, readMissionCount: async () => null, missionsAtStake: () => 0,
      removeAppImageBackup: async () => { calls.push('remove previous'); },
      previousAppImage: async (appImage: string) => { calls.push(`look ${appImage}`); return previous; },
      returnToPreviousAppImage: async (given: unknown) => { assert.equal(given, offer); calls.push('go back'); },
      takeUpdateConsent: () => null, consentApproves: () => preApproved,
    };
    await runInNewContext(`${compiled}\nmain()`, context).catch((error: Error) => {
      if (!preApproved) throw error;
      assert.match(error.message, /approval only/);
    });
    const looked = platform === 'linux' && !preApproved;
    assert.deepEqual(built, [looked && previous !== null], label);
    assert.deepEqual(calls, [
      ...(looked ? ['look /apps/Timon.AppImage'] : []),
      ...(preApproved ? ['remove previous'] : chosen ? ['go back'] : ['quit']),
    ], label);
  }
});

test('going back relaunches the previous AppImage, or says what to do when it cannot', async () => {
  const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'returnToPreviousAppImage')!;
  const code = ts.transpileModule(fn.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [outcome, dialog] of [
    [{ status: 'relaunched' }, null],
    [{ status: 'restored', message: 'no pipe' }, { type: 'info', message: 'Timon 0.1.8 est remis en place', detail: 'Rouvrez Timon pour le lancer.' }],
    [{ status: 'failed', message: 'EROFS' }, { type: 'error', message: 'Impossible de remettre Timon 0.1.8 en place' }],
    [{ status: 'missing' }, { type: 'error', message: 'Impossible de remettre Timon 0.1.8 en place' }],
  ] as const) {
    const calls: string[] = [];
    const shown: Record<string, string>[] = [];
    const context = {
      process: { platform: 'linux', env: { APPIMAGE: '/apps/Timon.AppImage' }, argv: ['/apps/Timon.AppImage'] },
      desktopHome: 'home', uiLocale: () => 'fr', updateCopy,
      relaunchOptions: () => ({ args: ['--flag'] }),
      queueAppImageRelaunch: async (appImage: string, args: string[], home: string) => { calls.push(`queue ${appImage} ${args.join(' ')} ${home}`); },
      rollBackAppImage: async (appImage: string, relaunch: (path: string) => Promise<unknown>) => {
        calls.push(`roll back ${appImage}`);
        if (outcome.status === 'relaunched') await relaunch(appImage);
        return outcome;
      },
      updateWindow: { close: () => calls.push('close window') },
      dialog: { showMessageBox: async (options: Record<string, string>) => { shown.push(options); calls.push('dialog'); return { response: 0 }; } },
      app: { quit: () => calls.push('quit') },
      console: { log: () => {} },
    };
    await runInNewContext(`${code}\nreturnToPreviousAppImage({ from: '0.1.8', to: '0.2.0' })`, context);
    assert.equal(calls[0], 'roll back /apps/Timon.AppImage', outcome.status);
    if (!dialog) {
      assert.deepEqual(calls, ['roll back /apps/Timon.AppImage', 'queue /apps/Timon.AppImage --flag home', 'quit']);
      assert.equal(shown.length, 0);
      continue;
    }
    assert.deepEqual(calls.slice(1), ['close window', 'dialog', 'quit'], outcome.status);
    for (const [key, value] of Object.entries(dialog)) assert.equal(shown[0]![key], value, `${outcome.status}: ${key}`);
    if (outcome.status !== 'restored') assert.match(shown[0]!.detail!, /Vos données sont intactes/);
  }
});

test('pending health is retained by the real HTTP probe', async t => {
  const { createServer } = await import('node:http');
  const { probeHealth } = await import('./health.js');
  const server = createServer((_, response) => response.end(JSON.stringify({ service: 'timon', status: 'update_pending' })));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const result = await probeHealth(`http://127.0.0.1:${port}`);
  assert.ok(result.ok && result.updatePending);
});

test('real approval transport carries the dedicated credential and waits for its response', async t => {
  const home = fixture(t);
  writeFileSync(join(home, 'update-token'), 'b'.repeat(64));
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${'b'.repeat(64)}`);
    assert.equal(request.url, '/api/update/approve');
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.deepEqual(JSON.parse(body), { version: '0.2.0', approve: true });
      response.end(JSON.stringify(state('ready')));
    });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  assert.equal((await requestUpdate(`http://127.0.0.1:${port}`, home, '0.2.0')).status, 'ready');
});

for (const platform of ['win32', 'darwin', 'linux']) {
  for (const mode of ['none', 'pending', 'unmanaged'] as const) {
    const pending = mode === 'pending';
    const title = { none: 'no update keeps existing startup', pending: 'approval precedes service changes and ready gate',
      unmanaged: 'TODO #477: a daemon the app does not run gets no offer and opens as is' }[mode];
    test(`${platform}: ${title}`, async () => {
      const calls: string[] = [];
      const logs: string[] = [];
      const cfg = { home: 'home', daemon: { listen: {} }, app: { listen: {} } };
      const context = {
        app: { isPackaged: true, getAppPath: () => 'app', getVersion: () => '0.2.0', setLoginItemSettings: () => {} },
        uiLocale: () => 'en', initShellLocale: async () => {},
        process: { platform, resourcesPath: 'resources', execPath: 'electron', env: {} },
        verifyInstalledRelease: async () => {}, readFileSync: () => '', join,
        nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, APP_ICON_PATH: 'icon', applyDockIcon: () => false, readDockIcon: () => 'classic',
        windowScheme: () => 'dark', nativeTheme: { shouldUseDarkColors: true },
      desktopHome: 'home', packagedFirstRun: () => false, loadDesktopConfig: () => cfg,
        updateOffer: () => mode === 'none' ? null : { from: '0.1.0', to: '0.2.0' },
        unmanagedDaemon: () => mode === 'unmanaged' ? 'it was not started by the Timon app' : null,
        updateWindow: null, updateApproved: false, nativeBrowser: null, browserMedia: null, stopBrowserProvider: null,
        UpdateWindow: class { choice = Promise.resolve().then(() => { calls.push('approve'); return true; }); },
        NativeBrowserEngine: class { constructor() { calls.push('browser'); } }, NativeBrowserMedia: class {},
        sessionAnnotationRoutes: () => async () => ({ status: 503, body: null }),
        startNativeBrowserServer: async () => ({ close: () => {} }),
        offerDataRestore: async () => { calls.push('restore'); return null; },
        hasDesktopService: () => true, serviceUpgradeNeeded: () => platform !== 'win32',
        serviceRepairVerdict: () => 'task-exists', existsSync: () => true,
        windowsTaskState: async () => ({ schtasks: true, lookup: 'present', exists: true, confirmedAbsent: false }),
        forgetMissingWindowsService: () => [], repairSessionWitness: async () => 'ok',
        serviceStoppedByUser: () => false, forgetServiceStopped: () => {},
        shellDaemonRuntime: () => ({ execPath: 'node', env: {} }), upgradePackagedService: async () => { calls.push('service'); },
        originOf: () => 'http://127.0.0.1', probeHealth: async () => ({ ok: true }),
        isTimon: () => true, daemonUp: false, tray: {},
        buildTray: () => { calls.push('tray'); },
        completeApprovedUpdate: async () => { if (pending) calls.push('ready'); context.updateWindow = null; },
        showWindow: () => { calls.push('window'); }, rearmAppIfDown: () => { calls.push('rearm'); }, noteDesktopOpened: () => {}, snapshotFailure: () => null, unshownSnapshotWarning: () => null,
        console: { log: (line: string) => { logs.push(line); } }, describeHealth: () => 'Timon, this home',
        installWindowPermissions: () => {}, session: { defaultSession: {} }, microphone: {}, installAppMenu: () => {}, installJumpList: () => {},
        // The per-window machine header (multi-window V3) is a session hook: nothing to observe here.
        installMachineHeader: () => {}, interfaceUrl: '',
        // Spell-check dictionaries stay local: a session setting, nothing to observe here.
        keepDictionariesLocal: () => {},
        // P3: the approval screen counts missions; the new AppImage drops the previous one.
        localDaemonGet: () => async () => null, readMissionCount: async () => null, missionsAtStake: () => 0, removeAppImageBackup: async () => {}, previousAppImage: async () => null,
        takeUpdateConsent: () => null, consentApproves: () => false,
        // What a silent Windows installer left behind is said by the launch that follows it.
        reportSilentInstallFailure: (home: string) => { calls.push(`install-result ${home}`); },
      };
      await runInNewContext(`${compiled}\nmain()`, context);
      assert.equal(calls[0], pending ? 'approve' : 'browser');
      assert.equal(context.updateApproved, pending);
      if (mode === 'unmanaged') assert.ok(logs.some(line => /update offer: none, .*not started by the Timon app/.test(line)), logs.join('\n'));
      if (mode === 'unmanaged') assert.ok(calls.includes('window'));
      if (platform !== 'win32') assert.ok(calls.indexOf('service') < calls.indexOf('window'));
      assert.ok(calls.includes('install-result home') && calls.indexOf('install-result home') < calls.indexOf('window'), 'a failed silent install is said before the window opens');
      // TODO #485: the daemon answers, so a dead interface is rearmed as the window opens.
      assert.ok(calls.includes('rearm') && calls.indexOf('rearm') < calls.indexOf('window'));
      if (pending) assert.ok(calls.indexOf('ready') < calls.indexOf('window'));
      else assert.ok(!calls.includes('ready') && !calls.includes('approve'));
    });
  }
}

test('a wrong daemon version never receives approval', async t => {
  const home = fixture(t);
  let posts = 0;
  await assert.rejects(finishUpdate({ home, origin: 'http://127.0.0.1', version: '0.2.0', locale: 'en', progress: () => {}, warning: async () => {} }, {
    request: async (_, __, version) => { if (version) posts++; return { ...state('pending'), daemonVersion: '0.1.0' }; },
    health: async () => ({ ok: false, status: null }), sleep: async () => {},
  }), /not the installed version/);
  assert.equal(posts, 0);
});

// Windows, 0.1.7 to 0.1.8: the installer replaced the application under a
// daemon it had not ended. That daemon kept the port and the data directory,
// the installed version could not start, and every launch stopped on "The
// running daemon is not the installed version".
test('a daemon of this home on the previous version is replaced once, then the update goes on', async t => {
  const home = fixture(t);
  const order: string[] = [];
  let running = '0.1.7';
  let probes = 0;
  await finishUpdate({ home, origin: 'http://127.0.0.1:3010', version: '0.2.0', locale: 'en',
    progress: () => {}, warning: async () => {},
    replacing: () => { order.push('replacing'); }, approving: () => { order.push('approving'); } }, {
    request: async (_, __, version) => {
      order.push(version ? 'post' : `status ${running}`);
      // The installed version takes two reads to come up after the restart.
      if (!version && running === 'starting') { running = '0.2.0'; throw new Error('connection refused'); }
      return version ? state('ready') : { ...state('pending'), daemonVersion: running };
    },
    health: async () => ({ ok: true, status: 200, identity: 'timon', instance: instanceId(home), updatePending: probes++ === 0 ? false : probes < 3 }),
    sleep: async () => {},
    replaceStaleDaemon: async () => { order.push('replace'); running = 'starting'; },
  });
  assert.deepEqual(order, ['status 0.1.7', 'replacing', 'replace', 'status starting', 'status 0.2.0', 'approving', 'post']);
});

test('a previous version that cannot be replaced ends in a message that says what to do, and no approval', async t => {
  const home = fixture(t);
  const ours = async () => ({ ok: true as const, status: 200, identity: 'timon' as const, instance: instanceId(home) });
  const stale = { ...state('pending'), daemonVersion: '0.1.7' };
  const base = { home, origin: 'http://127.0.0.1:3010', version: '0.2.0', locale: 'en', progress: () => {}, warning: async () => {} };

  // The elevation was refused: the stage says the service was touched, the text says why and what to do.
  let posts = 0, replaced = 0, stage = 'none';
  const refused = await finishUpdate({ ...base, replacing: () => { stage = 'service'; } }, {
    request: async (_, __, version) => { if (version) posts++; return stale; },
    health: ours, sleep: async () => {},
    replaceStaleDaemon: async () => { replaced++; throw new Error('The service restart failed: elevation refused'); },
  }).then(() => null, (e: unknown) => e as Error);
  assert.match(refused!.message, /not the installed version: it runs 0\.1\.7, and Timon 0\.2\.0 is installed\./);
  assert.match(refused!.message, /could not replace it: The service restart failed: elevation refused/);
  assert.match(refused!.message, /Quit Timon, restart the computer, then open Timon again\./);
  assert.deepEqual({ posts, replaced, stage }, { posts: 0, replaced: 1, stage: 'service' });

  // The restart ended nothing and so did not run the task again (the host
  // adapter's refusal): its words reach the person, and the update does not
  // wait for a version nobody started.
  let asked = 0;
  const outlived = await finishUpdate(base, {
    request: async (_, __, version) => { if (version) posts++; else asked++; return stale; },
    health: ours, sleep: async () => {},
    replaceStaleDaemon: async () => {
      throw new Error('The service restart failed: a Timon program of this installation is still running and could not be ended, so the service was not started again: end the Timon programs that still run (node.exe, Timon.exe) from Task Manager or restart the computer, then open Timon again');
    },
  }).then(() => null, (e: unknown) => e as Error);
  assert.match(outlived!.message, /could not replace it: The service restart failed: a Timon program of this installation is still running and could not be ended, so the service was not started again/);
  assert.match(outlived!.message, /from Task Manager or restart the computer/);
  assert.deepEqual({ posts, asked }, { posts: 0, asked: 1 });

  // Restarted, but the installed version never answers: once, then a bounded wait.
  let clock = 5_000, reads = 0;
  replaced = 0;
  const silent = await finishUpdate(base, {
    request: async (_, __, version) => { if (version) posts++; reads++; return stale; },
    health: ours, sleep: async () => { clock += 30_000; }, now: () => clock,
    replaceStaleDaemon: async () => { replaced++; },
  }).then(() => null, (e: unknown) => e as Error);
  assert.match(silent!.message, /restarted its background service, but version 0\.2\.0 did not answer in time \(version 0\.1\.7 still answers\)/);
  assert.match(silent!.message, /restart the computer/);
  assert.equal(replaced, 1, 'replaced once, never in a loop');
  assert.equal(reads, 1 + REPLACE_BUDGET_MS / 30_000, 'the whole budget was waited, and no longer');
  assert.equal(posts, 0);

  // A shell with nothing to replace it with (no service of its own) says so at once.
  const bare = await finishUpdate(base, { request: async () => stale, health: ours, sleep: async () => {} }).then(() => null, (e: unknown) => e as Error);
  assert.match(bare!.message, /not the installed version: it runs 0\.1\.7.*Quit Timon, restart the computer/);
});

test('a daemon of another home on the port is never replaced', async t => {
  const home = fixture(t);
  const other = fixture(t);
  const stale = { ...state('pending'), daemonVersion: '0.1.7' };
  const answers = [
    { ok: true as const, status: 200, identity: 'timon' as const, instance: instanceId(other) },
    // Before the instance id existed, and a foreign server: neither proves this home.
    { ok: true as const, status: 200, identity: 'timon' as const },
    { ok: true as const, status: 200, identity: 'foreign' as const },
    { ok: false as const, status: null },
  ];
  for (const health of answers) {
    let replaced = 0, stage = 'none';
    await assert.rejects(finishUpdate({ home, origin: 'http://127.0.0.1:3010', version: '0.2.0', locale: 'en',
      progress: () => {}, warning: async () => {}, replacing: () => { stage = 'service'; } }, {
      request: async () => stale, health: async () => health, sleep: async () => {},
      replaceStaleDaemon: async () => { replaced++; },
    }), /not the installed version/);
    assert.deepEqual({ replaced, stage }, { replaced: 0, stage: 'none' }, JSON.stringify(health));
  }
});

test('an already completed boot does not require the vanished update endpoint', async t => {
  const home = fixture(t);
  writeFileSync(join(home, 'data-version'), '0.2.0');
  await finishUpdate({ home, origin: 'http://127.0.0.1', version: '0.2.0', locale: 'en', progress: () => {}, warning: async () => {} }, {
    request: async () => { throw new Error('Endpoint must not be queried'); },
    health: async () => ({ ok: true, status: 200, identity: 'timon', instance: instanceId(home) }), sleep: async () => {},
  });
});

test('release notes render the CHANGELOG Markdown subset, escaped', () => {
  const html = renderNotes([
    '### Changed',
    '',
    '- **The Mails tile is now optional.** Install it with `timon plugin add ./x`',
    '  from the source checkout.',
    '- See [the docs](https://docs.timon-ai.com) and <script>bad</script>',
    '',
    'A closing paragraph',
    'on two lines.',
  ].join('\n'));
  assert.equal(html, '<h4>Changed</h4><ul>'
    + '<li><strong>The Mails tile is now optional.</strong> Install it with <code>timon plugin add ./x</code> from the source checkout.</li>'
    + '<li>See the docs and &lt;script&gt;bad&lt;/script&gt;</li></ul>'
    + '<p>A closing paragraph on two lines.</p>');
  assert.equal(renderNotes('`**not bold**`'), '<p><code>**not bold**</code></p>');
});

test('#132: an install set to light gets a light update window', t => {
  const home = fixture(t);
  const { html } = updatePage({ from: '0.1.0', to: '0.2.0' }, join(home, 'notes.json'), 'en', 'light');
  assert.ok(html.includes(':root{color-scheme:light}'));
  assert.ok(html.includes(`background:${LIGHT_THEME.background}`));
  assert.equal(themeFor('dark'), THEME);
});

// TODO #477: a packaged RC launched on the home of a daemon run from the
// sources offered a migration from 0.1.0, then failed on ENOENT update-token.
test('TODO #477: a daemon the app does not run gets no offer; embedded and service homes always do', t => {
  const home = fixture(t);
  const ours = (extra: { packaged?: boolean } = {}) => ({ ok: true as const, status: 200, identity: 'timon' as const, instance: instanceId(home), ...extra });
  // External: the daemon says it is not packaged, or predates the field and never wrote a token.
  assert.match(unmanagedDaemon(home, ours({ packaged: false }), false, true) ?? '', /not started by the Timon app/);
  assert.match(unmanagedDaemon(home, ours(), false, false) ?? '', /never wrote an update token/);
  // Non-regression, packaged: the embedded daemon (nothing answers yet), the app's service, a packaged daemon.
  assert.equal(unmanagedDaemon(home, { ok: false, status: null, error: 'connection refused' }, false, false), null);
  assert.equal(unmanagedDaemon(home, ours({ packaged: false }), true, false), null);
  assert.equal(unmanagedDaemon(home, ours({ packaged: true }), false, false), null);
  assert.equal(unmanagedDaemon(home, ours(), false, true), null);
  // Another home or another program on the port: not this decision (the startup reports it).
  assert.equal(unmanagedDaemon(home, { ...ours({ packaged: false }), instance: instanceId(join(home, 'other')) }, false, false), null);
  assert.equal(unmanagedDaemon(home, { ok: true, status: 200, identity: 'foreign' }, false, false), null);
  // The default reads the token file of the home.
  assert.match(unmanagedDaemon(home, ours(), false) ?? '', /update token/);
  writeFileSync(join(home, 'update-token'), 'a'.repeat(64));
  assert.equal(unmanagedDaemon(home, ours(), false), null);
});

test('TODO #477: without update-token, a typed error and no request at all', async t => {
  const home = fixture(t);
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  for (const version of [undefined, '0.2.0']) {
    const error = await requestUpdate('http://127.0.0.1:3010', home, version, fetcher).then(() => null, (e: Error) => e);
    assert.ok(error instanceof UpdateTokenMissingError);
    assert.doesNotMatch(error.message, /ENOENT/);
    assert.match(error.message, /not started by the Timon app.*Nothing was sent/s);
  }
  assert.equal(calls, 0);
});

test('TODO #477: the approval stage is reached only when the approval leaves', async t => {
  const home = fixture(t);
  const health = async () => ({ ok: false as const, status: null });
  let approving = 0;
  const input = { home, origin: 'http://127.0.0.1', version: '0.2.0', locale: 'en', progress: () => {}, warning: async () => {}, approving: () => { approving++; } };
  await assert.rejects(finishUpdate(input, { request: async () => { throw new UpdateTokenMissingError(); }, health, sleep: async () => {}, now: Date.now }), UpdateTokenMissingError);
  await assert.rejects(finishUpdate(input, { request: async () => ({ ...state('pending'), daemonVersion: '0.1.0' }), health, sleep: async () => {}, now: Date.now }), /not the installed version/);
  assert.equal(approving, 0);
  const order: string[] = [];
  await assert.rejects(finishUpdate({ ...input, approving: () => { order.push('approving'); } }, {
    request: async (_, __, version) => { order.push(version ? 'post' : 'status'); if (version) throw new Error('reset'); return state('pending'); },
    health, sleep: async () => {}, now: Date.now,
  }), /reset/);
  assert.deepEqual(order, ['status', 'approving', 'post']);
});

test('TODO #477: the failure dialog says only what happened at the stage reached', () => {
  for (const locale of ['en', 'fr']) {
    const none = updateFailureDialog(locale, 'none', 'cause');
    const service = updateFailureDialog(locale, 'service', 'cause');
    const approval = updateFailureDialog(locale, 'approval', 'cause');
    for (const dialog of [none, service, approval]) assert.match(dialog.detail, /\n\ncause$/);
    assert.doesNotMatch(none.detail, /may have been replaced|a pu être remplacé|migration|ont pu être modifiées|may have changed/);
    assert.match(none.detail, locale === 'fr' ? /aucun service n’a été remplacé et vos données n’ont pas été modifiées/ : /no service was replaced and your data were not modified/);
    assert.match(service.detail, locale === 'fr' ? /la migration n’a pas commencé/ : /the migration did not start/);
    assert.doesNotMatch(service.detail, /ont pu être modifiées|may have changed/);
    assert.match(approval.detail, locale === 'fr' ? /les données ont pu être modifiées/ : /data may have changed/);
  }
});
