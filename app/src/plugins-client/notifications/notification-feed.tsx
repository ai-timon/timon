'use client';

import Link from 'next/link';
import { ChatLink } from '@/components/chat/chat-link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Check, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { plainPreview } from '@/lib/plain-preview';
import { t } from '@/lib/i18n';
import { sseOn } from '@/lib/sse-stream';
import { notificationHref } from '@/lib/notification-href';
import { reltime } from '@/app/agents/notification-rail';
import { NotificationIconBadge, UrgentPill } from './notification-icon';
import { AgentAvatar, useAgentIdentities } from '@/components/agent-avatar';
import { BRAND } from '@/lib/brand';
import { CopyNotificationButton } from './copy-notification-button';
import { useNotificationPrefs } from '@/hooks/use-notification-prefs';
import {
  applyNotificationPrefs,
  feedFetchLimit,
  isFeedFiltered,
  toggleActionOnly,
  visibleNotificationTotal,
  visibleNotificationTypes,
} from '@/lib/notification-prefs';

/**
 * The short list of recent notifications, shared by the bell's dropdown and
 * the movable "Notifications" widget: one body, two surfaces, so they can
 * never show different things.
 *
 * "Read" is the center's own notion of done: a notification marked as read is
 * dismissed — it leaves the badge and this list, and stays in the archive.
 */

export type FeedNotification = {
  id: string;
  type: 'action_required' | 'alert' | 'report';
  urgent: number;
  title: string;
  body: string | null;
  task_id: string | null;
  mission_id: string | null;
  anchor: string | null;
  created_at: number;
  /** Agent that raised it (its mission's, else its task's); null = Timon itself. */
  agent?: string | null;
};

const POLL_MS = 20_000;

export type NotificationFeedState = {
  /** Visible kinds only, at most the chosen maximum. */
  items: FeedNotification[];
  /** Active notifications of the visible kinds: what the badge shows. */
  total: number;
  loading: boolean;
  /** Some kinds are hidden: an empty list says so rather than "nothing". */
  filtered: boolean;
  /** "Need you only" is on: the list holds `action_required` alone. */
  actionOnly: boolean;
  /** Flips "Need you only" for the account; a no-op until the settings are read. */
  toggleActionOnly: () => void;
  markRead: (id: string) => void;
  /** Dismisses the visible kinds only: a hidden kind is not "read" by a
   *  button that never showed it. */
  markAllRead: () => void;
};

type Counts = Partial<Record<FeedNotification['type'], number>>;

/** What the daemon answered, kept whole: the settings filter it at render, so
 *  a narrower maximum applies at once, without a round trip. */
type Snapshot = { rows: FeedNotification[]; totalActive: number; counts: Counts | undefined };

const EMPTY: Snapshot = { rows: [], totalActive: 0, counts: undefined };

/** The list and badge of the bell and the widget, filtered and capped by the
 *  settings of the archive page (`lib/notification-prefs.ts`). */
export function useNotificationFeed(): NotificationFeedState {
  const { prefs, known, ready, setPrefs } = useNotificationPrefs();
  const [data, setData] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const fetchLimit = feedFetchLimit(prefs);
  const filtered = isFeedFiltered(prefs);
  const visibleKey = visibleNotificationTypes(prefs).join(',');
  // Bumped when the list is emptied for another account: a fetch sent before
  // then answers for the previous one.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const at = generation.current;
    try {
      const r = await fetch(`/api/ui/notifications?limit=${fetchLimit}`, { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { notifications?: FeedNotification[]; total_active?: number; counts?: Counts };
      if (at === generation.current) setData({ rows: j.notifications ?? [], totalActive: j.total_active ?? 0, counts: j.counts });
    } catch { /* keep the last known list */ } finally {
      if (at === generation.current) setLoading(false);
    }
  }, [fetchLimit]);

  // Waits for the settings: fetching with the defaults first would ask the
  // daemon twice on every page load, and flash the unfiltered list. Settings
  // unknown again means another account: its predecessor's list goes too.
  useEffect(() => {
    if (!known) {
      generation.current += 1;
      setData(EMPTY);
      setLoading(true);
      return;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const unsub = sseOn('notifications_changed', () => void refresh());
    return () => {
      clearInterval(timer);
      unsub();
    };
  }, [refresh, known]);

  const markRead = useCallback((id: string) => {
    // Optimistic: the row goes at once, the refresh confirms.
    setData((prev) => {
      const gone = prev.rows.find((n) => n.id === id);
      return {
        rows: prev.rows.filter((n) => n.id !== id),
        totalActive: Math.max(0, prev.totalActive - 1),
        counts: gone && prev.counts
          ? { ...prev.counts, [gone.type]: Math.max(0, (prev.counts[gone.type] ?? 0) - 1) }
          : prev.counts,
      };
    });
    void fetch(`/api/ui/notifications/${encodeURIComponent(id)}/dismiss`, { method: 'POST', cache: 'no-store' })
      .catch(() => undefined)
      .finally(() => void refresh());
  }, [refresh]);

  const markAllRead = useCallback(() => {
    const visible = visibleKey.split(',') as FeedNotification['type'][];
    setData((prev) => {
      if (!filtered) return { rows: [], totalActive: 0, counts: prev.counts && { action_required: 0, alert: 0, report: 0 } };
      const dropped = prev.counts ? visible.reduce((sum, type) => sum + (prev.counts?.[type] ?? 0), 0) : 0;
      return {
        rows: prev.rows.filter((n) => !visible.includes(n.type)),
        totalActive: Math.max(0, prev.totalActive - dropped),
        counts: prev.counts && { ...prev.counts, ...Object.fromEntries(visible.map((type) => [type, 0])) },
      };
    });
    // The daemon dismisses one kind or all of them: one call per visible kind
    // when some are hidden.
    const bodies = filtered ? visible.map((type) => JSON.stringify({ type })) : ['{}'];
    void Promise.all(bodies.map((body) => fetch('/api/ui/notifications/dismiss-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      cache: 'no-store',
    }).catch(() => undefined)))
      .finally(() => void refresh());
  }, [refresh, filtered, visibleKey]);

  const items = useMemo(() => applyNotificationPrefs(data.rows, prefs), [data.rows, prefs]);
  const total = visibleNotificationTotal(data.totalActive, data.counts, prefs);
  const actionOnly = prefs.actionOnly === true;
  const flipActionOnly = useCallback(() => {
    if (ready) setPrefs(toggleActionOnly(prefs));
  }, [ready, setPrefs, prefs]);
  return { items, total, loading: loading || !known, filtered, actionOnly, toggleActionOnly: flipActionOnly, markRead, markAllRead };
}


/** Rows only: the header and the "See all" link belong to each surface. */
export function NotificationFeed({
  items,
  loading,
  filtered = false,
  actionOnly = false,
  onRead,
  onNavigate,
  className,
}: {
  items: FeedNotification[];
  loading: boolean;
  filtered?: boolean;
  actionOnly?: boolean;
  onRead: (id: string) => void;
  /** Called when a row's link is followed (the dropdown closes itself). */
  onNavigate?: () => void;
  className?: string;
}) {
  const { identityOf } = useAgentIdentities();
  if (items.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 py-6 text-center text-muted-foreground', className)}>
        <Bell className="size-5 opacity-30" aria-hidden="true" />
        <p className="text-xs">{loading
          ? t('notifications.loading')
          : t(actionOnly ? 'notifications.feed.emptyActionOnly' : filtered ? 'notifications.emptyFiltered' : 'notifications.empty')}</p>
      </div>
    );
  }

  return (
    // Rows are set apart by space and their own hover surface, never by a rule.
    <ul className={cn('flex flex-col gap-0.5', className)}>
      {items.map((n) => {
        const href = notificationHref(n);
        const text = (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[12.5px] font-medium leading-snug text-foreground" title={plainPreview(n.title)}>
                {plainPreview(n.title)}
              </span>
              {n.urgent === 1 && <UrgentPill type={n.type} label={t('notifications.urgent')} />}
            </span>
            {n.body && (
              <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{plainPreview(n.body)}</p>
            )}
            <p className="mt-1 flex min-w-0 items-center gap-1 text-[10.5px] text-muted-foreground/70" suppressHydrationWarning>
              <span
                data-notification-agent
                className="truncate font-medium text-muted-foreground"
                style={n.agent ? { color: identityOf(n.agent).accent } : undefined}
              >
                {n.agent ?? BRAND.displayName}
              </span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 tabular-nums">{reltime(n.created_at)} {t('notifications.ago')}</span>
            </p>
          </>
        );
        return (
          <li key={n.id} data-notification={n.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/50">
            {/* Who raised it: the agent's face, the kind of notification as a
                small mark on it. Timon's own notifications keep the mark alone. */}
            {n.agent ? (
              <span className="relative mt-0.5 shrink-0" aria-hidden="true">
                <AgentAvatar identity={identityOf(n.agent)} size="sm" live={false} />
                {/* An opaque base under the tinted badge: the avatar must not show through. */}
                <span className="absolute -bottom-1 -right-1.5 rounded-[5px] bg-popover ring-2 ring-popover">
                  <NotificationIconBadge n={n} urgent={n.urgent === 1} size="xs" />
                </span>
              </span>
            ) : (
              <NotificationIconBadge n={n} urgent={n.urgent === 1} className="mt-0.5" />
            )}
            {href ? (
              <ChatLink
                href={href}
                onClick={onNavigate}
                className="min-w-0 flex-1 rounded-sm outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
              >
                {text}
              </ChatLink>
            ) : (
              <div className="min-w-0 flex-1">{text}</div>
            )}
            {/* Always visible, not revealed on hover: a phone has no hover. */}
            <CopyNotificationButton notification={n} className="size-7" />
            <button
              type="button"
              onClick={() => onRead(n.id)}
              aria-label={t('notifications.feed.markRead')}
              title={t('notifications.feed.markRead')}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Check className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "Need you only", shared by both headers: a pressed chip, saved on the
 *  account like the kinds ticked on the archive page. */
export function ActionOnlyToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={t('notifications.feed.actionOnlyHint')}
      data-notification-action-only
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        on ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Zap className="size-3" aria-hidden="true" />
      {t('notifications.feed.actionOnly')}
    </button>
  );
}

/** "Mark all as read", shared by both headers. */
export function MarkAllReadButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
    >
      {t('notifications.feed.markAllRead')}
    </button>
  );
}

/** Footer link to the archive page, which stays the place for everything. */
export function SeeAllLink({ onClick }: { onClick?: () => void }) {
  return (
    <Link
      href="/notifications"
      prefetch={false}
      onClick={onClick}
      className="block rounded-lg px-2 py-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t('notifications.feed.seeAll')}
    </Link>
  );
}
