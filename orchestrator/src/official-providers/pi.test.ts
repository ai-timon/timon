/**
 * The official Pi provider over RPC (`official-providers/provider-pi`), run the way a third party's
 * would be: its `apply(ctx)` against the stand-in `ctx` of `@timon-ai/sdk/testing`.
 *
 * The session tests are CONTRACT tests: `__fixtures__/pi-rpc/*.jsonl` are Pi 1.4.0's own stdout,
 * recorded on the bench of 29/10/2026 (a real Pi behind a scripted OpenAI-compatible provider), with
 * a `_sent` marker where the client wrote each command. The fake peer below replays them: it waits
 * for the driver to send the command the marker names, then writes what Pi wrote next. A Pi that
 * changes its records breaks these tests when the fixtures are recorded again, not a tester's mission.
 * (`partial` of `message_update`, `agent_end.messages` and Pi's own system prompt were trimmed: the
 * driver reads none of them.)
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  BuildSpawnOpts, NativeProviderDefinition, NormalizedEvent, ProfileRuntime, SessionDriver, SessionHost, SpawnResult,
} from '../backends/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'pi-rpc');
const PLUGIN = join(HERE, '..', '..', 'official-providers', 'provider-pi');

const kit = await import('../../../packages/sdk/src/testing/index.js');
const plugin = await import('../../official-providers/provider-pi/lib/index.js') as { apply(ctx: unknown): void };
const { RpcSessionDriver } = await import('../../official-providers/provider-pi/lib/rpc-driver.js') as {
  RpcSessionDriver: new (opts: Record<string, unknown>) => SessionDriver;
};
const { parsePiModelList } = await import('../../official-providers/provider-pi/lib/models.js') as {
  parsePiModelList(output: string): Array<{ slug: string; supportedReasoningLevels?: string[] }> | null;
};

const LIST_MODELS = readFileSync(join(FIXTURES, 'list-models.txt'), 'utf8');

type Launchable = NativeProviderDefinition & { launch(spawn: BuildSpawnOpts, profile: ProfileRuntime): Promise<SpawnResult> };

function mount(binary: { version?: string; probe?: (args: readonly string[]) => { code?: number; stdout?: string; stderr?: string } } = { version: '1.4.0' }) {
  const ctx = kit.createProviderContext({ binaries: { pi: { path: '/opt/pi/bin/pi', ...binary } } });
  plugin.apply(ctx);
  process.on('exit', () => ctx.cleanup());
  return { ctx, provider: ctx.registered.providers.get('pi') as Launchable };
}

const { ctx, provider } = mount({ version: '1.4.0', probe: () => ({ stdout: LIST_MODELS }) });
const PROFILE: ProfileRuntime = { id: 'pi', cmd: 'pi', env: { PI_CODING_AGENT_DIR: '/x' }, minCliVersion: '1.4.0' };

function opts(over: Partial<BuildSpawnOpts> = {}, cfg: Partial<BuildSpawnOpts['cfg']> = {}): BuildSpawnOpts {
  return {
    agentName: 'timon.pi-test',
    systemPrompt: 'You are a Timon agent.',
    message: 'hello',
    resumeSession: null,
    cfg: { cwd: HERE, permission_mode: 'auto', ...cfg },
    missionId: `mission-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  };
}

function argAfter(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

/* ── Registration ─────────────────────────────────────────────────────── */

test('the plugin registers a coherent provider and the product\'s `pi` profile', () => {
  assert.equal(provider.id, 'pi');
  assert.deepEqual(ctx.registered.dialect('pi') !== undefined, true);
  assert.deepEqual(kit.providerRuntime.check.definitionProblems(provider), []);
  const profile = ctx.registered.productProfiles.find((p) => p.id === 'pi')!;
  assert.equal(profile.dialect, 'pi');
  assert.equal(profile.label, 'Pi');
  assert.equal(profile.brand, 'pi', 'the π mark of the app is unchanged');
  assert.equal(profile.cmd, 'pi', 'Pi itself, no adapter');
  assert.equal(profile.requiredBinary, 'pi', 'the profile vanishes where Pi is not installed');
  assert.equal(profile.minCliVersion, '1.4.0', 'the version the RPC records were verified on');
  assert.equal(profile.fallbackRank, undefined, 'Pi is never picked by the automatic fallback: its models depend on the user');
  assert.deepEqual(provider.declares?.credentialDirs, ['.pi'], 'Pi\'s sign-ins: spared for its missions, masked from the others\'');
  assert.equal(provider.transport.kind, 'stdio-persistent');
  assert.equal(provider.mcp.timon, true, 'Timon\'s tools reach Pi through the bridge extension');
  assert.deepEqual(provider.permission, { model: 'protocol', byAgent: false, appliesMode: true }, 'the bridge gates every call by the mode; the card answers what it asks');
});

test('the manifest authorizes exactly the binary and the folder the provider declares, and ships enabled', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')) as {
    timon: { id: string; provider: { binaries: Array<{ name: string }>; credentialDirs: string[] } };
  };
  assert.equal(manifest.timon.id, 'provider-pi');
  assert.deepEqual(manifest.timon.provider.binaries.map((b) => b.name), [...(provider.declares?.binary?.names ?? [])]);
  assert.deepEqual(manifest.timon.provider.credentialDirs, [...(provider.declares?.credentialDirs ?? [])]);
  const list = JSON.parse(readFileSync(join(HERE, '..', '..', 'builtin-plugins.json'), 'utf8')) as {
    plugins: Array<{ pkg: string; source: string; enabledByDefault?: boolean }>;
  };
  const entry = list.plugins.find((p) => p.pkg === '@timon-ai/provider-pi');
  assert.ok(entry, 'listed in builtin-plugins.json');
  assert.equal(entry.enabledByDefault, undefined, 'Pi is the product\'s `pi` backend: on wherever its CLI is');
  const acp = JSON.parse(readFileSync(join(HERE, '..', '..', 'official-providers', 'provider-acp', 'package.json'), 'utf8')) as {
    timon: { provider: { binaries: Array<{ name: string }>; credentialDirs: string[] } };
  };
  assert.ok(!acp.timon.provider.binaries.some((b) => b.name === 'pi-acp'), 'the pi-acp adapter is no longer needed');
  assert.ok(!acp.timon.provider.credentialDirs.includes('.pi'));
});

/* ── Launch ───────────────────────────────────────────────────────────── */

test('the launch runs `pi --mode rpc` with a session id Timon chose, and writes nothing on stdin', async () => {
  const sp = await provider.launch(opts(), PROFILE);
  assert.equal(sp.cmd, 'pi');
  assert.deepEqual(sp.args.slice(0, 2), ['--mode', 'rpc']);
  assert.match(argAfter(sp.args, '--session-id') ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(sp.initialStdin, null, 'the driver speaks first');
  assert.equal(sp.cwd, HERE);
  assert.deepEqual(sp.env, { PI_CODING_AGENT_DIR: '/x' });
  const again = await provider.launch(opts(), PROFILE);
  assert.notEqual(argAfter(again.args, '--session-id'), argAfter(sp.args, '--session-id'), 'a new mission is a new session');
});

test('a resume reopens the session by its id; an id Pi could not take opens a new one', async () => {
  const resumed = await provider.launch(opts({ resumeSession: 'fx-basic' }), PROFILE);
  assert.equal(argAfter(resumed.args, '--session-id'), 'fx-basic');
  const odd = await provider.launch(opts({ resumeSession: 'not an id!' }), PROFILE);
  assert.notEqual(argAfter(odd.args, '--session-id'), 'not an id!');
});

test('the system prompt goes out by file, never on the command line (Windows caps it at 32 767 characters)', async () => {
  const big = `PREAMBLE ${'x'.repeat(40_000)}`;
  const sp = await provider.launch(opts({ systemPrompt: big }), PROFILE);
  assert.ok(!sp.args.some((a) => a.includes('PREAMBLE')));
  const file = argAfter(sp.args, '--append-system-prompt');
  assert.ok(file && existsSync(file), '--append-system-prompt names a file');
  assert.equal(readFileSync(file, 'utf8'), big);
  const none = await provider.launch(opts({ systemPrompt: '   ' }), PROFILE);
  assert.equal(argAfter(none.args, '--append-system-prompt'), null);
});

test('model and thinking level travel as Pi documents them; an unknown level is left out', async () => {
  const sp = await provider.launch(opts({}, { model: 'anthropic/claude-sonnet-5', reasoningEffort: 'high' }), PROFILE);
  assert.equal(argAfter(sp.args, '--model'), 'anthropic/claude-sonnet-5');
  assert.equal(argAfter(sp.args, '--thinking'), 'high');
  const odd = await provider.launch(opts({}, { reasoningEffort: 'ultra' }), PROFILE);
  assert.equal(argAfter(odd.args, '--thinking'), null);
  assert.equal(argAfter(odd.args, '--model'), null);
});

test('a Pi older than the pinned version is refused with the command that updates it; an unreadable one is not', async () => {
  const old = mount({ version: '1.3.9' }).provider;
  await assert.rejects(old.launch(opts(), PROFILE), /1\.3\.9 is older than 1\.4\.0.*npm install -g @earendil-works\/pi-coding-agent/);
  const newer = mount({ version: '1.10.0' }).provider;
  await newer.launch(opts(), PROFILE);
  const unknown = mount({}).provider;
  await unknown.launch(opts(), PROFILE);
});

test('a refusal is not remembered: Pi updated after it starts at the next message, and an accepted version is read once', async () => {
  const pi = { path: '/opt/pi/bin/pi', version: '1.3.9' };
  const mounted = kit.createProviderContext({ binaries: { pi } });
  plugin.apply(mounted);
  process.on('exit', () => mounted.cleanup());
  const launchable = mounted.registered.providers.get('pi') as Launchable;
  await assert.rejects(launchable.launch(opts(), PROFILE), /1\.3\.9 is older than 1\.4\.0/);
  await assert.rejects(launchable.launch(opts(), PROFILE), /1\.3\.9 is older than 1\.4\.0/, 'still too old: read again, refused again');
  pi.version = '1.4.0';
  await launchable.launch(opts(), PROFILE);
  // Kept once accepted: a mission does not pay a `pi --version` process.
  pi.version = '1.3.9';
  await launchable.launch(opts(), PROFILE);
});

/* ── Models ───────────────────────────────────────────────────────────── */

test('the model list comes from `pi --list-models`, as `provider/model`', async () => {
  const models = await provider.models!.discover(PROFILE);
  assert.deepEqual(models, [{ slug: 'mock/mock-a' }, { slug: 'mock/mock-b' }, { slug: 'mock/mock-r', supportedReasoningLevels: ['low', 'medium', 'high'] }]);
});

test('a Pi with no provider answers an empty list; a failure or an unknown output is no answer', async () => {
  const empty = mount({ probe: () => ({ stdout: 'No models available. Use /login to log into a provider via OAuth or API key. See:\n' }) }).provider;
  assert.deepEqual(await empty.models!.discover(PROFILE), []);
  const failing = mount({ probe: () => ({ code: 1, stderr: 'boom' }) }).provider;
  await assert.rejects(failing.models!.discover(PROFILE), /exit 1/);
  const odd = mount({ probe: () => ({ stdout: 'something else entirely' }) }).provider;
  await assert.rejects(odd.models!.discover(PROFILE), /no model table/);
  assert.equal(parsePiModelList(''), null);
});

/* ── The session, replayed from Pi's own records ──────────────────────── */

type Sent = Record<string, unknown> & { type: string; id?: string };

/** Replays a recorded fixture against the driver: see the header. */
function replay(name: string) {
  const records = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const sent: Sent[] = [];
  const ids = new Map<string, string>();
  let at = 0;
  const flush = (): void => {
    while (at < records.length && !('_sent' in records[at]!)) {
      const record = { ...records[at++]! };
      if (record.type === 'response' && typeof record.id === 'string') record.id = ids.get(record.id) ?? record.id;
      stdout.write(`${JSON.stringify(record)}\n`);
    }
  };
  let pending = '';
  stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
      const command = JSON.parse(pending.slice(0, nl)) as Sent;
      pending = pending.slice(nl + 1);
      sent.push(command);
      if (command.type === 'extension_ui_response') continue;
      const marker = records[at]?._sent as Sent | undefined;
      assert.ok(marker, `the driver sent \`${command.type}\` where Pi was sent nothing`);
      assert.equal(command.type, marker.type, `command #${sent.length}`);
      for (const key of ['message', 'streamingBehavior', 'provider', 'modelId'] as const) {
        if (key in marker) assert.equal(command[key], marker[key], `${command.type}.${key}`);
      }
      ids.set(marker.id!, command.id!);
      at += 1;
      flush();
    }
  });
  flush();
  return { io: { stdin, stdout }, sent, done: () => at >= records.length };
}

function recorder() {
  const events: NormalizedEvent[] = [];
  const host: SessionHost = {
    emit: (ev) => { events.push(ev); },
    requestPermission: async () => ({ allow: false }),
  };
  return { events, host };
}

function driverFor(name: string, over: Record<string, unknown> = {}) {
  const peer = replay(name);
  const { events, host } = recorder();
  const driver = new RpcSessionDriver({
    io: peer.io, host, runtime: kit.providerRuntime, profileId: 'pi', resumeSession: null, ...over,
  });
  return { driver, peer, events };
}

type Payload = Record<string, unknown>;
const payloads = (events: NormalizedEvent[], type: string): Payload[] => events.filter((e) => e.type === type).map((e) => e.payload as Payload);
const blocks = (events: NormalizedEvent[]): Array<Record<string, unknown>> => payloads(events, 'assistant')
  .flatMap((p) => ((p.message as { content: Array<Record<string, unknown>> }).content));
const results = (events: NormalizedEvent[]): Payload[] => payloads(events, 'result');
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The driver's timers are `unref`'d (they must not hold the daemon up): a test that waits on one alone keeps the loop alive itself. */
async function keepingLoopAlive<T>(run: () => Promise<T>): Promise<T> {
  const alive = setInterval(() => undefined, 5);
  try {
    return await run();
  } finally {
    clearInterval(alive);
  }
}

test('a session: init with Pi\'s session id and model, a streamed answer, ONE result per turn with usage, cost and context', async () => {
  const { driver, peer, events } = driverFor('basic');
  const info = await driver.start();
  assert.equal(info.sessionId, 'fx-basic');
  assert.equal(info.resumed, false, 'nothing was asked to resume');
  assert.equal(info.capabilities.permissionsByAgent, true);
  assert.equal(info.capabilities.mcp, false, 'a driver opened with no bridge declares no MCP server');
  assert.equal(info.capabilities.image, false, 'the mock model takes text only');
  const init = payloads(events, 'system')[0]!;
  assert.equal(init.subtype, 'init');
  assert.equal(init.session_id, 'fx-basic');
  assert.equal(init.backend, 'pi');
  assert.equal(init.model, 'mock/mock-a');
  assert.equal(kit.providerRuntime.events.extractInitSessionId(events[0]!), 'fx-basic');

  assert.deepEqual(await driver.prompt('hello pi'), { stopReason: 'end_turn' });
  const deltas = payloads(events, 'assistant_delta').map((p) => p.text).join('');
  assert.equal(deltas, 'echo: hello pi', 'text streams as ephemeral deltas');
  assert.deepEqual(blocks(events).map((b) => b.text), ['echo: hello pi'], 'and is kept once, from `message_end`');
  const first = results(events)[0]!;
  assert.equal(first.subtype, 'success');
  assert.equal(first.result, 'echo: hello pi');
  assert.deepEqual(first.usage, { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.ok(Math.abs((first.total_cost_usd as number) - 0.000213) < 1e-9);
  assert.equal(first.context_tokens, 168);
  assert.equal(first.context_window, 100_000);

  assert.equal(await driver.setModel!('mock/mock-b'), true, 'set_model between two turns');
  assert.deepEqual(await driver.prompt('second turn'), { stopReason: 'end_turn' });
  assert.equal(results(events).length, 2);
  assert.equal(results(events)[1]!.result, 'echo: second turn');
  assert.ok(peer.done(), 'every recorded record was replayed');
  driver.close();
});

test('tool calls: the call from the message, its result from `tool_execution_end`; `bash` reads as Bash', async () => {
  const { driver, events } = driverFor('tool');
  await driver.start();
  await driver.prompt('TOOL:bash {"command":"cat a.txt"}');
  const uses = blocks(events).filter((b) => b.type === 'tool_use');
  assert.equal(uses.length, 1, 'announced once, though `tool_execution_start` repeats it');
  assert.equal(uses[0]!.name, 'Bash');
  assert.deepEqual(uses[0]!.input, { command: 'cat a.txt' });
  const toolResults = payloads(events, 'user').flatMap((p) => (p.message as { content: Array<Record<string, unknown>> }).content);
  assert.deepEqual(toolResults, [{ type: 'tool_result', tool_use_id: uses[0]!.id, content: 'hello file\n', is_error: false }]);
  const order = events.filter((e) => e.type !== 'assistant_delta' && e.type !== 'system').map((e) => e.type);
  assert.deepEqual(order, ['assistant', 'assistant', 'user', 'assistant', 'result']);
  const result = results(events)[0]!;
  assert.equal(result.result, 'TOOL RESULT SEEN: hello file\n');
  assert.equal((result.usage as Payload).input_tokens, 246, 'two LLM calls, two usages');
  driver.close();
});

test('cancel: `abort`, then the turn ends cancelled when Pi settles it — never an error', async () => {
  const { driver, peer, events } = driverFor('abort');
  await driver.start();
  const turn = driver.prompt('SLOW please');
  while (payloads(events, 'assistant_delta').length === 0) await tick();
  await driver.cancel();
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  assert.ok(peer.sent.some((c) => c.type === 'abort'));
  const result = results(events)[0]!;
  assert.equal(result.subtype, 'cancelled');
  assert.equal(result.is_error, false);
  assert.equal(result.stop_reason, 'aborted');
  driver.close();
});

test('a provider error: each retry of Pi\'s is a provider_retry, the turn fails once, with the HTTP status', async () => {
  const { driver, events } = driverFor('error');
  await driver.start();
  assert.deepEqual(await driver.prompt('ERROR500'), { stopReason: 'error' });
  const retries = payloads(events, 'provider_retry');
  assert.deepEqual(retries.map((r) => [r.attempt, r.max, r.delay_ms, r.kind]), [[1, 3, 2000, 'server'], [2, 3, 4000, 'server'], [3, 3, 8000, 'server']]);
  assert.equal(results(events).length, 1, 'the intermediate `agent_end`s close nothing');
  const result = results(events)[0]!;
  assert.equal(result.is_error, true);
  assert.equal(result.api_error_status, 500);
  assert.match(String(result.error), /mock upstream failure/);
  driver.close();
});

test('steer: the instruction is queued into the running turn, which ends once, on the new answer', async () => {
  const { driver, peer, events } = driverFor('steer');
  await driver.start();
  const turn = driver.prompt('SLOW please');
  while (payloads(events, 'assistant_delta').length === 0) await tick();
  assert.equal(await driver.steer!('change of plan'), true);
  assert.deepEqual(await turn, { stopReason: 'end_turn' });
  assert.equal(results(events).length, 1);
  assert.equal(results(events)[0]!.result, 'echo: change of plan');
  assert.ok(peer.sent.some((c) => c.type === 'prompt' && c.streamingBehavior === 'steer'));
  assert.equal(await driver.steer!('too late'), false, 'no running turn, nothing sent');
  driver.close();
});

test('reasoning becomes a thinking block, ahead of the answer; cached tokens are counted', async () => {
  const { driver, events } = driverFor('think');
  await driver.start();
  await driver.prompt('THINK about it');
  const content = blocks(events);
  assert.deepEqual(content.map((b) => b.type), ['thinking', 'text']);
  assert.equal(content[0]!.thinking, 'Let me think about this carefully.');
  assert.ok(!payloads(events, 'assistant_delta').some((d) => String(d.text).includes('think')), 'reasoning is not streamed as answer text');
  const result = results(events)[0]!;
  assert.equal((result.usage as Payload).cache_read_input_tokens, 50);
  assert.equal(result.context_window, 200_000);
  driver.close();
});

test('a resumed session reports its history, and U+2028 / U+2029 inside a record do not split it', async () => {
  const { driver, events } = driverFor('resume', { resumeSession: 'fx-basic' });
  const info = await driver.start();
  assert.equal(info.resumed, true, 'the session Timon named has messages: it was reopened');
  await driver.prompt('line sep and para sep');
  assert.deepEqual(blocks(events).map((b) => b.text), ['echo: line sep and para sep']);
  driver.close();
});

/* ── What the recordings do not show ──────────────────────────────────── */

/** A hand-driven peer: the test writes Pi's records itself. */
function manual(over: Record<string, unknown> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const sent: Sent[] = [];
  let pending = '';
  stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
      sent.push(JSON.parse(pending.slice(0, nl)) as Sent);
      pending = pending.slice(nl + 1);
    }
  });
  const { events, host } = recorder();
  const driver = new RpcSessionDriver({ io: { stdin, stdout }, host, runtime: kit.providerRuntime, profileId: 'pi', resumeSession: null, ...over });
  const write = (record: Record<string, unknown>): void => { stdout.write(`${JSON.stringify(record)}\n`); };
  const waitSent = async (type: string, n = 1): Promise<Sent> => {
    for (;;) {
      const found = sent.filter((c) => c.type === type);
      if (found.length >= n) return found[n - 1]!;
      await tick();
    }
  };
  const start = async (): Promise<void> => {
    const started = driver.start();
    const state = await waitSent('get_state');
    write({ id: state.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'm1', messageCount: 0, model: { provider: 'p', id: 'm', input: ['text', 'image'], contextWindow: 1000 } } });
    await started;
  };
  return { driver, stdin, stdout, sent, events, write, waitSent, start };
}

test('records are split on LF only, whatever the chunking, multi-byte characters included', async () => {
  const peer = manual();
  await peer.start();
  const turn = peer.driver.prompt('hi');
  const prompt = await peer.waitSent('prompt');
  const text = 'é € 🙂'; // french-ok: a multi-byte sample
  const bytes = Buffer.from([
    JSON.stringify({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } }),
    JSON.stringify({ type: 'agent_start' }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } }),
    JSON.stringify({ type: 'agent_settled', aborted: false }),
  ].join('\n') + '\n', 'utf8');
  for (let i = 0; i < bytes.length; i += 3) peer.stdout.write(bytes.subarray(i, i + 3));
  assert.deepEqual(await turn, { stopReason: 'end_turn' });
  assert.deepEqual(blocks(peer.events).map((b) => b.text), [text]);
  peer.driver.close();
});

test('images go to a model that takes them, in Pi\'s format', async () => {
  const peer = manual();
  await peer.start();
  peer.driver.prompt('look', [{ media_type: 'image/png', data: 'AAAA' }]).catch(() => undefined);
  const prompt = await peer.waitSent('prompt');
  assert.deepEqual(prompt.images, [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  peer.driver.close();
});

test('a model switch decides the next prompt\'s images: text only leaves them out, back to images sends them', async () => {
  const peer = manual();
  await peer.start();
  const settle = async (n: number): Promise<void> => {
    const prompt = await peer.waitSent('prompt', n);
    peer.write({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    peer.write({ type: 'agent_settled', aborted: false });
  };
  const switchTo = async (n: number, input: string[]): Promise<void> => {
    const switched = peer.driver.setModel!(`p/m${n}`);
    const set = await peer.waitSent('set_model', n);
    peer.write({ id: set.id, type: 'response', command: 'set_model', success: true, data: { provider: 'p', id: `m${n}`, input } });
    assert.equal(await switched, true);
  };
  await switchTo(1, ['text']);
  assert.equal(peer.driver.info?.capabilities.image, false);
  const textOnly = peer.driver.prompt('look', [{ media_type: 'image/png', data: 'AAAA' }]);
  await settle(1);
  await textOnly;
  const first = peer.sent.filter((c) => c.type === 'prompt')[0]!;
  assert.equal(first.images, undefined);
  assert.match(String(first.message), /1 image\(s\) not sent/);
  await switchTo(2, ['text', 'image']);
  assert.equal(peer.driver.info?.capabilities.image, true);
  peer.driver.prompt('look again', [{ media_type: 'image/png', data: 'BBBB' }]).catch(() => undefined);
  const second = await peer.waitSent('prompt', 2);
  assert.deepEqual(second.images, [{ type: 'image', data: 'BBBB', mimeType: 'image/png' }]);
  peer.driver.close();
});

test('an extension dialog is answered `cancelled` at once; a fire-and-forget request gets no answer', async () => {
  const peer = manual();
  await peer.start();
  peer.write({ type: 'extension_ui_request', id: 'ui-1', method: 'setStatus', statusKey: 'mcp' });
  peer.write({ type: 'extension_ui_request', id: 'ui-2', method: 'confirm', title: 'Delete?' });
  const answer = await peer.waitSent('extension_ui_response');
  assert.deepEqual(answer, { type: 'extension_ui_response', id: 'ui-2', cancelled: true });
  assert.equal(peer.sent.filter((c) => c.type === 'extension_ui_response').length, 1);
  peer.driver.close();
});

test('a prompt Pi refuses ends the turn in error; one an extension consumed ends it at once', async () => {
  const peer = manual();
  await peer.start();
  const refused = peer.driver.prompt('x');
  const p1 = await peer.waitSent('prompt');
  peer.write({ id: p1.id, type: 'response', command: 'prompt', success: false, error: 'Agent is already processing.' });
  assert.deepEqual(await refused, { stopReason: 'error' });
  assert.equal(results(peer.events)[0]!.error, 'Agent is already processing.');
  const handled = peer.driver.prompt('/timon-bridge {}');
  const p2 = await peer.waitSent('prompt', 2);
  peer.write({ id: p2.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
  assert.deepEqual(await handled, { stopReason: 'end_turn' });
  assert.equal(results(peer.events).length, 2);
  peer.driver.close();
});

test('the process going away mid-turn rejects the turn after closing it with an error result', async () => {
  const peer = manual();
  await peer.start();
  const turn = peer.driver.prompt('hi');
  const prompt = await peer.waitSent('prompt');
  peer.write({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
  peer.write({ type: 'agent_start' });
  peer.stdout.end();
  await assert.rejects(turn, /closed its output/);
  assert.equal(results(peer.events)[0]!.is_error, true);
  await assert.rejects(peer.driver.prompt('again'), /closed its output/);
});

test('an abort Pi never settles is given up on after the grace period, and the session refuses further prompts', () => keepingLoopAlive(async () => {
  const peer = manual({ cancelGraceMs: 20 });
  await peer.start();
  const turn = peer.driver.prompt('hi');
  const prompt = await peer.waitSent('prompt');
  peer.write({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
  await peer.driver.cancel();
  await peer.waitSent('abort');
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  assert.equal(results(peer.events)[0]!.subtype, 'cancelled');
  await assert.rejects(peer.driver.prompt('again'), /did not stop the cancelled turn/);
  peer.driver.close();
}));

test('a turn silent for too long is aborted, and ends in error', () => keepingLoopAlive(async () => {
  const peer = manual({ turnIdleTimeoutMs: 20 });
  await peer.start();
  const turn = peer.driver.prompt('hi');
  const prompt = await peer.waitSent('prompt');
  peer.write({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
  await peer.waitSent('abort');
  peer.write({ type: 'agent_settled', aborted: true });
  assert.deepEqual(await turn, { stopReason: 'error' });
  assert.match(String(results(peer.events)[0]!.error), /nothing for too long/);
  peer.driver.close();
}));

test('a run nobody prompted for is followed to its own result; the next prompt waits for it', async () => {
  const peer = manual();
  await peer.start();
  peer.write({ type: 'agent_start' });
  peer.write({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'on my own' }], stopReason: 'stop' } });
  const next = peer.driver.prompt('after');
  await tick();
  assert.equal(peer.sent.filter((c) => c.type === 'prompt').length, 0, 'not while Pi is busy');
  peer.write({ type: 'agent_settled', aborted: false });
  const prompt = await peer.waitSent('prompt');
  assert.equal(results(peer.events)[0]!.result, 'on my own');
  peer.write({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
  peer.write({ type: 'agent_settled', aborted: false });
  assert.deepEqual(await next, { stopReason: 'end_turn' });
  peer.driver.close();
});

test('setModel: a bare id is looked up among Pi\'s models; never during a turn', async () => {
  const peer = manual();
  await peer.start();
  const switched = peer.driver.setModel!('gpt-x');
  const list = await peer.waitSent('get_available_models');
  peer.write({ id: list.id, type: 'response', command: 'get_available_models', success: true, data: { models: [{ provider: 'openai', id: 'gpt-x' }] } });
  const set = await peer.waitSent('set_model');
  assert.deepEqual({ provider: set.provider, modelId: set.modelId }, { provider: 'openai', modelId: 'gpt-x' });
  peer.write({ id: set.id, type: 'response', command: 'set_model', success: true, data: { provider: 'openai', id: 'gpt-x', contextWindow: 4000 } });
  assert.equal(await switched, true);
  peer.driver.prompt('busy').catch(() => undefined);
  await peer.waitSent('prompt');
  assert.equal(await peer.driver.setModel!('openai/gpt-y'), false);
  peer.driver.close();
});

test('the live model switch of the runner reaches the session that holds the process\'s pipes', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const { host } = recorder();
  const spawn = opts();
  const driver = provider.codec.openSession({ io: { stdin, stdout }, spawn, host, profileId: 'pi' } as never);
  assert.equal(await provider.session.setModel!({ stdin, stdout }, 'p/m'), false, 'not started: nothing to switch');
  assert.equal(await provider.session.setModel!({ stdin: new PassThrough(), stdout }, 'p/m'), false, 'another process');
  provider.lifecycle!.dispose!(spawn.missionId);
  await assert.rejects(driver.prompt('x'), /not started|closed/);
});

/* ── The daemon's one-shots ───────────────────────────────────────────── */

const ONE_SHOT_FLAGS = ['--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve'];

test('a one-shot is confined at launch: no tool, no extension, skill, template or context file, no session kept', async () => {
  const sp = await provider.launch(opts({ oneShot: true, timonMcp: false, systemPrompt: 'Summarize.', message: 'a transcript' }, { model: 'mock/mock-a', permission_mode: 'plan' }), PROFILE);
  assert.deepEqual(sp.args.slice(0, 2), ['--mode', 'rpc']);
  for (const flag of ONE_SHOT_FLAGS) assert.ok(sp.args.includes(flag), flag);
  assert.equal(argAfter(sp.args, '--session-id'), null, 'nothing to resume, nothing to keep');
  assert.ok(!sp.args.includes('--tools'), 'no tool list: none at all');
  assert.equal(argAfter(sp.args, '--model'), 'mock/mock-a');
  assert.ok(!sp.args.some((a) => a.includes('a transcript')), 'the prompt is a `prompt` command on stdin, never an argument');
  assert.equal(sp.initialStdin, null, 'the driver speaks first');
});

test('a one-shot\'s system prompt replaces Pi\'s own, by file', async () => {
  const big = `SUMMARIZER ${'x'.repeat(40_000)}`;
  const sp = await provider.launch(opts({ oneShot: true, systemPrompt: big }), PROFILE);
  assert.equal(argAfter(sp.args, '--append-system-prompt'), null);
  const file = argAfter(sp.args, '--system-prompt');
  assert.ok(file && existsSync(file), '--system-prompt names a file');
  assert.equal(readFileSync(file, 'utf8'), big);
  assert.ok(!sp.args.some((a) => a.includes('SUMMARIZER')));
});

test('a one-shot that asks for tools (the Dreaming\'s web) gets none, and the log says so', async () => {
  const before = ctx.logs.length;
  const sp = await provider.launch(opts({ oneShot: true }, { allowed_tools: ['WebSearch', 'WebFetch'] }), PROFILE);
  assert.ok(sp.args.includes('--no-tools'));
  assert.ok(!sp.args.includes('--tools'));
  const warned = ctx.logs.slice(before).filter((l) => l.level === 'warn');
  assert.equal(warned.length, 1);
  assert.match(warned[0]!.message, /WebSearch, WebFetch.*no tool/);
});

test('a mission launch is not confined by the one-shot flags', async () => {
  const sp = await provider.launch(opts(), PROFILE);
  for (const flag of ONE_SHOT_FLAGS) assert.ok(!sp.args.includes(flag), flag);
});

test('a confined one-shot, replayed from Pi: the model is declared no tool, a call it makes up fails, the turn succeeds', async () => {
  const { driver, peer, events } = driverFor('one-shot');
  await driver.start();
  const outcome = await driver.prompt('Summarize. TOOL:bash {"command":"cat ~/.ssh/id_rsa"}');
  assert.equal(outcome.stopReason, 'end_turn');
  assert.ok(peer.done());
  const uses = blocks(events).filter((b) => b.type === 'tool_use');
  assert.equal(uses.length, 1, 'the call the model made up');
  const toolResults = payloads(events, 'user').flatMap((p) => (p.message as { content: Array<Record<string, unknown>> }).content);
  assert.deepEqual(toolResults, [{ type: 'tool_result', tool_use_id: uses[0]!.id, content: 'Tool bash not found', is_error: true }]);
  const [result] = results(events);
  assert.equal(result!.is_error, false);
  assert.equal(result!.result, 'TOOL RESULT SEEN: Tool bash not found');
  driver.close();
});

test('the daemon\'s session one-shot runs on Pi: one prompt, the answer after the last tool call, the process stopped', async () => {
  const { runSessionOneShot } = await import('../session-one-shot.js');
  const { getHost } = await import('../host/index.js');
  const host = getHost();
  const originalSpawn = host.spawn;
  const children: ChildProcessWithoutNullStreams[] = [];
  host.spawn = ((_cmd: string, _args: string[]) => {
    const child = nodeSpawn(process.execPath, [join(FIXTURES, 'fake-pi.mjs'), 'one-shot'], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    children.push(child);
    return child;
  }) as typeof host.spawn;
  let released = 0;
  try {
    const spawnOpts = opts({ oneShot: true, timonMcp: false, systemPrompt: 'Summarize.', message: 'Summarize. TOOL:bash {"command":"cat ~/.ssh/id_rsa"}' }, { permission_mode: 'plan' });
    const spec = await provider.launch(spawnOpts, PROFILE);
    const backend = { name: 'pi', openSession: provider.codec.kind === 'driver' ? provider.codec.openSession : undefined };
    const text = await runSessionOneShot({
      backend: backend as never, spawnOpts, spec, env: {}, openTimeoutMs: 5_000, timeoutMs: 10_000, release: () => { released += 1; },
    });
    assert.equal(text, 'TOOL RESULT SEEN: Tool bash not found', 'the text before the refused call is dropped');
    assert.equal(children.length, 1);
    const child = children[0]!;
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
    assert.ok(released >= 1, 'the seal and scratch folder are released');
  } finally {
    host.spawn = originalSpawn;
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }
});
