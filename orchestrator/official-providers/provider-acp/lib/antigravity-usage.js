// @ts-check
/**
 * Account usage of the `antigravity` backend: the weekly quota of each model group of the Google
 * account `agy` is signed in to, as `agy` itself reports it.
 *
 * Why this path. Google's quota endpoint refuses any client but Antigravity's own (403 on a direct
 * call with the account's token), and the token sits in the OS keychain (in `agy`'s own folder on Linux,
 * `agents.js`). `agy acp` starts a local
 * language server at `session/new`, in its own process, and that server answers
 * `RetrieveUserQuotaSummary` (Connect protocol, JSON over HTTP) with the figures it fetched under ITS
 * identity. So Timon reads no token, calls no Google host, and only asks the program the operator
 * installed. Verified on agy 1.5.9 with a Pro account; the method is internal to agy and versioned
 * with it, so every field is checked and an answer we cannot read is an error, never a zero.
 *
 * Security. That local server has NO authentication while it lives (any local process that knows the
 * port may call it). Hence:
 *  - a throwaway process per probe, started through the daemon (`binary.converse`: declared program,
 *    system whitelist plus the backend's own variables, a deadline, stopped with its tree, and with the
 *    plugin), stopped in `finally` on every path; never a mission's process, never a resident one;
 *  - the port is read ONLY from the log file of the process this probe started (`--log-file`, in a
 *    private folder made for it and removed after): a port found elsewhere could be another user's;
 *  - `127.0.0.1`, never `localhost`; one method, `RetrieveUserQuotaSummary`. `GetUserStatus` (it returns
 *    the account's name and e-mail) is never called;
 *  - neither the log nor the raw answer is logged or echoed in an error: only the kind of failure is.
 *  - the environment is a mission's own (`profile.env`, then the row's `env`: the two switches that would
 *    move `agy` to per-token billing, emptied, and on Linux the keychain's bus switched off, so that the
 *    reading sees the sign-in a mission sees), nothing more;
 *  - no server outlives the probe, even when `agy` exited first and `stop()` had nothing left to kill:
 *    the port is tried once `agy` is gone, a server still listening is killed by the pid the same log
 *    gives (`Starting language server process with pid N`), and one that cannot be killed fails the
 *    reading and stops the automatic ones (`endLeftoverServer`).
 *
 * `docs/SECURITY.md` and `public-docs/docs/usage/antigravity.md` describe the same mechanism.
 */
import { closeSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync, chmodSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The one method this probe calls on agy's language server. */
export const QUOTA_METHOD_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

/** The line agy 1.5.9 writes to its log once the language server listens. */
const PORT_LINE = /Language server listening on random port at (\d{1,5}) for HTTP\b/;
/** The line agy 1.5.9 writes before it: the process the server runs in (agy's own, in that version). */
const SERVER_PID_LINE = /Starting language server process with pid (\d{1,10})\b/;

/** Whole probe, start to kill. Measured: port after ~0.1 s, quota after ~1.1 s. */
const PROBE_TIMEOUT_MS = 10_000;
/** The daemon's own deadline on the process, should this module's never fire. */
const CONVERSATION_BACKSTOP_MS = 15_000;
/** Each ACP request; the whole probe stays under `PROBE_TIMEOUT_MS`. */
const REQUEST_TIMEOUT_MS = 8_000;
/** Polling of the log for the port, and of the server while it loads the account's quota. */
const LOG_POLL_MS = 100;
const QUOTA_RETRY_MS = 200;
/** Each HTTP request to the local server. */
const HTTP_TIMEOUT_MS = 3_000;
/** What is read of the log and of an answer: both are small, a larger one is not what we expect. */
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_ANSWER_BYTES = 256 * 1024;
/** A connection attempt to the port once agy is gone: on loopback a closed port refuses at once. */
const PORT_CHECK_MS = 500;
/** How long a killed server has to let go of its port. */
const LEFTOVER_WAIT_MS = 2_000;
const LEFTOVER_POLL_MS = 50;

/** A weekly quota moves turn by turn; each reading is an `agy` process. */
const CACHE_TTL_MS = 5 * 60_000;
/** A failure is asked again sooner, but never at the gauge's polling rate. */
const ERROR_TTL_MS = 60_000;
/** Not signed in changes only when the person signs in, and then presses ↻: no need to ask every minute. */
const SIGNED_OUT_TTL_MS = CACHE_TTL_MS;
/** A probe folder older than this was left by a daemon that died mid-probe. */
const STALE_DIR_MS = 60_000;

const DIR_PREFIX = 'timon-agy-usage-';
const MAX_GROUPS = 32;
const MAX_BUCKETS = 16;
const MAX_LABEL_CHARS = 60;

/** @param {unknown} v @returns {Record<string, unknown> | null} */
function asRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : null;
}

/** A label the gauge can show: the server's own words, without control characters, bounded. */
function label(/** @type {unknown} */ value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
}

/**
 * @typedef {{ utilization: number; resets_at: string }} UsageWindow
 * @typedef {{ windows: Record<string, UsageWindow | null>; extra: null }} AccountUsage
 * @typedef {{ state: 'ok'; usage: AccountUsage } | { state: 'pending' } | { state: 'invalid'; reason: string }} QuotaReading
 */

/**
 * `RetrieveUserQuotaSummary` → one window per model group (per bucket when a group has several),
 * keyed by the group's own name: `utilization = (1 − remainingFraction) × 100`, `resets_at = resetTime`.
 *
 * `pending`: the server answered before it loaded the account (no group, or a group with no bucket
 * yet): asked again. `invalid`: a field is there with the wrong type: the shape changed, and the
 * probe fails rather than guess.
 *
 * `remainingFraction` absent from a bucket that has a reset time is read as 0 (exhausted): the
 * server speaks proto3 JSON, which leaves out a field at its zero value.
 *
 * @param {unknown} payload
 * @returns {QuotaReading}
 */
export function parseQuotaSummary(payload) {
  const root = asRecord(payload);
  if (!root) return { state: 'invalid', reason: 'the answer is not an object' };
  if (root.response === undefined) return { state: 'pending' };
  const response = asRecord(root.response);
  if (!response) return { state: 'invalid', reason: '`response` is not an object' };
  if (response.groups === undefined) return { state: 'pending' };
  if (!Array.isArray(response.groups)) return { state: 'invalid', reason: '`groups` is not a list' };
  if (response.groups.length === 0) return { state: 'pending' };
  if (response.groups.length > MAX_GROUPS) return { state: 'invalid', reason: 'too many groups' };

  /** @type {Record<string, UsageWindow | null>} */
  const windows = {};
  const unique = (/** @type {string} */ name) => {
    let key = name;
    for (let n = 2; Object.hasOwn(windows, key); n += 1) key = `${name} ${n}`;
    return key;
  };
  for (const [index, rawGroup] of response.groups.entries()) {
    const group = asRecord(rawGroup);
    if (!group) return { state: 'invalid', reason: 'a group is not an object' };
    if (group.displayName !== undefined && typeof group.displayName !== 'string') return { state: 'invalid', reason: 'a group name is not text' };
    if (group.buckets === undefined) return { state: 'pending' };
    if (!Array.isArray(group.buckets)) return { state: 'invalid', reason: '`buckets` is not a list' };
    if (group.buckets.length === 0) return { state: 'pending' };
    if (group.buckets.length > MAX_BUCKETS) return { state: 'invalid', reason: 'too many buckets' };
    const groupName = label(group.displayName) || `Model group ${index + 1}`;
    for (const rawBucket of group.buckets) {
      const bucket = asRecord(rawBucket);
      if (!bucket) return { state: 'invalid', reason: 'a bucket is not an object' };
      const { remainingFraction, resetTime } = bucket;
      if (remainingFraction !== undefined
        && (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1)) {
        return { state: 'invalid', reason: '`remainingFraction` is not a fraction' };
      }
      if (resetTime !== undefined && typeof resetTime !== 'string') return { state: 'invalid', reason: '`resetTime` is not text' };
      const own = label(bucket.window) || label(bucket.bucketId);
      const key = unique(group.buckets.length > 1 && own ? `${groupName} (${own})` : groupName);
      const reset = typeof resetTime === 'string' ? Date.parse(resetTime) : Number.NaN;
      // No reset time: neither the window nor the fraction can be stated, so the window shows as unavailable.
      if (!Number.isFinite(reset)) { windows[key] = null; continue; }
      const used = (1 - (typeof remainingFraction === 'number' ? remainingFraction : 0)) * 100;
      windows[key] = { utilization: Math.round(Math.max(0, Math.min(100, used)) * 10) / 10, resets_at: new Date(reset).toISOString() };
    }
  }
  return { state: 'ok', usage: { windows, extra: null } };
}

/**
 * What the log the probe's own process writes says of its language server: the HTTP port, and the pid
 * of the process it runs in; each null until its line is there. Only the first `MAX_LOG_BYTES` are read.
 *
 * @param {string} file
 * @returns {{ port: number | null; serverPid: number | null }}
 */
export function serverFromLog(file) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return { port: null, serverPid: null }; }
  try {
    const buffer = Buffer.alloc(MAX_LOG_BYTES);
    const read = readSync(fd, buffer, 0, MAX_LOG_BYTES, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const port = Number(PORT_LINE.exec(text)?.[1]);
    const pid = Number(SERVER_PID_LINE.exec(text)?.[1]);
    return {
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      // Never 0, 1 or a negative number: `process.kill` reads those as a group or as every process.
      serverPid: Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff ? pid : null,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * The HTTP port of the language server, from the log the probe's own process writes; null until the
 * line is there.
 *
 * @param {string} file
 * @returns {number | null}
 */
export function portFromLog(file) {
  return serverFromLog(file).port;
}

/**
 * Whether something still accepts a connection on `127.0.0.1:port`. A bare TCP connection, closed at
 * once: no request reaches the server. No answer in time counts as listening, so a doubt is never
 * read as "gone".
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portListening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (/** @type {boolean} */ listening) => { clearTimeout(timer); socket.destroy(); resolve(listening); };
    const timer = setTimeout(() => done(true), PORT_CHECK_MS);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Run once agy is gone, whichever way it went. agy 1.5.9 runs its server in its own process, so
 * stopping agy closes the port; a version (or an OS) where the server is a process of its own could
 * leave it behind, reparented, listening without authentication, out of reach of `stop()`. Such a
 * server is killed by the pid its log gave, and only while its port still answers: that is what
 * tells the server still lives, and not a process that took its pid after it died. The pid of agy
 * itself is never signalled here: once agy has exited, its pid may already be someone else's.
 *
 * Resolves true when nothing listens any more, false when a server is left that could not be killed.
 *
 * @param {{ port: number | null; serverPid: number | null }} server
 * @param {number | null} agyPid
 * @returns {Promise<boolean>}
 */
export async function endLeftoverServer(server, agyPid) {
  const { port, serverPid } = server;
  if (port === null || !(await portListening(port))) return true;
  if (serverPid === null || serverPid === agyPid || serverPid === process.pid) return false;
  try { process.kill(serverPid, 'SIGKILL'); } catch { /* gone, or not ours to signal: the port says which */ }
  const stopAt = Date.now() + LEFTOVER_WAIT_MS;
  while (Date.now() < stopAt) {
    if (!(await portListening(port))) return true;
    // Held, unlike `sleep`: the probe's caller is waiting on this, and it is bounded.
    await new Promise((resolve) => { setTimeout(resolve, LEFTOVER_POLL_MS); });
  }
  return false;
}

/** A folder only the daemon's account may read (POSIX 0700; on Windows the user's own temp folder). */
function privateDir() {
  const dir = mkdtempSync(join(tmpdir(), DIR_PREFIX));
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  return dir;
}

/** Folders a daemon killed mid-probe left behind: their process is gone, the log goes with them. */
function sweepStaleDirs(now = Date.now()) {
  let names;
  try { names = readdirSync(tmpdir()); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      if (now - statSync(dir).mtimeMs > STALE_DIR_MS) rmSync(dir, { recursive: true, force: true });
    } catch { /* another account's, or already gone */ }
  }
}

/**
 * The body as text, read chunk by chunk and abandoned past `max` bytes (null): `response.text()` would
 * hold a runaway answer in memory before its size could be checked.
 *
 * @param {Response} response
 * @param {number} max
 * @returns {Promise<string | null>}
 */
export async function readCapped(response, max) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * @typedef {import('@timon-ai/sdk/provider').ProviderServices} ProviderServices
 * @typedef {{ cmd?: string; env?: Readonly<Record<string, string>> } | undefined} ProbeProfile
 * @typedef {{
 *   services: Pick<ProviderServices, 'binary' | 'runtime'>;
 *   names: readonly string[];
 *   env: Readonly<Record<string, string>>;
 *   signIn: string;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 * }} AntigravityUsageOptions
 */

/**
 * The probe, with its cache and the one probe that may run at a time.
 *
 * @param {AntigravityUsageOptions} opts
 */
export function createAntigravityUsage(opts) {
  const { binary, runtime } = opts.services;
  const { UsageNotSignedInError, isUsageNotSignedInError, accountUsageProblems } = runtime.usage;
  const { transportOver, AcpRpcError, AcpTransportError, RPC_AUTH_REQUIRED } = runtime.acp;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  /** `held`: a failure the automatic readings do not retry, only a person's ↻. */
  /** @type {{ at: number; usage?: AccountUsage; error?: Error; held?: boolean } | null} */
  let cache = null;
  /** @type {Promise<AccountUsage> | null} */
  let inFlight = null;

  /** agy's language server is still listening after the probe, and could not be killed. */
  class LeftoverServerError extends Error {
    constructor() {
      super('agy left its local language server running and Timon could not stop it: end the remaining agy process, then press ↻');
      this.name = 'LeftoverServerError';
    }
  }

  const notSignedIn = () => new UsageNotSignedInError(`Antigravity is not signed in: ${opts.signIn}`);

  /**
   * `session/new`. `auth_required`: not signed in. Never `authenticate`: `agy` loads a saved sign-in on
   * its own, and with none saved that call opens the Google sign-in page in the person's browser, for a
   * process this probe stops seconds later (`ANTIGRAVITY_AUTH_METHOD`, `agents.js`).
   *
   * @param {InstanceType<ProviderServices['runtime']['acp']['AcpTransport']>} transport
   * @param {string} cwd
   */
  async function openSession(transport, cwd) {
    try {
      await transport.newSession({ cwd, mcpServers: [] });
    } catch (err) {
      if (err instanceof AcpRpcError && err.code === RPC_AUTH_REQUIRED) throw notSignedIn();
      throw err;
    }
  }

  /**
   * @param {string} logFile
   * @param {() => boolean} gone
   * @param {number} stopAt
   */
  async function waitForPort(logFile, gone, stopAt) {
    for (;;) {
      const port = portFromLog(logFile);
      if (port !== null) return port;
      if (gone()) throw new Error('agy stopped before its language server started');
      if (Date.now() >= stopAt) throw new Error('agy did not report its language server port in time');
      await sleep(LOG_POLL_MS);
    }
  }

  /**
   * @param {number} port
   * @param {number} stopAt
   * @returns {Promise<AccountUsage>}
   */
  async function readQuota(port, stopAt) {
    const url = `http://127.0.0.1:${port}${QUOTA_METHOD_PATH}`;
    for (;;) {
      const left = stopAt - Date.now();
      if (left <= 0) throw new Error('agy did not report its quota in time');
      /** @type {Response} */
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
          body: '{}',
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(left, HTTP_TIMEOUT_MS)),
        });
      } catch {
        throw new Error('agy\'s language server did not answer');
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('this agy version does not report its quota; update agy and retry');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`agy's language server refused the quota request (HTTP ${response.status})`);
      }
      const text = await readCapped(response, MAX_ANSWER_BYTES);
      if (text === null) throw new Error('agy returned a quota answer of an unexpected size');
      /** @type {unknown} */
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error('agy returned a quota answer that is not JSON'); }
      const reading = parseQuotaSummary(payload);
      if (reading.state === 'invalid') throw new Error(`agy returned a quota answer Timon does not recognise (${reading.reason})`);
      if (reading.state === 'ok') {
        const problems = accountUsageProblems(reading.usage);
        if (problems.length > 0) throw new Error('agy returned a quota answer Timon does not recognise');
        return reading.usage;
      }
      await sleep(QUOTA_RETRY_MS);
    }
  }

  /**
   * One reading: a throwaway `agy acp`, its session, its port, one HTTP request; the process and its
   * log are gone when this returns, whichever way it returns.
   *
   * @param {ProbeProfile} profile
   * @returns {Promise<AccountUsage>}
   */
  async function probeOnce(profile) {
    const names = opts.names;
    const name = profile?.cmd && names.includes(profile.cmd) ? profile.cmd : names[0];
    if (!name) throw new Error('the antigravity backend declares no program');
    sweepStaleDirs();
    const dir = privateDir();
    const logFile = join(dir, 'agy.log');
    /** @type {ReturnType<typeof transportOver> | null} */
    let channel = null;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline;
    /** @type {number | null} */
    let agyPid = null;
    try {
      let conversation;
      try {
        conversation = await binary.converse(name, ['--log-file', logFile, 'acp'], {
          // The mission's environment: the profile's, then the row's own (the billed switches, emptied).
          env: { ...(profile?.env ?? {}), ...opts.env },
          timeoutMs: CONVERSATION_BACKSTOP_MS,
        });
      } catch {
        throw new Error('agy could not be started: is it installed and on the PATH?');
      }
      agyPid = conversation.pid;
      let exited = false;
      void conversation.exited.then(() => { exited = true; });
      const open = transportOver(conversation, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
      channel = open;
      const stopAt = Date.now() + timeoutMs;
      /** @type {Promise<never>} */
      const timedOut = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('agy did not report its quota in time')), timeoutMs);
      });
      timedOut.catch(() => undefined);
      const run = (async () => {
        await open.transport.initialize();
        await openSession(open.transport, open.cwd);
        const port = await waitForPort(logFile, () => exited, stopAt);
        return readQuota(port, stopAt);
      })();
      run.catch(() => undefined);
      try {
        return await Promise.race([run, timedOut]);
      } catch (err) {
        if (isUsageNotSignedInError(err)) throw err;
        if (err instanceof AcpTransportError) {
          throw new Error(err.kind === 'timeout' ? 'agy did not answer in time' : 'agy stopped before it reported its quota');
        }
        if (err instanceof AcpRpcError) throw new Error(`agy refused the session (code ${err.code})`);
        throw err instanceof Error ? err : new Error('Antigravity quota unavailable');
      }
    } finally {
      clearTimeout(deadline);
      // Read before the folder goes: the port and the server's pid, wherever the probe stopped.
      const server = serverFromLog(logFile);
      await channel?.stop().catch(() => undefined);
      const ended = await endLeftoverServer(server, agyPid).catch(() => false);
      rmSync(dir, { recursive: true, force: true });
      // Over any other outcome, the quota included: this one asks the person to act.
      if (!ended) throw new LeftoverServerError();
    }
  }

  /**
   * The quota, from the cache when it is fresh. `force` (a person's ↻, already spaced by the daemon's
   * floor) skips the cache, a cached failure included; it never starts a second process while one runs.
   * A server that could not be stopped holds the failure until that ↻.
   *
   * @param {ProbeProfile} profile
   * @param {{ force?: boolean; now?: number }} [options]
   * @returns {Promise<AccountUsage>}
   */
  async function getUsage(profile, options = {}) {
    const now = options.now ?? Date.now();
    if (options.force !== true && cache) {
      const ttl = cache.usage ? CACHE_TTL_MS : isUsageNotSignedInError(cache.error) ? SIGNED_OUT_TTL_MS : ERROR_TTL_MS;
      // A server left behind: each new reading could leave one more, so only the person decides when to retry.
      if (cache.held || now - cache.at < ttl) {
        if (cache.usage) return cache.usage;
        throw cache.error ?? new Error('Antigravity quota unavailable');
      }
    }
    if (inFlight) return inFlight;
    const request = (async () => {
      try {
        const usage = await probeOnce(profile);
        cache = { at: Date.now(), usage };
        return usage;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Antigravity quota unavailable');
        cache = { at: Date.now(), error: err, held: err instanceof LeftoverServerError };
        throw err;
      } finally {
        inFlight = null;
      }
    })();
    inFlight = request;
    return request;
  }

  /** Forgets the cache: for tests. */
  function forget() { cache = null; }

  return { getUsage, forget };
}
