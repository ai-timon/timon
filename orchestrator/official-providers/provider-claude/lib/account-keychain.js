import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * macOS: where a subscription account's sign-in lives, and why it is moved.
 *
 * Claude Code keeps an account's OAuth pair in the login keychain, under a service named
 * after its config folder, and falls back on `<CLAUDE_CONFIG_DIR>/.credentials.json` when
 * the keychain refuses a write. It READS the keychain first. A mission's fence keeps the
 * home read-only, so inside it `security` can read the entry but can neither update nor
 * delete it (measured on macOS 14.6: `UNIX[Operation not permitted]`). The first refresh in
 * a mission rotates the refresh token, writes the new pair to the file, and leaves the old
 * pair in the keychain, which every later process reads first: Claude Code 2.1.329 stops
 * there with "can't save to the Keychain", 2.1.275 refreshes with a rotated-away token.
 *
 * Before each launch the daemon, outside the fence, copies the entry into the account's
 * folder (unless the file already holds a fresher pair) and deletes it. With no entry the
 * CLI reads the file, and a refresh in the fence falls back on it with nothing left to
 * clear. A CLI run outside any fence may put the entry back on its next refresh: the next
 * launch moves it again. The CLI stays the one holder of the refresh token; the daemon
 * never refreshes it.
 *
 * Only a fenced launch needs the move: outside the fence the CLI updates the keychain itself.
 * And the entry must not be deleted while something may write it: a sign-in flow, or another
 * process on the account outside the fence. The daemon knows both and answers `held()`, checked
 * before each pass and again in the very run of the delete: then nothing is moved, the launch
 * goes on as is. The delete also only goes through while the entry still holds what was copied
 * (`remove(expected)`): a pair written in between stays in the keychain, and the next pass
 * copies it. Moves of one folder are serialized, and so is a launch outside the fence behind a
 * move in progress: it returns once that move is over.
 */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** The CLI's name for the entry of a config folder: the first 8 hex of sha256(folder, NFC). */
export function claudeAccountKeychainService(configDir) {
  const suffix = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

/** The keychain holds the CLI's JSON, as text or hex (`security -X`); null when it is not an object. */
function parseStore(raw) {
  const text = /^(?:[0-9a-f]{2})+$/i.test(raw) ? Buffer.from(raw, 'hex').toString('utf8') : raw;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readStore(file) {
  try {
    return parseStore(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const settling = new Map();

/** An entry that changes on every pass: a handful of tries, then the launch goes on. */
const MAX_PASSES = 3;

/**
 * Moves the account's keychain entry into `configDir`. Serialized per folder: two launches
 * on one account never interleave a copy and a delete. Answers what happened, never a
 * secret: `none` (no entry), `moved`, a hold (`signing-in`, `unfenced`, `in-use`: nothing
 * moved, `ProviderAccountOsCredentialHold`), `changed` (the entry kept changing under the
 * copy: left in place), `busy` (the CLI holds its lock: nothing deleted), `kept` (the store
 * refused the delete), `unreadable` (an entry that is not the CLI's JSON), `unwritable` (the
 * folder refused the copy).
 */
export function settleAccountKeychain({ entry, configDir, runtime }) {
  const previous = settling.get(configDir) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => settle({ entry, configDir, runtime }));
  settling.set(configDir, next);
  return next.finally(() => { if (settling.get(configDir) === next) settling.delete(configDir); });
}

async function settle({ entry, configDir, runtime }) {
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const hold = entry.held();
    if (hold) return hold;
    const outcome = await settleOnce({ entry, configDir, runtime });
    // Changed between the copy and the delete: the newer value is copied on the next pass.
    if (outcome !== 'changed') return outcome;
  }
  return 'changed';
}

async function settleOnce({ entry, configDir, runtime }) {
  const raw = await entry.read();
  if (!raw) return 'none';
  const fromKeychain = parseStore(raw);
  // Not ours to interpret: left alone rather than replaced by a guess.
  if (!fromKeychain) return 'unreadable';
  const file = join(configDir, '.credentials.json');
  const fromFile = readStore(file);
  const { expiryMs } = runtime.oauth;
  const expiry = (store) => expiryMs(store?.claudeAiOauth?.expiresAt) ?? -Infinity;
  // A fenced refresh already wrote a newer pair to the file: the keychain's is the stale one.
  const merged = fromFile && expiry(fromFile) > expiry(fromKeychain)
    ? { ...fromKeychain, ...fromFile }
    : { ...(fromFile ?? {}), ...fromKeychain };
  try {
    if (!runtime.oauth.writeStoreAtomically(file, merged, `${file}.lock`)) return 'busy';
  } catch {
    // The entry stays where it is: a mission still reads it, as before.
    return 'unwritable';
  }
  const removal = await entry.remove(raw);
  if (removal === 'removed') return 'moved';
  return removal === 'refused' ? 'kept' : removal;
}
