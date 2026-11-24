/**
 * `timon agent update` / `agent create` print the `reason` of a secu-4 refusal
 * on its own line (the MCP does the same through `httpCaller`): a 403 whose
 * reason sits inside raw JSON reads like a missing permission.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-agent-refusal-test-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const REASON = "permission_mode danger-full-access is above the caller's own level (auto)";

function run(args: string[], existing: boolean): Promise<{ code: number | null; stderr: string }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(existing ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(existing ? { name: 'a', backend: 'claude' } : { error: 'agent not found' }));
      return;
    }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden', reason: REASON }));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const env = { ...process.env, TIMON_API: `http://127.0.0.1:${port}`, TIMON_RESOURCE_GUARD_ENABLED: '0' };
      delete env.TIMON_API_TOKEN;
      const child = spawn(process.execPath, [TIMON, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
      child.on('error', reject);
      child.on('close', (code) => server.close(() => resolve({ code, stderr })));
    });
  });
}

test('agent update prints the reason of a refused permission mode', async () => {
  const r = await run(['agent', 'update', 'a', '--permission-mode', 'danger-full-access'], true);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes(`forbidden — ${REASON}`), r.stderr);
});

test('agent create prints it too', async () => {
  const created = await run(['agent', 'create', 'b', '--permission-mode', 'danger-full-access', '--prompt-file', fileURLToPath(import.meta.url)], false);
  assert.equal(created.code, 2);
  assert.ok(created.stderr.includes(`forbidden — ${REASON}`), created.stderr);
});
