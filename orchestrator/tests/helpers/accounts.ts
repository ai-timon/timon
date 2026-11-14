/**
 * Accounts for tests, created in one place.
 *
 * Account creation is leaving the core: once the account provider seam exists,
 * `dbApi.createUser` refuses any caller outside it, and rights stop coming from
 * the core's own roles and groups tables (docs/CONCEPTION-MULTI-UTILISATEUR-PLUGIN.md).
 * Tests go through these helpers instead, so that change lands here and not in
 * 160 files.
 *
 * The database API is passed in rather than imported: most tests load db.js
 * dynamically, after pointing TIMON_HOME at a temporary folder, and a static
 * import here would open the database before that. `permission-source.js` opens
 * nothing, so it is imported statically: db.js resolves the same module.
 */
import type { dbApi as DbApi, UserRow, UserStatus } from '../../src/db.js';
import { registerPermissionSource } from '../../src/users/permission-source.js';
import { claimAccountProvider, releaseAccountProvider } from '../../src/users/account-provider-state.js';
import { hashPasswordSync } from '../../src/users/password.js';
import { LicenseCapabilityError } from '../../src/license/capabilities.js';
import { DuplicateEmailError } from '../../src/users/errors.js';

export type TestAccountInput = {
  id?: string;
  email: string;
  name: string;
  passwordHash: string;
  status?: UserStatus;
  isSuperadmin?: boolean;
  createdAt?: number;
};

/** Creates an account the way a test needs one: same fields as `dbApi.createUser`. */
export function createTestAccount(db: Pick<typeof DbApi, 'createUser'>, input: TestAccountInput): UserRow {
  return db.createUser({ ...input, source: 'test' });
}

/**
 * What `POST /api/users` answered before account administration left the core,
 * for the tests that made their accounts over HTTP: the account, created with
 * its password hashed, and a 201; a licence refusal or a taken address as the
 * 409 it was.
 */
export function postTestAccount(
  db: Pick<typeof DbApi, 'createUser'>,
  body: { email: string; name: string; password: string; is_superadmin?: boolean; status?: UserStatus },
): { status: number; json: { user?: UserRow; error?: string } } {
  try {
    const user = createTestAccount(db, {
      email: body.email,
      name: body.name,
      passwordHash: hashPasswordSync(body.password),
      isSuperadmin: body.is_superadmin === true,
      ...(body.status ? { status: body.status } : {}),
    });
    return { status: 201, json: { user } };
  } catch (err) {
    if (err instanceof LicenseCapabilityError) return { status: 409, json: { error: err.code } };
    if (err instanceof DuplicateEmailError) return { status: 409, json: { error: 'email_taken' } };
    throw err;
  }
}

/**
 * The plugin id the tests serve accounts under. Accounts beyond the first
 * superadmin are served only while a plugin holds the account provider
 * (`users/free-access.ts`); `tests/helpers/paid-license.ts` holds it under this
 * id, the way the Multi-user plugin would on a paid install.
 */
export const TEST_ACCOUNT_PROVIDER_ID = 'test-accounts';

/** Holds the account provider for the tests. Idempotent. */
export function serveTestAccounts(): void {
  claimAccountProvider(TEST_ACCOUNT_PROVIDER_ID);
}

/** Lets go of it, for a test of the provider seam itself. */
export function stopServingTestAccounts(): void {
  releaseAccountProvider(TEST_ACCOUNT_PROVIDER_ID);
}

/** The plugin id the test source holds the permission seam under. */
export const TEST_PERMISSION_SOURCE_ID = 'test-permissions';

const granted = new Map<string, string[]>();
let source: ReturnType<typeof registerPermissionSource> | null = null;

/**
 * Registers the test permission source, which answers from the rights given by
 * `grantTestPermissions` (nothing for any other account). Registration happens
 * on the first grant, never at import: a test of the seam itself keeps the
 * "no source" case until it grants something.
 */
export function installTestPermissionSource(): void {
  if (source) return;
  source = registerPermissionSource(TEST_PERMISSION_SOURCE_ID, (userId) => granted.get(userId) ?? []);
}

/**
 * Gives an account exactly these permissions, replacing what it had: an empty
 * list takes everything away. Rights come from the test permission source, the
 * way a plugin holding the account directory would give them.
 */
export function grantTestPermissions(_db: unknown, userId: string, permissions: readonly string[]): void {
  installTestPermissionSource();
  granted.set(userId, [...permissions]);
  source?.invalidate(userId);
}

/** Forgets every grant and releases the seam, back to the "no source" case. */
export function clearTestPermissions(): void {
  granted.clear();
  source?.release();
  source = null;
}
