#!/usr/bin/env node
/**
 * A scripted stand-in for an ACP agent (`opencode acp`, `hermes-acp`), for the
 * transport tests. It never touches the network or a model: the scenario is
 * picked by the TEXT of the prompt it receives, so a test reads as a story.
 *
 *   hello     two message chunks, a tool call and its update, then end_turn
 *   perm      asks session/request_permission, reports the answer, end_turn
 *   permform  asks permission for a tool titled `ask_user` (a form card), reports the answer
 *   permslow  asks permission, then waits for the answer AND a cancel
 *   slow      streams a chunk, then waits for session/cancel → cancelled
 *   hang      never answers the prompt
 *   die       one chunk, then exits with code 3 in the middle of the turn
 *   fs        asks fs/read_text_file and terminal/create, reports the errors
 *   noise     prints banners and non-JSON between valid messages
 *   nonl      replies without a trailing newline, then exits
 *   echo      reports the content blocks it received (type or text, joined by |)
 *   mcp       reports the mcpServers of session/new (JSON)
 *   model     reports the model id of the last session/set_model
 *   effort    reports the thinking level the last session/set_config_option chose
 *   permalways  asks permission with an allow_always option only
 *   permhyphen  asks permission with options that carry no `kind`, only the ids `allow-once`, `allow-always`, `reject-once` (Cursor's), reports the answer
 *   permshell   asks permission for a one-line shell command (`execute`), reports the answer
 *   preamble    text, a tool call it asks permission for, then `The summary (<answer>).`
 *   [permission] …  a message Timon relays after a turn: echoed like `echo`
 *
 * Outside the prompt, the method `test/hang` is never answered.
 *
 * The scenario is the text of the LAST text block: a driver may put a system
 * prompt in front of the message.
 *
 * Environment: FAKE_ACP_STDERR=<text> written to stderr at start,
 * FAKE_ACP_IGNORE_TERM=1 traps SIGTERM (only SIGKILL stops it),
 * FAKE_ACP_RESUME=1 announces sessionCapabilities.resume,
 * FAKE_ACP_RESUME_FAIL=1 answers session/resume with -32601,
 * FAKE_ACP_LOAD_FAIL=1 answers session/load with "session not found",
 * FAKE_ACP_AUTH=1 announces an auth method and refuses session/new (-32000),
 * FAKE_ACP_AUTH=authenticate announces the method `cursor_login` and refuses session/new (-32000) until `authenticate`
 *   has been called with it (FAKE_ACP_AUTH_FAIL=1: `authenticate` itself answers an error; the call is recorded in the `auth` scenario),
 *   (FAKE_ACP_AUTH_HANG=1: `authenticate` never answers, as a sign-in that waits for a browser redirect),
 * FAKE_ACP_NO_IMAGE=1 does not announce image prompts,
 * FAKE_ACP_NO_CONFIG=1 answers session/set_config_option with -32601 (an agent without it).
 * FAKE_ACP_MUTE=1 reads its stdin and never answers anything (an agent waiting for something else),
 * FAKE_ACP_EXIT=<code> exits with that code at start, after FAKE_ACP_STDERR,
 * FAKE_ACP_NO_SET_MODEL=1 answers session/set_model with -32601 (opencode, TIM-0129).
 *
 * Models: `a` offers the thinking levels low and high, `b` offers none — like
 * opencode, which leaves the `effort` option out for a model with no variants.
 */
import { createInterface } from 'node:readline';

const out = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
const update = (sessionId, u) => out({ method: 'session/update', params: { sessionId, update: u } });
const chunk = (sessionId, text) => update(sessionId, {
  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
});

if (process.env.FAKE_ACP_STDERR) process.stderr.write(process.env.FAKE_ACP_STDERR);
if (process.env.FAKE_ACP_IGNORE_TERM === '1') process.on('SIGTERM', () => { /* trapped on purpose */ });
if (process.env.FAKE_ACP_EXIT) process.stderr.write('', () => process.exit(Number(process.env.FAKE_ACP_EXIT)));

let nextOut = 100;
const waiting = new Map();
const call = (method, params) => new Promise((resolve) => {
  const id = nextOut++;
  waiting.set(id, resolve);
  out({ id, method, params });
});

let cancelWaiter = null;
const cancelled = new Promise((resolve) => { cancelWaiter = resolve; });

const configOptions = () => [
  { id: 'model', category: 'model', currentValue: currentModel, options: [{ value: 'a' }, { value: 'b' }] },
  ...(currentModel === 'a'
    ? [{ id: 'effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }, { value: 'default' }] }]
    : []),
];

const USAGE = { inputTokens: 12, outputTokens: 34, thoughtTokens: 5, cachedReadTokens: 7 };
let seenClientCapabilities = null;
let lastModel = null;
let lastEffort = null;
let currentModel = 'a';
let seenMcpServers = null;
let authenticated = false;
const authenticateCalls = [];

let lastBlocks = [];
function echo(id, sessionId) {
  chunk(sessionId, lastBlocks.map((b) => (b.type === 'text' ? b.text : b.type)).join('|'));
  return out({ id, result: { stopReason: 'end_turn' } });
}

async function prompt(id, sessionId, text) {
  if (text.startsWith('[permission] ')) return echo(id, sessionId);
  switch (text) {
    case 'permshell': {
      const r = await call('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't6', title: 'sudo systemctl restart nginx', kind: 'execute', rawInput: { command: 'sudo systemctl restart nginx' } },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const o = r.result?.outcome;
      chunk(sessionId, o?.outcome === 'selected' ? `selected:${o.optionId}` : `outcome:${o?.outcome}`);
      return out({ id, result: { stopReason: 'end_turn' } });
    }
    case 'hello':
      chunk(sessionId, 'Hel');
      chunk(sessionId, 'lo');
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
      return out({ id, result: { stopReason: 'end_turn', usage: USAGE } });
    case 'perm': {
      const r = await call('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't2', title: 'write /etc/passwd', kind: 'edit', rawInput: { path: '/etc/passwd' } },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const o = r.result?.outcome;
      chunk(sessionId, o?.outcome === 'selected' ? `selected:${o.optionId}` : `outcome:${o?.outcome}`);
      return out({ id, result: { stopReason: 'end_turn' } });
    }
    case 'preamble': {
      // Text, a tool call that is refused, then the answer.
      chunk(sessionId, 'I will run rm -rf now');
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't8', title: 'rm -rf .', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf .' } });
      const r = await call('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't8', title: 'rm -rf .', kind: 'execute', rawInput: { command: 'rm -rf .' } },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't8', status: 'failed', rawOutput: 'rejected' });
      chunk(sessionId, `The summary (${r.result?.outcome?.optionId}).`);
      return out({ id, result: { stopReason: 'end_turn' } });
    }
    case 'permhyphen': {
      const r = await call('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't7', title: 'edit src/index.ts', kind: 'edit', rawInput: { path: 'src/index.ts' } },
        options: [
          { optionId: 'allow-once', name: 'Allow once' },
          { optionId: 'allow-always', name: 'Allow always' },
          { optionId: 'reject-once', name: 'Reject' },
        ],
      });
      const o = r.result?.outcome;
      chunk(sessionId, o?.outcome === 'selected' ? `selected:${o.optionId}` : `outcome:${o?.outcome}`);
      return out({ id, result: { stopReason: 'end_turn' } });
    }
    case 'permform': {
      const r = await call('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't5', title: 'ask_user', kind: 'other', rawInput: {} },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const o = r.result?.outcome;
      chunk(sessionId, o?.outcome === 'selected' ? `selected:${o.optionId}` : `outcome:${o?.outcome}`);
      return out({ id, result: { stopReason: 'end_turn' } });
    }
    case 'permslow': {
      const answer = call('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't3', title: 'rm -rf build', kind: 'execute' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });
      await cancelled;
      const r = await answer;
      chunk(sessionId, `outcome:${r.result?.outcome?.outcome}`);
      return out({ id, result: { stopReason: 'cancelled' } });
    }
    case 'echo':
      return echo(id, sessionId);
    case 'auth':
      chunk(sessionId, JSON.stringify(authenticateCalls));
      return out({ id, result: { stopReason: 'end_turn' } });
    case 'mcp':
      chunk(sessionId, JSON.stringify(seenMcpServers));
      return out({ id, result: { stopReason: 'end_turn' } });
    case 'effort':
      chunk(sessionId, `effort:${lastEffort}`);
      return out({ id, result: { stopReason: 'end_turn' } });
    case 'model':
      chunk(sessionId, `model:${lastModel}`);
      return out({ id, result: { stopReason: 'end_turn' } });
    case 'permalways': {
      const r = await call('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't4', title: 'curl example.com', kind: 'execute', rawInput: { command: 'curl example.com' } },
        options: [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }],
      });
      chunk(sessionId, `outcome:${r.result?.outcome?.outcome}`);
      return out({ id, result: { stopReason: 'end_turn' } });
    }
    case 'slow':
      chunk(sessionId, 'working');
      await cancelled;
      return out({ id, result: { stopReason: 'cancelled' } });
    case 'hang':
      return undefined;
    case 'die':
      chunk(sessionId, 'partial');
      return setTimeout(() => process.exit(3), 20);
    case 'fs': {
      const a = await call('fs/read_text_file', { sessionId, path: 'x.txt' });
      const b = await call('terminal/create', { sessionId, command: 'ls' });
      chunk(sessionId, `fs:${a.error?.code};terminal:${b.error?.code}`);
      return out({ id, result: { stopReason: 'end_turn' } });
    }
    case 'noise':
      process.stdout.write('Booting agent v1.2.3...\n');
      chunk(sessionId, 'a');
      process.stdout.write('{not json\n');
      process.stdout.write('[1,2,3]\n');
      process.stdout.write('\n');
      chunk(sessionId, 'b');
      return out({ id, result: { stopReason: 'end_turn' } });
    case 'nonl':
      chunk(sessionId, 'x');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }));
      // Only the end of the stream can flush a line with no newline.
      return setTimeout(() => process.exit(0), 20);
    default:
      return out({ id, error: { code: -32602, message: `unknown scenario ${text}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim() || process.env.FAKE_ACP_MUTE === '1') return;
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    // A reply to one of OUR requests.
    const resolve = waiting.get(msg.id);
    if (resolve) { waiting.delete(msg.id); resolve(msg); }
    return;
  }
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'initialize':
      seenClientCapabilities = p.clientCapabilities ?? null;
      return out({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'fake-acp', version: '0.0.0' },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: process.env.FAKE_ACP_NO_IMAGE !== '1' },
            ...(process.env.FAKE_ACP_RESUME === '1' ? { sessionCapabilities: { resume: {} } } : {}),
          },
          authMethods: process.env.FAKE_ACP_AUTH === '1' ? [{ id: 'login', name: 'Log in' }]
            : process.env.FAKE_ACP_AUTH === 'authenticate' ? [{ id: 'cursor_login', name: 'Cursor Login' }] : [],
          seenClientCapabilities,
          seenClientInfo: p.clientInfo ?? null,
        },
      });
    case 'authenticate':
      authenticateCalls.push(p.methodId ?? null);
      if (process.env.FAKE_ACP_AUTH_FAIL === '1') return out({ id: msg.id, error: { code: -32000, message: 'not signed in' } });
      if (process.env.FAKE_ACP_AUTH_HANG === '1') return undefined;
      authenticated = p.methodId === 'cursor_login';
      return out({ id: msg.id, result: {} });
    case 'session/new':
      if (process.env.FAKE_ACP_AUTH === 'authenticate' && !authenticated) return out({ id: msg.id, error: { code: -32000, message: 'auth_required' } });
      if (process.env.FAKE_ACP_AUTH === '1') return out({ id: msg.id, error: { code: -32000, message: 'auth_required' } });
      seenMcpServers = p.mcpServers ?? null;
      return out({
        id: msg.id,
        result: {
          sessionId: 'sess-1',
          configOptions: configOptions(),
          seenMcp: p.mcpServers ?? null,
          seenCwd: p.cwd ?? null,
        },
      });
    case 'session/load':
    case 'session/resume':
      if (msg.method === 'session/resume' && process.env.FAKE_ACP_RESUME_FAIL === '1') {
        return out({ id: msg.id, error: { code: -32601, message: 'Method not found: session/resume' } });
      }
      if (msg.method === 'session/load' && process.env.FAKE_ACP_LOAD_FAIL === '1') {
        return out({ id: msg.id, error: { code: -32002, message: 'session not found' } });
      }
      seenMcpServers = p.mcpServers ?? null;
      // Hermes replays the history even on resume.
      chunk(p.sessionId, 'replayed');
      return out({ id: msg.id, result: msg.method === 'session/load' ? null : {} });
    case 'session/set_model':
      if (process.env.FAKE_ACP_NO_SET_MODEL === '1') return out({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
      lastModel = p.modelId ?? null;
      currentModel = lastModel ?? currentModel;
      return out({ id: msg.id, result: {} });
    case 'session/set_config_option':
      if (process.env.FAKE_ACP_NO_CONFIG === '1') return out({ id: msg.id, error: { code: -32601, message: 'Method not found: session/set_config_option' } });
      if (p.configId === 'model' && (p.value === 'a' || p.value === 'b')) {
        lastModel = p.value;
        currentModel = p.value;
        return out({ id: msg.id, result: { configOptions: configOptions() } });
      }
      if (p.configId === 'effort' && currentModel === 'a' && (p.value === 'low' || p.value === 'high' || p.value === 'default')) {
        lastEffort = p.value;
        return out({ id: msg.id, result: { configOptions: configOptions() } });
      }
      return out({ id: msg.id, error: { code: -32602, message: `invalid option ${p.configId}=${p.value}` } });
    case 'session/prompt': {
      lastBlocks = Array.isArray(p.prompt) ? p.prompt : [];
      const texts = lastBlocks.filter((b) => b.type === 'text');
      void prompt(msg.id, p.sessionId, texts.length ? texts[texts.length - 1].text : '');
      return undefined;
    }
    case 'session/cancel':
      return cancelWaiter();
    case 'test/hang':
      // A non-prompt request that is never answered: only a budget ends it.
      return undefined;
    default:
      if (msg.id !== undefined) out({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return undefined;
  }
});
rl.on('close', () => process.exit(0));
