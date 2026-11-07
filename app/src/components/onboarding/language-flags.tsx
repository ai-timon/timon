/**
 * The small flag in front of each language of the welcome's roller, as the
 * 04/11/2026 mockup shows it. Inline SVG on a 30×20 box, a few shapes each: no
 * image to fetch, no package.
 *
 * A flag stands for a country, a language for many: the mockup's choice is
 * kept and written down here, one country per locale folder.
 * - `en`: the United Kingdom.
 * - `pt-BR`: Brazil, the variant Timon ships.
 * - `ko`: South Korea; `ja`: Japan; the others their own country.
 * A locale without an entry (a language added later) shows no flag: its name
 * alone, rather than a guess. Adding one is a line in `FLAGS`.
 */
import type { ReactElement } from 'react';

const UK = (): ReactElement => (
  <>
    <rect width="30" height="20" fill="#012169" />
    <path d="M0 0L30 20M30 0L0 20" stroke="#fff" strokeWidth="4" />
    <path d="M0 0L30 20M30 0L0 20" stroke="#C8102E" strokeWidth="1.6" />
    <path d="M15 0v20M0 10h30" stroke="#fff" strokeWidth="6" />
    <path d="M15 0v20M0 10h30" stroke="#C8102E" strokeWidth="3.2" />
  </>
);

const vertical = (a: string, b: string, c: string) => (): ReactElement => (
  <>
    <rect width="10" height="20" fill={a} />
    <rect x="10" width="10" height="20" fill={b} />
    <rect x="20" width="10" height="20" fill={c} />
  </>
);

const horizontal = (a: string, b: string, c: string) => (): ReactElement => (
  <>
    <rect width="30" height="7" fill={a} />
    <rect y="6.6" width="30" height="7" fill={b} />
    <rect y="13.3" width="30" height="6.7" fill={c} />
  </>
);

/** Shapes drawn on demand, never at import: a module-level element would need React loaded first. */
export const FLAGS: Readonly<Record<string, () => ReactElement>> = {
  en: UK,
  fr: vertical('#002395', '#fff', '#ED2939'),
  de: horizontal('#000', '#DD0000', '#FFCE00'),
  es: () => (
    <>
      <rect width="30" height="20" fill="#AA151B" />
      <rect y="5" width="30" height="10" fill="#F1BF00" />
    </>
  ),
  it: vertical('#009246', '#fff', '#CE2B37'),
  nl: horizontal('#AE1C28', '#fff', '#21468B'),
  pl: () => (
    <>
      <rect width="30" height="10" fill="#fff" />
      <rect y="10" width="30" height="10" fill="#DC143C" />
    </>
  ),
  'pt-BR': () => (
    <>
      <rect width="30" height="20" fill="#009C3B" />
      <path d="M15 2.5L27 10L15 17.5L3 10Z" fill="#FFDF00" />
      <circle cx="15" cy="10" r="4.2" fill="#002776" />
    </>
  ),
  ja: () => (
    <>
      <rect width="30" height="20" fill="#fff" />
      <circle cx="15" cy="10" r="6" fill="#BC002D" />
    </>
  ),
  ko: () => (
    <>
      <rect width="30" height="20" fill="#fff" />
      <path d="M10 10a5 5 0 0 1 10 0z" fill="#C60C30" />
      <path d="M10 10a5 5 0 0 0 10 0z" fill="#003478" />
    </>
  ),
  'zh-CN': () => (
    <>
      <rect width="30" height="20" fill="#DE2910" />
      <g fill="#FFDE00">
        <path d="M5 2l.7 2.1H8L6.1 5.5l.7 2.2L5 6.3 3.2 7.7l.7-2.2L2 4.1h2.3Z" />
        <path d="m10 2 .3.8h.9l-.7.5.3.9-.8-.5-.7.5.3-.9-.7-.5h.8Z" />
        <path d="m12 4 .3.8h.9l-.7.5.3.9-.8-.5-.7.5.3-.9-.7-.5h.8Z" />
        <path d="m12 7 .3.8h.9l-.7.5.3.9-.8-.5-.7.5.3-.9-.7-.5h.8Z" />
        <path d="m10 9 .3.8h.9l-.7.5.3.9-.8-.5-.7.5.3-.9-.7-.5h.8Z" />
      </g>
    </>
  ),
};

/** The flag of a locale, or nothing for a locale without one. */
export function LanguageFlag({ tag }: { tag: string }): ReactElement | null {
  const shapes = FLAGS[tag];
  if (!shapes) return null;
  return (
    <svg
      viewBox="0 0 30 20"
      aria-hidden
      data-flag={tag}
      className="h-4 w-6 shrink-0 overflow-hidden rounded-[3px] shadow-[0_0_0_1px_hsl(var(--foreground)/0.08)]"
    >
      {shapes()}
    </svg>
  );
}
