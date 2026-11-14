/**
 * Does a provider definition agree with itself? (`docs/PROVIDERS-SDK.md` § 7.3)
 *
 * The type system checks the SHAPE of a `ProviderDefinition`; this checks what a
 * type cannot say, and what a plugin written in JavaScript owes nobody: a
 * capability declared without the member that serves it. The failure it prevents
 * is a provider that registers, takes a mission, and dies at the first event,
 * far from the author. Each sentence names the declaration, the missing piece
 * and what to do — a plugin author reads them in a log line or in the
 * conformance suite.
 *
 * Takes `unknown` on purpose, and is pure: the daemon applies it at registration
 * (`ctx.provider.registerProvider`) and `runtime.check.definitionProblems` hands
 * the same function to the author's own tests.
 *
 * The rules mirror `dialectProblems`, which checks the older `Dialect` contract,
 * in the vocabulary of a definition (`session.resumable`, not `sessionResumable`).
 */

import { PERMISSION_MODELS, RATE_LIMIT_REPORTINGS, SESSION_STORES } from '../types.js';
import { PERMISSION_MODEL_OBLIGATIONS } from '../permission-models.js';
import { declarationProblems } from '../provider-declarations.js';
import { PROVIDER_TRANSPORTS } from './definition.js';

type Loose = Record<string, unknown>;

const isFunction = (v: unknown): boolean => typeof v === 'function';
const isRecord = (v: unknown): v is Loose => v !== null && typeof v === 'object' && !Array.isArray(v);
const THINKING_CONTROLS = ['levels', 'budget', 'toggle'] as const;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function definitionProblems(definition: unknown): string[] {
  if (!isRecord(definition)) return ['a provider definition must be an object'];
  const d = definition;
  const problems: string[] = [];

  if (typeof d.id !== 'string' || !ID.test(d.id)) problems.push('`id` must be 1 to 64 lowercase letters, digits, `.`, `_` or `-`');

  const transport = isRecord(d.transport) ? d.transport.kind : undefined;
  const codec = isRecord(d.codec) ? d.codec : undefined;
  const codecKind = codec?.kind;
  if (!(PROVIDER_TRANSPORTS as readonly unknown[]).includes(transport)) {
    problems.push(`\`transport.kind\` is ${JSON.stringify(transport)}; it must be one of ${PROVIDER_TRANSPORTS.map((t) => `'${t}'`).join(', ')}`);
  }
  if (codecKind !== 'lines' && codecKind !== 'driver') {
    problems.push(`\`codec.kind\` is ${JSON.stringify(codecKind)}; it must be 'lines' or 'driver'`);
  }
  const persistent = transport === 'stdio-persistent';
  const remote = transport === 'remote';
  if (remote && codecKind === 'lines') {
    problems.push('a `remote` provider has no process, hence no lines to read: its codec must be `driver`, which opens the connection');
  }
  if (transport === 'process-per-turn' && codecKind === 'driver') {
    problems.push('`codec: driver` drives a process that outlives a turn: it needs `transport: stdio-persistent` (a one-shot process would be respawned under it)');
  }

  if (codecKind === 'lines' && codec) {
    for (const key of ['parseLine', 'extractSessionId'] as const) {
      if (!isFunction(codec[key])) problems.push(`\`codec.${key}\` must be a function`);
    }
    if (persistent && !isFunction(codec.writeUserInput)) {
      problems.push('`codec.writeUserInput` must be a function: it is how a follow-up turn reaches a persistent process');
    }
  }
  if (codecKind === 'driver' && codec) {
    if (!isFunction(codec.openSession)) problems.push('`codec.openSession` must be a function: it returns the session driver');
    if (codec.extractSessionId !== undefined && !isFunction(codec.extractSessionId)) problems.push('`codec.extractSessionId` is declared but is not a function');
  }

  const declares = isRecord(d.declares) ? d.declares : undefined;
  problems.push(...declarationProblems(d.declares, typeof d.id === 'string' ? d.id : undefined));

  if (!remote) {
    if (!isFunction(d.launch)) problems.push('`launch` must be a function: it builds the command of one launch (the daemon spawns it)');
    const names = isRecord(declares?.binary) ? declares.binary.names : undefined;
    if (!Array.isArray(names) || names.length === 0) {
      problems.push('a provider that owns a process must name its binary in `declares.binary.names`: the daemon resolves it, and the manifest\'s `provider.binaries` lets the operator authorize it');
    }
  }

  if (remote && declares?.accounts !== undefined) {
    problems.push('`declares.accounts` signs a CLI in: a `remote` provider has no CLI, its sign-in is the connection\'s own');
  }

  const session = isRecord(d.session) ? d.session : undefined;
  if (!session) problems.push('`session` is missing: say where the conversation lives and whether a new process finds it again');
  else {
    if (!(SESSION_STORES as readonly unknown[]).includes(session.store)) {
      problems.push(`\`session.store\` is ${JSON.stringify(session.store)}; it must be one of ${SESSION_STORES.map((s) => `'${s}'`).join(', ')}`);
    }
    if (typeof session.resumable !== 'boolean') problems.push('`session.resumable` must be true or false');
    if (persistent && session.resumable === false) {
      problems.push('`transport: stdio-persistent` with `session.resumable: false`: the process can die (crash, restart) and the conversation with it; declare how a new process finds it again');
    }
    if (session.store === 'global' && session.resumable === false) {
      problems.push("`session.store: 'global'` keeps the session outside the mission, so it is resumable by construction: declare `session.resumable: true`");
    }
    if (session.notFound !== undefined && !isFunction(session.notFound)) {
      problems.push('`session.notFound` is declared but is not a function');
    }
    if (session.setModel !== undefined) {
      if (!isFunction(session.setModel)) problems.push('`session.setModel` is declared but is not a function');
      else if (!persistent) problems.push('`session.setModel` switches the model of a live process: without `transport: stdio-persistent` there is none, the next turn is a new launch');
    }
    if (session.compact !== undefined) {
      const command = isRecord(session.compact) ? session.compact.command : undefined;
      if (typeof command !== 'string' || command.trim() === '') {
        problems.push('`session.compact` must be `{ command: string }`: the non-empty message that makes the agent compact its own session');
      }
    }
    if (session.rewind !== undefined && !isFunction(session.rewind)) {
      problems.push('`session.rewind` is declared but is not a function');
    }
    if (session.maxPromptBytes !== undefined && !(Number.isInteger(session.maxPromptBytes) && (session.maxPromptBytes as number) > 0)) {
      problems.push('`session.maxPromptBytes` must be a positive whole number of bytes');
    }
  }

  const permission = isRecord(d.permission) ? d.permission : undefined;
  if (!permission) problems.push('`permission` is missing: say how tool uses are arbitrated');
  else {
    if (!(PERMISSION_MODELS as readonly unknown[]).includes(permission.model)) {
      problems.push(`\`permission.model\` is ${JSON.stringify(permission.model)}; it must be one of ${PERMISSION_MODELS.map((p) => `'${p}'`).join(', ')}`);
    }
    if (permission.model === 'protocol' && codecKind !== 'driver') {
      problems.push(`\`permission.model: 'protocol'\` needs \`codec: driver\`: it must ${PERMISSION_MODEL_OBLIGATIONS.protocol}`);
    }
    if (permission.byAgent !== undefined) {
      if (typeof permission.byAgent !== 'boolean' && !isFunction(permission.byAgent)) problems.push('`permission.byAgent` must be true, false or a function of the profile id');
      else if (permission.byAgent !== false && permission.model !== 'protocol') {
        problems.push("`permission.byAgent` says the agent arbitrates its own tool uses, which only a session protocol can express: declare `permission.model: 'protocol'` with `codec: driver`");
      }
    }
    if (permission.appliesMode !== undefined) {
      if (typeof permission.appliesMode !== 'boolean') problems.push('`permission.appliesMode` must be true or false');
      else if (permission.appliesMode && (permission.model !== 'protocol' || (permission.byAgent !== undefined && permission.byAgent !== false))) {
        problems.push("`permission.appliesMode` says the provider applies the permission mode before it asks: it needs `permission.model: 'protocol'` and an agent that asks (no `byAgent`)");
      }
    }
  }

  const limits = isRecord(d.limits) ? d.limits : undefined;
  if (!limits || !(RATE_LIMIT_REPORTINGS as readonly unknown[]).includes(limits.reporting)) {
    problems.push(`\`limits.reporting\` must be one of ${RATE_LIMIT_REPORTINGS.map((r) => `'${r}'`).join(', ')}: it is what tells "no limit hit" from "we have no idea"`);
  }
  if (!isRecord(d.mcp) || typeof d.mcp.timon !== 'boolean') problems.push('`mcp.timon` must be true or false: can Timon\'s own MCP servers be handed to this provider?');

  const optionalMethod = (group: string, key: string): void => {
    const value = d[group];
    if (value === undefined) return;
    if (!isRecord(value) || !isFunction(value[key])) problems.push(`\`${group}.${key}\` must be a function`);
  };
  optionalMethod('usage', 'probe');
  optionalMethod('models', 'discover');
  if (d.lifecycle !== undefined) {
    if (!isRecord(d.lifecycle)) problems.push('`lifecycle` must be an object');
    else for (const key of ['dispose', 'enrich']) {
      if (d.lifecycle[key] !== undefined && !isFunction(d.lifecycle[key])) problems.push(`\`lifecycle.${key}\` is declared but is not a function`);
    }
  }
  if (d.reasoning !== undefined) {
    const controls = isRecord(d.reasoning) ? d.reasoning.controls : undefined;
    if (!Array.isArray(controls) || controls.some((c) => !(THINKING_CONTROLS as readonly unknown[]).includes(c))) {
      problems.push(`\`reasoning.controls\` must list only ${THINKING_CONTROLS.map((c) => `'${c}'`).join(', ')}`);
    }
  }

  // Spans: one place only. A function at the top is the legacy adapter's; a native definition says it in `declares`.
  if (d.spans !== undefined && declares?.spans !== undefined) {
    problems.push('`spans` is declared twice (at the top and in `declares.spans`): keep `declares.spans`');
  }
  const spans = declares?.spans ?? d.spans;
  if (spans !== undefined && spans !== 'stream-json' && !isFunction(spans)) {
    problems.push("`declares.spans` must be 'stream-json' (claude's vocabulary) or a function of the event");
  }

  return problems;
}
