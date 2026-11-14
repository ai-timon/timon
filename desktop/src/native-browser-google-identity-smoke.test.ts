import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import ts from 'typescript';

/** The engine and every local module it imports, followed from its own import lines: a list kept by hand goes stale. */
async function engineModules(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const pending = ['native-browser'];
  while (pending.length) {
    const name = pending.pop()!;
    if (sources.has(name)) continue;
    const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    sources.set(name, source);
    for (const match of source.matchAll(/from '\.\/([\w-]+)\.js'/g)) pending.push(match[1]!);
  }
  return sources;
}

/**
 * A site's "Sign in with Google" popup, against stand-ins served inside the profile's session
 * (`protocol.handle`): no request leaves the machine, Google's real pages are never reached.
 */
const fixture = String.raw`
const { app, session } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { createServer } = require('node:http');
const home = process.env.TIMON_HOME;
const fail = (error) => { require('node:fs').writeSync(2, String(error?.stack ?? error) + '\n'); app.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.setPath('userData', join(home, 'shell'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// What the page's own first script sees: the shim must be there before any of the page's code.
const EARLY = '<script>window.early = Object.keys(window.chrome || {})</script>';
// A frame tells its parent what its window.chrome holds: a cross-origin one cannot be read from outside.
const FRAME_PAGE = '<script>parent.postMessage({ frame: location.host, keys: Object.keys(window.chrome || {}),'
  + ' native: Function.prototype.toString.call(window.chrome.loadTimes) }, "*")</script>';
const APP_PAGE = '<head>' + EARLY + '<title>App</title></head><button id="go" style="position:absolute;left:0;top:0;width:400px;height:200px" '
  + 'onclick="window.open(\'https://accounts.google.com/o/oauth2/v2/auth?client_id=1\', \'signin\', \'popup,width=500,height=600\')">Sign in with Google</button>'
  + '<button id="probe" style="position:absolute;left:0;top:300px;width:400px;height:200px" onclick="window.open(window.probe)">Probe</button>'
  + '<script>window.frameKeys = {}; window.addEventListener("message", (event) => {'
  + ' if (event.data && event.data.frame) window.frameKeys[event.data.frame] = event.data; else window.got = event.data; })</script>'
  + '<iframe src="https://app.example.test/frame" style="position:absolute;left:500px;top:0;width:10px;height:10px"></iframe>'
  + '<iframe src="https://frames.example.test/frame" style="position:absolute;left:500px;top:20px;width:10px;height:10px"></iframe>';
(async () => {
  await app.whenReady();
  app.dock?.hide();
  const seen = [];
  // A real request over the network: the session's header rewrite runs on it, not on protocol.handle's stand-ins.
  const probed = [];
  const server = createServer((req, res) => { probed.push(req.headers['user-agent']); res.setHeader('Content-Type', 'text/html'); res.end('<title>Probe</title>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  session.fromPath(join(home, 'browser-profiles', 'g', 'electron')).protocol.handle('https', (request) => {
    const url = new URL(request.url);
    seen.push({ host: url.hostname, path: url.pathname, ua: request.headers.get('user-agent'), hints: request.headers.get('sec-ch-ua') });
    const html = (body) => new Response(body, { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/frame') return html(FRAME_PAGE);
    if (url.hostname === 'accounts.google.com') return url.pathname === '/lookup' ? new Response('ok') : html('<head>' + EARLY + '<title>Sign in</title></head>');
    if (url.hostname === 'app.example.test') return html(APP_PAGE);
    return new Response('not found', { status: 404 });
  });
  const { NativeBrowserEngine } = await import('./native-browser.js');
  const engine = new NativeBrowserEngine(home);
  const command = (action, params = {}) => engine.command({ profileId: 'g', action, ...params });
  const evaluate = async (expression) => (await command('evaluate', { expression })).result;
  const until = async (what, check) => {
    for (let i = 0; i < 100; i++) { try { if (await check()) return; } catch {} await delay(50); }
    throw new Error('Never reached: ' + what);
  };
  const brands = 'navigator.userAgentData ? navigator.userAgentData.brands.map((entry) => entry.brand) : []';
  const CHROME_KEYS = ['loadTimes', 'csi', 'app'];
  // Google refuses a sign-in when window.chrome is empty, as Electron leaves it (native-browser-chrome-shim.ts).
  const assertChromeShim = async (where) => {
    assert.deepEqual(await evaluate('Object.keys(window.chrome)'), CHROME_KEYS, where + ': window.chrome as Chrome has it');
    assert.deepEqual(await evaluate('window.early'), CHROME_KEYS, where + ': before the page\'s first script');
    assert.equal(await evaluate('chrome.loadTimes.toString()'), 'function loadTimes() { [native code] }', where);
    assert.equal(await evaluate('Function.prototype.toString.toString()'), 'function toString() { [native code] }', where);
    assert.equal(await evaluate('typeof chrome.csi().pageT === "number" && chrome.app.getIsInstalled() === false'), true, where);
  };
  try {
    await command('start');
    await command('navigate', { url: 'https://app.example.test/' });
    await until('the site', async () => await evaluate('document.title') === 'App');
    assert.match(await evaluate('navigator.userAgent'), /Chrome\/\d+\./);
    assert.ok((await evaluate(brands)).includes('Google Chrome'), 'a site sees the Chrome identity');
    await assertChromeShim('the tab');
    await until('both frames', async () => Object.keys(await evaluate('window.frameKeys')).length === 2);
    for (const [host, frame] of Object.entries(await evaluate('window.frameKeys'))) {
      assert.deepEqual(frame.keys, CHROME_KEYS, 'the frame of ' + host);
      assert.equal(frame.native, 'function loadTimes() { [native code] }', 'the frame of ' + host);
    }
    const appTab = (await command('status')).activeTabId;
    await evaluate('window.probe = ' + JSON.stringify('http://127.0.0.1:' + server.address().port + '/probe') + '; true');
    let clicks = 0;
    await until('the probe popup', async () => {
      if (clicks++ % 20 === 0) await command('input', { event: { type: 'click', x: 100, y: 400 } });
      return probed.length > 0;
    });
    assert.doesNotMatch(probed[0], /Electron/, 'a popup\'s first request names no Electron: ' + probed[0]);
    assert.match(probed[0], /Chrome\/\d+\./);
    await until('the probe tab', async () => (await command('status')).tabs.length === 2);
    const probeTab = (await command('status')).tabs.find((entry) => entry.id !== appTab);
    await command('closeTab', { tabId: probeTab.id });
    await command('activateTab', { tabId: appTab });
    let popup = null;
    let polls = 0;
    await until('the popup', async () => {
      // A click sent before the page has painted is dropped (TODO #465): send it again until the popup opens.
      if (polls++ % 20 === 0) await command('input', { event: { type: 'click', x: 100, y: 50 } });
      const status = await command('status');
      popup = status.tabs.find((tab) => tab.id !== appTab && tab.url.startsWith('https://accounts.google.com/'));
      return popup && status.activeTabId === popup.id;
    });
    await until('the sign-in page', async () => await evaluate('document.title') === 'Sign in');
    await until('the sign-in identity', async () => !/Chrome\/\d/.test(await evaluate('navigator.userAgent')));
    assert.match(await evaluate('navigator.userAgent'), /Chrome Safari/);
    const signinBrands = await evaluate(brands);
    assert.ok(signinBrands.includes('Chromium') && !signinBrands.includes('Google Chrome'), 'Electron\'s own brands on the sign-in host: ' + signinBrands);
    assert.equal(await evaluate('!!window.opener'), true, 'the popup keeps its opener');
    await assertChromeShim('the window.open popup');
    assert.equal(await evaluate('typeof window.prompt'), 'function', 'the prompt bridge is still there');
    assert.equal(await evaluate('fetch("/lookup").then((response) => response.text())'), 'ok');
    const lookup = seen.filter((entry) => entry.path === '/lookup').at(-1);
    assert.doesNotMatch(lookup.ua, /Chrome\/\d/, 'requests of the sign-in page carry the versionless UA');
    assert.ok(!(lookup.hints ?? '').includes('Google Chrome'), 'and Electron\'s own hints');
    await evaluate('window.opener.postMessage("signed-in", "*"); true');
    // Leaving Google's host gives the popup the full identity back.
    await command('navigate', { url: 'https://app.example.test/callback' });
    await until('the full identity back', async () => /Chrome\/\d+\./.test(await evaluate('navigator.userAgent')));
    assert.ok((await evaluate(brands)).includes('Google Chrome'));
    await command('activateTab', { tabId: appTab });
    assert.equal(await evaluate('window.got'), 'signed-in', 'the site hears back from its popup');
    console.log('GOOGLE_IDENTITY_SMOKE_OK');
  } finally {
    await engine.close();
    await new Promise((resolve) => server.close(resolve));
  }
  app.exit(0);
})().catch(fail);
`;

test('Google\'s sign-in host sees a versionless UA and Electron\'s hints, in a popup that keeps its opener', {
  skip: process.env.TIMON_ELECTRON_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'timon-native-browser-google-identity-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    // The engine's modules import packages (i18n) that resolve from the desktop's own dependencies.
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
    for (const [name, source] of await engineModules()) {
      await writeFile(join(root, `${name}.js`), ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    const preloadSource = await readFile(new URL('./native-browser-preload.cts', import.meta.url), 'utf8');
    await writeFile(join(root, 'native-browser-preload.cjs'), ts.transpileModule(preloadSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText);
    new Script(fixture, { filename: 'smoke.cjs' });
    await writeFile(join(root, 'smoke.cjs'), fixture);
    const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [join(root, 'smoke.cjs')], { env, timeout: 45_000, killSignal: 'SIGKILL' })
      .catch((error: { code?: string; signal?: string; stdout?: string; stderr?: string }) => {
        throw new Error(`Electron smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`);
      });
    assert.match(stdout, /GOOGLE_IDENTITY_SMOKE_OK/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
