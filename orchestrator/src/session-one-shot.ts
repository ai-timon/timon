/**
 * A one-shot prompt on a session-driven backend (`Backend.openSession`: ACP —
 * opencode, Hermes, Pi): the same job as `runOneShot` (`summary.ts`), over the
 * backend's own `SessionDriver` instead of `parseLine`.
 *
 * Why it exists (TIM-0129): such an agent answers nothing until a client writes
 * the `initialize` handshake. Read as a line-oriented CLI, it waited for one that
 * never came, and a compaction sat on "Compacting…" until the summariser timeout
 * (300 s). Here the driver opens a throwaway session (initialize, session/new,
 * model), sends ONE prompt and collects the assistant's text until the turn ends;
 * then the process is stopped, whatever happened.
 *
 * What the summariser may do: nothing. Every permission request is refused
 * (`requestPermission` → deny), no Timon server is declared (the launch holds no
 * token), and the prompt carries the whole input. An agent that arbitrates its own
 * tool uses (`permissionsByAgent`) never asks: its provider confines it at launch
 * instead (`BuildSpawnOpts.oneShot` → `AcpAgentSpec.oneShotEnv`, opencode; the launch
 * arguments, Pi). Of the reply, only the text after the last tool call is kept.
 *
 * Failing fast and readably: the session must open within `openTimeoutMs`, a
 * process that exits rejects at once with the end of its stderr, a JSON-RPC error
 * ends the one-shot with that error.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { assertSpawnPinned } from './backends/sealed-spawn.js';
import type { Backend, BuildSpawnOpts, NormalizedEvent, SessionDriver, SpawnResult } from './backends/types.js';
import { getHost } from './host/index.js';
import { killProcessTree } from './host/kill-tree.js';
import { stderrExcerpt } from './agent.js';
import { redactText } from './secrets/redact.js';
import { recordOneShotProcess } from './mission-fence-state.js';

/** How long a stopped agent gets to exit on SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 2_000;
const ERROR_MAX = 300;
/** A driver learns the pipe closed a moment before the exit is known; the exit says how, and stderr why. */
const EXIT_SETTLE_MS = 500;

export type SessionOneShotArgs = {
  readonly backend: Backend;
  readonly spawnOpts: BuildSpawnOpts;
  /** What `buildSealedSpawn` returned for this launch. */
  readonly spec: SpawnResult;
  readonly env: NodeJS.ProcessEnv;
  /** Handshake + `session/new` + model, from the spawn. */
  readonly openTimeoutMs: number;
  /** The whole one-shot, from the spawn; absent = only the driver's own idle limit. */
  readonly timeoutMs?: number;
  /** Seal and scratch folder of the launch; called more than once, so idempotent. */
  release(): void;
};

function oneLine(text: string): string {
  const flat = redactText(text).replace(/\s+/g, ' ').trim();
  return flat.length > ERROR_MAX ? `${flat.slice(0, ERROR_MAX)}…` : flat;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => {
      const block = b as { type?: unknown; text?: unknown } | null;
      return block?.type === 'text' && typeof block.text === 'string';
    })
    .map((b) => b.text)
    .join('\n');
}

function hasToolUse(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => (b as { type?: unknown } | null)?.type === 'tool_use');
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)}s`;
}

/** Rejects after `ms`, with `message`; `cancel` disarms it. */
function deadline(ms: number, message: () => string): { promise: Promise<never>; cancel(): void } {
  let timer: NodeJS.Timeout | null = null;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), ms);
  });
  promise.catch(() => undefined);
  return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}

export async function runSessionOneShot(args: SessionOneShotArgs): Promise<string> {
  const { backend, spawnOpts, spec } = args;
  if (!backend.openSession) throw new Error(`backend ${backend.name} has no session driver`);
  const started = Date.now();

  let proc: ChildProcessWithoutNullStreams;
  try {
    assertSpawnPinned(spec);
    proc = getHost().spawn(spec.cmd, spec.args, {
      cwd: spec.cwd ?? spawnOpts.cfg.cwd ?? process.cwd(),
      env: args.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    args.release();
    throw err;
  }
  // Never fenced: on an account, it may rewrite the account's keychain entry, which no move may then delete.
  recordOneShotProcess(spawnOpts.missionId, backend.name, proc);
  // Again once the streams are closed: an agent stopped mid-write may still have
  // been writing in its folder when the first release removed it.
  proc.once('close', () => args.release());

  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    process.stderr.write(`[summary] ${d}`);
    stderrTail = (stderrTail + String(d)).slice(-2000);
  });
  const why = (): string => {
    const tail = stderrExcerpt(stderrTail).replace(/\s+/g, ' ').trim();
    return tail ? `: ${tail.length > ERROR_MAX ? `…${tail.slice(-ERROR_MAX)}` : tail}` : '';
  };

  // The process going away ends the one-shot now, not when a request times out.
  let exited = false;
  const gone = new Promise<never>((_, reject) => {
    proc.once('exit', (code, signal) => {
      exited = true;
      const how = signal ? `signal ${signal}` : `code ${code ?? '?'}`;
      reject(new Error(`the ${backend.name} agent stopped (${how}) before answering${why()}`));
    });
    proc.once('error', (err) => {
      exited = true;
      reject(err);
    });
  });
  gone.catch(() => undefined);
  const orExit = <T>(work: Promise<T>): Promise<T> => work.catch(async (err: unknown) => {
    const died = await Promise.race([
      gone.then(() => null, (e: unknown) => e as Error),
      new Promise<null>((r) => { setTimeout(() => r(null), EXIT_SETTLE_MS).unref?.(); }),
    ]);
    throw died ?? err;
  });

  let text = '';
  // Only the text after the agent's last tool call is the answer: what it said before one (an
  // injected "let me run…" whose call was refused) must not end up in the summary.
  let afterTool = false;
  let resultError: string | null = null;
  let resultText = '';
  const emit = (ev: NormalizedEvent): void => {
    const payload = ev.payload as { message?: { content?: unknown }; is_error?: unknown; error?: unknown; result?: unknown } | null;
    if (ev.type === 'assistant') {
      const content = payload?.message?.content;
      if (hasToolUse(content)) {
        afterTool = true;
        return;
      }
      const t = textOf(content);
      if (!t) return;
      // A reasoning block between two runs of text splits them in the stream, not in the answer.
      text = afterTool ? t : text + (text ? '\n' : '') + t;
      afterTool = false;
    } else if (ev.type === 'result') {
      if (typeof payload?.result === 'string') resultText = payload.result;
      if (payload?.is_error === true) {
        resultError = oneLine(typeof payload.error === 'string' && payload.error.trim() ? payload.error : 'unknown error');
      }
    }
  };

  let driver: SessionDriver | null = null;
  let turnLimit: ReturnType<typeof deadline> | null = null;
  try {
    driver = backend.openSession({
      io: { stdin: proc.stdin, stdout: proc.stdout },
      spawn: spawnOpts,
      host: {
        emit,
        // The summariser has nothing to run, read or write: every tool use is refused, and the agent answered now.
        requestPermission: async (req) => {
          console.warn(`[summary] ${backend.name}: refused ${req.tool} in a one-shot prompt`);
          return { allow: false };
        },
      },
    });

    const open = deadline(args.openTimeoutMs, () =>
      `no answer to the session handshake within ${duration(args.openTimeoutMs)}`);
    try {
      await Promise.race([orExit(driver.start()), open.promise, gone]);
    } catch (err) {
      const message = (err as Error).message;
      throw new Error(exited ? message : `the ${backend.name} session did not open: ${message}${why()}`);
    } finally {
      open.cancel();
    }

    if (args.timeoutMs && args.timeoutMs > 0) {
      const left = Math.max(0, args.timeoutMs - (Date.now() - started));
      turnLimit = deadline(left, () => `oneShot timeout after ${duration(args.timeoutMs!)}`);
    }
    const outcome = await Promise.race([
      orExit(driver.prompt(spawnOpts.message)),
      gone,
      ...(turnLimit ? [turnLimit.promise] : []),
    ]);
    if (resultError) throw new Error(`summary failed: ${resultError}`);
    if (outcome.stopReason === 'cancelled') throw new Error(`summary failed: the ${backend.name} turn was cancelled`);
    const out = (text.trim() || resultText.trim());
    if (!out) throw new Error('summary returned empty text');
    return out;
  } finally {
    turnLimit?.cancel();
    try { driver?.close(); } catch { /* the pipes are going anyway */ }
    stop(proc, exited);
    args.release();
  }
}

/** The runner owns the process, not the driver: stop it, the tree with it on Windows. */
function stop(proc: ChildProcessWithoutNullStreams, exited: boolean): void {
  if (exited || proc.exitCode !== null || proc.signalCode !== null) return;
  killProcessTree(proc);
  const hard = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, STOP_GRACE_MS);
  hard.unref?.();
  proc.once('exit', () => clearTimeout(hard));
}
