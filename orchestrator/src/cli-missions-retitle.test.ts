/**
 * `timon missions retitle`: the CLI relays to `POST /api/missions/titles/backfill`,
 * dry run unless `--apply`.
 * Witness HTTP server on `127.0.0.1:0`, never the machine's daemon.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-retitle-test-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));

type Seen = { method?: string; url?: string; body?: unknown };

function run(args: string[], answer: { status: number; body: unknown }): Promise<{ code: number | null; stdout: string; stderr: string; seen: Seen }> {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += String(c); });
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.body = raw ? JSON.parse(raw) : undefined;
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const env = { ...process.env, TIMON_API: `http://127.0.0.1:${port}`, TIMON_RESOURCE_GUARD_ENABLED: '0' };
      delete env.TIMON_API_TOKEN;
      delete env.TIMON_AGENT;
      delete env.TIMON_MISSION_ID;
      const child = spawn(process.execPath, [TIMON, 'missions', 'retitle', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
      child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
      child.on('error', reject);
      child.on('close', (code) => server.close(() => resolve({ code, stdout, stderr, seen })));
    });
  });
}

test('without --apply it is a dry run and says how many calls it would cost', async () => {
  const r = await run([], { status: 200, body: { ok: true, dryRun: true, targeted: 12, calls: 12, limit: 50, ceiling: 200 } });
  assert.equal(r.code, 0);
  assert.equal(r.seen.method, 'POST');
  assert.equal(r.seen.url, '/api/missions/titles/backfill');
  assert.deepEqual(r.seen.body, { dryRun: true });
  assert.match(r.stdout, /dry run: 12 mission\(s\) would be titled, 12 model call\(s\)/);
  assert.match(r.stdout, /nothing was written; add --apply/);
});

test('--apply with --since and --limit sends dryRun false and reports the result', async () => {
  const r = await run(['--since', '2026-01-01', '--limit', '5', '--apply'], { status: 200, body: { ok: true, dryRun: false, targeted: 5, written: 3, kept: 0, failed: 2, stopped: 'quota' } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.seen.body, { dryRun: false, since: '2026-01-01', limit: 5 });
  assert.match(r.stdout, /3 title\(s\) written, 0 kept, 2 failed, out of 5 targeted/);
  assert.match(r.stdout, /out of quota/);
});

test('a relative --since becomes a timestamp and a bad --limit is refused locally', async () => {
  const before = Date.now();
  const r = await run(['--since', '7d'], { status: 200, body: { ok: true, dryRun: true, targeted: 0, calls: 0, limit: 50, ceiling: 200 } });
  const since = (r.seen.body as { since: number }).since;
  assert.ok(since <= before - 7 * 86_400_000 + 5_000 && since >= before - 7 * 86_400_000 - 60_000);
  assert.match(r.stdout, /nothing to do/);
  const bad = await run(['--limit', '0'], { status: 200, body: {} });
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /--limit must be a positive integer/);
});
