'use client';

/**
 * Settings › Plugins › Developer mode: the switch that lets unsigned plugins
 * load (`developer.unsignedPlugins`). Superadmin only, on the tab
 * (`settings-layout.ts`) and on the daemon route.
 *
 * The switch shows what the daemon APPLIES (`effective`), never the bare wish:
 * a wish the licence refuses would otherwise read as unsigned code that runs.
 * When a fixed plugin composition keeps it shut, the switch is disabled and
 * says why.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import {
  DeveloperModeError, developerModeBlockedText, fetchDeveloperMode, setDeveloperMode, type DeveloperModeState,
} from '@/lib/developer-mode';
import { t } from '@/lib/i18n';

export function DeveloperModeSettings(): ReactElement {
  const [state, setState] = useState<DeveloperModeState | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await fetchDeveloperMode());
      setStatus('ready');
    } catch (err) {
      setStatus(err instanceof DeveloperModeError && (err.status === 401 || err.status === 403) ? 'forbidden' : 'error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const flip = async (enabled: boolean): Promise<void> => {
    setSaving(true);
    try {
      const next = await setDeveloperMode(enabled);
      setState(next);
      toast.success(t(next.effective ? 'developerMode.turnedOn' : 'developerMode.turnedOff'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      void load();
    } finally {
      setSaving(false);
    }
  };

  if (status === 'loading') return <section className="max-w-3xl" aria-busy="true" />;
  if (status === 'forbidden') return <Note>{t('developerMode.forbidden')}</Note>;
  if (status === 'error' || !state) return <Note>{t('developerMode.loadError')}</Note>;

  const blocked = developerModeBlockedText(state);
  // Off is always reachable: a mode left on under a licence that no longer
  // admits it, such as one that brought a fixed composition, must still be
  // switchable off.
  const disabled = saving || (!state.effective && !state.available);

  return (
    <section className="max-w-3xl space-y-4" data-testid="developer-mode-settings">
      <div className="flex flex-col gap-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0 flex-1">
          <label htmlFor="developer-mode-switch" className="text-[13px] font-medium leading-snug">
            {t('developerMode.label')}
          </label>
          <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
            {t('developerMode.description')}
          </p>
        </div>
        <Switch
          id="developer-mode-switch"
          checked={state.effective}
          disabled={disabled}
          aria-describedby={blocked ? 'developer-mode-blocked' : undefined}
          onCheckedChange={(checked) => { void flip(checked); }}
        />
      </div>

      {blocked && (
        <p id="developer-mode-blocked" role="status" className="m-0 max-w-[65ch] rounded-md bg-muted/60 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          {blocked}
        </p>
      )}

      <div className="flex max-w-[65ch] gap-2.5 rounded-md bg-amber-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="m-0">{t('developerMode.warning')}</p>
      </div>
    </section>
  );
}

function Note({ children }: { children: string }): ReactElement {
  return <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">{children}</p>;
}
