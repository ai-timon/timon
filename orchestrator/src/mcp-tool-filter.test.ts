/**
 * `TIMON_MCP_TOOLS` narrows the stdio MCP server: an MCP client started by the
 * user outside a mission (a desktop assistant) holds the operator's daemon
 * token, so a tool the filter leaves out must be neither listed nor reachable.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../bin/timon-mcp.mjs', import.meta.url));

type Reply = {
  error?: { code: number; message: string };
  result?: { isError?: boolean; tools?: Array<{ name: string }> };
};

type Run = { replies: Reply[]; code: number | null; stderr: string };

/** Sends the requests in order, then closes stdin and waits for the server to exit. */
function run(base: string, filter: string | undefined, requests: Array<Record<string, unknown>>): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-mcp-filter-')),
    TIMON_API_TOKEN: 'test-token',
    TIMON_ORCH_URL: base,
  };
  delete env.TIMON_TRACE_ID;
  delete env.TIMON_MISSION_ID;
  if (filter === undefined) delete env.TIMON_MCP_TOOLS;
  else env.TIMON_MCP_TOOLS = filter;
  const child = spawn(process.execPath, [MCP], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies: Reply[] = [];
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += String(c); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    replies.push(JSON.parse(line) as Reply);
    if (replies.length === requests.length) child.stdin.end();
  });
  for (const [i, request] of requests.entries()) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...request }) + '\n');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 5000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // The server keeps reading stdin: with every reply in, it is killed rather than awaited.
      resolve({ replies, code, stderr });
    });
    child.on('error', reject);
    child.stdout.on('end', () => child.kill());
  });
}

async function withDaemon(fn: (base: string, hits: string[]) => Promise<void>): Promise<void> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ task: { id: 't1' }, tasks: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('without TIMON_MCP_TOOLS every tool is listed', async () => {
  await withDaemon(async (base) => {
    const { replies } = await run(base, undefined, [{ method: 'tools/list' }]);
    const names = replies[0]!.result!.tools!.map((t) => t.name);
    assert.ok(names.includes('kanban_delete'));
    assert.ok(names.includes('agent_create'));
  });
});

test('TIMON_MCP_TOOLS lists only the named tools and families', async () => {
  await withDaemon(async (base) => {
    const { replies } = await run(base, 'kanban_get, project_todo_*', [{ method: 'tools/list' }]);
    const names = replies[0]!.result!.tools!.map((t) => t.name);
    assert.ok(names.includes('kanban_get'));
    assert.ok(names.includes('project_todo_add'));
    assert.ok(names.every((n) => n === 'kanban_get' || n.startsWith('project_todo_')), names.join(', '));
  });
});

test('a tool outside TIMON_MCP_TOOLS is refused before any daemon call', async () => {
  await withDaemon(async (base, hits) => {
    const { replies } = await run(base, 'kanban_get', [
      { method: 'tools/call', params: { name: 'kanban_delete', arguments: { id: 't1' } } },
      { method: 'tools/call', params: { name: 'kanban_get', arguments: { id: 't1' } } },
    ]);
    assert.equal(replies[0]!.error?.code, -32602);
    assert.equal(replies[1]!.result?.isError, undefined);
    assert.deepEqual(hits, ['GET /api/tasks/t1']);
  });
});

test('an invalid TIMON_MCP_TOOLS stops the server instead of widening it', async () => {
  await withDaemon(async (base, hits) => {
    for (const bad of ['*', '', ' , ', 'kanban_get,rm -rf']) {
      const { code, stderr, replies } = await run(base, bad, [{ method: 'tools/list' }]);
      assert.equal(code, 1, `exit code for ${JSON.stringify(bad)}`);
      assert.match(stderr, /TIMON_MCP_TOOLS/);
      assert.deepEqual(replies, []);
    }
    assert.deepEqual(hits, []);
  });
});
