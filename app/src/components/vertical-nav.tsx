'use client';

/**
 * Global vertical nav, anchored left below the header (TopBar), which
 * spans the full width above. Replaces the old horizontal row of links +
 * the "More" dropdown + the mobile hamburger from topbar.tsx.
 *
 * The TIMON logo now lives in the header (TopBar), not here: it only
 * starts below it, so it's never covered/overlapped on collapse-expand.
 *
 * Collapsed by default (icons only, `--timon-nav-w` = 56px, reserved in
 * every page's layout). Hovering expands it as an overlay above the
 * content (`fixed`, pushes nothing); a button at the bottom lets you pin
 * it expanded (persisted in localStorage) for those who prefer to keep
 * labels visible permanently.
 *
 * Mobile (<768px): no hover, no room for a permanent rail. The nav
 * disappears completely (`--timon-nav-w` = 0) and becomes a drawer that
 * slides in from the RIGHT — thumb side, and the side of the hamburger
 * that opens it in the header. The theme toggle moves there too: it no
 * longer has room in an already-crowded mobile header.
 */

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Globe,
  Moon,
  Pin,
  PinOff,
  Sun,
  X,
  Palette,
} from 'lucide-react';
import { hiddenOf, setHidden } from '@/lib/nav-hidden';
import { navLayoutOf, withNavLayout } from '@/lib/nav-order';
import { NavItems } from '@/components/nav-items';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { peekStoredLayout, useStoredLayout } from '@/hooks/use-stored-layout';
import { usePreviousScope } from '@/hooks/use-previous-scope';
import { rowHandover } from '@/lib/layout-handover';
import { leftoverNavScope, navPinnedOf, resolvedNavScope, sharedNavScope } from '@/lib/workspace-scope';
import { useLayoutSeed, useSeededNavScope } from '@/components/layout-seeds';
import { useColorScheme } from '@/components/theme-provider';
import { cn } from '@/lib/utils';
import { BrandLogo } from '@/components/brand-logo';
import { toggleBrowserPanel } from '@/lib/browser-panel-bus';
import { InstanceBadge, useInstance } from '@/components/instance-provider';
import { NavChromeProvider, useNavExpandedHolds } from '@/components/nav-link';
import { ChromeCorners } from '@/components/chrome-corners';
import { GlassRail } from '@/components/glass-rail';
import { SettingsNavLink } from '@/components/settings-nav-link';
import { NavFooter } from '@/components/nav-footer';
import { WidgetZone } from '@/components/widget-host/widget-zone';
import { t } from '@/lib/i18n';

// No entry list left in this file since U.10: every row of the rail — the
// main group, the divider, the secondary group — is a `nav.item` registered
// by the module that owns it (`app/src/plugins-client/`), painted through
// the slot in its declared order. A third-party plugin lands in the same
// list, after the product's own entries, until the person moves it: the
// order, the separators and the foot of the menu are theirs (TODO #456).

// Must match `w-56` (14rem = 224px) on the expanded nav below.
const NAV_W_PINNED = '224px';
const NAV_W_DEFAULT = '56px';
// Mobile: the drawer overlays the content, no page should reserve a
// left-hand gutter for it.
const NAV_W_MOBILE = '0px';
// Must match the Tailwind `md` breakpoint used on the desktop variants
// below: both describe the same boundary.
const MOBILE_MQ = '(max-width: 767px)';

// Set once a rail has hydrated in this document. Every later mount is a client
// navigation, which has no server markup to match: it can paint its real state
// at once instead of the collapsed one hydration needs (TIM-0105).
let railHydrated = false;

export function VerticalNav({
  mobileOpen = false,
  onMobileClose,
}: {
  /** Mobile drawer open. Driven by the header's hamburger (TopBar), which
   *  mounts this nav — so the state lives with the parent. */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
} = {}) {
  const pathname = usePathname();
  const instance = useInstance();
  const { scheme: resolvedTheme, setScheme: setTheme } = useColorScheme();
  const { key, owner, previousOwner } = useWorkspaceLayout();
  const seededScope = useSeededNavScope(owner);
  // Seeded from what this document already derived: a page change remounts
  // the rail, and waiting for the hash again painted it collapsed meanwhile.
  // On a full reload, the server's derivation stands in for it.
  const [ownerNav, setOwnerNav] = useState<{ owner: string; scope: string } | null>(() => {
    const scope = resolvedNavScope(owner) ?? seededScope;
    return owner && scope ? { owner, scope } : null;
  });
  useEffect(() => {
    if (!owner) {
      setOwnerNav(null);
      return;
    }
    let alive = true;
    void sharedNavScope(owner).then((scope) => {
      if (alive) setOwnerNav({ owner, scope });
    });
    return () => { alive = false; };
  }, [owner]);
  const navScope = ownerNav?.owner === owner ? ownerNav.scope : null;
  // Wait for the view key so the first read can still copy that view's
  // leftover, and on a remote machine for the row its rail had before.
  const previousNav = usePreviousScope(previousOwner, sharedNavScope);
  const { raw: readPrefs, update: updateNav } = useStoredLayout(
    navScope && key && previousNav !== undefined ? navScope : null,
    rowHandover(previousNav, leftoverNavScope(key)),
  );
  // A route visited for the first time has no view key yet, so the read above
  // has not started: the value this document already holds stands in for it,
  // or the rail drops its pin (and its hidden pages, its order) until it lands.
  // Without a view key (an agent the server could not read), the read never
  // starts on the first paint: the server's seed of the row still speaks.
  const navSeed = useLayoutSeed(navScope);
  const navPrefs = readPrefs ?? (peekStoredLayout(navScope) ?? navSeed ?? null);
  const pinned = navPinnedOf(navPrefs);
  const [hovered, setHovered] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const rereadHover = useRef<(() => void) | null>(null);
  // A menu opened from the rail keeps it expanded. Once the last one closes,
  // the next pointer move says whether the pointer is over the rail: it may
  // have left by the menu, which is gone and sends no leave. By geometry, not
  // `:hover`: the body keeps `pointer-events: none` through the menu's exit
  // animation, and the rail would fold under a pointer resting on it.
  const { held, holdExpanded } = useNavExpandedHolds(() => {
    rereadHover.current?.();
    const onMove = (e: PointerEvent) => {
      rereadHover.current = null;
      const rect = railRef.current?.getBoundingClientRect();
      setHovered(!!rect && e.clientX >= rect.left && e.clientX < rect.right && e.clientY >= rect.top && e.clientY < rect.bottom);
    };
    document.addEventListener('pointermove', onMove, { once: true });
    rereadHover.current = () => { document.removeEventListener('pointermove', onMove); rereadHover.current = null; };
  });
  useEffect(() => () => rereadHover.current?.(), []);
  const [mounted, setMounted] = useState(railHydrated);
  // Read at once so the width variable below is right from the first effect:
  // a wrong first value would reserve (then give back) the left gutter.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(MOBILE_MQ).matches,
  );

  useEffect(() => {
    railHydrated = true;
    setMounted(true);
  }, []);

  // Pinned = side-by-side layout: the nav must stop overlaying the
  // content, so we widen the CSS variable every page uses to reserve
  // room (padding-left). On a plain hover (not pinned), the nav stays a
  // `fixed` overlay above the content.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_MQ);
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Not gated on `mounted`: effects only run once hydrated, and waiting for
  // the extra render left the variable at its default for a frame at every
  // page change (the previous rail's cleanup has just reset it).
  useEffect(() => {
    try {
      document.documentElement.style.setProperty(
        '--timon-nav-w',
        isMobile ? NAV_W_MOBILE : pinned ? NAV_W_PINNED : NAV_W_DEFAULT,
      );
    } catch { /* ignore */ }
    return () => {
      try { document.documentElement.style.setProperty('--timon-nav-w', NAV_W_DEFAULT); } catch { /* ignore */ }
    };
  }, [pinned, isMobile]);

  // Navigating closes the drawer: without this it would stay open over
  // the page just requested. `onMobileClose` isn't a dependency — only a
  // route change should trigger the close, not a callback identity that
  // shifts on every parent render.
  const closeRef = useRef(onMobileClose);
  closeRef.current = onMobileClose;
  useEffect(() => { closeRef.current?.(); }, [pathname]);

  // Escape closes the drawer. Only while it's open: no global keyboard
  // listener lingering on every page on desktop.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  // The row also holds the hidden pages: a write keeps every field it does not change.
  function togglePin() { updateNav((prev) => ({ ...(prev && typeof prev === 'object' ? prev : {}), pinned: !pinned })); }
  const hidden = hiddenOf(navPrefs);
  const [editing, setEditing] = useState(false);
  const onToggleHidden = (href: string) => {
    const hide = !hidden.includes(href);
    updateNav((prev) => setHidden(prev, href, hide));
  };
  const stored = navLayoutOf(navPrefs);
  // The whole menu is stored, so a later change of the registered pages cannot reshuffle it.
  const onLayoutChange = (layout: { order: string[]; footer: string[] }) => updateNav((prev) => withNavLayout(prev, layout));
  const [dragging, setDragging] = useState(false);
  const items = { hidden, editing, onToggleHidden };
  const editButton = (labelled: boolean) => (
    <button
      type="button"
      onClick={() => setEditing((v) => !v)}
      aria-pressed={editing}
      aria-label={editing ? t('nav.customizeDone') : t('nav.customize')}
      title={editing ? t('nav.customizeDone') : t('nav.customize')}
      className={cn(
        'flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md p-2 text-[12.5px] transition-colors hover:bg-muted hover:text-foreground',
        editing ? 'text-primary' : 'text-muted-foreground',
      )}
    >
      {/* The painter's palette, like every customisation entry of the app (appearance menus). */}
      {editing ? <Check className="size-4 shrink-0" /> : <Palette className="size-4 shrink-0" />}
      {labelled && <span>{editing ? t('nav.customizeDone') : t('nav.customize')}</span>}
    </button>
  );

  // `pinned` comes from the server's seed on the first paint, so the server
  // markup and the hydrating render agree on it; the transient states
  // (hover, an open menu, a drag) only exist once mounted.
  const expanded = pinned || (mounted && (hovered || held || dragging));

  const isLight = mounted && resolvedTheme === 'light';

  return (
    <>
      {/* Desktop rail — unchanged: collapsed, expands on hover, pinnable. */}
      <nav
        ref={railRef}
        aria-label={t('nav.mainNav')}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          // over it and stays against the screen's left edge.
          'timon-nav-rail fixed left-0 top-[var(--timon-topbar-h)] bottom-0 z-[15] hidden flex-col overflow-hidden bg-chrome transition-[width] duration-150 md:flex',
          expanded ? 'w-56' : 'w-[var(--timon-nav-w)]',
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          <NavChromeProvider value={{ expanded, forceLabel: false, holdExpanded, ...items }}>
            <NavItems stored={stored} onLayoutChange={onLayoutChange} onDraggingChange={setDragging} />
          </NavChromeProvider>
          {/* Widget zone at the foot of the rail. Collapsed, the rail is
              56px wide and clips its widgets; they get their room back as
              soon as it is hovered or pinned. A compact zone: the bell and
              the quota rings show as icons here, like the nav items. */}
          <WidgetZone
            zone="sidebar.left.widget"
            slot="sidebar.left.widget"
            compact
            hideWhenEmpty
            revealWhenEditing={expanded}
            label={t('layout.leftWidgets')}
            className="mt-1.5 flex shrink-0 flex-col gap-2 pt-2"
            emptyClassName="border-dashed"
          />
        </div>

        <NavFooter expanded={expanded} forceLabel={false} holdExpanded={holdExpanded} hidden={hidden} editing={editing} stored={stored} />

        {/* One row at the foot of the rail, at a FIXED height, so the foot
            never moves when the rail expands: the settings gear, and the pin
            as an icon that joins it once there is width for it. */}
        <div className="flex h-[52px] shrink-0 items-center gap-1 px-2">
          <div className="min-w-0 flex-1">
            <NavChromeProvider value={{ expanded, forceLabel: false, holdExpanded }}>
              <SettingsNavLink />
            </NavChromeProvider>
          </div>
          {expanded && editButton(false)}
          {expanded && (
            <button
              type="button"
              onClick={togglePin}
              aria-label={pinned ? t('nav.collapseNav') : t('nav.pinNavExpanded')}
              title={pinned ? t('nav.collapseNav') : t('nav.pinNavExpanded')}
              aria-pressed={pinned}
              className={cn(
                'shrink-0 rounded-md p-2 transition-colors hover:bg-muted hover:text-foreground',
                pinned ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            </button>
          )}
        </div>
      </nav>

      <ChromeCorners expanded={expanded} />
      <GlassRail expanded={expanded} />

      {/* Mobile veil. `pointer-events-none` when closed so it never
          swallows a tap on the content, animated opacity so it doesn't
          appear as one block under the sliding drawer. */}
      <div
        aria-hidden
        onClick={() => closeRef.current?.()}
        className={cn(
          'timon-window-layer fixed inset-0 z-[29] bg-background/60 backdrop-blur-sm transition-opacity duration-200 md:hidden',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      {/* Mobile drawer — enters from the right, under the thumb. Always
          mounted (translated off-screen): an unmounted drawer can't animate. */}
      <nav
        aria-label={t('nav.mainNav')}
        aria-hidden={!mobileOpen}
        className={cn(
          'timon-below-window-band timon-window-layer fixed right-0 top-0 bottom-0 z-30 flex w-64 max-w-[85vw] flex-col bg-popover shadow-elev-3 transition-transform duration-200 ease-out md:hidden',
          mobileOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex shrink-0 items-center justify-between px-3 py-2">
          <div className="flex items-center gap-1.5">
            <BrandLogo className="h-5" alt={instance.displayName} />
            <InstanceBadge />
          </div>
          <button
            type="button"
            onClick={() => closeRef.current?.()}
            aria-label={t('nav.closeMenu')}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          <NavChromeProvider value={{ expanded, forceLabel: true, ...items }}>
            <NavItems stored={stored} onLayoutChange={onLayoutChange} onDraggingChange={setDragging} />
          </NavChromeProvider>
          <div className="mt-1">{editButton(true)}</div>
          {/* The mobile drawer renders no sidebar widget, plugin or native:
              they carry the same sort ids as the desktop rail, and the same id
              twice in one `DndContext` breaks drag and drop. A widget placed
              there therefore stays invisible on mobile. That already held for
              native ones; since the host also places slot entries, a
              `SlotRegion` here would paint them a second time. */}
        </div>

        <NavFooter expanded={expanded} forceLabel hidden={hidden} editing={editing} stored={stored} />

        {/* The browser toggle and theme toggle live here on mobile: the
            header doesn't have the width to carry them plus the hamburger. */}
        {pathname === '/chat' && <button
          type="button"
          onClick={() => {
            closeRef.current?.();
            toggleBrowserPanel();
          }}
          className="mx-2 mt-1 flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md px-3 py-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Globe className="size-4 shrink-0" />
          <span>{t('nav.browser')}</span>
        </button>}
        {/* Always labelled in the drawer: no hover on a touch screen. No pin
            either — the drawer has nothing to pin. */}
        <button
          type="button"
          onClick={() => {
            const scheme = isLight ? 'dark' : 'light';
            setTheme(scheme);
            void fetch('/api/ui/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scheme }) });
          }}
          className="mx-2 mt-1 flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md px-3 py-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {isLight ? <Moon className="size-4 shrink-0" /> : <Sun className="size-4 shrink-0" />}
          <span>{isLight ? t('nav.darkTheme') : t('nav.lightTheme')}</span>
        </button>
        <div className="shrink-0 p-2">
          <NavChromeProvider value={{ expanded, forceLabel: true }}>
            <SettingsNavLink onOpen={() => closeRef.current?.()} />
          </NavChromeProvider>
        </div>
      </nav>
    </>
  );
}
