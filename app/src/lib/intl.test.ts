// french-ok-file: French language names and accented words, the locale data under test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareText, formatAgeShort, formatBytes, formatDate, formatDateTime, formatList, formatNumber,
  formatPercent, formatRelativeTime, formatTime, intlLocale, languageDisplayName, regionalTag,
} from './intl.js';
import { getLocale, setLocale } from './i18n.js';

// Local-time constructor: the helpers format in the system zone, so the
// expectations do not depend on the runner's TZ.
const AT = new Date(2026, 10, 4, 14, 5, 3);
const NOW = AT.getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('English and French render what the product rendered before the helper', () => {
  assert.equal(formatDate(AT, 'medium', 'en'), 'Nov 4, 2026');
  assert.equal(formatDate(AT, 'medium', 'fr'), '4 nov. 2026');
  assert.equal(formatDateTime(AT, undefined, 'en'), '11/4/2026, 2:05:03 PM');
  assert.equal(formatDateTime(AT, undefined, 'fr'), '04/11/2026 14:05:03');
  assert.equal(formatTime(AT, undefined, 'en'), '02:05 PM');
  assert.equal(formatTime(AT, undefined, 'fr'), '14:05');
  assert.equal(formatNumber(1234567.5, undefined, 'en'), '1,234,567.5');
  assert.equal(formatNumber(1234567.5, undefined, 'fr'), '1 234 567,5');
  assert.equal(formatBytes(1_234_000, 'en'), '1.2 MB');
  assert.equal(formatBytes(1_234_000, 'fr').replace(/\s/g, ' '), '1,2 Mo');
  assert.equal(formatRelativeTime(NOW - 3 * MIN, NOW, 'short', 'fr'), 'il y a 3 min');
  assert.equal(formatRelativeTime(NOW - 5 * HOUR, NOW, 'short', 'fr'), 'il y a 5 h');
  assert.equal(formatAgeShort(12 * MIN, 'en'), '12m');
  assert.equal(formatAgeShort(3 * HOUR, 'en'), '3h');
  assert.equal(formatAgeShort(2 * DAY, 'en'), '2d');
});

test('German formats dates, numbers and relative times its own way', () => {
  assert.equal(formatDate(AT, 'medium', 'de'), '04.11.2026');
  assert.equal(formatTime(AT, undefined, 'de'), '14:05');
  assert.equal(formatNumber(1234567.5, undefined, 'de'), '1.234.567,5');
  assert.equal(formatRelativeTime(NOW - 3 * MIN, NOW, 'short', 'de'), 'vor 3 Min.');
  assert.equal(formatRelativeTime(NOW - DAY, NOW, 'short', 'de'), 'gestern');
  assert.equal(formatList(['a', 'b', 'c'], 'and', 'de'), 'a, b und c');
});

test('Japanese formats dates and relative times its own way', () => {
  assert.equal(formatDate(AT, 'medium', 'ja'), '2026/11/04');
  assert.equal(formatRelativeTime(NOW - 3 * MIN, NOW, 'short', 'ja'), '3 分前');
  assert.equal(formatList(['a', 'b', 'c'], 'and', 'ja'), 'a、b、c');
  assert.equal(regionalTag('ja'), 'ja-JP');
});

test('Brazilian Portuguese keeps its region', () => {
  assert.equal(formatDate(AT, 'medium', 'pt-BR'), '4 de nov. de 2026');
  assert.equal(formatNumber(1234567.5, undefined, 'pt-BR'), '1.234.567,5');
  assert.equal(formatRelativeTime(NOW + 2 * DAY, NOW, 'short', 'pt-BR'), 'depois de amanhã');
  assert.equal(regionalTag('pt-BR'), 'pt-BR');
  assert.equal(languageDisplayName('fr', 'pt-BR'), 'francês');
});

test('the active language is used when no tag is given', () => {
  const previous = getLocale();
  try {
    setLocale('en');
    assert.equal(formatNumber(1234.5), '1,234.5');
    assert.equal(intlLocale(), 'en');
  } finally {
    setLocale(previous);
  }
});

test('relative times pick the largest unit and say "now" under a minute', () => {
  assert.equal(formatRelativeTime(NOW - 20_000, NOW, 'short', 'en'), 'just now');
  assert.equal(formatRelativeTime(NOW - 20_000, NOW, 'short', 'fr'), 'maintenant');
  assert.equal(formatRelativeTime(NOW - 3 * HOUR, NOW, 'long', 'en'), '3 hours ago');
  assert.equal(formatRelativeTime(NOW - 400 * DAY, NOW, 'long', 'en'), 'last year');
  assert.equal(formatRelativeTime(NOW + 10 * MIN, NOW, 'long', 'en'), 'in 10 minutes');
});

test('English relative times read as the product wrote them: no period, "just now"', () => {
  assert.equal(formatRelativeTime(NOW - 3 * MIN, NOW, 'short', 'en'), '3 min ago');
  assert.equal(formatRelativeTime(NOW - 5 * HOUR, NOW, 'short', 'en'), '5 hr ago');
  assert.equal(formatRelativeTime(NOW + 10 * MIN, NOW, 'short', 'en'), 'in 10 min');
  assert.equal(formatRelativeTime(NOW - 3 * DAY, NOW, 'short', 'en'), '3 days ago');
  assert.equal(formatRelativeTime(NOW - DAY, NOW, 'short', 'en'), 'yesterday');
  assert.equal(formatRelativeTime(NOW, NOW, 'short', 'en'), 'just now');
  assert.equal(formatRelativeTime(NOW - 3 * MIN, NOW, 'short', 'en-GB'), '3 min ago');
  // A moment still ahead is not "just now".
  assert.equal(formatRelativeTime(NOW + 20_000, NOW, 'short', 'en'), 'now');
  // Other languages keep Intl's abbreviations.
  assert.equal(formatRelativeTime(NOW - 3 * MIN, NOW, 'short', 'de'), 'vor 3 Min.');
  assert.equal(formatRelativeTime(NOW - 20_000, NOW, 'short', 'de'), 'jetzt');
});

test('an unreadable value or a forged tag never throws', () => {
  assert.equal(formatDate('not a date'), '');
  assert.equal(formatDateTime(Number.NaN), '');
  assert.equal(formatRelativeTime('nope'), '');
  assert.equal(intlLocale('xx-forged!!'), 'en');
  assert.equal(formatNumber(1234.5, undefined, '<script>'), '1,234.5');
});

test('percent, regional tags and text order', () => {
  assert.equal(formatPercent(0.42, undefined, 'en'), '42%');
  assert.equal(formatPercent(0.42, undefined, 'fr'), '42 %');
  assert.equal(regionalTag('fr'), 'fr-FR');
  assert.equal(regionalTag('en'), 'en-US');
  assert.ok(compareText('école', 'zèbre', 'fr') < 0);
});
