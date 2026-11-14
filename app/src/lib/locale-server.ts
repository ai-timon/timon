/**
 * The request's interface language, on the server. Server Components and the
 * client components rendered on the server live in two module graphs with two
 * copies of `i18n.ts`: the root layout applies the locale to the first here,
 * and hands it to `LocaleProvider` for the second and for the browser.
 *
 * `t()` reads a module-level locale, so two requests asking for two languages
 * at the same instant can trade a few strings; a reload fixes it. Accepted:
 * one computer, one reader, one language almost always.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cookies, headers, type UnsafeUnwrappedCookies, type UnsafeUnwrappedHeaders } from 'next/headers';
import { DEFAULT_LOCALE, loadLocale, setLocaleLoader, type Dictionary, type Locale } from './i18n';
import { LOCALE_COOKIE, parseLocaleChoice, resolveLocale } from './locale-preference';

/**
 * The server reads the dictionaries `scripts/build-locales.mjs` wrote under
 * `public/locales/` — the files the browser fetches. The server runs from
 * the app's folder (`server.ts` hands Next `process.cwd()`), standalone
 * package included: `build-server.mjs` copies `public/` into it. The tag
 * comes from the generated catalog, never from the request.
 */
setLocaleLoader(async (info) => {
  const text = await readFile(join(process.cwd(), 'public', 'locales', `${info.tag}.json`), 'utf8');
  return JSON.parse(text) as Dictionary;
});

// Synchronous on purpose: Next 15 still unwraps `cookies()` and `headers()`
// in place, and server components call this without awaiting.
export function requestLocale(): Locale {
  try {
    const cookie = (cookies() as unknown as UnsafeUnwrappedCookies).get(LOCALE_COOKIE)?.value;
    return resolveLocale(parseLocaleChoice(cookie), (headers() as unknown as UnsafeUnwrappedHeaders).get('accept-language'));
  } catch {
    // Outside a request (build-time prerender): nothing to negotiate.
    return DEFAULT_LOCALE;
  }
}

/** Resolves the request's locale and switches this module graph to it. */
export async function applyRequestLocale(): Promise<Locale> {
  const locale = requestLocale();
  await loadLocale(locale);
  return locale;
}
