/**
 * `ctx.accountProvider` (API 15, sensitive permission `accounts:provision`): the
 * seam through which a plugin adds accounts to an install, the multi-user plugin
 * first. Accounts stay in the core's `users` table: the core runs the creation
 * inside the transaction that applies the licence quota, hashes the password
 * itself, never creates a superadmin, and writes the audit line. A session is
 * opened by the core's own cookie code, so the plugin never sees a token.
 *
 * One holder at a time: two plugins provisioning accounts would each believe
 * they own the install's account list. The first plugin to call the facade
 * holds it until it is unloaded.
 */
import type { Response } from 'express';
import { bus } from '../bus.js';
import { dbApi } from '../db.js';
import { DuplicateEmailError } from '../users/errors.js';
import { assertAccountWrite, LicenseCapabilityError } from '../license/capabilities.js';
import { licenseState } from '../license/runtime.js';
import type { UserRow } from '../db.js';
import { hashPasswordSync } from '../users/password.js';
import { setSession } from '../users/session-open.js';
import { onAccountChange } from '../users/account-changes.js';
import { claimAccountProvider, releaseAccountProvider } from '../users/account-provider-state.js';
import type {
  PluginAccountChange, PluginAccountProvider, PluginAuditEntry, PluginLegacyAccountTable, PluginProviderAccount,
  PluginProviderAccountPatch, PluginProvisionedAccount, PluginProvisionInput, PluginSessionRequest, PluginSessionResponse,
} from './contract/accounts.js';
import { LEGACY_ACCOUNT_TABLES } from '../db.js';

/** Same floor as the core's own forms. */
export const PROVISION_MIN_PASSWORD = 8;

export class AccountProviderError extends Error {
  constructor(public readonly code: 'not_trusted' | 'held' | 'invalid' | 'duplicate' | 'refused', message: string) {
    super(message);
    this.name = 'AccountProviderError';
  }
}

export { accountProviderHolder, releaseAccountProvider } from '../users/account-provider-state.js';

function claim(pluginId: string): void {
  const current = claimAccountProvider(pluginId);
  if (current !== pluginId) {
    throw new AccountProviderError('held', `the account provider is held by plugin \`${current}\``);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUDIT_TEXT_MAX = 200;
const AUDIT_LOG_MAX = 1000;

function view(user: UserRow): PluginProviderAccount {
  return {
    id: user.id, email: user.email, name: user.name, status: user.status, isSuperadmin: user.is_superadmin,
    createdAt: user.created_at, lastLoginAt: user.last_login_at,
  };
}

function auditText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > AUDIT_TEXT_MAX) {
    throw new AccountProviderError('invalid', `the audit ${what} is a non-empty string of at most ${AUDIT_TEXT_MAX} characters`);
  }
  return value.trim();
}

export function createAccountProviderFacade(opts: {
  pluginId: string;
  /** Asserts the manifest permission, like every facade. */
  assertPermission: () => void;
  /** Signed or shipped with the product: an unsigned plugin never adds accounts. */
  trusted: boolean;
  /** Registers a disposer run when the plugin is unloaded. */
  onUnload: (fn: () => void) => void;
  /** The manifest declares `accounts:provision`: a trusted plugin then holds the provider from its mount. */
  declared?: boolean;
  /** The account behind the current request, `null` for a job or an anonymous caller. */
  callerUserId?: () => string | null;
}): PluginAccountProvider {
  const { pluginId } = opts;
  const unsubscribes = new Set<() => void>();
  // Held from the mount, not from the first call: at boot, the accounts it
  // serves must not look suspended until the plugin happens to call it.
  if (opts.declared && opts.trusted && claimAccountProvider(pluginId) !== pluginId) {
    console.warn(`[accounts] plugin \`${pluginId}\` declares accounts:provision, but the provider is already held`);
  }
  opts.onUnload(() => {
    for (const off of unsubscribes) off();
    unsubscribes.clear();
    releaseAccountProvider(pluginId);
  });
  const enter = (): void => {
    opts.assertPermission();
    if (!opts.trusted) {
      throw new AccountProviderError('not_trusted', `plugin \`${pluginId}\` is not signed: it cannot provide accounts`);
    }
    claim(pluginId);
  };

  return {
    provision(input: PluginProvisionInput): PluginProvisionedAccount {
      enter();
      const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
      const name = typeof input?.name === 'string' ? input.name.trim() : '';
      const status = input?.status ?? 'active';
      if (!EMAIL.test(email)) throw new AccountProviderError('invalid', 'a valid e-mail is required');
      if (!name) throw new AccountProviderError('invalid', 'a name is required');
      if (typeof input.password !== 'string' || input.password.length < PROVISION_MIN_PASSWORD) {
        throw new AccountProviderError('invalid', `the password must be at least ${PROVISION_MIN_PASSWORD} characters`);
      }
      if (status !== 'active' && status !== 'invited') throw new AccountProviderError('invalid', 'status is `active` or `invited`');
      let user;
      try {
        user = dbApi.createUser({
          email, name, passwordHash: hashPasswordSync(input.password), status, isSuperadmin: false, source: 'provider',
        });
      } catch (err) {
        if (err instanceof DuplicateEmailError) throw new AccountProviderError('duplicate', 'an account already uses this e-mail');
        // The licence funnel counts it here, where every account provider's
        // creation is refused, whatever route of the plugin asked.
        if (err instanceof LicenseCapabilityError && (err.code === 'user_limit' || err.code === 'single_superadmin_required')) {
          bus.publish({ kind: 'account_limit_reached', userId: opts.callerUserId?.() ?? null });
        }
        // The licence quota and the composition refusals carry their own message.
        throw new AccountProviderError('refused', (err as Error).message);
      }
      // Nobody proved they read this address: an admin typed it, or an
      // invitation link was handed over by hand. The relay mails a reset code
      // only to an address it saw confirmed, so the owner is offered the
      // mailed code from their profile (`docs/EMAIL-CODES.md`).
      dbApi.setUserEmailUnverified(user.id, true);
      dbApi.insertAuditLog({ userId: null, actor: `plugin:${pluginId}`, action: 'user.create', target: `user:${user.id}`, ip: null });
      return { id: user.id, email: user.email, name: user.name, status };
    },

    list(): PluginProviderAccount[] {
      enter();
      return dbApi.listUsers().map(view);
    },

    get(userId: string): PluginProviderAccount | undefined {
      enter();
      const user = typeof userId === 'string' ? dbApi.getUserById(userId) : undefined;
      return user ? view(user) : undefined;
    },

    findByEmail(email: string): PluginProviderAccount | undefined {
      enter();
      if (typeof email !== 'string' || !email.trim()) return undefined;
      const user = dbApi.getUserByEmail(email);
      return user ? view(user) : undefined;
    },

    update(userId: string, patch: PluginProviderAccountPatch): PluginProviderAccount {
      enter();
      const user = typeof userId === 'string' ? dbApi.getUserById(userId) : undefined;
      if (!user) throw new AccountProviderError('invalid', 'no such account');
      // The superadmin is the operator's own account: a plugin never changes it.
      if (user.is_superadmin) throw new AccountProviderError('refused', 'a superadmin account is never changed by a plugin');
      if (!patch || typeof patch !== 'object') throw new AccountProviderError('invalid', 'a patch object is required');
      const name = patch.name === undefined ? undefined : typeof patch.name === 'string' ? patch.name.trim() : '';
      if (name !== undefined && !name) throw new AccountProviderError('invalid', 'a name is required');
      if (patch.password !== undefined && (typeof patch.password !== 'string' || patch.password.length < PROVISION_MIN_PASSWORD)) {
        throw new AccountProviderError('invalid', `the password must be at least ${PROVISION_MIN_PASSWORD} characters`);
      }
      if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'disabled') {
        throw new AccountProviderError('invalid', 'status is `active` or `disabled`');
      }
      if (name === undefined && patch.password === undefined && patch.status === undefined) {
        throw new AccountProviderError('invalid', 'name, password or status required');
      }
      const status = patch.status;
      if (status === 'active' && user.status !== 'active') {
        try {
          // Same check as the core's own account editor: a disabled account
          // coming back takes a seat again.
          assertAccountWrite(licenseState(), { isSuperadmin: false, status }, dbApi.countUsersInUse(), user.status === 'disabled');
        } catch (err) {
          if (err instanceof LicenseCapabilityError) throw new AccountProviderError('refused', err.message);
          throw err;
        }
      }
      const actor = `plugin:${pluginId}`;
      const by = opts.callerUserId?.() ?? null;
      const target = `user:${user.id}`;
      if (name !== undefined && name !== user.name) {
        dbApi.setUserName(user.id, name);
        dbApi.insertAuditLog({ userId: by, actor, action: 'user.rename', target, ip: null });
      }
      if (patch.password !== undefined) {
        dbApi.setUserPassword(user.id, hashPasswordSync(patch.password));
        // A new password ends the sessions opened with the old one.
        dbApi.revokeUserAccess(user.id);
        dbApi.insertAuditLog({ userId: by, actor, action: 'user.set_password', target, ip: null });
      }
      if (status !== undefined && status !== user.status) {
        dbApi.setUserStatus(user.id, status);
        if (status === 'disabled') dbApi.revokeUserAccess(user.id);
        dbApi.insertAuditLog({ userId: by, actor, action: status === 'disabled' ? 'user.disable' : 'user.enable', target, ip: null });
      }
      return view(dbApi.getUserById(user.id)!);
    },

    audit(action: string, target?: string | null): void {
      enter();
      const at = auditText(action, 'action');
      const on = target === undefined || target === null ? null : auditText(target, 'target');
      dbApi.insertAuditLog({ userId: opts.callerUserId?.() ?? null, actor: `plugin:${pluginId}`, action: at, target: on, ip: null });
    },

    auditLog(limit?: number): PluginAuditEntry[] {
      enter();
      const n = limit ?? 200;
      if (!Number.isInteger(n) || n < 1 || n > AUDIT_LOG_MAX) {
        throw new AccountProviderError('invalid', `limit is an integer between 1 and ${AUDIT_LOG_MAX}`);
      }
      return dbApi.listAuditLog(n).map((row) => ({
        id: row.id, at: row.at, userId: row.user_id, actor: row.actor, action: row.action, target: row.target,
      }));
    },

    openSession(userId: string, req: PluginSessionRequest, res: PluginSessionResponse): void {
      enter();
      const user = typeof userId === 'string' ? dbApi.getUserById(userId) : undefined;
      if (!user) throw new AccountProviderError('invalid', 'no such account');
      // A plugin opening a session as the superadmin would hold the install.
      if (user.is_superadmin) throw new AccountProviderError('refused', 'a session is never opened for a superadmin');
      if (user.status !== 'active') throw new AccountProviderError('refused', 'the account is not active');
      setSession(res as unknown as Response, user.id, req.header('user-agent') ?? undefined);
      dbApi.insertAuditLog({ userId: user.id, actor: `plugin:${pluginId}`, action: 'session.open', target: `user:${user.id}`, ip: null });
    },

    readLegacy(table: PluginLegacyAccountTable): Record<string, unknown>[] {
      enter();
      if (!(LEGACY_ACCOUNT_TABLES as readonly string[]).includes(table)) {
        throw new AccountProviderError('invalid', `not a legacy account table: ${String(table)}`);
      }
      return dbApi.readLegacyAccountTable(table);
    },

    onAccountChanged(fn: (change: PluginAccountChange) => void): () => void {
      enter();
      const off = onAccountChange((change) => fn({ userId: change.userId, status: change.status, previous: change.previous }));
      unsubscribes.add(off);
      return () => { off(); unsubscribes.delete(off); };
    },
  };
}
