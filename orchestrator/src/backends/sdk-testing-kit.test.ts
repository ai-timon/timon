/**
 * The conformance bench published as `@timon-ai/sdk/testing`, tested as a
 * third party would meet it: bound to a dialect with no registry, on the two
 * published examples — and made to FAIL. A bench that cannot fail certifies
 * nothing; each mutation below breaks one promise and must be caught by the
 * check that names it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = mkdtempSync(join(tmpdir(), 'timon-sdk-testing-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

const kit = await import('../../../packages/sdk/src/testing/index.js');
const { echoDialect } = await import('../../tests/helpers/example-dialects.js') as { echoDialect: Record<string, unknown> };
const { memoryDialect } = await import('../../tests/helpers/example-dialects.js') as { memoryDialect: never };

const ECHO = readFileSync(join(import.meta.dirname, '__fixtures__', 'echo.jsonl'), 'utf8');
const exp = { transcript: ECHO, sessionId: 'echo-session-7f21c0d4', cmd: 'echo', model: 'echo-1', envKeys: ['ECHO_API_KEY'] };
const profile = { id: 'echo-llm', env: { ECHO_API_KEY: 'a-key-of-test' } };
const ctx = { cwd: TMP };

/** Runs every check; returns the names that threw, with their message. */
async function failures(dialect: unknown): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const check of kit.dialectConformance(dialect as never, profile, exp, ctx)) {
    try { await check.run(); } catch (error) { out.set(check.name, error instanceof Error ? error.message : String(error)); }
  }
  return out;
}

test('the published line example passes the whole bench, bound without any registry', async () => {
  assert.deepEqual([...(await failures(echoDialect))], []);
});

test('the published remote example passes the remote bench', async () => {
  const bind = (id: string, env: Record<string, string>) => kit.bindDialect(memoryDialect, { id, env });
  const checks = kit.dialectConformance(memoryDialect, { id: 'memory-remote' }, () => ({
    model: 'memory-1',
    scenarios: {
      normal: bind('memory-remote', {}),
      slow: bind('memory-remote-slow', { MEMORY_AGENT_DELAY_MS: '60000' }),
      failing: bind('memory-remote-failing', { MEMORY_AGENT_FAIL: 'prompt' }),
    },
  }), ctx);
  assert.ok(checks.length >= 8, 'the remote bench is not empty');
  for (const check of checks) await check.run();
});

/* ── The bench must be able to fail ─────────────────────────────────────── */

const mutations: Array<[string, Record<string, unknown>, RegExp]> = [
  ['a parseLine that throws on malformed JSON', {
    parseLine(line: string) {
      if (line.includes('"type":null') || line === 'null') throw new TypeError('cannot read type of null');
      return (echoDialect.parseLine as (l: string) => unknown)(line);
    },
  }, /never throws/],
  ['an extractSessionId that invents an id from a non-init event', {
    extractSessionId: (ev: { type: string }) => (ev.type === 'assistant' ? 'invented' : null),
  }, /session id/],
  ['an extractSessionId that returns the empty string', {
    extractSessionId: () => '',
  }, /extractSessionId/],
  ['a one-shot provider that writes follow-ups on stdin', {
    writeUserInput: (proc: { stdin: { write(s: string): void } }) => { proc.stdin.write('again\n'); },
  }, /capabilities agree/],
  ['an argv prompt ceiling above what the OS accepts', {
    maxPromptBytes: 400_000,
  }, /MAX_ARG_STRLEN/],
  ['a spawn that forgets the session id on resume', {
    async buildSpawn(opts: { resumeSession: string | null; cfg: { model?: string; cwd?: string }; systemPrompt: string; message: string }, p: { cmd: string; env: Record<string, string> }) {
      return { cmd: p.cmd, args: ['--model', opts.cfg.model ?? 'echo-1', '--system', opts.systemPrompt, opts.message], env: { ...p.env }, cwd: opts.cfg.cwd, initialStdin: null };
    },
  }, /resume id missing/],
  ['a dialect whose declarations contradict each other', {
    persistentProcess: true, finishMissionOnExit: false, sessionResumable: false,
  }, /declarations agree/],
  ['a parseLine that drops the system:init', {
    parseLine(line: string) {
      return (echoDialect.parseLine as (l: string) => Array<{ type: string }>)(line).filter((e) => e.type !== 'system');
    },
  }, /exactly one system:init|normalized vocabulary|no 'system'/],
];

/** Says the turn's last words after closing it. */
const talksAfterResult = {
  parseLine(line: string) {
    const events = (echoDialect.parseLine as (l: string) => Array<{ type: string }>)(line);
    return events.flatMap((e) => (e.type === 'result' ? [e, { type: 'assistant', payload: { message: { content: [] } } }] : [e]));
  },
};
mutations.push(['a persistent process that emits an assistant after its result', {
  ...talksAfterResult, persistentProcess: true, finishMissionOnExit: true, sessionResumable: true,
}, /no 'assistant' after its result/]);

test('a one-shot process may talk after its result: nothing outlives the turn to read it as a new one', async () => {
  const caught = await failures({ ...echoDialect, ...talksAfterResult });
  assert.equal([...caught.keys()].some((name) => /after its result/.test(name)), false);
});

for (const [label, patch, expected] of mutations) {
  test(`the bench catches ${label}`, async () => {
    const caught = await failures({ ...echoDialect, ...patch });
    const messages = [...caught].map(([name, message]) => `${name}: ${message}`);
    assert.ok(messages.some((m) => expected.test(m)), `no check named ${expected}; failures were:\n${messages.join('\n') || '(none)'}`);
  });
}

test('replaying a transcript cut in single bytes still yields the same events (multi-byte characters)', async () => {
  const provider = kit.bindDialect(echoDialect as never, profile);
  const lines = kit.transcriptLines(ECHO);
  const whole = await kit.replayTranscript(provider, lines, kit.spawnOptions(ctx, 'echo-1', null), 'whole');
  const bytes = await kit.replayTranscript(provider, lines, kit.spawnOptions(ctx, 'echo-1', null), 'bytes');
  assert.deepEqual(bytes.events, whole.events);
  assert.ok(JSON.stringify(whole.events).includes('point d\'entrée'), 'the transcript carries a multi-byte character'); // french-ok: a multi-byte sample
});

test('the fake CLI is a real executable that prints its lines and exits with its code', async () => {
  const cli = kit.createFakeCli({ dir: join(TMP, 'fake'), lines: ['{"a":1}', '{"b":2}'], exitCode: 3, stderr: 'banner\n' });
  const proc = cli.spawn();
  let out = '';
  let err = '';
  proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  proc.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
  proc.stdin.on('error', () => undefined);
  const code = await new Promise<number | null>((resolve) => proc.once('close', resolve));
  assert.equal(out, '{"a":1}\n{"b":2}\n');
  assert.equal(err, 'banner\n');
  assert.equal(code, 3);
});

test('hostile inputs are shipped as data: every non-JSON line is really not JSON', () => {
  for (const line of kit.NOT_JSON_LINES) assert.throws(() => JSON.parse(line), line);
  for (const line of kit.MALFORMED_JSON_LINES) {
    // Valid JSON of the wrong shape — except the one that is too deep to parse, which is the point of it.
    try { JSON.parse(line); } catch { assert.ok(line.startsWith('[['), line.slice(0, 40)); }
  }
});
