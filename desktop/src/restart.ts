import { isAbsolute } from 'node:path';
import type { HealthResult } from './health.js';
import { shellText } from './shell-i18n.js';

export const SETUP_RESTART_CHANNEL = 'timon:restart-after-setup';
export const SETUP_RESTART_STATUS_CHANNEL = 'timon:setup-restart-pending';
export const SETUP_HANDOVER_CHANNEL = 'timon:setup-handover';

/** Only a bootstrap daemon needs handover; a normal portable launch stays quiet. */
export function setupRestartPending(state: { embedded: boolean; configuredAtLaunch: boolean; configuredNow: boolean; serviceInstalled: boolean }): boolean {
  return state.embedded && state.configuredNow && (!state.configuredAtLaunch || state.serviceInstalled);
}

export function canRestartFromSetup(sender: {
  isWindow: boolean;
  isMainFrame: boolean;
  url: string;
}, uiOrigin: string): boolean {
  if (!sender.isWindow || !sender.isMainFrame) return false;
  try {
    const url = new URL(sender.url);
    // Navigation after setup must retain the action. Authority remains bound
    // to the trusted main frame and exact app origin, never a browser tab.
    return url.origin === new URL(uiOrigin).origin;
  } catch { return false; }
}

export function relaunchOptions(platform: string, env: NodeJS.ProcessEnv, argv: string[]): {
  execPath?: string;
  args: string[];
} {
  // The mounted Electron binary disappears when an AppImage exits. Relaunch
  // its original file, without re-evaluating the launching shell command.
  const appImage = platform === 'linux' ? env.APPIMAGE : undefined;
  if (appImage && !isAbsolute(appImage)) throw new Error('The AppImage path is not absolute.');
  return { ...(appImage ? { execPath: appImage } : {}), args: argv.slice(1) };
}

/** A double click must never schedule two replacements of the same shell. */
export function setupRestarter(actions: {
  validate: () => void;
  stopEmbedded: () => Promise<void>;
  relaunch: () => void | (() => void) | Promise<void | (() => void)>;
  quit: () => void;
  /** True when an installed service, not an embedded child, runs the daemon. */
  serviceOwnsDaemon?: () => boolean;
  restartService?: () => Promise<void>;
}): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    let cancel: void | (() => void);
    pending ??= Promise.resolve().then(async () => {
      actions.validate();
      // Relaunching the shell would leave that service untouched, and the page
      // would come back to the same step forever. Restart the service instead;
      // the page is already waiting for a new daemon to answer.
      if (actions.serviceOwnsDaemon?.() && actions.restartService) {
        await actions.restartService();
        pending = undefined;
        return;
      }
      await actions.stopEmbedded();
      cancel = await actions.relaunch();
      actions.quit();
    }).catch((error: unknown) => {
      cancel?.();
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/**
 * Does the end of a first setup hand the embedded daemon's place to the
 * service the wizard just installed? Left running, the embedded daemon served
 * step 3 while the service crash-looped beside it on the same database, and
 * each of its boots failed the setup mission, whose token then got 401s.
 *
 * Never on a portable install (no supervisor, or Windows refused the task,
 * TODO #342), and never when the service would answer on other ports than
 * the ones the window uses: stopping the embedded daemon would gain nothing.
 */
export function serviceHandoverNeeded(state: {
  embedded: boolean;
  configuredAtLaunch: boolean;
  configuredNow: boolean;
  serviceInstalled: boolean;
  serviceRefused: boolean;
  supervisor: string;
  sameOrigins: boolean;
}): boolean {
  return state.embedded && !state.configuredAtLaunch && state.configuredNow && state.serviceInstalled
    && !state.serviceRefused && state.supervisor !== 'none' && state.sameOrigins;
}

/** Where the page asks to land once the service answers: a path of the interface, never a URL. */
export function handoverRoute(route: unknown, origin: string): string | null {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.includes('\\')) return null;
  try {
    const url = new URL(route, origin);
    return url.origin === new URL(origin).origin ? `${url.pathname}${url.search}` : null;
  } catch { return null; }
}

export type HandoverOutcome = 'not-needed' | 'handed-over' | 'kept-embedded';

/**
 * The embedded daemon gives its place to the installed service, in the running
 * shell. Not a relaunch (`setupRestarter`): a relaunched shell whose service
 * does not answer ends on a dead window, while this one can start its embedded
 * daemon again and keep the setup going.
 *
 * The pages move to the waiting page BEFORE the daemon stops: a page still on
 * the interface when its port closes retries, then reports a failure.
 */
export function serviceHandover(actions: {
  needed: () => boolean;
  showRestarting: (route: string) => void;
  stopEmbedded: () => Promise<void>;
  /** Starts the service now rather than at its supervisor's next attempt; `false` when it cannot start. */
  kickService: () => Promise<boolean>;
  /** The service answers as this home's daemon within the budget. */
  waitService: () => Promise<boolean>;
  /** The service answers: the pages load the interface again. */
  resume: () => void;
  /**
   * The service's process may outlive the wait: ended before the embedded
   * daemon starts again. Left alone, a service daemon that took the home
   * makes each embedded start exit refused, until its supervisor gives up
   * and reports a crash loop while the service is about to answer.
   */
  releaseService?: () => Promise<void>;
  /**
   * It does not: the embedded daemon serves again, and the pages follow it.
   * `'service'` when, starting, it found the service answering after all and
   * opened the pages on it: the handover happened, late.
   */
  resumeEmbedded: () => Promise<'embedded' | 'service' | void>;
  reportKept: (why: string | null) => void;
}): (route: string) => Promise<HandoverOutcome> {
  let pending: Promise<HandoverOutcome> | undefined;
  return (route) => {
    pending ??= (async (): Promise<HandoverOutcome> => {
      if (!actions.needed()) return 'not-needed';
      actions.showRestarting(route);
      try {
        await actions.stopEmbedded();
      } catch (error) {
        // Still the embedded daemon's: the pages go back to it.
        actions.resume();
        throw error;
      }
      let why: string | null = null;
      let answered = false;
      try {
        answered = await actions.kickService() && await actions.waitService();
      } catch (error) { why = (error as Error).message; }
      if (answered) {
        actions.resume();
        return 'handed-over';
      }
      await actions.releaseService?.().catch(() => undefined);
      if (await actions.resumeEmbedded() === 'service') return 'handed-over';
      actions.reportKept(why);
      return 'kept-embedded';
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

/** Clock seams of the handover waits: tests run them on a fake clock. */
export type WaitClock = { now: () => number; sleep: (ms: number) => Promise<void> };
const realClock: WaitClock = { now: () => Date.now(), sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

/**
 * Waits for the service the way `waitForHealth` does, `baseMs` first, then
 * on for as long as `stillBooting` says its process lives, `maxMs` at most.
 * A flat 90 s gave up on a Windows 10 PC whose service answered a minute
 * later (TIM-0158): a first boot there verifies its release and loads its
 * plugins under the antivirus' eye, and nothing was wrong with it.
 */
export async function waitWhileBooting(opts: {
  probe: () => Promise<HealthResult>;
  /** Asked past `baseMs`, every `recheckMs`: never at each probe, a query can take a second. */
  stillBooting: () => Promise<boolean>;
  baseMs: number;
  maxMs: number;
  intervalMs?: number;
  recheckMs?: number;
  clock?: WaitClock;
}): Promise<{ health: HealthResult; waitedMs: number; extended: boolean }> {
  const clock = opts.clock ?? realClock;
  const interval = opts.intervalMs ?? 300;
  const recheck = opts.recheckMs ?? 10_000;
  const start = clock.now();
  let checkedAt = Number.NEGATIVE_INFINITY;
  let booting = false;
  let extended = false;
  for (;;) {
    const health = await opts.probe();
    const waitedMs = clock.now() - start;
    // A foreign server answering here will not become Timon by waiting.
    if (health.ok) return { health, waitedMs, extended };
    if (waitedMs + interval >= opts.maxMs) return { health, waitedMs, extended };
    if (waitedMs + interval >= opts.baseMs) {
      if (clock.now() - checkedAt >= recheck) {
        booting = await opts.stillBooting().catch(() => false);
        checkedAt = clock.now();
        extended ||= booting;
      }
      if (!booting) return { health, waitedMs, extended };
    }
    await clock.sleep(interval);
  }
}

export type LateHandoverEnd = 'handed-over' | 'not-needed' | 'gave-up' | 'stopped' | 'failed';

/**
 * After a handover that kept the embedded daemon: the service may come up
 * later, and its supervisor keeps starting it. Each start is refused the home
 * the embedded daemon holds and leaves a mark (orchestrator `home-lock.ts`),
 * which proves the service runs and only waits for the home. The handover is
 * then made again, in the same window, rather than leaving the service and
 * the embedded daemon on one home until the user quits and reopens Timon.
 *
 * Bounded: `attempts` handovers at most, each watch ending `maxMs` after the
 * last fallback. A service that never shows up costs a file read every
 * `intervalMs`, nothing else.
 */
export function lateHandover(actions: {
  /** The service was refused the home at or after `since` (epoch ms). */
  serviceWaiting: (since: number) => boolean;
  handover: () => Promise<HandoverOutcome>;
  log?: (line: string) => void;
  clock?: WaitClock;
  intervalMs?: number;
  maxMs?: number;
  attempts?: number;
}): { start: (since: number) => Promise<LateHandoverEnd> | null; stop: () => void } {
  const clock = actions.clock ?? realClock;
  const interval = actions.intervalMs ?? 30_000;
  const maxMs = actions.maxMs ?? 30 * 60_000;
  const attempts = actions.attempts ?? 2;
  const log = actions.log ?? (() => undefined);
  let running: Promise<LateHandoverEnd> | null = null;
  let stopped = false;
  let made = 0;
  const watch = async (from: number): Promise<LateHandoverEnd> => {
    let since = from;
    let deadline = clock.now() + maxMs;
    for (;;) {
      await clock.sleep(interval);
      if (stopped) return 'stopped';
      if (clock.now() >= deadline) { log(`no sign of the service in ${Math.round(maxMs / 60_000)} min, watch ended`); return 'gave-up'; }
      if (!actions.serviceWaiting(since)) continue;
      made += 1;
      log(`the service was refused the home, handing over again (attempt ${made} of ${attempts})`);
      let outcome: HandoverOutcome;
      try { outcome = await actions.handover(); } catch (error) {
        log(`the handover failed: ${(error as Error).message}`);
        return 'failed';
      }
      if (outcome !== 'kept-embedded') return outcome;
      if (made >= attempts || stopped) return stopped ? 'stopped' : 'gave-up';
      since = clock.now();
      deadline = since + maxMs;
    }
  };
  return {
    // Called again by the fallback of a late handover: the watch running already covers it.
    start: (since) => {
      if (running || stopped || made >= attempts) return null;
      running = watch(since).finally(() => { running = null; });
      return running;
    },
    stop: () => { stopped = true; },
  };
}

/** Said when the service did not take over: the setup goes on, on the embedded daemon. */
export function handoverKeptMessage(locale: string, home: string, why: string | null): { message: string; detail: string } {
  const t = shellText(locale);
  const reason = why ? `\n\n${why}` : '';
  return { message: t('service.handoverKept'), detail: `${t('service.handoverKeptDetail', { home })}${reason}` };
}
