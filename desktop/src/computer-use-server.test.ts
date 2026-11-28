import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerCommandError } from './computer-use-protocol.js';
import { startComputerServer } from './computer-use-server.js';

test('provider publishes a private descriptor, authenticates, validates, and cleans up', async () => {
  const home = await mkdtemp(join(tmpdir(), 'timon-computer-server-'));
  const seen: unknown[] = [];
  const modes: string[] = [];
  const scopes: unknown[] = [];
  const provider = await startComputerServer(home, async (actor, command, allowedApps, mode, everything) => {
    modes.push(mode);
    scopes.push(everything);
    seen.push(allowedApps.length ? [actor, command, allowedApps] : [actor, command]);
    if (command.command === 'stop') throw new ComputerCommandError('nope', 409, 'computer_stopped');
    return { done: true };
  });
  const path = join(home, 'computer-native', 'provider.json');
  try {
    const descriptor = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(descriptor, provider.descriptor);
    assert.match(descriptor.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    const url = `${descriptor.origin}/command`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}` };
    const post = (body: unknown, h: Record<string, string> = headers) => fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
    for (const bad of [{ 'Content-Type': 'application/json' }, { ...headers, Authorization: 'Bearer wrong' }, { ...headers, Origin: 'http://evil.example' }]) {
      assert.equal((await post({ command: 'status', actor: 'agent' }, bad)).status, 401);
    }
    assert.equal(seen.length, 0);
    const ok = await post({ command: 'click', args: { x: 1, y: 2 }, actor: 'agent' });
    assert.deepEqual(await ok.json(), { ok: true, result: { done: true } });
    assert.deepEqual(seen[0], ['agent', { command: 'click', x: 1, y: 2, button: 'left' }]);
    await post({ command: 'type', args: { text: 'x' }, actor: 'agent', allowedApps: ['Notepad'] });
    assert.deepEqual(seen[1], ['agent', { command: 'type', text: 'x' }, [{ app: 'Notepad', mode: 'foreground' }]]);
    assert.equal((await post({ command: 'type', args: { text: 'x' }, actor: 'agent', allowedApps: 'Notepad' })).status, 400);
    assert.equal(modes.at(-1), 'foreground', 'no mode sent = the foreground');
    await post({ command: 'a11y_tree', actor: 'agent', allowedApps: ['Notepad'], mode: 'background' });
    assert.equal(modes.at(-1), 'background');
    assert.equal((await post({ command: 'a11y_tree', actor: 'agent', mode: 'sideways' })).status, 400);
    assert.equal(scopes.at(-1), null, 'no allApps sent = off');
    await post({ command: 'a11y_tree', actor: 'agent', mode: 'background', allApps: true, excludedApps: ['KeePassXC'] });
    assert.deepEqual(scopes.at(-1), { mode: 'background', excluded: ['KeePassXC'] }, 'the scope takes the agent\'s default mode');
    assert.equal((await post({ command: 'a11y_tree', actor: 'agent', allApps: true })).status, 400, 'on without its exclusions is refused');
    assert.equal((await post({ command: 'click', args: { x: 1 }, actor: 'agent' })).status, 400);
    assert.equal((await post({ command: 'click', args: { x: 1, y: 1 } })).status, 400);
    assert.equal((await post({ command: 'nope', actor: 'agent' })).status, 404);
    const stopped = await post({ command: 'stop', actor: 'human' });
    assert.equal(stopped.status, 409);
    assert.deepEqual(await stopped.json(), { ok: false, error: 'nope', code: 'computer_stopped' });
    assert.equal((await fetch(`${descriptor.origin}/other`, { method: 'POST', headers, body: '{}' })).status, 404);
    await provider.close();
    await assert.rejects(readFile(path), /ENOENT/);
  } finally { await provider.close(); await rm(home, { recursive: true, force: true }); }
});
