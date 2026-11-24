import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setLocale, t } from './i18n';
import './i18n-test-locales';
import { SETTINGS_CATEGORY_IDS, STATIC_TABS } from './settings-layout';
import { settingsPath } from './settings-path';

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales');

// "Settings → Voice", "Réglages › Backends": a path written by hand. french-ok: the French paths the pattern catches
const HAND_WRITTEN_PATH = /(Settings|Réglages|Paramètres)\s*(→|›|->|>)/; // french-ok: the French settings names

// Settings screens that are not Timon's: they cannot be composed from our tabs.
const NOT_TIMON_SETTINGS: ReadonlySet<string> = new Set([
  'triggersPage.secret.howto.github', // GitHub's repository settings
  'triggersPage.secret.howto.gitlab', // GitLab's project settings
  'pluginsPage.install.errors.unreadable', // macOS System Settings
  'projectsPage.cwdWarnDenied', // macOS System Settings
  'desktop.uninstall.finishWindows', // Windows Settings (desktop shell, desktop.json)
]);

type LocaleString = { file: string; key: string; value: string };

function localeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return localeFiles(path);
    return entry.name.endsWith('.json') ? [path] : [];
  });
}

function strings(value: unknown, prefix: string[], out: LocaleString[], file: string): void {
  if (typeof value === 'string') {
    out.push({ file, key: prefix.join('.'), value });
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) strings(child, [...prefix, key], out, file);
  }
}

function allStrings(): LocaleString[] {
  const out: LocaleString[] = [];
  for (const path of localeFiles(LOCALES)) {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    strings(parsed, [], out, relative(LOCALES, path));
  }
  return out;
}

test('settingsPath composes the labels the Settings dialog shows', () => {
  try {
    setLocale('en');
    assert.equal(settingsPath('interface', 'voice'), 'Settings → Interface → Voice dictation');
    assert.equal(settingsPath('models', 'backends'), 'Settings → AI models → Providers');
    assert.equal(settingsPath('models'), 'Settings → AI models');
    setLocale('fr');
    assert.equal(settingsPath('interface', 'terminal'), 'Paramètres → Interface → Terminal'); // french-ok: the French locale under test
  } finally {
    setLocale('en');
  }
});

test('every static category and tab has a label in both locales', () => {
  try {
    for (const locale of ['en', 'fr'] as const) {
      setLocale(locale);
      for (const category of SETTINGS_CATEGORY_IDS) {
        const categoryKey = `settingsDialog.category.${category}`;
        assert.notEqual(t(categoryKey), categoryKey, `${locale}: ${categoryKey}`);
        for (const tab of STATIC_TABS[category]) {
          const tabKey = `settingsDialog.tab.${category}.${tab.id}`;
          assert.notEqual(t(tabKey), tabKey, `${locale}: ${tabKey}`);
        }
      }
    }
  } finally {
    setLocale('en');
  }
});

test('no locale string writes a Timon settings path by hand', () => {
  const offenders = allStrings()
    .filter(({ key, value }) => HAND_WRITTEN_PATH.test(value) && !NOT_TIMON_SETTINGS.has(key))
    .map(({ file, key }) => `${file}: ${key}`);
  assert.deepEqual(offenders, [], 'interpolate {settingsPath} with settingsPath(category, tab) instead');
});

test('a message that names a settings path does so in both locales', () => {
  const byLocale = (locale: string): Set<string> => new Set(
    allStrings()
      .filter(({ file, value }) => (file === `${locale}.json` || file.split(sep)[0] === locale) && value.includes('{settingsPath}'))
      .map(({ key }) => key),
  );
  assert.deepEqual([...byLocale('fr')].sort(), [...byLocale('en')].sort());
});
