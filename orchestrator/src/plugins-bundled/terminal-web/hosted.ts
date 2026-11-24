/**
 * The web terminal's sessions, held by the terminal host when it can run and
 * by this process otherwise (`store.ts`).
 *
 * Lifecycle of the host, seen from here:
 * - at boot, reconnect to the host a previous daemon left running — its
 *   shells are listed and reattached as if nothing happened;
 * - when a shell is needed and no host answers, write a fresh token and
 *   launch one (`launch`), then wait for it to answer;
 * - a host from another release that has no session left is told to leave
 *   and replaced; one that still has shells keeps serving them;
 * - when the host cannot start, or answers without proving the token, the
 *   shells run in this process, as before, and `persistence()` says why.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HostConnectError, HostLink, HostRequestError } from '../../terminal-host/client.js';
import { newToken } from '../../terminal-host/protocol.js';
import { TerminalLimitError, type TerminalClient, type TerminalSessionInfo, type TerminalSessions } from '../../terminal-host/sessions.js';
import type { AttachHandle, CreateInput, Persistence, SessionStore } from './store.js';

export type HostedOptions = {
  endpoint: string;
  tokenFile: string;
  /** Starts a host process; resolves once it is started, not once it answers. */
  launch: () => Promise<{ via: string }>;
  /** The in-process fallback, created on first need. */
  local: () => TerminalSessions;
  idleMs: () => number;
  /** This daemon's release: a host announcing another one is outdated. */
  build: string;
  maxPerOwner?: number;
  /** How long a launched host gets to answer. */
  launchWaitMs?: number;
  /** After a failed launch, how long before trying again. */
  retryAfterMs?: number;
  log?: (line: string) => void;
  now?: () => number;
};

const POLL_MS = 100;

export class HostedSessions implements SessionStore {
  private link: HostLink | null = null;
  private connecting: Promise<HostLink | null> | null = null;
  private localSessions: TerminalSessions | null = null;
  private readonly attachments = new Set<HostLink>();
  private token: string | null = null;
  private reason: string | undefined;
  private via: string | undefined;
  private failedAt = 0;
  private closed = false;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: HostedOptions) {
    this.log = opts.log ?? ((line) => console.log(`[terminal-web] ${line}`));
    this.now = opts.now ?? Date.now;
  }

  /** At boot: picks up a host left by the previous daemon, never launches one. */
  async reconnect(): Promise<boolean> {
    return (await this.ensure(false)) !== null;
  }

  /**
   * Never launches: the chat asks for the status at every load, and a host
   * per opened chat is not what the user asked for. Only a new shell does.
   */
  async persistence(): Promise<Persistence> {
    const link = await this.ensure(false);
    if (link) return { mode: 'host', ...(this.via ? { via: this.via } : {}) };
    if (this.reason) return { mode: 'in-process', reason: this.reason };
    return { mode: 'not-started' };
  }

  async list(ownerId: string): Promise<TerminalSessionInfo[]> {
    const local = this.localSessions?.list(ownerId) ?? [];
    const link = await this.ensure(false);
    let remote: TerminalSessionInfo[] = [];
    if (link) {
      try { remote = await link.request<TerminalSessionInfo[]>('list', { ownerId }); } catch { remote = []; }
    }
    return [...remote, ...local].sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(ownerId: string, id: string): Promise<TerminalSessionInfo | null> {
    const local = this.localSessions?.get(ownerId, id);
    if (local) return local;
    const link = await this.ensure(false);
    if (!link) return null;
    try { return await link.request<TerminalSessionInfo | null>('get', { ownerId, sessionId: id }); } catch { return null; }
  }

  async create(ownerId: string, input: CreateInput): Promise<TerminalSessionInfo> {
    const max = this.opts.maxPerOwner ?? 8;
    if ((await this.list(ownerId)).length >= max) throw new TerminalLimitError(`at most ${max} terminal sessions per user`);
    // Twice: the host may leave (idle) between the moment we found it and the request.
    for (let attempt = 0; attempt < 2; attempt++) {
      const link = await this.ensure(true);
      if (!link) break;
      try {
        return await link.request<TerminalSessionInfo>('create', {
          ownerId, shell: input.shell, args: input.args, cwd: input.cwd, env: input.env,
          cols: typeof input.cols === 'number' ? input.cols : undefined,
          rows: typeof input.rows === 'number' ? input.rows : undefined,
          scope: input.scope ?? null, idleMs: this.idleMs(),
        });
      } catch (err) {
        if (err instanceof HostRequestError && err.code === 'limit') throw new TerminalLimitError(err.message);
        if (err instanceof HostRequestError && err.code === 'closed') continue;
        // The host is up but could not spawn — a release pruned under an old
        // host can no longer start node-pty's helper. This shell runs here.
        this.log(`terminal host could not start the shell (${(err as Error).message}); running it in the daemon`);
        this.reason = 'host_spawn_failed';
        break;
      }
    }
    return this.local().create(ownerId, input);
  }

  async kill(ownerId: string, id: string): Promise<boolean> {
    if (this.localSessions?.kill(ownerId, id)) return true;
    const link = await this.ensure(false);
    if (!link) return false;
    try { return await link.request<boolean>('kill', { ownerId, sessionId: id }); } catch { return false; }
  }

  async attach(ownerId: string, id: string, client: TerminalClient): Promise<AttachHandle | null> {
    const local = this.localSessions?.attach(ownerId, id, client);
    if (local) return local;
    if (!(await this.ensure(false))) return null;
    let link: HostLink;
    try {
      link = await HostLink.open(this.opts.endpoint, this.token ?? '');
    } catch {
      return null;
    }
    let detached = false;
    // Set before the request: the scrollback follows the answer in the same read.
    link.onFrame = (frame) => {
      if (frame.t === 'out' && typeof frame.data === 'string') client.send({ type: 'output', data: frame.data });
      else if (frame.t === 'exit') client.send({ type: 'exit', code: typeof frame.code === 'number' ? frame.code : null });
    };
    link.onClose = () => {
      this.attachments.delete(link);
      if (!detached) client.close();
    };
    this.attachments.add(link);
    let ok = false;
    try { ok = await link.request<boolean>('attach', { ownerId, sessionId: id }); } catch { ok = false; }
    if (!ok) {
      detached = true;
      link.close();
      return null;
    }
    return {
      input: (data) => link.send({ t: 'in', data }),
      resize: (cols, rows) => {
        if (typeof cols === 'number' && typeof rows === 'number') link.send({ t: 'resize', cols, rows });
      },
      detach: () => {
        if (detached) return;
        detached = true;
        link.close();
      },
    };
  }

  async dispose(): Promise<void> {
    // Before `closed`: a boot-time reconnection may still be on its way, and
    // the host's shells must go too.
    const link = await this.ensure(false);
    this.closed = true;
    this.localSessions?.disposeAll();
    if (link) {
      try { await link.request('killAll'); } catch { /* the host is gone already */ }
    }
    this.disconnect();
  }

  disconnect(): void {
    this.closed = true;
    this.link?.close();
    this.link = null;
    for (const a of [...this.attachments]) a.close();
    this.attachments.clear();
  }

  private idleMs(): number {
    return Math.max(1_000, this.opts.idleMs());
  }

  private local(): TerminalSessions {
    this.localSessions ??= this.opts.local();
    return this.localSessions;
  }

  /** Single flight: concurrent callers share one connection attempt. */
  private ensure(launch: boolean): Promise<HostLink | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.link?.alive) return Promise.resolve(this.link);
    const pending = this.connecting;
    if (pending) {
      // A launching attempt answers both kinds of caller; a reconnect-only one
      // may be followed by a launch.
      return pending.then((link) => (link || !launch ? link : this.ensure(true)));
    }
    const attempt = this.connect(launch).finally(() => { this.connecting = null; });
    this.connecting = attempt;
    return attempt;
  }

  private async connect(launch: boolean): Promise<HostLink | null> {
    let link = await this.tryOpen();
    if (link === 'untrusted') return null;
    if (link && this.outdated(link)) {
      if (link.welcome.sessions > 0) {
        if (link.protocol === 0) {
          // Shells we cannot speak to: left to the old host's idle reap.
          this.reason = 'host_incompatible';
          link.close();
          return null;
        }
      } else {
        this.log(`retiring an idle terminal host from another release (${link.welcome.build})`);
        try { await link.request('shutdown', { ifIdle: true }); } catch { /* it may be gone already */ }
        link.close();
        await this.waitGone();
        link = null;
      }
    }
    if (!link) {
      if (!launch) return null;
      if (this.failedAt && this.now() - this.failedAt < (this.opts.retryAfterMs ?? 60_000)) return null;
      link = await this.launchAndOpen();
      if (!link) { this.failedAt = this.now(); return null; }
    }
    // Let go while connecting (a daemon stopping just after its boot): the
    // link that arrives late is not kept open.
    if (this.closed) {
      link.close();
      return null;
    }
    this.failedAt = 0;
    this.reason = undefined;
    this.adopt(link);
    return link;
  }

  private outdated(link: HostLink): boolean {
    // Not the entry path: a signed package runs it through a verifying wrapper.
    return link.protocol === 0 || link.welcome.build !== this.opts.build;
  }

  private adopt(link: HostLink): void {
    this.link = link;
    link.onClose = () => { if (this.link === link) this.link = null; };
    link.request('config', { idleMs: this.idleMs() }).catch(() => {});
  }

  private readToken(): string | null {
    try {
      const token = readFileSync(this.opts.tokenFile, 'utf8').trim();
      return token.length >= 32 ? token : null;
    } catch {
      return null;
    }
  }

  /** A link, `null` when nothing listens, `'untrusted'` when something else does. */
  private async tryOpen(): Promise<HostLink | null | 'untrusted'> {
    this.token = this.readToken();
    if (!this.token) return null;
    try {
      return await HostLink.open(this.opts.endpoint, this.token);
    } catch (err) {
      if (err instanceof HostConnectError && err.code === 'absent') return null;
      this.log(`terminal host refused: ${(err as Error).message}`);
      this.reason = 'host_untrusted';
      return 'untrusted';
    }
  }

  private async waitGone(): Promise<void> {
    const deadline = this.now() + 3_000;
    while (this.now() < deadline) {
      const probe = await this.tryOpen();
      if (probe === null) return;
      if (probe !== 'untrusted') probe.close();
      await sleep(POLL_MS);
    }
  }

  private async launchAndOpen(): Promise<HostLink | null> {
    // Nothing answers: nobody holds the previous token, a new one costs nothing.
    this.token = newToken();
    mkdirSync(dirname(this.opts.tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.opts.tokenFile, `${this.token}\n`, { mode: 0o600 });
    try {
      const started = await this.opts.launch();
      this.via = started.via;
    } catch (err) {
      this.log(`terminal host did not start: ${(err as Error).message}`);
      this.reason = 'host_unavailable';
      return null;
    }
    const deadline = this.now() + (this.opts.launchWaitMs ?? 8_000);
    while (this.now() < deadline) {
      try {
        return await HostLink.open(this.opts.endpoint, this.token);
      } catch (err) {
        if (err instanceof HostConnectError && err.code !== 'absent' && err.code !== 'timeout') {
          this.reason = 'host_untrusted';
          return null;
        }
      }
      await sleep(POLL_MS);
    }
    this.log('terminal host started but never answered; shells will run in the daemon');
    this.reason = 'host_unavailable';
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
