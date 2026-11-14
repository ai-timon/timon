/**
 * Password hashing for user accounts (Phase M.1).
 *
 * argon2id would be the usual choice, but it is not on the allowed
 * dependency list (`CLAUDE.md` rule 7). `scrypt` from `node:crypto` needs
 * nothing installed and is the recipe's fallback (`docs/MULTI-USER.md` §11).
 *
 * Encoding: `scrypt$N$r$p$<salt-b64url>$<key-b64url>`. The parameters travel
 * with the hash so a later cost bump does not invalidate existing rows.
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const KEYLEN = 32;
const SALTLEN = 16;
/**
 * OWASP's current floor for scrypt (N=2^17, r=8, p=1): 128 MiB of memory and
 * about 200 ms per hash — paid once per sign-in, not on a hot path. Hashes
 * written with an older, lower cost keep verifying and are rewritten at the
 * next successful sign-in (`needsRehash`).
 */
const N = 131_072;
const R = 8;
const P = 1;
/**
 * scrypt needs 128 * N * r bytes, exactly 128 MiB here, and OpenSSL refuses a
 * limit equal to the need. 256 MiB leaves room for the current cost and caps
 * what a stored hash can make the daemon allocate.
 */
const MAXMEM = 256 * 1024 * 1024;

export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordError';
  }
}

/**
 * At most this many scrypt computations run at once; the others wait their
 * turn. Each one holds 128 MiB and a libuv worker for ~200 ms, and libuv has
 * four workers by default, shared with file and DNS work: two leaves the rest
 * of the daemon its share of the pool, and bounds the memory a burst of
 * sign-ins (spread over many addresses, so past the throttle) can claim.
 */
const MAX_CONCURRENT_HASHES = 2;
let running = 0;
const waiting: Array<() => void> = [];

async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running < MAX_CONCURRENT_HASHES) running += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    // The slot goes straight to the next caller, so `running` always counts
    // the computations actually in flight.
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}

/**
 * `crypto.scrypt` runs on the libuv pool: the event loop keeps serving every
 * other request and mission while a password is hashed, which `scryptSync`
 * did not (~200 ms frozen per attempt at the current cost).
 */
function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return withHashSlot(() => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  }));
}

function encode(salt: Buffer, key: Buffer): string {
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new PasswordError('password must not be empty');
  const salt = randomBytes(SALTLEN);
  return encode(salt, await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM }));
}

/**
 * Blocks the event loop for the whole computation: kept for the account
 * provider facade, whose published contract is synchronous (`provision`,
 * `update`), and for test fixtures. That path is a signed plugin acting for
 * someone already signed in, never an anonymous request.
 */
export function hashPasswordSync(password: string): string {
  if (password.length === 0) throw new PasswordError('password must not be empty');
  const salt = randomBytes(SALTLEN);
  return encode(salt, scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM }));
}

/** One-shot password for a superadmin reset. Shown once, communicated out of band. */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * True when `encoded` was written with a cost other than the current one (or
 * is not a scrypt hash this module wrote). Call it only after `verifyPassword`
 * succeeded, with the plain password at hand, to store a fresh hash.
 */
export function needsRehash(encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) !== N || Number(parts[2]) !== R || Number(parts[3]) !== P;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || r < 1 || p < 1) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url');
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let key: Buffer;
  try {
    key = await scryptAsync(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

let dummyHash: Promise<string> | null = null;

/**
 * Spends what a real verification spends and always answers false. Kept on an
 * object so a test can spy on it: an ES module binding cannot be replaced.
 */
export const passwordTiming = {
  async verifyDummy(password: string): Promise<false> {
    // Computed once, at the current cost, from a random password thrown away
    // at once: nothing can match it. The first call computes it instead of
    // verifying, which costs the same single scrypt.
    if (!dummyHash) {
      // A failed computation is not cached: the next caller tries again
      // instead of every unknown e-mail failing for the life of the process.
      dummyHash = hashPassword(randomBytes(SALTLEN).toString('base64url')).catch((err: unknown) => {
        dummyHash = null;
        throw err;
      });
      await dummyHash;
      return false;
    }
    await verifyPassword(password, await dummyHash);
    return false;
  },
};

/**
 * Checks a password against an account that may not be usable. An unknown
 * e-mail, a disabled account or an account without a password goes through
 * the dummy hash, so the answer takes as long as a wrong password on a real
 * account: the response time does not tell which e-mails have an account.
 */
export async function verifyAccountPassword(
  password: string,
  user: { status: string; password_hash: string } | null | undefined,
): Promise<boolean> {
  if (!user || user.status !== 'active' || !user.password_hash) {
    return passwordTiming.verifyDummy(password);
  }
  return verifyPassword(password, user.password_hash);
}
