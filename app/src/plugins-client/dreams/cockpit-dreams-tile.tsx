'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Tile } from '@/components/tile';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { t } from '@/lib/i18n';
import { formatAgeShort } from '@/lib/intl';
import { cn } from '@/lib/utils';

// ── Types (mirror of the /dreams domain vocabulary) ──────────────────────────

type Dream = {
  id: number;
  kind: 'improve' | 'opportunity';
  project: string | null;
  title: string;
  status: string;
  created_at: number;
};

// ── Compact relative age ──────────────────────────────────────────────────────

function fmtAge(ms: number): string {
  return formatAgeShort(Math.max(0, Date.now() - ms));
}

// ── Icon per kind ─────────────────────────────────────────────────────────────

const KIND_ICON: Record<string, string> = {
  improve: '🔧',
  opportunity: '💡',
};

// ── Component ─────────────────────────────────────────────────────────────────

export function CockpitDreamsTile({ handle, className }: WidgetProps) {
  const [dreams, setDreams] = useState<Dream[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/dreams?status=active', { cache: 'no-store' });
      const j = await r.json();
      // Keep only what the compact display needs
      setDreams(((j.dreams ?? []) as Dream[]).slice(0, 5));
    } catch {
      // Silent: the cockpit must not shout about an API that is down
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <Tile
      title={t('dreamsPage.heading')}
      subtitle={loading ? '…' : t('cockpit.dreams.pending', { count: dreams.length })}
      className={cn(HUD_SURFACE, className)}
      actions={handle}
    >
      {loading ? (
        <div className="flex items-center justify-center py-6">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/50">
            {t('cockpit.common.loading')}
          </span>
        </div>
      ) : dreams.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1.5 py-6">
          <span className="text-lg">🌙</span>
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/50">
            {t('cockpit.dreams.empty')}
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {dreams.map((d) => (
            <li key={d.id}>
              <Link
                href="/dreams"
                className={cn(
                  'group flex items-center gap-2 rounded-lg px-2.5 py-2',
                  'transition-colors hover:bg-primary/10',
                )}
              >
                {/* Kind icon */}
                <span className="shrink-0 text-[13px] leading-none">
                  {KIND_ICON[d.kind] ?? '•'}
                </span>

                {/* Truncated title */}
                <span className="min-w-0 flex-1 truncate text-[11.5px] leading-snug text-foreground/85">
                  {d.title}
                </span>

                {/* Age */}
                <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-muted-foreground/60">
                  {fmtAge(d.created_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}
