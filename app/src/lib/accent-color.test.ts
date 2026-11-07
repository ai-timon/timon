import test from 'node:test';
import assert from 'node:assert/strict';

import { accentPair, accentVars } from './accent-color';

/** Relative luminance, the WCAG one, to assert readability rather than hue. */
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const channel = (i: number) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = luminance('#ffffff');
const NEAR_BLACK = luminance('#0b0b0b');
/** Readable in both themes as-is: neither correction should touch it. */
const MID = '#3b82f6';

test('a near-black project colour becomes readable on a dark background', () => {
  // Timon's own colour, unreadable as-is on the dark theme.
  const { light, dark } = accentPair('#2b2b2b');
  assert.equal(light, '#2b2b2b', 'the light theme keeps the chosen colour');
  assert.ok(contrast(luminance(dark), NEAR_BLACK) > 3, `${dark} still drowns`);
});

test('a pale colour is darkened for the light theme and kept for the dark one', () => {
  const { light, dark } = accentPair('#ffe9a8');
  assert.ok(contrast(luminance(light), WHITE) > 3, `${light} washes out`);
  assert.equal(dark, '#ffe9a8');
});

test('the hue survives both corrections — a project stays the same project', () => {
  const { light, dark } = accentPair('#1d4ed8');
  for (const variant of [light, dark]) {
    const channel = (i: number) => parseInt(variant.slice(i, i + 2), 16);
    assert.ok(channel(5) > channel(1) && channel(5) > channel(3), `${variant} is no longer blue`);
  }
});

test('a mid colour is left alone in both themes', () => {
  const { light, dark } = accentPair(MID);
  assert.equal(light, MID);
  assert.equal(dark, MID);
});

test('unparseable or missing colours are passed through, never corrupted', () => {
  assert.deepEqual(accentPair(null), { light: 'currentColor', dark: 'currentColor' });
  assert.deepEqual(accentPair('rebeccapurple'), { light: 'rebeccapurple', dark: 'rebeccapurple' });
  const vars = accentVars('rebeccapurple') as Record<string, string | undefined>;
  assert.equal(vars['--accent-soft'], 'rebeccapurple');
});

test('short hex is accepted', () => {
  assert.equal(accentPair('#000').dark, accentPair('#000000').dark);
});

test('vars carry the tinted background and border both themes need', () => {
  const vars = accentVars('#2b2b2b') as Record<string, string>;
  assert.equal(vars['--accent-soft'], '#2b2b2b24');
  assert.match(String(vars['--accent-border-dark']), /^#[0-9a-f]{6}66$/);
});
