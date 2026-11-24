/**
 * TIM-0011 (3) — GET /api/terminal advertised the feature on hosts without
 * `gui`, and POST /api/terminal/open then answered 500. These tests pin the
 * contract: no gui → GET enabled:false + reason no_gui, POST 501; with gui
 * the historical responses stay; anonymous callers are refused.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';

delete process.env.TIMON_TERMINAL_ENABLED;

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
await import('../../../tests/helpers/claude-provider.js');

const { registerRoutes } = await import('./routes.js');
const { getHost } = await import('../../host/index.js');
const { upsertAgent } = await import('../../agent.js');
const { setSetting } = await import('../../settings.js');
const { isKnownCwd } = await import('../../terminal.js');

const TOKEN = 'terminal-native-test';
const cwd = process.env.TIMON_HOME!;
upsertAgent({ name: 'term-witness', system_prompt: 'witness', config: { cwd } });
assert.equal(isKnownCwd(cwd), true, 'the seeded agent cwd must be known to Timon');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function headers(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

function setGui(gui: ReturnType<typeof getHost>['gui']): () => void {
  const host = getHost();
  const previous = host.gui;
  host.gui = gui;
  return () => { host.gui = previous; };
}

test.describe('terminal-native routes', { concurrency: false }, () => {
  test('GET reports enabled:false with reason no_gui when the host has no gui', async (t) => {
    t.after(setGui(undefined));
    const res = await fetch(`${origin}/api/terminal`, { headers: headers() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      enabled: false,
      command: 'hyper',
      reason: 'no_gui',
    });
  });

  test('POST /api/terminal/open without gui is 501, never 500', async (t) => {
    t.after(setGui(undefined));
    const res = await fetch(`${origin}/api/terminal/open`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ cwd }),
    });
    assert.equal(res.status, 501);
    const body = await res.json() as { ok: boolean; error: string; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'no_gui');
    assert.match(body.error, /gui/i);
    assert.equal(/[À-ÿ]/.test(body.error), false, 'daemon errors are English'); // french-ok: the letters that betray French
  });

  test('GET stays enabled when the host has gui and the setting is on', async (t) => {
    t.after(setGui({ openTerminal() { /* no window in tests */ }, reveal: async () => 'xdg-open' as const }));
    const res = await fetch(`${origin}/api/terminal`, { headers: headers() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: true, command: 'hyper' });
  });

  test('POST with gui opens a known cwd and leaves real spawn failures as 500', async (t) => {
    const opened: string[] = [];
    t.after(setGui({
      openTerminal(path) { opened.push(path); },
      reveal: async () => 'xdg-open' as const,
    }));
    const ok = await fetch(`${origin}/api/terminal/open`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ cwd }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, cwd, command: 'hyper' });
    assert.deepEqual(opened, [cwd]);

    t.after(setGui({
      openTerminal() { throw new Error('spawn failed'); },
      reveal: async () => 'xdg-open' as const,
    }));
    const fail = await fetch(`${origin}/api/terminal/open`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ cwd }),
    });
    assert.equal(fail.status, 500);
    assert.deepEqual(await fail.json(), { ok: false, error: 'spawn failed' });
  });

  test('POST without a known cwd is 400, disabled setting is 403', async (t) => {
    t.after(setGui({ openTerminal() { throw new Error('must not spawn'); }, reveal: async () => 'xdg-open' as const }));
    t.after(() => { setSetting('TIMON_TERMINAL_ENABLED', null); });
    const missing = await fetch(`${origin}/api/terminal/open`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const unknown = await fetch(`${origin}/api/terminal/open`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ cwd: '/no/such/timon/path' }),
    });
    assert.equal(unknown.status, 400);

    setSetting('TIMON_TERMINAL_ENABLED', '0');
    const off = await fetch(`${origin}/api/terminal`, { headers: headers() });
    assert.equal(off.status, 200);
    const offBody = await off.json() as { enabled: boolean; reason?: string };
    assert.equal(offBody.enabled, false);
    assert.equal(offBody.reason, 'disabled');
    const refused = await fetch(`${origin}/api/terminal/open`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ cwd }),
    });
    assert.equal(refused.status, 403);
  });

  test('files/reveal answers with the lane the adapter really took (TIM-0084)', async (t) => {
    const revealed: string[] = [];
    // A reveal-only gui, as on Windows and macOS: no terminal, the file manager yes.
    t.after(setGui({ reveal: async (path) => { revealed.push(path); return 'explorer'; } }));
    const res = await fetch(`${origin}/api/agents/term-witness/files/reveal`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ path: '' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: 'revealed', path: '', via: 'explorer' });
    assert.deepEqual(revealed, [cwd]);

    const terminal = await fetch(`${origin}/api/terminal`, { headers: headers() });
    assert.deepEqual(await terminal.json(), { enabled: false, command: 'hyper', reason: 'no_gui' });
  });

  test.describe('files/reveal without a desktop session in the daemon (TIM-0084)', () => {
    const post = (body: unknown) => fetch(`${origin}/api/agents/term-witness/files/reveal`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    // The Windows service (S4U, session 0) and the macOS LaunchDaemon, as the adapter sees them.
    const serviceGui = (launched: string[]) => ({
      reveal: async (path: string) => { launched.push(path); return 'explorer' as const; },
      desktopSession: async () => 'none' as const,
    });

    test('the Electron client gets the validated absolute path and nothing is launched', async (t) => {
      const launched: string[] = [];
      t.after(setGui(serviceGui(launched)));
      writeFileSync(join(cwd, 'a b.txt'), 'x');
      const res = await post({ path: 'a b.txt', client: 'desktop' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        kind: 'client', path: 'a b.txt', absolutePath: join(cwd, 'a b.txt'), isDir: false,
      });
      const root = await post({ path: '', client: 'desktop' });
      assert.deepEqual(await root.json(), { kind: 'client', path: '', absolutePath: cwd, isDir: true });
      assert.deepEqual(launched, []);
    });

    test('a plain browser gets a 409 with a code, never a success', async (t) => {
      const launched: string[] = [];
      t.after(setGui(serviceGui(launched)));
      const res = await post({ path: '' });
      assert.equal(res.status, 409);
      const body = await res.json() as { error: string; code: string; kind?: string };
      assert.equal(body.code, 'no_desktop_session');
      assert.equal(body.kind, undefined);
      assert.equal(/[À-ÿ]/.test(body.error), false, 'daemon errors are English'); // french-ok: the letters that betray French
      assert.deepEqual(launched, []);
    });

    test('an unknown session is not trusted: client lane, or refusal', async (t) => {
      t.after(setGui({ reveal: async () => 'explorer', desktopSession: async () => 'unknown' }));
      assert.equal((await post({ path: '' })).status, 409);
      assert.equal((await post({ path: '', client: 'desktop' })).status, 200);
    });

    test('the daemon launches itself when it has a desktop session, client or not', async (t) => {
      const launched: string[] = [];
      t.after(setGui({
        reveal: async (path) => { launched.push(path); return 'finder'; },
        desktopSession: async () => 'graphical',
      }));
      for (const body of [{ path: '' }, { path: '', client: 'desktop' }]) {
        const res = await post(body);
        assert.deepEqual(await res.json(), { kind: 'revealed', path: '', via: 'finder' });
      }
      assert.deepEqual(launched, [cwd, cwd]);
    });

    test('confinement and existence are checked before any lane is chosen', async (t) => {
      t.after(setGui(serviceGui([])));
      for (const path of ['../outside', '../../etc', 'missing.txt']) {
        const res = await post({ path, client: 'desktop' });
        assert.equal(res.status, 400, path);
      }
    });

    test('anonymous callers are refused', async (t) => {
      t.after(setGui(serviceGui([])));
      const res = await fetch(`${origin}/api/agents/term-witness/files/reveal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '', client: 'desktop' }),
      });
      assert.equal(res.status, 401);
    });
  });

  test('anonymous GET and POST are refused', async () => {
    assert.equal((await fetch(`${origin}/api/terminal`)).status, 401);
    assert.equal((await fetch(`${origin}/api/terminal/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })).status, 401);
  });
});
