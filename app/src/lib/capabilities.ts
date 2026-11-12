/**
 * UI zones — what the front end is allowed to show.
 *
 * A zone is visible when (a) the module that carries it runs, and (b) it is
 * not listed in `ui.hidden` of `timon.config.json`. Two conditions, two
 * distinct intents: the first is technical (no Docker → no Docker panel), the
 * second editorial (the user wants a calmer UI).
 *
 * Fallback policy: **when in doubt, show**. As long as the capabilities are
 * not loaded — or when the orchestrator is unreachable — everything stays
 * visible. Hiding by default would give an empty UI on the first render and a
 * page that "loses" its tabs when the network hiccups; a button that returns
 * an error is less serious than a button nowhere to be found.
 */
'use client';

import { useEffect, useState } from 'react';

export type ModuleState = {
  id: string;
  tier: 'core' | 'std' | 'dev' | 'opt';
  active: boolean;
  reason: string | null;
  missing: string[];
  /** Options `timon.config.json` sets on this module (`enabled` removed).
   *  Absent from an old answer: each reader sets its own default. */
  options?: Record<string, unknown>;
};

export type Surfaces =
  | { all: true }
  | {
      all?: false;
      pages: string[];
      widgets: string[];
      nav: string[];
      plugins: string[];
      themes: string[];
      layouts: string[];
    };

export type Capabilities = {
  edition: string;
  profile: string;
  capabilities: string[];
  modules: ModuleState[];
  ui: { hidden: string[]; home: string };
  kernel: boolean;
  developer: { unsignedPlugins: boolean };
  /** No `timon.config.json` on the daemon's machine: onboarding is not done
   *  (step 5.9.2). The client host routes every page to `/setup` while true. */
  firstRun?: boolean;
  teamOnboarding?: boolean;
  /** Step 3 (naming the main agent) is still unanswered. */
  mainAgentOnboarding?: boolean;
  /** Step 5: the daemon is still the process that wrote `timon.config.json`,
   *  so it has not read it. The wizard holds on `/setup/restart` until a new
   *  process answers. */
  restartOnboarding?: boolean;
  beta?: boolean;
  /** The licence on the daemon lets a layout plugin replace the whole
   *  interface. Absent (an older daemon) reads as `false`. */
  whitelabel?: boolean;
  /**
   * Surfaces this viewer may see (M.4). Absent or `{ all: true }` is the
   * historical unrestricted payload (first-run, superadmin, old daemon).
   */
  surfaces?: Surfaces;
};

/** UI zone → module that must run for it to make sense. A zone absent from
 *  this table depends on no module (only `ui.hidden` can hide it). Frozen
 *  ids: the front end, the config and the plan §3.6 share them. */
const ZONE_MODULE: Record<string, string> = {
  'agents.notifications': '@timon/notifications',
  'settings.push': '@timon/web-push',
  'nav.kanban': '@timon/kanban',
  'nav.git': '@timon/git',
  'nav.routines': '@timon/routines',
  'nav.triggers': '@timon/triggers',
  'nav.dreams': '@timon/dreams',
  'nav.memory': '@timon/memory',
  'nav.brain': '@timon/vault',
  'cockpit.dreams': '@timon/dreams',
  'cockpit.vault-graph': '@timon/vault',
  'chat.panel.docker': '@timon/docker-supervision',
  'chat.panel.git-remote': '@timon/git',
  'chat.panel.files': '@timon/files-widget',
  'chat.panel.skills': '@timon/skills-widget',
  'chat.panel.mcp': '@timon/mcp-widget',
  'chat.panel.orchestrator-self': '@timon/orchestrator-self',
  'chat.panel.video-factory': '@timon/video-factory',
  'chat.panel.browser': '@timon/browser-embedded',
  'chat.terminal': '@timon/terminal-native',
  'nav.terminal': '@timon/terminal-web',
};

/**
 * Product pages that still live as Next routes, keyed by path. A disableable
 * module owns the page: switching it off must not keep a shell that fetches
 * a daemon route that is no longer there ("could not load dreams").
 *
 * Every other extractable page has moved to a `page`-slot plugin (Phase U):
 * `/dreams`, `/kanban`, `/git`, `/triggers` (and its `/routines` redirect), `/memory`,
 * `/secrets`, `/brain`. Each disappears on its own when its module is off —
 * the catch-all shows "unknown route" for it exactly like a third-party
 * plugin — so this table would be a second, redundant way to hide it.
 *
 * `/notifications` stays here on purpose: it renders its own `TopBar` and
 * must work even with `ui-layout` off (reachable in one tap, including on
 * phone, see its own `page.tsx`). The `page` slot only exists as a child of
 * the `root` that `ui-layout` declares, so it cannot host this one. Core
 * pages (`/settings`, `/agents`, `/missions`…) stay out too — they cannot be
 * switched off.
 */
export const PAGE_MODULE: Record<string, string> = {
  '/notifications': '@timon/notifications',
};

let cache: Capabilities | null = null;
let inFlight: Promise<Capabilities | null> | null = null;
const listeners = new Set<(c: Capabilities | null) => void>();

/**
 * Lifetime of the module cache.
 *
 * It is NO LONGER the delay after which a module's switch is learned: since
 * bundled modules toggle live, the daemon announces each recomposition with
 * `plugins_changed`, and `watchClientPlugins` forces an immediate reread.
 * Without it, switching a module off left its tile on screen for one more
 * minute. The TTL is only a safety net for a tab that missed the event (SSE
 * cut, wake from sleep).
 */
const TTL_MS = 60_000;
let fetchedAt = 0;

export function resetCapabilitiesCacheForTests(): void {
  cache = null;
  inFlight = null;
  fetchedAt = 0;
}

export async function fetchCapabilities(force = false): Promise<Capabilities | null> {
  if (!force && cache && Date.now() - fetchedAt < TTL_MS) return cache;
  // A `force` does not settle for the request in flight: it may have left
  // BEFORE the recomposition just learned, and would return the earlier state.
  if (inFlight && !force) return inFlight;
  inFlight = fetch('/api/ui/capabilities', { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<Capabilities>) : null))
    .catch(() => null)
    .then((c) => {
      // Same content = same object. The capabilities are reread when any
      // component mounts after 60 s, and their identity is an effect
      // dependency: returning a fresh object for unchanged content would
      // unmount then remount the modules' surfaces (the cockpit tiles, their
      // open dialogs, the 3D canvas) although nothing changed.
      if (c && cache && JSON.stringify(c) === JSON.stringify(cache)) c = cache;
      if (c) { cache = c; fetchedAt = Date.now(); }
      inFlight = null;
      for (const l of listeners) l(cache);
      return cache;
    });
  return inFlight;
}

export function useCapabilities(): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(cache);
  useEffect(() => {
    listeners.add(setCaps);
    void fetchCapabilities();
    return () => { listeners.delete(setCaps); };
  }, []);
  return caps;
}

export function isModuleOn(caps: Capabilities | null, name: string): boolean {
  if (!caps) return true; // not loaded yet: show
  const m = caps.modules.find((x) => x.id === name);
  return m ? m.active : true;
}

/**
 * Options of a module, as the config sets them.
 *
 * Deliberately untyped here: the kernel forwards them without knowing them,
 * and the module's client half validates them and sets its default.
 * Capabilities not loaded, module absent or an answer older than the field →
 * empty object, so "the module's default".
 */
export function moduleOptions(caps: Capabilities | null, name: string): Record<string, unknown> {
  return caps?.modules.find((x) => x.id === name)?.options ?? {};
}

export function isZoneVisible(caps: Capabilities | null, zone: string): boolean {
  if (!caps) return true;
  if (caps.ui.hidden.includes(zone)) return false;
  const required = ZONE_MODULE[zone];
  return required ? isModuleOn(caps, required) : true;
}

/** True when this path has no owning module, or that module is running. */
export function isProductPageOn(caps: Capabilities | null, pathname: string): boolean {
  if (!isPageSurfaceAllowed(caps, pathname)) return false;
  const required = PAGE_MODULE[pathname];
  return required ? isModuleOn(caps, required) : true;
}

function surfacesUnrestricted(caps: Capabilities | null): boolean {
  if (!caps) return true;
  if (!caps.surfaces) return true;
  return caps.surfaces.all === true;
}

export function shortPluginId(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function navSlug(href: string): string {
  if (href === '/') return 'home';
  const trimmed = href.replace(/^\//, '');
  const first = trimmed.split('/')[0];
  return first && first.length > 0 ? first : 'home';
}

/**
 * Routes no permission can take away: they are the account's own business.
 *
 * `/profile` is to the surfaces what self-service password rotation is to the
 * roles — an account that cannot edit its own identity has to ask a superadmin,
 * which is exactly the dependency the whole self-service story removes. It is
 * deliberately absent from the permission catalogue, so it never appears as a
 * checkbox somebody could untick.
 */
const SELF_SERVICE_PAGES: readonly string[] = ['/profile'];

export function isPageSurfaceAllowed(caps: Capabilities | null, pathname: string): boolean {
  if (SELF_SERVICE_PAGES.includes(pathname)) return true;
  if (surfacesUnrestricted(caps)) return true;
  const pages = caps!.surfaces && 'pages' in caps!.surfaces ? caps!.surfaces.pages : [];
  return pages.includes(pathname);
}

export function isNavSurfaceAllowed(
  caps: Capabilities | null,
  href: string,
  pluginId?: string,
): boolean {
  if (surfacesUnrestricted(caps)) return true;
  // `widget:<module>` also lists the module in `surfaces.plugins`: it opens the
  // card, not the page, and the entry would lead to the forbidden screen (TODO #645).
  const widgets = caps!.surfaces && 'widgets' in caps!.surfaces ? caps!.surfaces.widgets : [];
  if (pluginId && isPluginSurfaceAllowed(caps, pluginId) && !widgets.includes(shortPluginId(pluginId))) return true;
  if (isPageSurfaceAllowed(caps, href)) return true;
  const nav = caps!.surfaces && 'nav' in caps!.surfaces ? caps!.surfaces.nav : [];
  return nav.includes(navSlug(href));
}

export function isWidgetSurfaceAllowed(
  caps: Capabilities | null,
  pluginId: string,
  key: string,
): boolean {
  if (surfacesUnrestricted(caps)) return true;
  if (isPluginSurfaceAllowed(caps, pluginId)) return true;
  const widgets = caps!.surfaces && 'widgets' in caps!.surfaces ? caps!.surfaces.widgets : [];
  return widgets.includes(key) || widgets.includes(shortPluginId(pluginId));
}

export function isPluginSurfaceAllowed(caps: Capabilities | null, pluginId: string): boolean {
  if (surfacesUnrestricted(caps)) return true;
  const plugins = caps!.surfaces && 'plugins' in caps!.surfaces ? caps!.surfaces.plugins : [];
  return plugins.includes(pluginId);
}

export function isThemeSurfaceAllowed(caps: Capabilities | null, pluginId: string): boolean {
  if (surfacesUnrestricted(caps)) return true;
  if (isPluginSurfaceAllowed(caps, pluginId)) return true;
  const themes = caps!.surfaces && 'themes' in caps!.surfaces ? caps!.surfaces.themes : [];
  return themes.includes(shortPluginId(pluginId));
}

export function isLayoutSurfaceAllowed(caps: Capabilities | null, pluginId: string): boolean {
  if (surfacesUnrestricted(caps)) return true;
  if (isPluginSurfaceAllowed(caps, pluginId)) return true;
  const layouts = caps!.surfaces && 'layouts' in caps!.surfaces ? caps!.surfaces.layouts : [];
  return layouts.includes(shortPluginId(pluginId));
}
