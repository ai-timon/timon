'use client';

/**
 * "Confirm your email address" — a notice source (an entry of the `notices`
 * slot, registered by the settings module) for an account whose address was
 * never confirmed (`emailUnverified` of `/api/auth/me`, docs/EMAIL-CODES.md).
 * Until it is, the site relay mails no reset code, so "Forgot your password?"
 * brings nothing: worth a card, not only a row deep in the Profile.
 *
 * One action: the Profile's confirmation row (`ConfirmEmailRow`), which sends
 * the code and opens the code screen. The card is not sent from here: mailing
 * a code is a gesture of its own, made where its answer (wait, error) shows.
 *
 * Not shown on the Profile itself: the row is already on screen with the same
 * action, and a card pointing at the page one is on is noise. Taken away (not
 * closed) there, and as soon as the address is confirmed.
 *
 * Closed per account by the host. The id carries a hash of the address: a
 * login moved to another address, unconfirmed again, asks again.
 */

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useMe } from '@/hooks/use-me';
import { t } from '@/lib/i18n';
import { useNotices } from './notice-context';

export const CONFIRM_EMAIL_NOTICE_PREFIX = 'confirm-email';
/** The Profile's row, reached from the card (`ConfirmEmailRow` scrolls to it). */
export const CONFIRM_EMAIL_ANCHOR = 'confirm-email';
export const CONFIRM_EMAIL_HREF = `/profile#${CONFIRM_EMAIL_ANCHOR}`;

/**
 * A short, stable tag of the address (FNV-1a, 32 bits): enough to tell two
 * addresses of one account apart, without putting the address itself in the
 * account's closed list.
 */
export function addressTag(email: string): string {
  let hash = 0x811c9dc5;
  for (const char of email.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function confirmEmailNoticeId(email: string): string {
  return `${CONFIRM_EMAIL_NOTICE_PREFIX}-${addressTag(email)}`;
}

function onProfile(pathname: string | null): boolean {
  const path = pathname ?? (typeof window === 'undefined' ? '' : window.location.pathname);
  return path === '/profile' || path.startsWith('/profile/');
}

export function ConfirmEmailNotice(): null {
  const notices = useNotices();
  const push = notices?.push;
  const remove = notices?.remove;
  const me = useMe();
  const pathname = usePathname();
  const email = me?.user?.email ?? null;
  const id = email ? confirmEmailNoticeId(email) : null;
  const show = id !== null && me?.emailUnverified === true && !onProfile(pathname);

  useEffect(() => {
    if (!push || !remove || !id || !show) return;
    push({
      id,
      tone: 'info',
      title: t('notices.confirmEmail.title'),
      body: t('notices.confirmEmail.body'),
      actions: [{ label: t('notices.confirmEmail.action'), href: CONFIRM_EMAIL_HREF }],
      dismissible: true,
    });
    return () => { remove(id); };
  }, [push, remove, id, show]);
  return null;
}
