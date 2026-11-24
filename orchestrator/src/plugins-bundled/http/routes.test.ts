/**
 * `GET /api/health` is a CONTRACT, not a formality (step 5.6.4).
 *
 * The desktop shell uses it to decide whether Timon is running before it opens
 * a window. On a machine where another daemon holds the port — the v1 on
 * :3000, with a health route of its own — an answer that does not name itself
 * made the shell open a window on an app port nobody served: a blank page and
 * no message. The daemon must say who it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'timon-routes-test-'));
process.env.TIMON_HOME = HOME;

const express = (await import('express')).default;
const { registerRoutes } = await import('./routes.js');
const { instanceId } = await import('../../host/packaged-service.js');
const { BRAND } = await import('../../brand.js');
const { installPlanFor } = await import('../../host/machine.js');
const { machineFromEnvironment } = await import('../../onboarding.js');

test('/api/health names the service that answers', async () => {
  const app = express();
  registerRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: BRAND.id, instance: instanceId(HOME), packaged: false });
    const desktopModule = new URL('../../../../desktop/src/health.ts', import.meta.url).href;
    const desktop = await import(desktopModule);
    const health = await desktop.probeHealth(`http://127.0.0.1:${addr.port}`);
    assert.equal(desktop.isTimon(health, HOME), true);
    assert.equal(desktop.isTimon(health, join(HOME, 'another-home')), false);
    // TODO #477: a daemon run from the sources says so, and the desktop reads it.
    assert.equal(health.packaged, false);
  } finally {
    server.close();
  }
});

test('/api/health/resources reports the daemon heap next to the cgroup numbers', async () => {
  const app = express();
  registerRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health/resources`);
    assert.equal(res.status, 200);
    const body = await res.json() as { daemon?: { heapUsedMb: number; heapLimitMb: number; rssMb: number; sse: { clients: number; busEventListeners: number } } };
    assert.ok(body.daemon, 'a heap that grows has to be readable without attaching a debugger');
    assert.ok(body.daemon.heapUsedMb > 0 && body.daemon.heapUsedMb < body.daemon.heapLimitMb);
    assert.ok(body.daemon.rssMb > 0);
    assert.equal(body.daemon.sse.clients, 0);
  } finally {
    server.close();
  }
});

async function listening() {
  const app = express();
  app.use(express.json());
  registerRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return { base: `http://127.0.0.1:${addr.port}`, server };
}

const CONFIG = join(HOME, 'timon.config.json');

/**
 * `POST /api/onboarding` (step 5.7.3) — the surface where a browser can make
 * this machine run something. What it refuses matters more than what it does.
 */
test('onboarding: only a named action gets through, never a command', async () => {
  const { base, server } = await listening();
  try {
    for (const body of [
      { action: 'run', command: 'rm -rf /' },
      { action: 'install-binary', name: 'curl && rm -rf ~' },
      { action: 'install-binary' },
      {},
    ]) {
      const res = await fetch(`${base}/api/onboarding`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `refused: ${JSON.stringify(body)}`);
    }
  } finally {
    server.close();
  }
});

/**
 * The order this door imposes on the client: install the service FIRST,
 * write `timon.config.json` NEXT; writing that file ends the first
 * launch, and so closes this route.
 */
test('onboarding: refused as soon as a config exists, without advising a missing CLI', async () => {
  const { base, server } = await listening();
  writeFileSync(CONFIG, '{}\n');
  try {
    const res = await fetch(`${base}/api/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'install-service' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { command?: string };
    assert.equal(body.command, null);
  } finally {
    rmSync(CONFIG, { force: true });
    server.close();
  }
});

// Where the install needs no administrator rights (Homebrew on macOS) the
// route really runs it: a test must not install git on the machine it runs on.
const gitPlan = installPlanFor('git', machineFromEnvironment());
const installsForReal = gitPlan !== null && !gitPlan.elevated;
test('onboarding: a privileged prerequisite returns the command to paste', { skip: installsForReal && 'this machine installs git without privileges' }, async () => {
  const { base, server } = await listening();
  try {
    const res = await fetch(`${base}/api/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'install-binary', name: 'git' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; command: string | null; reason: string | null };
    // On this machine (apt): refused and shown. On a machine without a
    // known manager: refused without a command. Never run in either case.
    assert.equal(body.ok, false);
    assert.ok(body.reason);
  } finally {
    server.close();
  }
});
