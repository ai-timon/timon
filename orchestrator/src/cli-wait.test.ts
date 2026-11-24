/**
 * `timon wait` returns at the END OF THE TURN, and does not download the
 * transcript again on each loop iteration (card #101, 17/09/2026).
 *
 * HTTP witness on `127.0.0.1:0`, never the daemon of the machine. The server
 * replays what a persistent backend produces: `status: running` forever,
 * `turn_complete` that flips to true when the agent has finished writing.
 *
 * `node --test --import tsx src/cli-wait.test.ts`
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-wait-test-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const MISSION = 'd4d95593-d364-4181-8a31-13d425724f03';

const EVENTS = [
  { type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'premier tour' }] } } },
  { type: 'user', payload: { message: { content: 'une relance' } } },
  { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } } },
  // The stream ALSO persists its tool results as `user` events: cutting
  // on them would only return what follows the last tool.
  { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } } },
  { type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'second tour' }] } } },
  { type: 'result', payload: { subtype: 'success' } },
];

/** Mock daemon: `turnsAfter` light polls before the turn is declared over. */
function startMock(turnsAfter: number, events: unknown[] = EVENTS): Promise<{
  url: string;
  urls: string[];
  close: () => Promise<void>;
}> {
  const urls: string[] = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    urls.push(url);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.includes('view=status')) {
      polls += 1;
      // A persistent backend never leaves `running` before the idle reap.
      res.end(JSON.stringify({
        id: MISSION, status: 'running', turn_complete: polls > turnsAfter, turn_active: false,
      }));
      return;
    }
    res.end(JSON.stringify({ id: MISSION, status: 'running', events }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        urls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runTimon(args: string[], api: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, TIMON_API: api, TIMON_RESOURCE_GUARD_ENABLED: '0' };
    delete env.TIMON_API_TOKEN;
    const child = spawn(process.execPath, [TIMON, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('returns at the end of the turn, without waiting for the death of the process', async () => {
  const mock = await startMock(1);
  try {
    const r = await runTimon(['wait', MISSION, '--timeout=20'], mock.url);
    assert.equal(r.code, 0);
    // The current turn only: a pilot waiting twice on the same
    // mission must not be served the whole history again.
    assert.equal(r.stdout.trim(), 'second tour');
  } finally {
    await mock.close();
  }
});

test('the loop queries the light view, the transcript only once', async () => {
  const mock = await startMock(2);
  try {
    await runTimon(['wait', MISSION, '--timeout=20'], mock.url);
    const light = mock.urls.filter((u) => u.includes('view=status'));
    const full = mock.urls.filter((u) => !u.includes('view=status'));
    assert.equal(light.length, 3);
    assert.equal(full.length, 1, 'the transcript is only downloaded when it is printed');
  } finally {
    await mock.close();
  }
});

test('--json still returns the full mission', async () => {
  const mock = await startMock(0);
  try {
    const r = await runTimon(['wait', MISSION, '--timeout=20', '--json'], mock.url);
    const body = JSON.parse(r.stdout) as { id: string; events: unknown[] };
    assert.equal(body.id, MISSION);
    assert.equal(body.events.length, EVENTS.length);
  } finally {
    await mock.close();
  }
});

test('a turn ending on a tool returns the history rather than nothing', async () => {
  const mute = EVENTS.slice(0, 4); // no text after the last tool_result
  const mock = await startMock(1, [...mute, { type: 'result', payload: { subtype: 'success' } }]);
  try {
    const r = await runTimon(['wait', MISSION, '--timeout=20'], mock.url);
    assert.match(r.stdout, /premier tour/);
  } finally {
    await mock.close();
  }
});
