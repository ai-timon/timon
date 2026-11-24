/**
 * `timon notify`: a disabled notification centre is a logged no-op (exit 0),
 * but a refusal (403) or a server error must exit non-zero — an agent that
 * reports through it has to see the notification was not delivered.
 *
 * HTTP witness on `127.0.0.1:0`, never the daemon of the machine.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-notify-test-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));

function run(status: number, body: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const env = { ...process.env, TIMON_API: `http://127.0.0.1:${port}`, TIMON_RESOURCE_GUARD_ENABLED: '0' };
      delete env.TIMON_API_TOKEN;
      const child = spawn(process.execPath, [TIMON, 'notify', 'report', 'done'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
      child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
      child.on('error', reject);
      child.on('close', (code) => server.close(() => resolve({ code, stdout, stderr })));
    });
  });
}

test('notify exits non-zero when the token is refused (403)', async () => {
  const r = await run(403, { error: 'forbidden' });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('403'), r.stderr);
});

test('notify exits non-zero on a server error', async () => {
  const r = await run(500, { error: 'boom' });
  assert.equal(r.code, 2);
});

test('notify stays a no-op when the notification centre is switched off', async () => {
  const r = await run(404, { error: 'not found' });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('notifications module disabled'), r.stdout);
});

test('notify prints the id of the created notification', async () => {
  const r = await run(201, { notification: { id: 'n-1' } });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('notification created: n-1'), r.stdout);
});
