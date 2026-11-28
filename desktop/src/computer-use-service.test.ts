import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerCommandError, parseComputerCommand, type AllowedApp } from './computer-use-protocol.js';
import { createFakeA11yBackend } from './computer-use-a11y-fake.js';
import { ComputerUseService, type ComputerUseDeps } from './computer-use-service.js';
import type { SystemCommand } from './computer-use-input.js';

const display = { width: 1440, height: 900, scaleFactor: 2 };

/** The application the simulated machine has in front, and the list an agent is given by default. */
const FRONT = { bundle: 'com.apple.TextEdit', name: 'TextEdit', exe: 'TextEdit' };
const isForegroundRead = (command: SystemCommand): boolean => command.file === 'osascript' && command.args.some((arg) => arg.includes('frontmostApplication') && !arg.includes('CGWindowList'));

function setup(overrides: Partial<ComputerUseDeps> = {}, allowedApps: readonly (string | AllowedApp)[] = ['TextEdit']) {
  const calls: SystemCommand[] = [];
  const inner = overrides.exec ?? (async () => ({ stdout: 'true\n' }));
  const states: Array<{ active: boolean; stopped: boolean }> = [];
  const service = new ComputerUseService({
    platform: 'darwin', env: {},
    display: () => display,
    cursor: () => ({ x: 720, y: 450 }),
    capture: async () => Buffer.from([0xff, 0xd8, 0xff, 0x6a, 0x70, 0x67]),
    screenPermission: () => 'granted',
    sleep: async () => {},
    activeMs: 30,
    onState: (state) => states.push(state),
    // The real accessibility backends of the three systems would run on this fake executor and record
    // their calls: these tests are about the service, so its accessibility check is fixed here.
    a11y: createFakeA11yBackend({}, 'unsupported'),
    ...overrides,
    exec: async (command) => {
      if (isForegroundRead(command)) return { stdout: JSON.stringify(FRONT) };
      calls.push(command);
      return inner(command);
    },
  });
  const run = (command: string, args?: unknown, actor: 'agent' | 'human' = 'agent') => service.handle(actor, parseComputerCommand(command, args), allowedApps);
  return { service, calls, states, run };
}

test('screenshot sets the frame later coordinates are expressed in', async () => {
  const { run, calls } = setup();
  const shot = await run('screenshot', { maxWidth: 720 }) as { data: string; width: number; height: number; mimeType: string };
  assert.deepEqual([shot.mimeType, shot.width, shot.height], ['image/jpeg', 720, 450]);
  assert.equal(Buffer.from(shot.data, 'base64').toString('hex'), 'ffd8ff6a7067');
  calls.length = 0;
  await run('click', { x: 360, y: 225 });
  const steps = JSON.parse(calls[0]!.args[4]!);
  assert.deepEqual(steps[0], { t: 'move', x: 720, y: 450 });
  assert.deepEqual(await run('cursor_position'), { x: 360, y: 225 });
});

test('status reports platform, display, availability and activity', async () => {
  const { run } = setup();
  assert.deepEqual(await run('status'), { platform: 'darwin', available: true, display, active: false, stopped: false, checks: { desktop: 'ok', screen: 'ok', inputTool: 'ok', accessibility: 'ok', a11y: 'unsupported' }, needsRestart: false });
  await run('move', { x: 1, y: 1 });
  assert.equal(((await run('status')) as { active: boolean }).active, true);
});

test('stop refuses agent commands with computer_stopped until a person resumes', async () => {
  const { run, service, calls } = setup();
  await run('move', { x: 1, y: 1 });
  await run('stop', undefined, 'human');
  assert.equal(service.isStopped, true);
  await assert.rejects(run('click', { x: 1, y: 1 }), (e: ComputerCommandError) => e.code === 'computer_stopped' && e.statusCode === 409);
  const before = calls.length;
  assert.equal(calls.length, before, 'a refused command runs nothing');
  assert.equal(((await run('status')) as { stopped: boolean }).stopped, true); // status stays readable and reports it
  await assert.rejects(run('resume'), (e: ComputerCommandError) => e.statusCode === 403);
  await assert.rejects(run('stop'), (e: ComputerCommandError) => e.statusCode === 403);
  await run('resume', undefined, 'human');
  await run('move', { x: 2, y: 2 });
});

test('the global shortcut path (service.stop) behaves like the stop command and updates the indicator', async () => {
  const { run, service, states } = setup();
  await run('move', { x: 1, y: 1 });
  service.stop();
  assert.deepEqual(states.at(-1), { active: false, stopped: true });
  await assert.rejects(run('type', { text: 'x' }), /stopped/);
});

test('indicator goes off after the idle delay', async () => {
  const { run, states } = setup();
  await run('move', { x: 1, y: 1 });
  assert.equal(states.at(-1)?.active, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(states.at(-1)?.active, false);
});

test('macOS permissions are reported as reasons and refuse commands', async () => {
  const noAccessibility = setup({ exec: async () => ({ stdout: 'false\n' }) });
  assert.deepEqual(await noAccessibility.run('status'), { platform: 'darwin', available: false, reason: 'permission-accessibility', display, active: false, stopped: false, checks: { desktop: 'ok', screen: 'ok', inputTool: 'ok', accessibility: 'missing', a11y: 'unsupported' }, needsRestart: false });
  await assert.rejects(noAccessibility.run('click', { x: 1, y: 1 }), (e: ComputerCommandError) => e.code === 'computer_unavailable' && /permission-accessibility/.test(e.message));
  const noScreen = setup({ screenPermission: () => 'denied' });
  assert.equal(((await noScreen.run('status')) as { reason: string }).reason, 'permission-screen');
  const emptyFrame = setup({ capture: async () => null });
  await assert.rejects(emptyFrame.run('screenshot'), /permission-screen/);
});

test('Linux: wayland, missing tool and missing desktop are refused with a reason', async () => {
  const reason = async (deps: Partial<ComputerUseDeps>) => ((await setup({ platform: 'linux', ...deps }).run('status')) as { available: boolean; reason?: string });
  assert.equal((await reason({ env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } })).reason, 'wayland');
  assert.equal((await reason({ env: { XDG_SESSION_TYPE: 'wayland' } })).reason, 'wayland');
  // XWayland with the session type lost by the launcher is still Wayland; an explicit X11 session is not.
  assert.equal((await reason({ env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } })).reason, 'wayland');
  assert.equal((await reason({ env: { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } })).available, true);
  assert.equal((await reason({ env: { DISPLAY: ':0' }, exec: async () => { throw new Error('ENOENT'); } })).reason, 'no-input-tool');
  assert.equal((await reason({ env: {} })).reason, 'no-desktop');
  assert.equal((await reason({ env: { DISPLAY: ':0' } })).available, true);
  assert.equal((await reason({ env: { DISPLAY: ':0' }, display: () => null })).reason, 'no-desktop');
});

test('a failing input command hides its details (the typed text could be in them)', async () => {
  const { run } = setup({ exec: async (command) => { if (command.args.length > 4) throw new Error('secret-text'); return { stdout: 'true' }; } });
  await assert.rejects(run('type', { text: 'secret-text' }), (e: ComputerCommandError) => e.code === 'input_failed' && !/secret/.test(e.message));
});

test('arguments are validated', () => {
  assert.throws(() => parseComputerCommand('type', { text: 'x'.repeat(2001) }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('type', { text: '' }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('wait', { ms: 10001 }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('click', { x: 'a', y: 1 }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('click', { x: 1, y: 1, button: 'back' }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('rm', {}), /Unknown/);
  assert.deepEqual(parseComputerCommand('screenshot', {}), { command: 'screenshot', maxWidth: 1024 });
});

test('a refused action asks for the missing grant, at most once a minute', async () => {
  let now = 1_000_000;
  const asked: string[] = [];
  const { run } = setup({
    screenPermission: () => 'not-determined',
    now: () => now,
    requestPermission: async (reason) => { asked.push(reason); },
  });
  await assert.rejects(run('screenshot'), (error: unknown) => error instanceof ComputerCommandError && error.code === 'computer_unavailable');
  await assert.rejects(run('click', { x: 1, y: 1 }));
  assert.deepEqual(asked, ['permission-screen'], 'an agent retrying does not stack system prompts');
  now += 61_000;
  await assert.rejects(run('screenshot'));
  assert.deepEqual(asked, ['permission-screen', 'permission-screen']);
  // Status is read by the interface every few seconds: it reports, it never asks.
  await run('status', undefined, 'human');
  assert.equal(asked.length, 2);
});

test('status details every prerequisite, even when several are missing', async () => {
  const both = setup({ screenPermission: () => 'denied', exec: async () => ({ stdout: 'false' }) });
  const status = await both.run('status') as { reason: string; checks: Record<string, string> };
  assert.equal(status.reason, 'permission-screen');
  assert.deepEqual(status.checks, { desktop: 'ok', screen: 'missing', inputTool: 'ok', accessibility: 'missing', a11y: 'unsupported' });
  const noTool = setup({ platform: 'linux', env: { DISPLAY: ':0' }, exec: async () => { throw new Error('ENOENT'); } });
  assert.deepEqual(((await noTool.run('status')) as { checks: unknown }).checks, { desktop: 'ok', session: 'ok', inputTool: 'missing', a11y: 'unsupported' });
  const wayland = setup({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } });
  assert.deepEqual(((await wayland.run('status')) as { checks: unknown }).checks, { desktop: 'ok', session: 'unsupported', inputTool: 'missing', a11y: 'unsupported' });
  const windows = setup({ platform: 'win32' });
  assert.deepEqual(((await windows.run('status')) as { checks: unknown }).checks, { desktop: 'ok', a11y: 'unsupported' });
});

test('request_permissions is reserved to people and asks for each missing macOS grant', async () => {
  let screen: 'granted' | 'denied' = 'denied';
  const asked: string[] = [];
  const { run } = setup({
    screenPermission: () => screen,
    exec: async () => ({ stdout: 'false' }),
    requestPermission: async (reason) => { asked.push(reason); if (reason === 'permission-screen') screen = 'granted'; },
  });
  await assert.rejects(run('request_permissions'), (e: ComputerCommandError) => e.statusCode === 403 && e.code === 'forbidden');
  assert.deepEqual(asked, []);
  const answer = await run('request_permissions', undefined, 'human') as { requested: string[]; checks: Record<string, string>; needsRestart: boolean };
  assert.deepEqual(answer.requested, ['permission-accessibility', 'permission-screen']);
  assert.equal(answer.checks.screen, 'ok');
  assert.equal(answer.needsRestart, true, 'a grant given while the app runs needs a restart');
  // Asked again at once: a person pressed the button, so no one-minute limit applies.
  await run('request_permissions', undefined, 'human');
  assert.equal(asked.filter((reason) => reason === 'permission-accessibility').length, 2);
});

test('request_permissions asks nothing outside macOS and only reports the status', async () => {
  const asked: string[] = [];
  const { run } = setup({ platform: 'linux', env: { DISPLAY: ':0' }, requestPermission: async (r) => { asked.push(r); } });
  const answer = await run('request_permissions', undefined, 'human') as { requested: string[]; available: boolean };
  assert.deepEqual(answer.requested, []);
  assert.equal(answer.available, true);
  assert.deepEqual(asked, []);
});

test('restart_app is reserved to people and calls the shell restart', async () => {
  let restarted = 0;
  const { run } = setup({ restart: () => { restarted++; } });
  await assert.rejects(run('restart_app'), (e: ComputerCommandError) => e.statusCode === 403);
  assert.deepEqual(await run('restart_app', undefined, 'human'), { restarting: true });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(restarted, 1);
  await assert.rejects(setup().run('restart_app', undefined, 'human'), (e: ComputerCommandError) => e.statusCode === 501);
});

test('a capture that fell back to PNG is labelled as PNG', async () => {
  const { run } = setup({ capture: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) });
  const shot = await run('screenshot') as { mimeType: string };
  assert.equal(shot.mimeType, 'image/png');
});

test('keyboard and mouse actions are refused unless the foreground application is listed', async () => {
  for (const command of [['click', { x: 1, y: 1 }], ['double_click', { x: 1, y: 1 }], ['move', { x: 1, y: 1 }], ['drag', { fromX: 1, fromY: 1, toX: 2, toY: 2 }],
    ['type', { text: 'x' }], ['key', { keys: 'Enter' }], ['scroll', { x: 1, y: 1, deltaY: 3 }]] as const) {
    const refused = setup({}, ['Notepad']);
    await assert.rejects(refused.run(command[0], command[1]), (e: ComputerCommandError) =>
      e.code === 'computer_app_not_allowed' && e.statusCode === 403 && /TextEdit \(com\.apple\.TextEdit\)/.test(e.message), command[0]);
    assert.equal(refused.calls.length, 1, `${command[0]} ran nothing (only the Accessibility probe)`);
    // Bundle id, displayed name and executable name all match, whatever the case.
    for (const entry of ['com.apple.textedit', 'TEXTEDIT']) {
      await setup({}, [entry]).run(command[0], command[1]);
    }
  }
});

test('an empty or absent list allows no keyboard or mouse action, a person is not gated, reads stay open', async () => {
  const { run, calls } = setup({}, []);
  await assert.rejects(run('type', { text: 'x' }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed' && /no allowed applications/.test(e.message));
  await assert.rejects(run('click', { x: 1, y: 1 }), /computer_app_not_allowed|allowed/);
  await run('click', { x: 1, y: 1 }, 'human');
  await assert.rejects(run('screenshot'), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed', 'a screenshot is gated too');
  await run('screenshot', undefined, 'human');
  await run('wait', { ms: 0 });
  assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes('"t":"text"'))), 'nothing was typed');
});

test('an unreadable foreground application fails closed', async () => {
  const { run } = setup({ platform: 'linux', env: { DISPLAY: ':0' }, exec: async (command) => {
    if (command.args[0] === 'version') return { stdout: 'xdotool' };
    throw new Error('xdotool failed');
  } });
  await assert.rejects(run('click', { x: 1, y: 1 }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed' && /could not be read/.test(e.message));
});

test('list_windows lists, and focus_window only reaches the windows of allowed applications', async () => {
  const windows = [
    { id: '10:1', title: 'Notes', app: 'TextEdit', bundle: 'com.apple.TextEdit', focused: true },
    { id: '20:1', title: 'Inbox', app: 'Mail', bundle: 'com.apple.mail', focused: false },
  ];
  const focused: string[] = [];
  const exec = async (command: SystemCommand) => {
    if (command.args.some((arg) => arg.includes('AXRaise'))) { focused.push(command.args.at(-1)!); return { stdout: 'ok' }; }
    if (command.args.some((arg) => arg.includes('kCGWindowListOptionOnScreenOnly'))) return { stdout: JSON.stringify(windows) };
    return { stdout: 'true' };
  };
  const { run } = setup({ exec }, ['TextEdit']);
  assert.deepEqual(await run('list_windows'), [
    { id: '10:1', title: 'Notes', app: 'TextEdit', focused: true },
    { id: '20:1', title: 'Inbox', app: 'Mail', focused: false },
  ]);
  assert.deepEqual(await run('focus_window', { id: '10:1' }), { focused: true });
  assert.deepEqual(focused, ['[10,1]']);
  await assert.rejects(run('focus_window', { id: '20:1' }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed' && /Mail/.test(e.message));
  await assert.rejects(run('focus_window', { id: '99:9' }), (e: ComputerCommandError) => e.code === 'window_not_found' && e.statusCode === 404);
  assert.equal(focused.length, 1, 'the refused focus changed nothing');
  // list_windows stays open with an empty list: it is how the person fills it.
  assert.equal(((await setup({ exec }, []).run('list_windows')) as unknown[]).length, 2);
});

const PIXEL_COMMANDS = [['screenshot', {}], ['cursor_position', {}], ['click', { x: 1, y: 1 }], ['double_click', { x: 1, y: 1 }], ['move', { x: 1, y: 1 }],
  ['drag', { fromX: 1, fromY: 1, toX: 2, toY: 2 }], ['type', { text: 'x' }], ['key', { keys: 'Enter' }], ['scroll', { x: 1, y: 1, deltaY: 3 }]] as const;

test('pixel and keyboard actions need the application in front allowed in the foreground mode: the combinations', async () => {
  // In front: TextEdit. 1) allowed in the foreground: everything passes.
  const fg = setup({}, [{ app: 'TextEdit', mode: 'foreground' }, { app: 'Notes', mode: 'background' }]);
  for (const [command, args] of PIXEL_COMMANDS) await fg.run(command, args);
  // 2) allowed in the background: refused with computer_background_only, and the message says what to do.
  const bg = setup({}, [{ app: 'TextEdit', mode: 'background' }, { app: 'Notes', mode: 'foreground' }]);
  for (const [command, args] of PIXEL_COMMANDS) {
    await assert.rejects(bg.run(command, args), (e: ComputerCommandError) => e.code === 'computer_background_only' && e.statusCode === 403 && /TextEdit is allowed in the background only: use a11y_tree \/ a11y_action/.test(e.message), command);
  }
  // 3) not listed: computer_app_not_allowed, whatever the other applications' modes.
  const none = setup({}, [{ app: 'Notes', mode: 'foreground' }, { app: 'Mail', mode: 'background' }]);
  for (const [command, args] of PIXEL_COMMANDS) {
    await assert.rejects(none.run(command, args), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed', command);
  }
  // 4) a person is never gated, and list_windows / wait stay open.
  await bg.run('click', { x: 1, y: 1 }, 'human');
  await bg.run('list_windows');
  await bg.run('wait', { ms: 0 });
  await none.run('list_windows');
});

test('focus_window is judged on the application of the window it targets', async () => {
  const windows = [
    { id: '10:1', title: 'Notes', app: 'TextEdit', bundle: 'com.apple.TextEdit', focused: true },
    { id: '20:1', title: 'Inbox', app: 'Mail', bundle: 'com.apple.mail', focused: false },
    { id: '30:1', title: 'Chat', app: 'Discord', bundle: 'com.hnc.Discord', focused: false },
  ];
  const focused: string[] = [];
  const exec = async (command: SystemCommand) => {
    if (command.args.some((arg) => arg.includes('AXRaise'))) { focused.push(command.args.at(-1)!); return { stdout: 'ok' }; }
    if (command.args.some((arg) => arg.includes('kCGWindowListOptionOnScreenOnly'))) return { stdout: JSON.stringify(windows) };
    return { stdout: 'true' };
  };
  const { run } = setup({ exec }, [{ app: 'TextEdit', mode: 'background' }, { app: 'Discord', mode: 'foreground' }]);
  // The window in front is a background application: the target's mode is what counts.
  assert.deepEqual(await run('focus_window', { id: '30:1' }), { focused: true });
  await assert.rejects(run('focus_window', { id: '10:1' }), (e: ComputerCommandError) => e.code === 'computer_background_only');
  await assert.rejects(run('focus_window', { id: '20:1' }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed');
  assert.deepEqual(focused, ['[30,1]']);
});

test('a bare name takes the default mode of the agent, an object its own', async () => {
  const service = new ComputerUseService({
    platform: 'darwin', env: {}, display: () => display, cursor: () => ({ x: 0, y: 0 }), capture: async () => Buffer.from([0xff, 0xd8]),
    screenPermission: () => 'granted', sleep: async () => {}, a11y: createFakeA11yBackend({}, 'unsupported'),
    exec: async (command) => ({ stdout: isForegroundRead(command) ? JSON.stringify(FRONT) : 'true' }),
  });
  const click = parseComputerCommand('click', { x: 1, y: 1 });
  await service.handle('agent', click, ['TextEdit']);
  await assert.rejects(service.handle('agent', click, ['TextEdit'], 'background'), (e: ComputerCommandError) => e.code === 'computer_background_only');
  await service.handle('agent', click, [{ app: 'TextEdit', mode: 'foreground' }], 'background');
});

test('a11y_probe_app is a person\'s command and judges the tree', async () => {
  const window = { path: '0', role: 'window', name: 'W', enabled: true, actions: [] };
  const button = (path: string) => ({ path, role: 'button', name: 'B', enabled: true, actions: ['press'] });
  const a11y = createFakeA11yBackend({
    '10:1': [window, button('0.0'), button('0.1'), { ...button('0.2'), role: 'textfield', actions: ['set_value'] }],
    '20:1': [window],
    '30:1': [window, button('0.0')],
  });
  const { run } = setup({ a11y });
  assert.deepEqual(await run('a11y_probe_app', { windowId: '10:1' }, 'human'), { nodes: 4, actionable: 3, verdict: 'rich' });
  assert.deepEqual(await run('a11y_probe_app', { windowId: '20:1' }, 'human'), { nodes: 1, actionable: 0, verdict: 'empty' });
  assert.deepEqual(await run('a11y_probe_app', { windowId: '30:1' }, 'human'), { nodes: 2, actionable: 1, verdict: 'poor' });
  await assert.rejects(run('a11y_probe_app', { windowId: '10:1' }), (e: ComputerCommandError) => e.code === 'forbidden');
});

test('a window screenshot captures only its rectangle, and later coordinates are pixels of that image', async () => {
  const windows = [
    { id: '10:1', title: 'Notes', app: 'TextEdit', bundle: 'com.apple.TextEdit', focused: true, bounds: { x: 100, y: 50, width: 400, height: 300 } },
    { id: '20:1', title: 'Inbox', app: 'Mail', bundle: 'com.apple.mail', focused: false, bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { id: '30:1', title: 'Hidden', app: 'TextEdit', bundle: 'com.apple.TextEdit', focused: false, bounds: { x: 3000, y: 0, width: 800, height: 600 } },
    { id: '40:1', title: 'No bounds', app: 'TextEdit', bundle: 'com.apple.TextEdit', focused: false },
  ];
  const captured: unknown[] = [];
  const exec = async (command: SystemCommand) => {
    if (command.args.some((arg) => arg.includes('kCGWindowListOptionOnScreenOnly'))) return { stdout: JSON.stringify(windows) };
    return { stdout: 'true' };
  };
  const { run, calls } = setup({ exec, cursor: () => ({ x: 150, y: 100 }), capture: async (size, region) => { captured.push({ size, region }); return Buffer.from([0xff, 0xd8]); } });
  const shot = await run('screenshot', { windowId: '10:1', maxWidth: 400 }) as { width: number; height: number; window: unknown };
  assert.deepEqual([shot.width, shot.height], [400, 300]);
  assert.deepEqual(shot.window, { id: '10:1', title: 'Notes', app: 'TextEdit' });
  assert.deepEqual(captured.at(-1), { size: { width: 400, height: 300 }, region: { x: 100, y: 50, width: 400, height: 300 } });
  calls.length = 0;
  await run('click', { x: 200, y: 150 });
  const moves = calls.map((call) => call.args.find((arg) => arg.includes('"t":"move"'))).filter(Boolean);
  assert.deepEqual(JSON.parse(moves[0]!)[0], { t: 'move', x: 300, y: 200 }, 'the window origin is added back');
  calls.length = 0;
  await run('click', { x: 5000, y: 5000 });
  const clamped = calls.map((call) => call.args.find((arg) => arg.includes('"t":"move"'))).filter(Boolean);
  assert.deepEqual(JSON.parse(clamped[0]!)[0], { t: 'move', x: 499, y: 349 }, 'a stray coordinate stays inside the window');
  assert.deepEqual(await run('cursor_position'), { x: 50, y: 50 });

  // "front" is the window in front; a full screenshot afterwards restores the whole display.
  await run('screenshot', { windowId: 'front', maxWidth: 400 });
  assert.deepEqual((captured.at(-1) as { region: unknown }).region, { x: 100, y: 50, width: 400, height: 300 });
  await run('screenshot', { maxWidth: 720 });
  assert.equal((captured.at(-1) as { region?: unknown }).region, undefined);
  assert.deepEqual(await run('cursor_position'), { x: 75, y: 50 });

  // The window's own application must be allowed in the foreground mode.
  await assert.rejects(run('screenshot', { windowId: '20:1' }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed' && /Mail/.test(e.message));
  const background = setup({ exec }, [{ app: 'TextEdit', mode: 'foreground' }, { app: 'Mail', mode: 'background' }]);
  await assert.rejects(background.run('screenshot', { windowId: '20:1' }), (e: ComputerCommandError) => e.code === 'computer_background_only');
  await assert.rejects(run('screenshot', { windowId: '99:9' }), (e: ComputerCommandError) => e.code === 'window_not_found' && e.statusCode === 404);
  for (const id of ['30:1', '40:1']) {
    await assert.rejects(run('screenshot', { windowId: id }), (e: ComputerCommandError) => e.code === 'window_not_visible' && e.statusCode === 409, id);
  }
  assert.equal(captured.length, 3, 'a refused window capture captured nothing');
});

test('the screenshot windowId is a list_windows id or "front"', () => {
  assert.deepEqual(parseComputerCommand('screenshot', { windowId: 'front' }), { command: 'screenshot', maxWidth: 1024, windowId: 'front' });
  assert.deepEqual(parseComputerCommand('screenshot', { windowId: '10:1', maxWidth: 2048 }), { command: 'screenshot', maxWidth: 2048, windowId: '10:1' });
  for (const windowId of ['', 'a b', '../x', 7, 'x'.repeat(65)]) {
    assert.throws(() => parseComputerCommand('screenshot', { windowId }), ComputerCommandError, String(windowId));
  }
});

test('the real pointer glides from where it is, in points of the display, unless the motion is off', async () => {
  let motionMs = 200;
  let cursor = { x: 100, y: 100 };
  const { run, calls } = setup({ pointerMotionMs: () => motionMs, cursor: () => cursor });
  const moves = () => (JSON.parse(calls.at(-1)!.args[4]!) as Array<{ t: string; x?: number }>).filter((s) => s.t === 'move');
  await run('screenshot', { maxWidth: 1440 });
  await run('click', { x: 700, y: 100 });
  assert.equal(moves().length, 13);
  assert.ok(moves()[0]!.x! > 100 && moves()[0]!.x! < 700, 'the glide starts next to the real pointer');
  // Off: one move, straight to the target, as before.
  motionMs = 0;
  await run('double_click', { x: 10, y: 10 });
  assert.equal(moves().length, 1);
  // A pointer on another display does not glide in from outside the screen.
  motionMs = 200;
  cursor = { x: -300, y: 100 };
  await run('move', { x: 10, y: 10 });
  assert.equal(moves().length, 1);
});

test('the ghost pointer is told where the agent\'s pointer goes and clicks, with its name; a person draws nothing', async () => {
  const drawn: Array<{ event: { t: string }; agent: string | undefined }> = [];
  let failExec = false;
  const { service } = setup({
    pointerMotionMs: () => 200, cursor: () => ({ x: 100, y: 100 }), onPointer: (event, agent) => drawn.push({ event, agent }),
    exec: async () => { if (failExec) throw new Error('boom'); return { stdout: 'true\n' }; },
  });
  const run = (command: string, args: unknown, actor: 'agent' | 'human' = 'agent') => service.handle(actor, parseComputerCommand(command, args), ['TextEdit'], 'foreground', null, 'designer');
  await run('screenshot', { maxWidth: 1440 });
  await run('double_click', { x: 700, y: 300 });
  assert.deepEqual(drawn, [
    { event: { t: 'move', fromX: 100, fromY: 100, x: 700, y: 300, ms: 200 }, agent: 'designer' },
    { event: { t: 'click', x: 700, y: 300, n: 2 }, agent: 'designer' },
  ]);
  drawn.length = 0;
  await run('drag', { fromX: 10, fromY: 10, toX: 50, toY: 60 });
  assert.deepEqual(drawn.map((d) => d.event), [
    { t: 'move', fromX: 10, fromY: 10, x: 10, y: 10, ms: 0 }, { t: 'move', fromX: 10, fromY: 10, x: 50, y: 60, ms: 180 },
  ]);
  drawn.length = 0;
  await run('type', { text: 'secret' });
  await run('key', { keys: 'enter' });
  assert.equal(drawn.length, 0, 'typing moves no pointer');
  // A click that failed draws its glide but no halo.
  failExec = true;
  await assert.rejects(run('click', { x: 5, y: 5 }));
  assert.deepEqual(drawn.map((d) => d.event.t), ['move']);
  failExec = false;
  drawn.length = 0;
  await run('click', { x: 5, y: 5 }, 'human');
  assert.equal(drawn.length, 0, 'a person\'s command is not the agent\'s pointer');
});

test('a drawing that throws never fails the action', async () => {
  const { service } = setup({ onPointer: () => { throw new Error('window gone'); } });
  assert.deepEqual(await service.handle('agent', parseComputerCommand('click', { x: 1, y: 1 }), ['TextEdit'], 'foreground', null, 'designer'), {});
});

test('"All applications": an unlisted application is driven in the default mode, an excluded one is refused with its own code', async () => {
  const service = new ComputerUseService({
    platform: 'darwin', env: {}, display: () => display, cursor: () => ({ x: 0, y: 0 }), capture: async () => Buffer.from([0xff, 0xd8]),
    screenPermission: () => 'granted', sleep: async () => {}, a11y: createFakeA11yBackend({}, 'unsupported'),
    exec: async (command) => ({ stdout: isForegroundRead(command) ? JSON.stringify(FRONT) : 'true' }),
  });
  const click = parseComputerCommand('click', { x: 1, y: 1 });
  await assert.rejects(service.handle('agent', click, [], 'foreground'), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed', 'off: nothing listed, nothing allowed');
  await service.handle('agent', click, [], 'foreground', { mode: 'foreground', excluded: ['Terminal'] });
  await assert.rejects(service.handle('agent', click, [], 'background', { mode: 'background', excluded: [] }),
    (e: ComputerCommandError) => e.code === 'computer_background_only', 'the default mode applies to an unlisted application');
  await service.handle('agent', click, [{ app: 'TextEdit', mode: 'foreground' }], 'background', { mode: 'background', excluded: [] });
  await assert.rejects(service.handle('agent', click, [{ app: 'TextEdit', mode: 'foreground' }], 'foreground', { mode: 'foreground', excluded: ['com.apple.textedit'] }),
    (e: ComputerCommandError) => e.code === 'computer_app_excluded' && e.statusCode === 403 && /TextEdit/.test(e.message), 'an exclusion wins over an explicit entry');
  await service.handle('human', click, [], 'foreground', { mode: 'foreground', excluded: ['TextEdit'] });
});
