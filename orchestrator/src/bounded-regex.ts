/**
 * A regular expression from a plugin's declaration, run with a time limit.
 *
 * V8's backtracking engine has no timeout of its own: a pattern like `(.*.*)*!$` on a few dozen characters
 * keeps the daemon's thread busy for minutes, and with it every mission. Here the match runs in a `vm`
 * script whose timeout interrupts it; the daemon goes on and the caller learns the pattern was too slow.
 *
 * `pluginRegex` is what a caller holding a plugin's pattern uses: a pattern that fails (too slow, or not a
 * regular expression) is reported once to the operator, then skipped for as long as the daemon runs, so a
 * bad declaration costs the time limit once instead of at every call, and never blocks what it was checking.
 *
 * The linear engine of trigger filters (`triggers/safe-regex.ts`) was not used: the SDK contracts that
 * hand us these patterns allow the whole RegExp syntax (lookarounds, backreferences), and a server's
 * `ready` pattern hands back its first capture group, which a yes/no automaton cannot give.
 */
import { daemonMessage } from './daemon-message.js';
import { createContext, Script } from 'node:vm';

/** A declared pattern matched against a few kilobytes takes microseconds; past this, it is backtracking out of control. */
export const REGEX_TIMEOUT_MS = 250;

export class SlowRegexError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the regular expression ran past ${timeoutMs} ms`);
    this.name = 'SlowRegexError';
  }
}

export type BoundedRegex = {
  test(subject: string): boolean;
  /** The first capture group when it took part in the match, else the whole match; `null` when nothing matched. */
  firstGroup(subject: string): string | null;
};

const COMPILE = new Script('re = new RegExp(pattern, flags);');
const TEST = new Script('re.test(subject)');
const FIRST_GROUP = new Script('(() => { const m = re.exec(subject); return m === null ? null : (m[1] ?? m[0]); })()');

/**
 * Throws a `SyntaxError` of this realm when `pattern` is not a regular expression; `test` and `firstGroup`
 * throw `SlowRegexError` past `timeoutMs`. The context is made once, so a caller testing every chunk of a
 * process's output does not pay a new realm each time.
 */
export function compileBoundedRegex(pattern: string, flags = '', timeoutMs: number = REGEX_TIMEOUT_MS): BoundedRegex {
  // Compiling is linear in the pattern; doing it here first gives the caller a SyntaxError it can recognise.
  new RegExp(pattern, flags);
  const sandbox: { pattern: string; flags: string; subject: string } = { pattern, flags, subject: '' };
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const run = (script: Script, subject: string): unknown => {
    sandbox.subject = subject;
    try {
      return script.runInContext(context, { timeout: timeoutMs });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new SlowRegexError(timeoutMs);
      throw error;
    } finally {
      sandbox.subject = '';
    }
  };
  run(COMPILE, '');
  return {
    test: (subject) => run(TEST, subject) === true,
    firstGroup(subject) {
      const found = run(FIRST_GROUP, subject);
      return typeof found === 'string' ? found : null;
    },
  };
}

/** Where a plugin's pattern comes from: named in the alert, so the operator knows whom to ask. */
export type PluginPatternOrigin = {
  readonly pluginId: string;
  readonly place: 'webhook-secret' | 'ready';
  /** The webhook format, or the program the server runs. */
  readonly name: string;
};

export type PluginPatternFailure = 'timeout' | 'invalid';

export type PluginRegex = {
  /**
   * Set once the pattern failed for this origin, in this call or an earlier one: it is no longer run, and the
   * caller skips the check it was for.
   */
  readonly failed: boolean;
  /** `false` once failed: read `failed` before trusting it. */
  test(subject: string): boolean;
  /** `null` once failed: read `failed` before trusting it. */
  firstGroup(subject: string): string | null;
};

/** Patterns that failed since the daemon started, by origin and pattern. Never written to disk: a restart tries again. */
const FAILED = new Map<string, PluginPatternFailure>();
let alerts: Promise<void> = Promise.resolve();

function failureKey(origin: PluginPatternOrigin, pattern: string, flags: string): string {
  return [origin.pluginId, origin.place, origin.name, flags, pattern].join('\0');
}

const PLACE_LABEL: Record<PluginPatternOrigin['place'], string> = {
  'webhook-secret': 'webhook secret pattern',
  ready: 'server ready pattern',
};

/** Names the plugin, the place and the reason; never the pattern's subject, which may be a secret. */
export function pluginPatternNotice(origin: PluginPatternOrigin, failure: PluginPatternFailure): { title: string; body: string } {
  const label = PLACE_LABEL[origin.place];
  const why = failure === 'timeout'
    ? `It ran past ${REGEX_TIMEOUT_MS} ms and was stopped.`
    : 'It is not a valid regular expression.';
  const skipped = origin.place === 'ready'
    ? 'The server is handed over without waiting for its ready line.'
    : 'Pasted secrets are accepted without this format check.';
  return {
    title: `Plugin \`${origin.pluginId}\`: its ${label} for \`${origin.name}\` is ignored`,
    body: `${why} ${skipped} The check stays off until the daemon restarts; ask the plugin's author for a simpler pattern.`,
  };
}

function recordFailure(key: string, origin: PluginPatternOrigin, failure: PluginPatternFailure): void {
  if (FAILED.has(key)) return;
  FAILED.set(key, failure);
  const { title, body } = pluginPatternNotice(origin, failure);
  console.warn(`[plugins] ${title}: ${failure}`);
  // Fire-and-forget, imported late: the check that hit the pattern must go on whether the centre runs or not.
  alerts = alerts
    .then(() => import('./notifications.js'))
    .then(({ createNotification }) => {
      createNotification({
        type: 'alert', urgent: false, title, body, source: `plugin:${origin.pluginId}`,
        message: daemonMessage('plugin_pattern_ignored', {
          pluginId: origin.pluginId,
          place: origin.place === 'ready' ? 'ready' : 'webhook_secret',
          name: origin.name,
          failure,
          timeoutMs: REGEX_TIMEOUT_MS,
        }),
      });
    })
    .catch((error: unknown) => { console.warn(`[plugins] could not raise the pattern alert: ${(error as Error).message}`); });
}

/** Resolves once every alert raised so far is written; tests await it instead of polling. */
export function pluginPatternAlertsSettled(): Promise<void> {
  return alerts;
}

/** Tests only: forget the failures, as a restart would. */
export function resetPluginPatternFailures(): void {
  FAILED.clear();
}

/**
 * A plugin's pattern that never throws: a failure is recorded, alerted once, and turns the pattern off for this
 * origin. A pattern already off is not compiled again.
 */
export function pluginRegex(origin: PluginPatternOrigin, pattern: string, flags = '', timeoutMs: number = REGEX_TIMEOUT_MS): PluginRegex {
  const key = failureKey(origin, pattern, flags);
  const fail = (error: unknown): void => recordFailure(key, origin, error instanceof SlowRegexError ? 'timeout' : 'invalid');
  let compiled: BoundedRegex | null = null;
  if (!FAILED.has(key)) {
    try { compiled = compileBoundedRegex(pattern, flags, timeoutMs); } catch (error) { fail(error); }
  }
  const run = <T>(use: (re: BoundedRegex) => T, otherwise: T): T => {
    if (compiled === null || FAILED.has(key)) return otherwise;
    try { return use(compiled); } catch (error) { fail(error); return otherwise; }
  };
  return {
    get failed() { return FAILED.has(key); },
    test: (subject) => run((re) => re.test(subject), false),
    firstGroup: (subject) => run((re) => re.firstGroup(subject), null),
  };
}
