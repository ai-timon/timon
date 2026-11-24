// @ts-check
/**
 * Timon's bridge into Pi: a Pi extension in plain JavaScript (no TypeScript toolchain on a tester's
 * machine), loaded with `pi -e <file>`. The provider copies this file into the mission's scratch
 * folder at every launch, so Pi reads a real file of its own, never one inside the release.
 *
 * What it does, and why it does it itself:
 *  - its configuration arrives ONCE, on Pi's stdin, as the extension command `/timon-bridge …`
 *    the driver sends before the first prompt. Pi runs the command and answers `handled`: nothing
 *    reaches the model, nothing is written to the session. The mission's token travels in it as a
 *    reference the daemon swaps on the pipe (`mission-token-seal.ts`), so it is never in Pi's argv,
 *    in a file, or in an environment variable the agent's shell could print;
 *  - it is its own MCP client (stdio, and Streamable HTTP) and declares every tool with
 *    `pi.registerTool`, named `mcp__<server>__<tool>`. Pi's MCP layer is NOT used: `pi-mcp-adapter`,
 *    common among Pi users, turns the built-in one off (`-builtin:mcp`) and makes servers registered
 *    with `registerMcpServer` proxy-only, so the tools would never reach the model;
 *  - it stops the servers it started when Pi ends: their stdin is closed, then each is killed by
 *    pid (`ChildProcess.kill`), never by POSIX process group, which Windows does not have;
 *  - it is the gate of every tool call (`tool_call`, Pi's own tools included): the mission's
 *    permission policy, computed by the provider and sent with the servers, lets a call through,
 *    blocks it with a reason, or asks Timon (`ctx.ui.confirm`, which the driver turns into the
 *    Allow/Deny card). It asks with Pi's abort signal: without it, a Stop while a card is open never
 *    completes (verified on the bench). Before its configuration arrives, every call is blocked.
 *
 * Wire format of the command (after Pi decoded its JSON record): `/timon-bridge <head>␀<v0>␀<v1>…␀.`
 * where `<head>` is JSON naming each value by its index, and carrying the launch's nonce and its
 * permission policy. The nonce is what the driver recognizes the bridge by, in its report and in its
 * permission dialogs: another extension can write to the same channel, and only this one was told it. Every environment value and header value
 * travels raw after a NUL: the daemon swaps a reference for the value escaped for ONE JSON string,
 * which a value nested in a second JSON document (a Windows path, a quote) would not survive. NUL
 * can occur in no environment variable and in no HTTP header, so it cannot occur in a value.
 *
 * Self-contained on purpose: Pi loads it with no `node_modules` beside it, so only `node:*` is imported.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** The extension command the driver sends, without its slash. */
export const BRIDGE_COMMAND = 'timon-bridge';
/** Version of the wire format: the driver and the bridge ship together, a mismatch is a bug. */
export const BRIDGE_FORMAT = 2;
/** Prefix of the `notify` the command ends with: what the driver reads to learn the outcome. */
export const BRIDGE_REPORT = `${BRIDGE_COMMAND}:report `;
/** Title of a permission dialog, followed by the launch's nonce. */
export const BRIDGE_PERMISSION = `${BRIDGE_COMMAND}:permission `;
/** What a nonce looks like: the driver's is 32 hex characters. */
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

const NUL = '\u0000';
/** Last field of the command: a trailing value survives a trim of the arguments. */
const END = '.';
const PROTOCOL_VERSION = '2025-06-18';
/** Provider tool names: at most 64 characters of `[A-Za-z0-9_-]` (Pi's own MCP layer keeps the same limit). */
const MAX_TOOL_NAME = 64;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 2_000;
/** A tool result past this is cut in the middle: one runaway answer must not fill the model's context. */
const MAX_RESULT_CHARS = 200_000;
const STDERR_TAIL_CHARS = 2_000;
const MAX_ERROR_CHARS = 300;

/**
 * @typedef {{ type: 'stdio', name: string, command: string, args: string[], env: Record<string, string> }} StdioServer
 * @typedef {{ type: 'http', name: string, url: string, headers: Record<string, string> }} HttpServer
 * @typedef {StdioServer | HttpServer} BridgeServer
 * What the driver encodes: the daemon's MCP plan (`ctx.provider.mcp`), read-only.
 * @typedef {{ readonly type: 'stdio', readonly name: string, readonly command: string, readonly args: readonly string[], readonly env: Readonly<Record<string, string>> }
 *   | { readonly type: 'http', readonly name: string, readonly url: string, readonly headers: Readonly<Record<string, string>> }} ServerInput
 * @typedef {Record<string, unknown>} Json
 * @typedef {{ name: string, description?: string, title?: string, inputSchema?: unknown, annotations?: unknown }} McpTool
 * @typedef {{ type: 'text', text: string } | { type: 'image', data: string, mimeType: string }} PiContent
 * @typedef {{ content: PiContent[], details: undefined }} PiToolResult
 * @typedef {{ server: string, tools: number, error?: string }} ServerReport
 *
 * How a mission's tool calls are arbitrated (`piPermissionPolicy`, provider side). Tool names are
 * Pi's (`bash`, `edit`…) or `mcp__<server>__<tool>`; a name ending with `*` covers every name it
 * starts. A command rule is words: `git:*` is `git` followed by anything, `npm test` that command
 * exactly. A deny rule is text: `rm -rf /*` is anything starting with `rm -rf /`, `timon service`
 * that command or that command followed by arguments.
 *  - `mode`: `read-only` (plan), `ask` (default), `edits` (acceptEdits, auto), `bypass`;
 *  - `allowTools`, `allowCommands`: the product's own, in every mode (Timon's pre-approved MCP tools,
 *    the `timon` CLI commands a mission needs);
 *  - `grantTools`, `grantCommands`: the agent's grants, outside `read-only`;
 *  - `denyTools`, `denyPrograms`, `denyCommands`: refused in every mode, `bypass` included;
 *  - `hintServers`: the servers whose MCP `readOnlyHint` the gate believes (Timon's own); a server the
 *    user added, or a tool of another extension, says what it likes and still gets a card.
 * @typedef {'read-only' | 'ask' | 'edits' | 'bypass'} PermissionMode
 * @typedef {{
 *   mode: PermissionMode,
 *   allowTools: string[], allowCommands: string[], hintServers: string[],
 *   grantTools: string[], grantCommands: string[],
 *   denyTools: string[], denyPrograms: string[], denyCommands: string[],
 * }} BridgePolicy
 * What the command carries.
 * @typedef {{ nonce: string, policy: BridgePolicy, servers: BridgeServer[] }} BridgeConfig
 * What a call is: its tool, its arguments, and the hints the tool declares (MCP annotations), only
 * when one of `hintServers` serves it.
 * @typedef {{ toolName: string, input: unknown, annotations?: unknown }} ToolCall
 * @typedef {{ verdict: 'allow' } | { verdict: 'deny', reason: string } | { verdict: 'ask' }} Verdict
 *
 * The part of Pi's `ExtensionAPI` the bridge uses (Pi 1.4.0).
 * @typedef {{
 *   registerCommand(name: string, options: { description?: string, handler: (args: string, ctx: PiContext) => Promise<void> }): void,
 *   registerTool(tool: Json): void,
 *   on(event: string, handler: (event: Json, ctx: PiContext) => unknown): unknown,
 * }} PiApi
 * @typedef {{
 *   ui: {
 *     notify(message: string, type?: string): void,
 *     confirm?(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>,
 *   },
 *   cwd?: string,
 *   hasUI?: boolean,
 *   signal?: AbortSignal,
 * }} PiContext
 */

/** @param {unknown} v @returns {v is Json} */
function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One line, bounded: what an error may say in Pi's stderr and in the report. @param {unknown} err */
function describe(err) {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/* ── Configuration ───────────────────────────────────────────────────── */

/**
 * The command the driver sends: `/timon-bridge`, the launch's nonce and policy, and the servers,
 * each environment or header value after a NUL (see the header). A value holding a NUL is left out:
 * no OS would hand it to a process.
 * @param {readonly ServerInput[]} servers
 * @param {{ nonce: string, policy: BridgePolicy }} launch
 * @returns {string}
 */
export function encodeBridgeConfig(servers, launch) {
  /** @type {string[]} */
  const values = [];
  /** @param {Readonly<Record<string, string>>} record */
  const index = (record) => {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' && !value.includes(NUL)) out[key] = values.push(value) - 1;
    }
    return out;
  };
  const head = {
    v: BRIDGE_FORMAT,
    nonce: launch.nonce,
    policy: launch.policy,
    servers: servers.map((s) => (s.type === 'http'
      ? { type: 'http', name: s.name, url: s.url, headers: index(s.headers) }
      : { type: 'stdio', name: s.name, command: s.command, args: [...s.args], env: index(s.env) })),
  };
  return `/${BRIDGE_COMMAND} ${[JSON.stringify(head), ...values, END].join(NUL)}`;
}

/**
 * The nonce of a configuration, read before anything else is: a configuration the bridge refuses
 * is still reported under it, so the driver learns why. Null when there is none to read.
 * @param {string} args
 */
export function peekBridgeNonce(args) {
  try {
    const head = JSON.parse(args.split(NUL, 1)[0] ?? '');
    return isRecord(head) && typeof head.nonce === 'string' && NONCE.test(head.nonce) ? head.nonce : null;
  } catch {
    return null;
  }
}

/** @param {unknown} list @returns {string[]} */
function strings(list) {
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw new Error('malformed permission policy');
  return /** @type {string[]} */ (list);
}

/** @param {unknown} policy @returns {BridgePolicy} */
function readPolicy(policy) {
  if (!isRecord(policy)) throw new Error('missing permission policy');
  const mode = policy.mode;
  if (mode !== 'read-only' && mode !== 'ask' && mode !== 'edits' && mode !== 'bypass') throw new Error('unknown permission mode');
  return {
    mode,
    allowTools: strings(policy.allowTools),
    allowCommands: strings(policy.allowCommands),
    hintServers: strings(policy.hintServers),
    grantTools: strings(policy.grantTools),
    grantCommands: strings(policy.grantCommands),
    denyTools: strings(policy.denyTools),
    denyPrograms: strings(policy.denyPrograms),
    denyCommands: strings(policy.denyCommands),
  };
}

/**
 * What the command describes. Throws on anything the driver would not have written.
 * @param {string} args what Pi hands the command: everything after `/timon-bridge `
 * @returns {BridgeConfig}
 */
export function decodeBridgeConfig(args) {
  const fields = args.split(NUL);
  if (fields.length < 2 || fields[fields.length - 1] !== END) throw new Error('the configuration is truncated');
  const values = fields.slice(1, -1);
  const head = JSON.parse(/** @type {string} */ (fields[0]));
  if (!isRecord(head) || head.v !== BRIDGE_FORMAT || !Array.isArray(head.servers)) throw new Error('unsupported configuration format');
  if (typeof head.nonce !== 'string' || !NONCE.test(head.nonce)) throw new Error('missing nonce');
  const policy = readPolicy(head.policy);
  /** @param {unknown} map @returns {Record<string, string>} */
  const pick = (map) => {
    if (map === undefined) return {};
    if (!isRecord(map)) throw new Error('malformed configuration');
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, index] of Object.entries(map)) {
      const value = typeof index === 'number' ? values[index] : undefined;
      if (value === undefined) throw new Error('malformed configuration');
      out[key] = value;
    }
    return out;
  };
  /** @type {BridgeServer[]} */
  const servers = head.servers.map((/** @type {unknown} */ s) => {
    if (!isRecord(s) || typeof s.name !== 'string' || !s.name) throw new Error('malformed configuration');
    if (s.type === 'http' && typeof s.url === 'string') return { type: 'http', name: s.name, url: s.url, headers: pick(s.headers) };
    if (s.type === 'stdio' && typeof s.command === 'string' && Array.isArray(s.args) && s.args.every((a) => typeof a === 'string')) {
      return { type: 'stdio', name: s.name, command: s.command, args: /** @type {string[]} */ (s.args), env: pick(s.env) };
    }
    throw new Error('malformed configuration');
  });
  return { nonce: head.nonce, policy, servers };
}

/* ── Tool names and results ──────────────────────────────────────────── */

/**
 * `mcp__<server>__<tool>`, the name Timon's prompts use for every backend. Characters a provider
 * refuses become `_` (hyphens are kept: `mcp__timon-browser__…`); a name past 64 characters, or one
 * already taken, is shortened with a hash of the pair.
 * @param {string} server @param {string} tool @param {(name: string) => boolean} [isTaken]
 */
export function mcpToolName(server, tool, isTaken = () => false) {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (name.length <= MAX_TOOL_NAME && !isTaken(name)) return name;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
}

/** What Pi validates the arguments against: the tool's own JSON Schema, an empty object when it has none. @param {unknown} schema */
export function toolParameters(schema) {
  if (isRecord(schema) && (schema.type === 'object' || schema.type === undefined)) return { type: 'object', properties: {}, ...schema };
  return { type: 'object', properties: {} };
}

/** @param {string} text */
function bounded(text) {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const half = Math.floor(MAX_RESULT_CHARS / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - MAX_RESULT_CHARS} characters cut by Timon …]\n\n${text.slice(-half)}`;
}

/**
 * An MCP `CallToolResult` as Pi's tool result: text and images pass, the rest is described in text.
 * An MCP error (`isError`) is thrown, which is how a Pi tool fails.
 * @param {unknown} result
 * @returns {PiToolResult}
 */
export function toPiResult(result) {
  const r = isRecord(result) ? result : {};
  /** @type {PiContent[]} */
  const content = [];
  for (const block of Array.isArray(r.content) ? r.content : []) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text });
    else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else if (block.type === 'resource' && isRecord(block.resource)) {
      const res = block.resource;
      if (typeof res.text === 'string') content.push({ type: 'text', text: res.text });
      else if (typeof res.blob === 'string' && typeof res.mimeType === 'string' && res.mimeType.startsWith('image/')) {
        content.push({ type: 'image', data: res.blob, mimeType: res.mimeType });
      } else content.push({ type: 'text', text: `[resource ${String(res.uri ?? '')}${typeof res.mimeType === 'string' ? ` (${res.mimeType})` : ''}]` });
    } else if (block.type === 'resource_link') content.push({ type: 'text', text: `[resource ${String(block.uri ?? '')}]` });
    else content.push({ type: 'text', text: `[${String(block.type ?? 'unknown')} content not shown]` });
  }
  if (content.length === 0 && r.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(r.structuredContent) });
  const text = content.filter((c) => c.type === 'text').map((c) => /** @type {{ text: string }} */ (c).text).join('\n');
  if (r.isError === true) throw new Error(bounded(text || 'the tool failed'));
  return { content: content.map((c) => (c.type === 'text' ? { type: 'text', text: bounded(c.text) } : c)), details: undefined };
}

/* ── Permissions ─────────────────────────────────────────────────────── */

/** Pi's built-in tools, by what they do. Anything else is judged by the hints it declares. */
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const EDIT_TOOLS = new Set(['edit', 'write']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);

/** What a shell treats as more than one plain command: separators, redirections, substitutions. */
const SHELL_OPERATOR = /[;&|<>()`$\n\r]/;
/** Where a command line splits into the commands it runs, for the deny rules. */
const SHELL_SPLIT = /\|\||&&|[;&|\n\r()`]|\$\(/;
/** Words a command may start with that run the next word as the command. */
const COMMAND_PREFIXES = new Set(['exec', 'command', 'nohup', 'time', 'env', 'builtin']);

/** @param {readonly string[]} rules @param {string} name */
function namedBy(rules, name) {
  return rules.some((rule) => (rule.endsWith('*') ? name.startsWith(rule.slice(0, -1)) : rule === name));
}

/**
 * The words of a command line that runs ONE plain command, quotes resolved; null for anything a
 * shell would read as more (`;`, `&&`, a pipe, a redirection, `$(…)`, a variable). Only such a line
 * can match an allow rule: `git status; rm -rf x` must never pass as `git status`.
 * @param {string} command
 * @returns {string[] | null}
 */
export function shellWords(command) {
  /** @type {string[]} */
  const words = [];
  let word = '';
  let started = false;
  /** @type {"'" | '"' | null} */
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = /** @type {string} */ (command[i]);
    if (quote === "'") {
      if (c === "'") quote = null; else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '$' || c === '`') return null;
      else if (c === '\\' && i + 1 < command.length && '"\\$`'.includes(/** @type {string} */ (command[i + 1]))) word += command[++i];
      else word += c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (started) words.push(word);
      word = '';
      started = false;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === '\\') {
      const next = command[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return null;
      word += next;
      i += 1;
      started = true;
    } else if (SHELL_OPERATOR.test(c)) {
      return null;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words.length ? words : null;
}

/** Whether the words match an allow rule (`git:*`, `npm test`). @param {readonly string[]} rules @param {readonly string[]} words */
function commandAllowed(rules, words) {
  return rules.some((rule) => {
    const prefix = rule.endsWith(':*');
    const want = (prefix ? rule.slice(0, -2) : rule).trim().split(/\s+/).filter(Boolean);
    if (!want.length || words.length < want.length || (!prefix && words.length !== want.length)) return false;
    return want.every((w, i) => words[i] === w);
  });
}

/**
 * The deny rule a command line breaks, if any: every command it runs is checked, so a refused
 * program stays refused behind `&&` or inside `$(…)`. Best effort on purpose — a shell can always
 * be talked into running something a reading of its text does not see; this is a seatbelt, the card
 * is the guard.
 * @param {BridgePolicy} policy
 * @param {string} command
 * @returns {string | null}
 */
export function deniedCommand(policy, command) {
  for (const raw of command.split(SHELL_SPLIT)) {
    let words = raw.trim().split(/\s+/).filter(Boolean);
    // `FOO=1 sudo …`, `env sudo …`, `exec sudo …`: the command is the word after them.
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(/** @type {string} */ (words[0])) || COMMAND_PREFIXES.has(/** @type {string} */ (words[0])))) words = words.slice(1);
    if (!words.length) continue;
    const program = /** @type {string} */ (words[0]).replace(/^["'\\]+|["']+$/g, '').split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? '';
    if (policy.denyPrograms.includes(program)) return program;
    const text = [program, ...words.slice(1)].join(' ');
    for (const rule of policy.denyCommands) {
      if (rule.endsWith('*') ? text.startsWith(rule.slice(0, -1)) : text === rule || text.startsWith(`${rule} `)) return rule;
    }
  }
  return null;
}

/**
 * Whether a path an edit names stays inside the working directory, resolved as Pi resolves it
 * (`@` prefix dropped, `~` is the home). A symbolic link inside that points outside is not followed.
 * @param {unknown} path @param {string} cwd @param {string} home
 */
export function insideCwd(path, cwd, home) {
  if (typeof path !== 'string' || !path.trim()) return false;
  let p = path.startsWith('@') ? path.slice(1) : path;
  if (p === '~' || p.startsWith('~/') || p.startsWith(`~${sep}`)) p = join(home, p.slice(1));
  const root = resolve(cwd);
  const rel = relative(root, resolve(root, p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * What the mission's policy says of one tool call. Pure: the gate asks Timon only on `ask`.
 * @param {BridgePolicy} policy
 * @param {ToolCall} call
 * @param {{ cwd: string, home: string }} where
 * @returns {Verdict}
 */
export function permissionVerdict(policy, call, where) {
  const { toolName } = call;
  const input = isRecord(call.input) ? call.input : {};
  const shell = SHELL_TOOLS.has(toolName);
  const command = shell && typeof input.command === 'string' ? input.command : null;
  if (command !== null) {
    const rule = deniedCommand(policy, command);
    if (rule) return { verdict: 'deny', reason: `Timon never lets an agent run \`${rule}\`: it acts on the machine or on Timon itself. Do not retry it; say what you needed it for.` };
  }
  if (namedBy(policy.denyTools, toolName)) return { verdict: 'deny', reason: `\`${toolName}\` is disallowed for this agent in Timon. Do not retry it.` };
  if (policy.mode === 'bypass') return { verdict: 'allow' };

  const hints = isRecord(call.annotations) ? call.annotations : {};
  const readOnly = READ_TOOLS.has(toolName) || (!shell && !EDIT_TOOLS.has(toolName) && hints.readOnlyHint === true);
  if (readOnly || namedBy(policy.allowTools, toolName)) return { verdict: 'allow' };
  const words = command === null ? null : shellWords(command);
  if (words && commandAllowed(policy.allowCommands, words)) return { verdict: 'allow' };

  if (policy.mode === 'read-only') {
    return { verdict: 'deny', reason: `This mission runs in plan mode (read-only) in Timon: \`${toolName}\` is not allowed. Read and plan; changes wait for a mission in another permission mode.` };
  }
  if (policy.mode === 'edits' && EDIT_TOOLS.has(toolName) && insideCwd(input.path, where.cwd, where.home)) return { verdict: 'allow' };
  if (namedBy(policy.grantTools, toolName)) return { verdict: 'allow' };
  if (words && commandAllowed(policy.grantCommands, words)) return { verdict: 'allow' };
  return { verdict: 'ask' };
}

/** The reason a call the card did not allow is blocked with: what the model reads instead of a result. @param {string} toolName @param {boolean} aborted */
export function refusalReason(toolName, aborted) {
  return aborted
    ? 'The turn was stopped before Timon answered: the call did not run.'
    : `Timon did not allow \`${toolName}\` (refused on its Allow/Deny card, or no answer in time). Do not retry it as is: take a safe alternative, or say what you need and why.`;
}

/* ── Windows commands ────────────────────────────────────────────────── */

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for `cmd.exe /s /c "…"` running a batch shim, as `cross-spawn` quotes it. @param {string} arg */
export function quoteCmdArgument(arg) {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  out = `"${out}"`;
  // A `.cmd` shim re-parses its line once more: meta characters are escaped twice.
  return out.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/**
 * How to start `command` on this OS. Node refuses to spawn a `.cmd` or `.bat` without a shell
 * (Windows only: `npx`, `uvx` shims), so those run through `cmd.exe` with every argument quoted.
 * @param {string} command @param {string[]} args
 * @param {{ platform?: string, env?: Record<string, string | undefined>, isFile?: (p: string) => boolean }} [os] for tests
 * @returns {{ file: string, args: string[], verbatim: boolean }}
 */
export function resolveSpawn(command, args, os = {}) {
  const platform = os.platform ?? process.platform;
  if (platform !== 'win32') return { file: command, args, verbatim: false };
  const env = os.env ?? process.env;
  const isFile = os.isFile ?? ((/** @type {string} */ p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } });
  // `win32` explicitly: the same answer whatever OS runs the tests.
  const exts = (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const candidates = win32.extname(command) ? [command] : exts.map((ext) => `${command}${ext.toLowerCase()}`);
  const dirs = win32.isAbsolute(command) || /[\\/]/.test(command) ? [''] : ['', ...(env.PATH ?? env.Path ?? '').split(';').filter(Boolean)];
  let found = null;
  for (const dir of dirs) {
    for (const name of candidates) {
      const full = dir ? win32.join(dir, name) : name;
      if (isFile(full)) { found = full; break; }
    }
    if (found) break;
  }
  // Found nowhere: Node starts it itself, and a missing program fails with ENOENT ("could not
  // start"). Through cmd.exe it would only exit 1 with "operable program or batch file.".
  if (!found) return { file: command, args, verbatim: false };
  const target = found;
  const ext = win32.extname(target).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: target, args, verbatim: false };
  const line = [target.replace(CMD_META, '^$1'), ...args.map(quoteCmdArgument)].join(' ');
  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/* ── MCP clients ─────────────────────────────────────────────────────── */

/**
 * Rejects after `ms` unless `promise` settles first.
 * @template T @param {Promise<T>} promise @param {number} ms @param {string} what @returns {Promise<T>}
 */
function within(promise, ms, what) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), late]);
}

/** What both transports share: the MCP handshake, the tool list, a call. */
class McpClient {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    this.nextId = 0;
    /** @type {string | null} Why the client cannot be used any more. */
    this.dead = null;
  }

  /** @param {string} _method @param {Json} _params @param {AbortSignal} [_signal] @returns {Promise<unknown>} */
  rpc(_method, _params, _signal) { return Promise.reject(new Error('not implemented')); }

  /** @param {string} _method @param {Json} [_params] @returns {void} */
  notify(_method, _params) {}

  /** @returns {void | Promise<void>} */
  close() {}

  async initialize() {
    const result = await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'timon-pi-bridge', version: String(BRIDGE_FORMAT) },
    });
    if (!isRecord(result)) throw new Error('the server answered `initialize` with nothing');
    this.notify('notifications/initialized');
  }

  /** @returns {Promise<McpTool[]>} */
  async listTools() {
    /** @type {McpTool[]} */
    const tools = [];
    /** @type {unknown} */
    let cursor;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.rpc('tools/list', cursor === undefined ? {} : { cursor });
      if (!isRecord(result)) break;
      for (const tool of Array.isArray(result.tools) ? result.tools : []) {
        if (isRecord(tool) && typeof tool.name === 'string' && tool.name) tools.push(/** @type {McpTool} */ (tool));
      }
      cursor = result.nextCursor;
      if (typeof cursor !== 'string' || !cursor) break;
    }
    return tools;
  }

  /** @param {string} name @param {unknown} args @param {AbortSignal} [signal] */
  callTool(name, args, signal) {
    return this.rpc('tools/call', { name, arguments: isRecord(args) ? args : {} }, signal);
  }
}

/** An MCP server over stdio: newline-delimited JSON-RPC on its pipes. */
export class McpStdioClient extends McpClient {
  /** @param {StdioServer} server */
  constructor(server) {
    super(server.name);
    this.server = server;
    /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
    this.pending = new Map();
    this.stderrTail = '';
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
    this.child = null;
    this.exited = false;
    /** @type {Promise<void>} Settles when the process is gone (at once if it never started). */
    this.gone = Promise.resolve();
  }

  start() {
    // The mission's token reaches a server only when Timon declared it for that server: the user's
    // own servers do not inherit it from Pi's environment.
    const env = { ...process.env };
    delete env.TIMON_API_TOKEN;
    Object.assign(env, this.server.env);
    const how = resolveSpawn(this.server.command, this.server.args);
    const child = spawn(how.file, how.args, {
      env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: how.verbatim,
    });
    this.child = child;
    this.gone = new Promise((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      buffer += decoder.write(chunk);
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin.on('error', () => { /* the exit says why */ });
    child.on('error', (err) => this.fail(`could not start: ${describe(err)}`));
    child.on('exit', (code, signal) => {
      this.exited = true;
      const tail = this.stderrTail.trim().split('\n').pop() ?? '';
      this.fail(`exited (${signal ?? `code ${code}`})${tail ? `: ${describe(tail)}` : ''}`);
    });
  }

  /** @param {string} line */
  onLine(line) {
    /** @type {unknown} */
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!isRecord(message)) return;
    if (typeof message.method === 'string') {
      // A request from the server: the bridge offers no roots, sampling or elicitation.
      if (message.id !== undefined) {
        this.send(message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }
    const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!waiter || typeof message.id !== 'number') return;
    this.pending.delete(message.id);
    if (isRecord(message.error)) waiter.reject(new Error(String(message.error.message ?? 'the server returned an error')));
    else waiter.resolve(message.result);
  }

  /** @param {Json} message */
  send(message) {
    if (!this.child || this.exited) return;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* the exit says why */ }
  }

  /** @param {string} method @param {Json} params @param {AbortSignal} [signal] */
  rpc(method, params, signal) {
    if (this.dead) return Promise.reject(new Error(`MCP server \`${this.name}\` ${this.dead}`));
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'aborted' });
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** @param {string} method @param {Json} [params] */
  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  /** @param {string} why */
  fail(why) {
    if (!this.dead) this.dead = why;
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(new Error(`MCP server \`${this.name}\` ${this.dead}`));
    }
  }

  /**
   * The MCP way: close its input, and kill it if it is still there after a grace period.
   * @returns {Promise<void>} settles when the server is gone
   */
  close() {
    const child = this.child;
    this.fail('was stopped');
    if (!child || this.exited) return this.gone;
    try { child.stdin.end(); } catch { /* already gone */ }
    const timer = setTimeout(() => this.kill(), STOP_GRACE_MS);
    timer.unref();
    return this.gone.finally(() => clearTimeout(timer));
  }

  /** Synchronous: what still runs when Pi itself exits. */
  kill() {
    if (this.child && !this.exited) {
      try { this.child.kill(); } catch { /* already gone */ }
    }
  }
}

/**
 * An MCP server over Streamable HTTP: one POST per message, answered with JSON or with an event
 * stream carrying the answer. The older HTTP+SSE transport (2024-11-05) is not spoken.
 */
export class McpHttpClient extends McpClient {
  /** @param {HttpServer} server */
  constructor(server) {
    super(server.name);
    this.server = server;
    /** @type {string | null} */
    this.sessionId = null;
    /** @type {string | null} */
    this.protocol = null;
  }

  start() {}

  /** @param {Json} body @param {AbortSignal} [signal] */
  async post(body, signal) {
    /** @type {Record<string, string>} */
    const headers = { ...this.server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocol) headers['mcp-protocol-version'] = this.protocol;
    const response = await fetch(this.server.url, { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    // The URL is not repeated: a key in its query string would land in Pi's stderr.
    if (!response.ok) throw new Error(`MCP server \`${this.name}\` answered HTTP ${response.status}`);
    return response;
  }

  /** @param {string} method @param {Json} params @param {AbortSignal} [signal] */
  async rpc(method, params, signal) {
    if (this.dead) throw new Error(`MCP server \`${this.name}\` ${this.dead}`);
    this.nextId += 1;
    const id = this.nextId;
    try {
      const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
      const type = response.headers.get('content-type') ?? '';
      const message = type.includes('text/event-stream') ? await this.fromStream(response, id) : await response.json();
      if (!isRecord(message)) throw new Error(`MCP server \`${this.name}\` answered \`${method}\` with nothing`);
      if (isRecord(message.error)) throw new Error(String(message.error.message ?? 'the server returned an error'));
      if (method === 'initialize' && isRecord(message.result) && typeof message.result.protocolVersion === 'string') {
        this.protocol = message.result.protocolVersion;
      }
      return message.result;
    } catch (err) {
      if (signal?.aborted) {
        this.notify('notifications/cancelled', { requestId: id, reason: 'aborted' });
        throw new Error('aborted');
      }
      throw err;
    }
  }

  /** The answer to `id` in an event stream (other events, the server's requests, are skipped). @param {Response} response @param {number} id */
  async fromStream(response, id) {
    if (!response.body) return null;
    const decoder = new TextDecoder();
    let buffer = '';
    let data = '';
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (response.body))) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) data += `${data ? '\n' : ''}${line.slice(5).trimStart()}`;
        else if (line === '' && data) {
          /** @type {unknown} */
          let message = null;
          try { message = JSON.parse(data); } catch { /* not ours */ }
          data = '';
          if (isRecord(message) && message.id === id && message.method === undefined) return message;
        }
      }
    }
    return null;
  }

  /** @param {string} method @param {Json} [params] */
  notify(method, params) {
    this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }).then((r) => r.body?.cancel(), () => undefined);
  }

  close() {
    if (this.dead) return;
    this.dead = 'was stopped';
    if (!this.sessionId) return;
    /** @type {Record<string, string>} */
    const headers = { ...this.server.headers, 'mcp-session-id': this.sessionId };
    fetch(this.server.url, { method: 'DELETE', headers }).then((r) => r.body?.cancel(), () => undefined);
  }

  kill() {}
}

/* ── The extension ───────────────────────────────────────────────────── */

/**
 * Connects to every server, declares its tools, and says how it went.
 * @param {PiApi} pi @param {BridgeServer[]} servers @param {(McpStdioClient | McpHttpClient)[]} clients filled as servers start
 * @param {Map<string, { server: string, annotations: Json }>} [hints] filled with each declared tool's MCP annotations and its server, for the gate
 * @returns {Promise<ServerReport[]>}
 */
export async function bridgeServers(pi, servers, clients, hints = new Map()) {
  /** @type {Set<string>} */
  const taken = new Set();
  const connected = await Promise.all(servers.map(async (server) => {
    const client = server.type === 'http' ? new McpHttpClient(server) : new McpStdioClient(server);
    clients.push(client);
    try {
      client.start();
      await within(client.initialize(), HANDSHAKE_TIMEOUT_MS, 'initialize');
      const tools = await within(client.listTools(), HANDSHAKE_TIMEOUT_MS, 'tools/list');
      return { server, client, tools, error: null };
    } catch (err) {
      client.close();
      return { server, client, tools: /** @type {McpTool[]} */ ([]), error: describe(err) };
    }
  }));
  /** @type {ServerReport[]} */
  const report = [];
  // Declared in the order Timon listed the servers, whichever answered first.
  for (const { server, client, tools, error } of connected) {
    let declared = 0;
    for (const tool of tools) {
      const name = mcpToolName(server.name, tool.name, (n) => taken.has(n));
      try {
        pi.registerTool({
          name,
          label: typeof tool.title === 'string' && tool.title ? tool.title : `${server.name} ${tool.name}`,
          description: typeof tool.description === 'string' && tool.description ? tool.description : `${tool.name} (MCP server ${server.name})`,
          parameters: toolParameters(tool.inputSchema),
          ...(isRecord(tool.annotations) ? { annotations: tool.annotations } : {}),
          /** @param {string} _id @param {unknown} params @param {AbortSignal | undefined} signal */
          execute: async (_id, params, signal) => toPiResult(await client.callTool(tool.name, params, signal)),
        });
        taken.add(name);
        if (isRecord(tool.annotations)) hints.set(name, { server: server.name, annotations: tool.annotations });
        declared += 1;
      } catch (err) {
        process.stderr.write(`[${BRIDGE_COMMAND}] ${server.name}: tool ${tool.name} not declared (${describe(err)})\n`);
      }
    }
    if (error) process.stderr.write(`[${BRIDGE_COMMAND}] ${server.name}: ${error}\n`);
    report.push({ server: server.name, tools: declared, ...(error ? { error } : {}) });
  }
  return report;
}

/** @param {PiApi} pi */
export default function timonBridge(pi) {
  /** @type {(McpStdioClient | McpHttpClient)[]} */
  const clients = [];
  /** @type {Map<string, { server: string, annotations: Json }>} */
  const hints = new Map();
  let configured = false;
  let exitHooked = false;
  /** Set once the configuration is read; until then no tool runs. @type {{ nonce: string, policy: BridgePolicy } | null} */
  let gate = null;

  /** Pi waits for this handler before it exits: each server gets its grace period, all at once. */
  const stopAll = async () => { await Promise.all(clients.map((client) => client.close())); };
  const killAll = () => { for (const client of clients) client.kill(); };

  pi.registerCommand(BRIDGE_COMMAND, {
    description: 'Connects this Pi session to Timon\'s tools (sent by Timon at start)',
    handler: async (args, ctx) => {
      // Once per process: a message that starts with the command later on configures nothing.
      if (configured) {
        ctx.ui.notify(`${BRIDGE_REPORT}${JSON.stringify({ error: 'already configured' })}`, 'warning');
        return;
      }
      configured = true;
      /** @type {BridgeConfig} */
      let config;
      try {
        config = decodeBridgeConfig(args);
      } catch (err) {
        const nonce = peekBridgeNonce(args);
        ctx.ui.notify(`${BRIDGE_REPORT}${JSON.stringify({ ...(nonce ? { nonce } : {}), error: describe(err) })}`, 'error');
        return;
      }
      const { nonce, servers } = config;
      gate = { nonce, policy: config.policy };
      if (!exitHooked && servers.some((s) => s.type === 'stdio')) {
        exitHooked = true;
        // Whatever way Pi goes (a signal, an exit nobody announced), a server still there is killed with it.
        process.once('exit', killAll);
      }
      const report = await bridgeServers(pi, servers, clients, hints);
      ctx.ui.notify(`${BRIDGE_REPORT}${JSON.stringify({ nonce, servers: report })}`, 'info');
    },
  });

  pi.on('tool_call', async (event, ctx) => {
    const toolName = typeof event.toolName === 'string' ? event.toolName : '';
    // Fail closed: a Pi this bridge was not configured in (a `/reload` recreates the extension
    // without its configuration) runs nothing Timon did not arbitrate.
    if (!gate) return { block: true, reason: 'Timon has not configured this Pi session: no tool runs until it does. Start a new conversation.' };
    // Only Timon's servers are believed: anything can call itself read-only (cf. `hintServers`).
    const declared = hints.get(toolName);
    const annotations = declared && gate.policy.hintServers.includes(declared.server) ? declared.annotations : undefined;
    const verdict = permissionVerdict(gate.policy, { toolName, input: event.input, annotations }, { cwd: ctx.cwd ?? process.cwd(), home: homedir() });
    if (verdict.verdict === 'allow') return undefined;
    if (verdict.verdict === 'deny') return { block: true, reason: verdict.reason };
    if (!ctx.hasUI || !ctx.ui.confirm) return { block: true, reason: refusalReason(toolName, false) };
    const message = JSON.stringify({ toolCallId: event.toolCallId, tool: toolName, input: event.input ?? {} });
    let allowed = false;
    try {
      // The signal is what lets Pi's abort reach this dialog: without it a Stop waits forever.
      allowed = await ctx.ui.confirm(`${BRIDGE_PERMISSION}${gate.nonce}`, message, ctx.signal ? { signal: ctx.signal } : undefined);
    } catch {
      allowed = false;
    }
    return allowed === true ? undefined : { block: true, reason: refusalReason(toolName, ctx.signal?.aborted === true) };
  });

  pi.on('session_shutdown', () => stopAll());
}
