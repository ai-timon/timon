'use client';

import { Tile } from '@/components/tile';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { t } from '@/lib/i18n';
import { ActionOnlyToggle, MarkAllReadButton, NotificationFeed, SeeAllLink, useNotificationFeed } from './notification-feed';

/** The bell's dropdown, as a card: same list, same actions, placed wherever the
 *  user drops it (cockpit, the nav rail's widget zone, the chat columns). */
export function NotificationsWidget({ handle, className }: WidgetProps) {
  const feed = useNotificationFeed();
  return (
    <Tile
      title={t('notifications.bell.open')}
      subtitle={feed.total > 0 ? String(feed.total) : undefined}
      className={className}
      bodyClassName="p-0"
      actions={<>
        <MarkAllReadButton onClick={feed.markAllRead} disabled={feed.total === 0} />
        {handle}
      </>}
    >
      <div className="shrink-0 px-2 pb-1 pt-1.5">
        <ActionOnlyToggle on={feed.actionOnly} onToggle={feed.toggleActionOnly} />
      </div>
      <NotificationFeed
        items={feed.items}
        loading={feed.loading}
        filtered={feed.filtered}
        actionOnly={feed.actionOnly}
        onRead={feed.markRead}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5"
      />
      <div className="shrink-0 px-2 pb-2 pt-1">
        <SeeAllLink />
      </div>
    </Tile>
  );
}
