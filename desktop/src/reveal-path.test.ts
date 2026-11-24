// french-ok-file: accented folder names, the non-ASCII paths under test
import assert from 'node:assert/strict';
import test from 'node:test';
import { revealEntry, type RevealPathDeps } from './reveal-path.js';

const origin = 'http://127.0.0.1:4312';
const sender = { isWindow: true, isMainFrame: true, url: `${origin}/chat` };

type Entries = Record<string, 'file' | 'dir'>;

function fake(
  platform: NodeJS.Platform,
  entries: Entries,
  reply: { status: number; body: unknown } | Error,
  opts: { links?: Record<string, string>; openFailure?: string } = {},
) {
  const calls: string[] = [];
  const deps: RevealPathDeps = {
    platform,
    callRoute: async (agentId, path) => {
      calls.push(`route:${agentId}:${path}`);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    stat: (p) => { calls.push(`stat:${p}`); return p in entries ? { isDirectory: () => entries[p] === 'dir' } : null; },
    realpath: (p) => opts.links?.[p] ?? p,
    exists: (p) => Object.keys(entries).some((e) => e === p || e.startsWith(`${p}/`)),
    showItemInFolder: (p) => { calls.push(`show:${p}`); },
    openPath: async (p) => { calls.push(`open:${p}`); return opts.openFailure ?? ''; },
  };
  return { deps, calls };
}

const client = (absolutePath: string) => ({ status: 200, body: { kind: 'client', path: 'x', absolutePath, isDir: false } });

test('a file the daemon returned is shown in its folder, never opened', async () => {
  const { deps, calls } = fake('linux', { '/home/u/a b.txt': 'file' }, client('/home/u/a b.txt'));
  assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: 'a b.txt' }, deps), { status: 'opened' });
  assert.deepEqual(calls, ['route:a:a b.txt', 'stat:/home/u/a b.txt', 'show:/home/u/a b.txt']);
});

test('a plain folder is opened, accents and spaces untouched', async () => {
  const { deps, calls } = fake('darwin', { '/Users/Zoé/Mes documents': 'dir' }, client('/Users/Zoé/Mes documents'));
  assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: 'Mes documents' }, deps), { status: 'opened' });
  assert.deepEqual(calls.slice(-1), ['open:/Users/Zoé/Mes documents']);
});

test('macOS bundles are selected, never opened: .app, upper case, a link to one, Info.plist', async () => {
  const entries: Entries = {
    '/u/Calculator.app': 'dir', '/u/CALC.APP': 'dir', '/u/Raccourci': 'dir',
    '/u/Odd': 'dir', '/u/Odd/Contents/Info.plist': 'file',
  };
  const links = { '/u/Raccourci': '/u/Calculator.app' };
  for (const path of ['/u/Calculator.app', '/u/CALC.APP', '/u/Raccourci', '/u/Odd']) {
    const { deps, calls } = fake('darwin', entries, client(path), { links });
    assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: 'x' }, deps), { status: 'opened' }, path);
    assert.ok(calls.includes(`show:${path}`), path);
    assert.equal(calls.some((c) => c.startsWith('open:')), false, `${path} must not be opened`);
  }
});

test('Windows: a directory opens, a file (even run.bat) is only selected', async () => {
  const dir = fake('win32', { 'C:\\Users\\Zoé\\Mes documents': 'dir' }, client('C:\\Users\\Zoé\\Mes documents'));
  await revealEntry(sender, origin, { agentId: 'a', path: 'd' }, dir.deps);
  assert.deepEqual(dir.calls.slice(-1), ['open:C:\\Users\\Zoé\\Mes documents']);
  const file = fake('win32', { 'C:\\u\\run.bat': 'file' }, { status: 200, body: { kind: 'client', absolutePath: 'C:\\u\\run.bat', isDir: true } });
  await revealEntry(sender, origin, { agentId: 'a', path: 'run.bat' }, file.deps);
  assert.deepEqual(file.calls.slice(-1), ['show:C:\\u\\run.bat'], 'a reply isDir is never trusted');
});

test('the renderer cannot supply a filesystem path: an absolute one is only a relative request to the daemon', async () => {
  const { deps, calls } = fake(
    'darwin', { '/Applications/Calculator.app': 'dir' },
    { status: 400, body: { error: 'path escapes the agent folder' } },
  );
  const out = await revealEntry(
    sender, origin,
    { agentId: 'a', path: '/Applications/Calculator.app', absolutePath: '/Applications/Calculator.app' }, deps,
  );
  assert.deepEqual(out, { status: 'failed', message: 'path escapes the agent folder' });
  assert.deepEqual(calls, ['route:a:/Applications/Calculator.app'], 'no disk or shell operation');
});

test('a path-only call without an agent is refused before any request', async () => {
  const { deps, calls } = fake('darwin', { '/Applications/Calculator.app': 'dir' }, client('/Applications/Calculator.app'));
  for (const input of [
    { path: '/Applications/Calculator.app' }, { agentId: '', path: 'x' }, { agentId: 7, path: 'x' },
    { agentId: 'a' }, { agentId: 'a', path: 42 }, { agentId: 'a\0b', path: 'x' }, { agentId: 'a', path: 'x\0' },
    { agentId: 'a', path: 'x'.repeat(5000) }, { agentId: 'x'.repeat(300), path: '' }, null, 'C:\\a', undefined,
  ]) {
    await assert.rejects(revealEntry(sender, origin, input, deps), /Invalid path/, JSON.stringify(input)?.slice(0, 40));
  }
  assert.deepEqual(calls, []);
});

test('the route decides: its refusal and its no-desktop code are relayed, nothing is shown', async () => {
  const refused = fake('linux', { '/a': 'file' }, { status: 404, body: { error: 'not found: z' } });
  assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: 'z' }, refused.deps), { status: 'failed', message: 'not found: z' });
  const none = fake('linux', {}, { status: 409, body: { error: 'x', code: 'no_desktop_session' } });
  assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: '' }, none.deps), { status: 'no-desktop' });
  const html = fake('linux', {}, { status: 502, body: null });
  assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: '' }, html.deps), { status: 'failed', message: null });
  const down = fake('linux', {}, new Error('offline'));
  assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: '' }, down.deps), { status: 'failed', message: 'offline' });
  for (const calls of [refused.calls, none.calls, html.calls, down.calls]) {
    assert.equal(calls.some((c) => c.startsWith('show:') || c.startsWith('open:') || c.startsWith('stat:')), false);
  }
});

test('the daemon already revealed it: nothing more to do locally', async () => {
  const { deps, calls } = fake('win32', {}, { status: 200, body: { kind: 'revealed', path: 'x', via: 'explorer' } });
  assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: 'x' }, deps), { status: 'opened' });
  assert.deepEqual(calls, ['route:a:x']);
});

test('a returned path that is not local and absolute is refused: relative, UNC, device, missing', async () => {
  for (const [platform, path] of [
    ['linux', 'rel/x'], ['win32', '\\\\attacker\\share\\x.txt'], ['win32', '\\\\?\\C:\\x'], ['win32', '//attacker/share/x'],
    ['win32', 'x.txt'], ['linux', '/gone'],
  ] as const) {
    const { deps, calls } = fake(platform, {}, client(path));
    const out = await revealEntry(sender, origin, { agentId: 'a', path: 'x' }, deps);
    assert.equal(out.status, 'failed', path);
    assert.equal(calls.some((c) => c.startsWith('show:') || c.startsWith('open:')), false, path);
  }
  const unknown = fake('linux', {}, { status: 200, body: { kind: 'client' } });
  assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: 'x' }, unknown.deps), { status: 'failed', message: null });
});

test('openPath reports failure as a string: surfaced as a failure', async () => {
  const { deps } = fake('linux', { '/d': 'dir' }, client('/d'), { openFailure: 'Failed to open path' });
  assert.deepEqual(await revealEntry(sender, origin, { agentId: 'a', path: 'd' }, deps), { status: 'failed', message: 'Failed to open path' });
});

test('rejects foreign windows, subframes and origins before any request', async () => {
  for (const change of [
    { isWindow: false }, { isMainFrame: false }, { url: 'https://example.com/chat' },
    { url: 'http://127.0.0.1:4313/chat' }, { url: 'invalid' }, { url: 'file:///chat' },
  ]) {
    const { deps, calls } = fake('linux', { '/a': 'file' }, client('/a'));
    await assert.rejects(
      revealEntry({ ...sender, ...change }, origin, { agentId: 'a', path: 'x' }, deps),
      /only available from Timon/,
    );
    assert.deepEqual(calls, []);
  }
});
