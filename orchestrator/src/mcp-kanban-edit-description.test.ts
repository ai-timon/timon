/**
 * `kanban_edit_description` replaces one passage of a description: a client
 * ticks a checkbox in a long brief without resending (and possibly
 * corrupting) the rest of it, the way `kanban_update` would require.
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

type Reply = { result?: { isError?: boolean; content?: Array<{ text: string }> } };

function call(base: string, args: Record<string, unknown>): Promise<Reply> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-mcp-edit-')),
    TIMON_API_TOKEN: 'test-token',
    TIMON_ORCH_URL: base,
  };
  delete env.TIMON_TRACE_ID;
  delete env.TIMON_MISSION_ID;
  delete env.TIMON_MCP_TOOLS;
  const child = spawn(process.execPath, [MCP], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 5000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => { clearTimeout(timer); child.kill(); lines.close(); resolve(JSON.parse(line) as Reply); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.end(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kanban_edit_description', arguments: args },
    }) + '\n');
  });
}

/** A daemon holding one task; records the bodies of the PUTs it receives. */
async function withTask(description: string, fn: (base: string, puts: Array<Record<string, unknown>>) => Promise<void>): Promise<void> {
  const puts: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer | string) => { raw += String(c); });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET' && req.url === '/api/tasks/t1') {
        res.end(JSON.stringify({ task: { id: 't1', description } }));
      } else if (req.method === 'PUT' && req.url === '/api/tasks/t1') {
        const body = JSON.parse(raw) as Record<string, unknown>;
        puts.push(body);
        res.end(JSON.stringify({ task: { id: 't1', ...body } }));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, puts);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('replaces the one passage and sends the whole description back', async () => {
  await withTask('Intro\n- [ ] **Approved**\nEnd', async (base, puts) => {
    const reply = await call(base, { id: 't1', old_text: '- [ ] **Approved**', new_text: '- [x] **Approved**' });
    assert.notEqual(reply.result?.isError, true, reply.result?.content?.[0]?.text);
    assert.deepEqual(puts, [{ description: 'Intro\n- [x] **Approved**\nEnd' }]);
  });
});

test('replacement patterns in new_text stay literal', async () => {
  await withTask('a END b', async (base, puts) => {
    await call(base, { id: 't1', old_text: 'END', new_text: '$& $1 $$' });
    assert.deepEqual(puts, [{ description: 'a $& $1 $$ b' }]);
  });
});

test('an absent or repeated passage changes nothing', async () => {
  await withTask('dup and dup', async (base, puts) => {
    const absent = await call(base, { id: 't1', old_text: 'nowhere', new_text: 'x' });
    assert.equal(absent.result?.isError, true);
    assert.match(absent.result!.content![0]!.text, /not found/);
    const repeated = await call(base, { id: 't1', old_text: 'dup', new_text: 'x' });
    assert.equal(repeated.result?.isError, true);
    assert.match(repeated.result!.content![0]!.text, /more than once/);
    const empty = await call(base, { id: 't1', old_text: '', new_text: 'x' });
    assert.equal(empty.result?.isError, true);
    assert.deepEqual(puts, []);
  });
});
