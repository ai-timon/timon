import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { enableEnvProxy, envProxyChanges, type EnvProxyDeps } from './env-proxy.js';

const LOOPBACK = '127.0.0.1,::1,[::1],localhost';

type Witness = EnvProxyDeps & { execs: string[][]; refreshed: number; warnings: string[] };

function deps(env: NodeJS.ProcessEnv, withExecve: boolean): Witness {
  const out: Witness = {
    env,
    execPath: '/usr/bin/node',
    execArgv: ['--max-old-space-size=512'],
    argv: ['/usr/bin/node', '/opt/timon/dist/index.js'],
    execs: [],
    refreshed: 0,
    warnings: [],
    refreshAgents: () => { out.refreshed += 1; },
    warn: (message) => { out.warnings.push(message); },
  };
  if (withExecve) out.execve = (file, args) => { out.execs.push([file, ...args]); };
  return out;
}

test('no proxy named: nothing changes', () => {
  assert.equal(envProxyChanges({ PATH: '/bin' }), null);
  const d = deps({ PATH: '/bin' }, true);
  assert.equal(enableEnvProxy(d), 'none');
  assert.deepEqual(d.env, { PATH: '/bin' });
  assert.equal(d.execs.length, 0);
});

test('a proxy without the flag: the flag and the loopback exclusions are added', () => {
  assert.deepEqual(envProxyChanges({ https_proxy: 'http://proxy:3128', NO_PROXY: 'corp.example' }), {
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: `corp.example,${LOOPBACK}`,
    no_proxy: LOOPBACK,
  });
});

test('POSIX: the daemon replaces itself once, with the same arguments and the new environment', () => {
  const d = deps({ HTTPS_PROXY: 'http://proxy:3128' }, true);
  assert.equal(enableEnvProxy(d), 'restarted');
  assert.deepEqual(d.execs, [['/usr/bin/node', '/usr/bin/node', '--max-old-space-size=512', '/opt/timon/dist/index.js']]);
  assert.equal(d.env.NODE_USE_ENV_PROXY, '1');
  assert.equal(d.env.NO_PROXY, LOOPBACK);
  // The replaced process finds the flag and the exclusions: it goes on.
  const again = deps({ ...d.env }, true);
  assert.equal(enableEnvProxy(again), 'unchanged');
  assert.equal(again.execs.length, 0);
});

test('without execve (Windows): children get the flag, the http agents are rebuilt, and a warning tells the operator', () => {
  const d = deps({ HTTP_PROXY: 'http://proxy:3128' }, false);
  assert.equal(enableEnvProxy(d), 'children-only');
  assert.equal(d.env.NODE_USE_ENV_PROXY, '1');
  assert.equal(d.refreshed, 1);
  assert.match(d.warnings[0] ?? '', /NODE_USE_ENV_PROXY=1/);
  assert.doesNotMatch(d.warnings[0] ?? '', /proxy:3128/, 'the proxy URL may carry credentials: never logged');
});

test('flag already set by the operator: no restart, only the loopback exclusions', () => {
  const d = deps({ HTTPS_PROXY: 'http://proxy:3128', NODE_USE_ENV_PROXY: '1' }, true);
  assert.equal(enableEnvProxy(d), 'adjusted');
  assert.equal(d.execs.length, 0);
  assert.equal(d.refreshed, 1);
  assert.equal(d.env.no_proxy, LOOPBACK);
});

test('an explicit NODE_USE_ENV_PROXY=0 is kept: no restart, no proxied agents', () => {
  const d = deps({ HTTPS_PROXY: 'http://proxy:3128', NODE_USE_ENV_PROXY: '0' }, true);
  assert.equal(enableEnvProxy(d), 'adjusted');
  assert.equal(d.env.NODE_USE_ENV_PROXY, '0');
  assert.equal(d.execs.length, 0);
  assert.equal(d.refreshed, 0);
});

test('a real daemon start goes through the proxy for the outside and stays direct on the loopback', {
  skip: (process.platform === 'win32' || typeof process.execve !== 'function') && 'process.execve is POSIX only',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timon-env-proxy-'));
  const proxied: string[] = [];
  const proxy = http.createServer((req, res) => { proxied.push(`${req.method} ${req.url}`); res.end('via-proxy'); });
  // fetch tunnels even plain http through CONNECT: answer it, then refuse.
  proxy.on('connect', (req, socket) => { proxied.push(`CONNECT ${req.url}`); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  const local = http.createServer((_req, res) => { res.end('direct'); });
  try {
    proxy.listen(0, '127.0.0.1');
    local.listen(0, '127.0.0.1');
    await Promise.all([once(proxy, 'listening'), once(local, 'listening')]);
    const proxyPort = (proxy.address() as AddressInfo).port;
    const localPort = (local.address() as AddressInfo).port;
    const source = await readFile(new URL('./env-proxy.ts', import.meta.url), 'utf8');
    await writeFile(join(dir, 'env-proxy.mjs'), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText);
    await writeFile(join(dir, 'entry.mjs'), [
      `import { enableEnvProxyAtBoot } from './env-proxy.mjs';`,
      `const outcome = enableEnvProxyAtBoot();`,
      `const get = (url) => new Promise((resolve) => http.get(url, { timeout: 3000 }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); }).on('error', (e) => resolve('error ' + e.code)));`,
      `import http from 'node:http';`,
      `const outside = await fetch('http://timon.invalid/x', { signal: AbortSignal.timeout(3000) }).then((r) => String(r.status), (e) => 'error ' + (e.cause?.code ?? e.name));`,
      `const loopFetch = await fetch('http://127.0.0.1:${localPort}/', { signal: AbortSignal.timeout(3000) }).then((r) => r.text(), (e) => 'error ' + (e.cause?.code ?? e.name));`,
      `const loopHttp = await get('http://127.0.0.1:${localPort}/');`,
      `const outsideHttp = await get('http://timon.invalid/y');`,
      `console.log(JSON.stringify({ outcome, flag: process.env.NODE_USE_ENV_PROXY, outside, loopFetch, loopHttp, outsideHttp }));`,
    ].join('\n'));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HTTP_PROXY: `http://127.0.0.1:${proxyPort}` };
    const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings', join(dir, 'entry.mjs')], { env, timeout: 20_000 });
    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, string>;
    // `unchanged`: the replaced process found what the first one had set.
    assert.equal(result.outcome, 'unchanged');
    assert.equal(result.flag, '1');
    assert.equal(result.loopFetch, 'direct');
    assert.equal(result.loopHttp, 'direct');
    assert.equal(result.outsideHttp, 'via-proxy');
    assert.ok(proxied.includes('CONNECT timon.invalid:80'), `fetch reached the proxy: ${proxied.join(', ')}`);
    assert.ok(!proxied.some((line) => line.includes(String(localPort))), 'the loopback never reaches the proxy');
  } finally {
    proxy.close();
    local.close();
    await rm(dir, { recursive: true, force: true });
  }
});
