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

/** `answer` may be a function of the request index, so a job's poll can change over time. */
type Answer = { status: number; body: unknown };
function run(args: string[], answerOf: Answer | ((i: number, method: string) => Answer)): Promise<{ code: number | null; stdout: string; stderr: string; seen: Seen }> {
  const seen: Seen = {};
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += String(c); });
    req.on('end', () => {
      // `seen` keeps the first request: the one that carries the body.
      if (n === 0) {
        seen.method = req.method;
        seen.url = req.url;
        seen.body = raw ? JSON.parse(raw) : undefined;
      }
      const answer = typeof answerOf === 'function' ? answerOf(n, req.method ?? '') : answerOf;
      n++;
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const env = { ...process.env, TIMON_API: `http://127.0.0.1:${port}`, TIMON_RESOURCE_GUARD_ENABLED: '0', TIMON_RETITLE_POLL_MS: '20' };
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

const progress = (status: string, processed: number, extra: Record<string, unknown> = {}) =>
  ({ ok: true, jobId: 'job-1', status, targeted: 5, processed, written: processed, skipped: 0, errored: 0, ...extra });

test('--apply with --since and --limit starts a job and follows it to the end', async () => {
  const r = await run(['--since', '2026-01-01', '--limit', '5', '--apply'], (i) => {
    if (i === 0) return { status: 202, body: { ok: true, jobId: 'job-1' } };
    if (i === 1) return { status: 200, body: progress('running', 2) };
    return { status: 200, body: progress('done', 5) };
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.seen.body, { dryRun: false, since: '2026-01-01', limit: 5 });
  assert.match(r.stdout, /catch-up started \(job job-1\)/);
  assert.match(r.stdout, /2\/5 processed: 2 written, 0 skipped, 0 failed/);
  assert.match(r.stdout, /5\/5 processed: 5 written/);
  assert.match(r.stdout, /done\n$/);
});

test('--apply reports a quota stop from the job', async () => {
  const r = await run(['--apply'], (i) => i === 0
    ? { status: 202, body: { ok: true, jobId: 'job-1' } }
    : { status: 200, body: progress('stopped_quota', 2, { errored: 1, lastError: 'the title model is out of quota' }) });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /out of quota/);
});

test('--apply while a job already runs exits with the daemon refusal', async () => {
  const r = await run(['--apply'], { status: 409, body: { error: 'backfill_running', message: 'a title catch-up is already running' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /409/);
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
