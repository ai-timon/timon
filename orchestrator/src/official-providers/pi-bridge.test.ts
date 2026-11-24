/**
 * Timon's tools inside Pi (`official-providers/provider-pi/lib/timon-bridge.js`): the extension Pi
 * loads with `-e`, its configuration on stdin (`/timon-bridge`), its own MCP client, its permission
 * gate, and the driver's handshake. The bench run against a real Pi 1.4.0 is
 * `pi-bridge-bench.test.ts` (`docs/PROGRESS.md`, volets 2 and 3).
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { LaunchSeal } from '../backends/launch-seal.js';
import { sealMissionToken } from '../backends/mission-token-seal.js';
import type {
  BuildSpawnOpts, NativeProviderDefinition, NormalizedEvent, ProfileRuntime, SessionDriver, SessionHost, SpawnResult,
} from '../backends/types.js';

type Json = Record<string, unknown>;
type StdioServer = { type: 'stdio'; name: string; command: string; args: string[]; env: Record<string, string> };
type HttpServer = { type: 'http'; name: string; url: string; headers: Record<string, string> };
type BridgeServer = StdioServer | HttpServer;
type PiContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Client = {
  start(): void;
  initialize(): Promise<void>;
  listTools(): Promise<Array<{ name: string }>>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): void;
  kill(): void;
  sessionId?: string | null;
};
type Handler = (args: string, ctx: { ui: { notify(message: string, type?: string): void } }) => Promise<void>;
type Policy = {
  mode: 'read-only' | 'ask' | 'edits' | 'bypass';
  allowTools: string[]; allowCommands: string[]; hintServers: string[]; grantTools: string[]; grantCommands: string[];
  denyTools: string[]; denyPrograms: string[]; denyCommands: string[];
};
type Verdict = { verdict: 'allow' } | { verdict: 'deny'; reason: string } | { verdict: 'ask' };
type Tool = Json & { execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ content: PiContent[] }> };
type FakePi = {
  commands: Map<string, Handler>;
  tools: Map<string, Tool>;
  handlers: Map<string, Array<(event: Json) => unknown>>;
  notes: string[];
};

const BRIDGE_PATH = fileURLToPath(new URL('../../official-providers/provider-pi/lib/timon-bridge.js', import.meta.url));
const bridge = await import('../../official-providers/provider-pi/lib/timon-bridge.js') as {
  BRIDGE_COMMAND: string;
  BRIDGE_REPORT: string;
  BRIDGE_PERMISSION: string;
  encodeBridgeConfig(servers: readonly BridgeServer[], launch: { nonce: string; policy: Policy }): string;
  decodeBridgeConfig(args: string): { nonce: string; policy: Policy; servers: BridgeServer[] };
  peekBridgeNonce(args: string): string | null;
  permissionVerdict(policy: Policy, call: { toolName: string; input: unknown; annotations?: unknown }, where: { cwd: string; home: string }): Verdict;
  shellWords(command: string): string[] | null;
  deniedCommand(policy: Policy, command: string): string | null;
  insideCwd(path: unknown, cwd: string, home: string): boolean;
  mcpToolName(server: string, tool: string, isTaken?: (name: string) => boolean): string;
  toolParameters(schema: unknown): Json;
  toPiResult(result: unknown): { content: PiContent[] };
  quoteCmdArgument(arg: string): string;
  resolveSpawn(command: string, args: string[], os?: { platform?: string; env?: Record<string, string>; isFile?: (p: string) => boolean }): { file: string; args: string[]; verbatim: boolean };
  McpStdioClient: new (server: StdioServer) => Client;
  McpHttpClient: new (server: HttpServer) => Client;
  default(pi: unknown): void;
};
const kit = await import('../../../packages/sdk/src/testing/index.js');
const plugin = await import('../../official-providers/provider-pi/lib/index.js') as { apply(ctx: unknown): void };
const { RpcSessionDriver } = await import('../../official-providers/provider-pi/lib/rpc-driver.js') as {
  RpcSessionDriver: new (opts: Record<string, unknown>) => SessionDriver;
};

const WORK = mkdtempSync(join(tmpdir(), 'timon-pi-bridge-'));
const NONCE = '0123456789abcdef0123456789abcdef';
/** The policy of a mission in `default` mode, with the product's rules as the provider writes them. */
const POLICY: Policy = {
  mode: 'ask',
  allowTools: ['mcp__timon__kanban_add'],
  allowCommands: ['timon task done:*'],
  hintServers: ['timon', 'timon_ask'],
  grantTools: [],
  grantCommands: ['git:*'],
  denyTools: [],
  denyPrograms: ['sudo'],
  denyCommands: ['rm -rf /*', 'timon service'],
};
const LAUNCH = { nonce: NONCE, policy: POLICY };
/** What Pi hands the command: everything after `/timon-bridge `. */
const argsOf = (message: string): string => message.slice(bridge.BRIDGE_COMMAND.length + 2);
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stdio MCP server that writes what it saw to a log file, one JSON line per fact. */
const FAKE_SERVER = join(WORK, 'fake-mcp.mjs');
writeFileSync(FAKE_SERVER, `
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
const note = (o) => appendFileSync(log, JSON.stringify(o) + '\\n');
note({ start: process.pid, token: process.env.TIMON_API_TOKEN ?? null, extra: process.env.EXTRA ?? null });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\\n'); i !== -1; i = buf.indexOf('\\n')) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => { note({ eof: process.pid }); process.exit(0); });
function handle(m) {
  if (m.method === undefined) { note({ answered: m.id, result: m.result ?? null, error: m.error ?? null }); return; }
  if (m.method.startsWith('notifications/')) { note({ notification: m.method, params: m.params ?? null }); return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' });
    send({ jsonrpc: '2.0', id: 'srv-2', method: 'ping' });
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    return;
  }
  if (m.method === 'tools/list') {
    const first = [
      { name: 'whoami', description: 'The token the server sees', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    ];
    const second = [{ name: 'slow' }, { name: 'crash' }, { name: 'fail' }, { name: 'picture' }];
    send({ jsonrpc: '2.0', id: m.id, result: m.params?.cursor ? { tools: second } : { tools: first, nextCursor: 'p2' } });
    return;
  }
  if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params;
    if (name === 'whoami') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'token=' + (process.env.TIMON_API_TOKEN ?? '<unset>') }] } });
    else if (name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(a) }] } });
    else if (name === 'slow') note({ slow: m.id });
    else if (name === 'crash') { process.stderr.write('boom: the fake server crashed\\n'); process.exit(3); }
    else if (name === 'fail') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'it failed' }], isError: true } });
    else if (name === 'picture') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown ' + m.method } });
}
`);

let logCount = 0;
function fakeServer(name: string, env: Record<string, string> = {}): { server: StdioServer; log: () => Json[] } {
  const file = join(WORK, `log-${name}-${(logCount += 1)}.jsonl`);
  writeFileSync(file, '');
  return {
    server: { type: 'stdio', name, command: process.execPath, args: [FAKE_SERVER, file], env },
    log: () => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json),
  };
}

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function fakePi(): FakePi & { api: unknown } {
  const pi: FakePi = { commands: new Map(), tools: new Map(), handlers: new Map(), notes: [] };
  const api = {
    registerCommand: (name: string, options: { handler: Handler }) => { pi.commands.set(name, options.handler); },
    registerTool: (tool: Tool & { name: string }) => {
      if (tool.name === 'mcp__refused__echo') throw new Error('schema refused');
      pi.tools.set(tool.name, tool);
    },
    on: (event: string, handler: (event: Json) => unknown) => { pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]); },
  };
  return { ...pi, api };
}

async function runCommand(pi: FakePi, args: string): Promise<Json> {
  const handler = pi.commands.get(bridge.BRIDGE_COMMAND)!;
  const before = pi.notes.length;
  await handler(args, { ui: { notify: (message) => { pi.notes.push(message); } } });
  const note = pi.notes.slice(before).find((n) => n.startsWith(bridge.BRIDGE_REPORT));
  assert.ok(note, 'the command ends with its report');
  return JSON.parse(note.slice(bridge.BRIDGE_REPORT.length)) as Json;
}

const shutdown = (pi: FakePi): void => { for (const h of pi.handlers.get('session_shutdown') ?? []) h({ type: 'session_shutdown', reason: 'quit' }); };

/* ── The configuration ────────────────────────────────────────────────── */

const AWKWARD = 'C:\\Users\\Jean "JP" Doe\\tok\nen \u2028 é 🙂 \\u0000'; // french-ok: an awkward multi-byte value

test('the configuration round-trips, values that would break a nested JSON string included', () => {
  const servers: BridgeServer[] = [
    { type: 'stdio', name: 'timon', command: 'node', args: ['a b', '"q"'], env: { TIMON_API_TOKEN: 'timon-seal-abc', PATHLIKE: AWKWARD } },
    { type: 'http', name: 'remote', url: 'https://mcp.example/x?y=1', headers: { Authorization: `Bearer ${AWKWARD}` } },
  ];
  const message = bridge.encodeBridgeConfig(servers, LAUNCH);
  assert.ok(message.startsWith(`/${bridge.BRIDGE_COMMAND} {`));
  assert.ok(!message.includes(JSON.stringify(AWKWARD)), 'values are not nested in the JSON head');
  assert.deepEqual(bridge.decodeBridgeConfig(argsOf(message)), { nonce: NONCE, policy: POLICY, servers });
  // What Pi does to a command's arguments may include a trim: the end marker keeps the last value whole.
  const trailing = bridge.encodeBridgeConfig([{ type: 'stdio', name: 's', command: 'c', args: [], env: { V: 'ends with spaces   ' } }], LAUNCH);
  assert.equal((bridge.decodeBridgeConfig(argsOf(trailing).trim()).servers[0] as StdioServer).env.V, 'ends with spaces   ');
});

test('a value no OS could hand a process (a NUL) is left out, never shifts the others', () => {
  const message = bridge.encodeBridgeConfig([{ type: 'stdio', name: 's', command: 'c', args: [], env: { BAD: 'a\u0000b', GOOD: 'ok' } }], LAUNCH);
  assert.deepEqual((bridge.decodeBridgeConfig(argsOf(message)).servers[0] as StdioServer).env, { GOOD: 'ok' });
});

test('a configuration the driver did not write is refused', () => {
  const head = (over: Json): string => `${JSON.stringify({ v: 2, nonce: NONCE, policy: POLICY, servers: [], ...over })}\u0000.`;
  assert.throws(() => bridge.decodeBridgeConfig('{"v":2,"servers":[]}'), /truncated/);
  assert.throws(() => bridge.decodeBridgeConfig('{"v":1,"servers":[]}\u0000.'), /unsupported/, 'the format of volet 2 is not read');
  assert.throws(() => bridge.decodeBridgeConfig(head({ servers: [{ type: 'stdio', name: 's', command: 'c', args: [], env: { A: 3 } }] })), /malformed/);
  assert.throws(() => bridge.decodeBridgeConfig(head({ servers: [{ type: 'ftp', name: 's' }] })), /malformed/);
  assert.throws(() => bridge.decodeBridgeConfig(head({ nonce: undefined })), /missing nonce/);
  assert.throws(() => bridge.decodeBridgeConfig(head({ nonce: 'short' })), /missing nonce/);
  assert.throws(() => bridge.decodeBridgeConfig(head({ policy: undefined })), /missing permission policy/, 'no policy, no tool: never a default');
  assert.throws(() => bridge.decodeBridgeConfig(head({ policy: { ...POLICY, mode: 'yolo' } })), /unknown permission mode/);
  assert.throws(() => bridge.decodeBridgeConfig(head({ policy: { ...POLICY, denyPrograms: [1] } })), /malformed permission policy/);
  assert.throws(() => bridge.decodeBridgeConfig('not json\u0000.'));
  assert.equal(bridge.peekBridgeNonce(head({ servers: 'nope' })), NONCE, 'a refused configuration is still reported under its nonce');
  assert.equal(bridge.peekBridgeNonce('not json\u0000.'), null);
});

test('through the sealed pipe, the token and a user\'s secret reach the bridge intact, escaped once by the daemon', async () => {
  const token = 'tok"en\\with\nodd';
  const seal = new LaunchSeal('m1', 'pi', null);
  const tokenRef = seal.protect(token);
  const secretRef = seal.protect(AWKWARD);
  const target = new PassThrough();
  const sealed = sealMissionToken({ stdin: target, stdout: new PassThrough() }, { TIMON_API_TOKEN: token }, seal);
  const message = bridge.encodeBridgeConfig([
    { type: 'stdio', name: 'timon', command: 'node', args: ['x'], env: { TIMON_API_TOKEN: tokenRef } },
    { type: 'http', name: 'remote', url: 'https://mcp.example', headers: { Authorization: `Bearer ${secretRef}` } },
  ], LAUNCH);
  assert.ok(!message.includes(token) && !message.includes(AWKWARD), 'the plugin writes references only');
  let wire = '';
  target.on('data', (chunk: Buffer) => { wire += chunk.toString('utf8'); });
  // Written in small pieces: a reference cut by a chunk boundary is held back, then swapped.
  const line = `${JSON.stringify({ type: 'prompt', id: 'b', message })}\n`;
  for (let i = 0; i < line.length; i += 7) sealed.io.stdin.write(line.slice(i, i + 7));
  sealed.io.stdin.end();
  await once(target, 'end');
  const record = JSON.parse(wire) as { message: string };
  const { servers } = bridge.decodeBridgeConfig(argsOf(record.message));
  assert.equal((servers[0] as StdioServer).env.TIMON_API_TOKEN, token);
  assert.equal((servers[1] as HttpServer).headers.Authorization, `Bearer ${AWKWARD}`);
});

/* ── Names, schemas, results ──────────────────────────────────────────── */

test('tools are named `mcp__<server>__<tool>` as Timon\'s prompts say, within a provider\'s 64 characters', () => {
  assert.equal(bridge.mcpToolName('timon', 'kanban_add'), 'mcp__timon__kanban_add');
  assert.equal(bridge.mcpToolName('timon-browser', 'navigate_page'), 'mcp__timon-browser__navigate_page', 'hyphens are kept');
  assert.equal(bridge.mcpToolName('my server', 'do.it'), 'mcp__my_server__do_it');
  const long = bridge.mcpToolName('server', 'x'.repeat(80));
  assert.equal(long.length, 64);
  assert.match(long, /_[0-9a-f]{8}$/);
  const taken = bridge.mcpToolName('a', 'b', (name) => name === 'mcp__a__b');
  assert.notEqual(taken, 'mcp__a__b');
  assert.ok(taken.length <= 64);
});

test('a tool\'s schema is passed as is; a missing or odd one becomes an empty object', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  assert.deepEqual(bridge.toolParameters(schema), schema);
  assert.deepEqual(bridge.toolParameters(undefined), { type: 'object', properties: {} });
  assert.deepEqual(bridge.toolParameters({ type: 'string' }), { type: 'object', properties: {} });
});

test('an MCP result becomes Pi\'s: text and images pass, the rest is described, an error is thrown', () => {
  assert.deepEqual(bridge.toPiResult({
    content: [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///x', text: 'inline' } },
      { type: 'resource', resource: { uri: 'file:///y', blob: 'BBBB', mimeType: 'image/jpeg' } },
      { type: 'resource', resource: { uri: 'file:///z', blob: 'CCCC', mimeType: 'application/pdf' } },
      { type: 'resource_link', uri: 'file:///w' },
      { type: 'audio', data: 'x', mimeType: 'audio/wav' },
    ],
  }).content, [
    { type: 'text', text: 'a' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'text', text: 'inline' },
    { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
    { type: 'text', text: '[resource file:///z (application/pdf)]' },
    { type: 'text', text: '[resource file:///w]' },
    { type: 'text', text: '[audio content not shown]' },
  ]);
  assert.deepEqual(bridge.toPiResult({ content: [], structuredContent: { n: 1 } }).content, [{ type: 'text', text: '{"n":1}' }]);
  assert.throws(() => bridge.toPiResult({ content: [{ type: 'text', text: 'nope' }], isError: true }), /nope/);
  const huge = bridge.toPiResult({ content: [{ type: 'text', text: 'x'.repeat(300_000) }] }).content[0] as { text: string };
  assert.ok(huge.text.length < 210_000);
  assert.match(huge.text, /characters cut by Timon/);
});

/* ── Windows commands (pure: checked here for every OS) ───────────────── */

test('outside Windows a command is spawned as is', () => {
  assert.deepEqual(bridge.resolveSpawn('npx', ['-y', 'pkg'], { platform: 'linux' }), { file: 'npx', args: ['-y', 'pkg'], verbatim: false });
});

test('on Windows an .exe found on PATH is spawned directly; a .cmd shim goes through cmd.exe, every argument quoted', () => {
  const env = { PATH: 'C:\\node;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  const files = new Set(['C:\\tools\\grepai.exe', 'C:\\node\\npx.cmd']);
  const isFile = (p: string): boolean => files.has(p);
  assert.deepEqual(bridge.resolveSpawn('grepai', ['mcp-serve'], { platform: 'win32', env, isFile }),
    { file: 'C:\\tools\\grepai.exe', args: ['mcp-serve'], verbatim: false });
  const npx = bridge.resolveSpawn('npx', ['-y', 'chrome-devtools-mcp@1', '--browserUrl', 'http://127.0.0.1:9222/a b&c'], { platform: 'win32', env, isFile });
  assert.equal(npx.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(npx.verbatim, true);
  assert.deepEqual(npx.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(npx.args[3]!.startsWith('"') && npx.args[3]!.endsWith('"'));
  assert.ok(npx.args[3]!.includes('a^^^ b^^^&c'), 'meta characters escaped twice for a batch shim');
  assert.equal(bridge.quoteCmdArgument('plain'), '^^^"plain^^^"');
  assert.equal(bridge.quoteCmdArgument('say "hi"\\'), '^^^"say^^^ \\^^^"hi\\^^^"\\\\^^^"');
});

test('on Windows a command found nowhere is spawned as is: Node says it could not start, cmd.exe would not', () => {
  const env = { PATH: 'C:\\node', PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  assert.deepEqual(bridge.resolveSpawn('ghost', ['--x'], { platform: 'win32', env, isFile: () => false }),
    { file: 'ghost', args: ['--x'], verbatim: false });
});

/* ── The stdio client ─────────────────────────────────────────────────── */

test('the stdio client: handshake, paged tool list, calls, the server\'s own requests answered', async () => {
  const { server, log } = fakeServer('fake', { EXTRA: 'declared' });
  const client = new bridge.McpStdioClient(server);
  client.start();
  await client.initialize();
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['whoami', 'echo', 'slow', 'crash', 'fail', 'picture']);
  assert.deepEqual(await client.callTool('echo', { text: 'hé' }), { content: [{ type: 'text', text: '{"text":"hé"}' }] }); // french-ok: a multi-byte sample
  const seen = log();
  assert.equal(seen[0]!.extra, 'declared', 'the server gets the variables Timon declared for it');
  assert.ok(seen.some((l) => l.notification === 'notifications/initialized'));
  assert.ok(seen.some((l) => l.answered === 'srv-1' && (l.error as Json | null)?.code === -32601), 'roots/list: method not found');
  assert.ok(seen.some((l) => l.answered === 'srv-2' && l.result !== null), 'ping answered');
  client.close();
  await until(() => log().some((l) => l.eof !== undefined), 'the server to see its input close');
});

test('the user\'s servers do not inherit the mission\'s token from Pi\'s environment; Timon\'s get it declared', async () => {
  const saved = process.env.TIMON_API_TOKEN;
  process.env.TIMON_API_TOKEN = 'inherited-token';
  try {
    const user = fakeServer('user');
    const own = fakeServer('timon', { TIMON_API_TOKEN: 'declared-token' });
    const a = new bridge.McpStdioClient(user.server);
    const b = new bridge.McpStdioClient(own.server);
    a.start(); b.start();
    await Promise.all([a.initialize(), b.initialize()]);
    assert.equal(user.log()[0]!.token, null);
    assert.equal(own.log()[0]!.token, 'declared-token');
    a.close(); b.close();
  } finally {
    if (saved === undefined) delete process.env.TIMON_API_TOKEN; else process.env.TIMON_API_TOKEN = saved;
  }
});

test('an aborted call is cancelled on the server; a crash rejects what was pending with its last words', async () => {
  const { server, log } = fakeServer('fake');
  const client = new bridge.McpStdioClient(server);
  client.start();
  await client.initialize();
  const controller = new AbortController();
  const slow = client.callTool('slow', {}, controller.signal);
  await until(() => log().some((l) => l.slow !== undefined), 'the slow call to arrive');
  controller.abort();
  await assert.rejects(slow, /aborted/);
  await until(() => log().some((l) => l.notification === 'notifications/cancelled'), 'the cancellation');
  await assert.rejects(client.callTool('crash', {}), /exited \(code 3\): boom: the fake server crashed/);
  await assert.rejects(client.callTool('echo', { text: 'x' }), /`fake` exited/);
});

test('a server that cannot start says so, without hanging', async () => {
  const client = new bridge.McpStdioClient({ type: 'stdio', name: 'ghost', command: join(WORK, 'does-not-exist'), args: [], env: {} });
  client.start();
  await assert.rejects(client.initialize(), /`ghost` could not start/);
  client.close();
});

/* ── The HTTP client ──────────────────────────────────────────────────── */

test('the HTTP client speaks Streamable HTTP: JSON or event-stream answers, its session, its headers', async () => {
  const seen: Array<{ method: string; headers: IncomingMessage['headers']; body: Json | null }> = [];
  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => { raw += d.toString('utf8'); });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Json : null;
      seen.push({ method: req.method ?? '', headers: req.headers, body });
      if (req.method === 'DELETE' || body?.id === undefined) { res.writeHead(202).end(); return; }
      if (body.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }));
      } else if (body.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'remote_tool' }] } })}\n\n`);
      } else if (body.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'remote ok' }] } }));
      } else {
        res.writeHead(500).end();
      }
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp?key=in-the-url`;
  const client = new bridge.McpHttpClient({ type: 'http', name: 'remote', url, headers: { Authorization: 'Bearer abc' } });
  client.start();
  await client.initialize();
  assert.deepEqual((await client.listTools()).map((t) => t.name), ['remote_tool']);
  assert.deepEqual(await client.callTool('remote_tool', {}), { content: [{ type: 'text', text: 'remote ok' }] });
  const call = seen.find((s) => s.body?.method === 'tools/call')!;
  assert.equal(call.headers.authorization, 'Bearer abc');
  assert.equal(call.headers['mcp-session-id'], 'sess-1');
  assert.equal(call.headers['mcp-protocol-version'], '2025-03-26');
  assert.match(String(call.headers.accept), /text\/event-stream/);
  assert.ok(seen.some((s) => s.body?.method === 'notifications/initialized'));
  client.close();
  await until(() => seen.some((s) => s.method === 'DELETE'), 'the session to be closed');
  http.close();
});

test('an HTTP error names the status, never the URL (a key may sit in its query string)', async () => {
  const http = createServer((_req, res) => { res.writeHead(401).end(); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp?api_key=SECRET-IN-URL`;
  const client = new bridge.McpHttpClient({ type: 'http', name: 'remote', url, headers: {} });
  const error = await client.initialize().then(() => null, (err: Error) => err);
  assert.match(String(error?.message), /`remote` answered HTTP 401/);
  assert.ok(!String(error?.message).includes('SECRET-IN-URL'));
  http.close();
});

/* ── The extension ────────────────────────────────────────────────────── */

test('the extension: one command, every tool of every server declared, calls reach the right server', async () => {
  const pi = fakePi();
  bridge.default(pi.api);
  assert.deepEqual([...pi.commands.keys()], [bridge.BRIDGE_COMMAND]);
  assert.equal(pi.tools.size, 0, 'nothing is declared, nothing is started, before the configuration arrives');
  const one = fakeServer('timon', { TIMON_API_TOKEN: 'tok-1' });
  const two = fakeServer('timon_ask');
  const ghost: StdioServer = { type: 'stdio', name: 'ghost', command: join(WORK, 'nope'), args: [], env: {} };
  const report = await runCommand(pi, argsOf(bridge.encodeBridgeConfig([one.server, ghost, two.server], LAUNCH)));
  assert.equal(report.nonce, NONCE, 'the report carries the nonce: the driver reads no other');
  const servers = report.servers as Array<{ server: string; tools: number; error?: string }>;
  assert.deepEqual(servers.map((s) => [s.server, s.tools]), [['timon', 6], ['ghost', 0], ['timon_ask', 6]]);
  assert.match(servers[1]!.error ?? '', /could not start/);
  assert.ok(pi.tools.has('mcp__timon__whoami') && pi.tools.has('mcp__timon_ask__echo'));
  const whoami = pi.tools.get('mcp__timon__whoami')!;
  assert.deepEqual(whoami.annotations, { readOnlyHint: true });
  assert.deepEqual(whoami.parameters, { type: 'object', properties: {} });
  assert.deepEqual((await whoami.execute('c1', {})).content, [{ type: 'text', text: 'token=tok-1' }]);
  assert.deepEqual((await pi.tools.get('mcp__timon_ask__picture')!.execute('c2', {})).content, [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  await assert.rejects(pi.tools.get('mcp__timon_ask__fail')!.execute('c3', {}), /it failed/);

  const again = await runCommand(pi, argsOf(bridge.encodeBridgeConfig([fakeServer('evil').server], LAUNCH)));
  assert.equal(again.error, 'already configured', 'a later `/timon-bridge` (a message that starts with it) configures nothing');
  assert.equal('nonce' in again, false, 'and is not reported under the nonce');
  assert.ok(![...pi.tools.keys()].some((name) => name.startsWith('mcp__evil__')));

  shutdown(pi);
  await until(() => one.log().some((l) => l.eof !== undefined) && two.log().some((l) => l.eof !== undefined), 'both servers to be stopped');
});

test('a tool Pi refuses to declare is skipped, its server\'s other tools are not', async () => {
  const pi = fakePi();
  bridge.default(pi.api);
  const refused = fakeServer('refused');
  const report = await runCommand(pi, argsOf(bridge.encodeBridgeConfig([refused.server], LAUNCH)));
  assert.deepEqual((report.servers as Array<{ tools: number }>)[0]!.tools, 5);
  assert.ok(!pi.tools.has('mcp__refused__echo') && pi.tools.has('mcp__refused__whoami'));
  shutdown(pi);
});

test('a configuration the bridge cannot read is reported, and starts nothing', async () => {
  const pi = fakePi();
  bridge.default(pi.api);
  const report = await runCommand(pi, `{"v":9,"nonce":"${NONCE}","servers":[]}\u0000.`);
  assert.match(String(report.error), /unsupported/);
  assert.equal(report.nonce, NONCE);
  assert.equal(pi.tools.size, 0);
});

/* ── The driver's handshake ───────────────────────────────────────────── */

type Sent = Json & { type: string; id?: string };

type BridgeLaunch = { file: string; servers: BridgeServer[]; policy: Policy };

function peer(bridgeLaunch: BridgeLaunch | null, stdin = new PassThrough(), requestPermission: SessionHost['requestPermission'] = async () => ({ allow: false })) {
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
  const events: NormalizedEvent[] = [];
  const host: SessionHost = { emit: (ev) => { events.push(ev); }, requestPermission };
  const write = (record: Json): void => { stdout.write(`${JSON.stringify(record)}\n`); };
  const waitSent = async (type: string, n = 1): Promise<Sent> => {
    for (;;) {
      const found = sent.filter((c) => c.type === type);
      if (found.length >= n) return found[n - 1]!;
      await tick();
    }
  };
  return { stdin, stdout, sent, events, host, write, waitSent, bridge: bridgeLaunch };
}

function driverOn(p: ReturnType<typeof peer>, io?: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream }, over: Json = {}): SessionDriver {
  return new RpcSessionDriver({
    io: io ?? { stdin: p.stdin, stdout: p.stdout }, host: p.host,
    runtime: kit.providerRuntime, profileId: 'pi', resumeSession: null, bridge: p.bridge, ...over,
  });
}

const FILE = join(WORK, 'scratch', 'timon-bridge.js');
const SERVERS: BridgeServer[] = [{ type: 'stdio', name: 'timon', command: 'node', args: ['timon-mcp.mjs'], env: { TIMON_API_TOKEN: 'timon-seal-0' } }];
const ourCommand = (path = FILE): Json => ({ name: bridge.BRIDGE_COMMAND, source: 'extension', sourceInfo: { path, source: 'cli', scope: 'temporary', origin: 'top-level' } });

async function answerState(p: ReturnType<typeof peer>): Promise<void> {
  const state = await p.waitSent('get_state');
  p.write({ id: state.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 's1', messageCount: 0, model: { provider: 'p', id: 'm', input: ['text'] } } });
}

test('the driver checks the command is the provider\'s file, sends the servers, and reads the bridge\'s report', async () => {
  const p = peer({ file: FILE, servers: SERVERS, policy: POLICY });
  const driver = driverOn(p);
  const started = driver.start();
  await answerState(p);
  const list = await p.waitSent('get_commands');
  p.write({ id: list.id, type: 'response', command: 'get_commands', success: true, data: { commands: [
    { name: 'mcp', source: 'extension', sourceInfo: { path: '/elsewhere/index.ts' } },
    ourCommand(join(WORK, 'scratch', '..', 'scratch', 'timon-bridge.js')),
  ] } });
  const prompt = await p.waitSent('prompt');
  const config = bridge.decodeBridgeConfig(argsOf(String(prompt.message)));
  assert.deepEqual(config.servers, SERVERS);
  assert.deepEqual(config.policy, POLICY, 'the mission\'s policy travels with the servers');
  assert.match(config.nonce, /^[0-9a-f]{32}$/, 'a nonce drawn for this session');
  p.write({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: `${bridge.BRIDGE_REPORT}${JSON.stringify({ nonce: config.nonce, servers: [{ server: 'timon', tools: 40 }] })}`, notifyType: 'info' });
  p.write({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
  const info = await started;
  assert.equal(info.capabilities.mcp, true);
  assert.equal(info.capabilities.permissionsByAgent, undefined, 'the bridge gates the tools: Timon\'s card decides');
  assert.equal(p.sent.filter((c) => c.type === 'extension_ui_response').length, 0, 'a notify needs no answer');
  driver.close();
});

for (const [label, commands, error] of [
  ['the extension did not load', [], /did not load Timon's bridge extension/],
  ['another extension registers the command', [ourCommand('/home/u/.pi/agent/extensions/timon-bridge.js')], /another Pi extension also registers/],
  ['two extensions register it', [ourCommand(), ourCommand('/x/y.js')], /another Pi extension also registers/],
  ['a prompt template has the name', [{ name: 'timon-bridge', source: 'prompt', sourceInfo: { path: FILE } }], /another Pi extension also registers/],
] as const) {
  test(`nothing is sent, the session refuses to start, when ${label} (the configuration would reach the model)`, async () => {
    const p = peer({ file: FILE, servers: SERVERS, policy: POLICY });
    const driver = driverOn(p);
    const started = driver.start();
    await answerState(p);
    const list = await p.waitSent('get_commands');
    p.write({ id: list.id, type: 'response', command: 'get_commands', success: true, data: { commands } });
    await assert.rejects(started, error);
    assert.equal(p.sent.filter((c) => c.type === 'prompt').length, 0);
  });
}

test('a configuration the bridge refused, or a command Pi did not run, fails the start; Pi\'s own error is not repeated', async () => {
  for (const outcome of ['refused', 'not-handled'] as const) {
    const p = peer({ file: FILE, servers: SERVERS, policy: POLICY });
    const driver = driverOn(p);
    const started = driver.start();
    await answerState(p);
    const list = await p.waitSent('get_commands');
    p.write({ id: list.id, type: 'response', command: 'get_commands', success: true, data: { commands: [ourCommand()] } });
    const prompt = await p.waitSent('prompt');
    if (outcome === 'refused') {
      const { nonce } = bridge.decodeBridgeConfig(argsOf(String(prompt.message)));
      p.write({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: `${bridge.BRIDGE_REPORT}{"nonce":"${nonce}","error":"unsupported configuration format"}` });
      p.write({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
      await assert.rejects(started, /refused its configuration \(unsupported configuration format\)/);
    } else {
      p.write({ id: prompt.id, type: 'response', command: 'prompt', success: false, error: `Unknown: ${String(prompt.message)}` });
      const err = await started.then(() => null, (e: Error) => e);
      assert.match(String(err?.message), /did not run the bridge command/);
      assert.ok(!String(err?.message).includes('timon-seal'), 'what Pi echoes of the command stays out of the message');
    }
  }
});

test('without a bridge, the driver asks nothing, reports no MCP, and says Pi decides its tools alone', async () => {
  const p = peer(null);
  const driver = driverOn(p);
  const started = driver.start();
  await answerState(p);
  const info = await started;
  assert.equal(info.capabilities.mcp, false);
  assert.equal(info.capabilities.permissionsByAgent, true, 'nothing gates Pi\'s tools: the UI must not promise a card');
  assert.equal(p.sent.filter((c) => c.type === 'get_commands').length, 0);
  driver.close();
});

/* ── The provider ─────────────────────────────────────────────────────── */

type Launchable = NativeProviderDefinition & { launch(spawn: BuildSpawnOpts, profile: ProfileRuntime): Promise<SpawnResult> };
const ctx = kit.createProviderContext({ binaries: { pi: { path: '/opt/pi/bin/pi', version: '1.4.0' } } });
plugin.apply(ctx);
process.on('exit', () => ctx.cleanup());
const provider = ctx.registered.providers.get('pi') as Launchable;
const PROFILE: ProfileRuntime = { id: 'pi', cmd: 'pi', env: {}, minCliVersion: '1.4.0' };
const spawnOpts = (over: Partial<BuildSpawnOpts> = {}): BuildSpawnOpts => ({
  agentName: 'timon.pi-test', systemPrompt: 'You are a Timon agent.', message: 'hello', resumeSession: null,
  cfg: { cwd: WORK, permission_mode: 'auto' }, missionId: `mission-${Math.random().toString(36).slice(2, 10)}`, ...over,
});

test('the provider declares Timon\'s servers, and launches Pi with the bridge as a file of the mission\'s own', async () => {
  assert.equal(provider.mcp.timon, true);
  const spawn = spawnOpts();
  const sp = await provider.launch(spawn, PROFILE);
  const at = sp.args.indexOf('-e');
  assert.ok(at > 0, '`-e <file>` loads the bridge');
  const file = sp.args[at + 1]!;
  assert.equal(readFileSync(file, 'utf8'), readFileSync(BRIDGE_PATH, 'utf8'), 'a copy of the package\'s file');
  assert.notEqual(file, BRIDGE_PATH, 'never the file inside the release');
  assert.ok(!sp.args.some((a) => a.includes('timon-seal-')), 'no reference on the command line');
  assert.ok(!JSON.stringify(sp.env).includes('timon-seal-'), 'nor in the environment');
  assert.equal(sp.initialStdin, null);

  const p = peer(null);
  const driver = provider.codec.kind === 'driver'
    ? provider.codec.openSession({ io: { stdin: p.stdin, stdout: p.stdout }, spawn, host: { emit: () => undefined, requestPermission: async () => ({ allow: false }) }, profileId: 'pi' })
    : null;
  const handed = (driver as unknown as { opts: { bridge: { file: string; servers: Array<{ name: string; env?: Record<string, string> }> } } }).opts.bridge;
  assert.equal(handed.file, file);
  assert.deepEqual(handed.servers.map((s) => s.name), ['timon', 'timon_ask']);
  assert.equal(handed.servers[0]!.env?.TIMON_API_TOKEN, kit.FAKE_TOKEN_REFERENCE, 'the plan\'s reference, swapped on the pipe');
  driver!.close();
});

test('a launch with Timon\'s servers turned off still loads the bridge, with no server: it gates Pi\'s tools', async () => {
  const spawn = spawnOpts({ timonMcp: false });
  const sp = await provider.launch(spawn, PROFILE);
  assert.ok(sp.args.includes('-e'));
  const p = peer(null);
  const driver = provider.codec.kind === 'driver'
    ? provider.codec.openSession({ io: { stdin: p.stdin, stdout: p.stdout }, spawn, host: { emit: () => undefined, requestPermission: async () => ({ allow: false }) }, profileId: 'pi' })
    : null;
  const handed = (driver as unknown as { opts: { bridge: BridgeLaunch } }).opts.bridge;
  assert.deepEqual(handed.servers, []);
  assert.equal(handed.policy.mode, 'edits');
  driver!.close();
});

/* ── The permission gate (volet 3) ────────────────────────────────────── */

const permissions = await import('../../official-providers/provider-pi/lib/permissions.js') as {
  piPermissionMode(mode: string | undefined): Policy['mode'];
  piGrants(rules: readonly string[] | undefined): { tools: string[]; commands: string[] };
  piRefusals(rules: readonly string[] | undefined): { tools: string[]; commands: string[] };
};

type GateCtx = {
  ui: { notify(message: string): void; confirm?(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean> };
  cwd?: string;
  hasUI?: boolean;
  signal?: AbortSignal;
};
type Gate = (event: Json, ctx: GateCtx) => Promise<{ block?: boolean; reason?: string } | undefined>;
const HOME = join(WORK, 'home');
const WHERE = { cwd: join(WORK, 'project'), home: HOME };
const policy = (over: Partial<Policy> = {}): Policy => ({ ...POLICY, ...over });
const verdict = (p: Policy, toolName: string, input: Json = {}, annotations?: Json): string => bridge.permissionVerdict(p, { toolName, input, annotations }, WHERE).verdict;

/** A bridge configured with `p`, its gate, and the dialogs it raised. */
async function gated(p: Policy, servers: BridgeServer[] = []) {
  const pi = fakePi();
  bridge.default(pi.api);
  const gate = pi.handlers.get('tool_call')![0] as unknown as Gate;
  const before = await gate({ type: 'tool_call', toolName: 'read', toolCallId: 'c0', input: { path: 'a' } }, { ui: { notify: () => undefined }, hasUI: true, cwd: WHERE.cwd });
  await runCommand(pi, argsOf(bridge.encodeBridgeConfig(servers, { nonce: NONCE, policy: p })));
  return { pi, gate, before };
}

test('the gate: before Timon configured it, no tool runs, not even a read', async () => {
  const { pi, before } = await gated(POLICY);
  assert.equal(before?.block, true);
  assert.match(String(before?.reason), /not configured/);
  shutdown(pi);
});

test('the policy follows the permission mode, as every backend does', () => {
  // Reads pass in every mode; so do the product's pre-approved tools and `timon` commands.
  for (const mode of ['read-only', 'ask', 'edits', 'bypass'] as const) {
    for (const tool of ['read', 'grep', 'find', 'ls']) assert.equal(verdict(policy({ mode }), tool), 'allow', `${mode}: ${tool}`);
    assert.equal(verdict(policy({ mode }), 'mcp__timon__kanban_add'), 'allow');
    assert.equal(verdict(policy({ mode }), 'bash', { command: 'timon task done 42 --comment "ok; done"' }), 'allow', `${mode}: a Timon command`);
  }
  // Plan: anything else is refused, without a card.
  const plan = policy({ mode: 'read-only', grantTools: ['edit'] });
  assert.equal(verdict(plan, 'edit', { path: 'src/a.ts' }), 'deny');
  assert.equal(verdict(plan, 'bash', { command: 'git status' }), 'deny', 'grants do not reach plan mode');
  assert.match((bridge.permissionVerdict(plan, { toolName: 'write', input: { path: 'x' } }, WHERE) as { reason: string }).reason, /plan mode/);
  // Default: the card, unless granted.
  assert.equal(verdict(policy(), 'edit', { path: 'src/a.ts' }), 'ask');
  assert.equal(verdict(policy(), 'bash', { command: 'make' }), 'ask');
  assert.equal(verdict(policy(), 'bash', { command: 'git commit -m "x"' }), 'allow', 'granted `git:*`');
  assert.equal(verdict(policy(), 'mcp__github__create_issue'), 'ask');
  assert.equal(verdict(policy({ grantTools: ['mcp__github__*'] }), 'mcp__github__create_issue'), 'allow');
  // acceptEdits / auto: edits inside the working directory pass, outside they ask.
  const edits = policy({ mode: 'edits' });
  assert.equal(verdict(edits, 'edit', { path: 'src/a.ts' }), 'allow');
  assert.equal(verdict(edits, 'write', { path: join(WHERE.cwd, 'new.md') }), 'allow');
  assert.equal(verdict(edits, 'write', { path: '../elsewhere.md' }), 'ask');
  assert.equal(verdict(edits, 'write', { path: '~/.bashrc' }), 'ask');
  assert.equal(verdict(edits, 'bash', { command: 'make' }), 'ask', 'a command is not an edit');
  // Bypass: nothing asked.
  assert.equal(verdict(policy({ mode: 'bypass' }), 'bash', { command: 'make && make install' }), 'allow');
  assert.equal(verdict(policy({ mode: 'bypass' }), 'mcp__github__delete_repo'), 'allow');
});

test('refusals hold in every mode, bypass included: the product\'s commands and the agent\'s disallowed tools', () => {
  for (const mode of ['read-only', 'ask', 'edits', 'bypass'] as const) {
    const p = policy({ mode, denyTools: ['write', 'mcp__github__*'] });
    for (const command of ['sudo rm x', 'make && sudo make install', 'echo $(sudo id)', 'FOO=1 sudo id', 'env sudo id', '/usr/bin/sudo id', 'rm -rf /', 'rm -rf /etc', 'timon service restart', 'timon service']) {
      assert.equal(verdict(p, 'bash', { command }), 'deny', `${mode}: ${command}`);
    }
    assert.equal(verdict(p, 'write', { path: 'src/a.ts' }), 'deny', `${mode}: a disallowed tool`);
    assert.equal(verdict(p, 'mcp__github__list'), 'deny');
  }
  assert.equal(verdict(policy(), 'bash', { command: 'timon services' }), 'ask', 'a rule without `*` is that command, not a prefix of a word');
  assert.equal(verdict(policy(), 'powershell', { command: 'sudo x' }), 'deny', 'PowerShell is a shell too');
});

test('a command matches an allow rule only when it is ONE plain command', () => {
  assert.deepEqual(bridge.shellWords('git commit -m "a b; c" --author=\'x | y\''), ['git', 'commit', '-m', 'a b; c', '--author=x | y']);
  assert.deepEqual(bridge.shellWords('git  log\t--oneline'), ['git', 'log', '--oneline']);
  for (const compound of ['git status; rm -rf x', 'git status && make', 'git log | sh', 'git log > out', 'git $(id)', 'git `id`', 'git "$HOME"', 'git log\nmake', 'git (x)', 'git "open', 'git x &']) {
    assert.equal(bridge.shellWords(compound), null, compound);
    assert.equal(verdict(policy(), 'bash', { command: compound }), 'ask', `never allowed as git: ${compound}`);
  }
  assert.equal(verdict(policy(), 'bash', { command: 'gitk' }), 'ask', 'a rule names words, not a prefix of the first one');
  assert.equal(verdict(policy({ grantCommands: ['npm test'] }), 'bash', { command: 'npm test' }), 'allow');
  assert.equal(verdict(policy({ grantCommands: ['npm test'] }), 'bash', { command: 'npm test -- --watch' }), 'ask', 'an exact rule is exact');
  assert.equal(bridge.deniedCommand(policy(), 'echo ok'), null);
});

test('an edit is inside the working directory only when its path resolves there, as Pi resolves it', () => {
  const cwd = WHERE.cwd;
  assert.equal(bridge.insideCwd('src/a.ts', cwd, HOME), true);
  assert.equal(bridge.insideCwd('@src/a.ts', cwd, HOME), true, 'Pi drops a leading @');
  assert.equal(bridge.insideCwd('.', cwd, HOME), true);
  assert.equal(bridge.insideCwd('src/../../x', cwd, HOME), false);
  assert.equal(bridge.insideCwd(join(cwd, '..', 'project-other', 'a'), cwd, HOME), false, 'a sibling sharing the prefix is outside');
  assert.equal(bridge.insideCwd('~/x', cwd, HOME), false);
  assert.equal(bridge.insideCwd('..foo/a', cwd, HOME), true, 'a name starting with two dots is still inside');
  assert.equal(bridge.insideCwd('', cwd, HOME), false);
  assert.equal(bridge.insideCwd(42, cwd, HOME), false);
});

test('the gate asks Timon under the nonce, with Pi\'s abort signal; a refusal BLOCKS the call with a reason the model reads', async () => {
  const { pi, gate } = await gated(POLICY);
  const asked: Array<{ title: string; message: Json; signal?: AbortSignal }> = [];
  let answer = false;
  const turn = new AbortController();
  const ctx: GateCtx = {
    ui: { notify: () => undefined, confirm: async (title, message, options) => { asked.push({ title, message: JSON.parse(message) as Json, ...(options?.signal ? { signal: options.signal } : {}) }); return answer; } },
    hasUI: true, cwd: WHERE.cwd, signal: turn.signal,
  };
  const call = { type: 'tool_call', toolName: 'bash', toolCallId: 'call-1', input: { command: 'make install' } };

  const refused = await gate(call, ctx);
  assert.equal(refused?.block, true, 'refused on the card: the tool does not run');
  assert.match(String(refused?.reason), /did not allow `bash`/);
  assert.equal(asked[0]!.title, `${bridge.BRIDGE_PERMISSION}${NONCE}`);
  assert.deepEqual(asked[0]!.message, { toolCallId: 'call-1', tool: 'bash', input: { command: 'make install' } });
  assert.equal(asked[0]!.signal, turn.signal, 'without Pi\'s signal a Stop during the card never completes');

  answer = true;
  assert.equal(await gate(call, ctx), undefined, 'allowed: the call runs');
  assert.equal(await gate({ ...call, toolName: 'read', input: { path: 'x' } }, ctx), undefined);
  assert.equal(asked.length, 2, 'a read asks nothing');

  answer = false;
  turn.abort();
  assert.match(String((await gate(call, ctx))?.reason), /stopped before Timon answered/);
  const noUi = await gate(call, { ...ctx, hasUI: false });
  assert.equal(noUi?.block, true, 'nowhere to ask: refused, never allowed');
  const thrown = await gate(call, { ...ctx, ui: { notify: () => undefined, confirm: async () => { throw new Error('channel gone'); } } });
  assert.equal(thrown?.block, true);
  const denied = await gate({ ...call, input: { command: 'sudo make install' } }, ctx);
  assert.match(String(denied?.reason), /never lets an agent run `sudo`/);
  shutdown(pi);
});

test('a server tool the server declares read-only passes; its other tools ask', async () => {
  const server = fakeServer('timon');
  const { pi, gate } = await gated(POLICY, [server.server]);
  let asked = 0;
  const ctx: GateCtx = { ui: { notify: () => undefined, confirm: async () => { asked += 1; return false; } }, hasUI: true, cwd: WHERE.cwd };
  assert.equal(await gate({ type: 'tool_call', toolName: 'mcp__timon__whoami', toolCallId: 'a', input: {} }, ctx), undefined);
  assert.equal(asked, 0);
  assert.equal((await gate({ type: 'tool_call', toolName: 'mcp__timon__echo', toolCallId: 'b', input: { text: 'x' } }, ctx))?.block, true);
  assert.equal(asked, 1);
  shutdown(pi);
  await until(() => server.log().some((l) => l.eof !== undefined), 'the server to stop');
});

test('a server the user added is not believed when it calls a tool read-only: it gets the card, or plan mode refuses it', async () => {
  const timon = fakeServer('timon');
  const user = fakeServer('userdb');
  for (const mode of ['ask', 'read-only'] as const) {
    const { pi, gate } = await gated(policy({ mode }), [timon.server, user.server]);
    let asked = 0;
    const ctx: GateCtx = { ui: { notify: () => undefined, confirm: async () => { asked += 1; return false; } }, hasUI: true, cwd: WHERE.cwd };
    assert.equal(await gate({ type: 'tool_call', toolName: 'mcp__timon__whoami', toolCallId: 'a', input: {} }, ctx), undefined, `${mode}: Timon's own hint`);
    const verdict = await gate({ type: 'tool_call', toolName: 'mcp__userdb__whoami', toolCallId: 'b', input: {} }, ctx);
    assert.equal(verdict?.block, true, `${mode}: the user's server says readOnlyHint, the gate does not take its word`);
    assert.equal(asked, mode === 'ask' ? 1 : 0, mode === 'ask' ? 'the card decides' : 'plan mode refuses without a card');
    if (mode === 'read-only') assert.match(String(verdict?.reason), /plan mode/);
    shutdown(pi);
  }
  await until(() => user.log().filter((l) => l.eof !== undefined).length >= 2, 'the servers to stop');
});

test('a tool of another extension is never read-only by its own word', () => {
  // `permissionVerdict` reads the hints the gate hands it; the gate hands none for a tool it did not declare.
  assert.equal(verdict(policy(), 'acme_lookup', {}, undefined), 'ask');
  assert.equal(verdict(policy({ mode: 'read-only' }), 'acme_lookup', {}, undefined), 'deny');
});

/* ── The driver's cards ───────────────────────────────────────────────── */

type Asked = { request: Parameters<SessionHost['requestPermission']>[0]; signal?: AbortSignal; answer(allow: boolean): void };

/** A driver past its handshake with the bridge, and the cards its host was asked for. */
async function bridged(over: Json = {}) {
  const asked: Asked[] = [];
  const requestPermission: SessionHost['requestPermission'] = (request, wait) => new Promise((resolve) => {
    asked.push({ request, ...(wait?.signal ? { signal: wait.signal } : {}), answer: (allow) => resolve({ allow }) });
  });
  const p = peer({ file: FILE, servers: SERVERS, policy: POLICY }, new PassThrough(), requestPermission);
  const driver = driverOn(p, undefined, over);
  const started = driver.start();
  await answerState(p);
  const list = await p.waitSent('get_commands');
  p.write({ id: list.id, type: 'response', command: 'get_commands', success: true, data: { commands: [ourCommand()] } });
  const prompt = await p.waitSent('prompt');
  const { nonce } = bridge.decodeBridgeConfig(argsOf(String(prompt.message)));
  p.write({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: `${bridge.BRIDGE_REPORT}${JSON.stringify({ nonce, servers: [] })}` });
  p.write({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
  await started;
  const confirm = (id: string, call: Json, title = `${bridge.BRIDGE_PERMISSION}${nonce}`): void => {
    p.write({ type: 'extension_ui_request', id, method: 'confirm', title, message: JSON.stringify(call) });
  };
  /** Opens a turn: its prompt answered `started`, and Pi's run begun. */
  const openTurn = async (n: number) => {
    const turn = driver.prompt('go');
    const sent = await p.waitSent('prompt', n);
    p.write({ id: sent.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    p.write({ type: 'agent_start' });
    return turn;
  };
  const answers = (): Sent[] => p.sent.filter((c) => c.type === 'extension_ui_response');
  const waitAsked = async (n: number): Promise<Asked> => { while (asked.length < n) await tick(); return asked[n - 1]!; };
  return { p, driver, nonce, asked, confirm, openTurn, answers, waitAsked };
}

const settle = (p: ReturnType<typeof peer>, aborted = false): void => {
  p.write({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: aborted ? 'aborted' : 'stop', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } });
  p.write({ type: 'agent_settled', aborted });
};

test('the bridge\'s dialog becomes the Allow/Deny card, and the card\'s answer goes back to Pi', async () => {
  const b = await bridged();
  const turn = b.openTurn(2);
  b.confirm('ui-1', { toolCallId: 'call-1', tool: 'bash', input: { command: 'make' } });
  const card = await b.waitAsked(1);
  assert.deepEqual(card.request, { toolCallId: 'call-1', tool: 'Bash', title: null, input: { command: 'make' } }, '`Bash` + command: the card and its paste button read it');
  assert.ok(card.signal && !card.signal.aborted, 'the card can be retired');
  card.answer(true);
  while (b.answers().length < 1) await tick();
  assert.deepEqual(b.answers()[0], { type: 'extension_ui_response', id: 'ui-1', confirmed: true });

  b.confirm('ui-2', { toolCallId: 'call-2', tool: 'edit', input: { path: '/etc/hosts' } });
  (await b.waitAsked(2)).answer(false);
  while (b.answers().length < 2) await tick();
  assert.deepEqual(b.answers()[1], { type: 'extension_ui_response', id: 'ui-2', confirmed: false }, 'refused on the card: Pi blocks the call');
  settle(b.p);
  assert.deepEqual(await turn, { stopReason: 'end_turn' });
  b.driver.close();
});

test('a dialog without the session\'s nonce is not a card: answered `cancelled`, nobody asked', async () => {
  const b = await bridged();
  b.confirm('ui-1', { toolCallId: 'c', tool: 'bash', input: { command: 'make' } }, `${bridge.BRIDGE_PERMISSION}${'f'.repeat(32)}`);
  b.confirm('ui-2', { toolCallId: 'c', tool: 'bash', input: { command: 'make' } }, 'Allow tool call?');
  b.p.write({ type: 'extension_ui_request', id: 'ui-3', method: 'select', title: `${bridge.BRIDGE_PERMISSION}${b.nonce}`, options: ['Yes', 'No'] });
  while (b.answers().length < 3) await tick();
  assert.deepEqual(b.answers().map((a) => [a.id, a.cancelled]), [['ui-1', true], ['ui-2', true], ['ui-3', true]]);
  assert.equal(b.asked.length, 0);
  b.driver.close();
});

test('a report from another extension, or one written outside the bridge command, is not the bridge\'s', async () => {
  for (const forged of ['no-nonce', 'wrong-nonce', 'none'] as const) {
    const p = peer({ file: FILE, servers: SERVERS, policy: POLICY });
    const driver = driverOn(p);
    const started = driver.start();
    // Before the command runs: outside the window, whatever it says.
    p.write({ type: 'extension_ui_request', id: 'early', method: 'notify', message: `${bridge.BRIDGE_REPORT}{"servers":[]}` });
    await answerState(p);
    const list = await p.waitSent('get_commands');
    p.write({ id: list.id, type: 'response', command: 'get_commands', success: true, data: { commands: [ourCommand()] } });
    const prompt = await p.waitSent('prompt');
    if (forged === 'no-nonce') p.write({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: `${bridge.BRIDGE_REPORT}{"servers":[]}` });
    if (forged === 'wrong-nonce') p.write({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: `${bridge.BRIDGE_REPORT}{"nonce":"${'e'.repeat(32)}","servers":[]}` });
    p.write({ id: prompt.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
    await assert.rejects(started, /did not report its configuration/, forged);
  }
});

test('when the turn settles, the open card is retired and Pi answered `cancelled`; a late answer is not forwarded', async () => {
  const b = await bridged();
  const turn = b.openTurn(2);
  b.confirm('ui-1', { toolCallId: 'call-1', tool: 'bash', input: { command: 'make' } });
  const card = await b.waitAsked(1);
  // Pi's abort settles its own dialog without a word, then the turn.
  settle(b.p, true);
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  assert.equal(card.signal?.aborted, true, 'the card is retired: nobody looks at it for a call that will not run');
  assert.deepEqual(b.answers(), [{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }]);
  card.answer(true);
  await tick(); await tick();
  assert.equal(b.answers().length, 1, 'the human\'s late click reaches nobody');
  b.driver.close();
});

test('a Stop retires the open card at once, and aborts the turn', async () => {
  const b = await bridged();
  const turn = b.openTurn(2);
  b.confirm('ui-1', { toolCallId: 'call-1', tool: 'bash', input: { command: 'make' } });
  const card = await b.waitAsked(1);
  await b.driver.cancel();
  assert.equal(card.signal?.aborted, true);
  const abort = await b.p.waitSent('abort');
  b.p.write({ type: 'agent_settled', aborted: true });
  b.p.write({ id: abort.id, type: 'response', command: 'abort', success: true });
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  b.driver.close();
});

test('a call Pi announces before the gate shows only once allowed; a refused one shows with its error', async () => {
  const b = await bridged();
  const turn = b.openTurn(2);
  const toolUses = (): string[] => b.p.events.filter((e) => e.type === 'assistant')
    .flatMap((e) => ((e.payload as { message: { content: Array<{ type: string; id?: string }> } }).message.content))
    .filter((c) => c.type === 'tool_use').map((c) => c.id!);
  b.p.write({ type: 'tool_execution_start', toolCallId: 'p/1', toolName: 'bash', args: { command: 'make' } });
  b.confirm('ui-1', { toolCallId: 'p/1', tool: 'bash', input: { command: 'make' } });
  const card = await b.waitAsked(1);
  assert.deepEqual(toolUses(), [], 'not shown as started while the card is open');
  card.answer(true);
  while (toolUses().length < 1) await tick();
  assert.deepEqual(toolUses(), ['p/1']);

  b.p.write({ type: 'tool_execution_start', toolCallId: 'p/2', toolName: 'bash', args: { command: 'rm x' } });
  b.confirm('ui-2', { toolCallId: 'p/2', tool: 'bash', input: { command: 'rm x' } });
  (await b.waitAsked(2)).answer(false);
  while (b.answers().length < 2) await tick();
  assert.deepEqual(toolUses(), ['p/1'], 'refused: never shown as started');
  b.p.write({ type: 'tool_execution_end', toolCallId: 'p/2', toolName: 'bash', args: { command: 'rm x' }, result: { content: [{ type: 'text', text: 'Timon did not allow `bash`' }] }, isError: true });
  settle(b.p);
  await turn;
  assert.deepEqual(toolUses(), ['p/1', 'p/2'], 'its end shows the call with its refusal');
  const results = b.p.events.filter((e) => e.type === 'user').map((e) => JSON.stringify(e.payload));
  assert.ok(results.some((r) => r.includes('did not allow') && r.includes('"is_error":true')));
  b.driver.close();
});

test('a card past its ceiling is refused and retired; the turn\'s silence timer waits for the human', async () => {
  const alive = setInterval(() => undefined, 5);
  try {
    // The ceiling stays far above the 60 ms sleep: at 80 ms, a loaded machine overslept it, the card was already
    // retired and the silence timer had sent its abort (TODO #605).
    const b = await bridged({ permissionWaitMs: 2_000, turnIdleTimeoutMs: 30 });
    const turn = b.openTurn(2);
    b.confirm('ui-1', { toolCallId: 'call-1', tool: 'bash', input: { command: 'make' } });
    const card = await b.waitAsked(1);
    await sleep(60);
    assert.equal(b.p.sent.filter((c) => c.type === 'abort').length, 0, 'a card open is not Pi being silent');
    while (b.answers().length < 1) await sleep(5);
    assert.deepEqual(b.answers()[0], { type: 'extension_ui_response', id: 'ui-1', confirmed: false });
    assert.equal(card.signal?.aborted, true, 'the card goes with the refusal');
    settle(b.p);
    await turn;
    b.driver.close();
  } finally {
    clearInterval(alive);
  }
});

/* ── The provider's policy ────────────────────────────────────────────── */

test('the provider routes Pi\'s permissions to Timon\'s card', () => {
  assert.deepEqual(provider.permission, { model: 'protocol', byAgent: false, appliesMode: true });
  // The agent is told its mode holds, and how a refusal reads (the preamble's backend block).
  assert.match(String(provider.declares?.permissionsHint), /permission_mode[\s\S]*Timon did not allow/);
});

test('Timon\'s permission modes map onto the bridge\'s four', () => {
  assert.equal(permissions.piPermissionMode('plan'), 'read-only');
  assert.equal(permissions.piPermissionMode('read-only'), 'read-only');
  assert.equal(permissions.piPermissionMode('default'), 'ask');
  assert.equal(permissions.piPermissionMode(undefined), 'ask');
  assert.equal(permissions.piPermissionMode('something-new'), 'ask', 'an unknown mode asks, never allows');
  assert.equal(permissions.piPermissionMode('acceptEdits'), 'edits');
  assert.equal(permissions.piPermissionMode('auto'), 'edits');
  assert.equal(permissions.piPermissionMode('bypassPermissions'), 'bypass');
  assert.equal(permissions.piPermissionMode('danger-full-access'), 'bypass');
});

test('the agent\'s grants and refusals, in Claude Code\'s syntax, become Pi\'s; what has no faithful translation is left out', () => {
  assert.deepEqual(permissions.piGrants(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'Bash(git:*)', 'Bash(npm run *)', 'Bash(npx tsc --noEmit)', 'mcp__github', 'mcp__timon__mission_spawn', 'Edit(src/**)', 'Bash(rm *x*)', 'WebFetch']), {
    tools: ['edit', 'write', 'mcp__github__*', 'mcp__timon__mission_spawn'],
    commands: ['git:*', 'npm run:*', 'npx tsc --noEmit'],
  });
  assert.deepEqual(permissions.piGrants(['Bash']).tools, ['bash', 'powershell']);
  assert.deepEqual(permissions.piRefusals(['Bash(git push:*)', 'Bash(curl *example*)', 'Bash(rm -rf build)', 'Write', 'Read', 'mcp__github__delete_repo']), {
    tools: ['write', 'read', 'mcp__github__delete_repo'],
    commands: ['git push', 'curl', 'rm -rf build'],
  });
});

test('the launch hands the bridge the mission\'s policy: its mode, the product\'s rules, the agent\'s grants and refusals', async () => {
  const policyOf = async (cfg: Partial<BuildSpawnOpts['cfg']>): Promise<Policy> => {
    const spawn = spawnOpts({ cfg: { cwd: WORK, ...cfg } });
    await provider.launch(spawn, PROFILE);
    const p = peer(null);
    const driver = provider.codec.kind === 'driver'
      ? provider.codec.openSession({ io: { stdin: p.stdin, stdout: p.stdout }, spawn, host: p.host, profileId: 'pi' })
      : null;
    const handed = (driver as unknown as { opts: { bridge: BridgeLaunch } }).opts.bridge.policy;
    driver!.close();
    return handed;
  };
  const coder = await policyOf({ permission_mode: 'auto', allowed_tools: ['Edit', 'Bash(git:*)'], disallowed_tools: ['Bash(git push:*)'] });
  assert.equal(coder.mode, 'edits');
  assert.deepEqual(coder.grantTools, ['edit']);
  assert.deepEqual(coder.grantCommands, ['git:*']);
  assert.ok(coder.allowTools.includes('mcp__timon__kanban_add'), 'the product\'s pre-approved tools');
  assert.ok(!coder.allowTools.includes('mcp__timon__mission_spawn'), 'a spawn still asks');
  assert.ok(coder.allowCommands.includes('timon task done:*'));
  assert.deepEqual(coder.hintServers, ['timon', 'timon_ask'], 'Timon\'s servers: the only ones whose read-only hint is believed');
  assert.ok(coder.denyPrograms.includes('sudo'));
  assert.ok(coder.denyCommands.includes('timon service') && coder.denyCommands.includes('rm -rf /*') && coder.denyCommands.includes('git push'));
  assert.equal(bridge.permissionVerdict(coder, { toolName: 'bash', input: { command: 'git push origin main' } }, WHERE).verdict, 'deny', 'a refusal beats a grant');
  assert.equal((await policyOf({ permission_mode: 'plan' })).mode, 'read-only');
  assert.equal((await policyOf({})).mode, 'ask');
  assert.equal((await policyOf({ permission_mode: 'bypassPermissions' })).mode, 'bypass');
});
