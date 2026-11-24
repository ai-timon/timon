/**
 * Read-only access to ONE entry of the operating system's credential store
 * (S4/S8 of `docs/PROVIDERS-SDK.md`): today the macOS login keychain, where a CLI
 * keeps the sign-in a file-based probe cannot see (TIM-0044 for `claude`). The
 * generalisation of `claude-keychain.ts`, for a provider that declared the entry in
 * its manifest.
 *
 * Read-only on purpose: refresh tokens rotate, so Timon refreshing a CLI's session
 * would invalidate the one the CLI holds. The value is returned to the caller and
 * never logged; a locked keychain or a refused prompt answers `null`, remembered
 * for a minute so that a gauge polling every few seconds does not stack prompts in
 * front of the user. Distinct from `Host.keyring`, which shelters Timon's own
 * master key.
 *
 * One write exists, and it is a removal: the entry a CLI keeps for ONE
 * subscription account (`removeOsCredentialIf`). A mission's fence cannot update
 * the keychain (the home is read-only inside it), so a CLI that rotates its
 * refresh token there ends up with a stale entry that shadows the fresh copy it
 * wrote in its folder. The provider moves the entry into the account's folder,
 * outside the fence, and the daemon deletes it: the folder becomes the one place
 * the CLI keeps that sign-in, and the CLI stays its only holder.
 *
 * `security` offers no compare-and-delete. What keeps a fresh pair from being
 * deleted is that nothing Timon launched can write the entry between the read
 * and the delete: the caller checks, in the same synchronous run as this
 * function, that no sign-in flow holds the account (`account-signin.ts`) and
 * that no process on it runs outside the fence (`mission-fence-state.ts`), and
 * `security` runs synchronously here, so no process starts in between. The
 * entry is still read again right before each `delete-generic-password` and
 * kept when it no longer holds what the provider copied, as a second guard.
 * A writer Timon did not launch (`claude` started by hand with the account's
 * `CLAUDE_CONFIG_DIR`) is outside what the daemon can see or exclude.
 */
import type { Host } from './types.js';

const SECURITY_TIMEOUT_MS = 5_000;
const MISS_TTL_MS = 60_000;
/** `security` exit status for an entry that does not exist. */
const NOT_FOUND = 44;
/** A service may hold one entry per OS account name: a few, never an unbounded loop. */
const MAX_REMOVALS = 8;

export type OsCredentialEntry = { readonly service: string; readonly account?: string };

const misses = new Map<string, number>();
const keyOf = (entry: OsCredentialEntry): string => `${entry.service}\0${entry.account ?? ''}`;

/** Forget the remembered misses, so a login made since is picked up at once. */
export function resetOsCredentialMisses(entry?: OsCredentialEntry): void {
  if (entry) misses.delete(keyOf(entry));
  else misses.clear();
}

/**
 * The stored secret, or `null` when this is not macOS, the entry does not exist, or
 * the store cannot be read from this process (LaunchDaemon, SSH, locked, prompt
 * denied). Never throws: "cannot read" and "not signed in" are one answer.
 */
export function readOsCredential(
  host: Pick<Host, 'platform' | 'exec'>, entry: OsCredentialEntry, now: number = Date.now(),
): string | null {
  if (host.platform !== 'darwin') return null;
  const key = keyOf(entry);
  const lastMiss = misses.get(key);
  if (lastMiss && now - lastMiss < MISS_TTL_MS) return null;
  const value = findEntry(host, entry);
  if (value !== null) {
    misses.delete(key);
    return value;
  }
  misses.set(key, now);
  return null;
}

/** The secret, asked of `security` now: no remembered miss, nothing remembered. */
export function readOsCredentialNow(host: Pick<Host, 'platform' | 'exec'>, entry: OsCredentialEntry): string | null {
  return host.platform === 'darwin' ? findEntry(host, entry) : null;
}

function findEntry(host: Pick<Host, 'exec'>, entry: OsCredentialEntry): string | null {
  const found = probeEntry(host, entry);
  return found.kind === 'found' ? found.value : null;
}

type Probe = { kind: 'found'; value: string } | { kind: 'absent' } | { kind: 'error' };

/** What `security` answers, telling an absent entry from one it would not give (locked, refused, timeout). */
function probeEntry(host: Pick<Host, 'exec'>, entry: OsCredentialEntry): Probe {
  try {
    const args = ['find-generic-password', '-s', entry.service, ...(entry.account ? ['-a', entry.account] : []), '-w'];
    const result = host.exec('security', args, { timeout: SECURITY_TIMEOUT_MS });
    const value = result.stdout.trim();
    if (result.code === 0 && value) return { kind: 'found', value };
    return result.code === NOT_FOUND ? { kind: 'absent' } : { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

/** `removed`: none is left; `changed`: the entry holds something else, left as is; `refused`: the store said no. */
export type OsCredentialRemoval = 'removed' | 'changed' | 'refused';

/**
 * Deletes the entries under `service` (and `account`, when given) as long as
 * each still holds `expected`, and answers what is left: `removed` off macOS,
 * where there is nothing to remove; `changed` as soon as an entry holds
 * another value, which is never deleted; `refused` when `security` would not
 * read or delete (locked keychain, a prompt denied, a timeout). Only names go
 * on the command line, never the secret.
 */
export function removeOsCredentialIf(host: Pick<Host, 'platform' | 'exec'>, entry: OsCredentialEntry, expected: string): OsCredentialRemoval {
  if (host.platform !== 'darwin') return 'removed';
  const args = ['delete-generic-password', '-s', entry.service, ...(entry.account ? ['-a', entry.account] : [])];
  for (let attempt = 0; attempt < MAX_REMOVALS; attempt += 1) {
    const found = probeEntry(host, entry);
    if (found.kind === 'error') return 'refused';
    if (found.kind === 'absent') {
      misses.delete(keyOf(entry));
      return 'removed';
    }
    if (found.value !== expected) return 'changed';
    let code: number;
    try {
      code = host.exec('security', args, { timeout: SECURITY_TIMEOUT_MS }).code;
    } catch {
      return 'refused';
    }
    if (code === NOT_FOUND) {
      misses.delete(keyOf(entry));
      return 'removed';
    }
    if (code !== 0) return 'refused';
  }
  return 'refused';
}
