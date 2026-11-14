/**
 * Rewind, spawn side (docs/specs/rewind.md § 8 and "Provider session cut"): the
 * rewind runs nothing and records the cut; the next turn starts on it — the
 * backend's own cut when it declares one, a fresh session seeded with the visible
 * thread otherwise, the message alone when nothing is left before the cut.
 *
 * Real launches through a witness CLI, as in `session-replay-one-shot.test.ts`.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Dialect, NormalizedEvent } from './backends/types.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { witnessCli } = await import('../tests/helpers/witness-cli.js');
// The real path: on macOS the temporary folder is a link, and a launch is judged by where it leads.
const WITNESS_CLI = witnessCli(realpathSync(tmpdir()));

const { upsertAgent, sendToAgent, killAgent, isRunning, rewindMissionTo, whileTurnPrepares, TurnInFlightError } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');

type Launch = { message: string; resume: string | null; at?: string };
const SUCCESS = { type: 'result', payload: { subtype: 'success', is_error: false, result: 'done' } };

const removals: (() => void)[] = [];
const missions: string[] = [];
after(() => {
  for (const id of missions) killAgent(id, { source: 'test' });
  for (const remove of removals) remove();
});

/** `lostAt`: a launch asked to resume at a cut point fails as the CLI does when it cannot find it. */
function backend(id: string, nativeRewind?: Dialect['nativeRewind'], lostAt = false): { agent: string; launches: Launch[] } {
  const launches: Launch[] = [];
  const dialect: Dialect = {
    defaultCmd: WITNESS_CLI, persistentProcess: false, finishMissionOnExit: false,
    sessionResumable: true, sessionStore: 'per-mission', permissionModel: 'none', rateLimitReporting: 'none', hostedConnectors: false,
    ...(nativeRewind ? { nativeRewind } : {}),
    isSessionNotFoundError: (stderr) => stderr.includes('No message found'),
    async buildSpawn(opts) {
      launches.push({ message: opts.message, resume: opts.resumeSession, ...(opts.resumeAt ? { at: opts.resumeAt } : {}) });
      const lost = lostAt && opts.resumeAt;
      return {
        cmd: WITNESS_CLI,
        args: ['-e', lost ? `process.stderr.write('No message found\\n'); process.exit(1);`
          : `console.log(JSON.stringify(${JSON.stringify(SUCCESS)}));`],
        cwd: opts.cfg.cwd, initialStdin: null,
      };
    },
    writeUserInput() {},
    parseLine(line) { return [JSON.parse(line) as NormalizedEvent]; },
    extractSessionId(event) { return (event.payload as { session_id?: string }).session_id ?? null; },
  };
  removals.push(registerDialect(`${id}-test`, id, dialect));
  removals.push(registerProfile(`${id}-test`, {
    id, dialect: id, label: id, vendor: 'Test', custom: true,
    defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
  }));
  const agent = `${id}.witness`;
  upsertAgent({ name: agent, system_prompt: 'Witness.', config: { backend: id, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' } });
  return { agent, launches };
}

const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

/** Two finished exchanges on session `old-session`; returns the user event ids. */
function chat(agent: string): { id: string; first: number; second: number } {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'first question alpha', { channel: 'chat' });
  const first = dbApi.insertEvent(id, 'user', user('first question alpha')).id;
  dbApi.insertEvent(id, 'assistant', assistant('first answer bravo'));
  dbApi.insertEvent(id, 'result', SUCCESS.payload);
  const second = dbApi.insertEvent(id, 'user', user('second question charlie')).id;
  dbApi.insertEvent(id, 'assistant', assistant('second answer delta'));
  dbApi.insertEvent(id, 'result', SUCCESS.payload);
  dbApi.setMissionSession(id, 'old-session');
  dbApi.finishMission(id, 'completed', 0);
  missions.push(id);
  return { id, first, second };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Sends a chat message and returns the launch of the turn that carried it. */
async function turn(missionId: string, launches: Launch[], message: string): Promise<Launch> {
  assert.equal(await sendToAgent(missionId, message, undefined, null, null, undefined, { replayContext: true }), 'delivered');
  await until(() => launches.some((l) => l.message.includes(message)) && !isRunning(missionId), `the turn "${message}"`);
  return launches.findLast((l) => l.message.includes(message))!;
}

const logged = (id: string) => dbApi.listEvents(id).filter((e) => e.type === 'user')
  .map((e) => (JSON.parse(e.payload) as { message: { content: string } }).message.content);

test('the rewind runs nothing and records the cut; the next turn starts a fresh session on the visible thread', async () => {
  const { agent, launches } = backend('rewind-summary');
  const { id, second } = chat(agent);

  await rewindMissionTo(id, second);
  assert.equal(launches.length, 0, 'no process at rewind time');
  assert.equal(dbApi.getMission(id)?.session_id, null, 'the cut session can no longer be resumed');
  assert.equal(dbApi.getPendingRewind(id)?.session_id, 'old-session');

  const launch = await turn(id, launches, 'new question echo');
  assert.equal(launch.resume, null);
  assert.match(launch.message, /alpha|bravo/, 'seeded with what is left before the cut');
  assert.doesNotMatch(launch.message, /charlie|delta/, 'nothing of the cut part');
  assert.equal(dbApi.getPendingRewind(id), null, 'spent');
  assert.deepEqual(logged(id), ['first question alpha', 'new question echo'], 'the thread keeps what the user wrote');
  assert.ok(launches.every((l) => l.resume !== 'old-session'));
});

test('a rewind to the first message starts a plain fresh session', async () => {
  const { agent, launches } = backend('rewind-first');
  const { id, first } = chat(agent);
  await rewindMissionTo(id, first);
  const launch = await turn(id, launches, 'start over foxtrot');
  assert.deepEqual(launch, { message: 'start over foxtrot', resume: null });
  assert.equal(dbApi.listEvents(id).filter((e) => e.type === 'context_recovery').length, 0, 'no loss to announce');
});

test('rewinding further back moves the pointer and keeps the session the conversation was spoken in', async () => {
  const { agent } = backend('rewind-twice');
  const { id, first, second } = chat(agent);
  const one = await rewindMissionTo(id, second);
  const two = await rewindMissionTo(id, first);
  assert.ok(two > one);
  assert.deepEqual(dbApi.getPendingRewind(id), { session_id: 'old-session', rewind_event_id: two });
});

test('a backend that cuts its own session resumes where it says', async () => {
  const seen: { sessionId: string; texts: string }[] = [];
  const { agent, launches } = backend('rewind-native', async (ctx) => {
    seen.push({ sessionId: ctx.sessionId, texts: ctx.events.map((e) => e.payload).join(' ') });
    return { resume: 'forked-session' };
  });
  const { id, second } = chat(agent);
  await rewindMissionTo(id, second);
  const launch = await turn(id, launches, 'native golf');
  assert.deepEqual(launch, { message: 'native golf', resume: 'forked-session' });
  assert.equal(seen[0]?.sessionId, 'old-session');
  assert.match(seen[0]!.texts, /alpha/);
  assert.doesNotMatch(seen[0]!.texts, /charlie/);
});

test('a native cut that fails falls back to summary mode, and the turn still goes through', async () => {
  const { agent, launches } = backend('rewind-native-fails', async () => { throw new Error('no such method'); });
  const { id, second } = chat(agent);
  await rewindMissionTo(id, second);
  const launch = await turn(id, launches, 'fallback hotel');
  assert.equal(launch.resume, null);
  assert.match(launch.message, /alpha|bravo/);
  assert.doesNotMatch(launch.message, /charlie|delta/);
});

test('a cut point carried by the backend reaches the launch of the next turn', async () => {
  const { agent, launches } = backend('rewind-at', async (ctx) => ({ resume: ctx.sessionId, resumeAt: 'message-uuid' }));
  const { id, second } = chat(agent);
  await rewindMissionTo(id, second);
  const launch = await turn(id, launches, 'resume at india');
  assert.deepEqual(launch, { message: 'resume at india', resume: 'old-session', at: 'message-uuid' });
});

test('a cut point the provider cannot find falls back to summary mode, and the turn still goes through', async () => {
  const { agent, launches } = backend('rewind-at-lost', async (ctx) => ({ resume: ctx.sessionId, resumeAt: 'gone-uuid' }), true);
  const { id, second } = chat(agent);
  await rewindMissionTo(id, second);
  assert.equal(await sendToAgent(id, 'lost juliet', undefined, null, null, undefined, { replayContext: true }), 'delivered');
  await until(() => launches.length === 2 && !isRunning(id), 'the summary-mode retry');
  const [first, retry] = launches;
  assert.deepEqual(first, { message: 'lost juliet', resume: 'old-session', at: 'gone-uuid' });
  assert.equal(retry!.resume, null);
  assert.equal(retry!.at, undefined);
  assert.match(retry!.message, /alpha|bravo/);
  assert.doesNotMatch(retry!.message, /charlie|delta/);
  assert.match(retry!.message, /lost juliet/);
  assert.deepEqual(logged(id), ['first question alpha', 'lost juliet'], 'the message is logged once');
});

test('no rewind while a turn is being prepared', async () => {
  const { agent } = backend('rewind-busy');
  const { id, second } = chat(agent);
  let release!: () => void;
  const held = whileTurnPrepares(id, () => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(rewindMissionTo(id, second), TurnInFlightError);
  release();
  await held;
  assert.equal(dbApi.getPendingRewind(id), null);
  assert.equal(dbApi.getMission(id)?.session_id, 'old-session', 'nothing was cut');
});
