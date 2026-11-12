/**
 * What `timon` tells someone who has just installed it (`bin/cli-guide.mjs`),
 * and the two paths of the CLI that print it, run against a daemon that does
 * not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDaemonUnreachable, isLoopbackHost, listenUrl, overviewLines, unreachableLines } from '../bin/cli-guide.mjs';

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));

function refusedFetch(): Error {
  const error = new TypeError('fetch failed');
  (error as Error & { cause: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
  return error;
}

test('an unreachable daemon is told apart from a daemon that answered an error', () => {
  assert.equal(isDaemonUnreachable(refusedFetch()), true);
  assert.equal(isDaemonUnreachable(new TypeError('fetch failed')), true);
  assert.equal(isDaemonUnreachable(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), true);
  assert.equal(isDaemonUnreachable(Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } })), true);
  assert.equal(isDaemonUnreachable(new Error('agent not found')), false);
  assert.equal(isDaemonUnreachable(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isDaemonUnreachable(null), false);
});

test('the unreachable message names the next command', () => {
  const fresh = unreachableLines({ api: 'http://127.0.0.1:3010', local: true, serviceInstalled: false }).join('\n');
  assert.match(fresh, /no Timon daemon answers at http:\/\/127\.0\.0\.1:3010/);
  assert.match(fresh, /timon service install/);
  const installed = unreachableLines({ api: 'http://127.0.0.1:3010', local: true, serviceInstalled: true }).join('\n');
  assert.match(installed, /timon service status/);
  assert.match(installed, /timon doctor/);
  assert.doesNotMatch(installed, /service install/);
  const remote = unreachableLines({ api: 'https://server.example', local: false, serviceInstalled: false }).join('\n');
  assert.doesNotMatch(remote, /service/, 'a remote daemon is not installed from here');
});

test('the overview walks a new installation to its next step', () => {
  const down = overviewLines({ version: '0.2.0', api: 'http://127.0.0.1:3010', reachable: false }).join('\n');
  assert.match(down, /^Timon 0\.2\.0/);
  assert.match(down, /Daemon +not answering at http:\/\/127\.0\.0\.1:3010/);
  assert.match(down, /Next: run Timon in the background[^\n]*\n {2}timon service install/);
  assert.match(down, /All commands: timon help$/);

  const noAccount = overviewLines({
    api: 'http://127.0.0.1:3010', reachable: true, needsSetup: true, appUrl: 'http://127.0.0.1:3110', appLocalOnly: true,
  }).join('\n');
  assert.match(noAccount, /Account +not created yet/);
  assert.match(noAccount, /Web interface +http:\/\/127\.0\.0\.1:3110 \(this machine only\)/);
  assert.match(noAccount, /Next: create your account\n {2}timon init/);

  const overSsh = overviewLines({
    api: 'http://127.0.0.1:3010', reachable: true, needsSetup: false, appUrl: 'http://127.0.0.1:3110', appLocalOnly: true,
    ssh: { user: 'robin', host: 'my-server' },
  }).join('\n');
  assert.match(overSsh, /Account +created/);
  assert.match(overSsh, /ssh -N -L 3110:127\.0\.0\.1:3110 robin@my-server/);

  const ready = overviewLines({ api: 'http://127.0.0.1:3010', reachable: true, needsSetup: false }).join('\n');
  assert.doesNotMatch(ready, /\n\n\n/, 'no empty step');
});

test('listener addresses', () => {
  assert.equal(listenUrl({ host: '0.0.0.0', port: 3110 }), 'http://127.0.0.1:3110');
  assert.equal(listenUrl({ host: '::1', port: 3110 }), 'http://[::1]:3110');
  assert.equal(listenUrl({ port: 'x' }), null);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('100.64.0.1'), false);
});

test('the CLI prints the guidance instead of a bare "fetch failed"', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-cli-guide-'));
  // Nothing listens on port 9 (discard) on a test machine.
  writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: '127.0.0.1', port: 9 } } }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TIMON_HOME: home, NODE_ENV: 'test' };

  const list = spawnSync(process.execPath, [TIMON, 'list'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(list.status, 1);
  assert.match(list.stderr, /no Timon daemon answers at http:\/\/127\.0\.0\.1:9/);
  assert.match(list.stderr, /timon service install/);
  assert.doesNotMatch(list.stderr, /fetch failed/);

  mkdirSync(join(home, 'desktop-runtime'));
  writeFileSync(join(home, 'desktop-runtime', 'installed'), 'timon-orchestrator');
  const installed = spawnSync(process.execPath, [TIMON, 'list'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.match(installed.stderr, /timon service status/);

  const bare = spawnSync(process.execPath, [TIMON], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /Daemon +not answering at http:\/\/127\.0\.0\.1:9/);
  assert.match(bare.stdout, /Service +installed/);
  assert.match(bare.stdout, /All commands: timon help/);

  const help = spawnSync(process.execPath, [TIMON, '--help'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.match(help.stdout, /Timon control plane CLI/, '--help keeps the full help');
});
