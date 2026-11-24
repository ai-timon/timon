/**
 * The `tts` module: which URL, and which docker command.
 *
 * In the order of risk:
 *   1. Precedence. `TIMON_TTS_URL` always wins: starting a container
 *      while an external service is set means opening a second speech
 *      engine for nothing.
 *   2. The compose command. Without explicit `-f` and `-p`, it would run
 *      against the daemon's cwd, and an invented `-p` would create a SECOND stack
 *      next to the running one.
 *   3. `TIMON_TTS_URL` must be read through `settingStr`: it is a key of the
 *      `settings.ts` registry, hence settable from the UI.
 *   4. Docker installed is NOT ENOUGH to conclude "container": the Compose
 *      stack must also exist in this install. A package resolves
 *      `installDir` to `resources/orchestrator`, where no `docker-compose.yml`
 *      is shipped; launching compose there made every first packaged
 *      launch fail on a machine with Docker, with an advice
 *      (`docker compose build`) that makes no sense to an end user.
 *   5. Startup goes through `host.spawn` and NOT through `host.containers.cli`,
 *      which is synchronous: freezing the event loop in `apply` freezes the
 *      whole daemon (and `app.listen` with it) until docker answers.
 *
 * No test runs docker: the host is fake and records the calls.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { setConfig } = await import('../../config/load.js');
const { TimonConfigSchema } = await import('../../config/schema.js');
const { createHostPlugin } = await import('../../kernel/host-service.js');
const { setSetting } = await import('../../settings.js');
const tts = await import('./index.js');

type FakeChild = EventEmitter & { pid?: number; kill: () => boolean; killed: boolean };

/** Fake host: records the argv, never runs docker. */
function fakeHost(withContainers: boolean) {
  const calls: { name: string; args: string[] }[] = [];
  const children: FakeChild[] = [];
  const host = {
    platform: 'linux' as const,
    capabilities: () => (withContainers ? ['containers'] : []),
    bin: (n: string) => n,
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
    execAsync: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawn: (name: string, args: string[]) => {
      calls.push({ name, args });
      const child = new EventEmitter() as FakeChild;
      child.pid = 9000 + children.length;
      child.killed = false;
      child.kill = () => { child.killed = true; return true; };
      children.push(child);
      return child as never;
    },
    confine: (cmd: string, args: string[]) => ({ cmd, args }),
    services: {
      start: () => {}, stop: () => {}, status: () => 'stopped' as const,
      self: () => ({ status: 'running' }), selfRestart: () => {},
    },
    ...(withContainers
      // Present so the capability is seen, but the module must NEVER
      // call it: `cli` is synchronous and would block the boot.
      ? { containers: { cli: () => { throw new Error('containers.cli is synchronous: forbidden in apply()'); } } }
      : {}),
  };
  return { host, calls, children };
}

/** `withCompose: false` reproduces the shape of a package: an `installDir` under
 *  `resources/`, with no repository above, hence no `docker-compose.yml`. */
function configFor(withCompose = true): { root: string; cfg: ReturnType<typeof TimonConfigSchema.parse> } {
  const root = mkdtempSync(join(tmpdir(), 'timon-tts-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  if (withCompose) writeFileSync(join(root, 'docker-compose.yml'), 'services: {}\n');
  const cfg = TimonConfigSchema.parse({ daemon: { installDir: join(root, 'orchestrator') } });
  setConfig(cfg);
  return { root, cfg };
}

async function applyWith(host: unknown) {
  const ctx = new Context();
  await ctx.plugin(createHostPlugin(host as never));
  return ctx.plugin({ name: tts.name, inject: tts.inject, apply: tts.apply });
}

test('empty TIMON_TTS_URL + docker + compose stack: the app points at the loopback', () => {
  assert.deepEqual(tts.resolveTts(true, true), { source: 'container', url: 'http://127.0.0.1:5000' });
});

test('neither TIMON_TTS_URL nor docker: no URL, hence no voice announced to the app', () => {
  assert.deepEqual(tts.resolveTts(false, true), { source: 'none', url: null });
});

test('docker present but NO docker-compose.yml: source `none`, not `container`', () => {
  // The case of the packaged client on a machine with Docker. Concluding
  // "container" here launched compose against a missing file.
  assert.deepEqual(tts.resolveTts(true, false), { source: 'none', url: null });
  assert.deepEqual(tts.resolveTts(false, false), { source: 'none', url: null });
});

test('the presence of the stack is read on disk, outside the pure function', () => {
  const dev = configFor(true);
  assert.equal(tts.composeStackAvailable(dev.cfg), true);
  assert.equal(tts.composeFileOf(dev.root), resolve(dev.root, 'docker-compose.yml'));
  // `installDir` = `resources/orchestrator` of a package: nothing above.
  assert.equal(tts.composeStackAvailable(configFor(false).cfg), false);
});

test('TIMON_TTS_URL wins over the container, and is read from the settings registry', () => {
  // Set from the UI, not only through the environment: reading it from
  // `process.env` would silently ignore the value set by the user.
  setSetting('TIMON_TTS_URL', 'http://tts.exemple:5000');
  try {
    assert.deepEqual(tts.resolveTts(true, true), { source: 'external', url: 'http://tts.exemple:5000' });
    assert.deepEqual(tts.resolveTts(false, false), { source: 'external', url: 'http://tts.exemple:5000' });
  } finally {
    setSetting('TIMON_TTS_URL', null);
  }
  assert.equal(tts.resolveTts(true, true).source, 'container');
});

test('the compose command carries `-f`, `-p`, the docker profile and `--no-build`', () => {
  const { root, cfg } = configFor();
  assert.equal(tts.repoRootOf(cfg), root);
  // `--no-build`: the service carries a `build:`, and without an image an `up -d`
  // would build: several minutes of docker build at daemon startup,
  // that nobody asked for.
  assert.deepEqual(tts.composeArgs(root), [
    'compose',
    '-f', resolve(root, 'docker-compose.yml'),
    '-p', tts.composeProjectOf(root),
    '--profile', 'docker',
    'up', '-d', '--no-build', 'tts',
  ]);
});

test('the compose project name is DERIVED from the folder, as compose does', () => {
  // Inventing it would create a second stack next to the one already running.
  assert.equal(tts.composeProjectOf('/home/user/webdev/projects/TIMONv2'), 'timonv2');
  assert.equal(tts.composeProjectOf('/home/user/webdev/projects/acme-site'), 'acme-site');
});

test('with docker: `apply` launches ONE docker compose, through `spawn` and not `containers.cli`', async () => {
  configFor();
  const { host, calls } = fakeHost(true);
  // The fake `containers.cli` throws: if the module touched it, this test would fail.
  await applyWith(host);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'docker');
  assert.deepEqual(calls[0].args.slice(0, 1), ['compose']);
  assert.ok(calls[0].args.includes('--profile') && calls[0].args.includes('docker'));
  assert.deepEqual(calls[0].args.slice(-4), ['up', '-d', '--no-build', 'tts']);
});

test('with TIMON_TTS_URL: no docker call', async () => {
  configFor();
  setSetting('TIMON_TTS_URL', 'http://tts.exemple:5000');
  try {
    const { host, calls } = fakeHost(true);
    await applyWith(host);
    assert.deepEqual(calls, []);
  } finally {
    setSetting('TIMON_TTS_URL', null);
  }
});

test('without docker: no call, no throw', async () => {
  configFor();
  const { host, calls } = fakeHost(false);
  await applyWith(host);
  assert.deepEqual(calls, []);
});

test('package + docker installed: `apply` launches NOTHING and does not shout', async () => {
  configFor(false);
  const { host, calls } = fakeHost(true);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    await applyWith(host);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(calls, [], 'aucun docker compose contre un fichier inexistant');
  // Nothing is broken: the absence of a voice is a state, not a failure.
  assert.deepEqual(errors, []);
});

test('a failing docker is logged, not propagated, and the boot does not wait', () => {
  const { cfg } = configFor();
  const { host, children } = fakeHost(true);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    // `startContainer` returns IMMEDIATELY: docker's exit code
    // arrives later, in the listener.
    const stop = tts.startContainer(host as never, cfg);
    assert.deepEqual(errors, [], 'nothing is known yet at this stage');
    children[0].emit('exit', 1, null);
    stop();
  } finally {
    console.error = realError;
  }
  assert.ok(errors.some((e) => e.includes('missing image?')), errors.join('\n'));
  assert.equal(children[0].killed, true, 'disposer tue le child docker en vol');
});
