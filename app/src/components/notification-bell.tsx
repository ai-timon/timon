'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bell } from 'lucide-react';
import { AnchoredPopover } from '@/components/anchored-popover';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { bellBadgeText } from '@/lib/notification-bell';
import type { PopoverPlacement } from '@/lib/popover-placement';
import {
  ActionOnlyToggle,
  MarkAllReadButton,
  NotificationFeed,
  SeeAllLink,
  useNotificationFeed,
} from '@/plugins-client/notifications/notification-feed';

/** The bell button: opens a dropdown of the recent notifications, with a
 *  link to the archive page. The button is the same fixed 36px square whether
 *  or not there is a count: the badge is absolutely positioned, so it never
 *  moves the bar (which on a phone folds away on scroll — a width change here
 *  would re-trigger it).
 *
 *  The same button in every compact zone: under it on the top bar's line
 *  (`below`), next to it in a sidebar (`beside`). The panel is the shared
 *  `AnchoredPopover`, which keeps it inside the window. */
export function NotificationBell({ placement = 'below' }: { placement?: PopoverPlacement } = {}) {
  const feed = useNotificationFeed();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const badge = bellBadgeText(feed.total);
  const label = badge ? t('notifications.bell.unread', { count: badge }) : t('notifications.bell.open');
  const close = () => setOpen(false);

  // A route change (a row followed, "See all") closes the panel.
  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon' }),
          'relative z-10 shrink-0 text-muted-foreground hover:text-foreground',
          (open || pathname === '/notifications') && 'text-foreground',
        )}
      >
        <Bell className="size-4" />
        {badge && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-0.5 top-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[9px] font-bold tabular-nums leading-4 text-white"
          >
            {badge}
          </span>
        )}
      </button>
      <AnchoredPopover
        open={open}
        onClose={close}
        anchorRef={button}
        placement={placement}
        id={panelId}
        label={t('notifications.bell.open')}
      >
        <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
          <span className="text-sm font-semibold">{t('notifications.bell.open')}</span>
          {feed.total > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-[10.5px] font-medium tabular-nums text-muted-foreground">{feed.total}</span>
          )}
          <span className="ml-auto">
            <MarkAllReadButton onClick={feed.markAllRead} disabled={feed.total === 0} />
          </span>
        </div>
        {/* Its own line: next to "Mark all as read" it does not fit 352px in French. */}
        <div className="shrink-0 px-2 pb-1">
          <ActionOnlyToggle on={feed.actionOnly} onToggle={feed.toggleActionOnly} />
        </div>
        <NotificationFeed
          items={feed.items}
          loading={feed.loading}
          filtered={feed.filtered}
          actionOnly={feed.actionOnly}
          onRead={feed.markRead}
          onNavigate={close}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5"
        />
        <div className="shrink-0 px-2 pb-2 pt-1">
          <SeeAllLink onClick={close} />
        </div>
      </AnchoredPopover>
    </>
  );
}
