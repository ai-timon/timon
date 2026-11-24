'use client';

/**
 * The demonstration cards of `/?notices-preview=1`: one of each kind the
 * product shows, to judge the card's look without waiting five days, an
 * offer or an announcement. Shown by `NoticesHost` instead of the real cards
 * for the life of the page, closings ignored, nothing written
 * (`startNoticesPreview`). Like every card, nothing without a session.
 *
 * Their actions open a page (public, or the Profile's licence block) or close
 * the card in this page; the update card's "Update" opens the update window's
 * preview (`update-preview.ts`). None starts a download or changes a setting.
 */

import { t } from '@/lib/i18n';
import { formatDate } from '@/lib/intl';
import type { NoticeInput } from '@/lib/notices';
import { openUpdatePreview, UPDATE_PREVIEW_VERSION } from '@/components/updates/update-preview';
import { GITHUB_REPOSITORY_URL, GITHUB_STAR_NOTICE_ID } from './github-star-notice';
import { CONFIRM_EMAIL_HREF } from './confirm-email-notice';
import { licenseNoticeInput } from './license-notices';

export const NOTICES_PREVIEW_PARAM = 'notices-preview';
export const DISCORD_INVITE_URL = 'https://discord.gg/ZQGARNcpZ3';
const DAY_MS = 86_400_000;

/** Whether this address asks for the preview: `?notices-preview=1`. */
export function noticesPreviewRequested(search: string): boolean {
  return new URLSearchParams(search).get(NOTICES_PREVIEW_PARAM) === '1';
}

export function previewNotices(now: number = Date.now()): (NoticeInput & { pluginId: string })[] {
  const ends = formatDate(new Date(now + 5 * DAY_MS).toISOString(), { year: 'numeric', month: 'numeric', day: 'numeric' });
  return [
    {
      pluginId: '@timon/settings',
      id: GITHUB_STAR_NOTICE_ID,
      icon: 'github',
      title: t('notices.githubStar.title'),
      actions: [{ label: t('notices.githubStar.action'), href: GITHUB_REPOSITORY_URL, dismiss: true }],
    },
    {
      pluginId: '@timon/settings',
      id: 'discord',
      icon: 'discord',
      title: t('notices.preview.discord.title'),
      body: t('notices.preview.discord.body'),
      actions: [{ label: t('notices.preview.discord.action'), href: DISCORD_INVITE_URL, dismiss: true }],
    },
    {
      pluginId: '@timon/settings',
      id: 'confirm-email-preview',
      title: t('notices.confirmEmail.title'),
      body: t('notices.confirmEmail.body'),
      actions: [{ label: t('notices.confirmEmail.action'), href: CONFIRM_EMAIL_HREF }],
    },
    {
      pluginId: '@timon/updates',
      id: `update-${UPDATE_PREVIEW_VERSION}`,
      icon: 'timon',
      title: t('updates.notice.available', { version: UPDATE_PREVIEW_VERSION }),
      actions: [{ label: t('updates.notice.update'), onSelect: () => { openUpdatePreview(); } }],
    },
    {
      pluginId: '@timon/updates',
      id: 'build-ends-preview',
      tone: 'warning',
      title: t('updates.notice.buildEnds', { date: ends }),
    },
    // The licence's two definitive cards (docs/NOTICES.md): paid features
    // paused once the offline tolerance ran out, and a licence refused for good.
    { pluginId: '@timon/settings', ...licenseNoticeInput({ kind: 'paused', id: 'license-paused-preview' }, { canEnterKey: true }) },
    { pluginId: '@timon/settings', ...licenseNoticeInput({ kind: 'refused', id: 'license-refused-preview' }, { canEnterKey: true }) },
    {
      pluginId: '@timon/updates',
      id: 'feed.preview',
      icon: 'youtube',
      title: t('notices.preview.feed.title'),
      body: t('notices.preview.feed.body'),
      actions: [{ label: t('notices.feed.open'), href: 'https://timon-ai.com/', dismiss: true }],
    },
  ];
}
