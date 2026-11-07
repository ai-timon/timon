'use client';

import { ChatLink } from '@/components/chat/chat-link';
import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { TopBar } from '@/components/topbar';
import { PushToggle } from '@/components/push-toggle';
import { NotificationFeedSettings } from '@/plugins-client/notifications/notification-feed-settings';
import { cn } from '@/lib/utils';
import { notificationHref } from '@/lib/notification-href';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { BRAND } from '@/lib/brand';
import { CopyNotificationButton } from '@/plugins-client/notifications/copy-notification-button';
import { NotificationKindBadge } from '@/plugins-client/notifications/notification-icon';
import { isModuleOn, isPageSurfaceAllowed, useCapabilities } from '@/lib/capabilities';
import { ForbiddenScreen, PluginOffScreen } from '@/lib/plugin-host/module-page-gate';
import { PageIslandBody, PageIslandHost } from '@/components/islands/page-island-host';
import { systemNotificationText, type SystemNotificationPresentation } from '@/lib/system-notifications';

type NotificationType = 'action_required' | 'alert' | 'report';

type Notification = {
  id: string;
  type: NotificationType;
  urgent: number;
  title: string;
  body: string | null;
  task_id: string | null;
  mission_id: string | null;
  anchor: string | null;
  created_at: number;
  read_at: number | null;
  dismissed_at: number | null;
  /** Agent that raised it; null = Timon itself. */
  agent?: string | null;
  presentation?: SystemNotificationPresentation;
};

function fmtDate(ts: number): string {
  return formatDateTime(ts, {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function NotificationsPage() {
  const caps = useCapabilities();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const on = caps !== null && isPageSurfaceAllowed(caps, '/notifications') && isModuleOn(caps, '@timon/notifications');

  useEffect(() => {
    if (!on) return;
    fetch('/api/ui/notifications?archived=true&limit=200', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : { notifications: [] })
      .then((j) => { setNotifications(j.notifications ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [on]);

  if (caps === null || !on) {
    const denial = caps === null
      ? <main className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">{t('route.loading')}</main>
      : !isPageSurfaceAllowed(caps, '/notifications')
        ? <ForbiddenScreen />
        : <PluginOffScreen path="/notifications" />;
    return (
      <div className="flex h-dvh flex-col pl-[var(--timon-nav-w)]">
        <div className="fixed inset-x-0 top-0 z-[6]">
          <TopBar />
        </div>
        <div className="flex min-h-0 flex-1 pt-[var(--timon-topbar-h)]">
          {denial}
        </div>
      </div>
    );
  }

  const typeLabel: Record<NotificationType, string> = {
    action_required: t('notifications.kind.action_required'),
    alert: t('notifications.kind.alert'),
    report: t('notifications.kind.report'),
  };

  return (
    <div className="flex h-dvh flex-col">
      <div className="fixed inset-x-0 top-0 z-[6]">
        <TopBar />
      </div>
      {/* The TopBar stays out of the workspace; the archive is the route's island. */}
      <PageIslandHost>
        <PageIslandBody className="flex h-full flex-col pl-[var(--timon-nav-w)]">
          <div className="mx-auto w-full max-w-2xl px-4 pt-[calc(var(--timon-topbar-h)+16px)] pb-8">
            <div className="mb-6 flex items-center gap-3">
              <Bell className="size-5 text-muted-foreground" />
              <h1 className="text-lg font-semibold">{t('notifications.archiveTitle')}</h1>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                {notifications.length}
              </span>
            </div>

            {/* Opt-in Web Push — the browser requires a user gesture, hence the
                explicit button. Placed here because this is the page reachable in one
                tap from the rail, including on phone. */}
            <div className="mb-6 flex flex-col gap-3">
              <PushToggle />
              <NotificationFeedSettings />
            </div>

            {loading ? (
              <p className="text-sm text-muted-foreground">{t('notifications.loading')}</p>
            ) : notifications.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('notifications.empty')}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {notifications.map((n) => {
                  const href = notificationHref(n);
                  const display = systemNotificationText(n);

                  const card = (
                    <div
                      className={cn(
                        'rounded-xl bg-card/80 px-4 py-3 transition-colors hover:bg-muted/50',
                        n.dismissed_at && 'opacity-60',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <NotificationKindBadge n={n} urgent={n.urgent === 1} label={n.urgent === 1 ? t('notifications.urgent') : typeLabel[n.type]} />
                            {n.dismissed_at && (
                              <span className="rounded-full bg-muted px-1.5 py-px text-[9.5px] font-semibold text-muted-foreground">{t('notifications.dismissed')}</span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[13.5px] font-semibold leading-snug">{display.title}</p>
                          {display.body && <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted-foreground">{display.body}</p>}
                        </div>
                        <span className="flex shrink-0 flex-col items-end gap-0.5 text-[10.5px] text-muted-foreground/70">
                          <span data-notification-agent className="font-medium text-muted-foreground">{n.agent ?? BRAND.displayName}</span>
                          <span className="tabular-nums">{fmtDate(n.created_at)}</span>
                          <CopyNotificationButton notification={display} className="mt-1 size-6" />
                        </span>
                      </div>
                    </div>
                  );

                  return href ? (
                    <ChatLink key={n.id} href={href}>{card}</ChatLink>
                  ) : (
                    <div key={n.id}>{card}</div>
                  );
                })}
              </div>
            )}
          </div>
        </PageIslandBody>
      </PageIslandHost>
    </div>
  );
}
