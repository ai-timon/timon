/**
 * The device token of a remote machine, as the LOCAL daemon hands it to this
 * app's relay (TODO #329, step P2d). Server side only.
 *
 * The local daemon keeps the fleet (`GET /api/machines/:id/credential`,
 * `orchestrator/src/machines/http.ts`). It answers only:
 *   - for the person whose LOCAL session cookie comes with the call — another
 *     account's machine and an unknown id are the same 404, so this lookup IS
 *     the check that the `timon_machine` cookie names a machine of this user;
 *   - to the relay, proven by `X-Timon-Relay-Proof`: an HMAC keyed by this
 *     host's daemon-token over a timestamp and the machine id
 *     (`orchestrator/src/machines/relay-proof.ts` holds the contract). The
 *     daemon-token is the key, never a header: it does not travel, not even to
 *     the local daemon, and never to a remote one;
 *   - to a call that carries no browser fetch metadata (`Origin`,
 *     `Sec-Fetch-Site`, `Sec-Fetch-Dest`). Hence the headers below are built
 *     from scratch: nothing of the browser's request is ever copied onto it.
 *
 * Kept in memory for at most `CREDENTIAL_TTL_MS`, keyed by the session (a
 * hash of it) AND the machine: another session — another person, or the same
 * one after a logout — never reuses an entry. Never on disk, never logged.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORCHESTRATOR_URL, TIMON_HOME } from '../paths';
import { SESSION_COOKIE } from '../ui/proxy-auth';
import { isMachineId } from './machine-id';

export const RELAY_PROOF_HEADER = 'x-timon-relay-proof';
const PROOF_LABEL = 'timon-machine-credential';

/** Ceiling of the brief: a revoked or re-paired machine is seen within it. */
export const CREDENTIAL_TTL_MS = 60_000;
/** A loopback call; a daemon slower than this is treated as unavailable. */
const LOOKUP_TIMEOUT_MS = 5_000;
/** Bounds the memory a flood of distinct (session, id) pairs can take. */
const CACHE_MAX = 256;

export interface MachineCredential {
  readonly id: string;
  /** The machine's base URL as the registry normalised it, no trailing slash. */
  readonly url: string;
  readonly token: string;
}

/** Why there is no credential. Each maps to a typed answer of the relay. */
export type CredentialFailure =
  /** No local session, or one the local daemon no longer accepts. */
  | 'session_required'
  /** Not a machine of this person (unknown, or another account's). */
  | 'unknown'
  /** The local daemon could not hand it out (vault off, proof refused, down). */
  | 'unavailable';

export type CredentialLookup =
  | { readonly ok: true; readonly credential: MachineCredential }
  | { readonly ok: false; readonly failure: CredentialFailure };

export function relayProof(daemonToken: string, machineId: string, nowMs: number = Date.now()): string {
  const ts = Math.floor(nowMs / 1000);
  const mac = createHmac('sha256', daemonToken).update(`${PROOF_LABEL}\n${ts}\n${machineId}`).digest('hex');
  return `${ts}.${mac}`;
}

/**
 * The key of the proof: the daemon reads `<TIMON_HOME>/daemon-token`, so the
 * file comes first; the env copy (the daemon passes it to the app it
 * supervises) only when the file cannot be read, as in a container without
 * the home mounted.
 */
function daemonToken(): string {
  try {
    const fromFile = readFileSync(join(TIMON_HOME, 'daemon-token'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // Not readable here: fall back to the environment.
  }
  return (process.env.TIMON_DAEMON_TOKEN ?? '').trim();
}

const DEVICE_TOKEN = /^tdev_[A-Za-z0-9_-]{20,128}$/;
const URL_MAX = 2048;

/** The daemon's answer, checked field by field: it is a network input. */
function parseCredential(body: unknown, id: string): MachineCredential | null {
  if (typeof body !== 'object' || body === null) return null;
  const { id: gotId, url, token } = body as Record<string, unknown>;
  if (gotId !== id || typeof url !== 'string' || typeof token !== 'string') return null;
  if (url.length === 0 || url.length > URL_MAX || !DEVICE_TOKEN.test(token)) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return { id, url: url.replace(/\/+$/, ''), token };
}

async function lookup(sessionToken: string, id: string): Promise<CredentialLookup> {
  const key = daemonToken();
  if (!key) return { ok: false, failure: 'unavailable' };
  let res: globalThis.Response;
  try {
    res = await fetch(`${ORCHESTRATOR_URL.replace(/\/+$/, '')}/api/machines/${encodeURIComponent(id)}/credential`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
        [RELAY_PROOF_HEADER]: relayProof(key, id),
      },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
  if (res.status === 401) return drained(res, 'session_required');
  if (res.status === 404) return drained(res, 'unknown');
  if (res.status !== 200) return drained(res, 'unavailable');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
  const credential = parseCredential(body, id);
  return credential ? { ok: true, credential } : { ok: false, failure: 'unavailable' };
}

function drained(res: globalThis.Response, failure: CredentialFailure): CredentialLookup {
  void res.body?.cancel().catch(() => {});
  return { ok: false, failure };
}

interface Entry {
  readonly expires: number;
  readonly value: Promise<CredentialLookup>;
}

const cache = new Map<string, Entry>();

function cacheKey(sessionToken: string, id: string): string {
  return `${createHash('sha256').update(sessionToken).digest('hex')}\n${id}`;
}

/**
 * The credential of machine `id` for the holder of `sessionToken`. Only a
 * success is kept, and concurrent requests of one page share one lookup.
 */
export async function machineCredential(sessionToken: string | null | undefined, id: string): Promise<CredentialLookup> {
  const session = sessionToken?.trim();
  if (!session) return { ok: false, failure: 'session_required' };
  if (!isMachineId(id)) return { ok: false, failure: 'unknown' };
  const key = cacheKey(session, id);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  if (hit) cache.delete(key);
  const value = lookup(session, id);
  cache.set(key, { expires: now + CREDENTIAL_TTL_MS, value });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  const result = await value;
  if (!result.ok && cache.get(key)?.value === value) cache.delete(key);
  return result;
}

/**
 * Drops every cached credential. Called when an account action (logout,
 * password change, machine removed or re-paired) goes through the relay: the
 * next request asks the local daemon again rather than trusting up to a
 * minute of an answer given before it.
 */
export function forgetMachineCredentials(): void {
  cache.clear();
}
