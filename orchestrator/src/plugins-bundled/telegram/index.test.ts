/**
 * The `telegram` module: what decides to launch (or not) the two workers.
 *
 * In the order of risk:
 *   1. The module is disabled by default. Two pollers on the same bot would
 *      steal each other's Telegram updates: an active default would silence the channel
 *      the first time the daemon restarts next to the compose stack.
 *   2. Without a configured channel, a silent no-op: no throw, no child.
 *   3. The workers' environment is the HOST one, not the compose one:
 *      inherited `process.env` (the bot tokens live there) and loopback rather
 *      than `app:3100` / `host.docker.internal:3000`.
 *
 * No test opens a port or reaches Telegram: the host is fake.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { setConfig } = await import('../../config/load.js');
const { createHostPlugin } = await import('../../kernel/host-service.js');
const { TimonConfigSchema } = await import('../../config/schema.js');
const telegram = await import('./index.js');
const web = await import('../web-app/index.js');

type FakeChild = EventEmitter & { pid?: number; kill: () => boolean; killed: boolean };

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

/** Fake host: runs nothing, records the calls to `spawn`. */
function fakeHost() {
  const calls: { name: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  const host = {
    platform: 'linux' as const,
    capabilities: () => [],
    bin: (n: string) => n,
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
    execAsync: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawn: (name: string, args: string[], opts: Record<string, unknown> = {}) => {
      calls.push({ name, args, opts });
      const child = fakeChild(5000 + children.length);
      children.push(child);
      return child as never;
    },
    confine: (cmd: string, args: string[]) => ({ cmd, args }),
    services: {
      start: () => {}, stop: () => {}, status: () => 'stopped' as const,
      self: () => ({ status: 'running' }), selfRestart: () => {},
    },
  };
  return { host, calls, children };
}

/** A throwaway root with an "installed" app (the `tsx` the module looks for). */
function appRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'timon-telegram-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  mkdirSync(join(root, 'app', 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(root, 'app', 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  return root;
}

function configFor(root: string, modules: Record<string, unknown>) {
  const cfg = TimonConfigSchema.parse({ daemon: { installDir: join(root, 'orchestrator') }, modules });
  setConfig(cfg);
  return cfg;
}

async function applyWith(host: unknown) {
  const root = new Context();
  await root.plugin(createHostPlugin(host as never));
  return root.plugin({ name: telegram.name, inject: telegram.inject, apply: telegram.apply });
}

test('the module is disabled by default: no spawn at boot', async () => {
  const root = appRoot();
  const cfg = configFor(root, {});
  assert.equal(telegram.isEnabled(cfg), false, "a module missing from the table is 'auto', hence disabled here");

  const { host, calls } = fakeHost();
  await applyWith(host);
  assert.deepEqual(calls, []);
});

test("only an explicit `enabled: true` enables the module: 'auto' and false are not enough", () => {
  const root = appRoot();
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': 'auto' })), false);
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': false })), false);
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': {} })), false);
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': true })), true);
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': { enabled: true } })), true);
});

test('enabled without a configured channel: log and no-op, no throw', async () => {
  const root = appRoot();
  configFor(root, { '@timon/telegram': true });
  // TIMON_HOME is an isolated test folder, without `channels/`.
  assert.equal(telegram.hasChannels(), false);

  const { host, calls } = fakeHost();
  await applyWith(host); // must not reject
  assert.deepEqual(calls, [], 'aucun worker tant qu\'aucun canal n\'existe');
});

test('a `channels/` folder without .json does not count as configured', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'timon-telegram-')), 'channels');
  mkdirSync(dir, { recursive: true });
  assert.equal(telegram.hasChannels(dir), false);
  writeFileSync(join(dir, 'README.md'), '');
  assert.equal(telegram.hasChannels(dir), false);
  writeFileSync(join(dir, 'telegram.json'), '{}');
  assert.equal(telegram.hasChannels(dir), true);
});

test('both workers go through the host, with the real repository paths', () => {
  const root = appRoot();
  const cfg = configFor(root, { '@timon/telegram': true });
  const appDir = join(root, 'app');
  const { host, calls, children } = fakeHost();

  const stop = telegram.superviseWorkers(host as never, cfg, appDir);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ['node', 'node']);
  assert.deepEqual(calls[0].args, [join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'workers', 'telegram-poll.ts')]);
  // The compose service is called `reply-worker` but runs `mission-watcher.ts`:
  // that is the real file, and the worker is not renamed here.
  assert.deepEqual(calls[1].args, [join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'workers', 'mission-watcher.ts')]);
  assert.equal(calls[0].opts.cwd, appDir);

  stop();
  assert.deepEqual(children.map((c) => c.killed), [true, true], 'the disposer kills both workers');
});

test('desktop package: the workers run on the embedded Node, not on a `node` from the PATH', () => {
  const root = appRoot();
  const cfg = configFor(root, { '@timon/telegram': true });
  const appDir = join(root, 'app');
  const { host, calls } = fakeHost();
  const execPath = join(root, 'Timon');
  const node = web.nodeRuntime(cfg, { execPath, electron: '33.0.0' });

  const stop = telegram.superviseWorkers(host as never, cfg, appDir, node);

  assert.deepEqual(calls.map((c) => c.name), [execPath, execPath]);
  for (const call of calls) {
    assert.equal((call.opts.env as Record<string, string>).ELECTRON_RUN_AS_NODE, '1');
  }
  stop();
});

test('compiled workers: launched without tsx, and a package without tsx starts them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-telegram-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, '.next', 'timon', 'workers'), { recursive: true }); // no node_modules/tsx
  for (const w of telegram.WORKERS) writeFileSync(join(appDir, '.next', 'timon', 'workers', `${w}.cjs`), '');
  configFor(root, { '@timon/telegram': true });
  const channels = join(process.env.TIMON_HOME!, 'channels');
  mkdirSync(channels, { recursive: true });
  writeFileSync(join(channels, 'telegram.json'), '{"type":"telegram"}');

  const { host, calls } = fakeHost();
  const fork = await applyWith(host);

  assert.deepEqual(calls.map((c) => c.args), [
    [join(appDir, '.next', 'timon', 'workers', 'telegram-poll.cjs')],
    [join(appDir, '.next', 'timon', 'workers', 'mission-watcher.cjs')],
  ]);
  await fork.dispose();
  rmSync(join(channels, 'telegram.json'));
});

test('environment: inherited `process.env`, loopback URLs and not those of the docker network', () => {
  const root = appRoot();
  const cfg = configFor(root, { '@timon/telegram': true });

  process.env.TIMON_TELEGRAM_TEST_TOKEN = 'secret-de-bot';
  try {
    const poll = telegram.envOf(cfg, 'telegram-poll');
    // The bot tokens are named by the channel config (`bot_token_env`):
    // impossible to enumerate them, so the environment must be inherited.
    assert.equal(poll.TIMON_TELEGRAM_TEST_TOKEN, 'secret-de-bot');
    assert.equal(poll.APP_URL, `http://127.0.0.1:${cfg.app.listen.port}`);
    assert.equal(poll.ORCHESTRATOR_URL, process.env.ORCHESTRATOR_URL);
    assert.equal(poll.TIMON_HOME, process.env.TIMON_HOME);

    const watcher = telegram.envOf(cfg, 'mission-watcher');
    assert.equal(watcher.ORCHESTRATOR_URL, `http://127.0.0.1:${cfg.daemon.listen.port}`);
    assert.equal(watcher.TIMON_TELEGRAM_TEST_TOKEN, 'secret-de-bot');
  } finally {
    delete process.env.TIMON_TELEGRAM_TEST_TOKEN;
  }
});

test('enabled, channel present, but app not installed: actionable message and no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-telegram-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  mkdirSync(join(root, 'app'), { recursive: true }); // no node_modules/tsx
  configFor(root, { '@timon/telegram': true });
  const channels = join(process.env.TIMON_HOME!, 'channels');
  mkdirSync(channels, { recursive: true });
  writeFileSync(join(channels, 'telegram.json'), '{"type":"telegram"}');

  const { host, calls } = fakeHost();
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    await applyWith(host);
  } finally {
    console.error = realError;
  }

  assert.deepEqual(calls, []);
  assert.ok(errors.some((e) => e.includes('cd app && npm install')), errors.join('\n'));
});
