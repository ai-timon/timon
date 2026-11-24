'use client';

/**
 * Settings › System › Privacy, the own part of `@timon/telemetry`: one row,
 * "Share anonymous usage statistics", its state at the left, "Turn off" or
 * "Turn on" at the right, what is sent and the privacy notice in the "…"
 * menu. When the environment (`TIMON_TELEMETRY`) or `timon.config.json`
 * decides, the row says so and offers no switch.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { t } from '@/lib/i18n';
import {
  PRIVACY_DOCS_URL, fetchTelemetryPreference, putTelemetryPreference, telemetryStatusKeys, type TelemetryPreferenceView,
} from '@/lib/telemetry-preference';

export function TelemetrySettings(): ReactElement | null {
  const [pref, setPref] = useState<TelemetryPreferenceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);

  const load = useCallback(async () => {
    const read = await fetchTelemetryPreference();
    if (read) setPref(read);
    else setError(t('telemetrySettings.loadFailed'));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('');
    const result = await putTelemetryPreference(enabled);
    if (result.ok) setPref(result.pref);
    else setError(result.message);
    setBusy(false);
  };

  const status = pref ? telemetryStatusKeys(pref) : [];

  return (
    <div className="max-w-2xl space-y-2" data-telemetry-settings="">
      <ProviderSection title={t('telemetrySettings.title')}>
        <ProviderSettingRow
          data-telemetry-row=""
          title={t('telemetrySettings.share')}
          status={pref ? <span>{status.map((key) => t(key)).join(' · ')}</span> : undefined}
          action={pref?.editable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              disabled={busy}
              onClick={() => { void toggle(!pref.enabled); }}
              data-telemetry-toggle={pref.enabled ? 'off' : 'on'}
            >
              {t(pref.enabled ? 'telemetrySettings.turnOff' : 'telemetrySettings.turnOn')}
            </Button>
          ) : undefined}
          menu={(
            <>
              <DropdownMenuItem onSelect={() => { setDetails(true); }} data-telemetry-details="">
                {t('telemetrySettings.details')}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={PRIVACY_DOCS_URL} target="_blank" rel="noopener noreferrer" data-telemetry-notice="">
                  {t('telemetrySettings.learnMore')}<ExternalLink className="ml-auto size-3" aria-hidden />
                </a>
              </DropdownMenuItem>
            </>
          )}
          menuLabel={t('telemetrySettings.more')}
        />
      </ProviderSection>
      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('telemetrySettings.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-[13px]">
            <div className="space-y-1">
              <p className="font-medium">{t('telemetrySettings.sentTitle')}</p>
              <p className="leading-snug text-muted-foreground">{t('telemetrySettings.sent')}</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium">{t('telemetrySettings.neverTitle')}</p>
              <p className="leading-snug text-muted-foreground">{t('telemetrySettings.never')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => { setDetails(false); }}>{t('telemetrySettings.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
