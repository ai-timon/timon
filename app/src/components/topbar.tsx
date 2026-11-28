'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BrandLogo } from '@/components/brand-logo';
import { SetupRestartBanner } from '@/components/setup-restart-banner';
import { LicenseLockReload } from '@/components/license-lock-reload';
import { ThemeToggle } from '@/components/theme-toggle';
import { BrowserToggle } from '@/components/browser-toggle';
import { VerticalNav } from '@/components/vertical-nav';
import { InstanceBadge, useInstance } from '@/components/instance-provider';
import { Slot } from '@/lib/plugin-host/render';
import { WidgetZone } from '@/components/widget-host/widget-zone';
import { useWidgetEditing } from '@/components/widget-host/widget-host';
import { TOPBAR_CENTER_ZONE } from '@/components/widget-host/widget-catalog';
import { useMobile } from '@/hooks/use-mobile';
import { t } from '@/lib/i18n';
import { WindowMachineName } from '@/components/window-frame';
import { nextHeaderScrollState, topbarSlideFrames, TOPBAR_SLIDE } from '@/lib/header-scroll';

export function TopBar({
  extra,
  collapsed,
  banners = true,
}: {
  extra?: React.ReactNode;
  /** `false` for the setup wizard's inert backdrop: a restart or licence
   *  warning there would talk about a product the person is still setting up. */
  banners?: boolean;
  /** When true on mobile, the TopBar shrinks to height 0 and fades out
   *  so a sub-page (e.g. the chat view) can keep just its own context
   *  bar visible while the user scrolls. Desktop ignores this flag —
   *  there's enough vertical real estate to keep the global nav always
   *  in view.
   *
   *  Left undefined, the header collapses on its own on scroll (mobile).
   *  A page that supplies the prop takes over entirely: chat, for
   *  instance, has its own hysteresis with an anti-flicker lock on its
   *  message thread — two pilots on the same control would fight each other. */
  collapsed?: boolean;
}) {
  const instance = useInstance();
  const headerRef = useRef<HTMLElement | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const hiddenByScroll = useHideOnScroll(collapsed === undefined);
  const folded = collapsed ?? hiddenByScroll;
  const mobile = useMobile();
  const editing = useWidgetEditing();
  // The middle of the bar is a widget zone, where the Working agents widget
  // starts (TODO #479). From `md` it sits between the logo and the controls;
  // on a phone it is a row of its own under the bar (see below). Mounted in
  // ONE of the two places, picked after hydration: a zone is a drop target
  // with an id, two of them would fight over it. No flash comes of it — the
  // widgets only paint once the stored layout has answered, later still.
  //
  // The cards in it may shrink (`min-w-0`), unlike on the right-hand line: the
  // strip scrolls sideways inside its card instead of pushing the controls off.
  const centerZone = (
    <WidgetZone
      zone={TOPBAR_CENTER_ZONE}
      slot="topbar.widget"
      orientation="horizontal"
      hideWhenEmpty
      label={t('layout.topbarCenterWidgets')}
      className="flex h-full min-w-0 flex-1 items-center justify-center [&>.widget-frame>.widget-content]:min-w-0 [&>.widget-frame]:min-w-0 [&>.widget-frame]:shrink"
    />
  );

  // The active-agents row on phones (empty:hidden) and the folding bar make
  // the header's height variable — the row disappears outright when no agent
  // is running.
  // Pages that overlay their content on the header (canvas,
  // fixed/absolute sidebars) can no longer rely on a fixed pixel value: we
  // publish the measured height as a global CSS variable, which those
  // pages consume via var(--timon-topbar-h).
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publish = () => {
      // Rounded UP, never to the nearest: `offsetHeight` rounds, and a header
      // 68.4px tall then left a 0.4px slit under it where whatever sits behind
      // — a wallpaper — showed between the bar and the rail. With no border to
      // hide it any more, the rail has to start at or above the bar's real edge.
      document.documentElement.style.setProperty('--timon-topbar-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [folded]);

  // The fold, on a phone, is a slide made of transforms only: the layout
  // changes once, at the first frame, and the menu bar, the agents row and the
  // content under the header are then moved back to where they were painted
  // and slid to their new place together, on the compositor. Animating the
  // row's height instead relaid the whole page out (thread, islands) at every
  // frame — a few frames a second on a phone, with the agents row lagging
  // behind a bar that slid on its own.
  const barRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const slides = useRef<Animation[]>([]);
  const firstFold = useRef(true);
  useLayoutEffect(() => {
    if (firstFold.current) {
      firstFold.current = false;
      return;
    }
    const header = headerRef.current;
    const bar = barRef.current;
    if (!header || !bar || typeof bar.animate !== 'function') return;
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const shift = bar.offsetHeight;
    if (!shift) return;
    for (const a of slides.current) a.cancel();
    const frames = topbarSlideFrames(folded, shift);
    const followers = [rowRef.current, ...contentAfter(header)].filter((el): el is HTMLElement => el !== null);
    slides.current = [
      bar.animate(frames.bar, TOPBAR_SLIDE),
      ...followers.map((el) => el.animate(frames.follower, TOPBAR_SLIDE)),
    ];
  }, [folded]);

  return (
    <>
    <header
      ref={headerRef}
      className="sticky top-0 z-20 w-full"
    >
      {/* Drawn over the menu bar once it has slid up behind them. */}
      <div className="relative z-[1]">
        {/* iOS home-screen app: the page paints under the status bar
            (`black-translucent` + `viewport-fit=cover`), so the header starts
            with the notch's height in the bar colour. Zero everywhere else.
            Outside the folding bar on purpose: when it hides, the agents row
            must still clear the status bar. */}
        <div aria-hidden className="timon-topbar-safe h-[env(safe-area-inset-top,0px)] bg-chrome" />
        {/* Above everything, the logotype included: a global warning belongs at
            the very top of the page, not wedged under the nav bar where it
            used to push the content and overlap the rail. They live inside the
            measured header on purpose — `--timon-topbar-h` is what every fixed
            surface offsets itself by (the rail, the chat rails, the agent
            rails), so their height has to be part of it or they cover things.
            They also stay out of the mobile collapse below: a warning that
            scrolls away is a warning nobody reads. */}
        {banners && <SetupRestartBanner />}
        {/* The licence speaks through bottom-left notice cards; only the
            reload into a beta build's lock screen is left here. */}
        {banners && <LicenseLockReload />}
      </div>
      {/* Folds on phones only: the row drops to zero height at once and the
          bar, out of the flow's way, slides up over it (see the slide above).
          Not clipped, or the bar would vanish at the first frame; what sits
          above it (status bar, banners) is drawn over it instead. Desktop
          reverts every collapse override. */}
      <div
        data-topbar-fold={folded ? 'folded' : 'open'}
        className={cn(folded && 'h-0 md:h-auto')}
      >
      <div
        ref={barRef}
        className={cn(
          'timon-topbar-bar relative bg-chrome',
          folded && 'pointer-events-none -translate-y-full md:pointer-events-auto md:translate-y-0',
        )}
      >
        {/* Full-width header: carries the TIMON logo (never covered by the
            nav's collapse-expand, which starts below it — see
            VerticalNav) + the middle widget zone + page controls
            (`extra`). The wrapper keeps min-w-0 flex-1 even when the zone
            renders nothing: without it, `extra`/ThemeToggle would end up
            glued to the left for lack of an element pushing right. */}
        {/* The logotype sets the band height; the padding only breathes
            around it. The right-hand controls (h-9) are shorter and just
            centre themselves in the row. In a desktop window without the
            system's title bar, the row also keeps room at its ends for the
            window's buttons or the macOS traffic lights (both 0 elsewhere,
            see `components/window-frame.tsx`). */}
        <div className="flex items-center gap-3 py-1.5 pl-[calc(0.75rem+var(--timon-window-lights-w,0px))] pr-[calc(0.75rem+var(--timon-window-controls-w,0px))] sm:pl-[calc(1rem+var(--timon-window-lights-w,0px))] sm:pr-[calc(1rem+var(--timon-window-controls-w,0px))]">
          <Link
            prefetch={false}
            href="/"
            aria-label={`${instance.displayName} — cockpit`}
            className="relative z-10 flex shrink-0 items-center no-underline"
          >
            {/* Discreet on purpose: the mark is ~1.6× as wide as it is
                tall, a small height already reads at a glance. */}
            <BrandLogo className="h-5 md:h-6" />
            {/* Only the development instance paints anything here. */}
            <InstanceBadge className="ml-1.5" />
          </Link>
          {/* The machine the window drives, as the system's title bar named
              it: only in a desktop window that has none. */}
          <WindowMachineName className="hidden md:block" />
          {/* From `md` the middle zone sits in the bar, between the logo and
              the controls. On a phone it has its own row below (see after
              this bar): only a spacer here, pushing the controls to the right. */}
          <div className="hidden min-w-0 flex-1 self-stretch md:flex">
            {!mobile && centerZone}
          </div>
          <div className="flex-1 md:hidden" />
          {extra}
          {/* The bar's widget zone: the bell by default, and any widget with a
              flat form the user drops here in Edit Layout. One line, at the
              height of the controls next to it, so the band never grows and
              the phone fold keeps its fixed height. `topbar.item` stays
              beside it, unchanged, for plugins that register a plain control. */}
          <WidgetZone
            zone="topbar.widget"
            slot="topbar.widget"
            orientation="horizontal"
            hideWhenEmpty
            label={t('layout.topbarWidgets')}
            className="relative z-10 flex h-9 shrink-0 items-center gap-1"
          />
          <Slot name="topbar.item" />
          {/* Mobile: the hamburger takes the place of the theme toggle,
              which moves into the drawer (see VerticalNav). */}
          <div className="hidden items-center md:flex">
            <BrowserToggle />
            <ThemeToggle />
          </div>
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label={t('nav.openMenu')}
            aria-expanded={navOpen}
            className="relative z-10 shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
          >
            <Menu className="size-4" />
          </button>
        </div>
      </div>
      </div>
      {/* Phones: the middle zone — the agent tabs — is a bar of its own,
          under the menu bar. It lives in the same sticky header but outside
          the part that folds, so it stays on screen when the menu bar hides
          on scroll. No agent tab, no row (outside Edit Layout, where the
          zone must stay reachable). */}
      <div
        ref={rowRef}
        className={cn(
          'timon-topbar-agents flex bg-chrome px-2 pb-1.5 pt-0.5 empty:hidden md:hidden',
          !editing && '[&:not(:has([data-agent-tab],[data-project-tab]))]:hidden',
        )}
      >
        {mobile && centerZone}
      </div>
    </header>
    <VerticalNav mobileOpen={navOpen} onMobileClose={() => setNavOpen(false)} />
    </>
  );
}

/**
 * Hides the header when scrolling down, reveals it as soon as scrolling up
 * (or stopping at the top). Mobile only: on desktop the global nav stays
 * always visible, there's the height for it.
 *
 * The scroll doesn't necessarily come from `window` — most TIMON pages
 * scroll inside an internal container (chat, grids). `scroll` events don't
 * bubble, hence listening in the CAPTURE phase on the document, which sees
 * all of them regardless of the element.
 *
 * The decision itself (thresholds, lock against the flicker of TIM-0060) lives
 * in `lib/header-scroll.ts`.
 */
function useHideOnScroll(enabled: boolean): boolean {
  const [hidden, setHidden] = useState(false);
  // Position remembered PER container: several zones scroll
  // independently (conversation thread, missions rail…). A single
  // counter would read a jump between them as one giant scroll.
  const perEl = useRef<WeakMap<object, { lastY: number; upTravel: number }>>(new WeakMap());
  const shared = useRef({ hidden: false, lockUntil: 0 });

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    let mobile = mq.matches;
    const syncMq = () => {
      mobile = mq.matches;
      if (!mobile) {
        shared.current.hidden = false;
        setHidden(false);
      }
    };
    mq.addEventListener('change', syncMq);

    const onScroll = (e: Event) => {
      if (!mobile) return;
      const t = e.target;
      // A drawer, a dialog or a menu scrolls on its own: that says nothing about the page.
      if (t instanceof Element && t.closest('[data-header-scroll="ignore"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      const el = t instanceof HTMLElement ? t : document.documentElement;
      const y =
        t instanceof HTMLElement
          ? t.scrollTop
          : window.scrollY || document.documentElement.scrollTop;
      const mine = perEl.current.get(el) ?? { lastY: 0, upTravel: 0 };
      const next = nextHeaderScrollState(
        { ...shared.current, ...mine },
        { y, range: el.scrollHeight - el.clientHeight, now: performance.now() },
      );
      perEl.current.set(el, { lastY: next.lastY, upTravel: next.upTravel });
      shared.current = { hidden: next.hidden, lockUntil: next.lockUntil };
      setHidden(next.hidden);
    };

    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      mq.removeEventListener('change', syncMq);
    };
  }, [enabled]);

  return hidden;
}

/**
 * What follows the header in its own column — the page, which has to slide
 * with the agents row or a band would open between them. Fixed or absolute
 * siblings (the nav drawer) are not in the flow, so not moved.
 */
function contentAfter(header: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let el = header.nextElementSibling; el; el = el.nextElementSibling) {
    if (!(el instanceof HTMLElement)) continue;
    const position = getComputedStyle(el).position;
    if (position === 'fixed' || position === 'absolute' || el.offsetHeight === 0) continue;
    out.push(el);
  }
  return out;
}
