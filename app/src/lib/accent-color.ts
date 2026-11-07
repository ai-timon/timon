/**
 * Accent colours that stay readable in both themes.
 *
 * A project painted near-black (`#2b2b2b`) disappears on a dark background,
 * and a pastel one disappears on a light one. Rather than storing two colours
 * or reading the theme in JS — which renders the wrong variant on the server
 * and swaps it after hydration, the flash `brand-logo.tsx` avoids — both
 * variants are computed once and published as CSS variables, and CSS picks:
 *
 *   <span style={accentVars(color)} className="text-[var(--accent)] dark:text-[var(--accent-dark)]">
 *
 * Only the lightness moves: the hue is the identity of the project, and a
 * project recognised by its hue must stay the same project in the dark.
 */

import type { CSSProperties } from 'react';

/**
 * Target contrast ratio against the theme background. 3:1 is the WCAG floor
 * for UI components and large text, which is what these accents are: badge
 * labels, avatar rings, chips. Chasing 4.5 would repaint half the palette.
 */
const TARGET_CONTRAST = 3.2;

/** The backgrounds the two themes actually paint behind an accent. */
const LIGHT_BACKGROUND = 1; // white
const DARK_BACKGROUND = 0.0045; // near-black, the dark theme's canvas

export type AccentPair = { light: string; dark: string };

type Hsl = { h: number; s: number; l: number };

function parseHex(input: string): { r: number; g: number; b: number } | null {
  const hex = input.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex({ h, s, l }: Hsl): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const c = ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function contrastAt(hsl: Hsl, lightness: number, background: number): number {
  const rgb = parseHex(hslToHex({ ...hsl, l: lightness }));
  return rgb ? contrast(luminance(rgb), background) : 0;
}

/**
 * Moves the lightness — and only the lightness — until the colour reaches the
 * target contrast against `background`, or until the scale runs out. Hue and
 * saturation are the identity of the project; a yellow that needs a lot of
 * darkening to read on white must stay yellow.
 *
 * Binary search rather than a fixed lightness threshold: contrast depends on
 * the hue (a pure yellow at 50% lightness is still far too bright), so a
 * single cutoff repaints some colours that were fine and leaves others unread.
 */
function fit(hsl: Hsl, background: number, direction: 'darker' | 'lighter'): string {
  if (contrastAt(hsl, hsl.l, background) >= TARGET_CONTRAST) return hslToHex(hsl);
  let lo = direction === 'darker' ? 0 : hsl.l;
  let hi = direction === 'darker' ? hsl.l : 100;
  // The endpoint we move towards is black or white: if even that fails the
  // target, nothing else will, and the loop still returns the best of the two.
  for (let i = 0; i < 12; i += 1) {
    const mid = (lo + hi) / 2;
    if (contrastAt(hsl, mid, background) >= TARGET_CONTRAST) {
      if (direction === 'darker') lo = mid;
      else hi = mid;
    } else if (direction === 'darker') hi = mid;
    else lo = mid;
  }
  const chosen = direction === 'darker' ? lo : hi;
  return hslToHex({ ...hsl, l: chosen });
}

/**
 * The two readable variants of a colour. Unparseable input is returned as-is
 * in both slots: a caller passing a CSS keyword or a gradient keeps whatever
 * it meant rather than being silently repainted.
 */
export function accentPair(color: string | null | undefined): AccentPair {
  if (!color) return { light: 'currentColor', dark: 'currentColor' };
  const rgb = parseHex(color);
  if (!rgb) return { light: color, dark: color };
  const hsl = rgbToHsl(rgb);
  return {
    light: fit(hsl, LIGHT_BACKGROUND, 'darker'),
    dark: fit(hsl, DARK_BACKGROUND, 'lighter'),
  };
}

/**
 * CSS variables for an accent, to be spread in a `style` prop. Consumers read
 * `var(--accent)` and `dark:var(--accent-dark)`; the alpha variants cover the
 * tinted backgrounds and borders badges use.
 */
export function accentVars(color: string | null | undefined): CSSProperties {
  const { light, dark } = accentPair(color);
  // Alpha is appended to the hex, so a colour we could not parse (a CSS
  // keyword, a variable) gets the opaque value rather than `redcc`.
  const alpha = (value: string, suffix: string) =>
    /^#[0-9a-f]{6}$/i.test(value) ? `${value}${suffix}` : value;
  return {
    '--accent': light,
    '--accent-dark': dark,
    '--accent-soft': alpha(light, '24'),
    '--accent-soft-dark': alpha(dark, '24'),
    '--accent-border': alpha(light, '66'),
    '--accent-border-dark': alpha(dark, '66'),
  } as CSSProperties;
}
