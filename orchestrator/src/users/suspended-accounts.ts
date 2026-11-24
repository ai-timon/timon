/**
 * Accounts whose access is suspended (free-access.ts), told to the superadmins
 * once (TODO #906, the maintainer's decision of 05/11/2026): without a pro licence or
 * without the Multi-user plugin, only the first superadmin stays active. The
 * other accounts keep their data; this card says so, and why, rather than
 * leaving the superadmin to find out from a teammate who cannot sign in.
 *
 * Idempotent through the notification anchor: a card already open is not raised
 * again at every boot, and it closes by itself once nobody is suspended.
 */
import { daemonMessage } from '../daemon-message.js';
import { dbApi, type UserRow } from '../db.js';
import { createNotification, resolveAnchor } from '../notifications.js';
import { freeAccountAllowed } from './free-access.js';

export const SUSPENDED_ACCOUNTS_ANCHOR = 'accounts:suspended';

/** Active accounts the install does not serve right now. */
export function suspendedAccounts(): UserRow[] {
  return dbApi.listUsers().filter((u) => u.status === 'active' && !freeAccountAllowed(u.id));
}

/** Raises the card for each active superadmin, or closes it; returns the number suspended. */
export function noticeSuspendedAccounts(): number {
  const suspended = suspendedAccounts();
  if (suspended.length === 0) {
    resolveAnchor(SUSPENDED_ACCOUNTS_ANCHOR);
    return 0;
  }
  const open = dbApi.listActiveNotificationsByAnchorPrefix(SUSPENDED_ACCOUNTS_ANCHOR, 'action_required');
  if (open.length > 0) return suspended.length;
  const n = suspended.length;
  console.warn(`[users] ${n} account(s) suspended: accounts beyond the first superadmin need a pro licence and the Multi-user plugin`);
  for (const admin of dbApi.listUsers()) {
    if (!admin.is_superadmin || admin.status !== 'active') continue;
    createNotification({
      type: 'action_required',
      title: n === 1 ? '1 account is suspended' : `${n} accounts are suspended`,
      body: 'Accounts beyond the first superadmin need a pro licence and the Multi-user plugin. Their data are kept, and they get their access back as soon as both are there.',
      anchor: SUSPENDED_ACCOUNTS_ANCHOR,
      ownerUserId: admin.id,
      message: daemonMessage('accounts_suspended', { count: n }),
    });
  }
  return n;
}
