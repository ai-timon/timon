/**
 * Delivery of analytics events to our self-hosted OpenPanel, as its public
 * client does it: one `POST <api>/track` per event, identified by a PUBLIC
 * client id and the app's origin. Nothing here is a secret — the id is the one
 * a browser would carry, and the server only accepts it from that origin.
 *
 * A plain `fetch` rather than `@openpanel/sdk`: the SDK adds retries, a
 * device id and session handling we do not want, and one more dependency in
 * the distributed product for twenty lines of HTTP.
 *
 * Events are queued and sent in waves on a timer: a mission never waits on
 * the network. The queue is bounded (the oldest go first), each request has a
 * short timeout, and a failure is dropped with at most one log line per
 * process — analytics must never cost a mission anything.
 */
import { packagedDaemon } from '../../data-version.js';
import { buildInfo, type BuildChannel } from '../../build-info.js';
import { archValue, platformValue } from './events.js';

export const OPENPANEL_API_URL = 'https://analytics.timon-ai.com/api';
/** Public client id of the app (not the website's). */
export const OPENPANEL_CLIENT_ID = 'abdaa564-293b-4dc6-a018-c81af47a1daf';
/** The only origin the server accepts for this client; Node's fetch sends none. */
export const OPENPANEL_ORIGIN = 'timon-app://app';
/** Local capture server, honoured outside a packaged build only (tests, development). */
export const CAPTURE_URL_ENV = 'TIMON_TELEMETRY_CAPTURE_URL';

export const MAX_QUEUE = 200;
export const MAX_PER_FLUSH = 50;
export const REQUEST_TIMEOUT_MS = 3_000;

function underTest(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === 'test';
}

/**
 * Whether this process runs under a test runner: what the caller passed, or
 * this process's own environment. A test that hands `startTelemetry` an `env`
 * of its own still runs under the runner, and must not reach production.
 */
export function runningUnderTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return underTest(env) || underTest(process.env);
}

/** A loopback `http:` URL without credentials, or `null`. */
export function captureUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' || url.username || url.password) return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  return url.toString().replace(/\/$/, '');
}

/**
 * Where events go, or `null` for nowhere (and then nothing is even queued).
 *
 * The code is public and people install Timon from its sources: those
 * installations count as much as the packaged ones, so they send too, marked
 * `build: 'source'` (`runtime.ts`). What must never reach production is a test
 * run and the maintainer's own development, hence:
 *  - a packaged daemon of a released build (`beta` or `stable` stamp): OpenPanel,
 *    outside a test only; the capture URL is ignored, so an environment
 *    variable cannot divert a tester's events;
 *  - anything else: a local capture server when one is named, first;
 *  - then nothing under a test runner, whatever `env` the caller passed;
 *  - otherwise OpenPanel. The maintainer's installs turn it off like anyone
 *    (`TIMON_TELEMETRY=0`, or `telemetry.enabled: false` in the config).
 */
export function telemetryDestination(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = packagedDaemon(env),
  channel: BuildChannel = buildInfo().channel,
  testRunner: boolean = runningUnderTest(env),
): string | null {
  if (packaged && channel !== 'dev') return testRunner ? null : OPENPANEL_API_URL;
  const capture = captureUrl(env[CAPTURE_URL_ENV]);
  if (capture) return capture;
  if (testRunner) return null;
  return OPENPANEL_API_URL;
}

export type TrackPayload = {
  type: 'track';
  payload: { name: string; profileId: string; properties: Record<string, unknown> };
};

/**
 * The operating-system part of the user agent of an event a person caused,
 * in the tokens browsers use (the macOS one is frozen like theirs). OpenPanel
 * files a bare `name/version` agent, or one it reads no system from, as a
 * server: such events never open a session, so its overview stays empty.
 * Platform and architecture already travel in every event's properties: this
 * adds nothing about the machine.
 */
export function systemToken(platform: string = process.platform, arch: string = process.arch): string | null {
  const a = archValue(arch);
  switch (platformValue(platform)) {
    case 'win32': return a === 'arm64' ? 'Windows NT 10.0; ARM64' : 'Windows NT 10.0; Win64; x64';
    case 'darwin': return 'Macintosh; Intel Mac OS X 10_15_7';
    case 'linux': return a === 'arm64' ? 'X11; Linux aarch64' : 'X11; Linux x86_64';
    default: return null;
  }
}

/**
 * `Timon/<version>` for the daemon's own events, which OpenPanel attaches to
 * the person's open session if there is one; with the system for an event a
 * person caused, which opens or extends that session.
 */
export function userAgentOf(version: string, person: boolean, token: string | null = systemToken()): string {
  return person && token ? `Timon/${version} (${token})` : `Timon/${version}`;
}

export type EnqueueOptions = {
  /** A person caused it (a page, the app opened): it counts as a visit. */
  person?: boolean;
};

type QueueItem = { body: TrackPayload; person: boolean };

export type TransportOptions = {
  apiUrl: string;
  sdkVersion: string;
  fetch?: typeof fetch;
  maxQueue?: number;
  timeoutMs?: number;
};

export class TelemetryTransport {
  private readonly queue: QueueItem[] = [];
  private inFlight: Promise<void> | null = null;
  /** Bumped by `cancel()`: a wave of an older generation sends nothing more. */
  private generation = 0;
  private waveAbort: AbortController | null = null;
  private warned = false;
  private readonly fetcher: typeof fetch;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: TransportOptions) {
    this.fetcher = opts.fetch ?? fetch;
    this.maxQueue = opts.maxQueue ?? MAX_QUEUE;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get size(): number {
    return this.queue.length;
  }

  enqueue(item: TrackPayload, opts: EnqueueOptions = {}): void {
    if (this.queue.length >= this.maxQueue) this.queue.shift();
    this.queue.push({ body: item, person: opts.person === true });
  }

  /**
   * The preference was switched off: drops the queue AND stops the wave in
   * flight — its current request is aborted, the rest of it never starts. The
   * next `tick()` starts a fresh wave at once instead of waiting behind the old
   * one, so whatever is enqueued after this call (the one goodbye) is the only
   * thing that still leaves.
   */
  cancel(): void {
    this.queue.length = 0;
    this.generation++;
    this.waveAbort?.abort();
    this.waveAbort = null;
    this.inFlight = null;
  }

  /**
   * The timer's flush: one wave at a time. A wave still in flight (a slow or
   * silent network) makes the tick a no-op instead of queuing another one.
   */
  tick(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) return this.inFlight ?? Promise.resolve();
    const wave = this.queue.splice(0, MAX_PER_FLUSH);
    const abort = new AbortController();
    const run: Promise<void> = this.send(wave, this.generation, abort.signal).finally(() => {
      // A cancelled wave settles after its successor started: not its slot any more.
      if (this.inFlight !== run) return;
      this.inFlight = null;
      this.waveAbort = null;
    });
    this.inFlight = run;
    this.waveAbort = abort;
    return run;
  }

  /** Sends everything queued now, wave after wave (tests, shutdown). Never rejects. */
  async flush(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    while (this.queue.length > 0) await this.tick();
  }

  private async send(wave: QueueItem[], generation: number, cancelled: AbortSignal): Promise<void> {
    for (const item of wave) {
      if (generation !== this.generation) return;
      try {
        const res = await this.fetcher(`${this.opts.apiUrl}/track`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'openpanel-client-id': OPENPANEL_CLIENT_ID,
            'openpanel-sdk-name': 'timon-daemon',
            'openpanel-sdk-version': this.opts.sdkVersion,
            origin: OPENPANEL_ORIGIN,
            'user-agent': userAgentOf(this.opts.sdkVersion, item.person),
          },
          body: JSON.stringify(item.body),
          redirect: 'error',
          signal: AbortSignal.any([cancelled, AbortSignal.timeout(this.timeoutMs)]),
        });
        // The body is not read: drained so the socket can be reused.
        await res.arrayBuffer().catch(() => undefined);
        if (!res.ok) this.warnOnce(`HTTP ${res.status}`);
      } catch (err) {
        if (generation !== this.generation) return; // cancelled by us: not a delivery failure
        // The network is not there: the rest of this wave would wait out the
        // same timeout one by one. It is dropped, like the failed one.
        this.warnOnce((err as Error).name);
        return;
      }
    }
  }

  private warnOnce(what: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[telemetry] usage statistics could not be delivered (${what}); further failures are dropped silently`);
  }
}
