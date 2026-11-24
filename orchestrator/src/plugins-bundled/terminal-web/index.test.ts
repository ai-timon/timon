/**
 * What the module does to the terminal host's shells when its fiber goes.
 * A daemon stop releases the whole module tree (`daemon-shutdown.ts`): the
 * shells must stay in the host, only the link closes, so that the next daemon
 * reconnects to them. Disabling the module still kills them all.
 *
 * The module runs as in the daemon, through the kernel; the host it reconnects
 * to is an in-process host server listening on the test home's endpoint.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import { installDaemonShutdown } from '../../daemon-shutdown.js';
import { timonVersion } from '../../data-version.js';
import type { Host } from '../../host/index.js';
import { createHostPlugin } from '../../kernel/host-service.js';
import { createHttpPlugin } from '../../kernel/http-service.js';
import { TIMON_HOME } from '../../paths.js';
import { hostFiles, newToken } from '../../terminal-host/protocol.js';
import { createHostServer, type HostServer } from '../../terminal-host/server.js';
import type { Pty } from '../../terminal-host/sessions.js';
import * as terminalWeb from './index.js';

function fakePty(): Pty {
  let onExit: (e: { exitCode: number }) => void = () => {};
  return {
    pid: 4242,
    onData: () => {},
    onExit: (l) => { onExit = l; },
    write: () => {},
    resize: () => {},
    kill: () => onExit({ exitCode: 0 }),
  };
}

/** A running host with one shell, as a previous daemon would have left it. */
async function runningHost(): Promise<HostServer> {
  const files = hostFiles(TIMON_HOME);
  if (files.endpointDir) mkdirSync(files.endpointDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(files.token), { recursive: true, mode: 0o700 });
  const token = newToken();
  writeFileSync(files.token, `${token}\n`, { mode: 0o600 });
  const host = createHostServer({ token, spawn: fakePty, build: timonVersion(), entry: 'main', exitAfterMs: 60_000, onIdleExit: () => {} });
  await new Promise<void>((resolve, reject) => {
    host.server.once('error', reject);
    host.server.listen(files.endpoint, () => resolve());
  });
  host.sessions.create('alice', { shell: 'sh', args: [], cwd: '/', env: {} });
  return host;
}

function connections(host: HostServer): Promise<number> {
  return new Promise((resolve, reject) => host.server.getConnections((err, n) => (err ? reject(err) : resolve(n))));
}

async function until(cond: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The module under the kernel, connected to the host. */
async function startModule(host: HostServer): Promise<{ dispose: () => Promise<void> }> {
  const fakeHost = { spawnDetached: async () => { throw new Error('a host is already running'); } } as unknown as Host;
  const root = new Context();
  await root.plugin(createHttpPlugin(express()));
  await root.plugin(createHostPlugin(fakeHost));
  await root.plugin({ name: 'stub-db', apply(ctx: Context) { ctx.provide('db', {}); } });
  const fiber = await root.plugin(terminalWeb);
  await until(async () => (await connections(host)) > 0);
  return { dispose: async () => { await fiber.dispose(); } };
}

test.describe('terminal-web release', { concurrency: false }, () => {
  test('a daemon stop leaves the shells in the host and only closes the link', async () => {
    const host = await runningHost();
    try {
      const mod = await startModule(host);
      const proc = new EventEmitter();
      let exited!: () => void;
      const exit = new Promise<void>((resolve) => { exited = resolve; });
      const uninstall = installDaemonShutdown({
        proc, signals: ['SIGTERM'], release: mod.dispose, exit: () => exited(), log: () => {}, steps: () => [],
      });
      try {
        proc.emit('SIGTERM', 'SIGTERM');
        await exit;
      } finally {
        uninstall();
      }
      await until(async () => (await connections(host)) === 0);
      assert.equal(host.sessions.count(), 1, 'the shell is still running for the next daemon');
    } finally {
      host.close();
    }
  });

  test('disabling the module kills every shell in the host', async () => {
    const host = await runningHost();
    try {
      const mod = await startModule(host);
      await mod.dispose();
      await until(() => host.sessions.count() === 0);
    } finally {
      host.close();
    }
  });

  test('the choice follows the stop state alone', async () => {
    const calls: string[] = [];
    const store = {
      dispose: async () => { calls.push('dispose'); },
      disconnect: () => { calls.push('disconnect'); },
    } as unknown as Parameters<typeof terminalWeb.releaseSessions>[0];
    await terminalWeb.releaseSessions(store, () => true);
    await terminalWeb.releaseSessions(store, () => false);
    assert.deepEqual(calls, ['disconnect', 'dispose']);
  });
});
