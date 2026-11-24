'use client';

import { NotificationBell } from '@/components/notification-bell';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { NotificationsWidget } from './notifications-widget';

/** The bell, shaped by its zone. In a compact zone — the top bar's line or a
 *  sidebar — it is the button and its badge, the list opening on click: under
 *  it on the line, next to it in a column. In a wide zone (cockpit, chat
 *  column) it is the list as a card. Both forms read the same feed hook, so
 *  the badge, the list and the kind filters of the account stay one state. */
export function BellWidget({ orientation, compact, handle, ...props }: WidgetProps) {
  if (compact) {
    // The host lays the zone out (a line, or a column of icons): the grip and
    // the cross follow the bell in that direction.
    return (
      <>
        <span className="flex shrink-0 items-center self-center"><NotificationBell placement={orientation === 'horizontal' ? 'below' : 'beside'} /></span>
        {handle}
      </>
    );
  }
  return <NotificationsWidget handle={handle} {...props} />;
}
