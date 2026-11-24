/**
 * `timon project list` prints one slug per line (TIM-0055: it printed
 * `[object Object]` once `GET /api/projects` returned objects instead of slugs).
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-project-list-test-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));

function run(projects: unknown[]): Promise<{ code: number | null; stdout: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ projects, workspaces: [] }));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const env = { ...process.env, TIMON_API: `http://127.0.0.1:${port}`, TIMON_RESOURCE_GUARD_ENABLED: '0' };
      delete env.TIMON_API_TOKEN;
      const child = spawn(process.execPath, [TIMON, 'project', 'list'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
      child.on('error', reject);
      child.on('close', (code) => server.close(() => resolve({ code, stdout })));
    });
  });
}

test('prints the slug of each project object, not [object Object]', async () => {
  const r = await run([{ slug: 'timon', name: 'Timon', color: '#fff' }, { slug: 'nimbus', name: 'Nimbus' }]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'timon\nnimbus\n');
});

test('still accepts a bare slug', async () => {
  const r = await run(['timon', { slug: 'nimbus' }]);
  assert.equal(r.stdout, 'timon\nnimbus\n');
});
