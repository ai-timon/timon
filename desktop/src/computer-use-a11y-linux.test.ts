import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { A11yError } from './computer-use-a11y.js';
import { linuxA11yBackend } from './computer-use-a11y-linux.js';
import type { SystemCommand } from './computer-use-input.js';

const GEOMETRY = 'WINDOW=42\nX=100\nY=50\nWIDTH=420\nHEIGHT=640\nSCREEN=0\n';

/**
 * A scripted executor: xdotool answers about window 42 (at 100,50), xprop gives its CSD shadow
 * (`frame`: xprop's answer, or an Error when xprop is missing), the python reader answers `reply`.
 */
function setup(reply: unknown | Error, xdotoolFails = false, frame: string | Error = '_GTK_FRAME_EXTENTS(CARDINAL) = 10, 12, 6, 14\n') {
  const calls: SystemCommand[] = [];
  const exec = async (command: SystemCommand): Promise<{ stdout: string }> => {
    calls.push(command);
    if (command.file === 'xdotool') {
      if (xdotoolFails) throw new Error('no window');
      const answers: Record<string, string> = { getwindowpid: '1234\n', getwindowgeometry: GEOMETRY };
      return { stdout: answers[command.args[0]!] ?? 'Form\n' };
    }
    if (command.file === 'xprop') {
      if (frame instanceof Error) throw frame;
      return { stdout: frame };
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
  assert.deepEqual(request(calls), {
    op: 'tree', pid: 1234, title: 'Form', window: { x: 100, y: 50, width: 420, height: 640 }, frame: [10, 12, 6, 14], maxDepth: 5, maxNodes: 10,
  });
});

test('tree sends what it could read of the window place, and nothing it could not', async () => {
  const nodes = { truncated: false, nodes: [] };
  const plain = setup(nodes, false, '_GTK_FRAME_EXTENTS:  not found.\n');
  await plain.backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 });
  assert.deepEqual(request(plain.calls).frame, [0, 0, 0, 0], 'a window without a CSD shadow');

  const noXprop = setup(nodes, false, Object.assign(new Error('spawn xprop ENOENT'), { code: 'ENOENT' }));
  await noXprop.backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 });
  assert.equal('frame' in request(noXprop.calls), false, 'the reader estimates the shadow itself');
  assert.deepEqual(request(noXprop.calls).window, { x: 100, y: 50, width: 420, height: 640 });

  const calls: SystemCommand[] = [];
  const noGeometry = linuxA11yBackend(async (command) => {
    calls.push(command);
    if (command.file === 'xdotool' && command.args[0] === 'getwindowgeometry') throw new Error('BadWindow');
    if (command.file === 'xdotool') return { stdout: command.args[0] === 'getwindowpid' ? '1234\n' : 'Form\n' };
    return { stdout: JSON.stringify(nodes) };
  });
  await noGeometry.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 });
  const sent = request(calls);
  assert.equal('window' in sent || 'frame' in sent, false);
  assert.equal(calls.some((c) => c.file === 'xprop'), false);

  const act = setup({ ok: true });
  await act.backend.act({ windowId: '42', path: '0.1', action: 'press' });
  assert.equal(act.calls.some((c) => c.args[0] === 'getwindowgeometry'), false, 'an action needs no position');
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

/** A stand-in for PyGObject's Atspi: an accessible tree described in JSON, with extents per coordinate type. */
const FAKE_ATSPI = String.raw`
import json, os
class _Names:
    def __getattr__(self, name):
        return name
class _Rect:
    def __init__(self, x, y, width, height):
        self.x, self.y, self.width, self.height = x, y, width, height
class _States:
    def __init__(self, names):
        self.names = set(names)
    def contains(self, state):
        return state in self.names
class _Acc:
    def __init__(self, spec, parent):
        self.spec, self.parent = spec, parent
        self.kids = [_Acc(child, self) for child in spec.get('children', [])]
    def get_state_set(self): return _States(self.spec.get('states', ['SHOWING', 'ENABLED']))
    def get_interfaces(self): return ['Component']
    def get_role_name(self): return self.spec.get('role', 'push button')
    def get_name(self): return self.spec.get('name', '')
    def get_child_count(self): return len(self.kids)
    def get_child_at_index(self, index): return self.kids[index]
    def get_parent(self): return self.parent
    def get_process_id(self): return self.spec.get('pid', 0)
    def __getattr__(self, name):
        if name.startswith('get_') and name.endswith('_iface'):
            return lambda: None
        raise AttributeError(name)
class _Component:
    @staticmethod
    def get_extents(acc, coord):
        return _Rect(*acc.spec[coord.lower()])
class _Action:
    @staticmethod
    def get_n_actions(acc): return 0
class Atspi:
    CoordType = _Names()
    StateType = _Names()
    Component = _Component
    Action = _Action
    @staticmethod
    def get_desktop(index): return _DESKTOP
_DESKTOP = _Acc(json.loads(os.environ['FAKE_ATSPI_DESKTOP']), None)
`;

/** Runs the embedded reader against the fake Atspi; null when python3 is not installed. */
function readTree(desktop: unknown, request: Record<string, unknown>): { nodes: { name: string; bounds?: unknown }[] } | null {
  const { calls, backend } = setup({ ok: true });
  void backend.probe();
  const script = calls[0]!.args[1]!;
  const dir = mkdtempSync(join(tmpdir(), 'timon-fake-atspi-'));
  try {
    mkdirSync(join(dir, 'gi', 'repository'), { recursive: true });
    writeFileSync(join(dir, 'gi', '__init__.py'), 'def require_version(name, version):\n    pass\n');
    writeFileSync(join(dir, 'gi', 'repository', '__init__.py'), FAKE_ATSPI);
    const run = spawnSync('python3', ['-c', script, JSON.stringify({ op: 'tree', title: 'Calculator', maxDepth: 5, maxNodes: 50, ...request })], {
      env: { ...process.env, PYTHONPATH: dir, FAKE_ATSPI_DESKTOP: JSON.stringify(desktop) },
    });
    if (run.error) return null;
    assert.equal(run.status, 0, run.stderr.toString());
    return JSON.parse(run.stdout.toString()) as { nodes: { name: string; bounds?: unknown }[] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** gnome-calculator under GTK4: SCREEN extents are 0,0 for every element, WINDOW ones are right. */
const gtk4 = (button: Record<string, unknown> = { name: '7', screen: [0, 0, 40, 30], window: [20, 100, 40, 30] }) => ({
  role: 'desktop', children: [{ role: 'application', name: 'gnome-calculator', pid: 1234, children: [
    { role: 'frame', name: 'Calculator', screen: [0, 0, 400, 600], window: [0, 0, 400, 600], children: [button] },
  ] }],
});
const boundsOf = (tree: { nodes: { name: string; bounds?: unknown }[] }) => Object.fromEntries(tree.nodes.map((n) => [n.name, n.bounds ?? null]));

test('GTK4 positions come from the window extents plus the window place and its CSD shadow', (t) => {
  const tree = readTree(gtk4(), { window: { x: 100, y: 50, width: 420, height: 640 }, frame: [10, 10, 6, 34] });
  if (!tree) { t.skip('python3 is not installed'); return; }
  assert.deepEqual(boundsOf(tree), {
    Calculator: { x: 110, y: 56, width: 400, height: 600 },
    7: { x: 130, y: 156, width: 40, height: 30 },
  });
});

test('without the shadow read, it is assumed even around the root the toolkit reports', (t) => {
  const tree = readTree(gtk4(), { window: { x: 100, y: 50, width: 420, height: 640 } });
  if (!tree) { t.skip('python3 is not installed'); return; }
  assert.deepEqual(boundsOf(tree)['7'], { x: 130, y: 170, width: 40, height: 30 });
});

test('with no known window place a GTK4 element has no position rather than 0,0', (t) => {
  const tree = readTree(gtk4(), {});
  if (!tree) { t.skip('python3 is not installed'); return; }
  assert.deepEqual(boundsOf(tree), { Calculator: null, 7: null });
});

test('real screen extents are kept as the toolkit gives them', (t) => {
  const tree = readTree(gtk4({ name: 'OK', screen: [300, 200, 80, 24], window: [5, 5, 80, 24] }), { window: { x: 100, y: 50, width: 420, height: 640 }, frame: [0, 0, 0, 0] });
  if (!tree) { t.skip('python3 is not installed'); return; }
  assert.deepEqual(boundsOf(tree).OK, { x: 300, y: 200, width: 80, height: 24 });
});
