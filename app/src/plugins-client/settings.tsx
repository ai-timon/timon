'use client';

import dynamic from 'next/dynamic';
import type { BundledClientPlugin } from './types';
import { ResourceMemoryPresets } from './settings/resource-memory-presets';
import { CONFIRM_DIALOG_SLOT, DIRECTORY_PICKER_SLOT, NOTICE_CARD_SLOT, NOTICES_SLOT } from '@/lib/plugin-host/slots';
import { ProductConfirmDialog } from '@/components/confirm-dialog/confirm-dialog';
import { ProductNoticeCard } from '@/components/notices/notices-host';
import { GitHubStarNotice } from '@/components/notices/github-star-notice';
import { ConfirmEmailNotice } from '@/components/notices/confirm-email-notice';
import { LicenseNotices } from '@/components/notices/license-notices';

// Loaded on demand (docs/BUNDLE-SIZE.md): only a folder request paints it.
const ProductDirectoryBrowser = dynamic(() => import('@/components/directory-browser').then((m) => m.ProductDirectoryBrowser), { ssr: false });

export const coreSettingsClient: BundledClientPlugin = {
  module: '@timon/settings',
  apply(ctx) {
    ctx.register({ slot: 'settings.resources' }, ResourceMemoryPresets);
    // Default occupant of `directory.picker` (a boot slot, TIM-0136): the folder
    // browser of the active machine's daemon, the route this module serves. A
    // plugin that takes the slot replaces it in Settings, projects and agents at
    // once; with the slot empty, each host still paints the product's browser.
    ctx.register({ slot: DIRECTORY_PICKER_SLOT, fallback: true }, ProductDirectoryBrowser);
    // Default occupant of `confirm.dialog` (a boot slot, TODO #781): every
    // confirmation of the app. Not loaded on demand: the host in the root
    // layout already imports it, for the empty slot.
    ctx.register({ slot: CONFIRM_DIALOG_SLOT, fallback: true }, ProductConfirmDialog);
    // Default occupant of `notices.card` (a boot slot, docs/NOTICES.md): every
    // bottom-left card. The host in the root layout already imports it.
    ctx.register({ slot: NOTICE_CARD_SLOT, fallback: true }, ProductNoticeCard);
    // The product's first notice: a star on GitHub, after a few days of use.
    ctx.register({ slot: NOTICES_SLOT, key: 'github-star' }, GitHubStarNotice);
    // An account whose address was never confirmed: no reset code reaches it.
    ctx.register({ slot: NOTICES_SLOT, key: 'confirm-email' }, ConfirmEmailNotice);
    // What the licence has to say (paid features paused, a refused licence, a
    // late payment, its end), in place of the former top banner. Data, like
    // every source's cards: the occupant of `notices.card` paints them
    // (ids `license-*`), so a plugin rewords or restyles them there.
    ctx.register({ slot: NOTICES_SLOT, key: 'license' }, LicenseNotices);
  },
};
