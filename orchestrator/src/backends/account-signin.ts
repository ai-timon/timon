/**
 * Which subscription accounts a sign-in flow is running on right now.
 *
 * On macOS an in-place sign-in (`account-login.ts`) lets the CLI write the
 * account's keychain entry at any moment while it runs, and its verification
 * can sign the account out again. A provider that moves that entry into the
 * account's folder before a launch (`ctx.provider.account.osCredential`) must
 * not touch it meanwhile: a delete landing after the CLI's write would lose the
 * fresh pair. The flow holds the account from its start until it finished AND
 * its CLI exited; the provider facade reads the hold, synchronously, right
 * before it deletes anything.
 *
 * Kept apart from `account-login.ts` so the facade can read it without
 * importing the login machinery.
 */
const holds = new Map<string, number>();

/** Holds `accountId` for a sign-in; the returned release is idempotent. */
export function beginAccountSignIn(accountId: string): () => void {
  holds.set(accountId, (holds.get(accountId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(accountId) ?? 1) - 1;
    if (left > 0) holds.set(accountId, left);
    else holds.delete(accountId);
  };
}

/** A sign-in flow, or the CLI it started, may still write this account's credential. */
export function accountSigningIn(accountId: string): boolean {
  return holds.has(accountId);
}
