'use client';

import Link from 'next/link';
import { ChatLink } from '@/components/chat/chat-link';
import { Tile } from '@/components/tile';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Bell, Trash2, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { plainPreview } from '@/lib/plain-preview';
import { sseOn } from '@/lib/sse-stream';
import { useActiveNotificationCount } from '@/lib/use-notification-count';
import { notificationHref } from '@/lib/notification-href';
import { t } from '@/lib/i18n';
import { BRAND } from '@/lib/brand';
import { isZoneVisible, useCapabilities } from '@/lib/capabilities';
import { CopyNotificationButton } from '@/plugins-client/notifications/copy-notification-button';
import { NotificationKindBadge } from '@/plugins-client/notifications/notification-icon';

type NotificationType = 'action_required' | 'alert' | 'report';
type FilterTab = 'all' | 'alert' | 'action_required' | 'report';

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
};

type Counts = Record<NotificationType, number>;

export function reltime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

/** Past these lengths the collapsed card cuts the text (two-line title,
 *  two-line body at the rail's width). A length test rather than measuring
 *  the overflow: it holds before layout and in any container width. */
const TITLE_FIT = 80;
const BODY_FIT = 110;

export function isLongNotification(n: { title: string; body: string | null }): boolean {
  return n.title.length > TITLE_FIT || (n.body?.length ?? 0) > BODY_FIT || (n.body?.includes('\n') ?? false);
}

export function NotifCard({
  n,
  onDismiss,
}: {
  n: Notification;
  onDismiss: (id: string) => void;
}) {
  const isUrgent = n.urgent === 1;

  // Built the same way as the Web Push payload — see lib/notification-href.
  const missionHref = notificationHref(n);
  const [expanded, setExpanded] = useState(false);
  const expandable = isLongNotification(n);

  const kindLabel = isUrgent ? t('notifications.urgent') : t(`notifications.kind.${n.type}`);
  const cardContent = (
    <div className="nr-card group relative rounded-xl bg-card/80 px-3 py-2.5 shadow-sm backdrop-blur transition-colors hover:bg-muted/60">
      {/* Who and when, after the kind: the line the hover actions cover. */}
      <div className="flex min-w-0 items-center gap-2">
        <NotificationKindBadge n={n} urgent={isUrgent} label={kindLabel} />
        <p className="min-w-0 truncate text-[10px] text-muted-foreground/70" suppressHydrationWarning>
          <span data-notification-agent className="font-medium text-muted-foreground">{n.agent ?? BRAND.displayName}</span>
          {' · '}
          <span className="tabular-nums">{reltime(n.created_at)} {t('notifications.ago')}</span>
        </p>
      </div>
      <p
        className={cn(
          'mt-1.5 text-[12px] font-semibold leading-snug text-foreground',
          expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2 break-words',
        )}
        title={expanded ? undefined : plainPreview(n.title)}
      >
        {plainPreview(n.title)}
      </p>
      {n.body && (
        <p
          className={cn(
            'mt-0.5 text-[11px] leading-snug text-muted-foreground',
            expanded ? 'select-text whitespace-pre-wrap break-words' : 'line-clamp-2',
          )}
          title={expanded ? undefined : plainPreview(n.body)}
        >
          {plainPreview(n.body)}
        </p>
      )}
      {expandable && (
        <button
          type="button"
          onClick={(e) => {
            // Inside the mission link: expanding must not navigate.
            e.preventDefault();
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-expanded={expanded}
          className="mt-1 inline-flex items-center gap-0.5 rounded text-[10px] text-muted-foreground/80 hover:text-foreground"
        >
          <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
          {expanded ? t('notifications.showLess') : t('notifications.showMore')}
        </button>
      )}
      {/* Over the card, not beside it: hidden, they take no width from the text. */}
      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-md bg-card opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <CopyNotificationButton notification={n} className="size-6" />
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss(n.id);
          }}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('notifications.dismiss')}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );

  if (missionHref) {
    return (
      <ChatLink href={missionHref} className="block">
        {cardContent}
      </ChatLink>
    );
  }
  return cardContent;
}

export function NotificationRail({ poignee, className }: WidgetProps) {
  // `notifications` module off: the column has no source left. The check
  // lives HERE rather than at both call sites (agents, agents-grid) so the
  // rail and its badge answer to the same condition.
  const caps = useCapabilities();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [counts, setCounts] = useState<Counts>({ action_required: 0, alert: 0, report: 0 });
  const [filter, setFilter] = useState<FilterTab>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/notifications?limit=50', { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { notifications: Notification[]; counts: Counts };
      setNotifications(j.notifications ?? []);
      setCounts(j.counts ?? { action_required: 0, alert: 0, report: 0 });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 15_000);
    const unsub = sseOn('notifications_changed', () => refresh());
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      unsub();
    };
  }, [refresh]);

  const dismiss = useCallback(async (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    try {
      await fetch(`/api/ui/notifications/${id}/dismiss`, { method: 'POST', cache: 'no-store' });
      refresh();
    } catch { /* ignore */ }
  }, [refresh]);

  // Two steps on purpose: clearing everything cannot be undone, and an
  // accidental click on the bin would wipe unread alerts.
  const clearAll = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmClear(false);
    setNotifications((prev) => (filter === 'all' ? [] : prev.filter((n) => n.type !== filter)));
    try {
      await fetch('/api/ui/notifications/dismiss-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(filter === 'all' ? {} : { type: filter }),
        cache: 'no-store',
      });
      refresh();
    } catch { /* ignore */ }
  }, [confirmClear, filter, refresh]);

  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }, []);

  const filtered = filter === 'all' ? notifications : notifications.filter((n) => n.type === filter);
  const totalActive = counts.action_required + counts.alert + counts.report;
  const clearLabel = filter === 'all'
    ? t('notifications.clearAll')
    : filter === 'alert'
    ? t('notifications.clearAlerts')
    : filter === 'report'
    ? t('notifications.clearReports')
    : t('notifications.clearRequests');

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: 'all', label: t('notifications.all'), count: totalActive },
    { key: 'alert', label: t('notifications.alerts'), count: counts.alert },
    { key: 'action_required', label: t('notifications.action'), count: counts.action_required },
    { key: 'report', label: t('notifications.reports'), count: counts.report },
  ];

  // After the hooks, never before: an early return higher up would change
  // the hook order between two renders.
  if (!isZoneVisible(caps, 'agents.notifications')) return null;

  return (
    <Tile title={<Link href="/notifications" className="hover:text-primary">{t('notifications.center')}</Link>} className={className} bodyClassName="gap-2 p-2" actions={<>
      {totalActive > 0 && <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">{totalActive}</span>}
      {filtered.length > 0 && <button type="button" onClick={() => void clearAll()} title={clearLabel} aria-label={clearLabel} className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md p-1 text-muted-foreground hover:bg-muted', confirmClear && 'bg-destructive/10 pr-1.5 text-destructive hover:bg-destructive/15')}>
        <Trash2 className="size-3.5 shrink-0" />{confirmClear && <span className="text-xs">{t('notifications.sure')}</span>}
      </button>}
      {poignee}
    </>}>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* Filter toggles chip — 4 tabs of equal width, never wrapping */}
        <div className="grid grid-cols-4 gap-0.5 rounded-lg bg-muted p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setFilter(t.key)}
              className={cn(
                'flex items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-0.5 text-[10px] transition-colors',
                filter === t.key
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {t.count > 0 && (
                <span
                  className={cn(
                    'rounded-full px-1 tabular-nums text-[9px] font-bold',
                    t.key === 'alert'
                      ? 'bg-red-500/20 text-red-400'
                      : t.key === 'action_required'
                      ? 'bg-amber-500/20 text-amber-400'
                      : t.key === 'report'
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'bg-muted/60 text-muted-foreground',
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Cards — no column background, the cards float */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-2 scrollbar-none">
          {filtered.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground">
              <Bell className="size-6 opacity-30" />
              <p className="text-[11px]">{t('notifications.empty')}</p>
            </div>
          ) : (
            filtered.map((n) => (
              <NotifCard key={n.id} n={n} onDismiss={dismiss} />
            ))
          )}
        </div>

      </div>{/* end pointer-events-auto wrapper */}

    </Tile>
  );
}

export function NotificationBadge() {
  const caps = useCapabilities();
  const count = useActiveNotificationCount();

  if (count === 0 || !isZoneVisible(caps, 'agents.notifications')) return null;
  return (
    <span className="rounded-full bg-destructive px-1.5 py-px tabular-nums text-[9px] font-bold text-white shadow">
      {count}
    </span>
  );
}
