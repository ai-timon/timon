import { t } from './i18n';

/** Keep the daemon's copy for settings or fields a newer daemon adds. */
export function settingCopy<T extends string | null>(key: string, field: 'label' | 'description' | 'unit', fallback: T): string | T {
  if (fallback === null) return fallback;
  const id = `settingsFields.${key}.${field}`;
  const text = t(id);
  return text === id ? fallback : text;
}
