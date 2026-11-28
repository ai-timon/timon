/**
 * End-to-end test of computer use on a real display: `npm run test:computer-use-e2e` (in desktop/).
 *
 * Electron starts the real service (the same `startComputerUse` the app runs), opens a window with a
 * textarea, then acts as the AGENT over the private HTTP transport: screenshot, click, type, shortcut,
 * and reads what really landed in the textarea. It then reads the window as an accessibility tree, finds
 * a field and a button by name, writes the field and presses the button without touching the mouse,
 * and reads the real values back. A window capture is checked too: its size, and a click and typed text
 * through its own pixels (TIMON_E2E_REQUIRE_A11Y=1 makes a missing tree a failure; without it
 * the step is skipped with a note). It finishes by pressing the stop shortcut through the
 * service itself and checks that the next agent command is refused.
 *
 * It types and clicks on the real screen, so it only runs on CI or when TIMON_COMPUTER_USE_E2E=1.
 * On macOS without the Screen Recording / Accessibility grants it checks the clean refusal and passes
 * with "skipped: permissions".
 */
import { app, BrowserWindow, screen } from 'electron';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.env.TIMON_E2E_REPORT || join(root, 'computer-use-e2e-report.txt');
const lines = [];
function log(message) {
  lines.push(message);
  console.log(message);
}

if (process.env.CI !== 'true' && process.env.TIMON_COMPUTER_USE_E2E !== '1') {
  console.error('Refusing to run: this test types and clicks on the real screen. Set TIMON_COMPUTER_USE_E2E=1 to run it on purpose.');
  process.exit(2);
}

// Sandboxed chromium needs a SUID helper that CI images do not have; a headless virtual display has no GPU.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.disableHardwareAcceleration();
  // Some toolkits read this variable to export their tree to AT-SPI at start-up.
  process.env.ACCESSIBILITY_ENABLED = '1';
}
// On every OS: a fresh page can be read at once (the product itself asks Chromium for its tree).
app.commandLine.appendSwitch('force-renderer-accessibility');

const TYPED = 'hello timon 123';
// The agent's allowed applications: the Electron binary this test runs under, by each of its names.
const ALLOWED = [...new Set(['Electron', 'electron', 'com.github.Electron', basename(process.execPath), app.getName()])];
const timings = [];
let exitCode = 1;
let home = null;
let desktop = null;
let win = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function finish(code) {
  exitCode = code;
  try { await desktop?.close(); } catch { /* Best effort: the process exits next. */ }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* Same. */ }
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  await writeFile(reportPath, `${lines.join('\n')}\n`).catch(() => {});
  app.exit(exitCode);
}

function fail(message) {
  const error = new Error(message);
  error.expected = true;
  return error;
}

async function main() {
  // The service reads the provider descriptor from this home, never the real one.
  home = await mkdtemp(join(tmpdir(), 'timon-cu-e2e-'));
  process.env.TIMON_HOME = home;
  await app.whenReady();
  // Chromium builds its accessibility tree only when asked: without it a real backend sees an empty page.
  app.setAccessibilitySupportEnabled(true);

  const { startComputerUse, COMPUTER_STOP_SHORTCUT } = await import('../dist-e2e/computer-use-electron.js');
  desktop = await startComputerUse(home, (key) => key);
  const provider = JSON.parse(await readFile(join(home, 'computer-native', 'provider.json'), 'utf8'));

  async function send(command, args, actor = 'agent', label = command, allowedApps = ALLOWED, mode) {
    const started = performance.now();
    const response = await fetch(`${provider.origin}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.token}` },
      body: JSON.stringify({ command, args, actor, allowedApps, ...(mode ? { mode } : {}) }),
    });
    const body = await response.json();
    const ms = Math.round(performance.now() - started);
    timings.push({ label, ms, status: response.status });
    log(`  ${label.padEnd(34)} ${String(ms).padStart(6)} ms  (HTTP ${response.status})`);
    return { status: response.status, body };
  }
  async function agent(command, args, label) {
    const { status, body } = await send(command, args, 'agent', label);
    if (status !== 200 || !body.ok) throw fail(`${label ?? command} failed: HTTP ${status} ${JSON.stringify({ ...body, result: undefined })}`);
    return body.result;
  }

  log(`computer-use e2e on ${process.platform} (${process.arch}), electron ${process.versions.electron}`);
  const status = await agent('status', {}, 'status');
  log(`  display ${status.display.width}x${status.display.height} @${status.display.scaleFactor}, available=${status.available}${status.reason ? ` (${status.reason})` : ''}`);
  if (!status.available) {
    if (process.platform === 'darwin' && String(status.reason).startsWith('permission-')) {
      // The clean refusal: an action must be refused with a reason, never performed or crashed.
      const refused = await send('click', { x: 1, y: 1 }, 'agent', 'click (refused)');
      if (refused.status !== 503 || refused.body.code !== 'computer_unavailable') throw fail(`Expected a clean 503 refusal, got ${JSON.stringify(refused)}`);
      log('skipped: permissions');
      return 0;
    }
    throw fail(`Computer use should be available here, got reason=${status.reason}`);
  }
  if (status.stopped) throw fail('Service starts stopped.');

  win = new BrowserWindow({
    x: 120, y: 120, width: 640, height: 420, show: true, alwaysOnTop: true, frame: true, resizable: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const page = '<!doctype html><meta charset="utf-8"><title>timon e2e</title><body style="margin:0"><textarea id="t" style="position:absolute;left:40px;top:40px;width:480px;height:240px;font-size:24px"></textarea>'
    + '<input aria-label="Nom" style="position:absolute;left:40px;top:300px;width:240px;height:32px;font-size:20px">'
    + '<button id="go" style="position:absolute;left:300px;top:300px;height:36px;font-size:20px" onclick="document.getElementById(\'out\').textContent=\'clicked\'">Valider</button>'
    + '<p id="out" style="position:absolute;left:40px;top:350px;margin:0;font-size:20px"></p></body>';
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  win.show();
  win.focus();
  const js = (code) => win.webContents.executeJavaScript(code);
  const value = () => js('document.getElementById("t").value');
  async function expectValue(expected, label) {
    const deadline = Date.now() + 5000;
    let current = await value();
    while (current !== expected && Date.now() < deadline) { await sleep(100); current = await value(); }
    if (current !== expected) throw fail(`${label}: the textarea holds ${JSON.stringify(current)}, expected ${JSON.stringify(expected)}`);
    log(`  ✓ ${label}: ${JSON.stringify(current)}`);
  }
  await sleep(500);

  const shotTry = await send('screenshot', { maxWidth: 1280 }, 'agent', 'screenshot');
  // Hosted macOS runners differ: some grant Screen Recording to a new app, some do not. Without it the
  // capture must be refused cleanly, which is the same outcome as the permission check above.
  if (process.platform === 'darwin' && shotTry.status === 503 && shotTry.body.code === 'computer_unavailable' && /permission-/.test(String(shotTry.body.error))) {
    log('skipped: permissions');
    return 0;
  }
  if (shotTry.status !== 200 || !shotTry.body.ok) throw fail(`screenshot failed: HTTP ${shotTry.status} ${JSON.stringify({ ...shotTry.body, result: undefined })}`);
  const shot = shotTry.body.result;
  const png = Buffer.from(shot.data, 'base64');
  // JPEG starts with FF D8 FF; PNG, the fallback when the JPEG encoder gives nothing, with 89 'PNG'.
  const isJpeg = png[0] === 0xff && png[1] === 0xd8 && png[2] === 0xff;
  const isPng = png.subarray(1, 4).toString('latin1') === 'PNG';
  if (png.length < 1000 || !(shot.mimeType === 'image/jpeg' ? isJpeg : shot.mimeType === 'image/png' && isPng)) {
    throw fail(`Screenshot is not a plausible image (${shot.mimeType}, ${png.length} bytes).`);
  }
  log(`  format ${shot.mimeType}`);
  if (process.env.TIMON_E2E_REQUIRE_JPEG === '1' && shot.mimeType !== 'image/jpeg') {
    throw fail('The capture fell back to PNG: the JPEG encoder gave nothing on this system.');
  }
  const ratio = (shot.width / shot.height) / (status.display.width / status.display.height);
  if (Math.abs(ratio - 1) > 0.01 || shot.width > 1280) throw fail(`Screenshot size ${shot.width}x${shot.height} does not match the display ${status.display.width}x${status.display.height}.`);
  log(`  screenshot ${shot.width}x${shot.height}, ${png.length} bytes`);

  // Window content origin and textarea box are in points; the agent works in the screenshot's pixels.
  const box = await js('(() => { const r = document.getElementById("t").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
  const content = win.getContentBounds();
  const toImage = (point) => ({
    x: Math.round((content.x + point.x) * shot.width / status.display.width),
    y: Math.round((content.y + point.y) * shot.height / status.display.height),
  });
  const target = toImage(box);
  log(`  textarea centre: screen ${content.x + box.x},${content.y + box.y} points -> image ${target.x},${target.y}`);
  const selectAll = process.platform === 'darwin' ? 'cmd+a' : 'ctrl+a';

  log('variant 1: type, select all, delete, type');
  await agent('click', { x: target.x, y: target.y }, 'click');
  await agent('type', { text: TYPED }, 'type');
  await expectValue(TYPED, 'typed text arrived');
  await agent('key', { keys: selectAll }, `key ${selectAll}`);
  await agent('key', { keys: 'Backspace' }, 'key Backspace');
  await expectValue('', 'select all + delete cleared it');
  await agent('type', { text: 'ok' }, 'type');
  await expectValue('ok', 'final text');

  log('variant 2: without select all the full text stays');
  await js('document.getElementById("t").value = ""');
  await agent('click', { x: target.x, y: target.y }, 'click');
  await agent('type', { text: TYPED }, 'type');
  await expectValue(TYPED, 'full text');

  log('allowed applications: the guard refuses what is not listed');
  for (const [label, list] of [['empty list', []], ['other application', ['definitely-not-this-app']]]) {
    const refusedClick = await send('click', { x: target.x, y: target.y }, 'agent', `click (${label})`, list);
    if (refusedClick.status !== 403 || refusedClick.body.code !== 'computer_app_not_allowed') throw fail(`With an ${label} a click must get computer_app_not_allowed, got ${JSON.stringify(refusedClick)}`);
    const refusedType = await send('type', { text: 'LEAK' }, 'agent', `type (${label})`, list);
    if (refusedType.status !== 403 || refusedType.body.code !== 'computer_app_not_allowed') throw fail(`With an ${label} typing must be refused, got ${JSON.stringify(refusedType)}`);
    log(`  ✓ ${label}: ${refusedType.body.error}`);
  }
  await expectValue(TYPED, 'nothing was typed by the refused actions');
  // Reading stays open: a capture and a window list work with an empty list.
  await agent('screenshot', { maxWidth: 256 }, 'screenshot (any list)');

  log('list_windows and focus_window');
  const windowsOf = async (allowedApps = ALLOWED) => {
    const { status, body } = await send('list_windows', {}, 'agent', 'list_windows', allowedApps);
    if (status !== 200 || !body.ok) throw fail(`list_windows failed: HTTP ${status} ${JSON.stringify(body)}`);
    return body.result;
  };
  // The system id of our window, as list_windows writes it: macOS `<pid>:<CGWindowID>` (titles are
  // hidden without Screen Recording on the runner), Windows the HWND, Linux the X11 id, in decimal.
  const handle = win.getNativeWindowHandle();
  const expectedId = process.platform === 'darwin'
    ? `${process.pid}:${win.getMediaSourceId().split(':')[1]}`
    : process.platform === 'win32' ? (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString() : String(handle.readUInt32LE(0));
  log(`  test window id ${expectedId}`);
  const ours = (list) => list.find((w) => w.id === expectedId) ?? list.find((w) => w.title === 'timon e2e');
  const listed = await windowsOf([]);
  const mine = ours(listed);
  // The accessibility part works on our window by id, or on the front window when the list cannot name it.
  // The hosted macOS runner has no real display: its window server lists Electron's helper windows
  // on screen but not reliably the test window (ids 32 against 36, then gone). The window part is
  // checked on a real Mac instead; here it is skipped out loud, never guessed.
  if (!mine && process.platform === 'darwin' && process.env.CI) {
    log(`  skipped: macOS window list on a hosted runner (test window ${expectedId} not on screen)`);
  } else {
  if (!mine) throw fail(`The test window ${expectedId} is not in list_windows (${listed.length} windows): ${JSON.stringify(listed.map((w) => [w.id, w.app, w.title]))}`);
  log(`  ✓ listed: ${JSON.stringify(mine)}`);
  // Put another window in front, then ask for ours back.
  const other = new BrowserWindow({ x: 200, y: 200, width: 400, height: 300, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await other.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>timon e2e other</title><body>other</body>')}`);
  other.show();
  other.focus();
  await sleep(700);
  const refusedFocus = await send('focus_window', { id: mine.id }, 'agent', 'focus_window (not allowed)', ['definitely-not-this-app']);
  if (refusedFocus.status !== 403 || refusedFocus.body.code !== 'computer_app_not_allowed') throw fail(`focus_window must be refused for an unlisted application, got ${JSON.stringify(refusedFocus)}`);
  await agent('focus_window', { id: mine.id }, 'focus_window');
  let focusedNow = false;
  const focusDeadline = Date.now() + 5000;
  while (!focusedNow && Date.now() < focusDeadline) {
    // By id: the other window's title ("timon e2e other") contains ours.
    focusedNow = (await windowsOf()).find((w) => w.id === mine.id)?.focused === true;
    if (!focusedNow) await sleep(250);
  }
  if (!focusedNow) throw fail('focus_window did not bring the test window to the front (list_windows never reported it focused).');
  log('  ✓ focus_window brought the test window to the front');
  other.destroy();
  win.focus();
  await sleep(300);

  log('window capture: only the test window, coordinates in its pixels');
  const winShot = await agent('screenshot', { windowId: mine.id, maxWidth: 1280 }, 'screenshot (window)');
  if (winShot.window?.id !== mine.id) throw fail(`The window capture names ${JSON.stringify(winShot.window)}, expected ${mine.id}.`);
  // The system draws the window with its frame, which Electron's bounds may or may not count: a loose ratio.
  const outer = win.getBounds();
  const windowRatio = (winShot.width / winShot.height) / (outer.width / outer.height);
  if (Math.abs(windowRatio - 1) > 0.2 || winShot.width >= shot.width) throw fail(`Window capture ${winShot.width}x${winShot.height} does not look like the window ${outer.width}x${outer.height} (screen capture ${shot.width}x${shot.height}).`);
  log(`  window capture ${winShot.width}x${winShot.height} for a window of ${outer.width}x${outer.height} points`);
  await agent('move', { x: Math.round(winShot.width / 2), y: Math.round(winShot.height / 2) }, 'move (window pixels)');
  const pointer = screen.getCursorScreenPoint();
  if (Math.abs(pointer.x - (outer.x + outer.width / 2)) > 40 || Math.abs(pointer.y - (outer.y + outer.height / 2)) > 40) {
    throw fail(`The centre of the window capture led the pointer to ${pointer.x},${pointer.y}, not near the window centre (${JSON.stringify(outer)}).`);
  }
  const inWindow = {
    x: Math.round((content.x + box.x - outer.x) * winShot.width / outer.width),
    y: Math.round((content.y + box.y - outer.y) * winShot.height / outer.height),
  };
  await js('document.getElementById("t").value = ""');
  await agent('click', inWindow, 'click (window pixels)');
  await agent('type', { text: 'window' }, 'type');
  await expectValue('window', 'a click in the window capture reached the textarea');
  // Back to a capture of the whole screen and the text the rest of the test expects.
  await agent('screenshot', { maxWidth: 256 }, 'screenshot (screen again)');
  await js(`document.getElementById("t").value = ${JSON.stringify(TYPED)}`);
  }

  log('accessibility: find by name, set_value, press, no mouse');
  // Without the window in the list (hosted macOS) the contract applies: no windowId reads the front window.
  const windowArgs = mine ? { windowId: mine.id } : {};
  if (!mine) { win.show(); win.focus(); await sleep(500); }
  const a11yCheck = status.checks.a11y;
  if (!mine && process.platform === 'darwin' && process.env.CI) {
    // The hosted Mac exposes neither the test window in CGWindowList nor in AXWindows (only the
    // banner). The macOS accessibility is proven on a real Mac instead.
    log('  skipped: macOS a11y on a hosted runner (test window not on screen)');
  } else if (a11yCheck !== 'ok') {
    if (process.env.TIMON_E2E_REQUIRE_A11Y === '1') throw fail(`The accessibility tree is required here, got checks.a11y=${a11yCheck}.`);
    log(`  skipped: a11y (${a11yCheck})`);
  } else {
    const nameField = () => js('document.querySelector("input[aria-label=Nom]").value');
    // What the system really exposes, unfiltered, to tell a shallow tree from an unexposed page or a
    // field exposed without its actions.
    const dumpWhole = async () => {
      const whole = await send('a11y_tree', { ...windowArgs, maxDepth: 15, maxNodes: 200 }, 'agent', 'a11y_tree (whole)');
      const outline = (whole.body.result?.nodes ?? []).map((n) => `${'  '.repeat(n.depth)}${n.role} "${n.name ?? ''}" ${n.id} [${(n.actions ?? []).join(',')}]`).join('\n');
      log(`  whole tree (${whole.body.result?.nodes?.length ?? 0} nodes, truncated=${whole.body.result?.truncated}):\n${outline}`);
    };
    const findNode = async (query, accept) => {
      let tree = null;
      const until = Date.now() + 8000;
      // Chromium publishes its tree a moment after accessibility was switched on.
      while (Date.now() < until) {
        // Full depth: a web page sits deep under the window (window, pane, document, groups, field).
        tree = await agent('a11y_tree', { ...windowArgs, query, maxDepth: 15 }, `a11y_tree (${query})`);
        const found = tree.nodes.find(accept);
        if (found) return { tree, found };
        await sleep(400);
      }
      await dumpWhole();
      throw fail(`No element matching "${query}" in the accessibility tree: ${JSON.stringify(tree?.nodes.map((n) => [n.role, n.name]))}`);
    };
    // Windows only, on a failure: what UI Automation and MSAA expose, live and cached, and whether
    // each API can write the field and press the button (computer-use-a11y-win32-diag.ps1).
    const windowsDiagnostic = async (hwnd) => {
      if (process.platform !== 'win32') return;
      const script = join(root, 'scripts', 'computer-use-a11y-win32-diag.ps1');
      const run = (stage) => new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Hwnd', hwnd, '-Stage', stage],
          { timeout: 90_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => resolve(`${stdout}${stderr ? `\n[stderr] ${stderr}` : ''}${error ? `\n[exit] ${error.message.split('\n')[0]}` : ''}`));
      });
      const page = async () => `field=${JSON.stringify(await nameField())} out=${JSON.stringify(await js('document.getElementById("out").textContent'))}`;
      const reset = () => js('document.querySelector("input[aria-label=Nom]").value = ""; document.getElementById("out").textContent = ""');
      log(await run('tree'));
      for (const stage of ['uia-act', 'msaa-act']) {
        log(await run(stage));
        await sleep(600);
        log(`  diag ${stage} -> page ${await page()}`);
        await reset();
      }
    };
    const { tree: nameTree, found: field } = await findNode('Nom', (n) => n.name === 'Nom' && ['textfield', 'textarea', 'combobox'].includes(n.role));
    const windowId = nameTree.window.id;
    if ((mine && windowId !== mine.id) || !nameTree.nodes.every((n) => typeof n.id === 'string' && n.id.startsWith(`${windowId}#`))) throw fail('Element ids must be prefixed by the window id.');
    if (!field.actions.includes('set_value')) { await dumpWhole(); await windowsDiagnostic(windowId); }
    if (!field.actions.includes('set_value')) throw fail(`The field does not offer set_value: ${JSON.stringify(field)}`);
    const { found: button } = await findNode('Valider', (n) => n.role === 'button' && n.name === 'Valider');
    if (!button.actions.includes('press')) { await dumpWhole(); await windowsDiagnostic(windowId); }
    if (!button.actions.includes('press')) throw fail(`The button does not offer press: ${JSON.stringify(button)}`);
    log(`  ✓ found field ${field.id} and button ${button.id}`);
    const started = performance.now();
    await agent('a11y_tree', { ...windowArgs, maxNodes: 400 }, 'a11y_tree (400 nodes)');
    log(`  full tree read in ${Math.round(performance.now() - started)} ms (target: under 1500)`);

    const pointer = () => agent('cursor_position', {}, 'cursor_position');
    const before = await pointer();
    for (const [label, list] of [['empty list', []], ['other application', ['definitely-not-this-app']]]) {
      const refusedTree = await send('a11y_tree', windowArgs, 'agent', `a11y_tree (${label})`, list);
      const refusedSet = await send('a11y_action', { id: field.id, action: 'set_value', value: 'LEAK' }, 'agent', `a11y_action (${label})`, list);
      const refusedPress = await send('a11y_action', { id: button.id, action: 'press' }, 'agent', `a11y_action press (${label})`, list);
      for (const refused of [refusedTree, refusedSet, refusedPress]) {
        if (refused.status !== 403 || refused.body.code !== 'computer_app_not_allowed') throw fail(`With an ${label} an accessibility command must get computer_app_not_allowed, got ${JSON.stringify(refused)}`);
      }
    }
    if ((await nameField()) !== '' || (await js('document.getElementById("out").textContent')) !== '') throw fail('A refused accessibility action changed the page.');
    log('  ✓ refused for an application that is not listed');

    await agent('a11y_action', { id: field.id, action: 'set_value', value: 'timon' }, 'a11y_action set_value');
    const until = Date.now() + 5000;
    while ((await nameField()) !== 'timon' && Date.now() < until) await sleep(100);
    const written = await nameField();
    if (written !== 'timon') {
      await windowsDiagnostic(windowId);
      throw fail(`set_value: the field holds ${JSON.stringify(written)}, expected "timon".`);
    }
    log('  ✓ set_value wrote "timon" into the field');
    await agent('a11y_action', { id: button.id, action: 'press' }, 'a11y_action press');
    const pressed = Date.now() + 5000;
    while ((await js('document.getElementById("out").textContent')) !== 'clicked' && Date.now() < pressed) await sleep(100);
    if ((await js('document.getElementById("out").textContent')) !== 'clicked') {
      await windowsDiagnostic(windowId);
      throw fail('press: the button did not write "clicked".');
    }
    log('  ✓ press clicked the button');
    const after = await pointer();
    if (before.x !== after.x || before.y !== after.y) throw fail(`The accessibility actions moved the mouse: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    await expectValue(TYPED, 'the accessibility actions left the textarea alone');
    log('  ✓ the mouse did not move');

    // Background mode: the pixel, keyboard and focus commands are refused, accessibility still works.
    const back = (command, args, label) => send(command, args, 'agent', `${label ?? command} (background)`, ALLOWED, 'background');
    const pixelRefusals = [['screenshot', {}], ['click', { x: target.x, y: target.y }], ['type', { text: 'LEAK' }], ['key', { keys: 'a' }],
      ['scroll', { x: target.x, y: target.y, deltaY: 1 }], ['focus_window', { id: windowId }], ['a11y_action', { id: field.id, action: 'focus' }]];
    for (const [command, args] of pixelRefusals) {
      const refusedInBackground = await back(command, args);
      if (refusedInBackground.status !== 403 || refusedInBackground.body.code !== 'computer_background_only') throw fail(`In the background ${command} must get computer_background_only, got ${JSON.stringify(refusedInBackground)}`);
    }
    await expectValue(TYPED, 'the background refusals left the textarea alone');
    // Chromium refuses to write a field through accessibility under Windows and Linux (it does on a
    // native macOS field): in the background, where the keyboard fallback is off, the write either
    // lands or is refused with an explicit a11y_failed, never typed and never silent.
    const backgroundSet = await back('a11y_action', { id: field.id, action: 'set_value', value: 'bg' });
    if (backgroundSet.status === 200) {
      const backgroundUntil = Date.now() + 5000;
      while ((await nameField()) !== 'bg' && Date.now() < backgroundUntil) await sleep(100);
      if ((await nameField()) !== 'bg') throw fail(`Background set_value: the field holds ${JSON.stringify(await nameField())}, expected "bg".`);
      log('  ✓ background set_value wrote the field');
    } else if (backgroundSet.status === 502 && backgroundSet.body.code === 'a11y_failed') {
      if ((await nameField()) === 'bg') throw fail('A refused background set_value still changed the field.');
      log('  ✓ background set_value refused by this toolkit, cleanly and without typing');
    } else {
      throw fail(`In the background set_value must write or be refused with a11y_failed, got ${JSON.stringify(backgroundSet)}`);
    }
    const backgroundPress = await back('a11y_action', { id: button.id, action: 'press' });
    if (backgroundPress.status !== 200) throw fail(`In the background press must pass, got ${JSON.stringify(backgroundPress)}`);
    log('  ✓ background mode: pixel, keyboard and focus refused, a11y_action press passes');

    // The mode is per application: the same test application, listed with its own mode.
    const perApp = (mode) => ALLOWED.map((app) => ({ app, mode }));
    const asApp = (mode, command, args, label) => send(command, args, 'agent', `${label ?? command} (${mode} app)`, perApp(mode));
    for (const [command, args] of [['screenshot', {}], ['click', { x: target.x, y: target.y }], ['type', { text: 'LEAK' }], ['a11y_action', { id: field.id, action: 'focus' }]]) {
      const refusedForApp = await asApp('background', command, args);
      if (refusedForApp.status !== 403 || refusedForApp.body.code !== 'computer_background_only') throw fail(`For an application allowed in the background ${command} must get computer_background_only, got ${JSON.stringify(refusedForApp)}`);
    }
    const backgroundAppPress = await asApp('background', 'a11y_action', { id: button.id, action: 'press' });
    if (backgroundAppPress.status !== 200) throw fail(`For an application allowed in the background a11y_action press must pass, got ${JSON.stringify(backgroundAppPress)}`);
    log('  ✓ application allowed in the background: pixels refused with computer_background_only, a11y_action press accepted');
    for (const [command, args] of [['screenshot', { maxWidth: 256 }], ['cursor_position', {}]]) {
      const acceptedForApp = await asApp('foreground', command, args);
      if (acceptedForApp.status !== 200) throw fail(`For an application allowed in the foreground ${command} must pass, got ${JSON.stringify(acceptedForApp)}`);
    }
    const foregroundFocus = await asApp('foreground', 'a11y_action', { id: field.id, action: 'focus' });
    if (foregroundFocus.status !== 200) throw fail(`For an application allowed in the foreground the a11y focus action must pass, got ${JSON.stringify(foregroundFocus)}`);
    log('  ✓ application allowed in the foreground: pixels and focus accepted');

    const stale = await send('a11y_action', { id: `${windowId}#0.99.99`, action: 'press' }, 'agent', 'a11y_action (stale id)');
    if (stale.status !== 409 || stale.body.code !== 'a11y_element_stale') throw fail(`A stale id must get a11y_element_stale, got ${JSON.stringify(stale)}`);
    log('  ✓ a stale id is refused with a11y_element_stale');
  }

  log(`stop: pressing ${COMPUTER_STOP_SHORTCUT} through the service`);
  await agent('key', { keys: COMPUTER_STOP_SHORTCUT }, 'key (stop shortcut)');
  const deadline = Date.now() + 5000;
  let stopped = false;
  while (!stopped && Date.now() < deadline) {
    stopped = (await send('status', {}, 'human', 'status (poll)')).body.result?.stopped === true;
    if (!stopped) await sleep(200);
  }
  if (!stopped) throw fail('The stop shortcut did not stop the service (status.stopped stayed false): the global shortcut was not received.');
  const refused = await send('click', { x: target.x, y: target.y }, 'agent', 'click (after stop)');
  if (refused.status !== 409 || refused.body.code !== 'computer_stopped') throw fail(`After stop the agent must get computer_stopped, got ${JSON.stringify(refused)}`);
  await expectValue(TYPED, 'nothing changed after stop');
  log('  ✓ agent refused with computer_stopped');

  const slowest = timings.reduce((a, b) => (b.ms > a.ms ? b : a));
  log(`slowest action: ${slowest.label} ${slowest.ms} ms; total ${timings.reduce((sum, t) => sum + t.ms, 0)} ms over ${timings.length} commands`);
  log('PASS');
  return 0;
}

const watchdog = setTimeout(() => {
  log('FAIL: timed out after 240 s');
  void finish(1);
}, 240_000);
watchdog.unref();

main().then(
  (code) => finish(code),
  (error) => {
    log(`FAIL: ${error instanceof Error ? (error.expected ? error.message : error.stack ?? error.message) : String(error)}`);
    return finish(1);
  },
);
