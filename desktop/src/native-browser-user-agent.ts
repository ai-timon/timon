/** What the embedded browser presents to sites, derived from the Chromium Electron ships. */

export interface BrowserUserAgentMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

const FALLBACK_CHROME = '130.0.0.0';

/** Drops the `Electron/x` and `<AppName>/x` tokens: identity providers refuse or loop on an embedded shell. */
export function desktopUserAgent(raw: string): string {
  return raw
    .replace(/\sElectron\/\S+/g, '')
    .replace(/(\(KHTML, like Gecko\))\s+\S+\/\S+(?=\s+Chrome\/)/, '$1');
}

export function chromeVersion(userAgent: string): string {
  return userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? FALLBACK_CHROME;
}

export function mobileUserAgent(chrome: string): string {
  return `Mozilla/5.0 (Linux; Android 14; Timon) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`;
}

/**
 * Client hints (`Sec-CH-UA`, `navigator.userAgentData`) are sent separately from the UA string and
 * would otherwise still name Electron, so a login page that checks them keeps rejecting the browser.
 */
export function userAgentMetadata(
  chrome: string, mobile: boolean, platform: NodeJS.Platform, systemVersion: string,
): BrowserUserAgentMetadata {
  const major = chrome.split('.')[0] || '130';
  const desktopPlatform = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  return {
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not_A Brand', version: '24' },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: chrome },
      { brand: 'Google Chrome', version: chrome },
      { brand: 'Not_A Brand', version: '24.0.0.0' },
    ],
    fullVersion: chrome,
    platform: mobile ? 'Android' : desktopPlatform,
    platformVersion: mobile ? '14.0.0' : systemVersion,
    architecture: mobile ? '' : 'x86',
    model: '', mobile,
  };
}

/** `Sec-CH-UA` header value for a brand list, e.g. `"Chromium";v="130", "Google Chrome";v="130"`. */
export function clientHintBrands(list: Array<{ brand: string; version: string }>): string {
  return list.map((entry) => `"${entry.brand}";v="${entry.version}"`).join(', ');
}

/**
 * Who the browser says it is on a page. `chrome` is the identity above, everywhere but one host:
 * on Google's sign-in host, a Chrome version Electron's engine cannot back up gets the sign-in
 * refused, so the page sees the UA without its Chrome version and Electron's own brands
 * (Chromium, no "Google Chrome"). The rule Ferdium ships for its Google sign-in.
 */
export type BrowserIdentity = 'chrome' | 'googleSignin';

const GOOGLE_SIGNIN_HOST = 'accounts.google.com';

export function isGoogleSigninUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === GOOGLE_SIGNIN_HOST;
  } catch { return false; }
}

export function identityForUrl(url: string): BrowserIdentity {
  return isGoogleSigninUrl(url) ? 'googleSignin' : 'chrome';
}

/** `Chrome/130.0.6723.191` becomes `Chrome`; every other token stays. */
export function versionlessUserAgent(userAgent: string): string {
  return userAgent.replace(/Chrome\/[\d.]+/, 'Chrome');
}

/** The `User-Agent` header a request leaves with: never Electron's tokens, and without its Chrome version for Google's sign-in. */
export function signinUserAgent(header: string, signin: boolean): string {
  const clean = desktopUserAgent(header);
  return signin ? versionlessUserAgent(clean) : clean;
}

/** The brand list Electron announces itself: Chromium and the grease entry, never "Google Chrome". */
export function withoutChromeBrand(metadata: BrowserUserAgentMetadata): BrowserUserAgentMetadata {
  const keep = (entry: { brand: string }) => entry.brand !== 'Google Chrome';
  return { ...metadata, brands: metadata.brands.filter(keep), fullVersionList: metadata.fullVersionList.filter(keep) };
}

/** What a tab applies for an identity: the UA string and the client hints it announces. */
export function identityOverride(identity: BrowserIdentity, userAgent: string, metadata: BrowserUserAgentMetadata): {
  userAgent: string; userAgentMetadata: BrowserUserAgentMetadata;
} {
  return identity === 'googleSignin'
    ? { userAgent: versionlessUserAgent(userAgent), userAgentMetadata: withoutChromeBrand(metadata) }
    : { userAgent, userAgentMetadata: metadata };
}
