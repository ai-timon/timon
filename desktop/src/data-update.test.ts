import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createReleaseNotes } from '../scripts/release-notes.mjs';
import {
  DaemonStartTimeoutError, finishUpdate, LIGHT_THEME, START_BUDGET_MS, readProgress, renderNotes, requestUpdate, THEME, themeFor, updateCopy, updateOffer, updatePage, updateUnauthorizedMessage,
  unmanagedDaemon, UpdateTokenMissingError, updateFailureDialog, type UpdateStatus,
} from './data-update.js';
import { instanceId, windowsLauncher } from './service.js';

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
  writeFileSync(windowsLauncher(home), ['@echo off', 'set "TIMON_HOME=C:\\Users\\sam\\.timon"', 'set "PORT=3010"', ''].join('\r\n'));
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const error = await requestUpdate('http://127.0.0.1:3010', home, undefined, fetcher).then(() => null, (e: Error) => e);
  assert.match(error?.message ?? '', /installed by `timon service install` from Timon 0\.1\.3 or earlier/);
  assert.match(error?.message ?? '', /accept the Windows permission prompt/);
  assert.doesNotMatch(error?.message ?? '', /older/);
  // A marked launcher is not the cause: the generic message stays.
  writeFileSync(windowsLauncher(home), ['@echo off', 'set "TIMON_DESKTOP_SERVICE=1"', ''].join('\r\n'));
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
      process: { platform, resourcesPath: 'resources' },
      verifyInstalledRelease: async () => { calls.push('verify'); }, readFileSync: () => '', join,
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, APP_ICON_PATH: 'icon',
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
        localDaemonGet: () => async () => null, readMissionCount: async () => null, missionsAtStake: () => 0, removeAppImageBackup: async () => {},
    };
    await runInNewContext(`${compiled}\nmain()`, context);
    assert.deepEqual(calls, ['verify', 'quit']);
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
        nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, APP_ICON_PATH: 'icon',
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
        localDaemonGet: () => async () => null, readMissionCount: async () => null, missionsAtStake: () => 0, removeAppImageBackup: async () => {},
      };
      await runInNewContext(`${compiled}\nmain()`, context);
      assert.equal(calls[0], pending ? 'approve' : 'browser');
      assert.equal(context.updateApproved, pending);
      if (mode === 'unmanaged') assert.ok(logs.some(line => /update offer: none, .*not started by the Timon app/.test(line)), logs.join('\n'));
      if (mode === 'unmanaged') assert.ok(calls.includes('window'));
      if (platform !== 'win32') assert.ok(calls.indexOf('service') < calls.indexOf('window'));
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
