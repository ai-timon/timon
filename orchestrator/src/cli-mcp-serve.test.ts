/**
 * `timon mcp serve` runs the stdio MCP server through the CLI, so an MCP
 * client started by the user gets the daemon and credential the CLI resolves
 * (config listener, daemon-token) instead of the bare server's
 * `localhost:3000`, and `--tools` narrows what it holds.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/timon', import.meta.url));

type Reply = { error?: { code: number }; result?: { isError?: boolean; tools?: Array<{ name: string }> } };
type Hit = { method: string; url: string; auth: string | undefined };

/** A fake daemon listening where a fresh home's config says it does. */
async function withHome(fn: (home: string, hits: Hit[]) => Promise<void>): Promise<void> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ task: { id: 't1' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const home = mkdtempSync(join(tmpdir(), 'timon-cli-mcp-serve-'));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: '127.0.0.1', port } } }));
  writeFileSync(join(home, 'daemon-token'), 'home-daemon-token\n');
  try {
    await fn(home, hits);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function serve(home: string, args: string[], requests: Array<Record<string, unknown>>): Promise<{ replies: Reply[]; code: number | null; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: home };
  for (const key of ['TIMON_API', 'TIMON_API_TOKEN', 'TIMON_ORCH_URL', 'TIMON_MISSION_ID', 'TIMON_TRACE_ID', 'TIMON_MCP_TOOLS']) delete env[key];
  const child = spawn(process.execPath, [CLI, 'mcp', 'serve', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies: Reply[] = [];
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += String(c); });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    replies.push(JSON.parse(line) as Reply);
    if (replies.length === requests.length) child.kill();
  });
  for (const [i, request] of requests.entries()) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...request }) + '\n');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; stderr: ${stderr}`)); }, 10_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ replies, code, stderr }); });
    child.on('error', reject);
  });
}

test('serves the daemon of the config with the home daemon-token', async () => {
  await withHome(async (home, hits) => {
    const { replies } = await serve(home, [], [
      { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { method: 'tools/call', params: { name: 'kanban_get', arguments: { id: 't1' } } },
    ]);
    assert.equal(replies[1]!.result?.isError, undefined);
    assert.deepEqual(hits, [{ method: 'GET', url: '/api/tasks/t1', auth: 'Bearer home-daemon-token' }]);
  });
});

test('--tools narrows the tools the client holds', async () => {
  await withHome(async (home, hits) => {
    const { replies } = await serve(home, ['--tools', 'kanban_get,kanban_list'], [
      { method: 'tools/list' },
      { method: 'tools/call', params: { name: 'kanban_delete', arguments: { id: 't1' } } },
    ]);
    assert.deepEqual(replies[0]!.result!.tools!.map((t) => t.name).sort(), ['kanban_get', 'kanban_list']);
    assert.equal(replies[1]!.error?.code, -32602);
    assert.deepEqual(hits, []);
  });
});

test('an invalid --tools or a stray argument is a usage error', async () => {
  await withHome(async (home, hits) => {
    for (const args of [['--tools', '*'], ['--tools', ''], ['extra']]) {
      const { code, replies } = await serve(home, args, [{ method: 'tools/list' }]);
      assert.equal(code, 64, `exit code for ${JSON.stringify(args)}`);
      assert.deepEqual(replies, []);
    }
    assert.deepEqual(hits, []);
  });
});
