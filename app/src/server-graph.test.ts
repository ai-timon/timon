/**
 * `server.ts` loads its WebSocket relays before Next has installed
 * `AsyncLocalStorage` on `globalThis`. If that graph pulls `next/headers`,
 * Next's request store is cached broken and every page answers 500
 * ("AsyncLocalStorage accessed in runtime where it is not available").
 * A fresh process, because the test runner's own graph is not the server's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SERVER_IMPORTS = [
  join('src', 'lib', 'ui', 'terminal-ws-proxy.ts'),
  join('src', 'lib', 'listen-hosts.ts'),
  join('src', 'lib', 'standalone-config.ts'),
  join('src', 'lib', 'ui', 'window-csp.ts'),
];

test('the custom server graph never loads next/headers at startup', () => {
  const code = [
    `for (const f of ${JSON.stringify(SERVER_IMPORTS)}) require(require('node:path').resolve(f));`,
    `const hit = Object.keys(require.cache).filter((k) => /next[\\\\/](headers|dist[\\\\/]server[\\\\/](request[\\\\/](cookies|headers)|app-render[\\\\/](async-local-storage|work-async-storage|work-unit-async-storage)))/.test(k));`,
    'process.stdout.write(JSON.stringify(hit));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', code], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  assert.deepEqual(JSON.parse(out), []);
});
