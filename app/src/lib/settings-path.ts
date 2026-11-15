/**
 * Where something lives in the Settings dialog, as the user reads it there:
 * `Settings → Interface → Voice dictation`.
 *
 * Messages interpolate it (`{settingsPath}`) instead of copying the labels:
 * a copied path went stale every time a tab was renamed or moved (TODO #447:
 * "Settings → Voice", "Settings › Backends"). `settings-path.test.ts` refuses
 * a hand-written path in the locale files.
 */
import { t } from './i18n';
import type { SettingsCategoryId } from './settings-layout';

const SEPARATOR = ' → ';

export function settingsPath(category: SettingsCategoryId, tab?: string): string {
  const parts = [t('nav.settings'), t(`settingsDialog.category.${category}`)];
  if (tab) parts.push(t(`settingsDialog.tab.${category}.${tab}`));
  return parts.join(SEPARATOR);
}

/** The account's own panes at the foot of the dialog (`Settings → Profile`), which are not categories. */
export function settingsAccountPath(view: 'profile' | 'license'): string {
  return [t('nav.settings'), t(view === 'profile' ? 'session.profile' : 'session.license')].join(SEPARATOR);
}
