import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerCommandError, parseComputerCommand } from './computer-use-protocol.js';
import { ComputerUseService, type ComputerUseDeps } from './computer-use-service.js';
import { A11yError, buildTree, elementId, filterByQuery, parseElementId, type A11yRawNode } from './computer-use-a11y.js';
import { createFakeA11yBackend } from './computer-use-a11y-fake.js';
import { selectA11yBackend } from './computer-use-a11y-select.js';
import type { SystemCommand } from './computer-use-input.js';

const display = { width: 1440, height: 900, scaleFactor: 2 };
const node = (path: string, role: string, name: string, extra: Partial<A11yRawNode> = {}): A11yRawNode => ({ path, role, name, enabled: true, actions: [], ...extra });
const TREE: A11yRawNode[] = [
  node('0', 'window', 'Form', { bounds: { x: 100, y: 50, width: 400, height: 300 } }),
  node('0.0', 'group', 'Fields'),
  node('0.0.0', 'textfield', 'Nom', { value: 'abc', actions: ['focus', 'set_value'], bounds: { x: 120, y: 70, width: 200, height: 20 } }),
  node('0.0.1', 'weirdrole', 'Other thing'),
  node('0.1', 'button', 'Valider', { actions: ['press'], focused: true }),
];

const windows = [
  { id: '10:1', title: 'Form', app: 'TextEdit', bundle: 'com.apple.TextEdit', focused: true },
  { id: '20:1', title: 'Inbox', app: 'Mail', bundle: 'com.apple.mail', focused: false },
];
const FRONT = { bundle: 'com.apple.TextEdit', name: 'TextEdit', exe: 'TextEdit' };

function setup(allowed: readonly string[] = ['TextEdit'], overrides: Partial<ComputerUseDeps> = {}) {
  const backend = createFakeA11yBackend({ '10:1': TREE, '20:1': TREE });
  const calls: SystemCommand[] = [];
  const service = new ComputerUseService({
    platform: 'darwin', env: {}, display: () => display, cursor: () => ({ x: 0, y: 0 }),
    capture: async () => Buffer.from([0xff, 0xd8]), screenPermission: () => 'granted', sleep: async () => {}, activeMs: 30,
    a11y: backend,
    exec: async (command) => {
      calls.push(command);
      if (command.args.some((arg) => arg.includes('kCGWindowListOptionOnScreenOnly'))) return { stdout: JSON.stringify(windows) };
      // The window list script also reads the frontmost application, so it is matched first.
      if (command.args.some((arg) => arg.includes('frontmostApplication'))) return { stdout: JSON.stringify(FRONT) };
      return { stdout: 'true' };
    },
    ...overrides,
  });
  const run = (command: string, args?: unknown, actor: 'agent' | 'human' = 'agent', mode: 'foreground' | 'background' = 'foreground', agent?: string) => service.handle(actor, parseComputerCommand(command, args), allowed, mode, agent);
  return { backend, service, run, calls };
}

test('a11y_tree reads the foreground window, with ids, normalised roles and bounds in the frame of the capture', async () => {
  const { run } = setup();
  const tree = await run('a11y_tree') as ReturnType<typeof buildTree>;
  assert.deepEqual(tree.window, { id: '10:1', title: 'Form', app: 'TextEdit' });
  assert.equal(tree.truncated, false);
  assert.deepEqual(tree.nodes.map((n) => [n.id, n.parent, n.depth, n.role]), [
    ['10:1#0', null, 0, 'window'], ['10:1#0.0', '10:1#0', 1, 'group'], ['10:1#0.0.0', '10:1#0.0', 2, 'textfield'],
    ['10:1#0.0.1', '10:1#0.0', 2, 'other'], ['10:1#0.1', '10:1#0', 1, 'button'],
  ]);
  const field = tree.nodes[2]!;
  assert.deepEqual(field.value, 'abc');
  // Default frame is 1024 wide for a 1440 pt display: 120 pt → 85 px.
  assert.deepEqual(field.bounds, { x: 85, y: 50, width: 142, height: 14 });
  assert.equal(tree.nodes[4]!.focused, true);
  assert.equal('focused' in field, false);
});

test('bounds follow the last screenshot', async () => {
  const { run } = setup();
  await run('screenshot', { maxWidth: 720 });
  const tree = await run('a11y_tree') as ReturnType<typeof buildTree>;
  assert.deepEqual(tree.nodes[2]!.bounds, { x: 60, y: 35, width: 100, height: 10 });
});

test('query keeps the hits and their ancestors, whatever the case', async () => {
  const { run } = setup();
  const tree = await run('a11y_tree', { query: 'NOM' }) as ReturnType<typeof buildTree>;
  assert.deepEqual(tree.nodes.map((n) => n.id), ['10:1#0', '10:1#0.0', '10:1#0.0.0']);
  const byValue = await run('a11y_tree', { query: 'ABC' }) as ReturnType<typeof buildTree>;
  assert.equal(byValue.nodes.at(-1)!.name, 'Nom');
  const byRole = await run('a11y_tree', { query: 'button' }) as ReturnType<typeof buildTree>;
  assert.deepEqual(byRole.nodes.map((n) => n.id), ['10:1#0', '10:1#0.1']);
});

test('maxDepth and maxNodes cut the tree and say so', async () => {
  const { run } = setup();
  const shallow = await run('a11y_tree', { maxDepth: 2 }) as ReturnType<typeof buildTree>;
  assert.equal(shallow.truncated, true);
  assert.deepEqual(shallow.nodes.map((n) => n.depth), [0, 1, 1]);
  const short = await run('a11y_tree', { maxNodes: 2 }) as ReturnType<typeof buildTree>;
  assert.equal(short.nodes.length, 2);
  assert.equal(short.truncated, true);
});

test('the tree of an application that is not allowed is refused, even by window id', async () => {
  const { run, backend } = setup(['TextEdit']);
  await assert.rejects(run('a11y_tree', { windowId: '20:1' }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed' && /Mail/.test(e.message));
  await assert.rejects(setup([]).run('a11y_tree'), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed');
  assert.equal(backend.reads.length, 0);
  await assert.rejects(run('a11y_tree', { windowId: '99:9' }), (e: ComputerCommandError) => e.code === 'window_not_found');
});

test('a11y_action runs on the element, moves neither the mouse nor the keyboard, and answers ok', async () => {
  const { run, backend, calls } = setup();
  assert.deepEqual(await run('a11y_action', { id: '10:1#0.0.0', action: 'set_value', value: 'timon' }), { ok: true });
  assert.deepEqual(await run('a11y_action', { id: '10:1#0.1', action: 'press' }), { ok: true });
  assert.deepEqual(backend.acts, [
    { windowId: '10:1', path: '0.0.0', action: 'set_value', value: 'timon' },
    { windowId: '10:1', path: '0.1', action: 'press' },
  ]);
  // Only the window list was read by the system layer: no input script ran.
  assert.equal(calls.some((c) => c.args.some((arg) => arg.includes('CGEvent') || arg.includes('keyboard'))), false);
});

test('a stale element, an unsupported action and a refused application have their own codes', async () => {
  const { run, backend } = setup();
  await assert.rejects(run('a11y_action', { id: '10:1#0.9', action: 'press' }), (e: ComputerCommandError) => e.code === 'a11y_element_stale');
  await assert.rejects(run('a11y_action', { id: '99:9#0', action: 'press' }), (e: ComputerCommandError) => e.code === 'a11y_element_stale');
  await assert.rejects(run('a11y_action', { id: '10:1#0.1', action: 'expand' }), (e: ComputerCommandError) => e.code === 'a11y_action_unsupported' && /press/.test(e.message));
  await assert.rejects(run('a11y_action', { id: '20:1#0.1', action: 'press' }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed');
  assert.equal(backend.acts.length, 0);
  backend.setTree('10:1', [node('0', 'window', 'Changed')]);
  await assert.rejects(run('a11y_action', { id: '10:1#0.1', action: 'press' }), (e: ComputerCommandError) => e.code === 'a11y_element_stale');
});

test('a stopped computer refuses the accessibility commands', async () => {
  const { run, service } = setup();
  service.stop();
  await assert.rejects(run('a11y_tree'), (e: ComputerCommandError) => e.code === 'computer_stopped');
  await assert.rejects(run('a11y_action', { id: '10:1#0.1', action: 'press' }), (e: ComputerCommandError) => e.code === 'computer_stopped');
});

test('the value a backend refuses with never travels back in the error', async () => {
  const { run, backend } = setup();
  backend.act = async () => { throw new Error('boom secret-value'); };
  await assert.rejects(run('a11y_action', { id: '10:1#0.0.0', action: 'set_value', value: 'secret-value' }), (e: ComputerCommandError) => e.code === 'a11y_failed' && !/secret/.test(e.message));
});

test('a field the toolkit will not write is focused through accessibility, then typed into with the keyboard', async () => {
  const { run, backend, calls } = setup();
  const acts: string[] = [];
  backend.act = async (args) => {
    acts.push(args.action);
    if (args.action === 'set_value') throw new A11yError('failed', 'refused');
  };
  assert.deepEqual(await run('a11y_action', { id: '10:1#0.0.0', action: 'set_value', value: 'timon' }), { ok: true, via: 'keyboard' });
  assert.deepEqual(acts, ['set_value', 'focus']);
  // Select all, then the value, through the input script (the front application was checked first).
  const inputs = calls.filter((c) => c.args.some((arg) => arg.includes('CGEventPost') || arg.includes('keystroke')));
  assert.ok(inputs.length >= 2, 'select-all and typing went through the keyboard');
});

test('the keyboard fallback is refused when the application in front is not allowed', async () => {
  const { run, backend } = setup(['Mail']);
  backend.act = async (args) => { if (args.action === 'set_value') throw new A11yError('failed', 'refused'); };
  // The element's application is checked first: TextEdit is not on this list either.
  await assert.rejects(run('a11y_action', { id: '10:1#0.0.0', action: 'set_value', value: 'x' }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed');
});

test('status reports the accessibility check, and a missing one refuses the commands without blocking the rest', async () => {
  const missing = setup(['TextEdit'], { a11y: createFakeA11yBackend({}, 'missing') });
  const status = await missing.run('status') as { available: boolean; checks: { a11y: string } };
  assert.deepEqual([status.available, status.checks.a11y], [true, 'missing']);
  await assert.rejects(missing.run('a11y_tree'), (e: ComputerCommandError) => e.code === 'a11y_unavailable' && e.statusCode === 503);
  await missing.run('move', { x: 1, y: 1 });
});

test('a platform without a backend reports unsupported, and one whose probe gets no answer reports missing', async () => {
  const exec = async () => ({ stdout: '' });
  assert.equal(await selectA11yBackend('freebsd', exec).probe(), 'unsupported');
  // macOS, Windows and Linux all have a backend now: an empty answer means the grant or the bus is missing.
  for (const platform of ['darwin', 'win32', 'linux'] as const) assert.equal(await selectA11yBackend(platform, exec).probe(), 'missing');
});

test('arguments are validated', () => {
  const bad = (command: string, args: unknown) => assert.throws(() => parseComputerCommand(command, args), ComputerCommandError);
  bad('a11y_tree', { maxDepth: 0 });
  bad('a11y_tree', { maxDepth: 16 });
  bad('a11y_tree', { maxNodes: 1501 });
  bad('a11y_tree', { windowId: 'a b' });
  bad('a11y_tree', { query: 'x'.repeat(201) });
  bad('a11y_action', { id: 'nope', action: 'press' });
  bad('a11y_action', { id: '10:1#0', action: 'hover' });
  bad('a11y_action', { id: '10:1#0', action: 'set_value' });
  bad('a11y_action', { id: '10:1#0', action: 'set_value', value: 'x'.repeat(2001) });
  bad('a11y_action', { id: '10:1#0', action: 'press', value: 'x' });
  assert.deepEqual(parseComputerCommand('a11y_tree', {}), { command: 'a11y_tree', maxDepth: 15, maxNodes: 400 });
});

test('element ids round-trip, and the filter and tree builder drop orphans', () => {
  assert.deepEqual(parseElementId(elementId('10:1', '0.2.1')), { windowId: '10:1', path: '0.2.1' });
  assert.equal(parseElementId('10:1#0.a'), null);
  assert.equal(filterByQuery(TREE, undefined).length, TREE.length);
  const orphan = buildTree({ id: 'w', title: '', app: '' }, { truncated: false, nodes: [node('0', 'window', 'w'), node('0.3.1', 'button', 'lost')] }, { maxDepth: 8, maxNodes: 10 }, display, { width: 1440, height: 900 });
  assert.equal(orphan.nodes.length, 1);
});

test('an application allowed in the background: only reads and accessibility actions pass; screenshots, pixels and focus are refused with computer_background_only', async () => {
  const { run, backend, calls } = setup();
  const refused = (e: ComputerCommandError) => e.code === 'computer_background_only' && e.statusCode === 403 && /a11y_tree \/ a11y_action/.test(e.message) || /a11y_tree and a11y_action/.test(e.message);
  for (const [command, args] of [['screenshot', {}], ['click', { x: 1, y: 1 }], ['double_click', { x: 1, y: 1 }], ['move', { x: 1, y: 1 }],
    ['drag', { fromX: 1, fromY: 1, toX: 2, toY: 2 }], ['type', { text: 'x' }], ['key', { keys: 'Enter' }], ['scroll', { x: 1, y: 1, deltaY: 3 }],
    ['focus_window', { id: '10:1' }], ['a11y_action', { id: '10:1#0.0.0', action: 'focus' }]] as const) {
    await assert.rejects(run(command, args, 'agent', 'background'), refused, command);
  }
  assert.equal(calls.some((c) => c.args.some((arg) => arg.includes('CGEventPost') || arg.includes('AXRaise') || arg.includes('keystroke'))), false, 'no input reached the machine');
  assert.equal(backend.acts.length, 0);
  await run('list_windows', undefined, 'agent', 'background');
  await run('a11y_tree', undefined, 'agent', 'background');
  await run('wait', { ms: 0 }, 'agent', 'background');
  assert.deepEqual(await run('a11y_action', { id: '10:1#0.1', action: 'press' }, 'agent', 'background'), { ok: true });
  assert.deepEqual(backend.acts.at(-1), { windowId: '10:1', path: '0.1', action: 'press', background: true });
  // A person is never held to the mode.
  await run('screenshot', undefined, 'human', 'background');
});

test('in the background mode a field the toolkit refuses gets a11y_failed with advice, never the keyboard', async () => {
  const { run, backend, calls } = setup();
  const acts: string[] = [];
  backend.act = async (args) => { acts.push(args.action); throw new A11yError('failed', 'refused'); };
  await assert.rejects(run('a11y_action', { id: '10:1#0.0.0', action: 'set_value', value: 'timon' }, 'agent', 'background'),
    (e: ComputerCommandError) => e.code === 'a11y_failed' && /foreground/.test(e.message) && !/timon/.test(e.message));
  assert.deepEqual(acts, ['set_value'], 'no focus action');
  assert.equal(calls.some((c) => c.args.some((arg) => arg.includes('CGEventPost') || arg.includes('keystroke'))), false);
});

test('accessibility rules are per application: background ones never get focus or the keyboard fallback, foreground ones keep both', async () => {
  const { service, backend } = setup();
  const apps = [{ app: 'TextEdit', mode: 'background' as const }, { app: 'Mail', mode: 'foreground' as const }];
  const run = (command: string, args?: unknown) => service.handle('agent', parseComputerCommand(command, args), apps);
  // The tree of any allowed application can be read, whatever its mode.
  await run('a11y_tree', { windowId: '10:1' });
  await run('a11y_tree', { windowId: '20:1' });
  await assert.rejects(run('a11y_action', { id: '10:1#0.0.0', action: 'focus' }), (e: ComputerCommandError) => e.code === 'computer_background_only');
  await run('a11y_action', { id: '20:1#0.0.0', action: 'focus' });
  await run('a11y_action', { id: '10:1#0.1', action: 'press' });
  assert.deepEqual(backend.acts.map((act) => [act.windowId, act.action, act.background === true]), [['20:1', 'focus', false], ['10:1', 'press', true]]);
  // A window of an application that is not listed is refused.
  const only = (command: string, args?: unknown) => service.handle('agent', parseComputerCommand(command, args), [{ app: 'Mail', mode: 'background' }]);
  await assert.rejects(only('a11y_tree', { windowId: '10:1' }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed');
  await assert.rejects(only('a11y_action', { id: '10:1#0.1', action: 'press' }), (e: ComputerCommandError) => e.code === 'computer_app_not_allowed');
});

test('an accessibility action frames its element for the ghost pointer, in points of the display, when its bounds are known', async () => {
  const drawn: Array<{ event: unknown; agent: string | undefined }> = [];
  const { run } = setup(['TextEdit'], { display: () => ({ ...display, originX: 1440, originY: 0 }), onPointer: (event, agent) => drawn.push({ event, agent }) });
  // No tree read yet: no bounds, no frame.
  await run('a11y_action', { id: '10:1#0.0.0', action: 'set_value', value: 'x' }, 'agent', 'background', 'clerk');
  assert.equal(drawn.length, 0);
  await run('a11y_tree', undefined, 'agent', 'background', 'clerk');
  await run('a11y_action', { id: '10:1#0.0.0', action: 'set_value', value: 'y' }, 'agent', 'background', 'clerk');
  assert.deepEqual(drawn, [{ event: { t: 'frame', x: 120 - 1440, y: 70, w: 200, h: 20 }, agent: 'clerk' }]);
  // An element read without bounds draws nothing.
  await run('a11y_action', { id: '10:1#0.1', action: 'press' }, 'agent', 'background', 'clerk');
  assert.equal(drawn.length, 1);
});
