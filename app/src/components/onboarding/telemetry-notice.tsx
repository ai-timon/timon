'use client';

/**
 * The onboarding's one line about usage statistics, under the terms of the
 * "Choose your LLM" step: sharing is on by default (an opt-out, decided on
 * 17/11/2026), so the person is told, once, and can turn it off in one click
 * without leaving the onboarding. No checkbox to validate, nothing blocking:
 * the line shows only while statistics are actually being sent, and the
 * button only when this switch is the one that decides (not the environment
 * nor the configuration file). A toast confirms, with where to turn it back on.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import { fetchTelemetryPreference, putTelemetryPreference, type TelemetryPreferenceView } from '@/lib/telemetry-preference';
import { splitAtSlots } from './llm-choice';

export function TelemetryNotice(): ReactElement | null {
  const [pref, setPref] = useState<TelemetryPreferenceView | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void fetchTelemetryPreference().then((read) => { if (alive) setPref(read); });
    return () => { alive = false; };
  }, []);

  if (!pref?.enabled || !pref.active) return null;

  const turnOff = async () => {
    setBusy(true);
    const result = await putTelemetryPreference(false);
    setBusy(false);
    if (!result.ok) { toast.error(result.message); return; }
    setPref(result.pref);
    toast.success(t('onboarding.llm.telemetryOff', { settingsPath: settingsPath('system', 'privacy') }));
  };

  const parts = splitAtSlots((vars) => t('onboarding.llm.telemetry', vars), ['turnOff']);
  return (
    <p className="mt-1.5 max-w-[420px] text-xs leading-relaxed text-muted-foreground" data-telemetry-notice="">
      {parts.map((part, i) => {
        if (part.kind === 'text') return <span key={i}>{part.text}</span>;
        return pref.editable ? (
          <button
            key={i}
            type="button"
            disabled={busy}
            onClick={() => { void turnOff(); }}
            className="text-foreground underline underline-offset-2 hover:text-primary disabled:opacity-60"
            data-telemetry-turn-off=""
          >
            {t('onboarding.llm.telemetryTurnOff')}
          </button>
        ) : null;
      })}
    </p>
  );
}
