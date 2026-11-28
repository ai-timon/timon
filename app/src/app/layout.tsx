import type { Metadata } from 'next';
import { instanceIdentity } from '@/lib/instance';
import { InstanceProvider } from '@/components/instance-provider';
import { Suspense } from 'react';
import { BackgroundProvider } from '@/components/background/background-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { RolesProvider } from '@/components/roles-provider';
import { AuthRedirect } from '@/components/auth-redirect';
import { RegisterSW } from '@/components/register-sw';
import { EgressRefusedNotice } from '@/components/dictation/egress-refused-notice';
import { RadixPointerEventsReset } from '@/components/radix-pointer-events-reset';
import { WorkspaceLayoutProvider } from '@/components/workspace-layout-provider';
import { NavigateListener } from '@/components/navigate-listener';
import { GuidedTourOffer } from '@/components/guided-tour-offer';
import { WidgetHost } from '@/components/widget-host/widget-host';
import { ChatAppearanceProvider } from '@/components/chat/chat-appearance-menu';
import { NativeBrowserPanel as BrowserOpener } from '@/components/native-browser-opener';
import { TerminalOpener } from '@/components/terminal/terminal-opener';
import { PLATFORM_MODULES } from '@/lib/plugin-host/modules';
import { PlatformGlobals } from '@/lib/plugin-host/platform-globals';
import { ClientPluginHost } from '@/lib/plugin-host/client-plugin-host';
import { SettingsDialogHost } from '@/components/settings/settings-dialog-host';
import { ForgeProposalDialogHost } from '@/plugins-client/kanban/forge-proposal-host';
import { FirstRunGate } from '@/components/first-run-gate';
import { FIRST_RUN_ALLOWED, FIRST_RUN_SCHEME_KEY } from '@/lib/first-run-gate';
import { BetaLockScreen } from '@/components/beta-lock-screen';
import { betaLock, type BetaLock } from '@/lib/license';
import { SlotSingle } from '@/lib/plugin-host/render';
import { ThemeFloor } from '@/lib/plugin-host/theme-floor';
import { ThemeColorSync } from '@/components/theme-color-sync';
import { Toaster } from '@/components/ui/sonner';
import { AgentEditorModal } from '@/components/agent-editor/agent-editor-modal';
import { UnsavedDocumentDialog } from '@/components/chat/unsaved-document-dialog';
import { ConfirmDialogHost } from '@/components/confirm-dialog/confirm-dialog';
import { NoticesHost } from '@/components/notices/notices-host';
import { UpdatePreviewHost } from '@/components/updates/update-preview-host';
import { APPEARANCE_SCOPE, DEFAULT_APPEARANCE, effectiveGlass, readNativeAppearance } from '@/plugins-client/ui-theme-variants';
import { BACKGROUND_SCOPE } from '@/components/background/background-model';
import { DEFAULT_USER_PREFS, type ColorScheme } from '@/lib/auth';
import { readPublicTheme } from '@/lib/public-theme';
import { fetchForRender, resolveLayoutSeeds, resolveWorkspace } from '@/lib/ui/server-workspace';
import { LayoutSeedsProvider } from '@/components/layout-seeds';
import { navPinnedOf, sharedNavScope } from '@/lib/workspace-scope';
import { rowHandover } from '@/lib/layout-handover';
import { localTarget, resolveTarget } from '@/lib/machines/target';
import { activeScheme, describeActiveMachine, workspaceOwner } from '@/lib/machines/active-machine';
import { previousLayoutOwner } from '@/lib/machines/acting-account';
import { MachineBlockedScreen } from '@/components/machines/machine-blocked-screen';
import { WindowFrame } from '@/components/window-frame';
import { LastRouteRecorder } from '@/components/machines/last-route-recorder';
import { LocaleProvider } from '@/components/locale-provider';
import { applyRequestLocale } from '@/lib/locale-server';
import { localeDirection } from '@/lib/i18n';
import { headers } from 'next/headers';
import { CSP_HEADER, scriptNonceOf } from '@/lib/content-security-policy';
import '@/styles/globals.css';

export const dynamic = 'force-dynamic';

/**
 * Resolved per request, not at module scope: `app/.next` is built once and
 * SHIPPED INSIDE the Electron package, so a title frozen at build time would
 * carry the building machine's instance into the release. The layout is
 * `force-dynamic`, so this runs in the server that actually serves the page
 * and reads that server's environment. Same reason for the manifest.
 */
export async function generateMetadata(): Promise<Metadata> {
  const instance = instanceIdentity();
  return {
    title: instance.fullName,
    description: 'Local-first agentic OS',
    // iOS ignores most manifest fields, so it needs its own meta tags.
    // capable=true strips Safari's chrome when launched from the home
    // screen; black-translucent lets the page paint under the status bar.
    appleWebApp: {
      capable: true,
      title: instance.displayName,
      statusBarStyle: 'black-translucent',
    },
    // Safari falls back to the largest icon if no apple-touch-icon is set
    // (and renders it on black), and it does not resize gracefully — hence a
    // dedicated 180×180 cut from the same source as the other sizes.
    icons: {
      icon: [
        // Sharp at any size in a tab; the PNGs stay for the browsers that ignore SVG icons.
        { url: instance.icons.vector, type: 'image/svg+xml' },
        { url: instance.icons.small, sizes: '192x192', type: 'image/png' },
        { url: instance.icons.large, sizes: '512x512', type: 'image/png' },
      ],
      apple: [{ url: instance.icons.apple, sizes: '180x180', type: 'image/png' }],
    },
  };
}

// Required for mobile layouts to scale to the device width instead of
// rendering at the desktop viewport and zooming out (Safari/iOS quirk).
// viewport-fit=cover lets the safe areas extend behind the notch.
// theme-color is painted at runtime by ThemeColorSync from `--primary` so a
// third-party theme rethemes Chrome's URL bar; do not bake a hex here.
export const viewport: import('next').Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // The on-screen keyboard resizes the layout instead of scrolling the page
  // under a fixed-height shell, which made the composer fight the browser.
  interactiveWidget: 'resizes-content',
};

/**
 * Scheme AND owner in one read.
 *
 * They came from the same endpoint but were fetched twice — once here for the
 * palette, once by the browser to learn whose workspace this is. The second
 * read gated everything stored behind it; folding it into this one is what
 * lets the scope be resolved before the page is sent.
 */
async function loadInitialMe(): Promise<{ scheme: ColorScheme; owner: string | null; theme: string }> {
  try {
    // The local session's own identity: `/api/auth/*` is never relayed to
    // another machine, whatever the active one.
    const res = await fetchForRender('/api/auth/me', localTarget());
    if (!res.ok) return { scheme: DEFAULT_USER_PREFS.scheme, owner: null, theme: DEFAULT_USER_PREFS.theme };
    const body = (await res.json()) as { prefs?: { scheme?: unknown; theme?: unknown }; user?: { id?: unknown } | null };
    const owner = typeof body.user?.id === 'string' ? body.user.id : null;
    // The theme the page is painted with before the plugins mount (`ThemeFloor`).
    const theme = typeof body.prefs?.theme === 'string' && body.prefs.theme ? body.prefs.theme : DEFAULT_USER_PREFS.theme;
    return {
      scheme: body.prefs?.scheme === 'light' ? 'light' : 'dark',
      owner,
      // No session, no plugin will ever paint the page: it wears the
      // installation's theme, from the floor alone (`ThemeRoot`).
      theme: owner ? theme : await readPublicTheme((path) => fetchForRender(path, localTarget()), theme),
    };
  } catch {
    return { scheme: DEFAULT_USER_PREFS.scheme, owner: null, theme: DEFAULT_USER_PREFS.theme };
  }
}

/**
 * Whether this build is a locked beta (ended, expired, or no licence). The
 * daemon then answers 403 on everything but licence, auth and the export, so
 * the whole cockpit — capabilities, event stream, widgets — would fire refusals
 * at a screen nobody can use. Decided here, before anything is mounted, rather
 * than silenced call by call afterwards. An anonymous visitor gets a 401, which
 * is no lock: `/login` renders as usual.
 */
async function loadBetaLock(): Promise<BetaLock | null> {
  try {
    const res = await fetchForRender('/api/license');
    return res.ok ? betaLock(await res.json()) : null;
  } catch {
    return null;
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const instance = instanceIdentity();
  // The response's script nonce, put on the request by the server
  // (`ui/window-csp.ts`): without it, the inline scripts below never run.
  const nonce = scriptNonceOf((await headers()).get(CSP_HEADER));
  // The language first: the Server Components below read it from this module
  // graph, and `LocaleProvider` carries it to the client one and the browser.
  const locale = await applyRequestLocale();
  const [me, initialAppearance, lock, target] = await Promise.all([
    loadInitialMe(),
    fetchForRender(`/api/layout?scope=${APPEARANCE_SCOPE}`).then(async (res) => res.ok ? readNativeAppearance((await res.json()).layout) : DEFAULT_APPEARANCE).catch(() => DEFAULT_APPEARANCE),
    loadBetaLock(),
    resolveTarget(),
  ]);
  // A remote machine that cannot be used from here (unreachable, this
  // computer revoked there, a contract too old) gets a screen with the way
  // back instead of a cockpit that would only collect refusals. Local: no call.
  const machine = await describeActiveMachine(target, fetchForRender);
  // The mode of the machine this page is rendered for, not the local
  // account's: two windows on two machines keep two modes.
  const scheme = activeScheme(me.scheme, machine);
  if (machine.kind === 'blocked') {
    return (
      <html lang={locale} dir={localeDirection(locale)} suppressHydrationWarning data-timon-machine={target.id}>
        <body>
          <Suspense fallback={null}>
          <LocaleProvider locale={locale}>
          <InstanceProvider value={instance}>
            <WindowFrame />
            <ThemeProvider initialScheme={scheme} initialAppearance={initialAppearance} initialTheme={me.theme} nonce={nonce}>
              <ThemeFloor appearance={initialAppearance} theme={me.theme} />
              <MachineBlockedScreen name={machine.name} reason={machine.reason} apiLevel={machine.apiLevel} />
            </ThemeProvider>
          </InstanceProvider>
          </LocaleProvider>
          </Suspense>
        </body>
      </html>
    );
  }
  if (lock) {
    return (
      <html lang={locale} dir={localeDirection(locale)} suppressHydrationWarning data-timon-machine={target.id}>
        <body>
          <Suspense fallback={null}>
          <LocaleProvider locale={locale}>
          <InstanceProvider value={instance}>
            <WindowFrame />
            <ThemeProvider initialScheme={scheme} initialAppearance={initialAppearance} initialTheme={me.theme} nonce={nonce}>
              <ThemeFloor appearance={initialAppearance} theme={me.theme} />
              {/* The licence follows the active machine: a remote one's lock
                  offers the way back to this computer. */}
              <BetaLockScreen lock={lock} machine={machine.kind === 'remote' ? { name: machine.name } : undefined} />
            </ThemeProvider>
          </InstanceProvider>
          </LocaleProvider>
          </Suspense>
        </body>
      </html>
    );
  }
  // Second wave: it needs the owner the first one just resolved, and the seeds
  // need the workspace the second one resolves. Three waves on the server, on
  // a loopback socket, instead of two in the browser with a repaint between
  // each — that waterfall is what was being watched at every reload.
  // The scopes are hashed with the account the ACTIVE machine sees: on a
  // remote one, the device's account there, not the local session's — the
  // rows that machine's agents and its own interface read (TODO #646).
  const owner = workspaceOwner(me.owner, machine);
  const previousOwner = previousLayoutOwner(me.owner, owner);
  const initialWorkspace = await resolveWorkspace(owner, previousOwner);
  // The rail's pinned state is per account: seeded with the canvas, so a
  // reload paints a pinned rail pinned instead of widening it after hydration.
  // On a remote machine, from the row its rail had before when it holds none yet.
  const navScope = owner ? { owner, scope: await sharedNavScope(owner) } : null;
  const navHandover = rowHandover(previousOwner ? await sharedNavScope(previousOwner) : null);
  const seeds = owner
    ? await resolveLayoutSeeds(initialWorkspace, navScope ? [BACKGROUND_SCOPE, { scope: navScope.scope, legacy: navHandover }] : [BACKGROUND_SCOPE])
    : {};
  const navPinned = !!navScope && navPinnedOf(seeds[navScope.scope]);
  return (
    <html
      lang={locale}
      dir={localeDirection(locale)}
      suppressHydrationWarning
      // Read on the server so a frosted chrome paints frosted on the first
      // frame; the Appearance screen flips them live (`applyGlassAttributes`).
      data-glass={initialAppearance.glass ? '' : undefined}
      data-glass-bubbles={initialAppearance.glassBubbles ? '' : undefined}
      // Whole island or each widget: the default an island's menu may override.
      data-glass-scope={effectiveGlass(initialAppearance).glassScope}
      data-widgets-borderless={initialAppearance.widgetsBorderless ? '' : undefined}
      data-widgets-transparent={initialAppearance.widgetsTransparent ? '' : undefined}
      data-widgets-style-at={String(initialAppearance.widgetsStyleAt)}
      // The machine this page is rendered for: what `machine-storage.ts`
      // (`MACHINE_ATTRIBUTE`) prefixes the browser's per-machine keys with.
      data-timon-machine={target.id}
      // Reserves the pinned rail's gutter before the rail's effect sets
      // `--timon-nav-w` (globals.css, desktop widths only).
      data-nav-pinned={navPinned ? '' : undefined}
    >
      <head>
        {/* The browser hides a nonce once the element is in the page:
            `suppressHydrationWarning` keeps React from calling that a mismatch. */}
        <script type="importmap" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: JSON.stringify({ imports: PLATFORM_MODULES }) }} />
        {/* Onboarding opens dark for everyone, and it must do so BEFORE the
            first paint: the scheme is resolved on the server from the account
            preference, which does not exist yet during a first run. Same
            decision as `ThemeProvider` (`schemeFollowsSystem`), applied early
            enough to be invisible; a scheme picked on the onboarding's switch
            (`FIRST_RUN_SCHEME_KEY`) wins, as it does there. The slash character class survives template escaping.
            `suppressHydrationWarning` on <html> is what lets the
            class differ from the server's. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: `(function(){try{var a=${JSON.stringify(FIRST_RUN_ALLOWED)};var p=location.pathname.replace(/[/]+$/,'')||'/';if(!a.some(function(x){return p===x||p.indexOf(x+'/')===0;}))return;var s=null;try{s=sessionStorage.getItem(${JSON.stringify(FIRST_RUN_SCHEME_KEY)});}catch(e){}var l=s==='light';var c=document.documentElement.classList;c.toggle('light',l);c.toggle('dark',!l);}catch(e){}})()` }}
        />
      </head>
      <body>
        {/* The dictionary's chunk may still be on its way when the page
            hydrates: this boundary keeps the server's HTML meanwhile. */}
        <Suspense fallback={null}>
        <LocaleProvider locale={locale}>
        {/* The instance identity is resolved on the server (it reads the
            environment) and handed to the client here, around EVERYTHING:
            login and invite render the logotype outside `#timon-shell` and
            outside (main), and they must carry the same marker. */}
        <InstanceProvider value={instance}>
        {/* The desktop window's title bar when it has none of the system's:
            first in the page, before every control that must cut itself
            out of its drag area (`components/window-frame.tsx`). */}
        <WindowFrame />
        {/* One drag context for the whole app — not just (main)/AppFrame.
            Agents, Multichat and Chat render TopBar → VerticalNav →
            WidgetZone without going through AppFrame; without a host here
            they throw `WidgetZone used outside of a WidgetHost`. */}
        <Suspense fallback={null}>
        {/* Read on the server, keyed by scope: what every `useStoredLayout`
            paints on its FIRST render instead of its defaults. */}
        <LayoutSeedsProvider seeds={seeds} navScope={navScope}>
        <WorkspaceLayoutProvider initial={initialWorkspace}>
          <NavigateListener />
          <LastRouteRecorder />
          <GuidedTourOffer />
        <WidgetHost>
        {/* The chat's skin sits here, above the chat rather than inside it:
            multichat mounts several threads side by side, and they share ONE
            appearance — a checkbox ticked in one cell must not leave the cell
            next to it painted the old way. */}
        <ChatAppearanceProvider>
        <PlatformGlobals />
        {/* Slots and client halves are mounted here, not in (main): Agents,
            Multichat, Chat, Notifications and Events render their own TopBar
            → VerticalNav → <Slot name="nav.item" /> without ever going
            through SlotRoot, and their rail was painted empty. */}
        <ClientPluginHost />
        <FirstRunGate />
        {/* The whole cockpit lives in this shell, the browser sidepanel
            doesn't: in pinned mode, the panel shrinks `#timon-shell` (and
            transforms it, so pages' `fixed` surfaces follow its width) —
            if it applied to <body>, the panel, which is also its child,
            would shift along with it. */}
        <div id="timon-shell">
        <ThemeProvider initialScheme={scheme} initialAppearance={initialAppearance} initialTheme={me.theme} nonce={nonce}>
        <BackgroundProvider>
          {/* Inside ThemeProvider so `.light` / `dark` exist on <html>
              when the two palettes apply. Tokens live on :root, so login
              and the browser panel inherit even though they sit outside
              #timon-shell. */}
          {/* The sync host wraps the slot instead of living inside its
              occupant: claiming the slot unmounts the bundled theme, and
              with it any effect it held. Reads `--primary`, whatever
              paints it — a theme plugin has no meta to implement. */}
          {/* Under the slot, always: `@layer timon-floor` loses to whatever
              paints the slot, and catches the tokens nobody defined. */}
          <ThemeFloor appearance={initialAppearance} theme={me.theme} />
          <ThemeColorSync>
            <SlotSingle name="theme" />
          </ThemeColorSync>
          <RolesProvider>
            <AuthRedirect />
            {children}
          </RolesProvider>
          {/* The one and only toaster. Mounted here, outside every page's
              `relative z-[1]` wrapper, so its z-index actually beats the
              topbar; inside `#timon-shell` so it follows the shell when the
              browser panel is pinned. Pages call `toast()` and nothing
              else. */}
          <Toaster />
          {/* The bottom-left notice cards (a new version, a GitHub star):
              one host for every page, beside the toaster, inside the shell
              so they follow it when the browser panel is pinned. */}
          <NoticesHost />
          {/* The update window's preview (`?update-preview=1`): paints
              nothing unless the address asks for it. */}
          <UpdatePreviewHost />
          {/* "Save changes?" before a document closes: asked by an island
              tab that may be unmounted, so it lives here, once. */}
          <UnsavedDocumentDialog />
          {/* Every "Are you sure?" of the app (`confirmAction()`), asked
              from handlers and helpers outside any component: one host,
              here, for the same reason. */}
          <ConfirmDialogHost />
          {/* Agent editor, opened over whatever page you're on. Mounted
              here for the same reason as the toaster: its entry points are
              scattered across layouts that don't share a frame. */}
          <AgentEditorModal />
          {/* Settings, same reason: a dialog over any page, addressed by
              `?settings=` (Suspense: it reads useSearchParams). Fetched on
              first open, like the agent editor's form. */}
          <Suspense fallback={null}>
            <SettingsDialogHost />
          </Suspense>
          {/* "Publish on GitHub", same reason: the notification card of a
              proposal opens it over any page, by `?forge-proposal=`. */}
          <Suspense fallback={null}>
            <ForgeProposalDialogHost />
          </Suspense>
        </BackgroundProvider>
        </ThemeProvider>
        </div>
        {/* Global right-hand rail: mounted outside the pages so the
            built-in browser survives navigation (unmounting = reconnect).
            Suspense required: the component reads useSearchParams to
            preselect the current chat's project. */}
        <Suspense fallback={null}>
          <BrowserOpener />
        </Suspense>
        {/* Same reason as the browser: a running command must survive
            navigation. Suspense: it reads useSearchParams (the view's agent). */}
        <Suspense fallback={null}>
          <TerminalOpener />
        </Suspense>
        <RegisterSW />
        <EgressRefusedNotice />
        <RadixPointerEventsReset />
        </ChatAppearanceProvider>
        </WidgetHost>
        </WorkspaceLayoutProvider>
        </LayoutSeedsProvider>
        </Suspense>
        </InstanceProvider>
        </LocaleProvider>
        </Suspense>
      </body>
    </html>
  );
}
