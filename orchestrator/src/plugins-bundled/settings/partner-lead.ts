/**
 * The agency offer: an `agency` account may ask, with a box it ticks itself,
 * to receive Timon's partner offer by email. That is personal data under a
 * consent of its own, separate from usage statistics: it is sent even when
 * analytics is off, and only when the box was ticked.
 *
 * The daemon alone talks to the site, on the frozen contract
 * `POST|DELETE https://timon-ai.com/api/partners/leads`:
 *
 *   - POST `{ email, usageKind: 'agency', locale, appVersion, consentVersion }`
 *     → 201 `{ withdrawToken }`. A new POST invalidates the previous token: the
 *     latest one received always replaces the one kept here;
 *   - DELETE `{ withdrawToken }` → 204; 404 (unknown token) means there is
 *     nothing left to withdraw, which is what was asked;
 *   - 429 (rate limit) and any network failure or 5xx: tried again later, on a
 *     growing delay and at the next start, never in a tight loop;
 *   - 400 (validation) and 413 (body over 2 KB): never retried, the account
 *     sees a readable error and may try again with another address.
 *
 * Where it goes: the production site, from any daemon, packaged or run from
 * source. It is an explicit consent, not analytics: whoever ticked the box
 * asked for it, whatever way they installed Timon. A loopback server named in
 * `TIMON_PARTNERS_SERVER` takes its place when set (tests, a maintainer's
 * check). A test run never reaches the site: under a test runner, without that
 * stand-in, the request waits.
 *
 * What is kept, per account, in `partner-leads.json` (secrets zone, `0600`):
 * the address while the request waits or is active, its state, and the
 * withdrawal token. Neither the address nor the token is ever logged, put in an
 * error message, or handed to analytics.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { BRAND } from '../../brand.js';
import { timonVersion } from '../../data-version.js';
import { PARTNER_LEADS_FILE } from '../../paths.js';

export const PARTNER_LEADS_PATH = '/api/partners/leads';
export const PARTNER_LEADS_URL = `https://${BRAND.domain}${PARTNER_LEADS_PATH}`;
/** Version of the consent sentence the person ticked; the site files it with the lead. */
export const CONSENT_VERSION = '2026-11-15';
/** Loopback stand-in for the site, honoured outside a released packaged build only. */
export const PARTNERS_SERVER_ENV = 'TIMON_PARTNERS_SERVER';

export const REQUEST_TIMEOUT_MS = 10_000;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 6 * 3_600_000;

export const LEAD_STATES = ['pending', 'subscribed', 'withdrawing', 'rejected'] as const;
export type LeadState = (typeof LEAD_STATES)[number];

/** Why the last attempt did not land. Never the server's text: it could echo the address. */
export const LEAD_ERRORS = [
  'unavailable', 'unreachable', 'rate_limited', 'server_error', 'invalid', 'too_large', 'refused', 'invalid_response',
] as const;
export type LeadError = (typeof LEAD_ERRORS)[number];

const Entry = z.object({
  state: z.enum(LEAD_STATES),
  email: z.string().max(254),
  locale: z.string().max(16),
  requestedAt: z.number(),
  withdrawToken: z.string().min(1).max(512).optional(),
  subscribedAt: z.number().optional(),
  attempts: z.number().int().min(0),
  nextAttemptAt: z.number(),
  error: z.enum(LEAD_ERRORS).optional(),
});
type Entry = z.infer<typeof Entry>;

const FileSchema = z.object({ version: z.literal(1), leads: z.record(z.string(), Entry) });
type LeadFile = z.infer<typeof FileSchema>;

const Created = z.object({ withdrawToken: z.string().min(1).max(512) });

export type LeadView = {
  state: 'none' | LeadState;
  email: string | null;
  error: LeadError | null;
  /** When the offer was confirmed, or asked for while it waits. */
  at: number | null;
};

const NONE: LeadView = Object.freeze({ state: 'none', email: null, error: null, at: null });

/** The site normalises the address for uniqueness; the daemon sends it the same way. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** A language, or a language and region (`fr`, `pt-BR`): the contract's shapes, or `null`. `pt_br` becomes `pt-BR`. */
export function normalizeLocale(raw: string): string | null {
  const match = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2}))?$/.exec(raw.trim());
  if (!match) return null;
  return match[2] ? `${match[1]!.toLowerCase()}-${match[2].toUpperCase()}` : match[1]!.toLowerCase();
}

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,24})?$/;

function underTest(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === 'test';
}

/** The runner is read from this process too: a test passing its own `env` still runs under it. */
function runningUnderTest(env: NodeJS.ProcessEnv): boolean {
  return underTest(env) || underTest(process.env);
}

/** A loopback `http(s):` base URL without credentials, or `null`. */
export function partnersServerOverride(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  return `${url.origin}${PARTNER_LEADS_PATH}`;
}

/** Where a lead goes, or `null` when it must wait (see the header). */
export function partnersDestination(
  env: NodeJS.ProcessEnv = process.env,
  testRunner: boolean = runningUnderTest(env),
): string | null {
  const standIn = partnersServerOverride(env[PARTNERS_SERVER_ENV]);
  if (standIn) return standIn;
  return testRunner ? null : PARTNER_LEADS_URL;
}

export type PartnerLeadsOptions = {
  file?: string;
  destination?: () => string | null;
  fetch?: typeof fetch;
  now?: () => number;
  appVersion?: () => string;
  timeoutMs?: number;
  log?: (line: string) => void;
};

type Outcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: LeadError; retry: boolean; retryAfterMs?: number; status?: number };

function retryAfterOf(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export class PartnerLeads {
  private readonly file: string;
  private readonly destination: () => string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly appVersion: () => string;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  /** One operation at a time: a route and the timer must not both POST the same lead. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: PartnerLeadsOptions = {}) {
    this.file = opts.file ?? PARTNER_LEADS_FILE;
    this.destination = opts.destination ?? (() => partnersDestination());
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.appVersion = opts.appVersion ?? timonVersion;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.log = opts.log ?? ((line) => console.warn(line));
  }

  view(userId: string): LeadView {
    const entry = this.read().leads[userId];
    if (!entry) return NONE;
    return {
      state: entry.state,
      email: entry.email,
      error: entry.error ?? null,
      at: entry.state === 'subscribed' ? entry.subscribedAt ?? entry.requestedAt : entry.requestedAt,
    };
  }

  /**
   * Records the request and tries it at once. Waits on the network for at most
   * the request timeout; a failure that may pass leaves it `pending`.
   */
  subscribe(userId: string, email: string, locale: string): Promise<LeadView> {
    return this.serial(async () => {
      const file = this.read();
      const before = file.leads[userId];
      file.leads[userId] = {
        state: 'pending',
        email: normalizeEmail(email),
        locale,
        requestedAt: this.now(),
        // Kept until the site sends the next one: until then it is still the valid one.
        ...(before?.withdrawToken ? { withdrawToken: before.withdrawToken } : {}),
        attempts: 0,
        nextAttemptAt: this.now(),
      };
      this.write(file);
      await this.sendLead(userId);
      return this.view(userId);
    });
  }

  /**
   * Withdraws the request. Nothing sent yet: forgotten here, nothing left the
   * machine. Sent: the site is told; unreachable, the withdrawal waits and is
   * tried again like a lead.
   */
  withdraw(userId: string): Promise<LeadView> {
    return this.serial(async () => {
      const file = this.read();
      const entry = file.leads[userId];
      if (!entry) return NONE;
      if (!entry.withdrawToken) {
        delete file.leads[userId];
        this.write(file);
        return NONE;
      }
      file.leads[userId] = { ...entry, state: 'withdrawing', attempts: 0, nextAttemptAt: this.now() };
      delete file.leads[userId]!.error;
      this.write(file);
      await this.sendWithdrawal(userId);
      return this.view(userId);
    });
  }

  /** At start: every waiting request is due again now. */
  resetSchedule(): void {
    const file = this.read();
    let changed = false;
    for (const entry of Object.values(file.leads)) {
      if (entry.state === 'pending' || entry.state === 'withdrawing') {
        entry.nextAttemptAt = this.now();
        changed = true;
      }
    }
    if (changed) this.write(file);
  }

  /** Tries what is due. Never rejects. */
  tick(): Promise<void> {
    return this.serial(async () => {
      const file = this.read();
      for (const [userId, entry] of Object.entries(file.leads)) {
        if (entry.nextAttemptAt > this.now()) continue;
        if (entry.state === 'pending') await this.sendLead(userId);
        else if (entry.state === 'withdrawing') await this.sendWithdrawal(userId);
      }
    }).catch(() => undefined);
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async sendLead(userId: string): Promise<void> {
    const entry = this.read().leads[userId];
    if (!entry || entry.state !== 'pending') return;
    const version = this.appVersion();
    const outcome = await this.request('POST', {
      email: entry.email,
      usageKind: 'agency',
      locale: entry.locale,
      appVersion: SEMVER.test(version) ? version : '0.0.0',
      consentVersion: CONSENT_VERSION,
    });
    this.update(userId, (current) => {
      // Withdrawn or replaced while the request was in flight: that later choice wins.
      if (current.state !== 'pending' || current.requestedAt !== entry.requestedAt) return current;
      if (outcome.ok) {
        const created = outcome.status === 201 ? Created.safeParse(outcome.body) : null;
        if (created?.success) {
          return {
            state: 'subscribed', email: current.email, locale: current.locale, requestedAt: current.requestedAt,
            withdrawToken: created.data.withdrawToken, subscribedAt: this.now(), attempts: 0, nextAttemptAt: 0,
          };
        }
        return this.failed(current, { ok: false, error: 'invalid_response', retry: true });
      }
      return this.failed(current, outcome);
    });
  }

  private async sendWithdrawal(userId: string): Promise<void> {
    const entry = this.read().leads[userId];
    if (!entry || entry.state !== 'withdrawing' || !entry.withdrawToken) return;
    const outcome = await this.request('DELETE', { withdrawToken: entry.withdrawToken });
    // 404: the site knows no such token, so nothing is left to withdraw. 400: the
    // token cannot be one the site would ever accept, nor will it ever be.
    if (outcome.ok || outcome.status === 404 || outcome.status === 400) {
      const file = this.read();
      if (file.leads[userId]?.state === 'withdrawing') {
        delete file.leads[userId];
        this.write(file);
      }
      return;
    }
    this.update(userId, (current) => (current.state === 'withdrawing' ? this.failed(current, { ...outcome, retry: true }) : current));
  }

  /** The entry after a failed attempt: retried later on a growing delay, or set aside. */
  private failed(entry: Entry, outcome: Extract<Outcome, { ok: false }>): Entry {
    if (entry.error !== outcome.error) {
      this.log(`[partners] agency offer request not delivered (${outcome.error})${outcome.retry ? '; will retry later' : ''}`);
    }
    if (!outcome.retry) return { ...entry, state: 'rejected', error: outcome.error, nextAttemptAt: 0 };
    const attempts = entry.attempts + 1;
    const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(entry.attempts, 16));
    const delay = Math.min(RETRY_MAX_MS, Math.max(backoff, outcome.retryAfterMs ?? 0));
    return { ...entry, attempts, nextAttemptAt: this.now() + delay, error: outcome.error };
  }

  private async request(method: 'POST' | 'DELETE', body: Record<string, unknown>): Promise<Outcome> {
    const url = this.destination();
    // No destination (a test run without a stand-in): wait for the next start rather than poll.
    if (!url) return { ok: false, error: 'unavailable', retry: true, retryAfterMs: RETRY_MAX_MS };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `${BRAND.displayName}/${this.appVersion()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch {
      return { ok: false, error: 'unreachable', retry: true };
    }
    const status = res.status;
    if (status >= 200 && status < 300) {
      const parsed: unknown = status === 204 ? null : await res.json().catch(() => null);
      return { ok: true, status, body: parsed };
    }
    await res.body?.cancel().catch(() => undefined);
    if (status === 429) return { ok: false, error: 'rate_limited', retry: true, retryAfterMs: retryAfterOf(res), status };
    if (status === 400) return { ok: false, error: 'invalid', retry: false, status };
    if (status === 413) return { ok: false, error: 'too_large', retry: false, status };
    if (status >= 500) return { ok: false, error: 'server_error', retry: true, status };
    return { ok: false, error: 'refused', retry: false, status };
  }

  private update(userId: string, change: (entry: Entry) => Entry): void {
    const file = this.read();
    const entry = file.leads[userId];
    if (!entry) return;
    file.leads[userId] = change(entry);
    this.write(file);
  }

  private read(): LeadFile {
    if (!existsSync(this.file)) return { version: 1, leads: {} };
    try {
      const parsed = FileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      return parsed.success ? parsed.data : { version: 1, leads: {} };
    } catch {
      return { version: 1, leads: {} };
    }
  }

  private write(file: LeadFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(file) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

let shared: PartnerLeads | null = null;

/** The daemon's lead store, on the real home. */
export function partnerLeads(): PartnerLeads {
  return (shared ??= new PartnerLeads());
}
