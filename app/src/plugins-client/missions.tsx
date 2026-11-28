'use client';

import dynamic from 'next/dynamic';
import { ISLAND_ICON_CHAT, ISLAND_ICON_NETWORK } from '@/lib/island-tab-icons';
import { RecentMissions } from './starter-widgets';
import { MissionLivenessBadge } from './missions/liveness-badge';
import { registerWidget } from './widget';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { t } from '@/lib/i18n';
import { History, MessagesSquare } from 'lucide-react';
import { isNavSurfaceAllowed } from '@/lib/capabilities';
import { ACTIVITY_ROUTES, ACTIVITY_TABS, ActivityPage, type ActivityTabId } from './activity/activity-page';
import { registerNavItem } from './nav';
import { registerPage } from './page';
import type { BundledClientPlugin } from './types';
import { widgetPicto } from './widget-pictos';
import { ChatIsland } from './missions/chat-island';
import { ChatTabIcon } from './missions/chat-tab-icon';
import { CHAT_ISLAND_KEY, parseChatIslandParams } from '@/lib/chat-island-params';
import { CHAT_COLUMNS_EXCLUSIVE } from '@/components/chat/chat-island-host';
import { ChatMediaCard } from '@/components/chat/media-block';
import { FenceGrantCard } from '@/components/chat/fence-grant-card';
import { CHAT_FENCE_GRANT_SLOT, CHAT_MEDIA_SLOT } from '@/lib/plugin-host/slots';
import { EGRESS_ISLAND_KEY, parseEgressIslandParams } from '@/lib/egress';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const DelegationsWidget = dynamic(() => import('./missions/delegations-widget').then((m) => m.DelegationsWidget), { ssr: false });
// Framed by the host (`frame` left to `tile`): the props it is typed with never reach it.
const EgressWidget = dynamic<WidgetProps>(() => import('./missions/egress-view').then((m) => m.EgressWidget), { ssr: false });
const EgressIsland = dynamic(() => import('./missions/egress-view').then((m) => m.EgressIsland), { ssr: false });
const MissionTitleBackfillSettings = dynamic(() => import('./missions/title-backfill-settings').then((m) => m.MissionTitleBackfillSettings), { ssr: false });
const MissionTitleModelSettings = dynamic(() => import('./missions/title-model-settings').then((m) => m.MissionTitleModelSettings), { ssr: false });

const TAB_SURFACE: Readonly<Record<ActivityTabId, { href: string; zone?: string }>> = {
  missions: { href: '/missions', zone: 'nav.missions' },
  inbox: { href: '/messages', zone: 'nav.inbox' },
  memory: { href: '/memory', zone: 'nav.memory' },
  stats: { href: '/dashboard', zone: 'nav.stats' },
};

export const coreMissionsClient: BundledClientPlugin = {
  module: '@timon/missions',
  apply(ctx) {
    // Default occupant of `chat.media` (a boot slot): mounted with the module, not
    // with the cards, so a plugin's replacement keeps the slot across conversations.
    ctx.register({ slot: CHAT_MEDIA_SLOT, fallback: true }, ChatMediaCard);
    // The "Allow for this agent" card of a path the mission fence refused (TODO #1162),
    // the default occupant of its boot slot, like the media card.
    ctx.register({ slot: CHAT_FENCE_GRANT_SLOT, fallback: true }, FenceGrantCard);
    registerWidget(ctx, { key: 'recent', widget: { title: t('widgetCatalog.recentMissions.title'), icon: widgetPicto('recentMissions'), description: t('widgetCatalog.recentMissions.description'), zone: 'gauche', height: 300, minHeight: 150 }, Component: RecentMissions });
    // Delegated missions still owed a return. Registered like any other card
    // (`cockpit.widget`), so it is movable into the chat rails as well as the
    // cockpit — its content simply depends on being mounted inside a chat.
    registerWidget(ctx, { key: 'delegations', widget: { title: t('widgetCatalog.delegations.title'), icon: widgetPicto('delegations'), description: t('widgetCatalog.delegations.description'), zone: 'chat.left.widget', height: 220, minHeight: 120, frame: 'none' }, Component: DelegationsWidget });
    // The open mission's outbound connections (TODO #590): a card of the chat
    // rails, waiting in the palette like any new card.
    registerWidget(ctx, { key: 'egress', widget: { title: t('widgetCatalog.missionNetwork.title'), icon: widgetPicto('missionNetwork'), description: t('widgetCatalog.missionNetwork.description'), zone: 'chat.right.widget', height: 320, minHeight: 160 }, Component: EgressWidget });
    // The same view for a named mission, beside any page: what the new-host
    // alert opens (`lib/egress-deep-link.ts`).
    ctx.register({
      slot: 'island.content',
      key: EGRESS_ISLAND_KEY,
      island: {
        title: t('islands.missionEgress.title'),
        icon: ISLAND_ICON_NETWORK,
        parseParams: parseEgressIslandParams,
        params: {
          missionId: { type: 'string', required: true, maxLength: 128, description: 'Mission whose outbound connections are listed.' },
        },
        singletonBy: 'missionId',
        minWidth: 300,
      },
    }, EgressIsland);
    // Which of working / turn done / open / interrupted a mission is: `running`
    // alone cannot tell a live process from a finished turn.
    ctx.register({ slot: 'mission.card.badge', order: 10 }, MissionLivenessBadge);
    // Which model names the account's conversations (TODO #358): a graft of
    // the native Missions category, as a third-party plugin would add one.
    ctx.register({ slot: 'settings.missions' }, MissionTitleModelSettings);
    ctx.register({ slot: 'settings.missions', key: 'title-backfill' }, MissionTitleBackfillSettings);
    // An agent's chat as a content of the island workspace. Same slot, same
    // contract as a third-party content: no privilege (§5).
    ctx.register({
      slot: 'island.content',
      key: CHAT_ISLAND_KEY,
      island: {
        title: t('islands.chat.title'),
        icon: ISLAND_ICON_CHAT,
        tabIcon: ChatTabIcon,
        parseParams: parseChatIslandParams,
        params: {
          agent: { type: 'string', required: true, maxLength: 128, description: 'Name of the agent whose chat opens (letters, digits, `.`, `_`, `-`).' },
          missionId: { type: 'string', nullable: true, maxLength: 128, description: 'Mission (conversation) to continue; null asks the user which one, unless `fresh`.' },
          fresh: { type: 'boolean', description: 'Start a new conversation instead of asking (ignored when `missionId` is set).' },
        },
        // Recalling an arrangement brings the agents back, never the conversations.
        volatileParams: ['missionId', 'fresh'],
        // Its columns fold into panels: the thread alone sets the minimum.
        minWidth: 360,
        // One set of widget zones per view, held by the primary chat (Q10).
        exclusive: CHAT_COLUMNS_EXCLUSIVE,
      },
    }, ChatIsland);
    registerNavItem(ctx, { href: '/multichat', labelKey: 'nav.multichat', icon: MessagesSquare, order: 40, zone: 'nav.multichat' });
    // Missions, Inbox, Memory and Stats are read rarely: one entry, four tabs.
    // A tab is offered when its own surface is (zone and permission alike), so
    // hiding `nav.memory` or lacking `/dashboard` drops the tab, not the entry.
    const tabs: ActivityTabId[] = ACTIVITY_TABS.map((tab) => tab.id).filter((id) => TAB_SURFACE[id].zone === undefined || ctx.zoneVisible(TAB_SURFACE[id].zone!))
      .filter((id) => isNavSurfaceAllowed(ctx.caps, TAB_SURFACE[id].href));
    if (tabs.length === 0) return;
    registerNavItem(ctx, { href: '/activity', labelKey: 'nav.activity', icon: History, order: 210, activeRoutes: ACTIVITY_ROUTES });
    registerPage(ctx, { route: '/activity', Component: function Activity() { return <ActivityPage tabs={tabs} />; } });
  },
};
