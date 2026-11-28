import { request } from 'node:http';
import { RELOAD_BUDGET_MS, RELOAD_DELAY_MS } from './window-load.js';
import { waitingUrl, type WaitingStep } from './waiting-page.js';

/** The slice of BrowserWindow the view drives. */
export interface ViewTarget {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<unknown>;
}

/** True once anything answers HTTP on `url`: the port is bound, the page itself is the app's business. */
export function probeUi(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = request(url, { method: 'HEAD', agent: false, timeout: timeoutMs }, (res) => { res.resume(); resolve(true); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    } catch { resolve(false); }
  });
}

export type ViewState = WaitingStep | 'ready';

export type ViewDeps = {
  /**
   * Read at each paint, not once: the end of a first setup shows its page
   * after the onboarding, where the language and the mode may have changed.
   */
  locale: () => string;
  scheme: () => 'light' | 'dark';
  /** No configuration yet: the waiting page takes the onboarding's look (`waitingPage`). */
  firstRun?: boolean;
  /** The window has no system title bar: the waiting page keeps a strip to move it by. */
  frameless?: boolean;
  probe: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The interface never answered within the budget. */
  onGiveUp: () => void;
};

/**
 * What the window shows while Timon boots. The window used to open straight on
 * the interface address: Next binds its port after the daemon answers, so the
 * first load was refused and the window sat on its background colour. Here it
 * shows a local page with the step in progress and only navigates once the
 * interface answers.
 */
export class StartupView {
  state: ViewState = 'service';
  private run = 0;
  private since: number | null = null;
  /** Set by `restart`: the waiting page says Timon restarts, and the interface reopens on this route. */
  private restarting: { route: string | null } | null = null;

  constructor(private target: ViewTarget, private url: string, private deps: ViewDeps) {}

  /** Milliseconds spent waiting for the interface, for the reload budget. */
  elapsedMs(): number { return this.since === null ? 0 : this.deps.now() - this.since; }

  /** A service or interface start is still to come, or gave up: the caller may resume. */
  needsUi(): boolean { return this.state === 'service' || this.state === 'failed'; }

  private show(step: WaitingStep): void {
    this.state = step;
    if (this.target.isDestroyed()) return;
    void this.target.loadURL(waitingUrl(this.deps.locale(), this.deps.scheme(), step, this.restarting !== null, this.deps.firstRun === true, this.deps.frameless === true)).catch(() => { /* superseded navigation */ });
  }

  /** First paint: the service is being started. */
  start(): void { this.run++; this.show('service'); }

  /**
   * The daemon serving the interface is about to be replaced (end of a first
   * setup): back to waiting, before its port closes, and `begin` then opens
   * `route` (a path of the interface) rather than the window's first address.
   */
  restart(route: string | null = null): void {
    this.run++;
    this.restarting = { route };
    this.show('service');
  }

  /** Startup cannot continue: say so instead of spinning. Only while still waiting for the service. */
  fail(): void {
    if (this.state !== 'service') return;
    this.run++;
    this.show('failed');
  }

  /** The service answers: wait for the interface, then load it. Restarts the budget after a give-up. */
  async begin(): Promise<void> {
    if (this.state === 'interface') return;
    const run = ++this.run;
    this.since = this.deps.now();
    this.show('interface');
    await this.awaitUi(run);
  }

  /** The loaded interface failed after all (port closed again): go back to waiting, same budget. */
  async retry(): Promise<void> {
    if (this.state !== 'ready') return;
    if (this.elapsedMs() >= RELOAD_BUDGET_MS) return this.giveUp();
    const run = ++this.run;
    this.show('interface');
    await this.awaitUi(run);
  }

  private async awaitUi(run: number): Promise<void> {
    while (run === this.run && !this.target.isDestroyed()) {
      if (this.elapsedMs() >= RELOAD_BUDGET_MS) return this.giveUp();
      if (await this.deps.probe(this.url)) {
        if (run !== this.run || this.target.isDestroyed()) return;
        this.state = 'ready';
        const route = this.restarting?.route;
        this.restarting = null;
        void this.target.loadURL(route ? new URL(route, this.url).href : this.url).catch(() => { /* did-fail-load reports it */ });
        return;
      }
      await this.deps.sleep(RELOAD_DELAY_MS / 2);
    }
  }

  /** Budget spent: leave the interface alone and say so, once (`failed` is not `ready`, so retry() ignores further failures). */
  private giveUp(): void {
    this.run++;
    this.show('failed');
    this.deps.onGiveUp();
  }
}
