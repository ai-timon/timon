// UI texts of Citadel. The browser entry (client.tsx) plugs in Timon's translator (`createTranslator` from
// @timon/ui, ICU messages, English first); without it (Node tests) English is read directly from messages.json.
import messages from './messages.json';

type Params = Record<string, string | number>;
type Translate = (key: string, params?: Params) => string;
interface Tree { [key: string]: string | Tree }

let translate: Translate | null = null;
let getLocale: (() => string) | null = null;
/** Plugs in the translator and the locale reader of the host (Timon's `createTranslator` / `getLocale`). */
export function configureI18n({ translate: tr, locale }: { translate: Translate; locale: () => string }): void { translate = tr; getLocale = locale; }

const lookup = (obj: Tree, key: string): string | Tree | undefined =>
  key.split('.').reduce<string | Tree | undefined>((o, k) => (o === undefined || typeof o === 'string' ? undefined : o[k]), obj);
// Minimal English fallback: {name} substitution and `{n, plural, one {…} other {…}}` (with # for the number).
function fallback(key: string, params: Params): string {
  let msg = lookup(messages.en, key);
  if (typeof msg !== 'string') return key;
  msg = msg.replace(/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g, (_, n: string, one: string, other: string) => {
    const v = Number(params[n]);
    return (v === 1 ? one : other).replace(/#/g, String(v));
  });
  return msg.replace(/\{(\w+)\}/g, (m, n: string) => (n in params ? String(params[n]) : m));
}
/** Text for `key` (dotted path in messages.json), with ICU `params`. */
export const t = (key: string, params: Params = {}): string => translate ? translate(key, params) : fallback(key, params);
/** BCP 47 tag of the reader's language (any language Timon ships); never compared with a literal. */
export const locale = (): string => (getLocale ? getLocale() : (typeof navigator !== 'undefined' && navigator.language) || 'en');
