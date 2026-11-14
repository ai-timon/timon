/**
 * Does a dialect's declaration agree with what it provides?
 *
 * `assertDialectShape` (the registry) checks the SHAPE: required members present
 * and callable. This is the other half: a declared capability without the member
 * that serves it is a dialect that registers, launches a mission and dies at the
 * first event, far from the plugin that caused it. Each rule below names the
 * declaration, the missing piece and what to do — they are read by a plugin
 * author, in a log line or in the conformance suite.
 *
 * Pure, with no registry behind it: the daemon applies it at registration and
 * the SDK hands the same function to the author's own tests. It reads a
 * declaration, not a stream: what a dialect emits and in which order is the
 * conformance bench's (`lineProviderChecks`).
 */

import {
  PERMISSION_MODELS, RATE_LIMIT_REPORTINGS, SESSION_STORES,
} from './types.js';
import { nestedSandboxProblems, PERMISSION_MODEL_OBLIGATIONS } from './permission-models.js';

const THINKING_CONTROLS = ['levels', 'budget', 'toggle'] as const;

const OPTIONAL_FUNCTIONS = [
  'accountUsage', 'discoverModels', 'permissionsByAgent', 'spans', 'enrichEvent', 'dispose', 'setModel',
  'isSessionNotFoundError', 'openSession',
] as const;

type Loose = Record<string, unknown>;

const isFunction = (v: unknown): boolean => typeof v === 'function';

/**
 * What is incoherent in `dialect`, as readable sentences; empty = coherent.
 * Takes `unknown` on purpose: a plugin written in JavaScript owes the type
 * system nothing, and this is the place that says so politely.
 */
export function dialectProblems(dialect: unknown): string[] {
  if (dialect === null || typeof dialect !== 'object') return ['a dialect must be an object'];
  const d = dialect as Loose;
  const problems: string[] = [];
  const remote = d.transport === 'remote';

  const oneOf = (key: string, allowed: readonly string[]) => {
    if (!allowed.includes(d[key] as string)) {
      problems.push(`\`${key}\` is ${JSON.stringify(d[key])}; it must be one of ${allowed.map((a) => `'${a}'`).join(', ')}`);
    }
  };
  oneOf('sessionStore', SESSION_STORES);
  oneOf('permissionModel', PERMISSION_MODELS);
  oneOf('rateLimitReporting', RATE_LIMIT_REPORTINGS);

  for (const key of OPTIONAL_FUNCTIONS) {
    if (d[key] !== undefined && !isFunction(d[key])) problems.push(`\`${key}\` is declared but is not a function`);
  }
  if (typeof d.hostedConnectors !== 'boolean') problems.push('`hostedConnectors` must be true or false');
  if (typeof d.sessionResumable !== 'boolean') problems.push('`sessionResumable` must be true or false');

  if (d.permissionModel === 'protocol' && !isFunction(d.openSession)) {
    problems.push(`\`permissionModel: 'protocol'\` needs \`openSession\`: it must ${PERMISSION_MODEL_OBLIGATIONS.protocol}`);
  }
  if (isFunction(d.permissionsByAgent) && d.permissionModel !== 'protocol') {
    problems.push("`permissionsByAgent` says the agent arbitrates its own tool uses, which only a session protocol can express: declare `permissionModel: 'protocol'` with an `openSession`");
  }
  if (d.thinkingControls !== undefined) {
    const controls = d.thinkingControls;
    if (!Array.isArray(controls) || controls.some((c) => !(THINKING_CONTROLS as readonly unknown[]).includes(c))) {
      problems.push(`\`thinkingControls\` must list only ${THINKING_CONTROLS.map((c) => `'${c}'`).join(', ')}`);
    }
  }

  if (remote) return problems;

  // A process: who owns it, and whether its end ends the mission.
  if (typeof d.persistentProcess !== 'boolean') problems.push('`persistentProcess` must be true or false');
  if (typeof d.finishMissionOnExit !== 'boolean') problems.push('`finishMissionOnExit` must be true or false');
  if (typeof d.persistentProcess === 'boolean' && typeof d.finishMissionOnExit === 'boolean'
    && d.persistentProcess !== d.finishMissionOnExit) {
    problems.push(d.persistentProcess
      ? '`persistentProcess: true` with `finishMissionOnExit: false` describes no provider: a process that lives for the whole mission ends the mission when it exits'
      : '`persistentProcess: false` with `finishMissionOnExit: true` describes no provider: with one process per turn the mission survives each exit, so `finishMissionOnExit` must be false');
  }
  if (typeof d.defaultCmd !== 'string' || d.defaultCmd.trim() === '') problems.push('`defaultCmd` must name the binary to launch');
  if (d.persistentProcess === true && d.sessionResumable === false) {
    problems.push('`persistentProcess: true` with `sessionResumable: false`: the process can die (crash, restart) and the conversation with it; declare how a new process finds it again');
  }
  if (d.sessionStore === 'global' && d.sessionResumable === false) {
    problems.push("`sessionStore: 'global'` keeps the session outside the mission, so it is resumable by construction: declare `sessionResumable: true`");
  }
  if (isFunction(d.openSession) && d.persistentProcess !== true) {
    problems.push('`openSession` drives a process that outlives a turn: it needs `persistentProcess: true`');
  }
  if (isFunction(d.setModel) && d.persistentProcess !== true) {
    problems.push('`setModel` switches the model of a live process: without `persistentProcess: true` there is none, the next turn is a new launch');
  }
  if (d.nestedSandbox !== undefined) problems.push(...nestedSandboxProblems(d.nestedSandbox, 'nestedSandbox'));
  if (d.nativeCompact !== undefined) {
    const command = typeof d.nativeCompact === 'object' && d.nativeCompact !== null
      ? (d.nativeCompact as { command?: unknown }).command
      : undefined;
    if (typeof command !== 'string' || command.trim() === '') {
      problems.push('`nativeCompact` must be `{ command: string }`: the non-empty message that makes the agent compact its own session');
    }
  }
  if (d.maxPromptBytes !== undefined && !(Number.isInteger(d.maxPromptBytes) && (d.maxPromptBytes as number) > 0)) {
    problems.push('`maxPromptBytes` must be a positive whole number of bytes');
  }
  return problems;
}
