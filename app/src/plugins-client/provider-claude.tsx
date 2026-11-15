'use client';

/**
 * Client half of the official Claude provider (`provider-claude`): the
 * sections its provider page adds to the common ones.
 *
 * That provider is a plugin with no browser half of its own, and its setting
 * calls the routes it serves (`/api/backends/claude-token`). Its sections ship
 * with the app, registered under the plugin's id, so the page paints them on
 * the Claude page only (`provider-sections.ts`) — exactly where a provider
 * plugin's own browser half would put them. Not a bundled module: the module
 * catalogue never names it, so it mounts with the app and the section reads
 * nothing when the plugin is gone (its route answers 404).
 */
import { PROVIDER_SECTION_SLOT, PROVIDER_SECTION_ORDER } from '@/components/provider-page/provider-sections';
import { ClaudeTokenPanel } from './backends/claude-token';
import type { BundledClientPlugin } from './types';

export const providerClaudeClient: BundledClientPlugin = {
  module: 'provider-claude',
  apply(ctx) {
    // Its own settings: right after the common own-settings section, last on the page.
    ctx.register({ slot: PROVIDER_SECTION_SLOT, order: PROVIDER_SECTION_ORDER.settings + 50 }, ClaudeTokenPanel);
  },
};
