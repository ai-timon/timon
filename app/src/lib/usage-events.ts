/**
 * What the web app tells `@timon/telemetry` about the person using it
 * (`docs/TELEMETRY.md`, catalogue v2): that the app was opened, which page
 * they went to, and the licence offers they looked at. The daemon decides
 * whether anything leaves (sharing preference, destination), reduces a page
 * to its section and counts an opening once a day; this side only reports.
 * A failed report is dropped: analytics never shows an error to anyone.
 */

export type UsageSurface = 'web' | 'desktop';

/** How a screen of the onboarding was shown or left (`onboarding_screen`). */
export type OnboardingScreenAction = 'viewed' | 'completed' | 'skipped' | 'back';

/**
 * What "Choose your LLM" adds when the person goes on: the choice, the CLI
 * found ready (or the one that was not), whether one was, and why not. The
 * daemon maps the CLI to a product backend or `other`; nothing else of it
 * leaves, never a key or an address.
 */
export type OnboardingScreenDetail = {
  llmChoice?: 'plan' | 'local';
  backend?: string;
  connection?: 'ok' | 'failed' | 'unknown';
  failureCode?: 'not_installed' | 'signed_out' | 'unreachable';
};

export type UsageEvent =
  | { name: 'app_opened'; surface: UsageSurface; setupCompleted: boolean; loadMs?: number }
  | { name: 'ui_error'; surface: UsageSurface; path: string }
  | { name: 'page_viewed'; surface: UsageSurface; path: string }
  | { name: 'upgrade_action'; surface: UsageSurface; action: 'plans_viewed' | 'buy_opened'; entryPoint: 'license_page' | 'users' | 'settings' | 'banner' | 'other' }
  | ({ name: 'onboarding_screen'; surface: UsageSurface; screen: string; action: OnboardingScreenAction } & OnboardingScreenDetail);

export const USAGE_EVENT_ROUTE = '/api/ui/telemetry/event';
/** Pages of a signed-out visitor: the daemon would refuse them anyway. */
const SIGNED_OUT = /^\/(?:login|invite|confirm-email)(?:\/|$)/;
/** How often the reporter looks for a client-side navigation. */
export const PAGE_POLL_MS = 1_000;
/** At most one `ui_error` per section in this span: a render loop must not flood. */
export const UI_ERROR_GAP_MS = 60_000;

type Fetcher = (input: string, init: RequestInit) => Promise<unknown>;

export function usageSurface(win: { timonDesktop?: unknown } | undefined = typeof window === 'undefined' ? undefined : window): UsageSurface {
  return win && typeof win.timonDesktop === 'object' && win.timonDesktop !== null ? 'desktop' : 'web';
}

export function reportUsage(event: UsageEvent, fetcher: Fetcher = (input, init) => fetch(input, init)): void {
  try {
    void Promise.resolve(fetcher(USAGE_EVENT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      // The page may be closing: the report still goes.
      keepalive: true,
    })).catch(() => undefined);
  } catch { /* never surfaces */ }
}

/**
 * One screen of the onboarding shown or left. The screens before the account
 * are reported too: the daemon takes this event anonymously while the machine
 * has no account, and drops it when sharing is off.
 */
export function reportOnboardingScreen(
  screen: string, action: OnboardingScreenAction, detail: OnboardingScreenDetail = {}, fetcher?: Fetcher,
): void {
  reportUsage({ name: 'onboarding_screen', surface: usageSurface(), screen, action, ...detail }, fetcher);
}

/** The bits of `window` the reporter reads, injectable for tests. */
export type ReporterHost = {
  location: { pathname: string };
  /** Milliseconds from navigation start to the end of the load, when the browser knows it. */
  loadMs?: () => number | undefined;
  now?: () => number;
  /** `error` and `unhandledrejection`: only that they happened is read, never what they say. */
  onError?: (fn: () => void) => () => void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  addEventListener(type: 'popstate', fn: () => void): void;
  removeEventListener(type: 'popstate', fn: () => void): void;
  timonDesktop?: unknown;
};

/**
 * Reports the opening, then every page change. A client-side navigation
 * changes the path without an event every browser fires, so the path is
 * compared once a second — a string comparison. Returns what stops it.
 */
export function startUsageReporting(host: ReporterHost, fetcher?: Fetcher): () => void {
  const surface = usageSurface(host);
  let last: string | null = null;
  const look = (): void => {
    const path = host.location.pathname;
    if (path === last) return;
    last = path;
    if (!SIGNED_OUT.test(path)) reportUsage({ name: 'page_viewed', surface, path }, fetcher);
  };
  const first = host.location.pathname;
  if (!SIGNED_OUT.test(first)) {
    const loadMs = host.loadMs?.();
    reportUsage({
      name: 'app_opened', surface, setupCompleted: !/^\/setup(?:\/|$)/.test(first),
      ...(typeof loadMs === 'number' && loadMs >= 0 ? { loadMs: Math.round(loadMs) } : {}),
    }, fetcher);
  }
  look();
  const timer = host.setInterval(look, PAGE_POLL_MS);
  // Outside a browser (tests rendering the app under jsdom) the poll must not
  // keep the process alive.
  (timer as { unref?: () => void } | null)?.unref?.();
  host.addEventListener('popstate', look);
  const lastError = new Map<string, number>();
  const stopErrors = host.onError?.(() => {
    const path = host.location.pathname;
    const section = path.split('/')[1] ?? '';
    const now = host.now?.() ?? Date.now();
    if (now - (lastError.get(section) ?? -Infinity) < UI_ERROR_GAP_MS) return;
    lastError.set(section, now);
    reportUsage({ name: 'ui_error', surface, path }, fetcher);
  });
  return () => {
    host.clearInterval(timer);
    host.removeEventListener('popstate', look);
    stopErrors?.();
  };
}

/** The reporter's view of the real page: the global timers, which can be unref'd outside a browser. */
export function windowReporterHost(win: Window & { timonDesktop?: unknown }): ReporterHost {
  return {
    location: win.location,
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
    addEventListener: (type, fn) => win.addEventListener(type, fn),
    removeEventListener: (type, fn) => win.removeEventListener(type, fn),
    timonDesktop: win.timonDesktop,
    now: () => Date.now(),
    loadMs: () => {
      const nav = win.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
      return nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : undefined;
    },
    onError: (fn) => {
      win.addEventListener('error', fn);
      win.addEventListener('unhandledrejection', fn);
      return () => {
        win.removeEventListener('error', fn);
        win.removeEventListener('unhandledrejection', fn);
      };
    },
  };
}
