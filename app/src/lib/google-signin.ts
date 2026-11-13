/**
 * Google refuses to sign anyone in from the embedded browser's engine. These helpers
 * recognise its accounts pages and plan the detour through an installed Chrome: which
 * page Chrome opens on, and where the panel goes once the sign-in is copied back.
 *
 * The main case is not signing in to Google itself but "Sign in with Google" on another
 * site (OAuth): the site sends its tab, or a popup, to accounts.google.com. Chrome must then
 * open on that site, so the user runs its whole sign-in there and the site sets its own
 * session cookies, which the import copies along with Google's.
 */

const GOOGLE_ACCOUNTS_HOST = 'accounts.google.com';
const REJECTED_PATH = /^\/(?:v\d+\/)?signin(?:\/v\d+)?\/rejected\/?$/;
const OAUTH_PATH = /^\/(?:o\/oauth2|(?:v\d+\/)?signin\/oauth)(?:\/|$)/;
const MAX_NESTING = 4;
/** Where a sign-in to Google itself lands when the refused page named no https page to return to. */
const GOOGLE_ACCOUNT_HOME = 'https://myaccount.google.com/';

function parse(value: string | null | undefined): URL | null {
  if (!value) return null;
  try { return new URL(value); } catch { return null; }
}

function isWebUrl(url: URL | null): url is URL {
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
}

/** An https page of Google's accounts host, and only that host (no lookalike suffix). */
export function isGoogleAccountsPage(value: string | null | undefined): boolean {
  const url = parse(value);
  return url !== null && url.protocol === 'https:' && url.hostname === GOOGLE_ACCOUNTS_HOST;
}

/** The "This browser or app may not be secure" page. */
export function isGoogleSigninRejected(value: string | null | undefined): boolean {
  return isGoogleAccountsPage(value) && REJECTED_PATH.test(new URL(value!).pathname);
}

/** The page Google returns to after the sign-in, kept only when it is https. */
export function googleSigninContinue(value: string | null | undefined): string | null {
  if (!isGoogleAccountsPage(value)) return null;
  const target = parse(new URL(value!).searchParams.get('continue'));
  return target?.protocol === 'https:' ? target.href : null;
}

/** Google's accounts URLs nest the next step in `continue`; walk them, bounded. */
function chain(value: string): URL[] {
  const urls: URL[] = [];
  let current = parse(value);
  while (current && urls.length < MAX_NESTING && current.hostname === GOOGLE_ACCOUNTS_HOST) {
    urls.push(current);
    current = parse(current.searchParams.get('continue'));
  }
  return urls;
}

/** A Google page reached from another site's "Sign in with Google" (OAuth). */
export function isGoogleOAuthFlow(value: string | null | undefined): boolean {
  if (!isGoogleAccountsPage(value)) return false;
  return chain(value!).some((url) => OAUTH_PATH.test(url.pathname)
    || /oauth/i.test(url.searchParams.get('flowName') ?? '')
    || url.searchParams.has('client_id') || url.searchParams.has('redirect_uri'));
}

/** The origin of the site an OAuth flow returns to, read from its `redirect_uri`. */
export function oauthRedirectOrigin(value: string | null | undefined): string | null {
  if (!isGoogleAccountsPage(value)) return null;
  for (const url of chain(value!)) {
    const target = parse(url.searchParams.get('redirect_uri'));
    if (isWebUrl(target) && target.hostname !== GOOGLE_ACCOUNTS_HOST) return `${target.origin}/`;
  }
  return null;
}

/** Google's sign-in page, returning to `continueUrl` (https only, otherwise Google's default). */
export function googleSigninStartUrl(continueUrl: string | null): string {
  const url = new URL(`https://${GOOGLE_ACCOUNTS_HOST}/ServiceLogin`);
  const target = parse(continueUrl);
  if (target?.protocol === 'https:') url.searchParams.set('continue', target.href);
  return url.href;
}

/** What the panel remembers of its tabs between two status readings. */
export interface BrowserTabTrail {
  /** The last page of each tab that was not a Google accounts page. */
  site: Record<string, string>;
  /** The tab that was active when a tab first appeared: the opener of a popup, as far as the panel can tell. */
  opener: Record<string, string>;
  /** Every tab seen so far. */
  seen: string[];
  activeTabId: string | null;
  /** Tabs the user opened with the panel's own button, not yet seen: they have no opener. */
  userTabs: number;
}

export const EMPTY_TAB_TRAIL: BrowserTabTrail = { site: {}, opener: {}, seen: [], activeTabId: null, userTabs: 0 };

/** The user is about to open a tab by hand: the next new tab is theirs, not a page's popup. */
export function noteUserTab(trail: BrowserTabTrail): BrowserTabTrail {
  return { ...trail, userTabs: trail.userTabs + 1 };
}

/** Folds one status reading into the trail. The panel polls every second, so redirects in between go unseen; the site before them does not. */
export function trackBrowserTabs(trail: BrowserTabTrail, status: { tabs: { id: string; url: string }[]; activeTabId: string | null }): BrowserTabTrail {
  const ids = new Set(status.tabs.map((tab) => tab.id));
  const site: Record<string, string> = {};
  const opener: Record<string, string> = {};
  for (const [id, url] of Object.entries(trail.site)) if (ids.has(id)) site[id] = url;
  for (const [id, from] of Object.entries(trail.opener)) if (ids.has(id)) opener[id] = from;
  const seen = new Set(trail.seen.filter((id) => ids.has(id)));
  const first = trail.seen.length === 0;
  let userTabs = trail.userTabs;
  for (const tab of status.tabs) {
    if (!seen.has(tab.id)) {
      // The first reading has no history to tell an opener from: every tab was already there.
      if (userTabs > 0) userTabs -= 1;
      else if (!first && trail.activeTabId && trail.activeTabId !== tab.id && ids.has(trail.activeTabId)) opener[tab.id] = trail.activeTabId;
      seen.add(tab.id);
    }
    const url = parse(tab.url);
    if (isWebUrl(url) && url.hostname !== GOOGLE_ACCOUNTS_HOST) site[tab.id] = url.href;
  }
  return { site, opener, seen: [...seen], activeTabId: status.activeTabId, userTabs };
}

export interface GoogleSigninPlan {
  /** "Sign in with Google" on another site, rather than a sign-in to Google itself. */
  oauth: boolean;
  /** The page Chrome opens on; undefined leaves the desktop's default. */
  startUrl?: string;
  /** Where the panel navigates once the sign-in is copied. */
  returnUrl: string;
  /** The tab that is sent back there. */
  returnTabId: string | null;
  /** A sign-in popup to close: the site in its opener is what the user wants back. */
  closeTabId: string | null;
}

/** Plans the detour for the Google page `url` shown in tab `tabId`. */
export function googleSigninPlan(trail: BrowserTabTrail, tabId: string | null, url: string): GoogleSigninPlan {
  const continueUrl = googleSigninContinue(url);
  const ownSite = tabId ? trail.site[tabId] : undefined;
  const openerId = tabId ? trail.opener[tabId] : undefined;
  // A popup's own first page can be the site's sign-in handler (Firebase): the opener's page is the site.
  const openerSite = openerId ? trail.site[openerId] : undefined;
  const oauth = isGoogleOAuthFlow(url) || !!openerSite;
  if (!oauth) {
    return { oauth, startUrl: googleSigninStartUrl(continueUrl), returnUrl: continueUrl ?? GOOGLE_ACCOUNT_HOME, returnTabId: tabId, closeTabId: null };
  }
  const site = openerSite ?? ownSite ?? null;
  // Without the site's own page, Google's flow is the only way back to it.
  const startUrl = site ?? continueUrl ?? undefined;
  const returnUrl = site ?? oauthRedirectOrigin(url) ?? continueUrl ?? GOOGLE_ACCOUNT_HOME;
  const popup = !!openerSite;
  return { oauth, startUrl, returnUrl, returnTabId: popup ? openerId! : tabId, closeTabId: popup ? tabId : null };
}
