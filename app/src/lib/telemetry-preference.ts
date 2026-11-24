/**
 * The anonymous usage statistics preference, as `GET /api/ui/telemetry/preference`
 * returns it, and the one door that changes it: the Privacy row and the
 * onboarding's one-click opt-out read and write it the same way.
 */
import { apiErrorMessage } from './api-error';
import { BRAND } from './brand';
import { t } from './i18n';

export const TELEMETRY_MODULE = '@timon/telemetry';
export const TELEMETRY_PREFERENCE_URL = '/api/ui/telemetry/preference';
export const PRIVACY_DOCS_URL = `https://docs.${BRAND.domain}/usage/privacy`;

export type TelemetrySource = 'env' | 'config' | 'settings' | 'default';

export type TelemetryPreferenceView = {
  enabled: boolean;
  source: TelemetrySource;
  malformed: boolean;
  /** False when the environment or `timon.config.json` decides. */
  editable: boolean;
  /** False on a build that sends nothing at all (source checkout, tests). */
  active: boolean;
};

const SOURCES: readonly TelemetrySource[] = ['env', 'config', 'settings', 'default'];

/** The daemon's answer, or `null` when it is not one. */
export function parseTelemetryPreference(raw: unknown): TelemetryPreferenceView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean' || typeof r.editable !== 'boolean') return null;
  if (typeof r.source !== 'string' || !(SOURCES as readonly string[]).includes(r.source)) return null;
  return {
    enabled: r.enabled,
    source: r.source as TelemetrySource,
    malformed: r.malformed === true,
    editable: r.editable,
    active: r.active !== false,
  };
}

/** i18n key of the line explaining who decides, or `null` when the switch does. */
export function telemetryLockKey(pref: TelemetryPreferenceView): string | null {
  if (pref.source === 'env') return pref.malformed ? 'telemetrySettings.lockedEnvMalformed' : 'telemetrySettings.lockedEnv';
  if (pref.source === 'config') return pref.malformed ? 'telemetrySettings.lockedConfigMalformed' : 'telemetrySettings.lockedConfig';
  return null;
}

/** i18n keys of the row's status line, joined with " · ": the state, then who decides, then a build that sends nothing. */
export function telemetryStatusKeys(pref: TelemetryPreferenceView): string[] {
  const keys = [pref.enabled ? 'telemetrySettings.statusOn' : 'telemetrySettings.statusOff'];
  const lock = telemetryLockKey(pref);
  if (lock) keys.push(lock);
  if (!pref.active) keys.push('telemetrySettings.inactiveBuild');
  return keys;
}

/** The preference, or `null` when it cannot be read. */
export async function fetchTelemetryPreference(fetcher: typeof fetch = fetch): Promise<TelemetryPreferenceView | null> {
  try {
    const res = await fetcher(TELEMETRY_PREFERENCE_URL, { cache: 'no-store' });
    return res.ok ? parseTelemetryPreference(await res.json()) : null;
  } catch {
    return null;
  }
}

export type TelemetryWriteResult = { ok: true; pref: TelemetryPreferenceView } | { ok: false; message: string };

/**
 * Turns sharing on or off. A refusal is worded from the daemon's code: the
 * environment or the configuration file deciding (`telemetry_preference_forced`)
 * says where to change it.
 */
export async function putTelemetryPreference(enabled: boolean, fetcher: typeof fetch = fetch): Promise<TelemetryWriteResult> {
  try {
    const res = await fetcher(TELEMETRY_PREFERENCE_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 403) return { ok: false, message: t('telemetrySettings.forbidden') };
    if (!res.ok) return { ok: false, message: apiErrorMessage(body, t('telemetrySettings.saveFailed')) };
    const pref = parseTelemetryPreference(body);
    return pref ? { ok: true, pref } : { ok: false, message: t('telemetrySettings.saveFailed') };
  } catch {
    return { ok: false, message: t('telemetrySettings.saveFailed') };
  }
}
