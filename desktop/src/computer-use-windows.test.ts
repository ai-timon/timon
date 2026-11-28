import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerCommandError, parseAllowedApps, parseComputerCommand } from './computer-use-protocol.js';
import type { SystemCommand } from './computer-use-input.js';
import { appMode, focusWindow, isAppAllowed, listWindows, readForegroundApp, windowApp } from './computer-use-windows.js';

test('the allow-list compares case-insensitively with the bundle id, the displayed name or the executable', () => {
  const app = { bundle: 'com.microsoft.VSCode', name: 'Visual Studio Code', exe: 'Code' };
  for (const entry of ['com.microsoft.vscode', 'VISUAL STUDIO CODE', 'code', ' Code ', 'code.exe']) assert.equal(isAppAllowed(app, [entry]), true, entry);
  assert.equal(isAppAllowed({ name: 'Notepad', exe: 'notepad' }, ['Notepad.EXE']), true);
  assert.equal(isAppAllowed(app, ['Cod']), false, 'no partial match');
  assert.equal(isAppAllowed(app, []), false, 'an empty list allows nothing');
  assert.equal(isAppAllowed(app, ['', '  ']), false);
  assert.equal(isAppAllowed(null, ['code']), false);
});

test('Windows: reads go through the worker, as one JSON line', async () => {
  const seen: SystemCommand[] = [];
  const exec = async (command: SystemCommand) => {
    seen.push(command);
    const query = JSON.parse(command.worker!.input) as { q: string };
    if (query.q === 'foreground') return { stdout: '{"name":"Notepad","exe":"notepad"}' };
    if (query.q === 'windows') return { stdout: '[{"id":"197284","title":"a.txt - Notepad","app":"Notepad","exe":"notepad","focused":true}]' };
    return { stdout: '{"ok":true}' };
  };
  assert.deepEqual(await readForegroundApp('win32', exec), { name: 'Notepad', exe: 'notepad' });
  assert.deepEqual(await listWindows('win32', exec), [{ id: '197284', title: 'a.txt - Notepad', app: 'Notepad', focused: true }]);
  assert.deepEqual(await windowApp('win32', exec, '197284'), { name: 'Notepad', exe: 'notepad' });
  assert.equal(await focusWindow('win32', exec, '197284'), true);
  assert.ok(seen.every((c) => c.file === 'powershell.exe' && c.worker?.reply === true));
  assert.equal(JSON.parse(seen.at(-1)!.env!.TIMON_CU_QUERY!).id, '197284', 'the one-shot form carries the same request');
});

test('Linux: xdotool lists visible windows, names their application and activates one', async () => {
  const calls: string[] = [];
  const exec = async (command: SystemCommand) => {
    calls.push([command.file, ...command.args].join(' '));
    const [verb, id] = command.args;
    if (command.file === 'ps') return { stdout: 'firefox\n' };
    if (verb === 'getactivewindow') return { stdout: '4242\n' };
    if (verb === 'search') return { stdout: '4242\n9001\n; rm -rf /\n' };
    if (verb === 'getwindowname') return { stdout: id === '4242' ? 'Docs - Firefox\n' : 'Terminal\n' };
    if (verb === 'getwindowpid') return { stdout: id === '4242' ? '77\n' : '78\n' };
    if (command.file === 'xprop') return { stdout: command.args[1] === '4242' ? 'WM_CLASS(STRING) = "Navigator", "Firefox"\n' : 'WM_CLASS(STRING) = "xterm", "XTerm"\n' };
    return { stdout: '' };
  };
  const windows = await listWindows('linux', exec);
  assert.deepEqual(windows.map((w) => [w.id, w.title, w.app, w.focused]), [['4242', 'Docs - Firefox', 'Firefox', true], ['9001', 'Terminal', 'XTerm', false]]);
  assert.ok(!calls.some((line) => line.includes('rm -rf')), 'a line that is not a window number is never used');
  assert.deepEqual(await readForegroundApp('linux', exec), { name: 'Firefox', exe: 'firefox' });
});

test('Linux: without xprop the process name names the application, and the missing tool is asked once', async () => {
  const calls: string[] = [];
  const exec = async (command: SystemCommand) => {
    calls.push(command.file);
    const [verb] = command.args;
    if (command.file === 'xprop') throw Object.assign(new Error('spawn xprop ENOENT'), { code: 'ENOENT' });
    if (command.file === 'ps') return { stdout: 'firefox\n' };
    if (verb === 'getactivewindow') return { stdout: '1\n' };
    if (verb === 'search') return { stdout: '1\n2\n3\n' };
    if (verb === 'getwindowname') return { stdout: 'w\n' };
    if (verb === 'getwindowpid') return { stdout: '77\n' };
    return { stdout: '' };
  };
  const windows = await listWindows('linux', exec);
  assert.deepEqual(windows.map((w) => w.app), ['firefox', 'firefox', 'firefox']);
  assert.equal(calls.filter((file) => file === 'xprop').length, 1);
});

test('Linux: the frame windows Mutter draws decorations in are not listed, so each window comes out once', async () => {
  // xdotool finds every decorated window twice under Mutter X11: the client, and its frame window
  // (same title) owned by the mutter-x11-frames process. Ids: client 31457283 = 0x1e00003, 37748743 = 0x2400007.
  const scripted = (clientList: string) => async (command: SystemCommand) => {
    const [verb, id] = command.args;
    if (command.file === 'xprop' && verb === '-root') return { stdout: clientList };
    if (command.file === 'xprop') return { stdout: id === '31457283' ? 'WM_CLASS(STRING) = "Navigator", "Firefox"\n' : id === '37748743' ? 'WM_CLASS(STRING) = "gnome-terminal-server", "Gnome-terminal"\n' : 'WM_CLASS(STRING) = "mutter-x11-frames", "mutter-x11-frames"\n' };
    if (command.file === 'ps') return { stdout: id === '1' ? 'firefox\n' : id === '2' ? 'gnome-terminal-\n' : 'mutter-x11-fram\n' };
    if (verb === 'getactivewindow') return { stdout: '31457283\n' };
    if (verb === 'search') return { stdout: '8388614\n31457283\n8388620\n37748743\n' };
    if (verb === 'getwindowname') return { stdout: id === '31457283' || id === '8388614' ? 'Docs - Firefox\n' : 'Terminal\n' };
    if (verb === 'getwindowpid') return { stdout: id === '31457283' ? '1\n' : id === '37748743' ? '2\n' : '3\n' };
    return { stdout: '' };
  };
  const expected = [['31457283', 'Docs - Firefox', 'Firefox', true], ['37748743', 'Terminal', 'Gnome-terminal', false]];

  const withClientList = scripted('_NET_CLIENT_LIST(WINDOW): window id # 0x1e00003, 0x2400007\n');
  assert.deepEqual((await listWindows('linux', withClientList)).map((w) => [w.id, w.title, w.app, w.focused]), expected);
  assert.equal(await windowApp('linux', withClientList, '8388614'), null, 'a frame id is no window of the list');
  assert.deepEqual(await windowApp('linux', withClientList, '31457283'), { name: 'Firefox', exe: 'firefox' });
  assert.deepEqual(await readForegroundApp('linux', withClientList), { name: 'Firefox', exe: 'firefox' });

  // No client list published (no window manager, or an unreadable root): the frame class is dropped instead.
  const withoutClientList = scripted('_NET_CLIENT_LIST:  not found.\n');
  assert.deepEqual((await listWindows('linux', withoutClientList)).map((w) => [w.id, w.title, w.app, w.focused]), expected);
});

test('Linux focus: falls back to map, raise and focus without a window manager, and checks the result', async () => {
  let active = '4242';
  const calls: string[] = [];
  const exec = (works: string) => async (command: SystemCommand) => {
    calls.push(command.args.join(' '));
    const [verb, id] = command.args;
    if (verb === 'getactivewindow') return { stdout: `${active}\n` };
    if (verb === works) active = id === '--sync' ? command.args[2]! : id!;
    if (verb === 'windowactivate') throw new Error('no window manager');
    return { stdout: '' };
  };
  assert.equal(await focusWindow('linux', exec('windowfocus'), '9001'), true);
  assert.deepEqual(calls.filter((line) => !line.startsWith('getactive')), ['windowactivate --sync 9001', 'windowmap --sync 9001', 'windowraise --sync 9001', 'windowfocus --sync 9001']);
  active = '4242';
  await assert.rejects(focusWindow('linux', exec('nothing'), '9001'), /did not become active/);
});

test('macOS: the foreground application and the window list come from fixed JXA scripts', async () => {
  const exec = async (command: SystemCommand) => {
    assert.equal(command.file, 'osascript');
    return { stdout: command.args[3]!.includes('frontmostApplication') ? '{"bundle":"com.apple.Safari","name":"Safari","exe":"Safari"}' : '[]' };
  };
  assert.deepEqual(await readForegroundApp('darwin', exec), { bundle: 'com.apple.Safari', name: 'Safari', exe: 'Safari' });
  assert.deepEqual(await listWindows('darwin', exec), []);
  assert.equal(await focusWindow('darwin', async (command) => { assert.equal(command.args.at(-1), '[12,3]'); return { stdout: 'ok' }; }, '12:3'), true);
  assert.equal(await focusWindow('darwin', exec, 'a:b'), false, 'a malformed id never reaches the script');
});

test('a failing or garbled read gives no application', async () => {
  assert.equal(await readForegroundApp('darwin', async () => { throw new Error('boom'); }), null);
  assert.equal(await readForegroundApp('win32', async () => ({ stdout: 'not json' })), null);
  assert.deepEqual(await listWindows('win32', async () => ({ stdout: '[{"id":"../x","title":"t","app":"A"}]' })), [], 'an id that is not plain is dropped');
});

test('appMode reads the mode of the entry naming the application, the stricter one when two disagree', () => {
  const app = { bundle: 'com.apple.Notes', name: 'Notes', exe: 'Notes' };
  assert.equal(appMode(app, [{ app: 'notes', mode: 'background' }]), 'background');
  assert.equal(appMode(app, ['Notes']), 'foreground', 'a bare name is the foreground without a default');
  assert.equal(appMode(app, ['Notes'], 'background'), 'background');
  assert.equal(appMode(app, [{ app: 'com.apple.Notes', mode: 'foreground' }, { app: 'Notes', mode: 'background' }]), 'background');
  assert.equal(appMode(app, [{ app: 'Mail', mode: 'foreground' }]), null);
  assert.equal(appMode(null, [{ app: 'Notes', mode: 'foreground' }]), null);
});

test('the new commands and the allowed list are validated', () => {
  assert.deepEqual(parseComputerCommand('list_windows', {}), { command: 'list_windows' });
  assert.deepEqual(parseComputerCommand('focus_window', { id: '12:3' }), { command: 'focus_window', id: '12:3' });
  for (const id of [undefined, '', '../x', 'a b', 5]) assert.throws(() => parseComputerCommand('focus_window', { id }), ComputerCommandError);
  assert.deepEqual(parseAllowedApps(undefined), []);
  assert.deepEqual(parseAllowedApps(['Notepad']), [{ app: 'Notepad', mode: 'foreground' }], 'a bare name takes the default mode');
  assert.deepEqual(parseAllowedApps(['Notepad'], 'background'), [{ app: 'Notepad', mode: 'background' }]);
  assert.deepEqual(parseAllowedApps(['Notes', { app: 'Discord', mode: 'foreground' }], 'background'), [{ app: 'Notes', mode: 'background' }, { app: 'Discord', mode: 'foreground' }]);
  assert.throws(() => parseAllowedApps([{ app: 'Notes', mode: 'sideways' }]), ComputerCommandError);
  assert.throws(() => parseAllowedApps([{ mode: 'background' }]), ComputerCommandError);
  assert.throws(() => parseAllowedApps('Notepad'), ComputerCommandError);
  assert.throws(() => parseAllowedApps([1]), ComputerCommandError);
});
