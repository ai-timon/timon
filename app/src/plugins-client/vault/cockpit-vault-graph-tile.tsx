'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import VaultGraph3D from '@/components/vault/vault-graph-3d';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { NativeViewCover } from '@/lib/native-view-cover';

/**
 * The vault's 3D graph, now a widget like the others.
 *
 * The canvas needs explicit `width`/`height` in pixels: VaultGraph3D derives
 * them itself through a ResizeObserver on its container, which assumes that
 * container has a size of its own — hence the `min-h-0 flex-1` body under a
 * fixed-height header.
 */
export function CockpitVaultGraphTile({ handle, className }: WidgetProps) {
  // The magnifier and the expand button live in the header, the only place with
  // room; what they open lives elsewhere. Hence the state held here.
  const [searchOpen, setSearchOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Escape closes the full screen. Search comes first: a first Escape closes
  // the field, only a second one leaves the full screen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (searchOpen) setSearchOpen(false);
      else setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, searchOpen]);

  // ONE single copy of the graph is mounted at a time: two instances would
  // mean two WebGL contexts and two simulations. Moving it from one parent to
  // the other remounts it, but the scene finds its layout intact — the nodes
  // are memoised in VaultGraph3D and already carry their coordinates.
  const graph = (
    <VaultGraph3D
      searchOpen={searchOpen}
      onCloseSearch={() => setSearchOpen(false)}
    />
  );

  const buttons = (
    <>
      <button
        type="button"
        onClick={() => setSearchOpen((v) => !v)}
        aria-label={t('vault.filterNotes')}
        aria-pressed={searchOpen}
        className={cn(
          'grid size-6 place-items-center rounded transition-colors',
          searchOpen
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground/70 hover:bg-muted hover:text-foreground',
        )}
      >
        <Search className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setFullscreen((v) => !v)}
        aria-label={fullscreen ? t('vault.exitFullscreen') : t('vault.enterFullscreen')}
        className="grid size-6 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
      >
        {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>
    </>
  );

  return (
    <section className={cn('flex min-h-0 flex-col overflow-hidden rounded-2xl border', HUD_SURFACE, className)}>
      <header className="flex items-center gap-2.5 px-4 pt-3 pb-2.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('vault.heading')}
        </span>
        <span className="text-[11px] text-muted-foreground/50">{t('vault.graph3d')}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {buttons}
          {handle}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {fullscreen ? (
          <div className="grid h-full w-full place-items-center px-4 text-center text-[11px] text-muted-foreground/60">
            {t('vault.openFullscreen')}
          </div>
        ) : (
          graph
        )}
      </div>

      {/* Portal to `body`: `HUD_SURFACE` carries `backdrop-blur-xl`, which makes
          the tile the containing block of its `position: fixed` descendants. A
          full screen placed inside would therefore be contained in the tile, and
          clipped by its `overflow-hidden`. */}
      {fullscreen && createPortal(
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 p-4 backdrop-blur-sm">
          <NativeViewCover />
          <header className="flex shrink-0 items-center gap-2.5 pb-3">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('vault.heading')}
            </span>
            <span className="text-[11px] text-muted-foreground/50">{t('vault.graph3d')}</span>
            <div className="ml-auto flex items-center gap-1.5">{buttons}</div>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
            {graph}
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
