import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { A11yError, buildTree, type A11yRawTree } from './computer-use-a11y.js';
import { LINUX_A11Y_DEADLINE_MS, linuxA11yBackend } from './computer-use-a11y-linux.js';
import type { SystemCommand } from './computer-use-input.js';

/** A scripted executor: xdotool answers about window 42, the python reader answers `reply`. */
function setup(reply: unknown | Error, xdotoolFails = false) {
  const calls: SystemCommand[] = [];
  const exec = async (command: SystemCommand): Promise<{ stdout: string }> => {
    calls.push(command);
    if (command.file === 'xdotool') {
      if (xdotoolFails) throw new Error('no window');
      return { stdout: command.args[0] === 'getwindowpid' ? '1234\n' : 'Form\n' };
    }
    if (reply instanceof Error) throw reply;
    return { stdout: typeof reply === 'string' ? reply : JSON.stringify(reply) };
  };
  return { backend: linuxA11yBackend(exec), calls };
}
const request = (calls: SystemCommand[]): Record<string, unknown> => JSON.parse(calls.filter((c) => c.file === 'python3').at(-1)!.args[2]!) as Record<string, unknown>;

test('probe is ok when the reader reaches the bus, missing otherwise', async () => {
  assert.equal(await setup({ ok: true }).backend.probe(), 'ok');
  assert.equal(await setup(new Error('No module named gi')).backend.probe(), 'missing');
  assert.equal(await setup('not json').backend.probe(), 'missing');
});

test('tree sends one fixed script and the arguments as JSON, never inside the script', async () => {
  const { backend, calls } = setup({ truncated: true, nodes: [{ path: '0', role: 'window', name: 'Form', enabled: true, actions: [] }] });
  const tree = await backend.tree({ windowId: '42', maxDepth: 5, maxNodes: 10, query: "x'; rm -rf /" });
  assert.equal(tree.truncated, true);
  assert.equal(tree.nodes.length, 1);
  const python = calls.filter((c) => c.file === 'python3');
  assert.equal(python[0]!.args[0], '-c');
  assert.ok(!python[0]!.args[1]!.includes('rm -rf'));
  assert.deepEqual(request(calls), { op: 'tree', pid: 1234, title: 'Form', maxDepth: 5, maxNodes: 10, query: "x'; rm -rf /", deadlineMs: LINUX_A11Y_DEADLINE_MS });
});

test('a reader killed by its time limit or cut by its output size is a tree too large, not a failure of the bus', async () => {
  const killed = Object.assign(new Error('Command failed: python3'), { killed: true, signal: 'SIGTERM' });
  const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  for (const error of [killed, overflow]) {
    await assert.rejects(setup(error).backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 }), (e: unknown) => e instanceof A11yError && e.kind === 'too_large');
  }
  // An action that runs out of time stays a plain failure: the tree's advice would not apply.
  await assert.rejects(setup(killed).backend.act({ windowId: '42', path: '0.1', action: 'press' }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
});

test('a reader that stopped at its deadline answers a truncated, timed-out tree', async () => {
  const tree = await setup({ truncated: false, timedOut: true, nodes: [{ path: '0', role: 'window', name: 'Form', enabled: true, actions: [] }] }).backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 });
  assert.equal(tree.truncated, true);
  assert.equal(tree.timedOut, true);
});

test('act passes the value as data and maps the reader refusals', async () => {
  const ok = setup({ ok: true });
  await ok.backend.act({ windowId: '42', path: '0.0.1', action: 'set_value', value: '"; import os' });
  assert.deepEqual(request(ok.calls), { op: 'act', pid: 1234, title: 'Form', path: '0.0.1', action: 'set_value', value: '"; import os' });

  await assert.rejects(setup({ error: 'stale' }).backend.act({ windowId: '42', path: '0.1', action: 'press' }), (e: unknown) => e instanceof A11yError && e.kind === 'stale');
  await assert.rejects(
    setup({ error: 'unsupported', actions: ['focus', 'bogus'] }).backend.act({ windowId: '42', path: '0.1', action: 'press' }),
    (e: unknown) => e instanceof A11yError && e.kind === 'unsupported' && e.actions.join() === 'focus',
  );
  await assert.rejects(setup({ error: 'failed' }).backend.act({ windowId: '42', path: '0.1', action: 'press' }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
});

test('a bad or vanished window is stale, and a reader crash is a failure', async () => {
  const bad = setup({ ok: true });
  await assert.rejects(bad.backend.tree({ windowId: '4; ls', maxDepth: 3, maxNodes: 3 }), (e: unknown) => e instanceof A11yError && e.kind === 'stale');
  assert.equal(bad.calls.length, 0);
  await assert.rejects(setup({}, true).backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 }), (e: unknown) => e instanceof A11yError && e.kind === 'stale');
  await assert.rejects(setup(new Error('boom')).backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
  await assert.rejects(setup({ truncated: false }).backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
});

test('the embedded python script is valid python', (t) => {
  const { calls, backend } = setup({ ok: true });
  void backend.probe();
  const script = calls[0]!.args[1]!;
  const check = spawnSync('python3', ['-I', '-c', 'import sys; compile(sys.stdin.read(), "a11y", "exec")'], { input: script });
  if (check.error) { t.skip('python3 is not installed'); return; }
  assert.equal(check.status, 0, check.stderr.toString());
});

// ── The walker itself, run on a simulated AT-SPI ───────────────────────────

/**
 * A stand-in for PyGObject's `gi.repository.Atspi`, put first on PYTHONPATH: the real embedded
 * script walks a tree read from a JSON file. Each element counts how often its children were
 * listed, so a test can prove a hidden page was never entered.
 */
const FAKE_GI = {
  'gi/__init__.py': 'def require_version(*args):\n    pass\n',
  'gi/repository/__init__.py': '',
  'gi/repository/Atspi.py': String.raw`
import atexit, json, os, sys, time
SPEC = json.load(open(os.environ['FAKE_ATSPI_TREE']))
DELAY = float(os.environ.get('FAKE_ATSPI_DELAY', '0'))
LISTED = []
DEFAULT_STATES = ('SHOWING', 'VISIBLE', 'ENABLED')

class _Names:
    def __getattr__(self, name):
        return name
StateType = _Names()
CoordType = _Names()
ScrollType = _Names()

class _States:
    def __init__(self, states):
        self.states = set(states)
    def contains(self, state):
        return state in self.states

class _Rect:
    def __init__(self, x, y, width, height):
        self.x, self.y, self.width, self.height = x, y, width, height

def _pause():
    if DELAY:
        time.sleep(DELAY)

class Accessible:
    def __init__(self, spec, parent, pid):
        self.spec, self.parent, self.pid, self.kids = spec, parent, pid, None
    def _children(self):
        if self.kids is None:
            self.kids = [Accessible(child, self, self.pid) for child in self.spec.get('children', [])]
        return self.kids
    def get_child_count(self):
        _pause()
        LISTED.append(self.spec.get('name', ''))
        return len(self._children())
    def get_child_at_index(self, index):
        return self._children()[index]
    def get_name(self):
        return self.spec.get('name', '')
    def get_role_name(self):
        return self.spec.get('role', 'panel')
    def get_state_set(self):
        _pause()
        return _States(self.spec.get('states', DEFAULT_STATES))
    def get_interfaces(self):
        return self.spec.get('ifaces', ['Component'])
    def get_process_id(self):
        return self.pid
    def get_parent(self):
        return self.parent
    def get_index_in_parent(self):
        return self.parent._children().index(self)
    def __getattr__(self, name):
        if name.endswith('_iface'):
            return lambda: None
        raise AttributeError(name)

class Action:
    @staticmethod
    def get_n_actions(acc):
        return len(acc.spec.get('actions', []))
    @staticmethod
    def get_action_name(acc, index):
        return acc.spec['actions'][index]

class Component:
    @staticmethod
    def get_extents(acc, coord):
        return _Rect(0, 0, 10, 10)

class Text:
    @staticmethod
    def get_text(acc, start, end):
        return acc.spec.get('text', '')[start:end]

def get_desktop(index):
    return Accessible({'children': [{'name': 'app', 'role': 'application', 'children': [SPEC]}]}, None, 1234)

atexit.register(lambda: sys.stderr.write(json.dumps({'listed': LISTED})))
`,
};

interface Spec { name?: string; role?: string; states?: string[]; actions?: string[]; children?: Spec[] }

const button = (name: string): Spec => ({ name, role: 'push button', actions: ['click'] });
/** A page of the editor: panels nested `depth` deep, with a few buttons at the bottom. */
function page(name: string, depth: number, hidden: 'not-showing' | 'showing'): Spec {
  let inner: Spec = { name: `${name} content`, role: 'panel', children: [button(`${name} find`), button(`${name} replace`), { role: 'text', name: `${name} text` }] };
  for (let level = 0; level < depth; level++) inner = { role: 'panel', children: [inner, { role: 'panel' }] };
  return { name, role: 'panel', ...(hidden === 'not-showing' ? { states: ['VISIBLE', 'ENABLED'] } : {}), children: [inner] };
}
/**
 * gnome-text-editor with 63 documents open: the pages, a tab strip, then the header bar holding the
 * named toolbar buttons, last in reading order. The first page is shown; of the other 62, half say
 * so (no SHOWING state) and half claim to be shown although they are not, as GTK4 stack pages do.
 * About 2 900 elements.
 */
function editorWindow(): Spec {
  const pages: Spec[] = [];
  for (let index = 0; index < 63; index++) pages.push(page(`page ${index}`, 18, index === 0 || index % 2 === 0 ? 'showing' : 'not-showing'));
  return {
    name: 'Document 1 - Text Editor', role: 'frame', children: [
      { role: 'panel', children: pages },
      { role: 'page tab list', children: Array.from({ length: 63 }, (_, index) => ({ name: `Document ${index + 1}`, role: 'page tab', actions: ['click'] })) },
      { role: 'panel', children: [{ name: 'toolbar', role: 'tool bar', children: [button('Open'), button('New tab'), button('Main menu')] }] },
    ],
  };
}
const count = (spec: Spec): number => 1 + (spec.children ?? []).reduce((sum, child) => sum + count(child), 0);

/** Runs the embedded script on `window` and returns its answer and the elements whose children it listed. */
function walkFake(window: Spec, request: Record<string, unknown>, delay = 0): { out: A11yRawTree; listed: string[] } | null {
  const { calls, backend } = setup({ ok: true });
  void backend.probe();
  const script = calls[0]!.args[1]!;
  const dir = mkdtempSync(join(tmpdir(), 'fake-atspi-'));
  try {
    for (const [file, text] of Object.entries(FAKE_GI)) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    writeFileSync(join(dir, 'tree.json'), JSON.stringify(window));
    const run = spawnSync('python3', ['-c', script, JSON.stringify({ op: 'tree', title: window.name, pid: 1234, ...request })], {
      env: { ...process.env, PYTHONPATH: dir, FAKE_ATSPI_TREE: join(dir, 'tree.json'), FAKE_ATSPI_DELAY: String(delay) }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (run.error) return null;
    assert.equal(run.status, 0, run.stderr.toString());
    const stderr = run.stderr.toString();
    return { out: JSON.parse(run.stdout.toString()) as A11yRawTree, listed: (JSON.parse(stderr.slice(stderr.lastIndexOf('{"listed"'))) as { listed: string[] }).listed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const display = { width: 1000, height: 1000, scaleFactor: 1 };
const asTree = (out: A11yRawTree, args: { maxDepth: number; maxNodes: number; query?: string }) => buildTree({ id: '42', title: '', app: '' }, out, args, display, { width: 1000, height: 1000 });

test('a query finds the toolbar buttons of a large window: only the matches and their ancestors count against maxNodes', (t) => {
  const window = editorWindow();
  assert.ok(count(window) > 2500);
  for (const maxNodes of [150, 600]) {
    const run = walkFake(window, { maxDepth: 15, maxNodes, query: 'button', deadlineMs: 20_000 });
    if (!run) { t.skip('python3 is not installed'); return; }
    const tree = asTree(run.out, { maxDepth: 15, maxNodes, query: 'button' });
    const names = tree.nodes.filter((node) => node.role === 'button').map((node) => node.name);
    for (const name of ['Open', 'New tab', 'Main menu']) assert.ok(names.includes(name), `${name} missing with maxNodes ${maxNodes}`);
    // Every node the reader kept survives the tree builder: none is an orphan, none is beyond the limit.
    assert.equal(tree.nodes.length, run.out.nodes.length);
    assert.ok(tree.nodes.length <= maxNodes);
    // The pages that say they are hidden are never entered.
    assert.ok(!run.listed.some((name) => /^page \d*[13579]$/.test(name)), 'a hidden page was walked');
  }
});

test('without a query the walk is breadth first: the toolbar comes before the deep content, in reading order', (t) => {
  const run = walkFake(editorWindow(), { maxDepth: 15, maxNodes: 150, deadlineMs: 20_000 });
  if (!run) { t.skip('python3 is not installed'); return; }
  assert.equal(run.out.truncated, true);
  assert.equal(run.out.nodes.length, 150);
  assert.ok(['Open', 'New tab', 'Main menu'].every((name) => run.out.nodes.some((node) => node.name === name)));
  // Parents before their children, siblings in order: what the tree builder and the agent read.
  const paths = run.out.nodes.map((node) => node.path);
  const order = (path: string) => path.split('.').map(Number);
  const before = (a: string, b: string) => { const x = order(a); const y = order(b); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]!; return x.length < y.length; };
  for (let index = 1; index < paths.length; index++) assert.ok(before(paths[index - 1]!, paths[index]!), `${paths[index - 1]} then ${paths[index]}`);
  assert.equal(asTree(run.out, { maxDepth: 15, maxNodes: 150 }).nodes.length, 150);
});

test('the walk stops at its deadline and answers what it read, marked as timed out', (t) => {
  const started = Date.now();
  const run = walkFake(editorWindow(), { maxDepth: 15, maxNodes: 1500, query: 'zzz-nothing', deadlineMs: 300 }, 0.002);
  if (!run) { t.skip('python3 is not installed'); return; }
  assert.ok(Date.now() - started < 15_000);
  assert.equal(run.out.truncated, true);
  assert.equal((run.out as { timedOut?: boolean }).timedOut, true);
  assert.deepEqual(run.out.nodes, []);
});
