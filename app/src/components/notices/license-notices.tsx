'use client';

/**
 * What the licence has to say, as bottom-left notice cards: a source of the
 * `notices` slot, registered by the settings module like the GitHub star
 * (docs/NOTICES.md). It replaced the banner at the top of the screen.
 *
 * Only what is real and asks something of the person: paid features paused
 * once the offline tolerance ran out, a licence the server refused, a late
 * payment, the licence's end. A server that cannot be reached while the paid
 * rights hold shows nothing (`licenseCards`). Each card's id changes with its
 * episode, so a card the account closed comes back only when the state does,
 * and it leaves by itself once the rights are back.
 */

import { useEffect, useRef } from 'react';
import { BRAND } from '@/lib/brand';
import { isPageSurfaceAllowed, useCapabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import { formatDate } from '@/lib/intl';
import { licenseCards, useLicense, type LicenseCard } from '@/lib/license';
import type { NoticeInput } from '@/lib/notices';
import { useNotices } from './notice-context';

/** The licence block of the profile, where an administrator enters a key. */
export const LICENSE_KEY_HREF = '/profile#license';
/** The public section that explains paused paid features and the offline tolerance. */
export const LICENSE_RENEWAL_DOCS_URL = `https://docs.${BRAND.domain}/usage/licence-api#when-paid-features-are-paused`;

function day(iso: string): string {
  return formatDate(iso, { year: 'numeric', month: 'numeric', day: 'numeric' });
}

/**
 * The card for one licence state. `canEnterKey`: the account may open the
 * licence block (an account that cannot gets the card without the link, as
 * the banner did). Shared with `/?notices-preview=1`, so the preview cannot
 * drift from the real card.
 */
export function licenseNoticeInput(card: LicenseCard, { canEnterKey }: { canEnterKey: boolean }): NoticeInput {
  const enterKey = canEnterKey ? [{ label: t('notices.license.enterKey'), href: LICENSE_KEY_HREF }] : [];
  switch (card.kind) {
    case 'paused':
      return {
        id: card.id, tone: 'warning', dismissible: true,
        title: t('notices.license.paused.title'),
        body: t('notices.license.paused.body', { brand: BRAND.displayName }),
        actions: [{ label: t('notices.license.paused.action'), href: LICENSE_RENEWAL_DOCS_URL }],
      };
    case 'refused':
      return {
        id: card.id, tone: 'warning', dismissible: true,
        title: t('notices.license.refused.title'),
        body: t('notices.license.refused.body', { brand: BRAND.displayName }),
        actions: enterKey,
      };
    case 'pastDue':
      return {
        id: card.id, tone: 'warning', dismissible: true,
        title: t('notices.license.pastDue.title'),
        body: card.until ? t('notices.license.pastDue.bodyUntil', { date: day(card.until) }) : t('notices.license.pastDue.body'),
        actions: canEnterKey ? [{ label: t('notices.license.pastDue.action'), href: LICENSE_KEY_HREF }] : [],
      };
    case 'ends':
      return {
        id: card.id, tone: card.urgent ? 'warning' : 'info', dismissible: true,
        title: t('notices.license.ends.title', { date: day(card.at) }),
        body: t('notices.license.ends.body'),
        actions: enterKey,
      };
  }
}

export function LicenseNotices(): null {
  const notices = useNotices();
  const push = notices?.push;
  const remove = notices?.remove;
  const license = useLicense();
  const capabilities = useCapabilities();
  // Wait for the capabilities: the beta rule and the link both depend on them.
  const ready = capabilities !== null;
  const beta = capabilities?.beta === true;
  const canEnterKey = isPageSurfaceAllowed(capabilities, '/license');
  const shown = useRef<string[]>([]);

  useEffect(() => {
    if (!push || !remove) return;
    const inputs = ready ? licenseCards(license, Date.now(), { beta }).map((card) => licenseNoticeInput(card, { canEnterKey })) : [];
    const ids = inputs.map((input) => input.id);
    // A state that changed takes its old card away: rights back, a new episode.
    for (const id of shown.current) if (!ids.includes(id)) remove(id);
    for (const input of inputs) push(input);
    shown.current = ids;
  }, [beta, canEnterKey, license, push, ready, remove]);

  useEffect(() => () => { if (remove) for (const id of shown.current) remove(id); }, [remove]);
  return null;
}
